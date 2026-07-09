use crate::models::*;
use crate::runtime;
use crate::state::AppState;
use serde_json::{json, Value};
use std::io::Read;
use tauri::{AppHandle, Manager};

/// Deliver a message from `sender` to a teammate (by name or id) or to the
/// operator ("user"). Agent recipients get a new task so they can respond —
/// unless the hop chain is exhausted, in which case the message is only stored.
pub fn deliver_message(
    app: &AppHandle,
    sender: &Agent,
    to: &str,
    body: &str,
    hop: u32,
) -> Result<String, String> {
    if body.trim().is_empty() {
        return Err("message body is empty".into());
    }
    let state = app.state::<AppState>();
    let key = to.trim();
    if key.eq_ignore_ascii_case("user") || key.eq_ignore_ascii_case("operator") {
        runtime::push_message(&state, &sender.id, "user", body, hop);
        runtime::emit_changed(app);
        return Ok("message delivered to the operator".into());
    }
    let recipient = state
        .resolve_agent(key)
        .ok_or_else(|| format!("no teammate named '{key}'"))?;
    if recipient.id == sender.id {
        return Err("you cannot message yourself".into());
    }
    runtime::push_message(&state, &sender.id, &recipient.id, body, hop);
    runtime::emit_changed(app);
    let max_hops = state.settings.lock().unwrap().max_hops;
    if hop > max_hops {
        return Ok(format!(
            "message stored for {} (conversation chain limit reached; they will not auto-respond)",
            recipient.name
        ));
    }
    let prompt = runtime::build_message_prompt(&state, &recipient.id, &sender.name, body);
    runtime::submit_task(
        app,
        format!("Message from {}", sender.name),
        prompt,
        Some(recipient.id.clone()),
        sender.id.clone(),
        "message".into(),
        hop,
    )?;
    Ok(format!("message delivered to {}; they will respond asynchronously", recipient.name))
}

fn handle(app: &AppHandle, method: &str, path: &str, body: &str) -> (u16, Value) {
    let state = app.state::<AppState>();
    match (method, path) {
        ("GET", "/agents") => {
            let agents = state.agents.lock().unwrap();
            let roster: Vec<Value> = agents
                .iter()
                .map(|a| json!({"name": a.name, "role": a.role, "skills": a.skills}))
                .collect();
            (200, json!({"agents": roster}))
        }
        ("GET", "/board") => (200, json!({"board": runtime::board_summary(&state)})),
        ("GET", "/library") => (200, json!({"docs": crate::library::docs_index(&state)})),
        ("POST", "/library/read") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return (400, json!({"error": "invalid JSON"}));
            };
            let key = v["doc"].as_str().unwrap_or_default();
            match crate::library::find_doc(&state, key) {
                Some(d) => (200, json!({"title": d.title, "kind": d.kind, "content": d.content})),
                None => (404, json!({"error": format!("no library doc matching '{key}'")})),
            }
        }
        ("POST", "/library/save") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return (400, json!({"error": "invalid JSON"}));
            };
            let token = v["token"].as_str().unwrap_or_default();
            let Some(sender) = state.agent(token) else {
                return (403, json!({"error": "invalid token"}));
            };
            match crate::library::save_doc(
                app,
                v["title"].as_str().unwrap_or_default(),
                v["kind"].as_str().unwrap_or("process"),
                v["content"].as_str().unwrap_or_default(),
                &sender.name,
            ) {
                Ok(msg) => (200, json!({"ok": true, "detail": msg})),
                Err(e) => (400, json!({"error": e})),
            }
        }
        ("POST", "/memory") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return (400, json!({"error": "invalid JSON"}));
            };
            let token = v["token"].as_str().unwrap_or_default();
            let Some(sender) = state.agent(token) else {
                return (403, json!({"error": "invalid token"}));
            };
            match crate::library::update_memory(
                app,
                &sender,
                v["scope"].as_str().unwrap_or("self"),
                v["content"].as_str().unwrap_or_default(),
            ) {
                Ok(msg) => (200, json!({"ok": true, "detail": msg})),
                Err(e) => (400, json!({"error": e})),
            }
        }
        ("POST", "/agents/create") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return (400, json!({"error": "invalid JSON"}));
            };
            let token = v["token"].as_str().unwrap_or_default();
            let Some(sender) = state.agent(token) else {
                return (403, json!({"error": "invalid token"}));
            };
            // New hires inherit the requester's backend/model and start sandboxed.
            let input = crate::commands::AgentInput {
                name: v["name"].as_str().unwrap_or_default().to_string(),
                role: v["role"].as_str().unwrap_or_default().to_string(),
                skills: v["skills"].as_str().unwrap_or_default().to_string(),
                backend: sender.backend,
                model: sender.model.clone(),
                permission: Permission::Sandboxed,
                color: String::new(),
            };
            match crate::commands::create_agent_core(app, input) {
                Ok(agent) => (200, json!({"ok": true, "detail": format!("{} ({}) joined the team", agent.name, agent.role)})),
                Err(e) => (400, json!({"error": e})),
            }
        }
        ("POST", "/board/move") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return (400, json!({"error": "invalid JSON"}));
            };
            let token = v["token"].as_str().unwrap_or_default();
            let Some(sender) = state.agent(token) else {
                return (403, json!({"error": "invalid token"}));
            };
            let task = v["task"].as_str().unwrap_or_default();
            let column = v["column"].as_str().unwrap_or_default();
            match runtime::move_task_to(app, task, column, &sender.name) {
                Ok(msg) => (200, json!({"ok": true, "detail": msg})),
                Err(e) => (400, json!({"error": e})),
            }
        }
        ("POST", "/message") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return (400, json!({"error": "invalid JSON"}));
            };
            let token = v["token"].as_str().unwrap_or_default();
            let Some(sender) = state.agent(token) else {
                return (403, json!({"error": "invalid token"}));
            };
            let to = v["to"].as_str().unwrap_or_default();
            let msg_body = v["body"].as_str().unwrap_or_default();
            // Hop = current chain depth of whatever the sender is working on.
            let hop = {
                let tasks = state.tasks.lock().unwrap();
                tasks
                    .iter()
                    .filter(|t| t.status == "running" && t.agent_id.as_deref() == Some(&sender.id))
                    .map(|t| t.hop)
                    .max()
                    .unwrap_or(0)
                    + 1
            };
            match deliver_message(app, &sender, to, msg_body, hop) {
                Ok(msg) => (200, json!({"ok": true, "detail": msg})),
                Err(e) => (400, json!({"error": e})),
            }
        }
        _ => (404, json!({"error": "not found"})),
    }
}

/// Localhost-only HTTP bus that CLI-backed agents reach via curl.
pub fn start(app: AppHandle, port: u16) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("agent bus failed to bind port {port}: {e}");
                return;
            }
        };
        for mut request in server.incoming_requests() {
            let mut body = String::new();
            request.as_reader().take(1_000_000).read_to_string(&mut body).ok();
            let method = request.method().as_str().to_string();
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("").to_string();
            let (status, payload) = handle(&app, &method, &path, &body);
            let data = payload.to_string();
            let response = tiny_http::Response::from_string(data)
                .with_status_code(status)
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
            request.respond(response).ok();
        }
    });
}

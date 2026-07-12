//! Telegram remote channel: the operator pairs their personal chat with a
//! bot token, then texts tasks to the team from anywhere. Only the paired
//! chat id is honored; pairing requires the one-time code shown in Settings.

use crate::state::AppState;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

fn api(token: &str, method: &str) -> String {
    format!("https://api.telegram.org/bot{token}/{method}")
}

fn send(token: &str, chat_id: i64, text: &str) {
    // Telegram caps messages at 4096 chars.
    let text: String = text.chars().take(4000).collect();
    ureq::post(&api(token, "sendMessage"))
        .timeout(Duration::from_secs(15))
        .send_json(json!({ "chat_id": chat_id, "text": text }))
        .ok();
}

pub fn start_bot(app: AppHandle) {
    std::thread::spawn(move || {
        let mut offset: i64 = 0;
        loop {
            let (enabled, token, paired_chat, pair_code) = {
                let state = app.state::<AppState>();
                let mut s = state.settings.lock().unwrap();
                // Generate the pairing code lazily once a token exists.
                if !s.telegram_token.is_empty() && s.telegram_pair_code.is_empty() {
                    s.telegram_pair_code = format!(
                        "QIV-{:06}",
                        (crate::models::now_ms() % 900_000) + 100_000
                    );
                    drop(s);
                    state.save_settings();
                    crate::runtime::emit_changed(&app);
                    continue;
                }
                (
                    s.telegram_enabled,
                    s.telegram_token.clone(),
                    s.telegram_chat_id,
                    s.telegram_pair_code.clone(),
                )
            };
            if !enabled || token.is_empty() {
                std::thread::sleep(Duration::from_secs(15));
                continue;
            }
            let resp = ureq::post(&api(&token, "getUpdates"))
                .timeout(Duration::from_secs(70))
                .send_json(json!({ "timeout": 50, "offset": offset, "allowed_updates": ["message"] }));
            let v: Value = match resp {
                Ok(r) => match r.into_json() {
                    Ok(v) => v,
                    Err(_) => {
                        std::thread::sleep(Duration::from_secs(10));
                        continue;
                    }
                },
                Err(_) => {
                    std::thread::sleep(Duration::from_secs(10));
                    continue;
                }
            };
            for update in v["result"].as_array().cloned().unwrap_or_default() {
                offset = offset.max(update["update_id"].as_i64().unwrap_or(0) + 1);
                let msg = &update["message"];
                let chat_id = msg["chat"]["id"].as_i64().unwrap_or(0);
                let text = msg["text"].as_str().unwrap_or("").trim().to_string();
                if chat_id == 0 || text.is_empty() {
                    continue;
                }
                if paired_chat == 0 {
                    // Pairing phase: only the exact code pairs the chat.
                    if !pair_code.is_empty() && text == pair_code {
                        {
                            let state = app.state::<AppState>();
                            state.settings.lock().unwrap().telegram_chat_id = chat_id;
                            state.save_settings();
                        }
                        crate::runtime::emit_changed(&app);
                        send(&token, chat_id, "Paired with your Qivreno team ✓\nText me a task and I'll route it to the right agent. Start a message with 'ask <AgentName>:' to pick the agent yourself.");
                    } else {
                        send(&token, chat_id, "This Qivreno is not paired with you. Open Qivreno → Settings on your Mac and send me the pairing code shown there.");
                    }
                    continue;
                }
                if chat_id != paired_chat {
                    send(&token, chat_id, "This Qivreno is not paired with you.");
                    continue;
                }
                handle_remote_task(&app, &token, chat_id, &text);
            }
        }
    });
}

fn handle_remote_task(app: &AppHandle, token: &str, chat_id: i64, text: &str) {
    // Optional "ask AgentName: ..." prefix picks the agent explicitly.
    let (agent_key, body) = match text
        .strip_prefix("ask ")
        .or_else(|| text.strip_prefix("Ask "))
        .and_then(|rest| rest.split_once(':'))
    {
        Some((name, rest)) if !rest.trim().is_empty() => {
            (Some(name.trim().to_string()), rest.trim().to_string())
        }
        _ => (None, text.to_string()),
    };
    let title = format!("📱 {}", crate::runtime::truncate(&body, 60));
    let prompt = format!(
        "The operator sent this task remotely from their phone. Work it like any other task; \
         they will read your result on their phone, so end with a compact summary.\n\n{body}"
    );
    match crate::runtime::submit_task(app, title, prompt, agent_key, "user".into(), "task".into(), 0) {
        Ok(task) => {
            send(token, chat_id, "Got it — routing to the team now. I'll message you the result.");
            watch_and_reply(app.clone(), token.to_string(), chat_id, task.id);
        }
        Err(e) => send(token, chat_id, &format!("Couldn't start that: {e}")),
    }
}

/// Watch a remotely-submitted task and text back the outcome.
fn watch_and_reply(app: AppHandle, token: String, chat_id: i64, task_id: String) {
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(45 * 60);
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let state = app.state::<AppState>();
            let task = state.tasks.lock().unwrap().iter().find(|t| t.id == task_id).cloned();
            let Some(task) = task else { return };
            match task.status.as_str() {
                "done" => {
                    let who = task
                        .agent_id
                        .as_deref()
                        .and_then(|id| state.agent(id))
                        .map(|a| a.name)
                        .unwrap_or_else(|| "the team".into());
                    send(&token, chat_id, &format!("✅ {} finished \"{}\":\n\n{}", who, task.title.trim_start_matches("📱 "), task.result));
                    return;
                }
                "failed" => {
                    send(&token, chat_id, &format!("❌ Task failed: {}", task.result));
                    return;
                }
                "cancelled" => {
                    send(&token, chat_id, "Task was cancelled from the app.");
                    return;
                }
                "waiting" => {
                    send(&token, chat_id, &format!("⏸ The agent needs input before continuing:\n{}\n\nAnswer from the Requires Input column in the app.", task.input_request));
                    return;
                }
                _ => {}
            }
            if std::time::Instant::now() > deadline {
                send(&token, chat_id, "Still working — check the board in the app for the result.");
                return;
            }
        }
    });
}

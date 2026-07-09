//! The business Library (docs + processes) and agent memory. One shared
//! implementation used by the UI commands, the HTTP bus, and the
//! Ollama/LM Studio agent tools.

use crate::models::*;
use crate::runtime;
use crate::state::AppState;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const AGENT_MEMORY_CAP: usize = 6000;
pub const SHARED_MEMORY_CAP: usize = 4000;

/// Compact listing agents can read: "id-prefix | kind | title".
pub fn docs_index(state: &AppState) -> String {
    let docs = state.docs.lock().unwrap();
    if docs.is_empty() {
        return "(the library is empty)".into();
    }
    docs.iter()
        .map(|d| format!("{} | {} | {}", &d.id[..8], d.kind, d.title))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Find a doc by id, id prefix, or exact (case-insensitive) title.
pub fn find_doc(state: &AppState, key: &str) -> Option<Doc> {
    let key = key.trim();
    let docs = state.docs.lock().unwrap();
    docs.iter()
        .find(|d| d.id == key || (key.len() >= 6 && d.id.starts_with(key)))
        .or_else(|| docs.iter().find(|d| d.title.eq_ignore_ascii_case(key)))
        .cloned()
}

/// Create or update (matched by exact title) a library doc.
pub fn save_doc(
    app: &AppHandle,
    title: &str,
    kind: &str,
    content: &str,
    actor: &str,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("doc needs a title".into());
    }
    let kind = match kind {
        "business" | "process" => kind,
        "" => "process",
        other => return Err(format!("unknown doc kind '{other}' — use business or process")),
    };
    let state = app.state::<AppState>();
    let action;
    {
        let mut docs = state.docs.lock().unwrap();
        if let Some(d) = docs.iter_mut().find(|d| d.title.eq_ignore_ascii_case(title)) {
            d.content = content.to_string();
            d.updated_by = actor.to_string();
            d.updated_at = now_ms();
            action = format!("updated '{}'", d.title);
        } else {
            docs.push(Doc {
                id: Uuid::new_v4().to_string(),
                title: title.to_string(),
                kind: kind.to_string(),
                content: content.to_string(),
                updated_by: actor.to_string(),
                created_at: now_ms(),
                updated_at: now_ms(),
            });
            action = format!("created '{title}' in the library");
        }
    }
    state.save_docs();
    runtime::emit_changed(app);
    Ok(action)
}

/// Replace an agent's private memory (agents refine by rewriting the whole
/// file) or append a line to the shared memory. Both are size-capped.
pub fn update_memory(app: &AppHandle, agent: &Agent, scope: &str, content: &str) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("memory content is empty".into());
    }
    let state = app.state::<AppState>();
    let msg = match scope {
        "self" => {
            let text = runtime::truncate(content, AGENT_MEMORY_CAP);
            state.memory.lock().unwrap().agents.insert(agent.id.clone(), text);
            "your private memory was updated".to_string()
        }
        "shared" => {
            let mut mem = state.memory.lock().unwrap();
            let line = content.replace('\n', " ");
            if mem.shared.contains(&line) {
                return Ok("that fact is already in shared memory".into());
            }
            if !mem.shared.is_empty() {
                mem.shared.push('\n');
            }
            mem.shared.push_str(&format!("- {line}"));
            // Cap by dropping the oldest lines.
            while mem.shared.len() > SHARED_MEMORY_CAP {
                match mem.shared.find('\n') {
                    Some(i) => mem.shared.replace_range(..=i, ""),
                    None => {
                        mem.shared = runtime::truncate(&mem.shared, SHARED_MEMORY_CAP);
                        break;
                    }
                }
            }
            "added to the team's shared memory".to_string()
        }
        other => return Err(format!("unknown memory scope '{other}' — use self or shared")),
    };
    state.save_memory();
    runtime::emit_changed(app);
    Ok(msg)
}

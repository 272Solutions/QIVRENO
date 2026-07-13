//! Driver for OpenAI-compatible local servers (LM Studio, LocalAI,
//! llama.cpp server, …). Same tools as the Ollama driver; the wire format
//! differs: tool arguments arrive as a JSON string and tool results must
//! echo the call id.

use crate::models::*;
use crate::ollama::{exec_tool, strip_thinking, tool_defs};
use crate::state::AppState;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MAX_ITERATIONS: usize = 16;

pub fn run_agent_loop(
    app: &AppHandle,
    task_id: &str,
    agent: &Agent,
    settings: &Settings,
    prompt: &str,
) -> Result<String, String> {
    if agent.model.is_empty() {
        return Err("no model configured for this agent — is the LM Studio server running with a model loaded?".into());
    }
    run_agent_loop_at(app, task_id, agent, &settings.lmstudio_url, &agent.model.clone(), None, prompt)
}

/// Same loop against any OpenAI-compatible base URL — used by the LM Studio
/// backend, the built-in engine, and hosted OpenAI-compatible APIs (Grok);
/// `api_key` adds a Bearer header for the hosted case.
pub fn run_agent_loop_at(
    app: &AppHandle,
    task_id: &str,
    agent: &Agent,
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    prompt: &str,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let post = |body: &Value| {
        let mut req = ureq::post(&url).timeout(Duration::from_secs(600));
        if let Some(key) = api_key {
            req = req.set("Authorization", &format!("Bearer {key}"));
        }
        req.send_json(body.clone())
    };
    let tools = tool_defs(agent);
    let mut messages = vec![json!({"role":"user","content": prompt})];
    let mut sends: Vec<(String, String)> = vec![];
    let state = app.state::<AppState>();
    let task = state
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|t| t.id == task_id)
        .cloned()
        .ok_or("task disappeared")?;

    for _ in 0..MAX_ITERATIONS {
        if state.cancelled.lock().unwrap().contains(task_id) {
            return Err("cancelled".into());
        }
        let resp = post(&json!({
            "model": model,
            "messages": messages,
            "tools": tools,
            "stream": false,
        }))
        .map_err(|e| format!("backend request failed: {e}"))?;
        let v: Value = resp
            .into_json()
            .map_err(|e| format!("LM Studio bad response: {e}"))?;
        let msg = v["choices"][0]["message"].clone();
        let content = msg["content"].as_str().unwrap_or_default().to_string();
        let tool_calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();

        if tool_calls.is_empty() {
            let text = strip_thinking(&content);
            if text.is_empty() {
                // Model went silent — ask once for the wrap-up summary.
                messages.push(json!({
                    "role": "user",
                    "content": "Please give your final answer now: summarize what you did, name any files or library docs you created, and note anything that needs the operator's attention."
                }));
                continue;
            }
            return Ok(text);
        }
        messages.push(msg.clone());
        for call in &tool_calls {
            let call_id = call["id"].as_str().unwrap_or_default().to_string();
            let name = call["function"]["name"].as_str().unwrap_or_default().to_string();
            // OpenAI format: arguments is a JSON-encoded string.
            let args: Value = call["function"]["arguments"]
                .as_str()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| call["function"]["arguments"].clone());
            crate::runtime::log_task_line(
                app,
                task_id,
                &format!("tool: {name} {}", crate::ollama::loggable_args(&args)),
            );
            let result = exec_tool(app, agent, &task, &name, &args, &mut sends);
            if name == "request_input" && !result.starts_with("ERROR:") {
                // Pause the run; finalize parks the task in Requires Input.
                return Ok(format!("{}{}", crate::runtime::AWAIT_INPUT, result));
            }
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result,
            }));
        }
    }
    // Tool budget exhausted — force a final plain-text answer instead of failing.
    messages.push(json!({
        "role": "user",
        "content": "You have used all available tool calls for this task. Give your final answer now as plain text, summarizing what you did and any results. Do not call any more tools."
    }));
    let resp = post(&json!({
        "model": model,
        "messages": messages,
        "stream": false,
    }))
    .map_err(|e| format!("backend request failed: {e}"))?;
    let v: Value = resp
        .into_json()
        .map_err(|e| format!("LM Studio bad response: {e}"))?;
    let content = strip_thinking(v["choices"][0]["message"]["content"].as_str().unwrap_or_default());
    if content.is_empty() {
        Err(format!("stopped after {MAX_ITERATIONS} tool iterations without a final answer"))
    } else {
        Ok(content)
    }
}

use crate::bus;
use crate::models::*;
use crate::runtime::truncate;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MAX_ITERATIONS: usize = 16;
const CMD_TIMEOUT_SECS: u64 = 120;

pub(crate) fn tool_defs(agent: &Agent) -> Vec<Value> {
    let mut tools = vec![
        json!({"type":"function","function":{"name":"list_files","description":"List files in a directory. Your workspace by default; pass Shared to list the shared team folder.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Directory path, relative to your workspace. Defaults to the workspace root."}}}}}),
        json!({"type":"function","function":{"name":"read_file","description":"Read a text file.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}),
        json!({"type":"function","function":{"name":"write_file","description":"Write (create or overwrite) a text file. Use the Shared/ path prefix for team documents the operator should see (e.g. Shared/Q3 Plan.md).","parameters":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}),
        json!({"type":"function","function":{"name":"fetch_url","description":"Fetch a URL over HTTP GET and return the response body as text.","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}}),
        json!({"type":"function","function":{"name":"send_message","description":"Send a message or delegate work to a teammate agent. Their reply arrives later as a new task for you.","parameters":{"type":"object","properties":{"to":{"type":"string","description":"Teammate agent name"},"body":{"type":"string"}},"required":["to","body"]}}}),
        json!({"type":"function","function":{"name":"list_board","description":"Show the team's shared kanban board: every task with its id, column, status and assignee.","parameters":{"type":"object","properties":{}}}}),
        json!({"type":"function","function":{"name":"move_task","description":"Move a task on the shared kanban board. Columns: todo, in_progress, review, done. Do not move the task you are currently working on.","parameters":{"type":"object","properties":{"task":{"type":"string","description":"Task id (or exact title)"},"column":{"type":"string","enum":["todo","in_progress","review","done"]}},"required":["task","column"]}}}),
        json!({"type":"function","function":{"name":"list_library","description":"List the business library: company info docs and documented processes.","parameters":{"type":"object","properties":{}}}}),
        json!({"type":"function","function":{"name":"read_doc","description":"Read a library doc by id or exact title.","parameters":{"type":"object","properties":{"doc":{"type":"string"}},"required":["doc"]}}}),
        json!({"type":"function","function":{"name":"save_process","description":"Save or update a repeatable process in the library so any teammate can follow it later. Write clear numbered steps.","parameters":{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string","description":"The full process: purpose, numbered steps, tips"}},"required":["title","content"]}}}),
        json!({"type":"function","function":{"name":"update_memory","description":"Update memory. scope 'self': REPLACE your private memory with a refined full version (merge new durable facts, prune stale ones). scope 'shared': add ONE short fact every teammate should know.","parameters":{"type":"object","properties":{"scope":{"type":"string","enum":["self","shared"]},"content":{"type":"string"}},"required":["scope","content"]}}}),
        json!({"type":"function","function":{"name":"create_agent","description":"Hire a new teammate agent (they use the same AI backend as you, sandboxed). Use only when the team is missing a needed role.","parameters":{"type":"object","properties":{"name":{"type":"string","description":"Short name, e.g. 'Sales'"},"role":{"type":"string"},"skills":{"type":"string","description":"Comma-separated skills, used to route tasks to them"}},"required":["name","role","skills"]}}}),
        json!({"type":"function","function":{"name":"create_subtask","description":"Break the project you are working on into a smaller task and hand it to a teammate. The subtask stays linked to your current task on the board and the result comes back to you when it finishes. One call per subtask.","parameters":{"type":"object","properties":{"title":{"type":"string","description":"Short subtask title"},"details":{"type":"string","description":"Everything the teammate needs: goal, inputs, expected deliverable"},"assignee":{"type":"string","description":"Teammate agent name, or leave empty to route to the best fit"}},"required":["title","details"]}}}),
        json!({"type":"function","function":{"name":"request_input","description":"Pause your current task and ask the operator a question you genuinely cannot answer yourself (a decision, missing information, an approval). The task moves to the Requires Input column and resumes automatically with their answer. Ask everything you need in ONE clear question, then stop.","parameters":{"type":"object","properties":{"question":{"type":"string","description":"The complete question, with enough context for the operator to answer it cold"}},"required":["question"]}}}),
        json!({"type":"function","function":{"name":"calendar_events","description":"Read the operator's calendar: upcoming events with dates, times and titles. Use for scheduling context, deadlines and availability.","parameters":{"type":"object","properties":{"days":{"type":"integer","description":"How many days ahead to look (default 7, max 60)"}}}}}),
        json!({"type":"function","function":{"name":"calendar_add_event","description":"Add an event to the operator's calendar (meeting, deadline, reminder). It appears in their Calendar app immediately.","parameters":{"type":"object","properties":{"title":{"type":"string"},"start":{"type":"string","description":"Start as YYYY-MM-DD HH:MM (24h, operator's local time)"},"duration_minutes":{"type":"integer","description":"Length in minutes (default 60)"},"notes":{"type":"string","description":"Optional description/agenda"}},"required":["title","start"]}}}),
    ];
    if agent.permission == Permission::Full {
        tools.push(json!({"type":"function","function":{"name":"run_command","description":"Run a shell command on this Mac and return its output.","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}));
    }
    // Tools contributed by connected MCP servers (namespaced mcp__*).
    tools.extend(crate::mcp::tool_defs());

    tools
}

/// Resolve a path inside the agent workspace or the shared team folder;
/// sandboxed agents may not escape either. "Shared/…" addresses the shared
/// folder explicitly.
fn resolve_path(workspace: &Path, shared: &Path, raw: &str, sandboxed: bool) -> Result<PathBuf, String> {
    let raw_trim = raw.trim();
    let joined = if raw_trim == "Shared" || raw_trim == "Shared/" {
        shared.to_path_buf()
    } else if let Some(rest) = raw_trim.strip_prefix("Shared/") {
        shared.join(rest)
    } else {
        let p = Path::new(raw_trim);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            workspace.join(p)
        }
    };
    if sandboxed {
        // Canonicalize the nearest existing ancestor to catch `..` escapes.
        let mut probe = joined.clone();
        while !probe.exists() {
            probe = match probe.parent() {
                Some(parent) => parent.to_path_buf(),
                None => return Err("invalid path".into()),
            };
        }
        let canon = probe.canonicalize().map_err(|e| e.to_string())?;
        let ws = workspace.canonicalize().map_err(|e| e.to_string())?;
        let sh = shared.canonicalize().map_err(|e| e.to_string())?;
        if !canon.starts_with(&ws) && !canon.starts_with(&sh) {
            return Err(format!(
                "sandboxed: '{raw}' is outside your workspace and the Shared folder"
            ));
        }
    }
    Ok(joined)
}

/// Compact, log-safe rendering of tool args: long text values (content,
/// body) are shortened so identifying fields (path, title, to) survive the
/// log-line cap.
pub(crate) fn loggable_args(args: &Value) -> String {
    let mut v = args.clone();
    if let Some(obj) = v.as_object_mut() {
        for key in ["content", "body"] {
            if let Some(val) = obj.get_mut(key) {
                if let Some(s) = val.as_str() {
                    if s.len() > 60 {
                        *val = Value::String(format!("{}…", truncate(s, 60)));
                    }
                }
            }
        }
    }
    truncate(&v.to_string(), 300)
}

pub(crate) fn exec_tool(
    app: &AppHandle,
    agent: &Agent,
    task: &Task,
    name: &str,
    args: &Value,
    sends: &mut Vec<(String, String)>,
) -> String {
    let state = app.state::<AppState>();
    let workspace = state.workspace_dir(agent);
    let shared = state.shared_dir();
    let sandboxed = agent.permission == Permission::Sandboxed;
    let result: Result<String, String> = match name {
        "list_files" => {
            let raw = args["path"].as_str().unwrap_or(".");
            resolve_path(&workspace, &shared, raw, sandboxed).and_then(|dir| {
                std::fs::read_dir(&dir)
                    .map_err(|e| e.to_string())
                    .map(|entries| {
                        let mut names: Vec<String> = entries
                            .flatten()
                            .map(|e| {
                                let mut n = e.file_name().to_string_lossy().into_owned();
                                if e.path().is_dir() {
                                    n.push('/');
                                }
                                n
                            })
                            .collect();
                        names.sort();
                        if names.is_empty() {
                            "(empty directory)".into()
                        } else {
                            names.join("\n")
                        }
                    })
            })
        }
        "read_file" => {
            let raw = args["path"].as_str().unwrap_or_default();
            resolve_path(&workspace, &shared, raw, sandboxed).and_then(|p| {
                std::fs::read_to_string(&p)
                    .map(|s| truncate(&s, 16000))
                    .map_err(|e| e.to_string())
            })
        }
        "write_file" => {
            let raw = args["path"].as_str().unwrap_or_default();
            let content = args["content"].as_str().unwrap_or_default();
            resolve_path(&workspace, &shared, raw, sandboxed).and_then(|p| {
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                std::fs::write(&p, content)
                    .map(|_| format!("wrote {} bytes to {raw}", content.len()))
                    .map_err(|e| e.to_string())
            })
        }
        "fetch_url" => {
            let url = args["url"].as_str().unwrap_or_default();
            ureq::get(url)
                .timeout(Duration::from_secs(30))
                .call()
                .map_err(|e| e.to_string())
                .and_then(|r| r.into_string().map_err(|e| e.to_string()))
                .map(|s| truncate(&s, 12000))
        }
        "send_message" => {
            let to = args["to"].as_str().unwrap_or_default();
            let body = args["body"].as_str().unwrap_or_default();
            let key = (to.to_lowercase(), body.to_string());
            // Small local models tend to re-send the same message every
            // iteration while "waiting" for a reply that arrives async.
            if sends.contains(&key) {
                Err("you already sent this exact message — do NOT send it again. \
                     The reply will arrive later as a new task for you. Continue with \
                     the rest of your work, or give your final answer now."
                    .into())
            } else if sends.len() >= 5 {
                Err("message limit reached for this run — stop messaging teammates and \
                     give your final answer now."
                    .into())
            } else {
                sends.push(key);
                bus::deliver_message(app, agent, to, body, task.hop + 1).map(|s| {
                    format!(
                        "{s}. Do not send this message again — if you are only waiting \
                         on the reply, give your final answer now."
                    )
                })
            }
        }
        "list_board" => Ok(crate::runtime::board_summary(&state)),
        "move_task" => {
            let key = args["task"].as_str().unwrap_or_default();
            let column = args["column"].as_str().unwrap_or_default();
            crate::runtime::move_task_to(app, key, column, &agent.name)
        }
        "list_library" => Ok(crate::library::docs_index(&state)),
        "read_doc" => {
            let key = args["doc"].as_str().unwrap_or_default();
            crate::library::find_doc(&state, key)
                .map(|d| format!("# {} [{}]\n\n{}", d.title, d.kind, truncate(&d.content, 12000)))
                .ok_or_else(|| format!("no library doc matching '{key}'"))
        }
        "save_process" => crate::library::save_doc(
            app,
            args["title"].as_str().unwrap_or_default(),
            "process",
            args["content"].as_str().unwrap_or_default(),
            &agent.name,
        ),
        "update_memory" => crate::library::update_memory(
            app,
            agent,
            args["scope"].as_str().unwrap_or("self"),
            args["content"].as_str().unwrap_or_default(),
        ),
        "create_agent" => {
            let input = crate::commands::AgentInput {
                name: args["name"].as_str().unwrap_or_default().to_string(),
                role: args["role"].as_str().unwrap_or_default().to_string(),
                description: String::new(),
                skills: args["skills"].as_str().unwrap_or_default().to_string(),
                backend: agent.backend,
                model: agent.model.clone(),
                permission: Permission::Sandboxed,
                color: String::new(),
            };
            crate::commands::create_agent_core(app, input)
                .map(|a| format!("{} ({}) joined the team", a.name, a.role))
        }
        "create_subtask" => crate::runtime::create_subtask(
            app,
            &task.id,
            args["title"].as_str().unwrap_or_default(),
            args["details"].as_str().unwrap_or_default(),
            args["assignee"].as_str().unwrap_or_default(),
            agent,
        ),
        "request_input" => {
            let q = args["question"].as_str().unwrap_or_default().trim().to_string();
            if q.is_empty() {
                Err("request_input needs a question".into())
            } else {
                // The loop turns this into a paused task via the AWAIT_INPUT sentinel.
                Ok(q)
            }
        }
        "calendar_events" => {
            let days = args["days"].as_i64().unwrap_or(7).clamp(1, 60);
            crate::calendar::list_events(days)
        }
        "calendar_add_event" => crate::calendar::add_event(
            args["title"].as_str().unwrap_or_default(),
            args["start"].as_str().unwrap_or_default(),
            args["duration_minutes"].as_i64().unwrap_or(60).clamp(5, 24 * 60),
            args["notes"].as_str().unwrap_or_default(),
        ),
        "run_command" if !sandboxed => {
            let command = args["command"].as_str().unwrap_or_default();
            run_shell(&workspace, command)
        }
        n if n.starts_with(crate::mcp::PREFIX) => crate::mcp::call(n, &args),
        _ => Err(format!("unknown tool '{name}'")),
    };
    match result {
        Ok(s) => s,
        Err(e) => format!("ERROR: {e}"),
    }
}

fn run_shell(cwd: &Path, command: &str) -> Result<String, String> {
    use std::process::Stdio;
    let mut child = crate::platform::shell_command(command)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed().as_secs() > CMD_TIMEOUT_SECS {
                    child.kill().ok();
                    return Err("command timed out".into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        s.push_str("\n[stderr]\n");
        s.push_str(&err);
    }
    Ok(truncate(s.trim(), 12000))
}

pub(crate) fn strip_thinking(s: &str) -> String {
    // qwen3 and friends may emit <think>...</think> blocks.
    let mut out = s.to_string();
    while let (Some(start), Some(end)) = (out.find("<think>"), out.find("</think>")) {
        if end > start {
            out.replace_range(start..end + 8, "");
        } else {
            break;
        }
    }
    out.trim().to_string()
}

pub fn run_agent_loop(
    app: &AppHandle,
    task_id: &str,
    agent: &Agent,
    settings: &Settings,
    prompt: &str,
) -> Result<String, String> {
    if agent.model.is_empty() {
        return Err("no Ollama model configured for this agent".into());
    }
    let url = format!("{}/api/chat", settings.ollama_url);
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
        let resp = ureq::post(&url)
            .timeout(Duration::from_secs(600))
            .send_json(json!({
                "model": agent.model,
                "messages": messages,
                "tools": tools,
                "stream": false,
            }))
            .map_err(|e| format!("ollama request failed: {e}"))?;
        let v: Value = resp.into_json().map_err(|e| format!("ollama bad response: {e}"))?;
        let msg = &v["message"];
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
            let name = call["function"]["name"].as_str().unwrap_or_default().to_string();
            let args = call["function"]["arguments"].clone();
            crate::runtime::log_task_line(app, task_id, &format!("tool: {name} {}", loggable_args(&args)));
            let result = exec_tool(app, agent, &task, &name, &args, &mut sends);
            if name == "request_input" && !result.starts_with("ERROR:") {
                // Pause the run; finalize parks the task in Requires Input.
                return Ok(format!("{}{}", crate::runtime::AWAIT_INPUT, result));
            }
            messages.push(json!({"role":"tool","content": result, "tool_name": name}));
        }
    }
    // Tool budget exhausted — force a final plain-text answer instead of failing.
    messages.push(json!({
        "role": "user",
        "content": "You have used all available tool calls for this task. Give your final answer now as plain text, summarizing what you did and any results. Do not call any more tools."
    }));
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(600))
        .send_json(json!({
            "model": agent.model,
            "messages": messages,
            "stream": false,
        }))
        .map_err(|e| format!("ollama request failed: {e}"))?;
    let v: Value = resp.into_json().map_err(|e| format!("ollama bad response: {e}"))?;
    let content = strip_thinking(v["message"]["content"].as_str().unwrap_or_default());
    if content.is_empty() {
        Err(format!("stopped after {MAX_ITERATIONS} tool iterations without a final answer"))
    } else {
        Ok(content)
    }
}

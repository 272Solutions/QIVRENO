//! Model Context Protocol client — lets Qivreno agents use tools provided by
//! third-party MCP servers (databases, GitHub, Slack, filesystems, …) instead
//! of only the 17 tools built into this app.
//!
//! Scope: stdio transport, tools only (no resources/prompts). That is the
//! shape almost every MCP server ships, and it keeps the trust surface small.
//!
//! SECURITY: an MCP server is a real program running on the operator's
//! machine with their permissions. Nothing here is started implicitly — a
//! server runs only when its config is present AND enabled in Settings, and
//! the UI shows the exact command before it is enabled. Plugin packs may
//! *suggest* servers; suggesting never starts anything.
//!
//! Every read is bounded. A server that accepts a request and never answers
//! must fail its one call, not wedge the agent thread that asked.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "2024-11-05";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Namespaced so MCP tools can never shadow a built-in tool name.
pub const PREFIX: &str = "mcp__";

struct Server {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    /// Tool definitions as advertised by the server (name/description/schema).
    tools: Vec<Value>,
}

type Registry = Mutex<HashMap<String, Arc<Mutex<Server>>>>;

fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Server {
    /// One JSON-RPC round trip. Ignores notifications and replies to other
    /// ids that arrive while we wait.
    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let line = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string();
        writeln!(self.stdin, "{line}").map_err(|e| format!("write failed: {e}"))?;
        self.stdin.flush().map_err(|e| format!("flush failed: {e}"))?;

        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!("timed out after {}s", timeout.as_secs()));
            }
            match self.rx.recv_timeout(left) {
                Ok(msg) => {
                    if msg.get("id").and_then(|v| v.as_u64()) != Some(id) {
                        continue; // notification, or a reply we are not waiting on
                    }
                    if let Some(err) = msg.get("error") {
                        let m = err.get("message").and_then(|v| v.as_str()).unwrap_or("unknown error");
                        return Err(m.to_string());
                    }
                    return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!("timed out after {}s", timeout.as_secs()))
                }
                // Sender dropped: the reader thread hit EOF, so the server exited.
                Err(RecvTimeoutError::Disconnected) => return Err("server exited".into()),
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) {
        let line = json!({"jsonrpc":"2.0","method":method,"params":params}).to_string();
        writeln!(self.stdin, "{line}").ok();
        self.stdin.flush().ok();
    }
}

fn spawn_server(cfg: &crate::models::McpServerConfig) -> Result<Server, String> {
    let mut cmd = Command::new(&cfg.command);
    cmd.args(&cfg.args)
        .envs(cfg.env.iter())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::platform::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start '{}': {e}", cfg.command))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = channel();
    // One reader thread per server: parse newline-delimited JSON-RPC and hand
    // each message to whoever is waiting. Ends at EOF, which drops the sender
    // and turns every later request into a clean "server exited".
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });

    let mut srv = Server { child, stdin, rx, next_id: 0, tools: vec![] };

    srv.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "Qivreno", "version": env!("CARGO_PKG_VERSION")}
        }),
        STARTUP_TIMEOUT,
    )?;
    srv.notify("notifications/initialized", json!({}));

    let listed = srv.request("tools/list", json!({}), STARTUP_TIMEOUT)?;
    srv.tools = listed
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(srv)
}

fn stop_one(name: &str) {
    if let Some(srv) = registry().lock().unwrap().remove(name) {
        if let Ok(mut s) = srv.lock() {
            s.child.kill().ok();
            s.child.wait().ok();
        }
    }
}

/// Start/stop servers so the running set matches enabled settings. Returns a
/// per-server status line for the UI.
pub fn sync(settings: &crate::models::Settings) -> Vec<(String, String)> {
    let mut status = vec![];
    let enabled: Vec<&crate::models::McpServerConfig> =
        settings.mcp_servers.iter().filter(|s| s.enabled).collect();

    let running: Vec<String> = registry().lock().unwrap().keys().cloned().collect();
    for name in running {
        if !enabled.iter().any(|c| c.name == name) {
            stop_one(&name);
        }
    }

    for cfg in enabled {
        if cfg.name.trim().is_empty() || cfg.command.trim().is_empty() {
            continue;
        }
        if registry().lock().unwrap().contains_key(&cfg.name) {
            let n = registry()
                .lock()
                .unwrap()
                .get(&cfg.name)
                .and_then(|s| s.lock().ok().map(|s| s.tools.len()))
                .unwrap_or(0);
            status.push((cfg.name.clone(), format!("connected — {n} tool{}", if n == 1 { "" } else { "s" })));
            continue;
        }
        match spawn_server(cfg) {
            Ok(srv) => {
                let n = srv.tools.len();
                registry().lock().unwrap().insert(cfg.name.clone(), Arc::new(Mutex::new(srv)));
                status.push((cfg.name.clone(), format!("connected — {n} tool{}", if n == 1 { "" } else { "s" })));
            }
            Err(e) => status.push((cfg.name.clone(), format!("failed: {e}"))),
        }
    }
    status
}

pub fn stop_all() {
    let names: Vec<String> = registry().lock().unwrap().keys().cloned().collect();
    for n in names {
        stop_one(&n);
    }
}

/// Tool definitions for every connected server, in OpenAI function-calling
/// shape so they drop straight into the existing agent loop.
pub fn tool_defs() -> Vec<Value> {
    let mut out = vec![];
    let reg = registry().lock().unwrap();
    for (server, srv) in reg.iter() {
        let Ok(s) = srv.lock() else { continue };
        for t in &s.tools {
            let Some(name) = t.get("name").and_then(|v| v.as_str()) else { continue };
            let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let schema = t
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({"type":"object","properties":{}}));
            out.push(json!({
                "type": "function",
                "function": {
                    "name": format!("{PREFIX}{server}__{name}"),
                    "description": format!("[{server}] {desc}"),
                    "parameters": schema
                }
            }));
        }
    }
    out
}

/// Execute a namespaced MCP tool call. `full` looks like mcp__<server>__<tool>.
pub fn call(full: &str, args: &Value) -> Result<String, String> {
    let rest = full.strip_prefix(PREFIX).ok_or("not an MCP tool")?;
    let (server, tool) = rest.split_once("__").ok_or("malformed MCP tool name")?;
    let handle = registry()
        .lock()
        .unwrap()
        .get(server)
        .cloned()
        .ok_or_else(|| format!("MCP server '{server}' is not connected"))?;
    let mut s = handle.lock().map_err(|_| "server is unavailable".to_string())?;
    let result = s.request(
        "tools/call",
        json!({"name": tool, "arguments": args.clone()}),
        CALL_TIMEOUT,
    )?;

    // MCP returns a content array; flatten the text parts for the model.
    let mut text = String::new();
    if let Some(items) = result.get("content").and_then(|c| c.as_array()) {
        for item in items {
            match item.get("type").and_then(|v| v.as_str()) {
                Some("text") => {
                    if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                        text.push('\n');
                    }
                }
                Some(other) => text.push_str(&format!("[{other} content omitted]\n")),
                None => {}
            }
        }
    }
    if text.trim().is_empty() {
        text = result.to_string();
    }
    if result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(text.trim().to_string());
    }
    Ok(crate::runtime::truncate(text.trim(), 6000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{McpServerConfig, Settings};

    /// A minimal MCP server, so the handshake, tools/list and tools/call paths
    /// are exercised without a network fetch or a third-party dependency.
    const MOCK: &str = r#"
import sys, json
def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    m = json.loads(line)
    method, mid = m.get("method"), m.get("id")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":mid,"result":{"protocolVersion":"2024-11-05",
              "capabilities":{"tools":{}},"serverInfo":{"name":"mock","version":"1"}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":mid,"result":{"tools":[
              {"name":"echo","description":"Echo text back",
               "inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}})
    elif method == "tools/call":
        args = m.get("params",{}).get("arguments",{})
        send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":"echo: "+args.get("text","")}]}})
    elif mid is not None:
        send({"jsonrpc":"2.0","id":mid,"error":{"code":-32601,"message":"no such method"}})
"#;

    #[test]
    fn connects_lists_and_calls_a_tool() {
        let script = std::env::temp_dir().join("qivreno_mock_mcp.py");
        std::fs::write(&script, MOCK).unwrap();

        let mut settings = Settings::default();
        settings.mcp_servers = vec![McpServerConfig {
            name: "mock".into(),
            command: "python3".into(),
            args: vec![script.display().to_string()],
            enabled: true,
            ..Default::default()
        }];

        let status = sync(&settings);
        assert_eq!(status.len(), 1, "one server should be reported");
        assert!(status[0].1.contains("connected"), "expected connected, got {}", status[0].1);

        // The tool is advertised to the agent loop, namespaced by server.
        let defs = tool_defs();
        let names: Vec<String> = defs
            .iter()
            .filter_map(|d| d["function"]["name"].as_str().map(str::to_string))
            .collect();
        assert!(names.contains(&"mcp__mock__echo".to_string()), "got {names:?}");

        // And a call round-trips through JSON-RPC to the server and back.
        let out = call("mcp__mock__echo", &serde_json::json!({"text": "hello"})).unwrap();
        assert_eq!(out, "echo: hello");

        // Unknown servers fail cleanly rather than hanging.
        assert!(call("mcp__nope__x", &serde_json::json!({})).is_err());

        // Disabling removes it from the running set.
        settings.mcp_servers[0].enabled = false;
        let status = sync(&settings);
        assert!(status.is_empty());
        assert!(tool_defs().is_empty());

        stop_all();
        std::fs::remove_file(&script).ok();
    }
}

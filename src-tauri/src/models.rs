use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Builtin,
    Ollama,
    Lmstudio,
    Claude,
    Codex,
    Gemini,
    Grok,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Sandboxed,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub skills: String,
    pub backend: BackendKind,
    /// Model name: an Ollama tag for ollama agents, an optional model alias
    /// (e.g. "sonnet") for claude, ignored for codex.
    #[serde(default)]
    pub model: String,
    pub permission: Permission,
    #[serde(default)]
    pub color: String,
    /// Built-in assistants (Qivvy, Concierge): exempt from the agent cap.
    #[serde(default)]
    pub system: bool,
    /// Disabled agents receive no tasks, chats or messages.
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: u64,
}

impl Agent {
    /// Short capability summary for teammate rosters and routing prompts.
    /// Template skills open with a "<domain> per <framework> practice" anchor
    /// before the first colon; that prefix is the summary. Only the agent's
    /// own prompt carries the full skills text — injecting every teammate's
    /// full playbook would blow the local-model context window.
    pub fn skills_summary(&self) -> &str {
        let s = self.skills.trim();
        if let Some(i) = s.find(':') {
            if (20..=220).contains(&i) {
                return &s[..i];
            }
        }
        let mut end = match s.find(';') {
            Some(i) => i.min(160),
            None => s.len().min(160),
        };
        while end < s.len() && !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }
}

pub fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub prompt: String,
    /// Executing agent. None only while a broadcast task is being routed.
    pub agent_id: Option<String>,
    /// "user" or the id of the agent that delegated this task.
    pub origin: String,
    /// "task" | "chat" | "message"
    pub kind: String,
    /// "draft" | "routing" | "queued" | "running" | "done" | "failed" | "cancelled"
    pub status: String,
    /// Kanban column: "todo" | "in_progress" | "review" | "requires_input" | "done".
    #[serde(default)]
    pub column: String,
    /// Parent task id when this was spawned as a subtask of a larger project.
    #[serde(default)]
    pub parent_id: String,
    /// The question for the operator while parked in requires_input.
    #[serde(default)]
    pub input_request: String,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub log: Vec<String>,
    /// Agent-to-agent chain depth; runs triggered past max_hops are not auto-continued.
    #[serde(default)]
    pub hop: u32,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A knowledge-base document: business info the user maintains, or a
/// repeatable process documented by an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    pub title: String,
    /// "business" | "process"
    pub kind: String,
    pub content: String,
    /// "user" or an agent name.
    #[serde(default)]
    pub updated_by: String,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Long-lived memory: one private file per agent plus one shared file
/// injected into every agent's context.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryStore {
    #[serde(default)]
    pub shared: String,
    #[serde(default)]
    pub agents: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    /// "user" or an agent id.
    pub from: String,
    /// "user" or an agent id.
    pub to: String,
    pub body: String,
    #[serde(default)]
    pub hop: u32,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub claude_path: String,
    #[serde(default)]
    pub codex_path: String,
    /// Google AI Studio API key for the Gemini backend (stored locally).
    #[serde(default)]
    pub gemini_api_key: String,
    /// xAI API key for the Grok backend (OpenAI-compatible; stored locally).
    #[serde(default)]
    pub grok_api_key: String,
    pub ollama_url: String,
    /// Base URL of an OpenAI-compatible local server (LM Studio, LocalAI, llama.cpp…).
    #[serde(default = "default_lmstudio_url")]
    pub lmstudio_url: String,
    pub bus_port: u16,
    pub max_hops: u32,
    /// Ollama model used for best-fit routing decisions.
    #[serde(default)]
    pub router_model: String,
    /// Built-in AI engine (bundled llama.cpp + downloaded model).
    #[serde(default)]
    pub builtin_enabled: bool,
    #[serde(default = "default_builtin_port")]
    pub builtin_port: u16,
    /// Whether the one-time "Claude/Codex primary, local fallback" advice
    /// dialog has been dismissed.
    #[serde(default)]
    pub backend_advice_shown: bool,
    /// Deck-export branding. Empty = Qivreno defaults; set manually or by
    /// importing a customer's .pptx template.
    #[serde(default)]
    pub brand_accent: String,
    #[serde(default)]
    pub brand_text: String,
    /// Terms & Conditions acceptance record (version accepted + when).
    #[serde(default)]
    pub terms_accepted_version: u32,
    #[serde(default)]
    pub terms_accepted_at: u64,
    /// Qivreno subscription license key (QIV-…), verified offline.
    #[serde(default)]
    pub license_key: String,
    /// Per-device refresh token from activation; enables silent renewal.
    #[serde(default)]
    pub license_refresh_token: String,
    /// License service base URL (overridable for testing).
    #[serde(default = "default_license_server")]
    pub license_server: String,
    /// Monotonic clock guard — set on refresh; time moving backwards past
    /// this invalidates the cached key until a successful refresh.
    #[serde(default)]
    pub last_seen_ms: u64,
    /// First-launch timestamp; anchors the free trial.
    #[serde(default)]
    pub trial_started_at: u64,
    /// One-time flag: Qivvy (the default project-manager agent) was seeded.
    #[serde(default)]
    pub qivvy_seeded: bool,
    /// IMAP inbox watching (email → proposed tasks). Password stays local.
    #[serde(default)]
    pub mail_enabled: bool,
    #[serde(default)]
    pub mail_host: String,
    #[serde(default = "default_imap_port")]
    pub mail_port: u16,
    #[serde(default)]
    pub mail_user: String,
    #[serde(default)]
    pub mail_password: String,
    /// Optional comma-separated sender allowlist; empty = all senders.
    #[serde(default)]
    pub mail_allowlist: String,
    /// Telegram remote channel (bot token + paired chat).
    #[serde(default)]
    pub telegram_enabled: bool,
    #[serde(default)]
    pub telegram_token: String,
    #[serde(default)]
    pub telegram_chat_id: i64,
    /// One-time pairing code shown in Settings; a chat pairs by sending it.
    #[serde(default)]
    pub telegram_pair_code: String,
    /// Absolute paths to folders on the user's computer that the operator has
    /// explicitly connected. Agents may read and (when asked) edit files in
    /// these folders, alongside the built-in Shared folder.
    #[serde(default)]
    pub connected_folders: Vec<String>,
}

pub fn default_imap_port() -> u16 {
    993
}

pub fn default_lmstudio_url() -> String {
    "http://localhost:1234/v1".to_string()
}

pub fn default_builtin_port() -> u16 {
    42730
}

pub fn default_license_server() -> String {
    "https://qivreno.ai".to_string()
}

/// Bump when docs/TERMS.md changes materially — users re-accept in-app.
pub const TERMS_VERSION: u32 = 2;

impl Default for Settings {
    fn default() -> Self {
        Settings {
            claude_path: String::new(),
            codex_path: String::new(),
            gemini_api_key: String::new(),
            grok_api_key: String::new(),
            ollama_url: "http://localhost:11434".to_string(),
            lmstudio_url: default_lmstudio_url(),
            bus_port: 42720,
            max_hops: 6,
            router_model: String::new(),
            builtin_enabled: false,
            builtin_port: default_builtin_port(),
            backend_advice_shown: false,
            brand_accent: String::new(),
            brand_text: String::new(),
            terms_accepted_version: 0,
            terms_accepted_at: 0,
            license_key: String::new(),
            license_refresh_token: String::new(),
            license_server: default_license_server(),
            last_seen_ms: 0,
            trial_started_at: 0,
            qivvy_seeded: false,
            mail_enabled: false,
            mail_host: String::new(),
            mail_port: default_imap_port(),
            mail_user: String::new(),
            mail_password: String::new(),
            mail_allowlist: String::new(),
            telegram_enabled: false,
            telegram_token: String::new(),
            telegram_chat_id: 0,
            telegram_pair_code: String::new(),
            connected_folders: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Availability {
    pub builtin: bool,
    pub ollama: bool,
    pub ollama_models: Vec<String>,
    pub lmstudio: bool,
    pub lmstudio_models: Vec<String>,
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub grok: bool,
}

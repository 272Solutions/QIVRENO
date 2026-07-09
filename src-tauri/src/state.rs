use crate::models::*;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct AppState {
    pub agents: Mutex<Vec<Agent>>,
    pub tasks: Mutex<Vec<Task>>,
    pub messages: Mutex<Vec<Message>>,
    pub docs: Mutex<Vec<Doc>>,
    pub memory: Mutex<MemoryStore>,
    pub settings: Mutex<Settings>,
    pub data_dir: PathBuf,
    /// task_id -> child pid, for cancellation.
    pub running_pids: Mutex<HashMap<String, u32>>,
    /// task ids cancelled while running (checked by the ollama loop).
    pub cancelled: Mutex<HashSet<String>>,
}

fn load_vec<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

impl AppState {
    pub fn load(data_dir: PathBuf) -> Self {
        fs::create_dir_all(&data_dir).ok();
        let mut settings: Settings = fs::read_to_string(data_dir.join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // First launch anchors the free trial.
        if settings.trial_started_at == 0 {
            settings.trial_started_at = crate::models::now_ms();
            if let Ok(s) = serde_json::to_string_pretty(&settings) {
                fs::write(data_dir.join("settings.json"), s).ok();
            }
        }
        let mut tasks: Vec<Task> = load_vec(&data_dir.join("tasks.json"));
        // Anything that was mid-flight when the app quit is stale.
        for t in tasks.iter_mut() {
            if t.status == "running" || t.status == "routing" {
                t.status = "failed".to_string();
                t.log.push("interrupted: app was closed while task was running".into());
            }
            if t.column.is_empty() {
                t.column = match t.status.as_str() {
                    "done" => "review",
                    "draft" | "failed" | "cancelled" => "todo",
                    _ => "in_progress",
                }
                .to_string();
            }
        }
        let memory: MemoryStore = fs::read_to_string(data_dir.join("memory.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        AppState {
            agents: Mutex::new(load_vec(&data_dir.join("agents.json"))),
            tasks: Mutex::new(tasks),
            messages: Mutex::new(load_vec(&data_dir.join("messages.json"))),
            docs: Mutex::new(load_vec(&data_dir.join("docs.json"))),
            memory: Mutex::new(memory),
            settings: Mutex::new(settings),
            data_dir,
            running_pids: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
        }
    }

    fn save_json<T: serde::Serialize>(&self, name: &str, value: &T) {
        if let Ok(s) = serde_json::to_string_pretty(value) {
            fs::write(self.data_dir.join(name), s).ok();
        }
    }

    pub fn save_agents(&self) {
        let agents = self.agents.lock().unwrap().clone();
        self.save_json("agents.json", &agents);
    }
    pub fn save_tasks(&self) {
        let tasks = self.tasks.lock().unwrap().clone();
        self.save_json("tasks.json", &tasks);
    }
    pub fn save_messages(&self) {
        let messages = self.messages.lock().unwrap().clone();
        self.save_json("messages.json", &messages);
    }
    pub fn save_docs(&self) {
        let docs = self.docs.lock().unwrap().clone();
        self.save_json("docs.json", &docs);
    }
    pub fn save_memory(&self) {
        let memory = self.memory.lock().unwrap().clone();
        self.save_json("memory.json", &memory);
    }
    pub fn save_settings(&self) {
        let settings = self.settings.lock().unwrap().clone();
        self.save_json("settings.json", &settings);
    }

    pub fn agent(&self, id: &str) -> Option<Agent> {
        self.agents.lock().unwrap().iter().find(|a| a.id == id).cloned()
    }

    /// Resolve an agent by id or (case-insensitive) name.
    pub fn resolve_agent(&self, key: &str) -> Option<Agent> {
        let agents = self.agents.lock().unwrap();
        agents
            .iter()
            .find(|a| a.id == key)
            .or_else(|| agents.iter().find(|a| a.name.eq_ignore_ascii_case(key.trim())))
            .cloned()
    }

    /// Folder every agent (and the operator, via the Files view) can read
    /// and write — where documents, sheets, decks and dashboards live.
    pub fn shared_dir(&self) -> PathBuf {
        let home = crate::platform::home_dir();
        let dir = home.join("Qivreno").join("Shared");
        fs::create_dir_all(&dir).ok();
        dir
    }

    pub fn workspace_dir(&self, agent: &Agent) -> PathBuf {
        let home = crate::platform::home_dir();
        let root = home.join("Qivreno");
        // Pre-rename installs kept agent files in ~/Agentry or ~/AgentWorkspace.
        for legacy in [home.join("Agentry"), home.join("AgentWorkspace")] {
            if !root.exists() && legacy.is_dir() {
                fs::rename(&legacy, &root).ok();
            }
        }
        let slug: String = agent
            .name
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        let dir = root.join(slug);
        fs::create_dir_all(&dir).ok();
        dir
    }
}

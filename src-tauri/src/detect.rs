use crate::models::Availability;
use crate::state::AppState;
use std::path::Path;

fn find_on_path(bin: &str) -> Option<String> {
    // GUI apps get a minimal PATH on macOS; include the usual suspects on
    // both platforms, and probe .exe/.cmd/.bat shims on Windows.
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    for dir in path_dirs.into_iter().chain(crate::platform::extra_cli_dirs()) {
        for name in crate::platform::exe_candidates(bin) {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

pub fn detect_claude() -> Option<String> {
    let local = crate::platform::home_dir().join(".claude").join("local").join("claude");
    if local.is_file() {
        return Some(local.to_string_lossy().into_owned());
    }
    find_on_path("claude")
}

pub fn detect_codex() -> Option<String> {
    find_on_path("codex")
}

/// Models exposed by an OpenAI-compatible server (LM Studio, LocalAI, …).
pub fn lmstudio_models(base_url: &str) -> Vec<String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let resp = ureq::get(&url).timeout(std::time::Duration::from_secs(3)).call();
    let Ok(resp) = resp else { return vec![] };
    let Ok(json) = resp.into_json::<serde_json::Value>() else { return vec![] };
    json["data"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn ollama_models(url: &str) -> Vec<String> {
    let resp = ureq::get(&format!("{url}/api/tags")).timeout(std::time::Duration::from_secs(3)).call();
    let Ok(resp) = resp else { return vec![] };
    let Ok(json) = resp.into_json::<serde_json::Value>() else { return vec![] };
    json["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Fill in empty CLI paths on first run, then report what's usable.
pub fn availability(state: &AppState) -> Availability {
    let mut settings = state.settings.lock().unwrap().clone();
    let mut changed = false;
    // Migrate away from the desktop-app VM binary (not host-executable).
    if settings.claude_path.contains("claude-code-vm") {
        settings.claude_path = String::new();
        changed = true;
    }
    if settings.claude_path.is_empty() {
        if let Some(p) = detect_claude() {
            settings.claude_path = p;
            changed = true;
        }
    }
    if settings.codex_path.is_empty() {
        if let Some(p) = detect_codex() {
            settings.codex_path = p;
            changed = true;
        }
    }
    if changed {
        *state.settings.lock().unwrap() = settings.clone();
        state.save_settings();
    }
    let models = ollama_models(&settings.ollama_url);
    let lm_models = lmstudio_models(&settings.lmstudio_url);
    Availability {
        builtin: settings.builtin_enabled && crate::builtin::is_healthy(&settings),
        ollama: !models.is_empty(),
        ollama_models: models,
        lmstudio: !lm_models.is_empty(),
        lmstudio_models: lm_models,
        claude: !settings.claude_path.is_empty() && Path::new(&settings.claude_path).is_file(),
        codex: !settings.codex_path.is_empty() && Path::new(&settings.codex_path).is_file(),
    }
}

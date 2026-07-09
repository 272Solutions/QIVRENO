use crate::state::AppState;
use serde_json::json;
use std::collections::HashSet;
use std::time::Duration;

/// Pick the best-suited agent for a task. Tries a local LLM (Ollama) first,
/// then falls back to keyword-overlap scoring. Returns (agent_id, reason).
pub fn route(state: &AppState, task_id: &str) -> Option<(String, String)> {
    let task = state.tasks.lock().unwrap().iter().find(|t| t.id == task_id).cloned()?;
    let agents = state.agents.lock().unwrap().clone();
    if agents.is_empty() {
        return None;
    }
    if agents.len() == 1 {
        return Some((agents[0].id.clone(), format!("{} is the only agent", agents[0].name)));
    }
    let text = format!("{} {}", task.title, task.prompt);

    if let Some(pick) = route_via_llm(state, &agents, &text) {
        return Some(pick);
    }
    Some(route_via_keywords(state, &agents, &text))
}

fn route_via_llm(
    state: &AppState,
    agents: &[crate::models::Agent],
    text: &str,
) -> Option<(String, String)> {
    let settings = state.settings.lock().unwrap().clone();
    let roster: String = agents
        .iter()
        .enumerate()
        .map(|(i, a)| format!("{}. {} — {}: {}", i + 1, a.name, a.role, a.skills))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "You dispatch tasks to the best-suited member of a team of AI agents.\n\
         Team:\n{roster}\n\nTask:\n{}\n\n\
         Reply with ONLY the number of the single best-suited agent. No other text.",
        crate::runtime::truncate(text, 2000)
    );

    // Try Ollama first, then the built-in engine.
    let content = ask_ollama(&settings, &prompt)
        .or_else(|| ask_openai_compat(&crate::builtin::base_url(&settings), "qwen3", &prompt, settings.builtin_enabled))?;
    // Take the last number in the reply (skips any stray reasoning text).
    let digits: Vec<usize> = content
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|s| s.parse::<usize>().ok())
        .collect();
    let idx = digits.last().copied()?;
    let agent = agents.get(idx.checked_sub(1)?)?;
    Some((agent.id.clone(), format!("{} (picked by router)", agent.name)))
}

pub(crate) fn ask_ollama(settings: &crate::models::Settings, prompt: &str) -> Option<String> {
    let models = crate::detect::ollama_models(&settings.ollama_url);
    if models.is_empty() {
        return None;
    }
    let model = if !settings.router_model.is_empty() && models.contains(&settings.router_model) {
        settings.router_model.clone()
    } else {
        models[0].clone()
    };
    let resp = ureq::post(&format!("{}/api/chat", settings.ollama_url))
        .timeout(Duration::from_secs(60))
        .send_json(json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": false,
            "think": false,
        }))
        .ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    v["message"]["content"].as_str().map(str::to_string)
}

pub(crate) fn ask_openai_compat(base_url: &str, model: &str, prompt: &str, enabled: bool) -> Option<String> {
    if !enabled {
        return None;
    }
    let resp = ureq::post(&format!("{}/chat/completions", base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(120))
        .send_json(json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": false,
        }))
        .ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    v["choices"][0]["message"]["content"].as_str().map(str::to_string)
}

fn route_via_keywords(
    state: &AppState,
    agents: &[crate::models::Agent],
    text: &str,
) -> (String, String) {
    let words: HashSet<String> = text
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 3)
        .map(str::to_string)
        .collect();
    let busy_count = |agent_id: &str| -> usize {
        state
            .tasks
            .lock()
            .unwrap()
            .iter()
            .filter(|t| {
                (t.status == "running" || t.status == "queued")
                    && t.agent_id.as_deref() == Some(agent_id)
            })
            .count()
    };
    let mut best = (&agents[0], 0usize);
    for agent in agents {
        let profile = format!("{} {} {}", agent.name, agent.role, agent.skills).to_lowercase();
        let score = words.iter().filter(|w| profile.contains(w.as_str())).count();
        let better = score > best.1
            || (score == best.1 && busy_count(&agent.id) < busy_count(&best.0.id));
        if better {
            best = (agent, score);
        }
    }
    (
        best.0.id.clone(),
        format!("{} (keyword match, score {})", best.0.name, best.1),
    )
}

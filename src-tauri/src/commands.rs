use crate::detect;
use crate::models::*;
use crate::runtime;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

pub const MAX_AGENTS: usize = 12;

#[derive(Serialize)]
pub struct Snapshot {
    pub agents: Vec<Agent>,
    pub tasks: Vec<Task>,
    pub messages: Vec<Message>,
    pub docs: Vec<Doc>,
    pub memory: MemoryStore,
    pub settings: Settings,
    pub license: crate::license::LicenseStatus,
}

#[tauri::command]
pub fn get_snapshot(state: State<'_, AppState>) -> Snapshot {
    let settings = state.settings.lock().unwrap().clone();
    Snapshot {
        agents: state.agents.lock().unwrap().clone(),
        tasks: state.tasks.lock().unwrap().clone(),
        messages: state.messages.lock().unwrap().clone(),
        docs: state.docs.lock().unwrap().clone(),
        memory: state.memory.lock().unwrap().clone(),
        license: crate::license::status(&settings.license_key, settings.trial_started_at, &crate::platform::hardware_uuid()),
        settings,
    }
}

#[derive(Serialize)]
pub struct SharedFile {
    /// Path relative to the Shared root, using "/" separators (e.g.
    /// "Invoices/March.md"). Bare filename for files at the root.
    pub name: String,
    pub size: u64,
    pub modified: u64,
    /// True for a directory entry (agents and the operator can open it).
    #[serde(default)]
    pub is_dir: bool,
}

/// Resolve a Shared-relative path safely (no escaping the Shared root).
fn shared_path(state: &AppState, name: &str) -> Result<std::path::PathBuf, String> {
    let name = name.trim().replace('\\', "/");
    let name = name.trim_start_matches('/');
    if name.is_empty() {
        return Err("invalid file name".into());
    }
    // Reject any ".." segment so a crafted name can't escape the Shared root.
    if name.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err("invalid file name".into());
    }
    Ok(state.shared_dir().join(name))
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Walk the Shared tree, returning every file and folder as a root-relative
/// path so the Files view can render a real folder hierarchy.
fn walk_shared(root: &std::path::Path, rel: &str, out: &mut Vec<SharedFile>) {
    let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        // Hidden files and export/temp artifacts stay out of the list.
        if file_name.starts_with('.') || file_name.ends_with(".part") {
            continue;
        }
        let child_rel = if rel.is_empty() { file_name.clone() } else { format!("{rel}/{file_name}") };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            out.push(SharedFile { name: child_rel.clone(), size: 0, modified: modified_ms(&meta), is_dir: true });
            walk_shared(root, &child_rel, out);
        } else if meta.is_file() {
            out.push(SharedFile { name: child_rel, size: meta.len(), modified: modified_ms(&meta), is_dir: false });
        }
    }
}

#[tauri::command]
pub fn list_shared_files(state: State<'_, AppState>) -> Vec<SharedFile> {
    let root = state.shared_dir();
    let mut files = Vec::new();
    walk_shared(&root, "", &mut files);
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    files
}

/// Create a subfolder inside Shared (e.g. "Invoices" or "Clients/Acme").
#[tauri::command]
pub fn create_shared_folder(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let path = shared_path(&state, &name)?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ConnectedFolder {
    pub path: String,
    pub name: String,
    /// False if the folder no longer exists on disk.
    pub exists: bool,
}

#[tauri::command]
pub fn list_connected_folders(state: State<'_, AppState>) -> Vec<ConnectedFolder> {
    let settings = state.settings.lock().unwrap();
    settings
        .connected_folders
        .iter()
        .map(|p| {
            let path = std::path::Path::new(p);
            ConnectedFolder {
                path: p.clone(),
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.clone()),
                exists: path.is_dir(),
            }
        })
        .collect()
}

/// Open the OS folder picker and return the chosen path (None if cancelled).
/// The operator connects it in a second, confirmed step.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.and_then(|f| f.into_path().ok()));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Connect an existing folder on the user's computer so agents can read and
/// (when asked) edit its files. The operator confirms this in the UI first.
#[tauri::command]
pub fn connect_folder(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    let p = std::path::Path::new(trimmed);
    if !p.is_dir() {
        return Err("that folder doesn't exist".into());
    }
    // Keep the path as the OS picker returned it (already absolute and clean).
    // Avoid std::fs::canonicalize here: on Windows it yields an unfriendly
    // \\?\ verbatim path that would show in the UI and agent prompts.
    let folder = trimmed.to_string();
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.lock().unwrap();
        if !settings.connected_folders.iter().any(|f| f == &folder) {
            settings.connected_folders.push(folder);
        }
    }
    state.save_settings();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn disconnect_folder(app: AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.lock().unwrap();
        settings.connected_folders.retain(|f| f != &path);
    }
    state.save_settings();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn read_shared_file(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let path = shared_path(&state, &name)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 4_000_000 {
        return Err("file is too large to open in the app".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn write_shared_file(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = shared_path(&state, &name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_shared_file(app: AppHandle, name: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = shared_path(&state, &name)?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    runtime::emit_changed(&app);
    Ok(())
}

/// Export a shared file next to itself in the requested format.
/// Documents (.md): docx | pdf. Spreadsheets (.csv): xlsx | pdf.
/// Presentations (.slides.json): pptx | pdf. Dashboards (.dash.json): html | pdf.
#[tauri::command]
pub fn export_shared_file(
    state: State<'_, AppState>,
    name: String,
    format: String,
) -> Result<String, String> {
    let path = shared_path(&state, &name)?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lower = name.to_lowercase();

    let parse = |what: &str| -> Result<serde_json::Value, String> {
        serde_json::from_str(&content).map_err(|_| format!("this {what} isn't valid JSON yet"))
    };

    // Deck branding: Qivreno Blue by default, the customer's imported brand when set.
    let (brand_accent, brand_text) = {
        let s = state.settings.lock().unwrap();
        (
            if s.brand_accent.is_empty() { "005DFF".to_string() } else { s.brand_accent.trim_start_matches('#').to_uppercase() },
            if s.brand_text.is_empty() { "111827".to_string() } else { s.brand_text.trim_start_matches('#').to_uppercase() },
        )
    };

    let (base, out_name): (String, String);
    if lower.ends_with(".slides.json") {
        base = name.trim_end_matches(".slides.json").to_string();
        let v = parse("presentation")?;
        match format.as_str() {
            "pptx" => {
                out_name = format!("{base}.pptx");
                crate::pptx::slides_to_pptx(&v, &shared_path(&state, &out_name)?, &brand_accent, &brand_text)?;
            }
            "pdf" => {
                out_name = format!("{base}.pdf");
                std::fs::write(shared_path(&state, &out_name)?, crate::pdf::slides_to_pdf(&v))
                    .map_err(|e| e.to_string())?;
            }
            f => return Err(format!("presentations export as pptx or pdf, not {f}")),
        }
    } else if lower.ends_with(".dash.json") {
        base = name.trim_end_matches(".dash.json").to_string();
        let v = parse("dashboard")?;
        match format.as_str() {
            "html" => {
                out_name = format!("{base}.html");
                std::fs::write(shared_path(&state, &out_name)?, crate::export::dash_to_html(&v))
                    .map_err(|e| e.to_string())?;
            }
            "pdf" => {
                out_name = format!("{base}.pdf");
                std::fs::write(shared_path(&state, &out_name)?, crate::pdf::dash_to_pdf(&v))
                    .map_err(|e| e.to_string())?;
            }
            f => return Err(format!("dashboards export as html or pdf, not {f}")),
        }
    } else if lower.ends_with(".csv") {
        base = name.trim_end_matches(".csv").to_string();
        match format.as_str() {
            "xlsx" => {
                out_name = format!("{base}.xlsx");
                crate::export::csv_to_xlsx(&content, &shared_path(&state, &out_name)?)?;
            }
            "pdf" => {
                out_name = format!("{base}.pdf");
                std::fs::write(shared_path(&state, &out_name)?, crate::pdf::csv_to_pdf(&base, &content))
                    .map_err(|e| e.to_string())?;
            }
            f => return Err(format!("spreadsheets export as xlsx or pdf, not {f}")),
        }
    } else if lower.ends_with(".md") || lower.ends_with(".txt") {
        base = name.rsplit_once('.').map(|(b, _)| b.to_string()).unwrap_or_else(|| name.clone());
        match format.as_str() {
            "docx" => {
                out_name = format!("{base}.docx");
                crate::docx::md_to_docx(&base, &content, &shared_path(&state, &out_name)?)?;
            }
            "pdf" => {
                out_name = format!("{base}.pdf");
                std::fs::write(shared_path(&state, &out_name)?, crate::pdf::md_to_pdf(&base, &content))
                    .map_err(|e| e.to_string())?;
            }
            f => return Err(format!("documents export as docx or pdf, not {f}")),
        }
    } else {
        return Err("no export available for this file type".into());
    }
    Ok(out_name)
}

/// Import a customer's .pptx/.potx brand template: extract its theme colors
/// and store them so future deck exports use the customer's brand.
#[tauri::command]
pub fn import_brand_template(app: AppHandle, data_b64: String) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|_| "could not read the uploaded file")?;
    let (accent, text) = crate::pptx::parse_theme_colors(&bytes)?;
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.lock().unwrap();
        settings.brand_accent = format!("#{accent}");
        settings.brand_text = format!("#{text}");
    }
    state.save_settings();
    runtime::emit_changed(&app);
    Ok(serde_json::json!({ "accent": format!("#{accent}"), "text": format!("#{text}") }))
}

/// Show the shared folder (or one file in it) in Finder.
#[tauri::command]
pub fn reveal_shared(state: State<'_, AppState>, name: Option<String>) -> Result<(), String> {
    let target = match name {
        Some(n) => shared_path(&state, &n)?,
        None => state.shared_dir(),
    };
    crate::platform::reveal(&target, target.is_file())
}

/// Async: `status` probes the engine's health endpoint and (on first call)
/// the machine's RAM — that work must stay off the main thread, and the UI
/// polls this every 1.2s while the Built-in AI panel is open.
#[tauri::command]
pub async fn builtin_status(app: AppHandle) -> crate::builtin::BuiltinStatus {
    tauri::async_runtime::spawn_blocking(move || crate::builtin::status(&app))
        .await
        .expect("builtin_status probe panicked")
}

/// Turn on the built-in AI engine: downloads the model on first use, then
/// starts the bundled server. Progress is polled via builtin_status.
#[tauri::command]
pub async fn builtin_enable(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.lock().unwrap();
        settings.builtin_enabled = true;
    }
    state.save_settings();
    crate::builtin::ensure_started(&app);
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn builtin_disable(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.lock().unwrap();
        settings.builtin_enabled = false;
    }
    state.save_settings();
    crate::builtin::stop(&app);
    runtime::emit_changed(&app);
    Ok(())
}

/// Record acceptance of the current Terms & Conditions (version + timestamp
/// persist in settings.json as the acceptance record).
#[tauri::command]
pub fn accept_terms(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.lock().unwrap();
        settings.terms_accepted_version = crate::models::TERMS_VERSION;
        settings.terms_accepted_at = now_ms();
    }
    state.save_settings();
    runtime::emit_changed(&app);
    Ok(())
}

/// Exit the app (used when the user declines the Terms & Conditions).
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Verify and store a subscription key. An empty string clears it (reverts
/// to trial rules).
/// Accepts either a one-time activation code (QIVACT-…) — redeemed against
/// qivreno.ai for a device-bound key with auto-renewal — or a raw QIV- key
/// (manual/enterprise licensing). Empty clears back to trial rules.
#[tauri::command]
pub async fn apply_license(app: AppHandle, key: String) -> Result<crate::license::LicenseStatus, String> {
    let input = key.trim().to_string();
    if input.to_uppercase().starts_with("QIVACT-") {
        crate::activation::activate_with_code(&app, &input.to_uppercase())?;
    } else {
        if !input.is_empty() {
            let lic = crate::license::parse_and_verify(&input)?;
            if now_ms() > lic.exp + crate::license::GRACE_DAYS * 24 * 60 * 60 * 1000 {
                return Err("that license key has expired — request a renewal from 272 Solutions".into());
            }
            if !lic.device.is_empty() && lic.device != crate::platform::hardware_uuid() {
                return Err("that license key is bound to a different computer".into());
            }
        }
        let state = app.state::<AppState>();
        let mut settings = state.settings.lock().unwrap();
        settings.license_key = input;
        settings.license_refresh_token = String::new();
        drop(settings);
        state.save_settings();
        runtime::emit_changed(&app);
    }
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    Ok(crate::license::status(
        &settings.license_key,
        settings.trial_started_at,
        &crate::platform::hardware_uuid(),
    ))
}

/// Turn off subscription renewal (called after the in-app retention screen).
/// Access continues until the paid-through date; returns that date (epoch ms).
#[tauri::command]
pub async fn cancel_subscription(app: AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || crate::activation::cancel_subscription(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_availability(app: AppHandle) -> Availability {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        detect::availability(&state)
    })
    .await
    .expect("availability probe panicked")
}

#[derive(Deserialize)]
pub struct AgentInput {
    pub name: String,
    pub role: String,
    pub skills: String,
    pub backend: BackendKind,
    #[serde(default)]
    pub model: String,
    pub permission: Permission,
    #[serde(default)]
    pub color: String,
}

#[tauri::command]
pub fn create_agent(app: AppHandle, input: AgentInput) -> Result<Agent, String> {
    create_agent_core(&app, input)
}

/// Enable or disable an agent. Disabled agents receive no tasks, chats or
/// messages (the Concierge auto-disables after onboarding and can be
/// re-enabled here for admin help).
/// Verify IMAP credentials for the Connect Email wizard (nothing is saved).
#[tauri::command]
pub async fn test_mail_connection(host: String, port: u16, user: String, password: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::mail::test_connection(&host, port, &user, &password)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn set_agent_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut agents = state.agents.lock().unwrap();
        let a = agents.iter_mut().find(|a| a.id == id).ok_or("agent not found")?;
        a.enabled = enabled;
    }
    state.save_agents();
    runtime::emit_changed(&app);
    Ok(())
}

/// Shared by the UI command and by agents staffing up via the bus / tools.
pub fn create_agent_core(app: &AppHandle, input: AgentInput) -> Result<Agent, String> {
    let state = app.state::<AppState>();
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("agent needs a name".into());
    }
    // Built-in assistants don't count toward the team size.
    let system = name.eq_ignore_ascii_case("Qivvy") || name.eq_ignore_ascii_case("Concierge");
    {
        let agents = state.agents.lock().unwrap();
        if !system && agents.iter().filter(|a| !a.system).count() >= MAX_AGENTS {
            return Err(format!("workspace is full ({MAX_AGENTS} agents max — Qivvy and the Concierge don't count)"));
        }
        if agents.iter().any(|a| a.name.eq_ignore_ascii_case(&name)) {
            return Err(format!("an agent named '{name}' already exists"));
        }
    }
    let agent = Agent {
        id: Uuid::new_v4().to_string(),
        name,
        role: input.role.trim().to_string(),
        skills: input.skills.trim().to_string(),
        backend: input.backend,
        model: input.model.trim().to_string(),
        permission: input.permission,
        color: if input.color.is_empty() { "#6c8cff".into() } else { input.color },
        system,
        enabled: true,
        created_at: now_ms(),
    };
    state.workspace_dir(&agent); // create it now
    state.agents.lock().unwrap().push(agent.clone());
    state.save_agents();
    runtime::emit_changed(app);
    Ok(agent)
}

#[tauri::command]
pub fn save_doc(
    app: AppHandle,
    title: String,
    kind: String,
    content: String,
) -> Result<String, String> {
    crate::library::save_doc(&app, &title, &kind, &content, "user")
}

#[tauri::command]
pub fn rename_doc(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut docs = state.docs.lock().unwrap();
        if docs.iter().any(|d| d.id != id && d.title.eq_ignore_ascii_case(title.trim())) {
            return Err("another doc already has that title".into());
        }
        let d = docs.iter_mut().find(|d| d.id == id).ok_or("doc not found")?;
        d.title = title.trim().to_string();
        d.updated_at = now_ms();
    }
    state.save_docs();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_doc(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.docs.lock().unwrap().retain(|d| d.id != id);
    state.save_docs();
    runtime::emit_changed(&app);
    Ok(())
}

/// UI editing of memory: direct replacement of an agent's memory or the
/// shared memory ("shared" as the key).
#[tauri::command]
pub fn set_memory(app: AppHandle, key: String, content: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut mem = state.memory.lock().unwrap();
        if key == "shared" {
            mem.shared = runtime::truncate(content.trim(), crate::library::SHARED_MEMORY_CAP);
        } else {
            if content.trim().is_empty() {
                mem.agents.remove(&key);
            } else {
                mem.agents
                    .insert(key, runtime::truncate(content.trim(), crate::library::AGENT_MEMORY_CAP));
            }
        }
    }
    state.save_memory();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn update_agent(app: AppHandle, agent: Agent) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut agents = state.agents.lock().unwrap();
        let existing = agents
            .iter_mut()
            .find(|a| a.id == agent.id)
            .ok_or("agent not found")?;
        *existing = agent;
    }
    state.save_agents();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_agent(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.agents.lock().unwrap().retain(|a| a.id != id);
    {
        let mut tasks = state.tasks.lock().unwrap();
        for t in tasks.iter_mut() {
            if t.agent_id.as_deref() == Some(&id)
                && matches!(t.status.as_str(), "queued" | "routing" | "running")
            {
                t.status = "cancelled".into();
                t.log.push("agent was deleted".into());
            }
        }
    }
    state.save_agents();
    state.save_tasks();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    title: String,
    prompt: String,
    agent_key: Option<String>,
    draft: bool,
) -> Result<Task, String> {
    if prompt.trim().is_empty() {
        return Err("task needs a description".into());
    }
    let title = if title.trim().is_empty() {
        runtime::truncate(prompt.trim().lines().next().unwrap_or(""), 60)
    } else {
        title.trim().to_string()
    };
    if !draft {
        return runtime::submit_task(&app, title, prompt, agent_key, "user".into(), "task".into(), 0);
    }
    // Draft: parked in the To Do column, runs when moved to In Progress.
    let state = app.state::<AppState>();
    let agent_id = match &agent_key {
        Some(key) => Some(
            state
                .resolve_agent(key)
                .ok_or_else(|| format!("no agent named '{key}'"))?
                .id,
        ),
        None => None,
    };
    let task = Task {
        id: Uuid::new_v4().to_string(),
        title,
        prompt,
        agent_id,
        origin: "user".into(),
        kind: "task".into(),
        status: "draft".into(),
        column: "todo".into(),
        parent_id: String::new(),
        input_request: String::new(),
        result: String::new(),
        log: vec![],
        hop: 0,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    state.tasks.lock().unwrap().push(task.clone());
    state.save_tasks();
    runtime::emit_changed(&app);
    Ok(task)
}

#[tauri::command]
pub fn move_task(app: AppHandle, id: String, column: String) -> Result<String, String> {
    runtime::move_task_to(&app, &id, &column, "the operator")
}

/// Answer a task waiting in the Requires Input column; it resumes (or, for
/// unassigned proposals, gets routed) with the answer appended.
#[tauri::command]
pub fn provide_input(app: AppHandle, id: String, answer: String) -> Result<(), String> {
    runtime::provide_input(&app, &id, &answer)
}

#[tauri::command]
pub fn send_chat(app: AppHandle, agent_id: String, body: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let agent = state.agent(&agent_id).ok_or("agent not found")?;
    if body.trim().is_empty() {
        return Err("message is empty".into());
    }
    runtime::push_message(&state, "user", &agent.id, &body, 0);
    runtime::emit_changed(&app);

    // Build the prompt from recent user<->agent conversation.
    let history: Vec<String> = {
        let messages = state.messages.lock().unwrap();
        messages
            .iter()
            .filter(|m| {
                (m.from == "user" && m.to == agent.id) || (m.from == agent.id && m.to == "user")
            })
            .rev()
            .take(20)
            .map(|m| {
                let who = if m.from == "user" { "Operator" } else { &agent.name };
                format!("{who}: {}", runtime::truncate(&m.body, 1500))
            })
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };
    let prompt = format!(
        "This is an ongoing chat with your operator. Recent conversation:\n{}\n\n\
         Reply to the operator's latest message. If it asks you to do work, do it now and report back.",
        history.join("\n")
    );
    runtime::submit_task(
        &app,
        format!("Chat with {}", agent.name),
        prompt,
        Some(agent.id.clone()),
        "user".into(),
        "chat".into(),
        0,
    )?;
    Ok(())
}

#[tauri::command]
pub fn cancel_task(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut was_running = false;
    {
        let mut tasks = state.tasks.lock().unwrap();
        let t = tasks.iter_mut().find(|t| t.id == id).ok_or("task not found")?;
        match t.status.as_str() {
            "queued" | "routing" => {
                t.status = "cancelled".into();
                t.updated_at = now_ms();
            }
            "running" => was_running = true,
            _ => return Err("task already finished".into()),
        }
    }
    if was_running {
        state.cancelled.lock().unwrap().insert(id.clone());
        if let Some(pid) = state.running_pids.lock().unwrap().get(&id).copied() {
            crate::platform::kill_pid(pid);
        }
    }
    state.save_tasks();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_task(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut tasks = state.tasks.lock().unwrap();
        let t = tasks.iter().find(|t| t.id == id).ok_or("task not found")?;
        if matches!(t.status.as_str(), "running" | "routing") {
            return Err("cancel the task before deleting it".into());
        }
        tasks.retain(|t| t.id != id);
    }
    state.save_tasks();
    runtime::emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn update_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.settings.lock().unwrap() = settings;
    state.save_settings();
    runtime::emit_changed(&app);
    Ok(())
}

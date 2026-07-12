use crate::models::*;
use crate::ollama;
use crate::routing;
use crate::state::AppState;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const TASK_TIMEOUT_SECS: u64 = 20 * 60;

pub fn emit_changed(app: &AppHandle) {
    app.emit("changed", ()).ok();
}

pub fn log_task_line(app: &AppHandle, task_id: &str, line: &str) {
    let state = app.state::<AppState>();
    {
        let mut tasks = state.tasks.lock().unwrap();
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
            t.log.push(line.to_string());
            t.updated_at = now_ms();
        }
    }
    state.save_tasks();
    emit_changed(app);
}

/// Create a task and get it running. `agent_key` of None means broadcast:
/// the router picks the best-suited agent.
/// Subscription gate: task execution requires an active trial, license, or
/// grace period. Data stays intact and viewable either way.
pub fn license_ok(state: &AppState) -> Result<(), String> {
    let settings = state.settings.lock().unwrap();
    // Clock-rollback guard: time moving back more than an hour behind the
    // last verified moment invalidates the cached key until the next
    // successful refresh moves the guard forward again.
    if settings.last_seen_ms > now_ms() + 3_600_000 {
        return Err("the system clock appears to have been set back — fix the date/time (the license re-verifies automatically)".into());
    }
    let status = crate::license::status(
        &settings.license_key,
        settings.trial_started_at,
        &crate::platform::hardware_uuid(),
    );
    if status.active {
        Ok(())
    } else if status.state == "trial_expired" {
        Err("your free trial has ended — enter a license key in Settings (⚙) to keep your agents working".into())
    } else {
        Err("your Qivreno subscription has expired — enter a renewed license key in Settings (⚙)".into())
    }
}

pub fn submit_task(
    app: &AppHandle,
    title: String,
    prompt: String,
    agent_key: Option<String>,
    origin: String,
    kind: String,
    hop: u32,
) -> Result<Task, String> {
    let state = app.state::<AppState>();
    license_ok(&state)?;
    let agent_id = match &agent_key {
        Some(key) => {
            let a = state
                .resolve_agent(key)
                .ok_or_else(|| format!("no agent named '{key}'"))?;
            if !a.enabled {
                return Err(format!("{} is disabled — enable them from the team list first", a.name));
            }
            Some(a.id)
        }
        None => None,
    };
    let needs_routing = agent_id.is_none();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        title,
        prompt,
        agent_id,
        origin,
        kind,
        status: if needs_routing { "routing" } else { "queued" }.to_string(),
        column: "in_progress".to_string(),
        parent_id: String::new(),
        input_request: String::new(),
        result: String::new(),
        log: vec![],
        hop,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    state.tasks.lock().unwrap().push(task.clone());
    state.save_tasks();
    emit_changed(app);

    if needs_routing {
        start_routing(app, task.id.clone());
    } else {
        schedule(app);
    }
    Ok(task)
}

/// Pick the best-fit agent for an unassigned task on a background thread,
/// then enqueue it.
pub fn start_routing(app: &AppHandle, task_id: String) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        let state = app2.state::<AppState>();
        let picked = routing::route(&state, &task_id);
        {
            let mut tasks = state.tasks.lock().unwrap();
            if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
                if t.status == "routing" {
                    match &picked {
                        Some((agent_id, reason)) => {
                            t.agent_id = Some(agent_id.clone());
                            t.status = "queued".into();
                            t.log.push(format!("routed to best fit: {reason}"));
                        }
                        None => {
                            t.status = "failed".into();
                            t.column = "todo".into();
                            t.log.push("routing failed: no agents available".into());
                        }
                    }
                    t.updated_at = now_ms();
                }
            }
        }
        state.save_tasks();
        emit_changed(&app2);
        schedule(&app2);
    });
}

/// Sentinel result prefix: an agent paused its task with request_input.
/// Everything after the prefix is the question for the operator.
pub const AWAIT_INPUT: &str = "\u{1}QIVRENO_AWAIT_INPUT\u{1}";

/// Spawn a subtask of `parent_id`, delegated by `creator`. Assignee empty →
/// best-fit routing. The subtask stays linked to its parent on the board and
/// the creator is notified when it finishes.
pub fn create_subtask(
    app: &AppHandle,
    parent_id: &str,
    title: &str,
    details: &str,
    assignee: &str,
    creator: &Agent,
) -> Result<String, String> {
    if title.trim().is_empty() || details.trim().is_empty() {
        return Err("subtask needs a title and details".into());
    }
    let parent_title = {
        let state = app.state::<AppState>();
        let tasks = state.tasks.lock().unwrap();
        tasks
            .iter()
            .find(|t| t.id == parent_id)
            .map(|t| t.title.clone())
            .unwrap_or_default()
    };
    let prompt = format!(
        "You have been handed a subtask of the larger project \"{parent_title}\" by {}, who is coordinating it.\n\nYour subtask: {}\n\n{}\n\nDo this piece thoroughly and report a review-ready result — {} will integrate it into the overall project.",
        creator.name, title.trim(), details.trim(), creator.name
    );
    let assignee_key = {
        let a = assignee.trim();
        if a.is_empty() || a.eq_ignore_ascii_case("auto") || a.eq_ignore_ascii_case(&creator.name) {
            None
        } else {
            Some(a.to_string())
        }
    };
    let task = submit_task(
        app,
        title.trim().to_string(),
        prompt,
        assignee_key.clone(),
        creator.id.clone(),
        "task".into(),
        0,
    )?;
    {
        let state = app.state::<AppState>();
        let mut tasks = state.tasks.lock().unwrap();
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            t.parent_id = parent_id.to_string();
            t.log.push(format!("subtask of '{parent_title}' created by {}", creator.name));
        }
        state.save_tasks();
    }
    emit_changed(app);
    Ok(format!(
        "subtask '{}' (id {}) created and {} — you will receive its result when it finishes",
        title.trim(),
        &task.id[..8],
        match assignee_key {
            Some(a) => format!("assigned to {a}"),
            None => "being routed to the best-fit teammate".into(),
        }
    ))
}

/// Resume a requires_input task with the operator's answer. Unassigned
/// proposals (e.g. from email) are routed to the best-fit agent.
pub fn provide_input(app: &AppHandle, task_id: &str, answer: &str) -> Result<(), String> {
    if answer.trim().is_empty() {
        return Err("answer is empty".into());
    }
    let state = app.state::<AppState>();
    license_ok(&state)?;
    let needs_routing;
    {
        let mut tasks = state.tasks.lock().unwrap();
        let t = tasks
            .iter_mut()
            .find(|t| t.id == task_id && t.column == "requires_input")
            .ok_or("that task is not waiting for input")?;
        t.prompt.push_str(&format!(
            "\n\n--- OPERATOR INPUT ---\nQuestion put to the operator: {}\nThe operator answered: {}\nContinue the task using this answer. Do not ask the same question again.",
            t.input_request, answer.trim()
        ));
        t.input_request = String::new();
        needs_routing = t.agent_id.is_none();
        t.status = if needs_routing { "routing" } else { "queued" }.into();
        t.column = "in_progress".into();
        t.log.push("operator provided input — resuming".into());
        t.updated_at = now_ms();
    }
    state.save_tasks();
    emit_changed(app);
    if needs_routing {
        start_routing(app, task_id.to_string());
    } else {
        schedule(app);
    }
    Ok(())
}

/// Park a brand-new, unassigned task proposal in Requires Input for the
/// operator to approve (used by the email watcher). Nothing runs until
/// provide_input is called.
pub fn propose_task(app: &AppHandle, title: &str, prompt: &str, question: &str) {
    let state = app.state::<AppState>();
    {
        let tasks = state.tasks.lock().unwrap();
        // Dedupe: an identical open proposal already on the board.
        if tasks
            .iter()
            .any(|t| t.column == "requires_input" && t.title == title && t.status == "waiting")
        {
            return;
        }
    }
    let task = Task {
        id: Uuid::new_v4().to_string(),
        title: title.to_string(),
        prompt: prompt.to_string(),
        agent_id: None,
        origin: "user".into(),
        kind: "task".into(),
        status: "waiting".into(),
        column: "requires_input".into(),
        parent_id: String::new(),
        input_request: question.to_string(),
        result: String::new(),
        log: vec!["proposed automatically — waiting for operator approval".into()],
        hop: 0,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    state.tasks.lock().unwrap().push(task);
    state.save_tasks();
    emit_changed(app);
}

/// Seed Qivvy, the default project-manager agent, once per install.
pub fn ensure_qivvy(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let settings = state.settings.lock().unwrap();
        if settings.qivvy_seeded {
            return;
        }
    }
    let exists = state
        .agents
        .lock()
        .unwrap()
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case("Qivvy"));
    if !exists {
        let agent = Agent {
            id: Uuid::new_v4().to_string(),
            name: "Qivvy".into(),
            role: "Project Manager".into(),
            skills: "project coordination ONLY — never executes domain work directly: digests large or multi-part requests, breaks them into clear subtasks with create_subtask, delegates every piece to the best-suited teammate, tracks progress on the board, integrates the pieces into one coherent deliverable, flags risks and open decisions to the operator with request_input; scope definition, work breakdown structures, scheduling and sequencing, dependency and risk tracking, status reporting, stakeholder communication".into(),
            backend: crate::models::BackendKind::Builtin,
            model: String::new(),
            permission: crate::models::Permission::Sandboxed,
            color: "#f2a65a".into(),
            system: true,
            enabled: true,
            created_at: now_ms(),
        };
        state.agents.lock().unwrap().push(agent);
        state.save_agents();
    }
    {
        let mut settings = state.settings.lock().unwrap();
        settings.qivvy_seeded = true;
    }
    state.save_settings();
    emit_changed(app);
}

/// Move a task to a kanban column, on behalf of the operator or an agent.
/// `key` may be a task id, an id prefix, or an exact title. Moving an
/// inactive task to in_progress (re)dispatches it.
pub fn move_task_to(app: &AppHandle, key: &str, column: &str, actor: &str) -> Result<String, String> {
    let column = column.trim().to_lowercase().replace([' ', '-'], "_");
    if !matches!(column.as_str(), "todo" | "in_progress" | "review" | "requires_input" | "done") {
        return Err(format!("unknown column '{column}' — use todo, in_progress, review, requires_input or done"));
    }
    let state = app.state::<AppState>();
    let key_trimmed = key.trim();
    let mut needs_routing: Option<String> = None;
    let mut needs_schedule = false;
    let moved_title;
    {
        let mut tasks = state.tasks.lock().unwrap();
        let idx = tasks
            .iter()
            .position(|t| {
                t.kind == "task"
                    && (t.id == key_trimmed
                        || (key_trimmed.len() >= 6 && t.id.starts_with(key_trimmed))
                        || t.title.eq_ignore_ascii_case(key_trimmed))
            })
            .ok_or_else(|| format!("no board task matching '{key_trimmed}'"))?;
        let t = &mut tasks[idx];
        let active = matches!(t.status.as_str(), "routing" | "queued" | "running");
        match column.as_str() {
            "in_progress" => {
                if !active {
                    license_ok(&state)?;
                    // Re-dispatch: draft, failed, cancelled or done tasks start a fresh run.
                    if t.agent_id.is_some() {
                        t.status = "queued".into();
                        needs_schedule = true;
                    } else {
                        t.status = "routing".into();
                        needs_routing = Some(t.id.clone());
                    }
                    t.log.push(format!("dispatched by {actor}"));
                }
            }
            "todo" => {
                if t.status == "running" {
                    return Err("task is running — cancel it before moving it back to To Do".into());
                }
                if t.status == "routing" || t.status == "queued" {
                    t.status = "draft".into();
                    t.log.push(format!("pulled back to backlog by {actor}"));
                }
            }
            _ => {
                if active {
                    return Err("task is still being worked on — wait for it to finish or cancel it".into());
                }
                t.log.push(format!("moved to {column} by {actor}"));
            }
        }
        t.column = column.clone();
        t.updated_at = now_ms();
        moved_title = t.title.clone();
    }
    state.save_tasks();
    emit_changed(app);
    if let Some(id) = needs_routing {
        start_routing(app, id);
    } else if needs_schedule {
        schedule(app);
    }
    Ok(format!("moved '{moved_title}' to {column}"))
}

/// Compact text listing of the kanban board, for agents.
pub fn board_summary(state: &AppState) -> String {
    let tasks = state.tasks.lock().unwrap();
    let agents = state.agents.lock().unwrap();
    let mut lines: Vec<String> = vec![];
    for col in ["todo", "in_progress", "review", "requires_input", "done"] {
        lines.push(format!("[{col}]"));
        let mut any = false;
        for t in tasks.iter().filter(|t| t.kind == "task" && t.column == col) {
            let who = t
                .agent_id
                .as_deref()
                .and_then(|id| agents.iter().find(|a| a.id == id))
                .map(|a| a.name.clone())
                .unwrap_or_else(|| "unassigned".into());
            lines.push(format!("  {} | {} | {} | {}", &t.id[..8], t.title, t.status, who));
            any = true;
        }
        if !any {
            lines.push("  (empty)".into());
        }
    }
    lines.join("\n")
}

/// Start queued tasks for every agent that isn't already busy (one task per
/// agent at a time).
pub fn schedule(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut to_start: Vec<String> = vec![];
    {
        let mut tasks = state.tasks.lock().unwrap();
        let mut busy: HashSet<String> = tasks
            .iter()
            .filter(|t| t.status == "running")
            .filter_map(|t| t.agent_id.clone())
            .collect();
        // Work from the user (chats, then board tasks) outranks
        // agent-to-agent message traffic; ties go to the oldest.
        let mut queued: Vec<(u8, u64, String, String)> = tasks
            .iter()
            .filter(|t| t.status == "queued" && t.agent_id.is_some())
            .map(|t| {
                let priority = match t.kind.as_str() {
                    "chat" => 0,
                    "task" => 1,
                    _ => 2,
                };
                (priority, t.created_at, t.id.clone(), t.agent_id.clone().unwrap())
            })
            .collect();
        queued.sort();
        for (_, _, task_id, agent_id) in queued {
            if busy.insert(agent_id) {
                if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
                    t.status = "running".into();
                    t.updated_at = now_ms();
                }
                to_start.push(task_id);
            }
        }
    }
    if to_start.is_empty() {
        return;
    }
    state.save_tasks();
    emit_changed(app);
    for task_id in to_start {
        let app2 = app.clone();
        std::thread::spawn(move || run_task(app2, task_id));
    }
}

fn run_task(app: AppHandle, task_id: String) {
    let state = app.state::<AppState>();
    let (task, agent, settings) = {
        let tasks = state.tasks.lock().unwrap();
        let Some(task) = tasks.iter().find(|t| t.id == task_id).cloned() else {
            return;
        };
        let agent = task.agent_id.as_deref().and_then(|id| state.agent(id));
        (task, agent, state.settings.lock().unwrap().clone())
    };
    let Some(agent) = agent else {
        finalize(&app, &task_id, Err("agent no longer exists".into()));
        return;
    };

    let preamble = build_preamble(&state, &agent, &settings, &task);
    let full_prompt = format!("{preamble}\n\n---\n\n{}", task.prompt);
    log_task_line(
        &app,
        &task_id,
        &format!("started on {} ({:?} backend)", agent.name, agent.backend),
    );

    let outcome = run_backend(&app, &task_id, &agent, &settings, &full_prompt);

    // Local models are always the safety net: if the primary backend fails
    // for any reason other than cancellation, rerun on the best installed
    // local backend with a preamble rebuilt for it.
    let outcome = match outcome {
        Err(e) if e != "cancelled" && !state.cancelled.lock().unwrap().contains(&task_id) => {
            if let Some(mut fallback_agent) = pick_local_fallback(&settings, &agent) {
                log_task_line(
                    &app,
                    &task_id,
                    &format!(
                        "{:?} backend failed ({}); falling back to {:?}",
                        agent.backend,
                        truncate(&e, 200),
                        fallback_agent.backend
                    ),
                );
                fallback_agent.id = agent.id.clone(); // keep identity/token
                let fb_prompt = format!(
                    "{}\n\n---\n\n{}",
                    build_preamble(&state, &fallback_agent, &settings, &task),
                    task.prompt
                );
                run_backend(&app, &task_id, &fallback_agent, &settings, &fb_prompt)
            } else {
                Err(e)
            }
        }
        other => other,
    };

    // Board tasks must arrive in Review with a substantive report. If the
    // agent's own wrap-up is thin, compose one from the evidence (log +
    // the actual files it wrote) using whatever local model is available.
    let outcome = match outcome {
        Ok(result)
            if task.kind == "task"
                && result.trim().len() < 400
                && !result.starts_with(AWAIT_INPUT) =>
        {
            log_task_line(&app, &task_id, "composing review report…");
            match compose_report(&app, &task_id, &agent, &result) {
                Some(report) => Ok(report),
                None => Ok(result),
            }
        }
        other => other,
    };
    finalize(&app, &task_id, outcome);
}

/// Build a completion report from the task, its action log, and the content
/// of Shared files written during the run. Uses the cheapest local model.
fn compose_report(app: &AppHandle, task_id: &str, agent: &Agent, raw_result: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let task = state.tasks.lock().unwrap().iter().find(|t| t.id == task_id).cloned()?;

    // Only real actions go to the composer — routing/backend lines are
    // internal plumbing that must not leak into an operator-facing report.
    let tool_lines: Vec<String> = task
        .log
        .iter()
        .filter(|l| l.starts_with("tool: "))
        .cloned()
        .collect();
    let mut ctx = format!(
        "Task requested by the operator:\n{}\n\nActions you took (complete list — you did nothing else):\n{}\n\nYour own closing message:\n{}\n",
        truncate(&task.prompt, 1500),
        if tool_lines.is_empty() { "(no tool actions)".to_string() } else { tool_lines.join("\n") },
        if raw_result.trim().is_empty() { "(none)" } else { raw_result }.to_owned()
    );
    // Attach the content of Shared files this run created, so the report can
    // describe the actual deliverables.
    let shared = state.shared_dir();
    let mut written_files: Vec<String> = vec![];
    let mut attached = 0;
    for line in &task.log {
        if let Some(rest) = line.strip_prefix("tool: write_file ") {
            if let Some(p) = rest.find("\"path\":\"Shared/") {
                let start = p + 15;
                if let Some(end) = rest[start..].find('"') {
                    let name = &rest[start..start + end];
                    written_files.push(format!("Shared/{name}"));
                    if let Ok(content) = std::fs::read_to_string(shared.join(name)) {
                        ctx.push_str(&format!(
                            "\nContent of Shared/{name}:\n{}\n",
                            truncate(&content, 2500)
                        ));
                        attached += 1;
                        if attached >= 3 {
                            break;
                        }
                    }
                }
            }
        }
    }

    let deliverables_rule = if written_files.is_empty() {
        "You created NO files in this run — the Deliverables section MUST say 'None'. Do not list \
         any file, document format, or artifact."
            .to_string()
    } else {
        format!(
            "The ONLY deliverables you may list are exactly these files (no others exist): {}.",
            written_files.join(", ")
        )
    };
    let prompt = format!(
        "You are {name}, the {role} on a business's AI team. Write your completion report for the \
         operator who will review this task before approving it. Write in first person, factually, \
         based STRICTLY on the information below — never invent actions or artifacts.\n\
         Rules:\n- {deliverables_rule}\n\
         - Never mention AI backends, models, routing, tools, fallbacks, or the writing of this report.\n\
         - If little was accomplished, say so plainly and recommend what to do next.\n\
         Use exactly these Markdown sections:\n\
         ### What I did\n(3-6 sentence narrative)\n\
         ### Deliverables\n(one bullet per file with its exact name and what it contains; or 'None')\n\
         ### Key decisions\n(bullets)\n\
         ### Needs your attention\n(approvals, open questions, or 'Nothing — ready to approve.')\n\n{ctx}",
        name = agent.name,
        role = agent.role,
    );
    let report = routing::ask_ollama(&settings, &prompt).or_else(|| {
        routing::ask_openai_compat(
            &crate::builtin::base_url(&settings),
            "qwen3",
            &prompt,
            settings.builtin_enabled && crate::builtin::is_healthy(&settings),
        )
    })?;
    let report = crate::ollama::strip_thinking(&report);
    if report.trim().len() < 80 {
        return None;
    }
    log_task_line(app, task_id, "review report composed");
    Some(report)
}

fn run_backend(
    app: &AppHandle,
    task_id: &str,
    agent: &Agent,
    settings: &Settings,
    full_prompt: &str,
) -> Result<String, String> {
    match agent.backend {
        BackendKind::Claude => run_claude(app, task_id, agent, settings, full_prompt),
        BackendKind::Codex => run_codex(app, task_id, agent, settings, full_prompt),
        BackendKind::Ollama => ollama::run_agent_loop(app, task_id, agent, settings, full_prompt),
        BackendKind::Lmstudio => crate::lmstudio::run_agent_loop(app, task_id, agent, settings, full_prompt),
        BackendKind::Builtin => {
            if !crate::builtin::is_healthy(settings) {
                crate::builtin::ensure_started(app);
                Err("built-in AI engine is not running yet — it is starting up (or needs enabling in Settings); try again shortly".into())
            } else {
                crate::lmstudio::run_agent_loop_at(
                    app,
                    task_id,
                    agent,
                    &crate::builtin::base_url(settings),
                    "qwen3",
                    full_prompt,
                )
            }
        }
    }
}

/// Best installed local backend that isn't the one that just failed.
/// Preference: built-in engine, then Ollama, then LM Studio.
fn pick_local_fallback(settings: &Settings, failed: &Agent) -> Option<Agent> {
    let mut clone = failed.clone();
    if failed.backend != BackendKind::Builtin
        && settings.builtin_enabled
        && crate::builtin::is_healthy(settings)
    {
        clone.backend = BackendKind::Builtin;
        clone.model = String::new();
        return Some(clone);
    }
    if failed.backend != BackendKind::Ollama {
        let models = crate::detect::ollama_models(&settings.ollama_url);
        if !models.is_empty() {
            clone.backend = BackendKind::Ollama;
            clone.model = if !settings.router_model.is_empty() && models.contains(&settings.router_model) {
                settings.router_model.clone()
            } else {
                models[0].clone()
            };
            return Some(clone);
        }
    }
    if failed.backend != BackendKind::Lmstudio {
        let models = crate::detect::lmstudio_models(&settings.lmstudio_url);
        if !models.is_empty() {
            clone.backend = BackendKind::Lmstudio;
            clone.model = models[0].clone();
            return Some(clone);
        }
    }
    None
}

fn build_preamble(state: &AppState, agent: &Agent, settings: &Settings, task: &Task) -> String {
    let workspace = state.workspace_dir(agent);
    let roster: String = {
        let agents = state.agents.lock().unwrap();
        agents
            .iter()
            .filter(|a| a.id != agent.id)
            .map(|a| format!("- {} — {} ({})", a.name, a.role, a.skills))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let shared = state.shared_dir();
    let mut p = format!(
        "You are {name}, the {role} of a multi-agent team called Qivreno, operated by your human owner.\n\
         Your responsibilities and skills: {skills}\n\
         Your private working directory is: {ws}\n\
         The team's shared folder (visible to the operator in the Files view and to every teammate) is: {sh}\n",
        name = agent.name,
        role = agent.role,
        skills = agent.skills,
        ws = workspace.display(),
        sh = shared.display(),
    );
    if agent.system && agent.name.eq_ignore_ascii_case("Qivvy") {
        p.push_str(
            "\nYOU ARE THE COORDINATOR, NOT AN EXECUTOR. You never produce domain deliverables \
             (documents, copy, analyses, code) yourself. For EVERY piece of executable work — even \
             a task that looks like one specialist's job — digest it, then hand it off with \
             create_subtask to the right teammate (or leave assignee empty for best-fit routing). \
             Your own output is limited to: the work breakdown, delegation briefs, progress \
             tracking, integrating teammates' results into the final package, and a status \
             summary for the operator. If the team lacks the needed role, hire one with \
             create_agent, then delegate to them.\n",
        );
    }
    match agent.backend {
        BackendKind::Builtin | BackendKind::Ollama | BackendKind::Lmstudio => p.push_str(
            "Address the shared folder with the Shared/ path prefix in your file tools \
             (e.g. write_file path \"Shared/Q3 Plan.md\").\n",
        ),
        _ => p.push_str("You can read and write files in the shared folder directly by that path.\n"),
    }
    p.push_str(
        "Scratch work belongs in your private directory. Deliverables for the operator belong \
         in the shared folder, in these formats so they render in the app:\n\
         - Text document / report: Markdown (.md)\n\
         - Spreadsheet: CSV with a header row (.csv)\n\
         - Presentation: <name>.slides.json — {\"title\":\"…\",\"slides\":[{\"title\":\"…\",\"bullets\":[\"…\"],\"notes\":\"…\"}]}\n\
         - Dashboard: <name>.dash.json — {\"title\":\"…\",\"widgets\":[{\"type\":\"stat\",\"label\":\"…\",\"value\":\"…\",\"sub\":\"…\"},\
{\"type\":\"bar\",\"label\":\"…\",\"data\":[{\"x\":\"Jan\",\"y\":12}]},{\"type\":\"line\",\"label\":\"…\",\"data\":[{\"x\":\"W1\",\"y\":3}]},\
{\"type\":\"table\",\"label\":\"…\",\"headers\":[\"…\"],\"rows\":[[\"…\"]]}]}\n\
         Teammates collaborate on these files — read a file before improving it, and mention the \
         exact file name when handing work to a teammate.\n",
    );
    if roster.is_empty() {
        p.push_str("\nYou currently have no teammate agents.\n");
    } else {
        p.push_str(&format!("\nYour teammate agents:\n{roster}\n"));
        match agent.backend {
            BackendKind::Builtin | BackendKind::Ollama | BackendKind::Lmstudio => p.push_str(
                "\nUse the send_message tool to message or delegate work to a teammate. \
                 Replies arrive asynchronously as new tasks for you.\n",
            ),
            _ => p.push_str(&format!(
                "\nTo message or delegate work to a teammate, run this shell command:\n\
                 curl -s -X POST http://127.0.0.1:{port}/message -H 'Content-Type: application/json' \
                 -d '{{\"token\":\"{token}\",\"to\":\"<teammate name>\",\"body\":\"<your message>\"}}'\n\
                 Replies arrive asynchronously as new tasks for you — do not wait for them.\n",
                port = settings.bus_port,
                token = agent.id,
            )),
        }
    }
    match agent.backend {
        BackendKind::Builtin | BackendKind::Ollama | BackendKind::Lmstudio => p.push_str(
            "\nThe team shares a kanban board (columns: todo, in_progress, review, requires_input, done). \
             Use the list_board tool to see it and the move_task tool to move a task \
             (e.g. move a teammate's reviewed work to done). Tasks you complete move to \
             review automatically — do not move your own current task.\n\
             \nLarge or multi-part projects: use the create_subtask tool to split the work and \
             delegate pieces to the best-suited teammates. Each subtask stays linked to your task \
             and its result comes back to you; you integrate everything into the final deliverable.\n\
             \nIf you are blocked on a decision or missing information only the operator has, use the \
             request_input tool with ONE complete question — your task parks in Requires Input and \
             resumes automatically when they answer. Use it sparingly; prefer sensible assumptions \
             (and state them) for anything reversible.\n\
             \nThe operator's calendar is available: calendar_events shows their upcoming schedule \
             (deadlines, meetings, availability); calendar_add_event books meetings, deadlines and \
             reminders directly into their Calendar. Always check calendar_events before proposing \
             or booking a time.\n",
        ),
        _ => p.push_str(&format!(
            "\nThe team shares a kanban board (columns: todo, in_progress, review, requires_input, done). \
             To view it: curl -s http://127.0.0.1:{port}/board\n\
             To move a task on it: curl -s -X POST http://127.0.0.1:{port}/board/move \
             -H 'Content-Type: application/json' \
             -d '{{\"token\":\"{token}\",\"task\":\"<task id or exact title>\",\"column\":\"<column>\"}}'\n\
             Tasks you complete move to review automatically — do not move your own current task.\n",
            port = settings.bus_port,
            token = agent.id,
        )),
    }
    if task.kind == "task" {
        p.push_str(&format!("This task's board id is {}.\n", task.id));
    }

    // Business context: profile, library, and memory.
    let index = crate::library::docs_index(state);
    let profile = {
        let docs = state.docs.lock().unwrap();
        docs.iter()
            .find(|d| d.title.eq_ignore_ascii_case("Business Profile"))
            .map(|d| truncate(&d.content, 2500))
    };
    let (own_memory, shared_memory) = {
        let mem = state.memory.lock().unwrap();
        (mem.agents.get(&agent.id).cloned(), mem.shared.clone())
    };
    p.push_str("\n=== Business context ===\n");
    match &profile {
        Some(text) => p.push_str(&format!("Business profile:\n{text}\n")),
        None => p.push_str(
            "Business profile: (not filled in yet — base answers on the operator's requests, \
             and encourage them to fill in the Library)\n",
        ),
    }
    p.push_str(&format!("\nBusiness library (id | kind | title):\n{index}\n"));
    p.push_str(&format!(
        "\nShared team memory:\n{}\n",
        if shared_memory.is_empty() { "(empty)" } else { &shared_memory }
    ));
    p.push_str(&format!(
        "\nYour private memory:\n{}\n",
        own_memory.as_deref().unwrap_or("(empty — build it up as you work)")
    ));
    match agent.backend {
        BackendKind::Builtin | BackendKind::Ollama | BackendKind::Lmstudio => p.push_str(
            "\nAlways follow the business profile and documented processes. Tools: list_library / \
             read_doc to consult docs; save_process to document any repeatable workflow you perform \
             (check for an existing process first); create_agent only if the team is missing a \
             needed role. At the end of a significant task, maintain memory with update_memory: \
             scope 'self' REPLACES your private memory (rewrite it fully — merge new durable facts, \
             prune stale ones); scope 'shared' adds one short fact the whole team should know.\n",
        ),
        _ => p.push_str(&format!(
            "\nAlways follow the business profile and documented processes. Library & memory API \
             (same host as above):\n\
             - Read a doc: curl -s -X POST http://127.0.0.1:{port}/library/read -H 'Content-Type: application/json' -d '{{\"doc\":\"<id or title>\"}}'\n\
             - Document a repeatable process (check the library for an existing one first): \
             curl -s -X POST http://127.0.0.1:{port}/library/save -H 'Content-Type: application/json' \
             -d '{{\"token\":\"{token}\",\"title\":\"<name>\",\"kind\":\"process\",\"content\":\"<numbered steps>\"}}'\n\
             - Maintain memory at the end of significant tasks: curl -s -X POST http://127.0.0.1:{port}/memory \
             -H 'Content-Type: application/json' -d '{{\"token\":\"{token}\",\"scope\":\"self|shared\",\"content\":\"...\"}}' \
             (scope self REPLACES your private memory — send the full refined text; scope shared adds one short team-wide fact)\n\
             - Hire a missing role: curl -s -X POST http://127.0.0.1:{port}/agents/create \
             -H 'Content-Type: application/json' -d '{{\"token\":\"{token}\",\"name\":\"<Name>\",\"role\":\"<Role>\",\"skills\":\"<skills>\"}}'\n",
            port = settings.bus_port,
            token = agent.id,
        )),
    }
    if task.kind == "message" {
        p.push_str(
            "\nThe input below is a message from a teammate agent. Handle any request in it, \
             and your final response will be delivered back to them.\n\
             IMPORTANT: if the message needs no action or answer from you (it is just an \
             acknowledgment, confirmation, or thank-you), respond with exactly NO_REPLY and nothing else.\n",
        );
    } else if !roster.is_empty() {
        p.push_str(
            "Only message a teammate when you need something from them or have new information \
             they need — never just to acknowledge or thank them.\n",
        );
    }
    if agent.permission == Permission::Sandboxed {
        p.push_str("\nYou are sandboxed: work only within your working directory and the shared folder.\n");
    }
    p.push_str(
        "\nWhen you are done, your FINAL message must be a completion report the operator reviews \
before approving your work. Format it in Markdown with exactly these sections:\n\
### What I did\nA clear paragraph (3-6 sentences) narrating what you actually did and why — \
written for a busy owner, not a log.\n\
### Deliverables\nOne bullet per file, library doc or process you created or changed, with its \
exact name and a one-line description of what's inside. Write 'None' if there are none.\n\
### Key decisions\nBullet the important choices, assumptions or numbers in your work.\n\
### Needs your attention\nAnything requiring the operator's approval, decision or follow-up. \
Write 'Nothing — ready to approve.' if clean.\n\
Never end with an empty message or a one-liner.\n",
    );
    p
}

/// Spawn a child, capture output on reader threads, enforce timeout + cancel.
fn run_child(
    app: &AppHandle,
    task_id: &str,
    mut cmd: Command,
    stdin_data: Option<String>,
) -> Result<(i32, String, String), String> {
    let state = app.state::<AppState>();
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd.spawn().map_err(|e| format!("failed to launch: {e}"))?;
    state.running_pids.lock().unwrap().insert(task_id.to_string(), child.id());

    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            std::thread::spawn(move || {
                stdin.write_all(data.as_bytes()).ok();
            });
        }
    }
    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let mut readers = vec![];
    if let Some(mut out) = child.stdout.take() {
        let buf = stdout_buf.clone();
        readers.push(std::thread::spawn(move || {
            let mut s = String::new();
            out.read_to_string(&mut s).ok();
            *buf.lock().unwrap() = s;
        }));
    }
    if let Some(mut err) = child.stderr.take() {
        let buf = stderr_buf.clone();
        readers.push(std::thread::spawn(move || {
            let mut s = String::new();
            err.read_to_string(&mut s).ok();
            *buf.lock().unwrap() = s;
        }));
    }

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed().as_secs() > TASK_TIMEOUT_SECS {
                    child.kill().ok();
                    child.wait().ok();
                    state.running_pids.lock().unwrap().remove(task_id);
                    return Err(format!("timed out after {} minutes", TASK_TIMEOUT_SECS / 60));
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            Err(e) => {
                state.running_pids.lock().unwrap().remove(task_id);
                return Err(format!("wait failed: {e}"));
            }
        }
    };
    for r in readers {
        r.join().ok();
    }
    state.running_pids.lock().unwrap().remove(task_id);
    let out = stdout_buf.lock().unwrap().clone();
    let err = stderr_buf.lock().unwrap().clone();
    Ok((status.code().unwrap_or(-1), out, err))
}

fn run_claude(
    app: &AppHandle,
    task_id: &str,
    agent: &Agent,
    settings: &Settings,
    prompt: &str,
) -> Result<String, String> {
    if settings.claude_path.is_empty() {
        return Err("Claude CLI not found — set its path in Settings".into());
    }
    let state = app.state::<AppState>();
    let workspace = state.workspace_dir(agent);
    let mut cmd = Command::new(&settings.claude_path);
    cmd.current_dir(&workspace)
        .arg("-p")
        .arg("--output-format")
        .arg("json")
        .arg("--max-turns")
        .arg("50");
    if !agent.model.is_empty() {
        cmd.arg("--model").arg(&agent.model);
    }
    match agent.permission {
        Permission::Full => {
            cmd.arg("--dangerously-skip-permissions");
        }
        Permission::Sandboxed => {
            cmd.arg("--allowedTools").arg(
                "Bash(curl:*),Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch,TodoWrite,NotebookEdit",
            );
            // Grant the shared team folder alongside the private workspace.
            cmd.arg("--add-dir").arg(state.shared_dir());
        }
    }
    let (code, out, err) = run_child(app, task_id, cmd, Some(prompt.to_string()))?;
    if code != 0 && out.trim().is_empty() {
        return Err(format!("claude exited with code {code}: {}", tail(&err, 2000)));
    }
    // -p --output-format json prints one JSON object with a `result` field.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(out.trim()) {
        if let Some(r) = v["result"].as_str() {
            if v["is_error"].as_bool() == Some(true) {
                return Err(r.to_string());
            }
            return Ok(r.to_string());
        }
    }
    Ok(out.trim().to_string())
}

fn run_codex(
    app: &AppHandle,
    task_id: &str,
    agent: &Agent,
    settings: &Settings,
    prompt: &str,
) -> Result<String, String> {
    if settings.codex_path.is_empty() {
        return Err("Codex CLI not found — install it (npm i -g @openai/codex) or set its path in Settings".into());
    }
    let state = app.state::<AppState>();
    let workspace = state.workspace_dir(agent);
    let last_msg = std::env::temp_dir().join(format!("agentws-{task_id}.txt"));
    let mut cmd = Command::new(&settings.codex_path);
    cmd.current_dir(&workspace)
        .arg("exec")
        .arg("--skip-git-repo-check")
        .arg("--output-last-message")
        .arg(&last_msg);
    match agent.permission {
        Permission::Full => {
            cmd.arg("--dangerously-bypass-approvals-and-sandbox");
        }
        Permission::Sandboxed => {
            cmd.arg("--sandbox").arg("workspace-write");
            cmd.arg("-c").arg(format!(
                "sandbox_workspace_write.writable_roots=[\"{}\"]",
                state.shared_dir().display()
            ));
        }
    }
    cmd.arg(prompt);
    let (code, out, err) = run_child(app, task_id, cmd, None)?;
    let last = std::fs::read_to_string(&last_msg).unwrap_or_default();
    std::fs::remove_file(&last_msg).ok();
    if !last.trim().is_empty() {
        return Ok(last.trim().to_string());
    }
    if code != 0 {
        return Err(format!("codex exited with code {code}: {}", tail(&err, 2000)));
    }
    Ok(tail(&out, 4000))
}

fn tail(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.len() <= n {
        return s.to_string();
    }
    let mut start = s.len() - n;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

fn finalize(app: &AppHandle, task_id: &str, outcome: Result<String, String>) {
    let state = app.state::<AppState>();
    let was_cancelled = state.cancelled.lock().unwrap().remove(task_id);
    let mut reply_ctx: Option<(Task, Agent)> = None;
    // request_input pause: park the task instead of completing it.
    if let Ok(result) = &outcome {
        if let Some(question) = result.strip_prefix(AWAIT_INPUT) {
            if !was_cancelled {
                {
                    let mut tasks = state.tasks.lock().unwrap();
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
                        t.status = "waiting".into();
                        t.column = "requires_input".into();
                        t.input_request = question.trim().to_string();
                        t.log.push("paused: waiting for operator input".into());
                        t.updated_at = now_ms();
                    }
                }
                state.save_tasks();
                emit_changed(app);
                schedule(app);
                return;
            }
        }
    }
    {
        let mut tasks = state.tasks.lock().unwrap();
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
            if was_cancelled || t.status == "cancelled" {
                t.status = "cancelled".into();
                t.log.push("cancelled".into());
            } else {
                match &outcome {
                    Ok(result) => {
                        t.status = "done".into();
                        t.result = if result.trim().is_empty() && t.kind == "task" {
                            // Never send an empty result to Review — fall back
                            // to a summary assembled from the action log.
                            let actions: Vec<String> = t
                                .log
                                .iter()
                                .filter(|l| l.starts_with("tool: "))
                                .map(|l| format!("- {}", truncate(l.trim_start_matches("tool: "), 160)))
                                .collect();
                            if actions.is_empty() {
                                "The agent finished without a written summary or logged actions — consider re-running this task.".to_string()
                            } else {
                                format!(
                                    "The agent finished without a written summary. Actions it took:\n{}",
                                    actions.join("\n")
                                )
                            }
                        } else {
                            result.clone()
                        };
                    }
                    Err(e) => {
                        t.status = "failed".into();
                        t.result = e.clone();
                        t.log.push(format!("error: {e}"));
                    }
                }
            }
            if t.kind == "task" {
                match t.status.as_str() {
                    "done" => t.column = "review".into(),
                    "failed" | "cancelled" => t.column = "todo".into(),
                    _ => {}
                }
            }
            t.updated_at = now_ms();
            if t.status == "done" {
                if let Some(agent) = t.agent_id.as_deref().and_then(|id| state.agent(id)) {
                    reply_ctx = Some((t.clone(), agent));
                }
            }
        }
    }
    state.save_tasks();

    // Onboarding complete? The Concierge steps back once the Business Profile
    // exists and a real team has been hired; re-enable it any time from the
    // team list for admin/setup help.
    if let Some((_, agent)) = &reply_ctx {
        if agent.name.eq_ignore_ascii_case("Concierge") && agent.enabled {
            let profile_saved = state
                .docs
                .lock()
                .unwrap()
                .iter()
                .any(|d| d.title.eq_ignore_ascii_case("Business Profile"));
            let team_hired = state.agents.lock().unwrap().iter().any(|a| !a.system);
            if profile_saved && team_hired {
                let no_open_work = !state.tasks.lock().unwrap().iter().any(|t| {
                    t.agent_id.as_deref() == Some(agent.id.as_str())
                        && matches!(t.status.as_str(), "routing" | "queued" | "running" | "waiting")
                });
                if no_open_work {
                    if let Some(a) = state.agents.lock().unwrap().iter_mut().find(|a| a.id == agent.id) {
                        a.enabled = false;
                    }
                    state.save_agents();
                    push_message(
                        &state,
                        &agent.id,
                        "user",
                        "Setup is done, so I'm stepping back — your team takes it from here. If you ever need help with settings, backends, or how anything works, re-enable me from the team list.",
                        0,
                    );
                }
            }
        }
    }

    // Deliver the result: chat replies go to the user, message replies go back
    // to the originating agent (and may trigger their next turn).
    if let Some((task, agent)) = reply_ctx {
        if task.kind == "task" && !task.parent_id.is_empty() && task.origin != "user" {
            // Completed subtask: hand the result back to the coordinating agent.
            let coordinator = state.agent(&task.origin);
            if let Some(coord) = coordinator {
                let hop = task.hop + 1;
                let max_hops = state.settings.lock().unwrap().max_hops;
                if hop <= max_hops {
                    let body = format!(
                        "Subtask finished: \"{}\" (done by {}).\n\nResult:\n{}\n\nIntegrate this into the overall project. Check the board for remaining subtasks; when everything is done, assemble the final deliverable and summarize the whole project for the operator. Reply NO_REPLY if nothing needs doing yet.",
                        task.title, agent.name, truncate(&task.result, 4000)
                    );
                    push_message(&state, &agent.id, &coord.id, &body, hop);
                    submit_task(
                        app,
                        format!("Subtask done: {}", truncate(&task.title, 40)),
                        build_message_prompt(&state, &coord.id, &agent.name, &body),
                        Some(coord.id.clone()),
                        agent.id.clone(),
                        "message".into(),
                        hop,
                    )
                    .ok();
                }
            }
        } else if task.kind == "chat" {
            push_message(&state, &agent.id, "user", &task.result, 0);
        } else if task.kind == "message" && task.origin != "user" {
            // NO_REPLY is the agreed way to end an agent-to-agent thread.
            if task.result.trim() == "NO_REPLY" || task.result.trim().is_empty() {
                emit_changed(app);
                schedule(app);
                return;
            }
            let hop = task.hop + 1;
            push_message(&state, &agent.id, &task.origin, &task.result, hop);
            let max_hops = state.settings.lock().unwrap().max_hops;
            if hop <= max_hops && !task.result.trim().is_empty() {
                let prompt = build_message_prompt(&state, &task.origin, &agent.name, &task.result);
                submit_task(
                    app,
                    format!("Reply from {}", agent.name),
                    prompt,
                    Some(task.origin.clone()),
                    agent.id.clone(),
                    "message".into(),
                    hop,
                )
                .ok();
            }
        }
    }
    emit_changed(app);
    schedule(app);
}

pub fn push_message(state: &AppState, from: &str, to: &str, body: &str, hop: u32) {
    state.messages.lock().unwrap().push(Message {
        id: Uuid::new_v4().to_string(),
        from: from.to_string(),
        to: to.to_string(),
        body: body.to_string(),
        hop,
        ts: now_ms(),
    });
    state.save_messages();
}

/// Prompt for a task triggered by an incoming agent-to-agent message,
/// including recent context between the two agents.
pub fn build_message_prompt(state: &AppState, recipient_id: &str, sender_name: &str, body: &str) -> String {
    let history: Vec<String> = {
        let messages = state.messages.lock().unwrap();
        let agents = state.agents.lock().unwrap();
        let name_of = |id: &str| -> String {
            if id == "user" {
                "Operator".into()
            } else {
                agents
                    .iter()
                    .find(|a| a.id == id)
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| "unknown".into())
            }
        };
        messages
            .iter()
            .filter(|m| m.from == recipient_id || m.to == recipient_id)
            .rev()
            .take(8)
            .map(|m| format!("{} -> {}: {}", name_of(&m.from), name_of(&m.to), truncate(&m.body, 600)))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };
    let mut p = String::new();
    if !history.is_empty() {
        p.push_str(&format!(
            "Recent message history for context:\n{}\n\n",
            history.join("\n")
        ));
    }
    p.push_str(&format!("New message from teammate {sender_name}:\n{body}"));
    p
}

pub fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut end = n;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

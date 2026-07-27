//! Macro-pad control surface: global keyboard shortcuts for driving Qivreno
//! from a programmable pad like the Work Louder Creator Micro 2 (or any
//! macro keyboard). The pad's keys are mapped — in Work Louder's Input app,
//! VIA, or similar — to the shortcuts registered here; Qivreno reacts even
//! while another app has focus. Off by default; enabled in Settings.

use crate::runtime;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// One controllable action with its default accelerator. F13-F20 are the
/// macropad convention (unused by the OS, easy to emit from any pad); macOS
/// has no scancodes above F20, so the rest use hyper combos, which every
/// pad configurator can send too.
pub const ACTIONS: &[(&str, &str, &str)] = &[
    ("show_board", "F13", "Show the Board"),
    ("show_chat", "F14", "Show Team Chat"),
    ("show_files", "F15", "Show Files"),
    ("show_library", "F16", "Show the Library"),
    ("focus_composer", "F17", "New task (focus the composer)"),
    ("open_review", "F18", "Open the newest task in Review"),
    ("approve_review", "F19", "Approve the newest reviewed task"),
    ("rerun_failed", "F20", "Re-run the newest failed task"),
    ("open_input_request", "Cmd+Ctrl+Alt+Shift+1", "Answer the agent that needs input"),
    ("toggle_agents", "Cmd+Ctrl+Alt+Shift+2", "Pause / resume all agents"),
    ("reveal_shared", "Cmd+Ctrl+Alt+Shift+3", "Open the Shared folder"),
    ("toggle_window", "Cmd+Ctrl+Alt+Shift+4", "Show / hide Qivreno"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicroBinding {
    pub action: String,
    pub accel: String,
}

pub fn default_bindings() -> Vec<MicroBinding> {
    ACTIONS
        .iter()
        .map(|(a, k, _)| MicroBinding { action: (*a).to_string(), accel: (*k).to_string() })
        .collect()
}

/// (Re)register the global shortcuts to match current settings. Called at
/// startup and whenever settings change. Unregisters everything first so
/// disabling or rebinding never leaves stale hooks.
pub fn sync(app: &AppHandle) {
    let gs = app.global_shortcut();
    gs.unregister_all().ok();
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    if !settings.micro_enabled {
        return;
    }
    let bindings = if settings.micro_bindings.is_empty() {
        default_bindings()
    } else {
        settings.micro_bindings.clone()
    };
    let mut failed: Vec<String> = vec![];
    for b in bindings {
        if b.accel.trim().is_empty() {
            continue;
        }
        let action = b.action.clone();
        let app2 = app.clone();
        if let Err(e) = gs.on_shortcut(b.accel.as_str(), move |_app, _sc, event| {
            if event.state == ShortcutState::Pressed {
                perform(&app2, &action);
            }
        }) {
            eprintln!("micro: could not register {} for {}: {e}", b.accel, b.action);
            failed.push(b.accel.clone());
        }
    }
    // A shortcut this system can't register must not fail silently — the
    // operator would press a dead key and think the app was broken.
    if !failed.is_empty() {
        app.emit(
            "micro-toast",
            format!(
                "Macro pad: {} could not be registered (already in use, or unsupported on this system)",
                failed.join(", ")
            ),
        )
        .ok();
    }
}

/// Bring the main window forward (view-switch actions imply it).
fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        w.show().ok();
        w.unminimize().ok();
        w.set_focus().ok();
    }
}

fn perform(app: &AppHandle, action: &str) {
    match action {
        // View switches and modal-opens are frontend concerns: surface the
        // window and let App.tsx route on the event payload.
        "show_board" | "show_chat" | "show_files" | "show_library" | "focus_composer"
        | "open_review" | "open_input_request" => {
            show_window(app);
            app.emit("micro-action", action).ok();
        }
        "toggle_window" => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                    w.hide().ok();
                } else {
                    show_window(app);
                }
            }
        }
        "reveal_shared" => {
            let state = app.state::<AppState>();
            let dir = state.shared_dir();
            crate::platform::reveal(&dir, false).ok();
        }
        "approve_review" => {
            let state = app.state::<AppState>();
            let target = {
                let tasks = state.tasks.lock().unwrap();
                tasks
                    .iter()
                    .filter(|t| t.kind == "task" && t.column == "review" && t.status == "done")
                    .max_by_key(|t| t.updated_at)
                    .map(|t| (t.id.clone(), t.title.clone()))
            };
            match target {
                Some((id, title)) => {
                    runtime::move_task_to(app, &id, "done", "the macro pad").ok();
                    app.emit("micro-toast", format!("Approved: {title}")).ok();
                }
                None => {
                    app.emit("micro-toast", "Nothing in Review to approve".to_string()).ok();
                }
            }
        }
        "rerun_failed" => {
            let state = app.state::<AppState>();
            let target = {
                let tasks = state.tasks.lock().unwrap();
                tasks
                    .iter()
                    .filter(|t| t.kind == "task" && t.status == "failed")
                    .max_by_key(|t| t.updated_at)
                    .map(|t| (t.id.clone(), t.title.clone()))
            };
            match target {
                Some((id, title)) => {
                    runtime::move_task_to(app, &id, "in_progress", "the macro pad").ok();
                    app.emit("micro-toast", format!("Re-running: {title}")).ok();
                }
                None => {
                    app.emit("micro-toast", "No failed tasks to re-run".to_string()).ok();
                }
            }
        }
        "toggle_agents" => {
            let state = app.state::<AppState>();
            let paused = {
                let mut agents = state.agents.lock().unwrap();
                // If any non-system agent is enabled, pause them all;
                // otherwise resume them all.
                let any_enabled = agents.iter().any(|a| !a.system && a.enabled);
                for a in agents.iter_mut().filter(|a| !a.system) {
                    a.enabled = !any_enabled;
                }
                any_enabled
            };
            state.save_agents();
            runtime::emit_changed(app);
            app.emit(
                "micro-toast",
                if paused { "All agents paused" } else { "All agents resumed" }.to_string(),
            )
            .ok();
        }
        _ => {}
    }
}

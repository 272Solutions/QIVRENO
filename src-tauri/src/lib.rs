mod activation;
mod builtin;
mod bus;
mod commands;
mod detect;
mod docx;
mod export;
mod pdf;
mod platform;
mod pptx;
mod library;
mod license;
mod lmstudio;
mod models;
mod ollama;
mod routing;
mod runtime;
mod state;

use state::AppState;
use tauri::Manager;

/// One-time migration from pre-rename identifiers (Agentry, Agent
/// Workspace) so existing users keep their team.
fn migrate_legacy_data(data_dir: &std::path::Path) {
    if data_dir.join("agents.json").exists() {
        return;
    }
    let Some(parent) = data_dir.parent() else { return };
    for old in ["com.272solutions.agentry"] {
        let legacy = parent.join(old);
        if !legacy.join("agents.json").exists() {
            continue;
        }
        if std::fs::rename(&legacy, data_dir).is_err() {
            // Different volume or dir exists — fall back to copying the files.
            std::fs::create_dir_all(data_dir).ok();
            for name in [
                "agents.json", "tasks.json", "messages.json", "settings.json",
                "docs.json", "memory.json",
            ] {
                std::fs::copy(legacy.join(name), data_dir.join(name)).ok();
            }
        }
        return;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("no app data dir");
            migrate_legacy_data(&data_dir);
            let state = AppState::load(data_dir);
            let port = state.settings.lock().unwrap().bus_port;
            app.manage(state);
            app.manage(builtin::BuiltinState::default());
            bus::start(app.handle().clone(), port);
            // A crash or force-quit can orphan a previous engine process;
            // reclaim ownership so exactly one engine runs, managed by us.
            platform::kill_stray_engines();
            builtin::ensure_started(app.handle());
            activation::start_background_refresh(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::check_availability,
            commands::create_agent,
            commands::update_agent,
            commands::delete_agent,
            commands::create_task,
            commands::move_task,
            commands::send_chat,
            commands::cancel_task,
            commands::delete_task,
            commands::update_settings,
            commands::save_doc,
            commands::rename_doc,
            commands::delete_doc,
            commands::set_memory,
            commands::apply_license,
            commands::cancel_subscription,
            commands::builtin_status,
            commands::builtin_enable,
            commands::builtin_disable,
            commands::list_shared_files,
            commands::read_shared_file,
            commands::write_shared_file,
            commands::delete_shared_file,
            commands::export_shared_file,
            commands::reveal_shared,
            commands::import_brand_template,
            commands::accept_terms,
            commands::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Make sure the bundled AI engine dies with the app.
            if let tauri::RunEvent::Exit = event {
                builtin::stop(app);
            }
        });
}

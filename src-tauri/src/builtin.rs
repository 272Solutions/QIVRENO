//! Built-in AI engine: a bundled llama.cpp server (llama-server + dylibs in
//! the app resources) plus a Qwen3 GGUF model downloaded on first enable.
//! Exposes an OpenAI-compatible API on localhost, so agents run through the
//! same driver as LM Studio — zero third-party installs for the user.

use crate::models::Settings;
use crate::state::AppState;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub struct BuiltinState {
    pub child: Mutex<Option<Child>>,
    /// (downloaded, total) while a model download is in flight.
    pub download: Mutex<Option<(u64, u64)>>,
    pub last_error: Mutex<String>,
    pub starting: Mutex<bool>,
}

impl Default for BuiltinState {
    fn default() -> Self {
        BuiltinState {
            child: Mutex::new(None),
            download: Mutex::new(None),
            last_error: Mutex::new(String::new()),
            starting: Mutex::new(false),
        }
    }
}

pub struct ModelSpec {
    pub name: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub size_gb: f32,
}

const MODEL_8B: ModelSpec = ModelSpec {
    name: "Qwen3 8B",
    file: "Qwen3-8B-Q4_K_M.gguf",
    url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
    size_gb: 5.1,
};
const MODEL_4B: ModelSpec = ModelSpec {
    name: "Qwen3 4B",
    file: "Qwen3-4B-Q4_K_M.gguf",
    url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
    size_gb: 2.6,
};

pub fn ram_gb() -> u64 {
    crate::platform::ram_gb()
}

/// Pick the largest model this Mac can comfortably run.
pub fn recommended_model() -> &'static ModelSpec {
    if ram_gb() >= 15 {
        &MODEL_8B
    } else {
        &MODEL_4B
    }
}

fn models_dir(state: &AppState) -> PathBuf {
    let dir = state.data_dir.join("models");
    std::fs::create_dir_all(&dir).ok();
    dir
}

pub fn model_path(state: &AppState) -> PathBuf {
    models_dir(state).join(recommended_model().file)
}

pub fn base_url(settings: &Settings) -> String {
    format!("http://127.0.0.1:{}/v1", settings.builtin_port)
}

pub fn is_healthy(settings: &Settings) -> bool {
    ureq::get(&format!("http://127.0.0.1:{}/health", settings.builtin_port))
        .timeout(Duration::from_secs(2))
        .call()
        .is_ok()
}

/// The engine ships inside the app bundle (read-only, signed). Copy it to
/// the data dir on first run / engine upgrade so we can chmod and spawn it
/// without touching the bundle.
fn ensure_engine(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let dest = state.data_dir.join("engine");
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("llama");
    let want_version = std::fs::read_to_string(resource.join("ENGINE_VERSION")).unwrap_or_default();
    let have_version = std::fs::read_to_string(dest.join("ENGINE_VERSION")).unwrap_or_default();
    if want_version.trim().is_empty() {
        return Err("bundled engine missing from app resources".into());
    }
    if want_version != have_version || !dest.join(crate::platform::engine_binary()).exists() {
        std::fs::remove_dir_all(&dest).ok();
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(&resource).map_err(|e| e.to_string())?.flatten() {
            std::fs::copy(entry.path(), dest.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
        crate::platform::make_executable(&dest.join(crate::platform::engine_binary()));
    }
    Ok(dest)
}

fn download_model(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let spec = recommended_model();
    let final_path = models_dir(&state).join(spec.file);
    if final_path.exists() {
        return Ok(final_path);
    }
    let part_path = final_path.with_extension("gguf.part");
    let existing = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);

    let mut req = ureq::get(spec.url).timeout(Duration::from_secs(60 * 60));
    if existing > 0 {
        req = req.set("Range", &format!("bytes={existing}-"));
    }
    let resp = req.call().map_err(|e| format!("model download failed: {e}"))?;
    let resuming = resp.status() == 206;
    let total = if resuming {
        resp.header("Content-Range")
            .and_then(|r| r.rsplit('/').next())
            .and_then(|t| t.parse::<u64>().ok())
            .unwrap_or(0)
    } else {
        resp.header("Content-Length").and_then(|l| l.parse().ok()).unwrap_or(0)
    };
    let mut done = if resuming { existing } else { 0 };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(resuming)
        .write(true)
        .truncate(!resuming)
        .open(&part_path)
        .map_err(|e| e.to_string())?;

    *app.state::<BuiltinState>().download.lock().unwrap() = Some((done, total));
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 1 << 16];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        *app.state::<BuiltinState>().download.lock().unwrap() = Some((done, total));
    }
    drop(file);
    if total > 0 && done < total {
        return Err("download ended early — click Enable again to resume".into());
    }
    std::fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(final_path)
}

fn spawn_server(app: &AppHandle, engine: &PathBuf, model: &PathBuf) -> Result<(), String> {
    let state = app.state::<AppState>();
    let port = state.settings.lock().unwrap().builtin_port;
    let log = std::fs::File::create(state.data_dir.join("builtin-engine.log"))
        .map_err(|e| e.to_string())?;
    let mut cmd = Command::new(engine.join(crate::platform::engine_binary()));
    crate::platform::hide_console(&mut cmd);
    let child = cmd
        .args([
            "-m",
            model.to_string_lossy().as_ref(),
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--jinja",
            "-c",
            "8192",
            "--no-webui",
        ])
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("failed to start engine: {e}"))?;
    *app.state::<BuiltinState>().child.lock().unwrap() = Some(child);
    // Wait for the model to load (large models take a while).
    for _ in 0..240 {
        std::thread::sleep(Duration::from_millis(500));
        let settings = state.settings.lock().unwrap().clone();
        if is_healthy(&settings) {
            return Ok(());
        }
        if let Some(c) = app.state::<BuiltinState>().child.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                return Err(format!(
                    "engine exited during startup ({status}) — see builtin-engine.log"
                ));
            }
        }
    }
    Err("engine did not become healthy within 2 minutes".into())
}

/// Bring the built-in engine up: copy engine, download model if needed,
/// start the server. Runs on a background thread; progress is polled via
/// the builtin_status command.
pub fn ensure_started(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let settings = state.settings.lock().unwrap();
        if !settings.builtin_enabled {
            return;
        }
        if is_healthy(&settings) {
            return;
        }
    }
    {
        let bstate = app.state::<BuiltinState>();
        let mut starting = bstate.starting.lock().unwrap();
        if *starting {
            return;
        }
        *starting = true;
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        let bstate = app2.state::<BuiltinState>();
        bstate.last_error.lock().unwrap().clear();
        let outcome = ensure_engine(&app2)
            .and_then(|engine| download_model(&app2).map(|model| (engine, model)))
            .and_then(|(engine, model)| spawn_server(&app2, &engine, &model));
        *bstate.download.lock().unwrap() = None;
        if let Err(e) = outcome {
            *bstate.last_error.lock().unwrap() = e;
        }
        *bstate.starting.lock().unwrap() = false;
        crate::runtime::emit_changed(&app2);
    });
}

pub fn stop(app: &AppHandle) {
    let bstate = app.state::<BuiltinState>();
    let taken = bstate.child.lock().unwrap().take();
    if let Some(mut child) = taken {
        child.kill().ok();
        child.wait().ok();
    }
}

#[derive(Serialize, Clone)]
pub struct BuiltinStatus {
    pub enabled: bool,
    pub running: bool,
    pub starting: bool,
    pub downloading: bool,
    pub downloaded: u64,
    pub total: u64,
    pub model_name: String,
    pub model_size_gb: f32,
    pub model_installed: bool,
    pub ram_gb: u64,
    pub error: String,
}

pub fn status(app: &AppHandle) -> BuiltinStatus {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let spec = recommended_model();
    let dl = *app.state::<BuiltinState>().download.lock().unwrap();
    BuiltinStatus {
        enabled: settings.builtin_enabled,
        running: settings.builtin_enabled && is_healthy(&settings),
        starting: *app.state::<BuiltinState>().starting.lock().unwrap(),
        downloading: dl.is_some(),
        downloaded: dl.map(|(d, _)| d).unwrap_or(0),
        total: dl.map(|(_, t)| t).unwrap_or(0),
        model_name: spec.name.to_string(),
        model_size_gb: spec.size_gb,
        model_installed: model_path(&state).exists(),
        ram_gb: ram_gb(),
        error: app.state::<BuiltinState>().last_error.lock().unwrap().clone(),
    }
}

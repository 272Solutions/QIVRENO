//! Every OS-specific call in one place. macOS is the primary target;
//! Windows branches enable the .exe build (compiled + bundled via CI on
//! Windows runners — see .github/workflows/release.yml).

use std::path::PathBuf;
use std::process::Command;

/// On Windows, every spawned console process opens a visible console window
/// unless CREATE_NO_WINDOW is set — GUI apps must set it on all child
/// processes (engine server, taskkill, CLI backends, shell tools).
/// No-op elsewhere.
pub fn hide_console(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

pub fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// Run a user-supplied shell command line via the platform shell.
pub fn shell_command(command_line: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command_line);
        hide_console(&mut c);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(command_line);
        c
    }
}

pub fn kill_pid(pid: u32) {
    #[cfg(windows)]
    hide_console(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]))
        .status()
        .ok();
    #[cfg(not(windows))]
    Command::new("kill").arg("-9").arg(pid.to_string()).status().ok();
}

/// Kill stray built-in engine processes from previous app runs.
pub fn kill_stray_engines() {
    #[cfg(windows)]
    hide_console(Command::new("taskkill").args(["/F", "/IM", "llama-server.exe"]))
        .status()
        .ok();
    #[cfg(not(windows))]
    Command::new("/usr/bin/pkill").args(["-f", "engine/llama-server"]).status().ok();
}

/// Show a file (selected) or folder in the system file manager.
pub fn reveal(path: &std::path::Path, is_file: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut c = Command::new("explorer");
        if is_file {
            c.arg(format!("/select,{}", path.display()));
        } else {
            c.arg(path);
        }
        c.status().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("/usr/bin/open");
        if is_file {
            c.arg("-R");
        }
        c.arg(path).status().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Installed RAM. Cached: the answer never changes while the app runs, and
/// probing it costs a process spawn (PowerShell on Windows) — callers poll
/// this via builtin_status, so an uncached probe would spawn constantly.
pub fn ram_gb() -> u64 {
    use std::sync::OnceLock;
    static RAM: OnceLock<u64> = OnceLock::new();
    *RAM.get_or_init(|| {
        #[cfg(windows)]
        {
            let out = hide_console(Command::new("powershell").args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ]))
            .output();
            out.ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
                .map(|b| b / 1_073_741_824)
                .unwrap_or(8)
        }
        #[cfg(not(windows))]
        {
            let out = Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output();
            out.ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
                .map(|b| b / 1_073_741_824)
                .unwrap_or(8)
        }
    })
}

/// Stable hardware identifier for license device-binding. Copying app data
/// to another machine changes this value, so copied license files fail.
pub fn hardware_uuid() -> String {
    use std::sync::OnceLock;
    static UUID: OnceLock<String> = OnceLock::new();
    UUID.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            let out = Command::new("/usr/sbin/ioreg")
                .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                .output();
            if let Ok(out) = out {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = text.lines().find(|l| l.contains("IOPlatformUUID")) {
                    if let Some(v) = line.split('"').nth(3) {
                        return v.to_string();
                    }
                }
            }
        }
        #[cfg(windows)]
        {
            let out = hide_console(Command::new("powershell").args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
            ]))
            .output();
            if let Ok(out) = out {
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !v.is_empty() {
                    return v;
                }
            }
        }
        // Fallback: random-but-persisted id would go here; empty disables binding.
        String::new()
    })
    .clone()
}

pub fn hostname() -> String {
    #[cfg(windows)]
    let out = hide_console(&mut Command::new("hostname")).output();
    #[cfg(not(windows))]
    let out = Command::new("/bin/hostname").arg("-s").output();
    out.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Computer".into())
}

pub fn engine_binary() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}

/// Mark the copied engine binary executable (no-op on Windows).
pub fn make_executable(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).ok();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Executable name candidates for a CLI on this platform.
pub fn exe_candidates(bin: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{bin}.exe"), format!("{bin}.cmd"), format!("{bin}.bat")]
    } else {
        vec![bin.to_string()]
    }
}

/// Directories beyond PATH worth probing for user-installed CLIs.
pub fn extra_cli_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    if cfg!(windows) {
        let mut v = vec![];
        if let Ok(appdata) = std::env::var("APPDATA") {
            v.push(PathBuf::from(appdata).join("npm"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(local).join("Programs"));
        }
        v.push(home.join(".local").join("bin"));
        v
    } else {
        vec![
            home.join(".local/bin"),
            home.join(".npm-global/bin"),
            home.join("bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
        ]
    }
}

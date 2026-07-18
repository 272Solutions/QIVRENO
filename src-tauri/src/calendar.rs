//! Calendar integration, macOS-first: agents read and create events in the
//! user's Calendar app (which syncs whatever accounts the Mac already has —
//! iCloud, Google, Exchange). The tool surface is backend-agnostic so a
//! Google/Outlook API backend can slot in later for Windows.

#[cfg(target_os = "macos")]
use std::process::Command;

/// Upcoming events for the next `days` days, one per line.
#[cfg(target_os = "macos")]
pub fn list_events(days: i64) -> Result<String, String> {
    // JXA reads Calendar's event store faster and more predictably than
    // AppleScript's whose-clauses on large calendars.
    let script = format!(
        r#"
const app = Application('Calendar');
const now = new Date();
const until = new Date(now.getTime() + {days} * 86400000);
const out = [];
for (const cal of app.calendars()) {{
  let evs;
  try {{
    evs = cal.events.whose({{ _and: [ {{ startDate: {{ _greaterThan: now }} }}, {{ startDate: {{ _lessThan: until }} }} ] }})();
  }} catch (e) {{ continue; }}
  for (const ev of evs) {{
    try {{
      const s = ev.startDate();
      const e = ev.endDate();
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      out.push(fmt(s) + ' → ' + fmt(e) + ' | ' + ev.summary() + ' [' + cal.name() + ']');
    }} catch (e) {{}}
  }}
}}
out.sort();
out.length ? out.join('\n') : '(no events in the next {days} days)';
"#
    );
    run_osascript_jxa(&script)
}

/// Create an event. `start` is "YYYY-MM-DD HH:MM" local time.
#[cfg(target_os = "macos")]
pub fn add_event(title: &str, start: &str, duration_minutes: i64, notes: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("event needs a title".into());
    }
    let (y, mo, d, h, mi) = parse_start(start)?;
    // Build dates via components (locale-proof), create in the first
    // writable calendar (JXA: default calendar isn't exposed; use calendar 1).
    let script = format!(
        r#"
const app = Application('Calendar');
const start = new Date({y}, {mo} - 1, {d}, {h}, {mi}, 0);
const end = new Date(start.getTime() + {duration_minutes} * 60000);
const cal = app.calendars[0];
const ev = app.Event({{ summary: {title_js}, startDate: start, endDate: end, description: {notes_js} }});
cal.events.push(ev);
'created: ' + {title_js} + ' on ' + start.toLocaleString() + ' (' + {duration_minutes} + ' min) in calendar "' + cal.name() + '"';
"#,
        title_js = js_str(title),
        notes_js = js_str(notes),
    );
    run_osascript_jxa(&script)
}

#[cfg(target_os = "macos")]
fn run_osascript_jxa(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .map_err(|e| format!("osascript failed to start: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        if stderr.contains("not authorized") || stderr.contains("-1743") {
            return Err("Qivreno needs Calendar access — macOS will show a permission prompt; approve it in System Settings → Privacy & Security → Automation, then try again".into());
        }
        return Err(format!("Calendar error: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Today's local date + weekday as a human string, e.g.
/// "Monday, 2026-07-13". Agents need this because a local model has no idea
/// what today is and would otherwise book events in its training-era year.
/// Uses the OS `date` command (locale-correct, no date crate needed).
pub fn today_string() -> String {
    #[cfg(target_os = "windows")]
    let out = crate::platform::hide_console(std::process::Command::new("powershell").args([
        "-NoProfile",
        "-Command",
        "Get-Date -Format 'dddd, yyyy-MM-dd'",
    ]))
    .output();
    #[cfg(not(target_os = "windows"))]
    let out = std::process::Command::new("date").args(["+%A, %Y-%m-%d"]).output();

    out.ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

fn parse_start(start: &str) -> Result<(i32, u32, u32, u32, u32), String> {
    let s = start.trim().replace('T', " ");
    let err = || format!("start must be YYYY-MM-DD HH:MM — got '{start}'");
    let (date, time) = s.split_once(' ').ok_or_else(err)?;
    let d: Vec<&str> = date.split('-').collect();
    let t: Vec<&str> = time.split(':').collect();
    if d.len() != 3 || t.len() < 2 {
        return Err(err());
    }
    let parsed = (
        d[0].parse().map_err(|_| err())?,
        d[1].parse().map_err(|_| err())?,
        d[2].parse().map_err(|_| err())?,
        t[0].parse().map_err(|_| err())?,
        t[1].parse().map_err(|_| err())?,
    );
    let (_, mo, day, h, mi) = parsed;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&day) || h > 23 || mi > 59 {
        return Err(err());
    }
    Ok(parsed)
}

#[cfg(not(target_os = "macos"))]
pub fn list_events(_days: i64) -> Result<String, String> {
    Err("calendar integration is not yet available on this platform".into())
}

#[cfg(not(target_os = "macos"))]
pub fn add_event(_title: &str, _start: &str, _duration_minutes: i64, _notes: &str) -> Result<String, String> {
    Err("calendar integration is not yet available on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::parse_start;

    #[test]
    fn parses_valid_start() {
        assert_eq!(parse_start("2026-07-15 14:30").unwrap(), (2026, 7, 15, 14, 30));
        assert_eq!(parse_start("2026-01-02T09:05").unwrap(), (2026, 1, 2, 9, 5));
    }

    #[test]
    fn rejects_bad_start() {
        assert!(parse_start("tomorrow at noon").is_err());
        assert!(parse_start("2026-13-01 10:00").is_err());
        assert!(parse_start("2026-07-15").is_err());
    }

    #[test]
    fn today_string_is_iso_dated() {
        let t = super::today_string();
        // "<Weekday>, YYYY-MM-DD" — assert the ISO date tail parses.
        assert!(t.contains(", "), "unexpected: {t}");
        let date = t.split(", ").nth(1).unwrap_or("");
        assert!(super::parse_start(&format!("{date} 09:00")).is_ok(), "bad date: {t}");
    }
}

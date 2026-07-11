//! Activation-code redemption and silent license renewal against the
//! qivreno.ai license service (see qivreno-site/functions/api/).

use crate::state::AppState;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const REFRESH_AFTER_MS: u64 = 7 * 24 * 3600 * 1000; // refresh keys older than 7 days
const LOOP_EVERY_SECS: u64 = 24 * 3600;

/// POST /api/activate — pure HTTP, testable without an AppHandle.
pub fn call_activate(
    server: &str,
    code: &str,
    device_id: &str,
    device_name: &str,
) -> Result<(String, String), String> {
    let resp = ureq::post(&format!("{}/api/activate", server.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .send_json(json!({ "code": code, "device_id": device_id, "device_name": device_name }));
    let v: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(_, r)) => r.into_json().map_err(|e| e.to_string())?,
        Err(e) => return Err(format!("could not reach qivreno.ai: {e}")),
    };
    if let Some(err) = v["error"].as_str() {
        return Err(err.to_string());
    }
    match (v["key"].as_str(), v["refresh_token"].as_str()) {
        (Some(k), Some(t)) => Ok((k.to_string(), t.to_string())),
        _ => Err("unexpected response from the license service".into()),
    }
}

/// POST /api/refresh — Ok(Some(key)) on renewal, Ok(None) when the server
/// explicitly says the subscription is inactive, Err on network problems
/// (which are ignored — the cached key + grace period carry the user).
pub fn call_refresh(server: &str, refresh_token: &str, device_id: &str) -> Result<Option<String>, String> {
    let resp = ureq::post(&format!("{}/api/refresh", server.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .send_json(json!({ "refresh_token": refresh_token, "device_id": device_id }));
    match resp {
        Ok(r) => {
            let v: Value = r.into_json().map_err(|e| e.to_string())?;
            Ok(v["key"].as_str().map(str::to_string))
        }
        Err(ureq::Error::Status(code, _)) if (400..500).contains(&code) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// POST /api/cancel — turns off renewal in Stripe; access continues until the
/// paid-through date, which is returned as epoch ms.
pub fn call_cancel(server: &str, refresh_token: &str, device_id: &str) -> Result<u64, String> {
    let resp = ureq::post(&format!("{}/api/cancel", server.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .send_json(json!({ "refresh_token": refresh_token, "device_id": device_id }));
    let v: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(_, r)) => r.into_json().map_err(|e| e.to_string())?,
        Err(e) => return Err(format!("could not reach qivreno.ai: {e}")),
    };
    if let Some(err) = v["error"].as_str() {
        return Err(err.to_string());
    }
    Ok(v["access_until"].as_u64().unwrap_or(0))
}

/// Cancel the subscription renewal for this device's activation.
pub fn cancel_subscription(app: &AppHandle) -> Result<u64, String> {
    let state = app.state::<AppState>();
    let (server, token) = {
        let s = state.settings.lock().unwrap();
        (s.license_server.clone(), s.license_refresh_token.clone())
    };
    if token.is_empty() {
        return Err("this Mac was not activated with an activation code".into());
    }
    call_cancel(&server, &token, &crate::platform::hardware_uuid())
}

/// Redeem a QIVACT- code for this machine and store the key + refresh token.
pub fn activate_with_code(app: &AppHandle, code: &str) -> Result<(), String> {
    let device = crate::platform::hardware_uuid();
    if device.is_empty() {
        return Err("could not read this machine's hardware id".into());
    }
    let state = app.state::<AppState>();
    let server = state.settings.lock().unwrap().license_server.clone();
    let (key, token) = call_activate(&server, code, &device, &crate::platform::hostname())?;
    // Sanity: verify before storing.
    crate::license::parse_and_verify(&key)?;
    {
        let mut settings = state.settings.lock().unwrap();
        settings.license_key = key;
        settings.license_refresh_token = token;
        settings.last_seen_ms = crate::models::now_ms();
    }
    state.save_settings();
    crate::runtime::emit_changed(app);
    Ok(())
}

/// Refresh the key if it's older than a week. Silent on network failure.
pub fn refresh_if_due(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (server, token, key) = {
        let s = state.settings.lock().unwrap();
        (s.license_server.clone(), s.license_refresh_token.clone(), s.license_key.clone())
    };
    if token.is_empty() {
        touch_last_seen(app);
        return;
    }
    let due = crate::license::parse_and_verify(&key)
        .map(|lic| crate::models::now_ms() >= lic.iat + REFRESH_AFTER_MS)
        .unwrap_or(true);
    if !due {
        touch_last_seen(app);
        return;
    }
    let device = crate::platform::hardware_uuid();
    match call_refresh(&server, &token, &device) {
        Ok(Some(new_key)) => {
            if crate::license::parse_and_verify(&new_key).is_ok() {
                let mut settings = state.settings.lock().unwrap();
                settings.license_key = new_key;
                settings.last_seen_ms = crate::models::now_ms();
                drop(settings);
                state.save_settings();
                crate::runtime::emit_changed(app);
            }
        }
        Ok(None) => {
            // Subscription inactive / device unknown: keep the cached key and
            // let the built-in grace/expiry flow enforce.
            touch_last_seen(app);
        }
        Err(_) => touch_last_seen(app), // offline — try again next cycle
    }
}

fn touch_last_seen(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut settings = state.settings.lock().unwrap();
        // Never move the guard backwards.
        settings.last_seen_ms = settings.last_seen_ms.max(crate::models::now_ms());
    }
    state.save_settings();
}

/// Startup + daily renewal loop.
pub fn start_background_refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        refresh_if_due(&app);
        std::thread::sleep(Duration::from_secs(LOOP_EVERY_SECS));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Full loop against the real license service (local wrangler dev).
    /// Run with: QIVRENO_TEST_SERVER=http://127.0.0.1:8788 cargo test --lib activation
    #[test]
    fn activate_and_refresh_e2e() {
        let Ok(server) = std::env::var("QIVRENO_TEST_SERVER") else {
            eprintln!("skipped (set QIVRENO_TEST_SERVER)");
            return;
        };
        let code = std::env::var("QIVRENO_TEST_CODE").unwrap_or_else(|_| "QIVACT-APPS-TEST-2026".into());

        let (key, token) = call_activate(&server, &code, "HW-APP-TEST-1", "TestMac").expect("activate");
        let lic = crate::license::parse_and_verify(&key).expect("key verifies");
        assert_eq!(lic.device, "HW-APP-TEST-1");

        // Device binding: right device licensed, wrong device inactive.
        let good = crate::license::status(&key, 0, "HW-APP-TEST-1");
        assert!(good.active && good.state == "licensed");
        let bad = crate::license::status(&key, 0, "HW-SOMEONE-ELSE");
        assert!(!bad.active);

        // Single-use enforcement.
        assert!(call_activate(&server, &code, "HW-APP-TEST-2", "Other").is_err());

        // Refresh returns a fresh, verifiable key for the same device.
        let refreshed = call_refresh(&server, &token, "HW-APP-TEST-1").expect("refresh call");
        let new_key = refreshed.expect("subscription active");
        assert!(crate::license::parse_and_verify(&new_key).is_ok());

        // Refresh with the wrong device is refused.
        assert_eq!(call_refresh(&server, &token, "HW-WRONG").unwrap(), None);
    }
}

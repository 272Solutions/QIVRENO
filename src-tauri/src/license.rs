//! Offline license verification for Qivreno subscriptions.
//!
//! A license key is `QIV-<base64url(payload json)>.<base64url(ed25519 sig)>`,
//! signed with 272 Solutions' private key (kept offline; see
//! `license-gen`, the companion CLI in src/bin/license_gen.rs). The app
//! verifies against the public key below — no server call needed.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 272 Solutions license signing public key (Ed25519, base64url).
/// Generated 2026-07-07; the matching private key lives outside the repo.
pub const PUBLIC_KEY_B64: &str = "P8y_yPSwEzso4S8waGA2IFv1FaE-3iCNM9l3VkHD9eA";

pub const TRIAL_DAYS: u64 = 14;
pub const GRACE_DAYS: u64 = 7;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct License {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub email: String,
    /// "pro" | "enterprise"
    pub plan: String,
    #[serde(default)]
    pub seats: u32,
    pub iat: u64,
    pub exp: u64,
    #[serde(default)]
    pub features: Vec<String>,
    /// Hardware id this key is bound to. Empty (e.g. manually issued
    /// license-gen keys) = valid on any device.
    #[serde(default)]
    pub device: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatus {
    /// "trial" | "trial_expired" | "licensed" | "grace" | "expired"
    pub state: String,
    pub days_left: i64,
    pub plan: String,
    pub customer: String,
    pub expires_at: u64,
    /// Whether agents may run tasks right now.
    pub active: bool,
}

pub fn parse_and_verify(key: &str) -> Result<License, String> {
    let key = key.trim();
    let body = key
        .strip_prefix("QIV-")
        .ok_or("that doesn't look like a Qivreno license key (should start with QIV-)")?;
    let (payload_b64, sig_b64) = body.split_once('.').ok_or("malformed license key")?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| "malformed license key (payload)")?;
    let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| "malformed license key (signature)")?
        .try_into()
        .map_err(|_| "malformed license key (signature length)")?;
    let pk_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(PUBLIC_KEY_B64)
        .map_err(|_| "app public key misconfigured")?
        .try_into()
        .map_err(|_| "app public key misconfigured")?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_bytes).map_err(|_| "app public key misconfigured")?;
    verifying_key
        .verify(&payload, &Signature::from_bytes(&sig_bytes))
        .map_err(|_| "invalid license key — signature check failed")?;
    serde_json::from_slice::<License>(&payload).map_err(|_| "malformed license payload".to_string())
}

/// `local_device`: this machine's hardware id — a device-bound key issued
/// for a different machine is ignored (falls through to trial rules).
pub fn status(license_key: &str, trial_started_at: u64, local_device: &str) -> LicenseStatus {
    let now = now_ms();
    if !license_key.is_empty() {
        if let Ok(lic) = parse_and_verify(license_key) {
            if !lic.device.is_empty() && lic.device != local_device {
                return LicenseStatus {
                    state: "expired".into(),
                    days_left: 0,
                    plan: lic.plan,
                    customer: lic.name,
                    expires_at: lic.exp,
                    active: false,
                };
            }
            let grace_end = lic.exp + GRACE_DAYS * DAY_MS;
            let (state, active, reference) = if now < lic.exp {
                ("licensed", true, lic.exp)
            } else if now < grace_end {
                ("grace", true, grace_end)
            } else {
                ("expired", false, grace_end)
            };
            return LicenseStatus {
                state: state.into(),
                days_left: (reference as i64 - now as i64) / DAY_MS as i64,
                plan: lic.plan,
                customer: lic.name,
                expires_at: lic.exp,
                active,
            };
        }
        // A stored key that no longer verifies falls through to trial rules.
    }
    let trial_end = trial_started_at + TRIAL_DAYS * DAY_MS;
    if now < trial_end {
        LicenseStatus {
            state: "trial".into(),
            days_left: (trial_end as i64 - now as i64) / DAY_MS as i64,
            plan: "trial".into(),
            customer: String::new(),
            expires_at: trial_end,
            active: true,
        }
    } else {
        LicenseStatus {
            state: "trial_expired".into(),
            days_left: 0,
            plan: "trial".into(),
            customer: String::new(),
            expires_at: trial_end,
            active: false,
        }
    }
}

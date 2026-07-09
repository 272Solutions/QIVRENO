//! Qivreno license issuing CLI for 272 Solutions.
//!
//!   license-gen keygen --out <private.key>
//!       Generate a signing keypair. Prints the public key to embed in
//!       src/license.rs. Keep the private key file OFFLINE and out of git.
//!
//!   license-gen issue --key <private.key> --name "Acme LLC" [--email a@b.c]
//!                     [--plan pro|enterprise] [--months 1] [--seats 1]
//!                     [--features enterprise,beta]
//!       Print a license key to send to the customer.
//!
//!   license-gen verify <QIV-...>
//!       Verify a key against the public key embedded in the app and print
//!       its payload — the exact check the app performs.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use std::collections::HashMap;
use std::process::exit;

#[path = "../../../src-tauri/src/license.rs"]
mod license;

fn flags(args: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(name) = args[i].strip_prefix("--") {
            let value = args.get(i + 1).cloned().unwrap_or_default();
            map.insert(name.to_string(), value);
            i += 2;
        } else {
            i += 1;
        }
    }
    map
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("keygen") => {
            let f = flags(&args[1..]);
            let out = f.get("out").cloned().unwrap_or_else(|| "qivreno-private.key".into());
            let mut rng = rand_core::OsRng;
            let signing = SigningKey::generate(&mut rng);
            std::fs::write(&out, URL_SAFE_NO_PAD.encode(signing.to_bytes()))
                .unwrap_or_else(|e| { eprintln!("write failed: {e}"); exit(1) });
            println!("private key written to: {out}   (keep OFFLINE, never commit)");
            println!("public key (embed in src/license.rs PUBLIC_KEY_B64):");
            println!("{}", URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()));
        }
        Some("issue") => {
            let f = flags(&args[1..]);
            let key_path = f.get("key").unwrap_or_else(|| { eprintln!("--key <private.key> required"); exit(1) });
            let name = f.get("name").unwrap_or_else(|| { eprintln!("--name required"); exit(1) });
            let months: u64 = f.get("months").and_then(|m| m.parse().ok()).unwrap_or(1);
            let plan = f.get("plan").cloned().unwrap_or_else(|| "pro".into());
            let seats: u32 = f.get("seats").and_then(|s| s.parse().ok()).unwrap_or(1);
            let features: Vec<String> = f
                .get("features")
                .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
                .unwrap_or_default();
            let key_b64 = std::fs::read_to_string(key_path)
                .unwrap_or_else(|e| { eprintln!("cannot read private key: {e}"); exit(1) });
            let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
                .decode(key_b64.trim())
                .unwrap_or_else(|_| { eprintln!("bad private key file"); exit(1) })
                .try_into()
                .unwrap_or_else(|_| { eprintln!("bad private key length"); exit(1) });
            let signing = SigningKey::from_bytes(&key_bytes);
            let now = now_ms();
            let payload = serde_json::json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "name": name,
                "email": f.get("email").cloned().unwrap_or_default(),
                "plan": plan,
                "seats": seats,
                "iat": now,
                // months ≈ 30.5 days; issue with a few days' margin over the billing period
                "exp": now + months * 305 * 24 * 60 * 60 * 100,
                "features": features,
            });
            let bytes = serde_json::to_vec(&payload).unwrap();
            let sig = signing.sign(&bytes);
            println!(
                "QIV-{}.{}",
                URL_SAFE_NO_PAD.encode(&bytes),
                URL_SAFE_NO_PAD.encode(sig.to_bytes())
            );
        }
        Some("verify") => {
            let key = args.get(1).unwrap_or_else(|| { eprintln!("usage: license-gen verify <QIV-...>"); exit(1) });
            match license::parse_and_verify(key) {
                Ok(lic) => {
                    println!("VALID");
                    println!("{}", serde_json::to_string_pretty(&lic).unwrap());
                    let now = now_ms();
                    if now > lic.exp {
                        println!("(note: expired {} days ago)", (now - lic.exp) / 86_400_000);
                    } else {
                        println!("(expires in {} days)", (lic.exp - now) / 86_400_000);
                    }
                }
                Err(e) => {
                    println!("INVALID: {e}");
                    exit(1);
                }
            }
        }
        _ => {
            eprintln!("usage: license-gen keygen|issue|verify (see file header for flags)");
            exit(1);
        }
    }
}

//! Plugin packs: user-installable extensions loaded from disk at startup.
//!
//! A pack is a folder under ~/Qivreno/Plugins/<id>/ containing a plugin.json
//! manifest plus the markdown files it references. Packs are DATA, not code —
//! they add agent role templates, team templates and Library documents, and
//! they may declare MCP servers (which the user must still enable explicitly
//! before anything is executed; see mcp.rs).
//!
//! Skill documents live in their own .md files rather than inside the JSON:
//! they run to hundreds of words of prose, and authors need to read, diff and
//! edit them like documents.

use crate::models::now_ms;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One agent role a pack contributes to the New Agent / Quick Start pickers.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PackAgent {
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub description: String,
    /// Inline skills text. Ignored when `skills_file` is present.
    #[serde(default)]
    pub skills: String,
    /// Path to a markdown file, relative to the pack folder.
    #[serde(default)]
    pub skills_file: String,
    #[serde(default)]
    pub color: String,
}

/// A named group of this pack's agents, offered as a one-click team.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PackTeam {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    /// Agent names, which must exist in this pack's `agents`.
    #[serde(default)]
    pub agents: Vec<String>,
}

/// A Library document the pack installs (business info or a process).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PackDoc {
    pub title: String,
    /// "business" | "process" — defaults to process.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub file: String,
}

/// An MCP server the pack suggests. Declaring one does NOT run it: the
/// operator enables it in Settings after seeing the exact command.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PackMcpServer {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub agents: Vec<PackAgent>,
    #[serde(default)]
    pub teams: Vec<PackTeam>,
    #[serde(default)]
    pub docs: Vec<PackDoc>,
    #[serde(default)]
    pub mcp_servers: Vec<PackMcpServer>,
}

/// A loaded pack plus where it came from and whether it parsed cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedPlugin {
    #[serde(flatten)]
    pub manifest: PluginManifest,
    pub dir: String,
    /// Non-fatal problems worth showing the operator (missing files, etc).
    #[serde(default)]
    pub warnings: Vec<String>,
}

pub fn plugins_dir() -> PathBuf {
    let dir = crate::platform::home_dir().join("Qivreno").join("Plugins");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Read a pack-relative file, refusing anything that escapes the pack folder.
fn read_pack_file(dir: &Path, rel: &str) -> Result<String, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("empty path".into());
    }
    if rel.starts_with('/') || rel.split('/').any(|s| s == ".." || s == ".") {
        return Err(format!("unsafe path '{rel}'"));
    }
    std::fs::read_to_string(dir.join(&rel)).map_err(|e| format!("{rel}: {e}"))
}

/// Load one pack folder. Returns None when there is no manifest at all.
fn load_one(dir: &Path) -> Option<LoadedPlugin> {
    let raw = std::fs::read_to_string(dir.join("plugin.json")).ok()?;
    let mut warnings = vec![];
    let mut manifest: PluginManifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            // A broken manifest must not take the app down or vanish silently.
            let id = dir.file_name()?.to_string_lossy().into_owned();
            return Some(LoadedPlugin {
                manifest: PluginManifest { id: id.clone(), name: id, ..Default::default() },
                dir: dir.display().to_string(),
                warnings: vec![format!("plugin.json is not valid JSON: {e}")],
            });
        }
    };
    if manifest.id.trim().is_empty() {
        manifest.id = dir.file_name()?.to_string_lossy().into_owned();
    }
    if manifest.name.trim().is_empty() {
        manifest.name = manifest.id.clone();
    }

    // Resolve skills_file / docs file references into inline content.
    for a in manifest.agents.iter_mut() {
        if !a.skills_file.trim().is_empty() {
            match read_pack_file(dir, &a.skills_file) {
                Ok(text) => a.skills = text.trim().to_string(),
                Err(e) => warnings.push(format!("agent '{}': {e}", a.name)),
            }
        }
        if a.skills.trim().is_empty() {
            warnings.push(format!("agent '{}' has no skills text — it will be skipped", a.name));
        }
    }
    manifest.agents.retain(|a| !a.name.trim().is_empty() && !a.skills.trim().is_empty());

    for d in manifest.docs.iter_mut() {
        if !d.file.trim().is_empty() {
            match read_pack_file(dir, &d.file) {
                Ok(text) => d.content = text,
                Err(e) => warnings.push(format!("doc '{}': {e}", d.title)),
            }
        }
        if d.kind.trim().is_empty() {
            d.kind = "process".into();
        }
    }
    manifest.docs.retain(|d| !d.title.trim().is_empty() && !d.content.trim().is_empty());

    // Teams may only reference agents this pack actually ships.
    let names: Vec<String> = manifest.agents.iter().map(|a| a.name.to_lowercase()).collect();
    for t in manifest.teams.iter_mut() {
        let before = t.agents.len();
        t.agents.retain(|n| names.contains(&n.to_lowercase()));
        if t.agents.len() != before {
            warnings.push(format!("team '{}' referenced agents this pack does not define", t.label));
        }
    }
    manifest.teams.retain(|t| !t.agents.is_empty());

    Some(LoadedPlugin { manifest, dir: dir.display().to_string(), warnings })
}

/// Every pack currently installed, sorted by name.
pub fn load_all() -> Vec<LoadedPlugin> {
    let root = plugins_dir();
    let mut out = vec![];
    let Ok(entries) = std::fs::read_dir(&root) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false) {
            continue;
        }
        if let Some(p) = load_one(&path) {
            out.push(p);
        }
    }
    out.sort_by(|a, b| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()));
    out
}

/// Install a pack's Library documents, skipping titles that already exist so
/// re-loading a pack never overwrites the operator's edits.
pub fn install_docs(state: &crate::state::AppState, packs: &[LoadedPlugin]) -> usize {
    let mut added = 0;
    {
        let mut docs = state.docs.lock().unwrap();
        for p in packs {
            for d in &p.manifest.docs {
                if docs.iter().any(|x| x.title.eq_ignore_ascii_case(&d.title)) {
                    continue;
                }
                docs.push(crate::models::Doc {
                    id: uuid::Uuid::new_v4().to_string(),
                    title: d.title.clone(),
                    kind: d.kind.clone(),
                    content: d.content.clone(),
                    updated_by: format!("plugin:{}", p.manifest.id),
                    created_at: now_ms(),
                    updated_at: now_ms(),
                });
                added += 1;
            }
        }
    }
    if added > 0 {
        state.save_docs();
    }
    added
}

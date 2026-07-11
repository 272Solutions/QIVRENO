import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Agent, AGENT_COLORS, agentTemplateGroups, Availability, BackendKind,
  BuiltinStatus, BUSINESS_PROFILE_SKELETON, Column, CONCIERGE, Doc, fileKind,
  LicenseStatus, MAX_AGENTS, Permission, Settings, SharedFile, Snapshot,
  Task, TeamTemplate, TEMPLATES,
} from "./types";
import { TERMS_MD, TERMS_VERSION } from "./terms";
import "./App.css";

type View =
  | { kind: "board" }
  | { kind: "activity" }
  | { kind: "library" }
  | { kind: "files" }
  | { kind: "agent"; id: string };

/** Two-step destructive button (native confirm() is unavailable in the webview). */
function ArmButton(props: {
  label: string;
  armedLabel?: string;
  className?: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={props.className ?? "btn danger sm"}
      onClick={() => {
        if (armed) {
          setArmed(false);
          props.onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? props.armedLabel ?? "Click again to confirm" : props.label}
    </button>
  );
}

const EMPTY_SNAPSHOT: Snapshot = {
  agents: [], tasks: [], messages: [], docs: [], memory: { shared: "", agents: {} },
  settings: {
    claude_path: "", codex_path: "", ollama_url: "", lmstudio_url: "",
    bus_port: 0, max_hops: 6, router_model: "", builtin_enabled: false,
    builtin_port: 0, backend_advice_shown: true, brand_accent: "", brand_text: "",
    terms_accepted_version: 999, terms_accepted_at: 0,
    license_key: "", license_refresh_token: "", license_server: "", last_seen_ms: 0,
    trial_started_at: 0,
  },
  license: { state: "trial", days_left: 14, plan: "trial", customer: "", expires_at: 0, active: true },
};

const NO_AVAIL: Availability = {
  builtin: false, ollama: false, ollama_models: [], lmstudio: false, lmstudio_models: [], claude: false, codex: false,
};

const BACKENDS: BackendKind[] = ["builtin", "ollama", "lmstudio", "claude", "codex"];

const BACKEND_SUB: Record<BackendKind, string> = {
  builtin: "Zero setup — runs on this Mac",
  ollama: "Local, private, free",
  lmstudio: "Local, OpenAI-compatible",
  claude: "Claude Code CLI",
  codex: "Codex CLI",
};

interface Guide {
  title: string;
  intro: string;
  steps: string[];
  url: string;
  urlLabel: string;
}

const GUIDES: Partial<Record<BackendKind, Guide>> = {
  ollama: {
    title: "Set up Ollama",
    intro: "Ollama runs open models entirely on this Mac — private and free.",
    steps: [
      "Download Ollama and install it (drag to Applications, then open it once — a llama icon appears in the menu bar).",
      "Open Terminal and run:  ollama pull qwen3:8b   (≈5 GB; a capable model that supports tools).",
      "That's it — Qivreno connects to Ollama at localhost:11434 automatically.",
    ],
    url: "https://ollama.com/download",
    urlLabel: "Open ollama.com/download",
  },
  lmstudio: {
    title: "Set up LM Studio",
    intro: "LM Studio runs local models with a friendly UI, and works with any OpenAI-compatible server (LocalAI, llama.cpp…).",
    steps: [
      "Download LM Studio and install it.",
      "Inside LM Studio, use the search (🔍) to download a model that supports tool use — e.g. Qwen3 8B.",
      "Open the Developer tab and start the local server (default port 1234), with the model loaded.",
      "Qivreno connects at localhost:1234/v1 (changeable in Settings).",
    ],
    url: "https://lmstudio.ai",
    urlLabel: "Open lmstudio.ai",
  },
  claude: {
    title: "Set up Claude",
    intro: "Agents drive the Claude Code CLI using your own Claude subscription (Pro or Max recommended).",
    steps: [
      "Install Claude Code — the desktop app from the link below, or in Terminal:  npm install -g @anthropic-ai/claude-code",
      "Run  claude  once in Terminal and log in with your Claude account.",
      "Qivreno auto-detects the CLI. If it isn't found, set the path manually in Settings (⚙).",
    ],
    url: "https://claude.com/product/claude-code",
    urlLabel: "Open claude.com/claude-code",
  },
  codex: {
    title: "Set up Codex",
    intro: "Agents drive OpenAI's Codex CLI using your own ChatGPT subscription (Plus or Pro).",
    steps: [
      "Install Node.js if you don't have it (nodejs.org), then in Terminal:  npm install -g @openai/codex",
      "Run  codex  once in Terminal and sign in with your ChatGPT account.",
      "Qivreno auto-detects the CLI. If it isn't found, set the path manually in Settings (⚙).",
    ],
    url: "https://developers.openai.com/codex/cli",
    urlLabel: "Open Codex CLI docs",
  },
};

function fmtGB(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(2);
}

/// Enable / progress / status panel for the bundled AI engine.
function BuiltinPanel(props: { onChanged: () => void }) {
  const [st, setSt] = useState<BuiltinStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const tick = () => invoke<BuiltinStatus>("builtin_status").then(setSt).catch(() => {});
    tick();
    const iv = setInterval(tick, 1200);
    return () => clearInterval(iv);
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      await invoke("builtin_enable");
      props.onChanged();
    } catch { /* status poll shows the error */ }
    setBusy(false);
  };
  const disable = async () => {
    await invoke("builtin_disable").catch(() => {});
    props.onChanged();
  };

  if (!st) return <div className="guide"><div className="guide-intro">Checking built-in AI…</div></div>;

  return (
    <div className="guide">
      <div className="guide-title">Built-in AI</div>
      {st.running ? (
        <>
          <div className="guide-intro">
            ● Running — {st.model_name} entirely on this Mac. Agents on this backend need no other setup.
          </div>
          <div className="guide-actions">
            <button className="btn ghost sm" onClick={disable}>Turn off</button>
            <span className="guide-status up">● Running</span>
          </div>
        </>
      ) : st.downloading ? (
        <>
          <div className="guide-intro">Downloading {st.model_name}…</div>
          <div className="progress"><i style={{ width: st.total ? `${(st.downloaded / st.total) * 100}%` : "10%" }} /></div>
          <div className="guide-actions">
            <span className="guide-status">{fmtGB(st.downloaded)} / {st.total ? fmtGB(st.total) : "?"} GB — you can keep using the app</span>
          </div>
        </>
      ) : st.starting ? (
        <div className="guide-intro">Starting the engine (loading {st.model_name} into memory)…</div>
      ) : (
        <>
          <div className="guide-intro">
            One click, no third-party installs: Qivreno downloads {st.model_name} (~{st.model_size_gb} GB,
            picked for this Mac's {st.ram_gb} GB RAM) and runs it with the bundled engine. Private — nothing leaves this Mac.
          </div>
          {st.error && <div className="guide-intro" style={{ color: "var(--red)" }}>Last attempt failed: {st.error}</div>}
          <div className="guide-actions">
            <button className="btn sm" disabled={busy} onClick={enable}>
              {st.model_installed ? "Turn on Built-in AI" : `Download & enable (${st.model_size_gb} GB)`}
            </button>
            <span className="guide-status">○ Not running</span>
          </div>
        </>
      )}
    </div>
  );
}

function SetupGuide(props: {
  backend: BackendKind;
  avail: Availability;
  onRecheck: () => void;
}) {
  const [checking, setChecking] = useState(false);
  if (props.backend === "builtin") {
    return <BuiltinPanel onChanged={props.onRecheck} />;
  }
  const g = GUIDES[props.backend]!;
  const up = props.avail[props.backend];
  return (
    <div className="guide">
      <div className="guide-title">{g.title}</div>
      <div className="guide-intro">{g.intro}</div>
      <ol className="guide-steps">
        {g.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <div className="guide-actions">
        <button className="btn ghost sm" onClick={() => openUrl(g.url).catch(() => {})}>
          ↗ {g.urlLabel}
        </button>
        <button
          className="btn sm"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            props.onRecheck();
            setTimeout(() => setChecking(false), 1500);
          }}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        <span className={`guide-status ${up ? "up" : ""}`}>
          {up ? "● Connected" : "○ Not detected yet"}
        </span>
      </div>
    </div>
  );
}

const COLUMNS: { key: Column; label: string }[] = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const BACKEND_LABEL: Record<BackendKind, string> = {
  builtin: "Built-in AI", ollama: "Ollama", lmstudio: "LM Studio", claude: "Claude", codex: "Codex",
};
const BACKEND_DOT: Record<BackendKind, string> = {
  builtin: "AI", ollama: "Ollama", lmstudio: "LM", claude: "Claude", codex: "Codex",
};

/** Blocking Terms & Conditions gate (or read-only viewer from Settings). */
function TermsModal(props: { viewOnly: boolean; onClose?: () => void; notify: (t: string, e?: boolean) => void }) {
  const [agreed, setAgreed] = useState(false);
  const accept = async () => {
    try {
      await invoke("accept_terms");
    } catch (e) {
      props.notify(String(e), true);
    }
  };
  return (
    <div className="overlay terms-overlay">
      <div className="modal wide terms-modal">
        <h2>Terms &amp; Conditions</h2>
        <div className="terms-body">
          <MarkdownView text={TERMS_MD} />
        </div>
        {props.viewOnly ? (
          <div className="modal-actions">
            <button className="btn" onClick={props.onClose}>Close</button>
          </div>
        ) : (
          <>
            <label className="terms-agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              I have read and agree to these Terms &amp; Conditions, including that agent responses
              are AI-generated and for reference only.
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => invoke("quit_app").catch(() => {})}>
                Decline &amp; Quit
              </button>
              <button className="btn" disabled={!agreed} onClick={accept}>I Agree</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [avail, setAvail] = useState<Availability>(NO_AVAIL);
  const [showGuide, setShowGuide] = useState<BackendKind | null>(null);
  const [view, setView] = useState<View>({ kind: "board" });
  const [editingAgent, setEditingAgent] = useState<Agent | "new" | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [filesFocus, setFilesFocus] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(() => {
    invoke<Snapshot>("get_snapshot").then(setSnap).catch(() => {});
  }, []);
  const checkAvail = useCallback(() => {
    invoke<Availability>("check_availability").then(setAvail).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    checkAvail();
    const un = listen("changed", refresh);
    const iv = setInterval(checkAvail, 30000);
    return () => { un.then((f) => f()); clearInterval(iv); };
  }, [refresh, checkAvail]);

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const workingAgents = useMemo(() => {
    const ids = new Set<string>();
    for (const t of snap.tasks) {
      if ((t.status === "running" || t.status === "routing") && t.agent_id) ids.add(t.agent_id);
    }
    return ids;
  }, [snap.tasks]);

  const agentById = useMemo(() => {
    const m = new Map<string, Agent>();
    snap.agents.forEach((a) => m.set(a.id, a));
    return m;
  }, [snap.agents]);

  const nameOf = useCallback(
    (id: string) => (id === "user" ? "You" : agentById.get(id)?.name ?? "(deleted agent)"),
    [agentById],
  );
  const colorOf = useCallback(
    (id: string) => (id === "user" ? "#8b94a3" : agentById.get(id)?.color ?? "#5b6474"),
    [agentById],
  );

  const selectedAgent = view.kind === "agent" ? agentById.get(view.id) : undefined;

  // Guided first-run setup: create (or reuse) the Concierge agent and open
  // a chat where it interviews the user, fills the Business Profile, and
  // hires the right team.
  const startConcierge = useCallback(async () => {
    const existing = snap.agents.find((a) => a.name === CONCIERGE.name);
    try {
      let id = existing?.id;
      if (!id) {
        const backend = firstAvailableBackend(avail);
        const agent = await invoke<Agent>("create_agent", {
          input: {
            name: CONCIERGE.name,
            role: CONCIERGE.role,
            skills: CONCIERGE.skills,
            backend,
            model: localModelsFor(backend, avail)?.[0] ?? "",
            permission: "sandboxed" as Permission,
            color: CONCIERGE.color,
          },
        });
        id = agent.id;
        await invoke("send_chat", {
          agentId: id,
          body: "Hi! I'm new here — please interview me and set up Qivreno for my business.",
        });
      }
      setShowTemplates(false);
      setView({ kind: "agent", id: id! });
    } catch (e) {
      notify(String(e), true);
    }
  }, [snap.agents, avail, notify]);

  const dismissAdvice = useCallback(() => {
    invoke("update_settings", { settings: { ...snap.settings, backend_advice_shown: true } }).catch(() => {});
  }, [snap.settings]);

  const lic = snap.license;
  const bannerText =
    lic.state === "trial_expired"
      ? "Your free trial has ended — subscribe to keep your team working. Your files and agents are safe."
      : lic.state === "expired"
      ? "Your Qivreno subscription has expired — agents are paused until it renews."
      : lic.state === "grace"
      ? `Your subscription has lapsed — ${lic.days_left} day${lic.days_left === 1 ? "" : "s"} of grace remaining.`
      : lic.state === "trial" && lic.days_left <= 5
      ? `Free trial: ${lic.days_left} day${lic.days_left === 1 ? "" : "s"} left.`
      : null;

  return (
    <div className="app-col">
      {bannerText && (
        <div className={`license-banner ${lic.active ? "" : "blocked"}`}>
          <span>{bannerText}</span>
          <button className="btn sm" onClick={() => openUrl("https://qivreno.ai/pricing")}>Subscribe</button>
          <button className="btn sm ghost" onClick={() => setShowSettings(true)}>Enter activation code</button>
        </div>
      )}
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-lockup" src="/logo-white.png" alt="Qivreno — AI Workforce Platform" />
        </div>
        <button className={`nav-item ${view.kind === "board" ? "active" : ""}`} onClick={() => setView({ kind: "board" })}>
          <span className="icon">▦</span> Board
        </button>
        <button className={`nav-item ${view.kind === "activity" ? "active" : ""}`} onClick={() => setView({ kind: "activity" })}>
          <span className="icon">☰</span> Activity
        </button>
        <button className={`nav-item ${view.kind === "library" ? "active" : ""}`} onClick={() => setView({ kind: "library" })}>
          <span className="icon">▤</span> Library
        </button>
        <button className={`nav-item ${view.kind === "files" ? "active" : ""}`} onClick={() => setView({ kind: "files" })}>
          <span className="icon">🗎</span> Files
        </button>
        <div className="section-label">
          <span>Agents</span>
          <span>{snap.agents.length}/{MAX_AGENTS}</span>
        </div>
        <div className="agent-list">
          {snap.agents.map((a) => (
            <button
              key={a.id}
              className={`agent-item ${view.kind === "agent" && view.id === a.id ? "active" : ""}`}
              onClick={() => setView({ kind: "agent", id: a.id })}
            >
              <span className={`agent-dot ${workingAgents.has(a.id) ? "working" : ""}`} style={{ background: a.color, color: a.color }} />
              <span style={{ minWidth: 0 }}>
                <div className="agent-item-name">{a.name}</div>
                <div className="agent-item-role">{a.role}</div>
              </span>
              {workingAgents.has(a.id) && <span className="agent-item-status">working</span>}
            </button>
          ))}
        </div>
        <button className="add-agent" disabled={snap.agents.length >= MAX_AGENTS} onClick={() => setEditingAgent("new")}>
          + New Agent
        </button>
        {snap.agents.length < MAX_AGENTS && (
          <button className="add-agent quickstart" onClick={() => setShowTemplates(true)}>
            ✨ Quick Start Team
          </button>
        )}
        <div className="sidebar-footer">
          <div className="backend-dots">
            {BACKENDS.map((b) => (
              <button
                key={b}
                className={`backend-dot ${avail[b] ? "up" : ""}`}
                title={avail[b] ? `${BACKEND_LABEL[b]} — connected` : `${BACKEND_LABEL[b]} — click for setup guide`}
                onClick={() => setShowGuide(b)}
              >
                <i /> {BACKEND_DOT[b]}
              </button>
            ))}
          </div>
          <button className="gear" title="Settings" onClick={() => setShowSettings(true)}>⚙</button>
        </div>
      </aside>

      <main className="main">
        {view.kind === "board" && (
          <KanbanBoard
            snap={snap}
            agentById={agentById}
            notify={notify}
            onQuickStart={() => setShowTemplates(true)}
            onNewAgent={() => setEditingAgent("new")}
            onConcierge={startConcierge}
            onOpenFile={(name) => { setFilesFocus(name); setView({ kind: "files" }); }}
          />
        )}
        {view.kind === "activity" && <ActivityFeed snap={snap} nameOf={nameOf} colorOf={colorOf} />}
        {view.kind === "library" && <LibraryView snap={snap} notify={notify} />}
        {view.kind === "files" && (
          <FilesView notify={notify} focus={filesFocus} onFocusConsumed={() => setFilesFocus(null)} />
        )}
        {view.kind === "agent" && selectedAgent && (
          <AgentView
            agent={selectedAgent}
            snap={snap}
            working={workingAgents.has(selectedAgent.id)}
            onEdit={() => setEditingAgent(selectedAgent)}
            onDeleted={() => setView({ kind: "board" })}
            notify={notify}
          />
        )}
        {view.kind === "agent" && !selectedAgent && (
          <div className="empty">This agent no longer exists.</div>
        )}
      </main>

      {editingAgent && (
        <AgentModal
          agent={editingAgent === "new" ? null : editingAgent}
          avail={avail}
          onRecheck={checkAvail}
          onClose={() => setEditingAgent(null)}
          notify={notify}
        />
      )}
      {showTemplates && (
        <TemplateModal
          existing={snap.agents}
          avail={avail}
          onRecheck={checkAvail}
          onConcierge={startConcierge}
          onClose={() => setShowTemplates(false)}
          notify={notify}
        />
      )}
      {showGuide && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowGuide(null); }}>
          <div className="modal">
            <SetupGuide backend={showGuide} avail={avail} onRecheck={checkAvail} />
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowGuide(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <SettingsModal
          settings={snap.settings}
          license={snap.license}
          avail={avail}
          onClose={() => { setShowSettings(false); checkAvail(); }}
          notify={notify}
        />
      )}
      {snap.settings.bus_port > 0 && snap.settings.terms_accepted_version < TERMS_VERSION && (
        <TermsModal viewOnly={false} notify={notify} />
      )}
      {snap.settings.bus_port > 0
        && snap.settings.terms_accepted_version >= TERMS_VERSION
        && !snap.settings.backend_advice_shown && (
        <div className="overlay">
          <div className="modal">
            <h2>Recommended setup</h2>
            <p className="advice-p">
              For the best results, run your most important agents on <b>Claude</b> or <b>Codex</b> —
              they are markedly more capable and use your existing subscription.
            </p>
            <p className="advice-p">
              Local models (Built-in AI, Ollama, LM Studio) are great for private, high-volume work —
              and whenever one is installed, it automatically serves as a <b>fallback</b>: if an
              agent's primary backend is unavailable or fails, the task reruns locally so your team
              never stalls. Nothing to configure.
            </p>
            <div className="tags" style={{ marginBottom: 6 }}>
              <span className="tag">{avail.claude ? "✓ Claude detected" : "Claude not set up"}</span>
              <span className="tag">{avail.codex ? "✓ Codex detected" : "Codex not set up"}</span>
              <span className="tag">
                {avail.builtin || avail.ollama || avail.lmstudio ? "✓ Local fallback ready" : "No local model yet"}
              </span>
            </div>
            <div className="hint">Set any of these up later by clicking the dots at the bottom of the sidebar.</div>
            <div className="modal-actions">
              {!avail.claude && (
                <button className="btn ghost" onClick={() => { dismissAdvice(); setShowGuide("claude"); }}>
                  Set up Claude…
                </button>
              )}
              <button className="btn" onClick={dismissAdvice}>Got it</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.text}</div>}
    </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function KanbanBoard(props: {
  snap: Snapshot;
  agentById: Map<string, Agent>;
  notify: (t: string, e?: boolean) => void;
  onQuickStart: () => void;
  onNewAgent: () => void;
  onConcierge: () => void;
  onOpenFile: (name: string) => void;
}) {
  const { snap, agentById, notify } = props;
  const [prompt, setPrompt] = useState("");
  const [assignee, setAssignee] = useState("auto");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<Column | null>(null);

  const submit = async (draft: boolean) => {
    try {
      await invoke("create_task", {
        title: "",
        prompt,
        agentKey: assignee === "auto" ? null : assignee,
        draft,
      });
      setPrompt("");
      notify(draft ? "Added to the backlog" : "Task dispatched");
    } catch (e) {
      notify(String(e), true);
    }
  };

  const moveTask = (id: string, column: Column) => {
    invoke("move_task", { id, column }).catch((e) => notify(String(e), true));
  };

  const boardTasks = useMemo(
    () => snap.tasks.filter((t) => t.kind === "task"),
    [snap.tasks],
  );
  const byColumn = useMemo(() => {
    const m = new Map<Column, Task[]>();
    COLUMNS.forEach((c) => m.set(c.key, []));
    for (const t of boardTasks) {
      (m.get(t.column) ?? m.get("todo"))!.push(t);
    }
    m.forEach((list) => list.sort((a, b) => b.updated_at - a.updated_at));
    return m;
  }, [boardTasks]);

  const detail = detailId ? boardTasks.find((t) => t.id === detailId) : undefined;

  return (
    <>
      <div className="main-header">
        <div>
          <div className="main-title">Board</div>
          <div className="main-sub">Drag tasks between columns — agents move them too as they work</div>
        </div>
      </div>
      <div className="main-body board-body">
        <div className="composer">
          <textarea
            placeholder={snap.agents.length === 0
              ? "Create agents first (try Quick Start Team), then describe a task here…"
              : "Describe a task… e.g. “Draft a Q3 hiring plan for a 15-person team”"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim() && snap.agents.length > 0) submit(false);
            }}
          />
          <div className="composer-row">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="auto">🎯 Best fit (auto-route)</option>
              {snap.agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
              ))}
            </select>
            <div className="spacer" />
            <button className="btn ghost" disabled={!prompt.trim()} onClick={() => submit(true)}>
              Add to Backlog
            </button>
            <button className="btn" disabled={!prompt.trim() || snap.agents.length === 0} onClick={() => submit(false)}>
              Dispatch Now ⌘↵
            </button>
          </div>
        </div>

        {snap.agents.length === 0 && boardTasks.length === 0 ? (
          <div className="empty">
            <p style={{ marginBottom: 14 }}>
              Welcome to Qivreno. The fastest start: let the <b>Concierge</b> interview you,
              fill in your business profile, and hire the right team automatically.
            </p>
            <button className="btn" onClick={props.onConcierge}>🪄 Set up with the Concierge</button>
            <p style={{ margin: "14px 0" }}>…or do it yourself:</p>
            <button className="btn ghost" onClick={props.onQuickStart}>✨ Quick Start Team</button>
            <span style={{ margin: "0 10px" }}>or</span>
            <button className="btn ghost" onClick={props.onNewAgent}>+ New Agent</button>
          </div>
        ) : (
          <div className="kanban">
            {COLUMNS.map((col) => (
              <div
                key={col.key}
                className={`kcol ${dragOver === col.key ? "dragover" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(col.key); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const id = e.dataTransfer.getData("text/plain");
                  if (id) moveTask(id, col.key);
                }}
              >
                <div className="kcol-head">
                  <span>{col.label}</span>
                  <span className="kcount">{byColumn.get(col.key)!.length}</span>
                </div>
                <div className="kcol-body">
                  {byColumn.get(col.key)!.map((t) => {
                    const agent = t.agent_id ? agentById.get(t.agent_id) : undefined;
                    const showBadge = !(
                      (col.key === "todo" && t.status === "draft") ||
                      ((col.key === "review" || col.key === "done") && t.status === "done")
                    );
                    return (
                      <div
                        key={t.id}
                        className="kcard"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", t.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => setDetailId(t.id)}
                      >
                        <div className="kcard-title">{t.title}</div>
                        {t.status === "done" && t.result && (
                          <div className="kcard-snippet">{t.result.replace(/[#*`>-]/g, "").slice(0, 110)}</div>
                        )}
                        <div className="kcard-meta">
                          {agent ? (
                            <span className="agent-chip"><i style={{ background: agent.color }} /> {agent.name}</span>
                          ) : (
                            <span className="agent-chip"><i style={{ background: "var(--text-faint)" }} /> auto</span>
                          )}
                          {showBadge && <span className={`badge ${t.status}`}>{t.status}</span>}
                          <span className="task-time">{timeAgo(t.updated_at)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {detail && (
        <TaskDetailModal
          task={detail}
          agent={detail.agent_id ? agentById.get(detail.agent_id) : undefined}
          onClose={() => setDetailId(null)}
          onMove={(c) => moveTask(detail.id, c)}
          onOpenFile={props.onOpenFile}
          notify={notify}
        />
      )}
    </>
  );
}

/** Turn a raw log line into a human-readable action for review. */
function prettyAction(line: string): { icon: string; text: string; file?: string } {
  const grab = (k: string) => line.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
  if (line.startsWith("tool: ")) {
    const name = line.slice(6).split(" ")[0];
    switch (name) {
      case "write_file": {
        const path = grab("path") ?? "a file";
        return { icon: "📄", text: `Wrote ${path}`, file: path.startsWith("Shared/") ? path.slice(7) : undefined };
      }
      case "read_file": return { icon: "👁", text: `Read ${grab("path") ?? "a file"}` };
      case "list_files": return { icon: "📁", text: "Browsed files" };
      case "save_process": return { icon: "📚", text: `Saved process “${grab("title") ?? "…"}” to the Library` };
      case "read_doc": return { icon: "📚", text: `Read library doc ${grab("doc") ?? ""}` };
      case "list_library": return { icon: "📚", text: "Checked the Library" };
      case "send_message": return { icon: "💬", text: `Messaged ${grab("to") ?? "a teammate"}: “${(grab("body") ?? "").slice(0, 70)}…”` };
      case "update_memory": return { icon: "🧠", text: `Updated ${grab("scope") === "shared" ? "the team's shared" : "its private"} memory` };
      case "move_task": return { icon: "📋", text: `Moved board task ${grab("task") ?? ""} to ${grab("column") ?? ""}` };
      case "create_agent": return { icon: "🤝", text: `Hired new agent “${grab("name") ?? ""}”` };
      case "list_board": return { icon: "📋", text: "Checked the board" };
      case "fetch_url": return { icon: "🌐", text: `Fetched ${grab("url") ?? "a URL"}` };
      case "run_command": return { icon: "⚡", text: `Ran a command: ${(grab("command") ?? "").slice(0, 70)}` };
      default: return { icon: "🔧", text: line.slice(6) };
    }
  }
  if (line.startsWith("routed to best fit")) return { icon: "🎯", text: line };
  if (line.startsWith("started on")) return { icon: "▶️", text: line };
  if (line.includes("falling back")) return { icon: "⚠️", text: line };
  if (line.startsWith("error:")) return { icon: "❌", text: line };
  return { icon: "·", text: line };
}

function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

function TaskDetailModal(props: {
  task: Task;
  agent?: Agent;
  onClose: () => void;
  onMove: (c: Column) => void;
  onOpenFile: (name: string) => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const { task, agent, notify } = props;
  const active = ["routing", "queued", "running"].includes(task.status);
  const actions = task.log.map(prettyAction);
  const files = [...new Set(actions.filter((a) => a.file).map((a) => a.file!))];
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal wide">
        <div className="detail-head">
          <h2 style={{ marginBottom: 0 }}>{task.title}</h2>
          <span className={`badge ${task.status}`}>{task.status}</span>
        </div>
        <div className="detail-sub">
          {agent ? `${agent.name}` : "Unassigned — routes to best fit when started"}
          {" · created "}{timeAgo(task.created_at)}
          {!active && task.updated_at > task.created_at &&
            ` · took ${fmtDuration(task.updated_at - task.created_at)}`}
        </div>
        <div className="task-detail" style={{ borderTop: "none", paddingTop: 4 }}>
          {task.result && (
            <div>
              <h4>{task.status === "failed" ? "Error" : "Summary — what the agent reports"}</h4>
              {task.status === "failed" ? (
                <pre>{task.result}</pre>
              ) : (
                <div className="result-md"><MarkdownView text={task.result} /></div>
              )}
              {task.status !== "failed" && (
                <div className="ai-note">AI-generated — for reference only. Verify before relying on it.</div>
              )}
            </div>
          )}
          {files.length > 0 && (
            <div>
              <h4>Files produced</h4>
              <div className="file-chips">
                {files.map((f) => (
                  <button key={f} className="file-chip" onClick={() => { props.onOpenFile(f); props.onClose(); }}>
                    📄 {f} <span>open →</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {task.log.length > 0 && (
            <div>
              <h4>Actions taken</h4>
              <div className="act-list">
                {actions.map((a, i) => (
                  <div className="act-line" key={i}><span className="act-ico">{a.icon}</span> {a.text}</div>
                ))}
              </div>
            </div>
          )}
          <details className="req-details">
            <summary>Original request</summary>
            <pre>{task.prompt}</pre>
          </details>
        </div>
        <div className="modal-actions">
          {!active && (
            <button
              className="btn danger sm"
              onClick={() => {
                invoke("delete_task", { id: task.id })
                  .then(props.onClose)
                  .catch((e) => notify(String(e), true));
              }}
            >
              Delete
            </button>
          )}
          <div className="spacer" />
          {active ? (
            <button
              className="btn danger sm"
              onClick={() => invoke("cancel_task", { id: task.id }).catch((e) => notify(String(e), true))}
            >
              Cancel Run
            </button>
          ) : (
            <>
              {task.column !== "done" && task.status === "done" && (
                <button className="btn ghost sm" onClick={() => { props.onMove("done"); props.onClose(); }}>
                  Approve → Done
                </button>
              )}
              <button className="btn sm" onClick={() => props.onMove("in_progress")}>
                {task.status === "draft" ? "Start" : "Re-run"}
              </button>
            </>
          )}
          <button className="btn ghost sm" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AgentView(props: {
  agent: Agent;
  snap: Snapshot;
  working: boolean;
  onEdit: () => void;
  onDeleted: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const { agent, snap, working, notify } = props;
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const chat = useMemo(
    () =>
      snap.messages.filter(
        (m) =>
          (m.from === "user" && m.to === agent.id) ||
          (m.from === agent.id && m.to === "user"),
      ),
    [snap.messages, agent.id],
  );
  const awaitingReply = useMemo(
    () =>
      snap.tasks.some(
        (t) => t.kind === "chat" && t.agent_id === agent.id && ["queued", "running"].includes(t.status),
      ),
    [snap.tasks, agent.id],
  );
  const agentTasks = useMemo(
    () =>
      snap.tasks
        .filter((t) => t.agent_id === agent.id && t.kind !== "chat")
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 5),
    [snap.tasks, agent.id],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.length, awaitingReply]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    try {
      await invoke("send_chat", { agentId: agent.id, body });
    } catch (e) {
      notify(String(e), true);
    }
  };

  const remove = async () => {
    try {
      await invoke("delete_agent", { id: agent.id });
      props.onDeleted();
    } catch (e) {
      notify(String(e), true);
    }
  };

  return (
    <>
      <div className="main-header">
        <div>
          <div className="main-title">{agent.name}</div>
          <div className="main-sub">{working ? "Working…" : "Idle"}</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={props.onEdit}>Edit</button>
        <ArmButton label="Delete" armedLabel="Really delete?" onConfirm={remove} />
      </div>
      <div className="main-body">
        <div className="profile">
          <div className="avatar" style={{ background: agent.color }}>
            {agent.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="profile-info">
            <div className="profile-name">{agent.name}</div>
            <div className="profile-role">{agent.role}</div>
            {agent.skills && <div className="profile-skills">{agent.skills}</div>}
            <div className="tags">
              <span className="tag">{BACKEND_LABEL[agent.backend]}{agent.model ? ` · ${agent.model}` : ""}</span>
              {agent.permission === "full"
                ? <span className="tag warn">Full access</span>
                : <span className="tag">Sandboxed</span>}
              <span className="tag">~/Qivreno/{agent.name.replace(/[^a-zA-Z0-9]/g, "-")}</span>
            </div>
          </div>
        </div>

        <div className="chat">
          {chat.length === 0 && !awaitingReply && (
            <div className="empty">Say hello — messages here go straight to {agent.name}.</div>
          )}
          {chat.map((m) => (
            <div key={m.id} className={`bubble-row ${m.from === "user" ? "user" : "agent"}`}>
              <div className={`bubble ${m.from === "user" ? "user" : "agent"}`}>{m.body}</div>
              <div className="bubble-meta">
                {m.from === "user" ? timeAgo(m.ts) : <>AI-generated — for reference only · {timeAgo(m.ts)}</>}
              </div>
            </div>
          ))}
          {awaitingReply && <div className="typing">{agent.name} is thinking…</div>}
          <div ref={endRef} />
        </div>

        {agentTasks.length > 0 && (
          <>
            <div className="section-label" style={{ padding: "6px 2px" }}><span>Recent tasks</span></div>
            <div className="task-list" style={{ marginBottom: 16 }}>
              {agentTasks.map((t) => (
                <div className="task-card" key={t.id}>
                  <div className="task-head" style={{ cursor: "default" }}>
                    <span className="task-title">{t.title}</span>
                    <span className={`badge ${t.status}`}>{t.status}</span>
                    <span className="task-time">{timeAgo(t.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="chat-input">
          <textarea
            rows={1}
            placeholder={`Message ${agent.name}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn sm" disabled={!draft.trim()} onClick={send}>Send</button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

function ActivityFeed(props: {
  snap: Snapshot;
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
}) {
  const messages = useMemo(
    () => [...props.snap.messages].sort((a, b) => b.ts - a.ts).slice(0, 200),
    [props.snap.messages],
  );
  return (
    <>
      <div className="main-header">
        <div>
          <div className="main-title">Activity</div>
          <div className="main-sub">Every message flowing between you and the team</div>
        </div>
      </div>
      <div className="main-body">
        {messages.length === 0 ? (
          <div className="empty">Nothing yet. Once agents start talking — to you or to each other — it shows up here.</div>
        ) : (
          <div className="feed">
            {messages.map((m) => (
              <div className="feed-item" key={m.id}>
                <div className="feed-head">
                  <span className="feed-name" style={{ color: props.colorOf(m.from) }}>{props.nameOf(m.from)}</span>
                  <span className="feed-arrow">→</span>
                  <span className="feed-name" style={{ color: props.colorOf(m.to) }}>{props.nameOf(m.to)}</span>
                  <span className="feed-time">{timeAgo(m.ts)}</span>
                </div>
                <div className="feed-body">{m.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

function firstAvailableBackend(avail: Availability): BackendKind {
  return BACKENDS.find((b) => avail[b]) ?? "ollama";
}

function localModelsFor(backend: BackendKind, avail: Availability): string[] | null {
  if (backend === "ollama") return avail.ollama_models;
  if (backend === "lmstudio") return avail.lmstudio_models;
  return null;
}

/* ---------------- Shared Files ---------------- */

const KIND_META: Record<string, { icon: string; label: string; exports: { label: string; format: string }[] }> = {
  document: { icon: "📄", label: "Document", exports: [{ label: "Word", format: "docx" }, { label: "PDF", format: "pdf" }] },
  spreadsheet: { icon: "▦", label: "Spreadsheet", exports: [{ label: "Excel", format: "xlsx" }, { label: "PDF", format: "pdf" }] },
  presentation: { icon: "🖥", label: "Presentation", exports: [{ label: "PowerPoint", format: "pptx" }, { label: "PDF", format: "pdf" }] },
  dashboard: { icon: "📊", label: "Dashboard", exports: [{ label: "HTML", format: "html" }, { label: "PDF", format: "pdf" }] },
  other: { icon: "🗎", label: "File", exports: [] },
};

const NEW_FILE_TEMPLATES: { kind: string; name: string; content: string }[] = [
  { kind: "document", name: "Untitled.md", content: "# Untitled\n\nStart writing…\n" },
  { kind: "spreadsheet", name: "Untitled.csv", content: "Item,Amount,Notes\nExample,100,\n" },
  {
    kind: "presentation",
    name: "Untitled.slides.json",
    content: JSON.stringify(
      { title: "Untitled deck", slides: [{ title: "First slide", bullets: ["Point one", "Point two"], notes: "" }] },
      null, 2),
  },
  {
    kind: "dashboard",
    name: "Untitled.dash.json",
    content: JSON.stringify(
      {
        title: "Untitled dashboard",
        widgets: [
          { type: "stat", label: "Revenue", value: "$12,400", sub: "this month" },
          { type: "bar", label: "Sales by month", data: [{ x: "Jan", y: 8 }, { x: "Feb", y: 12 }, { x: "Mar", y: 10 }] },
        ],
      },
      null, 2),
  },
];

/** Minimal inline markdown: **bold**, *italic*, `code`. */
function mdInline(text: string, key: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) parts.push(<code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
    else parts.push(<em key={`${key}-${i++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownView(props: { text: string }) {
  const out: React.ReactNode[] = [];
  let list: { tag: "ul" | "ol"; items: React.ReactNode[] } | null = null;
  let code: string[] | null = null;
  let table: string[] | null = null;
  let k = 0;

  const flushList = () => {
    if (list) {
      out.push(list.tag === "ul" ? <ul key={k++}>{list.items}</ul> : <ol key={k++}>{list.items}</ol>);
      list = null;
    }
  };
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter((r) => !/^\s*\|[\s\-:|]+\|?\s*$/.test(r));
    out.push(
      <table key={k++}>
        <tbody>
          {rows.map((r, ri) => {
            const cells = r.trim().replace(/^\||\|$/g, "").split("|");
            return (
              <tr key={ri}>
                {cells.map((c, ci) =>
                  ri === 0 ? <th key={ci}>{mdInline(c.trim(), k++)}</th> : <td key={ci}>{mdInline(c.trim(), k++)}</td>,
                )}
              </tr>
            );
          })}
        </tbody>
      </table>,
    );
    table = null;
  };

  for (const line of props.text.split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("```")) {
      flushList(); flushTable();
      if (code) { out.push(<pre key={k++}>{code.join("\n")}</pre>); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    if (t.startsWith("|")) { (table ??= []).push(line); continue; }
    flushTable();
    if (t.startsWith("### ")) { flushList(); out.push(<h3 key={k++}>{mdInline(t.slice(4), k++)}</h3>); }
    else if (t.startsWith("## ")) { flushList(); out.push(<h2 key={k++}>{mdInline(t.slice(3), k++)}</h2>); }
    else if (t.startsWith("# ")) { flushList(); out.push(<h1 key={k++}>{mdInline(t.slice(2), k++)}</h1>); }
    else if (t.startsWith("> ")) { flushList(); out.push(<blockquote key={k++}>{mdInline(t.slice(2), k++)}</blockquote>); }
    else if (t.startsWith("- ") || t.startsWith("* ")) {
      if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
      list.items.push(<li key={k++}>{mdInline(t.slice(2), k++)}</li>);
    } else if (/^\d+\.\s/.test(t)) {
      if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
      list.items.push(<li key={k++}>{mdInline(t.replace(/^\d+\.\s/, ""), k++)}</li>);
    } else if (t === "") { flushList(); }
    else { flushList(); out.push(<p key={k++}>{mdInline(line, k++)}</p>); }
  }
  flushList(); flushTable();
  if (code) out.push(<pre key={k++}>{(code as string[]).join("\n")}</pre>);
  return <div className="md-view">{out}</div>;
}

function parseCsv(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const fields: string[] = [];
      let cur = "";
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (q && line[i + 1] === '"') { cur += '"'; i++; }
          else q = !q;
        } else if (ch === "," && !q) { fields.push(cur.trim()); cur = ""; }
        else cur += ch;
      }
      fields.push(cur.trim());
      return fields;
    });
}

function CsvView(props: { text: string }) {
  const rows = parseCsv(props.text);
  if (rows.length === 0) return <div className="empty">Empty spreadsheet.</div>;
  return (
    <div className="csv-wrap">
      <table className="csv-table">
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (ri === 0 ? <th key={ci}>{c}</th> : <td key={ci}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SlidesView(props: { text: string }) {
  const [idx, setIdx] = useState(0);
  let deck: { title?: string; slides?: { title?: string; bullets?: string[]; notes?: string }[] };
  try {
    deck = JSON.parse(props.text);
  } catch {
    return <div className="empty">This presentation isn't valid JSON yet — switch to Edit to fix it.</div>;
  }
  const slides = deck.slides ?? [];
  const total = slides.length + 1;
  const cur = Math.min(idx, total - 1);
  return (
    <div className="deck">
      <div className="deck-slide">
        {cur === 0 ? (
          <div className="deck-title-slide">{deck.title ?? "Untitled deck"}</div>
        ) : (
          <>
            <div className="deck-h">{slides[cur - 1]?.title}</div>
            <ul>{(slides[cur - 1]?.bullets ?? []).map((b, i) => <li key={i}>{mdInline(b, i)}</li>)}</ul>
            {slides[cur - 1]?.notes && <div className="deck-notes">🗒 {slides[cur - 1].notes}</div>}
          </>
        )}
      </div>
      <div className="deck-nav">
        <button className="btn ghost sm" disabled={cur === 0} onClick={() => setIdx(cur - 1)}>← Prev</button>
        <span className="deck-pos">{cur + 1} / {total}</span>
        <button className="btn ghost sm" disabled={cur >= total - 1} onClick={() => setIdx(cur + 1)}>Next →</button>
      </div>
    </div>
  );
}

/* Chart hues validated against the app's dark surface (dataviz six-checks). */
const SERIES_1 = "#3987e5";

function chartPoints(w: { data?: { x: string | number; y: number }[] }): { x: string; y: number }[] {
  return (w.data ?? []).map((p) => ({ x: String(p.x), y: Number(p.y) || 0 }));
}

function BarChart(props: { data: { x: string; y: number }[] }) {
  const { data } = props;
  const W = 620, H = 240, PL = 44, PB = 26, PT = 14;
  const max = Math.max(0, ...data.map((d) => d.y));
  const min = Math.min(0, ...data.map((d) => d.y));
  const range = Math.max(max - min, 1e-9);
  const plotW = W - PL - 10, plotH = H - PT - PB;
  const step = plotW / Math.max(data.length, 1);
  const bw = Math.min(56, Math.max(4, step - 2));
  const yOf = (v: number) => PT + plotH * (1 - (v - min) / range);
  const baseY = yOf(0);
  const maxI = data.reduce((mi, d, i) => (d.y > data[mi].y ? i : mi), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      {[1, 2, 3].map((q) => (
        <line key={q} x1={PL} x2={W - 10} y1={PT + (plotH * q) / 4} y2={PT + (plotH * q) / 4}
          stroke="var(--border)" strokeWidth={1} />
      ))}
      {data.map((d, i) => {
        const x = PL + step * i + (step - bw) / 2;
        const top = d.y >= 0 ? yOf(d.y) : baseY;
        const h = Math.abs(baseY - yOf(d.y));
        return (
          <g key={i}>
            <rect x={x} y={top} width={bw} height={Math.max(h, 1)} rx={4} fill={SERIES_1}>
              <title>{d.x}: {d.y}</title>
            </rect>
            {/* square off the baseline end so only the data end reads rounded */}
            {h > 6 && (
              <rect x={x} y={d.y >= 0 ? baseY - 4 : baseY} width={bw} height={4} fill={SERIES_1} />
            )}
            {i === maxI && (
              <text x={x + bw / 2} y={top - 5} textAnchor="middle" className="chart-label">{d.y}</text>
            )}
            {data.length <= 14 && (
              <text x={x + bw / 2} y={H - 7} textAnchor="middle" className="chart-axis">{d.x}</text>
            )}
          </g>
        );
      })}
      <line x1={PL} x2={W - 10} y1={baseY} y2={baseY} stroke="var(--text-faint)" strokeWidth={1} />
      <text x={PL - 6} y={yOf(max) + 4} textAnchor="end" className="chart-axis">{max}</text>
    </svg>
  );
}

function LineChart(props: { data: { x: string; y: number }[] }) {
  const { data } = props;
  const W = 620, H = 240, PL = 44, PB = 26, PT = 14;
  const max = Math.max(...data.map((d) => d.y));
  const min = Math.min(0, ...data.map((d) => d.y));
  const range = Math.max(max - min, 1e-9);
  const plotW = W - PL - 16, plotH = H - PT - PB;
  const xOf = (i: number) => PL + (plotW * i) / Math.max(data.length - 1, 1);
  const yOf = (v: number) => PT + plotH * (1 - (v - min) / range);
  const pts = data.map((d, i) => `${xOf(i)},${yOf(d.y)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      {[1, 2, 3].map((q) => (
        <line key={q} x1={PL} x2={W - 16} y1={PT + (plotH * q) / 4} y2={PT + (plotH * q) / 4}
          stroke="var(--border)" strokeWidth={1} />
      ))}
      <polyline points={pts} fill="none" stroke={SERIES_1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <circle key={i} cx={xOf(i)} cy={yOf(d.y)} r={4} fill={SERIES_1} stroke="var(--bg-card)" strokeWidth={2}>
          <title>{d.x}: {d.y}</title>
        </circle>
      ))}
      {data.length > 0 && (
        <text x={xOf(data.length - 1) + 7} y={yOf(data[data.length - 1].y) + 4} className="chart-label">
          {data[data.length - 1].y}
        </text>
      )}
      {data.length <= 12 &&
        data.map((d, i) => (
          <text key={i} x={xOf(i)} y={H - 7} textAnchor="middle" className="chart-axis">{d.x}</text>
        ))}
      <line x1={PL} x2={W - 16} y1={yOf(Math.max(min, 0))} y2={yOf(Math.max(min, 0))} stroke="var(--text-faint)" strokeWidth={1} />
    </svg>
  );
}

function DashView(props: { text: string }) {
  let dash: { title?: string; widgets?: Record<string, unknown>[] };
  try {
    dash = JSON.parse(props.text);
  } catch {
    return <div className="empty">This dashboard isn't valid JSON yet — switch to Edit to fix it.</div>;
  }
  const widgets = (dash.widgets ?? []) as {
    type?: string; label?: string; value?: string | number; sub?: string;
    data?: { x: string | number; y: number }[]; headers?: string[]; rows?: (string | number)[][];
  }[];
  const stats = widgets.filter((w) => w.type === "stat");
  return (
    <div className="dash">
      <h2 className="dash-title">{dash.title}</h2>
      {stats.length > 0 && (
        <div className="dash-stats">
          {stats.map((s, i) => (
            <div className="dash-stat" key={i}>
              <div className="dash-stat-label">{s.label}</div>
              <div className="dash-stat-value">{String(s.value ?? "")}</div>
              {s.sub && <div className="dash-stat-sub">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}
      {widgets.filter((w) => w.type !== "stat").map((w, i) => (
        <div className="dash-card" key={i}>
          <div className="dash-card-title">{w.label}</div>
          {w.type === "bar" && <BarChart data={chartPoints(w)} />}
          {w.type === "line" && <LineChart data={chartPoints(w)} />}
          {w.type === "table" && (
            <div className="csv-wrap">
              <table className="csv-table">
                <tbody>
                  <tr>{(w.headers ?? []).map((h, hi) => <th key={hi}>{h}</th>)}</tr>
                  {(w.rows ?? []).map((r, ri) => (
                    <tr key={ri}>{r.map((c, ci) => <td key={ci}>{String(c)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FilesView(props: {
  notify: (t: string, e?: boolean) => void;
  focus?: string | null;
  onFocusConsumed?: () => void;
}) {
  const { notify } = props;
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [selName, setSelName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(() => {
    invoke<SharedFile[]>("list_shared_files").then(setFiles).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [refresh]);

  useEffect(() => {
    if (props.focus) {
      openFile(props.focus);
      props.onFocusConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus]);

  const openFile = async (name: string) => {
    if (dirty) {
      notify("Unsaved changes — Save or Discard first", true);
      return;
    }
    try {
      const text = await invoke<string>("read_shared_file", { name });
      setSelName(name);
      setContent(text);
      setEditing(false);
      setDirty(false);
    } catch (e) {
      notify(String(e), true);
    }
  };

  const save = async () => {
    if (!selName) return;
    try {
      await invoke("write_shared_file", { name: selName, content });
      setDirty(false);
      refresh();
      notify("Saved");
    } catch (e) {
      notify(String(e), true);
    }
  };

  const createFile = async (tpl: (typeof NEW_FILE_TEMPLATES)[number]) => {
    let name = tpl.name;
    let n = 2;
    while (files.some((f) => f.name === name)) {
      const dot = tpl.name.indexOf(".");
      name = `${tpl.name.slice(0, dot)} ${n}${tpl.name.slice(dot)}`;
      n++;
    }
    try {
      await invoke("write_shared_file", { name, content: tpl.content });
      refresh();
      setSelName(name);
      setContent(tpl.content);
      setEditing(false);
      setDirty(false);
    } catch (e) {
      notify(String(e), true);
    }
  };

  const exportFile = async (format: string) => {
    if (!selName) return;
    try {
      const out = await invoke<string>("export_shared_file", { name: selName, format });
      refresh();
      notify(`Exported as ${out}`);
      invoke("reveal_shared", { name: out }).catch(() => {});
    } catch (e) {
      notify(String(e), true);
    }
  };

  const removeFile = async () => {
    if (!selName) return;
    try {
      await invoke("delete_shared_file", { name: selName });
      setSelName(null);
      setContent("");
      setDirty(false);
      refresh();
    } catch (e) {
      notify(String(e), true);
    }
  };

  const kind = selName ? fileKind(selName) : "other";
  const meta = KIND_META[kind];

  return (
    <>
      <div className="main-header">
        <div>
          <div className="main-title">Files</div>
          <div className="main-sub">The team's shared folder — agents create and collaborate on these; ask any agent for a document, deck, sheet or dashboard</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => invoke("reveal_shared", { name: null }).catch(() => {})}>
          Open in Finder
        </button>
      </div>
      <div className="main-body lib-body">
        <div className="lib-nav">
          <div className="section-label"><span>New</span></div>
          <div className="file-new-row">
            {NEW_FILE_TEMPLATES.map((t) => (
              <button key={t.kind} className="file-new" title={`New ${KIND_META[t.kind].label}`} onClick={() => createFile(t)}>
                {KIND_META[t.kind].icon}<span>{KIND_META[t.kind].label}</span>
              </button>
            ))}
          </div>
          <div className="section-label"><span>Shared files</span><span>{files.length}</span></div>
          {files.length === 0 && (
            <div className="lib-empty">
              Nothing yet. Try dispatching: “Create a one-page overview of our services as Shared/Overview.md”.
            </div>
          )}
          {files.map((f) => (
            <button
              key={f.name}
              className={`lib-item ${selName === f.name ? "active" : ""}`}
              onClick={() => openFile(f.name)}
            >
              <span className="lib-item-title">{KIND_META[fileKind(f.name)].icon} {f.name}</span>
              <span className="lib-item-sub">{KIND_META[fileKind(f.name)].label} · {timeAgo(f.modified)}</span>
            </button>
          ))}
        </div>

        <div className="lib-editor">
          {!selName ? (
            <div className="empty">
              Select a file, create one, or ask an agent to produce one.<br />
              Documents (.md), spreadsheets (.csv), presentations (.slides.json) and dashboards
              (.dash.json) all render right here and export with one click.
            </div>
          ) : (
            <>
              <div className="file-head">
                <span className="file-name">{meta.icon} {selName}</span>
                <div className="spacer" />
                <button className={`btn ghost sm ${!editing ? "seg-active" : ""}`} onClick={() => setEditing(false)}>View</button>
                <button className={`btn ghost sm ${editing ? "seg-active" : ""}`} onClick={() => setEditing(true)}>Edit</button>
                {meta.exports.map((ex) => (
                  <button key={ex.format} className="btn ghost sm" onClick={() => exportFile(ex.format)}>
                    ↧ {ex.label}
                  </button>
                ))}
                <ArmButton label="Delete" armedLabel="Really?" onConfirm={removeFile} />
              </div>
              {editing ? (
                <textarea
                  className="lib-content"
                  value={content}
                  onChange={(e) => { setContent(e.target.value); setDirty(true); }}
                />
              ) : (
                <div className="file-render">
                  {kind === "document" && <MarkdownView text={content} />}
                  {kind === "spreadsheet" && <CsvView text={content} />}
                  {kind === "presentation" && <SlidesView text={content} />}
                  {kind === "dashboard" && <DashView text={content} />}
                  {kind === "other" && <pre className="file-raw">{content}</pre>}
                </div>
              )}
              <div className="lib-actions">
                <div className="spacer" />
                {dirty && <span className="lib-dirty">unsaved changes</span>}
                <button className="btn sm" disabled={!dirty} onClick={save}>Save</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ---------------- Library ---------------- */

type LibSel =
  | { type: "doc"; id: string }
  | { type: "new"; kind: "business" | "process" }
  | { type: "mem"; key: string }; // "shared" or an agent id

function LibraryView(props: { snap: Snapshot; notify: (t: string, e?: boolean) => void }) {
  const { snap, notify } = props;
  const [sel, setSel] = useState<LibSel | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);

  const business = snap.docs.filter((d) => d.kind === "business");
  const processes = snap.docs.filter((d) => d.kind === "process");
  const selDoc: Doc | undefined =
    sel?.type === "doc" ? snap.docs.find((d) => d.id === sel.id) : undefined;

  // Load the editor when the selection changes (but never clobber unsaved typing).
  useEffect(() => {
    if (dirty) return;
    if (sel?.type === "doc" && selDoc) {
      setTitle(selDoc.title);
      setContent(selDoc.content);
    } else if (sel?.type === "new") {
      const firstProfile = sel.kind === "business" && !snap.docs.some((d) => d.title.toLowerCase() === "business profile");
      setTitle(firstProfile ? "Business Profile" : "");
      setContent(firstProfile ? BUSINESS_PROFILE_SKELETON : "");
    } else if (sel?.type === "mem") {
      setTitle("");
      setContent(sel.key === "shared" ? snap.memory.shared : snap.memory.agents[sel.key] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.type, sel?.type === "doc" ? sel.id : sel?.type === "mem" ? sel.key : "", selDoc?.updated_at]);

  const select = (next: LibSel) => {
    if (dirty) {
      notify("Unsaved changes — Save or Discard first", true);
      return;
    }
    setSel(next);
  };

  const save = async () => {
    try {
      if (sel?.type === "mem") {
        await invoke("set_memory", { key: sel.key, content });
        notify("Memory saved");
      } else if (sel?.type === "new") {
        await invoke("save_doc", { title, kind: sel.kind, content });
        notify("Saved to the library");
        setSel(null);
      } else if (sel?.type === "doc" && selDoc) {
        if (title.trim() !== selDoc.title) {
          await invoke("rename_doc", { id: selDoc.id, title });
        }
        await invoke("save_doc", { title, kind: selDoc.kind, content });
        notify("Saved");
      }
      setDirty(false);
    } catch (e) {
      notify(String(e), true);
    }
  };

  const removeDoc = async () => {
    if (sel?.type !== "doc" || !selDoc) return;
    try {
      await invoke("delete_doc", { id: selDoc.id });
      setDirty(false);
      setSel(null);
    } catch (e) {
      notify(String(e), true);
    }
  };

  const docItem = (d: Doc) => (
    <button
      key={d.id}
      className={`lib-item ${sel?.type === "doc" && sel.id === d.id ? "active" : ""}`}
      onClick={() => select({ type: "doc", id: d.id })}
    >
      <span className="lib-item-title">{d.title}</span>
      <span className="lib-item-sub">by {d.updated_by || "user"} · {timeAgo(d.updated_at)}</span>
    </button>
  );

  return (
    <>
      <div className="main-header">
        <div>
          <div className="main-title">Library</div>
          <div className="main-sub">Business knowledge, documented processes, and agent memory — injected into every agent's context</div>
        </div>
      </div>
      <div className="main-body lib-body">
        <div className="lib-nav">
          <div className="section-label"><span>Business Info</span>
            <button className="lib-add" title="Add business info" onClick={() => select({ type: "new", kind: "business" })}>+</button>
          </div>
          {business.length === 0 && <div className="lib-empty">Add your business profile so agents answer in your voice.</div>}
          {business.map(docItem)}

          <div className="section-label"><span>Processes</span>
            <button className="lib-add" title="Add process" onClick={() => select({ type: "new", kind: "process" })}>+</button>
          </div>
          {processes.length === 0 && <div className="lib-empty">Agents document repeatable workflows here (or add your own).</div>}
          {processes.map(docItem)}

          <div className="section-label"><span>Memory</span></div>
          <button
            className={`lib-item ${sel?.type === "mem" && sel.key === "shared" ? "active" : ""}`}
            onClick={() => select({ type: "mem", key: "shared" })}
          >
            <span className="lib-item-title">🧠 Shared team memory</span>
            <span className="lib-item-sub">{snap.memory.shared ? `${snap.memory.shared.length} chars` : "empty"}</span>
          </button>
          {snap.agents.map((a) => (
            <button
              key={a.id}
              className={`lib-item ${sel?.type === "mem" && sel.key === a.id ? "active" : ""}`}
              onClick={() => select({ type: "mem", key: a.id })}
            >
              <span className="lib-item-title">
                <i className="agent-dot" style={{ background: a.color, display: "inline-block", marginRight: 6 }} />
                {a.name}'s memory
              </span>
              <span className="lib-item-sub">{snap.memory.agents[a.id] ? `${snap.memory.agents[a.id].length} chars` : "empty"}</span>
            </button>
          ))}
        </div>

        <div className="lib-editor">
          {!sel ? (
            <div className="empty">
              Select a doc or memory to view and edit it.<br />
              Everything here is shared with your agents: the <b>Business Profile</b> guides every
              response, processes make work repeatable, and memories persist what agents learn.
            </div>
          ) : (
            <>
              {sel.type !== "mem" ? (
                <input
                  className="lib-title"
                  type="text"
                  placeholder="Title…"
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                />
              ) : (
                <div className="lib-title-static">
                  {sel.key === "shared"
                    ? "Shared team memory — facts every agent sees"
                    : `${snap.agents.find((a) => a.id === sel.key)?.name ?? "Agent"}'s private memory`}
                </div>
              )}
              <textarea
                className="lib-content"
                placeholder={sel.type === "mem" ? "Durable facts, preferences, lessons learned…" : "Write in plain text or markdown…"}
                value={content}
                onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              />
              <div className="lib-actions">
                {sel.type === "doc" && (
                  <ArmButton label="Delete" armedLabel="Really delete?" onConfirm={removeDoc} />
                )}
                <div className="spacer" />
                {dirty && <span className="lib-dirty">unsaved changes</span>}
                {dirty && (
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      setDirty(false);
                      if (sel.type === "doc" && selDoc) {
                        setTitle(selDoc.title);
                        setContent(selDoc.content);
                      } else if (sel.type === "mem") {
                        setContent(sel.key === "shared" ? snap.memory.shared : snap.memory.agents[sel.key] ?? "");
                      } else {
                        setSel(null);
                      }
                    }}
                  >
                    Discard
                  </button>
                )}
                <button className="btn sm" disabled={!dirty || (sel.type !== "mem" && !title.trim())} onClick={save}>
                  Save
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function templateDefaultChecked(t: TeamTemplate, taken: Set<string>): Set<string> {
  if (t.defaultChecked === false) return new Set();
  return new Set(t.agents.filter((a) => !taken.has(a.name.toLowerCase())).map((a) => a.name));
}

function TemplateModal(props: {
  existing: Agent[];
  avail: Availability;
  onRecheck: () => void;
  onConcierge: () => void;
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const { existing, avail, notify } = props;
  const [tplKey, setTplKey] = useState(TEMPLATES[0].key);
  const tpl: TeamTemplate = TEMPLATES.find((t) => t.key === tplKey)!;
  const existingNames = useMemo(
    () => new Set(existing.map((a) => a.name.toLowerCase())),
    [existing],
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => templateDefaultChecked(TEMPLATES[0], new Set(existing.map((a) => a.name.toLowerCase()))),
  );
  const [backend, setBackend] = useState<BackendKind>(() => firstAvailableBackend(avail));
  const [model, setModel] = useState(localModelsFor(firstAvailableBackend(avail), avail)?.[0] ?? "");
  const [creating, setCreating] = useState(false);
  const localModels = localModelsFor(backend, avail);

  useEffect(() => {
    const models = localModelsFor(backend, avail);
    if (models && models.length > 0 && !models.includes(model)) {
      setModel(models[0]);
    }
  }, [backend, avail, model]);

  const pickTemplate = (key: string) => {
    setTplKey(key);
    const t = TEMPLATES.find((x) => x.key === key)!;
    setChecked(templateDefaultChecked(t, existingNames));
  };

  const slots = MAX_AGENTS - existing.length;
  const selectable = tpl.agents.filter((a) => !existingNames.has(a.name.toLowerCase()));
  const selectedCount = selectable.filter((a) => checked.has(a.name)).length;
  const overCap = selectedCount > slots;

  const create = async () => {
    setCreating(true);
    let created = 0;
    let firstError = "";
    for (const a of selectable) {
      if (!checked.has(a.name)) continue;
      try {
        await invoke("create_agent", {
          input: {
            name: a.name,
            role: a.role,
            skills: a.skills,
            backend,
            model: localModels ? model : "",
            permission: "sandboxed" as Permission,
            color: a.color,
          },
        });
        created++;
      } catch (e) {
        if (!firstError) firstError = String(e);
      }
    }
    setCreating(false);
    if (created > 0) {
      notify(`${created} agent${created > 1 ? "s" : ""} joined the team${firstError ? ` (some failed: ${firstError})` : ""}`, false);
      props.onClose();
    } else {
      notify(firstError || "nothing selected", true);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal">
        <h2>Quick Start Team</h2>
        <div className="field">
          <div className="radio-row">
            {TEMPLATES.map((t) => (
              <button key={t.key} className={`radio-card ${tplKey === t.key ? "selected" : ""}`} onClick={() => pickTemplate(t.key)}>
                <div className="rc-title">{t.key === "business" ? "🏢" : "💻"} {t.label}</div>
                <div className="rc-sub">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Team members — uncheck any you don't need (editable later)</label>
          <div className="tpl-list">
            {tpl.agents.map((a) => {
              const taken = existingNames.has(a.name.toLowerCase());
              return (
                <label key={a.name} className={`tpl-agent ${taken ? "taken" : ""}`}>
                  <input
                    type="checkbox"
                    disabled={taken}
                    checked={!taken && checked.has(a.name)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(a.name); else next.delete(a.name);
                      setChecked(next);
                    }}
                  />
                  <span className="agent-dot" style={{ background: a.color }} />
                  <span style={{ minWidth: 0 }}>
                    <div className="agent-item-name">{a.name} <span className="tpl-role">— {a.role}{taken ? " (already on team)" : ""}</span></div>
                    <div className="tpl-skills">{a.skills}</div>
                  </span>
                </label>
              );
            })}
          </div>
          {overCap && (
            <div className="hint" style={{ color: "var(--red)" }}>
              Only {slots} agent slot{slots === 1 ? "" : "s"} left (12 max) — uncheck {selectedCount - slots}.
            </div>
          )}
        </div>
        <div className="field">
          <label>Backend for the whole team (changeable per agent later)</label>
          <div className="radio-row">
            {BACKENDS.map((b) => (
              <button key={b} className={`radio-card ${backend === b ? "selected" : ""}`} onClick={() => setBackend(b)}>
                <div className="rc-title"><i className={avail[b] ? "dot-up" : "dot-down"} /> {BACKEND_LABEL[b]}</div>
                <div className="rc-sub">{BACKEND_SUB[b]}{!avail[b] && " — not set up"}</div>
              </button>
            ))}
          </div>
        </div>
        {!avail[backend] && <SetupGuide backend={backend} avail={avail} onRecheck={props.onRecheck} />}
        {localModels && localModels.length > 0 && (
          <div className="field">
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {localModels.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
        <div className="hint" style={{ marginBottom: 6 }}>
          All agents start sandboxed. Edit any agent afterwards to tweak name, skills, backend or permissions.
          Prefer a guided setup? <button className="linkish" onClick={props.onConcierge}>Let the Concierge interview you</button>.
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn" disabled={creating || selectedCount === 0 || overCap} onClick={create}>
            {creating ? "Creating…" : `Create ${selectedCount} Agent${selectedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AgentModal(props: {
  agent: Agent | null;
  avail: Availability;
  onRecheck: () => void;
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const { agent, avail, notify } = props;
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [skills, setSkills] = useState(agent?.skills ?? "");
  const [backend, setBackend] = useState<BackendKind>(agent?.backend ?? firstAvailableBackend(avail));
  const [model, setModel] = useState(agent?.model ?? "");
  const [permission, setPermission] = useState<Permission>(agent?.permission ?? "sandboxed");
  const [color, setColor] = useState(agent?.color ?? AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]);
  const [saving, setSaving] = useState(false);
  const localModels = localModelsFor(backend, avail);

  useEffect(() => {
    const models = localModelsFor(backend, avail);
    if (models && !model && models.length > 0) {
      setModel(models[0]);
    }
  }, [backend, model, avail]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        name, role, skills, backend,
        model: backend === "codex" || backend === "builtin" ? "" : model,
        permission, color,
      };
      if (agent) {
        await invoke("update_agent", { agent: { ...agent, ...payload } });
        notify(`${name} updated`);
      } else {
        await invoke("create_agent", { input: payload });
        notify(`${name} joined the team`);
      }
      props.onClose();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal">
        <h2>{agent ? `Edit ${agent.name}` : "New Agent"}</h2>
        {!agent && (
          <div className="field">
            <label>Start from a template (optional — everything stays editable)</label>
            <select
              defaultValue=""
              onChange={(e) => {
                const [gi, ai] = e.target.value.split(":").map(Number);
                const tpl = agentTemplateGroups()[gi]?.agents[ai];
                if (tpl) {
                  setName(tpl.name);
                  setRole(tpl.role);
                  setSkills(tpl.skills);
                  setColor(tpl.color);
                }
              }}
            >
              <option value="">Custom (blank)</option>
              {agentTemplateGroups().map((g, gi) => (
                <optgroup key={g.label} label={g.label}>
                  {g.agents.map((a, ai) => (
                    <option key={a.name + gi} value={`${gi}:${ai}`}>{a.name} — {a.role}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>Name</label>
          <input type="text" value={name} placeholder="e.g. Piper" onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Role</label>
          <input type="text" value={role} placeholder="e.g. Marketing Manager" onChange={(e) => setRole(e.target.value)} />
        </div>
        <div className="field">
          <label>Skills & responsibilities</label>
          <textarea
            value={skills}
            placeholder="What is this agent good at? Used to route broadcast tasks to the best fit — be specific. e.g. social campaigns, brand copy, competitor research, email newsletters"
            onChange={(e) => setSkills(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Backend</label>
          <div className="radio-row">
            {BACKENDS.map((b) => (
              <button key={b} className={`radio-card ${backend === b ? "selected" : ""}`} onClick={() => setBackend(b)}>
                <div className="rc-title"><i className={avail[b] ? "dot-up" : "dot-down"} /> {BACKEND_LABEL[b]}</div>
                <div className="rc-sub">{BACKEND_SUB[b]}{!avail[b] && " — not set up"}</div>
              </button>
            ))}
          </div>
        </div>
        {!avail[backend] && <SetupGuide backend={backend} avail={avail} onRecheck={props.onRecheck} />}
        {localModels && (
          <div className="field">
            <label>Model</label>
            {localModels.length > 0 ? (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {localModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input type="text" value={model} placeholder="e.g. qwen3:8b (server not detected)" onChange={(e) => setModel(e.target.value)} />
            )}
            <div className="hint">Pick a model that supports tool calling (qwen3, llama3.1+, mistral-nemo…).</div>
          </div>
        )}
        {backend === "claude" && (
          <div className="field">
            <label>Model (optional)</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
              <option value="haiku">haiku</option>
            </select>
          </div>
        )}
        <div className="field">
          <label>Permissions</label>
          <div className="radio-row">
            <button className={`radio-card ${permission === "sandboxed" ? "selected" : ""}`} onClick={() => setPermission("sandboxed")}>
              <div className="rc-title">🔒 Sandboxed</div>
              <div className="rc-sub">Files only in its own workspace folder; web access allowed</div>
            </button>
            <button className={`radio-card ${permission === "full" ? "selected" : ""}`} onClick={() => setPermission("full")}>
              <div className="rc-title">⚡ Full access</div>
              <div className="rc-sub">Can run any command and touch any file on this Mac</div>
            </button>
          </div>
        </div>
        <div className="field">
          <label>Color</label>
          <div className="swatches">
            {AGENT_COLORS.map((c) => (
              <button key={c} className={`swatch ${color === c ? "selected" : ""}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn" disabled={!name.trim() || !role.trim() || saving} onClick={save}>
            {agent ? "Save" : "Create Agent"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function licenseSummary(lic: LicenseStatus): string {
  switch (lic.state) {
    case "licensed":
      return `✓ Licensed (${lic.plan}) to ${lic.customer} — renews/expires ${new Date(lic.expires_at).toLocaleDateString()}`;
    case "grace":
      return `⚠ Subscription lapsed — grace period, ${lic.days_left} day${lic.days_left === 1 ? "" : "s"} left`;
    case "expired":
      return "✕ Subscription expired — agents are paused";
    case "trial_expired":
      return "✕ Free trial ended — agents are paused";
    default:
      return `Free trial — ${lic.days_left} day${lic.days_left === 1 ? "" : "s"} remaining`;
  }
}

/** Retention screen shown before a cancellation goes through. */
function CancelSubscriptionModal(props: {
  onKeep: () => void;
  onCancelled: (accessUntil: number) => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirmCancel = async () => {
    setBusy(true);
    try {
      const accessUntil = await invoke<number>("cancel_subscription");
      props.onCancelled(accessUntil);
    } catch (e) {
      props.notify(String(e), true);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onKeep(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <h2>Before you go…</h2>
        <p style={{ marginTop: 6 }}>Cancelling stops the renewal. Here is what that means:</p>
        <ul style={{ lineHeight: 1.9, paddingLeft: 22, margin: "10px 0 14px" }}>
          <li>Your team keeps working until the end of the period you already paid for.</li>
          <li>After that, agents pause. <b>Nothing is deleted</b> — your files, Library, board, and agent memories stay on this Mac.</li>
          <li>Resubscribing later picks up right where you left off.</li>
        </ul>
        <p style={{ color: "var(--dim, #6B7280)", fontSize: 13.5 }}>
          If something isn't working or the price is the issue, tell us first — hello@qivreno.ai. We read everything and we can usually help.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <button className="btn danger sm" disabled={busy} onClick={confirmCancel}>
            {busy ? "Cancelling…" : "Cancel my renewal"}
          </button>
          <button className="btn" onClick={props.onKeep}>Keep my subscription</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal(props: {
  settings: Settings;
  license: LicenseStatus;
  avail: Availability;
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const [s, setS] = useState<Settings>({ ...props.settings });
  const [licKey, setLicKey] = useState(props.settings.license_key);
  const [licStatus, setLicStatus] = useState<LicenseStatus>(props.license);
  const [showTerms, setShowTerms] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelledUntil, setCancelledUntil] = useState(0);

  const applyLicense = async () => {
    try {
      const status = await invoke<LicenseStatus>("apply_license", { key: licKey });
      setLicStatus(status);
      props.notify(licKey.trim() ? "License applied" : "License cleared");
    } catch (e) {
      props.notify(String(e), true);
    }
  };
  const save = async () => {
    try {
      await invoke("update_settings", { settings: s });
      props.notify("Settings saved");
      props.onClose();
    } catch (e) {
      props.notify(String(e), true);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal">
        <h2>Settings</h2>
        <div className="field license-field">
          <label>Subscription</label>
          <div className={`license-status ${licStatus.active ? "ok" : "bad"}`}>{licenseSummary(licStatus)}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              type="text"
              style={{ flex: 1 }}
              placeholder="Activation code (QIVACT-…) or license key (QIV-…)"
              value={licKey}
              onChange={(e) => setLicKey(e.target.value)}
            />
            <button className="btn sm" onClick={applyLicense}>Apply</button>
          </div>
          <div className="hint">
            {props.settings.license_refresh_token
              ? cancelledUntil > 0
                ? `Renewal cancelled — access continues until ${new Date(cancelledUntil).toLocaleDateString()}.`
                : "Activated on this Mac — your license renews automatically in the background."
              : "Paste the activation code from your purchase email (it activates this Mac and renews automatically), or a license key issued by 272 Solutions."}
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 8 }}>
            {!props.settings.license_refresh_token && licStatus.state !== "licensed" && (
              <button className="btn sm" onClick={() => openUrl("https://qivreno.ai/pricing")}>
                Subscribe at qivreno.ai
              </button>
            )}
            {props.settings.license_refresh_token && cancelledUntil === 0 && (
              <button
                className="btn link sm"
                style={{ background: "none", border: "none", color: "var(--dim, #6B7280)", textDecoration: "underline", cursor: "pointer", padding: 0 }}
                onClick={() => setShowCancel(true)}
              >
                Cancel subscription…
              </button>
            )}
          </div>
        </div>
        {showCancel && (
          <CancelSubscriptionModal
            onKeep={() => setShowCancel(false)}
            onCancelled={(until) => {
              setShowCancel(false);
              setCancelledUntil(until || 1);
              props.notify(
                until > 0
                  ? `Renewal cancelled — your team keeps working until ${new Date(until).toLocaleDateString()}.`
                  : "Renewal cancelled.",
              );
            }}
            notify={props.notify}
          />
        )}
        <div className="field">
          <label>Claude CLI path {props.avail.claude ? "· detected ✓" : "· not found"}</label>
          <input type="text" value={s.claude_path} placeholder="auto-detected if installed" onChange={(e) => setS({ ...s, claude_path: e.target.value })} />
        </div>
        <div className="field">
          <label>Codex CLI path {props.avail.codex ? "· detected ✓" : "· not found"}</label>
          <input type="text" value={s.codex_path} placeholder="npm i -g @openai/codex" onChange={(e) => setS({ ...s, codex_path: e.target.value })} />
        </div>
        <div className="field">
          <label>Ollama URL {props.avail.ollama ? "· connected ✓" : "· not running"}</label>
          <input type="text" value={s.ollama_url} onChange={(e) => setS({ ...s, ollama_url: e.target.value })} />
        </div>
        <div className="field">
          <label>LM Studio / OpenAI-compatible server URL {props.avail.lmstudio ? "· connected ✓" : "· not running"}</label>
          <input type="text" value={s.lmstudio_url} placeholder="http://localhost:1234/v1" onChange={(e) => setS({ ...s, lmstudio_url: e.target.value })} />
          <div className="hint">Works with LM Studio, LocalAI, llama.cpp server, or any other OpenAI-compatible endpoint.</div>
        </div>
        <div className="field">
          <label>Routing model (picks the best-fit agent for broadcast tasks)</label>
          {props.avail.ollama_models.length > 0 ? (
            <select value={s.router_model} onChange={(e) => setS({ ...s, router_model: e.target.value })}>
              <option value="">Auto (first available)</option>
              {props.avail.ollama_models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input type="text" value={s.router_model} onChange={(e) => setS({ ...s, router_model: e.target.value })} />
          )}
        </div>
        <div className="field">
          <label>Deck branding (PowerPoint / PDF presentation exports)</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="color-pick">
              Accent
              <input
                type="color"
                value={s.brand_accent || "#2563FF"}
                onChange={(e) => setS({ ...s, brand_accent: e.target.value })}
              />
            </label>
            <label className="color-pick">
              Text
              <input
                type="color"
                value={s.brand_text || "#0B1220"}
                onChange={(e) => setS({ ...s, brand_text: e.target.value })}
              />
            </label>
            <label className="btn ghost sm" style={{ cursor: "pointer" }}>
              Import customer template…
              <input
                type="file"
                accept=".pptx,.potx"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const buf = new Uint8Array(await file.arrayBuffer());
                    let bin = "";
                    for (let i = 0; i < buf.length; i += 0x8000) {
                      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
                    }
                    const res = await invoke<{ accent: string; text: string }>("import_brand_template", {
                      dataB64: btoa(bin),
                    });
                    setS({ ...s, brand_accent: res.accent, brand_text: res.text });
                    props.notify(`Brand imported: accent ${res.accent}`);
                  } catch (err) {
                    props.notify(String(err), true);
                  }
                  e.target.value = "";
                }}
              />
            </label>
            {(s.brand_accent || s.brand_text) && (
              <button className="btn ghost sm" onClick={() => setS({ ...s, brand_accent: "", brand_text: "" })}>
                Reset to Qivreno
              </button>
            )}
          </div>
          <div className="hint">
            Decks export with Qivreno Blue by default. Import a customer's PowerPoint template
            (.pptx/.potx) to pull their theme colors, or pick them manually — their brand then
            applies to every presentation export.
          </div>
        </div>
        <div className="field">
          <label>Agent-to-agent conversation limit (hops)</label>
          <input
            type="number" min={1} max={20} value={s.max_hops}
            onChange={(e) => setS({ ...s, max_hops: Math.max(1, Number(e.target.value) || 6) })}
          />
          <div className="hint">Stops two agents from talking to each other forever. After this many back-and-forths, messages are delivered but no longer auto-answered.</div>
        </div>
        <div className="hint" style={{ marginBottom: 4 }}>
          <button className="linkish" onClick={() => setShowTerms(true)}>View Terms &amp; Conditions</button>
          {props.settings.terms_accepted_at > 0 &&
            ` — accepted ${new Date(props.settings.terms_accepted_at).toLocaleDateString()} (v${props.settings.terms_accepted_version})`}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn" onClick={save}>Save</button>
        </div>
      </div>
      {showTerms && <TermsModal viewOnly onClose={() => setShowTerms(false)} notify={props.notify} />}
    </div>
  );
}

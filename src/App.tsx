import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  Agent, AGENT_COLORS, agentTemplateGroups, Availability, BackendKind,
  BuiltinStatus, BUSINESS_PROFILE_SKELETON, Column, CONCIERGE, ConnectedFolder,
  displayName, Doc, fileKind, Permission, Settings,
  MICRO_ACTIONS, SharedFile, skillsSummary, Snapshot, Task, TeamTemplate, TEMPLATES,
} from "./types";
import { TERMS_MD, TERMS_VERSION } from "./terms";
import { Icon, IconName } from "./Icon";

/* Platform-aware UI strings: the same build runs on macOS and Windows. */
const IS_MAC = navigator.userAgent.includes("Mac");
const MOD_ENTER = IS_MAC ? "\u2318\u21B5" : "Ctrl+\u21B5";
const MACHINE = IS_MAC ? "Mac" : "computer";
const REVEAL_LABEL = IS_MAC ? "Open in Finder" : "Show in Explorer";
import "./App.css";

type View =
  | { kind: "board" }
  | { kind: "activity" }
  | { kind: "chatroom" }
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
    claude_path: "", codex_path: "", gemini_api_key: "", grok_api_key: "", ollama_url: "", lmstudio_url: "",
    bus_port: 0, max_hops: 6, router_model: "", builtin_enabled: false,
    builtin_port: 0, backend_advice_shown: true, brand_accent: "", brand_text: "",
    terms_accepted_version: 999, terms_accepted_at: 0,
    qivvy_seeded: false,
    mail_enabled: false, mail_host: "", mail_port: 993, mail_user: "", mail_password: "", mail_allowlist: "",
    telegram_enabled: false, telegram_token: "", telegram_chat_id: 0, telegram_pair_code: "",
    connected_folders: [], micro_enabled: false, micro_bindings: [],
  },
};

const NO_AVAIL: Availability = {
  builtin: false, ollama: false, ollama_models: [], lmstudio: false, lmstudio_models: [], claude: false, codex: false,
  gemini: false, grok: false,
};

const BACKENDS: BackendKind[] = ["builtin", "ollama", "lmstudio", "claude", "codex", "gemini", "grok"];

const BACKEND_SUB: Record<BackendKind, string> = {
  builtin: `Free and private — limited by this ${MACHINE}'s power`,
  ollama: `Free and private — limited by this ${MACHINE}'s power`,
  lmstudio: `Free and private — limited by this ${MACHINE}'s power`,
  claude: "Recommended — strongest results, uses your Claude plan",
  codex: "Recommended — strongest results, uses your OpenAI plan",
  gemini: "Google API key (free tier)",
  grok: "xAI API key",
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
    intro: `Ollama runs open models entirely on this ${MACHINE} — private and free.`,
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
      "Inside LM Studio, use the search bar to download a model that supports tool use — e.g. Qwen3 8B.",
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
      "Qivreno auto-detects the CLI. If it isn't found, set the path manually in Settings.",
    ],
    url: "https://claude.com/product/claude-code",
    urlLabel: "Open claude.com/claude-code",
  },
  gemini: {
    title: "Set up Gemini",
    intro: "Agents call Google's Gemini models with your own API key, using Qivreno's native tools (board, files, calendar, everything). Google's free tier needs no card.",
    steps: [
      "Open Google AI Studio (link below) and click Create API key — a Google account is all you need.",
      "Paste the key into Settings → Gemini API key.",
      "Pick Gemini as the backend when creating or editing an agent (default model: gemini-2.5-flash; set another in the agent's model field).",
    ],
    url: "https://aistudio.google.com/apikey",
    urlLabel: "Open aistudio.google.com/apikey",
  },
  grok: {
    title: "Set up Grok",
    intro: "Agents call xAI's Grok models through your own API key. Unlike the CLIs, Grok uses Qivreno's native tools, so the full board/library/calendar toolset works.",
    steps: [
      "Create an xAI account and generate an API key at console.x.ai.",
      "Paste the key into Settings → Grok API key.",
      "Pick Grok as the backend when creating or editing an agent (default model: grok-4-fast; set another in the agent's model field).",
    ],
    url: "https://console.x.ai",
    urlLabel: "Open console.x.ai",
  },
  codex: {
    title: "Set up Codex",
    intro: "Agents drive OpenAI's Codex CLI using your own ChatGPT subscription (Plus or Pro).",
    steps: [
      "Install Node.js if you don't have it (nodejs.org), then in Terminal:  npm install -g @openai/codex",
      "Run  codex  once in Terminal and sign in with your ChatGPT account.",
      "Qivreno auto-detects the CLI. If it isn't found, set the path manually in Settings.",
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
  const pickModel = async (modelId: string) => {
    if (busy || st?.model_id === modelId) return;
    setBusy(true);
    try {
      await invoke("set_builtin_model", { modelId });
      props.onChanged();
    } catch { /* status poll shows the error */ }
    setBusy(false);
  };

  if (!st) return <div className="guide"><div className="guide-intro">Checking built-in AI…</div></div>;

  const modelPicker = !st.downloading && !st.starting && (
    <div className="radio-row" style={{ margin: "10px 0" }}>
      <button
        className={`radio-card ${st.model_id !== "qivreno-agent-4b" ? "selected" : ""}`}
        onClick={() => pickModel("")}
      >
        <div className="rc-title">Standard</div>
        <div className="rc-sub">Stock Qwen3, sized to this {MACHINE}</div>
      </button>
      <button
        className={`radio-card ${st.model_id === "qivreno-agent-4b" ? "selected" : ""}`}
        onClick={() => pickModel("qivreno-agent-4b")}
      >
        <div className="rc-title">Qivreno Tuned</div>
        <div className="rc-sub">Trained on agent work — better tool use, reports &amp; delegation</div>
      </button>
    </div>
  );

  return (
    <div className="guide">
      <div className="guide-title">Built-in AI</div>
      {st.running ? (
        <>
          <div className="guide-intro">
            ● Running — {st.model_name} entirely on this {MACHINE}. Agents on this backend need no other setup.
          </div>
          {modelPicker}
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
            picked for this {MACHINE}'s {st.ram_gb} GB RAM) and runs it with the bundled engine.
            Nothing you or your agents write ever leaves this {MACHINE}, and it keeps working without
            internet. Because it runs on this {MACHINE}, expect slower and simpler results than
            Claude or Codex — connect one of those if you want the strongest work from your agents.
          </div>
          {st.error && <div className="guide-intro" style={{ color: "var(--red)" }}>Last attempt failed: {st.error}</div>}
          {modelPicker}
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

const KEY_BACKENDS: Partial<Record<BackendKind, keyof Settings>> = {
  gemini: "gemini_api_key",
  grok: "grok_api_key",
};

function SetupGuide(props: {
  backend: BackendKind;
  avail: Availability;
  onRecheck: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  if (props.backend === "builtin") {
    return <BuiltinPanel onChanged={props.onRecheck} />;
  }
  const g = GUIDES[props.backend]!;
  const up = props.avail[props.backend];
  const keyField = KEY_BACKENDS[props.backend];
  const saveKey = async () => {
    if (!key.trim() || savingKey) return;
    setSavingKey(true);
    try {
      const snap = await invoke<Snapshot>("get_snapshot");
      await invoke("update_settings", { settings: { ...snap.settings, [keyField!]: key.trim() } });
      setKey("");
      props.onRecheck();
    } catch { /* status row reflects the result */ }
    setSavingKey(false);
  };
  return (
    <div className="guide">
      <div className="guide-title">{g.title}</div>
      <div className="guide-intro">{g.intro}</div>
      <ol className="guide-steps">
        {g.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {keyField && !up && (
        <div style={{ display: "flex", gap: 8, margin: "4px 0 10px" }}>
          <input
            type="password"
            style={{ flex: 1 }}
            placeholder="Paste your API key here"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveKey(); }}
          />
          <button className="btn sm" disabled={savingKey || !key.trim()} onClick={saveKey}>
            {savingKey ? "Saving…" : "Save key"}
          </button>
        </div>
      )}
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

function BackendPicker(props: {
  backend: BackendKind;
  avail: Availability;
  onPick: (b: BackendKind) => void;
}) {
  const groups: { label: string; items: BackendKind[] }[] = [
    { label: `Private — runs on this ${MACHINE}`, items: ["builtin", "ollama", "lmstudio"] },
    { label: "Cloud — your own account", items: ["claude", "codex", "gemini", "grok"] },
  ];
  return (
    <>
      {groups.map((g) => (
        <div key={g.label} style={{ marginBottom: 8 }}>
          <div className="hint" style={{ margin: "4px 0 6px" }}>{g.label}</div>
          <div className="radio-row">
            {g.items.map((b) => (
              <button key={b} className={`radio-card ${props.backend === b ? "selected" : ""}`} onClick={() => props.onPick(b)}>
                <div className="rc-title"><i className={props.avail[b] ? "dot-up" : "dot-down"} /> {BACKEND_LABEL[b]}</div>
                <div className="rc-sub">{BACKEND_SUB[b]}{!props.avail[b] && " — tap to set up"}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

const COLUMNS: { key: Column; label: string }[] = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "requires_input", label: "Requires Input" },
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
  gemini: "Gemini", grok: "Grok",
};
const BACKEND_DOT: Record<BackendKind, string> = {
  builtin: "AI", ollama: "Ollama", lmstudio: "LM", claude: "Claude", codex: "Codex", gemini: "Gemini", grok: "Grok",
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
  const [getStarted, setGetStarted] = useState<(typeof GET_STARTED)[number] | null>(null);
  const [showGetStarted, setShowGetStarted] = useState(false);
  const [filesFocus, setFilesFocus] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  // Applied by the effect below: "system" follows the OS, light/dark force it.
  // The toolbar cycling button was dropped in v1.4.8; the control now lives in
  // Settings > Appearance, which is where people look for it.
  const [theme, setTheme] = useState<"dark" | "light" | "system">(
    () => (localStorage.getItem("qiv_theme") as "dark" | "light" | "system") || "system",
  );

  // ⌘, opens Settings (macOS Preferences convention) — a reliable path
  // regardless of window chrome.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); setShowSettings(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Apply theme: system follows the OS; light/dark force it.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const light = theme === "light" || (theme === "system" && mq.matches);
      document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    };
    apply();
    localStorage.setItem("qiv_theme", theme);
    if (theme === "system") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

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

  // Macro-pad control surface: shortcut presses arrive from Rust as events.
  const snapRef = useRef<Snapshot | null>(null);
  useEffect(() => { snapRef.current = snap; }, [snap]);
  const [microOpenTask, setMicroOpenTask] = useState<string | null>(null);
  useEffect(() => {
    const unAction = listen<string>("micro-action", (e) => {
      const action = e.payload;
      const tasks = snapRef.current?.tasks ?? [];
      switch (action) {
        case "show_board": setView({ kind: "board" }); break;
        case "show_chat": setView({ kind: "chatroom" }); break;
        case "show_files": setView({ kind: "files" }); break;
        case "show_library": setView({ kind: "library" }); break;
        case "focus_composer":
          setView({ kind: "board" });
          setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 150);
          break;
        case "open_review": {
          const t = tasks
            .filter((t) => t.kind === "task" && t.column === "review" && t.status === "done")
            .sort((a, b) => b.updated_at - a.updated_at)[0];
          setView({ kind: "board" });
          if (t) setMicroOpenTask(t.id);
          break;
        }
        case "open_input_request": {
          const t = tasks
            .filter((t) => t.kind === "task" && t.column === "requires_input")
            .sort((a, b) => b.updated_at - a.updated_at)[0];
          setView({ kind: "board" });
          if (t) setMicroOpenTask(t.id);
          break;
        }
      }
    });
    const unToast = listen<string>("micro-toast", (e) => notify(e.payload));
    return () => { unAction.then((f) => f()); unToast.then((f) => f()); };
  }, [notify]);

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
      if (existing && existing.enabled === false) {
        await invoke("set_agent_enabled", { id: existing.id, enabled: true });
      }
      if (!id) {
        const backend = firstAvailableBackend(avail);
        const agent = await invoke<Agent>("create_agent", {
          input: {
            name: CONCIERGE.name,
            role: CONCIERGE.role,
            description: CONCIERGE.description,
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

  return (
    <div className="app-col">
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-lockup" src="/logo-white.png" alt="Qivreno — AI Workforce Platform" />
        </div>
        <button className={`nav-item ${view.kind === "board" ? "active" : ""}`} onClick={() => setView({ kind: "board" })}>
          <span className="icon"><Icon name="board" /></span> Board
        </button>
        <button className={`nav-item ${view.kind === "chatroom" ? "active" : ""}`} onClick={() => setView({ kind: "chatroom" })}>
          <span className="icon"><Icon name="chat" /></span> Team Chat
        </button>
        <button className={`nav-item ${view.kind === "activity" ? "active" : ""}`} onClick={() => setView({ kind: "activity" })}>
          <span className="icon"><Icon name="list" /></span> Activity
        </button>
        <button className={`nav-item ${view.kind === "library" ? "active" : ""}`} onClick={() => setView({ kind: "library" })}>
          <span className="icon"><Icon name="library" /></span> Library
        </button>
        <button className={`nav-item ${view.kind === "files" ? "active" : ""}`} onClick={() => setView({ kind: "files" })}>
          <span className="icon"><Icon name="doc" /></span> Files
        </button>
        <div className="section-label">
          <span>Agents</span>
          <span>{snap.agents.filter((a) => !a.system).length}</span>
        </div>
        <div className="agent-list">
          {[...snap.agents].sort((a, b) => Number(b.system) - Number(a.system)).map((a) => (
            <button
              key={a.id}
              className={`agent-item ${view.kind === "agent" && view.id === a.id ? "active" : ""}`}
              style={a.enabled === false ? { opacity: 0.45 } : undefined}
              title={a.description || undefined}
              onClick={() => setView({ kind: "agent", id: a.id })}
            >
              <span className={`agent-dot ${workingAgents.has(a.id) ? "working" : ""}`} style={{ background: a.color, color: a.color }} />
              <span style={{ minWidth: 0 }}>
                <div className="agent-item-name">{a.name}{a.system ? " ✦" : ""}</div>
                <div className="agent-item-role">{a.enabled === false ? "disabled" : a.role}</div>
              </span>
              {workingAgents.has(a.id) && <span className="agent-item-status">working</span>}
            </button>
          ))}
        </div>
        <button className="add-agent" onClick={() => setEditingAgent("new")}>
          + New Agent
        </button>
        <button className="add-agent quickstart" onClick={() => setShowTemplates(true)}>
          <Icon name="spark" /> Quick Start Team
        </button>
        <button className="add-agent getstarted" onClick={() => setShowGetStarted(true)}>
          <Icon name="rocket" /> Get Started
        </button>
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
        </div>
      </aside>

      <main className="main">
        <div className="app-toolbar">
          <button className="header-btn" title="Settings" onClick={() => setShowSettings(true)}>
            <Icon name="gear" /><span className="lbl">Settings</span>
          </button>
        </div>
        {view.kind === "board" && (
          <KanbanBoard
            snap={snap}
            agentById={agentById}
            notify={notify}
            onQuickStart={() => setShowTemplates(true)}
            onNewAgent={() => setEditingAgent("new")}
            onConcierge={startConcierge}
            onOpenFile={(name) => { setFilesFocus(name); setView({ kind: "files" }); }}
            openTaskId={microOpenTask}
            onOpenTaskConsumed={() => setMicroOpenTask(null)}
          />
        )}
        {view.kind === "activity" && <ActivityFeed snap={snap} nameOf={nameOf} colorOf={colorOf} />}
        {view.kind === "chatroom" && <ChatRoomView snap={snap} nameOf={nameOf} colorOf={colorOf} workingAgents={workingAgents} />}
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
      {showGetStarted && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowGetStarted(false); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <h2><Icon name="rocket" /> Get Started</h2>
            <p className="hint" style={{ margin: "8px 0 14px" }}>
              Pick a ready-made job and the team builds it for you — the finished document lands in Files.
            </p>
            <div className="gs-picker">
              {GET_STARTED.map((g) => (
                <button
                  key={g.label}
                  className="gs-pick"
                  onClick={() => { setShowGetStarted(false); setGetStarted(g); }}
                >
                  <span className="gs-pick-icon"><Icon name={g.icon} /></span>
                  <span className="gs-pick-text">
                    <span className="gs-pick-title">{g.label}</span>
                    <span className="gs-pick-desc">{g.desc}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowGetStarted(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {getStarted && (
        <GetStartedModal
          tpl={getStarted}
          hasAgents={snap.agents.length > 0}
          onQuickStart={() => { setGetStarted(null); setShowTemplates(true); }}
          onDispatched={() => { setGetStarted(null); setView({ kind: "board" }); }}
          onClose={() => setGetStarted(null)}
          notify={notify}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={snap.settings}
          avail={avail}
          theme={theme}
          onTheme={setTheme}
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

/* Get Started templates: one-click briefs that produce a defined deliverable
   in Shared/. Shown in the sidebar below Quick Start Team; the optional
   context field is folded into the dispatched prompt. */
const GET_STARTED: { icon: IconName; label: string; desc: string; hint: string; prompt: (ctx: string) => string }[] = [
  // Ordered by how commonly small businesses reach for AI (2025-26 NFIB /
  // QuickBooks / U.S. Chamber / Adobe surveys): marketing content first,
  // then customer communication, sales & admin drafting, research,
  // finances, getting paid, hiring, and process documentation.
  {
    icon: "megaphone",
    label: "Marketing Plan",
    desc: "A 30-day plan: audience, channel mix, week-by-week calendar, three sample posts, and success metrics.",
    hint: "What are you marketing? e.g. a bookkeeping service for restaurants",
    prompt: (ctx) =>
      `Create a 30-day marketing plan${ctx ? ` for: ${ctx}.` : ". Use our Business Profile in the Library; ask me anything essential that's missing."} ` +
      "Include the target audience, channel mix, a week-by-week content calendar, three sample posts in our voice, and how we'll measure success. " +
      "Deliver as Shared/Marketing Plan.md.",
  },
  {
    icon: "calendar",
    label: "Social Media Calendar",
    desc: "A month of ready-to-post content: date, platform, post copy, hashtags, and a visual idea for each.",
    hint: "Which platforms, and anything to promote this month? e.g. Instagram + Facebook, spring sale",
    prompt: (ctx) =>
      `Create one month of social media content${ctx ? ` — details: ${ctx}.` : ". Use our Business Profile in the Library for voice and audience; ask me anything essential that's missing."} ` +
      "Write every post in full, in our brand voice — a realistic mix of promotional, educational and personable posts, 3-4 per week. " +
      "Deliver as Shared/Social Media Calendar.csv with the header row: Date,Platform,Post,Hashtags,Visual idea.",
  },
  {
    icon: "envelope",
    label: "Marketing Emails",
    desc: "Turns your product info into a 3-email sequence: awareness, value, and call-to-action.",
    hint: "Paste product info here, or name a file you've dropped in Shared/",
    prompt: (ctx) =>
      "Review this product information and turn it into a 3-email marketing sequence — awareness, value, call-to-action — each with a subject line, preview text, and body copy. " +
      `Product info: ${ctx || "[none provided — read the newest product document in Shared/ and confirm with me before writing]"}. ` +
      "Deliver as Shared/Marketing Emails.md.",
  },
  {
    icon: "chat",
    label: "Customer Reply Templates",
    desc: "Ready-to-send replies for your most common customer questions, complaints, and requests — in your voice.",
    hint: "What do customers ask most? e.g. pricing, refunds, how long a job takes",
    prompt: (ctx) =>
      `Write a set of customer-service reply templates${ctx ? ` covering: ${ctx}.` : ". Base the topics on our Business Profile in the Library, and ask me for our most common customer questions if unclear."} ` +
      "Cover at least: a price/quote request, a scheduling request, a complaint, a refund request, a late-delivery apology, and a thank-you/review ask. " +
      "Each template: when to use it, the full reply, and the parts to personalize in [brackets]. Warm, professional, in our voice. " +
      "Deliver as Shared/Customer Reply Templates.md.",
  },
  {
    icon: "doc",
    label: "Sales Proposal",
    desc: "A polished, client-ready proposal: their need, your offer, pricing approach, timeline, and next steps.",
    hint: "Who's it for and what do they need? e.g. Acme Corp, monthly IT support for 20 staff",
    prompt: (ctx) =>
      `Create a client-ready sales proposal${ctx ? ` for: ${ctx}.` : ". Ask me who it's for and what they need before writing."} ` +
      "Include: a short summary of their situation and need, our proposed approach, scope and deliverables, pricing approach, timeline, why us, and clear next steps. " +
      "Deliver as a polished document named Shared/Sales Proposal - [client name].md.",
  },
  {
    icon: "search",
    label: "Competitor Research",
    desc: "A brief on your top competitors: offers, pricing, strengths, weaknesses, and how to win against them.",
    hint: "Name 2-4 competitors, or describe your market and area",
    prompt: (ctx) =>
      `Research my competitors${ctx ? `: ${ctx}.` : ". Use our Business Profile in the Library to identify the likely competitors, and confirm the list with me before going deep."} ` +
      "For each: what they offer, pricing (where findable), positioning, strengths, weaknesses, and reviews/reputation signals. " +
      "Finish with a comparison table and the three clearest opportunities for us to win. " +
      "Deliver as Shared/Competitor Research Brief.md.",
  },
  {
    icon: "chart",
    label: "Cash-Flow Forecast",
    desc: "A 12-week cash dashboard: money in, money out, projected balance, and the crunch points to watch.",
    hint: "Paste your numbers (cash on hand, expected income, regular bills), or name a file in Shared/",
    prompt: (ctx) =>
      `Build me a 12-week cash-flow forecast. ${ctx ? `The numbers: ${ctx}.` : "[No numbers provided — read the newest spreadsheet in Shared/, or ask me for cash on hand, expected money in, and regular outgoings.]"} ` +
      "State any assumptions you make. Build Shared/Cash-Flow Forecast.dash.json with stat widgets for cash on hand, expected in, expected out and lowest projected balance, " +
      "a weekly projected-balance line chart, and a table of the largest upcoming payments. Flag any week the balance goes uncomfortably low.",
  },
  {
    icon: "card",
    label: "Chase Overdue Invoices",
    desc: "A 3-step reminder sequence — friendly nudge, firm follow-up, final notice — ready to send.",
    hint: "Who owes what, and how late? e.g. Smith & Co, $2,400, 30 days overdue",
    prompt: (ctx) =>
      `Write a 3-step overdue invoice reminder sequence${ctx ? ` for: ${ctx}.` : " I can reuse for any late-paying customer."} ` +
      "Email 1: friendly nudge (assumes they forgot). Email 2: firm follow-up (references the first, asks for a payment date). Email 3: final notice (professional, states next steps). " +
      "Each with a subject line and body, personalization in [brackets], and a one-line tip on timing between sends. Firm but relationship-preserving. " +
      "Deliver as Shared/Invoice Reminder Sequence.md.",
  },
  {
    icon: "recruit",
    label: "Hiring Kit",
    desc: "Everything to hire a role: job description, where to post, screening questions, interview plan, scorecard.",
    hint: "What role? e.g. part-time bookkeeper, remote, $25/hr",
    prompt: (ctx) =>
      `Help me hire${ctx ? ` — the role: ${ctx}.` : ". Ask me what role I'm hiring for and any requirements before writing."} ` +
      "Produce a hiring kit: job description, where to post it, five screening questions, a structured interview plan with a scorecard, and a first-touch candidate outreach message. " +
      "Deliver as Shared/[Role] Hiring Kit.md.",
  },
  {
    icon: "book",
    label: "Document a Process",
    desc: "Turns how you do something into a numbered, repeatable process — saved to the Library so the whole team follows it.",
    hint: "Which process? e.g. how we onboard a new client",
    prompt: (ctx) =>
      `Document one of our processes as a clear, numbered, repeatable procedure anyone could follow${ctx ? ` — the process: ${ctx}.` : ". Ask me which process to document."} ` +
      "Interview me for the steps you can't infer (use request_input), don't invent details. " +
      "Save it to the Library as a process, and also deliver a copy as Shared/[Process Name] SOP.md.",
  },
];

/** One Get Started template → a dispatched task with the user's context folded in. */
function GetStartedModal(props: {
  tpl: (typeof GET_STARTED)[number];
  hasAgents: boolean;
  onQuickStart: () => void;
  onDispatched: () => void;
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const [ctx, setCtx] = useState("");
  const [busy, setBusy] = useState(false);
  const dispatch = async () => {
    setBusy(true);
    try {
      await invoke("create_task", { title: "", prompt: props.tpl.prompt(ctx.trim()), agentKey: null, draft: false });
      props.notify(`${props.tpl.label} dispatched — the deliverable will land in Files`);
      props.onDispatched();
    } catch (e) {
      props.notify(String(e), true);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <h2><Icon name={props.tpl.icon} /> {props.tpl.label}</h2>
        <p className="hint" style={{ margin: "8px 0 14px" }}>{props.tpl.desc}</p>
        <div className="field">
          <label>Your specifics (optional — the team asks if it needs more)</label>
          <textarea
            autoFocus
            rows={4}
            style={{ width: "100%", resize: "vertical" }}
            placeholder={props.tpl.hint}
            value={ctx}
            onChange={(e) => setCtx(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && props.hasAgents && !busy) dispatch();
            }}
          />
        </div>
        {!props.hasAgents && (
          <div className="hint" style={{ marginBottom: 10 }}>
            You need a team first — Quick Start sets one up in seconds.
          </div>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={props.onClose}>Cancel</button>
          {!props.hasAgents ? (
            <button className="btn" onClick={props.onQuickStart}><Icon name="spark" /> Quick Start Team</button>
          ) : (
            <button className="btn" disabled={busy} onClick={dispatch}>
              {busy ? "Dispatching…" : `Dispatch to team ${MOD_ENTER}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const OUTCOMES: { icon: IconName; label: string; prompt: string }[] = [
  { icon: "doc", label: "Create a sales proposal", prompt: "Create a sales proposal for [customer name]. What they need: [one sentence]. Include our relevant offerings, pricing approach, timeline, and next steps. Deliver it as a complete, client-ready proposal document in Shared/ — full prose I could send as-is, not an outline." },
  { icon: "search", label: "Research a prospect", prompt: "Research [company name] before my meeting on [date]. I need: company background, what they likely care about right now, talking points for us, and questions to ask. Deliver a one-page brief to Shared/." },
  { icon: "megaphone", label: "Develop a marketing plan", prompt: "Develop a 30-day marketing plan for [product/service]. Include the channel mix with budget/effort allocation, a week-by-week content calendar, three sample posts in our brand voice, and measurable targets with how we'll track them. Make it a complete plan I could hand to a new marketing hire — not an outline. Deliver to Shared/." },
  { icon: "deck", label: "Build a presentation", prompt: "Build a presentation about [topic] for [audience]. 10-12 substantive slides with speaker notes: the story, supporting numbers, and a clear ask at the end. Deliver as a deck in Shared/ so I can export it to PowerPoint." },
  { icon: "book", label: "Document a process", prompt: "Document how we [process, e.g. onboard a new client] as a numbered, repeatable process anyone on the team could follow. Ask me what you need to know, then save it to the Library." },
  { icon: "nodes", label: "Plan a project", prompt: "Plan the project: [what you want done]. Break it into workstreams with owners, sequence and dependencies, risks, and a timeline. If it spans several specialties, split it into subtasks for the team." },
  { icon: "chart", label: "Analyze a spreadsheet", prompt: "Analyze the spreadsheet [drop it in Shared/ first, then name it here]. I want the trends, anything unusual, and a short memo with the three decisions the numbers suggest. Deliver analysis and memo to Shared/." },
  { icon: "building", label: "Set up my back office", prompt: "Set up my business back office: interview me about the business, then produce our core operating documents (key policies, a client onboarding procedure, a job description template, and a simple KPI review)." },
];

function KanbanBoard(props: {
  snap: Snapshot;
  agentById: Map<string, Agent>;
  notify: (t: string, e?: boolean) => void;
  onQuickStart: () => void;
  onNewAgent: () => void;
  onConcierge: () => void;
  onOpenFile: (name: string) => void;
  openTaskId?: string | null;
  onOpenTaskConsumed?: () => void;
}) {
  const { snap, agentById, notify } = props;
  const [prompt, setPrompt] = useState("");
  const [assignee, setAssignee] = useState("auto");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<Column | null>(null);

  // Macro-pad "open this task" requests arrive from the App level.
  useEffect(() => {
    if (props.openTaskId) {
      setDetailId(props.openTaskId);
      props.onOpenTaskConsumed?.();
    }
  }, [props.openTaskId]);

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
              <option value="auto">Best fit (auto-route)</option>
              {snap.agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
              ))}
            </select>
            <div className="spacer" />
            <button className="btn ghost" disabled={!prompt.trim()} onClick={() => submit(true)}>
              Add to Backlog
            </button>
            <button className="btn" disabled={!prompt.trim() || snap.agents.length === 0} onClick={() => submit(false)}>
              Dispatch Now {MOD_ENTER}
            </button>
          </div>
        </div>

        {snap.agents.length === 0 && boardTasks.length === 0 ? (
          <div className="empty">
            <p style={{ marginBottom: 14 }}>
              Welcome to Qivreno. The fastest start: let the <b>Concierge</b> interview you,
              fill in your business profile, and hire the right team automatically.
            </p>
            <button className="btn" onClick={props.onConcierge}><Icon name="wand" /> Set up with the Concierge</button>
            <p style={{ margin: "14px 0" }}>…or do it yourself:</p>
            <button className="btn ghost" onClick={props.onQuickStart}><Icon name="spark" /> Quick Start Team</button>
            <span style={{ margin: "0 10px" }}>or</span>
            <button className="btn ghost" onClick={props.onNewAgent}>+ New Agent</button>
          </div>
        ) : boardTasks.length === 0 ? (
          <div className="empty" style={{ maxWidth: 720, margin: "24px auto" }}>
            <p style={{ marginBottom: 6, fontSize: 16, color: "var(--text)" }}>
              <b>What do you need accomplished today?</b>
            </p>
            <p style={{ marginBottom: 16, fontSize: 13.5 }}>
              Pick one to start from a proven brief. Fill in the [brackets], then Dispatch —
              your first reviewed, exportable deliverable is the goal.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
              {OUTCOMES.map((o) => (
                <button
                  key={o.label}
                  className="btn ghost sm"
                  onClick={() => {
                    setPrompt(o.prompt);
                    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
                  }}
                >
                  <Icon name={o.icon} /> {o.label}
                </button>
              ))}
            </div>
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
                        {t.parent_id && (
                          <div className="kcard-snippet" style={{ color: "var(--text-faint)" }}>
                            ↳ subtask of “{(boardTasks.find((p) => p.id === t.parent_id)?.title ?? "a larger project").slice(0, 50)}”
                          </div>
                        )}
                        {t.column === "requires_input" && t.input_request && (
                          <div className="kcard-needs">
                            <div className="kcard-needs-tag"><Icon name="question" /> Needs your input</div>
                            <div className="kcard-needs-q">{t.input_request}</div>
                            <div className="kcard-needs-cta">Open to respond →</div>
                          </div>
                        )}
                        {t.status === "done" && t.result && (
                          <div className="kcard-snippet">{t.result.replace(/[#*`>-]/g, "").slice(0, 110)}</div>
                        )}
                        {(col.key === "review" || col.key === "done") && (t.files ?? []).length > 0 && (
                          <div className="kcard-files">
                            {t.files.slice(0, 3).map((f) => (
                              <button
                                key={f}
                                className="file-chip sm"
                                title={`Open ${f}`}
                                onClick={(e) => { e.stopPropagation(); props.onOpenFile(f); }}
                              >
                                <Icon name="doc" /> {displayName(f)}
                              </button>
                            ))}
                            {t.files.length > 3 && <span className="kcard-files-more">+{t.files.length - 3} more</span>}
                          </div>
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

/** Question + large answer field, shown at the top of the task detail modal
 * when the agent has paused for the operator's input. */
function InputRequestBox(props: {
  task: Task;
  notify: (t: string, e?: boolean) => void;
  onAnswered?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    try {
      await invoke("provide_input", { id: props.task.id, answer });
      props.notify("Answer sent — task resuming");
      props.onAnswered?.();
    } catch (e) {
      props.notify(String(e), true);
      setBusy(false);
    }
  };
  return (
    <div className="input-request">
      <div className="input-request-head"><Icon name="question" /> The agent needs your input to continue</div>
      <div className="input-request-q">{props.task.input_request}</div>
      <textarea
        className="input-request-field"
        autoFocus
        rows={6}
        placeholder="Type your response for the agent…"
        value={answer}
        disabled={busy}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className="input-request-actions">
        <span className="hint">{MOD_ENTER} to send</span>
        <button className="btn" disabled={busy || !answer.trim()} onClick={submit}>
          {busy ? "Sending…" : "Send response"}
        </button>
      </div>
    </div>
  );
}

/** Turn a raw log line into a human-readable action for review. */
function prettyAction(line: string): { icon: IconName; text: string; file?: string } {
  const grab = (k: string) => line.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
  if (line.startsWith("tool: ")) {
    const name = line.slice(6).split(" ")[0];
    switch (name) {
      case "write_file": {
        const path = grab("path") ?? "a file";
        return { icon: "doc", text: `Wrote ${path}`, file: path.startsWith("Shared/") ? path.slice(7) : undefined };
      }
      case "read_file": return { icon: "eye", text: `Read ${grab("path") ?? "a file"}` };
      case "list_files": return { icon: "folder", text: "Browsed files" };
      case "save_process": return { icon: "library", text: `Saved process “${grab("title") ?? "…"}” to the Library` };
      case "read_doc": return { icon: "library", text: `Read library doc ${grab("doc") ?? ""}` };
      case "list_library": return { icon: "library", text: "Checked the Library" };
      case "send_message": return { icon: "chat", text: `Messaged ${grab("to") ?? "a teammate"}: “${(grab("body") ?? "").slice(0, 70)}…”` };
      case "update_memory": return { icon: "nodes", text: `Updated ${grab("scope") === "shared" ? "the team's shared" : "its private"} memory` };
      case "move_task": return { icon: "board", text: `Moved board task ${grab("task") ?? ""} to ${grab("column") ?? ""}` };
      case "create_agent": return { icon: "recruit", text: `Hired new agent “${grab("name") ?? ""}”` };
      case "list_board": return { icon: "board", text: "Checked the board" };
      case "fetch_url": return { icon: "globe", text: `Fetched ${grab("url") ?? "a URL"}` };
      case "run_command": return { icon: "bolt", text: `Ran a command: ${(grab("command") ?? "").slice(0, 70)}` };
      default: return { icon: "wrench", text: line.slice(6) };
    }
  }
  if (line.startsWith("routed to best fit")) return { icon: "target", text: line };
  if (line.startsWith("started on")) return { icon: "play", text: line };
  if (line.includes("falling back")) return { icon: "warning", text: line };
  if (line.startsWith("error:")) return { icon: "error", text: line };
  return { icon: "dot", text: line };
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
  const files = [...new Set([...(task.files ?? []), ...actions.filter((a) => a.file).map((a) => a.file!)])];
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
          {task.column === "requires_input" && task.input_request && (
            <InputRequestBox task={task} notify={notify} onAnswered={props.onClose} />
          )}
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
                  <button key={f} className="file-chip" onClick={() => { props.onOpenFile(f); props.onClose(); }} title={f}>
                    <Icon name="doc" /> {displayName(f)} <span>open →</span>
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
                  <div className="act-line" key={i}><span className="act-ico"><Icon name={a.icon} /></span> {a.text}</div>
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
          <div className="main-title">{agent.name}{agent.system ? " ✦" : ""}</div>
          <div className="main-sub">{agent.enabled === false ? "Disabled" : working ? "Working…" : "Idle"}</div>
        </div>
        <div className="spacer" />
        <button
          className="btn ghost sm"
          onClick={async () => {
            try {
              await invoke("set_agent_enabled", { id: agent.id, enabled: agent.enabled === false });
              notify(agent.enabled === false ? `${agent.name} enabled` : `${agent.name} disabled`);
            } catch (e) {
              notify(String(e), true);
            }
          }}
        >
          {agent.enabled === false ? "Enable" : "Disable"}
        </button>
        <button className="btn ghost sm" onClick={props.onEdit}>Edit</button>
        <ArmButton label="Delete" armedLabel="Really delete?" onConfirm={remove} />
      </div>
      {agent.enabled === false && (
        <div className="license-banner">
          <span>
            {agent.name} is disabled and won't receive tasks or messages.
            {agent.name === "Concierge" ? " Re-enable for help with setup, settings or how the app works." : ""}
          </span>
          <button
            className="btn sm"
            onClick={() => invoke("set_agent_enabled", { id: agent.id, enabled: true }).catch((e) => notify(String(e), true))}
          >
            Enable
          </button>
        </div>
      )}
      <div className="main-body">
        <div className="profile">
          <div className="avatar" style={{ background: agent.color }}>
            {agent.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="profile-info">
            <div className="profile-name">{agent.name}</div>
            <div className="profile-role">{agent.role}</div>
            {(agent.description || agent.skills) && (
              <div className="profile-skills">{agent.description || skillsSummary(agent.skills)}</div>
            )}
            {agent.skills && (
              <details className="profile-skills-full">
                <summary>Full skills & working instructions</summary>
                <div>{agent.skills}</div>
              </details>
            )}
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
            <div className="empty">Say hello — type below and it goes straight to {agent.name}.</div>
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

        <div className="chat-input">
          <textarea
            rows={1}
            autoFocus
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
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** Chat Room: the team's agent-to-agent traffic as a live conversation —
    delegations, questions, replies — so the operator can watch the flow. */
/** Strip raw tool markup that older failed tasks left in message bodies. */
function cleanBody(body: string): string {
  return body
    .replace(/<\/?tool_(call|response)s?>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ChatRoomView(props: {
  snap: Snapshot;
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  workingAgents: Set<string>;
}) {
  const { snap, nameOf, colorOf } = props;
  const [scope, setScope] = useState<"agents" | "all">("agents");
  const [who, setWho] = useState("all");
  const endRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => {
    let ms = [...snap.messages].sort((a, b) => a.ts - b.ts);
    if (scope === "agents") ms = ms.filter((m) => m.from !== "user" && m.to !== "user");
    if (who !== "all") ms = ms.filter((m) => m.from === who || m.to === who);
    return ms.slice(-300);
  }, [snap.messages, scope, who]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages.length]);

  const busy = snap.agents.filter((a) => props.workingAgents.has(a.id));

  return (
    <>
      <div className="main-header">
        <div>
          <div className="main-title">Team Chat</div>
          <div className="main-sub">Watch the team coordinate — delegations, questions and replies between agents</div>
        </div>
        <div className="spacer" />
        <select value={who} onChange={(e) => setWho(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="all">All agents</option>
          {snap.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="btn ghost sm" onClick={() => setScope(scope === "agents" ? "all" : "agents")}>
          {scope === "agents" ? "Agents only" : "Including you"}
        </button>
      </div>
      <div className="main-body">
        {busy.length > 0 && (
          <div className="room-live">
            {busy.map((a) => (
              <span key={a.id} className="room-live-chip">
                <i style={{ background: a.color }} /> {a.name} is working…
              </span>
            ))}
          </div>
        )}
        {messages.length === 0 ? (
          <div className="empty">
            No team chatter {who !== "all" ? "for this agent " : ""}yet.
            Dispatch a multi-part project and watch Qivvy break it up and delegate —
            every request and reply between agents lands here.
          </div>
        ) : (
          <div className="room">
            {messages.map((m) => (
              <div className="room-msg" key={m.id}>
                <span className="room-avatar" style={{ background: colorOf(m.from) }}>
                  {nameOf(m.from).slice(0, 1).toUpperCase()}
                </span>
                <div className="room-content">
                  <div className="room-head">
                    <span style={{ color: colorOf(m.from), fontWeight: 650 }}>{nameOf(m.from)}</span>
                    <span className="room-arrow">→</span>
                    <span style={{ color: colorOf(m.to), fontWeight: 650 }}>{nameOf(m.to)}</span>
                    <span className="room-time">{timeAgo(m.ts)}</span>
                  </div>
                  <div className="room-body">{cleanBody(m.body)}</div>
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
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

const KIND_META: Record<string, { icon: IconName; label: string; exports: { label: string; format: string }[] }> = {
  document: { icon: "doc", label: "Document", exports: [{ label: "Word", format: "docx" }, { label: "PDF", format: "pdf" }] },
  spreadsheet: { icon: "grid", label: "Spreadsheet", exports: [{ label: "Excel", format: "xlsx" }, { label: "PDF", format: "pdf" }] },
  presentation: { icon: "deck", label: "Presentation", exports: [{ label: "PowerPoint", format: "pptx" }, { label: "PDF", format: "pdf" }] },
  dashboard: { icon: "chart", label: "Dashboard", exports: [{ label: "HTML", format: "html" }, { label: "PDF", format: "pdf" }] },
  other: { icon: "file", label: "File", exports: [] },
};

/* New-file templates: the user names the file and describes what they want;
   the team builds the content into the file. "Start blank" uses make() with
   the name folded in so titles match from the start. */
const NEW_FILE_TEMPLATES: { kind: string; ext: string; hint: string; briefHint: string; make: (title: string) => string }[] = [
  {
    kind: "document", ext: ".md",
    hint: "e.g. Vendor Cost Review",
    briefHint: "e.g. Compare our top 5 vendors on cost and reliability, recommend which to renegotiate",
    make: (t) => `# ${t}\n`,
  },
  {
    kind: "spreadsheet", ext: ".csv",
    hint: "e.g. Q3 Budget",
    briefHint: "e.g. A quarterly budget with categories for payroll, tools, marketing and travel",
    make: () => "Item,Amount,Notes\nExample,100,\n",
  },
  {
    kind: "presentation",
    ext: ".slides.json",
    hint: "e.g. Client Kickoff Deck",
    briefHint: "e.g. A kickoff deck for the Acme project: goals, timeline, team, next steps",
    make: (t) => JSON.stringify(
      { title: t, slides: [{ title: "First slide", bullets: ["Point one", "Point two"], notes: "" }] },
      null, 2),
  },
  {
    kind: "dashboard",
    ext: ".dash.json",
    hint: "e.g. Q3 Sales Dashboard",
    briefHint: "e.g. Show monthly revenue vs target, top customers, and pipeline by stage",
    make: (t) => JSON.stringify(
      {
        title: t,
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

/** JSON.parse that survives the truncated output local models sometimes
    produce: on failure, balance any unclosed strings/brackets and retry. */
function parseLoose(text: string): any | null {
  try { return JSON.parse(text); } catch { /* try repair */ }
  let inStr = false, esc = false;
  const stack: string[] = [];
  for (const ch of text) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  const repaired = text.trimEnd().replace(/,\s*$/, "") + (inStr ? '"' : "") + stack.reverse().join("");
  try { return JSON.parse(repaired); } catch { return null; }
}

function SlidesView(props: { text: string }) {
  const [idx, setIdx] = useState(0);
  const deck: { title?: string; slides?: { title?: string; bullets?: string[]; notes?: string }[] } | null =
    parseLoose(props.text);
  if (!deck) {
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
            {slides[cur - 1]?.notes && <div className="deck-notes"><Icon name="note" /> {slides[cur - 1].notes}</div>}
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
  const dash: { title?: string; widgets?: Record<string, unknown>[] } | null = parseLoose(props.text);
  if (!dash) {
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
  const [folders, setFolders] = useState<ConnectedFolder[]>([]);
  const [cwd, setCwd] = useState("");           // current subfolder within Shared ("" = root)
  const [selName, setSelName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState<{ tpl: (typeof NEW_FILE_TEMPLATES)[number]; title: string; brief: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);  // null = closed, "" = open
  const [connectPath, setConnectPath] = useState<string | null>(null);  // pending connect confirmation

  const refresh = useCallback(() => {
    invoke<SharedFile[]>("list_shared_files").then(setFiles).catch(() => {});
    invoke<ConnectedFolder[]>("list_connected_folders").then(setFolders).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [refresh]);

  const createFolder = async (name: string) => {
    const clean = name.trim().replace(/[\\:]/g, "-").replace(/^\.+/, "");
    if (!clean) return;
    const rel = cwd ? `${cwd}/${clean}` : clean;
    try {
      await invoke("create_shared_folder", { name: rel });
      refresh();
    } catch (e) {
      notify(String(e), true);
    }
  };

  const pickAndConnect = async () => {
    try {
      const path = await invoke<string | null>("pick_folder");
      if (path) setConnectPath(path);
    } catch (e) {
      notify(String(e), true);
    }
  };

  const confirmConnect = async () => {
    if (!connectPath) return;
    try {
      await invoke("connect_folder", { path: connectPath });
      setConnectPath(null);
      refresh();
      notify("Folder connected — your team can now work in it");
    } catch (e) {
      notify(String(e), true);
    }
  };

  const disconnectFolder = async (path: string) => {
    try {
      await invoke("disconnect_folder", { path });
      refresh();
    } catch (e) {
      notify(String(e), true);
    }
  };

  useEffect(() => {
    if (props.focus) {
      const slash = props.focus.lastIndexOf("/");
      setCwd(slash >= 0 ? props.focus.slice(0, slash) : "");
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

  /** Dispatch the content brief to the team; the file lands here when done. */
  const buildFile = async (tpl: (typeof NEW_FILE_TEMPLATES)[number], title: string, brief: string) => {
    const base = title.trim().replace(/[/\\:]/g, "-").replace(/^\.+/, "") || "Untitled";
    const name = (cwd ? `${cwd}/` : "") + base + tpl.ext;
    const kindLabel = KIND_META[tpl.kind].label.toLowerCase();
    try {
      await invoke("create_task", {
        title: "",
        prompt:
          `Create the ${kindLabel} "Shared/${name}" — keep exactly this file name and the format its extension implies. ` +
          `Content brief: ${brief.trim()}`,
        agentKey: null,
        draft: false,
      });
      notify(`Sent to the team — ${name} will appear here when ready`);
    } catch (e) {
      notify(String(e), true);
    }
  };

  const createFile = async (tpl: (typeof NEW_FILE_TEMPLATES)[number], title: string) => {
    const base = title.trim().replace(/[/\\:]/g, "-").replace(/^\.+/, "") || "Untitled";
    const dir = cwd ? `${cwd}/` : "";
    let name = dir + base + tpl.ext;
    let n = 2;
    while (files.some((f) => f.name === name)) {
      name = `${dir}${base} ${n}${tpl.ext}`;
      n++;
    }
    const content = tpl.make(base);
    try {
      await invoke("write_shared_file", { name, content });
      refresh();
      setSelName(name);
      setContent(content);
      setEditing(true);
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
          {REVEAL_LABEL}
        </button>
      </div>
      <div className="main-body lib-body">
        <div className="lib-nav">
          <div className="section-label"><span>New</span></div>
          <div className="file-new-row">
            {NEW_FILE_TEMPLATES.map((t) => (
              <button key={t.kind} className="file-new" title={`New ${KIND_META[t.kind].label}`} onClick={() => setNaming({ tpl: t, title: "", brief: "" })}>
                <Icon name={KIND_META[t.kind].icon} /><span>{KIND_META[t.kind].label}</span>
              </button>
            ))}
            <button className="file-new" title="New folder" onClick={() => setNewFolder("")}>
              <Icon name="folder" /><span>Folder</span>
            </button>
          </div>
          {newFolder !== null && (
            <div className="folder-new-row">
              <input
                type="text"
                autoFocus
                placeholder="Folder name…"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newFolder.trim()) { createFolder(newFolder); setNewFolder(null); }
                  if (e.key === "Escape") setNewFolder(null);
                }}
              />
              <button className="btn sm" disabled={!newFolder.trim()} onClick={() => { createFolder(newFolder); setNewFolder(null); }}>Create</button>
              <button className="btn ghost sm" onClick={() => setNewFolder(null)}>✕</button>
            </div>
          )}
          {files.length > 0 && (
            <input
              className="file-search"
              type="text"
              placeholder="Search files…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {/* Breadcrumb when inside a subfolder */}
          {cwd && !query.trim() && (
            <div className="file-crumbs">
              <button className="crumb" onClick={() => setCwd("")}>Shared</button>
              {cwd.split("/").map((seg, i, arr) => (
                <span key={i}>
                  <span className="crumb-sep">/</span>
                  <button className="crumb" onClick={() => setCwd(arr.slice(0, i + 1).join("/"))}>{seg}</button>
                </span>
              ))}
            </div>
          )}
          {(() => {
            const q = query.trim().toLowerCase();
            // Searching flattens the whole tree; otherwise show only this folder's direct children.
            const inCwd = (f: SharedFile) => {
              if (q) return true;
              const rest = cwd ? (f.name.startsWith(cwd + "/") ? f.name.slice(cwd.length + 1) : null) : f.name;
              return rest !== null && !rest.includes("/");
            };
            const shown = files.filter((f) => inCwd(f) && (!q || f.name.toLowerCase().includes(q)));
            if (files.length === 0) {
              return (
                <div className="lib-empty">
                  Nothing yet. Drop files in with <b>Connect a folder</b> below, create one above, or ask an agent to produce one.
                </div>
              );
            }
            if (shown.length === 0) {
              return <div className="lib-empty">{q ? <>No files match “{query}”.</> : <>This folder is empty.</>}</div>;
            }
            const subFolders = shown.filter((f) => f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
            const docs = shown.filter((f) => !f.is_dir);
            const order: { kind: string; label: string }[] = [
              { kind: "document", label: "Documents" },
              { kind: "spreadsheet", label: "Spreadsheets" },
              { kind: "presentation", label: "Presentations" },
              { kind: "dashboard", label: "Dashboards" },
              { kind: "other", label: "Other files" },
            ];
            return (
              <>
                {subFolders.length > 0 && (
                  <div>
                    <div className="section-label"><span>Folders</span><span>{subFolders.length}</span></div>
                    {subFolders.map((f) => (
                      <button key={f.name} className="lib-item folder-item" onClick={() => { setCwd(f.name); setQuery(""); }}>
                        <span className="lib-item-title"><Icon name="folder" /> {displayName(f.name)}</span>
                        <span className="lib-item-sub">open →</span>
                      </button>
                    ))}
                  </div>
                )}
                {order.map((grp) => {
                  const inGroup = docs
                    .filter((f) => fileKind(f.name) === grp.kind)
                    .sort((a, b) => b.modified - a.modified);
                  if (inGroup.length === 0) return null;
                  return (
                    <div key={grp.kind}>
                      <div className="section-label"><span>{grp.label}</span><span>{inGroup.length}</span></div>
                      {inGroup.map((f) => (
                        <button
                          key={f.name}
                          className={`lib-item ${selName === f.name ? "active" : ""}`}
                          onClick={() => openFile(f.name)}
                          title={f.name}
                        >
                          <span className="lib-item-title"><Icon name={KIND_META[fileKind(f.name)].icon} /> {displayName(f.name)}</span>
                          <span className="lib-item-sub">{timeAgo(f.modified)}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </>
            );
          })()}

          {/* Connected folders on the user's computer */}
          <div className="section-label" style={{ marginTop: 14 }}>
            <span>Your Folders</span>
            <button className="link-btn" onClick={pickAndConnect}>+ Connect</button>
          </div>
          {folders.length === 0 ? (
            <div className="lib-empty small">
              Connect a folder on your computer so the team can work on files already on your machine.
            </div>
          ) : (
            folders.map((f) => (
              <div key={f.path} className={`lib-item connected ${f.exists ? "" : "missing"}`}>
                <span className="lib-item-title" title={f.path}><Icon name="laptop" /> {f.name}{f.exists ? "" : " (missing)"}</span>
                <span className="conn-actions">
                  <button className="link-btn" title="Open in file manager" onClick={() => openPath(f.path).catch(() => {})}>open</button>
                  <button className="link-btn danger" title="Disconnect" onClick={() => disconnectFolder(f.path)}>✕</button>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="lib-editor">
          {!selName ? (
            <div className="empty">
              Select a file, create one, or ask an agent to produce one.<br />
              Documents, spreadsheets, presentations and dashboards all render right here
              and export to Word, Excel, PowerPoint or PDF with one click.
            </div>
          ) : (
            <>
              <div className="file-head">
                <span className="file-name" title={selName}><Icon name={meta.icon} /> {displayName(selName)}</span>
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
      {naming && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setNaming(null); }}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <h2>New {KIND_META[naming.tpl.kind].label.toLowerCase()}</h2>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Name</label>
              <input
                type="text"
                autoFocus
                placeholder={naming.tpl.hint}
                value={naming.title}
                onChange={(e) => setNaming({ ...naming, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Escape") setNaming(null); }}
              />
            </div>
            <div className="field">
              <label>What should it contain? The team builds it for you.</label>
              <textarea
                rows={4}
                style={{ width: "100%", resize: "vertical" }}
                placeholder={naming.tpl.briefHint}
                value={naming.brief}
                onChange={(e) => setNaming({ ...naming, brief: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && naming.title.trim() && naming.brief.trim()) {
                    buildFile(naming.tpl, naming.title, naming.brief);
                    setNaming(null);
                  }
                  if (e.key === "Escape") setNaming(null);
                }}
              />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setNaming(null)}>Cancel</button>
              <button
                className="btn ghost"
                disabled={!naming.title.trim()}
                title="Create an empty file and write it yourself"
                onClick={() => { createFile(naming.tpl, naming.title); setNaming(null); }}
              >
                Start blank
              </button>
              <button
                className="btn"
                disabled={!naming.title.trim() || !naming.brief.trim()}
                onClick={() => { buildFile(naming.tpl, naming.title, naming.brief); setNaming(null); }}
              >
                Ask the team {MOD_ENTER}
              </button>
            </div>
          </div>
        </div>
      )}
      {connectPath && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setConnectPath(null); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h2><Icon name="warning" /> Connect this folder?</h2>
            <p className="hint" style={{ margin: "10px 0" }}>
              You're about to give your AI team access to:
            </p>
            <div className="connect-path">{connectPath}</div>
            <p className="hint" style={{ margin: "12px 0" }}>
              Agents will be able to <b>read every file</b> in this folder, and <b>create or edit
              files</b> here when a task asks them to. Only connect folders you're comfortable letting
              the team work in. You can disconnect it any time.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConnectPath(null)}>Cancel</button>
              <button className="btn" onClick={confirmConnect}>Connect folder</button>
            </div>
          </div>
        </div>
      )}
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
            <span className="lib-item-title"><Icon name="nodes" /> Shared team memory</span>
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

const TEMPLATE_ICONS: Record<string, IconName> = {
  consulting: "recruit",
  agency: "megaphone",
  founder: "target",
  sales: "chart",
  backoffice: "building",
  dev: "laptop",
};

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

  const selectable = tpl.agents.filter((a) => !existingNames.has(a.name.toLowerCase()));
  const selectedCount = selectable.filter((a) => checked.has(a.name)).length;

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
            description: a.description,
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
                <div className="rc-title"><Icon name={TEMPLATE_ICONS[t.key] ?? "building"} /> {t.label}</div>
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
                    <div className="tpl-skills">{a.description || a.skills}</div>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="field">
          <label>Backend for the whole team (changeable per agent later)</label>
          <BackendPicker backend={backend} avail={avail} onPick={setBackend} />
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
          <button className="btn" disabled={creating || selectedCount === 0} onClick={create}>
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
  const [description, setDescription] = useState(agent?.description ?? "");
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
        name, role, description, skills, backend,
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
                  setDescription(tpl.description);
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
          <label>Description (shown on the agent's profile)</label>
          <input
            type="text"
            value={description}
            placeholder="One friendly line about what this agent does for you"
            onChange={(e) => setDescription(e.target.value)}
          />
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
          <BackendPicker backend={backend} avail={avail} onPick={setBackend} />
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
              <div className="rc-title"><Icon name="lock" /> Sandboxed</div>
              <div className="rc-sub">Files only in its own workspace folder; web access allowed</div>
            </button>
            <button className={`radio-card ${permission === "full" ? "selected" : ""}`} onClick={() => setPermission("full")}>
              <div className="rc-title"><Icon name="bolt" /> Full access</div>
              <div className="rc-sub">Can run any command and touch any file on this {MACHINE}</div>
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

/** Friendly email-connection wizard with provider presets + a real test. */
const MAIL_PRESETS: { label: string; host: string; port: number; hint: string }[] = [
  { label: "Gmail", host: "imap.gmail.com", port: 993, hint: "Use an App Password (myaccount.google.com/apppasswords), not your normal password." },
  { label: "Outlook / Microsoft 365", host: "outlook.office365.com", port: 993, hint: "Create an app password in your Microsoft account security settings." },
  { label: "iCloud", host: "imap.mail.me.com", port: 993, hint: "Generate an app-specific password at appleid.apple.com." },
  { label: "Yahoo", host: "imap.mail.yahoo.com", port: 993, hint: "Create an app password in Yahoo Account Security." },
  { label: "Other (IMAP)", host: "", port: 993, hint: "Enter your provider's IMAP server and port (usually 993)." },
];

function ConnectEmailModal(props: {
  settings: Settings;
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const [preset, setPreset] = useState<string>("");
  const [s, setS] = useState({
    host: props.settings.mail_host,
    port: props.settings.mail_port || 993,
    user: props.settings.mail_user,
    password: props.settings.mail_password,
    allowlist: props.settings.mail_allowlist,
  });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const pickPreset = (p: typeof MAIL_PRESETS[number]) => {
    setPreset(p.label);
    setS((v) => ({ ...v, host: p.host, port: p.port }));
    setResult(null);
  };
  const hint = MAIL_PRESETS.find((p) => p.label === preset)?.hint;

  const test = async () => {
    setTesting(true); setResult(null);
    try {
      const msg = await invoke<string>("test_mail_connection", { host: s.host, port: s.port, user: s.user, password: s.password });
      setResult({ ok: true, msg });
    } catch (e) {
      setResult({ ok: false, msg: String(e) });
    }
    setTesting(false);
  };
  const saveAndConnect = async () => {
    try {
      await invoke("update_settings", {
        settings: { ...props.settings, mail_enabled: true, mail_host: s.host, mail_port: s.port, mail_user: s.user, mail_password: s.password, mail_allowlist: s.allowlist },
      });
      props.notify("Email connected — new mail becomes task proposals in Requires Input");
      props.onClose();
    } catch (e) { props.notify(String(e), true); }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <h2>Connect your email</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          Qivreno reads incoming mail and turns real requests into task proposals you approve.
          Nothing is sent, nothing is marked read, and your password stays on this {MACHINE}.
        </p>
        <div className="field">
          <label>Your email provider</label>
          <div className="radio-row">
            {MAIL_PRESETS.map((p) => (
              <button key={p.label} className={`radio-card ${preset === p.label ? "selected" : ""}`} onClick={() => pickPreset(p)}>
                <div className="rc-title">{p.label}</div>
              </button>
            ))}
          </div>
          {hint && <div className="hint" style={{ marginTop: 8 }}>{hint}</div>}
        </div>
        {(preset === "Other (IMAP)" || !preset) && (
          <div style={{ display: "flex", gap: 8 }}>
            <div className="field" style={{ flex: 2 }}>
              <label>IMAP server</label>
              <input type="text" placeholder="imap.example.com" value={s.host} onChange={(e) => setS({ ...s, host: e.target.value.trim() })} />
            </div>
            <div className="field" style={{ width: 90 }}>
              <label>Port</label>
              <input type="number" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) || 993 })} />
            </div>
          </div>
        )}
        <div className="field">
          <label>Email address</label>
          <input type="text" placeholder="you@example.com" value={s.user} onChange={(e) => setS({ ...s, user: e.target.value.trim() })} />
        </div>
        <div className="field">
          <label>App password</label>
          <input type="password" placeholder="app password (not your login password)" value={s.password} onChange={(e) => setS({ ...s, password: e.target.value })} />
        </div>
        <div className="field">
          <label>Only these senders (optional)</label>
          <input type="text" placeholder="comma-separated — leave blank for all" value={s.allowlist} onChange={(e) => setS({ ...s, allowlist: e.target.value })} />
        </div>
        {result && (
          <div className={`license-status ${result.ok ? "ok" : "bad"}`} style={{ marginBottom: 10 }}>
            {result.ok ? "✓ " : "✕ "}{result.msg}
          </div>
        )}
        <div className="modal-actions">
          {props.settings.mail_enabled && (
            <button
              className="btn ghost"
              style={{ marginRight: "auto", color: "var(--red)" }}
              onClick={async () => {
                try {
                  await invoke("update_settings", { settings: { ...props.settings, mail_enabled: false } });
                  props.notify("Email disconnected");
                  props.onClose();
                } catch (e) { props.notify(String(e), true); }
              }}
            >
              Disconnect
            </button>
          )}
          <button className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn ghost" disabled={testing || !s.host || !s.user || !s.password} onClick={test}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button className="btn" disabled={!result?.ok} onClick={saveAndConnect}>Connect</button>
        </div>
      </div>
    </div>
  );
}

/** Launcher: pick a cloud AI provider, then its inline setup guide. */
function ConnectAIModal(props: {
  avail: Availability;
  onClose: () => void;
  onRecheck: () => void;
}) {
  const [picked, setPicked] = useState<BackendKind | null>(null);
  const groups: { label: string; items: BackendKind[] }[] = [
    { label: `Private — stays on this ${MACHINE}`, items: ["builtin", "ollama", "lmstudio"] },
    { label: "Best results — uses your own account", items: ["claude", "codex", "gemini", "grok"] },
  ];
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <h2>Connect an AI model</h2>
        <p className="hint" style={{ marginBottom: 8 }}>
          Your agents need an AI to think with. There are two ways to do this, and there is a real
          trade-off between them.
        </p>
        <p className="hint" style={{ marginBottom: 8 }}>
          <b>Private</b> — the AI runs on this {MACHINE}. Nothing you or your agents write is ever
          sent anywhere. It is free and works without internet. The catch: it can only be as smart
          as this {MACHINE} is powerful, so the work comes back slower and simpler.
        </p>
        <p className="hint" style={{ marginBottom: 8 }}>
          <b>Best results</b> — the thinking happens on Claude's or OpenAI's computers using an
          account you already pay for. Your agents produce noticeably better work. In exchange, the
          text of your tasks is sent to that company to be processed.
        </p>
        <p className="hint" style={{ marginBottom: 12 }}>
          <b>Our recommendation:</b> connect Claude or Codex — that is where your agents do their
          best work. Choose a private option instead if keeping every word on this {MACHINE} matters
          more to you than getting the strongest results. You can set up both and choose per agent.
        </p>
        {groups.map((g) => (
          <div key={g.label} className="field">
            <label>{g.label}</label>
            <div className="radio-row">
              {g.items.map((b) => (
                <button key={b} className={`radio-card ${picked === b ? "selected" : ""}`} onClick={() => setPicked(b)}>
                  <div className="rc-title"><i className={props.avail[b] ? "dot-up" : "dot-down"} /> {BACKEND_LABEL[b]}</div>
                  <div className="rc-sub">{BACKEND_SUB[b]}{props.avail[b] ? " · connected ✓" : ""}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {picked && <div style={{ marginTop: 2 }}><SetupGuide backend={picked} avail={props.avail} onRecheck={props.onRecheck} /></div>}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** Guided Telegram setup — text tasks to the team from your phone. */
function ConnectTelegramModal(props: {
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const [live, setLive] = useState<Settings | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    invoke<Snapshot>("get_snapshot").then((sn) => {
      setLive(sn.settings);
      setToken(sn.settings.telegram_token);
    }).catch(() => {});
  }, []);
  const refresh = async () => {
    try { const sn = await invoke<Snapshot>("get_snapshot"); setLive(sn.settings); } catch { /* keep last */ }
  };
  const connect = async () => {
    setBusy(true);
    try {
      const sn = await invoke<Snapshot>("get_snapshot");
      await invoke("update_settings", {
        settings: { ...sn.settings, telegram_enabled: true, telegram_token: token.trim() },
      });
      await refresh();
      props.notify("Bot saved — now send it the pairing code from Telegram");
    } catch (e) { props.notify(String(e), true); }
    setBusy(false);
  };
  const disconnect = async () => {
    try {
      const sn = await invoke<Snapshot>("get_snapshot");
      await invoke("update_settings", { settings: { ...sn.settings, telegram_enabled: false } });
      props.notify("Phone remote turned off");
      props.onClose();
    } catch (e) { props.notify(String(e), true); }
  };
  const paired = live !== null && live.telegram_chat_id !== 0;
  const enabled = live?.telegram_enabled ?? false;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <h2>Phone remote (Telegram)</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          Text your team from anywhere: messages you send the bot become tasks, and agents reply
          with results. Free, end-to-end through your own private bot.
        </p>
        <ol className="guide-steps" style={{ marginBottom: 12 }}>
          <li>In Telegram, message <b>@BotFather</b> and send <b>/newbot</b>.</li>
          <li>Give it a name — BotFather replies with a token.</li>
          <li>Paste the token below and hit Connect.</li>
          <li>Send your new bot the pairing code that appears.</li>
        </ol>
        <div className="field">
          <label>Bot token</label>
          <input
            type="password"
            placeholder="123456789:ABC… from @BotFather"
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
          />
        </div>
        {enabled && !paired && live?.telegram_pair_code && (
          <div className="license-status" style={{ marginBottom: 10 }}>
            Pairing code — send this to your bot: <b>{live.telegram_pair_code}</b>
          </div>
        )}
        {paired && (
          <div className="license-status ok" style={{ marginBottom: 10 }}>
            ✓ Paired — text your bot and tasks route to the team. Prefix with "ask AgentName:" to pick the agent.
          </div>
        )}
        <div className="modal-actions">
          {enabled && (
            <button className="btn ghost" style={{ marginRight: "auto", color: "var(--red)" }} onClick={disconnect}>
              Disconnect
            </button>
          )}
          <button className="btn ghost" onClick={props.onClose}>Close</button>
          {enabled && !paired && (
            <button className="btn ghost" onClick={refresh}>Check pairing</button>
          )}
          <button className="btn" disabled={busy || !token.trim()} onClick={connect}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Deck branding — colors + customer template import, applied to every export. */
function BrandingModal(props: {
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const [accent, setAccent] = useState("");
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    invoke<Snapshot>("get_snapshot").then((sn) => {
      setAccent(sn.settings.brand_accent);
      setText(sn.settings.brand_text);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);
  const save = async () => {
    try {
      const sn = await invoke<Snapshot>("get_snapshot");
      await invoke("update_settings", { settings: { ...sn.settings, brand_accent: accent, brand_text: text } });
      props.notify("Deck branding saved");
      props.onClose();
    } catch (e) { props.notify(String(e), true); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <h2>Deck branding</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          Decks export with Qivreno Blue by default. Import a customer's PowerPoint template to
          pull their theme colors, or pick them manually — their brand then applies to every
          presentation and PDF export.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <label className="color-pick">
            Accent
            <input type="color" disabled={!loaded} value={accent || "#005DFF"} onChange={(e) => setAccent(e.target.value)} />
          </label>
          <label className="color-pick">
            Text
            <input type="color" disabled={!loaded} value={text || "#111827"} onChange={(e) => setText(e.target.value)} />
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
                  setAccent(res.accent);
                  setText(res.text);
                  props.notify(`Brand imported: accent ${res.accent}`);
                } catch (err) {
                  props.notify(String(err), true);
                }
                e.target.value = "";
              }}
            />
          </label>
          {(accent || text) && (
            <button className="btn ghost sm" onClick={() => { setAccent(""); setText(""); }}>
              Reset to Qivreno
            </button>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** Settings hub: one card per feature, each with a status line and a single
    setup button that opens its guided wizard. Raw fields live under Advanced. */
function SettingsModal(props: {
  settings: Settings;
  avail: Availability;
  /** Theme lives in localStorage, not Settings, so it is passed in separately. */
  theme: "dark" | "light" | "system";
  onTheme: (t: "dark" | "light" | "system") => void;
  onClose: () => void;
  notify: (t: string, e?: boolean) => void;
}) {
  const [s, setS] = useState<Settings>({ ...props.settings });
  const [showTerms, setShowTerms] = useState(false);
  const [showConnectEmail, setShowConnectEmail] = useState(false);
  const [showConnectAI, setShowConnectAI] = useState(false);
  const [showTelegram, setShowTelegram] = useState(false);
  const [showBrand, setShowBrand] = useState(false);
  const [showMicro, setShowMicro] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const [showAdv, setShowAdv] = useState(false);

  // Wizards persist themselves; re-sync our draft when one closes so a later
  // Save here can't write stale values over what the wizard just saved.
  const refresh = () =>
    invoke<Snapshot>("get_snapshot").then((sn) => setS(sn.settings)).catch(() => {});

  const save = async () => {
    try {
      await invoke("update_settings", { settings: s });
      props.notify("Settings saved");
      props.onClose();
    } catch (e) {
      props.notify(String(e), true);
    }
  };

  const aiUp = BACKENDS.filter((b) => props.avail[b]);
  const paired = s.telegram_chat_id !== 0;
  const cards: {
    icon: IconName; title: string; status: string; tone: "up" | "warn" | "";
    action?: string; onAction?: () => void;
  }[] = [
    {
      icon: "agent", title: "AI models",
      status: aiUp.length > 0
        ? `● ${aiUp.map((b) => BACKEND_LABEL[b]).join(", ")}`
        : "None connected yet — Built-in AI is one click away",
      tone: aiUp.length > 0 ? "up" : "warn",
      action: "Set up", onAction: () => setShowConnectAI(true),
    },
    {
      icon: "envelope", title: "Email to tasks",
      status: s.mail_enabled ? `● ${s.mail_user || "Connected"}` : "Off — turn incoming requests into task proposals",
      tone: s.mail_enabled ? "up" : "",
      action: s.mail_enabled ? "Manage" : "Connect", onAction: () => setShowConnectEmail(true),
    },
    {
      icon: "phone", title: "Phone remote",
      status: paired ? "● Paired — text your team via Telegram" : s.telegram_enabled ? "Waiting for pairing…" : "Off — send tasks from your phone",
      tone: paired ? "up" : s.telegram_enabled ? "warn" : "",
      action: s.telegram_enabled ? "Manage" : "Set up", onAction: () => setShowTelegram(true),
    },
    {
      icon: "calendar", title: "Calendar",
      status: IS_MAC
        ? "● Built in — agents read your Mac Calendar and can book events"
        : "Agents are date-aware today — Windows calendar integration is coming",
      tone: IS_MAC ? "up" : "",
    },
    {
      icon: "palette", title: "Deck branding",
      status: s.brand_accent || s.brand_text ? `● Custom — accent ${s.brand_accent || "default"}` : "Qivreno Blue (default)",
      tone: s.brand_accent || s.brand_text ? "up" : "",
      action: "Customize", onAction: () => setShowBrand(true),
    },
    {
      icon: "bolt", title: "Macro pad",
      status: s.micro_enabled
        ? "● Global shortcuts active — Creator Micro ready"
        : "Off — drive Qivreno from a Creator Micro or any macro pad",
      tone: s.micro_enabled ? "up" : "",
      action: "Configure", onAction: () => setShowMicro(true),
    },
    {
      icon: "eye", title: "Appearance",
      status: props.theme === "system"
        ? `Light or dark, following this ${MACHINE}`
        : props.theme === "light" ? "Always light" : "Always dark",
      tone: "",
      action: "Change", onAction: () => setShowTheme(true),
    },
  ];

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal">
        <h2>Settings</h2>
        <div className="settings-cards">
          {cards.map((c) => (
            <div key={c.title} className="setting-card">
              <div className="sc-icon"><Icon name={c.icon} /></div>
              <div className="sc-body">
                <div className="sc-title">{c.title}</div>
                <div className={`sc-status ${c.tone}`}>{c.status}</div>
              </div>
              {c.action && (
                <button className="btn ghost sm" onClick={c.onAction}>{c.action}</button>
              )}
            </div>
          ))}
        </div>

        <button className="adv-toggle" onClick={() => setShowAdv(!showAdv)}>
          {showAdv ? "▾" : "▸"} Advanced
        </button>
        {showAdv && (
          <div style={{ marginTop: 10 }}>
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
              <label>Agent-to-agent conversation limit (hops)</label>
              <input
                type="number" min={1} max={20} value={s.max_hops}
                onChange={(e) => setS({ ...s, max_hops: Math.max(1, Number(e.target.value) || 6) })}
              />
              <div className="hint">Stops two agents from talking to each other forever. After this many back-and-forths, messages are delivered but no longer auto-answered.</div>
            </div>
          </div>
        )}

        <div className="hint" style={{ margin: "14px 0 4px" }}>
          <button className="linkish" onClick={() => setShowTerms(true)}>View Terms &amp; Conditions</button>
          {props.settings.terms_accepted_at > 0 &&
            ` — accepted ${new Date(props.settings.terms_accepted_at).toLocaleDateString()} (v${props.settings.terms_accepted_version})`}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={props.onClose}>Close</button>
          {showAdv && <button className="btn" onClick={save}>Save</button>}
        </div>
      </div>
      {showTerms && <TermsModal viewOnly onClose={() => setShowTerms(false)} notify={props.notify} />}
      {showConnectEmail && (
        <ConnectEmailModal
          settings={s}
          notify={props.notify}
          onClose={() => { setShowConnectEmail(false); refresh(); }}
        />
      )}
      {showConnectAI && (
        <ConnectAIModal
          avail={props.avail}
          onClose={() => { setShowConnectAI(false); refresh(); }}
          onRecheck={() => invoke("check_availability").catch(() => {})}
        />
      )}
      {showTelegram && (
        <ConnectTelegramModal
          notify={props.notify}
          onClose={() => { setShowTelegram(false); refresh(); }}
        />
      )}
      {showBrand && (
        <BrandingModal
          notify={props.notify}
          onClose={() => { setShowBrand(false); refresh(); }}
        />
      )}
      {showMicro && (
        <MicroModal
          notify={props.notify}
          onClose={() => { setShowMicro(false); refresh(); }}
        />
      )}
      {showTheme && (
        <ThemeModal
          theme={props.theme}
          onPick={props.onTheme}
          onClose={() => setShowTheme(false)}
        />
      )}
    </div>
  );
}

/**
 * Light / dark / follow-the-OS. The preference lives in localStorage (applied
 * by the effect in App), not in Settings, so there is nothing to save here —
 * picking applies immediately and the modal is just a chooser.
 */
function ThemeModal(props: {
  theme: "dark" | "light" | "system";
  onPick: (t: "dark" | "light" | "system") => void;
  onClose: () => void;
}) {
  const options: { id: "system" | "light" | "dark"; title: string; sub: string }[] = [
    { id: "system", title: `Match this ${MACHINE}`, sub: `Follows your ${MACHINE}'s light or dark setting` },
    { id: "light", title: "Light", sub: `Always light, whatever this ${MACHINE} is set to` },
    { id: "dark", title: "Dark", sub: `Always dark, whatever this ${MACHINE} is set to` },
  ];
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <h2><Icon name="eye" /> Appearance</h2>
        <p className="hint" style={{ margin: "6px 0 12px" }}>
          Changes apply straight away, so you can see each one before you close this.
        </p>
        <div className="radio-row">
          {options.map((o) => (
            <button
              key={o.id}
              className={`radio-card ${props.theme === o.id ? "selected" : ""}`}
              onClick={() => props.onPick(o.id)}
            >
              <div className="rc-title">{o.title}</div>
              <div className="rc-sub">{o.sub}</div>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** Macro-pad control surface: enable global shortcuts and map them. Saves
 * immediately (like the other wizards) so the pad works without a restart. */
function MicroModal(props: { notify: (t: string, e?: boolean) => void; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    invoke<Snapshot>("get_snapshot").then((sn) => {
      const st = sn.settings;
      if (!st.micro_bindings || st.micro_bindings.length === 0) {
        st.micro_bindings = MICRO_ACTIONS.map((a) => ({ action: a.action, accel: a.accel }));
      }
      setS(st);
    }).catch(() => {});
  }, []);
  if (!s) return null;
  const labelOf = (action: string) => MICRO_ACTIONS.find((a) => a.action === action)?.label ?? action;
  const save = async () => {
    setSaving(true);
    try {
      await invoke("update_settings", { settings: s });
      props.notify(s.micro_enabled ? "Macro pad shortcuts active" : "Macro pad shortcuts off");
      props.onClose();
    } catch (e) {
      props.notify(String(e), true);
      setSaving(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal">
        <h2><Icon name="bolt" /> Macro pad</h2>
        <p className="hint" style={{ margin: "6px 0 12px" }}>
          Drive Qivreno from a <b>Work Louder Creator Micro 2</b> or any programmable macro pad.
          Qivreno listens for the global shortcuts below even while you work in another app — map
          your pad's keys to them in the pad's configurator (Work Louder <b>Input</b>: create a
          Qivreno layer, assign each key a shortcut from this list, and use <b>AppSense</b> to
          auto-switch to that layer when Qivreno is focused). {IS_MAC
            ? "F13-F20 are safe defaults no other app uses; macOS cannot register F21-F24, so those four actions use hyper combos."
            : "F13-F24 are safe defaults no other app uses, and every one of them registers on Windows."}
        </p>
        <label className="check-row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={s.micro_enabled}
            onChange={(e) => setS({ ...s, micro_enabled: e.target.checked })}
          />
          Enable global macro-pad shortcuts
        </label>
        <div className="micro-grid">
          {s.micro_bindings.map((b, i) => (
            <div className="micro-row" key={b.action}>
              <span className="micro-label">{labelOf(b.action)}</span>
              <input
                type="text"
                value={b.accel}
                style={{ width: 110, textAlign: "center" }}
                onChange={(e) => {
                  const next = [...s.micro_bindings];
                  next[i] = { ...b, accel: e.target.value };
                  setS({ ...s, micro_bindings: next });
                }}
              />
            </div>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          Accepts key names like F13 {IS_MAC ? "(F13-F20 only on macOS)" : "(F13-F24 all work here)"}{" "}
          or combos like {IS_MAC ? "Cmd+Ctrl+Alt+Shift+1" : "Ctrl+Alt+Shift+1"}. Suggested pad
          layout: keys 1-12 → the twelve actions in order; dial press → Show / hide Qivreno.
          Anything that fails to register is reported as a notification when you save.
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

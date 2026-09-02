# Qivreno

**A local-first desktop app for running a team of AI agents.** Give a task to
the whole team and the best-suited agent picks it up, or assign it to a
specific one. Agents chat with you, delegate to each other, move work across a
shared kanban board, and write real deliverables — documents, spreadsheets,
decks — into a folder on your disk.

Free, MIT-licensed, and built so that **nothing has to leave your computer**:
the bundled AI engine runs a local model with one click, there is no account,
no licence key, no telemetry and no Qivreno server anywhere in the loop. When
you want stronger results you can point any individual agent at Claude, Codex,
Gemini or Grok using your own subscription — per agent, so you decide exactly
what leaves the machine and what does not.

Built with Tauri 2 (Rust core + React/TypeScript UI). Ships for macOS today;
the stack is cross-platform and a Windows build exists (see below).

**[Download](https://qivreno.ai/download)** · [Plugins](docs/PLUGINS.md) ·
[Discord](https://discord.gg/REPLACE-ME) · MIT

> Honest note: Qivreno was built as a paid product and did not find its
> market. It is released free and open rather than left to rot. On the bundled
> local model it is capable but limited — expect slower, simpler work than a
> frontier model, and point agents at Claude or Codex when the output has to
> be sharp.

## Example: scale a small business without headcount

Create manager agents — Accounting, HR, Marketing, Engineering — each with a
role and a skills description. Then dispatch tasks like *"Draft a Q3 hiring
plan for a 15-person team"* to **Best fit** and the router hands it to the HR
agent. Agents can pass work sideways: Marketing can ask Engineering a
technical question mid-task via the built-in message bus.

## Guided setup (Concierge)

On first launch the Board offers **“Set up with the Concierge”**: it creates a
Setup Assistant agent that interviews the owner in chat, saves what it learns
into a *Business Profile* library doc, and hires the team of agents that fits
their business — fully working out of the box. The Concierge can also be
started later from the Quick Start dialog.

## Quick Start teams

**✨ Quick Start Team** (sidebar) creates a whole team from a template in one
click — pick the members you want, every agent is fully editable afterwards.
Templates are designed around the most common small-business capability gaps
(cash-flow management, compliance, cybersecurity, marketing consistency,
customer retention, data-driven decisions, hiring, funding):

- **Small Business** — Sales, Marketing, HR, Accounting, Legal, Operations,
  Planning managers.
- **Software Team** — Engineering Manager, Architect, Backend, Frontend,
  Systems/DevOps, QA.
- **Finance & Back Office** — Bookkeeper, Cash-Flow Analyst, Compliance
  Officer, Procurement Specialist.
- **Marketing Studio** — Content Writer, Social Media, SEO, Email Marketer,
  Marketing Analyst.
- **Customer Care** — Support, Customer Success, Community, Knowledge Base
  Curator.
- **Specialists** (pick-and-choose singles) — IT & Security Advisor,
  Executive Assistant, Data Analyst, Grants & Funding Writer, Project
  Manager, Recruiter, Training Lead, Front Desk & Triage.

## Library: business knowledge, processes, and memory

The **Library** view holds everything agents should know, and all of it is
injected into every agent run:

- **Business Info** — docs the owner maintains: name, market, brand identity,
  pricing, policies. The doc titled *Business Profile* is injected verbatim
  into every agent's context so responses stay on-brand and on-policy (a
  guided skeleton is prefilled on first use).
- **Processes** — repeatable workflows. Agents are instructed to check for an
  existing process before improvising and to document new repeatable
  workflows they perform (`save_process` tool / `POST /library/save`), so the
  business builds an SOP handbook as a side effect of doing work.
- **Memory** — one private, ever-refined memory file per agent (the agent
  rewrites it wholesale — merging new durable facts, pruning stale ones) plus
  one shared team memory that any agent can append facts to (deduped and
  size-capped). Both are editable by the owner in the Library.

Agents can also **hire** (`create_agent` tool / `POST /agents/create`) when a
needed role is missing — new hires inherit the requester's backend and start
sandboxed. The 12-agent cap still applies.

## Backend strategy: cloud primary, local fallback

A one-time dialog recommends running key agents on Claude/Codex (highest
quality, BYO subscription) with local models as the safety net. The fallback
is automatic and always on: **if an agent's primary backend fails or is
unreachable, the task reruns on the best installed local backend**
(Built-in AI → Ollama → LM Studio) with its prompt rebuilt for that backend,
and the switch is recorded in the task log. Nothing to configure.

## Shared Files: documents, spreadsheets, decks, dashboards

The **Files** view is the team's shared folder (`~/Qivreno/Shared`) — every
agent, sandboxed or not, can read and write it (local agents use the
`Shared/` path prefix; Claude gets `--add-dir`, Codex gets an extra
writable root). Agents are instructed to save deliverables there in formats
the app renders natively and can export:

| Type | Format | In-app | Export |
|---|---|---|---|
| Document / report | Markdown `.md` | Rendered (headings, lists, tables) + editable | **Word `.docx`** · **PDF** |
| Spreadsheet | `.csv` with header row | Data grid | **Excel `.xlsx`** · **PDF** |
| Presentation | `.slides.json` | Slide viewer with navigation | **PowerPoint `.pptx`** · **PDF** (one 16:9 page per slide) |
| Dashboard | `.dash.json` | Stat tiles + SVG bar/line charts + tables | **HTML** · **PDF** (vector charts) |

All exports are generated locally with zero external dependencies: DOCX via
docx-rs, PPTX as hand-built OOXML, XLSX via rust_xlsxwriter, and PDFs from a
built-in PDF 1.4 writer (standard fonts, vector charts). Validated against
macOS's own parsers (textutil / Quick Look) in the test suite.

Agents collaborate on these files — the conventions are injected into every
run, so "have Marketing draft the deck and have Sales review it" works by
file name. The operator can create/edit all four types directly in the app.

## Kanban board

The Board view is a four-column kanban: **To Do → In Progress → Review → Done**.

- *Add to Backlog* parks a task in To Do; *Dispatch Now* (or dragging a card
  to In Progress) sends it to a specific agent or auto-routes to the best fit.
- While an agent works, the card sits in In Progress; when it finishes, it
  moves to Review automatically. Drag it to Done to approve, or back to
  In Progress to re-run. Failed tasks return to To Do for retry.
- Agents see the board too: they can list it and move cards
  (e.g. a QA agent moving a reviewed teammate's task to Done) via the
  local bus API / their `list_board` and `move_task` tools.

## AI backends (per agent)

| Backend | How it runs | Requirements on the machine |
|---|---|---|
| **Built-in AI** | A bundled llama.cpp engine (`llama-server`, MIT) + a Qwen3 GGUF model (Apache-2.0) downloaded on first enable — auto-sized to the Mac's RAM (8B on 16 GB+, 4B below). OpenAI-compatible server managed by the app on port 42730; same tool loop as other local backends | **None** — one click in the app, one model download (~2.6–5.1 GB) |
| **Ollama** | Local models via the Ollama HTTP API, with a built-in tool loop (files, web fetch, teammate messaging, kanban, optional shell) | [Ollama](https://ollama.com) running, with a tool-calling model pulled (e.g. `ollama pull qwen3:8b`) |
| **LM Studio** | Same built-in tool loop over any OpenAI-compatible local server (LM Studio, LocalAI, llama.cpp server, …) | [LM Studio](https://lmstudio.ai) with a tool-capable model loaded and the local server started (port 1234) |
| **Claude** | Drives the `claude` CLI headlessly (`claude -p`), inheriting the user's Claude subscription and its full tool suite | Claude Code installed & logged in (auto-detected, incl. the desktop-app bundled binary) |
| **Codex** | Drives the `codex` CLI headlessly (`codex exec`) | `npm i -g @openai/codex` and logged in with a ChatGPT account |

Backend availability is shown live in the sidebar. **Clicking any backend —
in the sidebar dots or while creating an agent — that isn't set up opens a
step-by-step setup guide** with download links and a "Check again" button.
Paths and server URLs are overridable in Settings.

## Permissions (per agent)

- **Sandboxed** (default): file access confined to the agent's own workspace
  folder (`~/Qivreno/<Name>`), web access allowed, no arbitrary shell.
  Claude agents get a restricted tool allowlist; Codex agents run under
  `--sandbox workspace-write`.
- **Full access**: the agent can run any command and touch any file on the
  machine (Claude `--dangerously-skip-permissions`, Codex bypass mode, shell
  tool for local models). Use deliberately.

## How agents collaborate

- The app runs a localhost-only HTTP message bus on port `42720`.
- CLI-backed agents message teammates and move kanban cards with `curl`
  calls (instructions are injected into every run); Ollama/LM Studio agents
  get native `send_message`, `list_board` and `move_task` tools.
- An incoming message becomes a task for the recipient, whose answer is
  delivered back — enabling multi-step agent-to-agent threads.
- Threads are bounded by a configurable **hop limit** (default 6), duplicate
  sends are blocked, per-run sends are capped, and agents answer `NO_REPLY`
  to acknowledgments — so conversations terminate instead of ping-ponging.
- Each agent works one task at a time; user chats and board tasks are
  prioritized over agent-to-agent traffic.

## Cost & licensing

Qivreno is **free**. No trial, no licence key, no account, no seat limit, and
no cap on how many agents you create. There is no telemetry and no server to
phone home to — the app works fully offline with the built-in engine.

The only things that ever cost money are optional and paid to someone else:
if you point an agent at Claude, Codex, Gemini or Grok, that runs on **your**
subscription or API key with those providers, under their terms. Ollama, LM
Studio and the bundled llama.cpp engine run locally and cost nothing.

## Plugins

Qivreno is extensible in two ways: **skill packs** (plain-text folders adding
agent roles, teams and Library documents) and **MCP tool servers** (giving
agents new tools). See [docs/PLUGINS.md](docs/PLUGINS.md) for the format and
[examples/plugins/starter-pack](examples/plugins/starter-pack) for a worked
example. Packs are data and load at startup; MCP servers are programs and run
only when you enable them.

## Contributing

Issues and pull requests are welcome. The most useful contributions right
now are plugin packs (see [docs/PLUGINS.md](docs/PLUGINS.md)), Windows
testing, and bug reports with the task log attached.

This is maintained by one person alongside client work, so responses are
best-effort. If something is broken, a clear reproduction is worth more than
a patch.

## License

MIT — see [LICENSE](LICENSE). Use it commercially, fork it, ship it.

The **Qivreno** name, logo and brand assets in `brand/` are trademarks of
272 Solutions LLC and are not covered by the MIT grant; forks should ship
under their own name.

Much of this codebase was written with Claude (Anthropic) pair-programming,
which the commit history reflects.

## Develop

```sh
npm install
npm run tauri dev
```

Prereqs: Node 18+, Rust (`rustup`), Xcode Command Line Tools.

## Build & deploy (macOS)

```sh
npm run tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:
- `macos/Qivreno.app`
- `dmg/Qivreno_1.0.0_<arch>.dmg`

Copy the `.dmg` to another Mac and drag the app to Applications. Dev builds
are unsigned, so on first launch: **right-click the app → Open → Open** (or
`xattr -dr com.apple.quarantine /Applications/Qivreno.app`).

Out of the box, users need **nothing else installed**: the Built-in AI
backend downloads and runs a local model with one click (engine files live
in `Contents/Resources/llama/`; the model lands in the app data dir; the
server process is started and stopped with the app). Power users can still
point agents at Ollama, LM Studio, or logged-in Claude Code / Codex CLIs —
the in-app setup guides cover each.

Third-party notices: the bundled engine is llama.cpp (MIT — license file
ships in Resources/llama/LICENSE); downloaded models are Qwen3 (Apache-2.0).

## Windows build

The codebase is Windows-ready: every OS-specific call is behind
`src-tauri/src/platform.rs` (home dir, shell, process kill, file-manager
reveal, RAM detection, CLI discovery with `.exe`/`.cmd` shims), and the
built-in AI engine ships per-platform (`resources/llama` for macOS via
`tauri.macos.conf.json`, `resources/llama-win` with `llama-server.exe` via
`tauri.windows.conf.json`).

**Producing the .exe** requires building on Windows — Tauri cannot
cross-compile Windows installers from macOS. The push-button path is
GitHub Actions (`.github/workflows/release.yml`): push this repo to GitHub,
tag a version (`v1.0.0`) or run the workflow manually, and Windows runners
produce the NSIS `.exe` installer + `.msi` (WebView2 bootstrapper included
automatically) alongside the macOS `.dmg`. Alternative: run
`npm run tauri build` on any Windows 10/11 machine with Node + Rust.

Before selling the Windows build: smoke-test on a real Windows machine
(the platform branches compile-check only on Windows), and add an
Authenticode code-signing certificate (SmartScreen warns loudly on
unsigned installers).

## Distribution notes

- All dependencies (Tauri, React, Vite, serde, ureq, tiny_http, uuid) are
  MIT/Apache-2.0 licensed — free for commercial use, no copyleft.
- The app never bundles or resells model access. Claude and Codex agents run
  on the **end user's own** subscription and installed CLI; Ollama/LM Studio
  models run locally under their own licenses. Keep it that way — reselling
  Anthropic/OpenAI access through your subscription would violate their
  terms.
- Public distribution needs an Apple Developer ID ($99/yr) so builds can be
  signed and notarized — macOS warns on unsigned downloads. `./sign-release.sh`
  does the whole signed + notarized + stapled build.

## Data locations (macOS)

- App state (agents, tasks, messages, settings):
  `~/Library/Application Support/com.272solutions.qivreno/`
- Agent workspaces (files agents create): `~/Qivreno/<AgentName>/`
- Both migrate automatically from the pre-rename locations on first launch.

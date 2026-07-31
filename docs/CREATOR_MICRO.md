# Macro pad control — Work Louder Creator Micro 2

Qivreno can be driven from a programmable macro pad. The integration targets the
[Work Louder Creator Micro 2](https://worklouder.cc/creator-micro-2) (13 keys,
rotary encoder, 6 layers) but works with any pad or keyboard that can emit
keyboard shortcuts.

## How it works

Qivreno registers **global keyboard shortcuts** (Settings → Macro pad). They
fire even while another app has focus, so a key press on the pad drives the
board from anywhere. There is no HID/SDK dependency — the pad just types keys.

Default bindings (editable in Settings → Macro pad → Configure):

| Windows | macOS | Action |
| ------- | ----- | ------ |
| F13 | F13 | Show the Board |
| F14 | F14 | Show Team Chat |
| F15 | F15 | Show Files |
| F16 | F16 | Show the Library |
| F17 | F17 | New task (focus the composer) |
| F18 | F18 | Open the newest task in Review |
| F19 | F19 | Approve the newest reviewed task |
| F20 | F20 | Re-run the newest failed task |
| F21 | Cmd+Ctrl+Alt+Shift+1 | Answer the agent that needs input |
| F22 | Cmd+Ctrl+Alt+Shift+2 | Pause / resume all agents |
| F23 | Cmd+Ctrl+Alt+Shift+3 | Open the Shared folder |
| F24 | Cmd+Ctrl+Alt+Shift+4 | Show / hide Qivreno |

F13-F20 are used because no OS or mainstream app claims them. Windows registers
F21-F24 too, so it uses the full F13-F24 run. macOS has no scancode above F20,
so there the last four actions use a "hyper" combo (Cmd+Ctrl+Alt+Shift) — every
pad configurator can send those. Any shortcut that fails to register is
reported in-app when you save.

If you configured the macro pad on an earlier version, Qivreno rewrites the last
four bindings to this platform's defaults on launch (a binding you changed
yourself is left as-is).

## Creator Micro 2 setup

1. In Qivreno: Settings → **Macro pad** → Configure → enable and Save.
2. In Work Louder's **Input** configurator: create a "Qivreno" layer, map the
   12 keys to the accelerators in the table's order for your platform (top-left
   key = F13), and map the encoder press to the show/hide accelerator (F24 on
   Windows, Cmd+Ctrl+Alt+Shift+4 on macOS).
3. Optional: use Input's **AppSense** to link the Qivreno layer to the Qivreno
   app, so the pad switches itself to agent control whenever Qivreno is
   focused, and back to your other layers elsewhere.

Feedback for actions that change state (approve, re-run, pause/resume) appears
as in-app toasts. Pausing affects every non-system agent; Qivvy and the
Concierge stay available.

## Implementation notes

- `src-tauri/src/micro.rs` — action table, registration (tauri-plugin-
  global-shortcut), and handlers. Board mutations run in Rust; view switches
  are emitted to the frontend as `micro-action` events.
- Settings: `micro_enabled` (default off) and `micro_bindings` (empty = the
  defaults above). Registration re-syncs on every settings save.
- Per-key LED feedback (e.g. lighting a key while agents work) would need
  Work Louder's HID protocol, which is not publicly documented — revisit if
  they publish an SDK.

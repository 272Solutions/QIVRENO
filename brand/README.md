# Qivreno brand assets

Recreated as clean vectors from the brand identity sheet (2026-07-08).

- Colors: Qivreno Blue gradient `#00C2FF → #2563FF` · Deep Navy `#0B1220` · Steel Gray `#6B7280`
- `icon.svg` — primary mark (gradient), transparent background, ring break via mask
- `icon_mono.svg` — monochrome (Deep Navy) for light surfaces
- `icon_white.svg` — reversed (white) for dark surfaces
- `app-icon.svg` / `app-icon-1024.png` — dark rounded tile; source for `src-tauri/icons/*`
  (regenerate with `npm run tauri -- icon brand/app-icon-1024.png`)
- `primary_horizontal.svg` — lockup: mark + QIVRENO + "AI Workforce Platform" tagline.
  ⚠ Wordmark uses Helvetica Neue Heavy as an approximation of the brand typeface —
  swap in the real font's outlines when the original vector files are available.

In-app usage: sidebar logo is inlined in `src/App.tsx` (same geometry); Dock/installer
icons come from `src-tauri/icons/`; dev favicon at `public/qivreno.svg`.

/* Qivreno wireframe icon set — Brand Book v1.0 visual language: thin-line,
   squared geometry, node structures and workflow paths. Mirrors the site's
   Icon.astro set. Single-color via currentColor, so every icon follows the
   surrounding text color and stays legible in both light and dark themes. */

import type { ReactElement } from "react";

export type IconName =
  | "board" | "chat" | "list" | "library" | "doc" | "file" | "folder"
  | "spark" | "rocket" | "gear" | "wand" | "target" | "question"
  | "megaphone" | "deck" | "envelope" | "recruit" | "chart" | "search"
  | "book" | "nodes" | "building" | "laptop" | "grid" | "eye" | "globe"
  | "bolt" | "wrench" | "play" | "warning" | "error" | "lock" | "card"
  | "agent" | "phone" | "calendar" | "palette" | "note" | "dot";

const PATHS: Record<IconName, ReactElement> = {
  board: (
    <>
      <rect x="3.5" y="4.5" width="4.6" height="15" />
      <rect x="9.7" y="4.5" width="4.6" height="10" />
      <rect x="15.9" y="4.5" width="4.6" height="12.5" />
      <path d="M5 7.5h1.6M11.2 7.5h1.6M17.4 7.5h1.6" />
    </>
  ),
  chat: (
    <>
      <path d="M3.5 4.5h17v11h-9l-4.5 4v-4h-3.5v-11z" />
      <path d="M7.5 8.5h9M7.5 11.5h6" />
    </>
  ),
  list: (
    <>
      <path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
      <path d="M3.5 6h1.6M3.5 12h1.6M3.5 18h1.6" />
    </>
  ),
  library: (
    <>
      <path d="M12 4.5L3.5 8.5 12 12.5l8.5-4L12 4.5z" />
      <path d="M3.5 12.5L12 16.5l8.5-4" />
      <path d="M3.5 16.5L12 20.5l8.5-4" />
    </>
  ),
  doc: (
    <>
      <path d="M6.5 3.5h8l4 4v13h-12v-17z" />
      <path d="M14.5 3.5v4h4" />
      <path d="M9.5 11h5M9.5 14h5M9.5 17h3" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 3.5h8l4 4v13h-12v-17z" />
      <path d="M14.5 3.5v4h4" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 5.5h6l2 2.5h9v11h-17v-13.5z" />
      <path d="M3.5 9.5h17" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5" />
      <path d="M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 3.5c3 2 4.5 5.5 4.5 9l-2.5 3h-4l-2.5-3c0-3.5 1.5-7 4.5-9z" />
      <circle cx="12" cy="9.5" r="1.8" />
      <path d="M7.5 12.5l-3 3.5 3.5-.5M16.5 12.5l3 3.5-3.5-.5M12 15.5v5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9L18 18M18 6l-2.1 2.1M8.1 15.9L6 18" />
    </>
  ),
  wand: (
    <>
      <path d="M4.5 19.5L15 9" />
      <path d="M15 9l-1.5-1.5 3-3L18 6l3-3" />
      <path d="M18.5 10.5v3M17 12h3M8 4v2.5M6.75 5.25h2.5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  question: (
    <>
      <path d="M8.5 8.5A3.5 3.5 0 0 1 12 5.5c1.9 0 3.5 1.3 3.5 3 0 2.2-3.5 2.6-3.5 5" />
      <path d="M12 17v1.5" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10v4h3l7 4V6l-7 4H4z" />
      <path d="M17.5 9.5a4 4 0 0 1 0 5" />
      <path d="M7 14v4h2.5" />
    </>
  ),
  deck: (
    <>
      <rect x="3.5" y="4.5" width="17" height="11" />
      <path d="M7 8.5h6M7 11.5h9" />
      <path d="M12 15.5v3M8.5 21l3.5-2.5L15.5 21" />
    </>
  ),
  envelope: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </>
  ),
  recruit: (
    <>
      <circle cx="10" cy="8" r="3.2" />
      <path d="M4.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16.5 8.5l1.8 1.8 3.2-3.6" />
    </>
  ),
  chart: (
    <>
      <path d="M4.5 4.5v15h15" />
      <path d="M8.5 15.5v-4M12.5 15.5V8M16.5 15.5v-6.5" />
      <path d="M7.5 6.5l4-1.5 4.5 2 3.5-2.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5c-1.5-1.5-4-2-7.5-2v13c3.5 0 6 .5 7.5 2 1.5-1.5 4-2 7.5-2v-13c-3.5 0-6 .5-7.5 2z" />
      <path d="M12 6.5v13" />
    </>
  ),
  nodes: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.4 6.6l7.1 1M7 8.3l3.8 7.5M16.8 10.2L13.3 16" />
    </>
  ),
  building: (
    <>
      <rect x="5.5" y="3.5" width="13" height="17" />
      <path d="M9 7h2M13 7h2M9 10.5h2M13 10.5h2M9 14h2M13 14h2" />
      <path d="M10.5 20.5v-3h3v3" />
    </>
  ),
  laptop: (
    <>
      <rect x="5.5" y="5.5" width="13" height="9" />
      <path d="M3.5 18.5h17l-2-4M5.5 14.5l-2 4" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12c2.5-4.5 6-6.5 9.5-6.5s7 2 9.5 6.5c-2.5 4.5-6 6.5-9.5 6.5S5 16.5 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z" />
    </>
  ),
  bolt: <path d="M13.5 3L6 13.5h5L10.5 21 18 10.5h-5L13.5 3z" />,
  wrench: (
    <>
      <path d="M14.5 7.5a4 4 0 0 1 5-5l-3 3 .5 2.5 2.5.5 3-3a4 4 0 0 1-5 5l-8 8a1.8 1.8 0 0 1-2.5-2.5l8-8z" transform="translate(-1.5 -0.5)" />
    </>
  ),
  play: <path d="M8 5.5l10 6.5-10 6.5v-13z" />,
  warning: (
    <>
      <path d="M12 4L2.5 20h19L12 4z" />
      <path d="M12 10v4.5M12 17v.5" />
    </>
  ),
  error: (
    <>
      <rect x="4" y="4" width="16" height="16" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <path d="M12 14v2.5" />
    </>
  ),
  card: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" />
      <path d="M3.5 9.5h17M6.5 14.5h5" />
    </>
  ),
  agent: (
    <>
      <rect x="5.5" y="8.5" width="13" height="10" />
      <path d="M12 8.5V5M12 5h.01" />
      <circle cx="12" cy="4.5" r="1" />
      <path d="M9 12.5v1.5M15 12.5v1.5" />
      <path d="M3.5 12v3M20.5 12v3" />
    </>
  ),
  phone: (
    <>
      <rect x="7.5" y="3.5" width="9" height="17" />
      <path d="M10.5 17.5h3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5.5" width="17" height="14" />
      <path d="M3.5 9.5h17M8 3.5v4M16 3.5v4" />
      <path d="M7.5 13h2M11 13h2M14.5 13h2M7.5 16h2M11 16h2" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.5 0 2-1 1.5-2s0-2 1.5-2h2a3.5 3.5 0 0 0 3.5-3.5c0-5.5-4-9.5-8.5-9.5z" />
      <path d="M7.5 10.5h.01M11 7.5h.01M15.5 8.5h.01" />
      <circle cx="7.5" cy="10.5" r="0.4" />
      <circle cx="11" cy="7.5" r="0.4" />
      <circle cx="15.5" cy="8.5" r="0.4" />
    </>
  ),
  note: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" />
      <path d="M8 8.5h8M8 11.5h8M8 14.5h5" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="1.6" />,
};

export function Icon(props: { name: IconName; size?: number | string; className?: string }) {
  const size = props.size ?? "1em";
  return (
    <svg
      className={`wf-icon${props.className ? ` ${props.className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {PATHS[props.name]}
    </svg>
  );
}

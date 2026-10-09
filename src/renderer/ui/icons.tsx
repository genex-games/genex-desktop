/**
 * The Genex icon set: line glyphs on one 24-unit grid with a 1.75 stroke, round caps and joins.
 * Parts marked `a-*` move once when the enclosing control is hovered or focused; the motion
 * lives in styles/icons.css and stops under Reduce Motion. Dots are the only fills.
 */
import type { JSX, ReactNode } from "react";

const DOT = { fill: "currentColor", stroke: "none" } as const;
const FOLDER =
  "M3.5 17V7A2.5 2.5 0 0 1 6 4.5h3.2a2 2 0 0 1 1.5.7l1.1 1.3a2 2 0 0 0 1.5.7H18A2.5 2.5 0 0 1 20.5 9.7V17a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17z";
const GEAR =
  "M9.08 5.97Q9.82 5.67 9.87 4.87L9.93 3.92Q9.99 2.92 10.97 2.76A9.3 9.3 0 0 1 13.03 2.76Q14.01 2.92 14.07 3.92L14.13 4.87Q14.18 5.67 14.92 5.97A6.7 6.7 0 0 1 15.76 6.46Q16.4 6.94 17.11 6.59L17.96 6.16Q18.86 5.72 19.49 6.49A9.3 9.3 0 0 1 20.52 8.27Q20.87 9.2 20.04 9.76L19.24 10.28Q18.58 10.72 18.68 11.51A6.7 6.7 0 0 1 18.68 12.49Q18.58 13.28 19.24 13.72L20.04 14.24Q20.87 14.8 20.52 15.73A9.3 9.3 0 0 1 19.49 17.51Q18.86 18.28 17.96 17.84L17.11 17.41Q16.4 17.06 15.76 17.54A6.7 6.7 0 0 1 14.92 18.03Q14.18 18.33 14.13 19.13L14.07 20.08Q14.01 21.08 13.03 21.24A9.3 9.3 0 0 1 10.97 21.24Q9.99 21.08 9.93 20.08L9.87 19.13Q9.82 18.33 9.08 18.03A6.7 6.7 0 0 1 8.24 17.54Q7.6 17.06 6.89 17.41L6.04 17.84Q5.14 18.28 4.51 17.51A9.3 9.3 0 0 1 3.48 15.73Q3.13 14.8 3.96 14.24L4.76 13.72Q5.42 13.28 5.32 12.49A6.7 6.7 0 0 1 5.32 11.51Q5.42 10.72 4.76 10.28L3.96 9.76Q3.13 9.2 3.48 8.27A9.3 9.3 0 0 1 4.51 6.49Q5.14 5.72 6.04 6.16L6.89 6.59Q7.6 6.94 8.24 6.46A6.7 6.7 0 0 1 9.08 5.97Z";
const SPEAKER = "M3.5 10A1.5 1.5 0 0 1 5 8.5h2.3L11.5 5v14l-4.2-3.5H5A1.5 1.5 0 0 1 3.5 14z";
const INFINITY =
  "M12 12c-2-2.6-3.6-4-5.4-4a4 4 0 0 0 0 8c1.8 0 3.4-1.4 5.4-4zm0 0c2 2.6 3.6 4 5.4 4a4 4 0 0 0 0-8c-1.8 0-3.4 1.4-5.4 4z";

const glyphs = {
  "new-game": (
    <>
      <path d="M11 4.5H7.5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V13" />
      <path className="a-ink" pathLength={1} d="M7.8 16.4c1-.9 2-.9 3 0" />
      <g className="a-pen">
        <path d="M17.4 4.1a1.9 1.9 0 0 1 2.6 2.6l-6.9 6.9-3.3.8.8-3.3z" />
      </g>
    </>
  ),
  // The plug itself, tilted: it pushes in along its pins with a small spark.
  plugins: (
    <g transform="rotate(45 12 12)">
      <g className="a-plug">
        <path d="M9 3.5V7M15 3.5V7" />
        <path d="M6.5 8.5A1.5 1.5 0 0 1 8 7h8a1.5 1.5 0 0 1 1.5 1.5v2a5.5 5.5 0 0 1-11 0z" />
      </g>
      <path className="a-cord" d="M12 16v4.5" />
      <path className="a-zap" d="M6.4 3.4L4.9 2.2M17.6 3.4l1.5-1.2" />
    </g>
  ),
  // Decode: a scan frame over three lines of code; the scan passes and the lines write back in.
  harness: (
    <>
      <path d="M4 8.5V7a3 3 0 0 1 3-3h1.5M15.5 4H17a3 3 0 0 1 3 3v1.5M20 15.5V17a3 3 0 0 1-3 3h-1.5M8.5 20H7a3 3 0 0 1-3-3v-1.5" />
      <path className="a-l1" pathLength={1} d="M8.5 9h4.5" />
      <path className="a-l2" pathLength={1} d="M10.5 12h5" />
      <path className="a-l3" pathLength={1} d="M8.5 15h3.5" />
      <path className="a-scan" d="M6.5 12h11" />
    </>
  ),
  settings: (
    <g className="a-gear6">
      <path d={GEAR} />
      <circle cx="12" cy="12" r="2.6" />
    </g>
  ),
  rename: (
    <>
      <path className="a-ink" pathLength={1} d="M5 19.5h5" />
      <g className="a-pen">
        <path d="M15.6 4.4a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4z" />
      </g>
    </>
  ),
  search: (
    <g className="a-lens">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
      <path d="M8.1 9.1a2.8 2.8 0 0 1 2-1.9" strokeOpacity={0.5} />
    </g>
  ),
  // The bell swings from its hanger, the clapper lags behind it, and two sound marks flash.
  bell: (
    <>
      <g className="a-ring">
        <path d="M5.75 16.75h12.5c-.95-.95-1.55-2.15-1.55-3.5V10.3a4.7 4.7 0 0 0-9.4 0v2.95c0 1.35-.6 2.55-1.55 3.5z" />
        <path d="M12 3.6v2" />
        <path className="a-clap" d="M10.1 19.5a1.9 1.9 0 0 0 3.8 0" />
      </g>
      <path className="a-waves" d="M3.6 9.6a8 8 0 0 1 1.7-3.7M20.4 9.6a8 8 0 0 0-1.7-3.7" />
    </>
  ),
  // Send feedback: a beetle seen from above, head, antennae and three legs a side.
  bug: (
    <>
      <path d="M9.5 9.2a2.5 2.5 0 0 1 5 0" />
      <path d="M10.4 7.3 9 5.6M13.6 7.3 15 5.6" />
      <path d="M8 13a4 4 0 0 1 8 0v3a4 4 0 0 1-8 0z" />
      <path d="M8.6 11 5.6 9.4M15.4 11l3-1.6M8 14.5H4.5M16 14.5h3.5M8.3 17.5l-2.8 1.9M15.7 17.5l2.8 1.9" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
      <path className="a-divider" d="M9.5 4.5v15" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
      <path className="a-prompt" d="M7.5 9.5l2.8 2.5-2.8 2.5" />
      <path className="a-cursor" d="M13 14.5h3.5" />
    </>
  ),
  folder: (
    <>
      <path d={FOLDER} />
      <path className="a-paper" d="M7.5 8.6h9" />
      <path className="a-flap" d="M3.5 11h17" />
    </>
  ),
  "folder-plus": (
    <>
      <path d={FOLDER} />
      <g className="a-rot">
        <path d="M12 10.5v6M9 13.5h6" />
      </g>
    </>
  ),
  "folder-open": (
    <>
      <path d={FOLDER} />
      <path d="M8.5 13.5h6M12.5 11l2.5 2.5-2.5 2.5" />
    </>
  ),
  dice: (
    <>
      <path d="M7.5 4h9A3.5 3.5 0 0 1 20 7.5v9a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16.5v-9A3.5 3.5 0 0 1 7.5 4z" />
      <path d="M8.75 8.75h.01M15.25 8.75h.01M12 12h.01M8.75 15.25h.01M15.25 15.25h.01" strokeWidth={2.4} />
    </>
  ),
  export: (
    <>
      <path d="M4.5 14.5V17a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-2.5" />
      <g className="a-up">
        <path d="M12 15V4.5M8 8.5l4-4 4 4" />
      </g>
    </>
  ),
  more: (
    <>
      <circle className="a-d1" cx="5.5" cy="12" r="1.4" {...DOT} />
      <circle className="a-d2" cx="12" cy="12" r="1.4" {...DOT} />
      <circle className="a-d3" cx="18.5" cy="12" r="1.4" {...DOT} />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <ellipse className="a-meridian" cx="12" cy="12" rx="3.7" ry="8.5" />
    </>
  ),
  reload: (
    <g className="a-spin">
      <path d="M20 12a8 8 0 1 1-8-8c2.2 0 4.2.9 5.7 2.3L20 8.5" />
      <path d="M20 4v4.5h-4.5" />
    </g>
  ),
  // Reload, mirrored: the arrow turns back a little, the way the chat goes back.
  rewind: (
    <g className="a-rewind">
      <path d="M4 12a8 8 0 1 0 8-8c-2.2 0-4.2.9-5.7 2.3L4 8.5" />
      <path d="M4 4v4.5h4.5" />
    </g>
  ),
  play: (
    <g className="a-nudge">
      <path
        transform="translate(-1.2 0)"
        d="M8 5.8v12.4a1 1 0 0 0 1.5.86l10-6.2a1 1 0 0 0 0-1.72l-10-6.2A1 1 0 0 0 8 5.8z"
      />
    </g>
  ),
  stop: <rect className="a-pulse" x="6.5" y="6.5" width="11" height="11" rx="2.5" />,
  // Full screen: the four corners pushed out to the edges.
  expand: (
    <path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15" />
  ),
  send: (
    <g className="a-up">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </g>
  ),
  // Opens a page outside the app.
  // Code brackets: making something of your own.
  code: (
    <>
      <path d="M9 7.5L4.5 12 9 16.5" />
      <path d="M15 7.5l4.5 4.5-4.5 4.5" />
    </>
  ),
  "arrow-up-right": (
    <g className="a-up">
      <path d="M7 17L17 7M9 7h8v8" />
    </g>
  ),
  attach: (
    <g className="a-wig">
      <path d="M19.5 11.5l-7.6 7.6a4.8 4.8 0 0 1-6.8-6.8l8.1-8.1a3.2 3.2 0 0 1 4.5 4.5l-8 8a1.6 1.6 0 0 1-2.3-2.3l7.3-7.3" />
    </g>
  ),
  pin: (
    <g className="a-pin">
      <path d="M9 4h6M10 4v5l-3.2 3.4V15h10.4v-2.6L14 9V4M12 15v5.5" />
    </g>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
      <circle className="a-sun" cx="9" cy="9.8" r="1.6" />
      <path d="M20.2 15.2l-4-4a1.5 1.5 0 0 0-2.1 0L5.5 19.3" />
    </>
  ),
  // A camera the game is seen through: the lens closes like a shutter.
  camera: (
    <>
      <path d="M3.5 9.5A2.5 2.5 0 0 1 6 7h2.2l1.3-2h5l1.3 2H18a2.5 2.5 0 0 1 2.5 2.5V17a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17z" />
      <circle className="a-pulse" cx="12" cy="13" r="3.5" />
    </>
  ),
  trash: (
    <>
      <g className="a-lid">
        <path d="M4.5 7h15M9.5 7V5.5a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3V7" />
      </g>
      <path d="M6.5 7l.8 11.1a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7M10.2 11v5M13.8 11v5" />
    </>
  ),
  close: (
    <g className="a-rot">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </g>
  ),
  plus: (
    <g className="a-rot">
      <path d="M12 5v14M5 12h14" />
    </g>
  ),
  minus: <path d="M5 12h14" />,
  "chevron-left": (
    <g className="a-px">
      <path d="M14.5 6l-6 6 6 6" />
    </g>
  ),
  "chevron-right": (
    <g className="a-nx">
      <path d="M9.5 6l6 6-6 6" />
    </g>
  ),
  "chevron-down": (
    <g className="a-ny">
      <path d="M6 9.5l6 6 6-6" />
    </g>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 12l3 2" />
      <path className="a-hand" d="M12 12V7" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <g className="a-bob">
        <path d="M12 11v5" />
        <circle cx="12" cy="8" r="1.1" {...DOT} />
      </g>
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <g className="a-bob">
        <path d="M9.7 9.6a2.4 2.4 0 0 1 4.7.7c0 1.6-2.4 2-2.4 3.5" />
        <circle cx="12" cy="16.7" r="1.1" {...DOT} />
      </g>
    </>
  ),
  file: (
    <>
      <path d="M13.5 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8.5z" />
      <path d="M13.5 3.5v5h5" />
    </>
  ),
  plan: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="3" />
      <path className="a-l1" pathLength={1} d="M8.5 8.5h7" />
      <path className="a-l2" pathLength={1} d="M8.5 12h7" />
      <path className="a-l3" pathLength={1} d="M8.5 15.5h4" />
    </>
  ),
  // A lightbulb: Add's Plan mode, a plan before anything is built (its row and the bulb that shows it).
  bulb: (
    <>
      <path d="M9.5 15.5c0-1.2-.6-2-1.4-2.9a5.5 5.5 0 1 1 7.8 0c-.8.9-1.4 1.7-1.4 2.9" />
      <path d="M9.5 18h5" />
      <path d="M10.5 20.5h3" />
    </>
  ),
  copy: (
    <>
      <path className="a-back" d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
      <rect className="a-front" x="9" y="9" width="11" height="11" rx="2.5" />
    </>
  ),
  check: <path className="a-draw" pathLength={1} d="M5 12.5l4.5 4.5L19 7.5" />,
  // A shield whose check draws in: what Claude may do without asking (Permissions, Auto).
  shield: (
    <>
      <path d="M12 3.5l7 2.6v5.2c0 4.3-2.9 7.7-7 9.2-4.1-1.5-7-4.9-7-9.2V6.1z" />
      <path className="a-draw" pathLength={1} d="M8.9 12.1l2.1 2.1 4.1-4.2" />
    </>
  ),
  // The same shield struck through: nothing is asked first (Bypass permissions).
  "shield-off": (
    <>
      <path d="M12 3.5l7 2.6v5.2c0 4.3-2.9 7.7-7 9.2-4.1-1.5-7-4.9-7-9.2V6.1z" />
      <path className="a-draw" pathLength={1} d="M4.5 4.5l15 15" />
    </>
  ),
  // The judges' look at a build: the pupil glances across.
  eye: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle className="a-nx" cx="12" cy="12" r="2.6" />
    </>
  ),
  // Thrown away, back to the build before it.
  undo: (
    <g className="a-px">
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
      <path d="M4.5 4.5V9H9" />
    </g>
  ),
  // The Assets tab: four tiles, as the canvas lays files out.
  assets: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" />
    </>
  ),
  box: (
    <g className="a-lift">
      <path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7z" />
      <path d="M4.5 7.7L12 12l7.5-4.3M12 12v8.5" />
    </g>
  ),
  boxes: (
    <g transform="translate(-.5 0)">
      <g className="a-b1">
        <path d="M8 6l4.5 2.6v5L8 16.2l-4.5-2.6v-5z" />
        <path d="M3.5 8.6L8 11.2l4.5-2.6M8 11.2v5" />
      </g>
      <g className="a-b2">
        <path d="M17 8l4.5 2.6v5L17 18.2l-4.5-2.6v-5z" />
        <path d="M12.5 10.6L17 13.2l4.5-2.6M17 13.2v5" />
      </g>
    </g>
  ),
  // A figure: the head nods once.
  character: (
    <>
      <g className="a-bob">
        <circle cx="12" cy="8" r="3.5" />
      </g>
      <path d="M5 20c.6-3.8 3.4-6.2 7-6.2s6.4 2.4 7 6.2" />
    </>
  ),
  // Level meter: the bars rise back in one after another.
  sound: (
    <>
      <path className="a-l1" pathLength={1} d="M5 14V10" />
      <path className="a-l2" pathLength={1} d="M8.5 17V7" />
      <path className="a-l3" pathLength={1} d="M12 20V4" />
      <path className="a-l2" pathLength={1} d="M15.5 16V8" />
      <path className="a-l1" pathLength={1} d="M19 13.5v-3" />
    </>
  ),
  // The Live game's sound: the waves draw out from the speaker.
  speaker: (
    <>
      <path d={SPEAKER} />
      <path className="a-l1" pathLength={1} d="M15 9.5a3.5 3.5 0 0 1 0 5" />
      <path className="a-l2" pathLength={1} d="M17.8 6.8a7.3 7.3 0 0 1 0 10.4" />
    </>
  ),
  // Sound off: the same speaker, crossed out; the stroke draws across it again.
  "speaker-off": (
    <>
      <path d={SPEAKER} />
      <path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.8 6.8a7.3 7.3 0 0 1 0 10.4" />
      <path className="a-l1" pathLength={1} d="M4 4l16 16" />
    </>
  ),
  // A credit: the coin flips once on its edge.
  coin: (
    <g className="a-meridian">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.2l1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1 2.7-1.1z" />
    </g>
  ),
  chat: (
    <g className="a-wig">
      <path d="M20 11.5c0 4.1-3.6 7.5-8 7.5-1.2 0-2.3-.2-3.3-.7L4.5 19.5l1.2-3.6A7.2 7.2 0 0 1 4 11.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5z" />
    </g>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H17a3.5 3.5 0 0 0 3.5-3.5c0-4.1-3.8-7.5-8.5-7.5z" />
      <circle className="a-p1" cx="7.8" cy="11.6" r="1.15" {...DOT} />
      <circle className="a-p2" cx="9.6" cy="7.7" r="1.15" {...DOT} />
      <circle className="a-p3" cx="14.2" cy="7.7" r="1.15" {...DOT} />
    </>
  ),
  infinity: (
    <>
      <path strokeOpacity={0.4} d={INFINITY} />
      <path className="a-trace" pathLength={1} d={INFINITY} />
    </>
  ),
  circle: <circle className="a-pulse" cx="12" cy="12" r="7" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs;
/** `strokeWidth` is for glyphs drawn smaller than 12px, where the set's 1.75 would thin to a hairline. */
export function Icon({
  name,
  size = 16,
  className = "",
  strokeWidth = 1.75,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`gi shrink-0 ${className}`}
    >
      {glyphs[name]}
    </svg>
  );
}

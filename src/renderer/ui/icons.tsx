/**
 * The Genex icon set: line glyphs on one 24-unit grid with a 1.75 stroke, round caps and joins.
 * Parts marked `a-*` move once when the enclosing control is hovered or focused; the motion
 * lives in styles/icons.css and stops under Reduce Motion. Dots, carets and the marks of Unity,
 * Roblox, Apple and Windows are the only fills.
 */
import type { JSX, ReactNode } from "react";

const DOT = { fill: "currentColor", stroke: "none" } as const;
const FOLDER =
  "M3.5 17V7A2.5 2.5 0 0 1 6 4.5h3.2a2 2 0 0 1 1.5.7l1.1 1.3a2 2 0 0 0 1.5.7H18A2.5 2.5 0 0 1 20.5 9.7V17a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17z";
const GEAR =
  "M9.08 5.97Q9.82 5.67 9.87 4.87L9.93 3.92Q9.99 2.92 10.97 2.76A9.3 9.3 0 0 1 13.03 2.76Q14.01 2.92 14.07 3.92L14.13 4.87Q14.18 5.67 14.92 5.97A6.7 6.7 0 0 1 15.76 6.46Q16.4 6.94 17.11 6.59L17.96 6.16Q18.86 5.72 19.49 6.49A9.3 9.3 0 0 1 20.52 8.27Q20.87 9.2 20.04 9.76L19.24 10.28Q18.58 10.72 18.68 11.51A6.7 6.7 0 0 1 18.68 12.49Q18.58 13.28 19.24 13.72L20.04 14.24Q20.87 14.8 20.52 15.73A9.3 9.3 0 0 1 19.49 17.51Q18.86 18.28 17.96 17.84L17.11 17.41Q16.4 17.06 15.76 17.54A6.7 6.7 0 0 1 14.92 18.03Q14.18 18.33 14.13 19.13L14.07 20.08Q14.01 21.08 13.03 21.24A9.3 9.3 0 0 1 10.97 21.24Q9.99 21.08 9.93 20.08L9.87 19.13Q9.82 18.33 9.08 18.03A6.7 6.7 0 0 1 8.24 17.54Q7.6 17.06 6.89 17.41L6.04 17.84Q5.14 18.28 4.51 17.51A9.3 9.3 0 0 1 3.48 15.73Q3.13 14.8 3.96 14.24L4.76 13.72Q5.42 13.28 5.32 12.49A6.7 6.7 0 0 1 5.32 11.51Q5.42 10.72 4.76 10.28L3.96 9.76Q3.13 9.2 3.48 8.27A9.3 9.3 0 0 1 4.51 6.49Q5.14 5.72 6.04 6.16L6.89 6.59Q7.6 6.94 8.24 6.46A6.7 6.7 0 0 1 9.08 5.97Z";
const SPEAKER = "M3.5 10A1.5 1.5 0 0 1 5 8.5h2.3L11.5 5v14l-4.2-3.5H5A1.5 1.5 0 0 1 3.5 14z";
const MIC_BODY = "M9 6.5a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0z";
const MIC_STAND = "M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v2.8";
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
  // Unreal's U in its ring, as the Unreal plugin's own picture draws it, in line.
  unreal: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 7.75v5a3 3 0 0 0 6 0v-5" />
    </>
  ),
  // Godot's head as the Godot plugin's own picture draws it, in line: two antennae, two eyes, a mouth.
  godot: (
    <>
      <rect x="4" y="7.5" width="16" height="12" rx="4" />
      <path d="M8.5 7.5 7.5 4.5M15.5 7.5l1-3M10 16h4" />
      <circle cx="9.5" cy="12.5" r="1.4" {...DOT} />
      <circle cx="14.5" cy="12.5" r="1.4" {...DOT} />
    </>
  ),
  // Unity's own mark, as the Unity plugin's picture draws it, filled: a line copy would no longer be Unity's.
  unity: (
    <path
      transform="translate(3.6 3.6) scale(.7)"
      d="m12.9288 4.2939 3.7997 2.1929c.1366.077.1415.2905 0 .3675l-4.515 2.6076a.4192.4192 0 0 1-.4246 0L7.274 6.8543c-.139-.0745-.1415-.293 0-.3675l3.7972-2.193V0L1.3758 5.5977V16.793l3.7177-2.1456v-4.3858c-.0025-.1565.1813-.2682.318-.1838l4.5148 2.6076a.4252.4252 0 0 1 .2136.3676v5.2127c.0025.1565-.1813.2682-.3179.1838l-3.7996-2.1929-3.7178 2.1457L12 24l9.6954-5.5977-3.7178-2.1457-3.7996 2.1929c-.1341.082-.3229-.0248-.3179-.1838V13.053c0-.1565.087-.2956.2136-.3676l4.5149-2.6076c.134-.082.3228.0224.3179.1838v4.3858l3.7177 2.1456V5.5977L12.9288 0Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  // Roblox's tilted square with its square hole, as the Roblox Studio plugin's picture draws it, filled.
  roblox: (
    <path
      transform="rotate(15 12 12)"
      fillRule="evenodd"
      d="M5.5 5.5h13v13h-13zM10.25 10.25v3.5h3.5v-3.5z"
      fill="currentColor"
      stroke="none"
    />
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
  // Paused: two bars, the stop's size and corners.
  pause: (
    <g className="a-pulse">
      <rect x="7" y="6.5" width="3.5" height="11" rx="1.2" />
      <rect x="13.5" y="6.5" width="3.5" height="11" rx="1.2" />
    </g>
  ),
  // Full screen: the four corners pushed out to the edges.
  expand: (
    <path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15" />
  ),
  // A played game's full screen, as genex.games' game page draws it: two arrows out to opposite corners.
  maximize: <path d="M14.5 4H20v5.5M20 4l-6.5 6.5M9.5 20H4v-5.5M4 20l6.5-6.5" />,
  // The Apple and Windows marks a native game's card and page name its systems by, filled like Unity's.
  apple: (
    <path
      d="M16.4 12.6c0-2.4 2-3.5 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.2.7c1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7 0 0-2.4-1-2.4-4zM14 5.3c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z"
      fill="currentColor"
      stroke="none"
    />
  ),
  windows: (
    <path
      d="M3 5.5 10.5 4.5v7H3zM12 4.3 21 3v8.5h-9zM3 12.5h7.5v7L3 18.5zM12 12.5h9V21l-9-1.3z"
      fill="currentColor"
      stroke="none"
    />
  ),
  /** Linux's Tux with his belly line (Simple Icons' path without the feet lines), 5% smaller than the box. */
  linux: (
    <path
      d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7z"
      transform="translate(0.6 0.6) scale(0.95)"
      fill="currentColor"
      fillRule="evenodd"
      stroke="none"
    />
  ),
  /** A download: an arrow falling onto a tray. */
  download: (
    <>
      <g className="a-nudge">
        <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
      </g>
      <path d="M5 19.5h14" />
    </>
  ),
  /** A window of its own: a game's, brought forward. */
  window: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 9h18" />
    </>
  ),
  /** An update waiting: an arrow rising in a ring. */
  update: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <g className="a-up">
        <path d="M12 16V8.5M8.75 11.5L12 8.25l3.25 3.25" />
      </g>
    </>
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
  // Save: a ribbon bookmark. Saved draws it filled (`.gi-filled` in styles/asset-library.css).
  bookmark: <path d="M7.5 4.5h9a1 1 0 0 1 1 1v14.2l-5.5-3.9-5.5 3.9V5.5a1 1 0 0 1 1-1z" />,
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
  // A four-point sparkle and a small one: something a model makes (home's Make your own background).
  sparkle: (
    <>
      <path d="M11 3.5c.7 4.4 2.3 6 6.75 6.75-4.45.75-6.05 2.35-6.75 6.75-.7-4.4-2.3-6-6.75-6.75C8.7 9.5 10.3 7.9 11 3.5z" />
      <path d="M18.5 15.5v4.5M16.25 17.75h4.5" />
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
  // The Builds tab: two steps joined, as the run's graph draws them.
  graph: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
      <path d="M7 10.5V14a3 3 0 0 0 3 3h3.5" />
    </>
  ),
  // A heart: it beats once. A liked one is filled (`fill` on the glyph's path).
  heart: <path className="a-pulse" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  // A pad: it bobs once, the way a hand picks it up.
  gamepad: (
    <g className="a-bob">
      <path d="M7.5 6.5h9a4 4 0 0 1 3.95 3.37l.85 5.4a2.5 2.5 0 0 1-4.37 2.03L15.5 15.5h-7l-1.43 1.8A2.5 2.5 0 0 1 2.7 15.27l.85-5.4A4 4 0 0 1 7.5 6.5z" />
      <path d="M8 9.5V13M6.25 11.25h3.5" />
      <path d="M15.5 10.5h.01M17.5 12.5h.01" strokeWidth={2.4} />
    </g>
  ),
  // A wrench: it twists once, as if tightening.
  wrench: (
    <g className="a-wig">
      <path d="M14.5 6.5a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a5.5 5.5 0 0 1-7.3 7.3l-6.6 6.6a2.05 2.05 0 0 1-2.9-2.9l6.6-6.6a5.5 5.5 0 0 1 7.3-7.3z" />
    </g>
  ),
  /** A screen on its stand: Genex does the work on this computer. */
  computer: (
    <g>
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </g>
  ),
  box: (
    <g className="a-lift">
      <path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7z" />
      <path d="M4.5 7.7L12 12l7.5-4.3M12 12v8.5" />
    </g>
  ),
  // Create › Items: a stack of three sheets, the top one lifting.
  layers: (
    <>
      <path className="a-lift" d="M12 4l8 4.2-8 4.2-8-4.2z" />
      <path d="M4 12.2l8 4.2 8-4.2M4 16l8 4.2 8-4.2" />
    </>
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
  // A figure with a plus beside it: asking someone to be a friend. The head nods once.
  "user-plus": (
    <>
      <g className="a-bob">
        <circle cx="9.5" cy="8.5" r="3.2" />
      </g>
      <path d="M4 19.5c.5-3.4 2.8-5.5 5.5-5.5s5 2.1 5.5 5.5M18.5 8v6M15.5 11h6" />
    </>
  ),
  // A door and an arrow leaving through it: signing out.
  "sign-out": (
    <>
      <path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10" />
      <path d="M14.5 8l4 4-4 4M18.5 12H9" />
    </>
  ),
  // Up and down chevrons: a control that opens a menu above or below.
  chevrons: <path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" />,
  // Two links of a chain: an address to share.
  link: (
    <>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </>
  ),
  // Two figures side by side, for players together: the front head nods once.
  users: (
    <>
      <g className="a-bob">
        <circle cx="9" cy="8.5" r="3.2" />
      </g>
      <path d="M3.5 19.5c.5-3.4 2.8-5.5 5.5-5.5s5 2.1 5.5 5.5" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.3c1.6.8 2.7 2.6 3 5.2" />
    </>
  ),
  // A fork: one game, two ways on.
  remix: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="17.5" cy="5.5" r="2" />
      <circle cx="12" cy="18.5" r="2" />
      <path d="M6.5 7.5v.8a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3v-.8M12 11.3v5.2" />
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
  // A game's voice chat, heard: the microphone, and its pickup arc drawing out.
  mic: (
    <>
      <path d={MIC_BODY} />
      <path className="a-l1" pathLength={1} d={MIC_STAND} />
    </>
  ),
  // Not heard: the same microphone, crossed out; the stroke draws across it again.
  "mic-off": (
    <>
      <path d={MIC_BODY} />
      <path d={MIC_STAND} />
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
  // Compact: two corners drawn in toward the middle, the context folding smaller.
  compact: <path d="M4.5 14h5.5v5.5M19.5 10H14V4.5M14 10l6-6M4 20l6-6" />,
  // A drive: where Genex keeps what it makes on this Mac.
  drive: (
    <>
      <path d="M3.5 13l2.6-6.1A2.2 2.2 0 0 1 8.1 5.5h7.8a2.2 2.2 0 0 1 2 1.4l2.6 6.1V17a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17z" />
      <path d="M3.5 13h17" />
      <circle cx="7.5" cy="16.25" r="1" {...DOT} />
    </>
  ),
  // A model chip: the die and its pins, for models that run on this Mac.
  chip: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
    </>
  ),
  /** A film camera: video. */
  video: (
    <>
      <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  /** Two notes: music. */
  music: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  /** A pulse: an animation clip. */
  motion: <path d="M4 12h3.5l2-6 4 12 2-6H20" />,
  /** Four tiles: a texture set. */
  tiles: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </>
  ),
  /** A tag with its hole: a game's tags. */
  tag: (
    <>
      <path d="M4 12.6V5.5A1.5 1.5 0 0 1 5.5 4h7.1a1.5 1.5 0 0 1 1 .4l6.1 6.1a1.5 1.5 0 0 1 0 2.1l-7.1 7.1a1.5 1.5 0 0 1-2.1 0l-6.1-6.1a1.5 1.5 0 0 1-.4-1z" />
      <circle cx="8.5" cy="8.5" r="1.3" {...DOT} />
    </>
  ),
  /** An eye struck through: taken out of sight. */
  "eye-off": (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5c1.6 0 3 .5 4.2 1.2M21.5 12s-3.5 6.5-9.5 6.5c-1.6 0-3-.5-4.2-1.2" />
      <path d="M4 20L20 4" />
    </>
  ),
  /** A closed padlock. */
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  /** A small triangle up or down: a number that rose or fell. */
  "caret-up": <path d="M12 7l6 9H6z" fill="currentColor" stroke="none" />,
  "caret-down": <path d="M12 17l6-9H6z" fill="currentColor" stroke="none" />,
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

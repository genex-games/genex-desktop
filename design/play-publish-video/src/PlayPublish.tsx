/**
 * The Play publish film. The app sits as a window on a dark desk, and the camera moves over it the
 * way a screen recording is edited: from the whole window it zooms in on Publish as the cursor
 * clicks it, eases back to the dialog that tests the game, makes it public and sends the cover, and
 * holds on "Live on Play". It pulls out and in again on the Play switch in the sidebar, then follows
 * the cursor to the dashboard, where the game appears first in the grid and players join it. It
 * zooms out to the whole window, which turns back to Create, and the loop starts again.
 * Everything is in the app's own pixels (`APP`); `camera` places them in the 760×400 frame.
 */
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, Img, staticFile, useCurrentFrame } from "remotion";
import { CURSOR_EASE, camera, EASE_IN_OUT, keys, type Shot } from "./motion";
import { APP, C, FRAMES, H, MONO, SANS, W } from "./theme";

const cover = (name: string) => staticFile(`covers/${name}.webp`);
const HERO = cover("midnight-asphalt-pursuit");
/** The game the film publishes. */
const GAME = { title: "Midnight Asphalt Pursuit", page: "genex.games/midnight-asphalt-pursuit" } as const;
const RECENT = [
  { title: "SKATE", src: cover("skate") },
  { title: "The Long Silence", src: cover("the-long-silence") },
  { title: "Skate Dog", src: cover("skate-dog") },
] as const;
const GRID = [
  { title: "Opus 5.5 NBA 2K", src: cover("opus-nba-2k") },
  { title: "Stick & Steel", src: cover("stick-and-steel") },
  { title: "SKATE", src: cover("skate") },
  { title: "The Long Silence", src: cover("the-long-silence") },
  { title: "wildfire", src: cover("wildfire") },
] as const;
/** The maker's other games in Create's sidebar: names only, each with a coloured mark. */
const PROJECTS = [
  { title: "Neon Drift", hue: "#7a5cff" },
  { title: "Tiny Tanks", hue: "#3fb27f" },
  { title: "Moonbase", hue: "#d9894a" },
] as const;

/** The app's layout, in its own pixels. */
const L = {
  pill: { x: 16, y: 70, width: 168, height: 32 },
  publish: { x: 840, y: 8, width: 108, height: 32 },
  dialog: { x: 580, y: 324, width: 330 },
  grid: { x: 224, y: 100, gap: 16, column: 226 },
} as const;
/** Where the cursor presses: the middle of Publish and of the switch's Play half. */
const PUBLISH_AT = { x: L.publish.x + L.publish.width / 2, y: L.publish.y + L.publish.height / 2 };
const PLAY_AT = { x: L.pill.x + L.pill.width / 4 + 1, y: L.pill.y + L.pill.height / 2 };
const CARD_COVER = { width: L.grid.column, height: (L.grid.column * 9) / 16 };

/** The story, in film frames (30 a second). */
const T = {
  pressPublish: 64,
  dialogIn: [80, 96],
  steps: [100, 120, 140, 160],
  liveIn: [162, 174],
  /** Players fly in from all round and land in the stack, one after another, while the count rolls up. */
  landings: [180, 187, 194, 201, 208, 215],
  count: [176, 230],
  dialogOut: [240, 252],
  pressPlay: 274,
  /** The switch answers the press at once; the page follows. */
  pill: [274, 281],
  /** Create turns into Play, and back to Create for the loop. */
  toPlay: [276, 292],
  toCreate: [364, 382],
  cardIn: [310, 324],
  online: [328, 340],
  hover: [324, 332, 350, 362],
} as const;

/** The camera: the whole window, Publish, the dialog (a punch in as it goes live), the switch, the new game, the whole window. */
const SHOTS: readonly Shot[] = [
  { f: 0, x: 480, y: 300, z: 0.588 },
  { f: 20, x: 480, y: 300, z: 0.588 },
  { f: 60, x: 842, y: 72, z: 2.3 },
  { f: 76, x: 848, y: 70, z: 2.36 },
  { f: 104, x: 580, y: 324, z: 2.12, dip: 0.32 },
  { f: 160, x: 580, y: 324, z: 2.16 },
  { f: 174, x: 580, y: 322, z: 2.25 },
  { f: 234, x: 580, y: 322, z: 2.2 },
  { f: 274, x: 112, y: 104, z: 2.3, dip: 0.55 },
  { f: 286, x: 112, y: 104, z: 2.36 },
  { f: 316, x: 337, y: 178, z: 2.2, dip: 0.22 },
  { f: 350, x: 337, y: 178, z: 2.32 },
  { f: 376, x: 480, y: 300, z: 0.588 },
  { f: 384, x: 480, y: 300, z: 0.588 },
];
/** The zoom of the whole-window shot: the desk shows all round it. */
const WIDE = SHOTS[0].z;

const STEPS = [
  { label: "Testing the game", from: T.steps[0], to: T.steps[1] },
  { label: "Making it public", from: T.steps[1], to: T.steps[2] },
  { label: "Sending the cover", from: T.steps[2], to: T.steps[3] },
] as const;

const fill: CSSProperties = { position: "absolute", inset: 0 };
const oneLine: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
/** Create goes before Play arrives (the first and second half of a switch), so their words never overlap. */
const leaving = (play: number) => Math.max(0, 1 - play * 2);
const arriving = (play: number) => Math.max(0, play * 2 - 1);
const round = (size: number): CSSProperties => ({
  width: size,
  height: size,
  flex: "none",
  borderRadius: "50%",
  objectFit: "cover",
});

/** Loads the app's two faces before the first frame; a missing face fails the render. */
function useFonts(): void {
  const [handle] = useState(() => delayRender("Play fonts"));
  useEffect(() => {
    const faces = [
      new FontFace("Zalando Sans SemiExpanded", `url(${staticFile("fonts/ZalandoSansSemiExpanded-variable.woff2")})`, {
        weight: "200 900",
      }),
      new FontFace("Geist Mono", `url(${staticFile("fonts/GeistMono-variable.woff2")})`, { weight: "100 900" }),
    ];
    Promise.all(faces.map((f) => f.load()))
      .then((loaded) => {
        for (const f of loaded) document.fonts.add(f);
        return document.fonts.ready;
      })
      .then(() => continueRender(handle))
      .catch((error: unknown) => cancelRender(error));
  }, [handle]);
}

// ── small marks ───────────────────────────────────────────────────────────────────────────

function Stroke({ size, color = "currentColor", children }: { size: number; color?: string; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      {children}
    </svg>
  );
}

const Globe = () => (
  <Stroke size={16}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <ellipse cx="12" cy="12" rx="3.7" ry="8.5" />
  </Stroke>
);

function Wordmark() {
  return (
    <svg aria-hidden="true" width="76" height="12" viewBox="0 0 95 15" fill={C.ink}>
      <path d="M87.0116 5.07172L91.676 0H94.4091L88.615 6.2915C87.9591 7.01909 87.9591 7.96068 88.615 8.68826L94.4091 14.9798H91.676L87.0116 9.90805C86.6837 9.54425 86.3192 9.35165 85.9184 9.35165C85.554 9.35165 85.1532 9.54425 84.8252 9.90805L80.1608 14.9798H77.4277L83.2218 8.68826C83.9142 7.96068 83.9142 7.01909 83.2218 6.2915L77.4277 0H80.1608L84.8252 5.07172C85.1532 5.43552 85.554 5.60671 85.9184 5.60671C86.3192 5.60671 86.6837 5.43552 87.0116 5.07172Z" />
      <path d="M66.9152 13.652H75.333V15.0002H59.9551V0.0203894H75.333V1.36857H66.8059C64.0729 1.36857 61.6124 1.2552 61.6124 4.10773C61.6124 6.96025 64.0729 6.78268 66.8059 6.78268H73.6568V8.13086H66.9152C64.1093 8.13086 61.6124 8.15941 61.6124 10.9128C61.6124 13.6662 64.1093 13.652 66.9152 13.652Z" />
      <path d="M54.2463 10.4207V0.0205078H56.5056V15.0003H54.2463L44.8082 4.42884C44.4438 4.04365 44.1523 3.85105 43.9336 3.85105C43.715 3.85105 43.5692 4.10785 43.5692 4.60004V15.0003H41.2734V0.0205078H43.5692L53.0073 10.5919C53.3353 10.9771 53.6268 11.1697 53.8455 11.1697C54.1005 11.1697 54.2463 10.9129 54.2463 10.4207Z" />
      <path d="M30.0656 13.6521H38.4834V15.0003H23.1055V0.0205078H38.4834V1.36869H29.9563C27.2233 1.36869 24.7628 1.13245 24.7628 4.10784C24.7628 7.08324 27.2233 6.7828 29.9563 6.7828H36.8072V8.13098H30.0656C27.2597 8.13098 24.7628 8.16423 24.7628 10.9129C24.7628 13.6616 27.2597 13.6521 30.0656 13.6521Z" />
      <path d="M14.8313 8.85849H6.76045V7.51031H19.2407V11.1697C19.2407 11.1697 18.2707 14.9788 9.80253 14.9788C9.80253 14.9788 0 15.257 0 7.10372C0 -0.450362 10.6042 0.0204315 10.6042 0.0204315C18.7669 0.0204315 19.2407 3.97937 19.2407 3.97937L17.1271 4.32176C17.1271 4.32176 16.4712 1.28301 10.4585 1.28301C10.4585 1.28301 2.40508 0.983416 2.40508 7.25352C2.40508 7.25352 2.22288 13.5022 9.91186 13.6734C15.961 13.866 16.8356 10.6561 16.9085 10.0997C17.1271 9.39349 16.1796 8.85849 14.8313 8.85849Z" />
    </svg>
  );
}

// ── the sidebar: the switch, then Create's games or Play's recent ones ─────────────────────

function TrafficLights() {
  return (
    <div style={{ position: "absolute", top: 12, left: 16, display: "flex", gap: 8 }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
        <span key={color} style={{ width: 12, height: 12, borderRadius: "50%", background: color }} />
      ))}
    </div>
  );
}

/** The Play / Create switch; `play` slides its highlight from Create (0) to Play (1). */
function Switch({ play }: { play: number }) {
  const half = (L.pill.width - 6) / 2;
  const label = (active: number): CSSProperties => ({
    position: "relative",
    display: "grid",
    placeItems: "center",
    color: active > 0.5 ? (play > 0.5 ? C.cyberInk : C.ink1) : C.ink4,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: L.pill.x,
        top: L.pill.y,
        width: L.pill.width,
        height: L.pill.height,
        boxSizing: "border-box",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 2,
        padding: 2,
        border: "1px solid rgba(121, 127, 139, 0.21)",
        borderRadius: 10,
        background: "rgba(77, 81, 96, 0.1)",
        fontFamily: MONO,
        fontSize: 13,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          bottom: 2,
          left: 2 + (1 - play) * (half + 2),
          width: half,
          borderRadius: 8,
          background: `rgba(31, 143, 255, ${0.24 * play})`,
          boxShadow: `inset 0 0 0 1px rgba(255, 255, 255, ${0.08 * (1 - play)})`,
        }}
      >
        <span style={{ ...fill, borderRadius: 8, background: "rgba(255, 255, 255, 0.07)", opacity: 1 - play }} />
      </span>
      <span style={label(play)}>Play</span>
      <span style={label(1 - play)}>Create</span>
    </div>
  );
}

const listHeading: CSSProperties = { margin: "0 0 6px 8px", fontSize: 12, color: C.ink3 };
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: 34,
  padding: "0 8px",
  borderRadius: 8,
  fontSize: 14,
  color: C.ink2,
};

function Sidebar({ play, pill }: { play: number; pill: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: APP.sidebar,
        background: C.sidebar,
        borderRight: `1px solid ${C.sidebarLine}`,
      }}
    >
      <TrafficLights />
      <div style={{ position: "absolute", left: 22, top: 44 }}>
        <Wordmark />
      </div>
      <Switch play={pill} />
      <div style={{ position: "absolute", left: 8, right: 8, top: 122, opacity: leaving(play) }}>
        <p style={listHeading}>Games</p>
        <span style={{ ...row, background: "rgba(255, 255, 255, 0.06)", color: C.ink1 }}>
          <Img src={HERO} style={round(20)} />
          <span style={oneLine}>{GAME.title}</span>
        </span>
        {PROJECTS.map((p) => (
          <span key={p.title} style={row}>
            <span style={{ ...round(20), background: `linear-gradient(135deg, ${p.hue}, #15151a)` }} />
            {p.title}
          </span>
        ))}
      </div>
      <div style={{ position: "absolute", left: 8, right: 8, top: 122, opacity: arriving(play) }}>
        <p style={listHeading}>Recent</p>
        {RECENT.map((g) => (
          <span key={g.title} style={row}>
            <Img src={g.src} style={round(20)} />
            {g.title}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Create: the game in its preview, its name and Publish ──────────────────────────────────

function CreateView({ f }: { f: number }) {
  const press = keys(f, [0, T.pressPublish, T.pressPublish + 3, T.pressPublish + 9], [1, 1, 0.9, 1]);
  return (
    <div style={fill}>
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 8,
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 14,
          color: C.ink1,
        }}
      >
        <Img src={HERO} style={round(22)} />
        {GAME.title}
      </div>
      <div
        style={{
          position: "absolute",
          left: L.publish.x - APP.sidebar,
          top: L.publish.y,
          width: L.publish.width,
          height: L.publish.height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          borderRadius: 9,
          background: C.publish,
          color: "#ffffff",
          fontSize: 14,
          fontWeight: 500,
          transform: `scale(${press})`,
        }}
      >
        <Globe />
        Publish
      </div>
      <div
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          top: APP.header,
          bottom: 12,
          overflow: "hidden",
          borderRadius: 10,
        }}
      >
        <Img src={HERO} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    </div>
  );
}

// ── the publish dialog ──────────────────────────────────────────────────────────────────────

function Spinner({ f }: { f: number }) {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" style={{ transform: `rotate(${f * 14}deg)` }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke={C.dialogLine} strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={C.cyber} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** One step of the publish: it rises in, spins, ticks green, and rises away for the next. */
function Step({ f, label, from, to, last }: { f: number; label: string; from: number; to: number; last: boolean }) {
  const enter = keys(f, [from, from + 8], [0, 1]);
  const leave = last ? 0 : keys(f, [to, to + 7], [0, 1]);
  const done = keys(f, [to - 7, to - 1], [0, 1]);
  return (
    <span
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        opacity: enter * (1 - leave),
        transform: `translateY(${(1 - enter) * 12 - leave * 12}px)`,
      }}
    >
      <span style={{ display: "grid", width: 16, height: 16 }}>
        <span style={{ gridArea: "1 / 1", opacity: 1 - done }}>
          <Spinner f={f} />
        </span>
        <span style={{ gridArea: "1 / 1", opacity: done, transform: `scale(${0.4 + 0.6 * done})` }}>
          <Stroke size={16} color={C.green}>
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </Stroke>
        </span>
      </span>
      {label}
    </span>
  );
}

function Progress({ f }: { f: number }) {
  const end = T.steps[T.steps.length - 1];
  // A third of the bar per step, each third filling as its step runs, so a tick never beats its bar.
  const bar = keys(f, T.steps, [0, 1 / 3, 2 / 3, 1], EASE_IN_OUT);
  return (
    <div style={{ gridArea: "1 / 1", opacity: keys(f, [end, end + 6], [1, 0]) }}>
      <div style={{ height: 6, overflow: "hidden", borderRadius: 3, background: C.dialogLine }}>
        <div
          style={{
            height: "100%",
            borderRadius: 3,
            background: C.cyber,
            transformOrigin: "0 50%",
            transform: `scaleX(${bar})`,
          }}
        />
      </div>
      <div style={{ position: "relative", height: 22, marginTop: 14, fontSize: 15, color: C.ink2 }}>
        {STEPS.map((s, i) => (
          <Step key={s.label} f={f} {...s} last={i === STEPS.length - 1} />
        ))}
      </div>
    </div>
  );
}

/** The last 40 % of a step rolls the digit on, eased; before that it holds still. */
const tick = (t: number) => {
  const u = Math.min(1, Math.max(0, (t - 0.6) / 0.4));
  return u * u * (3 - 2 * u);
};

/** An odometer: every digit rolls up through the numbers, and a new leading digit opens its place as it arrives. */
function Rolling({ value, digits }: { value: number; digits: number }) {
  const places = Array.from({ length: digits }, (_, i) => digits - 1 - i);
  return (
    <span style={{ display: "inline-flex", height: "1.2em", overflow: "hidden", fontFamily: MONO, lineHeight: "1.2em" }}>
      {places.map((k) => {
        const unit = 10 ** k;
        // The ones roll all the time; a higher digit rolls only while the digit below goes from 9 to 0.
        const pos = Math.floor(value / unit) + tick((value % unit) - (unit - 1));
        const open = k === 0 ? 1 : Math.min(1, Math.max(0, value - unit + 1));
        return (
          <span key={k} style={{ width: `${0.6 * open}em`, overflow: "hidden", opacity: open }}>
            <span style={{ display: "flex", flexDirection: "column", transform: `translateY(${-(pos % 10) * 1.2}em)` }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d, i) => (
                <span key={`${k}-${i}`} style={{ height: "1.2em" }}>
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The players who join first, each its own kind of picture (a face in neon bokeh, a chrome head, a
 * cyberpunk anime girl, a felt creature, a smiling orb, a gamer lit by the screen), made with Genex
 * image generation, and where each flies in from (relative to its place in the stack).
 */
const player = (name: string) => staticFile(`players/${name}.webp`);
const PLAYERS = [
  { id: "bokeh", src: player("bokeh"), ring: "#ff5ad1", dx: 240, dy: -170 },
  { id: "chrome", src: player("chrome"), ring: "#9fd2ff", dx: 330, dy: 70 },
  { id: "cyber", src: player("cyber"), ring: "#c26bff", dx: -190, dy: 170 },
  { id: "clay", src: player("clay"), ring: "#4da3ff", dx: 280, dy: 190 },
  { id: "orb", src: player("orb"), ring: "#7cebaa", dx: 360, dy: -60 },
  { id: "lofi", src: player("lofi"), ring: "#3fe0e6", dx: -150, dy: -150 },
] as const;
const AVATAR = 32;
const FLIGHT = 16;

/** One player: it shoots in on an arc and lands in the stack with a bounce and a ring. */
function Player({ f, land, index, src, ring: ringColor, dx, dy }: { f: number; land: number; index: number } & (typeof PLAYERS)[number]) {
  const t = keys(f, [land - FLIGHT, land], [0, 1]);
  const arc = -40 * Math.sin(Math.PI * t);
  const bounce = keys(f, [land - 1, land + 3, land + 9], [1, 1.2, 1]);
  const ring = keys(f, [land, land + 12], [0, 1]);
  const circle: CSSProperties = { position: "absolute", inset: 0, borderRadius: "50%" };
  return (
    <span style={{ position: "relative", width: AVATAR, height: AVATAR, flex: "none", marginLeft: index ? -8 : 0 }}>
      {f >= land && ring < 1 && (
        <span
          style={{
            ...circle,
            border: `2px solid ${ringColor}`,
            opacity: 0.8 * (1 - ring),
            transform: `scale(${1 + 0.9 * ring})`,
          }}
        />
      )}
      <span
        style={{
          ...circle,
          overflow: "hidden",
          boxShadow: `0 0 0 2px ${C.dialog}`,
          opacity: keys(f, [land - FLIGHT, land - FLIGHT + 3], [0, 1]),
          transform: `translate(${dx * (1 - t)}px, ${dy * (1 - t) + arc}px) scale(${(0.55 + 0.45 * t) * bounce})`,
        }}
      >
        <Img src={src} style={{ width: "100%", height: "100%" }} />
      </span>
    </span>
  );
}

/** Live: the dot pulses, players fly in and stack up, and the count of players rolls up. */
function Live({ f }: { f: number }) {
  const shown = keys(f, T.liveIn, [0, 1]);
  const pulse = f < T.liveIn[0] ? 0 : ((f - T.liveIn[0]) % 24) / 24;
  return (
    <div
      style={{
        gridArea: "1 / 1",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 12,
        opacity: shown,
        transform: `translateY(${(1 - shown) * 8}px) scale(${0.96 + 0.04 * shown})`,
        transformOrigin: "0 50%",
      }}
    >
      <p style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: 21, fontWeight: 500, color: C.ink1 }}>
        <span style={{ position: "relative", width: 10, height: 10 }}>
          <span style={{ ...fill, borderRadius: "50%", background: C.green, boxShadow: `0 0 10px ${C.green}` }} />
          <span
            style={{
              ...fill,
              borderRadius: "50%",
              border: `1.5px solid ${C.green}`,
              opacity: 0.8 * (1 - pulse),
              transform: `scale(${1 + 1.6 * pulse})`,
            }}
          />
        </span>
        Live on Play
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ display: "flex" }}>
          {PLAYERS.map((p, i) => (
            <Player key={p.id} f={f} land={T.landings[i]} index={i} {...p} />
          ))}
        </span>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, fontSize: 17, fontWeight: 500, color: C.ink1 }}>
          <Rolling value={keys(f, T.count, [0, 128])} digits={3} />
          <span style={{ fontSize: 14, fontWeight: 400, color: C.ink3 }}>playing</span>
        </span>
      </div>
    </div>
  );
}

/** As it goes live a light sweeps across the dialog and its edge glows green, then settles. */
function LiveFlash({ f }: { f: number }) {
  const sweep = keys(f, [T.liveIn[0], T.liveIn[0] + 16], [-40, 140]);
  const on = f >= T.liveIn[0] && f <= T.liveIn[0] + 16;
  return (
    <span style={{ ...fill, overflow: "hidden", borderRadius: 16, pointerEvents: "none" }}>
      {on && (
        <span
          style={{
            position: "absolute",
            top: -40,
            bottom: -40,
            left: `${sweep}%`,
            width: 70,
            background: "linear-gradient(90deg, rgba(124, 209, 148, 0), rgba(124, 209, 148, 0.22), rgba(124, 209, 148, 0))",
            transform: "rotate(18deg)",
          }}
        />
      )}
    </span>
  );
}

/** The dialog's edge: its hairline, turning green as it goes live. */
const glowEdge = (glow: number) =>
  `rgba(${41 + (124 - 41) * glow}, ${41 + (209 - 41) * glow}, ${43 + (148 - 43) * glow}, ${1 - 0.4 * glow})`;

function Dialog({ f }: { f: number }) {
  const [inFrom, inTo] = T.dialogIn;
  const [outFrom, outTo] = T.dialogOut;
  const at = [0, inFrom, inTo, outFrom, outTo];
  const shown = keys(f, at, [0, 0, 1, 1, 0]);
  const glow = keys(f, [T.liveIn[0], T.liveIn[0] + 8, T.liveIn[0] + 40], [0, 1, 0.4]);
  return (
    <>
      <div style={{ ...fill, background: "rgba(0, 0, 0, 0.5)", opacity: shown }} />
      <div
        style={{
          position: "absolute",
          left: L.dialog.x - L.dialog.width / 2,
          top: L.dialog.y,
          width: L.dialog.width,
          boxSizing: "border-box",
          padding: 18,
          borderRadius: 16,
          background: C.dialog,
          boxShadow: `0 0 0 1px ${glowEdge(glow)}, 0 16px 48px rgba(0, 0, 0, 0.45), 0 0 ${48 * glow}px rgba(124, 209, 148, ${0.3 * glow})`,
          opacity: shown,
          transform: `translateY(-50%) translateY(${keys(f, at, [10, 10, 0, 0, 0])}px) scale(${keys(f, at, [0.94, 0.94, 1, 1, 0.97])})`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Img src={HERO} style={{ ...round(38), outline: "1px solid rgba(255, 255, 255, 0.1)", outlineOffset: -1 }} />
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "21px", color: C.ink1 }}>{GAME.title}</p>
            <p style={{ margin: "2px 0 0", fontFamily: MONO, fontSize: 11, lineHeight: "16px", color: C.ink4 }}>
              {GAME.page}
            </p>
          </div>
        </div>
        <LiveFlash f={f} />
        <div style={{ display: "grid", height: 70, marginTop: 14 }}>
          <Progress f={f} />
          <Live f={f} />
        </div>
      </div>
    </>
  );
}

// ── Play: the dashboard, where the game arrives first ─────────────────────────────────────

const cell: CSSProperties = { display: "flex", flexDirection: "column", gap: 9, minWidth: 0 };
const coverBox: CSSProperties = {
  position: "relative",
  width: CARD_COVER.width,
  height: CARD_COVER.height,
  overflow: "hidden",
  borderRadius: 10,
};
const cardTitle: CSSProperties = { fontSize: 15, fontWeight: 500, color: C.ink1 };

function Card({ title, src }: { title: string; src: string }) {
  return (
    <div style={cell}>
      <div style={{ ...coverBox, boxShadow: `inset 0 0 0 1px ${C.cardLine}` }}>
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <span style={cardTitle}>{title}</span>
    </div>
  );
}

/** The first cell: a shimmering placeholder until the new game pops in, glowing blue, and fills up. */
function NewCard({ f }: { f: number }) {
  const [popFrom, popTo] = T.cardIn;
  const shown = keys(f, [popFrom, popTo], [0, 1]);
  const scale = keys(f, [popFrom, popTo, popTo + 6], [0.9, 1.03, 1]);
  const glow = keys(f, [popFrom, popTo, popTo + 30], [0, 1, 0.55]);
  const hover = keys(f, T.hover, [0, 1, 1, 0]);
  const shimmer = ((f % 40) / 40) * 200 - 50;
  return (
    <div style={{ ...cell, position: "relative" }}>
      <div
        style={{
          ...coverBox,
          position: "absolute",
          background: `linear-gradient(100deg, #18181b ${shimmer - 30}%, #232327 ${shimmer}%, #18181b ${shimmer + 30}%)`,
          opacity: 1 - shown,
        }}
      />
      <div
        style={{
          ...coverBox,
          opacity: shown,
          transform: `scale(${scale * (1 + 0.02 * hover)})`,
          boxShadow: `0 0 0 ${1 + glow}px ${C.cyberLine}, 0 0 ${28 * glow}px rgba(31, 143, 255, ${0.5 * glow})`,
        }}
      >
        <Img
          src={HERO}
          style={{ width: "100%", height: "100%", objectFit: "cover", filter: `brightness(${1 + 0.12 * hover})` }}
        />
        <PlayMark hover={hover} />
        <Online f={f} />
      </div>
      <span style={{ ...cardTitle, ...oneLine, opacity: shown }}>{GAME.title}</span>
    </div>
  );
}

function PlayMark({ hover }: { hover: number }) {
  return (
    <span
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 44,
        height: 44,
        display: "grid",
        placeItems: "center",
        borderRadius: "50%",
        background: "rgba(255, 255, 255, 0.92)",
        opacity: hover,
        transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * hover})`,
      }}
    >
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="#0e0d0f" style={{ marginLeft: 3 }}>
        <path d="M6 4l14 8-14 8z" />
      </svg>
    </span>
  );
}

/** The players in it now, still rolling up as more join. */
function Online({ f }: { f: number }) {
  const shown = keys(f, [T.cardIn[1], T.cardIn[1] + 6], [0, 1]);
  return (
    <span
      style={{
        position: "absolute",
        left: 10,
        bottom: 10,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 7,
        background: "rgba(0, 0, 0, 0.6)",
        fontFamily: MONO,
        fontSize: 13,
        fontWeight: 500,
        color: "#ffffff",
        opacity: shown,
        transform: `translateY(${(1 - shown) * 4}px)`,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, boxShadow: `0 0 6px ${C.green}` }} />
      <Rolling value={keys(f, T.online, [128, 131])} digits={3} />
      online
    </span>
  );
}

const TABS = ["Featured", "Arcade", "Shooter", "Racing", "Sports"] as const;

function PlayView({ f }: { f: number }) {
  return (
    <div style={fill}>
      <div
        style={{
          position: "absolute",
          right: 16,
          top: 10,
          width: 200,
          height: 28,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          borderRadius: 8,
          background: "rgba(255, 255, 255, 0.05)",
          boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
          fontSize: 13,
          color: C.ink4,
        }}
      >
        <Stroke size={14}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </Stroke>
        Search games
      </div>
      <div style={{ position: "absolute", left: 24, top: 58, display: "flex", gap: 20, fontSize: 14, color: C.ink4 }}>
        {TABS.map((tab, i) => (
          <span key={tab} style={i === 0 ? { color: C.ink1, boxShadow: `0 8px 0 -6px ${C.cyber}` } : undefined}>
            {tab}
          </span>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: L.grid.x - APP.sidebar,
          top: L.grid.y,
          display: "grid",
          gridTemplateColumns: `repeat(3, ${L.grid.column}px)`,
          gap: `22px ${L.grid.gap}px`,
        }}
      >
        <NewCard f={f} />
        {GRID.map((g) => (
          <Card key={g.title} {...g} />
        ))}
      </div>
    </div>
  );
}

// ── the window, the click ripples and the cursor ───────────────────────────────────────────

function Window({ f, play, pill }: { f: number; play: number; pill: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: APP.width,
        height: APP.height,
        overflow: "hidden",
        borderRadius: APP.radius,
        background: C.page,
        boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.1), 0 30px 80px rgba(0, 0, 0, 0.6), 0 0 140px rgba(31, 143, 255, 0.14)",
      }}
    >
      <div style={{ position: "absolute", left: APP.sidebar, top: 0, right: 0, bottom: 0 }}>
        <div style={{ ...fill, opacity: leaving(play) }}>
          <CreateView f={f} />
        </div>
        <div style={{ ...fill, opacity: arriving(play), transform: `translateY(${(1 - play) * 12}px)` }}>
          <PlayView f={f} />
        </div>
      </div>
      <Sidebar play={play} pill={pill} />
      <Dialog f={f} />
    </div>
  );
}

/** A blue ring that spreads from where the cursor pressed. */
function Ripple({ f, at, x, y }: { f: number; at: number; x: number; y: number }) {
  const t = keys(f, [at, at + 14], [0, 1]);
  if (f < at || t >= 1) return null;
  return (
    <span
      style={{
        position: "absolute",
        left: x - 30,
        top: y - 30,
        width: 60,
        height: 60,
        borderRadius: "50%",
        border: `2px solid ${C.cyber}`,
        opacity: 0.8 * (1 - t),
        transform: `scale(${0.3 + 0.9 * t})`,
      }}
    />
  );
}

/** Rests on the game, glides to Publish, steps aside, glides to Play, hovers the new game, and fades. */
const CURSOR = {
  at: [0, 30, 62, 76, 100, 238, 272, 294, 324, 352, 364, 368, 382],
  x: [560, 560, PUBLISH_AT.x, PUBLISH_AT.x, 760, 760, PLAY_AT.x, PLAY_AT.x, 330, 330, 330, 560, 560],
  y: [380, 380, PUBLISH_AT.y, PUBLISH_AT.y, 150, 150, PLAY_AT.y, PLAY_AT.y, 168, 168, 168, 380, 380],
  opacity: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1],
} as const;

function Cursor({ f }: { f: number }) {
  const at = (values: readonly number[]) => keys(f, CURSOR.at, values, CURSOR_EASE);
  const press = (frame: number) => keys(f, [frame, frame + 3, frame + 8], [1, 0.82, 1]);
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="30"
      viewBox="0 0 22 28"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        transformOrigin: "3px 2px",
        opacity: at(CURSOR.opacity),
        transform: `translate(${at(CURSOR.x) - 3}px, ${at(CURSOR.y) - 2}px) scale(${press(T.pressPublish) * press(T.pressPlay)})`,
        filter: "drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45))",
      }}
    >
      <path
        d="M3 2 L3 22 L8 17.5 L11.5 25 L15 23.5 L11.6 16.2 L18 16 Z"
        fill="#ffffff"
        stroke={C.page}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The desk: an autumn mountain road at sunset, darker at the edges; it drifts a touch with the zoom and the clock. */
function Desk({ z, f }: { z: number; f: number }) {
  const drift = Math.sin((2 * Math.PI * f) / FRAMES);
  return (
    <div style={{ ...fill, transform: `scale(${1.06 + 0.08 * Math.log(z / WIDE)}) translateX(${drift * 8}px)` }}>
      <Img
        src={staticFile("desk.webp")}
        style={{ width: W, height: H, objectFit: "cover" }}
      />
      <div style={{ ...fill, background: "radial-gradient(85% 85% at 50% 50%, rgba(5, 6, 10, 0) 55%, rgba(5, 6, 10, 0.55))" }} />
    </div>
  );
}

export function PlayPublish() {
  useFonts();
  const f = useCurrentFrame();
  const view = camera(f, SHOTS);
  const play = keys(f, [0, T.toPlay[0], T.toPlay[1], T.toCreate[0], T.toCreate[1]], [0, 0, 1, 1, 0], EASE_IN_OUT);
  return (
    <AbsoluteFill
      style={{
        width: W,
        height: H,
        overflow: "hidden",
        background: C.desk,
        color: C.ink,
        fontFamily: SANS,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <Desk z={view.z} f={f} />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: APP.width,
          height: APP.height,
          transformOrigin: "0 0",
          transform: `translate(${W / 2}px, ${H / 2}px) scale(${view.z}) translate(${-view.x}px, ${-view.y}px)`,
        }}
      >
        <Window f={f} play={play} pill={keys(f, [0, ...T.pill, T.toCreate[0], T.toCreate[0] + 8], [0, 0, 1, 1, 0])} />
        <Ripple f={f} at={T.pressPublish} {...PUBLISH_AT} />
        <Ripple f={f} at={T.pressPlay} {...PLAY_AT} />
        <Cursor f={f} />
      </div>
    </AbsoluteFill>
  );
}

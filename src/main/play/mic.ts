/**
 * Voice chat in Play's viewer, Electron-free. A game in voice chat holds a microphone the app owns
 * (`preload/play-mic-page.ts`); the header's mic switch decides whether the person's own microphone
 * feeds it. Every game starts with the switch off and remembers it; turning it on asks the system
 * first (macOS asks the person once). The switch's menu picks the microphone. Main lets the page
 * open the person's microphone only just after telling it to ({@link micGate}).
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { type PlayBarState, type PlayMicBar, PlayNote, type PlayPoint } from "../../shared/play.ts";
import { type PlayMicCommand, PlayMicProblem, type PlayMicReport } from "../../shared/play-mic.ts";
import type { PlayMicStore } from "./mic-store.ts";

/** How long after main tells the page to open the microphone the page may ask the browser for it. */
export const MIC_OPEN_GRANT_MS = 10 * SECOND_MS;

/** What the mic moves or asks: the system, the game's page, a menu, the system's settings, the store. */
export interface PlayMicDeps {
  /** Whether the person's microphone may be used; macOS asks the person the first time. */
  access(): Promise<boolean>;
  /** Tell the game's page to open the person's microphone or close it. */
  command(command: PlayMicCommand): void;
  /** The person's microphones in a menu at `at` (the system's first), `chosen` checked; `choose` hears the pick. */
  menu(
    devices: readonly string[],
    chosen: string | null,
    at: PlayPoint | undefined,
    choose: (device: string | null) => void,
  ): void;
  /** Open the system's microphone privacy settings. */
  openSettings(): void;
  store: PlayMicStore;
}

/** The mic's side of one game's session. */
export interface MicSession {
  /** The game has asked for a microphone: the header shows the switch from then on. */
  shown: boolean;
  /** The game holds a microphone now: it is in voice chat. */
  asked: boolean;
  /** The person's microphone is open, feeding the game. */
  live: boolean;
  /** The person's switch for this game. */
  on: boolean;
  /** Whether the system lets the app use the microphone; null until asked in this session. */
  allowed: boolean | null;
  /** The system is being asked. */
  asking: boolean;
  /** The microphones by name, as the page last read them. */
  devices: string[];
  /** What the page was last told; null once it holds nothing open. */
  told: PlayMicCommand | null;
  /** A microphone that went away was opened again: that happens once. */
  reopened: boolean;
  /** The page's last report, so the same word twice changes nothing. */
  heard: string;
}

/** A game just opened: the switch as it was left for it, nothing asked yet. */
export const freshMic = (on: boolean): MicSession => ({
  shown: false,
  asked: false,
  live: false,
  on,
  allowed: null,
  asking: false,
  devices: [],
  told: null,
  reopened: false,
  heard: "",
});

/** The header's mic, or null while the game has not asked for one. */
export const micBar = (mic: MicSession): PlayMicBar | null =>
  mic.shown ? { on: mic.on, live: mic.live, waiting: mic.asked && !mic.on } : null;

/** The session the mic acts in. */
interface MicHolder {
  slug: string;
  epoch: number;
  mic: MicSession;
  state: PlayBarState;
}

/** What the mic needs of the viewer: its deps, the session, and how to draw and say things. */
export interface MicContext {
  deps: { mic: PlayMicDeps };
  session(): MicHolder | null;
  current(epoch: number): MicHolder | null;
  draw(): void;
  note(value: PlayNote | null): void;
}

/** What the header says when the microphone would not open, or went away for good. */
const PROBLEM_NOTE = {
  [PlayMicProblem.Denied]: PlayNote.MicBlocked,
  [PlayMicProblem.Missing]: PlayNote.MicMissing,
  [PlayMicProblem.Lost]: PlayNote.MicMissing,
  [PlayMicProblem.Failed]: PlayNote.MicFailed,
} as const satisfies Record<PlayMicProblem, PlayNote>;

/** Show the mic as it is now. */
function redraw(ctx: MicContext, s: MicHolder): void {
  s.state = { ...s.state, mic: micBar(s.mic) };
  ctx.draw();
}

/** Tell the page to open (the chosen microphone) or close, unless that is what it was last told. */
function tell(ctx: MicContext, s: MicHolder): void {
  const { mic } = s;
  const open = mic.on && mic.asked && mic.allowed === true;
  const device = ctx.deps.mic.store.device();
  const told = mic.told;
  const alreadyClosed = !open && told?.open !== true;
  const alreadyOpen = open && told?.open === true && told.device === device;
  if (alreadyClosed || alreadyOpen) return;
  mic.told = { open, device };
  ctx.deps.mic.command(mic.told);
}

/** Open the microphone if the game and the switch want it, asking the system first once a session. */
async function openWhenAllowed(ctx: MicContext, s: MicHolder): Promise<void> {
  const { mic } = s;
  const needsAsking = mic.on && mic.asked && mic.allowed === null;
  if (needsAsking && mic.asking) return;
  if (needsAsking) {
    mic.asking = true;
    const allowed = await ctx.deps.mic.access();
    mic.asking = false;
    if (!ctx.current(s.epoch)) return;
    mic.allowed = allowed;
    if (!allowed) {
      // Left on for this game, but the system has since refused it: say where it is allowed.
      mic.on = false;
      ctx.note(PlayNote.MicBlocked);
      redraw(ctx, s);
      return;
    }
  }
  tell(ctx, s);
}

/** The page's microphone would not open or went away: open again once if it went away, else the switch turns off. */
function failed(ctx: MicContext, s: MicHolder, problem: PlayMicProblem): void {
  const { mic } = s;
  mic.told = null;
  mic.live = false;
  if (problem === PlayMicProblem.Lost && !mic.reopened) {
    mic.reopened = true;
    return;
  }
  // Off for now, not forgotten: the game's choice stays for next time.
  mic.on = false;
  ctx.note(PROBLEM_NOTE[problem]);
}

/** The page's word on its microphone: what the header shows, and whether to open or close. */
export function heardMic(ctx: MicContext, report: PlayMicReport): void {
  const s = ctx.session();
  if (!s) return;
  const { mic } = s;
  const heard = JSON.stringify(report);
  if (heard === mic.heard && !report.problem) return;
  mic.heard = heard;
  mic.asked = report.asked;
  mic.live = report.live;
  if (report.asked) mic.shown = true;
  if (report.devices.length > 0) mic.devices = report.devices;
  // A page out of voice chat has closed the microphone itself.
  if (!report.asked) mic.told = null;
  if (report.problem) failed(ctx, s, report.problem);
  redraw(ctx, s);
  void openWhenAllowed(ctx, s);
}

/** The header's mic switch: off closes the microphone; on asks the system first, and remembers. */
export async function toggleMic(ctx: MicContext): Promise<void> {
  const s = ctx.session();
  if (!s?.mic.shown) return;
  const { mic } = s;
  const { store } = ctx.deps.mic;
  if (mic.on) {
    mic.on = false;
    store.setOn(s.slug, false);
    redraw(ctx, s);
    tell(ctx, s);
    return;
  }
  const allowed = await ctx.deps.mic.access();
  if (!ctx.current(s.epoch)) return;
  mic.allowed = allowed;
  if (!allowed) {
    ctx.note(PlayNote.MicBlocked);
    ctx.deps.mic.openSettings();
    return;
  }
  mic.on = true;
  mic.reopened = false;
  store.setOn(s.slug, true);
  redraw(ctx, s);
  tell(ctx, s);
}

/** The mic's menu at `at`: a pick is remembered, and an open microphone changes to it. */
export function chooseMic(ctx: MicContext, at: PlayPoint | undefined): void {
  const s = ctx.session();
  if (!s?.mic.shown) return;
  const { store } = ctx.deps.mic;
  ctx.deps.mic.menu(s.mic.devices, store.device(), at, (device) => {
    store.setDevice(device);
    const live = ctx.current(s.epoch);
    if (live) void openWhenAllowed(ctx, live);
  });
}

/** A media permission request, as main's gate reads it. */
export interface MicRequest {
  mediaTypes: readonly string[];
  isMainFrame: boolean;
}

/**
 * The game view's microphone gate. The page may open the microphone once, just after main told it
 * to; never a camera, never from a frame inside the game. Once main has told it to open in this
 * page, the page may read the microphones' names (the switch's menu needs them).
 */
export function micGate() {
  let until = Number.NEGATIVE_INFINITY;
  let trusted = false;
  return {
    /** Main told the page to open the microphone at `now`. */
    allow(now: number): void {
      until = now + MIC_OPEN_GRANT_MS;
      trusted = true;
    },
    /** Whether `request` may open the microphone now; an opening spends the grant. */
    take(request: MicRequest, now: number): boolean {
      const audioOnly = request.mediaTypes.length > 0 && request.mediaTypes.every((type) => type === "audio");
      if (!audioOnly || !request.isMainFrame || now > until) return false;
      until = Number.NEGATIVE_INFINITY;
      return true;
    },
    /** Whether the page may see the microphones' names (`mediaType` as Electron's check names it). */
    names(mediaType: string | undefined, isMainFrame: boolean): boolean {
      return trusted && isMainFrame && mediaType === "audio";
    },
  };
}

/** A game view's gate, as {@link micGate} makes it. */
export type MicGate = ReturnType<typeof micGate>;

/** A gate that never opens: for a page that isn't the game's own. */
const CLOSED_GATE: MicGate = { allow: () => {}, take: () => false, names: () => false };

/** The origin of an address, or null for one that isn't an address. */
function originOf(address: string): string | null {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/**
 * The gate for a page the game's view just moved to: a fresh one on the game's own origin (`home`,
 * the address it opened), so nothing granted on an earlier page carries over; one that never opens
 * anywhere else, such as another game a link led to, which never gets this game's microphone.
 */
export function micGateFor(page: string, home: string): MicGate {
  const origin = originOf(page);
  return origin !== null && origin === originOf(home) ? micGate() : CLOSED_GATE;
}

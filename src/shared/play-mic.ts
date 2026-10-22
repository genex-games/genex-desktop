/**
 * Voice chat in Play. A game's page asks for a microphone and gets one the app controls
 * (`preload/play-mic-page.ts`); the person's own microphone feeds it only while the viewer header's
 * mic switch is on. Main and the page talk through the Play view's preload on these two channels;
 * these are the shapes both sides share.
 */

/** The Play view preload's channels. Wire values: never rename one. */
export const PlayMicChannel = { Report: "play-mic:report", Command: "play-mic:command" } as const;

/** Why the person's microphone did not open, or closed by itself. Wire values: never rename one. */
export const PlayMicProblem = {
  /** The system or the browser refused it. */
  Denied: "denied",
  /** There is no microphone. */
  Missing: "missing",
  /** It was open and went away (unplugged). */
  Lost: "lost",
  /** Anything else: in use elsewhere, a driver error. */
  Failed: "failed",
} as const;
export type PlayMicProblem = (typeof PlayMicProblem)[keyof typeof PlayMicProblem];

/** The page's word on its microphone. */
export interface PlayMicReport {
  /** The game holds a microphone: it is in voice chat. */
  asked: boolean;
  /** The person's microphone is open and feeding the game. */
  live: boolean;
  /** Why the last opening failed, or why the microphone closed by itself; said once. */
  problem: PlayMicProblem | null;
  /** The microphones by name; empty until the page may read their names. */
  devices: string[];
}

/** Main's word to the page: open the person's microphone (the one named, else the system's) or close it. */
export interface PlayMicCommand {
  open: boolean;
  device: string | null;
}

/** The most microphones a report may name, and the longest name kept. */
export const MIC_DEVICES_MAX = 32;
export const MIC_NAME_MAX = 200;

const PROBLEMS: ReadonlySet<string> = new Set(Object.values(PlayMicProblem));

/** Microphone names as main keeps them: strings, trimmed, bounded, each once. */
function micNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name || name.length > MIC_NAME_MAX || names.includes(name)) continue;
    names.push(name);
    if (names.length >= MIC_DEVICES_MAX) break;
  }
  return names;
}

/** A report from the untrusted page as main accepts it, or null when it is not one. */
export function readMicReport(raw: unknown): PlayMicReport | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { asked, live, problem, devices } = raw as Record<string, unknown>;
  if (typeof asked !== "boolean" || typeof live !== "boolean") return null;
  const said = typeof problem === "string" && PROBLEMS.has(problem) ? (problem as PlayMicProblem) : null;
  return { asked, live, problem: said, devices: micNames(devices) };
}

/** A microphone's name as main keeps a choice of one: trimmed and bounded, or null for the system's. */
export function micDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= MIC_NAME_MAX ? name : null;
}

/**
 * C++ in the Unreal Loop: whether this run may build C++, and the game's C++ module, added once
 * before the first C++ sub-agent works (between the lead's turns). The Unreal plugin's `cpp-status`
 * says whether this computer builds Unreal C++ (a Mac with Xcode ready) and names the game's
 * module; its `add-cpp-module` quits Unreal, writes the module, builds it and opens Unreal again
 * (one restart, about two minutes), which the runner waits for and then snapshots, so every
 * sub-agent's copy holds the module. Every answer is read as data: anything odd means no C++ this
 * run, and the game is built in Blueprints and Python.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { CLIP_DETAIL, clip } from "../text.ts";
import { cppHeldWords } from "./hold-words.ts";
import { MINUTE_MS, minutes, SECOND_MS } from "../time.ts";

/** Where adding the game's C++ module stands, as the Unreal plugin's `cpp-status` names it. */
export const CppAddState = { Idle: "idle", Adding: "adding", Done: "done", Failed: "failed" } as const;
export type CppAddState = (typeof CppAddState)[keyof typeof CppAddState];

/** How often adding the module is asked about, and how long it may take before the run goes on without it. */
export const CPP_POLL_MS = 5 * SECOND_MS;
export const ADD_MODULE_TIMEOUT_MS = 8 * MINUTE_MS;

/** A C++ module's name, as Unreal and the plugin accept one: a C++ identifier. */
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A word from the plugin's status (an Xcode state, a platform), kept to name characters. */
const WORD = /[^A-Za-z0-9 ._-]/g;
const WORD_CHARS = 40;
const ADD_STATES: ReadonlySet<string> = new Set(Object.values(CppAddState));

const MESSAGE = {
  Adding: (game: string) => `Adding C++ to ${game}: Unreal restarts once, about two minutes.`,
  Added: (game: string) => `${game} has C++ now: its code is written in C++.`,
  NotAdded: (why: string) => `C++ couldn't be added (${why}), so this run builds everything in Blueprints.`,
  CppModule: "C++ module",
  NoAnswer: "the Unreal plugin couldn't say whether this computer builds C++",
  CannotCompile: (xcode: string, platform: string) =>
    `this computer can't build Unreal C++ (Xcode ${xcode || "unknown"}, ${platform || "unknown platform"})`,
  AddRefused: (error: string) => `adding the C++ module was refused: ${error}`,
  AddUnclear: "the Unreal plugin didn't say it started adding the C++ module",
  AddFailed: (error: string) => `adding the C++ module failed: ${error || "no reason given"}`,
  AddTimedOut: `adding the C++ module took longer than ${minutes(ADD_MODULE_TIMEOUT_MS)} minutes`,
  RunTimeUp: "the run's time ran out while the C++ module was being added",
  NoModule: "the C++ module was added but has no name",
  Stopped: "the Loop was stopped while C++ was being added",
} as const;

/** The plugin's `cpp-status`, once read. */
export type CppStatus = {
  canCompile: boolean;
  xcode: string;
  platform: string;
  /** The game's module, or null before it has one. */
  module: string | null;
  adding: { state: CppAddState; error?: string; seconds?: number };
};

/**
 * Whether this run may build C++: the game's module (null until it is added), or why not, as
 * one clause a prompt quotes. `stillAdding` marks a wait that gave up while the plugin was still
 * adding the module, so Unreal may still be closed or restarting (`whileAdding`).
 */
export type CppSupport =
  | { available: true; module: string | null }
  | { available: false; why: string; stillAdding?: true; heldWords?: string };

const isRecord = (value: unknown): value is AnyRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const word = (value: unknown) => (typeof value === "string" ? value.replace(WORD, "").trim().slice(0, WORD_CHARS) : "");
/** A reason from the plugin, on one line and cut short. */
const reason = (value: unknown) =>
  clip(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    CLIP_DETAIL,
  );

/** Where adding stands in a status, or null when it isn't one of the plugin's states. */
function readAdding(value: unknown): CppStatus["adding"] | null {
  if (!isRecord(value) || !ADD_STATES.has(value.state)) return null;
  const error = typeof value.error === "string" ? reason(value.error) : "";
  const seconds = typeof value.seconds === "number" && Number.isFinite(value.seconds) ? value.seconds : null;
  return {
    state: value.state as CppAddState,
    ...(error ? { error } : {}),
    ...(seconds !== null ? { seconds } : {}),
  };
}

/** The plugin's `cpp-status` answer, or null when it isn't one. */
export function readCppStatus(answer: unknown): CppStatus | null {
  if (!isRecord(answer) || typeof answer.canCompile !== "boolean") return null;
  const moduleOk = answer.module === null || (typeof answer.module === "string" && MODULE_NAME.test(answer.module));
  const adding = readAdding(answer.adding);
  if (!moduleOk || !adding) return null;
  return {
    canCompile: answer.canCompile,
    xcode: word(answer.xcode),
    platform: word(answer.platform),
    module: answer.module,
    adding,
  };
}

/** What a status means for this run's parts. */
export function cppSupport(status: CppStatus | null): CppSupport {
  if (!status) return { available: false, why: MESSAGE.NoAnswer };
  if (!status.canCompile) return { available: false, why: MESSAGE.CannotCompile(status.xcode, status.platform) };
  return { available: true, module: status.module };
}

/** Where one owner's C++ lives in the game's module `module`, from the game folder: a C++ sub-agent's folder. */
export function cppFolder(module: string, owner: string): string {
  return `unreal/Source/${module}/Parts/${owner}`;
}

/** What adding the module needs from the run: the plugin's two tools, its clock, its line to the user and its snapshot. */
export type CppSetup = {
  status: () => Promise<unknown>;
  add: () => Promise<unknown>;
  /** One plain line for the user, as the run's other cards are. */
  say: (line: string) => Promise<void>;
  snapshot: (reason: string) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  deadline: number;
  /** The game's name as the user knows it. */
  game: string;
};

/** The module `add-cpp-module` says is already there, or null when it started adding (or answered oddly). */
function alreadyThere(answer: unknown): string | null {
  const named = isRecord(answer) && answer.already === true && typeof answer.module === "string";
  return named && MODULE_NAME.test(answer.module) ? answer.module : null;
}

/** Asks how adding goes until it is done or failed, the time is up or the run is stopped; the module, or why not. */
async function waitForModule(setup: CppSetup): Promise<CppSupport> {
  const timeout = setup.now() + ADD_MODULE_TIMEOUT_MS;
  const until = Math.min(timeout, setup.deadline);
  while (setup.now() < until) {
    await setup.sleep(CPP_POLL_MS);
    if (setup.stopped()) return { available: false, why: MESSAGE.Stopped };
    const status = readCppStatus(await setup.status().catch(() => null));
    const state = status?.adding.state;
    if (state === CppAddState.Failed) return { available: false, why: MESSAGE.AddFailed(status?.adding.error ?? "") };
    if (state !== CppAddState.Done) continue;
    return status?.module ? { available: true, module: status.module } : { available: false, why: MESSAGE.NoModule };
  }
  return { available: false, why: until < timeout ? MESSAGE.RunTimeUp : MESSAGE.AddTimedOut, stillAdding: true };
}

/**
 * Before the editor is used again, when the wait for the module gave up while the plugin was still
 * adding it: waits until the plugin says it no longer is (or can't say), the run's time is up or the
 * run is stopped, since adding quits and reopens Unreal and writes the project's Source and
 * .uproject. A step played, snapshotted or restored meanwhile would meet a closed editor or catch
 * the module half-written. Nothing to wait for otherwise.
 */
export async function whileAdding(
  setup: Pick<CppSetup, "status" | "now" | "sleep" | "stopped" | "deadline">,
  support: CppSupport,
): Promise<void> {
  if (support.available || !support.stillAdding) return;
  while (setup.now() < setup.deadline && !setup.stopped()) {
    const status = readCppStatus(await setup.status().catch(() => null));
    if (status?.adding.state !== CppAddState.Adding) return;
    await setup.sleep(CPP_POLL_MS);
  }
}

/** Starts adding the module; the module when it was already there, or why it couldn't start. */
async function startAdding(setup: CppSetup): Promise<CppSupport | null> {
  try {
    const answer = await setup.add();
    const module = alreadyThere(answer);
    if (module) return { available: true, module };
    return isRecord(answer) && answer.started === true ? null : { available: false, why: MESSAGE.AddUnclear };
  } catch (refused) {
    const why = MESSAGE.AddRefused(reason((refused as Error)?.message ?? refused));
    // Genex's own hold (a lock not given) is told to the person in their words, never the agents'.
    const heldWords = isRecord(refused) ? cppHeldWords(refused) : null;
    return { available: false, why, ...(heldWords ? { heldWords } : {}) };
  }
}

/**
 * The run's C++ once C++ is `wanted` (a C++ sub-agent asked for it): unchanged when C++ is out, the game
 * has its module or nothing wants it; otherwise the module is added (the user told, Unreal restarting
 * once) and snapshotted so the sub-agents' copies hold it, or, when adding fails, takes too long or the
 * run is stopped, C++ is out for the rest of the run with why. A wait that gave up leaves the
 * editor's next use to wait for the plugin (`whileAdding`).
 */
export async function ensureCppModule(setup: CppSetup, support: CppSupport, wanted: boolean): Promise<CppSupport> {
  const needed = support.available && !support.module && wanted;
  if (!needed || setup.stopped()) return support;
  await setup.say(MESSAGE.Adding(setup.game));
  const added = (await startAdding(setup)) ?? (await waitForModule(setup));
  if (added.available) {
    await setup.snapshot(MESSAGE.CppModule);
    await setup.say(MESSAGE.Added(setup.game));
  } else if (!setup.stopped()) await setup.say(added.heldWords ?? MESSAGE.NotAdded(added.why));
  return added;
}

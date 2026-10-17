/**
 * Genex's own gates, registered for the facts they guard and run beside the plugins' hooks at the
 * same moments: code, never advice. A gate reads typed fields only (never the words of a problem),
 * and reaches a game only where the facts it names are served at the root, the folder a Loop works
 * in, of a game whose Loop is the web method's. Its answer is shaped like a plugin's (`HookReport`'s `blocked` and `notes`), so a caller merges
 * it after `fireHooks`.
 *
 * A module of its own: the parts that call it may be ones an agent kept from before, and a kept copy
 * exports only what it did then.
 */
import type { HookReport } from "../types/host-api.d.ts";
import {
  CoreFact,
  FACT_ROOT,
  type FactsOfDescriptor,
  hasFact,
  LoopProfile,
  loopProfileOf,
  servedFactsOf,
} from "./folder-facts.ts";
import { GENEX, HookEvent } from "./hooks.ts";

/** This part serves a Loop on a project of any kind: a run reads it by namespace before it leads one. */
export const SERVES_OPEN_LOOP = true;

/** Genex's own gates, by the name a block carries as its step. Never rename a value. */
export const BuiltinGate = { WebReady: "web.ready" } as const;
export type BuiltinGate = (typeof BuiltinGate)[keyof typeof BuiltinGate];

/** One of Genex's own gates: the moment it runs at and the facts it guards. */
export interface BuiltinHook {
  on: HookEvent;
  facts: readonly string[];
  gate: BuiltinGate;
}

/** Every gate of Genex's own, with the moment and the facts it is registered for. */
export const BUILTIN_HOOKS: readonly BuiltinHook[] = [
  // A web page that lacks the files it needs to load has nothing for a Loop to work on.
  { on: HookEvent.RunPrepare, facts: [CoreFact.WebGame], gate: BuiltinGate.WebReady },
];

/** What a gate is handed: the game as `game.list` describes it, and what the moment found. */
export interface GateInput {
  game: (FactsOfDescriptor & { name?: string }) | null | undefined;
  /** The files a web page needs that are not there, by name (`game.validate`'s `missing`). */
  missing?: unknown;
}

/** What Genex's gates answer at a moment: a block, or none, and their notes. */
export type GateReport = Pick<HookReport, "blocked" | "notes">;

/** Characters a file's name may not carry into a sentence: control characters. */
const CONTROL_CHARS = /\p{Cc}/u;

const MESSAGE = {
  thisGame: "this game",
  notReady: (name: string, missing: readonly string[]) =>
    `${name} is not ready for a run: ${missing.map((file) => `${file} is missing`).join("; ")}. Fix that first (a chat build can), then start again.`,
} as const;

/**
 * The gates that reach a game at a moment: those whose facts it is served by at its root, and only
 * for a web game's Loop (`loopProfileOf`): a project led in place is never asked for a web page,
 * whatever else its folder holds.
 */
export function gatesOn(on: HookEvent, game: FactsOfDescriptor): BuiltinGate[] {
  if (loopProfileOf(game) !== LoopProfile.Web) return [];
  const served = servedFactsOf(game);
  return BUILTIN_HOOKS.filter((hook) => hook.on === on && hook.facts.some((id) => hasFact(served, id, FACT_ROOT))).map(
    (hook) => hook.gate,
  );
}

/** The missing files as names, or none when the list is not a list of plain names. */
function namesOf(missing: unknown): string[] {
  if (!Array.isArray(missing)) return [];
  const plain = missing.every((name) => typeof name === "string" && name.trim() !== "" && !CONTROL_CHARS.test(name));
  return plain ? (missing as string[]) : [];
}

/** `web.ready`: why a web page that lacks the files it needs to load can't have a Loop, or null. */
function webReady(input: GateInput): string | null {
  const names = namesOf(input.missing);
  if (names.length === 0) return null;
  return MESSAGE.notReady(input.game?.name ?? MESSAGE.thisGame, names);
}

const GATES = {
  [BuiltinGate.WebReady]: webReady,
} as const satisfies Record<BuiltinGate, (input: GateInput) => string | null>;

/** Runs Genex's own gates at a moment for a game: the first block, with why. */
export function fireGates(on: HookEvent, input: GateInput): GateReport {
  for (const gate of gatesOn(on, input.game)) {
    const reason = GATES[gate](input);
    if (reason) return { blocked: { plugin: GENEX, tool: gate, reason }, notes: [] };
  }
  return { blocked: null, notes: [] };
}

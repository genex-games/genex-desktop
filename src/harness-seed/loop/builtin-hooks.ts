/**
 * Genex's own gates, registered for the facts they guard and run at the same moments as the plugins'
 * hooks: each finds a fact the Loop's lead reads as it starts (`moment-lines.ts` `gateLines`), and
 * holds nothing back. A gate reads typed fields only (never the words of a problem), and reaches a
 * game only where the facts it names are served at the root, the folder a Loop works in. Its answer
 * is shaped like a plugin's (`HookReport`'s `blocked` and `notes`): `blocked.reason` is what it found.
 *
 * A module of its own: the parts that call it may be ones an agent kept from before, and a kept copy
 * exports only what it did then.
 */
import type { HookReport } from "../types/host-api.d.ts";
import { CoreFact, FACT_ROOT, type FactsOfDescriptor, hasFact, servedFactsOf } from "./folder-facts.ts";
import { GENEX, HookEvent } from "./hooks.ts";
import { GATE_WORDS } from "./builtin-hooks-prompts.ts";

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
  // A web page that lacks the files it needs to load: the Loop's lead builds them first.
  { on: HookEvent.RunPrepare, facts: [CoreFact.WebGame], gate: BuiltinGate.WebReady },
];

/** What a gate is handed: the game as `game.list` describes it, and what the moment found. */
export interface GateInput {
  game: (FactsOfDescriptor & { name?: string }) | null | undefined;
  /** The files a web page needs that are not there, by name (`game.validate`'s `missing`). */
  missing?: unknown;
}

/** What Genex's gates answer at a moment: what one found (as a block, its reason), or none, and their notes. */
export type GateReport = Pick<HookReport, "blocked" | "notes">;

/** Characters a file's name may not carry into a sentence: control characters. */
const CONTROL_CHARS = /\p{Cc}/u;

/** The gates that reach a game at a moment: those whose facts it is served by at its root. */
export function gatesOn(on: HookEvent, game: FactsOfDescriptor): BuiltinGate[] {
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

/** `web.ready`: the files a web page needs to load that are not there, as the lead reads it, or null. */
function webReady(input: GateInput): string | null {
  const names = namesOf(input.missing);
  if (names.length === 0) return null;
  return GATE_WORDS.pageMissing(input.game?.name ?? GATE_WORDS.theGame, names);
}

const GATES = {
  [BuiltinGate.WebReady]: webReady,
} as const satisfies Record<BuiltinGate, (input: GateInput) => string | null>;

/** Runs Genex's own gates at a moment for a game: the first that found something, as a block with what it found. */
export function fireGates(on: HookEvent, input: GateInput): GateReport {
  for (const gate of gatesOn(on, input.game)) {
    const reason = GATES[gate](input);
    if (reason) return { blocked: { plugin: GENEX, tool: gate, reason }, notes: [] };
  }
  return { blocked: null, notes: [] };
}

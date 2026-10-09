/**
 * The module contract a plan may carry: which plan part owns which module, what each module
 * exposes, the conventions every part keeps, and the shared files one part owns and the others
 * read. Without it, parallel workers around one shared state object rewrite each other's modules.
 *
 * The contract is data: `parseModuleContract` holds it to its shape (one owner per path, every
 * owner a part of the plan) and answers a typed `ContractRefusal`, never a sentence to match. The
 * words are contract-prompts.ts's; the gate that holds loop workers to it is contract-gate.ts.
 *
 * Pure. A new module (seed upgrades keep an edited older sibling, and a new name imported from one
 * would not link), so everything the contract needs is here or in contract-prompts.ts.
 */
import { WorkerMode } from "../outcomes.ts";
import { ownMatches } from "../review.ts";
import { clip } from "../text.ts";
import { clipWords } from "../word-clip.ts";
import { parseJson, slug } from "./args.ts";

/** Why a plan's contract was refused: the code the plan's answer is worded from. Never rename a value. */
export const ContractRefusal = {
  NotJson: "not-json",
  NotObject: "not-object",
  NoModules: "no-modules",
  TooMany: "too-many",
  BadPath: "bad-path",
  OwnedTwice: "owned-twice",
  UnknownOwner: "unknown-owner",
} as const;
export type ContractRefusal = (typeof ContractRefusal)[keyof typeof ContractRefusal];

/** At most this many modules, shared files, conventions and API lines a contract keeps. */
export const MAX_CONTRACT_MODULES = 24;
export const MAX_CONTRACT_SHARED = 12;
const MAX_CONVENTIONS = 8;
const MAX_API_LINES = 12;
const MAX_REGISTERED = 12;
/**
 * How long one convention, one API line, a path or a registered name may be. A convention or an API
 * line longer than its room is cut at a word, with an ellipsis, never mid-word. The counts above
 * keep the whole contract bounded.
 */
const CONVENTION_CHARS = 400;
const API_CHARS = 400;
const PATH_CHARS = 200;
const NAME_CHARS = 80;
/** How much of a refused value the refusal quotes. */
const QUOTED_CHARS = 80;

/** What a module registers with the studio, so no other part's evidence loses it. */
export interface ContractRegisters {
  cameras: string[];
  demos: string[];
  probes: string[];
}

/** One module of the contract: its file, the part that owns it, and what it exposes. */
export interface ContractModule {
  path: string;
  owner: string;
  api: string[];
  /** The namespace of `state()` the module reports under, when it names one. */
  state?: string;
  registers?: ContractRegisters;
}

/** A file several parts read and one owns (the shared state object, the render layer). */
export interface ContractShared {
  path: string;
  owner: string;
}

/** The contract, as the harness holds a plan to it. */
export interface ModuleContract {
  conventions: string[];
  modules: ContractModule[];
  shared: ContractShared[];
  /** Made by the harness from the plan's owns, after the lead gave none (contract-gate.ts). */
  derived?: boolean;
}

/** A refused contract: the code, and the value the refusal names. */
export interface ContractProblem {
  code: ContractRefusal;
  detail: string;
}

/** A part as the contract reads it from the plan: its id, and whether it is only ever a single session. */
export interface ContractPart {
  id: string;
  single?: boolean;
  owns?: string[];
}

/** Parts a loop worker builds: every part not marked `"mode":"single"`. */
export function loopParts(plan: { workers?: readonly ContractPart[] } | null | undefined): ContractPart[] {
  return (plan?.workers ?? []).filter((part) => part.single !== true);
}

/** Does this plan need a contract before its loop workers start: two parts or more that loop. */
export function contractRequired(plan: { workers?: readonly ContractPart[] } | null | undefined): boolean {
  return loopParts(plan).length >= 2;
}

/** Is this part only ever a single session (`"mode":"single"` on the plan, in any case, as worker_start reads it)? */
export function singlePart(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  return String((raw as { mode?: unknown }).mode ?? "").toLowerCase() === WorkerMode.Single;
}

/**
 * A path the contract may name: a file relative to the game — no absolute path, no `..`, no glob,
 * no control character, nothing inside `.git`. Answers the path tidied (a leading `./` dropped), or
 * null when it is not one.
 */
export function contractPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/^(?:\.\/)+/, "");
  if (!path || path.length > PATH_CHARS) return null;
  if (path.startsWith("/") || path.startsWith("-") || path.includes("\\")) return null;
  if (/[*?[\]\p{Cc}]/u.test(path)) return null;
  const segments = path.split("/");
  const badSegment = segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (badSegment || segments[0] === ".git") return null;
  return path;
}

/** Trimmed, non-empty strings of an array (or one string), at most `max`, each clipped (at a word with `words`). */
function strings(value: unknown, max: number, chars: number, { words = false }: { words?: boolean } = {}): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const cut = words ? clipWords : clip;
  return raw
    .filter((entry) => typeof entry === "string" || typeof entry === "number")
    .map((entry) => cut(String(entry).trim(), chars))
    .filter(Boolean)
    .slice(0, max);
}

/** What a module says it registers, when it says anything. */
function registersOf(value: unknown): ContractRegisters | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const registers = {
    cameras: strings(raw.cameras ?? [], MAX_REGISTERED, NAME_CHARS),
    demos: strings(raw.demos ?? [], MAX_REGISTERED, NAME_CHARS),
    probes: strings(raw.probes ?? [], MAX_REGISTERED, NAME_CHARS),
  };
  const any = registers.cameras.length + registers.demos.length + registers.probes.length > 0;
  return any ? registers : undefined;
}

/** A refusal naming what it refused. */
const refused = (code: ContractRefusal, detail: unknown): { problem: ContractProblem } => ({
  problem: { code, detail: clip(typeof detail === "string" ? detail : JSON.stringify(detail ?? null), QUOTED_CHARS) },
});

type Owned = { path: string; owner: string };

/** One owned entry (a module or a shared file): its path and its owner, both checked. */
function ownedEntry(entry: unknown, partIds: readonly string[]): { owned: Owned } | { problem: ContractProblem } {
  const raw = (entry ?? {}) as Record<string, unknown>;
  const path = contractPath(raw.path);
  if (!path) return refused(ContractRefusal.BadPath, raw.path);
  const owner = slug(raw.owner);
  if (!partIds.includes(owner)) return refused(ContractRefusal.UnknownOwner, `${path} → ${String(raw.owner ?? "")}`);
  return { owned: { path, owner } };
}

/** A module entry, compiled. */
function moduleEntry(
  entry: unknown,
  partIds: readonly string[],
): { module: ContractModule } | { problem: ContractProblem } {
  const owned = ownedEntry(entry, partIds);
  if ("problem" in owned) return owned;
  const raw = (entry ?? {}) as Record<string, unknown>;
  const state = typeof raw.state === "string" ? clip(raw.state.trim(), NAME_CHARS) : "";
  const registers = registersOf(raw.registers);
  return {
    module: {
      ...owned.owned,
      api: strings(raw.api ?? [], MAX_API_LINES, API_CHARS, { words: true }),
      ...(state ? { state } : {}),
      ...(registers ? { registers } : {}),
    },
  };
}

/** The entries of one list (`modules` or `shared`), each compiled, or the first problem. */
function entriesOf<T>(
  value: unknown,
  max: number,
  compile: (entry: unknown) => { problem: ContractProblem } | T,
): { entries: T[] } | { problem: ContractProblem } {
  const raw = value === undefined || value === null ? [] : value;
  if (!Array.isArray(raw)) return refused(ContractRefusal.NotObject, raw);
  if (raw.length > max) return refused(ContractRefusal.TooMany, `${raw.length} > ${max}`);
  const entries: T[] = [];
  for (const entry of raw) {
    const compiled = compile(entry);
    if (typeof compiled === "object" && compiled !== null && "problem" in compiled) return compiled;
    entries.push(compiled as T);
  }
  return { entries };
}

/** The first path two entries both name (one owner per path), or null. */
function ownedTwice(entries: readonly Owned[]): string | null {
  const seen = new Set<string>();
  for (const { path } of entries) {
    if (seen.has(path)) return path;
    seen.add(path);
  }
  return null;
}

/**
 * A plan's `contract`, held to its shape: null when the plan gave none, the contract, or the
 * problem with it. `partIds` are the plan's own part ids — every owner must be one of them.
 */
export function parseModuleContract(
  raw: unknown,
  partIds: readonly string[],
): { contract: ModuleContract | null; problem?: undefined } | { problem: ContractProblem; contract?: undefined } {
  const parsed = parseJson(raw);
  if (parsed === null) return { contract: null };
  if (parsed?.__error) return refused(ContractRefusal.NotJson, raw);
  if (typeof parsed !== "object" || Array.isArray(parsed)) return refused(ContractRefusal.NotObject, parsed);
  const modules = entriesOf(parsed.modules, MAX_CONTRACT_MODULES, (entry) => {
    const compiled = moduleEntry(entry, partIds);
    return "problem" in compiled ? compiled : compiled.module;
  });
  if ("problem" in modules) return { problem: modules.problem };
  if (!modules.entries.length) return refused(ContractRefusal.NoModules, parsed.modules ?? null);
  const shared = entriesOf(parsed.shared, MAX_CONTRACT_SHARED, (entry) => {
    const compiled = ownedEntry(entry, partIds);
    return "problem" in compiled ? compiled : compiled.owned;
  });
  if ("problem" in shared) return { problem: shared.problem };
  const twice = ownedTwice([...modules.entries, ...shared.entries]);
  if (twice) return refused(ContractRefusal.OwnedTwice, twice);
  return {
    contract: {
      conventions: strings(parsed.conventions ?? [], MAX_CONVENTIONS, CONVENTION_CHARS, { words: true }),
      modules: modules.entries,
      shared: shared.entries,
    },
  };
}

/** Every path the contract gives an owner, with that owner. */
function ownedPaths(contract: ModuleContract): Owned[] {
  return [...contract.modules, ...contract.shared].map(({ path, owner }) => ({ path, owner }));
}

/** The paths the contract gives this part: its modules, then the shared files it owns. */
export function pathsOwnedBy(contract: ModuleContract | null | undefined, partId: string | null): string[] {
  if (!contract || !partId) return [];
  return ownedPaths(contract)
    .filter((entry) => entry.owner === partId)
    .map((entry) => entry.path);
}

/** The modules the contract gives this part. */
export function modulesOwnedBy(contract: ModuleContract | null | undefined, partId: string | null): ContractModule[] {
  if (!contract || !partId) return [];
  return contract.modules.filter((module) => module.owner === partId);
}

/**
 * Seam entries that would let this part edit another part's file: `owns` reaching a path the
 * contract gives someone else (the path itself, a folder above it, or a glob over it).
 */
export function ownsClaimingOthers(
  owns: readonly string[],
  contract: ModuleContract | null | undefined,
  partId: string | null,
): Array<{ own: string; path: string; owner: string }> {
  if (!contract) return [];
  const others = ownedPaths(contract).filter((entry) => entry.owner !== partId);
  const claims: Array<{ own: string; path: string; owner: string }> = [];
  for (const own of owns) {
    const hit = others.find((entry) => ownMatches(entry.path, own));
    if (hit) claims.push({ own, path: hit.path, owner: hit.owner });
  }
  return claims;
}

/**
 * The plan part a worker builds: its own id, else the worker it restarts, else the goal it
 * advances — whichever is a part of the plan. Null for a worker the plan does not name.
 */
export function partOfWorker(
  plan: { workers?: readonly ContractPart[] } | null | undefined,
  candidates: readonly unknown[],
): string | null {
  const ids = new Set((plan?.workers ?? []).map((part) => part.id));
  for (const candidate of candidates) {
    const id = slug(candidate);
    if (id && ids.has(id)) return id;
  }
  return null;
}

/**
 * The contract the harness writes when the lead gave none (contract-gate.ts): each loop part owns
 * the plain files of its `owns` that exist, and a file two parts both name has no owner at all.
 */
export function derivedContract(parts: readonly ContractPart[], exists: ReadonlySet<string>): ModuleContract {
  const claims = new Map<string, string[]>();
  for (const part of parts) {
    for (const own of part.owns ?? []) {
      const path = contractPath(own);
      if (!path || !exists.has(path)) continue;
      claims.set(path, [...new Set([...(claims.get(path) ?? []), part.id])]);
    }
  }
  const modules = [...claims.entries()]
    .filter(([, owners]) => owners.length === 1)
    .map(([path, owners]) => ({ path, owner: owners[0] as string, api: [] }));
  return { conventions: [], modules, shared: [], derived: true };
}

/** Are two contracts the same data (a re-plan that repeats it commits nothing)? */
export function sameContract(a: ModuleContract | null | undefined, b: ModuleContract | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

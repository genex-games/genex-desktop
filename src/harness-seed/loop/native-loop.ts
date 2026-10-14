/**
 * The loop's compiled-stack rules outside review (native-review.ts has those): the folder an
 * intake asks the host for (Rust · wgpu for a desktop or phone destination, or when asked; never
 * C++ · raylib, whose creation is retired), the union merge a compiled entry takes, which stack a
 * night is on, and the night a kept pre-native part or a folder with nothing to build refuses, by
 * code. Every per-stack answer is a table over the stacks, never a raylib-or-not test.
 *
 * A new module on purpose (the seed-upgrade rule): the loop's existing modules import these names
 * from here, never from one another, so a part the agent kept from before native support still
 * links. It reads the native contract (native-contract.ts) and nothing of the loop's own.
 */
import type { GameValidationCode } from "../types/host-api.d.ts";
import {
  BuildTarget,
  GameStack,
  NativeNightRefusal,
  ProjectKind,
  STACK_OF_KIND,
  STACK_TARGETS,
  TargetRefusal,
  nativeNightRefused,
  stackForTargets,
} from "./native-contract.ts";

/**
 * This module tells a Rust · wgpu game from a browser one by its kind, stamps it, scaffolds it and
 * shapes its plan: a copy kept from before Rust games read one as three.js, and run-dispatch.ts
 * refuses a Rust night on it (`RUST_PARTS`).
 */
export const SERVES_RUST = true;

/** A stack whose games are compiled: everything but three.js. */
export type CompiledStack = Exclude<GameStack, typeof GameStack.ThreeJs>;

/** The kind a compiled stack's template scaffolds as (`game.scaffold` `kind`). */
const KIND_OF_STACK = {
  [GameStack.RaylibCpp]: ProjectKind.RaylibCpp,
  [GameStack.RustWgpu]: ProjectKind.RustWgpu,
} as const satisfies Record<CompiledStack, ProjectKind>;

/** Whether `stack` is a compiled one (a key of `KIND_OF_STACK`). */
function isCompiledStack(stack: unknown): stack is CompiledStack {
  return typeof stack === "string" && Object.hasOwn(KIND_OF_STACK, stack);
}

/** What the chat is told. */
const MESSAGE = {
  nativePartsMissing: (name: string) =>
    `${name} is a C++ · raylib game, and part of the studio's own loop was kept from before it could build C++ games (an edited copy survives an update), so tonight would be judged by rules meant for web pages. Bring that edit up to date with the studio's current loop, then start again.`,
  stackIsFixed: (name: string) =>
    `${name} is a browser game (three.js), and a game keeps the kind it was made as: Mac, Windows and Linux need a Rust · wgpu game. Start a new game for the desktop, or build ${name} for the browser.`,
  compiledStackIsFixed: (name: string, targets: readonly string[]) =>
    `${name} is a C++ · raylib game, and a game keeps the kind it was made as: a raylib game cannot be built for ${targets.join(" or ")}, which needs a Rust game. Start a new game for it, or keep ${name}'s destinations.`,
} as const;

/** Every destination, in the order the host lists them. */
const ALL_TARGETS: readonly string[] = Object.values(BuildTarget);

/**
 * The validation codes that leave a night nothing to build on: a file the game needs is missing,
 * studio.json names a stack its files are not, or a newer Genex made the game (it opens
 * read-only, and nothing may write into it). A missing contract is not one: installing it is the
 * night's first job (`game.validate` `codes`).
 */
const RefusingCode = {
  MissingFile: "missing-file",
  NativeMissingCMake: "native-missing-cmake",
  NativeMissingMain: "native-missing-main",
  StackContradictsKind: "stack-contradicts-kind",
  KindUnsupported: "kind-unsupported",
} as const satisfies Record<string, GameValidationCode>;
const REFUSING_CODES: readonly string[] = Object.values(RefusingCode);
/** The typed reasons a launch is refused for, which the chat records beside its sentence. */
const LAUNCH_REFUSALS: readonly string[] = [...Object.values(NativeNightRefusal), ...Object.values(TargetRefusal)];

/** A game as the loop reads it from `game.list`: its name, and its shape's kind and entry. */
export interface NativeDescriptor {
  name?: string;
  shape?: { kind?: string; main?: string } | null;
}

/** What `game.scaffold` is asked beyond the name: a compiled template and its destinations, or nothing. */
export interface ScaffoldAsk {
  kind?: (typeof KIND_OF_STACK)[CompiledStack];
  targets?: BuildTarget[];
}

/** The destinations an intake chose, as the host takes them: known ones only, each once. */
function chosenTargets(raw: unknown): BuildTarget[] {
  if (!Array.isArray(raw)) return [];
  const known = raw.filter((target): target is BuildTarget => ALL_TARGETS.includes(target));
  return [...new Set(known)];
}

/** Whether a game of `stack` may name `target` (native-contract.ts `STACK_TARGETS`). */
function namesTarget(stack: GameStack, target: BuildTarget): boolean {
  const named: readonly BuildTarget[] = STACK_TARGETS[stack];
  return named.includes(target);
}

/**
 * What a scaffold asks for after an intake chose `targets` (and, when it named one, `stack`): a
 * compiled template and those destinations, else nothing new (the three.js template, as always).
 * Any destination beyond the browser, a desktop or a phone, asks for Rust · wgpu, and so does an
 * asked-for Rust · wgpu game whatever its destinations (native-contract.ts `stackForTargets`).
 * Never C++ · raylib: its creation is retired, and existing raylib games keep their own folders.
 */
export function scaffoldFor(targets: unknown, stack?: unknown): ScaffoldAsk {
  const chosen = chosenTargets(targets);
  const asked = stackForTargets(chosen, stack === GameStack.RustWgpu ? GameStack.RustWgpu : undefined);
  if (!isCompiledStack(asked)) return {};
  return { kind: KIND_OF_STACK[asked], targets: chosen };
}

/** Whether `kind` is one this seed knows (native-contract.ts `ProjectKind`). */
function isKnownKind(kind: string | undefined): kind is ProjectKind {
  return kind !== undefined && Object.hasOwn(STACK_OF_KIND, kind);
}

/**
 * The stack a shape is, by its kind (native-contract.ts `STACK_OF_KIND`): C++ · raylib and Rust ·
 * wgpu are their own, every other kind is a browser game, and so is a kind this seed does not
 * know. The folder's kind decides, never what studio.json claims.
 */
export function stackOfShape(shape: NativeDescriptor["shape"]): GameStack {
  const kind = shape?.kind;
  return isKnownKind(kind) ? STACK_OF_KIND[kind] : GameStack.ThreeJs;
}

/**
 * The compiled stack a run was stamped with (`run.stack`, set where the night learns its game):
 * C++ · raylib or Rust · wgpu, else null — a three.js night, or one started before stacks were
 * stamped.
 */
export function stampedStack(run: Readonly<Record<string, unknown>> | null | undefined): CompiledStack | null {
  const stack = run?.stack;
  return isCompiledStack(stack) ? stack : null;
}

/**
 * The stack a night is on: the folder's kind when it exists, else what the intake chose for the
 * folder it is about to scaffold (`targets`, and the `stack` it named, if any).
 */
export function nightStack(
  descriptor: NativeDescriptor | null | undefined,
  targets?: unknown,
  stack?: unknown,
): GameStack {
  if (descriptor) return stackOfShape(descriptor.shape);
  const kind = scaffoldFor(targets, stack).kind;
  return kind ? STACK_OF_KIND[kind] : GameStack.ThreeJs;
}

/** The shape a compiled template has once scaffolded (the host's own per kind): its page comes from the lane. */
interface CompiledTemplateShape {
  readonly entry: string;
  readonly main: string;
  readonly build: null;
  readonly install: null;
  readonly own: false;
  readonly kind: (typeof KIND_OF_STACK)[CompiledStack];
  readonly serve: string;
}

/** Each compiled template's shape (substrate/project-shape.ts `COMPILED_SHAPES`). */
const TEMPLATE_SHAPES = {
  [GameStack.RaylibCpp]: Object.freeze({
    entry: "index.html",
    main: "src/main.cpp",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RaylibCpp,
    serve: ".",
  }),
  [GameStack.RustWgpu]: Object.freeze({
    entry: "index.html",
    main: "src/main.rs",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RustWgpu,
    serve: ".",
  }),
} as const satisfies Record<CompiledStack, CompiledTemplateShape>;

/**
 * The shape a night plans with before its folder exists: the compiled template's the intake asked
 * for (`scaffoldFor`), else null (the caller's three.js template shape, as always).
 */
export function templateShapeFor(targets: unknown, stack?: unknown): CompiledTemplateShape | null {
  const kind = scaffoldFor(targets, stack).kind;
  if (!kind) return null;
  const compiled = STACK_OF_KIND[kind];
  return isCompiledStack(compiled) ? TEMPLATE_SHAPES[compiled] : null;
}

/**
 * How a union merge of the FACET WIRING block is asked for this shape (merge.ts `unionMergeMain`):
 * the entry the shape names, and whether it has the template's wiring block. A compiled entry
 * always does (`src/main.cpp`, `src/main.rs`), whatever the folder's own-shape flag says; a
 * browser game has one only on the studio's template.
 */
export function wiringFor(
  shape: { kind?: string; main?: string } | null | undefined,
  ownShape: boolean,
): { main?: string; wiring: boolean } {
  const wiring = stackOfShape(shape) === GameStack.ThreeJs ? !ownShape : true;
  return { ...(shape?.main ? { main: shape.main } : {}), wiring };
}

/**
 * The typed refusal a raylib night meets when a part it runs predates native support (`served`
 * is native-contract.ts `servesNative` over the caller's parts); null for every other game, and
 * for a raylib game whose parts all serve one.
 */
export function nativeNightRefusal(
  descriptor: NativeDescriptor | null | undefined,
  served: boolean,
): (Error & { code: NativeNightRefusal }) | null {
  if (served || stackOfShape(descriptor?.shape) !== GameStack.RaylibCpp) return null;
  return nativeNightRefused(
    NativeNightRefusal.PartsMissing,
    MESSAGE.nativePartsMissing(descriptor?.name ?? "this game"),
  );
}

/**
 * The refusal a launch meets when the intake chose a destination the game's own stack cannot name
 * (`STACK_TARGETS`): a desktop one for a browser game, a phone for a raylib game. Its stack is fixed
 * (`TargetRefusal.StackIsFixed`), so the night would build the old stack and drop the destination
 * without a word. Null for every other launch.
 */
export function stackChangeRefusal(
  descriptor: NativeDescriptor | null | undefined,
  targets: unknown,
): (Error & { code: typeof TargetRefusal.StackIsFixed }) | null {
  if (!descriptor || !scaffoldFor(targets).kind) return null;
  // A game's own stack may name these destinations already (a raylib game and the desktop).
  const stack = stackOfShape(descriptor.shape);
  const beyond = chosenTargets(targets).filter((target) => !namesTarget(stack, target));
  if (beyond.length === 0) return null;
  const name = descriptor.name ?? "this game";
  const sentence =
    stack === GameStack.ThreeJs ? MESSAGE.stackIsFixed(name) : MESSAGE.compiledStackIsFixed(name, beyond);
  return Object.assign(new Error(sentence), { code: TargetRefusal.StackIsFixed });
}

/** The typed reason a refused launch threw (a native night's or a destination's), else null. */
export function launchRefusalCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && LAUNCH_REFUSALS.includes(code) ? code : null;
}

/**
 * Each problem's code, or null for one the host left uncoded. A host that codes every problem (a
 * C++ game) is read one to one. One that codes only some — a browser game, whose validation says
 * its missing files first, then what it has no code for, then the missing contract and a stack
 * its files contradict (substrate/game-validation.ts) — is aligned by that order.
 */
function codeOfEachProblem(problems: readonly string[], codes: readonly string[]): Array<string | null> {
  if (codes.length >= problems.length) return problems.map((_problem, index) => codes[index] ?? null);
  const leading = codes.findIndex((code) => code !== RefusingCode.MissingFile);
  const missingFiles = leading === -1 ? codes.length : leading;
  const uncoded: null[] = Array.from({ length: problems.length - codes.length }, () => null);
  return [...codes.slice(0, missingFiles), ...uncoded, ...codes.slice(missingFiles)];
}

/**
 * The problems that leave a night nothing to build on, read by their codes (`game.validate`
 * `codes`), never by their words: only those are named. A refusing code no problem can be matched
 * to still refuses, with every problem said.
 */
export function refusingProblems(problems: readonly string[], codes: readonly string[]): string[] {
  const refuses = (code: string | null): boolean => code !== null && REFUSING_CODES.includes(code);
  const byProblem = codeOfEachProblem(problems, codes);
  const named = problems.filter((_problem, index) => refuses(byProblem[index] ?? null));
  if (named.length || !codes.some(refuses)) return named;
  return problems.length ? [...problems] : codes.filter(refuses);
}

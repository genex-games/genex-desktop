/**
 * Create game's "Where will people play?": the boxes the person ticks, the compiled stack the
 * dialog makes and the host decide which boxes are refused or only labelled here, the exact
 * `createGame` call the dialog makes, and when the Toolchain sheet opens for that stack (a Rust
 * game's sheet reads its own components and lock). Which stacks the dialog offers is
 * {@link stackOffer}: Three.js and Rust · wgpu where main's creation gate is open, its lane runs
 * and its toolchain is installed or reachable, starting on the one the `stackDefault` switch
 * names; never C++ · raylib, whose creation is retired (M6.3). Pure, so conformance tests hold it
 * without a DOM.
 */
import { StudioPlatform } from "../shared/boot.ts";
import {
  ALL_BUILD_TARGETS,
  BuildTarget,
  type CompiledStack,
  CREATABLE_STACKS,
  type CreatableStack,
  GameStack,
  MOBILE_TARGETS,
  parseStackDefaultSwitch,
  StackDefaultSwitch,
} from "../shared/game-project.ts";
import { buildRefusal, runRefusal, STACK_HOST_MATRIX, TargetRefusal } from "../shared/game-targets.ts";
import { laneRunsOn, setupTargets } from "../shared/stack-setup.ts";
import type { StudioApi } from "../shared/studio-api.ts";
import type { ToolchainHost, ToolchainId, ToolchainStatus } from "../shared/toolchain.ts";
import { missingForStack } from "./panels/toolchain-view.ts";

/** A new game is a browser game until the person ticks something else. */
export const DEFAULT_DESTINATION_CHECKS: readonly BuildTarget[] = Object.freeze([BuildTarget.Web]);

/** What the dialog knows about this computer when it decides which stacks to offer. */
export interface StackGate {
  /** The OS Studio runs on (`hostOf(hostPlatform())`), or null on one it does not build for. */
  platform: StudioPlatform | null;
  /**
   * The toolchain host the store answered with: null where nothing is pinned (an Intel Mac),
   * undefined until the store has answered.
   */
  toolchainHost: ToolchainHost | null | undefined;
  /**
   * Main's Rust · wgpu creation gate (`main/core/stack-gate.ts`): open in a developer run and, in a
   * release build, where the Rust lane runs (an Apple-silicon Mac, the Linux Studio).
   */
  rustCreation: boolean;
  /** Whether the computer is online: a first Rust setup downloads its toolchain. */
  online: boolean;
  /**
   * Whether this profile's store already holds Rust · wgpu's setup for this host
   * ({@link rustSetupReady}): offline is then no reason to withhold it. Absent: not known yet.
   */
  rustToolchainReady?: boolean;
  /** The new-game stack switch main read from the settings (`stackDefault`); absent, the shipped one. */
  stackDefault?: StackDefaultSwitch;
}

/** The stacks the dialog lists as explicit choices ("Made in"), and the one it starts on. */
export interface StackOffer {
  /** In the order the dialog lists them: Three.js and Rust · wgpu where Rust is offered, else none (a browser game). */
  stacks: readonly CreatableStack[];
  /** The stack the dialog starts on, never one this host cannot build; absent, it makes a browser game. */
  initial?: CreatableStack;
  /** With no compiled stack offered, why the desktop boxes are refused. */
  unoffered?: TargetRefusal;
}

/**
 * Whether `stack`'s setup prepares anything on this host. Before the store answers, the platform's
 * row is trusted, as the compiled entry always did; an answered host without a pinned toolchain
 * (an Intel Mac) prepares nothing.
 */
function prepares(stack: CompiledStack, gate: StackGate): boolean {
  if (!gate.platform || !laneRunsOn(stack, gate.platform)) return false;
  if (gate.toolchainHost === undefined) return STACK_HOST_MATRIX[stack][gate.platform].build.length > 0;
  return setupTargets(stack, gate.toolchainHost).length > 0;
}

/**
 * Rust · wgpu: main's gate open, its toolchain reachable (online, or already installed here, as
 * `defaultStackFor` reads an offline launch), where its lane prepares something.
 */
function rustOffered(gate: StackGate): boolean {
  const reachable = gate.online || gate.rustToolchainReady === true;
  return gate.rustCreation && reachable && prepares(GameStack.RustWgpu, gate);
}

/**
 * The stacks Create game offers on this host, and the one it starts on. C++ · raylib creation is
 * retired (M6.3), so it is never offered on any host. Rust · wgpu is offered where main's creation
 * gate is open (`stack-gated` where it is closed), its toolchain is reachable (online, or installed
 * here; `toolchain-offline` otherwise) and its lane prepares something, trusting the platform until
 * the store names the host. Where it is offered, Three.js is offered beside it and the dialog starts
 * on the stack the `stackDefault` switch names: Rust · wgpu as shipped, Three.js once the switch is
 * reverted, with Rust · wgpu still one choice away. Where it is not, the dialog makes only a
 * browser game and says why its desktop boxes are refused.
 */
export function stackOffer(gate: StackGate): StackOffer {
  if (!rustOffered(gate)) {
    return { stacks: [], unoffered: gate.online ? TargetRefusal.StackGated : TargetRefusal.ToolchainOffline };
  }
  const reverted = parseStackDefaultSwitch(gate.stackDefault) === StackDefaultSwitch.ThreeJs;
  return { stacks: CREATABLE_STACKS, initial: reverted ? GameStack.ThreeJs : GameStack.RustWgpu };
}

/** The compiled stack a "Made in" choice makes: Rust · wgpu, or none for Three.js (a browser game). */
export function compiledChoice(stack: CreatableStack | undefined): CompiledStack | undefined {
  return stack === GameStack.RustWgpu ? stack : undefined;
}

/**
 * Why the desktop boxes are refused while the dialog makes no compiled game: the offer's reason
 * when no compiled stack is offered, else `not-a-destination` (Three.js was chosen: it plays in
 * the browser, and Rust · wgpu is one choice away).
 */
export function browserOnlyRefusal(offer: StackOffer): TargetRefusal {
  return offer.unoffered ?? TargetRefusal.NotADestination;
}

/**
 * Whether the store's answer holds everything Rust · wgpu's setup prepares on its host: nothing
 * to download, so Create game may offer Rust while offline.
 */
export function rustSetupReady(status: ToolchainStatus): boolean {
  const targets = setupTargets(GameStack.RustWgpu, status.host);
  if (targets.length === 0) return false;
  const missing = missingForStack(status, targets, GameStack.RustWgpu);
  return !missing.clt && missing.components.length === 0;
}

/** What the boxes, the chosen stack and the host make of a new game. */
export interface DestinationChoice {
  /** Absent for a Three.js browser game, which is created exactly as before destinations existed. */
  stack?: CompiledStack;
  /** The destinations sent, in the table's order: the ticked boxes this host can build for. */
  targets: BuildTarget[];
  /** A box this host cannot build for, and why: it cannot be ticked. */
  disabled: Record<BuildTarget, TargetRefusal | null>;
  /** A box this host builds for but cannot run, and why: it can be ticked, and says so. */
  notes: Record<BuildTarget, TargetRefusal | null>;
}

/** One value per destination, in the table's order: the phones last. */
function perTarget(value: (target: BuildTarget) => TargetRefusal | null): Record<BuildTarget, TargetRefusal | null> {
  return {
    [BuildTarget.Web]: value(BuildTarget.Web),
    [BuildTarget.Mac]: value(BuildTarget.Mac),
    [BuildTarget.Windows]: value(BuildTarget.Windows),
    [BuildTarget.Linux]: value(BuildTarget.Linux),
    [BuildTarget.Ios]: value(BuildTarget.Ios),
    [BuildTarget.Android]: value(BuildTarget.Android),
  };
}

/**
 * The label a box carries on this host: only "not runnable here". The host's own OS needs
 * a game box to run (`runRefusal`); that is the stage's concern, not a reason to hesitate here.
 * An unknown host cannot promise any desktop build runs on it, and Studio runs no phone build on
 * any host: a Simulator, emulator or phone launch is the person's.
 */
function noteFor(host: StudioPlatform | null, target: BuildTarget): TargetRefusal | null {
  if (target === BuildTarget.Web) return null;
  if (!host || MOBILE_TARGETS.includes(target)) return TargetRefusal.NotRunnableHere;
  const refusal = runRefusal(host, target, { gameBox: true });
  return refusal === TargetRefusal.NotRunnableHere ? refusal : null;
}

/**
 * The host's own refusal of `target`: Mac games are built on a Mac, and so are iPhone games (the
 * same Apple SDK licence), which the stack's host matrix names where it builds a phone at all.
 */
function hostRefusal(chosen: CompiledStack | undefined, host: StudioPlatform, target: BuildTarget) {
  if (!MOBILE_TARGETS.includes(target)) return buildRefusal(host, target);
  if (!chosen) return null;
  const builds: readonly BuildTarget[] = STACK_HOST_MATRIX[chosen][host].build;
  const appleOnly = target === BuildTarget.Ios && host !== StudioPlatform.Mac;
  return appleOnly && !builds.includes(target) ? TargetRefusal.MacBuildsNeedAMac : null;
}

/**
 * Why `target` cannot be ticked on `host`: the host's own refusal (Mac and iPhone games are built
 * on a Mac), else, for the compiled stack the dialog makes, a destination its lane does not build
 * here yet, and with none, every box but Browser (`unoffered`: a browser game is all it makes).
 */
function refusalFor(
  chosen: CompiledStack | undefined,
  host: StudioPlatform | null,
  target: BuildTarget,
  unoffered: TargetRefusal,
) {
  const refusal = host ? hostRefusal(chosen, host, target) : null;
  if (refusal) return refusal;
  if (!chosen) return target === BuildTarget.Web ? null : unoffered;
  if (!host) return null;
  const builds: readonly BuildTarget[] = STACK_HOST_MATRIX[chosen][host].build;
  return builds.includes(target) ? null : TargetRefusal.StackGated;
}

/**
 * The stack and destinations for `checked` boxes, the compiled stack the dialog makes and this
 * host. The stack is sent as given; without one the dialog makes a Three.js browser game, so a
 * desktop box never implies a stack here and is refused (`unoffered`, `stack-gated` unless told
 * otherwise). A refused box carries its refusal and no note.
 */
export function destinationChoice(
  checked: readonly BuildTarget[],
  chosen: CompiledStack | undefined,
  host: StudioPlatform | null,
  unoffered: TargetRefusal = TargetRefusal.StackGated,
): DestinationChoice {
  const disabled = perTarget((target) => refusalFor(chosen, host, target, unoffered));
  const targets = ALL_BUILD_TARGETS.filter((target) => checked.includes(target) && disabled[target] === null);
  return {
    ...(chosen ? { stack: chosen } : {}),
    targets,
    disabled,
    notes: perTarget((target) => (disabled[target] ? null : noteFor(host, target))),
  };
}

/** The stack the dialog's line names: Three.js unless the dialog makes a compiled game. */
export function shownStack(choice: DestinationChoice): GameStack {
  return choice.stack ?? GameStack.ThreeJs;
}

/**
 * The arguments of the dialog's one `createGame` call, or null when there is nothing to create
 * (no name, or no destination). A browser game sends neither stack nor targets, so it is created
 * exactly as it always was; a location adds `parent`.
 */
export function createGameArgs(
  title: string,
  choice: DestinationChoice,
  parent?: string,
): Parameters<StudioApi["createGame"]> | null {
  const name = title.trim();
  if (!name || choice.targets.length === 0) return null;
  const where = parent ? { parent } : {};
  if (!choice.stack) return parent ? [name, where] : [name];
  return [name, { ...where, stack: choice.stack, targets: [...choice.targets] }];
}

/** The full setup gaps offered in this dialog, so later destination choices do not prompt again. */
export interface SheetOffer {
  /** The stack whose setup was offered; absent on {@link NOTHING_OFFERED}. One offer per stack per dialog. */
  stack?: CompiledStack;
  clt: boolean;
  components: readonly ToolchainId[];
  prewarm?: readonly BuildTarget[];
}

/** A dialog that has not opened the sheet yet. */
export const NOTHING_OFFERED: SheetOffer = Object.freeze({ clt: false, components: Object.freeze([]) });

/**
 * Whether `choice` should ask the store what is installed: it is compiled, and it
 * reaches a destination the store has not been asked about for its stack in this dialog (`asked`
 * is that stack's list). Unticking a box asks nothing.
 */
export function asksToolchains(choice: DestinationChoice, asked: readonly BuildTarget[]): boolean {
  if (!choice.stack) return false;
  return choice.targets.some((target) => !asked.includes(target));
}

/**
 * What the Toolchain sheet has offered once it opens for `choice`, or null when it should stay
 * closed. `choice` is the latest one when the store answers, so an answer for a choice that is no
 * longer compiled opens nothing, and `offered` is what was offered for its stack. The sheet offers
 * the stack's complete setup on this host once, including Apple's separate prerequisite and stale
 * first builds, while game destinations stay the person's choice. A Rust game's gaps are its own
 * components under its own lock (`missingForStack`), never a C++ one.
 */
export function sheetOffer(status: ToolchainStatus, choice: DestinationChoice, offered: SheetOffer): SheetOffer | null {
  const { stack } = choice;
  if (!stack || choice.targets.length === 0) return null;
  const missing = missingForStack(status, setupTargets(stack, status.host), stack);
  const newComponents = missing.components.filter((id) => !offered.components.includes(id));
  const newClt = missing.clt && !offered.clt;
  const newPrewarm = missing.prewarm.filter((target) => !offered.prewarm?.includes(target));
  if (!newClt && newComponents.length === 0 && newPrewarm.length === 0) return null;
  return {
    stack,
    clt: offered.clt || missing.clt,
    components: [...offered.components, ...newComponents],
    ...(offered.prewarm || newPrewarm.length > 0 ? { prewarm: [...(offered.prewarm ?? []), ...newPrewarm] } : {}),
  };
}

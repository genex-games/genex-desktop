/**
 * What a build registers with the studio — its cameras, its demos and the state its probes read —
 * and which of those another part depends on. A worker that deletes cameras other workers' checks
 * look through goes unnoticed otherwise: a facet photographs only its own cameras, the health pass
 * photographs whatever the merged page still declares, and the other workers' checks simply turn
 * into failures nobody caused.
 *
 * `lostRegistrations` compares two looks at a build (before and after a change) against what the
 * other parts' checks use. The facet loop refuses a round that loses one (facet/phases/verify.ts),
 * and the director's health pass fails a merge that does (director/integrate.ts).
 *
 * Pure. A new module: the callers that upgrade with it import it, and nothing older does.
 */
import { DEFAULT_CAMERA } from "./cameras.ts";
import { dryRunChecks } from "./checks.ts";
import { isRecord } from "./json.ts";
import { isTruncatedState, StateShape, stateCutOf } from "./state-shape.ts";
import { CheckKind } from "./spec.ts";
import type { Check } from "./spec.ts";

/** What a build registers that another part's evidence can depend on. Never rename a value. */
export const RegistrationKind = {
  Camera: "camera",
  Demo: "demo",
  Probe: "probe",
} as const;
export type RegistrationKind = (typeof RegistrationKind)[keyof typeof RegistrationKind];

/** The frames the harness makes itself (`demo:x`, `eye:y`, `user:view`): never a registered camera. */
const HARNESS_FRAME = ":";

/**
 * Is this a camera a game registers? Not a harness frame, and not the harness's own `default`
 * view: every compiled spec looks through it, and studio.js stops listing it the moment a game
 * names a camera of its own, so a game's first named camera is not the loss of `default`.
 */
const registeredCamera = (camera: string): boolean => !camera.includes(HARNESS_FRAME) && camera !== DEFAULT_CAMERA;

/** A look's cameras without the harness's own views; null stays null (the look could not tell). */
const registeredOnly = (cameras: readonly string[] | null | undefined): string[] | null =>
  Array.isArray(cameras) ? cameras.filter(registeredCamera) : null;
/** A camera named `demo:x` is the frame demo x leaves: a dependency on that demo. */
const DEMO_FRAME = "demo:";
/** How many lost registrations one sentence names. */
const LOSSES_NAMED = 4;

/** The words a lost registration is reported in (a verdict's gap, a health problem). */
const MESSAGE = {
  loss: (loss: LostRegistration) =>
    `lost ${loss.kind} "${loss.name}", which ${loss.usedBy.join(", ")} ${loss.usedBy.length === 1 ? "depends" : "depend"} on`,
  more: (count: number) => `and ${count} more`,
  reason: "removed what another part's checks depend on",
} as const;

/** One look at a build, as the registry reads it: `null` for what that look could not tell. */
export interface RegistryLook {
  cameras?: readonly string[] | null;
  demos?: readonly string[] | null;
  state?: unknown;
  demoStates?: unknown;
}

/** One part that depends on what a build registers: its cameras, its demos and its probe checks. */
export interface RegistryDependent {
  id: string;
  cameras: string[];
  demos: string[];
  probes: Check[];
}

/** A registration that was there before, is gone after, and another part depends on. */
export interface LostRegistration {
  kind: RegistrationKind;
  name: string;
  usedBy: string[];
}

/** Can this state's probes be read at all: a state, not missing, not cut short by the studio? */
function readableState(state: unknown): boolean {
  if (!isRecord(state) || state[StateShape.Missing]) return false;
  return !isTruncatedState(state) && stateCutOf(state) === null;
}

/** A spec's checks, whatever shape the spec arrived in. */
const checksOf = (spec: { checks?: unknown }): Check[] =>
  (Array.isArray(spec.checks) ? spec.checks : []).filter((check): check is Check => isRecord(check));

/** The registered cameras a part looks through: its own cameras and every camera its checks name. */
function camerasOf(spec: { cameras?: unknown }, checks: readonly Check[]): string[] {
  const own = Array.isArray(spec.cameras) ? spec.cameras.map(String) : [];
  const named = checks.map((check) => String(check.camera ?? "")).filter(Boolean);
  return [...new Set([...own, ...named])].filter(registeredCamera);
}

/** The demos a part's checks run or look at (`demo` on a check, or a `demo:x` frame). */
function demosOf(checks: readonly Check[]): string[] {
  const named = checks.flatMap((check) => {
    const camera = String(check.camera ?? "");
    return [String(check.demo ?? ""), camera.startsWith(DEMO_FRAME) ? camera.slice(DEMO_FRAME.length) : ""];
  });
  return [...new Set(named.filter(Boolean))];
}

/** The parts other than `except` and what each of them depends on, from their specs. */
export function dependentsOf(
  facets: ReadonlyArray<{ id?: unknown; cameras?: unknown; checks?: unknown }> | null | undefined,
  except: readonly string[] = [],
): RegistryDependent[] {
  return (facets ?? [])
    .filter((facet) => isRecord(facet) && typeof facet.id === "string" && !except.includes(facet.id))
    .map((facet) => {
      const checks = checksOf(facet);
      return {
        id: String(facet.id),
        cameras: camerasOf(facet, checks),
        demos: demosOf(checks),
        probes: checks.filter((check) => check.kind === CheckKind.Probe && typeof check.expr === "string"),
      };
    });
}

/** Every demo the parts' checks name: what a health pass inside a wave runs. */
export function demosNamedBy(dependents: readonly RegistryDependent[]): string[] {
  return [...new Set(dependents.flatMap((dependent) => dependent.demos))];
}

/** Names registered before and gone after, each with the parts that use it; nothing when either look could not tell. */
function lostNames(
  kind: RegistrationKind,
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined,
  usedBy: (name: string) => string[],
): LostRegistration[] {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const present = new Set(after);
  return [...new Set(before)]
    .filter((name) => !present.has(name))
    .map((name) => ({ kind, name, usedBy: usedBy(name) }))
    .filter((loss) => loss.usedBy.length > 0);
}

/** The ids of a probe check the state no longer answers, by the paths it misses. */
function unsatisfiedIds(checks: readonly Check[], look: RegistryLook): Map<string, string[]> {
  const { unsatisfiable } = dryRunChecks(checks, { state: look.state, demoStates: look.demoStates ?? null });
  return new Map(unsatisfiable.map((entry) => [entry.id, entry.missing]));
}

/** Did this look run the demo (its state is among the look's demo states)? */
const ranDemo = (look: RegistryLook, demo: string): boolean => isRecord(look.demoStates) && demo in look.demoStates;

/**
 * The probes both looks read alike: a demo-scoped probe only when both ran its demo. A look that
 * did not run it (another facet's demo is only an extra slot) would read the main state instead.
 */
function comparableProbes(probes: readonly Check[], before: RegistryLook, after: RegistryLook): Check[] {
  return probes.filter((check) => {
    const demo = typeof check.demo === "string" ? check.demo : "";
    return !demo || (ranDemo(before, demo) && ranDemo(after, demo));
  });
}

/** The state paths one part's probes read before and cannot read after. */
function pathsGone(dependent: RegistryDependent, before: RegistryLook, after: RegistryLook): string[] {
  const probes = comparableProbes(dependent.probes, before, after);
  if (!probes.length) return [];
  const was = unsatisfiedIds(probes, before);
  return [...unsatisfiedIds(probes, after)].filter(([id]) => !was.has(id)).flatMap(([, missing]) => missing);
}

/** Probes other parts read that the state answered before and does not after. */
function lostProbes(before: RegistryLook, after: RegistryLook, dependents: readonly RegistryDependent[]) {
  if (!readableState(before.state) || !readableState(after.state)) return [];
  const losses = new Map<string, LostRegistration>();
  for (const dependent of dependents) {
    for (const name of pathsGone(dependent, before, after)) {
      const loss = losses.get(name) ?? { kind: RegistrationKind.Probe, name, usedBy: [] };
      if (!loss.usedBy.includes(dependent.id)) loss.usedBy.push(dependent.id);
      losses.set(name, loss);
    }
  }
  return [...losses.values()];
}

/**
 * What a change lost that another part depends on: cameras and demos registered before and gone
 * after, and state paths another part's probe read before and cannot after. A look that could not
 * tell (no registry, a missing, truncated or cut state) loses nothing of that kind.
 */
export function lostRegistrations({
  before,
  after,
  dependents,
}: {
  before: RegistryLook | null | undefined;
  after: RegistryLook | null | undefined;
  dependents: readonly RegistryDependent[];
}): LostRegistration[] {
  if (!before || !after || !dependents.length) return [];
  const users = (pick: (d: RegistryDependent) => readonly string[]) => (name: string) =>
    dependents.filter((dependent) => pick(dependent).includes(name)).map((dependent) => dependent.id);
  return [
    ...lostNames(
      RegistrationKind.Camera,
      registeredOnly(before.cameras),
      registeredOnly(after.cameras),
      users((d) => d.cameras),
    ),
    ...lostNames(
      RegistrationKind.Demo,
      before.demos,
      after.demos,
      users((d) => d.demos),
    ),
    ...lostProbes(before, after, dependents),
  ];
}

/** The losses in one sentence: the first few, and how many more. */
export function lostWords(losses: readonly LostRegistration[]): string {
  const named = losses.slice(0, LOSSES_NAMED).map(MESSAGE.loss);
  const more = losses.length > LOSSES_NAMED ? [MESSAGE.more(losses.length - LOSSES_NAMED)] : [];
  return [...named, ...more].join("; ");
}

/**
 * The facet loop's refusal of a challenger that lost a registration another facet depends on:
 * the verdict's gap and reason, or null when it lost nothing anyone uses.
 */
export function registryRefusal({
  facetId,
  facets,
  incumbent,
  challenger,
}: {
  facetId: string;
  facets: ReadonlyArray<{ id?: unknown; cameras?: unknown; checks?: unknown }> | null | undefined;
  incumbent: { registeredCameras?: unknown; registeredDemos?: unknown; state?: unknown; demoStates?: unknown } | null;
  challenger: { registeredCameras?: unknown; registeredDemos?: unknown; state?: unknown; demoStates?: unknown } | null;
}): { gap: string; reason: string; lost: LostRegistration[] } | null {
  const lost = lostRegistrations({
    before: lookOf(incumbent),
    after: lookOf(challenger),
    dependents: dependentsOf(facets, [facetId]),
  });
  if (!lost.length) return null;
  return { gap: lostWords(lost), reason: MESSAGE.reason, lost };
}

/**
 * A look's setup as a key: two looks under the same setup have the same key. Only those two can
 * tell which state paths a change lost; a judge's look under a setup it asked for reaches paths
 * the run's own setup never does.
 */
export function setupKey(setup: unknown): string {
  return JSON.stringify(setup ?? null);
}

/** An evidence pass's registry, as the registry reads it. */
export function lookOf(
  evidence: { registeredCameras?: unknown; registeredDemos?: unknown; state?: unknown; demoStates?: unknown } | null,
): RegistryLook | null {
  if (!evidence) return null;
  const names = (value: unknown) => (Array.isArray(value) ? value.map(String) : null);
  return {
    cameras: names(evidence.registeredCameras),
    demos: names(evidence.registeredDemos),
    state: evidence.state,
    demoStates: evidence.demoStates ?? null,
  };
}

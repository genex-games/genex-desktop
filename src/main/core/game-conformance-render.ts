/**
 * The game conformance suite's renderer checks (extension ladder M7.0, renderer rows), run on a
 * Rust · wgpu game whose `ready` receipt advertises `renderSettings`; a game without the verb (C++,
 * a Rust game built before it) is `unavailable` with `render-settings-unsupported` on both, which
 * `conformancePassed` counts green.
 *
 * - `render-presets`: every effective preset, then every phone class emulated as it ships (its own
 *   anti-aliasing, scene format and upscale, no switches), then every phone class with TAA, AO and
 *   exposure switched on (the temporal features a settled capture must reset), each set through the
 *   verb. Under each the answer names what was asked, a `renderSettings` without `set` reads the same
 *   settings back (the round trip), `state().volatile.render` is in its shape and names them (and,
 *   once the captures drew the case, has every switch it was sent on or names it in `degraded`), and
 *   two settled captures of one state are non-blank with one digest. Then the low and high captures
 *   must keep one look (mean luminance and dominant hue within tolerance), and, once the second run
 *   has booted, the two cold boots' first captures must sit on one pinned profile: `render`
 *   provenance that never came from the verb, the same settings both times and, for one state, one
 *   digest.
 * - `render-extensions`: as the game booted, then under every preset and the emulated mobile-mid and
 *   mobile-low classes (each drawn once through a capture), no custom GPU pass in
 *   `state().volatile.customPasses` is refused, no Level-2 source in `volatile.extensions` carries a
 *   refusal code and `volatile.render.degraded` names only typed reasons the receipt allows (a v1
 *   fallback only where the receipt still serves that v1 API). The status's whole shape is
 *   `render-presets`' to judge, so one defect fails one row.
 *
 * After each change both walks step the game until the drawn frame has it (Live keeps drawing the
 * settings it had, naming `pipeline-change-deferred`, while a new pipeline warms), so captures and
 * status reads judge the settings asked, not the last ones; a change still deferred after
 * {@link CHANGE_LANDS_MS} fails the case with `verb-invalid`.
 * Each check gives the game's own settings back when it ends, whatever happened.
 */
import {
  ConformanceCheck,
  type ConformanceCheckResult,
  ConformanceOutcome,
  ConformanceProblem,
} from "../../shared/game-conformance.ts";
import {
  type NativeCapabilityReceipt,
  type NativeCustomPassStatus,
  NativeOp,
  NATIVE_RENDER_KEY,
  nativeCustomPasses,
  nativeRenderStatus,
  receiptCustomPassApis,
  receiptExtensionApis,
  receiptServesRenderSettings,
} from "../../shared/native-contract.ts";
import type { PixelStats } from "../../shared/preview-contract.ts";
import {
  type CaptureProvenance,
  DegradeReason,
  DeviceClass,
  EFFECTIVE_PRESETS,
  type EffectivePreset,
  isDegradeReason,
  QualityPreset,
  type RenderDegrade,
  RenderFeature,
  type RenderSettingsAnswer,
  type RenderSettingsChange,
  type RenderStatus,
  SettingsSource,
} from "../../shared/render-quality.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { isEffectivelyBlack } from "../../substrate/pixel-stats.ts";
import type { ConformancePort } from "./game-conformance.ts";
import { always, CheckFailure, judged, result, verb } from "./game-conformance-verdict.ts";

/** A capture whose luma varies by less than this (standard deviation, 0..255) is one flat colour: blank. */
const BLANK_LUMA_STD = 0.5;
/** The most the low and high presets' mean luminance (0..255) may differ by: the look is the game's, not the preset's. */
export const LOOK_LUMA_TOLERANCE = 12;
/** The most the low and high presets' dominant hues may differ by, in degrees, where both frames have one. */
export const LOOK_HUE_TOLERANCE_DEG = 20;
/** A frame has a dominant hue when its saturation-weighted hue histogram agrees at least this much (0..1). */
const HUE_MIN_STRENGTH = 0.25;
/** Degrees in a turn. */
const TURN_DEG = 360;
/** The API version (extension and custom pass) whose fallbacks a receipt must still serve to report them. */
const LEGACY_API = 1;
/** The longest a settings change may take to reach the drawn frame (a pipeline warming on a slow Live frame). */
export const CHANGE_LANDS_MS = MINUTE_MS;
/** The sim time each wait for a change steps, and the wall time between its polls. */
const CHANGE_POLL_MS = 100;

const MESSAGE = {
  unsupported: "the game's receipt does not advertise renderSettings",
  answered: (label: string, asked: string, got: string) => `${label}: asked ${asked}, answered ${got}`,
  roundTrip: (label: string, set: string, read: string) =>
    `${label}: renderSettings answered ${set}, but a round trip reads ${read}`,
  notNamed: (label: string, wanted: string, got: string) =>
    `${label}: state().volatile.render says ${got}; the verb answered ${wanted}`,
  statusShape: (label: string) => `${label}: state().volatile.render is missing or outside its shape`,
  passesShape: (label: string) => `${label}: state().volatile.customPasses is outside its shape`,
  blank: (label: string) => `${label}: the capture is blank`,
  differs: (label: string, first: string | null, second: string | null) =>
    `${label}: two captures of one state differ: ${first ?? "no digest"} then ${second ?? "no digest"}`,
  lookLuma: (low: number, high: number) =>
    `low and high differ in mean luminance: ${low.toFixed(1)} then ${high.toFixed(1)} (tolerance ${LOOK_LUMA_TOLERANCE})`,
  lookHue: (low: number, high: number) =>
    `low and high differ in hue: ${low.toFixed(0)}° then ${high.toFixed(0)}° (tolerance ${LOOK_HUE_TOLERANCE_DEG}°)`,
  noProvenance: "a cold boot's capture names no render provenance",
  verbProvenance: "a cold boot's capture names the verb's settings, not the pinned profile",
  coldSettings: (first: string, second: string) =>
    `two cold boots captured one state under different settings: ${first} then ${second}`,
  coldDigest: (first: string, second: string) => `two cold boots captured one state as ${first} then ${second}`,
  passRefused: (label: string, pass: NativeCustomPassStatus) =>
    `${label}: ${pass.name} at ${pass.stage} is refused: ${pass.code ?? "stopped"}`,
  extensionRefused: (label: string, source: ExtensionRow) =>
    `${label}: ${source.path} (${source.kind}) is refused: ${source.code}`,
  extensionsShape: (label: string) => `${label}: state().volatile.extensions is outside its shape`,
  featureNotDrawn: (label: string, feature: RenderFeature) =>
    `${label}: ${feature} was switched on, but the drawn frame has it off and degraded does not name it`,
  notLanded: (label: string) =>
    `${label}: the drawn frame still holds the settings before the change (pipeline-change-deferred) after ${CHANGE_LANDS_MS / SECOND_MS} s`,
  untypedDegrade: (label: string, reason: string) => `${label}: degraded names ${reason}, which is no typed reason`,
  degrade: (label: string, degrade: RenderDegrade) =>
    `${label}: degraded names ${degrade.reason}${degrade.subject ? ` (${degrade.subject})` : ""}, which the receipt does not allow`,
  /** The label of the observation before any settings change. */
  asBooted: "as booted",
} as const;

/** The wall clock the waits for a change read, injected. */
export interface RenderClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** One settings the renderer checks put the game under, and what its answer must name. */
interface RenderCase {
  /** Names the case in a failure: the preset, or the emulated class. */
  label: string;
  change: RenderSettingsChange;
  /** The effective preset the answer must name; null where the class decides (any effective preset). */
  preset: EffectivePreset | null;
  /** The device class the answer must name; null where the case leaves the class alone. */
  deviceClass: DeviceClass | null;
}

const presetCase = (preset: EffectivePreset): RenderCase => ({
  label: preset,
  change: { preset },
  preset,
  deviceClass: null,
});

/** A phone class emulated on its own default preset, as it ships: no switches. */
const classCase = (deviceClass: DeviceClass): RenderCase => ({
  label: deviceClass,
  change: { preset: QualityPreset.Auto, deviceClass },
  preset: null,
  deviceClass,
});

/** A phone class emulated on its own default preset with the temporal features switched on. */
const temporalCase = (deviceClass: DeviceClass): RenderCase => ({
  label: `${deviceClass} (temporal)`,
  change: { preset: QualityPreset.Auto, deviceClass, features: TEMPORAL_ON },
  preset: null,
  deviceClass,
});

/** The temporal features each emulated phone class runs with in `render-presets`: each settles over history. */
const TEMPORAL_ON: Partial<Record<RenderFeature, boolean>> = {
  [RenderFeature.Taa]: true,
  [RenderFeature.Ao]: true,
  [RenderFeature.Exposure]: true,
};

/** The phone classes `render-presets` emulates, fastest first. */
const PHONE_CLASSES: readonly DeviceClass[] = [DeviceClass.MobileHigh, DeviceClass.MobileMid, DeviceClass.MobileLow];

/**
 * `render-presets`: every effective preset, then every phone class as it ships (the path a real phone
 * draws: its own anti-aliasing, scene format and upscale), then every phone class with the temporal
 * features on.
 */
const PRESET_CASES: readonly RenderCase[] = [
  ...EFFECTIVE_PRESETS.map(presetCase),
  ...PHONE_CLASSES.map(classCase),
  ...PHONE_CLASSES.map(temporalCase),
];

/** `render-extensions`: every effective preset, then the two weakest phone classes as they ship. */
const EXTENSION_CASES: readonly RenderCase[] = [
  ...EFFECTIVE_PRESETS.map(presetCase),
  classCase(DeviceClass.MobileMid),
  classCase(DeviceClass.MobileLow),
];

/** The presets whose captures must keep one look. */
const LOOK_LOW: EffectivePreset = QualityPreset.Low;
const LOOK_HIGH: EffectivePreset = QualityPreset.High;

/** What gives the game's and the person's settings back: no verb preset, the probed class, no verb switches. */
const RENDER_RESTORE: RenderSettingsChange = { preset: null, deviceClass: null, features: null };

/**
 * The fallbacks a receipt must still serve the v1 API of to report: a v1 in-world pass needs custom
 * pass API v1, a v1 material extension API v1. Every other typed reason is allowed.
 */
const DEGRADE_NEEDS_V1: Partial<Record<DegradeReason, (receipt: NativeCapabilityReceipt) => number[]>> = {
  [DegradeReason.CustomPassV1InWorld]: receiptCustomPassApis,
  [DegradeReason.MaterialV1InHdr]: receiptExtensionApis,
};

/** What a cold boot's first capture says: the state's checksum, the capture's digest and its render provenance. */
export interface ColdCapture {
  checksum: string;
  digest: string;
  render: CaptureProvenance | null;
}

/** The receipt of a game that serves `renderSettings`, or null for one that does not. */
async function renderReceipt(port: ConformancePort): Promise<NativeCapabilityReceipt | null> {
  const { receipt } = await port.ready();
  return receipt && receiptServesRenderSettings(receipt) ? receipt : null;
}

const unsupported = (check: ConformanceCheck): ConformanceCheckResult =>
  result(check, ConformanceOutcome.Unavailable, ConformanceProblem.RenderSettingsUnsupported, MESSAGE.unsupported);

/** Gives the game's own settings back. Best effort: a game that already ended has nothing to give back. */
async function restore(port: ConformancePort): Promise<void> {
  await port.call(NativeOp.RenderSettings, { set: RENDER_RESTORE }).catch(() => null);
}

/** A settings answer in words: the preset on the class. */
const settingsWords = (settings: Pick<RenderSettingsAnswer, "preset" | "deviceClass">): string =>
  `${settings.preset} on ${settings.deviceClass}`;

/** The verb under `each.change`, its answer checked against what the case asked. */
async function applyRenderCase(port: ConformancePort, each: RenderCase): Promise<RenderSettingsAnswer> {
  const answer = await verb(
    NativeOp.RenderSettings,
    () => port.call(NativeOp.RenderSettings, { set: each.change }),
    always,
  );
  const asked = each.preset ?? each.deviceClass ?? each.label;
  const presetWrong = each.preset !== null && answer.preset !== each.preset;
  const classWrong = each.deviceClass !== null && answer.deviceClass !== each.deviceClass;
  if (presetWrong || classWrong)
    throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.answered(each.label, asked, settingsWords(answer)));
  return answer;
}

/** Whether the last drawn frame still holds the settings before a change (`pipeline-change-deferred`). */
const changeDeferred = (status: RenderStatus | null): boolean =>
  status?.degraded.some((entry) => entry.reason === DegradeReason.PipelineChangeDeferred) === true;

/**
 * Steps the game until its drawn frame has the change `label` sent; a change still deferred after
 * {@link CHANGE_LANDS_MS} fails the case. Live draws on the wall clock, so each poll steps the sim
 * and waits.
 */
async function untilChangeLands(port: ConformancePort, clock: RenderClock, label: string): Promise<void> {
  const deadline = clock.now() + CHANGE_LANDS_MS;
  while (clock.now() < deadline) {
    const state = await verb(NativeOp.State, () => port.call(NativeOp.State), always);
    if (!changeDeferred(nativeRenderStatus(state))) return;
    await verb(NativeOp.Step, () => port.call(NativeOp.Step, { ms: CHANGE_POLL_MS }), always);
    await clock.sleep(CHANGE_POLL_MS);
  }
  throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.notLanded(label));
}

/** A `renderSettings` without `set` must read back the settings the change answered. */
async function checkRoundTrip(port: ConformancePort, label: string, answer: RenderSettingsAnswer): Promise<void> {
  const read = await verb(NativeOp.RenderSettings, () => port.call(NativeOp.RenderSettings, {}), always);
  const same =
    read.preset === answer.preset && read.requested === answer.requested && read.deviceClass === answer.deviceClass;
  if (!same)
    throw new CheckFailure(
      ConformanceProblem.VerbInvalid,
      MESSAGE.roundTrip(label, settingsWords(answer), settingsWords(read)),
    );
}

/** `state().volatile.render`, in its shape, or a `render-status-invalid` failure. */
async function readRenderStatus(port: ConformancePort, label: string): Promise<RenderStatus> {
  const state = await verb(NativeOp.State, () => port.call(NativeOp.State), always);
  const status = nativeRenderStatus(state);
  if (status === null) throw new CheckFailure(ConformanceProblem.RenderStatusInvalid, MESSAGE.statusShape(label));
  return status;
}

/** `state().volatile.render` must be in its shape and name the preset and class the verb answered. */
async function checkRenderNamed(port: ConformancePort, label: string, answer: RenderSettingsAnswer): Promise<void> {
  const status = await readRenderStatus(port, label);
  const wanted = settingsWords(answer);
  const got = settingsWords(status);
  if (got !== wanted) throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.notNamed(label, wanted, got));
}

/** The switches a case turned on. */
function switchedOn(each: RenderCase): RenderFeature[] {
  const features = each.change.features ?? {};
  return Object.values(RenderFeature).filter((feature) => features[feature] === true);
}

/**
 * Once the case's captures drew it, `state().volatile.render` must have every switch the case turned
 * on, or name it in `degraded` (its subject is the feature's wire name): a game that ignores
 * `features` never settles the history the case is for. Read after the captures because the status
 * and the verb's answer report the last drawn frame.
 */
async function checkSwitchesDrawn(port: ConformancePort, each: RenderCase): Promise<void> {
  const wanted = switchedOn(each);
  if (wanted.length === 0) return;
  const status = await readRenderStatus(port, each.label);
  const named = new Set(status.degraded.map((entry) => entry.subject));
  const missing = wanted.find((feature) => status.features[feature] !== true && !named.has(feature));
  if (missing) throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.featureNotDrawn(each.label, missing));
}

/** Whether a capture's pixel statistics say one flat colour. */
function isBlank(stats: PixelStats): boolean {
  return stats.contrast === undefined ? isEffectivelyBlack(stats) : stats.contrast < BLANK_LUMA_STD;
}

/** Two settled captures of one state under the settings in force: not blank, one digest. The first's statistics. */
async function checkRenderCaptured(port: ConformancePort, label: string): Promise<PixelStats> {
  const first = await verb(NativeOp.Capture, () => port.screenshotWithStats(), always);
  if (isBlank(first.stats)) throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.blank(label));
  const second = await verb(NativeOp.Capture, () => port.screenshotWithStats(), always);
  const { digest } = first.provenance;
  if (second.provenance.digest !== digest)
    throw new CheckFailure(
      ConformanceProblem.Nondeterministic,
      MESSAGE.differs(label, digest, second.provenance.digest),
    );
  return first.stats;
}

/** A frame's dominant hue in degrees (the saturation-weighted circular mean), or null where none dominates. */
function dominantHue(stats: PixelStats): number | null {
  const bins = stats.hueHistogram;
  if (!bins || bins.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const [index, weight] of bins.entries()) {
    const angle = ((index + 0.5) / bins.length) * 2 * Math.PI;
    x += weight * Math.cos(angle);
    y += weight * Math.sin(angle);
  }
  if (Math.hypot(x, y) < HUE_MIN_STRENGTH) return null;
  const degrees = (Math.atan2(y, x) * TURN_DEG) / (2 * Math.PI);
  return (degrees + TURN_DEG) % TURN_DEG;
}

/** The shorter way round the hue circle between two hues, in degrees. */
function hueGap(a: number, b: number): number {
  const apart = Math.abs(a - b) % TURN_DEG;
  return Math.min(apart, TURN_DEG - apart);
}

/** Why the low and high captures do not keep one look, or null when they do. */
export function lookProblem(low: PixelStats, high: PixelStats): string | null {
  if (Math.abs(low.meanLuma - high.meanLuma) > LOOK_LUMA_TOLERANCE)
    return MESSAGE.lookLuma(low.meanLuma, high.meanLuma);
  const lowHue = dominantHue(low);
  const highHue = dominantHue(high);
  if (lowHue === null || highHue === null) return null;
  return hueGap(lowHue, highHue) > LOOK_HUE_TOLERANCE_DEG ? MESSAGE.lookHue(lowHue, highHue) : null;
}

/** Every `render-presets` case in order (the first to fail ends the walk), then the look check. */
async function walkPresets(port: ConformancePort, clock: RenderClock): Promise<void> {
  const looks = new Map<string, PixelStats>();
  for (const each of PRESET_CASES) {
    const answer = await applyRenderCase(port, each);
    await untilChangeLands(port, clock, each.label);
    await checkRoundTrip(port, each.label, answer);
    await checkRenderNamed(port, each.label, answer);
    looks.set(each.label, await checkRenderCaptured(port, each.label));
    await checkSwitchesDrawn(port, each);
  }
  const low = looks.get(LOOK_LOW);
  const high = looks.get(LOOK_HIGH);
  const problem = low && high ? lookProblem(low, high) : null;
  if (problem) throw new CheckFailure(ConformanceProblem.LookInconsistent, problem);
}

/**
 * `render-presets` over one run, before the cold boots are compared (see {@link judgeColdBoots}):
 * `unavailable` (`render-settings-unsupported`) for a game whose receipt does not advertise the verb.
 */
export async function checkRenderPresets(port: ConformancePort, clock: RenderClock): Promise<ConformanceCheckResult> {
  const check = ConformanceCheck.RenderPresets;
  if ((await renderReceipt(port)) === null) return unsupported(check);
  const judgement = await judged(check, () => walkPresets(port, clock));
  await restore(port);
  return judgement;
}

/** A capture's render provenance in words. */
const provenanceWords = (render: CaptureProvenance): string =>
  `${render.preset} on ${render.deviceClass} (${render.settingsSource}, scale ${render.scale}, ${render.settleFrames} settle frames)`;

/** Every member of a capture's render provenance, in one order: two cold boots compare these. */
const provenanceKey = (render: CaptureProvenance): string =>
  JSON.stringify([
    render.preset,
    render.deviceClass,
    render.settingsSource,
    render.scale,
    render.settleFrames,
    render.historyReset,
    render.exposure,
  ]);

/** Why a cold boot's capture is not on the pinned profile, or null. */
function unpinned(cold: ColdCapture): string | null {
  if (cold.render === null) return MESSAGE.noProvenance;
  return cold.render.settingsSource === SettingsSource.Verb ? MESSAGE.verbProvenance : null;
}

/** Why two cold boots' captures disagree on the pinned profile, or null. */
function coldBootProblem(first: ColdCapture, second: ColdCapture | null): string | null {
  const own = unpinned(first) ?? (second ? unpinned(second) : null);
  if (own !== null || second === null || first.render === null || second.render === null) return own;
  if (provenanceKey(first.render) !== provenanceKey(second.render))
    return MESSAGE.coldSettings(provenanceWords(first.render), provenanceWords(second.render));
  const oneState = first.checksum === second.checksum;
  return oneState && first.digest !== second.digest ? MESSAGE.coldDigest(first.digest, second.digest) : null;
}

/**
 * `render-presets` with the pinned profile judged: a walk that passed fails `capture-unpinned` when
 * a cold boot's capture (the first capture of each run, before any verb) names no render provenance
 * or the verb's settings, or the two cold boots captured under different settings or, for one
 * state, as two digests. A run that never captured is judged by `seed-determinism`, not here.
 */
export function judgeColdBoots(
  walk: ConformanceCheckResult,
  first: ColdCapture | null,
  second: ColdCapture | null,
): ConformanceCheckResult {
  if (walk.outcome !== ConformanceOutcome.Pass || first === null) return walk;
  const problem = coldBootProblem(first, second);
  if (problem === null) return walk;
  return result(walk.check, ConformanceOutcome.Fail, ConformanceProblem.CaptureUnpinned, problem);
}

/** Whether the receipt allows a typed degrade reason (see {@link DEGRADE_NEEDS_V1}). */
function degradeAllowed(reason: DegradeReason, receipt: NativeCapabilityReceipt): boolean {
  const served = DEGRADE_NEEDS_V1[reason];
  return served === undefined || served(receipt).includes(LEGACY_API);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The entries `state().volatile.render.degraded` lists, read on their own (an empty list when there
 * is none): the status's whole shape is `render-presets`' to judge, so one defect fails one row.
 */
function degradedEntries(state: unknown): Record<string, unknown>[] {
  const volatile = isRecord(state) ? state.volatile : undefined;
  const render = isRecord(volatile) ? volatile[NATIVE_RENDER_KEY] : undefined;
  const degraded = isRecord(render) ? render.degraded : undefined;
  return Array.isArray(degraded) ? degraded.filter(isRecord) : [];
}

/** Why one degrade entry is not allowed under `receipt` (untyped, or a v1 fallback without v1), or null. */
function degradeProblem(
  label: string,
  entry: Record<string, unknown>,
  receipt: NativeCapabilityReceipt,
): string | null {
  const { reason, subject } = entry;
  if (!isDegradeReason(reason)) return MESSAGE.untypedDegrade(label, String(reason));
  const named: RenderDegrade = { reason, subject: typeof subject === "string" ? subject : null };
  return degradeAllowed(reason, receipt) ? null : MESSAGE.degrade(label, named);
}

/** One Level-2 source's admission as `state().volatile.extensions` lists it: its path, kind and refusal code. */
interface ExtensionRow {
  path: string;
  kind: string;
  code: string | null;
}

/** The longest path, kind or code an extension row may carry. */
const EXTENSION_TEXT_MAX_CHARS = 512;
/** The most rows `volatile.extensions` may list. */
const EXTENSIONS_MAX = 64;
/** The `volatile` key Level-2 admissions are listed under (genex's `VOLATILE_EXTENSIONS_KEY`). */
const VOLATILE_EXTENSIONS_KEY = "extensions";

const isShortText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= EXTENSION_TEXT_MAX_CHARS;

/**
 * The Level-2 rows `state().volatile.extensions` lists, copied with only the fields this check reads;
 * an empty list when it lists none (a game with no `[[wgsl]]` rows), null when it is outside its shape.
 */
function extensionRows(state: unknown): ExtensionRow[] | null {
  const volatile = isRecord(state) ? state.volatile : undefined;
  const listed = isRecord(volatile) ? volatile[VOLATILE_EXTENSIONS_KEY] : undefined;
  if (listed === undefined) return [];
  if (!Array.isArray(listed) || listed.length > EXTENSIONS_MAX) return null;
  const rows: ExtensionRow[] = [];
  for (const row of listed) {
    if (!isRecord(row) || !isShortText(row.path) || !isShortText(row.kind)) return null;
    if (row.code !== null && !isShortText(row.code)) return null;
    rows.push({ path: row.path, kind: row.kind, code: row.code });
  }
  return rows;
}

/** Under the settings in force: no Level-2 source carries a refusal code. */
function checkSourcesHold(state: unknown, label: string): void {
  const rows = extensionRows(state);
  if (rows === null) throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.extensionsShape(label));
  const refused = rows.find((row) => row.code !== null);
  if (refused) throw new CheckFailure(ConformanceProblem.ExtensionRefused, MESSAGE.extensionRefused(label, refused));
}

/**
 * Under the settings in force: no custom pass refused, no Level-2 source refused, every degrade typed
 * and allowed by the receipt.
 */
async function checkExtensionsHold(
  port: ConformancePort,
  receipt: NativeCapabilityReceipt,
  label: string,
): Promise<void> {
  const state = await verb(NativeOp.State, () => port.call(NativeOp.State), always);
  const passes = nativeCustomPasses(state);
  if (passes === null) throw new CheckFailure(ConformanceProblem.VerbInvalid, MESSAGE.passesShape(label));
  const refused = passes.find((pass) => !pass.running || pass.code !== null);
  if (refused) throw new CheckFailure(ConformanceProblem.CustomPassRefused, MESSAGE.passRefused(label, refused));
  checkSourcesHold(state, label);
  for (const entry of degradedEntries(state)) {
    const problem = degradeProblem(label, entry, receipt);
    if (problem) throw new CheckFailure(ConformanceProblem.DegradeNotAllowed, problem);
  }
}

/** As booted, then every `render-extensions` case drawn once; the first to fail ends the walk. */
async function walkExtensions(
  port: ConformancePort,
  receipt: NativeCapabilityReceipt,
  clock: RenderClock,
): Promise<void> {
  await checkExtensionsHold(port, receipt, MESSAGE.asBooted);
  for (const each of EXTENSION_CASES) {
    await verb(NativeOp.RenderSettings, () => port.call(NativeOp.RenderSettings, { set: each.change }), always);
    await untilChangeLands(port, clock, each.label);
    // A capture draws the frame under the new settings, so a pass the switch broke reports it now.
    await verb(NativeOp.Capture, () => port.call(NativeOp.Capture, {}), always);
    await checkExtensionsHold(port, receipt, each.label);
  }
}

/**
 * `render-extensions`: `unavailable` (`render-settings-unsupported`) for a game whose receipt does not
 * advertise the verb; otherwise its custom passes and degrades hold under every case.
 */
export async function checkRenderExtensions(
  port: ConformancePort,
  clock: RenderClock,
): Promise<ConformanceCheckResult> {
  const check = ConformanceCheck.RenderExtensions;
  const receipt = await renderReceipt(port);
  if (receipt === null) return unsupported(check);
  const judgement = await judged(check, () => walkExtensions(port, receipt, clock));
  await restore(port);
  return judgement;
}

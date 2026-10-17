/**
 * The asset cards of the Builds graph (`run-graph.ts`): Blender's own assets, and every plugin
 * job the run asked for, joined across the records one asset leaves in the log.
 */
import { GENEX_LOOKUPS, genexEndedUnmade, genexRefused, isGenexSource } from "../shared/asset-making.ts";
import { digestOperation } from "../shared/game-assets.ts";
import { GenexOperation } from "../shared/genex.ts";
import type { AssetInfo, AssetState } from "./run-graph.ts";
import {
  digestField,
  num,
  type Payload,
  parseJson,
  record,
  records,
  str,
  strings,
  strOrNull,
} from "./run-graph-parse.ts";

/** Where an asset card is, from the log's point of view (`AssetInfo.state`). */
export const AssetCardState = {
  Requested: "requested",
  Generating: "generating",
  Delivered: "delivered",
  Failed: "failed",
  /** still open when the run or chat turn that asked for it ended: nothing will deliver it now */
  Unfinished: "unfinished",
} as const satisfies Record<string, AssetState>;

/** The `source` of an asset Blender made; any other source is a plugin id. */
export const BLENDER_SOURCE = "blender";

/** Genex's in-game checks: they land on the job they check, never a card of their own. */
const CHECK_OPERATIONS: ReadonlySet<string> = new Set([GenexOperation.InspectUse, GenexOperation.VerifyUse]);

/** The plugin's own word, in its JSON result, for a job that failed though the call itself came back ok. */
const PLUGIN_FAILED = "failed";

/** How many folds `cardHolding` follows before giving up on a cycle. */
const MAX_FOLD_HOPS = 32;

/** Where in the run an asset record sits: the part and round it names, and when it was written. */
export interface AssetPlace {
  facetId: string | null;
  iteration: number | null;
  /** the record's `created_at` */
  at: string;
}

/**
 * The plugin asset jobs, in the order they were asked for. A call is indexed by its `callId`
 * while it is open, by its `jobId` once the plugin names one — the delivery record
 * (`asset_delivered`) knows only the job, and lands before the call returns — and by the remote
 * `generationId`, which is all that joins a create to the wait that finishes it. A job that
 * finished having delivered nothing is dropped: a status or wait call is not an asset, and the
 * graph stays about what was made.
 */
export interface AssetLedger {
  jobs: AssetInfo[];
  byCall: Map<string, AssetInfo>;
  byJob: Map<string, AssetInfo>;
  /** A Genex create and the wait that finishes it are two Studio jobs joined only by this id. */
  byGeneration: Map<string, AssetInfo>;
  dropped: Set<AssetInfo>;
  /** An open in-game check, by call, naming the Studio job it checks. */
  checkByCall: Map<string, string>;
  foldedInto: Map<AssetInfo, AssetInfo>;
}

/** An empty ledger, before the run asked for anything. */
export function newAssetLedger(): AssetLedger {
  return {
    jobs: [],
    byCall: new Map(),
    byJob: new Map(),
    byGeneration: new Map(),
    dropped: new Set(),
    checkByCall: new Map(),
    foldedInto: new Map(),
  };
}

/** The jobs that stay on the page: everything asked for, less what delivered nothing or was folded away. */
export function keptAssetJobs(ledger: AssetLedger): AssetInfo[] {
  return ledger.jobs.filter((job) => !ledger.dropped.has(job));
}

/** Whether a card is still on its way: asked for, or being made. */
const stillOpen = (job: AssetInfo): boolean =>
  job.state === AssetCardState.Requested || job.state === AssetCardState.Generating;

/** Where a run's asset jobs have got to, as the assets tile counts them. */
export interface AssetCounts {
  made: number;
  failed: number;
  /** still on their way while the run goes on */
  making: number;
  /** still open when the run ended: nothing will deliver them now */
  unfinished: number;
  /** delivered jobs whose copy is in the game, of those the inventory knows */
  inGame: number;
  known: number;
}

/** The tile's counts of a run's asset jobs. */
export function assetCounts(jobs: readonly AssetInfo[]): AssetCounts {
  const made = jobs.filter((job) => job.state === AssetCardState.Delivered);
  const count = (state: AssetState) => jobs.filter((job) => job.state === state).length;
  return {
    made: made.length,
    failed: count(AssetCardState.Failed),
    making: jobs.filter(stillOpen).length,
    unfinished: count(AssetCardState.Unfinished),
    inGame: made.filter((job) => job.inGame).length,
    known: made.filter((job) => job.inGame !== undefined).length,
  };
}

/** Whether `later` is the same worker's same asset as `failed`: its part, plugin, tool and name. */
const sameAsset = (failed: AssetInfo, later: AssetInfo): boolean =>
  later.facetId === failed.facetId &&
  later.source === failed.source &&
  later.tool === failed.tool &&
  later.name === failed.name;

/**
 * The ledger once its log is read. A failure the same worker retried successfully under the same
 * name folds into that success, whether the success kept a card of its own or was folded as work
 * on another asset. Once the run or chat turn that asked is over (`over`), a job still open is
 * not finished: nothing will deliver it now, so it is never "making" after the end.
 */
export function settleAssetJobs(ledger: AssetLedger, over: boolean): void {
  ledger.jobs.forEach((job, index) => {
    if (job.state !== AssetCardState.Failed || job.facetId === null) return;
    const retried = ledger.jobs
      .slice(index + 1)
      .some((later) => later.state === AssetCardState.Delivered && sameAsset(job, later));
    if (retried) ledger.dropped.add(job);
  });
  if (!over) return;
  for (const job of ledger.jobs) if (stillOpen(job)) job.state = AssetCardState.Unfinished;
}

type CardIdentity = Pick<AssetInfo, "name" | "at" | "source" | "pluginName" | "callId" | "jobId">;

/** A card with nothing learned yet: asked for, no files, no render. */
function blankAsset(place: AssetPlace, identity: CardIdentity): AssetInfo {
  return {
    name: identity.name,
    file: null,
    bytes: 0,
    render: null,
    renderFront: null,
    facetId: place.facetId,
    iteration: place.iteration,
    ok: false,
    error: null,
    polygons: null,
    triangles: null,
    at: identity.at,
    source: identity.source,
    pluginName: identity.pluginName,
    callId: identity.callId,
    jobId: identity.jobId,
    state: AssetCardState.Requested,
    files: [],
    args: "",
    prompt: null,
    operation: null,
    tool: null,
  };
}

/** One `blender_asset` record as a card. */
export function blenderAsset(payload: Payload, place: AssetPlace): AssetInfo {
  const stats = record(payload.stats);
  const file = strOrNull(payload.file);
  const ok = payload.ok === true;
  const identity: CardIdentity = {
    name: str(payload.name, "asset"),
    at: strOrNull(payload.at) ?? place.at,
    source: BLENDER_SOURCE,
    pluginName: "Blender",
    callId: null,
    jobId: strOrNull(payload.name),
  };
  return {
    ...blankAsset(place, identity),
    file,
    bytes: num(payload.bytes) ?? 0,
    render: strOrNull(payload.render),
    renderFront: strOrNull(payload.renderFront),
    ok,
    error: strOrNull(payload.error),
    polygons: stats ? num(stats.polygons) : null,
    triangles: stats ? num(stats.triangles) : null,
    state: ok ? AssetCardState.Delivered : AssetCardState.Failed,
    files: file ? [file] : [],
  };
}

/** Two records of one asset: the card that was asked for keeps what the other one learned. */
function foldAsset(ledger: AssetLedger, from: AssetInfo, into: AssetInfo): void {
  if (from.files.length) into.files = from.files;
  into.file = into.files[0] ?? from.file ?? into.file;
  if (from.bytes) into.bytes = from.bytes;
  into.render ??= from.render;
  into.renderFront ??= from.renderFront;
  into.jobId ??= from.jobId;
  if (from.state === AssetCardState.Delivered) {
    into.state = AssetCardState.Delivered;
    into.ok = true;
  }
  ledger.dropped.add(from);
  ledger.foldedInto.set(from, into);
}

/** The card that now holds a file some asset delivered, following folds to the card that kept it. */
function cardHolding(ledger: AssetLedger, file: string): AssetInfo | undefined {
  const folded = (job: AssetInfo | undefined): job is AssetInfo => job !== undefined && ledger.foldedInto.has(job);
  let card = ledger.jobs.find((job) => job.files.includes(file));
  for (let hops = 0; folded(card) && hops < MAX_FOLD_HOPS; hops++) card = ledger.foldedInto.get(card);
  return card;
}

/**
 * `plugin_tool_started`: a plugin was asked for something. The card appears now, in the state the
 * log can honestly claim — asked for — and the `plugin_tool` that closes the call decides what
 * becomes of it.
 */
export function assetRequested(ledger: AssetLedger, payload: Payload, place: AssetPlace): void {
  const callId = strOrNull(payload.callId);
  if (!callId || ledger.byCall.has(callId)) return;
  const args = str(payload.args, "");
  const tool = strOrNull(payload.tool);
  const prompt = digestField(args, "prompt");
  // The digest writes `operation` first; one a prompt only mentions later is never read as it.
  const operation = digestOperation(args);
  if (operation && GENEX_LOOKUPS.has(operation)) return;
  if (operation && CHECK_OPERATIONS.has(operation)) {
    const checked = digestField(args, "id");
    if (checked) ledger.checkByCall.set(callId, checked);
    return;
  }
  const identity: CardIdentity = {
    name: prompt ?? digestField(args, "name") ?? operation ?? tool ?? "asset",
    at: strOrNull(payload.at) ?? place.at,
    source: str(payload.pluginId, "plugin"),
    pluginName: strOrNull(payload.pluginName),
    callId,
    jobId: null,
  };
  const job: AssetInfo = { ...blankAsset(place, identity), args, prompt, operation, tool };
  ledger.jobs.push(job);
  ledger.byCall.set(callId, job);
}

/**
 * `plugin_tool`: the call came back. Files in hand is a delivery; a job id with no files is work
 * the plugin has taken on and will deliver later; an error is an error; and anything else
 * delivered nothing, so its card goes away rather than cluttering the run with a status check.
 * The restart merge in `run-graph.ts` has already renamed a replaced worker's attribution.
 */
export function assetCallReturned(ledger: AssetLedger, payload: Payload, at: string): void {
  const callId = strOrNull(payload.callId);
  const checked = callId ? ledger.checkByCall.get(callId) : undefined;
  if (checked) {
    recordCheck(ledger, checked, payload, at);
    return;
  }
  const call = callId ? ledger.byCall.get(callId) : undefined;
  if (!callId || !call) return;
  const jobId = strOrNull(payload.jobId);
  const generationId = strOrNull(payload.generationId);
  const files = strings(payload.files);
  const orphan = foldOrphanDelivery(ledger, call, jobId, files);
  const job = resolveGeneration(ledger, call, callId, generationId);
  indexJob(ledger, job, { jobId, generationId, orphan });
  if (files.length) job.files = files;
  settleCall(ledger, job, payload);
  foldDerivedWork(ledger, job, payload);
}

/** An in-game check (`inspect_use`/`verify_use`) came back: it lands on the job it checked. */
function recordCheck(ledger: AssetLedger, checked: string, payload: Payload, at: string): void {
  const target = ledger.byJob.get(checked);
  if (!target) return;
  target.check = { ok: payload.ok !== false, error: strOrNull(payload.error), at: strOrNull(payload.at) ?? at };
}

/**
 * The host writes the delivery before the call returns (`assets.deliver` awaits the ledger), so a
 * card `asset_delivered` opened for this job with no call of its own IS this call: fold it in
 * rather than leaving an orphan beside the card that asked for it. Returns that delivery card.
 */
function foldOrphanDelivery(
  ledger: AssetLedger,
  call: AssetInfo,
  jobId: string | null,
  files: string[],
): AssetInfo | undefined {
  const orphan = jobId ? ledger.byJob.get(jobId) : orphanHoldingFiles(ledger, files);
  const unclaimed = orphan !== undefined && orphan !== call && orphan.callId === null;
  if (unclaimed) foldAsset(ledger, orphan, call);
  return orphan;
}

/** A plugin's card that no call asked for. */
const unaskedPluginCard = (card: AssetInfo): boolean => card.callId === null && card.source !== BLENDER_SOURCE;

/** A plugin delivery nothing asked for that holds one of these files. */
function orphanHoldingFiles(ledger: AssetLedger, files: string[]): AssetInfo | undefined {
  if (!files.length) return undefined;
  return ledger.jobs.find((card) => unaskedPluginCard(card) && card.files.some((file) => files.includes(file)));
}

/**
 * A create names the generation and delivers nothing; the wait that delivers it is a second
 * Studio job for the same asset. The card the run asked for is the one that resolves.
 */
function resolveGeneration(
  ledger: AssetLedger,
  call: AssetInfo,
  callId: string,
  generationId: string | null,
): AssetInfo {
  const opened = generationId ? ledger.byGeneration.get(generationId) : undefined;
  if (!opened || opened === call) return call;
  foldAsset(ledger, call, opened);
  ledger.byCall.set(callId, opened);
  return opened;
}

/** Index the job under the ids this return named, keeping an earlier card's claim unless it was the orphan. */
function indexJob(
  ledger: AssetLedger,
  job: AssetInfo,
  ids: { jobId: string | null; generationId: string | null; orphan: AssetInfo | undefined },
): void {
  const { jobId, generationId, orphan } = ids;
  if (generationId) job.generationId = generationId;
  if (generationId && !ledger.byGeneration.has(generationId)) ledger.byGeneration.set(generationId, job);
  if (!jobId) return;
  job.jobId = jobId;
  const unclaimed = !ledger.byJob.has(jobId) || ledger.byJob.get(jobId) === orphan;
  if (unclaimed) ledger.byJob.set(jobId, job);
}

/**
 * Why a returned call failed, or null when it did not: the call itself failed, or the plugin's own
 * result says the job failed (`status: "failed"` with its `error`) though the call came back ok.
 */
function callFailure(payload: Payload): { error: string | null } | null {
  if (payload.ok === false) return { error: strOrNull(payload.error) };
  const result = parseJson(payload.result);
  if (result?.status !== PLUGIN_FAILED) return null;
  return { error: strOrNull(result.error) ?? strOrNull(payload.error) };
}

/**
 * How a Genex call's reply ended its job, when it did. Genex answers a request it refused before
 * starting a generation, and a generation that failed, with a job that failed rather than an error.
 */
function genexEnding(job: AssetInfo, payload: Payload): { refused: boolean; error: string | null } | null {
  if (!isGenexSource(job.source)) return null;
  const reply = parseJson(payload.result);
  const status = strOrNull(reply?.status);
  if (!genexEndedUnmade(status)) return null;
  const generationId = job.generationId ?? strOrNull(reply?.generationId);
  return { refused: genexRefused({ status, generationId }), error: strOrNull(reply?.error)?.trim() || null };
}

/**
 * What the returned call made of its card: failed, delivered, still generating, or nothing at all.
 * A request Genex refused made nothing either: the agent already read why, and asked again.
 */
function settleCall(ledger: AssetLedger, job: AssetInfo, payload: Payload): void {
  const ending = job.state === AssetCardState.Delivered ? null : genexEnding(job, payload);
  const failure = callFailure(payload);
  if (ending?.refused) {
    ledger.dropped.add(job);
  } else if (failure || ending) {
    job.state = AssetCardState.Failed;
    job.error = failure?.error ?? ending?.error ?? null;
  } else if (job.files.length) {
    job.state = AssetCardState.Delivered;
    job.file = job.files[0] ?? job.file;
  } else if (job.jobId) {
    job.state = job.state === AssetCardState.Delivered ? AssetCardState.Delivered : AssetCardState.Generating;
  } else {
    ledger.dropped.add(job);
  }
  job.ok = job.state === AssetCardState.Delivered;
}

const numberList = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((n) => typeof n === "number") ? (value as number[]) : null;

/**
 * Work on an asset the run already has (Blender importing a Genex model to measure and render it)
 * is a step on that asset. The plugin names its input as `derivedFrom`.
 */
function foldDerivedWork(ledger: AssetLedger, job: AssetInfo, payload: Payload): void {
  const result = parseJson(payload.result);
  const input = strOrNull(record(result?.derivedFrom)?.file) ?? digestField(job.args, "model");
  const source = job.state === AssetCardState.Delivered && input ? cardHolding(ledger, input) : undefined;
  if (!source || source === job) return;
  const stats = record(result?.stats);
  source.derived ??= [];
  source.derived.push({
    pluginName: job.pluginName,
    name: job.name,
    facetId: job.facetId,
    files: job.files,
    size: numberList(stats?.size),
    triangles: stats ? num(stats.triangles) : null,
    at: job.at,
  });
  ledger.dropped.add(job);
}

/**
 * `asset_delivered`: the host's own record of files that landed. It joins the open call on
 * `jobId`; a delivery nothing asked for in this run still earns a card, except Blender's, which
 * already has one.
 */
export function assetDelivered(ledger: AssetLedger, payload: Payload, place: AssetPlace): void {
  const jobId = strOrNull(payload.jobId);
  const source = str(payload.source, "plugin");
  if (!jobId || source === BLENDER_SOURCE) return;
  const rows = records(payload.files);
  const files = rows.map((row) => str(row.file)).filter(Boolean);
  // A delivery that landed no file (a lookup the host still records) made nothing.
  if (!files.length) return;
  const bytes = rows.reduce((total, row) => total + (num(row.bytes) ?? 0), 0);
  const at = strOrNull(payload.at) ?? place.at;
  const job = ledger.byJob.get(jobId) ?? openDeliveryCard(ledger, place, { jobId, source, at, payload });
  ledger.dropped.delete(job);
  job.state = AssetCardState.Delivered;
  job.ok = true;
  job.files = files;
  job.file = job.files[0] ?? job.file;
  job.bytes = bytes || job.bytes;
  job.render = strOrNull(payload.render) ?? job.render;
  job.renderFront = strOrNull(payload.renderFront) ?? job.renderFront;
  if (job.name === jobId) job.name = job.files[0] ?? job.name;
}

/** A card for a delivery no open call claimed. */
function openDeliveryCard(
  ledger: AssetLedger,
  place: AssetPlace,
  delivery: { jobId: string; source: string; at: string; payload: Payload },
): AssetInfo {
  const { jobId, source, at, payload } = delivery;
  const job = blankAsset(place, {
    name: jobId,
    at,
    source,
    pluginName: strOrNull(payload.pluginName),
    callId: null,
    jobId,
  });
  ledger.jobs.push(job);
  ledger.byJob.set(jobId, job);
  return job;
}

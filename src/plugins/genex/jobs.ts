/**
 * Asset job bookkeeping: how Genex's answers and the CLI's generation ledger map onto the
 * `GenexJob` record Studio keeps, and the files a job may fetch alongside its delivery.
 */
import path from "node:path";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { GenexJobStatus, GenexOperation, type GenexJob } from "../../shared/genex.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { API_REQUEST_TIMEOUT_MS, isGenexAssetUrl, readCapped } from "./http.ts";

/** A Studio job id: a UUID, so it can name a folder and never a path. */
export const JOB_ID = /^[a-f0-9-]{36}$/;
/** How many jobs reconcile with Genex at once during a status read. */
export const RECONCILE_BATCH = 4;
const GLB_HEADER_BYTES = 12;
const GLB_VERSION = 2;
const MAX_APPROVAL_IMAGE_BYTES = 10_000_000;
const APPROVAL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const VARIANT_TIMEOUT_MS = MINUTE_MS;
/** The optimized sibling a model generation may carry, and the name Studio saves it under. */
const DESKTOP_VARIANT_ROLE = "model-glb@2048";
const DESKTOP_VARIANT_FILE = "model-desktop.glb";

const MESSAGE = {
  ApprovalHost: "Unrecognized Genex approval image host",
  ApprovalUnavailable: "Approval image unavailable",
  ApprovalEmpty: "Approval image is empty",
  ApprovalTooLarge: "Approval image exceeds 10 MB",
  VariantHost: "Optimized variant has an unrecognized asset host",
  VariantHttp: (status: number) => `Variant download: HTTP ${status}`,
  VariantIncomplete: "Variant is not a complete GLB 2 model",
  VariantUnavailable: (reason: string) => `Original retained; desktop variant unavailable: ${reason}`,
} as const;

/** The generation statuses Genex answers with that Studio records under its own name. */
const GenexRemoteStatus = {
  Completed: "completed",
  Pending: "pending",
  Queued: "queued",
  Running: "running",
  Processing: "processing",
  Failed: "failed",
  Canceled: "canceled",
} as const;

/** Genex's generation statuses that a CLI answer records under Studio's name; others are kept as they came. */
const JOB_STATUS_FOR_REMOTE = new Map<string, GenexJobStatus>([
  [GenexRemoteStatus.Completed, GenexJobStatus.Generated],
  [GenexRemoteStatus.Pending, GenexJobStatus.Accepted],
  [GenexRemoteStatus.Queued, GenexJobStatus.Accepted],
  [GenexRemoteStatus.Running, GenexJobStatus.Generating],
  [GenexRemoteStatus.Processing, GenexJobStatus.Generating],
]);

/** The job status for Genex's remote status; a status with no answer counts as generated. */
export function jobStatusFromRemote(remote: string | null | undefined): string {
  if (remote === undefined || remote === null) return GenexJobStatus.Generated;
  return JOB_STATUS_FOR_REMOTE.get(remote) ?? remote;
}

/**
 * Genex's generation statuses that reconciling a job without files records under Studio's name.
 * Narrower than the CLI answer's table: `queued` and `running` are kept as they came.
 */
const RECONCILED_STATUS_FOR_REMOTE = new Map<string, GenexJobStatus>([
  [GenexRemoteStatus.Completed, GenexJobStatus.Generated],
  [GenexRemoteStatus.Processing, GenexJobStatus.Generating],
  [GenexRemoteStatus.Pending, GenexJobStatus.Accepted],
]);

/** The job status a reconcile records for Genex's remote status. */
export function reconciledJobStatus(remote: string): string {
  return RECONCILED_STATUS_FOR_REMOTE.get(remote) ?? remote;
}

/** Genex's view of one generation: the fields a reconcile copies onto a job. */
export interface GenerationView {
  status?: unknown;
  files?: unknown;
  creditsCharged?: unknown;
  creditsRefunded?: unknown;
}

/**
 * Genex's generation statuses after which its view of that generation no longer changes. Its view
 * carries no charge or refund, so an unknown refund is no reason to ask again.
 */
const SETTLED_REMOTE = new Set<string>([
  GenexRemoteStatus.Completed,
  GenexRemoteStatus.Failed,
  GenexRemoteStatus.Canceled,
]);

/** Whether a view is Genex's last word on its generation. */
export const isSettledView = (view: GenerationView): boolean =>
  typeof view.status === "string" && SETTLED_REMOTE.has(view.status);

/** The generation view in an answer from Genex's generation route, keeping only what a reconcile reads. */
export function generationView(
  response: ({ generation?: GenerationView } & GenerationView) | null | undefined,
): GenerationView {
  const view = response?.generation ?? response;
  return {
    status: view?.status,
    files: view?.files,
    creditsCharged: view?.creditsCharged,
    creditsRefunded: view?.creditsRefunded,
  };
}

/** Copy Genex's view of a generation onto the job: status, files and credits. */
export function applyGenerationView(job: GenexJob, view: GenerationView): void {
  if (typeof view.status === "string") {
    job.remoteStatus = view.status;
    const awaitingFiles = !job.files.length && job.status !== GenexJobStatus.ApprovalRequired;
    if (awaitingFiles) job.status = reconciledJobStatus(view.status);
  }
  if (Array.isArray(view.files)) job.manifest = manifestFromView(view.files);
  if (typeof view.creditsCharged === "number") job.creditsCharged = view.creditsCharged;
  if (typeof view.creditsRefunded === "number") job.creditsRefunded = view.creditsRefunded;
}

/** Genex's answer naming the generation a generic reservation became. */
export interface FoundGeneration {
  id: string;
  status?: string;
  creditsQuoted?: unknown;
}

/** Record on the job which generation its reservation became, as Genex named it. */
export function applyFoundGeneration(job: GenexJob, found: FoundGeneration): void {
  job.generationId = found.id;
  job.remoteStatus = found.status;
  const quoted = found.creditsQuoted;
  if (typeof quoted === "number" && Number.isSafeInteger(quoted)) job.creditsQuoted = quoted;
}

/** Statuses that say the submit may or may not have reached Genex. */
const UNCERTAIN_SUBMIT = new Set<string>([GenexJobStatus.Submitting, GenexJobStatus.Unresolved]);
/** Statuses after which nothing is left to download. */
const NOTHING_TO_DOWNLOAD = new Set<string>([
  GenexJobStatus.Accepted,
  GenexJobStatus.Generating,
  GenexJobStatus.Failed,
  GenexJobStatus.Canceled,
]);
/** Statuses that mean Genex refused or dropped the generation. */
const REMOTE_FAILURE = new Set<string>([GenexJobStatus.Failed, GenexJobStatus.Canceled]);

export const isUncertainSubmit = (job: GenexJob) => UNCERTAIN_SUBMIT.has(job.status);
export const isRemoteFailure = (job: GenexJob) => REMOTE_FAILURE.has(job.status);
/** Whether a finished CLI answer left files to fetch: not still running remotely, and not failed. */
export const hasDownloadableResult = (job: GenexJob) => !NOTHING_TO_DOWNLOAD.has(job.status);

/** The status of a job whose run threw, before reconciling: an unanswered submit stays unresolved. */
export function failedJobStatus(job: GenexJob, aborted: boolean): GenexJobStatus {
  if (job.status === GenexJobStatus.Submitting) return GenexJobStatus.Unresolved;
  return aborted ? GenexJobStatus.Stopped : GenexJobStatus.Failed;
}

/**
 * The status a failed job settles in after reconciling. A read never leaves an unresolved create
 * behind, and an unresolved submit with no request or generation id never reached Genex.
 */
export function settledFailureStatus(job: GenexJob, readOnly: boolean, aborted: () => boolean): string {
  if (readOnly) return aborted() ? GenexJobStatus.Stopped : GenexJobStatus.RetrievalFailed;
  const neverAdmitted = job.status === GenexJobStatus.Unresolved && !job.requestId && !job.generationId;
  if (neverAdmitted) return aborted() ? GenexJobStatus.Stopped : GenexJobStatus.Failed;
  return job.status;
}

/** The kinds of row in the CLI's generation ledger (`LedgerRow.t`); the CLI's own spelling. */
const LedgerRowKind = { Reserve: "reserve", Quote: "q", Release: "release" } as const;

/** One row of the CLI's generation ledger: a reservation, a quote or a release. */
export interface LedgerRow {
  t?: string;
  id?: string;
  out?: string;
  credits?: number;
  generic?: boolean;
}

/**
 * Read the CLI's `.genex/generations.ndjson` for one job's output folder: its reservation and its
 * quoted generation. A released reservation that never became a generation reads as none.
 */
export async function readLedger(cwd: string, job: GenexJob): Promise<LedgerRow | undefined> {
  const output = path.join(cwd, "jobs", job.id, "output");
  const lines = (await readFile(path.join(cwd, ".genex/generations.ndjson"), "utf8").catch(() => "")).split("\n");
  const ledger: Ledger = { reservation: undefined, released: new Set() };
  for (const line of lines) {
    const row = parseRow(line);
    if (row) applyLedgerRow(ledger, row, output, job);
  }
  const { reservation, released } = ledger;
  const releasedUnused = reservation?.id !== undefined && released.has(reservation.id) && !job.generationId;
  if (!releasedUnused) return reservation;
  if (isUncertainSubmit(job)) job.status = GenexJobStatus.Failed;
  return undefined;
}

/** What the ledger says so far: this job's reservation and every released reservation id. */
interface Ledger {
  reservation: LedgerRow | undefined;
  released: Set<string>;
}

/** Fold one ledger row in: releases count for every job; reservations and quotes only for this job's output. */
function applyLedgerRow(ledger: Ledger, row: LedgerRow, output: string, job: GenexJob): void {
  if (row.t === LedgerRowKind.Release && typeof row.id === "string") ledger.released.add(row.id);
  if (row.out !== output) return;
  if (row.t === LedgerRowKind.Reserve) {
    ledger.reservation = row;
    job.requestId = row.id;
  }
  if (row.t === LedgerRowKind.Quote && typeof row.id === "string") {
    job.generationId = row.id;
    if (Number.isSafeInteger(row.credits)) job.creditsQuoted = row.credits;
  }
}

function parseRow(line: string): LedgerRow | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The file list of a generation view, keeping only well-formed entries. */
export function manifestFromView(files: unknown[]): NonNullable<GenexJob["manifest"]> {
  return (files as Array<{ role?: unknown; url?: unknown; bytes?: unknown }>)
    .filter((f) => typeof f.role === "string" && typeof f.url === "string")
    .map((f) => ({
      role: f.role as string,
      url: f.url as string,
      ...(typeof f.bytes === "number" ? { bytes: f.bytes } : {}),
    }));
}

/** Whether `file` is a whole GLB 2 model: its header names glTF, version 2 and its exact size. */
export async function isCompleteGlb(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(GLB_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, GLB_HEADER_BYTES, 0);
    const size = (await handle.stat()).size;
    return (
      bytesRead === GLB_HEADER_BYTES &&
      header.toString("ascii", 0, 4) === "glTF" &&
      header.readUInt32LE(4) === GLB_VERSION &&
      header.readUInt32LE(8) === size
    );
  } finally {
    await handle.close();
  }
}

/** The images a user reviews before approving: three preview candidates, or four finalize views. */
export function approvalLabels(operation: string): string[] {
  return operation === GenexOperation.CharacterPreview ? ["1", "2", "3"] : ["front", "back", "left", "right"];
}

/** The CLI's `wait --no-download` answer for a character awaiting approval. */
export interface ReviewAnswer {
  candidates?: Array<{ candidate?: unknown; url?: unknown }>;
  views?: Record<string, unknown>;
  sourceFaceCount?: unknown;
}

/** The review image URL for one label of a {@link ReviewAnswer}. */
export function approvalImageUrl(operation: string, response: ReviewAnswer, label: string): unknown {
  if (operation !== GenexOperation.CharacterPreview) return response.views?.[label];
  return response.candidates?.find((c) => String(c.candidate) === label)?.url;
}

/** Whether every one of `files` is a regular file under `root`. None at all is not present. */
export async function filesPresent(root: string, files: string[]): Promise<boolean> {
  if (files.length === 0) return false;
  const found = await Promise.all(
    files.map((file) =>
      lstat(path.resolve(root, file)).then(
        (info) => info.isFile(),
        () => false,
      ),
    ),
  );
  return found.every(Boolean);
}

/** Another job of this workspace holding the same generation with its files present. */
export async function siblingWithFiles(
  cwd: string,
  root: string,
  job: GenexJob,
  readJob: (file: string) => Promise<GenexJob | null>,
): Promise<GenexJob | undefined> {
  if (!job.generationId) return undefined;
  for (const name of await readdir(path.join(cwd, "jobs")).catch(() => [] as string[])) {
    if (name === job.id || !JOB_ID.test(name)) continue;
    const other = await readJob(path.join(cwd, "jobs", name, "job.json"));
    if (other?.generationId === job.generationId && (await filesPresent(root, other.files))) return other;
  }
  return undefined;
}

/** Download one review image from Genex's asset hosts as a data URL, refusing anything but a small image. */
export async function fetchApprovalImage(raw: string, signal: AbortSignal): Promise<string> {
  const url = new URL(raw);
  if (!isGenexAssetUrl(url)) throw new Error(MESSAGE.ApprovalHost);
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(API_REQUEST_TIMEOUT_MS)]),
  });
  const mime = res.headers.get("content-type")?.split(";")[0];
  if (!res.ok || !APPROVAL_IMAGE_TYPES.includes(mime ?? "")) throw new Error(MESSAGE.ApprovalUnavailable);
  const reader = res.body?.getReader();
  if (!reader) throw new Error(MESSAGE.ApprovalEmpty);
  const bytes = await readCapped(reader, MAX_APPROVAL_IMAGE_BYTES, MESSAGE.ApprovalTooLarge);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Stream a response body into a new private file; `wx` refuses to overwrite anything. */
async function saveBody(body: ReadableStream<Uint8Array>, file: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.writeFile(value);
    }
  } finally {
    await reader.cancel();
    await handle.close();
  }
}

/**
 * Retrieve the optimized desktop sibling of this existing generation into `output`; never submit a
 * replacement generation. The original always stays: a failure is recorded on the job, not thrown.
 */
export async function fetchDesktopVariant(job: GenexJob, output: string, signal: AbortSignal): Promise<void> {
  const variant = job.manifest?.find((file) => file.role === DESKTOP_VARIANT_ROLE);
  if (!variant) return;
  const url = new URL(variant.url);
  if (!isGenexAssetUrl(url)) {
    job.variantError = MESSAGE.VariantHost;
    return;
  }
  const temporary = path.join(output, `${DESKTOP_VARIANT_FILE}.partial`);
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(VARIANT_TIMEOUT_MS)]),
    });
    if (!response.ok || !response.body) throw new Error(MESSAGE.VariantHttp(response.status));
    await saveBody(response.body, temporary);
    if (!(await isCompleteGlb(temporary))) throw new Error(MESSAGE.VariantIncomplete);
    await rename(temporary, path.join(output, DESKTOP_VARIANT_FILE));
    job.preferredFile = DESKTOP_VARIANT_FILE;
  } catch (error) {
    job.variantError = MESSAGE.VariantUnavailable((error as Error).message);
    await rm(temporary, { force: true });
  }
}

/** Why an inspected job's files are not in this workspace, and which id to use instead. */
export function deliveredElsewhereMessage(job: GenexJob, sibling: GenexJob | undefined): string {
  const head = `Job ${job.id} was delivered to another workspace, so its files are not in this one.`;
  if (sibling) return `${head} Job ${sibling.id} has the same generation here: inspect that id instead.`;
  const wait = job.generationId ? `, or use wait with generationId ${job.generationId} to deliver a copy here` : "";
  return `${head} Inspect it after that work lands${wait}.`;
}

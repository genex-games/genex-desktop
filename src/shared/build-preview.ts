import { type BuildTarget, type GameStack, isBuildTarget, isGameStack } from "./game-project.ts";

export interface BuildPreviewRequest {
  runId: string;
  facetId: string;
  iteration: number;
}

/** The build a capture shows: its stack, destination and the digest of what the lane admitted. */
export interface BuildIdentity {
  stack: GameStack;
  target: BuildTarget;
  /** The SHA-256 of the admitted build (`out/` executable or web module); null for a page served from source. */
  digest: string | null;
  /** The toolchain lock's digest the build was made with; null for a three.js game. */
  lock: string | null;
}

/**
 * Where a saved capture came from, so a frame is never shown as a build it is not: the game's own
 * capture sequence number and pixel digest (a native capture's FNV-1a, recomputed by the host),
 * the camera, the run and the build. Every field is null when the capture path did not know it,
 * as a web capture and an older capture folder do. The capture manifest reuses these fields.
 */
export interface CaptureProvenance {
  seq: number | null;
  digest: string | null;
  camera: string | null;
  runId: string | null;
  build: BuildIdentity | null;
}

export interface BuildPreviewFrame {
  path: string;
  capturedAt: string;
  camera: string;
  /** Where the frame came from; absent for a capture saved before provenance was kept. */
  provenance?: CaptureProvenance;
  /** The capture's manifest; absent for a capture saved before manifests were written. */
  manifest?: CaptureManifest;
}

/** The capture manifest's shape this build writes; a reader leaves out any other. */
export const CAPTURE_MANIFEST_VERSION = 1;

/**
 * The manifest saved beside every builder capture (`c3_default.jpg` → `c3_default.manifest.json`):
 * whose capture it is (the Studio run and the worker), what was rendered (the workspace's commit
 * and whether it had edits beyond it) and where the frame came from (`provenance`: the game's
 * sequence number, the pixel digest, the camera, the native run and the build with its digest),
 * so a card never shows a frame as a build or a worker it is not. Unknown fields are null.
 */
export interface CaptureManifest {
  version: typeof CAPTURE_MANIFEST_VERSION;
  /** The Studio run the capture belongs to; null for a capture outside a run. */
  runId: string | null;
  /** The worker that took it: its facet, or `director`. */
  workerId: string | null;
  /** The capture call's number in its iteration folder (`c<call>_<camera>.jpg`). */
  call: number;
  /** The camera the capture asked for. */
  camera: string;
  /** The commit the rendered workspace stood at; null when it is not a repository. */
  commit: string | null;
  /** Whether the workspace had edits beyond `commit` (a capture renders edits included); null when unknown. */
  edited: boolean | null;
  /** When the frame was saved (ISO 8601). */
  capturedAt: string;
  provenance: CaptureProvenance;
  /**
   * The capture took no frame, and why: its build failed (a record saved alone, `c<call>.refused.json`,
   * so the folder's newest capture is the failure and no older frame stands in for it). Absent
   * from a frame's own manifest.
   */
  refused?: CaptureRefusal;
}

/** Why a preview refuses to take a picture. */
export const CaptureRefusal = {
  /** A judged load's build failed: the preview was left on no page, so no older build is photographed. */
  BuildFailed: "build-failed",
} as const;
export type CaptureRefusal = (typeof CaptureRefusal)[keyof typeof CaptureRefusal];

const CAPTURE_REFUSALS: ReadonlySet<unknown> = new Set(Object.values(CaptureRefusal));
/** Whether `value` is one of the capture refusal codes. */
const isCaptureRefusal = (value: unknown): value is CaptureRefusal => CAPTURE_REFUSALS.has(value);

/** A capture the preview refused; `refusal` crosses the harness pipe as a typed code. */
export class CaptureError extends Error {
  readonly refusal: CaptureRefusal;

  constructor(refusal: CaptureRefusal, message: string) {
    super(message);
    this.name = "CaptureError";
    this.refusal = refusal;
  }
}

/** The longest name or digest a saved provenance may carry (any real one is far shorter). */
const PROVENANCE_TEXT_MAX_CHARS = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length <= PROVENANCE_TEXT_MAX_CHARS);

/** Whether `value` is a `BuildIdentity`: a known stack and target, each digest a short text or null. */
function isBuildIdentity(value: unknown): value is BuildIdentity {
  if (!isRecord(value)) return false;
  return (
    isGameStack(value.stack) && isBuildTarget(value.target) && isTextOrNull(value.digest) && isTextOrNull(value.lock)
  );
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Whether `value` is a `CaptureProvenance` as a capture's sidecar saves it. */
export function isCaptureProvenance(value: unknown): value is CaptureProvenance {
  if (!isRecord(value)) return false;
  const seq = value.seq === null || isCount(value.seq);
  const build = value.build === null || isBuildIdentity(value.build);
  return seq && build && isTextOrNull(value.digest) && isTextOrNull(value.camera) && isTextOrNull(value.runId);
}

/** A build identity with only its own fields. */
const pickBuild = ({ stack, target, digest, lock }: BuildIdentity): BuildIdentity => ({ stack, target, digest, lock });

/** A checked copy of a saved provenance, with only its own fields; null for anything else. */
export function captureProvenanceOf(value: unknown): CaptureProvenance | null {
  if (!isCaptureProvenance(value)) return null;
  const { seq, digest, camera, runId, build } = value;
  return { seq, digest, camera, runId, build: build && pickBuild(build) };
}

/** A saved manifest whose own fields checked out; its provenance is checked on its own. */
type ManifestFields = Omit<CaptureManifest, "provenance"> & { provenance: unknown };

/** Whether the manifest's own fields (all but its provenance) have the shape this build writes. */
function hasManifestFields(value: Record<string, unknown>): value is ManifestFields {
  const known = value.version === CAPTURE_MANIFEST_VERSION && isCount(value.call);
  const camera = typeof value.camera === "string" && value.camera.length <= PROVENANCE_TEXT_MAX_CHARS;
  const edited = value.edited === null || typeof value.edited === "boolean";
  const texts = [value.runId, value.workerId, value.commit].every(isTextOrNull);
  const dated = typeof value.capturedAt === "string" && Number.isFinite(Date.parse(value.capturedAt));
  const refused = value.refused === undefined || isCaptureRefusal(value.refused);
  return known && camera && edited && texts && dated && refused;
}

/** A checked copy of a saved capture manifest, with only its own fields; null for anything else. */
export function captureManifestOf(value: unknown): CaptureManifest | null {
  if (!isRecord(value) || !hasManifestFields(value)) return null;
  const provenance = captureProvenanceOf(value.provenance);
  if (!provenance) return null;
  const { version, runId, workerId, call, camera, commit, edited, capturedAt, refused } = value;
  const manifest = { version, runId, workerId, call, camera, commit, edited, capturedAt, provenance };
  return refused === undefined ? manifest : { ...manifest, refused };
}

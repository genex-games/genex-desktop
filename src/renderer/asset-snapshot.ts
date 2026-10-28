/**
 * A model or texture drawn once off screen by the asset viewer, snapshotted, and its viewer thrown
 * away: the Assets tab's thumbnails and Play's asset tiles both make their pictures this way.
 */
import { PreviewFailure } from "../shared/asset-preview.ts";
import { errorMessage } from "../shared/errors.ts";
import { t } from "../shared/i18n.ts";

const MESSAGE = {
  cancelled: t("Preview cancelled"),
  unavailable: t("Preview unavailable"),
} as const;

/** A snapshot the viewer gave up on, and why: the file itself, or something around it that may pass. */
export class SnapshotError extends Error {
  readonly failure: PreviewFailure;
  constructor(failure: PreviewFailure, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.failure = failure;
  }
}

/** Whether `error` says the file itself cannot be drawn, so drawing it again would fail again. */
export const fileUndrawable = (error: unknown): boolean =>
  error instanceof SnapshotError && error.failure === PreviewFailure.File;

/** One file read for the viewer: its bytes and their type. */
export type SnapshotRead = (file: string) => Promise<{ mimeType: string; data: Uint8Array<ArrayBuffer> }>;

/** What to draw and how large. */
export interface SnapshotRequest {
  /** The name the viewer reads the file under; its extension picks the loader. */
  file: string;
  /** Files beside it the viewer may read (textures, buffers). */
  companions: string[];
  /** Reads the file and any companion it names. */
  read: SnapshotRead;
  /** The picture's size in CSS pixels. */
  width: number;
  height: number;
}

/**
 * The PNG data URL of `request.file` drawn off screen; rejects when it cannot be drawn (a
 * {@link SnapshotError} saying why, when the viewer says) or `signal` aborts.
 */
export async function viewerSnapshot(request: SnapshotRequest, signal?: AbortSignal): Promise<string> {
  const { createAssetViewer } = await import("./asset-model-viewer.js");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;left:-10000px;top:0;width:${request.width}px;height:${request.height}px;pointer-events:none`;
    document.body.append(host);
    let viewer: ReturnType<typeof createAssetViewer> | undefined;
    let settled = false;
    const finish = (outcome: { value: string } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      viewer?.dispose();
      host.remove();
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const abort = () => finish({ error: new Error(MESSAGE.cancelled) });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      viewer = createAssetViewer(host, {
        file: request.file,
        companions: request.companions,
        read: request.read,
        onTime: () => {},
        // The viewer says why it gave up: the file itself, or something around it that may pass.
        onError: (error: unknown, failure?: PreviewFailure) =>
          finish({ error: failure ? new SnapshotError(failure, error) : error }),
        onReady: () => {
          try {
            if (!viewer) throw new Error(MESSAGE.unavailable);
            finish({ value: viewer.snapshot() });
          } catch (error) {
            finish({ error });
          }
        },
      });
    } catch (error) {
      finish({ error });
    }
  });
}

/**
 * The copy Genex keeps of a delivered picture, for the Builds graph. A Loop's workers deliver into
 * their own copies of the game and the lead into the run's integration worktree: the game folder has
 * those files only once the build lands, and a worker's copy is removed after its merge. So when a
 * delivery lands in a build workspace the host keeps a copy of its first picture in the run's folder,
 * the one place `readRunStill` reads, and names it on the delivery's record (`asset_delivered.picture`).
 *
 * The workspace is one an agent writes: the picture is read contained (no link, no escape, its bytes
 * a picture), and a delivery that names nothing readable keeps nothing.
 */
import { assetFormat } from "../shared/game-assets.ts";
import { sniffImage } from "../substrate/image-sniff.ts";
import { readContainedImage } from "./game-assets.ts";

/** The folder of the run's own folder the kept copies go in. */
const KEPT_FOLDER = "deliveries";
/** The longest a kept copy's name may be, from its job's id. */
const KEPT_NAME_MAX = 80;
/** The longest side of a kept copy the host makes smaller: what the Builds graph's nodes and card draw. */
const KEPT_PICTURE_PX = 640;

/** One delivery that landed in a build workspace. */
export interface DeliveredFiles {
  /** the workspace the files landed in: a worker's copy, or the run's integration worktree */
  root: string;
  /** the delivery's files, relative to `root`, as its record lists them */
  files: readonly string[];
  runId: string;
  jobId: string;
}

/** How a copy is written, and made smaller when the host can. */
export interface KeepPictureIo {
  /** Writes one file in the run's folder (`StudioCore.saveRunArtifact`) and answers its path. */
  save: (runId: string, name: string, data: Buffer) => Promise<string>;
  /** A JPEG of a picture at most `maxPx` on its longest side, or null when nothing here can make one. */
  resize?: (data: Buffer, maxPx: number) => Promise<Buffer | null>;
}

/** A job's id as a file name: what it may hold of it, never a way out of the folder. */
const keptName = (jobId: string): string => jobId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, KEPT_NAME_MAX) || "delivery";

/** The picture's bytes as a file, smaller when the host could make it so; null when they are no picture. */
async function pictureOf(
  root: string,
  file: string,
  resize: KeepPictureIo["resize"],
): Promise<{ data: Buffer; ext: string } | null> {
  const smaller = resize
    ? async (data: Buffer) => {
        const made = await resize(data, KEPT_PICTURE_PX);
        if (!made) throw new Error("not resized");
        return made;
      }
    : undefined;
  const read = await readContainedImage(root, file, { prefixes: [], ...(smaller ? { resize: smaller } : {}) });
  if (!read) return null;
  const data = Buffer.from(read.data, "base64");
  const sniffed = sniffImage(data);
  return sniffed ? { data, ext: sniffed.ext } : null;
}

/**
 * Keep a copy of the delivery's first picture in its run's folder and answer where, or null when
 * it has no picture the workspace holds readably. Never throws.
 */
export async function keepDeliveredPicture(delivery: DeliveredFiles, io: KeepPictureIo): Promise<string | null> {
  const first = delivery.files.find((file) => assetFormat(file)?.raster === true);
  if (!first) return null;
  try {
    const picture = await pictureOf(delivery.root, first, io.resize);
    if (!picture) return null;
    return await io.save(delivery.runId, `${KEPT_FOLDER}/${keptName(delivery.jobId)}${picture.ext}`, picture.data);
  } catch {
    return null;
  }
}

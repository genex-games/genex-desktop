/**
 * The pinned Basis Universal encoder for development and tests (renderer pass 2, A6.6): its two
 * WebAssembly build files downloaded from the release commit `BASIS_ENCODER` names
 * (`src/substrate/asset-import/basis-encoder.ts`), each held to its size and sha256 before it is
 * kept, into `.studio-dev/tools/basis-encoder-<version>/` (ignored by Git). The encoder is never
 * committed; a Studio install will get it from the toolchain store instead.
 *
 *   node scripts/toolchains/basis-encoder.ts fetch
 *
 * A file already there with the pinned sha256 is kept. A download is written beside its name and
 * renamed into place only when it matches; anything else is deleted and refused. A refusal is one
 * line on stderr, `genex-basis-encoder-refusal: {"code":…,"detail":…}`, and exit 78.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASIS_ENCODER } from "../../src/substrate/asset-import/basis-encoder.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** Where the fetch keeps the encoder (what the tests read). */
export const ENCODER_DIR = path.join(REPO, ".studio-dev", "tools", `basis-encoder-${BASIS_ENCODER.version}`);
const REFUSAL_PREFIX = "genex-basis-encoder-refusal: ";
const REFUSAL_EXIT = 78;

/** Why the fetch refused. Wire values. */
export const EncoderFetchRefusal = {
  Usage: "usage",
  DownloadFailed: "download-failed",
  SizeMismatch: "size-mismatch",
  HashMismatch: "hash-mismatch",
} as const;
export type EncoderFetchRefusal = (typeof EncoderFetchRefusal)[keyof typeof EncoderFetchRefusal];

class Refused extends Error {
  readonly code: EncoderFetchRefusal;
  constructor(code: EncoderFetchRefusal, detail: string) {
    super(detail);
    this.code = code;
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One pinned file in place: kept when it already matches, else downloaded and checked. */
async function fetchFile(file: (typeof BASIS_ENCODER.files)[number]): Promise<void> {
  const target = path.join(ENCODER_DIR, file.name);
  const held = await readFile(target).catch(() => null);
  if (held && sha256(held) === file.sha256) return;
  const response = await fetch(`${BASIS_ENCODER.source}${file.name}`).catch(() => null);
  if (!response?.ok)
    throw new Refused(EncoderFetchRefusal.DownloadFailed, `${file.name}: ${response?.status ?? "no answer"}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.bytes)
    throw new Refused(EncoderFetchRefusal.SizeMismatch, `${file.name}: ${bytes.byteLength} bytes`);
  if (sha256(bytes) !== file.sha256)
    throw new Refused(EncoderFetchRefusal.HashMismatch, `${file.name}: ${sha256(bytes)}`);
  const partial = `${target}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target);
}

/** Fetch both files. */
export async function fetchEncoder(): Promise<void> {
  await mkdir(ENCODER_DIR, { recursive: true });
  for (const file of BASIS_ENCODER.files) {
    try {
      await fetchFile(file);
    } catch (error) {
      await rm(`${path.join(ENCODER_DIR, file.name)}.partial`, { force: true });
      throw error;
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "fetch") throw new Refused(EncoderFetchRefusal.Usage, "usage: basis-encoder.ts fetch");
    await fetchEncoder();
    process.stdout.write(`${ENCODER_DIR}\n`);
  } catch (error) {
    const code = error instanceof Refused ? error.code : EncoderFetchRefusal.DownloadFailed;
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code, detail: (error as Error).message })}\n`);
    process.exit(REFUSAL_EXIT);
  }
}

/**
 * The safe-path rule for a game's assets, host-side: the rule the C++ runtime applies to every
 * file it opens (`paths.h` `isSafeAssetPath`, ported to `genex-core` `is_safe_asset_path`), then
 * the file read without following a link at its name and only when its real path stays inside the
 * game folder. The importer never sees the game folder: the host copies what this module read.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { NotARegularFileError, readRegularFile } from "../fsx.ts";
import { isWindowsSafeName } from "../windows-names.ts";
import { AssetImportRefusal } from "./import-plan.ts";

/** Letters, digits, space, `_`, `-` and `.`: what an asset path segment may hold. */
const SEGMENT = /^[A-Za-z0-9 _.-]+$/;

/**
 * Whether `rel` may name a file under the game folder: `/`-separated segments of letters, digits,
 * space, `_`, `-` and `.`, none empty, `.` or `..`. Absolute paths, backslashes and drive letters
 * are refused, and so is what Windows would read differently: a trailing dot or space and a
 * device name (`con.png`). The same rule as `paths.h` and `genex-core`.
 */
export function isSafeAssetPath(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel === "") return false;
  return rel.split("/").every((segment) => SEGMENT.test(segment) && isWindowsSafeName(segment));
}

/** A file read for the importer, or why not. */
export type GameAssetRead = { ok: true; bytes: Buffer } | { ok: false; refusal: AssetImportRefusal };

/** An errno a read refusal maps from. */
const ERRNO_REFUSAL: Readonly<Record<string, AssetImportRefusal>> = Object.freeze({
  ENOENT: AssetImportRefusal.Missing,
  ENOTDIR: AssetImportRefusal.Missing,
  ELOOP: AssetImportRefusal.EscapesGame,
  EISDIR: AssetImportRefusal.NotRegularFile,
  ENOTREG: AssetImportRefusal.NotRegularFile,
  EFBIG: AssetImportRefusal.TooLarge,
});

/** Why a read failed, as the import step words it. */
function readRefusal(error: unknown): AssetImportRefusal {
  if (error instanceof NotARegularFileError) return ERRNO_REFUSAL[error.code] ?? AssetImportRefusal.NotRegularFile;
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  return Object.hasOwn(ERRNO_REFUSAL, code)
    ? (ERRNO_REFUSAL[code] ?? AssetImportRefusal.Missing)
    : AssetImportRefusal.Missing;
}

/**
 * The bytes of `rel` inside `gameRoot`: the name must pass {@link isSafeAssetPath}, its real path
 * must stay strictly inside the game folder's, the name itself must not be a link, and the file
 * must be a regular one of at most `maxBytes`. Never throws; nothing is written.
 */
export async function readGameAsset(gameRoot: string, rel: string, maxBytes: number): Promise<GameAssetRead> {
  if (!isSafeAssetPath(rel)) return { ok: false, refusal: AssetImportRefusal.UnsafePath };
  try {
    const base = await realpath(gameRoot);
    const named = path.join(base, ...rel.split("/"));
    const link = await lstat(named);
    if (link.isSymbolicLink()) return { ok: false, refusal: AssetImportRefusal.EscapesGame };
    const real = await realpath(named);
    if (!real.startsWith(base + path.sep)) return { ok: false, refusal: AssetImportRefusal.EscapesGame };
    return { ok: true, bytes: await readRegularFile(real, maxBytes) };
  } catch (error) {
    return { ok: false, refusal: readRefusal(error) };
  }
}

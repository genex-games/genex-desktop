import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { openNoFollow } from "../substrate/fsx.ts";
import { constants } from "node:fs";
import { assertRelativePath } from "../substrate/paths.ts";
import { ASSET_PREVIEW_MIME, assetExtension } from "../shared/asset-preview.ts";
import { StudioPlatform } from "../shared/boot.ts";
import { t } from "../shared/i18n.ts";
import { type AssetFolder, isAssetPath } from "../shared/project-workspace.ts";

/** The largest file previewed in memory (the message below names it: 100 MiB). */
const PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

/** The asset panel's reveal button on this platform, as `renderer/words.ts` `fileManagerWords` names it. */
function revealButton(): string {
  if (process.platform === StudioPlatform.Windows) return t("Show in Explorer");
  if (process.platform === StudioPlatform.Linux) return t("Show in folder");
  return t("Reveal in Finder");
}

/** Why a preview was refused, as the asset panel shows it. */
const MESSAGE = {
  notAnAsset: () => t("Only asset files can be previewed."),
  noPreview: () =>
    t("This format has no in-app preview. Use {button} to open it in its authoring app.", { button: revealButton() }),
  linked: () => t("Linked files cannot be previewed."),
  notRegular: () => t("Asset is not a regular file."),
  changedWhileOpening: () => t("Asset changed while opening. Try again."),
  tooLarge: () =>
    t(
      "This file exceeds the 100 MiB in-app preview memory limit. The original is unchanged; open it in its authoring app.",
    ),
  changedWhileReading: () => t("Asset changed while reading. Try again."),
} as const;

/** Refuse a file outside a game's asset folders (or not of a format its folder lists), as a preview does. */
export function assertAssetPath(file: string, folders: readonly AssetFolder[]): void {
  if (!isAssetPath(file, folders)) throw new Error(MESSAGE.notAnAsset());
}

/** Bounded in-memory preview, not an asset-generation or export size restriction. */
export async function readAssetPreview(
  base: string,
  file: string,
  prefixes: readonly string[] = ["assets/", "public/assets/"],
  maxBytes = PREVIEW_MAX_BYTES,
): Promise<{ mimeType: string; data: Uint8Array<ArrayBuffer> }> {
  assertPreviewLimit(maxBytes);
  assertRelativePath(file);
  const hidden = file.split("/").some((part) => part.startsWith("."));
  const outsidePrefixes = prefixes.length > 0 && !prefixes.some((prefix) => file.startsWith(prefix));
  const notAnAsset = hidden || file.startsWith("assets/src/") || outsidePrefixes;
  if (notAnAsset) throw new Error(MESSAGE.notAnAsset());
  const mimeType = ASSET_PREVIEW_MIME[assetExtension(file)];
  if (!mimeType) throw new Error(MESSAGE.noPreview());
  const root = await realpath(base);
  const target = path.join(root, ...file.split("/"));
  if ((await realpath(target)) !== target) throw new Error(MESSAGE.linked());
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(MESSAGE.notRegular());
  const handle = await openNoFollow(target, constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error(MESSAGE.changedWhileOpening());
    if (stat.size > maxBytes) throw new Error(MESSAGE.tooLarge());
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error(MESSAGE.changedWhileReading());
    return { mimeType, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    await handle.close();
  }
}

/** Reject invalid caller limits before opening a file. */
function assertPreviewLimit(maxBytes: number): void {
  const invalid = !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PREVIEW_MAX_BYTES;
  if (invalid) throw new Error(MESSAGE.tooLarge());
}

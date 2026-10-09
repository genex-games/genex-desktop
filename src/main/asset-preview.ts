import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { openNoFollow } from "../substrate/fsx.ts";
import { constants } from "node:fs";
import { assertRelativePath } from "../substrate/paths.ts";
import { ASSET_PREVIEW_MIME, assetExtension } from "../shared/asset-preview.ts";
import { StudioPlatform } from "../shared/boot.ts";
import { ASSET_PREFIXES } from "../shared/game-assets.ts";

/** The largest file previewed in memory (the message below names it: 100 MiB). */
const PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

/** The asset panel's reveal button on this platform, as `renderer/words.ts` `fileManagerWords` names it. */
const REVEAL_BUTTON: Readonly<Record<string, string>> = {
  [StudioPlatform.Windows]: "Show in Explorer",
  [StudioPlatform.Linux]: "Show in folder",
};
const revealButton = REVEAL_BUTTON[process.platform] ?? "Reveal in Finder";

/** Why a preview was refused, as the asset panel shows it. */
const MESSAGE = {
  notAnAsset: "Only asset files can be previewed.",
  noPreview: `This format has no in-app preview. Use ${revealButton} to open it in its authoring app.`,
  linked: "Linked files cannot be previewed.",
  notRegular: "Asset is not a regular file.",
  changedWhileOpening: "Asset changed while opening. Try again.",
  tooLarge:
    "This file exceeds the 100 MiB in-app preview memory limit. The original is unchanged; open it in its authoring app.",
  changedWhileReading: "Asset changed while reading. Try again.",
} as const;

/** Bounded in-memory preview, not an asset-generation or export size restriction. */
export async function readAssetPreview(
  base: string,
  file: string,
  prefixes: readonly string[] = ASSET_PREFIXES,
  maxBytes = PREVIEW_MAX_BYTES,
): Promise<{ mimeType: string; data: Uint8Array<ArrayBuffer> }> {
  assertPreviewLimit(maxBytes);
  assertRelativePath(file);
  const hidden = file.split("/").some((part) => part.startsWith("."));
  const outsidePrefixes = prefixes.length > 0 && !prefixes.some((prefix) => file.startsWith(prefix));
  const notAnAsset = hidden || file.startsWith("assets/src/") || outsidePrefixes;
  if (notAnAsset) throw new Error(MESSAGE.notAnAsset);
  const mimeType = ASSET_PREVIEW_MIME[assetExtension(file)];
  if (!mimeType) throw new Error(MESSAGE.noPreview);
  const root = await realpath(base);
  const target = path.join(root, ...file.split("/"));
  if ((await realpath(target)) !== target) throw new Error(MESSAGE.linked);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(MESSAGE.notRegular);
  const handle = await openNoFollow(target, constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error(MESSAGE.changedWhileOpening);
    if (stat.size > maxBytes) throw new Error(MESSAGE.tooLarge);
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error(MESSAGE.changedWhileReading);
    return { mimeType, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    await handle.close();
  }
}

/** Reject invalid caller limits before opening a file. */
function assertPreviewLimit(maxBytes: number): void {
  const invalid = !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PREVIEW_MAX_BYTES;
  if (invalid) throw new Error(MESSAGE.tooLarge);
}

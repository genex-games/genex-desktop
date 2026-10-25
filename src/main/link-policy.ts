/**
 * Where a link clicked inside the studio window may go.
 *
 * The window is the studio's only UI, and the links in it are mostly a contractor's markdown —
 * a report that ends in "[Base handoff](/Users/…/NOTES.base-builder.md)". Followed in place, such
 * a click navigates the window itself to a file that may not exist and leaves the whole app black.
 * So the window never navigates: a link opens outside it (the browser, the
 * file's own app, Finder) or is refused in words, and the studio stays on screen.
 *
 * File links are allowed only inside the user's game folders — a report may point at its own
 * notes, never at the studio's credentials or anything else on the disk. Containment is checked
 * on real paths, because a contractor can plant a link. And a click only ever *opens* a document
 * or media file: the text of a link hides its extension, so a contractor that wrote
 * `NOTES.command` or `Evil.app` and linked it as "handoff notes" would otherwise run it with the
 * user's full privileges, outside every sandbox (SECUI-1). Everything else is shown in Finder.
 * A page of Genex's website goes to the browser tagged `s=desktop` (`tagGenexLink`).
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tagGenexLink } from "../plugins/genex/http.ts";
import { isInside } from "../substrate/paths.ts";
import { t } from "../shared/i18n.ts";

/** Why a link is refused: the detail of the "That link could not be opened" dialog. */
const MESSAGE = {
  notALink: () => t("that is not a link the studio can open"),
  httpOnly: () => t("only https links open from the studio"),
  scheme: (scheme: string) => t("{scheme} links do not open from the studio", { scheme }),
  remoteFile: (host: string) => t("files on {host} do not open from the studio", { host }),
  malformedFile: () => t("that file link is malformed"),
  outside: (target: string) => t("{path} is outside your game folders", { path: target }),
  missing: (target: string) => t("{path} does not exist", { path: target }),
} as const;

export type LinkRoute =
  | { action: "external"; url: string }
  | { action: "open-path"; target: string }
  | { action: "reveal"; target: string }
  | { action: "refuse"; reason: string };

/** What a report legitimately links to. An allowlist: a denylist of launchers misses one. */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".txt",
  ".json",
  ".html",
  ".htm",
  ".csv",
  ".log",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".webm",
  ".glb",
  ".gltf",
]);

export async function routeStudioLink(raw: string, options: { projectDirs: string[] }): Promise<LinkRoute> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { action: "refuse", reason: MESSAGE.notALink() };
  }
  if (url.protocol === "https:") return { action: "external", url: tagGenexLink(url.href) };
  if (url.protocol === "http:") return { action: "refuse", reason: MESSAGE.httpOnly() };
  if (url.protocol !== "file:") return { action: "refuse", reason: MESSAGE.scheme(url.protocol.replace(/:$/, "")) };
  if (url.hostname && url.hostname !== "localhost")
    return { action: "refuse", reason: MESSAGE.remoteFile(url.hostname) };

  let target: string;
  try {
    // The platform's own reading of a file URL: `/C:/Users/…` is a drive path on Windows.
    target = path.resolve(fileURLToPath(url));
  } catch {
    return { action: "refuse", reason: MESSAGE.malformedFile() };
  }
  const outside = { action: "refuse", reason: MESSAGE.outside(target) } as const;
  // Lexically first, so a link to anywhere else on the disk is refused without touching it.
  if (!options.projectDirs.some((dir) => isInside(dir, target))) return outside;

  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return { action: "refuse", reason: MESSAGE.missing(target) };
  }
  // Then on real paths: a link inside a game folder that leads out of it is outside. A game
  // folder that is gone contains nothing.
  const roots = await Promise.all(options.projectDirs.map((dir) => realpath(path.resolve(dir)).catch(() => null)));
  if (!roots.some((root) => root !== null && isInside(root, real))) return outside;

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(real);
  } catch {
    return { action: "refuse", reason: MESSAGE.missing(target) };
  }
  // A regular, non-executable document opens in its own app. Folders, bundles (`.app` is a
  // folder), launchers and anything with an exec bit are shown in Finder, never opened.
  const openable =
    info.isFile() && (Number(info.mode) & 0o111) === 0 && OPENABLE_EXTENSIONS.has(path.extname(real).toLowerCase());
  return openable ? { action: "open-path", target: real } : { action: "reveal", target: real };
}

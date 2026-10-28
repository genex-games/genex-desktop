/**
 * A folder's label as a person reads it, on either platform. Main writes labels in the host's own
 * spelling (`substrate/game-workspace.ts` `tildePath`): `~/AI Games` on the Mac, `~\AI Games` or
 * `D:\Games\rift` on Windows, so the renderer splits them on either separator.
 */

/** Either separator: a Windows label splits as a Mac one does. */
const SEPARATOR = /[\\/]/;
const TRAILING_SEPARATORS = /[\\/]+$/;

/** A path's last part: `~/AI Games` and `C:\Users\ana\AI Games\` are both `AI Games`. */
export function pathLeaf(label: string): string {
  return label.split(SEPARATOR).filter(Boolean).at(-1) ?? label;
}

/** A path as its parent, separator kept (`~/`, `D:\Games\`), and its own last part (`AI Games`). */
export function pathParts(label: string): { parent: string; leaf: string } {
  const trimmed = label.replace(TRAILING_SEPARATORS, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? { parent: "", leaf: label } : { parent: trimmed.slice(0, cut + 1), leaf: trimmed.slice(cut + 1) };
}

/** A path's last two parts, `/`-joined: `AI Games/rift` from `/Users/ana/AI Games/rift` or `C:\…\AI Games\rift`. */
export function lastTwoParts(path: string): string {
  return path.split(SEPARATOR).filter(Boolean).slice(-2).join("/");
}

/**
 * A path in a person's home as `~/…`: the Mac's `/Users/ana`, Linux's `/home/ana`, and Windows'
 * `C:\Users\ana`, `C:/Users/ana` or `/c/Users/ana` (the form Claude Code writes in its rules).
 */
export function homePath(path: string): string {
  return path.replace(/^(?:\/(?:Users|home)|\/[A-Za-z]\/Users|[A-Za-z]:[\\/]Users)[\\/][^\\/]+(?=[\\/]|$)/i, "~");
}

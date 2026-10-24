/**
 * The operating system main runs on, as the renderer knows it: `studio-entry.tsx` puts main's answer to
 * `bootState` on the root as `data-platform` before the studio mounts, and platform-specific copy
 * (the file manager's name) reads it from there.
 */

/** The platform on the root, in `process.platform` spelling; empty before main has answered. */
export function hostPlatform(root: { dataset: DOMStringMap } = document.documentElement): string {
  return root.dataset.platform ?? "";
}

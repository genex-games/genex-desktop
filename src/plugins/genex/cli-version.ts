/** Which Genex CLI release a version is: what Studio's pinned CLI can do is read from it. */

/**
 * Whether CLI `version` is release `first` or later. A prerelease comes before its release
 * (`1.36.11-dev.4` may predate what 1.36.11 brings), so only a later release's prerelease counts.
 */
export function isAtLeast(version: string, first: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (const [at, wanted] of first.entries()) {
    const part = parts[at] ?? 0;
    if (part !== wanted) return part > wanted;
  }
  return match[4] === undefined;
}

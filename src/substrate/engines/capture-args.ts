/**
 * What a builder's `capture` call hands the studio, whichever engine it came through (Claude's
 * MCP tool, the Codex bridge, a local session). A model that sends an empty optional means "the
 * game": an empty, blank or non-string `page` (Codex's JSON null included) is left out, never
 * forwarded as a bench page the studio would refuse.
 */

/** The `onCapture` arguments from a capture call's raw arguments: the page it named, if any. */
export function captureArgs(args: Record<string, unknown> | null | undefined): { page?: string } {
  const page = args?.page;
  return typeof page === "string" && page.trim() ? { page } : {};
}

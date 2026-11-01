/**
 * The pages the studio writes into a game folder: the CLAUDE.md a game of its own gets in place of
 * the template's, and the `references/` readme. Facts only; the workspace (`game-workspace.ts`)
 * decides when each is written.
 */
import type { ProjectShape } from "../shared/game-project.ts";

/** What a README in `references/` says to whoever opens the folder. */
export const REFERENCES_README = [
  "# References",
  "",
  "Reference images and notes for this game. They are not loaded by the game.",
  "",
].join("\n");

/** The line a game with a build gets: the command, and that the preview runs the same one. */
function buildRule(build: string): string {
  return `\nIt builds with \`${build}\`; Genex runs the same build before each preview.\n`;
}

/** `CLAUDE.own.md` filled in from the shape the folder actually has. */
export function ownRules(template: string, shape: ProjectShape): string {
  return template
    .replaceAll("__ENTRY_MAIN__", shape.main)
    .replaceAll("__SERVED_ENTRY__", shape.entry)
    .replaceAll(
      "__BUILD_LINE__",
      shape.build ? `it is built with \`${shape.build}\`` : "it runs as written, with no build step",
    )
    .replaceAll("__BUILD_RULE__", shape.build ? buildRule(shape.build) : "");
}

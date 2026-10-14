/**
 * The builder-facing pages the studio writes into a game folder: the rules and notes a game of
 * its own gets in place of the template's, and the `references/` readme. Text only; the
 * workspace (`game-workspace.ts`) decides when each is written.
 */
import { type CompiledStack, GameStack, isCompiledStack, type ProjectShape, stackOf } from "../shared/game-project.ts";

/** How many lines of the folder's own readme the seeded notes quote. */
const QUOTED_README_LINES = 40;

/** What a README in `references/` says to whoever opens the folder. */
export const REFERENCES_README = [
  "# References",
  "",
  "Drop stills, mood boards and notes here. The studio can see them — look at images",
  "in chat and they become the visual bar. They are **not** loaded as game assets;",
  "assets come from studio tools into `assets/` (the asset rule in CLAUDE.md).",
  "",
].join("\n");

/** The rule a game with a build gets: run it before finishing, and keep the contract's types. */
function buildRule(build: string): string {
  return [
    `6. **Run \`${build}\` before you finish**, and fix what it reports. The studio runs the`,
    `   same build before every preview and before every judge looks: a build that fails is a`,
    `   black screen for the user and a lost round for you. If the compiler rejects`,
    `   \`./studio.js\`, the types are in \`src/studio.d.ts\` beside it — point the config at them`,
    `   rather than deleting the import.`,
    "",
  ].join("\n");
}

/**
 * `CLAUDE.own.md` filled in from the shape the folder actually has. The build command appears
 * twice on purpose: once in the sentence that describes the game, and once as a rule of its
 * own, because a build that was never run is a black screen for every critic.
 */
export function ownRules(template: string, shape: ProjectShape): string {
  // Function replacements: `$'`, `$&` or `$$` in what the folder says stay its own characters.
  const buildLine = shape.build ? `it is built with \`${shape.build}\`` : "it runs as written, with no build step";
  const buildRuleText = shape.build ? buildRule(shape.build) : "";
  return template
    .replaceAll("__ENTRY_MAIN__", () => shape.main)
    .replaceAll("__SERVED_ENTRY__", () => shape.entry)
    .replaceAll("__BUILD_LINE__", () => buildLine)
    .replaceAll("__BUILD_RULE__", () => buildRuleText);
}

/** The pitch seeded from the folder's own readme, or the placeholder the first build replaces. */
function seededPitch(readme: { file: string; text: string } | null): string {
  if (!readme) return "(not written yet — the first build fills this in)";
  const quoted = readme.text
    .trim()
    .split("\n")
    .slice(0, QUOTED_README_LINES)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `From the folder's own \`${readme.file}\`, copied when the studio opened this game — replace it with the pitch once the first build knows better:\n\n${quoted}`;
}

/** How an adopted compiled game runs: the studio's own lane builds it, never a folder of its own. */
const COMPILED_RUNS = {
  [GameStack.RaylibCpp]:
    " the studio builds it with its own C++ toolchain for each destination, and Live shows that build, never a `build/` folder here.",
  [GameStack.RustWgpu]:
    " the studio builds it with its own Rust toolchain for each destination, and Live shows that build, never a `target/` folder here.",
} as const satisfies Record<CompiledStack, string>;

/** How an adopted game runs, for its notes' current state. */
function howItRuns(shape: ProjectShape): string {
  const stack = stackOf(shape);
  if (isCompiledStack(stack)) return COMPILED_RUNS[stack];
  if (shape.build) return ` it is built with \`${shape.build}\` and the studio serves \`${shape.entry}\`.`;
  return ` it runs as written and the studio serves \`${shape.entry}\`.`;
}

/**
 * `NOTES.own.md` for a game that already exists. Its "current state" is the shape, not "Empty
 * project", and its pitch is seeded from whatever the folder already says about itself — the
 * user wrote it once; nobody should have to write it again to be understood here.
 */
export function ownNotes(
  template: string,
  title: string,
  shape: ProjectShape,
  readme: { file: string; text: string } | null,
): string {
  const state = [
    `This game came with the folder (\`${shape.kind}\`). Its entry is \`${shape.main}\`;`,
    howItRuns(shape),
    " The studio has changed nothing yet — what changes from here is written down above.",
  ].join("");
  const pitch = seededPitch(readme);
  return template
    .replaceAll("__GAME_TITLE__", () => title)
    .replaceAll("__SEEDED_PITCH__", () => pitch)
    .replaceAll("__CURRENT_STATE__", () => state);
}

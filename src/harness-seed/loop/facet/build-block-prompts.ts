/** What the build block (facet/build-block.ts) says to its builder, and why its round was kept. */
import { slug } from "../spec.ts";
import { BUILD_BLOCK_MAX_MS, BUILD_BLOCK_MIN_MS } from "./build-block.ts";
import { MINUTE_MS } from "../time.ts";

/** The block's two ends, as its words name them ("60–90"): read when a line is written, never at load. */
const blockSpan = (): string =>
  `${Math.round(BUILD_BLOCK_MIN_MS / MINUTE_MS)}–${Math.round(BUILD_BLOCK_MAX_MS / MINUTE_MS)}`;

/** A part's bench page in a template game: one page that mounts just its module (loop/library.ts's bench rule). */
export const benchPage = (facetId: string): string => `bench/${slug(facetId, "part")}.html`;

/** The bench page a block names: a template game's for this part; a game the user brought has its own ways. */
export const blockBench = ({
  ownShape,
  spec,
}: {
  ownShape?: boolean;
  spec?: { id?: unknown } | null;
}): string | null => (ownShape ? null : benchPage(String(spec?.id ?? "")));

/** What to capture in the block's loop: the bench page where the game has one, and the part's own cameras. */
const captureWhat = (bench: string | null): string => (bench ? `page=${bench} and your cameras` : "your cameras");

/** The brief's section for a build block: what the round is, how to work it, and how it is kept. */
export function blockBriefSection(bench: string | null): string[] {
  return [
    `## THE BUILD BLOCK — your first round, ${blockSpan()} minutes`,
    `This round is one long build: the part is yours for ${blockSpan()} minutes before anything compares it with anything.`,
    bench
      ? `- First set up your bench page ${bench} (a page that mounts just your module), then work in a screenshot-and-fix loop: capture ${captureWhat(bench)}, LOOK, fix the worst thing you see, capture again.`
      : `- Work in a screenshot-and-fix loop: capture your cameras, LOOK, fix the worst thing you see, capture again.`,
    `- Build the move first, then keep climbing your ladder in order. If you stop early, the studio asks you to keep going until the block's time is up.`,
    `- The block is kept on the checks alone: the game must run, regress nothing and change what a player sees. The judge looks once and its notes are your next round's work; from round two every round is judged blind against the accepted build.`,
    ``,
  ];
}

/** The opening prompt's line for a build block (the brief carries the rest). */
export function blockPromptLine(bench: string | null): string {
  return `THE BUILD BLOCK (your first round, ${blockSpan()} min): one long build kept on the checks alone — ${bench ? `set up ${bench}, then ` : ""}screenshot, look and fix, round after round, until the block's time is up. The brief says how.`;
}

/** What a builder that ended its turn inside the block is asked: keep going, in the same session. */
export function blockContinueAsk({ minutesLeft, bench }: { minutesLeft: number; bench: string | null }): string {
  return [
    `BUILD BLOCK — keep going: about ${minutesLeft} more minutes before this part is looked at.`,
    `Work in a screenshot-and-fix loop: capture ${captureWhat(bench)}, LOOK at every frame against the intent and the reference, fix the worst thing you see, and capture again. Then the next thing, and the next rung of your ladder.`,
    `Keep every check passing and the game running; write what you fixed in your notes. Undo nothing that works.`,
  ].join("\n");
}

/** Why a build block was kept: on the checks, and what it flipped. */
export function blockReason(strong: readonly string[]): string {
  const flipped = strong.length ? `flipped ${strong.join(", ")}; ` : "";
  return `build block: kept on the checks (${flipped}it runs and regresses nothing) — the judge's notes are the next round's work, and the next round is judged side by side`;
}

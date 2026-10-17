/**
 * Bench pages: the page a part keeps to look at its one module in seconds (facet/build-block-prompts.ts
 * `benchPage`, loop/library.ts's bench rule). The game never loads one, so the template's rules
 * for game code (one seed, the step clock, tagged objects) do not reach them.
 */

/** The folder a template game keeps its parts' bench pages in. */
export const BENCH_FOLDER = "bench/";

/** Is this file one of the bench's own (a page, its script, a node sim beside it)? */
export const isBenchFile = (file: string): boolean => file.startsWith(BENCH_FOLDER);

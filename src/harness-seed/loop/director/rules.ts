/**
 * The Loop's plain rules, with no run of their own: what a landing may claim about the build it made
 * live, and the plain sentence a card falls back on. It imports no part of the run, so every part can
 * use it without an import cycle.
 */

/**
 * How a landing reads on the result card (a token the screen reads; persisted, never rename a value).
 * Only the health check speaks for a build now: no judge decides a landing.
 */
export const LandingHow = {
  JudgePick: "judge-pick",
  JudgeAnsweredYes: "judge-answered-yes",
  JudgeAnsweredNo: "judge-answered-no",
  FreshHealthPass: "fresh-health-pass",
  JudgeSawLoad: "judge-saw-load",
  NoFreshLook: "no-fresh-look",
  /** Nothing was made live, so there is nothing to claim. */
  NotLanded: "not-landed",
} as const;
export type LandingHow = (typeof LandingHow)[keyof typeof LandingHow];

/** What the landing can honestly claim about the build it made live: that its health check passed, or no fresh look. */
export function landingWords({ healthPassed = false }: { healthPassed?: boolean } = {}): {
  verified: boolean;
  how: LandingHow;
  line: string;
} {
  if (healthPassed)
    return { verified: false, how: LandingHow.FreshHealthPass, line: "made live; it loads and shows a picture" };
  return { verified: false, how: LandingHow.NoFreshLook, line: "made live, without a fresh look at it" };
}

/**
 * The fallback plain sentence, for a card whose writer gave none: everything only a developer
 * could read — shas, refs, run ids, absolute paths — is taken out and what is left is tidied.
 */
export function plainly(text: unknown): string {
  return (
    String(text ?? "")
      .replace(/\b(?:refs\/|attempt\/)[\w./-]+/g, "")
      .replace(/\/(?:Users|private|var|tmp)\/\S+/g, "")
      .replace(/\brun_[a-z0-9]{6,}\b/gi, "")
      // Eight and up: a word like "defaced" is not a sha, and every sha the cards carry is ten.
      .replace(/\b[0-9a-f]{8,40}\b/g, "")
      .replace(/\(\s*[),;:—–-]*\s*\)/g, "")
      .replace(/\s+([,.;:])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[\s—–:,;'"(-]+$/, "")
      // What a removed sha or ref leaves behind: "kept unlanded on", "merged shine at".
      .replace(/\s+(?:on|at|in|to|from|as|of)$/i, "")
      .replace(/[\s—–:,;'"(-]+$/, "")
      .trim()
  );
}

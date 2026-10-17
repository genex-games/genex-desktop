/**
 * The git command lines that leave a claim's proof out of the build: the status a commit reads,
 * the staging, and whether git tracks a proof file at all. They live in a module of their own
 * because the shipped `loop/git.ts` may gain no key another module reads: an in-app agent's kept
 * older copy would lack it.
 */
import { shellQuote } from "../shell.ts";

/** A path git matches as written, kept out of what a command reads. */
const keptOut = (rel: string): string => shellQuote(`:(exclude,literal)${rel}`);

/** The git commands that leave the claims' proof out of the build: the status a commit reads, and the staging. */
export const GIT_WITHOUT_PROOF = {
  status: (out: readonly string[]): string => `git status --porcelain -- . ${out.map(keptOut).join(" ")}`,
  addAll: (out: readonly string[]): string => `git add -A -- . ${out.map(keptOut).join(" ")}`,
  untracked: (rel: string): string =>
    `git status --porcelain --untracked-files=all -- ${shellQuote(`:(literal)${rel}`)}`,
} as const;

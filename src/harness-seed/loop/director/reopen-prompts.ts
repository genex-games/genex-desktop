/**
 * What a finished build reopened says to its lead (director/reopen.ts): the words its brief's resume
 * note opens with. Plain facts in, text out.
 */
import { shortSha } from "../git.ts";

/**
 * The words a reopened build's resume note opens with (director.ts `resumeWords`): where it goes on
 * from — the game folder as it is now when the finished build is in it, else the finished build.
 */
export function reopenNote({ inFolder, forkCommit }: { inFolder: boolean; forkCommit: string | null }): string {
  const from = inFolder
    ? `the game folder as it is now (${shortSha(forkCommit ?? "")}): the finished build is in it, with whatever changed since`
    : `the finished build (${shortSha(forkCommit ?? "")}), which is not in the game folder — finish lands it with what you add`;
  return `This build had finished; the user asked for more, so the same run goes on with a fresh working budget from ${from}.`;
}

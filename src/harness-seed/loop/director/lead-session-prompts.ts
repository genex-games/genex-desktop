/**
 * What a waking run's lead reads because it IS its chat's own session (one session,
 * lead-session.ts): where it sits and where it builds — with its own hands, in the integration
 * worktree it leads, beside the workers it hands parallel parts to — the chat so far when its
 * session is a fresh one, and what a merge conflict or a build that does not run asks of it. The
 * long turn keeps a director whose cwd is that worktree and reads none of this.
 */
import { shortSha } from "../git.ts";
import { clipMarked } from "../text.ts";

/** How many of the chat's latest messages a fresh lead is told, and at most how much of their text. */
export const CHAT_SO_FAR_MESSAGES = 20;
export const CHAT_SO_FAR_CHARS = 18_000;
/** At most this much of any one message. */
const CHAT_MESSAGE_CHARS = 4_000;
/** A commit a worker must type whole. */
const FULL_SHA = 40;

/** One message of the chat, as a fresh lead is told it. */
export interface ChatLine {
  role: string;
  content: string;
}

/**
 * The chat so far, for a lead whose session is not the chat's own after all — the chat had none on
 * this engine and model, or it could not be resumed: the latest messages, oldest first, clipped.
 */
export function chatSoFar(lines: readonly ChatLine[]): string {
  const said = lines
    .slice(-CHAT_SO_FAR_MESSAGES)
    .map((line) => `${line.role}: ${clipMarked(line.content, CHAT_MESSAGE_CHARS)}`)
    .join("\n")
    .slice(-CHAT_SO_FAR_CHARS);
  if (!said.trim()) return "";
  return `THE CHAT SO FAR (its latest messages, oldest first) — this chat's own session could not carry on here, so this session is new and this is the conversation the build came from:\n${said}`;
}

/** Where the lead sits, and the build it leads. */
export interface LeadWhere {
  gameFolder: string;
  integrationWorktree: string;
  baseCommit: string | null;
}

/** The lines of the director's brief a lead reads instead of the ones written for a director with its own hands. */
export const LEAD_BRIEF = {
  opening: (runId: string, project: string) =>
    `You are the DIRECTOR of run ${runId} on the game "${project}" — and still this chat's own session: the conversation the user has been having, now leading the build they asked for. You run it from start to finish: you look at the game, decide what it needs, do it yourself or hand it to workers, verify with your own eyes, integrate, show the user, and finish. Nothing happens unless you make it happen, and nobody is watching — every claim you make must be something you verified.`,
  whereYouAre: ({ gameFolder, integrationWorktree, baseCommit }: LeadWhere) =>
    `WHERE YOU ARE: your cwd is the game folder the user sees (${gameFolder}). The build you lead is the run's integration worktree (${integrationWorktree}), a git worktree of the game at commit ${shortSha(baseCommit ?? "")} — the integration branch. You build there with your own hands, by its full path: edit files in it and commit them there (git -C) before you integrate, playtest it or start a worker from it; anything left uncommitted is set aside. Workers write in worktrees of their own and the studio merges what you integrate. Leave the game folder as the user left it: finish lands the branch there.`,
  // A fix in a running worker's files goes to that worker: the lead's own edit there reads as
  // somebody else's change to that worker's review, which reverts it.
  delegate:
    "- After the starting point, do the foundations yourself in the integration worktree and commit them: splitting a big file so builders can work side by side, integration fixes, small repairs. Then every area the ask names, the UI and HUD too, gets a worker on its own files; a fix in a running worker's files goes to it (worker_steer now=yes).",
  contractFailed: (error: unknown, main: string) =>
    `CONTRACT NOT INSTALLED — DO THIS FIRST: this game's page never loads the studio contract, and the studio's own attempt to wire it in failed (${error}). Until it is wired nothing can be judged: no state, no cameras, no capture. Read ${main}: if the call is already there, say so in a note and carry on; otherwise wire it yourself in the integration worktree — \`import { installStudio } from "./studio.js"\` and \`installStudio({ renderer, player })\` in ${main} with this game's real renderer and player, nothing else — commit it, and look at it with capture before anything else.`,
  startingPointFailed: (error: unknown) =>
    `THE STARTING POINT: this game is an empty project and the studio's attempt at a starting point failed (${error}). Nothing runs until it does: build the world's shape and the shared modules yourself in the integration worktree and commit them, look at it — then start the workers on it.`,
  baseMustRun:
    "THE BASE MUST RUN: worker_start looks at the commit a loop worker forks from before it starts anyone (a console error there costs every worker its first iteration); a refusal names the problems — fix them yourself in the integration worktree and commit (or have a single worker on that build fix them and integrate it), and start again. An integration head that fails its health pass cannot land: fix it the same way, or judge it (a passing judge counts).",
  nested: (repos: readonly string[]) =>
    `NESTED REPOSITORIES: ${repos.join(", ")} — each is a git repository of its own inside the game folder. The studio versions such a folder in every fork when the user allowed it; if it did not, a health pass says this build carries nothing from inside it, and the first job is to vendor what the run builds on (its sources, without their .git) into src/ — yourself in the integration worktree, and commit it.`,
} as const;

/** The build card's rule for a lead (wake-prompts.ts `buildCard`): where it builds, and what it hands out. */
export const LEAD_CARD_RULE =
  "- You build in the integration worktree and commit there; workers take the parts that run side by side.";

/** The first line of a lead's fresh session (wake-prompts.ts `freshStart`): no memory file, the run follows. */
export const LEAD_FRESH_START = (why: string) =>
  `YOUR EARLIER SESSION WAS LOST (${why}) — this is a fresh one. Your notes and the run so far are below: carry on from where the run stands.`;

/** The sentence of `integrate`'s description a lead reads instead (wake-prompts.ts `wakeTools`): a conflict goes to a worker. */
export const LEAD_INTEGRATE_SWAP = [
  "A conflict elsewhere is left for you: the merge is aborted and the files listed — resolve it yourself with git in your worktree, then commit.",
  "A conflict elsewhere goes to a worker: the merge is aborted, the files listed, and the studio starts a single worker from the integration branch that resolves it — integrate that worker when it ends.",
] as const;

/** What a resumed lead is told about its memory: the journal and the digests carry the run. */
export const LEAD_RESUMED_MEMORY =
  "The journal kept the run: the digest below says where it stands, and run_status has the rest.";

/** What `integrate` answers a lead about a build that does not run after a merge. */
export const LEAD_FIX_NEXT =
  "the integrated build does not run — fix it yourself in the integration worktree and commit (its git log shows what came in), or start a single worker from integration to fix it and integrate it, before anything else";

/** What a lead is told when a loop worker's fork point does not run (workers.ts `forkGate`). */
export const LEAD_FORK_REFUSED = (commit: string | null, from: string) =>
  `the build at ${shortSha(commit ?? "")} (from=${from}) does not run — fix it (in the integration worktree yourself when from=integration, and commit; otherwise a single worker from=${from}, which starts on a build that does not run, then integrate it), then start this one again`;

/** At most this many of the paths set aside are named. */
const SET_ASIDE_NAMED = 8;

/** The paths as a sentence names them: the first few, and how many more. */
function someOf(files: readonly string[]): string {
  const more = files.length > SET_ASIDE_NAMED ? ` and ${files.length - SET_ASIDE_NAMED} more` : "";
  return `${files.slice(0, SET_ASIDE_NAMED).join(", ")}${more}`;
}

/**
 * What the studio did with changes no worker made in a lead's integration worktree (lead-session.ts
 * `setAsideStrays`): kept on a ref of the run, the worktree reset to the integration head.
 */
export const LEAD_SET_ASIDE = (ref: string, files: readonly string[]) =>
  `the integration worktree had uncommitted changes no worker made (${someOf(files)}); the studio kept them on ${ref} and reset the worktree to the integration head — a worker can bring any of them back with \`git checkout ${ref} -- <path>\``;

/** What `integrate` or a playtest answers a lead when those changes could not be set aside. */
export const LEAD_DIRTY = (error: unknown) =>
  `The integration worktree has uncommitted changes that no worker made (host-delivered assets were checkpointed; these were not), and the studio could not set them aside (${error}), so nothing is merged over them. Say what they are in a note: the user can clear them. Never move or delete assets.`;

/** What `worker_start` tells a lead whose integration worktree holds changes no worker made. */
export const LEAD_START_DIRTY =
  "the integration worktree has uncommitted changes no worker made; this worker forked from HEAD without them — the next integrate sets them aside on a ref of the run";

/** How a worker from before a pause is brought in by a lead that writes nothing (journal-prompts.ts). */
export const LEAD_PRIOR_BRINGS_IN = "integrating a worker started from it brings it in";

/** What `playtest target=live` answers when the game folder has changes of its own. */
export const LEAD_LIVE_DIRTY =
  "the game folder has uncommitted changes, and a lead's playtest of it plays a copy of its last commit — which would not be what the user sees; playtest integration or a worker instead";

/** The merge a conflict worker is started for (conflict-worker.ts). */
export interface ConflictFacts {
  /** The worker whose work conflicted. */
  of: string;
  title: string;
  commit: string;
  conflicts: readonly string[];
}

/** The conflict worker's words: its title, its brief, and what `integrate` answers the lead. */
export const CONFLICT_WORDS = {
  title: (title: string) => `Merge ${title}`,
  brief: ({ of, commit, conflicts }: ConflictFacts) =>
    `MERGE CONFLICT TO RESOLVE: this folder is the integration branch with worker ${of}'s accepted work (${shortSha(commit)}) being merged into it, and git stopped on conflicts in: ${conflicts.join(", ") || "the files git status lists as unmerged"}. Resolve every conflict in those files keeping both sides' work — nothing either side built may go missing: every module, demo, camera and tagged group each registered stays. Change nothing else, do not run git merge --abort, and do not commit: the studio commits the merge when you stop. (If git status shows no merge in progress, start it first: \`git merge --no-commit ${shortSha(commit, FULL_SHA)}\`.) Look at the build before you say it is done.`,
  started: (id: string, facts: ConflictFacts) =>
    JSON.stringify({
      merged: false,
      conflict: facts.conflicts,
      resolving: id,
      how: `the studio started worker ${id} from the integration branch to merge ${facts.of}'s work (${shortSha(facts.commit)}) and resolve the conflict; integrate ${id} when it ends, and leave the integration worktree's merge to it until then.`,
    }),
  refused: (why: string, facts: ConflictFacts) =>
    JSON.stringify({
      merged: false,
      conflict: facts.conflicts,
      how: `a worker must resolve this conflict and none could start (${why}); integrate ${facts.of} again once one can — the studio then starts it for you`,
    }),
  mergedCleanly: (of: string) => `the integration branch had moved: ${of}'s work merged without a conflict here`,
  markersLeft: (files: readonly string[]) =>
    `left conflict markers in ${files.join(", ")} — nothing was committed and the merge was aborted`,
  unresolved: (id: string, of: string, files: readonly string[]) =>
    JSON.stringify({
      merged: false,
      conflict: files,
      how: `worker ${id} left conflict markers in ${files.join(", ")}, so nothing of it was committed; integrate ${of} again and the studio starts a new worker for the conflict`,
    }),
} as const;

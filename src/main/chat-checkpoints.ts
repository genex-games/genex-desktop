import { serial } from "./core/serial.ts";
/**
 * The game folder as it was just before, and just after, each chat message was answered, so
 * rewinding a chat can put its files back. A checkpoint is a commit on a ref of the studio's own
 * (`refs/studio/chat/<thread>/before/<message>`) whose parent is the HEAD it was taken on.
 * Taking one never moves HEAD or a branch and never touches the user's index: the tree is
 * written through a private index file, and ref updates run with hooks off. Restoring writes
 * the working tree only.
 *
 * Host checkpoints preserve raw bytes: repository filters and hooks never run here, including
 * LFS conversion. Large files stay subject to the checkpoint size limit. Path lists use stdin.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, rm, rmdir, stat, utimes } from "node:fs/promises";
import { GIT_ENV } from "../substrate/snapshots.ts";
import { hostGitArgs, hostGitConfig, hostGitEnv } from "../substrate/git-policy.ts";
import { pathExists } from "../substrate/fsx.ts";
import { nestedRepos } from "../substrate/game-workspace.ts";
import { isBelow } from "../substrate/paths.ts";
import { ignoreLine, type PlacedRule, ruleGlob, ruleMatches } from "../shared/project-workspace.ts";
import { ensureFactIgnoreRules } from "../substrate/nested-repos.ts";
import { REWIND_REFS } from "../shared/game-history.ts";
import { isRewindId, UndoRewindRefusal, undoRewindRefusalWords } from "../shared/chat-rewind.ts";

/** Files the rewind never puts back: the game's shape and consent belong to now, not then. */
const KEPT_PATHS = new Set(["studio.json"]);
/** Where a checkpoint records what it left out, inside its own tree (never in the folder). */
const LEFT_OUT_FILE = ".studio-checkpoint-left-out.json";
/**
 * Never captured, whatever `.gitignore` says at the time: secrets, packages and build output
 * (the studio's own ignore rules, game-workspace.ts). A rewound `.gitignore` can therefore
 * neither smuggle `.env` into a checkpoint nor get it deleted.
 */
const NEVER_CAPTURED = [
  "**/.env",
  "**/.env.*",
  "**/node_modules/**",
  "**/.studio/**",
  "**/.git.studio-backup/**",
  "**/dist/**",
  "**/output/**",
  "**/.playwright-cli/**",
];
/** A single file this large stays out of checkpoints. */
export const CHECKPOINT_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** New or changed content a checkpoint takes in at once; the largest files beyond it stay out. */
export const CHECKPOINT_CHANGE_MAX_BYTES = 1024 * 1024 * 1024;
/** Message checkpoints kept per chat; older messages can still rewind the conversation. */
export const CHAT_CHECKPOINTS_KEPT = 100;
const REWOUND_KEPT = 10;
/** Git errors a fresh private index can cure; anything else is the folder's and is reported. */
const INDEX_TROUBLE =
  /index file|index\.lock|bad signature|index uses|unknown index entry format|sharedindex|invalid object|is not a valid object|bad object|unable to read [0-9a-f]{7}/i;

/** When a message's checkpoint is taken: before its answer, or after it. Part of each ref's name. */
export const CheckpointPhase = {
  Before: "before",
  After: "after",
} as const;
export type CheckpointPhase = (typeof CheckpointPhase)[keyof typeof CheckpointPhase];

/** Why a restore is refused. */
const MESSAGE = {
  HistoryChanged:
    "The game files changed through a commit or a landed build since this message, so they stay as they are.",
  NoCheckpoint: "There is no saved copy of the game files from before this message.",
  NotSaved: "The game files could not be saved before rewinding.",
  OutsideFolder: (relative: string) => `Refusing to remove a path outside the game folder: ${relative}`,
} as const;

/** The mode git records a nested repository's link with; its files are not the folder's. */
const GITLINK_MODE = "160000";

export type CheckpointPlan =
  | {
      state: "restore";
      files: number;
      /** Changed since the message by something other than this chat's answers (the user, an editor, a delivery). */
      outside: string[];
      /** A later answer left no checkpoint, so changes made outside the chat cannot be told apart. */
      outsideUnknown: boolean;
      /** Nested repositories: their files keep their own history and stay as they are. */
      nested: string[];
      /** Changed files too large to have been saved: they stay as they are. */
      tooLarge: number;
      /** Those files by path, present only when there are any. */
      tooLargeFiles?: string[];
    }
  | { state: "unchanged"; nested: string[] }
  | { state: "unavailable"; reason: "no-checkpoint" | "history-changed" }
  /** Every changed file is too large to have been saved; `tooLargeFiles` names them. */
  | { state: "unavailable"; reason: "too-large"; tooLargeFiles?: string[] };

interface Change {
  status: string;
  path: string;
}
/** A tree with what it left out. */
interface Snapshot {
  tree: string;
  nested: string[];
  skipped: string[];
  /** The folder's rules it left out by, when it was taken now; none for a stored checkpoint. */
  ruled: readonly PlacedRule[];
}
/** What a checkpoint left out: nested repositories, and files it skipped for their size. */
export type LeftOut = Pick<Snapshot, "nested" | "skipped">;
/**
 * A finished restore: how many files came back, the saved copy that undoes it (and the id its
 * `rewound/` ref is named by), and files too large to put back.
 */
export interface RestoredCheckpoint {
  files: number;
  saved: string;
  rewindId: string;
  /** Changed files too large to have been saved, which stayed as they are; present only when there are any. */
  stayed?: string[];
}

const refRoot = (threadId: string) => `${REWIND_REFS}${threadId}`;
export const chatCheckpointRef = (
  threadId: string,
  messageId: string,
  phase: CheckpointPhase = CheckpointPhase.Before,
): string => `${refRoot(threadId)}/${phase}/${messageId}`;
/** Where the folder as it was just before a rewind is kept, by the id the rewind's line names it with. */
const rewoundRef = (threadId: string, rewindId: string): string => `${refRoot(threadId)}/rewound/${rewindId}`;
/** A new rewind's id: base-36 time, then eight hex digits (`shared/chat-rewind.ts` `isRewindId`). */
const newRewindId = (): string => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const exec = promisify(execFile);
/** The PATH filters such as git-lfs are found on (an app started from the Finder has a bare one). */
let toolPath: string | undefined;
/**
 * Git with executable configuration disabled, never prompting. Line endings are kept
 * as they are: Git for Windows installs with core.autocrlf=true, which wrote LF files back as CRLF.
 */
async function read(dir: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  const environment = hostGitEnv({ ...(toolPath ? { PATH: toolPath } : {}), ...env });
  const config = await hostGitConfig(dir, environment);
  const running = exec("git", [...config, "-C", dir, "-c", "core.autocrlf=false", ...hostGitArgs(args)], {
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (input !== undefined) running.child.stdin?.end(input);
  return (await running).stdout;
}
/** Git as the studio: its identity, isolated configuration, and no hooks (reference-transaction). */
async function write(dir: string, args: string[]): Promise<string> {
  const env = hostGitEnv(GIT_ENV);
  const config = await hostGitConfig(dir, env);
  const { stdout } = await exec("git", [...config, "-C", dir, ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
const quiet = <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);
const nul = (items: readonly string[]) => items.map((item) => `${item}\0`).join("");
const message = (err: unknown) => String((err as Error)?.message ?? err);

/** What a checkpoint asks of its owner about a folder. */
export interface ChatCheckpointOptions {
  /**
   * The folder's own rules for what it holds (`shared/project-workspace.ts`), which a checkpoint of
   * it leaves out besides `NEVER_CAPTURED`. A rejection counts as none.
   */
  neverCaptured?: (dir: string) => Promise<readonly PlacedRule[]>;
}

/** A file time in milliseconds as whole seconds, rounded down: never later than the time itself. */
const wholeSeconds = (ms: number) => Math.floor(ms / 1000);

export class ChatCheckpoints {
  readonly #indexes: string;
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #path?: () => Promise<string>;
  readonly #neverCaptured: (dir: string) => Promise<readonly PlacedRule[]>;
  /** `toolchainPath`: the PATH git's filters are looked up on (see `toolPath`). */
  constructor(indexes: string, toolchainPath?: () => Promise<string>, options: ChatCheckpointOptions = {}) {
    this.#indexes = indexes;
    this.#path = toolchainPath;
    this.#neverCaptured = options.neverCaptured ?? (async () => []);
  }

  /** One git operation per folder at a time: they share the private index. */
  #serial<T>(dir: string, work: () => Promise<T>): Promise<T> {
    return serial(this.#tails, dir, async () => {
      if (this.#path && toolPath === undefined) toolPath = await this.#path().catch(() => process.env.PATH ?? "");
      return work();
    });
  }

  /**
   * Run `work` in the folder's queue, so no checkpoint interleaves with it, then reset the private
   * index, so no later checkpoint leans on an object `work` removed.
   */
  exclusive<T>(dir: string, work: () => Promise<T>): Promise<T> {
    return this.#serial(dir, async () => {
      try {
        return await work();
      } finally {
        await this.#resetIndex(dir);
      }
    });
  }

  async #indexFile(dir: string): Promise<string> {
    return path.join(
      this.#indexes,
      `${createHash("sha1")
        .update(await realpath(dir))
        .digest("hex")}.index`,
    );
  }

  async #index(dir: string, fromHead = false): Promise<string> {
    const file = await this.#indexFile(dir);
    if (await pathExists(file)) return file;
    await mkdir(this.#indexes, { recursive: true });
    // The repository's own index carries the stat cache for everything tracked, so the first
    // `add -A` hashes only what changed. Its staged state does not matter (`add -A` restages
    // all), but entries it tells git to skip must be read like any other.
    const own = path.join(dir, ".git", "index");
    if (!fromHead && (await pathExists(own))) {
      // With its times: git re-reads a file whose time (to the second) is not older than its
      // index's own, so a same-size edit in the second the repository last read it is still seen.
      // A copy dated now would read every such entry as unchanged. The times are read before the
      // copy and rounded down to the second, so the copy is never dated later than its content: a
      // git that rewrites the index in between, or a time in a second's last half millisecond,
      // only makes more entries racy, which costs a re-read and never misses an edit.
      const { atimeMs, mtimeMs } = await stat(own);
      await copyFile(own, file);
      await utimes(file, wholeSeconds(atimeMs), wholeSeconds(mtimeMs));
      const flagged = (await read(dir, ["ls-files", "-v", "-z"], { GIT_INDEX_FILE: file }))
        .split("\0")
        .filter((line) => /^([a-z]|S) /.test(line))
        .map((line) => line.slice(2));
      if (flagged.length)
        await read(
          dir,
          ["update-index", "--no-assume-unchanged", "--no-skip-worktree", "-z", "--stdin"],
          { GIT_INDEX_FILE: file },
          nul(flagged),
        );
    } else {
      const parent = await head(dir);
      await read(dir, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { GIT_INDEX_FILE: file });
    }
    return file;
  }

  async #resetIndex(dir: string): Promise<void> {
    const index = await this.#indexFile(dir);
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }

  /**
   * The folder's current content as a tree object; nothing else in the repository changes. Also
   * what it left out: nested repositories and files it skipped for size, which a restore never
   * touches since neither side of it holds them.
   */
  async #tree(dir: string): Promise<Snapshot> {
    try {
      return await this.#treeOnce(dir, false);
    } catch (err) {
      // The private index can go bad in ways a new one cures: a copied index this git cannot
      // use, a lock left by a killed git, blobs pruned since. Copy the repository's index again
      // (it keeps the stat cache), then start from HEAD. Any other failure is the folder's own.
      if (!INDEX_TROUBLE.test(message(err))) throw err;
      for (const fromHead of [false, true]) {
        await this.#resetIndex(dir);
        try {
          return await this.#treeOnce(dir, fromHead);
        } catch (next) {
          if (!INDEX_TROUBLE.test(message(next))) {
            await this.#resetIndex(dir);
            throw next;
          }
        }
      }
      await this.#resetIndex(dir);
      throw err;
    }
  }

  /**
   * The folder's own rules for what it holds, less any that reaches a file the repository tracks:
   * a tracked file stays in checkpoints as it stays in history, so Rewind still brings it back.
   */
  async #ruledOut(dir: string): Promise<readonly PlacedRule[]> {
    const rules = await this.#neverCaptured(dir).catch((): PlacedRule[] => []);
    if (!rules.length) return [];
    const listed = await quiet(read(dir, ["ls-files", "-z", "--", ...rules.map((rule) => pattern(ruleGlob(rule)))]));
    const tracked = (listed ?? "").split("\0").filter(Boolean);
    return rules.filter((rule) => !tracked.some((file) => ruleMatches(file, rule)));
  }

  async #treeOnce(dir: string, fromHead: boolean): Promise<Snapshot> {
    const index = await this.#index(dir, fromHead);
    const nested = await nestedRepos(dir);
    // The folder's own rules for what it holds, like NEVER_CAPTURED: a folder a rule names now
    // leaves the checkpoint even when an earlier one captured it.
    const ruled = await this.#ruledOut(dir);
    const excluded = [
      ...NEVER_CAPTURED.map(pattern),
      ...ruled.map((rule) => pattern(ruleGlob(rule))),
      ...nested.flatMap((name) => [`:(glob)${literal(name)}/**`, pattern(literal(name))]),
    ];
    const exclude = excluded.map((spec) => spec.replace(/^:\(/, ":(exclude,"));
    const skipped = await this.#oversized(dir, index, exclude);
    const env = { GIT_INDEX_FILE: index };
    // Out of the private index too (forced: it is ours), in case an earlier checkpoint held them;
    // so is a record a checkpoint interrupted before taking it back out.
    await read(
      dir,
      ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
      env,
      nul([...excluded, ...skipped.map((file) => `:(literal)${file}`), `:(literal)${LEFT_OUT_FILE}`]),
    );
    await read(
      dir,
      ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
      env,
      nul([".", ...exclude, ...skipped.map((file) => `:(exclude,literal)${file}`)]),
    );
    // Nothing left out needs no record (`snapshotOf` reads its absence as empty): three fewer git
    // runs before most answers.
    if (!nested.length && !skipped.length)
      return { tree: (await read(dir, ["write-tree"], env)).trim(), nested, skipped, ruled };
    // What it left out goes into the tree for the commit, and straight back out of the index.
    const record = (await read(dir, ["hash-object", "-w", "--stdin"], {}, JSON.stringify({ nested, skipped }))).trim();
    await read(dir, ["update-index", "--add", "--cacheinfo", `100644,${record},${LEFT_OUT_FILE}`], env);
    const tree = (await read(dir, ["write-tree"], env)).trim();
    await read(dir, ["update-index", "--force-remove", "--", LEFT_OUT_FILE], env);
    return { tree, nested, skipped, ruled };
  }

  /**
   * Files to leave out: each one over the size limit, and past the change budget the largest of
   * the rest. They are recorded with the checkpoint instead, so they never read as deleted.
   */
  async #oversized(dir: string, index: string, exclude: string[]): Promise<string[]> {
    // A short fixed list (ls-files takes no pathspec file); the long lists go on stdin elsewhere.
    const listed = (
      await read(dir, ["ls-files", "-z", "-o", "-m", "--exclude-standard", "--", ".", ...exclude], {
        GIT_INDEX_FILE: index,
      })
    )
      .split("\0")
      .filter(Boolean);
    const sized = await Promise.all(
      [...new Set(listed)].map(async (file) => ({
        file,
        size: (await lstat(path.join(dir, file)).catch(() => null))?.size ?? 0,
      })),
    );
    const skip: string[] = [];
    let total = 0;
    for (const { file, size } of sized.sort((a, b) => a.size - b.size)) {
      if (size > CHECKPOINT_FILE_MAX_BYTES || total + size > CHECKPOINT_CHANGE_MAX_BYTES) skip.push(file);
      else total += size;
    }
    return skip;
  }

  /** Commit the folder as it is now onto `ref`; the commit and the rules it left out by, or null past the deadline. */
  async #take(
    dir: string,
    ref: string,
    text: string,
    deadline?: number,
  ): Promise<{ commit: string; ruled: readonly PlacedRule[] } | null> {
    const [parent, { tree, ruled }] = await Promise.all([head(dir), this.#tree(dir)]);
    const commit = (await write(dir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", text])).trim();
    // Too late to be the folder before the answer: the answer may already be changing it.
    if (deadline !== undefined && Date.now() > deadline) return null;
    await write(dir, ["update-ref", ref, commit]);
    return { commit, ruled };
  }

  /**
   * Before a message is answered, or after. A message answered again after a restart keeps its
   * first "before": the interrupted answer may already have changed files. Returns null when
   * the deadline passed before the checkpoint was ready.
   */
  take(
    dir: string,
    threadId: string,
    messageId: string,
    phase: CheckpointPhase = CheckpointPhase.Before,
    deadline?: number,
  ): Promise<string | null> {
    return this.#serial(dir, async () => {
      const ref = chatCheckpointRef(threadId, messageId, phase);
      const existing = phase === CheckpointPhase.Before ? await commitAt(dir, ref) : null;
      if (existing) return existing;
      const taken = await this.#take(dir, ref, `studio: ${phase} chat message ${messageId}`, deadline);
      if (taken) await this.#prune(dir, `${refRoot(threadId)}/${phase}/`, CHAT_CHECKPOINTS_KEPT);
      return taken?.commit ?? null;
    });
  }

  async #prune(dir: string, prefix: string, keep: number): Promise<void> {
    const refs = (
      (await quiet(write(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", prefix]))) ?? ""
    )
      .split("\n")
      .filter(Boolean);
    for (const ref of refs.slice(keep)) await quiet(write(dir, ["update-ref", "-d", ref]));
  }

  /**
   * What restoring a message's checkpoint would do now. Files come back only while HEAD is the
   * commit the checkpoint was taken on: a commit or a landed build since then moved the game's
   * history, and a working-tree restore would read as uncommitted edits against it.
   * `answered` lists the messages answered from this one on, in order: the paths their answers
   * changed are this chat's, and so are `ours` (files the withdrawn messages themselves saved);
   * anything else that changed is reported as changed outside it.
   */
  plan(
    dir: string,
    threadId: string,
    messageId: string,
    answered: readonly string[] = [messageId],
    ours: readonly string[] = [],
  ): Promise<CheckpointPlan> {
    return this.#serial(dir, async () => {
      const found = await this.#checkpoint(dir, threadId, messageId);
      if ("reason" in found) return { state: "unavailable", reason: found.reason };
      const now = await this.#tree(dir);
      const { changes, tooLarge } = await restorable(dir, found.commit, now);
      if (!changes.length)
        return tooLarge.length
          ? { state: "unavailable", reason: "too-large", tooLargeFiles: tooLarge }
          : { state: "unchanged", nested: now.nested };
      const answers = await this.#answered(dir, threadId, answered, now.tree);
      const known = new Set([...(answers ?? []), ...ours]);
      return {
        state: "restore",
        files: changes.length,
        nested: now.nested,
        tooLarge: tooLarge.length,
        ...(tooLarge.length ? { tooLargeFiles: tooLarge } : {}),
        outside: answers ? changes.map((change) => change.path).filter((file) => !known.has(file)) : [],
        outsideUnknown: answers === null,
      };
    });
  }

  /** Paths the answers changed, from each answer's before/after pair; null when that is unknowable. */
  async #answered(
    dir: string,
    threadId: string,
    answered: readonly string[],
    now: string,
  ): Promise<Set<string> | null> {
    const paths = new Set<string>();
    for (const [index, messageId] of answered.entries()) {
      const before = await commitAt(dir, chatCheckpointRef(threadId, messageId));
      const after = await commitAt(dir, chatCheckpointRef(threadId, messageId, CheckpointPhase.After));
      const nextId = answered[index + 1];
      const next = nextId ? await commitAt(dir, chatCheckpointRef(threadId, nextId)) : null;
      // An answer that never recorded its end (a crash) is credited with its whole span.
      const end = after ?? next ?? now;
      if (!before) return null;
      for (const change of await changesBetween(dir, before, end)) paths.add(change.path);
    }
    return paths;
  }

  /**
   * Put the folder back to the message's checkpoint. The current content is kept first on a
   * `rewound/` ref; a restore that fails partway is undone from it before the error is reported,
   * and `putBack` undoes a finished one.
   */
  restore(dir: string, threadId: string, messageId: string): Promise<RestoredCheckpoint> {
    return this.#serial(dir, async () => {
      const found = await this.#checkpoint(dir, threadId, messageId);
      if ("reason" in found) {
        throw new Error(found.reason === "history-changed" ? MESSAGE.HistoryChanged : MESSAGE.NoCheckpoint);
      }
      return this.#restoreFrom(dir, threadId, found.commit, `studio: game files before rewinding to ${messageId}`);
    });
  }

  /**
   * Put the folder back as it was just before a rewind (its `rewound/` ref), saving the present on
   * a `rewound/` ref of its own first, so this too can be undone. Refused once the game's history
   * moved since the rewind, as a restore is; a restore that fails partway is undone the same way.
   */
  restoreSaved(dir: string, threadId: string, rewindId: string): Promise<RestoredCheckpoint> {
    const refused = (reason: UndoRewindRefusal) => new Error(undoRewindRefusalWords(reason));
    if (!isRewindId(rewindId)) return Promise.reject(refused(UndoRewindRefusal.Gone));
    return this.#serial(dir, async () => {
      const saved = await commitAt(dir, rewoundRef(threadId, rewindId));
      if (!saved) throw refused(UndoRewindRefusal.Gone);
      if ((await parentOf(dir, saved)) !== (await head(dir))) throw refused(UndoRewindRefusal.HistoryChanged);
      return this.#restoreFrom(dir, threadId, saved, `studio: game files before bringing back ${rewindId}`);
    });
  }

  /** Save the folder on a new `rewound/` ref, then restore `target`; a failure puts the saved copy back. */
  async #restoreFrom(dir: string, threadId: string, target: string, text: string): Promise<RestoredCheckpoint> {
    const rewindId = newRewindId();
    const taken = await this.#take(dir, rewoundRef(threadId, rewindId), text);
    if (!taken) throw new Error(MESSAGE.NotSaved);
    const saved = taken.commit;
    await this.#prune(dir, `${refRoot(threadId)}/rewound/`, REWOUND_KEPT);
    try {
      const current = { ...(await snapshotOf(dir, saved)), ruled: taken.ruled };
      const { files, stayed } = await restoreTo(dir, target, current, this.#indexes);
      await keepIgnoring(dir, taken.ruled);
      return { files, saved, rewindId, ...(stayed.length ? { stayed } : {}) };
    } catch (err) {
      await restoreTo(dir, saved, await this.#tree(dir), this.#indexes).catch(() => {});
      throw err;
    }
  }

  /** What a checkpoint commit left out (none for a commit that recorded nothing, or none at all). */
  async leftOut(dir: string, commit: string): Promise<LeftOut> {
    const { nested, skipped } = await snapshotOf(dir, commit);
    return { nested, skipped };
  }

  /** Was the folder saved before this message was answered, or after with `phase` (and is that copy still kept)? */
  async has(
    dir: string,
    threadId: string,
    messageId: string,
    phase: CheckpointPhase = CheckpointPhase.Before,
  ): Promise<boolean> {
    return (await commitAt(dir, chatCheckpointRef(threadId, messageId, phase))) !== null;
  }

  /** Undo a restore: the folder as it was when the rewind began. */
  putBack(dir: string, saved: string): Promise<number> {
    return this.#serial(dir, async () => (await restoreTo(dir, saved, await this.#tree(dir), this.#indexes)).files);
  }

  async #checkpoint(
    dir: string,
    threadId: string,
    messageId: string,
  ): Promise<{ commit: string } | { reason: "no-checkpoint" | "history-changed" }> {
    const commit = await commitAt(dir, chatCheckpointRef(threadId, messageId));
    if (!commit) return { reason: "no-checkpoint" };
    return (await parentOf(dir, commit)) === (await head(dir)) ? { commit } : { reason: "history-changed" };
  }
}

/**
 * Write the folder's rules of now back into its restored ignore file: a restore leaves what they
 * leave out on disk, and an older ignore file may not name it, though the folder it put back may no
 * longer hold what named those rules. A file that cannot be topped up is left as it is.
 */
async function keepIgnoring(dir: string, ruled: readonly PlacedRule[]): Promise<void> {
  await ensureFactIgnoreRules(dir, ruled.map(ignoreLine)).catch(() => {});
}

/** A checkpoint commit's tree and what it left out. */
async function snapshotOf(dir: string, commit: string): Promise<Snapshot> {
  let recorded: Partial<Snapshot> = {};
  try {
    recorded = JSON.parse(await read(dir, ["cat-file", "-p", `${commit}:${LEFT_OUT_FILE}`])) as Partial<Snapshot>;
  } catch {
    recorded = {};
  }
  return {
    tree: commit,
    nested: Array.isArray(recorded.nested) ? recorded.nested : [],
    skipped: Array.isArray(recorded.skipped) ? recorded.skipped : [],
    ruled: [],
  };
}

/** A folder name as a glob that matches only itself: wildcard characters become classes. */
function literal(name: string): string {
  return name.replace(/[*?[\]\\]/g, (match) => (match === "\\" ? "[\\\\]" : `[${match}]`));
}

/**
 * A segment that holds a wildcard: as it is when it has one, else its last character becomes a
 * class (`dis[t]`), or, when that is not ASCII, one `?` per UTF-8 byte (git matches classes byte
 * by byte).
 */
function wildcarded(segment: string): string {
  if (/[*?]|\[[^\]]*\]/.test(segment)) return segment;
  const chars = [...segment];
  const final = chars.pop() ?? "";
  const tail = /^[\x20-\x7e]$/.test(final) ? `[${final}]` : "?".repeat(Buffer.byteLength(final));
  return `${chars.join("")}${tail}`;
}

/**
 * A glob pathspec `git add` accepts even for an ignored path. It refuses an item whose literal
 * start names an ignored path outright, even to exclude it (`Saved/**` once `/Saved/` is ignored),
 * so the first part and the last get a wildcard each (`Save[d]/**`, `dis[t]`).
 */
function pattern(glob: string): string {
  const parts = glob.split("/");
  const last = parts.length - 1;
  return `:(glob)${parts.map((part, i) => (i === 0 || i === last ? wildcarded(part) : part)).join("/")}`;
}

async function head(dir: string): Promise<string | null> {
  return (await quiet(read(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])))?.trim() || null;
}
/** The commit a checkpoint was taken on (its first parent), or null for one taken before any commit. */
async function parentOf(dir: string, commit: string): Promise<string | null> {
  return (await quiet(read(dir, ["rev-parse", "--verify", "-q", `${commit}^1`])))?.trim() || null;
}

async function commitAt(dir: string, ref: string): Promise<string | null> {
  return (await quiet(read(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])))?.trim() || null;
}

/** Paths that differ between two trees, as seen from the first. */
async function changesBetween(dir: string, from: string, to: string): Promise<Change[]> {
  const parts = (await read(dir, ["diff-tree", "-r", "--no-renames", "-z", from, to])).split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [modeA, modeB, , , status = ""] = (parts[i] ?? "").replace(/^:/, "").split(" ");
    const file = parts[i + 1] ?? "";
    // A nested repository is recorded as a link to its own history; its files are not ours.
    const gitlink = modeA === GITLINK_MODE || modeB === GITLINK_MODE;
    if (gitlink || KEPT_PATHS.has(file) || file === LEFT_OUT_FILE) continue;
    changes.push({ status: status.charAt(0), path: file });
  }
  return changes;
}

const ancestors = (file: string): string[] =>
  file
    .split("/")
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join("/"));

/**
 * The changes a restore may make: none to what either side left out, nested or skipped, nor
 * beneath a skipped file's place, nor to what the folder's rules leave out now (an older
 * checkpoint may have captured engine scratch a rule names since: it stays as it is, whole).
 * `tooLarge` lists changed files held back for their size.
 */
async function restorable(
  dir: string,
  target: string | Snapshot,
  current: Snapshot,
): Promise<{ changes: Change[]; tooLarge: string[] }> {
  const from = typeof target === "string" ? await snapshotOf(dir, target) : target;
  const skipped = new Set([...from.skipped, ...current.skipped]);
  const roots = [...from.nested, ...current.nested];
  const all = await changesBetween(dir, from.tree, current.tree);
  const tooLarge = (file: string) => skipped.has(file) || ancestors(file).some((parent) => skipped.has(parent));
  const nested = (file: string) => roots.some((root) => file === root || file.startsWith(`${root}/`));
  const ruled = (file: string) => current.ruled.some((rule) => ruleMatches(file, rule));
  const kept = (file: string) => tooLarge(file) || nested(file) || ruled(file);
  return {
    changes: all.filter((change) => !kept(change.path)),
    tooLarge: all.filter((change) => tooLarge(change.path)).map((change) => change.path),
  };
}

/**
 * Make the working tree match `target` where it differs from `current`. Ignore files come back
 * first, and a path the restored rules ignore is left alone rather than deleted: it was not the
 * checkpoint's to have. Where a folder now stands in place of a file, or a file in place of a
 * folder, holding anything the checkpoints never saw, that place is left as it is, whole.
 * Answers how many files it changed, and the changed files it left for their size.
 */
async function restoreTo(
  dir: string,
  target: string,
  current: Snapshot,
  indexes: string,
): Promise<{ files: number; stayed: string[] }> {
  const { changes, tooLarge } = await restorable(dir, target, current);
  const root = await realpath(dir);
  const index = path.join(indexes, `restore-${randomUUID()}.index`);
  const checkout = async (files: string[]) => {
    if (files.length) await read(dir, ["checkout-index", "-f", "-z", "--stdin"], { GIT_INDEX_FILE: index }, nul(files));
  };
  try {
    await mkdir(indexes, { recursive: true });
    await read(dir, ["read-tree", target], { GIT_INDEX_FILE: index });
    const back = changes.filter((change) => change.status !== ADDED).map((change) => change.path);
    const rules = back.filter((file) => path.basename(file) === ".gitignore");
    await checkout(rules);
    const added = changes.filter((change) => change.status === ADDED).map((change) => change.path);
    const ignored = await ignoredAmong(dir, added);
    const removable = new Set(added.filter((file) => !ignored.has(file)));
    // Decide what stays before anything is removed: a place that holds more than the removals take.
    const kept = await keptPlaces(root, back, removable);
    const within = (file: string) => [...kept].some((place) => file === place || file.startsWith(`${place}/`));
    // Removals before the rest: a file can stand where the checkpoint has a folder, and the reverse.
    for (const file of removable) if (!within(file)) await removeInside(root, file);
    await clearFolders(
      root,
      back.filter((file) => !kept.has(file) && !rules.includes(file)),
    );
    await checkout(back.filter((file) => !rules.includes(file) && !kept.has(file)));
    const restored = (change: Change) => change.status !== ADDED || removable.has(change.path);
    return { files: changes.filter((change) => !within(change.path) && restored(change)).length, stayed: tooLarge };
  } finally {
    await rm(index, { force: true });
  }
}

/** The status `diff-tree` gives a path only the newer side has. */
const ADDED = "A";

/** Which of these paths the (restored) ignore rules ignore. */
async function ignoredAmong(dir: string, files: readonly string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  // Exit 1 means none is ignored.
  const listed = await quiet(read(dir, ["check-ignore", "--no-index", "--stdin", "-z"], {}, nul(files)));
  return new Set((listed ?? "").split("\0").filter(Boolean));
}

const isRealFolder = (entry: { isDirectory(): boolean; isSymbolicLink(): boolean } | null): boolean =>
  Boolean(entry?.isDirectory() && !entry.isSymbolicLink());

/**
 * The places a restore leaves whole: a folder standing where the checkpoint has a file and
 * holding more than the removals take, and a file (or link) standing where it has a folder.
 */
async function keptPlaces(root: string, back: readonly string[], removable: ReadonlySet<string>): Promise<Set<string>> {
  const kept = new Set<string>();
  for (const file of back) {
    const here = await lstat(path.join(root, file)).catch(() => null);
    if (isRealFolder(here) && !(await onlyRemovable(root, file, removable))) kept.add(file);
    for (const parent of ancestors(file)) {
      const there = await lstat(path.join(root, parent)).catch(() => null);
      if (there && !isRealFolder(there) && !removable.has(parent)) kept.add(file);
    }
  }
  return kept;
}

/** A folder standing where the checkpoint has a file goes, so the file can come back. */
async function clearFolders(root: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const here = await lstat(path.join(root, file)).catch(() => null);
    if (isRealFolder(here)) await rm(path.join(root, file), { recursive: true, force: true });
  }
}

/** Whether everything under a folder is a file the restore removes anyway (empty folders count). */
async function onlyRemovable(root: string, relative: string, removable: ReadonlySet<string>): Promise<boolean> {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    const goes = entry.isDirectory() ? await onlyRemovable(root, child, removable) : removable.has(child);
    if (!goes) return false;
  }
  return true;
}

/** Remove a file the checkpoint did not have, then any folders that became empty because of it. */
async function removeInside(root: string, relative: string): Promise<void> {
  const target = path.resolve(root, relative);
  if (!isBelow(root, target)) throw new Error(MESSAGE.OutsideFolder(relative));
  await rm(target, { force: true });
  for (let dir = path.dirname(target); isBelow(root, dir); dir = path.dirname(dir)) {
    if ((await readdir(dir).catch(() => ["?"])).length) break;
    await rmdir(dir).catch(() => {});
  }
}

/**
 * The self-edit gate: a change to the harness's own code is tried in a validation fork before it
 * is accepted. The fork is a worktree of the harness repository (the architect's fork); the
 * change is written into it, the vendored TypeScript 7 compiler checks it inside the sandbox
 * (`substrate/type-gate.ts`), and only a fork that type-checks then boots and answers its
 * healthcheck — plus the loop self-test, for an architect job — lets the change through.
 *
 * What a pass buys (PH-5): the code the fork booted is recorded by fingerprint, and a harness
 * snapshot whose code is exactly that is healthy — a rewind target — at once, instead of only
 * after the next restart. A snapshot of anything else still has to boot for real first.
 *
 * The gate fails closed: no compiler, a compiler that fails or times out, a fork that cannot be
 * made — each is a refusal with a sentence the agent can read, never a silent accept.
 * Composed by `StudioCore`; its state stays here.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HostMethod,
  type HarnessResult,
  type SelfEditStage,
  type SelfEditVerdict,
  type SelfWriteResult,
} from "../../shared/harness-api.ts";
import { CustomEvent, type SelfChangePayload, customEventData } from "../../shared/custom-events.ts";
import { type EventData, SnapshotScope } from "../../shared/event-log.ts";
import { SKILL_SLUG } from "../../shared/self-change-files.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { atomicWriteText, ensureDir, pathExists } from "../../substrate/fsx.ts";
import { HarnessHost } from "../../substrate/harness-host.ts";
import { shortId } from "../../substrate/ids.ts";
import { type SnapshotRecord, HARNESS_WORKSPACE } from "../../substrate/snapshots.ts";
import { TypeCheckFailure, type TypeCheckResult, typeCheckText, typecheckHarness } from "../../substrate/type-gate.ts";
import { RUNS_AS_CODE } from "../self-changes.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** One file of a proposed change, workspace-relative. */
export interface ProposedFile {
  file: string;
  contents: string;
}

/** What a fork boot answered: up and healthy, or why it stopped. */
export type ForkBoot = { ok: true } | { ok: false; stage: "boot"; message: string };

/** How many passed fingerprints are remembered: a pass is claimed by the snapshot right after it. */
const REMEMBERED_PASSES = 8;
/** The most files one proposed change may carry. */
const MAX_FILES = 20;
/** The largest file a proposed change may carry, in bytes. */
const MAX_FILE_BYTES = 1024 * 1024;
/** How long a fork's harness may go without a heartbeat before its host gives up on it. */
const FORK_HEARTBEAT_TIMEOUT_MS = 10 * MINUTE_MS;
/** A fork crashes once and stays down: one exit in this window is a crash loop. */
const FORK_CRASH_LOOP = { count: 1, windowMs: MINUTE_MS } as const;
/** A proposed file's path may hold no control character and no backslash. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const UNSAFE_PATH_CHARS = /[\x00-\x1f\\]/;
/** Folders a proposed change may never write into at any depth: git's own and installed packages. */
const NEVER_WRITTEN = [".git", "node_modules"] as const;

/** What the gate tells the agent when it turns a change away. */
const MESSAGE = {
  fileCount: `Send between 1 and ${MAX_FILES} files.`,
  notYours: (file: unknown) => `Not a file of yours: ${String(file)}`,
  notSmallText: (rel: string) => `${rel} is not text under ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
  noFork: (err: unknown) => `Studio could not make a copy of itself to try the change in (${errorMessage(err)}).`,
  notTried: (err: unknown) => `The change could not be tried: ${errorMessage(err)}`,
  didNotStart: (why: string) => `A copy of Studio with this change did not start: ${why}`,
  newTypeErrors: (count: number) => `${count} new type error${count === 1 ? "" : "s"}.`,
  learningOff: "Self-improvement is off: your own code, prompts and skills stay as they are.",
} as const;

/** The longest reason a self-change keeps in its snapshot and record. */
const MAX_REASON_CHARS = 2_000;
/** The plain words a self-change keeps for Activity: a title, and at most this many summary lines of this length. */
const MAX_TITLE_CHARS = 90;
const MAX_SUMMARY_LINES = 3;
const MAX_SUMMARY_LINE_CHARS = 200;
/** A skill's file: `skills/<slug>.md`, one level down. */
const SKILL_FILE = /^skills\/([^/]+)\.md$/;
/** Where the agent's own tools live. */
const TOOLS_DIR = "tools/";

/** Where a failed type check stops a change. */
const TYPE_FAILURE_STAGE: Record<TypeCheckFailure, SelfEditStage> = {
  errors: "types",
  timeout: "timeout",
  unavailable: "unavailable",
  crashed: "unavailable",
};

/** A change the gate turns away, and the sentence the agent reads about it. */
function refuse(stage: SelfEditStage, message: string): SelfEditVerdict {
  return { ok: false, stage, message };
}

const isSmallText = (contents: unknown): contents is string =>
  typeof contents === "string" && Buffer.byteLength(contents) <= MAX_FILE_BYTES;

/** A proposed change checked before any fork is made: 1 to 20 files of the agent's own, each text under 1 MB. */
function checkedProposal(files: readonly ProposedFile[]): { accepted: ProposedFile[] } | { refusal: string } {
  const wrongCount = !Array.isArray(files) || files.length === 0 || files.length > MAX_FILES;
  if (wrongCount) return { refusal: MESSAGE.fileCount };
  const accepted: ProposedFile[] = [];
  for (const entry of files) {
    const rel = checkedRel(entry?.file);
    if (!rel) return { refusal: MESSAGE.notYours(entry?.file) };
    if (!isSmallText(entry.contents)) return { refusal: MESSAGE.notSmallText(rel) };
    accepted.push({ file: rel, contents: entry.contents });
  }
  return { accepted };
}

export class SelfEditGateService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;
  #chain: Promise<unknown> = Promise.resolve();
  /** Fingerprints of code that booted in a fork, newest last. */
  #passed: string[] = [];

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /**
   * A worktree of the harness at its current commit under scratch. `carryLive` brings in what the
   * live workspace has changed since that commit, so the fork is the live self, not the last
   * snapshot of it.
   */
  async openFork(dir: string, { carryLive = false }: { carryLive?: boolean } = {}): Promise<void> {
    await this.#core.snapshots.removeWorktree("harness", dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await ensureDir(path.dirname(dir));
    const commit = await this.#core.snapshots.currentCommit(HARNESS_WORKSPACE);
    await this.#core.snapshots.worktreeAt("harness", commit, dir);
    if (!carryLive) return;
    const live = this.#core.layout.harnessWs;
    for (const rel of await this.#core.snapshots.uncommittedPaths(HARNESS_WORKSPACE)) {
      const from = path.join(live, rel);
      const to = path.join(dir, rel);
      await this.#x.assertNoLinkBelow(dir, to);
      if (await pathExists(from)) {
        await mkdir(path.dirname(to), { recursive: true });
        await cp(from, to, { force: true, recursive: true });
      } else {
        await rm(to, { force: true, recursive: true });
      }
    }
  }

  async closeFork(dir: string): Promise<void> {
    await this.#core.snapshots.removeWorktree("harness", dir).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * The vendored compiler over the fork, held to the app's own tsconfig (never the workspace's,
   * which the agent may edit ungated), read-only, within the gate's time limit.
   */
  typecheck(dir: string, signal?: AbortSignal): Promise<TypeCheckResult> {
    return typecheckHarness(this.#core.sandbox, {
      resources: this.#core.options.paths.resources,
      dir,
      config: path.join(this.#core.options.paths.resources, "harness-seed", "tsconfig.json"),
      ...(this.#core.options.typeGate?.timeoutMs ? { timeoutMs: this.#core.options.typeGate.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Boot the fork as a second harness (it never restarts itself: one failure and it stays down),
   * and ask its healthcheck.
   */
  async boot(dir: string): Promise<ForkBoot> {
    const fork = new HarnessHost({
      workspace: dir,
      bootstrap: path.join(this.#core.options.paths.resources, "harness-boot", "bootstrap.mjs"),
      execPath: this.#core.options.execPath ?? process.execPath,
      ...(this.#core.options.runAsNode ? { runAsNode: true } : {}),
      sandbox: this.#core.sandbox,
      // Proposed code has not earned live authority. Boot, shutdown and self-test run locally;
      // only the healthcheck's read-only head query crosses into the host.
      api: { [HostMethod.EventsHead]: this.#core.api()[HostMethod.EventsHead] },
      updatesDir: this.#core.layout.updates,
      heartbeatTimeoutMs: FORK_HEARTBEAT_TIMEOUT_MS,
      // A fork that cannot boot must fail once and stay down — never auto-restart-loop a
      // deliberately experimental self while the real one keeps running.
      crashLoop: { ...FORK_CRASH_LOOP },
      onCrashLoop: () => {},
      ...(this.#core.options.onLog ? { onLog: this.#core.options.onLog } : {}),
    });
    try {
      await fork.start();
      if (!(await fork.healthcheck()))
        return { ok: false, stage: "boot", message: "it did not answer its healthcheck" };
      return { ok: true };
    } catch (err) {
      return { ok: false, stage: "boot", message: errorMessage(err) };
    } finally {
      await fork.stop().catch(() => {});
    }
  }

  /**
   * `guardian.validate_edit`: try `files` in a fork of the live self. Serialized, so two edits
   * never share a fork. A pass is remembered for the snapshot the harness takes after writing.
   */
  validateEdit(files: readonly ProposedFile[]): Promise<HarnessResult<"guardian.validate_edit">> {
    const run = this.#chain.then(() => this.#validate(files));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #validate(files: readonly ProposedFile[]): Promise<HarnessResult<"guardian.validate_edit">> {
    const proposal = checkedProposal(files);
    if ("refusal" in proposal) return refuse("refused", proposal.refusal);
    const dir = path.join(this.#core.layout.scratch, "self-edit", shortId("fork"));
    try {
      try {
        await this.openFork(dir, { carryLive: true });
      } catch (err) {
        return refuse("unavailable", MESSAGE.noFork(err));
      }
      return await this.#tryInFork(dir, proposal.accepted);
    } catch (err) {
      return refuse("unavailable", MESSAGE.notTried(err));
    } finally {
      await this.closeFork(dir);
    }
  }

  /** Write the change into the fork, type-check it (code only), boot it; a pass is remembered. */
  async #tryInFork(dir: string, accepted: readonly ProposedFile[]): Promise<SelfEditVerdict> {
    const changes = new Map<string, { before: string | null; after: string }>();
    for (const { file: rel, contents } of accepted) {
      const target = path.join(dir, rel);
      await this.#x.assertNoLinkBelow(dir, target);
      changes.set(rel, { before: await readFile(target, "utf8").catch(() => null), after: contents });
    }
    await writeChanges(dir, changes, "after");
    const checked: string[] = [];
    if (accepted.some(({ file }) => RUNS_AS_CODE.test(file))) {
      const types = await this.typesAddedBy(dir, changes);
      if (!types.ok) return refuse(TYPE_FAILURE_STAGE[types.reason], typeCheckText(types));
      checked.push("types");
    }
    const booted = await this.boot(dir);
    if (!booted.ok) return refuse("boot", MESSAGE.didNotStart(booted.message));
    checked.push("boot");
    this.#remember(await codeFingerprint(dir));
    return { ok: true, checked };
  }

  /**
   * The fork's type check, holding the change to one rule: it may not add type errors. Errors the
   * self already had (a file migrated from JavaScript, say) do not block a change that leaves them
   * as they were — counted by file, code and message, since an edit moves the lines — so an agent
   * can fix such a file a piece at a time. Every error the change adds is reported.
   */
  async typesAddedBy(
    dir: string,
    changes: ReadonlyMap<string, { before: string | null; after: string }>,
  ): Promise<TypeCheckResult> {
    const after = await this.typecheck(dir);
    if (after.ok || after.reason !== TypeCheckFailure.Errors) return after;
    // The self without the change, for what it already had; then the change back for the boot.
    await writeChanges(dir, changes, "before");
    const before = await this.typecheck(dir);
    await writeChanges(dir, changes, "after");
    if (!before.ok && before.reason !== TypeCheckFailure.Errors) return before;
    const known = new Map<string, number>();
    for (const line of before.ok ? [] : before.diagnostics)
      known.set(diagnosticKey(line), (known.get(diagnosticKey(line)) ?? 0) + 1);
    const added = after.diagnostics.filter((line) => {
      const left = known.get(diagnosticKey(line)) ?? 0;
      if (left > 0) known.set(diagnosticKey(line), left - 1);
      return left === 0;
    });
    if (added.length > 0)
      return {
        ...after,
        message: MESSAGE.newTypeErrors(added.length),
        diagnostics: added,
      };
    return { ok: true, durationMs: 0 };
  }

  /**
   * `guardian.write_self`: the one way the harness changes one of its own files. The change is
   * tried in a fork exactly as `validate_edit` tries it; only a pass is written, between two host
   * snapshots, and the host records it (`self_edit`, `skill_edited`, `tool_installed`) where
   * Activity and Undo read it. Serialized with the gate, so a write never lands mid-validation.
   */
  writeSelf(p: SelfWriteParams): Promise<SelfWriteResult> {
    const run = this.#chain.then(() => this.#writeSelf(p));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #writeSelf({ file, contents, reason, title, summary }: SelfWriteParams): Promise<SelfWriteResult> {
    // Self-improvement is stopped unless the person turned learning on: the harness stays as shipped.
    if (!this.#core.settings.learning) return { ok: false, stage: "refused", message: MESSAGE.learningOff };
    const ws = this.#core.layout.harnessWs;
    const rel = checkedRel(file);
    const notYours: SelfWriteResult = { ok: false, stage: "refused", message: MESSAGE.notYours(file) };
    if (!rel) return notYours;
    const target = path.join(ws, rel);
    try {
      // A link planted anywhere on the way, the file itself included, would carry the write out.
      await this.#x.assertNoLinkBelow(ws, target);
    } catch {
      return notYours;
    }
    const verdict = await this.#validate([{ file: rel, contents }]);
    if (!verdict.ok) return { ok: false, stage: verdict.stage, message: verdict.message };
    const existed = await pathExists(target);
    const why = String(reason ?? "").slice(0, MAX_REASON_CHARS);
    const before = await this.#core.snapshot(SnapshotScope.Harness, `before self-edit: ${rel} — ${why}`);
    await ensureDir(path.dirname(target));
    await this.#x.assertNoLinkBelow(ws, target);
    await atomicWriteText(target, contents);
    const after = await this.#afterSnapshot(`after self-change: ${rel} — ${why}`);
    await this.#core.append([
      selfChangeRecord(rel, existed, {
        reason: why,
        ...plainWordsOf(title, summary),
        snapshot_id: before.snapshot_id,
        post_snapshot_id: after.snapshot_id,
        bytes: Buffer.byteLength(contents),
      }),
    ]);
    return {
      ok: true,
      file: rel,
      snapshotId: before.snapshot_id,
      postSnapshotId: after.snapshot_id,
      checked: verdict.checked,
    };
  }

  /**
   * The snapshot after a self-change: healthy by the host's own rules only (files that never run,
   * or code exactly as the fork booted it), the way `snapshot.create` grants a harness request.
   */
  async #afterSnapshot(reason: string): Promise<SnapshotRecord> {
    const record = await this.#core.snapshot(SnapshotScope.Harness, reason, undefined, false);
    await this.#x.recovery.inheritHealth(record);
    await this.vouchIfValidated(this.#core.snapshotIndex.get(record.snapshot_id) ?? record);
    return this.#core.snapshotIndex.get(record.snapshot_id) ?? record;
  }

  #remember(fingerprint: string): void {
    this.#passed = [...this.#passed.filter((known) => known !== fingerprint), fingerprint].slice(-REMEMBERED_PASSES);
  }

  /**
   * Called for a harness snapshot the harness asked to be healthy: when the code it holds is
   * exactly code a fork booted, it is healthy now. Anything else is left to a real boot.
   */
  async vouchIfValidated(record: SnapshotRecord): Promise<void> {
    const mayVouch = this.#passed.length > 0 && !record.healthy && Boolean(record.git.harness);
    if (!mayVouch) return;
    const fingerprint = await codeFingerprint(this.#core.layout.harnessWs).catch(() => null);
    if (fingerprint && this.#passed.includes(fingerprint)) this.#x.recovery.markHealthy(record.snapshot_id);
  }
}

/**
 * The log record of a self-change, named for what it changed: a skill (`skills/<slug>.md`), a
 * tool that was not there before (`tools/…`), or any other file of the agent's own.
 */
/** What `guardian.write_self` is asked: the change, why, and the agent's plain words for the person. */
type SelfWriteParams = { file: string; contents: string; reason: string; title?: unknown; summary?: unknown };

/** One line of plain words: whitespace folded, clipped; empty for anything but text. */
const plainLine = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The title and summary a self-change keeps for Activity, bounded; each left out when the agent wrote none. */
function plainWordsOf(title: unknown, summary: unknown): Pick<SelfChangePayload, "title" | "summary"> {
  const heading = plainLine(title, MAX_TITLE_CHARS);
  const lines = (Array.isArray(summary) ? summary : [])
    .map((line) => plainLine(line, MAX_SUMMARY_LINE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_SUMMARY_LINES);
  return { ...(heading ? { title: heading } : {}), ...(lines.length ? { summary: lines } : {}) };
}

function selfChangeRecord(rel: string, existed: boolean, payload: SelfChangePayload): EventData {
  const skill = SKILL_FILE.exec(rel)?.[1];
  if (skill && SKILL_SLUG.test(skill)) return customEventData(CustomEvent.SkillEdited, { slug: skill, ...payload });
  if (!existed && rel.startsWith(TOOLS_DIR))
    return customEventData(CustomEvent.ToolInstalled, { file: rel, ...payload });
  return customEventData(CustomEvent.SelfEdit, { file: rel, ...payload });
}

/** Put one side of a change into the fork: the proposed files, or what was there before them. */
async function writeChanges(
  dir: string,
  changes: ReadonlyMap<string, { before: string | null; after: string }>,
  side: "before" | "after",
): Promise<void> {
  for (const [rel, change] of changes) {
    const target = path.join(dir, rel);
    const text = change[side];
    if (text === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

/** A diagnostic without its position: `loop/x.ts(12,3): error TS2322: …` → `loop/x.ts TS2322 …`. */
function diagnosticKey(line: string): string {
  return line.replace(/^(.+?)\(\d+,\d+\): error (TS\d+): /, "$1 $2 ");
}

/** A workspace-relative path the agent may propose: no escape, not git's, not an installed package's. */
function checkedRel(file: unknown): string | null {
  if (typeof file !== "string" || !isPlainRelative(file)) return null;
  const parts = file.split("/");
  if (parts.some(isEmptyOrDots)) return null;
  const offLimits = NEVER_WRITTEN.some((folder) => parts.includes(folder));
  return offLimits ? null : file;
}

/** A non-empty relative path with no control character or backslash in it. */
function isPlainRelative(file: string): boolean {
  return Boolean(file) && !UNSAFE_PATH_CHARS.test(file) && !path.isAbsolute(file);
}

/** A path segment that names nothing or only moves: empty, `.` or `..`. */
function isEmptyOrDots(part: string): boolean {
  return !part || part === "." || part === "..";
}

/**
 * sha256 over every file Node would run in `dir` (RUNS_AS_CODE), by path and content — what a
 * fork booted, compared with what a snapshot of the live self holds.
 */
export async function codeFingerprint(dir: string): Promise<string> {
  const files: string[] = [];
  await collectCode(dir, "", files);
  const hash = createHash("sha256");
  for (const rel of files.sort())
    hash.update(
      `${rel}\0${createHash("sha256")
        .update(await readFile(path.join(dir, rel)))
        .digest("hex")}\n`,
    );
  return hash.digest("hex");
}

/** Every file Node would run below `rel` in `dir`, workspace-relative, skipping git's and packages. */
async function collectCode(dir: string, rel: string, files: string[]): Promise<void> {
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectCode(dir, child, files);
    else if (entry.isFile() && RUNS_AS_CODE.test(child)) files.push(child);
  }
}

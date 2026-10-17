/**
 * What a game and a run hold: reference frames and run artifacts saved, the user's feedback on a
 * run, and a project's assets listed, previewed and read back through the contained readers.
 * Composed by `StudioCore`; its state stays in the core.
 */
import { assetWorkspaces } from "../asset-workspaces.ts";
import { assertAssetPath, readAssetPreview } from "../asset-preview.ts";
import { readModelRig } from "../model-rigs.ts";
import type { ModelRig } from "../../shared/model-rig.ts";
import { assertRelativePath, isBelow } from "../../substrate/paths.ts";
import {
  genexJobDir,
  reconcileGeneratedAssets,
  joinProjectAssets,
  readGenexJobs,
  walkGameAssets,
} from "../game-assets.ts";
import type { ProjectAssets } from "../../shared/game-assets.ts";
import { type AssetCall, assetCallJobs } from "./asset-calls.ts";
import { type AssetFolder, assetFoldersFor, DEFAULT_ASSET_FOLDERS } from "../../shared/project-workspace.ts";
import path from "node:path";
import { rewindsOf, withoutRewound } from "../../shared/chat-rewind.ts";
import { latestRun } from "../../shared/coordinator.ts";
import { genexOutputFile, isGenexRef, parseGenexRef } from "../../shared/genex-ref.ts";
import { createHash } from "node:crypto";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { ensureDir, ensureDirBelow, pathExists, writeFileInDir } from "../../substrate/fsx.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { git } from "../../substrate/snapshots.ts";
import type { EventEnvelope } from "../../substrate/types.ts";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import type { StudioCore } from "../studio-core.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { SECOND_MS } from "../../shared/duration.ts";

/** Errors the user (or the renderer on their behalf) reads when an asset request is refused. */
const MESSAGE = {
  feedbackEmpty: "feedback text is empty",
  feedbackNeedsThread: "feedback needs the run's thread",
  invalidRetainedRef: "Invalid retained asset reference",
  notThisGamesAsset: "Asset does not belong to this game",
  notContained: "Asset is not a contained regular file",
  assetRequired: "Project and asset are required.",
  recordedAssetUnavailable: "Recorded asset is unavailable.",
  filesRequired: "Project and files are required.",
} as const;

/** The most mood-board frames one call saves, and the largest one, in bytes. */
const MAX_REFERENCE_FRAMES = 12;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
/** How long a reference still's name may grow from its label. */
const REFERENCE_SLUG_MAX_CHARS = 40;
/** The most delivered files one presence check looks at. */
const MAX_PRESENCE_FILES = 200;
/** The longest label a run's feedback keeps. */
const FEEDBACK_LABEL_CHARS = 120;
/** How long a game's asset folders are reused by its previews and thumbnails: the Assets stage's poll. */
const ASSET_FOLDERS_FRESH_MS = 10 * SECOND_MS;

/** A reference still written into the game; `created` when this call added the file. */
export interface SavedReference {
  file: string;
  bytes: number;
  created: boolean;
}

/** A run id as a folder name: no separators, no leading dot. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A reference still's file name stem: its label, slugged, or `board`. */
function referenceSlug(label: string | undefined): string {
  const slug = (label ?? "board")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, REFERENCE_SLUG_MAX_CHARS);
  return slug || "board";
}

/** What a run's feedback refers to: `facet …, camera …, iteration …`, as far as it says. */
function feedbackTarget(p: { facetId?: string; camera?: string; iteration?: number }): string {
  return [
    p.facetId ? `facet ${p.facetId}` : null,
    p.camera ? `camera ${p.camera}` : null,
    p.iteration ? `iteration ${p.iteration}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export class AssetService {
  readonly #core: StudioCore;
  readonly #git: typeof git;
  /** Each game's asset folders as last read, and when, shared by the reads that follow. */
  readonly #folders = new Map<string, { at: number; folders: Promise<AssetFolder[]> }>();
  /** The clock the folders' reuse window is read on. */
  readonly #now: () => number;
  /** The calls making an asset right now, which the plugin tools note (`asset-calls.ts`). */
  readonly #calls: ReadonlyMap<string, AssetCall>;

  constructor(
    core: StudioCore,
    runGit: typeof git = git,
    now: () => number = Date.now,
    calls: ReadonlyMap<string, AssetCall> = new Map(),
  ) {
    this.#core = core;
    this.#git = runGit;
    this.#now = now;
    this.#calls = calls;
  }

  /**
   * Persist mood-board frames into `<project>/references/` (scaffolded per game, agent-readable,
   * recognised by user-paths). Closes the game.write-is-string-only gap without widening
   * game.write itself. Names are content-hashed so re-sending the same board is idempotent.
   */
  async saveReferenceFrames(project: string, frames: ReferenceFrame[]): Promise<SavedReference[]> {
    const dir = path.join(this.#core.games.dirFor(project), "references");
    await ensureDir(dir);
    const saved: SavedReference[] = [];
    const skipped: string[] = [];
    for (const frame of frames.slice(0, MAX_REFERENCE_FRAMES)) {
      if (!frame?.data) continue;
      const data = Buffer.from(frame.data, "base64");
      if (data.length === 0 || data.length > MAX_REFERENCE_BYTES) continue;
      // The extension comes from the bytes, never from the declared type: an AVIF
      // named .jpg was saved, listed, and dropped from every judge call in one run.
      const sniffed = sniffImage(data);
      if (!sniffed) {
        const why = describeUnknownImage(data);
        this.#core.options.onLog?.(
          `[core] reference skipped: ${frame.label ?? "board"} is ${why} — the judges cannot read it`,
          "stderr",
        );
        skipped.push(`${frame.label ?? "board"} (${why})`);
        continue;
      }
      const hash = createHash("sha1").update(data).digest("hex").slice(0, 8);
      const file = path.join(dir, `${referenceSlug(frame.label)}-${hash}${sniffed.ext}`);
      const created = !(await pathExists(file));
      await writeFile(file, data);
      saved.push({ file, bytes: data.length, created });
    }
    if (saved.length) this.#core.emit(UiEvent.GameChanged, { project, file: "references" });
    if (skipped.length)
      this.#core.emit(UiEvent.GameChanged, {
        project,
        file: "references",
        warning: `reference stills skipped (unreadable format): ${skipped.join(", ")}`,
      });
    return saved;
  }

  async saveRunArtifact(runId: string, name: string, data: Buffer): Promise<string> {
    // Both names arrive from the sandboxed harness (`run.artifact`, capture labels): a `..` in
    // either once let it write any bytes anywhere the app itself may write.
    const dir = path.resolve(this.#core.layout.runs, runId);
    const file = path.resolve(dir, name);
    const escapes = !RUN_ID.test(runId) || runId.includes("..") || !isBelow(dir, file);
    if (escapes) {
      throw new Error(
        `a run artifact must stay inside its run folder: ${JSON.stringify(`${runId}/${name}`).slice(0, 120)}`,
      );
    }
    // The runs folder is one an agent's box writes: a link or a file on the way, or at the file's
    // own name, is refused, never written through.
    const parts = path.relative(path.resolve(this.#core.layout.runs), path.dirname(file)).split(path.sep);
    const folder = await ensureDirBelow(this.#core.layout.runs, parts);
    // Written by handle once it is known to be the file in that folder: a folder swapped for a link
    // after the check above is refused, never written through.
    await writeFileInDir(folder, path.basename(file), data);
    return file;
  }

  /**
   * JPEG/PNG bytes for the Review filmstrip. The renderer is sandboxed and cannot `file://`
   * these; it names a path from the log, and we only read it if it still lives under `runs/`.
   */
  /**
   * Feedback from the human watching a run's gallery. It lands in the run thread twice: as a
   * user message — which the autopilot's steering inbox already drains into every facet's next
   * brief ("USER STEERING (obey this over everything below)") — and as a `user_feedback` custom
   * event so the gallery can show what was sent and to which frame it referred.
   */
  /** A chat's log as its conversation reads: a build a rewind withdrew is not the chat's to steer. */
  async #conversation(threadId: string): Promise<EventEnvelope[]> {
    const record = await this.#core.store.getRecord(threadId);
    return withoutRewound(await this.#core.store.listEvents(threadId), rewindsOf([], record.metadata));
  }

  async runFeedback(p: {
    threadId: string;
    runId?: string;
    facetId?: string;
    camera?: string;
    iteration?: number;
    text: string;
    /** What the note is about, as the chat names it ("Tall mountain · try 5"). */
    label?: string;
  }): Promise<{ ok: true }> {
    const text = String(p.text ?? "").trim();
    const label = typeof p.label === "string" ? p.label.trim().slice(0, FEEDBACK_LABEL_CHARS) : "";
    if (!text) throw new Error(MESSAGE.feedbackEmpty);
    if (!p.threadId) throw new Error(MESSAGE.feedbackNeedsThread);
    const target = feedbackTarget(p);
    const content = `[USER FEEDBACK${target ? ` on ${target}` : ""}] ${text}`;
    await this.#core.append(
      [
        { type: EventKind.Messages, messages: [{ role: "user", content }] },
        customEventData(CustomEvent.UserFeedback, {
          ...(p.runId ? { runId: p.runId } : {}),
          ...(p.facetId ? { facetId: p.facetId } : {}),
          ...(p.camera ? { camera: p.camera } : {}),
          ...(p.iteration ? { iteration: p.iteration } : {}),
          ...(label ? { label } : {}),
          text,
          at: new Date().toISOString(),
        }),
      ],
      p.threadId,
    );
    const addressedRun = p.runId ?? latestRun(await this.#conversation(p.threadId))?.runId;
    if (addressedRun)
      await this.#core.append(
        [
          customEventData(CustomEvent.RunSteering, {
            runId: addressedRun,
            text: content,
            ...(p.facetId ? { facetId: p.facetId } : {}),
            at: new Date().toISOString(),
          }),
        ],
        p.threadId,
      );
    this.#core.emit(UiEvent.RunFeedback, { threadId: p.threadId, runId: p.runId ?? null });
    return { ok: true };
  }

  /**
   * What the game holds, read-only: the walk of its own asset folders joined with the project's
   * delivery ledger and the Genex plugin's job records, and what is on its way: Genex's waiting
   * jobs and every call making an asset right now. The ledger is passed in because the
   * renderer's bootstrap tail is not the project's whole log — `RunSummaryReader.forProject`
   * reads that, and the join ignores every event belonging to another project.
   */
  async projectAssets(project: string, ledger: readonly EventEnvelope[] = []): Promise<ProjectAssets> {
    const dir = this.#core.games.dirFor(project);
    const autopilot = path.join(this.#core.layout.scratch, "autopilot");
    // Independent reads, side by side: the Assets stage polls this every ten seconds.
    const folders = await this.#readFolders(project);
    const [walk, jobs, scratchRoot, listing, checkpoints] = await Promise.all([
      walkGameAssets(dir, { folders }),
      readGenexJobs(this.#core.layout.engineHomes, project).catch(() => []),
      realpath(autopilot).catch(() => autopilot),
      this.#git(dir, ["worktree", "list", "--porcelain", "-z"]).catch(() => ""),
      this.#core.assetCheckpoints.records(),
    ]);
    const workspaces = assetWorkspaces(listing, this.#core.layout.scratch, scratchRoot);
    const inventory = await reconcileGeneratedAssets(
      this.#core.games.dirFor(project),
      this.#core.layout.engineHomes,
      joinProjectAssets({
        project,
        entries: walk.entries,
        ledger,
        jobs,
        truncated: walk.truncated,
        skipped: walk.skipped,
      }),
      jobs,
      workspaces,
      checkpoints,
    );
    inventory.jobs = [...(inventory.jobs ?? []), ...assetCallJobs(this.#calls, project)];
    return inventory;
  }

  /**
   * Where a game keeps its assets, by the facts its folder holds and the enabled plugins' `assets`.
   * A listing reads them afresh; a preview or thumbnail reuses a read made in the last
   * `ASSET_FOLDERS_FRESH_MS`, so opening the Assets stage is one facts walk, not one per picture.
   */
  assetFolders(project: string): Promise<AssetFolder[]> {
    const kept = this.#folders.get(project);
    if (kept && this.#now() - kept.at < ASSET_FOLDERS_FRESH_MS) return kept.folders;
    return this.#readFolders(project);
  }

  /** One facts read of a game's asset folders, kept for the reads that follow. A folder that cannot be read answers today's folders. */
  #readFolders(project: string): Promise<AssetFolder[]> {
    const folders = this.#core.games.factsOf(project).then(
      (facts) => assetFoldersFor(facts, this.#core.plugins?.workspaceSections() ?? []),
      () => [...DEFAULT_ASSET_FOLDERS],
    );
    this.#folders.set(project, { at: this.#now(), folders });
    return folders;
  }

  /**
   * One image from inside a game, for the Assets stage. A second contained reader, never a
   * widening of {@link StudioCore.readRunStill}: this one is bounded to the game's asset folders,
   * or — for `genex-inspection` — to the one saved frame inside a named job folder.
   */
  async retainedAssetFile(project: string, ref: string): Promise<string> {
    await this.#core.assertProjectAllowed(this.#core.games.dirFor(project));
    const output = genexOutputFile(ref);
    const dir = output && genexJobDir(this.#core.layout.engineHomes, project, output.jobId);
    if (!output || !dir) throw new Error(MESSAGE.invalidRetainedRef);
    if (!(await this.#ownsGenexJob(project, output.jobId))) throw new Error(MESSAGE.notThisGamesAsset);
    const engineHomes = await realpath(this.#core.layout.engineHomes);
    const root = path.join(engineHomes, "genex", "projects", project, "jobs", output.jobId, "output");
    const file = path.join(root, output.file);
    const contained = (await realpath(root)) === root && (await realpath(file)) === file;
    if (!contained || !(await lstat(file)).isFile()) throw new Error(MESSAGE.notContained);
    return file;
  }

  async previewProjectAsset(p: {
    project: string;
    file: string;
    maxBytes?: number;
  }): Promise<{ mimeType: string; data: Uint8Array<ArrayBuffer> }> {
    const malformed = !p || typeof p.project !== "string" || typeof p.file !== "string";
    if (malformed) throw new Error(MESSAGE.assetRequired);
    if (isGenexRef(p.file)) {
      const ref = parseGenexRef(p.file);
      const dir = ref && genexJobDir(this.#core.layout.engineHomes, p.project, ref.jobId);
      if (!ref || !dir || !ref.path.length) throw new Error(MESSAGE.recordedAssetUnavailable);
      if (!(await this.#ownsGenexJob(p.project, ref.jobId))) throw new Error(MESSAGE.recordedAssetUnavailable);
      return readAssetPreview(path.join(dir, "output"), ref.path.join("/"), [], p.maxBytes);
    }
    assertAssetPath(p.file, await this.assetFolders(p.project));
    // The folders were checked above; the reader keeps its own hidden-part, link and file checks.
    return readAssetPreview(this.#core.games.dirFor(p.project), p.file, [], p.maxBytes);
  }

  /** Whether this game's own Genex records hold the job. */
  async #ownsGenexJob(project: string, jobId: string): Promise<boolean> {
    return (await readGenexJobs(this.#core.layout.engineHomes, project)).some((job) => job.id === jobId);
  }

  /** Which of these delivered files the game folder holds now: regular files, never links or escapes. */
  async presentProjectAssets(p: { project: string; files: string[] }): Promise<string[]> {
    const malformed = !p || typeof p.project !== "string" || !Array.isArray(p.files);
    if (malformed) throw new Error(MESSAGE.filesRequired);
    const dir = this.#core.games.dirFor(p.project);
    await this.#core.assertProjectAllowed(dir);
    const root = await realpath(dir);
    const present: string[] = [];
    for (const file of p.files.slice(0, MAX_PRESENCE_FILES)) {
      if (typeof file !== "string" || isGenexRef(file)) continue;
      try {
        assertRelativePath(file);
      } catch {
        continue;
      }
      const target = path.join(root, ...file.split("/"));
      if ((await realpath(target).catch(() => null)) !== target) continue;
      if ((await lstat(target).catch(() => null))?.isFile()) present.push(file);
    }
    return present;
  }

  /** The rigs of these GLB and glTF files in the game folder, read from their headers; other files are skipped. */
  async projectModelRigs(p: { project: string; files: string[] }): Promise<ModelRig[]> {
    const malformed = !p || typeof p.project !== "string" || !Array.isArray(p.files);
    if (malformed) throw new Error(MESSAGE.filesRequired);
    const dir = this.#core.games.dirFor(p.project);
    await this.#core.assertProjectAllowed(dir);
    const root = await realpath(dir);
    const rigs: ModelRig[] = [];
    for (const file of p.files.slice(0, MAX_PRESENCE_FILES)) {
      const rig = await readModelRig(root, file);
      if (rig) rigs.push(rig);
    }
    return rigs;
  }
}

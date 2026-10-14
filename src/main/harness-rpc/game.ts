/** Harness RPC: games and their assets — list, scaffold, read, write, validate, covers, export. */
import { workspaceContentStamp, workspaceContentStamps } from "../../substrate/workspace-content.ts";
import path from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { ensureDir, readRegularFile, realpathNearest, writeFileNoFollow } from "../../substrate/fsx.ts";
import {
  CreationError,
  creationRefusal,
  DestinationError,
  hudContractGeneration,
  isImageFile,
  readOnlyRefusal,
  readProjectShape,
  ScaffoldCaller,
  type ScaffoldOptions,
  shippedHudGeneration,
  shippedStudioGeneration,
  studioContractGeneration,
  type GameProject,
} from "../../substrate/game-workspace.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { starterOfKind } from "../../shared/project-facts.ts";
import {
  type AttachReport,
  BuildTarget,
  type CompiledStack,
  GameStack,
  isCompiledStack,
  ProjectKind,
  stackOf,
} from "../../shared/game-project.ts";
import { TargetRefusal } from "../../shared/game-targets.ts";
import { NativeError, NativeRefusal } from "../../shared/native-contract.ts";
import {
  HostMethod,
  type HarnessHostHandlers,
  type HarnessParams,
  type HarnessResult,
} from "../../shared/harness-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { keptPreRustParts, type SeedDirs, seedNightRefusal } from "../../substrate/seed-upgrade.ts";
import { git } from "../../substrate/snapshots.ts";
import { keptPreRustNotice } from "../seed-upgrade-notice.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { developmentStacksOpen } from "../core/stack-gate.ts";
import { attachReport, noAttachment, str } from "../core/page-report.ts";
import { ExportCaller, exportDestinationOf, exportDirFor, exportSigningFor } from "../core/native-export-run.ts";
import { startHeldInPlan } from "../core/project-tools.ts";
import { isBelow, throughClaudeFolder, throughGitFolder } from "../../substrate/paths.ts";

/** The largest image `game.read` hands back. */
const MAX_IMAGE_READ_MB = 8;
const MAX_IMAGE_READ_BYTES = MAX_IMAGE_READ_MB * 1024 * 1024;
/** The largest `src/hud.js` an upgrade reads to recognise; a shipped copy is a few kilobytes. */
const MAX_HUD_READ_BYTES = 512 * 1024;

/** What the harness reads when a game call is refused. */
const MESSAGE = {
  invalidRunId: "Invalid run id",
  foreignWorkspace: "Integration workspace does not belong to this game",
  exportOutsideExports: (target: string) =>
    `refused: game.export writes only into the studio's exports folder: ${target}`,
  onlyBrowserGames: "Only browser-game scaffolding is supported in this build.",
  /** A compiled game keeps its own contract, named in its stack's terms. */
  contractKept: {
    [GameStack.RaylibCpp]:
      "a C++ · raylib game keeps its own C++ contract (src/studio.h and studio::install); the JavaScript contract upgrade does not apply",
    [GameStack.RustWgpu]:
      "a Rust · wgpu game keeps its own Rust contract (genex::install(game) at the end of main in src/main.rs, written against the read-only docs/GENEX_API.md); the JavaScript contract upgrade does not apply",
  } satisfies Record<CompiledStack, string>,
  stackGated: "Rust games aren't available in this version of Genex yet.",
  /**
   * A new C++ · raylib game asked for: only a harness from before Rust games still asks. Names the
   * kept modules when the workspace has any, each to re-take.
   */
  raylibRetired: (kept: readonly string[]) =>
    `raylib-creation-retired: new C++ · raylib games can't be made any more (existing ones still open, build and export). Scaffold a Rust · wgpu game instead (kind: rust-wgpu). ${
      kept.length > 0
        ? `This harness keeps modules edited before Rust games, which still ask for raylib: ${kept.join(", ")}. Re-take the seed copy of each; the edit is kept as a patch to carry over.`
        : "A harness copy from before Rust games asks for raylib: re-take the seed copy of its game tools and intake."
    }`,
  imageTooLarge: (file: string) => `${file} is larger than ${MAX_IMAGE_READ_MB} MB`,
  imageNotJudgeable: (file: string, what: string) =>
    `${file} is ${what}, which the judges cannot read — re-save it as JPEG or PNG`,
  claudeFolder: (file: string) =>
    `refused: ${file} is in the game's .claude folder, Claude Code's own settings, which only the person changes`,
  gitFolder: (file: string) => `refused: ${file} is in a .git folder, whose configuration and hooks the host controls`,
  studioOutOfReach:
    "src/studio.js or its backup leads out of the game folder or cannot be written; it is kept as it is",
} as const;

/**
 * Harness-owned files that ride along with a contract upgrade: a game scaffolded before one of
 * them existed gets it.
 */
const CONTRACT_COMPANION_FILES = [
  // The material library rides along: a game scaffolded before it gets the file.
  // …and the foliage recipe: both are harness-owned files.
  "materials.js",
  "foliage.js",
  // …and the assets door (AG-930): `src/assets.js` loads what the studio's tools made.
  "assets.js",
  // …and the contract's own typings (M2.3): a TypeScript game whose build is `tsc -b &&
  // vite build` cannot import an untyped ./studio.js, so the declaration travels with it.
  "studio.d.ts",
  // …and the HUD (M4.2a): the upgraded studio.js imports ./hud.js, so a game that gets the
  // new contract without the file it imports loses its overlay on the first HUD call.
  "hud.js",
];

/** A run id an integration workspace is filed under: a plain slug, dots allowed. */
const RUN_ID = /^[a-z0-9][a-z0-9-_.]*$/i;

const readText = (file: string): Promise<string | null> => readFile(file, "utf8").catch(() => null);

/** A run's integration workspace, refused unless git has it registered as a worktree of this game. */
async function integrationWorkspace(core: StudioCore, project: string, runId: string): Promise<string> {
  if (!RUN_ID.test(runId)) throw new Error(MESSAGE.invalidRunId);
  await core.assertProjectAllowed(core.games.dirFor(project));
  const workspace = await realpath(path.join(core.layout.scratch, "autopilot", runId, "integration"));
  // Git's registration ties this host-derived worktree to the authorized game.
  const listing = await git(core.games.dirFor(project), ["worktree", "list", "--porcelain"]);
  if (!listing.split("\n").includes(`worktree ${workspace}`)) throw new Error(MESSAGE.foreignWorkspace);
  return workspace;
}

/**
 * Project settings and Git control files can execute hooks or filters in another host session.
 * The harness never writes either folder, by any spelling (case, `..`, links): check the named
 * path and its actual destination before creating directories or writing bytes.
 */
async function refuseProjectControlFolder(root: string, target: string, file: string): Promise<void> {
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  const named = path.relative(path.resolve(root), path.resolve(target));
  const landing = path.relative(realRoot, await realpathNearest(target));
  if (throughClaudeFolder(named) || throughClaudeFolder(landing)) throw new Error(MESSAGE.claudeFolder(file));
  if (throughGitFolder(named) || throughGitFolder(landing)) throw new Error(MESSAGE.gitFolder(file));
}

/** TQ-1: the harness may name where inside the studio's exports folder, never elsewhere. */
async function assertExportTarget(core: StudioCore, target: string): Promise<void> {
  const real = await realpathNearest(target);
  const exportsRoot = await realpathNearest(core.layout.exports);
  if (!isBelow(exportsRoot, real)) throw new Error(MESSAGE.exportOutsideExports(target));
}

/**
 * `game.export`: the destination and signing are checked before anything runs (a build target;
 * none or ad hoc, never an identity: `harness-may-not-sign`), then the folder (TQ-1). A three.js
 * game's browser folder is exported as it always was; a compiled game (C++, Rust), or any named
 * desktop destination, through `exportPublicCopy`, which builds through its lane first or refuses
 * `build-failed`: a compiled game's folder is never exported as it stands.
 */
async function harnessExport(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.GameExport>,
): Promise<HarnessResult<typeof HostMethod.GameExport>> {
  const destination = exportDestinationOf(p.destination);
  const signing = exportSigningFor(destination, p.signing, ExportCaller.Harness);
  await x.assertHarnessRoot(p.project, null);
  if (p.target !== undefined && p.target !== null) await assertExportTarget(core, String(p.target));
  const target = p.target ?? exportDirFor(core.layout.exports, p.project, destination);
  const compiled = isCompiledStack(stackOf(await readProjectShape(core.games.dirFor(p.project))));
  if (compiled || destination !== BuildTarget.Web) {
    return core.exportPublicCopy(p.project, target, { destination, signing });
  }
  return core.games.export(p.project, target, undefined, { secretValues: core.knownSecretValues() });
}

export function gameRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.AssetsInventory]: async (p) => {
      await core.assertProjectAllowed(core.games.dirFor(p.project));
      return core.projectAssets(p.project);
    },
    [HostMethod.AssetsCheckpoint]: async (p) => {
      const workspace = await integrationWorkspace(core, p.project, p.runId);
      return core.assetCheckpoints.checkpoint(p.project, workspace, p.assetIds);
    },
    // — games —
    [HostMethod.GameList]: async () => core.games.list(),
    [HostMethod.GameSetCover]: async (p) => x.setGameCover(p.project, p, p.threadId),
    // Harnesses installed before recipes still author custom GLSL covers through this.
    [HostMethod.GameSetCoverShader]: async (p) => x.setGameCoverShader(p.project, p.surface, p.threadId),
    // `split` answers both stamps from one walk; a caller that does not ask gets the old string.
    [HostMethod.GameContentStamp]: async (p) =>
      p.split
        ? workspaceContentStamps(core.games.dirFor(p.project))
        : workspaceContentStamp(core.games.dirFor(p.project)),
    [HostMethod.GameRecents]: async () => core.games.recents(),
    [HostMethod.GameScaffold]: async (p) => scaffold(core, x, p),
    // The starter a game with no kind yet takes on (a local model's `start_web_game`, a Loop's launch).
    // A local model's names its chat: while that chat is in Plan nothing is written, as for the chat's
    // own `start_web_game`. `readyProject` tells the app its game changed.
    [HostMethod.GameStart]: async (p) =>
      (await startHeldInPlan(core, x, p.project, p.threadId)) ??
      x.readyProject(await core.games.start(p.project, p.starter)),
    // No `game.adopt` here (ARCH-1): adopting a folder widens the sandbox, so it is the user's
    // Open Game sheet's to do (`adoptProject`), never the agent-editable harness's.
    [HostMethod.GameValidate]: async (p) =>
      p.candidateId
        ? core.games.validateAt((await core.candidates.get(p.candidateId, p.project)).root)
        : core.games.validate(p.project),
    // The live half of the same question. `game.validate` reads the folder; this serves the
    // page, waits for it to boot and asks what the hook got hold of — so a run stops asking
    // for the two lines from a game the studio already attached to on its own. A HOST call,
    // made by the run for the director: no MCP tool and no bridge entry, so both engines see
    // exactly the tools they saw before.
    [HostMethod.GameAttached]: async (p) => attached(core, x, p),
    // v2 contract upgrade: a game whose studio.js predates
    // `inspect()` gets the shipped template's copy; the old file is kept beside it.
    [HostMethod.GameUpgradeContract]: async (p) => upgradeContract(core, p.project),
    [HostMethod.GameRead]: async (p) => {
      const target = p.candidateId
        ? await core.candidates.file(p.candidateId, p.project, p.file)
        : await x.delegation.gameFile(p.project, p.file, "read");
      if (isImageFile(target)) return readImage(target, p.file);
      return readFile(target, "utf8");
    },
    [HostMethod.GameWrite]: async (p) => {
      const target = p.candidateId
        ? await core.candidates.file(p.candidateId, p.project, p.file, true)
        : await x.delegation.gameFile(p.project, p.file, "write");
      const root = p.candidateId
        ? (await core.candidates.get(p.candidateId, p.project)).root
        : core.games.dirFor(p.project);
      await refuseProjectControlFolder(root, target, p.file);
      await ensureDir(path.dirname(target));
      await writeFileNoFollow(target, p.contents);
      if (!p.candidateId) core.emit(UiEvent.GameChanged, { project: p.project, file: p.file });
      return { bytes: p.contents.length };
    },
    [HostMethod.GameTree]: async (p) =>
      p.candidateId ? core.candidates.tree(p.candidateId, p.project) : x.delegation.gameTree(p.project),
    [HostMethod.GameExport]: async (p) => harnessExport(core, x, p),
    // The stills in <project>/references/, sniffed and resized, for a run whose board is
    // empty (a resume, or a board attached in an earlier chat).
    [HostMethod.GameReferences]: async (p) => core.referenceStills(p.project, { max: p?.max, maxPx: p?.maxPx }),
  } satisfies Partial<HarnessHostHandlers>;
}

/**
 * What `game.scaffold` asks the library for, as the harness ({@link ScaffoldCaller.Harness}). A
 * C++ · raylib request, by kind or by destinations naming a desktop and no kind (how a pre-Rust
 * harness asked for one), is passed on as raylib: the library returns an existing raylib game of
 * that name and refuses a new one `raylib-creation-retired`. The Rust · wgpu template for its kind
 * only where the development gate is open (`stack-gated` before the library is asked elsewhere);
 * the Three.js template for the studio template's kind, so an existing game of another stack is
 * refused (`stack-is-fixed`); the web starter's kind (`web`, or an older caller's
 * `studio-template`) or destinations alone ask for the Three.js template. With no kind and no
 * destinations, null: a game with no kind yet (`makeEmpty`). Any other kind is refused in the
 * words it always was.
 */
function scaffoldOptions(
  p: HarnessParams<typeof HostMethod.GameScaffold>,
  gateOpen: boolean,
): Partial<ScaffoldOptions> | null {
  const title = p.title ? { title: p.title } : {};
  const targets = p.targets ? { targets: p.targets } : {};
  const caller = { caller: ScaffoldCaller.Harness };
  const asksRaylib = p.kind === ProjectKind.RaylibCpp || (!p.kind && creationRefusal({ targets: p.targets }) !== null);
  if (asksRaylib) return { ...title, stack: GameStack.RaylibCpp, ...targets, ...caller };
  if (p.kind === ProjectKind.RustWgpu) {
    if (!gateOpen) throw new DestinationError(TargetRefusal.StackGated, MESSAGE.stackGated);
    return { ...title, stack: GameStack.RustWgpu, ...targets, ...caller };
  }
  const starter = starterOfKind(p.kind);
  if (starter === undefined) throw new Error(MESSAGE.onlyBrowserGames);
  // Destinations named for a browser game are checked by the library: a desktop one is refused.
  if (starter || p.targets) return { ...title, stack: GameStack.ThreeJs, ...targets, ...caller };
  // No kind makes a game with no kind yet; the web starter only when the caller names it.
  return null;
}

/**
 * `game.scaffold` refused for the harness workspace (`harness-predates-native`): typed by `code`,
 * as the scaffold's other refusals are (`stack-gated`, `raylib-creation-retired`), and by
 * `refusal`, as the lease it stands in for would have been.
 */
class ScaffoldPredatesRust extends NativeError {
  readonly code: NativeRefusal;

  constructor(message: string) {
    super(NativeRefusal.HarnessPredatesNative, message);
    this.code = this.refusal;
  }
}

/** Where the harness is read: the seed the app ships, and the agent's workspace copy of it. */
function seedDirs(core: StudioCore): SeedDirs {
  return { seedDir: path.join(core.options.paths.resources, "harness-seed"), workspaceDir: core.layout.harnessWs };
}

/**
 * The library's scaffold as the harness asks it. A new Rust · wgpu folder is never made for a
 * harness workspace that kept a part a Rust night runs from before Rust games: its lease would be
 * refused, so the scaffold is refused first (`harness-predates-native`, naming each kept module
 * and its re-take), before any folder exists. A retired raylib request is answered in the
 * harness's terms: the kind to ask for instead, and the kept modules to re-take.
 */
async function scaffoldAsHarness(core: StudioCore, p: HarnessParams<typeof HostMethod.GameScaffold>) {
  const options = scaffoldOptions(p, developmentStacksOpen(core.options));
  if (options === null) return core.games.makeEmpty(p.name, p.title ? { title: p.title } : {});
  if (options.stack === GameStack.RustWgpu) {
    const notice = keptPreRustNotice(await seedNightRefusal(GameStack.RustWgpu, seedDirs(core)));
    if (notice) throw new ScaffoldPredatesRust(notice.text);
  }
  try {
    return await core.games.scaffold(p.name, options);
  } catch (error) {
    if (!(error instanceof CreationError)) throw error;
    const kept = await keptPreRustParts(seedDirs(core)).catch(() => []);
    throw new CreationError(error.code, MESSAGE.raylibRetired(kept));
  }
}

async function scaffold(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.GameScaffold>,
): Promise<HarnessResult<typeof HostMethod.GameScaffold>> {
  const project = await x.readyProject(await scaffoldAsHarness(core, p));
  // A brief sent from an unbound "new game" thread names that thread the moment the
  // folder exists — the chat and the project become one thing.
  if (p.threadId && p.threadId !== core.mainThread) {
    const record = await core.store.getRecord(p.threadId).catch(() => null);
    const meta = record?.metadata as { kind?: string; project?: string | null } | undefined;
    if (meta?.kind === ThreadKind.Game && !meta.project) await core.bindThreadToProject(p.threadId, project.name);
  }
  return project;
}

/** `game.attached`: serve the page in a window of its own and ask what the hook got hold of. */
async function attached(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.GameAttached>,
): Promise<AttachReport> {
  const checked = await x.assertHarnessRoot(p.project, p.candidateId ? null : p.root);
  const root = p.candidateId ? (await core.candidates.get(p.candidateId, p.project)).root : checked;
  const session = x.previews.sessionPortFor({ label: `attach:${p.project}` });
  try {
    const port = await session.get();
    const loaded = await x.previews.loadServed(port, p.project, root, p.entry);
    const status = port.status();
    if (loaded.problem) return noAttachment(loaded.problem, status.loadError, status.consoleErrors);
    const answered = await (port.attachReport?.().catch(() => null) ?? Promise.resolve(null));
    const reported = answered && typeof answered === "object" ? (answered as unknown as Record<string, unknown>) : null;
    if (!reported) {
      return noAttachment(
        loaded.note ?? "this page reports nothing about the studio contract",
        status.loadError,
        status.consoleErrors,
      );
    }
    // The port's report is the page's own account of itself: read field by field, so a
    // page that answers a shape nobody expected cannot become this call's answer.
    const base = noAttachment(str(reported.reason) ?? loaded.note ?? null, status.loadError, status.consoleErrors);
    return attachReport(reported, base);
  } finally {
    await session.release();
  }
}

/** An image in the game, as the judges read it: the bytes decide the type. */
async function readImage(target: string, file: string) {
  const data = await readFile(target);
  if (data.length > MAX_IMAGE_READ_BYTES) throw new Error(MESSAGE.imageTooLarge(file));
  // The bytes decide the type, never the extension: an AVIF named .jpg is refused.
  const sniffed = sniffImage(data);
  if (!sniffed) throw new Error(MESSAGE.imageNotJudgeable(file, describeUnknownImage(data)));
  return {
    kind: "image" as const,
    mimeType: sniffed.mimeType,
    data: data.toString("base64"),
    bytes: data.length,
    file,
  };
}

async function upgradeContract(core: StudioCore, project: string): Promise<HarnessResult<"game.upgradeContract">> {
  const dir = core.games.dirFor(project);
  const shape = await readProjectShape(dir);
  // Before any write: a newer Genex's game is read-only, and the JavaScript contract, its
  // companions and its page have no place in a compiled game.
  const readOnly = readOnlyRefusal(shape);
  if (readOnly) throw readOnly;
  const stack = stackOf(shape);
  if (isCompiledStack(stack)) return { upgraded: false, reason: MESSAGE.contractKept[stack] };
  const own = await isOwnShape(core, project);
  const materialsAdded = await addCompanionFiles(core, dir);
  await addContractPage(own, dir, core.games.templateDir);
  const template = await readText(path.join(core.games.templateDir, "src", "studio.js"));
  const studio = template === null ? null : await upgradeShippedStudio(core, project, dir, template);
  // The HUD moves only beside a contract that is now current: a newer hud.js under a kept older
  // facade would be asked to draw what that facade cannot forward.
  const hudMoves = !own && studio?.kept !== true;
  const hudUpgrade = hudMoves ? await upgradeShippedHud(core, project, dir) : await heldHud(core, own, dir);
  const hud = hudUpgrade ? { hud: hudUpgrade } : {};
  if (studio === null) return { upgraded: false, reason: "no template studio.js", ...hud };
  return { ...studio.answer, ...(studio.answer.upgraded ? {} : { materialsAdded }), ...hud };
}

/** What became of a game's `src/studio.js`, and whether an older copy was kept as it is. */
interface StudioUpgrade {
  answer: HarnessResult<"game.upgradeContract">;
  kept: boolean;
}

/**
 * The template's contract for a game whose `src/studio.js` is older than it and byte for byte a copy
 * the studio shipped (or missing); the old copy is kept beside it as `src/studio.v<generation>.js`.
 * A copy anyone edited stays, answered as `edited` at its generation: the template asks the main
 * owner to extend this file, and the game may import what they added. Nothing is written through a
 * link that leads out of the game.
 */
async function upgradeShippedStudio(
  core: StudioCore,
  project: string,
  dir: string,
  template: string,
): Promise<StudioUpgrade> {
  const target = path.join(dir, "src", "studio.js");
  if (!(await landsInside(dir, target))) return keptStudio({ upgraded: false, reason: MESSAGE.studioOutOfReach });
  const current = await readText(target);
  // Which vintage the game holds, against which the shipped template is compared below.
  // Feature-sniffing decided this before and could not see past the file it was written
  // for: `inspect()` and `hud: hud.api` are in every copy since the one-screen contract,
  // so every game scaffolded before M4 answered "current" and kept its old contract while
  // the director and autopilot called this believing it brought the game up to date.
  const generation = studioContractGeneration(current);
  // Only a copy older than the shipped one is replaced, so a game that already holds the
  // current contract is left alone and a template that ever moves backwards writes nothing.
  if (generation >= studioContractGeneration(template)) return { answer: { upgraded: false }, kept: false };
  if (current !== null && shippedStudioGeneration(current) === null) {
    return keptStudio({ upgraded: false, edited: true, generation });
  }
  const backup = current === null ? null : `src/studio.v${generation}.js`;
  if (backup !== null && !(await landsInside(dir, path.join(dir, backup)))) {
    return keptStudio({ upgraded: false, reason: MESSAGE.studioOutOfReach });
  }
  try {
    await ensureDir(path.dirname(target));
    // The backup first: when it cannot be written, the game's contract is not touched either.
    if (backup !== null && current !== null) await writeFileNoFollow(path.join(dir, backup), current);
    await writeFileNoFollow(target, template);
  } catch {
    return keptStudio({ upgraded: false, reason: MESSAGE.studioOutOfReach });
  }
  core.emit(UiEvent.GameChanged, { project, file: "src/studio.js" });
  return { answer: { upgraded: true, backup }, kept: false };
}

/** An older contract the upgrade left where it is. */
function keptStudio(answer: HarnessResult<"game.upgradeContract">): StudioUpgrade {
  return { answer, kept: true };
}

/**
 * The HUD beside a contract the upgrade kept: reported at its generation when older than the
 * template's, never written. Null for a game the user brought, or a HUD that is current or absent.
 */
async function heldHud(core: StudioCore, own: boolean, dir: string): Promise<HudUpgrade | null> {
  if (own) return null;
  const target = path.join(dir, "src", "hud.js");
  if (!(await landsInside(dir, target))) return null;
  const current = await readHud(target);
  const template = await readText(path.join(core.games.templateDir, "src", "hud.js"));
  if (current === null || template === null) return null;
  const held = hudContractGeneration(current);
  return held >= hudContractGeneration(template) ? null : { generation: held, replaced: false };
}

/** A game's `src/hud.js`, read as a regular file of bounded size; null when there is none to read. */
const readHud = (target: string): Promise<string | null> =>
  readRegularFile(target, MAX_HUD_READ_BYTES)
    .then((bytes) => bytes.toString("utf8"))
    .catch(() => null);

/** Copy each companion file the game lacks from the template; true when any was added. */
async function addCompanionFiles(core: StudioCore, dir: string): Promise<boolean> {
  let added = false;
  for (const file of CONTRACT_COMPANION_FILES) {
    const target = path.join(dir, "src", file);
    if (await readText(target)) continue;
    const source = await readText(path.join(core.games.templateDir, "src", file));
    if (source === null) continue;
    await ensureDir(path.dirname(target));
    await writeFile(target, source);
    added = true;
  }
  return added;
}

/** Whether the game is one the user brought (its own shape), whose files the studio keeps as they are. */
async function isOwnShape(core: StudioCore, project: string): Promise<boolean> {
  const games = await core.games.list().catch(() => [] as GameProject[]);
  return games.find((g) => g.name === project)?.built === true;
}

/**
 * The contract page describes the studio's own empty project — "no build step, no package
 * manager, no network". A game the user brought is none of those things, and adoption
 * deliberately keeps that page out of their folder; a run must not put it back.
 */
async function addContractPage(own: boolean, dir: string, templateDir: string): Promise<void> {
  const docsTarget = path.join(dir, "docs", "CONTRACT.md");
  if (own || (await readText(docsTarget))) return;
  const contract = await readText(path.join(templateDir, "docs", "CONTRACT.md"));
  if (contract === null) return;
  await ensureDir(path.dirname(docsTarget));
  await writeFile(docsTarget, contract);
}

/** A file inside the game folder, by where it really lands: no link on the way leads out of it. */
async function landsInside(dir: string, file: string): Promise<boolean> {
  const root = await realpath(dir).catch(() => null);
  const landing = await realpathNearest(file).catch(() => null);
  return root !== null && landing !== null && isBelow(root, landing);
}

/** What `game.upgradeContract` says about a game whose HUD was older than the template's. */
type HudUpgrade = NonNullable<HarnessResult<"game.upgradeContract">["hud"]>;

/**
 * The template's HUD for a game whose `src/hud.js` is an older copy the studio shipped, byte for
 * byte; the old copy is kept beside it as `src/hud.v<generation>.js`. A copy anyone edited is the
 * main owner's work and stays, as does everything reached through a link. Answers what happened
 * to a HUD older than the template's (replaced, or left at its generation), and null for a HUD
 * that is current, absent or out of reach.
 */
async function upgradeShippedHud(core: StudioCore, project: string, dir: string): Promise<HudUpgrade | null> {
  const target = path.join(dir, "src", "hud.js");
  if (!(await landsInside(dir, target))) return null;
  const current = await readHud(target);
  const template = await readText(path.join(core.games.templateDir, "src", "hud.js"));
  if (current === null || template === null) return null;
  const latest = hudContractGeneration(template);
  const held = hudContractGeneration(current);
  if (held >= latest) return null;
  const leftAlone = { generation: held, replaced: false };
  const shipped = shippedHudGeneration(current);
  if (shipped === null) return leftAlone;
  const backupName = `src/hud.v${shipped}.js`;
  const backup = path.join(dir, backupName);
  if (!(await landsInside(dir, backup))) return leftAlone;
  try {
    // The backup first: when it cannot be written, the game's HUD is not touched either.
    await writeFileNoFollow(backup, current);
    await writeFileNoFollow(target, template);
  } catch {
    return leftAlone;
  }
  core.emit(UiEvent.GameChanged, { project, file: "src/hud.js" });
  return { generation: latest, replaced: true, backup: backupName };
}

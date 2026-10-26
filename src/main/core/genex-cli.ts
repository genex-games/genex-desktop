/**
 * The host side of the bundled Genex plugin's `host` tools: `genex__cli` and `genex__cli-paid` run
 * Studio's own pinned Genex CLI through the process sandbox.
 *
 * A run never happens in the game folder. There the CLI rewrites `.claude/skills`, `AGENTS.md`
 * and the contracts of every ancestor folder whenever the folder looks like a Genex workspace,
 * which an agent can arrange at any moment and which an unsandboxed profile would not stop. So
 * each call gets a fresh folder under `<userData>/genex-cli`, outside every agent's writable roots,
 * with HOME at that folder (the CLI's contract healing stops at HOME), and the folder is removed
 * afterwards. A project command sees only the hosted project's id and slug, mirrored from the
 * publish workspace. The token reaches the CLI on stdin through Studio's preload, never argv,
 * environment or disk; the sandbox opens the Genex API alone for the length of the run, and Genex's
 * object storage beside it only for a call that moves a store item's files. A store
 * item's picture, model and package are files of the bound game: Studio checks each by real path
 * inside it and copies it into the run folder first; `items add` writes `genex-items/<id>/` in the
 * run folder, and Studio moves it into the game afterwards (`genex-game-paths.ts`). The game's local
 * item drafts (`.genex/items/`, made before the game is on Genex) are copied in for the shop's
 * commands, and a change carried back (`local-item-files.ts`); a `shop add|set|remove` in a game with
 * no hosted project runs on them alone. Studio itself uploads them after a publish
 * (`syncLocalItems`) and runs the person's "Other games can use it" on one (`setLocalShared`).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { genexCliEnv, parseGenexJson, stripAnsi } from "../../plugins/genex/cli.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { GenexHostedStatus } from "../../shared/genex.ts";
import { PLAY_ORIGIN } from "../../shared/play.ts";
import { type PluginBinding, PluginHostTool } from "../../shared/plugins.ts";
import { type RunRequest, type RunResult, shellQuote } from "../../substrate/spawn.ts";
import type { PluginHostAccount } from "../../substrate/plugins/registry.ts";
import { assertNativeActionAllowed, type NativeStep } from "../dev/native-policy.ts";
import type { DevStand } from "../play/origins.ts";
import {
  type GenexCliRequest,
  genexCliConsentArgs,
  genexCliRequest,
  LocalItemsUse,
  localShareRequest,
  localSyncRequest,
} from "./genex-cli-policy.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";
import { deliverSharedItem, ItemNotDelivered, resolveGamePath, stageGamePaths } from "./genex-game-paths.ts";
import { type GenexPackageService, genexPackageConsentArgs } from "./genex-package.ts";
import { draftInCliAnswer, itemSyncOf, type SyncedItem } from "./item-draft.ts";
import { isLocalDraft, type ListingRecord, type LocalListingDraft } from "../../shared/item-draft.ts";
import {
  carryLocalDrafts,
  type DraftPrints,
  hasLocalDrafts,
  LocalDraftsNotCarried,
  removeSyncedDrafts,
  stageLocalDrafts,
} from "./local-item-files.ts";

/** How long one CLI command may run before it is stopped. */
export const GENEX_CLI_TIMEOUT_MS = 90 * SECOND_MS;
/** The most of a command's output an agent reads back. */
const OUTPUT_MAX_CHARS = 64 * 1024;
const TRUNCATED_NOTE = "\n[output truncated]";
const REDACTED = "[redacted]";
/** Genex's production API, the one origin a run may reach. */
const GENEX_API = "https://api.genex.games";
/**
 * Genex's object storage (Cloudflare R2): the API hands out signed links there for a store item's
 * picture, model and package, so a run that moves those bytes reaches it too.
 */
const ITEM_STORAGE_DOMAIN = "*.r2.cloudflarestorage.com";
/** The virtual env path Studio's preload serves the sign-in record beside (`src/genex-host/preload.mjs`). */
const CREDENTIALS_ENV_FILE = "/__studio_genex_credentials__";
/** The sandbox pipes stdio 0-2 only, so the preload reads the credential from stdin. */
const CREDENTIAL_FD = "0";
/** Where the plugin build puts the preload and the pinned CLI inside the app's resources. */
const PRELOAD_IN_RESOURCES = "plugins/genex/preload.mjs";
const CLI_IN_RESOURCES = "plugins/genex/node_modules/@genex-ai/cli-demo/dist/index.js";
/** A game name as the Genex adapter names its publish workspace. */
const PROJECT_NAME = /^[a-zA-Z0-9_-]+$/;
const RUN_ID_CHARS = 12;
/** A token the credential line can carry whole: no whitespace and no control character. */
const LINE_TOKEN = /^[^\s\u0000-\u001f\u007f]+$/;

/** The one plugin whose manifest may declare host tools. */
export const GENEX_PLUGIN_ID = "genex";

const MESSAGE = {
  InvalidProject: "This call is not bound to a game project Studio knows.",
} as const;

/** What a run needs from Studio. Every path is Studio's own; none comes from the agent. */
export interface GenexCliDeps {
  /** The process sandbox's `run`. */
  run: (request: RunRequest) => Promise<RunResult>;
  /** `GENEX_TOKEN=…\n` for the unlocked Genex account, or undefined while it is locked. */
  credentialFile: () => Promise<string | undefined>;
  /** Every credential Studio holds, taken out of whatever the CLI prints. */
  heldCredentials: () => string[];
  /** `<userData>/genex-cli`: the run folders' parent, outside every agent's writable roots. */
  runsRoot: string;
  /** The app's resources, where the plugin build put the preload and the pinned CLI. */
  resources: string;
  /** The Genex plugin's storage, whose `publish/<project>/.genex/project.json` names the hosted project. */
  genexStorage: string;
  /** Folders a run may never write, on top of the sandbox's own denies: the games root and every game. */
  protectedWrites: () => string[] | Promise<string[]>;
  /**
   * The bound game's real folder (`genex-bound-game.ts`), for a call that reads the game's files or
   * writes a shared item into it; without it, such a call is refused.
   */
  boundGame?: (binding: PluginBinding) => Promise<string>;
  /** The clock an earlier copy of a shared item is stamped with when it moves aside. */
  now?: () => number;
  /** The Genex API origin; tests point it at a fixture. */
  api?: string;
  /** The Node that runs the CLI: Electron as node in the app. */
  execPath?: string;
  parentEnv?: NodeJS.ProcessEnv;
  /**
   * The game's real folder by its name, for a run Studio makes itself (a sync after a publish, the
   * person's "Other games can use it" on a local draft); never a folder an agent named.
   */
  gameFolder?: (project: string) => Promise<string>;
  /**
   * A store item the game's agent made or changed (`genex shop add|set --json`), read from the
   * CLI's own answer (`item-draft.ts`): the chat draws its Listing draft card. A local draft comes
   * with Studio's fingerprint of what the game now holds for it. Its failure never fails the call.
   */
  onListingDraft?: (draft: ListingRecord, binding: PluginBinding, fingerprint?: string | null) => Promise<void>;
  /** Local drafts an agent's `shop remove` took out of the game. Its failure never fails the call. */
  onLocalDraftsRemoved?: (project: string, localIds: readonly string[]) => Promise<void>;
}

/**
 * A local draft the person changed through main, with Studio's fingerprints of what the game now
 * holds for it and of what it held when the run took it (the bytes the CLI changed).
 */
export interface LocalDraftChange {
  draft: LocalListingDraft;
  fingerprint: string | null;
  staged: string | null;
}

/** A run's folder and the game's local drafts copied into it, for what follows the CLI's answer. */
interface RunFolder {
  work: string;
  staged: DraftPrints;
}

/** The hosted project a run sees: its id and slug, nothing else. */
interface HostedProject {
  id: string;
  slug: string;
}

/** What an agent reads back: the command, whether it succeeded, and its (parsed) output. */
export interface GenexCliAnswer {
  command: string;
  ok: boolean;
  exitCode?: number | null;
  output: unknown;
}

/**
 * A development profile's stand (`main/play/origins.ts`): the API its CLI runs reach, the token of
 * the account the profile signed in to there, and the stand's own CA file when it has one.
 */
export interface GenexStand {
  api: string;
  token(): Promise<string | undefined>;
  /**
   * The CA a local stand signs its hosts with (`GENEX_DEV_PLAY_GAMES_CA`, an absolute path): the
   * Genex plugin's publish trusts it beside the system's, to push to the stand's source host and
   * check its game host.
   */
  ca?: string;
  /** The stand's game host (`GENEX_DEV_PLAY_GAMES_ORIGIN`), where the plugin's publish tests its draft. */
  games?: string;
}

/**
 * This launch's stand for the Genex host tools and the Genex plugin: the stand API a development
 * launch names (`main/play/origins.ts` `devStand`, null in every other launch) with the account the
 * profile signed in to there, its CA and its game host when it names them; undefined keeps
 * genex.games and the Genex plugin's own account.
 */
export function launchStand(
  named: Pick<DevStand, "hostToolsApi" | "gamesCaFile" | "origins">,
  token: () => Promise<string | undefined>,
): GenexStand | undefined {
  const api = named.hostToolsApi;
  if (!api) return undefined;
  const games = named.origins.games === PLAY_ORIGIN.games ? null : named.origins.games;
  return {
    api,
    token,
    ...(named.gamesCaFile ? { ca: named.gamesCaFile } : {}),
    ...(games ? { games } : {}),
  };
}

/**
 * The Genex plugin on a stand (`PluginRegistry.hostAccount`): its backend, and so its publish, talks
 * to the stand's API as the stand's account, exactly as `genex__cli` does, trusting the stand's CA;
 * undefined without a stand.
 */
export function genexPluginAccount(stand: GenexStand | undefined): PluginHostAccount | undefined {
  if (!stand) return undefined;
  return {
    id: GENEX_PLUGIN_ID,
    api: stand.api,
    token: stand.token,
    ...(stand.ca ? { ca: stand.ca } : {}),
    ...(stand.games ? { games: stand.games } : {}),
  };
}

/**
 * The credential a run on `stand` hands the CLI (`GENEX_TOKEN=…`), from the stand's own account;
 * undefined (locked) while the profile is not signed in there, or for a token that is not one line.
 */
export function standCredentialFile(stand: GenexStand): () => Promise<string | undefined> {
  return async () => {
    const token = await stand.token().catch(() => undefined);
    return token && LINE_TOKEN.test(token) ? `GENEX_TOKEN=${token}\n` : undefined;
  };
}

/** Whether a call moves a store item's files: it uploads a picture, model or package, adds a shared item, or syncs. */
const movesItemFiles = (request: GenexCliRequest): boolean =>
  (request.gamePaths?.length ?? 0) > 0 || request.delivers !== undefined || request.localItems === LocalItemsUse.Sync;

/** An object, not a list or null. */
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A publish record's hosted project: its id and slug when both are text, else null. */
function hostedProjectOf(record: Record<string, unknown> | null): HostedProject | null {
  const id = record?.id;
  const slug = record?.slug;
  if (typeof id !== "string" || !id || typeof slug !== "string" || !slug) return null;
  return { id, slug };
}

/** Runs one allowed Genex CLI command at a time per call, each in a folder of its own. */
export class GenexCliService {
  readonly #deps: GenexCliDeps;
  readonly #api: string;
  constructor(deps: GenexCliDeps) {
    this.#deps = deps;
    this.#api = deps.api ?? GENEX_API;
  }

  /** Validate, prepare a run folder, run the command in the sandbox, answer, and remove the folder. */
  async run(
    args: Record<string, unknown>,
    binding: PluginBinding,
    options: { paid: boolean; signal?: AbortSignal },
  ): Promise<GenexCliAnswer> {
    const request = genexCliRequest(args, { paid: options.paid });
    const game = await this.#checkedGame(request, binding);
    const project = request.project ? await this.#projectFor(request, binding.project, game) : null;
    return this.#execute(request, { game, project }, options.signal, async (answer, run) => {
      const delivered = await this.#deliver(answer, request, run.work, game);
      const { carried, written } = await this.#carry(delivered, request, run, game, binding.project);
      await this.#announceDraft(carried, binding, project, new Map([...run.staged, ...written]));
      return carried;
    });
  }

  /**
   * Studio's own upload of the game's local drafts once it is on Genex (`genex shop sync --json`):
   * each draft's result, with the uploaded ones taken out of the game; null when the game is not on
   * Genex, holds no drafts, or the CLI answered nothing that reads. Never puts anything on sale.
   */
  async syncLocalItems(project: string, signal?: AbortSignal): Promise<SyncedItem[] | null> {
    const game = await this.#gameFolder(project);
    const hosted = await this.#hostedProjectOrNull(project);
    if (!hosted || !(await hasLocalDrafts(game))) return null;
    return this.#execute(localSyncRequest(), { game, project: hosted }, signal, async (answer, run) => {
      const items = itemSyncOf(answer.output);
      if (!items) return null;
      const uploaded = items.flatMap((item) => (item.skuId ? [item.localId] : []));
      await removeSyncedDrafts(game, uploaded, run.staged);
      return items;
    });
  }

  /**
   * The person's "Other games can use it" on a local draft: main's own `genex shop set <localId>
   * --shared|--no-shared`, carried back into the game; the draft after it, or null when the CLI
   * changed nothing it could show.
   */
  async setLocalShared(project: string, localId: string, shared: boolean): Promise<LocalDraftChange | null> {
    const request = localShareRequest(localId, shared);
    const game = await this.#gameFolder(project);
    const hosted = await this.#hostedProjectOrNull(project);
    return this.#execute(request, { game, project: hosted }, undefined, async (answer, run) => {
      if (!answer.ok) return null;
      const { written } = await carryLocalDrafts(run.work, game, run.staged);
      const draft = draftInCliAnswer(answer, project, null);
      if (!draft || !isLocalDraft(draft) || draft.localId !== localId) return null;
      const staged = run.staged.get(localId) ?? null;
      return { draft, fingerprint: written.get(localId) ?? staged, staged };
    });
  }

  /**
   * One run in a folder of its own: the credential, the folder (with the hosted project and the game's
   * local drafts when the request uses them), the game's files it names, the sandboxed CLI, then
   * `finish` with the answer while the folder is still there; the folder is removed after.
   */
  async #execute<T>(
    request: GenexCliRequest,
    target: { game: string | null; project: HostedProject | null },
    signal: AbortSignal | undefined,
    finish: (answer: GenexCliAnswer, run: RunFolder) => Promise<T>,
  ): Promise<T> {
    const { game, project } = target;
    const credential = await this.#deps.credentialFile();
    if (!credential) throw new Error(GENEX_CLI_PROMPT.Locked);
    const root = path.join(this.#deps.runsRoot, randomUUID().replaceAll("-", "").slice(0, RUN_ID_CHARS));
    try {
      const work = await this.#prepare(root, project);
      const staged = game && request.localItems ? await stageLocalDrafts(game, work) : new Map<string, string>();
      const argv =
        game && request.gamePaths ? await stageGamePaths(game, request.gamePaths, request.argv, work) : request.argv;
      const denyWrite = await this.#deps.protectedWrites();
      const result = await this.#deps.run(
        this.#runRequest({ ...request, argv }, { root, work, denyWrite }, credential, signal),
      );
      return await finish(this.#answer(request, result, credential, signal), { work, staged });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /**
   * What the consent card shows for a paid call, once the files it names are in the game: a call
   * Studio would refuse throws here, so nobody is asked about it. Nothing runs or is copied.
   */
  async preflight(
    args: Record<string, unknown>,
    binding: PluginBinding,
    tool: { paid: boolean },
  ): Promise<Record<string, string>> {
    await this.#checkedGame(genexCliRequest(args, tool), binding);
    return genexCliConsentArgs(args, tool);
  }

  /**
   * The bound game's real folder for a call that reads the game's files, writes a shared item into it
   * or uses its local drafts, with every file it names checked there; null for any other call. A call
   * that only uses local drafts runs without them when the call is not bound to the game.
   */
  async #checkedGame(request: GenexCliRequest, binding: PluginBinding): Promise<string | null> {
    const strict = Boolean(request.gamePaths || request.delivers);
    if (!strict && !request.localItems) return null;
    const boundGame = this.#deps.boundGame;
    if (!boundGame) {
      if (strict) throw new Error(GENEX_CLI_PROMPT.ForeignFolder);
      return null;
    }
    const game = strict ? await boundGame(binding) : await boundGame(binding).catch(() => null);
    if (!game) return null;
    for (const arg of request.gamePaths ?? []) await resolveGamePath(game, arg);
    return game;
  }

  /**
   * The hosted project a call runs on; null for a call on local drafts while the game has none (it
   * then needs the game itself). Any other call, or one with no game, needs the hosted project.
   */
  async #projectFor(request: GenexCliRequest, project: string, game: string | null): Promise<HostedProject | null> {
    const hosted = await this.#hostedProjectOrNull(project);
    if (hosted) return hosted;
    if (request.localItems && request.localItems !== LocalItemsUse.Read && !game)
      throw new Error(GENEX_CLI_PROMPT.ForeignFolder);
    if (request.localItems && game) return null;
    throw new Error(GENEX_CLI_PROMPT.NoDraft);
  }

  /** The game's real folder for a run Studio makes itself, by its name. */
  async #gameFolder(project: string): Promise<string> {
    if (!this.#deps.gameFolder) throw new Error(GENEX_CLI_PROMPT.ForeignFolder);
    return this.#deps.gameFolder(project);
  }

  /**
   * After a call that changes local drafts, what the CLI changed goes into the game: each draft it
   * wrote (with its fingerprint), and each it removed, which the host hears of. The agent reads why
   * when it could not.
   */
  async #carry(
    answer: GenexCliAnswer,
    request: GenexCliRequest,
    run: RunFolder,
    game: string | null,
    project: string,
  ): Promise<{ carried: GenexCliAnswer; written: DraftPrints }> {
    const none = { carried: answer, written: new Map<string, string>() };
    if (!answer.ok || request.localItems !== LocalItemsUse.Change || !game) return none;
    try {
      const { written, removed } = await carryLocalDrafts(run.work, game, run.staged);
      if (removed.length > 0) await this.#deps.onLocalDraftsRemoved?.(project, removed).catch(() => undefined);
      return { carried: answer, written };
    } catch (error) {
      const why = error instanceof LocalDraftsNotCarried ? error.message : GENEX_CLI_PROMPT.ItemFolderUnwritable;
      const output = GENEX_CLI_PROMPT.LocalDraftsNotCarried(why);
      return { carried: { command: answer.command, ok: false, output }, written: new Map() };
    }
  }

  /** After `items add`, its folder moves into the game; the agent reads why when it could not. */
  async #deliver(
    answer: GenexCliAnswer,
    request: GenexCliRequest,
    work: string,
    game: string | null,
  ): Promise<GenexCliAnswer> {
    const itemId = request.delivers;
    if (!itemId || !game || !answer.ok) return answer;
    try {
      await deliverSharedItem(work, game, itemId, (this.#deps.now ?? Date.now)());
      return answer;
    } catch (error) {
      const why = error instanceof ItemNotDelivered ? error.message : GENEX_CLI_PROMPT.ItemFolderUnwritable;
      return { command: answer.command, ok: false, output: GENEX_CLI_PROMPT.ItemNotDelivered(itemId, why) };
    }
  }

  /**
   * A listing draft in the answer, for the game's own hosted project: its card goes up in the chat. A
   * local draft's card goes up only while the game holds that draft (`prints`, Studio's fingerprints).
   */
  async #announceDraft(
    answer: GenexCliAnswer,
    binding: PluginBinding,
    project: { id: string } | null,
    prints: DraftPrints,
  ): Promise<void> {
    const announce = this.#deps.onListingDraft;
    const draft = announce ? draftInCliAnswer(answer, binding.project, project?.id ?? null) : null;
    if (!announce || !draft) return;
    if (!isLocalDraft(draft)) {
      await announce(draft, binding).catch(() => undefined);
      return;
    }
    const fingerprint = prints.get(draft.localId);
    if (fingerprint) await announce(draft, binding, fingerprint).catch(() => undefined);
  }

  /** The publish workspace's record of the game's hosted project, or null while it has none that reads. */
  async #publishRecord(project: string): Promise<Record<string, unknown> | null> {
    if (!PROJECT_NAME.test(project)) throw new Error(MESSAGE.InvalidProject);
    const file = path.join(this.#deps.genexStorage, "publish", project, ".genex", "project.json");
    try {
      const meta: unknown = JSON.parse(await readFile(file, "utf8"));
      return isPlainRecord(meta) ? meta : null;
    } catch {
      return null;
    }
  }

  /** The hosted project's id and slug from the publish workspace (never its apiUrl), or null while it has none. */
  async #hostedProjectOrNull(project: string): Promise<HostedProject | null> {
    return hostedProjectOf(await this.#publishRecord(project));
  }

  /** The game's hosted Genex project id, as its publish record names it; null before its first publish. */
  async hostedProjectId(project: string): Promise<string | null> {
    return (await this.#hostedProjectOrNull(project))?.id ?? null;
  }

  /**
   * Whether the game is public on Genex: its publish workspace names a hosted project that its publish
   * marked published. A publish makes the project first and marks it last, so one that failed part-way,
   * or is still running, does not count.
   */
  async published(project: string): Promise<boolean> {
    const record = await this.#publishRecord(project);
    return hostedProjectOf(record) !== null && record?.status === GenexHostedStatus.Published;
  }

  /**
   * The run folder: `<root>` is HOME, `<root>/work` the working folder. HOME carries a fresh
   * update-check record so the CLI does not try the npm registry, which the sandbox keeps closed.
   */
  async #prepare(root: string, project: HostedProject | null): Promise<string> {
    const work = path.join(root, "work");
    await mkdir(path.join(root, ".genex"), { recursive: true, mode: 0o700 });
    await mkdir(work, { recursive: true, mode: 0o700 });
    const updateCheck = { checkedAt: new Date().toISOString(), latest: {} };
    await writeFile(path.join(root, ".genex", "update-check.json"), `${JSON.stringify(updateCheck)}\n`);
    if (project) {
      await mkdir(path.join(work, ".genex"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(work, ".genex", "project.json"), `${JSON.stringify(project)}\n`);
    }
    return work;
  }

  #runRequest(
    request: GenexCliRequest,
    folders: { root: string; work: string; denyWrite: string[] },
    credential: string,
    signal: AbortSignal | undefined,
  ): RunRequest {
    const { root, work, denyWrite } = folders;
    const node = this.#deps.execPath ?? process.execPath;
    const argv = [
      node,
      "--import",
      path.join(this.#deps.resources, PRELOAD_IN_RESOURCES),
      path.join(this.#deps.resources, CLI_IN_RESOURCES),
      ...request.argv,
    ];
    const hostFlags = `--env ${shellQuote(CREDENTIALS_ENV_FILE)} --api-url ${shellQuote(this.#api)} --no-auth --json`;
    return {
      command: `${argv.map(shellQuote).join(" ")} ${hostFlags}`,
      cwd: work,
      env: this.#env(root),
      stdin: credential,
      timeoutMs: GENEX_CLI_TIMEOUT_MS,
      maxOutputBytes: OUTPUT_MAX_CHARS,
      label: `genex-cli:${request.command}`,
      policy: {
        allowedDomains: [new URL(this.#api).hostname, ...(movesItemFiles(request) ? [ITEM_STORAGE_DOMAIN] : [])],
        allowWrite: [root],
        denyWrite,
      },
      ...(signal ? { signal } : {}),
    };
  }

  /** The CLI's own environment, with HOME at the run root and the credential on stdin. */
  #env(root: string): Record<string, string> {
    const env: Record<string, string> = {
      // Node's fetch uses the sandbox's filtering proxy only when asked to.
      NODE_USE_ENV_PROXY: "1",
      STUDIO_GENEX_CREDENTIAL_FD: CREDENTIAL_FD,
      GENEX_NO_BROWSER: "1",
    };
    for (const [key, value] of Object.entries(
      genexCliEnv(this.#deps.parentEnv ?? process.env, { api: this.#api, home: root }),
    ))
      if (value !== undefined) env[key] = value;
    return env;
  }

  /** What the agent reads: redacted, without colour codes, capped, parsed when it is JSON. */
  #answer(
    request: GenexCliRequest,
    result: RunResult,
    credential: string,
    signal: AbortSignal | undefined,
  ): GenexCliAnswer {
    if (result.timedOut) throw new Error(GENEX_CLI_PROMPT.TimedOut(request.command, GENEX_CLI_TIMEOUT_MS / SECOND_MS));
    if (signal?.aborted) throw new Error(GENEX_CLI_PROMPT.Stopped(request.command));
    const text = this.#redact(stripAnsi(result.stdout.trim() || result.stderr.trim()), credential);
    const output = cappedOutput(text);
    if (result.code === 0) return { command: request.command, ok: true, output };
    return { command: request.command, ok: false, exitCode: result.code, output };
  }

  #redact(text: string, credential: string): string {
    const token = credential.match(/^GENEX_TOKEN=(.*)$/m)?.[1]?.trim();
    const secrets = [...this.#deps.heldCredentials(), ...(token ? [token] : [])].filter((s) => s.length > 0);
    return secrets.reduce((out, secret) => out.replaceAll(secret, REDACTED), text);
  }
}

/** The CLI's JSON when the whole answer is JSON within the cap; otherwise its text, capped. */
function cappedOutput(text: string): unknown {
  if (text.length > OUTPUT_MAX_CHARS) return `${text.slice(0, OUTPUT_MAX_CHARS)}${TRUNCATED_NOTE}`;
  try {
    return parseGenexJson(text);
  } catch {
    return text;
  }
}

/** The registry's host-tool hook: the plugin id, the host program, its arguments and the binding. */
export type GenexHostTool = (
  id: string,
  host: PluginHostTool,
  args: Record<string, unknown>,
  binding: PluginBinding,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Each host program's native step: a fixture profile runs neither the CLI nor an install. */
export const GENEX_HOST_STEP = {
  [PluginHostTool.GenexCli]: "studio:plugins.host-cli",
  [PluginHostTool.GenexCliPaid]: "studio:plugins.host-cli",
  [PluginHostTool.GenexPackage]: "studio:plugins.host-package",
} as const satisfies Record<PluginHostTool, NativeStep>;

/** The registry hook for the bundled Genex plugin's host tools. */
export function genexHostTool(services: { cli: GenexCliService; packages: GenexPackageService }): GenexHostTool {
  return async (_id, host, args, binding, signal) => {
    if (host === PluginHostTool.GenexPackage) return services.packages.add(args, binding);
    return services.cli.run(args, binding, {
      paid: host === PluginHostTool.GenexCliPaid,
      ...(signal ? { signal } : {}),
    });
  };
}

/**
 * The registry's consent hook for the Genex host tools: the call as Studio would run it, made from
 * the validated request (a refused call throws, and nobody is asked).
 */
export function genexHostConsent(
  _id: string,
  host: PluginHostTool,
  args: Record<string, unknown>,
): Record<string, string> {
  if (host === PluginHostTool.GenexPackage) return genexPackageConsentArgs(args);
  return genexCliConsentArgs(args, { paid: host === PluginHostTool.GenexCliPaid });
}

/**
 * Validate a call's prerequisites before showing a consent card: a package's folder, and the game's
 * files a CLI call names. Execution checks them again.
 */
export function genexHostPreflight(packages: GenexPackageService, cli?: GenexCliService) {
  return async (
    id: string,
    host: PluginHostTool,
    args: Record<string, unknown>,
    binding: PluginBinding,
  ): Promise<Record<string, string>> => {
    if (host === PluginHostTool.GenexPackage) await packages.preflight(args, binding);
    else if (cli) return cli.preflight(args, binding, { paid: host === PluginHostTool.GenexCliPaid });
    return genexHostConsent(id, host, args);
  };
}

/** `hook`, refused in a fixture profile before anything runs, as every native step is. */
export function gatedHostTool(hook: GenexHostTool, fixture: boolean): GenexHostTool {
  return async (id, host, args, binding, signal) => {
    assertNativeActionAllowed(fixture, GENEX_HOST_STEP[host]);
    return hook(id, host, args, binding, signal);
  };
}

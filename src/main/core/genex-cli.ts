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
 * environment or disk; the sandbox opens the Genex API alone for the length of the run.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StudioPlatform } from "../../shared/boot.ts";
import type { NativeProcessRequest, NativeProcessResult } from "../../substrate/plugins/native-process-contract.ts";
import { runWindowsCli } from "./genex-cli-windows.ts";
import { genexCliEnv, parseGenexJson, stripAnsi } from "../../plugins/genex/cli.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { type PluginBinding, PluginHostTool } from "../../shared/plugins.ts";
import { type RunRequest, type RunResult, shellQuote } from "../../substrate/spawn.ts";
import { assertNativeActionAllowed, type NativeStep } from "../dev/native-policy.ts";
import { type GenexCliRequest, genexCliConsentArgs, genexCliRequest } from "./genex-cli-policy.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";
import { type GenexPackageService, genexPackageConsentArgs } from "./genex-package.ts";

/** How long one CLI command may run before it is stopped. */
export const GENEX_CLI_TIMEOUT_MS = 90 * SECOND_MS;
/** The most of a command's output an agent reads back. */
const OUTPUT_MAX_CHARS = 64 * 1024;
const TRUNCATED_NOTE = "\n[output truncated]";
const REDACTED = "[redacted]";
/** Genex's production API, the one origin a run may reach. */
const GENEX_API = "https://api.genex.games";
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

/** The one plugin whose manifest may declare host tools. */
export const GENEX_PLUGIN_ID = "genex";

const MESSAGE = {
  InvalidProject: "This call is not bound to a game project Studio knows.",
} as const;

/** What a run needs from Studio. Every path is Studio's own; none comes from the agent. */
export interface GenexCliDeps {
  /** The process sandbox's `run`. */
  run: (request: RunRequest) => Promise<RunResult>;
  /** Windows private-folder execution through ProcessSandbox's offline native job. */
  runNative?: (request: NativeProcessRequest) => Promise<NativeProcessResult>;
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
  /** The Genex API origin; tests point it at a fixture. */
  api?: string;
  /** The Node that runs the CLI: Electron as node in the app. */
  execPath?: string;
  parentEnv?: NodeJS.ProcessEnv;
}

/** What an agent reads back: the command, whether it succeeded, and its (parsed) output. */
export interface GenexCliAnswer {
  command: string;
  ok: boolean;
  exitCode?: number | null;
  output: unknown;
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
    const project = request.project ? await this.#hostedProject(binding.project) : null;
    const credential = await this.#deps.credentialFile();
    if (!credential) throw new Error(GENEX_CLI_PROMPT.Locked);
    const root = path.join(this.#deps.runsRoot, randomUUID().replaceAll("-", "").slice(0, RUN_ID_CHARS));
    try {
      const work = await this.#prepare(root, project);
      const denyWrite = await this.#deps.protectedWrites();
      const run = this.#runRequest(request, { root, work, denyWrite }, credential, options.signal);
      const result = await this.#execute(request, run);
      return this.#answer(request, result, credential, options.signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /** The hosted project's id and slug from the publish workspace; never its apiUrl. */
  async #hostedProject(project: string): Promise<{ id: string; slug: string }> {
    if (!PROJECT_NAME.test(project)) throw new Error(MESSAGE.InvalidProject);
    const file = path.join(this.#deps.genexStorage, "publish", project, ".genex", "project.json");
    const meta: unknown = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
    const { id, slug } = (meta ?? {}) as { id?: unknown; slug?: unknown };
    if (typeof id !== "string" || !id || typeof slug !== "string" || !slug) throw new Error(GENEX_CLI_PROMPT.NoDraft);
    return { id, slug };
  }

  /**
   * The run folder: `<root>` is HOME, `<root>/work` the working folder. HOME carries a fresh
   * update-check record so the CLI does not try the npm registry, which the sandbox keeps closed.
   */
  async #prepare(root: string, project: { id: string; slug: string } | null): Promise<string> {
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
    const argv = this.#nodeArgv(request);
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
        allowedDomains: [new URL(this.#api).hostname],
        allowWrite: [root],
        denyWrite,
      },
      ...(signal ? { signal } : {}),
    };
  }

  #nodeArgv(request: GenexCliRequest): string[] {
    return [
      this.#deps.execPath ?? process.execPath,
      "--import",
      pathToFileURL(path.join(this.#deps.resources, PRELOAD_IN_RESOURCES)).href,
      path.join(this.#deps.resources, CLI_IN_RESOURCES),
      ...request.argv,
    ];
  }

  #execute(request: GenexCliRequest, run: RunRequest): Promise<RunResult> {
    if (process.platform !== StudioPlatform.Windows || !this.#deps.runNative) return this.#deps.run(run);
    const argv = [
      ...this.#nodeArgv(request),
      "--env",
      CREDENTIALS_ENV_FILE,
      "--api-url",
      this.#api,
      "--no-auth",
      "--json",
    ];
    return runWindowsCli(run, argv, this.#deps.resources, this.#deps.runNative);
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

/** Validate package prerequisites before showing a consent card; execution checks them again. */
export function genexHostPreflight(packages: GenexPackageService) {
  return async (
    id: string,
    host: PluginHostTool,
    args: Record<string, unknown>,
    binding: PluginBinding,
  ): Promise<Record<string, string>> => {
    if (host === PluginHostTool.GenexPackage) await packages.preflight(args, binding);
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

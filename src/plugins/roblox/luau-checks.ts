/**
 * The Luau checks as the Roblox backend serves them: the agent's `check-scripts`, the moments'
 * `luau-note` (a worker's end) and `luau-finish` (a build's finish), the panel's **Add Luau
 * checks** with its confirmation, and what `status` says of them. Each finds the programs afresh
 * (`luau-tools.ts`), so a program the person installs meanwhile is used at once, and checks with
 * `check-scripts.ts` in the folder the call is bound to: a worker's copy is checked as itself.
 */
import type { PluginContext, PluginReview } from "../../plugin-sdk/index.d.ts";
import type { HookAnswer } from "../../shared/plugin-hooks.ts";
import { PluginService } from "../../shared/plugins.ts";
import { type CheckRun, checkScripts, luauFinish, luauNote, systemCheckRun } from "./check-scripts.ts";
import {
  addLuauChecks,
  downloadMegabytes,
  type FindToolsDeps,
  findTools,
  LuauAddError,
  LuauAddRefusal,
  type LuauAsset,
  luauPlatform,
  missingAssets,
} from "./luau-tools.ts";
import type { InstallRun } from "./studio-install.ts";
import { SETUP_PROMPTS } from "./setup-prompts.ts";
import { MESSAGE } from "./words.ts";

/** The computer the checks work on: the processor, the program runner, the network and the unpacker. */
export interface LuauDeps {
  arch: string;
  run: CheckRun;
  fetch: typeof fetch;
  unpack: InstallRun;
  /** A signal that ends after `ms`; the system's timer by default. */
  timeout?(ms: number): AbortSignal;
}

/** This computer's: its processor, `spawn`, Node's fetch and `unpack` (the installer's runner). */
export function systemLuau(fetchFn: typeof fetch, unpack: InstallRun): LuauDeps {
  return { arch: process.arch, run: systemCheckRun, fetch: fetchFn, unpack };
}

/** Where the backend looks for the programs. */
type ToolHome = FindToolsDeps & { platform: NodeJS.Platform };

/** The answer to check-scripts. */
export interface CheckScriptsAnswer {
  checked: boolean;
  message: string;
  files?: number;
  errors?: number;
  warnings?: number;
  format?: number;
}

/** The answer to Add Luau checks: added (or already there), else why not. */
export interface AddLuauAnswer {
  added: boolean;
  message: string;
  assets?: LuauAsset[];
  reason?: LuauAddRefusal;
}

/** What `status` says of the checks: whether they are all here, and whether Add Luau checks is offered. */
export interface LuauStatus {
  added: boolean;
  offered: boolean;
}

async function toolsFor(home: ToolHome, context: PluginContext) {
  const storage: string = await context.host(PluginService.StorageRoot);
  return { storage, tools: await findTools(home, storage) };
}

/** A check of `folder`, the folder the call is bound to: the changed files unless `all`. */
async function check(home: ToolHome, luau: LuauDeps, context: PluginContext, at: { folder: string; all: boolean }) {
  const { storage, tools } = await toolsFor(home, context);
  const timeout = luau.timeout ? { timeout: luau.timeout } : {};
  const deps = { run: luau.run, storage, platform: home.platform, tools, ...timeout };
  const game = context.project ? { game: context.project } : {};
  return checkScripts(deps, { ...at, ...game, signal: context.signal });
}

/** The agent's check-scripts: the plain lines and the counts. */
export async function checkScriptsTool(
  home: ToolHome,
  luau: LuauDeps,
  context: PluginContext,
  args: Record<string, unknown>,
): Promise<CheckScriptsAnswer> {
  const { tools } = await toolsFor(home, context);
  if (Object.keys(tools.programs).length === 0) return { checked: false, message: SETUP_PROMPTS.ChecksNotAdded };
  if (!context.directory) return { checked: false, message: MESSAGE.Checks.NoGame };
  const done = await check(home, luau, context, { folder: context.directory, all: args.all === true });
  const counts = { errors: done.errors, warnings: done.warnings, format: done.format };
  return { checked: done.ran.length > 0, message: done.message, files: done.files.length, ...counts };
}

/** A worker's end: its changed scripts checked, a note of what they still have. */
export async function luauNoteAt(home: ToolHome, luau: LuauDeps, context: PluginContext): Promise<HookAnswer> {
  if (!context.directory) return {};
  const done = await check(home, luau, context, { folder: context.directory, all: false });
  return luauNote(done, context.hook?.worker?.title);
}

/** A build's finish: every script checked; errors hold it back. */
export async function luauFinishAt(home: ToolHome, luau: LuauDeps, context: PluginContext): Promise<HookAnswer> {
  if (!context.directory) return {};
  return luauFinish(await check(home, luau, context, { folder: context.directory, all: true }));
}

/** What this computer still lacks, or undefined when no release is built for it. */
async function missingHere(home: ToolHome, luau: LuauDeps, context: PluginContext) {
  const platform = luauPlatform(home.platform, luau.arch);
  if (!platform) return undefined;
  const { storage, tools } = await toolsFor(home, context);
  return { storage, missing: missingAssets(tools, platform) };
}

/** Whether the checks are all here, and whether Add Luau checks is offered. */
export async function luauStatus(home: ToolHome, luau: LuauDeps, context: PluginContext): Promise<LuauStatus> {
  const here = await missingHere(home, luau, context);
  if (!here) return { added: false, offered: false };
  return { added: here.missing.length === 0, offered: here.missing.length > 0 };
}

/** Add Luau checks' confirmation: this computer's download size, and where they come from and run. */
export async function reviewAddLuau(home: ToolHome, luau: LuauDeps, context: PluginContext): Promise<PluginReview> {
  const here = await missingHere(home, luau, context).catch(() => undefined);
  if (!here || here.missing.length === 0) return {};
  return { message: MESSAGE.Luau.Confirm(downloadMegabytes(here.missing)), detail: MESSAGE.Luau.Plan() };
}

/** Add Luau checks: downloads what this computer lacks into the plugin's storage, all or nothing. */
export async function addLuauAction(home: ToolHome, luau: LuauDeps, context: PluginContext): Promise<AddLuauAnswer> {
  const here = await missingHere(home, luau, context);
  if (!here) return { added: false, message: MESSAGE.Luau.Refused.unsupported(), reason: LuauAddRefusal.Unsupported };
  if (here.missing.length === 0) return { added: true, message: MESSAGE.Luau.AlreadyAdded() };
  const deps = {
    platform: home.platform,
    arch: luau.arch,
    env: home.env,
    fetch: luau.fetch,
    run: luau.unpack,
    storage: here.storage,
    signal: context.signal,
    ...(luau.timeout ? { timeout: luau.timeout } : {}),
  };
  try {
    const added = await addLuauChecks(deps, here.missing);
    return { added: true, message: MESSAGE.Luau.Added(), assets: added.assets };
  } catch (error) {
    if (!(error instanceof LuauAddError)) throw error;
    return { added: false, message: error.message, reason: error.code };
  }
}

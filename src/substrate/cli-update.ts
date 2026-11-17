import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { requireCodingCli, invalidateCodingCli } from "./engines/external-cli.ts";
import { runCommand } from "./engines/claude-cli.ts";
import type { CodingProvider } from "../shared/coding-cli.ts";
import { CliInstallProblem } from "../shared/cli-install.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { EngineId } from "../shared/providers.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { installCodingCli, type FetchInstaller, type InstallOutcome } from "./cli-installer.ts";
import { isBelow } from "./paths.ts";

const UPDATE_TIMEOUT_MS = 10 * MINUTE_MS;
/** How long the question "which Codex is the latest" may take. */
const LATEST_TIMEOUT_MS = 15 * SECOND_MS;
/** Where OpenAI's installer keeps the Codex it installs, under the home folder, on every system. */
const CODEX_INSTALLER_ROOT = [".codex", "packages", "standalone"] as const;
/**
 * Where the installer itself asks which stable Codex is the latest: OpenAI's release host, then
 * the GitHub release it falls back to. Both answer `{ "tag_name": "rust-v1.2.3" }`.
 */
const CODEX_LATEST_SOURCES = [
  "https://releases.openai.com/codex/channels/latest",
  "https://api.github.com/repos/openai/codex/releases/latest",
] as const;
/** A stable release's tag: no alpha or beta. */
const STABLE_TAG = /^rust-v(\d+\.\d+\.\d+)$/;
const latestSchema = z.object({ tag_name: z.string() });
/** The command each CLI updates itself with. */
const UPDATE_ARGS: Record<CodingProvider, readonly string[]> = {
  [EngineId.ClaudeCode]: ["update"],
  [EngineId.Codex]: ["update"],
  [EngineId.OpenCode]: ["upgrade"],
  [EngineId.Grok]: ["update"],
  [EngineId.Cursor]: ["update"],
  [EngineId.Antigravity]: ["update"],
};
/** A macOS app bundle's own files: `<name>.app/Contents/…`. */
const APP_BUNDLE = /\.app\/Contents\//;
const MESSAGE = {
  appManaged: (file: string) => `${file} is inside a desktop app; only that app updates it`,
} as const;

/**
 * Whether `executable` is the copy a desktop app ships inside itself (Codex in the ChatGPT app,
 * Claude Code in the Claude app), named directly or through a link. Such a CLI cannot update
 * itself: its app replaces it with the app's own update.
 */
export async function shippedInsideApp(
  executable: string,
  real: (file: string) => Promise<string> = realpath,
): Promise<boolean> {
  if (APP_BUNDLE.test(executable)) return true;
  return APP_BUNDLE.test(await real(executable).catch(() => executable));
}

/**
 * Whether `executable` is the Codex that OpenAI's own installer put on this computer (the one
 * Genex's Install button runs): the command, followed through its links, lives in the installer's
 * folder. An npm, Homebrew or app copy is somebody else's to update.
 */
export async function installedByCodexInstaller(
  executable: string,
  options: { home?: string; real?: (file: string) => Promise<string>; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const real = options.real ?? realpath;
  const root = path.join(options.home ?? os.homedir(), ...CODEX_INSTALLER_ROOT);
  const file = await real(executable).catch(() => null);
  if (!file) return false;
  return isBelow(await real(root).catch(() => root), file, options.platform);
}

/** The latest stable Codex version ("0.169.0"), or null when nobody answers with one. */
export async function latestCodexVersion(fetchFn: FetchInstaller = fetch): Promise<string | null> {
  for (const url of CODEX_LATEST_SOURCES) {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) });
      if (!response.ok) continue;
      const parsed = latestSchema.safeParse(await response.json());
      const version = parsed.success ? STABLE_TAG.exec(parsed.data.tag_name)?.[1] : undefined;
      if (version) return version;
    } catch {
      // The next source may answer.
    }
  }
  return null;
}

/**
 * Update only the selected installation; never fall back to a different installer. The Codex that
 * OpenAI's installer installed is updated by that same installer, which puts the latest stable
 * release in the same place.
 */
export async function updateCodingCli(
  provider: CodingProvider,
  executable?: string,
  deps: {
    resolve?: typeof requireCodingCli;
    run?: typeof runCommand;
    invalidate?: typeof invalidateCodingCli;
    real?: (file: string) => Promise<string>;
    home?: string;
    install?: (provider: CodingProvider) => Promise<InstallOutcome>;
  } = {},
): Promise<InstallOutcome> {
  const resolve = deps.resolve ?? requireCodingCli;
  const selected = await resolve(provider, executable);
  if (await shippedInsideApp(selected.path, deps.real))
    return { ok: false, problem: CliInstallProblem.AppManaged, detail: MESSAGE.appManaged(selected.path) };
  const ownInstaller =
    provider === EngineId.Codex &&
    (await installedByCodexInstaller(selected.path, { home: deps.home, real: deps.real }));
  const updated = ownInstaller
    ? await (deps.install ?? installCodingCli)(provider)
    : await selfUpdate(provider, selected, deps.run ?? runCommand);
  if (!updated.ok) return updated;
  (deps.invalidate ?? invalidateCodingCli)(provider);
  const verified = await resolve(provider, executable);
  if (verified.path !== selected.path)
    return { ok: false, problem: CliInstallProblem.NotFound, detail: "The selected CLI changed during the update." };
  return { ok: true };
}

/** Ask the CLI to update itself, as its package manager or own updater does. */
async function selfUpdate(
  provider: CodingProvider,
  selected: { path: string; env: NodeJS.ProcessEnv },
  run: typeof runCommand,
): Promise<InstallOutcome> {
  const result = await run(selected.path, [...UPDATE_ARGS[provider]], {
    env: selected.env,
    timeoutMs: UPDATE_TIMEOUT_MS,
  });
  if (result.code === 0) return { ok: true };
  return {
    ok: false,
    problem: CliInstallProblem.Installer,
    detail: "The selected CLI could not update. Use its installation guide or package manager.",
  };
}

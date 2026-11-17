import { realpath } from "node:fs/promises";
import { requireCodingCli, invalidateCodingCli } from "./engines/external-cli.ts";
import { runCommand } from "./engines/claude-cli.ts";
import type { CodingProvider } from "../shared/coding-cli.ts";
import { CliInstallProblem } from "../shared/cli-install.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { EngineId } from "../shared/providers.ts";
import type { InstallOutcome } from "./cli-installer.ts";

const UPDATE_TIMEOUT_MS = 10 * MINUTE_MS;
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

/** Update only the selected installation; never fall back to a different installer. */
export async function updateCodingCli(
  provider: CodingProvider,
  executable?: string,
  deps: {
    resolve?: typeof requireCodingCli;
    run?: typeof runCommand;
    invalidate?: typeof invalidateCodingCli;
    real?: (file: string) => Promise<string>;
  } = {},
): Promise<InstallOutcome> {
  const resolve = deps.resolve ?? requireCodingCli;
  const selected = await resolve(provider, executable);
  if (await shippedInsideApp(selected.path, deps.real))
    return { ok: false, problem: CliInstallProblem.AppManaged, detail: MESSAGE.appManaged(selected.path) };
  const result = await (deps.run ?? runCommand)(selected.path, [...UPDATE_ARGS[provider]], {
    env: selected.env,
    timeoutMs: UPDATE_TIMEOUT_MS,
  });
  if (result.code !== 0)
    return {
      ok: false,
      problem: CliInstallProblem.Installer,
      detail: "The selected CLI could not update. Use its installation guide or package manager.",
    };
  (deps.invalidate ?? invalidateCodingCli)(provider);
  const verified = await resolve(provider, executable);
  if (verified.path !== selected.path)
    return { ok: false, problem: CliInstallProblem.NotFound, detail: "The selected CLI changed during the update." };
  return { ok: true };
}

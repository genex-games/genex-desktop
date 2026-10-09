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
};
/** Update only the selected installation; never fall back to a different installer. */
export async function updateCodingCli(
  provider: CodingProvider,
  executable?: string,
  deps: {
    resolve?: typeof requireCodingCli;
    run?: typeof runCommand;
    invalidate?: typeof invalidateCodingCli;
  } = {},
): Promise<InstallOutcome> {
  const resolve = deps.resolve ?? requireCodingCli;
  const selected = await resolve(provider, executable);
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

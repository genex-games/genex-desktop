/**
 * The self test's Claude worker stage (`--claude-worker-check`): one Loop worker on the real Claude
 * Code CLI, its model a scripted Anthropic stand-in the runner started and named through
 * `ANTHROPIC_BASE_URL` (a dummy OAuth token, no account, nothing billed). Its turn runs one shell
 * command that writes a file in the worker's folder.
 *
 * On Windows Claude Code's own sandbox cannot start, and a worker used to be refused for it; there
 * the command runs through the studio's `run_command` in Genex's sandbox. Elsewhere Claude Code's
 * own sandbox runs it. The CLI is the stage's own: the vendor's installer, as the person's Install
 * button runs it, puts it in a home of the stage's under the engine homes (which no sandboxed process
 * may read or write), and the engine runs that one by its path. A self test never looks for, nor
 * changes, the person's own CLI.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { type FetchInstaller, installCodingCli } from "../../substrate/cli-installer.ts";
import { ClaudeCodeEngine, studioShell } from "../../substrate/engines/claude-code.ts";
import { requireCodingCli, resolveCodingCli } from "../../substrate/engines/external-cli.ts";
import { NeverTouchKind } from "../../substrate/engines/never-touch.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
import { ProcessSandbox } from "../../substrate/spawn.ts";
import type { StudioCore } from "../studio-core.ts";

/** The checks this stage reports; the release canary waits for them by name. */
export const CLAUDE_WORKER_CHECK = {
  Cli: "the Claude Code CLI is installed",
  Ran: "a Claude worker ran its turn without being refused",
  Wrote: "the Claude worker's command ran in its sandbox and wrote its folder",
} as const;

/** The worker's whole turn, CLI start included. */
const WORKER_TIMEOUT_MS = 3 * MINUTE_MS;

type Check = (name: string, ok: boolean, detail?: string) => void;

/** Run the stage: the CLI, the worker's turn, and the file its command wrote. */
export async function checkClaudeWorker(
  core: StudioCore,
  stage: { proofFile: string; fetch: FetchInstaller },
  check: Check,
): Promise<void> {
  const homes = path.join(core.layout.engineHomes, "claude-worker-check");
  const cli = await stageCli(path.join(homes, "cli-home"), stage.fetch);
  check(CLAUDE_WORKER_CHECK.Cli, cli.path !== null, cli.detail);
  if (!cli.path) return;
  // Inside the studio's scratch, which every sandboxed process here is already granted (Windows
  // grants a folder opened later only once the harness next stops).
  const root = path.join(core.layout.scratch, "claude-worker-check");
  const copy = path.join(root, "copy");
  await rm(root, { recursive: true, force: true });
  await mkdir(copy, { recursive: true });
  let boxes = 0;
  const toolPath = async () => (await core.sandbox.toolPath()) ?? process.env.PATH ?? "";
  const engine = new ClaudeCodeEngine({
    executable: cli.path,
    // A self test's CLI discovery is isolated (an empty PATH: `configureCodingClis` in main), and
    // a CLI launched with it finds no shell (exit 127). The stage's runs on the studio's
    // toolchain PATH, as a person's launch finds one.
    resolveCli: async (provider, override, signal, refresh) => {
      const found = await requireCodingCli(provider, override, signal, refresh);
      return { ...found, env: { ...found.env, PATH: await toolPath() } };
    },
    engineHome: path.join(homes, "engine-home"),
    systemHome: path.join(homes, "no-system-login"),
    protectedPaths: [core.layout.secrets, core.layout.engineHomes],
    scratchRoot: path.join(root, "scratch"),
    toolPath,
    commandSandbox: (options) => {
      boxes++;
      return ProcessSandbox.create(options);
    },
  });
  const request = workerRequest(copy, path.join(core.layout.gamesRoot, "other"));
  try {
    const result = await engine.delegate(request);
    check(CLAUDE_WORKER_CHECK.Ran, result.ok, `${result.stopReason}${result.errorText ? `: ${result.errorText}` : ""}`);
  } catch (err) {
    check(CLAUDE_WORKER_CHECK.Ran, false, errorMessage(err));
  }
  const wrote = await readFile(path.join(copy, path.basename(stage.proofFile)), "utf8").catch(() => "");
  const genexBox = studioShell(request, process.platform);
  const boxed = genexBox ? boxes === 1 : boxes === 0;
  check(
    CLAUDE_WORKER_CHECK.Wrote,
    wrote.length > 0 && boxed,
    `${genexBox ? "Genex's sandbox" : "Claude Code's sandbox"}; ${boxes} Genex sandboxes; file ${wrote ? "written" : "missing"}`,
  );
}

/** A writing worker in Auto with nobody to ask, beside a game it may never touch. */
function workerRequest(copy: string, otherGame: string): DelegateRequest {
  const request: DelegateRequest = {
    prompt: "Run the command that writes the proof file, then stop.",
    cwd: copy,
    timeoutMs: WORKER_TIMEOUT_MS,
    worker: {
      id: "claude-worker-check",
      title: "Self test worker",
      mode: PermissionMode.Auto,
      writeRoots: [copy],
      neverTouch: { roots: [{ path: otherGame, kind: NeverTouchKind.OtherGame }], open: [copy] },
      research: false,
    },
  };
  return request;
}

/**
 * The stage's own CLI, in `home`: the vendor's installer run with that folder as its home folder,
 * where it puts the CLI as it does in a person's (`.local/bin`). Its path, or null and why.
 */
async function stageCli(home: string, fetch: FetchInstaller): Promise<{ path: string | null; detail: string }> {
  const exe = path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const installed = await installCodingCli(EngineId.ClaudeCode, { fetch, env });
  if (!installed.ok) return { path: null, detail: `${installed.problem}: ${installed.detail}` };
  const { status } = await resolveCodingCli(EngineId.ClaudeCode, exe, undefined, true);
  if (status.state !== CodingCliState.Ready) return { path: null, detail: `${status.state}: ${status.detail}` };
  return { path: exe, detail: `${exe} (${status.version ?? "unknown version"})` };
}

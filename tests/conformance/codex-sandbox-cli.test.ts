/**
 * A Codex session's commands run under the flags Genex starts Codex with, with the real Codex CLI.
 *
 * The engine builds each session's `codex exec` argv as it would for a build (a fake exec records
 * it); the real CLI then runs that argv against `fake-openai-responses.ts` (a custom provider, no
 * sign-in, nothing billed), whose scripted turn runs one `node` command that writes the session's
 * folder. On Windows this is the lead's `node .studio/bridge/tool.mjs start_web_game` of #304:
 * without Codex's own Windows sandbox every such command was "rejected: blocked by policy".
 * Opt-in, like every test that needs this machine's own programs: `STUDIO_CODEX_CLI_TESTS=1` with
 * a `codex` the engine can find (or `STUDIO_CODEX_BIN`). On Windows with a second drive the same
 * sessions also run inside a Genex data folder moved there (Settings → Storage), locked down to
 * this account as the move leaves it.
 */
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EngineId } from "../../src/shared/providers.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { spawnCommand } from "../../src/substrate/command-launch.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import { resolveCodingCli } from "../../src/substrate/engines/external-cli.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { codexProviderArgs, startFakeResponses } from "../helpers/fake-openai-responses.ts";
import { lockDownFolder } from "../../src/substrate/windows-drive.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_CODEX_CLI_TESTS === "1";
/** How long one scripted Codex turn may take. */
const TURN_TIMEOUT_MS = 120_000;
/** What the scripted command writes in the session's folder. */
const PROOF = { file: "codex-proof.txt", text: "ok" } as const;
const PROBE_FILE = "probe.mjs";
const PROBE_SOURCE = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(PROOF.file)}, ${JSON.stringify(PROOF.text)});\nconsole.log("probe ran");\n`;

interface Launch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** The `codex exec` launch the engine makes for one request, recorded and not run. */
async function launchFor(root: string, request: (game: string) => DelegateRequest): Promise<Launch> {
  const home = path.join(root, "engine-home");
  const game = path.join(root, "game");
  for (const dir of [home, game]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, "auth.json"), "{}");
  const seen: Launch[] = [];
  const execFn: CodexExec = (invocation) => {
    seen.push({ argv: invocation.argv, cwd: invocation.cwd, env: invocation.env });
    return { async *[Symbol.asyncIterator]() {} };
  };
  const engine = new CodexEngine({
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    executable: "/fake/codex",
    resolveCli: fixtureCodingCli,
    authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
    execFn,
  });
  await engine.delegate(request(game));
  const launch = seen.at(-1);
  assert.ok(launch, "the engine launched codex exec");
  return launch;
}

/** The real `codex` binary. */
async function codexBinary(): Promise<string> {
  if (process.env.STUDIO_CODEX_BIN) return process.env.STUDIO_CODEX_BIN;
  const found = await resolveCodingCli(EngineId.Codex);
  assert.ok(found.status.path, `no codex CLI found: ${found.status.state}`);
  return found.status.path;
}

/** Run the recorded launch with the real CLI against a fake turn; what the command left and said. */
async function runForReal(root: string, launch: Launch) {
  await mkdir(launch.cwd, { recursive: true });
  await writeFile(path.join(launch.cwd, PROBE_FILE), PROBE_SOURCE);
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  const fake = await startFakeResponses(["node", PROBE_FILE]);
  try {
    const argv = [...launch.argv.slice(0, -1), ...codexProviderArgs(fake), "-"];
    const child = spawnCommand(await codexBinary(), argv, {
      cwd: launch.cwd,
      env: { ...launch.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let log = "";
    child.stdout?.on("data", (chunk) => (log += chunk));
    child.stderr?.on("data", (chunk) => (log += chunk));
    child.stdin?.end("Run the command.");
    const ceiling = setTimeout(() => child.kill(), TURN_TIMEOUT_MS);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    clearTimeout(ceiling);
    const proof = await readFile(path.join(launch.cwd, PROOF.file), "utf8").catch(() => null);
    return { code, log, proof, shell: fake.calledShell(), output: fake.commandOutput() };
  } finally {
    await fake.close();
  }
}

const SESSIONS: Array<{ name: string; request: (game: string) => DelegateRequest }> = [
  { name: "the lead in Auto", request: (cwd) => ({ prompt: "build", cwd, permissions: chat(PermissionMode.Auto) }) },
  { name: "the lead in Plan", request: (cwd) => ({ prompt: "plan", cwd, permissions: chat(PermissionMode.Plan) }) },
  { name: "a read-only session", request: (cwd) => ({ prompt: "look", cwd, readOnly: true }) },
  {
    name: "a worker",
    request: (cwd) => ({
      prompt: "build the scene",
      cwd,
      worker: {
        id: "w1",
        title: "Scene builder",
        mode: PermissionMode.Auto,
        writeRoots: [cwd],
        neverTouch: { roots: [], open: [] },
        research: false,
      },
    }),
  },
];

function chat(mode: PermissionMode): DelegateRequest["permissions"] {
  return { mode, allow: [], directories: [], protectWrites: [], ask: async () => ({ decision: "deny" }) };
}

describe("a Codex session's commands run under Genex's flags (real CLI)", {
  skip: !LIVE && "STUDIO_CODEX_CLI_TESTS=1",
}, () => {
  for (const session of SESSIONS) {
    it(`${session.name}: a node command is not blocked by policy and writes the session's folder`, async () => {
      const root = await realpath(await tmpDir("studio-codex-cli-"));
      const launch = await launchFor(root, session.request);
      const run = await runForReal(root, launch);
      const detail = `exit ${run.code}, shell ${run.shell}, output ${run.output}\n${run.log.slice(-4000)}`;
      assert.ok(run.shell, `the scripted call was made: ${detail}`);
      assert.doesNotMatch(run.output ?? "", /blocked by policy|rejected/i, detail);
      assert.equal(run.proof, PROOF.text, detail);
    });
  }
});

/** A drive other than the temp folder's, where a hosted Windows runner has one. */
function secondDrive(): string | null {
  if (process.platform !== "win32") return null;
  const temp = statSync(os.tmpdir()).dev;
  for (const letter of ["D", "E"]) {
    const root = `${letter}:\\`;
    if (existsSync(root) && statSync(root).dev !== temp) return root;
  }
  return null;
}
const SECOND_DRIVE = secondDrive();

describe("a Codex session in a Genex data folder on a second drive (real CLI, Windows)", {
  skip: (!LIVE && "STUDIO_CODEX_CLI_TESTS=1") || (!SECOND_DRIVE && "Windows with a second drive"),
}, () => {
  for (const session of SESSIONS) {
    it(`${session.name}: its command runs and writes there`, async (t) => {
      const data = path.join(SECOND_DRIVE ?? os.tmpdir(), `genex-codex-data-${process.pid}`, "Genex");
      t.after(() => removeTree(path.dirname(data)));
      await mkdir(data, { recursive: true });
      await lockDownFolder(data);
      const root = await realpath(data);
      const launch = await launchFor(root, session.request);
      const run = await runForReal(root, launch);
      const detail = `exit ${run.code}, shell ${run.shell}, output ${run.output}\n${run.log.slice(-4000)}`;
      assert.ok(run.shell, `the scripted call was made: ${detail}`);
      assert.doesNotMatch(run.output ?? "", /blocked by policy|rejected/i, detail);
      assert.equal(run.proof, PROOF.text, detail);
    });
  }
});

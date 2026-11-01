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
 *
 * A session in Auto runs on the real app server (`codex app-server`, on-request approvals) when the
 * CLI is new enough: its scripted call asks to run outside the sandbox, and the Auto check is the
 * real `codex exec --ephemeral` against a second fake that only answers a verdict, so what is
 * proven is the whole round: Codex's ask, the check's clean call on the session's model, the
 * answer, and a refusal's reason reaching the model. Each CLI runs in a `CODEX_HOME` of the test's
 * own, never the person's.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { EngineId } from "../../src/shared/providers.ts";
import { PermissionDecision, PermissionMode } from "../../src/shared/permissions.ts";
import { spawnCommand } from "../../src/substrate/command-launch.ts";
import { type CodexAppServer, spawnCodexAppServer } from "../../src/substrate/engines/codex-app-server.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import { resolveCodingCli } from "../../src/substrate/engines/external-cli.ts";
import type { DelegatePermissions, DelegateRequest, PermissionAsk } from "../../src/substrate/engines/types.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import {
  codexProviderArgs,
  codexProviderConfig,
  FAKE_MODEL,
  type FakeResponses,
  startFakeAnswer,
  startFakeResponses,
} from "../helpers/fake-openai-responses.ts";
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

// ── Auto on the app server: what Codex asks to run, checked by its own model ──────────────────

/** Why the scripted call asks to run outside the sandbox, as the model says it. */
const JUSTIFICATION = "write the proof file beside the game folder";
/** The session's own brief: the check must never read it. */
const SESSION_PROMPT = "Leave a proof file next to the game, please.";

/** A probe that writes the proof at `file`, outside the session's box. */
const probeWriting = (file: string) =>
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(file)}, ${JSON.stringify(PROOF.text)});\nconsole.log("probe ran");\n`;

/** `codex exec` as the engine runs it, on the real binary pointed at `fake`, in a home of its own: its JSONL events. */
function realExec(binary: string, fake: FakeResponses, codexHome: string): CodexExec {
  return (invocation) => ({
    async *[Symbol.asyncIterator]() {
      const argv = [...invocation.argv.slice(0, -1), ...codexProviderConfig(fake), invocation.argv.at(-1) ?? "-"];
      const child = spawnCommand(binary, argv, {
        cwd: invocation.cwd,
        env: { ...invocation.env, CODEX_HOME: codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr?.resume();
      child.stdin?.end(invocation.prompt);
      const stop = () => child.kill();
      invocation.signal.addEventListener("abort", stop, { once: true });
      try {
        for await (const line of readline.createInterface({ input: child.stdout as NodeJS.ReadableStream })) {
          if (line.trim().startsWith("{")) yield JSON.parse(line) as Record<string, unknown>;
        }
      } finally {
        invocation.signal.removeEventListener("abort", stop);
        child.kill();
      }
    },
  });
}

/** The real app server, pointed at `fake`, in a home of its own. */
function realAppServer(binary: string, fake: FakeResponses, codexHome: string): CodexAppServer {
  return (invocation) =>
    spawnCodexAppServer(binary)({
      ...invocation,
      argv: [...invocation.argv, ...codexProviderConfig(fake)],
      env: { ...invocation.env, CODEX_HOME: codexHome },
    });
}

/** What the real binary says its version is, which the engine reads to choose the app server. */
async function cliVersion(binary: string): Promise<string> {
  const { stdout } = await promisify(execFile)(binary, ["--version"]);
  return stdout.trim();
}

/** Who runs in the chat's Auto: the chat's own session, or a worker of its lead (which has no way to ask). */
const AutoSeat = { Chat: "chat", Worker: "worker" } as const;
type AutoSeat = (typeof AutoSeat)[keyof typeof AutoSeat];

/**
 * A game folder, an engine on the real CLI (the session's turns on `session`, its checks on
 * `check`) and a session in the chat's Auto. Its probe writes the proof beside the game, outside its
 * box, or (`inside`) in the game.
 */
async function autoSession(
  session: FakeResponses,
  check: FakeResponses,
  { seat = AutoSeat.Chat, inside = false }: { seat?: AutoSeat; inside?: boolean } = {},
) {
  const root = await realpath(await tmpDir("studio-codex-auto-"));
  const game = path.join(root, "game");
  const home = path.join(root, "engine-home");
  const codexHome = path.join(root, "codex-home");
  for (const dir of [game, home, codexHome]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, "auth.json"), "{}");
  const proofFile = path.join(inside ? game : root, PROOF.file);
  await writeFile(path.join(game, PROBE_FILE), probeWriting(proofFile));
  const binary = await codexBinary();
  const version = await cliVersion(binary);
  const engine = new CodexEngine({
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    resolveCli: async (provider, override, signal) => {
      const found = await fixtureCodingCli(provider, override, signal);
      return { ...found, status: { ...found.status, version } };
    },
    authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
    execFn: realExec(binary, check, codexHome),
    appServerFn: realAppServer(binary, session, codexHome),
  });
  const asked: PermissionAsk[] = [];
  const permissions: DelegatePermissions = {
    mode: PermissionMode.Auto,
    allow: [],
    directories: [],
    protectWrites: [],
    ask: async (ask) => {
      asked.push(ask);
      return { decision: PermissionDecision.Allow };
    },
  };
  const worker = {
    id: "w1",
    title: "Scene builder",
    mode: PermissionMode.Auto,
    writeRoots: [game],
    neverTouch: { roots: [], open: [] },
    research: false,
  };
  const turn = (resume?: string) =>
    engine.delegate({
      cwd: game,
      prompt: SESSION_PROMPT,
      model: FAKE_MODEL,
      timeoutMs: TURN_TIMEOUT_MS,
      ...(seat === AutoSeat.Worker ? { worker } : { permissions }),
      ...(resume ? { resume } : {}),
    });
  return { turn, asked, proofFile };
}

/** What the check was sent, once: the action alone, on the session's model. */
function assertCheckedAlone(check: FakeResponses, index: number): void {
  const body = check.requests[index] as { model?: string };
  const sent = JSON.stringify(body);
  assert.match(sent, /You are Genex's Auto check/);
  assert.match(sent, /node probe\.mjs/, "the command Codex asked to run");
  assert.ok(!sent.includes(SESSION_PROMPT), "none of the session's own conversation");
  assert.ok(!sent.includes(JUSTIFICATION), "nor the model's case for it");
  assert.equal(body.model, FAKE_MODEL, "the session's own model");
}

const AUTO_CASES = [
  {
    name: "the check allows it: it runs beyond the box",
    verdict: '{"decision":"allow","reason":"it writes a proof file the person asked for"}',
    runs: true,
    asksPerson: false,
  },
  {
    name: "the check refuses it: Codex declines it and the model reads why",
    verdict: '{"decision":"deny","reason":"it writes outside the game"}',
    runs: false,
    asksPerson: false,
  },
  {
    name: "the check cannot say: the person is asked, and their yes runs it",
    verdict: "I cannot tell.",
    runs: true,
    asksPerson: true,
  },
] as const;

describe("a Codex session in Auto has what Codex asks to run checked by its own model (real CLI)", {
  skip: !LIVE && "STUDIO_CODEX_CLI_TESTS=1",
}, () => {
  for (const auto of AUTO_CASES) {
    it(auto.name, async () => {
      const session = await startFakeResponses(["node", PROBE_FILE], { escalated: { justification: JUSTIFICATION } });
      const check = await startFakeAnswer(auto.verdict);
      try {
        const { turn, asked, proofFile } = await autoSession(session, check);
        const result = await turn();
        const proof = await readFile(proofFile, "utf8").catch(() => null);
        const output = session.commandOutput() ?? "";
        const detail = `${result.ok ? "ok" : result.errorText}; output ${output}`;
        assert.equal(result.ok, true, detail);
        assert.equal(check.requests.length, 1, `one check for the one ask: ${detail}`);
        assertCheckedAlone(check, 0);
        assert.equal(asked.length, auto.asksPerson ? 1 : 0, "only what the check could not decide reaches the person");
        if (auto.asksPerson) assert.match(String(asked[0]?.input.command), /node probe\.mjs/);
        if (auto.runs) {
          assert.equal(proof, PROOF.text, detail);
          assert.doesNotMatch(output, /rejected/i, detail);
          return;
        }
        assert.equal(proof, null, "a refused command never ran");
        assert.match(output, /rejected/i, detail);
        assert.match(JSON.stringify(session.requests), /Auto check did not allow this: it writes outside the game/);
      } finally {
        await session.close();
        await check.close();
      }
    });
  }

  it("a resumed session in Auto is resumed on the app server and checked again", async () => {
    const session = await startFakeResponses(["node", PROBE_FILE], { escalated: { justification: JUSTIFICATION } });
    const check = await startFakeAnswer('{"decision":"deny","reason":"it writes outside the game"}');
    try {
      const { turn, proofFile } = await autoSession(session, check);
      const first = await turn();
      assert.equal(first.ok, true, first.errorText);
      assert.ok(first.sessionId, "the session has an id to continue");
      const again = await turn(first.sessionId);
      assert.equal(again.ok, true, again.errorText);
      assert.equal(again.sessionId, first.sessionId, "the same session, continued");
      assert.equal(check.requests.length, 2, "the resumed turn's ask was checked too");
      assertCheckedAlone(check, 1);
      assert.equal(await readFile(proofFile, "utf8").catch(() => null), null, "refused both times");
      const last = JSON.stringify(session.requests.at(-1));
      assert.ok(last.includes(SESSION_PROMPT), "the resumed turn carries the session's history");
    } finally {
      await session.close();
      await check.close();
    }
  });

  it("a command inside its box runs without a check", async () => {
    const session = await startFakeResponses(["node", PROBE_FILE]);
    const check = await startFakeAnswer('{"decision":"deny","reason":"it should never be asked"}');
    try {
      const { turn, asked, proofFile } = await autoSession(session, check, { inside: true });
      const result = await turn();
      const detail = `${result.ok ? "ok" : result.errorText}; output ${session.commandOutput()}`;
      assert.equal(result.ok, true, detail);
      assert.equal(await readFile(proofFile, "utf8").catch(() => null), PROOF.text, detail);
      assert.equal(check.requests.length, 0, "ordinary work in its folder is never checked");
      assert.equal(asked.length, 0);
    } finally {
      await session.close();
      await check.close();
    }
  });

  it("a worker in Auto: its ask is checked on the app server too", async () => {
    const session = await startFakeResponses(["node", PROBE_FILE], { escalated: { justification: JUSTIFICATION } });
    const check = await startFakeAnswer('{"decision":"allow","reason":"it writes a proof file the person asked for"}');
    try {
      const { turn, proofFile } = await autoSession(session, check, { seat: AutoSeat.Worker });
      const result = await turn();
      const detail = `${result.ok ? "ok" : result.errorText}; output ${session.commandOutput()}`;
      assert.equal(result.ok, true, detail);
      assert.equal(check.requests.length, 1, detail);
      assertCheckedAlone(check, 0);
      assert.equal(await readFile(proofFile, "utf8").catch(() => null), PROOF.text, detail);
    } finally {
      await session.close();
      await check.close();
    }
  });
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

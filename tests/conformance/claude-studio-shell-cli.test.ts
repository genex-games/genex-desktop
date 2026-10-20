/**
 * The studio shell end to end, with the real Claude Code CLI and Genex's real sandbox.
 *
 * The CLI talks to `fake-anthropic.ts` (a dummy OAuth token, no account, nothing billed), whose
 * scripted turn runs one command. The engine is told it runs on Windows, so the session gets no
 * sandbox of Claude Code's and runs the command through the studio's `run_command` in a real
 * `ProcessSandbox` (this platform's backend). Opt-in, like every test that needs this machine's
 * own programs: `STUDIO_CLAUDE_CLI_TESTS=1` with a `claude` the engine can find.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { NeverTouchKind } from "../../src/substrate/engines/never-touch.ts";
import {
  CLAUDE_WORKER_COMMAND,
  CLAUDE_WORKER_PROOF,
  type FakeAnthropic,
  startFakeAnthropic,
} from "../helpers/fake-anthropic.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_CLAUDE_CLI_TESTS === "1";

/** A worker's folder beside another game, and the engine told it runs on Windows. */
async function workerOnWindows() {
  const root = await realpath(await tmpDir("studio-claude-shell-cli-"));
  const copy = path.join(root, "workers", "copy-1");
  const otherGame = path.join(root, "games", "other");
  for (const dir of [copy, otherGame]) await mkdir(dir, { recursive: true });
  const engine = new ClaudeCodeEngine({
    engineHome: path.join(root, "engine-home"),
    systemHome: path.join(root, "no-system-login"),
    platform: "win32",
    scratchRoot: path.join(root, "scratch"),
  });
  const delegate = () =>
    engine.delegate({
      prompt: "Run the command.",
      cwd: copy,
      timeoutMs: 120_000,
      worker: {
        id: "w1",
        title: "Proof writer",
        mode: PermissionMode.Auto,
        writeRoots: [copy],
        neverTouch: { roots: [{ path: otherGame, kind: NeverTouchKind.OtherGame }], open: [copy] },
        research: false,
      },
    } as never);
  return { copy, otherGame, delegate };
}

/** One scripted turn against the fake, its command the one given. */
async function withFake<T>(command: string, body: (fake: FakeAnthropic) => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const fake = await startFakeAnthropic({ command });
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.ANTHROPIC_BASE_URL = fake.baseUrl;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token";
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  try {
    return await body(fake);
  } finally {
    process.env = saved;
    await fake.close();
  }
}

describe("a Claude worker's command runs in Genex's sandbox (real CLI)", {
  skip: !LIVE && "STUDIO_CLAUDE_CLI_TESTS=1",
}, () => {
  it("a worker on Windows is not refused, its command runs through run_command and writes its folder", async () => {
    const { copy, delegate } = await workerOnWindows();
    await withFake(CLAUDE_WORKER_COMMAND, async (fake) => {
      const result = await delegate();
      assert.equal(result.ok, true, `${result.stopReason}: ${result.errorText ?? result.summary}`);
      assert.equal(fake.calledShell(), "mcp__studio__run_command", "offered the studio's shell, not Bash");
      const proof = await readFile(path.join(copy, CLAUDE_WORKER_PROOF.file), "utf8");
      assert.equal(proof, CLAUDE_WORKER_PROOF.text, "the command wrote the worker's folder");
    });
  });

  it("a command that hides its target from the screen still cannot write another game: the box holds", async () => {
    const { otherGame, delegate } = await workerOnWindows();
    const stolen = path.join(otherGame, "stolen.txt");
    // The never-touch screen reads paths in a command line; this one names none until it runs.
    const hidden = Buffer.from(`printf x > '${stolen}'`).toString("base64");
    await withFake(`eval "$(echo ${hidden} | base64 -d)"`, async (fake) => {
      await delegate();
      assert.equal(fake.calledShell(), "mcp__studio__run_command");
      await assert.rejects(readFile(stolen), { code: "ENOENT" }, "nothing was written outside the box");
    });
  });
});

/**
 * Claude Code's shell commands where its own sandbox cannot start (Windows).
 *
 * Claude Code has no sandbox on Windows, and a worker required one, so every Claude worker there
 * was refused. There a session that runs commands unasked instead loses Claude Code's own shell
 * tools and runs each command through the studio's `run_command` tool, in Genex's own sandbox (the
 * box local sessions already use). The CLI itself runs as before, so its sign-in and its network
 * are untouched. The SDK's `query()` is injected and the sandbox faked: what is proven is the
 * engine's half, from the options it really passed and the handler it really registered.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { NeverTouchKind, type NeverTouchList } from "../../src/substrate/engines/never-touch.ts";
import type { CommandSandbox } from "../../src/substrate/engines/session-commands.ts";
import type { PermissionReply, WorkerAsks, WorkerSeat } from "../../src/substrate/engines/types.ts";
import type { RunRequest, RunResult, SandboxOptions } from "../../src/substrate/spawn.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { scriptedClaude } from "../helpers/scripted-claude.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

type Options = Record<string, unknown>;
type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

const RUN_COMMAND = "mcp__studio__run_command";
/** Claude Code's built-ins that start a process of their own: none may reach a session boxed by Genex. */
const PROCESS_TOOLS = ["Bash", "PowerShell", "Monitor", "REPL", "Workflow", "CronCreate", "ScheduleWakeup"];

/** A sandbox that records how it was made and what it ran, and answers every run. */
function fakeSandboxes() {
  const made: SandboxOptions[] = [];
  const runs: RunRequest[] = [];
  let disposed = 0;
  const create = async (options: SandboxOptions): Promise<CommandSandbox> => {
    made.push(options);
    return {
      run: async (request: RunRequest): Promise<RunResult> => {
        runs.push(request);
        return {
          code: 0,
          signal: null,
          stdout: "ok from the box",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          truncated: false,
          sandboxed: true,
          command: request.command,
          cwd: request.cwd,
        };
      },
      dispose: async () => {
        disposed++;
      },
    };
  };
  return { create, made, runs, disposed: () => disposed };
}

async function fixture() {
  const root = await realpath(await tmpDir("studio-claude-win-commands-"));
  const userData = path.join(root, "userData");
  const copy = path.join(userData, "scratch", "workers", "copy-1");
  const granted = path.join(root, "refs");
  const otherGame = path.join(root, "games", "other");
  const engineHome = path.join(userData, "engine-homes", "claude");
  for (const dir of [copy, granted, otherGame, engineHome]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(engineHome, ".credentials.json"), "{}");
  const list: NeverTouchList = {
    roots: [
      { path: path.join(os.homedir(), ".codex", "auth.json"), kind: NeverTouchKind.Login },
      { path: userData, kind: NeverTouchKind.GenexData },
      { path: otherGame, kind: NeverTouchKind.OtherGame },
    ],
    open: [copy],
  };
  return { root, userData, copy, granted, otherGame, engineHome, list };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function workerAsks(): WorkerAsks {
  return {
    mode: PermissionMode.Manual,
    allow: [],
    directories: [],
    protectWrites: [],
    ask: async (): Promise<PermissionReply> => ({ decision: "allow" }),
    screen: async () => null,
    worker: { id: "w1", title: "Scene builder" },
  };
}

function seat(f: Fixture, mode: PermissionMode): WorkerSeat {
  return {
    id: "w1",
    title: "Scene builder",
    mode,
    writeRoots: [f.copy, f.granted],
    neverTouch: f.list,
    research: false,
    asks: workerAsks(),
  };
}

/** One delegation on the platform named; the session's options, its tool calls and its sandboxes. */
async function session(
  f: Fixture,
  platform: NodeJS.Platform,
  request: Record<string, unknown>,
  plan: Array<{ tool: string; args?: Record<string, unknown> }> = [],
) {
  const scripted = scriptedClaude(plan);
  const sandboxes = fakeSandboxes();
  const engine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: f.engineHome,
    systemHome: path.join(f.root, "no-system-login"),
    queryFn: scripted.queryFn,
    protectedPaths: [path.dirname(f.engineHome)],
    platform,
    scratchRoot: path.join(f.root, "scratch"),
    commandSandbox: sandboxes.create,
  });
  const result = await engine.delegate({ prompt: "build the scene", cwd: f.copy, ...request } as never);
  const options = scripted.options;
  assert.ok(options, "a session started");
  return { options: options as Options, scripted, sandboxes, result };
}

const WRITER_MODES = [
  PermissionMode.Bypass,
  PermissionMode.Auto,
  PermissionMode.AcceptEdits,
  PermissionMode.Manual,
] as const;

/** Whether a studio tool is marked to load with the prompt, never deferred behind Claude Code's tool search. */
function alwaysLoaded(options: Options, tool: string): boolean {
  const servers = options.mcpServers as Record<
    string,
    { instance?: { _registeredTools?: Record<string, { _meta?: Record<string, unknown> }> } }
  >;
  return servers.studio?.instance?._registeredTools?.[tool]?._meta?.["anthropic/alwaysLoad"] === true;
}

/** The session offers Claude Code no built-in that starts a process, and runs commands through the studio. */
function assertStudioShell(options: Options, label: string): void {
  const builtIns = options.tools as string[] | undefined;
  assert.ok(Array.isArray(builtIns), `${label}: Claude Code's built-ins are an allowlist`);
  for (const tool of PROCESS_TOOLS) assert.equal(builtIns.includes(tool), false, `${label}: no ${tool}`);
  assert.ok((options.disallowedTools as string[]).includes("Bash"), `${label}: Bash is refused outright`);
  const sandbox = options.sandbox as { enabled?: boolean; failIfUnavailable?: boolean } | undefined;
  assert.notEqual(sandbox?.enabled, true, `${label}: Claude Code's own sandbox is not asked for`);
  assert.equal(sandbox?.failIfUnavailable, undefined, `${label}: nothing for the CLI to refuse`);
}

describe("Claude Code on Windows runs its commands in Genex's sandbox", () => {
  it("a worker in every writing mode starts with no sandbox of Claude Code's to refuse, and the studio's shell", async () => {
    const f = await fixture();
    for (const mode of WRITER_MODES) {
      const { options, scripted, result } = await session(f, "win32", { worker: seat(f, mode) });
      assertStudioShell(options, mode);
      assert.ok(scripted.tools.includes("run_command"), `${mode}: the studio registers its shell`);
      assert.equal(
        alwaysLoaded(options, "run_command"),
        true,
        `${mode}: its shell is never deferred behind tool search`,
      );
      const allowed = (options.allowedTools as string[]).includes(RUN_COMMAND);
      const unasked = mode === PermissionMode.Bypass || mode === PermissionMode.Auto;
      assert.equal(allowed, unasked, `${mode}: its commands run unasked only where Claude Code's box ran them unasked`);
      assert.notEqual(result.stopReason, "sandbox_unavailable", `${mode}: the worker is not refused`);
    }
  });

  it("a read-only worker (Plan) has no shell at all, and no sandbox of Claude Code's to refuse it either", async () => {
    const f = await fixture();
    const { options, scripted } = await session(f, "win32", { worker: seat(f, PermissionMode.Plan) });
    const sandbox = options.sandbox as { enabled?: boolean; failIfUnavailable?: boolean } | undefined;
    assert.notEqual(sandbox?.enabled, true, "Claude Code's sandbox cannot start on Windows");
    assert.equal(sandbox?.failIfUnavailable, undefined, "a reader is not refused");
    assert.equal(scripted.tools.includes("run_command"), false, "no studio shell");
    assert.ok((options.disallowedTools as string[]).includes("Bash"));
    assert.equal((options.allowedTools as string[]).includes(RUN_COMMAND), false);
  });

  it("an unattended builder with no seat, which used to get a blanket Bash, gets the studio's shell instead", async () => {
    const f = await fixture();
    const { options, scripted } = await session(f, "win32", {});
    assertStudioShell(options, "builder");
    assert.equal((options.allowedTools as string[]).includes("Bash"), false, "no blanket Bash with no box behind it");
    assert.ok((options.allowedTools as string[]).includes(RUN_COMMAND), "its boxed commands run unasked");
    assert.ok(scripted.tools.includes("run_command"));
  });

  it("a command runs in a box writing only the worker's folders, denying the sign-ins and the never-touch list", async () => {
    const f = await fixture();
    const { sandboxes, scripted } = await session(f, "win32", { worker: seat(f, PermissionMode.Auto) }, [
      { tool: "run_command", args: { command: "node --check main.js" } },
    ]);
    assert.equal(sandboxes.made.length, 1, "one sandbox for the session");
    const [box] = sandboxes.made;
    assert.ok(box);
    for (const root of [f.copy, f.granted]) assert.ok(box.writableRoots.includes(root), `writes ${root}`);
    assert.equal(box.writableRoots.includes(os.homedir()), false, "not the home folder outside Bypass");
    assert.ok(box.secretPaths.includes(f.otherGame), "never reads another game");
    assert.ok(box.secretPaths.includes(path.dirname(f.engineHome)), "never reads the studio's protected folders");
    assert.ok(
      box.secretPaths.some((p) => p === path.join(os.homedir(), ".claude")),
      "never reads the person's Claude sign-in",
    );
    assert.ok(box.denyWrite?.includes(f.otherGame), "never writes another game");
    const [run] = sandboxes.runs;
    assert.equal(run?.command, "node --check main.js");
    assert.equal(run?.cwd, f.copy);
    assert.deepEqual(run?.policy?.allowedDomains ?? [], [], "a command has no network");
    assert.equal(run?.policy?.denyRead, undefined, "the box holds the denies; none is stamped again per command");
    const [call] = scripted.calls;
    assert.equal(call?.isError, false);
    assert.match(call?.text ?? "", /ok from the box/);
    assert.match(call?.text ?? "", /exit code 0/);
    assert.equal(sandboxes.disposed(), 1, "the session's sandbox goes when the session does");
  });

  it("an unattended builder's box never writes the studio's secrets, either CLI's sign-in home or the borrowed login", async () => {
    const f = await fixture();
    const systemHome = path.join(f.root, "dot-claude");
    await mkdir(systemHome, { recursive: true });
    await writeFile(path.join(systemHome, ".credentials.json"), "{}");
    const secrets = path.join(f.root, "secrets");
    const sandboxes = fakeSandboxes();
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      // No sign-in of the studio's own: the session borrows the person's (`systemHome`).
      engineHome: path.join(f.root, "no-studio-login"),
      systemHome,
      queryFn: scriptedClaude([{ tool: "run_command", args: { command: "true" } }]).queryFn,
      protectedPaths: [secrets],
      platform: "win32",
      scratchRoot: path.join(f.root, "scratch"),
      commandSandbox: sandboxes.create,
    });
    await engine.delegate({ prompt: "build", cwd: f.copy } as never);
    const [box] = sandboxes.made;
    assert.ok(box, "the command ran in Genex's sandbox");
    for (const dir of [secrets, path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".claude"), systemHome]) {
      assert.ok(box.denyWrite?.includes(dir), `never writes ${dir}`);
      assert.ok(box.secretPaths.includes(dir) || dir === systemHome, `never reads ${dir}`);
    }
  });

  it("Bypass writes the home folder too, as Claude Code's Bypass box did", async () => {
    const f = await fixture();
    const { sandboxes } = await session(f, "win32", { worker: seat(f, PermissionMode.Bypass) }, [
      { tool: "run_command", args: { command: "true" } },
    ]);
    assert.ok(sandboxes.made[0]?.writableRoots.includes(os.homedir()));
  });

  it("a failing command reports its exit code as a failed call, never ending the session", async () => {
    const f = await fixture();
    const sandboxes = fakeSandboxes();
    const scripted = scriptedClaude([{ tool: "run_command", args: { command: "exit 3" } }]);
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: f.engineHome,
      systemHome: path.join(f.root, "no-system-login"),
      queryFn: scripted.queryFn,
      platform: "win32",
      scratchRoot: path.join(f.root, "scratch"),
      commandSandbox: async (options) => {
        const box = await sandboxes.create(options);
        return { ...box, run: async (request) => ({ ...(await box.run(request)), code: 3, stderr: "boom" }) };
      },
    });
    const result = await engine.delegate({ prompt: "x", cwd: f.copy, worker: seat(f, PermissionMode.Auto) } as never);
    assert.equal(result.ok, true);
    assert.equal(scripted.calls[0]?.isError, true);
    assert.match(scripted.calls[0]?.text ?? "", /exit code 3/);
    assert.match(scripted.calls[0]?.text ?? "", /boom/);
  });

  it("the never-touch screen reads the studio shell's command as it reads Bash's", async () => {
    const f = await fixture();
    const { options } = await session(f, "win32", { worker: seat(f, PermissionMode.Bypass) });
    const hooks = (options.hooks as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse;
    const [hook] = hooks[0]?.hooks ?? [];
    assert.ok(hook);
    // Quoted, as a command that reaches them must be under Git Bash on Windows (an unquoted
    // backslash is an escape there).
    const hostile = [
      `cat '${path.join(f.otherGame, "save.json")}'`,
      "cat ~/.codex/auth.json",
      `rm -rf '${path.join(f.userData, "runs")}'`,
    ];
    for (const command of hostile) {
      const answer = await hook({
        hook_event_name: "PreToolUse",
        tool_name: RUN_COMMAND,
        tool_input: { command },
        tool_use_id: "tu",
      });
      const output = answer.hookSpecificOutput as { permissionDecision?: string } | undefined;
      assert.equal(output?.permissionDecision, "deny", command);
    }
  });

  it("an asking worker's question about a command reaches the host as a shell command", async () => {
    const f = await fixture();
    const asked: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const worker = {
      ...seat(f, PermissionMode.Manual),
      asks: {
        ...workerAsks(),
        ask: async (question: { tool: string; input: Record<string, unknown> }): Promise<PermissionReply> => {
          asked.push(question);
          return { decision: "allow" };
        },
      },
    };
    const { options } = await session(f, "win32", { worker });
    const canUseTool = options.canUseTool as (
      tool: string,
      input: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    await canUseTool(
      RUN_COMMAND,
      { command: "npm test" },
      { signal: new AbortController().signal, toolUseID: "tu", suggestions: [] },
    );
    assert.equal(asked[0]?.tool, "Bash", "the person's card shows a command, as for Bash");
    assert.equal(asked[0]?.input.command, "npm test");
  });

  it("macOS and Linux keep Claude Code's own sandbox and its Bash (characterization)", async () => {
    const f = await fixture();
    for (const platform of ["darwin", "linux"] as const) {
      const { options, scripted, sandboxes } = await session(f, platform, { worker: seat(f, PermissionMode.Auto) });
      const sandbox = options.sandbox as { enabled: boolean; failIfUnavailable: boolean };
      assert.equal(sandbox.enabled, true, platform);
      assert.equal(sandbox.failIfUnavailable, true, platform);
      assert.equal("tools" in options, false, `${platform}: Claude Code keeps its own set`);
      assert.equal(scripted.tools.includes("run_command"), false, platform);
      assert.equal(sandboxes.made.length, 0, `${platform}: no Genex sandbox for its commands`);
    }
  });
});

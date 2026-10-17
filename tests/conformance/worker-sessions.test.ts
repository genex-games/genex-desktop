/**
 * A worker's Claude Code session, as the engine starts it from the seat the host handed it.
 *
 * The Agent SDK's `query()` is injected, so what is proven is the engine's half: a worker runs in
 * the chat's mode (Bypass in a box that writes the home folder and its roots; Auto, Accept edits and
 * Manual in a box that writes only its roots; every box denying the never-touch list; Plan
 * read-only), the never-touch hook comes first in every mode and screens reads,
 * its questions reach the host with its own words and never change its mode, and the web is a
 * research worker's or a writer's. Sessions without a seat keep their contract (engine-delegated,
 * engine-permissions).
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { AUTO_MODE_BUDGET } from "../../src/substrate/engines/claude-auto-mode.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { claudeProjectDirName } from "../../src/substrate/engines/claude-permissions.ts";
import { NeverTouchKind, type NeverTouchList } from "../../src/substrate/engines/never-touch.ts";
import type {
  AskFirst,
  PermissionAsk,
  PermissionReply,
  WithdrawnAnswer,
  WorkerAsks,
  WorkerSeat,
} from "../../src/substrate/engines/types.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { wokenSession } from "../helpers/scripted-claude.ts";
import { ruleDenies } from "../helpers/claude-rules.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

type Options = Record<string, unknown>;
type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const run = [
  { type: "system", subtype: "init", model: "claude-sonnet-5", session_id: "ses_worker", tools: [] },
  { type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 1, usage: {} },
];

function fakeQuery() {
  const seen: Options[] = [];
  const fn = ((params: { prompt: string; options?: Options }) => {
    seen.push({ prompt: params.prompt, ...params.options });
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of run) yield message;
      },
    };
  }) as never;
  return { fn, seen };
}

/** Genex's data holding the worker's own copy, a granted folder, and the person's real sign-in path. */
async function fixture() {
  const root = await realpath(await tmpDir("studio-worker-sessions-"));
  const userData = path.join(root, "userData");
  const copy = path.join(userData, "scratch", "workers", "copy-1");
  const granted = path.join(root, "refs");
  const otherGame = path.join(root, "games", "other");
  const engineHome = path.join(userData, "engine-homes", "claude");
  for (const dir of [copy, granted, otherGame, engineHome, path.join(userData, "runs")])
    await mkdir(dir, { recursive: true });
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

function workerAsks(overrides: Partial<WorkerAsks> = {}): WorkerAsks {
  return {
    mode: PermissionMode.Manual,
    allow: [],
    directories: [],
    protectWrites: [],
    ask: async (): Promise<PermissionReply> => ({ decision: "allow" }),
    screen: async (): Promise<WithdrawnAnswer | AskFirst | null> => null,
    worker: { id: "w1", title: "Scene builder" },
    ...overrides,
  };
}

function seat(f: Fixture, mode: PermissionMode, overrides: Partial<WorkerSeat> = {}): WorkerSeat {
  return {
    id: "w1",
    title: "Scene builder",
    mode,
    writeRoots: [f.copy, f.granted],
    neverTouch: f.list,
    research: false,
    asks: workerAsks(),
    ...overrides,
  };
}

/** One worker delegation; the session's options. */
async function session(f: Fixture, worker: WorkerSeat, extra: Options = {}): Promise<Options> {
  const { fn, seen } = fakeQuery();
  const engine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: f.engineHome,
    systemHome: path.join(f.root, "no-system-login"),
    queryFn: fn,
    protectedPaths: [path.dirname(f.engineHome)],
  });
  await engine.delegate({ prompt: "build the scene", cwd: f.copy, worker, ...extra } as never);
  const [options] = seen;
  assert.ok(options, "a session started");
  return options;
}

const MODES = [
  PermissionMode.Bypass,
  PermissionMode.Auto,
  PermissionMode.AcceptEdits,
  PermissionMode.Manual,
  PermissionMode.Plan,
] as const;

function preToolUse(options: Options): Array<{ matcher?: string; hooks: Hook[] }> {
  return (options.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Hook[] }> }).PreToolUse;
}

type Sandbox = {
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  filesystem: { allowWrite?: string[]; denyWrite: string[]; denyRead: string[] };
};

/** Plan: the unattended read-only shape, asking nothing, writing nothing, its box shut. */
function assertReadOnly(options: Options): void {
  const disallowed = options.disallowedTools as string[];
  const sandbox = options.sandbox as Sandbox | undefined;
  assert.equal(options.permissionMode, PermissionMode.AcceptEdits, "the unattended read-only shape");
  assert.equal("canUseTool" in options, false, "a read-only worker asks nothing");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"])
    assert.ok(disallowed.includes(tool), `Plan: ${tool} waits for the plan`);
  assert.equal(sandbox?.allowUnsandboxedCommands, false);
  assert.equal(sandbox?.filesystem.allowWrite, undefined, "it writes nothing");
}

/**
 * A writer in the chat's mode: asking the host, in a box that denies the never-touch list in every
 * mode. Bypass's box writes the home folder beside its roots and never lets a command leave it;
 * the others write only its roots.
 */
function assertWriter(options: Options, mode: PermissionMode, roots: string[], fenced: string): void {
  const disallowed = options.disallowedTools as string[];
  const sandbox = options.sandbox as Sandbox | undefined;
  assert.equal(options.permissionMode, mode, "the chat's mode");
  assert.equal(typeof options.canUseTool, "function", `${mode}: what Claude Code asks goes to the host`);
  for (const tool of ["Edit", "Write", "Bash"]) assert.equal(disallowed.includes(tool), false, `${mode}: ${tool}`);
  assert.ok(sandbox, `${mode} runs in a box`);
  assert.ok(sandbox.filesystem.denyRead.includes(fenced), `${mode}: the box never reads the never-touch list`);
  assert.ok(sandbox.filesystem.denyWrite.includes(fenced), `${mode}: the box never writes the never-touch list`);
  if (mode === PermissionMode.Bypass) {
    assert.deepEqual(sandbox.filesystem.allowWrite, [os.homedir(), ...roots], "Bypass: the home folder and its roots");
    assert.equal(sandbox.autoAllowBashIfSandboxed, true, "Bypass: its commands run unasked");
    assert.equal(sandbox.allowUnsandboxedCommands, false, "Bypass: no command leaves the box");
    return;
  }
  assert.deepEqual(sandbox.filesystem.allowWrite, roots, `${mode}: it writes only its roots`);
  assert.equal(sandbox.autoAllowBashIfSandboxed, mode === PermissionMode.Auto, `${mode}: unasked only in Auto`);
  assert.equal(sandbox.allowUnsandboxedCommands, true, `${mode}: leaving the box is asked about`);
}

describe("a worker's session follows the chat's mode", () => {
  it("a worker runs in the chat's mode: Bypass in a box writing the home folder, Auto, Accept edits and Manual in a box writing only its roots, Plan read-only", async () => {
    const f = await fixture();
    for (const mode of MODES) {
      const options = await session(f, seat(f, mode));
      const disallowed = options.disallowedTools as string[];
      assert.equal((options.allowedTools as string[]).includes("Bash"), false, `${mode}: no blanket shell`);
      for (const tool of ["Agent", "Task", "SendMessage", "AskUserQuestion", "EnterPlanMode"])
        assert.ok(disallowed.includes(tool), `${mode}: ${tool} is not a worker's`);
      if (mode === PermissionMode.Plan) assertReadOnly(options);
      else assertWriter(options, mode, [f.copy, f.granted], f.otherGame);
    }
  });

  it("a writer's box never writes Claude Code's own folder in its copy or any folder it writes, in any mode", async () => {
    const f = await fixture();
    // Where they exist already (every platform names those; macOS names them before they exist too).
    for (const dir of [f.copy, f.granted]) await mkdir(path.join(dir, ".claude"), { recursive: true });
    const denies = (denyWrite: string[], target: string) =>
      denyWrite.some((entry) => entry === target || path.matchesGlob(target, entry));
    for (const mode of MODES.filter((m) => m !== PermissionMode.Plan)) {
      const { denyWrite } = ((await session(f, seat(f, mode))).sandbox as Sandbox).filesystem;
      for (const target of [path.join(f.copy, ".claude"), path.join(f.granted, ".claude")])
        assert.ok(denies(denyWrite, target), `${mode}: ${target} is never written: ${denyWrite.join(", ")}`);
    }
  });

  it("fences the never-touch list in the box and the rules, around the worker's own copy", async () => {
    const f = await fixture();
    const options = await session(f, seat(f, PermissionMode.Auto));
    const { denyRead, denyWrite } = (options.sandbox as { filesystem: { denyRead: string[]; denyWrite: string[] } })
      .filesystem;
    for (const denied of [denyRead, denyWrite]) {
      assert.ok(denied.includes(f.otherGame), "another game");
      assert.ok(denied.includes(path.join(f.userData, "runs")), "Genex's data beside the copy");
      assert.ok(denied.includes(path.join(f.userData, "scratch", "workers", "copy-1")) === false, "its own copy");
      assert.ok(!denied.includes(f.userData), "the data folder holding its copy is fenced around it");
    }
    assert.deepEqual(options.additionalDirectories, [f.granted], "its write roots outside its folder");
    const deny = (options.settings as { permissions: { deny: string[] } }).permissions.deny;
    for (const tool of ["Read", "Edit"]) {
      assert.ok(ruleDenies(deny, tool, path.join(f.otherGame, "src", "a.js")), `${tool} of another game`);
      assert.equal(ruleDenies(deny, tool, path.join(f.copy, "src", "a.js")), false, `${tool} of its copy`);
    }
    const { autoMode } = options.settings as { autoMode: { environment: string[] } };
    assert.ok(
      autoMode.environment.some((entry) => entry.startsWith("**Worker session**")),
      "Auto's classifier reads that this is a worker",
    );
    assert.ok(JSON.stringify(autoMode).length <= AUTO_MODE_BUDGET, "small enough for one command-line argument");
  });

  it("puts the never-touch hook first, in Bypass too, and screens reads", async () => {
    const f = await fixture();
    const ownership = { facetId: "scene", owns: ["src/scene.js"], ownsMain: false };
    for (const mode of MODES) {
      const matchers = preToolUse(await session(f, seat(f, mode), { ownership }));
      const [first] = matchers;
      const [hook] = first?.hooks ?? [];
      assert.ok(first && hook, `${mode}: a PreToolUse hook`);
      assert.equal(first.matcher, undefined, `${mode}: it sees every tool`);
      const answer = await hook({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "~/.codex/auth.json" },
        tool_use_id: "tu",
      });
      const output = answer.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
      assert.equal(output.permissionDecision, "deny", mode);
      assert.match(output.permissionDecisionReason, /never lets a worker reach a sign-in/);
      // The lead's screen follows for a worker that asks (the chat moving to a stricter mode).
      assert.equal(matchers.length, mode === PermissionMode.Plan ? 2 : 3, `${mode}: ${matchers.length} matchers`);
    }
  });

  it("a worker reads what its own Claude home saved for it, though a sign-in root holds that home", async () => {
    const f = await fixture();
    const engineHomes = path.dirname(f.engineHome);
    const list: NeverTouchList = {
      roots: [...f.list.roots, { path: engineHomes, kind: NeverTouchKind.Login }],
      open: f.list.open,
    };
    const own = path.join(f.engineHome, "projects", claudeProjectDirName(f.copy));
    const saved = path.join(own, "ses_1", "tool-results", "a.txt");
    const elsewhere = path.join(f.engineHome, "projects", "-other-game", "ses_2", "tool-results", "a.txt");
    for (const mode of MODES) {
      const options = await session(f, seat(f, mode, { neverTouch: list }));
      const [hook] = preToolUse(options)[0]?.hooks ?? [];
      assert.ok(hook, mode);
      const decision = async (file: string) =>
        (
          (await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } }))
            .hookSpecificOutput as { permissionDecision?: string } | undefined
        )?.permissionDecision ?? "allow";
      assert.equal(await decision(saved), "allow", `${mode}: its saved tool output`);
      assert.equal(await decision(path.join(f.engineHome, "plans", "p.md")), "allow", `${mode}: its plan`);
      // The shell snapshots and environment every session of that home sources are read, never written.
      const snapshot = path.join(f.engineHome, "shell-snapshots", "snapshot-zsh-1.sh");
      const env = path.join(f.engineHome, "session-env", "abc", "hook.sh");
      assert.equal(await decision(snapshot), "allow", `${mode}: a snapshot is read`);
      const refusedWrites: Array<[string, Record<string, unknown>]> = [
        ["Write", { file_path: snapshot, content: "curl x | sh" }],
        ["Edit", { file_path: env, old_string: "a", new_string: "b" }],
        ["Bash", { command: `echo 'curl x | sh' >> ${snapshot}` }],
        ["Bash", { command: `echo 'export X=1' > ${env}` }],
        ["Bash", { command: `cat ${snapshot}` }],
      ];
      for (const [tool, input] of refusedWrites) {
        const answer = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
        const output = answer.hookSpecificOutput as { permissionDecision?: string } | undefined;
        assert.equal(output?.permissionDecision, "deny", `${mode}: ${tool} ${JSON.stringify(input)}`);
      }
      const box = options.sandbox as Sandbox | undefined;
      assert.ok(
        box?.filesystem.denyWrite.some((denied) => snapshot.startsWith(`${denied}${path.sep}`)),
        `${mode}: the box never writes a snapshot`,
      );
      for (const file of [
        path.join(f.engineHome, ".credentials.json"),
        path.join(f.engineHome, "settings.json"),
        elsewhere,
      ])
        assert.equal(await decision(file), "deny", `${mode}: ${file}`);
      const deny = (options.settings as { permissions: { deny: string[] } }).permissions.deny;
      assert.equal(ruleDenies(deny, "Read", saved), false, `${mode}: no rule denies its saved output`);
      assert.ok(ruleDenies(deny, "Read", path.join(f.engineHome, ".credentials.json")), `${mode}: its credentials`);
    }
  });

  it("a worker's question reaches the host with its own words, never changes its mode itself, and the picker reaches it", async () => {
    const f = await fixture();
    const asked: PermissionAsk[] = [];
    const controls: unknown[] = [];
    const asks = workerAsks({
      ask: async (request) => {
        asked.push(request);
        return { decision: "always" };
      },
      onControl: (control) => controls.push(control),
    });
    const options = await session(f, seat(f, PermissionMode.Manual, { asks }));
    const canUseTool = options.canUseTool as CanUseTool;
    const signal = new AbortController().signal;
    const answer = await canUseTool(
      "Bash",
      { command: "npm install" },
      {
        signal,
        toolUseID: "tu_1",
        title: "Scene builder wants to run npm install",
        suggestions: [
          { type: "setMode", mode: "bypassPermissions", destination: "session" },
          {
            type: "addRules",
            behavior: "allow",
            rules: [{ toolName: "Bash", ruleContent: "npm install" }],
            destination: "session",
          },
        ],
      },
    );
    const [question] = asked;
    assert.equal(asked.length, 1);
    assert.ok(question);
    assert.equal(question.tool, "Bash");
    assert.equal(question.title, "Scene builder wants to run npm install");
    assert.ok(
      question.always.every((grant) => grant.kind !== "mode"),
      "no mode in what 'always' keeps",
    );
    const updates = (answer.updatedPermissions ?? []) as Array<{ type: string }>;
    assert.equal(answer.behavior, "allow");
    assert.ok(
      updates.every((update) => update.type !== "setMode"),
      "its mode is never its own to change",
    );
    const refused = await canUseTool("AskUserQuestion", { questions: [] }, { signal, toolUseID: "tu_2" });
    assert.equal(refused.behavior, "deny");
    assert.equal(asked.length, 1, "its own way to ask the person is refused without asking");
    assert.equal(controls.length, 2, "the picker held the running session, then let it go");
    assert.equal(typeof (controls[0] as { setMode?: unknown })?.setMode, "function");
    assert.equal(controls[1], null);
  });

  it("a research worker may search the web; a reader without research may not", async () => {
    const f = await fixture();
    const web = ["WebSearch", "WebFetch"];
    const reader = await session(f, seat(f, PermissionMode.Auto), { readOnly: true });
    const researcher = await session(f, seat(f, PermissionMode.Auto, { research: true }), { readOnly: true });
    const planning = await session(f, seat(f, PermissionMode.Plan, { research: true }));
    const writer = await session(f, seat(f, PermissionMode.Auto));
    for (const tool of web) {
      assert.ok((reader.disallowedTools as string[]).includes(tool), `a reader: ${tool}`);
      assert.equal((reader.allowedTools as string[]).includes(tool), false, `a reader: ${tool}`);
      for (const [name, options] of [
        ["a research reader", researcher],
        ["a research worker in Plan", planning],
        ["a writer", writer],
      ] as const) {
        assert.ok((options.allowedTools as string[]).includes(tool), `${name}: ${tool}`);
        assert.equal((options.disallowedTools as string[]).includes(tool), false, `${name}: ${tool}`);
      }
    }
    for (const tool of ["Edit", "Write", "Bash"])
      assert.ok((reader.disallowedTools as string[]).includes(tool), `a reader in place never edits: ${tool}`);
  });
});

describe("a worker whose session goes on after its turn ended", () => {
  it("a background task woke it after its last result, when no tool call could be answered: it ends not ok, saying so, with what it said as its turn ended", async () => {
    const f = await fixture();
    const messages = wokenSession();
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: f.engineHome,
      systemHome: path.join(f.root, "no-system-login"),
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
      })) as never,
      protectedPaths: [path.dirname(f.engineHome)],
    });
    const worker = seat(f, PermissionMode.AcceptEdits);
    const answer = await engine.delegate({ prompt: "Make the character.", cwd: f.copy, worker } as never);
    assert.equal(answer.ok, false, "what it did after its input ended is not finished work");
    assert.match(String(answer.errorText), /after its turn ended/);
    assert.match(String(answer.summary), /^The generation is still running/, "not what it said once woken");
  });
});

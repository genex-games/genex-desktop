/**
 * Running lanes without a provider: the supervisor timestamps each stdout line on receipt and holds
 * the rail (SIGTERM to the group, SIGKILL after the wait, leftovers reaped); the raw lanes replay
 * synthetic Claude and Codex streams through a fake child and are judged by the typed guards; the
 * Genex lane launches a fake Electron that writes a lane report. The clock, spawn and process group
 * are fakes; no CLI or app is started.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { EvalCase } from "../../scripts/evals/case-types.ts";
import { type CliResolver, rawClaudeArgv } from "../../scripts/evals/lanes/argv.ts";
import {
  type ChildLike,
  installInterruptReaper,
  LANE_PID_FILE,
  liveGroups,
  OUTPUT_DRAIN_MS,
  RAIL_KILL_AFTER_MS,
  readLanePid,
  readStreamRecords,
  type SupervisorDeps,
  superviseProcess,
} from "../../scripts/evals/lanes/common.ts";
import { type ProductDefaults, runGenexAppLane } from "../../scripts/evals/lanes/genex-app.ts";
import {
  ContaminationFinding,
  claudeContamination,
  claudeInit,
  codexContamination,
  detectHarnessFailure,
  type HarnessEvidence,
  parseSkillsBlock,
  type RawLaneDeps,
  rawEndedHow,
  runRawLane,
  sameModel,
  streamEvents,
} from "../../scripts/evals/lanes/raw.ts";
import { laneById, readLaneRegistry } from "../../scripts/evals/lanes/registry.ts";
import type { LaneRunRequest } from "../../scripts/evals/lanes/types.ts";
import {
  AnswerPolicy,
  CaseExposure,
  CaseMode,
  CaseVisibility,
  EndedHow,
  HarnessFailure,
} from "../../scripts/evals/vocabulary.ts";
import {
  EVAL_LANE_EXIT,
  EVAL_LANE_REPORT_SCHEMA,
  EvalLaneErrorCode,
  type EvalLaneReport,
  type EvalLaneSpec,
} from "../../src/shared/eval-lane.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { EngineId } from "../../src/shared/providers.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const fixtures = path.join(repo, "tests/fixtures/evals/lanes");
const fixtureLines = (name: string): string[] =>
  fs.readFileSync(path.join(fixtures, name), "utf8").split("\n").filter(Boolean);
const registry = readLaneRegistry(repo);
const lane = (id: string) => {
  const row = laneById(registry, id);
  assert.ok(row, id);
  return row;
};

const temps: string[] = [];
const tempDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-lanes-run-")));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── the fake machine ────────────────────────────────────────────────────────────────────

/** What the fake child does once spawned. */
interface Behaviour {
  lines?: string[];
  /** Files it writes into its cwd, by relative path. */
  files?: Record<string, string>;
  /** Called with the spawn's argv and cwd before any line (to write rollouts or reports). */
  before?: (args: readonly string[], cwd: string) => void;
  exitCode?: number;
  /** `exit`: close on its own; `term`: run until SIGTERM; `stubborn`: run until SIGKILL. */
  mode?: "exit" | "term" | "stubborn";
  /** A group member outlives the leader until SIGTERM. */
  lingers?: boolean;
  /** A process outside the group keeps the leader's output open: it exits, its output never ends. */
  holdsOutput?: boolean;
}

interface Spawned {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  detached: boolean;
}

function fakeMachine(behaviour: Behaviour) {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const signals: string[] = [];
  const spawned: Spawned[] = [];
  let leaderAlive = false;
  let lingering = false;
  let close: (signal: NodeJS.Signals | null) => void = () => {};

  const advance = (ms: number): void => {
    now += ms;
    for (const timer of timers.filter((t) => t.live && t.at <= now).sort((a, b) => a.at - b.at)) {
      timer.live = false;
      timer.fn();
    }
  };

  const deps: SupervisorDeps = {
    clock: {
      now: () => now,
      setTimer: (fn, ms) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    },
    group: {
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL" || behaviour.mode !== "stubborn") lingering = false;
        const stops = signal === "SIGKILL" || (signal === "SIGTERM" && behaviour.mode === "term");
        if (leaderAlive && stops) close(signal);
      },
      alive: () => leaderAlive || lingering,
      sleep: async (ms) => advance(ms),
    },
    spawn: (file, args, options) => {
      const emitter = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const record: Spawned = {
        file,
        args,
        cwd: String(options.cwd),
        env: options.env ?? {},
        stdin: "",
        detached: options.detached === true,
      };
      stdin.on("data", (chunk: Buffer) => {
        record.stdin += chunk.toString("utf8");
      });
      spawned.push(record);
      leaderAlive = true;
      lingering = behaviour.lingers === true;
      close = (signal) => {
        leaderAlive = false;
        const code = signal ? null : (behaviour.exitCode ?? 0);
        setImmediate(() => emitter.emit("exit", code, signal));
        if (behaviour.holdsOutput) return;
        stdout.end();
        stderr.end();
        setImmediate(() => emitter.emit("close", code, signal));
      };
      queueMicrotask(() => {
        behaviour.before?.(args, record.cwd);
        for (const [name, text] of Object.entries(behaviour.files ?? {}))
          fs.writeFileSync(path.join(record.cwd, name), text);
        for (const line of behaviour.lines ?? []) stdout.write(`${line}\n`);
        stderr.write("warming up\n");
        if ((behaviour.mode ?? "exit") === "exit") close(null);
      });
      const child: ChildLike = Object.assign(emitter, { pid: 4242, stdin, stdout, stderr });
      return child;
    },
  };
  return { deps, advance, signals, spawned, now: () => now };
}

// ── a request ───────────────────────────────────────────────────────────────────────────

const evalCase: EvalCase = {
  id: "tiny-pong",
  number: 1,
  label: "Tiny pong",
  brief: "Make a tiny pong game.",
  mode: CaseMode.Build,
  exposure: CaseExposure.None,
  exposureReason: null,
  visibility: CaseVisibility.Public,
  acceptance: [],
  followUps: [],
  deadlineMin: 90,
  version: "0123456789ab",
  checklistVersion: "0123456789ab",
  startFrom: null,
};

function request(laneId: string, root: string, overrides: Partial<LaneRunRequest> = {}): LaneRunRequest {
  const runId = `20261001T120000-tiny-pong-${laneId}-r1`;
  return {
    runId,
    campaignId: "c1",
    lane: lane(laneId),
    evalCase,
    rep: 1,
    workRoot: path.join(root, "evals", "work", runId),
    laneRoot: path.join(root, "evals", "work", runId),
    homes: { claude: path.join(root, "evals", "homes", "claude"), codex: path.join(root, "evals", "homes", "codex") },
    appBuild: null,
    deadlineMs: 60_000,
    graceMs: 5_000,
    suffix: "You have about 1 minutes.",
    deliverable: null,
    answerPolicy: AnswerPolicy.NoAnswers,
    maxAnswers: 3,
    live: true,
    interleaveSeed: "seed",
    coRunLane: null,
    templateDigest: null,
    ...overrides,
  };
}

function rawDeps(machine: ReturnType<typeof fakeMachine>, root: string, extra: Partial<RawLaneDeps> = {}): RawLaneDeps {
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return {
    supervisor: machine.deps,
    resolveCli: async (engine) => ({
      path: `/fake/bin/${engine}-cli`,
      version: engine === EngineId.Codex ? "0.159.0" : "2.1.284",
    }),
    hostSkillsDir: path.join(root, "host-skills"),
    operatorNames: async () => ({ skills: new Set(["my-own-skill"]), agents: new Set(["my-helper"]) }),
    permissionMode: PermissionMode.Auto,
    readQuota: async () => ({
      measuredAt: "2026-10-01T12:00:00.000Z",
      windows: [{ id: "five_hour", label: "5h", percent: 10 }],
    }),
    parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test", GENEX_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o" },
    home,
    node: process.execPath,
    lookAtPageScript: async () => "/installed/look-at-page.ts",
    ...extra,
  };
}

/** Write the synthetic rollout into the Codex eval home; its skills block names `listedHome` as the home. */
function writeRollout(codexHome: string, listedHome: string): void {
  const dir = path.join(codexHome, "sessions", "2026", "10", "01");
  fs.mkdirSync(dir, { recursive: true });
  const text = fs
    .readFileSync(path.join(fixtures, "codex-rollout.jsonl"), "utf8")
    .replaceAll("{{CODEX_HOME}}", listedHome);
  fs.writeFileSync(path.join(dir, "rollout-2026-10-01T00-00-00-0000aaaa-0000-7000-8000-000000000001.jsonl"), text);
}

// ── the supervisor ──────────────────────────────────────────────────────────────────────

describe("supervisor", () => {
  const run = (root: string, railMs = 10_000) => ({
    file: "/fake/bin/tool",
    args: ["--flag"],
    cwd: root,
    env: { PATH: "/usr/bin" },
    stdin: "the prompt",
    streamPath: path.join(root, "stream.jsonl"),
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    railMs,
  });

  it("writes each stdout line as a record stamped on receipt, keeps raw output and feeds stdin", async () => {
    const root = tempDir();
    const machine = fakeMachine({ lines: ['{"a":1}', "not json", '{"b":2}'], exitCode: 0 });
    const outcome = await superviseProcess(run(root), machine.deps);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.railFired, false);
    assert.equal(outcome.lines, 3);
    const records = readStreamRecords(fs.readFileSync(path.join(root, "stream.jsonl"), "utf8"));
    assert.deepEqual(
      records.map((r) => r.line),
      ['{"a":1}', "not json", '{"b":2}'],
    );
    assert.ok(records.every((r) => r.receivedAt === 1_000_000));
    assert.equal(fs.readFileSync(path.join(root, "stdout.log"), "utf8"), '{"a":1}\nnot json\n{"b":2}\n');
    assert.equal(fs.readFileSync(path.join(root, "stderr.log"), "utf8"), "warming up\n");
    assert.equal(machine.spawned[0]?.stdin, "the prompt");
    assert.equal(machine.spawned[0]?.detached, true);
    assert.deepEqual(machine.signals, []);
  });

  it("SIGTERMs the group when the rail fires and reports the rail", async () => {
    const root = tempDir();
    const machine = fakeMachine({ lines: ['{"a":1}'], mode: "term" });
    const pending = superviseProcess(run(root, 10_000), machine.deps);
    await tick();
    machine.advance(9_999);
    assert.deepEqual(machine.signals, []);
    machine.advance(1);
    const outcome = await pending;
    assert.equal(outcome.railFired, true);
    assert.equal(outcome.sigkilled, false);
    assert.equal(outcome.signal, "SIGTERM");
    assert.deepEqual(machine.signals, ["SIGTERM"]);
  });

  /** An interrupt reaper over the fake machine: the handlers it registers and the exit codes it asks for. */
  function fakeInterrupts(machine: ReturnType<typeof fakeMachine>) {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    let onExit: () => void = () => {};
    installInterruptReaper({
      onSignal: (signal, handler) => handlers.set(signal, handler),
      onExit: (handler) => {
        onExit = handler;
      },
      group: machine.deps.group,
      exit: (code) => exits.push(code),
    });
    return { handlers, exits, exit: () => onExit() };
  }

  it("stops every live lane group on Ctrl-C before the campaign exits, never leaving it running", async () => {
    const root = tempDir();
    const machine = fakeMachine({ lines: ['{"a":1}'], mode: "term" });
    const interrupts = fakeInterrupts(machine);
    assert.deepEqual([...interrupts.handlers.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
    const pending = superviseProcess(run(root, 10 * 60_000), machine.deps);
    await tick();
    assert.deepEqual(liveGroups(), [4242]);
    interrupts.handlers.get("SIGINT")?.();
    const outcome = await pending;
    await tick();
    assert.deepEqual(machine.signals, ["SIGTERM"]);
    assert.equal(outcome.railFired, false);
    assert.deepEqual(interrupts.exits, [130]);
    assert.deepEqual(liveGroups(), []);
  });

  it("SIGKILLs a group that ignores the interrupt's SIGTERM, and kills what is left when the process exits", async () => {
    const root = tempDir();
    const machine = fakeMachine({ mode: "stubborn" });
    const interrupts = fakeInterrupts(machine);
    const pending = superviseProcess(run(root, 10 * 60_000), machine.deps);
    await tick();
    interrupts.handlers.get("SIGTERM")?.();
    await pending;
    await tick();
    assert.deepEqual(machine.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(interrupts.exits, [143]);
    const lingering = fakeMachine({ mode: "stubborn" });
    const left = fakeInterrupts(lingering);
    const stillRunning = superviseProcess(run(tempDir(), 10 * 60_000), lingering.deps);
    await tick();
    left.exit();
    await stillRunning;
    assert.deepEqual(lingering.signals, ["SIGKILL"]);
  });

  it("records the group leader beside the run while it runs, so a resume can tell it is still live", async () => {
    const root = tempDir();
    const machine = fakeMachine({ mode: "term" });
    const pidPath = path.join(root, LANE_PID_FILE);
    const pending = superviseProcess({ ...run(root, 1_000), pidPath }, machine.deps);
    await tick();
    assert.equal(readLanePid(fs.readFileSync(pidPath, "utf8")), 4242);
    machine.advance(1_000);
    await pending;
    assert.equal(fs.existsSync(pidPath), false, "a reaped run leaves no pid behind");
  });

  it("SIGKILLs a group that ignores SIGTERM after the rail's wait", async () => {
    const root = tempDir();
    const machine = fakeMachine({ mode: "stubborn" });
    const pending = superviseProcess(run(root, 1_000), machine.deps);
    await tick();
    machine.advance(1_000);
    machine.advance(RAIL_KILL_AFTER_MS - 1);
    assert.deepEqual(machine.signals, ["SIGTERM"]);
    machine.advance(1);
    const outcome = await pending;
    assert.equal(outcome.sigkilled, true);
    assert.deepEqual(machine.signals, ["SIGTERM", "SIGKILL"]);
  });

  it("reaps what the leader left running in its group", async () => {
    const root = tempDir();
    const machine = fakeMachine({ lines: [], lingers: true });
    const outcome = await superviseProcess(run(root), machine.deps);
    assert.equal(outcome.railFired, false);
    assert.deepEqual(machine.signals, ["SIGTERM"]);
  });

  it("ends when the leader exits though a process outside its group keeps its output open", async () => {
    const root = tempDir();
    const machine = fakeMachine({ lines: ['{"a":1}'], exitCode: 0, holdsOutput: true });
    let outcome: Awaited<ReturnType<typeof superviseProcess>> | null = null;
    void superviseProcess(run(root), machine.deps).then((value) => {
      outcome = value;
    });
    for (let turn = 0; turn < 20 && outcome === null; turn++) {
      await tick();
      machine.advance(OUTPUT_DRAIN_MS);
    }
    assert.ok(outcome, "the supervisor still waits for output that nothing will close");
    const ended: Awaited<ReturnType<typeof superviseProcess>> = outcome;
    assert.equal(ended.exitCode, 0);
    assert.equal(ended.lines, 1);
    assert.equal(ended.railFired, false);
    assert.equal(fs.readFileSync(path.join(root, "stderr.log"), "utf8"), "warming up\n");
    assert.deepEqual(liveGroups(), []);
  });
});

// ── the typed guards ────────────────────────────────────────────────────────────────────

describe("harness guards", () => {
  const events = streamEvents(
    fixtureLines("claude-stream.jsonl")
      .map((line) => JSON.stringify({ receivedAt: 1, line }))
      .join("\n"),
  );
  const clean: HarnessEvidence = {
    engine: EngineId.ClaudeCode,
    events,
    spawnFailed: false,
    anyFile: true,
    findings: [],
    servedModel: "claude-opus-5-5",
    requestedModel: "claude-opus-5-5",
    versionChanged: false,
  };
  const rows: Array<[string, Partial<HarnessEvidence>, HarnessFailure | null]> = [
    ["a clean run", {}, null],
    ["a spawn that failed", { spawnFailed: true }, HarnessFailure.CliMissing],
    ["an empty stream", { events: [] }, HarnessFailure.EmptyStream],
    ["a CLI that changed under the run", { versionChanged: true }, HarnessFailure.CliChanged],
    ["a contamination finding", { findings: [ContaminationFinding.McpServers] }, HarnessFailure.Contamination],
    ["another served model", { servedModel: "claude-sonnet-5-5" }, HarnessFailure.ServedModelMismatch],
    ["no file written", { anyFile: false }, HarnessFailure.ZeroFiles],
    [
      "Claude's authentication_failed",
      { events: [{ type: "assistant", error: "authentication_failed" }] },
      HarnessFailure.AuthExpired,
    ],
    ["Claude's rate_limit", { events: [{ type: "assistant", error: "rate_limit" }] }, HarnessFailure.RateLimited],
    [
      "a rejected rate-limit window",
      { events: [{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }] },
      HarnessFailure.QuotaExhausted,
    ],
    ["a result naming 401", { events: [{ type: "result", api_error_status: 401 }] }, HarnessFailure.AuthExpired],
    [
      "Codex's typed usage limit",
      {
        engine: EngineId.Codex,
        events: [{ type: "turn.failed", error: { codex_error_info: "usage_limit_exceeded" } }],
      },
      HarnessFailure.QuotaExhausted,
    ],
    [
      "Codex's words alone (never matched as text)",
      { engine: EngineId.Codex, events: [{ type: "error", message: "You've hit your usage limit" }] },
      null,
    ],
  ];
  for (const [name, change, expected] of rows)
    it(`classifies ${name}`, () => assert.equal(detectHarnessFailure({ ...clean, ...change }), expected));

  it("maps the ending: rail first, then limits, other guards, max turns, a clean finish, else a crash", () => {
    const exit0 = { railFired: false, exitCode: 0 };
    const done = { finished: true, maxTurns: false };
    assert.equal(rawEndedHow({ railFired: true, exitCode: null }, null, done), EndedHow.Deadline);
    assert.equal(rawEndedHow(exit0, HarnessFailure.QuotaExhausted, done), EndedHow.RateLimited);
    assert.equal(rawEndedHow(exit0, HarnessFailure.ZeroFiles, done), EndedHow.HarnessFailure);
    assert.equal(rawEndedHow(exit0, null, { finished: false, maxTurns: true }), EndedHow.MaxTurns);
    assert.equal(rawEndedHow(exit0, null, done), EndedHow.AgentFinished);
    assert.equal(rawEndedHow({ railFired: false, exitCode: 1 }, null, done), EndedHow.Crash);
  });

  it("matches a served model exactly or as a dated or context-tagged variant", () => {
    assert.ok(sameModel("claude-opus-5-5", "claude-opus-5-5"));
    assert.ok(sameModel("claude-opus-5-5-20260901", "claude-opus-5-5"));
    assert.ok(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5"));
    assert.equal(sameModel("claude-opus-5", "claude-opus-5-5"), false);
    assert.equal(sameModel("claude-opus-5-5-fast", "claude-opus-5-5"), false);
  });

  it("checks Claude's init line against the pins", () => {
    const init = claudeInit(events);
    assert.ok(init);
    const pins = {
      permissionMode: PermissionMode.Auto,
      operator: { skills: new Set<string>(), agents: new Set<string>() },
    };
    assert.deepEqual(claudeContamination(init, pins), []);
    const dirty = {
      ...init,
      mcpServers: ["playwright"],
      plugins: 1,
      skills: ["genex-game-director"],
      agents: ["genex-helper"],
      permissionMode: PermissionMode.Bypass,
    };
    assert.deepEqual(
      claudeContamination(dirty, {
        ...pins,
        operator: { skills: new Set(["genex-game-director"]), agents: new Set(["genex-helper"]) },
      }),
      [
        ContaminationFinding.McpServers,
        ContaminationFinding.Plugins,
        ContaminationFinding.OperatorSkill,
        ContaminationFinding.OperatorAgent,
        ContaminationFinding.PermissionMode,
      ],
    );
    assert.deepEqual(claudeContamination(null, pins), [ContaminationFinding.InitMissing]);
  });

  it("expands a Codex skills block through its root table and flags any skill outside the stock root", () => {
    const block = [
      "<skills_instructions>",
      "- `r0` = `/evals/homes/codex/skills/.system`",
      "- `r1` = `/home/op/.agents/skills`",
      "- imagegen: Make a picture. (file: r0/imagegen/SKILL.md)",
      "- genex-helper: Help. (file: r1/genex-helper/SKILL.md)",
      "</skills_instructions>",
    ].join("\n");
    const skills = parseSkillsBlock(block);
    assert.deepEqual(skills, [
      { name: "imagegen", file: "/evals/homes/codex/skills/.system/imagegen/SKILL.md" },
      { name: "genex-helper", file: "/home/op/.agents/skills/genex-helper/SKILL.md" },
    ]);
    const facts = { found: true, model: "m", effort: "high", version: "1", skills, agentsInstructions: false };
    assert.deepEqual(codexContamination(facts, "/evals/homes/codex"), [ContaminationFinding.HostSkill]);
    assert.deepEqual(codexContamination({ ...facts, skills: skills.slice(0, 1) }, "/evals/homes/codex"), []);
    assert.deepEqual(codexContamination({ ...facts, found: false }, "/evals/homes/codex"), [
      ContaminationFinding.RolloutMissing,
    ]);
  });
});

// ── raw lanes ───────────────────────────────────────────────────────────────────────────

describe("raw Claude lane", () => {
  it("runs the fixture stream clean: argv, eval-home env, look-at-page shim, records and result", async () => {
    const root = tempDir();
    const machine = fakeMachine({ lines: fixtureLines("claude-stream.jsonl"), files: { "index.html": "<canvas>" } });
    const req = request("raw-claude", root);
    const result = await runRawLane(req, rawDeps(machine, root));
    assert.equal(result.endedHow, EndedHow.AgentFinished);
    assert.equal(result.harnessFailure, null);
    assert.equal(result.contaminationClean, true);
    assert.equal(result.cliVersion, "2.1.284");
    assert.equal(result.exitCode, 0);
    assert.equal(result.quotaBefore?.windows[0]?.percent, 10);
    const spawned = machine.spawned[0];
    assert.ok(spawned);
    const projectDir = path.join(req.workRoot, "project");
    assert.equal(spawned.cwd, projectDir);
    assert.equal(spawned.file, `/fake/bin/${EngineId.ClaudeCode}-cli`);
    const prompt = `Make a tiny pong game.\n\n${req.suffix}\n\n`;
    assert.ok(String(spawned.args.at(-1)).startsWith(prompt));
    assert.ok(String(spawned.args.at(-1)).includes("look-at-page <url>"));
    assert.deepEqual(
      spawned.args,
      rawClaudeArgv({
        model: "claude-opus-5-5",
        effort: "high",
        mcpConfigPath: path.join(req.workRoot, "pinned", "empty-mcp.json"),
        permissionMode: PermissionMode.Auto,
        prompt: String(spawned.args.at(-1)),
      }),
    );
    assert.equal(spawned.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(spawned.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(spawned.env.GENEX_TOKEN, undefined);
    assert.equal(spawned.env.CLAUDE_CONFIG_DIR, req.homes.claude);
    assert.equal(spawned.env.DISABLE_AUTOUPDATER, "1");
    const shimDir = path.join(req.workRoot, "bin");
    assert.equal(spawned.env.PATH, `${shimDir}${path.delimiter}/usr/bin`);
    assert.ok(fs.statSync(path.join(shimDir, "look-at-page")).mode & 0o100);
    const records = readStreamRecords(fs.readFileSync(result.artifacts.streamPath ?? "", "utf8"));
    assert.equal(records.length, 5);
  });

  const cases: Array<[string, Behaviour, HarnessFailure, EndedHow]> = [
    [
      "an expired sign-in",
      { lines: fixtureLines("claude-auth-expired.jsonl"), exitCode: 1 },
      HarnessFailure.AuthExpired,
      EndedHow.HarnessFailure,
    ],
    [
      "another served model",
      {
        lines: fixtureLines("claude-stream.jsonl").map((l) =>
          l.replace('"model":"claude-opus-5-5","permissionMode"', '"model":"claude-haiku-4-5","permissionMode"'),
        ),
        files: { "index.html": "x" },
      },
      HarnessFailure.ServedModelMismatch,
      EndedHow.HarnessFailure,
    ],
    [
      "an operator skill in the init line",
      {
        lines: fixtureLines("claude-stream.jsonl").map((l) =>
          l.replace('"skills":["review"]', '"skills":["my-own-skill"]'),
        ),
        files: { "index.html": "x" },
      },
      HarnessFailure.Contamination,
      EndedHow.HarnessFailure,
    ],
    [
      "a run that wrote nothing",
      { lines: fixtureLines("claude-stream.jsonl") },
      HarnessFailure.ZeroFiles,
      EndedHow.HarnessFailure,
    ],
    ["no output at all", { lines: [], exitCode: 1 }, HarnessFailure.EmptyStream, EndedHow.HarnessFailure],
  ];
  for (const [name, behaviour, failure, endedHow] of cases)
    it(`reports ${name} as ${failure}`, async () => {
      const root = tempDir();
      const machine = fakeMachine(behaviour);
      const result = await runRawLane(request("raw-claude", root), rawDeps(machine, root));
      assert.equal(result.harnessFailure, failure);
      assert.equal(result.endedHow, endedHow);
    });

  it("ends on the deadline when the rail fires", async () => {
    const root = tempDir();
    let spawnedNow = (): void => {};
    const started = new Promise<void>((resolve) => {
      spawnedNow = resolve;
    });
    const machine = fakeMachine({
      lines: fixtureLines("claude-stream.jsonl").slice(0, 2),
      mode: "term",
      files: { "a.js": "x" },
      before: () => spawnedNow(),
    });
    const req = request("raw-claude", root);
    const pending = runRawLane(req, rawDeps(machine, root));
    await started;
    machine.advance(req.deadlineMs + req.graceMs);
    const result = await pending;
    assert.equal(result.endedHow, EndedHow.Deadline);
    assert.deepEqual(machine.signals, ["SIGTERM"]);
  });

  it("spawns and creates nothing on a dry run or when the CLI is missing", async () => {
    for (const [overrides, extra, endedHow] of [
      [{ live: false }, {}, EndedHow.Cancelled],
      [{}, { resolveCli: async () => Promise.reject(new Error("not installed")) }, EndedHow.HarnessFailure],
    ] as const) {
      const root = tempDir();
      const machine = fakeMachine({ lines: fixtureLines("claude-stream.jsonl") });
      const req = request("raw-claude", root, overrides);
      const result = await runRawLane(req, rawDeps(machine, root, extra));
      assert.equal(result.endedHow, endedHow);
      assert.equal(machine.spawned.length, 0);
      assert.equal(fs.existsSync(req.workRoot), false);
    }
  });

  it("refuses a Genex lane", async () => {
    const root = tempDir();
    await assert.rejects(runRawLane(request("genex-claude", root), rawDeps(fakeMachine({}), root)));
  });
});

describe("raw Codex lane", () => {
  /** The fake Codex writes its parent rollout; `listedHome` is the home its skills block names. */
  const behaviour = (listedHome: (codexHome: string) => string): Behaviour => ({
    lines: fixtureLines("codex-stream.jsonl"),
    files: { "index.html": "<canvas>" },
    before: (_args, cwd) => {
      const evalsDir = path.dirname(path.dirname(path.dirname(cwd)));
      const codexHome = path.join(evalsDir, "homes", "codex");
      writeRollout(codexHome, listedHome(codexHome));
    },
  });

  it("runs the fixture stream clean: prompt on stdin, host skills disabled, stock skills only", async () => {
    const root = tempDir();
    const machine = fakeMachine(behaviour((home) => home));
    const deps = rawDeps(machine, root);
    fs.mkdirSync(path.join(deps.hostSkillsDir, "genex-helper"), { recursive: true });
    fs.writeFileSync(path.join(deps.hostSkillsDir, "genex-helper", "SKILL.md"), "s");
    const req = request("raw-codex", root);
    const result = await runRawLane(req, deps);
    assert.equal(result.harnessFailure, null, JSON.stringify(result));
    assert.equal(result.endedHow, EndedHow.AgentFinished);
    assert.equal(result.cliVersion, "0.159.0");
    const spawned = machine.spawned[0];
    assert.ok(spawned);
    assert.ok(spawned.stdin.startsWith("Make a tiny pong game."));
    assert.equal(spawned.args.at(-1), "-");
    assert.ok(
      spawned.args.includes(
        `skills.config=[{path="${path.join(deps.hostSkillsDir, "genex-helper", "SKILL.md")}",enabled=false}]`,
      ),
    );
    assert.ok(
      spawned.args.includes(`sandbox_workspace_write.writable_roots=["${path.join(req.workRoot, "project")}"]`),
    );
    assert.ok(spawned.args.includes("sandbox_workspace_write.network_access=true"));
    assert.equal(spawned.env.CODEX_HOME, req.homes.codex);
  });

  it("reports a host skill in the parent rollout as contamination", async () => {
    const root = tempDir();
    const hostRoot = "/home/op/.agents/skills";
    const machine = fakeMachine(behaviour(() => hostRoot));
    const result = await runRawLane(request("raw-codex", root), rawDeps(machine, root));
    assert.equal(result.harnessFailure, HarnessFailure.Contamination);
    assert.equal(result.contaminationClean, false);
  });

  it("reports a missing rollout as contamination: the skills cannot be checked", async () => {
    const root = tempDir();
    const machine = fakeMachine({ lines: fixtureLines("codex-stream.jsonl"), files: { "index.html": "x" } });
    const result = await runRawLane(request("raw-codex", root), rawDeps(machine, root));
    assert.equal(result.harnessFailure, HarnessFailure.Contamination);
  });
});

// ── the Genex app lane ──────────────────────────────────────────────────────────────────

describe("Genex app lane", () => {
  const defaults: ProductDefaults = { permissionMode: PermissionMode.Auto };
  const report = (spec: EvalLaneSpec, change: Partial<EvalLaneReport> = {}): EvalLaneReport => ({
    schema: EVAL_LANE_REPORT_SCHEMA,
    runId: spec.runId,
    laneId: spec.laneId,
    caseId: spec.caseId,
    engine: spec.engine,
    modelRequested: spec.model,
    modelServed: spec.model,
    effort: spec.effort,
    effortServed: null,
    appVersion: "0.0.0",
    harnessDigest: { workspace: "a", shipped: "a", matches: true },
    projectDir: path.join(spec.gamesRoot, "tiny-pong"),
    templateDigest: null,
    threadId: "t1",
    startedAt: "2026-10-01T12:00:00.000Z",
    endedAt: "2026-10-01T12:30:00.000Z",
    endedHow: EndedHow.AgentFinished,
    launch: "none",
    budgets: { completionPolicy: null } as EvalLaneReport["budgets"],
    runIds: [],
    permissionModeServed: spec.permissionMode,
    modeServed: "autopilot-until-satisfied",
    commissionSent: spec.commission,
    questionsAsked: 2,
    answers: [{ atMs: 5, question: "ask_user", questionId: "q1", policy: AnswerPolicy.NoAnswers }],
    firstPreviewProxyMs: null,
    cliVersions: { claude: "2.1.284", codex: null },
    fixture: spec.fixture,
    errors: [],
    ...change,
  });

  /** The fake app's exit code, and the CLI resolver the lane pins its executables with. */
  interface GenexOptions {
    exitCode?: number;
    resolveCli?: CliResolver;
  }

  async function runGenex(change: Partial<EvalLaneReport> | null, laneId = "genex-claude", options: GenexOptions = {}) {
    const root = tempDir();
    const specs: EvalLaneSpec[] = [];
    const machine = fakeMachine({
      ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
      before: (args) => {
        const specArg = args.find((arg) => arg.startsWith("--studio-eval-lane="));
        const spec = JSON.parse(fs.readFileSync(String(specArg).split("=")[1] ?? "", "utf8")) as EvalLaneSpec;
        specs.push(spec);
        if (change) fs.writeFileSync(spec.reportPath, JSON.stringify(report(spec, change)));
      },
    });
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const req = request(laneId, root, {
      appBuild: { sha: "a".repeat(40), dir: path.join(root, "build"), dirty: false },
    });
    const result = await runGenexAppLane(req, {
      supervisor: machine.deps,
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ permissionMode: defaults.permissionMode, addedGlobals: [] }),
        stderr: "",
      }),
      resolveElectron: () => "/fake/electron",
      resolveCli: options.resolveCli ?? (async (engine) => ({ path: `/opt/cli/${engine}`, version: "1.0.0" })),
      readQuota: null,
      parentEnv: {
        PATH: "/usr/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "o",
        GENEX_TOKEN: "t",
        CLAUDE_CONFIG_DIR: "/home/op/.claude",
      },
      home,
    });
    return { result, spec: specs[0], spawned: machine.spawned[0], req };
  }

  it("writes the spec from the build's own defaults, launches the smoke sub-runner and reads the report", async () => {
    const { result, spec, spawned, req } = await runGenex({});
    assert.ok(spec && spawned);
    assert.deepEqual(spec.commission, {});
    assert.equal(spec.permissionMode, PermissionMode.Auto);
    assert.equal(spec.codexHostSkillSuppression, false);
    assert.equal(spec.userDataRoot, path.join(req.workRoot, "userdata"));
    assert.equal(spawned.file, "/fake/electron");
    assert.ok(spawned.args.includes("--studio-smoke"));
    assert.ok(spawned.args.includes(`--userdata=${spec.userDataRoot}`));
    assert.equal(spawned.args.includes("--studio-eval-fixture"), false);
    assert.equal(spawned.env.STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS, "1");
    assert.equal(spawned.env.STUDIO_DISABLE_OS_CREDENTIALS, "1");
    assert.equal(spawned.env.CLAUDE_CONFIG_DIR, req.homes.claude);
    assert.equal(spawned.env.CODEX_HOME, req.homes.codex);
    assert.equal(spawned.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(spawned.env.GENEX_TOKEN, undefined);
    assert.equal(result.endedHow, EndedHow.AgentFinished);
    assert.equal(result.harnessFailure, null);
    assert.equal(result.questionsAsked, 2);
    assert.equal(result.answersGiven, 1);
    assert.equal(result.cliVersion, "2.1.284");
    assert.equal(result.contaminationClean, true);
  });

  it("suppresses host skills for Codex", async () => {
    const { spec } = await runGenex({}, "genex-codex-auto");
    assert.ok(spec);
    assert.equal(spec.codexHostSkillSuppression, true);
  });

  it("asks the app to turn a plugin-off lane's plugins off, and turns none off for its twin", async () => {
    const off = await runGenex({ plugins: [{ id: GENEX_PLUGIN_ID, enabled: false }] }, "genex-claude-plugin-off");
    assert.deepEqual(off.spec?.disabledPlugins, [GENEX_PLUGIN_ID]);
    assert.equal(off.result.harnessFailure, null);
    assert.equal(off.result.contaminationClean, true);
    const on = await runGenex({ plugins: [{ id: GENEX_PLUGIN_ID, enabled: true }] });
    assert.equal(on.spec?.disabledPlugins, undefined);
    assert.equal(on.result.harnessFailure, null);
  });

  const pluginLeftOn: Array<[string, Partial<EvalLaneReport>]> = [
    ["the plugin still on", { plugins: [{ id: GENEX_PLUGIN_ID, enabled: true }] }],
    ["the plugin missing from the report", { plugins: [] }],
    // A build from before plugin pins reads the spec, ignores the list and reports no plugins.
    ["no plugins at all, as a build that cannot turn one off writes it", {}],
  ];
  for (const [name, change] of pluginLeftOn)
    it(`types a plugin-off lane whose report shows ${name} as contamination`, async () => {
      const { result } = await runGenex(change, "genex-claude-plugin-off");
      assert.equal(result.harnessFailure, HarnessFailure.Contamination);
      assert.equal(result.contaminationClean, false);
    });

  it("types a harness that drifted from the seed, another served model and a missing report", async () => {
    const drifted = await runGenex({ harnessDigest: { workspace: "a", shipped: "b", matches: false } });
    assert.equal(drifted.result.harnessFailure, HarnessFailure.Contamination);
    const served = await runGenex({ modelServed: "claude-sonnet-5-5" });
    assert.equal(served.result.harnessFailure, HarnessFailure.ServedModelMismatch);
    const missing = await runGenex(null);
    assert.equal(missing.result.endedHow, EndedHow.Crash);
    assert.equal(missing.result.contaminationClean, false);
  });

  const appFailures: Array<[string, Partial<EvalLaneReport>, HarnessFailure]> = [
    [
      "an engine that was not ready",
      { endedHow: EndedHow.HarnessFailure, errors: [{ code: EvalLaneErrorCode.EngineNotReady, detail: "x" }] },
      HarnessFailure.EngineNotReady,
    ],
    [
      "a model the engine does not list",
      { endedHow: EndedHow.HarnessFailure, errors: [{ code: EvalLaneErrorCode.UnknownModel, detail: "x" }] },
      HarnessFailure.AppFailed,
    ],
    [
      "a thread that failed",
      { endedHow: EndedHow.HarnessFailure, errors: [{ code: EvalLaneErrorCode.ThreadFailed, detail: "x" }] },
      HarnessFailure.AppFailed,
    ],
    ["a harness-failure ending with no error code", { endedHow: EndedHow.HarnessFailure }, HarnessFailure.AppFailed],
  ];
  for (const [name, change, failure] of appFailures)
    it(`types ${name} as a ${failure} harness failure, as a raw lane types its own`, async () => {
      const { result } = await runGenex(change);
      assert.equal(result.harnessFailure, failure);
      assert.equal(result.endedHow, EndedHow.HarnessFailure);
    });

  it("keeps a stop that failed after the run as the agent's ending, not a harness failure", async () => {
    const { result } = await runGenex({ errors: [{ code: EvalLaneErrorCode.StopFailed, detail: "x" }] });
    assert.equal(result.harnessFailure, null);
    assert.equal(result.endedHow, EndedHow.AgentFinished);
  });

  for (const exitCode of [EVAL_LANE_EXIT.Refused, EVAL_LANE_EXIT.Failed])
    it(`types an app that exited ${exitCode} with no report as app-failed, not a Genex crash`, async () => {
      const { result } = await runGenex(null, "genex-claude", { exitCode });
      assert.equal(result.harnessFailure, HarnessFailure.AppFailed);
      assert.equal(result.endedHow, EndedHow.HarnessFailure);
    });

  it("pins a live Genex lane's CLIs to the paths the raw lanes resolve, and a fixture lane's to none", async () => {
    const live = await runGenex({});
    assert.deepEqual(live.spec?.executables, { claude: "/opt/cli/claude-code", codex: "/opt/cli/codex" });
    const partial = await runGenex({}, "genex-claude", {
      resolveCli: async (engine) => {
        if (engine === EngineId.Codex) throw new Error("Install this coding CLI");
        return { path: "/opt/cli/claude", version: null };
      },
    });
    assert.deepEqual(partial.spec?.executables, { claude: "/opt/cli/claude" });
    const asked: string[] = [];
    const fixture = await runGenex({}, "fixture-genex", {
      resolveCli: async (engine) => {
        asked.push(engine);
        return { path: "/opt/cli/x", version: null };
      },
    });
    assert.ok(fixture.spec);
    assert.equal(Object.hasOwn(fixture.spec, "executables"), false);
    assert.deepEqual(asked, []);
  });
});

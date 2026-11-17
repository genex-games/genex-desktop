/**
 * The Genex app eval lane's launch guard and log readers (evals plan §5.3): a `--studio-eval-lane`
 * launch is refused before any core starts unless it is a smoke launch, live providers are
 * explicitly allowed, the mode is not Bypass, and every root it writes sits inside the spec's
 * work root by real path, outside `~/AI Games` and the normal profile. Refusing creates nothing.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type EvalLaunchFacts,
  evalLaunchRefusal,
  openEvalLane,
  parseEvalLaunch,
  readLaneLog,
  readLaunch,
} from "../../src/main/smoke/eval-lane.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { AnswerPolicy, EvalLaunchRefusal, LaunchPath, QuestionKind } from "../../src/shared/eval-lane.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOME = "/Users/studio";
const WORK = `${HOME}/genex-evals/work/run-1`;
const SAFE: EvalLaunchFacts = {
  smoke: true,
  live: false,
  liveAllowed: false,
  permissionMode: PermissionMode.Auto,
  workRoot: WORK,
  roots: [`${WORK}/userdata`, `${WORK}/games`, `${WORK}/report`],
  aiGames: `${HOME}/AI Games`,
  defaultUserData: `${HOME}/Library/Application Support/Genex`,
};

describe("eval launch refusal (pure)", () => {
  const TABLE: Array<{ name: string; facts: Partial<EvalLaunchFacts>; refusal: EvalLaunchRefusal | null }> = [
    { name: "a fixture smoke launch inside its work root runs", facts: {}, refusal: null },
    { name: "a live launch with the opt-in runs", facts: { live: true, liveAllowed: true }, refusal: null },
    { name: "not a smoke launch", facts: { smoke: false }, refusal: EvalLaunchRefusal.NotSmoke },
    { name: "live without the opt-in", facts: { live: true }, refusal: EvalLaunchRefusal.LiveNotAllowed },
    {
      name: "Bypass is never a lane's mode",
      facts: { permissionMode: PermissionMode.Bypass },
      refusal: EvalLaunchRefusal.BypassMode,
    },
    {
      name: "a work root that holds the normal games",
      facts: { workRoot: HOME, roots: [`${HOME}/eval/userdata`] },
      refusal: EvalLaunchRefusal.WorkRootTooBroad,
    },
    {
      name: "a work root that is the file system root",
      facts: { workRoot: "/", roots: ["/tmp/userdata"] },
      refusal: EvalLaunchRefusal.WorkRootTooBroad,
    },
    {
      name: "games in ~/AI Games",
      facts: { roots: [`${WORK}/userdata`, `${HOME}/AI Games/eval`] },
      refusal: EvalLaunchRefusal.InsideAiGames,
    },
    {
      name: "games that are ~/AI Games itself",
      facts: { roots: [`${HOME}/AI Games`] },
      refusal: EvalLaunchRefusal.InsideAiGames,
    },
    {
      name: "the normal profile's userData",
      facts: { roots: [SAFE.defaultUserData] },
      refusal: EvalLaunchRefusal.DefaultUserData,
    },
    {
      name: "a folder inside the normal profile",
      facts: { roots: [`${SAFE.defaultUserData}/eval`] },
      refusal: EvalLaunchRefusal.DefaultUserData,
    },
    {
      name: "a sibling run's folder",
      facts: { roots: [`${HOME}/genex-evals/work/run-2/games`] },
      refusal: EvalLaunchRefusal.OutsideWorkRoot,
    },
    {
      name: "a prefix-sharing sibling (run-1x)",
      facts: { roots: [`${WORK}x/games`] },
      refusal: EvalLaunchRefusal.OutsideWorkRoot,
    },
    {
      name: "a dot-dot escape",
      facts: { roots: [`${WORK}/games/../../run-2`] },
      refusal: EvalLaunchRefusal.OutsideWorkRoot,
    },
  ];
  for (const row of TABLE) {
    it(row.name, () => {
      assert.equal(evalLaunchRefusal({ ...SAFE, ...row.facts }), row.refusal);
    });
  }
});

/** A spec whose every path is inside `work`. */
function specIn(work: string, patch: Record<string, unknown> = {}) {
  return {
    runId: "20261001T120000-genex-claude-case-01-r1",
    laneId: "fixture-genex",
    caseId: "case-01",
    engine: EngineId.ClaudeCode,
    model: "fixture-v1",
    effort: "high",
    brief: "A small synthetic game brief.",
    suffix: "You have about 90 minutes.",
    commission: {},
    permissionMode: PermissionMode.Auto,
    deadlineMs: 60_000,
    graceMs: 5_000,
    answerPolicy: AnswerPolicy.NoAnswers,
    maxAnswers: 3,
    codexHostSkillSuppression: false,
    gamesRoot: path.join(work, "games"),
    userDataRoot: path.join(work, "userdata"),
    workRoot: work,
    homes: { claude: path.join(work, "homes", "claude"), codex: path.join(work, "homes", "codex") },
    reportPath: path.join(work, "report", "lane-report.json"),
    fixture: true,
    ...patch,
  };
}

/** Every entry under `dir`, recursively, as relative paths: what a refused launch must leave unchanged. */
async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

/** A run's work folder beside a fake home with its games and profile. */
async function layout() {
  const base = await tmpDir("studio-eval-guard-");
  const work = path.join(base, "work", "run-1");
  const aiGames = path.join(base, "home", "AI Games");
  const defaultUserData = path.join(base, "home", "Library", "Genex");
  await mkdir(work, { recursive: true });
  await mkdir(aiGames, { recursive: true });
  await mkdir(defaultUserData, { recursive: true });
  return { base, work, aiGames, defaultUserData };
}

type Dirs = Awaited<ReturnType<typeof layout>>;

/** Open a launch whose spec file holds `spec` (text as is, anything else as JSON). */
async function open(
  dirs: Dirs,
  spec: unknown,
  input: { smoke?: boolean; userData?: string; devLaunch?: boolean } = {},
) {
  const file = path.join(dirs.base, "spec.json");
  await writeFile(file, typeof spec === "string" ? spec : JSON.stringify(spec));
  return openEvalLane({
    file,
    smoke: input.smoke ?? true,
    devLaunch: input.devLaunch ?? false,
    fixtureFlag: false,
    liveAllowed: false,
    userData: input.userData ?? path.join(dirs.work, "userdata"),
    aiGames: dirs.aiGames,
    defaultUserData: dirs.defaultUserData,
  });
}

/** Specs and launches that must be refused, each laid out in a fresh folder first. */
const HOSTILE: Array<{
  name: string;
  prepare: (dirs: Dirs) => Promise<{ spec: unknown; smoke?: boolean; userData?: string; devLaunch?: boolean }>;
  refusal: EvalLaunchRefusal;
}> = [
  {
    name: "games reached through a link out of the work root",
    prepare: async (dirs) => {
      const outside = path.join(dirs.base, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(dirs.work, "escape"));
      return { spec: specIn(dirs.work, { gamesRoot: path.join(dirs.work, "escape", "games") }) };
    },
    refusal: EvalLaunchRefusal.OutsideWorkRoot,
  },
  {
    name: "games reached through a link into ~/AI Games",
    prepare: async (dirs) => {
      await symlink(dirs.aiGames, path.join(dirs.work, "games-link"));
      return { spec: specIn(dirs.work, { gamesRoot: path.join(dirs.work, "games-link") }) };
    },
    refusal: EvalLaunchRefusal.InsideAiGames,
  },
  {
    name: "a dangling link on the way to the report",
    prepare: async (dirs) => {
      await symlink(path.join(dirs.base, "nowhere"), path.join(dirs.work, "dangling"));
      return { spec: specIn(dirs.work, { reportPath: path.join(dirs.work, "dangling", "r", "report.json") }) };
    },
    refusal: EvalLaunchRefusal.OutsideWorkRoot,
  },
  {
    name: "the launch's own data folder outside the work root",
    prepare: async (dirs) => ({ spec: specIn(dirs.work), userData: path.join(dirs.base, "elsewhere") }),
    refusal: EvalLaunchRefusal.OutsideWorkRoot,
  },
  {
    name: "the launch's data folder is the normal profile",
    prepare: async (dirs) => ({ spec: specIn(dirs.work), userData: dirs.defaultUserData }),
    refusal: EvalLaunchRefusal.DefaultUserData,
  },
  {
    name: "a live spec without the opt-in",
    prepare: async (dirs) => ({ spec: specIn(dirs.work, { fixture: false }) }),
    refusal: EvalLaunchRefusal.LiveNotAllowed,
  },
  {
    name: "a Bypass spec",
    prepare: async (dirs) => ({ spec: specIn(dirs.work, { permissionMode: PermissionMode.Bypass }) }),
    refusal: EvalLaunchRefusal.BypassMode,
  },
  {
    name: "not a smoke launch",
    prepare: async (dirs) => ({ spec: specIn(dirs.work), smoke: false }),
    refusal: EvalLaunchRefusal.NotSmoke,
  },
  {
    name: "a developer launch, whose core runs on its dev profile and games, not the checked roots",
    prepare: async (dirs) => ({ spec: specIn(dirs.work), devLaunch: true }),
    refusal: EvalLaunchRefusal.DevLaunch,
  },
  {
    name: "a spec that is not JSON",
    prepare: async () => ({ spec: "{ not json" }),
    refusal: EvalLaunchRefusal.InvalidSpec,
  },
  {
    name: "a relative games root",
    prepare: async (dirs) => ({ spec: specIn(dirs.work, { gamesRoot: "games" }) }),
    refusal: EvalLaunchRefusal.InvalidSpec,
  },
  {
    name: "an unknown engine",
    prepare: async (dirs) => ({ spec: specIn(dirs.work, { engine: "gpt-cli" }) }),
    refusal: EvalLaunchRefusal.InvalidSpec,
  },
  {
    name: "a commission with a key the composer never sends",
    prepare: async (dirs) => ({ spec: specIn(dirs.work, { commission: { project: "/etc" } }) }),
    refusal: EvalLaunchRefusal.InvalidSpec,
  },
  {
    name: "a relative pinned executable",
    prepare: async (dirs) => ({ spec: { ...specIn(dirs.work), executables: { codex: "bin/codex" } } }),
    refusal: EvalLaunchRefusal.InvalidSpec,
  },
];
describe("opening an eval launch (real paths)", () => {
  it("opens a fixture spec whose roots sit inside the work root, and creates none of them", async () => {
    const dirs = await layout();
    const before = await tree(dirs.base);
    const opened = await open(dirs, { ...specIn(dirs.work), executables: { claude: "/opt/cli/claude" } });
    assert.equal(opened.ok, true);
    assert.deepEqual(opened.ok && opened.launch.spec.executables, { claude: "/opt/cli/claude" });
    assert.deepEqual(await tree(dirs.base), [...before, "spec.json"].sort());
  });

  for (const row of HOSTILE) {
    it(`refuses ${row.name}, creating nothing`, async () => {
      const dirs = await layout();
      const prepared = await row.prepare(dirs);
      const file = path.join(dirs.base, "spec.json");
      await writeFile(file, "");
      const before = await tree(dirs.base);
      const opened = await open(dirs, prepared.spec, prepared);
      assert.equal(opened.ok ? null : opened.refusal, row.refusal);
      assert.deepEqual(await tree(dirs.base), before);
    });
  }
});

describe("parsing a spec", () => {
  it("names the first bad field", () => {
    assert.throws(() => parseEvalLaunch({ ...specIn("/w"), maxAnswers: -1 }), /maxAnswers/);
    assert.throws(() => parseEvalLaunch({ ...specIn("/w"), answerPolicy: "always" }), /answerPolicy/);
    assert.throws(() => parseEvalLaunch([]), /spec/);
  });

  it("takes plugin ids to turn off, and refuses anything that is not a list of distinct plugin ids", () => {
    assert.deepEqual(parseEvalLaunch({ ...specIn("/w"), disabledPlugins: ["genex"] }).spec.disabledPlugins, ["genex"]);
    assert.equal(parseEvalLaunch(specIn("/w")).spec.disabledPlugins, undefined);
    for (const disabledPlugins of ["genex", [""], ["../genex"], ["Genex"], [7], ["genex", "genex"], {}])
      assert.throws(
        () => parseEvalLaunch({ ...specIn("/w"), disabledPlugins }),
        /disabledPlugins/,
        JSON.stringify(disabledPlugins),
      );
  });

  it("takes a start game's folder name, and refuses anything that could name a folder outside the games root", () => {
    assert.equal(parseEvalLaunch({ ...specIn("/w"), startGame: "anim-walk-1" }).spec.startGame, "anim-walk-1");
    assert.equal(parseEvalLaunch(specIn("/w")).spec.startGame, undefined);
    for (const startGame of [
      "",
      ".",
      "..",
      "../games",
      "a/b",
      "a\\b",
      "/w/games/a",
      "-a",
      "Walk",
      "a b",
      7,
      ["a"],
      null,
    ])
      assert.throws(() => parseEvalLaunch({ ...specIn("/w"), startGame }), /startGame/, JSON.stringify(startGame));
  });
});

let nextId = 0;
function envelope(data: EventData): EventEnvelope {
  nextId++;
  return {
    id: `e${nextId}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 9, 1, 12, 0, nextId)).toISOString(),
    data,
  };
}
const user = (content: string) => envelope({ type: EventKind.Messages, messages: [{ role: "user", content }] });
const custom = (name: Parameters<typeof customEventData>[0], payload: Record<string, unknown>) =>
  envelope(customEventData(name, payload as never));

describe("reading the chat's log", () => {
  it("a question after the last user message waits; one before it was answered", () => {
    const log = readLaneLog([
      user("brief"),
      custom(CustomEvent.CoordinatorMessageQueued, { messageId: "m1" }),
      custom(CustomEvent.InterviewQuestion, { question: "Where?" }),
      custom(CustomEvent.CoordinatorMessageHandled, { messageId: "m1" }),
    ]);
    assert.equal(log.started, true);
    assert.equal(log.queueBusy, false);
    assert.deepEqual(
      log.questions.map((q) => [q.kind, q.waiting]),
      [[QuestionKind.AskUser, true]],
    );
    const answered = readLaneLog([
      user("brief"),
      custom(CustomEvent.InterviewQuestion, { question: "Where?" }),
      user("answer"),
    ]);
    assert.deepEqual(
      answered.questions.map((q) => q.waiting),
      [false],
    );
  });

  it("a waiting plan review is a question; a plan being written keeps the chat busy", () => {
    const log = readLaneLog([
      custom(CustomEvent.PlanReview, { id: "p1", state: "generating", text: "brief" }),
      custom(CustomEvent.PlanReview, { id: "p2", state: "waiting", text: "brief" }),
    ]);
    assert.equal(log.planBusy, true);
    assert.deepEqual(
      log.questions.map((q) => [q.kind, q.id, q.waiting]),
      [
        [QuestionKind.PlanReview, "p1", false],
        [QuestionKind.PlanReview, "p2", true],
      ],
    );
  });

  it("an error after the last user message, with no reply after it, is a failed turn", () => {
    const failed = readLaneLog([user("brief"), envelope({ type: EventKind.Error, message: "turn failed" })]);
    assert.equal(failed.failed, true);
    const recovered = readLaneLog([
      user("brief"),
      envelope({ type: EventKind.Error, message: "turn failed" }),
      envelope({ type: EventKind.Messages, messages: [{ role: "assistant", content: "Done." }] }),
    ]);
    assert.equal(recovered.failed, false);
    const retried = readLaneLog([
      user("brief"),
      envelope({ type: EventKind.Error, message: "turn failed" }),
      user("again"),
    ]);
    assert.equal(retried.failed, false);
  });

  it("a registered run keeps the chat busy until it finishes", () => {
    const running = readLaneLog([custom(CustomEvent.RunRegistered, { runId: "run-a" })]);
    assert.equal(running.runningRunId, "run-a");
    const finished = readLaneLog([
      custom(CustomEvent.RunRegistered, { runId: "run-a" }),
      custom(CustomEvent.RunFinished, { runId: "run-a" }),
    ]);
    assert.equal(finished.runningRunId, null);
  });
});

describe("reading what the chat launched", () => {
  it("no run: the chat built it itself", () => {
    assert.deepEqual(readLaunch([user("brief")]), {
      launch: LaunchPath.None,
      budgets: { completionPolicy: null },
      runIds: [],
    });
  });

  it("an autopilot run: its mode and the budgets it registered, the first run's only", () => {
    const launch = readLaunch([
      custom(CustomEvent.RunRegistered, {
        runId: "run-a",
        mode: "autopilot",
        budgets: { wallClockMs: 86_400_000, untilSatisfied: true, completionPolicy: "goal", review: true },
      }),
      custom(CustomEvent.RunStarted, { runId: "run-a", budgets: { wallClockMs: 86_400_000, untilSatisfied: true } }),
      custom(CustomEvent.RunRegistered, { runId: "run-b", budgets: { wallClockMs: 1 } }),
    ]);
    assert.deepEqual(launch, {
      launch: LaunchPath.StartAutopilot,
      budgets: { wallClockMs: 86_400_000, untilSatisfied: true, completionPolicy: "goal" },
      runIds: ["run-a", "run-b"],
    });
  });

  it("a run registered without a mode came from start_unattended_run", () => {
    const launch = readLaunch([
      custom(CustomEvent.RunRegistered, { runId: "run-a", budgets: { wallClockMs: 3_600_000 } }),
    ]);
    assert.equal(launch.launch, LaunchPath.StartUnattendedRun);
    assert.deepEqual(launch.budgets, { wallClockMs: 3_600_000, completionPolicy: null });
  });
});

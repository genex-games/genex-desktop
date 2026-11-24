/**
 * Play-time models in a game's preview: a practice helper answers every preview with made-up
 * answers, and real models answer Live alone, only for the game and the cap the person approved by
 * pressing Start. The helpers here are small Node programs that print what `genex llm practice
 * --json` prints, so a stop is proven by the process being gone.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PreviewAiService, withPracticeKey } from "../../src/main/core/preview-ai.ts";
import { type HostAnswer, type HostAsk, HostError } from "../../src/main/core/preview-ai-plans.ts";
import type { PracticeLaunch } from "../../src/main/core/genex-cli.ts";
import { GenexHosting } from "../../src/shared/genex.ts";
import {
  PreviewAiMode,
  type PreviewAiPlan,
  type PreviewAiState,
  PreviewAiUnavailable,
} from "../../src/shared/preview-ai.ts";
import { withGenexSdkImport } from "../../src/shared/genex-page.ts";
import { codeCallsPlayTimeModels, gameCallsPlayTimeModels } from "../../src/substrate/project-shape.ts";
import { HEX, hostProgram, listening, program, type Script } from "../helpers/practice-helper.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = "live";
const TEMPLATE_PAGE = path.resolve(import.meta.dirname, "../../src/game-template/index.html");
const AGENT = "game-preview-facet-1";

/** The person's plan in these tests, and the models it answers as. */
const CLAUDE: PreviewAiPlan = { engine: "claude-code", label: "Claude Code" };
const PLAN_MODELS = [{ id: "claude-code/sonnet", label: "Sonnet", vendor: "anthropic" }];

/** What the service is told when it asks Genex for a game's project: an outcome, or the error thrown. */
type Hosting = GenexHosting | Error;

/** A service whose helpers are scripted per kind, with what it launched, emitted, reloaded and put on Genex. */
async function service(
  options: {
    live?: Script;
    mock?: Script;
    allowed?: boolean;
    signedIn?: boolean;
    draft?: boolean;
    hosting?: Hosting;
    /** The person's plans that are ready (default: none). */
    plans?: PreviewAiPlan[];
    /** What a host helper asks for once it listens. */
    asks?: HostAsk[];
    /** A host helper that prints this instead of behaving as one. */
    hostHelper?: Script;
    /** What the plan answers a call with (default: the call's own text back). */
    answer?: (ask: HostAsk) => HostAnswer | Promise<HostAnswer>;
  } = {},
) {
  const scratch = await tmpDir("studio-preview-ai-");
  const launches: Array<{ project: string; live: { maxCredits: number } | null; host?: true }> = [];
  /** Every line a host helper printed, parsed: its hello, and the answers it was given. */
  const heard: Array<Record<string, unknown>> = [];
  const answered: Array<{ engine: string; ask: HostAsk }> = [];
  const states: PreviewAiState[] = [];
  const reloads: string[] = [];
  const pids: number[] = [];
  const hosted: string[] = [];
  let onGenex = options.draft ?? true;
  const ai = new PreviewAiService(
    {
      launch: async (project, live, host) => {
        launches.push({ project, live, ...(host ? { host: true as const } : {}) });
        const script = live
          ? (options.live ?? { first: listening(41001, "live") })
          : (options.mock ?? { first: listening(41000, "mock") });
        return {
          command: host ? hostHelper(options) : program(script),
          cwd: scratch,
          env: {},
          label: "test",
          policy: { allowedDomains: [], allowWrite: [], denyWrite: [] },
          root: `${scratch}/run-${launches.length}`,
        } satisfies PracticeLaunch;
      },
      spawn: async (request) => {
        const child = spawn(process.execPath, ["-e", request.command], { stdio: ["pipe", "pipe", "pipe"] });
        if (child.pid) pids.push(child.pid);
        if (request.liveInput) hear(child.stdout, heard);
        return { child, input: child.stdin };
      },
      plans: async () => options.plans ?? [],
      planModels: async () => PLAN_MODELS,
      answer: async (engine, ask) => {
        answered.push({ engine, ask });
        return (await options.answer?.(ask)) ?? { id: ask.id, text: `${engine} heard: ${ask.user}` };
      },
      signedIn: async () => options.signedIn ?? true,
      hasDraft: async () => onGenex,
      host: async (project) => {
        hosted.push(project);
        const hosting = options.hosting ?? GenexHosting.Hosted;
        if (hosting instanceof Error) throw hosting;
        onGenex = hosting === GenexHosting.Hosted;
        return hosting;
      },
      liveAllowed: () => options.allowed ?? true,
      emit: (state) => states.push(state),
      reloadLive: async (project) => {
        reloads.push(project);
      },
      stopGraceMs: 2000,
    },
    LIVE,
  );
  return { ai, launches, states, reloads, pids, hosted, heard, answered };
}

/** The program a host launch runs: the scripted one when the test names it, else a helper in host mode. */
const hostHelper = (options: { asks?: HostAsk[]; hostHelper?: Script }): string =>
  options.hostHelper ? program(options.hostHelper) : hostProgram(options.asks ?? []);

/** Keep every JSON line a child prints. */
function hear(output: NodeJS.ReadableStream, lines: Array<Record<string, unknown>>): void {
  let pending = "";
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const text of parts) if (text.trim()) lines.push(JSON.parse(text) as Record<string, unknown>);
  });
}

/** Wait until `seen` says so: for what a helper prints behind a call. */
async function until(seen: () => boolean): Promise<void> {
  for (let waited = 0; waited < 5000 && !seen(); waited += 10) await sleep(10);
  assert.ok(seen(), "what the test waited for never happened");
}

describe("practice answers in every preview", () => {
  it("gives Live and an agent's window made-up answers, and adds the key to the page's address", async () => {
    const { ai, launches } = await service();
    try {
      const key = await ai.keyFor(LIVE, "inn");
      assert.equal(key, `genex_llm_practice=41000.${HEX}`);
      assert.equal(await ai.keyFor(AGENT, "inn"), key, "one helper per game serves both previews");
      assert.deepEqual(launches, [{ project: "inn", live: null }]);
      assert.equal(ai.state("inn").mode, PreviewAiMode.Practice);
      assert.equal(withPracticeKey("index.html?genex_local_test=1", key), `index.html?genex_local_test=1&${key}`);
      assert.equal(withPracticeKey("index.html", null), "index.html");
    } finally {
      await ai.stopAll();
    }
  });

  it("stops a game's helper once no preview shows it, and leaves no process behind", async () => {
    const { ai, pids } = await service();
    await ai.keyFor(LIVE, "inn");
    await ai.keyFor(AGENT, "inn");
    await ai.release(AGENT);
    assert.equal(ai.runningPids().length, 1, "Live still shows the game");
    await ai.release(LIVE);
    assert.deepEqual(ai.runningPids(), []);
    for (const pid of pids) assert.equal(running(pid), false, `helper ${pid} is gone`);
  });

  it("stops the last game's helper when Live moves to another game", async () => {
    const { ai, pids } = await service();
    try {
      await ai.keyFor(LIVE, "inn");
      await ai.keyFor(LIVE, "tavern");
      assert.equal(running(pids[0] ?? 0), false, "the inn's helper stopped");
      assert.equal(ai.runningPids().length, 1);
    } finally {
      await ai.stopAll();
    }
    for (const pid of pids) assert.equal(running(pid), false);
  });

  it("stops every helper when the app quits", async () => {
    const { ai, pids } = await service();
    await ai.keyFor(LIVE, "inn");
    await ai.keyFor(AGENT, "tavern");
    await ai.stopAll();
    for (const pid of pids) assert.equal(running(pid), false);
    assert.equal(await ai.keyFor(LIVE, "inn"), null, "nothing starts once the app is quitting");
  });

  it("takes the bar away once Live's game calls no model any more", async () => {
    const { ai, pids } = await service();
    await ai.keyFor(LIVE, "inn");
    await ai.noModels(LIVE, "inn");
    assert.equal(ai.state("inn").mode, PreviewAiMode.None);
    assert.deepEqual(ai.runningPids(), []);
    for (const pid of pids) assert.equal(running(pid), false);
  });

  it("goes on without a key when the helper fails, and says so", async () => {
    const { ai } = await service({
      mock: { first: { command: "llm practice", status: "failed", error: "boom", code: "EACCES" } },
    });
    try {
      assert.equal(await ai.keyFor(LIVE, "inn"), null);
      assert.equal(ai.state("inn").reason, PreviewAiUnavailable.HelperFailed);
      assert.match(ai.state("inn").error ?? "", /EACCES: boom/);
    } finally {
      await ai.stopAll();
    }
  });
});

describe("real models in Live, approved once with a cap", () => {
  it("never starts real models without the person's Start for that game and cap", async () => {
    const { ai, launches } = await service();
    try {
      await ai.keyFor(LIVE, "inn");
      await ai.keyFor(AGENT, "inn");
      assert.ok(
        launches.every((launch) => launch.live === null),
        "no approval, no real models",
      );
      await assert.rejects(ai.startRealModels("inn", 50), /not a cap/);
      await assert.rejects(ai.startRealModels("inn", Number.NaN), /not a cap/);
      assert.ok(
        launches.every((launch) => launch.live === null),
        "a cap Live does not offer starts nothing",
      );
    } finally {
      await ai.stopAll();
    }
  });

  it("starts real models in Live for the approved cap, and an agent's window keeps made-up answers", async () => {
    const { ai, launches, reloads } = await service();
    try {
      await ai.keyFor(LIVE, "inn");
      const started = await ai.startRealModels("inn", 300);
      assert.equal(started.mode, PreviewAiMode.Starting);
      assert.deepEqual(reloads, ["inn"], "Live is loaded again to take the new key");
      const key = await ai.keyFor(LIVE, "inn");
      assert.equal(key, `genex_llm_practice=41001.${HEX}`);
      assert.deepEqual(launches.at(-1), { project: "inn", live: { maxCredits: 300 } });
      assert.equal(ai.state("inn").mode, PreviewAiMode.Live);
      assert.equal(await ai.keyFor(AGENT, "inn"), `genex_llm_practice=41000.${HEX}`, "never the paid key");
      assert.equal(launches.filter((launch) => launch.live !== null).length, 1);
      await ai.keyFor(AGENT, "tavern");
      assert.ok(
        launches.filter((launch) => launch.project === "tavern").every((launch) => launch.live === null),
        "an approval is for its own game only",
      );
    } finally {
      await ai.stopAll();
    }
  });

  it("answers the unavailable state, with its reason, where it cannot spend", async () => {
    const cases = [
      { options: { allowed: false }, reason: PreviewAiUnavailable.NotHere },
      { options: { signedIn: false }, reason: PreviewAiUnavailable.SignedOut },
      {
        options: { draft: false, hosting: GenexHosting.TermsPending },
        reason: PreviewAiUnavailable.Terms,
      },
      {
        options: { draft: false, hosting: new Error("Genex did not answer") },
        reason: PreviewAiUnavailable.NoDraft,
        error: "Genex did not answer",
      },
    ];
    for (const { options, reason, error = null } of cases) {
      const { ai, launches, reloads } = await service(options);
      try {
        const state = await ai.startRealModels("inn", 100);
        assert.equal(state.mode, PreviewAiMode.Unavailable);
        assert.equal(state.reason, reason);
        assert.equal(state.error, error, `${reason}: Genex's own words, when it gave any`);
        assert.equal(state.capCredits, null);
        await ai.keyFor(LIVE, "inn");
        assert.ok(
          launches.every((launch) => launch.live === null),
          `${reason}: nothing spends`,
        );
        assert.deepEqual(reloads, []);
      } finally {
        await ai.stopAll();
      }
    }
  });

  it("puts a game that is not on Genex there on the person's Start, then starts real models", async () => {
    const { ai, launches, reloads, hosted, states } = await service({ draft: false });
    try {
      await ai.keyFor(LIVE, "inn");
      assert.deepEqual(hosted, [], "practice answers ask Genex for nothing");
      assert.equal(ai.state("inn").onGenex, false, "the bar knows its confirmation has to say so");
      await ai.startRealModels("inn", 300);
      assert.deepEqual(hosted, ["inn"], "the game's project is made once the person pressed Start");
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41001.${HEX}`, "Live plays on real models");
      assert.equal(ai.state("inn").mode, PreviewAiMode.Live);
      assert.equal(ai.state("inn").onGenex, true);
      assert.deepEqual(launches.at(-1), { project: "inn", live: { maxCredits: 300 } });
      assert.deepEqual(reloads, ["inn"]);
      const starting = states.findIndex((state) => state.mode === PreviewAiMode.Starting);
      assert.ok(starting !== -1, "the bar says real AI is starting while Genex is asked");
      await ai.startRealModels("inn", 300);
      assert.deepEqual(hosted, ["inn"], "a game already on Genex is not put there again");
    } finally {
      await ai.stopAll();
    }
  });

  it("asks Genex for nothing where real models cannot start anyway", async () => {
    for (const options of [{ allowed: false }, { signedIn: false }]) {
      const { ai, hosted } = await service({ ...options, draft: false });
      try {
        await ai.startRealModels("inn", 100);
        assert.deepEqual(hosted, []);
      } finally {
        await ai.stopAll();
      }
    }
  });

  it("falls back to practice with the reason when the lane is off", async () => {
    const { ai } = await service({ live: { first: { command: "llm practice", status: "off", error: null } } });
    try {
      await ai.startRealModels("inn", 100);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`);
      assert.equal(ai.state("inn").mode, PreviewAiMode.Unavailable);
      assert.equal(ai.state("inn").reason, PreviewAiUnavailable.LaneOff);
      assert.equal(ai.runningPids().length, 1, "only the practice helper runs");
    } finally {
      await ai.stopAll();
    }
  });

  it("shows what the run spent, and when its cap is used up", async () => {
    const later = [
      {
        event: "live",
        kind: "generate",
        callCredits: 4,
        ceilingCredits: 4,
        chargedCredits: 4,
        heldCredits: 0,
        capCredits: 100,
      },
      { event: "call", kind: "generate", status: "refused", error: "grant_limit_reached", via: "live" },
    ];
    const { ai } = await service({ live: { first: listening(41001, "live"), later } });
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      await sleep(300);
      assert.equal(ai.state("inn").chargedCredits, 4);
      assert.equal(ai.state("inn").mode, PreviewAiMode.CapReached);
    } finally {
      await ai.stopAll();
    }
  });

  it("goes back to practice on the person's Stop, and stops the paid run", async () => {
    const { ai, pids } = await service();
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      const paid = pids.at(-1) ?? 0;
      const state = await ai.backToPractice("inn");
      assert.equal(state.mode, PreviewAiMode.Practice);
      assert.equal(running(paid), false);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`);
    } finally {
      await ai.stopAll();
    }
  });

  it("keeps the choice for the game while Live is away, and stops the paid run meanwhile", async () => {
    const { ai, pids, launches } = await service();
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      const paid = pids.at(-1) ?? 0;
      await ai.release(LIVE);
      assert.equal(running(paid), false, "Live's Stop ends the paid run");
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41001.${HEX}`, "Play starts it again");
      assert.deepEqual(launches.at(-1)?.live, { maxCredits: 100 });
    } finally {
      await ai.stopAll();
    }
  });

  it("holds every run of a game to the one cap the person approved: a later run gets what is left", async () => {
    const spent = { event: "live", kind: "generate", chargedCredits: 55, heldCredits: 5, capCredits: 100 };
    const { ai, launches } = await service({ live: { first: listening(41001, "live"), later: [spent] } });
    const paid = () => launches.filter((launch) => launch.live !== null).map((launch) => launch.live?.maxCredits);
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      await sleep(300);
      await ai.release(LIVE);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41001.${HEX}`, "Play goes on with real models");
      assert.deepEqual(paid(), [100, 40], "the second run may spend only what the first left");
      await sleep(300);
      assert.equal(
        ai.state("inn").chargedCredits,
        115,
        "the bar counts both runs, a held bill of an ended one as spent",
      );
      await ai.release(LIVE);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`, "nothing left: made-up answers");
      assert.deepEqual(paid(), [100, 40], "no third paid run without a new Start");
      assert.equal(ai.state("inn").mode, PreviewAiMode.CapReached);
      await ai.startRealModels("inn", 300);
      await ai.keyFor(LIVE, "inn");
      assert.deepEqual(paid(), [100, 40, 300], "a new Start is a new cap, counted from nothing");
    } finally {
      await ai.stopAll();
    }
  });
});

describe("a plan of the person's own in Live, at no credits", () => {
  const ask = (id: string, user: string): HostAsk => ({
    id,
    modelId: "claude-code/sonnet",
    system: "frame",
    user,
    maxOutputTokens: 300,
  });

  it("offers the plans that are ready, and never starts one without the person's Start for it", async () => {
    const { ai, launches } = await service({ plans: [CLAUDE] });
    try {
      await ai.keyFor(LIVE, "inn");
      assert.deepEqual(ai.state("inn").plans, [CLAUDE], "the bar can offer it");
      assert.equal(ai.state("inn").mode, PreviewAiMode.Practice);
      assert.deepEqual(launches, [{ project: "inn", live: null }], "only made-up answers so far");
    } finally {
      await ai.stopAll();
    }
  });

  it("starts the helper in host mode, tells it who answers, and answers its questions on that plan", async () => {
    const asks = [ask("c1", "Got any answers in stock?"), ask("c2", "Is she looking?")];
    const { ai, launches, reloads, heard, answered } = await service({ plans: [CLAUDE], asks });
    try {
      const state = await ai.startPlan("inn", CLAUDE.engine);
      assert.deepEqual([state.mode, state.plan], [PreviewAiMode.Starting, CLAUDE]);
      assert.deepEqual(reloads, ["inn"]);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41002.${HEX}`, "Live plays on the plan's helper");
      assert.deepEqual([ai.state("inn").mode, ai.state("inn").plan], [PreviewAiMode.Plan, CLAUDE]);
      assert.deepEqual(launches.at(-1), { project: "inn", live: null, host: true });
      assert.deepEqual(heard[0], { event: "hello", host: { name: "Claude Code", models: PLAN_MODELS } });
      await until(() => heard.filter((line) => line.event === "answered").length === 2);
      assert.deepEqual(
        answered.map(({ engine, ask: one }) => [engine, one.id, one.user]),
        [
          ["claude-code", "c1", "Got any answers in stock?"],
          ["claude-code", "c2", "Is she looking?"],
        ],
      );
      assert.deepEqual(
        heard.filter((line) => line.event === "answered").map((line) => line.answer),
        [
          { id: "c1", text: "claude-code heard: Got any answers in stock?" },
          { id: "c2", text: "claude-code heard: Is she looking?" },
        ],
      );
      assert.equal(
        await ai.keyFor(AGENT, "inn"),
        `genex_llm_practice=41000.${HEX}`,
        "an agent's window keeps made-up answers",
      );
    } finally {
      await ai.stopAll();
    }
  });

  it("passes on why the plan has no answer, and a plan that throws answers failed", async () => {
    const asks = [ask("c1", "limit"), ask("c2", "boom")];
    const answer = (one: HostAsk): HostAnswer => {
      if (one.user === "boom") throw new Error("the engine broke");
      return { id: one.id, error: HostError.RateLimited };
    };
    const { ai, heard } = await service({ plans: [CLAUDE], asks, answer });
    try {
      await ai.startPlan("inn", CLAUDE.engine);
      await ai.keyFor(LIVE, "inn");
      await until(() => heard.filter((line) => line.event === "answered").length === 2);
      const answers = heard.filter((line) => line.event === "answered").map((line) => JSON.stringify(line.answer));
      assert.deepEqual(answers.sort(), ['{"id":"c1","error":"rate_limited"}', '{"id":"c2","error":"failed"}']);
    } finally {
      await ai.stopAll();
    }
  });

  it("refuses a plan that is not ready here, and starts nothing", async () => {
    const { ai, launches, reloads } = await service({ plans: [CLAUDE] });
    try {
      const state = await ai.startPlan("inn", "codex");
      assert.deepEqual(
        [state.mode, state.reason, state.plan],
        [PreviewAiMode.Unavailable, PreviewAiUnavailable.PlanNotReady, null],
      );
      await ai.keyFor(LIVE, "inn");
      assert.ok(
        launches.every((launch) => !launch.host),
        "no helper in host mode",
      );
      assert.deepEqual(reloads, []);
    } finally {
      await ai.stopAll();
    }
  });

  it("ends the plan on Stop and when real models take over, and leaves no helper behind", async () => {
    const { ai, pids, launches } = await service({ plans: [CLAUDE] });
    try {
      await ai.startPlan("inn", CLAUDE.engine);
      await ai.keyFor(LIVE, "inn");
      const back = await ai.backToPractice("inn");
      assert.deepEqual([back.mode, back.plan], [PreviewAiMode.Practice, null]);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`, "made-up answers again");

      await ai.startPlan("inn", CLAUDE.engine);
      await ai.keyFor(LIVE, "inn");
      await ai.startRealModels("inn", 100);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41001.${HEX}`, "real models answer now");
      assert.deepEqual([ai.state("inn").mode, ai.state("inn").plan], [PreviewAiMode.Live, null]);

      await ai.startPlan("inn", CLAUDE.engine);
      assert.equal(
        await ai.keyFor(LIVE, "inn"),
        `genex_llm_practice=41002.${HEX}`,
        "and the plan again, with no credits approved",
      );
      assert.equal(launches.filter((launch) => launch.live !== null).length, 1, "the paid run was not started again");
    } finally {
      await ai.stopAll();
    }
    for (const pid of pids) assert.equal(running(pid), false, `helper ${pid} is gone`);
  });

  it("falls back to practice, saying why, when the plan's helper cannot start", async () => {
    const failing = {
      first: { command: "llm practice", status: "failed", code: "host_silent", error: "nobody answers" },
    };
    const { ai, launches } = await service({ plans: [CLAUDE], hostHelper: failing });
    try {
      await ai.startPlan("inn", CLAUDE.engine);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`, "made-up answers go on");
      const state = ai.state("inn");
      assert.deepEqual(
        [state.mode, state.reason, state.plan],
        [PreviewAiMode.Unavailable, PreviewAiUnavailable.HelperFailed, null],
      );
      assert.match(state.error ?? "", /host_silent: nobody answers/);
      await ai.keyFor(LIVE, "inn");
      assert.equal(
        launches.filter((launch) => launch.host).length,
        1,
        "the plan is not tried again without a new Start",
      );
    } finally {
      await ai.stopAll();
    }
  });
});

describe("which games call play-time models", () => {
  const SDK = 'import { requestSpendGrant, generateStream } from "@genex-ai/embed-sdk";';
  const table: Array<{ name: string; code: string; calls: boolean }> = [
    { name: "a budget asked for", code: `${SDK}\nawait requestSpendGrant({ models: [] });`, calls: true },
    { name: "a streamed answer", code: `${SDK}\nawait generateStream({ grantId });`, calls: true },
    {
      name: "the model list",
      code: 'import { getGenerationModels } from "@genex-ai/embed-sdk";\ngetGenerationModels();',
      calls: true,
    },
    {
      name: "a judge's question",
      code: 'import { judge } from "@genex-ai/embed-sdk";\nawait judge({ grantId, state, questions });',
      calls: true,
    },
    {
      name: "generate from the SDK",
      code: 'import { generate } from "@genex-ai/embed-sdk";\nawait generate({ prompt });',
      calls: true,
    },
    {
      name: "generate from Studio's copy",
      code: 'import { generate } from "/vendor/genex/embed-sdk.js";\ngenerate({ prompt });',
      calls: true,
    },
    { name: "a generate() of the game's own", code: "function generate() {}\ngenerate();", calls: false },
    { name: "a line comment", code: "// later: requestSpendGrant() for the innkeeper", calls: false },
    { name: "a block comment", code: "/* generateStream({ grantId }) */ const x = 1;", calls: false },
    { name: "a string", code: 'const hint = "call requestSpendGrant() first";', calls: false },
    { name: "a template string", code: "const hint = `judge(x) first`;", calls: false },
    { name: "a longer name", code: "const requestSpendGrantLater = 1; myjudge(1);", calls: false },
    { name: "a URL before a call", code: `${SDK}\nconst u = "http://x"; await requestSpendGrant({});`, calls: true },
    { name: "an unterminated comment", code: "/* requestSpendGrant(", calls: false },
    { name: "an unterminated string", code: '"requestSpendGrant(', calls: false },
    { name: "nothing", code: "", calls: false },
    { name: "a huge file", code: `${"x".repeat(2_000_000)} requestSpendGrant()`, calls: false },
  ];
  for (const { name, code, calls } of table)
    it(`${calls ? "calls" : "does not call"}: ${name}`, () => {
      assert.equal(codeCallsPlayTimeModels(code), calls);
    });

  it("reads a game's own sources, only once its page or package loads the SDK", async () => {
    const dir = await tmpDir("studio-models-game-");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
    const page = withGenexSdkImport(await readFile(TEMPLATE_PAGE, "utf8")) ?? "";
    await writeFile(path.join(dir, "index.html"), page);
    await writeFile(path.join(dir, "src", "main.js"), "console.log(1);");
    await writeFile(path.join(dir, "node_modules", "x", "index.js"), `${SDK} requestSpendGrant();`);
    assert.equal(await gameCallsPlayTimeModels(dir), false, "a dependency's code is not the game's");
    await writeFile(path.join(dir, "src", "npc.js"), `${SDK}\nawait requestSpendGrant({});`);
    assert.equal(await gameCallsPlayTimeModels(dir), true);
    await writeFile(path.join(dir, "index.html"), "<!doctype html><script src=src/main.js></script>");
    assert.equal(await gameCallsPlayTimeModels(dir), false, "no SDK on the page, no calls");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@genex-ai/embed-sdk": "0.37.0" } }),
    );
    assert.equal(await gameCallsPlayTimeModels(dir), true, "a built game names the SDK in its package");
    assert.equal(await gameCallsPlayTimeModels(path.join(dir, "missing")), false);
  });

  it("does not follow a link out of the game", async () => {
    const dir = await tmpDir("studio-models-link-");
    const outside = await tmpDir("studio-models-outside-");
    await writeFile(path.join(outside, "npc.js"), 'import { judge } from "@genex-ai/embed-sdk"; judge({});');
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@genex-ai/embed-sdk": "0.37.0" } }),
    );
    await writeFile(path.join(dir, "index.html"), "<!doctype html>");
    await symlink(outside, path.join(dir, "src"));
    assert.equal(await gameCallsPlayTimeModels(dir), false);
  });
});

/**
 * The gauntlet inner loop.
 *
 * The rule this suite exists for is our addition to gauntlet-loop, which has no tie or regression
 * handling: **the incumbent only advances on a clear win.** A tie, a judge that cannot answer, or
 * a build that will not run must all leave the run's work no worse than it was.
 *
 * The loop runs for real — real harness process, real substrate, real git snapshots — with a
 * scripted judge that reads the (blind, shuffled) prompt and answers like a real one would.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { countImages, flattenMessageContent, newestFixtureBuild, type FakeReply } from "../helpers/fake-ollama.ts";
import { EngineError, type Engine } from "../../src/substrate/engines/types.ts";
import { combineFacetVerdict, normalizeDefects } from "../../src/harness-seed/loop/judge.ts";
import { buildBrief } from "../../src/harness-seed/loop/gauntlet.ts";

const rigs: Rig[] = [];
// Each scenario owns its rig. Keeping finished harnesses until file teardown leaves
// processes, heartbeat timers and HTTP servers alive during every following scenario.
// Do not swallow cleanup failures: a green assertion must not hide a leaked rig.
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.stop();
    assert.equal(rig.core.host.state, "stopped", "the scenario releases its harness before the next test");
  }
});

interface Script {
  /** How the judge should decide a head-to-head comparison (legacy overall pick). */
  compare: "challenger" | "incumbent" | "tie";
  /** Faceted judge: sides relative to challenger/incumbent, not A/B. */
  facets?: {
    works: "challenger" | "incumbent" | "tie";
    visuals: "challenger" | "incumbent" | "tie";
    feel: "challenger" | "incumbent" | "tie";
    play: "challenger" | "incumbent" | "tie";
  };
  /** How the reference panel should vote. */
  panel?: "build" | "reference";
  /** Fail this many blind-compare requests at the HTTP level before answering — a judge outage. */
  failCompares?: number;
  /** Fail exactly these blind-compare requests (1-based) — outages with recoveries between. */
  failCompareAt?: number[];
  /** Fail this many reference-panel requests at the HTTP level before answering. */
  failPanels?: number;
  /**
   * Status for those failures. Defaults to 429 because a rate limit only ever falls back to
   * direct engines — the rig has no second one, so the test can never wander onto a real
   * contractor as a stand-in judge on a machine where Claude Code happens to be signed in.
   */
  failStatus?: number;
  onBuild?: () => void;
}

/**
 * A responder that plays all three roles the loop asks for: the builder (tool calls), the blind
 * comparison judge, and the reference panel. It reads the synthetic capture counters to find which label the
 * newer fixture got, so "pick the challenger" is expressible even though the sides are shuffled.
 */
function makeResponder(script: Script) {
  let builds = 0;
  const counts = { compare: 0, panel: 0, build: 0 };
  const respond = (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
    const text = request.messages.map((m) => m.content).join("\n");

    // Head-to-head comparison: two unlabelled candidates.
    if (text.includes("BUILD A") && text.includes("BUILD B")) {
      counts.compare++;
      const failing = script.failCompareAt
        ? script.failCompareAt.includes(counts.compare)
        : counts.compare <= (script.failCompares ?? 0);
      if (failing) {
        return {
          httpStatus: script.failStatus ?? 429,
          body: JSON.stringify({ error: { message: "the judge fainted" } }),
        };
      }
      const aIsIncumbent = newestFixtureBuild(request) === "B";
      const letter = (side: "challenger" | "incumbent" | "tie") =>
        side === "tie" ? "tie" : side === "challenger" ? (aIsIncumbent ? "B" : "A") : aIsIncumbent ? "A" : "B";
      if (script.facets) {
        return {
          text: JSON.stringify({
            facets: {
              works: letter(script.facets.works),
              visuals: letter(script.facets.visuals),
              feel: letter(script.facets.feel),
              play: letter(script.facets.play),
            },
            biggest_gap: "the rings need more contrast",
            reason: "scripted facets",
          }),
        };
      }
      const pick =
        script.compare === "tie"
          ? "tie"
          : script.compare === "challenger"
            ? aIsIncumbent
              ? "B"
              : "A"
            : aIsIncumbent
              ? "A"
              : "B";
      return {
        text: JSON.stringify({ pick, biggest_gap: "the rings need more contrast", reason: "scripted" }),
      };
    }

    // The exit condition: our build against the named reference.
    if (text.includes("THE BUILD") && text.includes("REFERENCE:")) {
      counts.panel++;
      if (counts.panel <= (script.failPanels ?? 0)) {
        return {
          httpStatus: script.failStatus ?? 429,
          body: JSON.stringify({ error: { message: "the panel fainted" } }),
        };
      }
      // The panel's ballot: three answers, and a vote for the
      // build counts only when it names what the build does better.
      const forBuild = script.panel === "build";
      return {
        text: JSON.stringify({
          looks: forBuild ? "build" : "reference",
          plays: forBuild ? "build" : "reference",
          better: forBuild ? "the impacts land with a visible flash" : "",
          biggest_gap: "no screen shake on impact",
          reason: "scripted panel",
        }),
      };
    }

    // Otherwise this is the builder turn: write one file, then finish.
    counts.build++;
    builds++;
    if (builds % 2 === 1) {
      script.onBuild?.();
      return {
        toolCalls: [
          {
            id: `call_${builds}`,
            name: "write_file",
            arguments: {
              project: "pong",
              file: "src/feature.js",
              contents: `// challenger attempt ${builds}\nexport const attempt = ${builds};\n`,
            },
          },
        ],
        text: "Closing the gap.",
      };
    }
    return { text: "Done with this iteration." };
  };
  return { respond, counts };
}

async function runOnce(
  script: Script,
  options: {
    maxIterations?: number;
    observationDelays?: number[];
    preview?: (rig: Rig) => void;
    reference?: {
      name: string;
      shots: string[];
      notes?: string;
      kind?: "reference" | "direction";
      frames?: Array<{ label: string; mimeType: string; data: string }>;
    };
  } = {},
) {
  const { respond, counts } = makeResponder(script);
  const rig = await startRig({ respond });
  rigs.push(rig);
  options.preview?.(rig);

  const runId = rig.core.newRunId();
  await rig.core.dispatchRun({
    runId,
    goal: "make a ring-flying game",
    project: "pong",
    reference: options.reference ?? { name: "Race the Sun", shots: [], notes: "speed and clarity" },
    budgets: {
      wallClockMs: 120_000,
      maxIterations: options.maxIterations ?? 1,
      ...(options.observationDelays ? { observationDelays: options.observationDelays } : {}),
    },
  });

  const events = await waitForLog(
    rig.core,
    (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
    90_000,
    "run_finished",
  );
  const report = customEvents(events, "run_finished")[0]!;
  return { rig, events, report, counts, runId };
}

describe("gauntlet: the incumbent rule", () => {
  it("advances the incumbent when the challenger clearly wins, and keeps its work", async () => {
    const { events, report, rig, counts } = await runOnce({ compare: "challenger" });
    const iterations = customEvents(events, "run_iteration");
    assert.equal(iterations.length, 1);
    assert.equal(
      iterations[0]!.winner,
      "challenger",
      JSON.stringify({ iterations, counts, logs: rig.logs.slice(-10) }),
    );

    // The challenger's file survives, and a healthy snapshot marks the new incumbent.
    const feature = await readFile(path.join(rig.core.layout.gamesRoot, "pong", "src", "feature.js"), "utf8");
    assert.match(feature, /challenger attempt/);
    assert.ok(report.finalSnapshot, "the report names the final snapshot");
    const accepted = events.filter((e) => e.data.type === "snapshot_created" && e.data.healthy === true);
    assert.ok(accepted.length >= 1, "an accepted challenger is snapshotted as healthy");
  });

  it("keeps the incumbent and rolls the work back on a TIE", async () => {
    const { events, rig } = await runOnce({ compare: "tie" });
    const iterations = customEvents(events, "run_iteration");
    assert.equal(iterations[0]!.winner, "incumbent", "a tie must not advance the incumbent");

    // The challenger's file is gone — the workspace went back to the last accepted build.
    await assert.rejects(
      () => readFile(path.join(rig.core.layout.gamesRoot, "pong", "src", "feature.js"), "utf8"),
      /ENOENT/,
      "a tie must restore the incumbent's workspace",
    );
    const restores = events.filter((e) => e.data.type === "workspace_restored");
    assert.ok(restores.length >= 1, "the rollback is recorded in the log");
    // Losing a round is a verdict about the game, not the coder: the rollback must not drag
    // the harness back with it (one bad run of ties would erase every unjudged self-edit).
    for (const restore of restores) {
      assert.equal((restore.data as { scope?: string }).scope, "game");
    }
  });

  it("keeps the incumbent when the challenger regresses", async () => {
    const { events, rig } = await runOnce({ compare: "incumbent" });
    assert.equal(customEvents(events, "run_iteration")[0]!.winner, "incumbent");
    await assert.rejects(
      () => readFile(path.join(rig.core.layout.gamesRoot, "pong", "src", "feature.js"), "utf8"),
      /ENOENT/,
    );
  });

  it("treats a build that cannot be judged as a loss without asking the judge", async () => {
    const { events, counts } = await runOnce(
      { compare: "challenger" },
      {
        preview: (rig) => {
          // The build broke the studio contract: nothing to judge.
          rig.preview.next = { __missing: true };
        },
      },
    );
    const iteration = customEvents(events, "run_iteration")[0]!;
    assert.equal(iteration.winner, "incumbent");
    assert.match(String(iteration.biggest_gap), /window\.__studio is missing|does not run/);
    assert.equal(counts.compare, 0, "no judge call should be spent on an unjudgeable build");
  });

  it("survives an evidence pass that throws — the challenger is held, the run ends honestly", async () => {
    // Since the occluded-window postmortem, a blind observation layer is an outage, not a loss:
    // each blind iteration retries on a backoff, holds the challenger unjudged (no reset), and
    // two outages in a row stop the run before more build turns are spent blind.
    const { events, report, counts, rig } = await runOnce(
      { compare: "challenger" },
      {
        maxIterations: 4,
        observationDelays: [1],
        preview: (rig) => {
          // The user closed the window mid-run: every preview RPC dies with it.
          rig.preview.reload = async () => {
            throw new Error("window destroyed: no compositor surface");
          };
        },
      },
    );
    assert.equal(customEvents(events, "run_iteration").length, 0, "a blind iteration is held, never verdicted");
    assert.equal(customEvents(events, "observation_outage").length, 2, "each blind pass is logged as an outage");
    // The close says it in the user's words; the diagnostic stays on the event and on the report.
    assert.match(String(report.stoppedBecause), /could not see the game to judge it/);
    assert.match(
      String((report.observationOutage as { problem?: string })?.problem ?? ""),
      /.+/,
      "the problem itself is still recorded",
    );
    assert.equal(counts.compare, 0, "nothing judgeable ever reached the judge");
    assert.equal(customEvents(events, "run_finished").length, 1, "the run still closes honestly");
    assert.ok(report, "report.json still lands for the morning");
    // The post-run pass mines the run regardless of the dead preview — wait it out so its
    // work cannot outlive the test and EPIPE the runner at teardown.
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "skillopt_pass").length >= 1,
      30_000,
      "skillopt_pass after the run",
    );
  });

  it("treats a build whose every camera is black as a loss without asking the judge", async () => {
    const { events, counts } = await runOnce(
      { compare: "challenger" },
      {
        preview: (rig) => {
          // Probes pass and frames advance — but no camera puts a lit pixel on screen.
          rig.preview.pixelStatsNext = { ...rig.preview.pixelStatsNext, meanLuma: 0.4, litFraction: 0 };
        },
      },
    );
    const iteration = customEvents(events, "run_iteration")[0]!;
    assert.equal(iteration.winner, "incumbent");
    assert.match(String(iteration.biggest_gap), /black|does not run|not responding/);
    assert.equal(counts.compare, 0, "a vision judge would politely describe the black JPEGs — never ask it");
  });

  it("stops on a blind panel win rather than a round count", async () => {
    const { events, report, counts } = await runOnce({ compare: "challenger", panel: "build" }, { maxIterations: 6 });
    assert.equal(report.victory, true);
    assert.match(String(report.stoppedBecause), /blind panel picked our build/);
    assert.equal(customEvents(events, "run_iteration").length, 1, "victory ends the run immediately");
    assert.equal(counts.panel, 3, "the panel is a majority of three independent votes");
  });

  it("keeps going when the panel still prefers the reference", async () => {
    const { events, report } = await runOnce({ compare: "challenger", panel: "reference" }, { maxIterations: 3 });
    assert.equal(report.victory, false);
    assert.equal(
      customEvents(events, "run_iteration").length,
      3,
      JSON.stringify({ report, terminal: customEvents(events, "run_finished") }),
    );
    assert.match(String(report.stoppedBecause), /iteration budget/);
  });
});

describe("gauntlet: judge outages", () => {
  it("a judge that fails twice and then answers still produces a verdict", async () => {
    // One transient hiccup must not end an 8-hour run: the verdict gets retried, and the
    // run continues as if nothing happened.
    const { events, report, counts } = await runOnce({
      compare: "challenger",
      failCompares: 2,
      failStatus: 500,
    });
    const iterations = customEvents(events, "run_iteration");
    assert.equal(iterations.length, 1, "the hiccup cost retries, not the iteration");
    assert.equal(iterations[0]!.winner, "challenger");
    assert.equal(counts.compare, 3, "two failed attempts plus the answer that landed");
    assert.ok(!String(report.stoppedBecause).includes("judge unavailable"), "a recovered judge is not an outage");
  });

  it("one exhausted outage costs an iteration as an auto-tie, and the run continues", async () => {
    // An outage buys exactly one invented verdict: a tie, which the incumbent rule turns into
    // a rollback. The cost is visible — an iteration spent, the incident in its reason string —
    // and the run keeps going.
    const { events, report, counts } = await runOnce(
      { compare: "tie", failCompareAt: [1, 2, 3] },
      { maxIterations: 2 },
    );
    const iterations = customEvents(events, "run_iteration");
    assert.equal(
      iterations.length,
      2,
      `the outage cost one iteration, not the run; stoppedBecause=${report.stoppedBecause}; error=${report.error ?? "none"}`,
    );
    assert.equal(iterations[0]!.winner, "incumbent", "an auto-tie must not advance the challenger");
    assert.match(
      String(iterations[0]!.reason),
      /judge unavailable — auto-tie \(1 of 2\)/,
      "the morning review can read the incident off the iteration record",
    );
    assert.equal(iterations[1]!.winner, "incumbent", "iteration 2 was judged for real");
    assert.ok(!String(iterations[1]!.reason).includes("judge unavailable"), "a recovered judge answers for itself");
    assert.equal(counts.compare, 4, "three dead attempts, then the answer that landed");
    assert.match(String(report.stoppedBecause), /iteration budget/);
  });

  it("a verdict between outages resets the allowance — only CONSECUTIVE outages end the run", async () => {
    // Iterations 1 and 3 each lose their judge; iteration 2's verdict lands. Two outages with
    // a real answer between them are weather twice over, not a pattern.
    const { events, report } = await runOnce(
      { compare: "tie", failCompareAt: [1, 2, 3, 5, 6, 7] },
      { maxIterations: 3 },
    );
    const iterations = customEvents(events, "run_iteration");
    assert.equal(iterations.length, 3);
    assert.match(String(iterations[0]!.reason), /auto-tie \(1 of 2\)/);
    assert.match(String(iterations[2]!.reason), /auto-tie \(1 of 2\)/, "the reset re-arms the allowance");
    assert.match(String(report.stoppedBecause), /iteration budget/);
  });

  it("a judge that stays down ends the run honestly on the second consecutive outage", async () => {
    // The first outage is spent as an auto-tie; a second in a row is a pattern no verdict may
    // be invented from. The run ends, and everything a morning needs is still on disk.
    const { events, report, rig, runId, counts } = await runOnce(
      { compare: "challenger", failCompares: Number.POSITIVE_INFINITY },
      { maxIterations: 3 },
    );
    assert.equal(report.victory, false);
    assert.match(
      String(report.stoppedBecause),
      /judge unavailable on iterations 1 and 2/,
      "the honest ending names both dead iterations",
    );
    const iterations = customEvents(events, "run_iteration");
    assert.equal(iterations.length, 1, "the auto-tie is recorded; the second unjudged attempt is not anyone's win");
    assert.equal(iterations[0]!.winner, "incumbent");
    assert.match(String(iterations[0]!.reason), /auto-tie \(1 of 2\)/);
    assert.equal(counts.compare, 6, "both iterations spent their retries before the run gave up");
    assert.equal(customEvents(events, "run_finished").length, 1, "the run closes, it does not crash");
    const written = JSON.parse(await readFile(path.join(rig.core.layout.runs, runId, "report.json"), "utf8"));
    assert.match(String(written.stoppedBecause), /judge unavailable/);
    assert.ok(report.finalSnapshot, "the incumbent snapshot is still named for the morning");
    // Both unjudged challengers are rolled back — same rule as a tie: never end below the start.
    await assert.rejects(
      () => readFile(path.join(rig.core.layout.gamesRoot, "pong", "src", "feature.js"), "utf8"),
      /ENOENT/,
    );
  });

  it("a dead reference panel spends the same allowance: the win stands and the run continues", async () => {
    // The blind win is already the new incumbent; only the exit question went unanswered. One
    // dead panel must not end the run — the incident lands on the report for the morning.
    const { events, report, rig, counts } = await runOnce(
      { compare: "challenger", failPanels: 3 },
      { maxIterations: 2 },
    );
    const iterations = customEvents(events, "run_iteration");
    assert.equal(iterations.length, 2, "the dead panel did not end the run");
    assert.equal(iterations[0]!.winner, "challenger", "the blind win is never rolled back by a panel outage");
    assert.match(String(report.stoppedBecause), /iteration budget/);
    assert.match(
      String((report.iterations as Array<{ judgeOutage?: string }>)[0]!.judgeOutage),
      /reference panel unavailable/,
      "the report carries the incident beside the iteration it hit",
    );
    assert.equal(counts.panel, 6, "three dead attempts on iteration 1, three live votes on iteration 2");
    // The winner's work survives to the end of the run.
    const feature = await readFile(path.join(rig.core.layout.gamesRoot, "pong", "src", "feature.js"), "utf8");
    assert.match(feature, /challenger attempt/);
  });
});

describe("gauntlet: engine signals", () => {
  it("stops after one build attempt when the contractor sign-in has expired", async () => {
    // Before the fix, runTurn's needs_signin outcome was discarded: the run read a dead login
    // as a finished build and re-delegated into the same wall every iteration until morning.
    const rig = await startRig({});
    rigs.push(rig);
    let delegations = 0;
    const vendor: Engine = {
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async () => {
        delegations++;
        throw new EngineError("auth", "vendor", "OAuth session expired — sign in again");
      },
    };
    rig.core.engines.register(vendor);

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make a ring-flying game",
      project: "pong",
      engine: "vendor",
      reference: { name: "speed and clarity", shots: [], kind: "direction" },
      budgets: { wallClockMs: 120_000, maxIterations: 5 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").length >= 1,
      60_000,
      "run_finished after auth failure",
    );
    const report = customEvents(events, "run_finished")[0]!;
    assert.equal(delegations, 1, "a dead sign-in must not be re-delegated into");
    assert.match(String(report.stoppedBecause), /sign in/i);
    assert.equal(customEvents(events, "run_iteration").length, 0, "no verdict is invented for a build that never ran");
    assert.equal(customEvents(events, "needs_signin").length, 1, "the UI's sign-in affordance is triggered");
  });

  it("waits out a throttle window before the next iteration when no fallback is ready", async () => {
    const buildTimes: number[] = [];
    let throttled = false;
    const rig = await startRig({
      respond: (request) => {
        const text = request.messages.map((m) => m.content).join("\n");
        if (text.includes("BUILD A") && text.includes("BUILD B")) {
          return { text: JSON.stringify({ pick: "tie", biggest_gap: "presence", reason: "scripted" }) };
        }
        // Only the run's own build briefs count — the post-run self-improvement pass also
        // calls the model, and its requests must not pollute the timing.
        if (!text.includes("unattended run")) return { text: "ok" };
        buildTimes.push(Date.now());
        if (!throttled) {
          throttled = true;
          return { httpStatus: 429, body: JSON.stringify({ error: { message: "throttled; retry-after: 1" } }) };
        }
        return { text: "Done with this iteration." };
      },
    });
    rigs.push(rig);

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make a ring-flying game",
      project: "pong",
      reference: { name: "speed and clarity", shots: [], kind: "direction" },
      budgets: { wallClockMs: 120_000, maxIterations: 2 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").length >= 1,
      90_000,
      "run_finished after throttle",
    );
    const report = customEvents(events, "run_finished")[0]!;

    const backoffs = customEvents(events, "run_backoff");
    assert.equal(backoffs.length, 1, "the pause is in the log, not silent");
    assert.equal(backoffs[0]!.waitMs, 1_000, "the engine's own retry-after is obeyed, not a guess");
    assert.ok(buildTimes.length >= 2, "the run kept iterating after the throttle");
    const delta = buildTimes[1]! - buildTimes[0]!;
    assert.ok(delta >= 950, `the next build waited out the window (got ${delta}ms)`);
    assert.ok(!String(report.stoppedBecause).includes("in a row"), "one throttle survived is not a run-ending outage");
  });

  it("three consecutive engine failures end the run honestly instead of burning the budget", async () => {
    let builds = 0;
    const rig = await startRig({
      respond: (request) => {
        const text = request.messages.map((m) => m.content).join("\n");
        if (text.includes("BUILD A") && text.includes("BUILD B")) {
          return { text: JSON.stringify({ pick: "tie", biggest_gap: "presence", reason: "scripted" }) };
        }
        // The post-run self-improvement pass also calls the model; only build briefs count.
        if (!text.includes("unattended run")) return { text: "ok" };
        builds++;
        return { httpStatus: 429, body: JSON.stringify({ error: { message: "throttled; retry-after: 0" } }) };
      },
    });
    rigs.push(rig);

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make a ring-flying game",
      project: "pong",
      reference: { name: "speed and clarity", shots: [], kind: "direction" },
      budgets: { wallClockMs: 120_000, maxIterations: 8 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").length >= 1,
      90_000,
      "run_finished after engine outage",
    );
    const report = customEvents(events, "run_finished")[0]!;
    assert.equal(builds, 3, "the engine gets three chances, not the whole iteration budget");
    assert.match(String(report.stoppedBecause), /3 build turns in a row/);
    assert.equal(
      customEvents(events, "run_iteration").length,
      3,
      "each lost turn is still recorded and rolled back before the run closes",
    );
  });
});

describe("gauntlet: evidence and artefacts", () => {
  it("captures deterministic evidence and writes a reviewable timeline", async () => {
    const { events, rig, runId } = await runOnce({ compare: "challenger" });
    const iteration = customEvents(events, "run_iteration")[0]!;

    // Deterministic playthrough: seeded, then stepped by hand.
    const seeded = rig.preview.calls.filter((call) => call.method === "seed");
    const stepped = rig.preview.calls.filter((call) => call.method === "step");
    assert.ok(seeded.length >= 1, "the run seeds the game before judging");
    assert.ok(stepped.length >= 5, "the run steps the game deterministically");
    assert.equal(seeded[0]!.arg, 1234, "the same seed is used every iteration so builds compare");
    assert.ok(
      rig.preview.inputs.length >= 1,
      "the critic drives WASD/look, not only the clock — otherwise feel/play judge an idle scene",
    );

    // Screenshots from named cameras, saved under the run — with the pixel counts beside them.
    const shots = iteration.shots as Array<{ camera: string; path: string; stats: { litFraction: number } | null }>;
    // Three frames through the CAMERA FLOOR, not through a hard-coded trio: this game declares
    // no cameras at all (the fake answers `cameras()` with `{ok:true}`, as the template's own
    // one-camera build effectively does), so the pass asks for close and wide on top of default
    // and treats an unregistered one of them as "not registered", never as a defect.
    assert.equal(rig.preview.cameraNames, undefined, "nothing was declared; the floor supplied the other two");
    assert.deepEqual(
      shots.map((shot) => shot.camera),
      ["default", "close", "wide"],
    );
    // …and the user's-eye frame is dropped, because nothing outside the canvas differs.
    assert.ok(!shots.some((shot) => shot.camera === "user:view"), "no page frame when the page and the canvas agree");
    for (const shot of shots) {
      const bytes = await readFile(shot.path);
      assert.ok(bytes.length > 1_000, `${shot.camera} screenshot should have content`);
      assert.ok(shot.path.startsWith(path.join(rig.core.layout.runs, runId)));
      assert.equal(typeof shot.stats?.litFraction, "number", "pixel stats ride beside every logged shot");
    }

    const verdict = JSON.parse(
      await readFile(path.join(rig.core.layout.runs, runId, "iter_001", "verdict.json"), "utf8"),
    );
    assert.equal(verdict.iteration, 1);
    assert.ok(verdict.biggest_gap);

    const report = JSON.parse(await readFile(path.join(rig.core.layout.runs, runId, "report.json"), "utf8"));
    assert.equal(report.runId, runId);
    assert.equal(report.iterations.length, 1);
  });

  it("records the run in the log so a morning report can be rebuilt from it alone", async () => {
    const { events } = await runOnce({ compare: "challenger" });
    assert.equal(customEvents(events, "run_started").length, 1);
    assert.equal(customEvents(events, "run_finished").length, 1);
    assert.ok(
      events.some((e) => e.data.type === "snapshot_created"),
      "every iteration is snapshotted, which is what makes the timeline playable",
    );
  });
});

describe("gauntlet: the judge sees both sides", () => {
  it("gives the judge evidence for the incumbent, never a bare snapshot id", async () => {
    // The first live run's judge saw one side described as "snapshot: <id>" and nothing else —
    // and rejected two real improvements against a build it knew nothing about.
    const { rig, runId } = await runOnce({ compare: "challenger" });
    const compares = rig.server.requests
      .map((r) => r.body as { messages?: Array<{ role: string; content: unknown }> } | null)
      .filter((b) => b?.messages?.some((m) => flattenMessageContent(m.content).includes("BUILD A")));
    assert.ok(compares.length >= 1, "a blind comparison was requested");
    const text = compares[0]!.messages!.map((m) => flattenMessageContent(m.content)).join("\n");
    assert.match(
      text,
      /BUILD [AB]\nstate ~1s in, before the scripted controls/,
      "both sides carry probe evidence without revealing their origin",
    );
    assert.doesNotMatch(text, /previously accepted|incumbent|challenger/i);
    assert.ok(!text.includes("→ /"), "no screenshot file paths are fed to a judge that cannot open files");
    assert.match(
      text,
      /state after the scripted controls and ~30s of deterministic play/,
      "the probe plays long enough for something to happen",
    );
    assert.equal(countImages(compares[0]!.messages), 2, "one default-camera still per build is attached");
    assert.match(text, /IMAGES ATTACHED/, "the prompt tells the judge the pictures are the comparison");

    const log = await rig.core.store.listEvents(await rig.core.threadForGame("pong"));
    const started = customEvents(log, "run_started")[0] as { reference?: { frames?: unknown; frameCount?: number } };
    assert.equal(started?.reference?.frames, undefined, "pixels must not be written into the event log");
    assert.equal(started?.reference?.frameCount, 0);
    const iteration = customEvents(log, "run_iteration")[0];
    const loggedShots = iteration?.shots as Array<Record<string, unknown>> | undefined;
    assert.ok(
      loggedShots?.every((shot) => !("base64" in shot)),
      "logged shots are paths and sizes, not pixels",
    );
    const incumbentShots = iteration?.incumbentShots as Array<Record<string, unknown>> | undefined;
    assert.ok(
      incumbentShots && incumbentShots.length >= 1,
      "the starting build's stills are logged beside the challenger",
    );
    assert.ok(incumbentShots.every((shot) => !("base64" in shot)));
    assert.ok(String(incumbentShots[0]!.path).includes("iter_000"));
    assert.equal(iteration?.runId, runId);
    assert.equal(iteration?.project, "pong");
    assert.equal(typeof iteration?.attemptSnapshot, "string");
  });

  it("attaches the user's reference stills to the judge, and reports GPU errors without auto-losing", async () => {
    const still = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const { rig, report, events } = await runOnce(
      { compare: "challenger" },
      {
        preview: (next) => {
          next.preview.gpuErrors = async () => ["GL_INVALID_OPERATION"];
        },
        reference: {
          name: "Race the Sun",
          shots: [],
          kind: "reference",
          notes: "speed and clarity",
          frames: [
            { label: "title", mimeType: "image/jpeg", data: still },
            { label: "play", mimeType: "image/jpeg", data: still },
          ],
        },
      },
    );
    const compares = rig.server.requests
      .map((r) => r.body as { messages?: Array<{ role: string; content: unknown }> } | null)
      .filter((b) => b?.messages?.some((m) => flattenMessageContent(m.content).includes("BUILD A")));
    assert.ok(
      compares.length,
      JSON.stringify({
        report,
        events: events
          .map((e) => e.data)
          .filter((d) => d.type === "custom" && /error|failed|finished/.test(d.event_type)),
      }),
    );
    const text = compares[0]!.messages!.map((m) => flattenMessageContent(m.content)).join("\n");
    assert.match(text, /REFERENCE \/ title/, "the bar's stills are labelled in the prompt");
    assert.match(text, /WebGL errors \(GPU process\): GL_INVALID_OPERATION/, "GPU errors reach the judge as evidence");
    assert.equal(countImages(compares[0]!.messages), 4, "two default-camera build stills and two reference stills");
    const log = await rig.core.store.listEvents(await rig.core.threadForGame("pong"));
    const started = customEvents(log, "run_started")[0] as { reference?: { frameCount?: number } };
    assert.equal(started?.reference?.frameCount, 2, "the log records how many stills were given, not the pixels");
    const iteration = customEvents(log, "run_iteration")[0];
    assert.deepEqual(iteration?.gpuErrors, ["GL_INVALID_OPERATION"]);
    assert.equal(iteration?.winner, "challenger", "a GPU error is evidence, not an automatic loss");
  });

  it("refuses a beat-a-real-game run that has a name but no stills", async () => {
    const { report, counts } = await runOnce(
      { compare: "challenger" },
      { reference: { name: "Vampire Survivors", shots: [], kind: "reference" } },
    );
    assert.equal(report.victory, false);
    assert.match(String(report.stoppedBecause), /no reference screenshots/);
    assert.equal(counts.compare, 0, "no judge call is spent on a bar the critic cannot see");
    assert.equal(counts.build, 0, "the builder is not started either");
  });

  it("a direction run spends its whole budget iterating — no reference panel against a vibe", async () => {
    const { report, counts, rig } = await runOnce(
      { compare: "challenger", panel: "build" },
      { maxIterations: 2, reference: { name: "more to touch, kick and hear", shots: [], kind: "direction" } },
    );
    assert.equal(counts.panel, 0, "no exit panel is convened when there is no reference game to beat");
    assert.equal(report.victory, false);
    assert.match(String(report.stoppedBecause), /iteration budget/);
    const briefs = rig.server.requests
      .map((r) => r.body as { messages?: Array<{ role: string; content: unknown }> } | null)
      .filter((b) =>
        b?.messages?.some((m) => flattenMessageContent(m.content).includes("DIRECTION (feeling): more to touch")),
      );
    assert.ok(briefs.length >= 1, "the builder is briefed with a DIRECTION, not a fake quality bar");
  });
});

describe("gauntlet: where the story lands", () => {
  it("logs the run into the game's own thread and feeds self-improvement afterwards", async () => {
    const { rig } = await runOnce({ compare: "challenger" });

    // The run is that game's story: its chat shows the start, every verdict, and the ending.
    const gameThread = await rig.core.threadForGame("pong");
    assert.notEqual(gameThread, rig.core.mainThread, "a run must not land in the studio thread");
    const threadEvents = await rig.core.store.listEvents(gameThread);
    for (const type of ["run_started", "run_iteration", "run_finished"]) {
      assert.ok(
        threadEvents.some((e) => e.data.type === "custom" && e.data.event_type === type),
        `${type} belongs to the game's chat`,
      );
    }

    // Nobody pressed a button: the finished run was mined for lessons on the spot.
    const all = await waitForLog(
      rig.core,
      (log) => customEvents(log, "skillopt_pass").length >= 1,
      30_000,
      "skillopt_pass after the run",
    );
    const pass = customEvents(all, "skillopt_pass").at(-1)!;
    assert.ok(Number(pass.tasks) >= 1, "the run's iterations became validation evidence");
  });
});

describe("gauntlet: faceted critic", () => {
  it("combines facets in code: visuals win, feel vetoes a prettier loss, visual tie can still advance", () => {
    const visualWin = combineFacetVerdict(
      { facets: { works: "A", visuals: "A", feel: "tie", play: "tie" }, biggest_gap: "lighting" },
      true,
    );
    assert.equal(visualWin.pick, "challenger");

    const feelVeto = combineFacetVerdict(
      { facets: { works: "tie", visuals: "A", feel: "B", play: "A" }, biggest_gap: "the camera is numb" },
      true,
    );
    assert.equal(feelVeto.pick, "incumbent", "a prettier build that feels worse must not advance");

    const visualTiePlay = combineFacetVerdict(
      { facets: { works: "tie", visuals: "tie", feel: "A", play: "A" }, biggest_gap: "the verb is still thin" },
      true,
    );
    assert.equal(visualTiePlay.pick, "challenger");

    const legacy = combineFacetVerdict({ pick: "B", biggest_gap: "x" }, true);
    assert.equal(legacy.pick, "incumbent");
  });

  it("the judge's defect ledger is uncapped, deduped, and backwards-compatible", () => {
    // A full list rides through untouched (order preserved, whitespace trimmed, dupes dropped).
    assert.deepEqual(
      normalizeDefects({
        defects: [
          " seam in the water — camBridge ",
          "hand is blobby — default",
          "seam in the water — camBridge",
          "",
          7,
        ],
      }),
      ["seam in the water — camBridge", "hand is blobby — default"],
    );
    // Old-format verdicts (biggest_gap only) become a one-entry ledger — no migration anywhere.
    assert.deepEqual(normalizeDefects({ biggest_gap: "the rings need more contrast" }), [
      "the rings need more contrast",
    ]);
    // Nothing reported is an empty ledger, not a phantom defect.
    assert.deepEqual(normalizeDefects({ biggest_gap: "" }), []);
    assert.deepEqual(normalizeDefects({}), []);
  });

  it("a prettier build that feels worse keeps the incumbent", async () => {
    const { events } = await runOnce({
      compare: "challenger",
      facets: { works: "tie", visuals: "challenger", feel: "incumbent", play: "challenger" },
    });
    assert.equal(customEvents(events, "run_iteration")[0]!.winner, "incumbent");
  });

  it("visuals can advance the challenger when feel does not veto", async () => {
    const { events } = await runOnce({
      compare: "incumbent",
      facets: { works: "tie", visuals: "challenger", feel: "tie", play: "tie" },
    });
    assert.equal(customEvents(events, "run_iteration")[0]!.winner, "challenger");
  });
});

describe("gauntlet: briefs and intake", () => {
  it("iteration 1 is a first playable, later iterations close one visual-first gap, the tail integrates", () => {
    const run = {
      runId: "run_test",
      project: "city",
      goal: "AAA rainy city",
      reference: { name: "AAA photoreal rainy night", shots: [], kind: "direction" as const },
      budgets: { wallClockMs: 8 * 3_600_000 },
    };
    assert.match(buildBrief({ run, iteration: 1, biggestGap: "n/a", phase: "first" }), /first playable/);
    assert.match(
      buildBrief({ run, iteration: 3, biggestGap: "the wet road reads plastic", phase: "gap" }),
      /wet road reads plastic/,
    );
    assert.match(buildBrief({ run, iteration: 9, biggestGap: "the camera", phase: "integrate" }), /integration pass/);
  });

  it("a mechanical failure is quoted as a failure report, never billed as the design gap", () => {
    const run = {
      runId: "run_test",
      project: "city",
      goal: "AAA rainy city",
      reference: { name: "AAA photoreal rainy night", shots: [], kind: "direction" as const },
      budgets: { wallClockMs: 8 * 3_600_000 },
    };
    const brief = buildBrief({
      run,
      iteration: 4,
      biggestGap: "the wet road reads plastic",
      lastFailure: "the build turn failed: Request timed out.",
      phase: "gap",
    });
    assert.match(brief, /never reached the blind judge/);
    assert.match(brief, /Request timed out/);
    assert.match(brief, /wet road reads plastic/, "the last real creative gap still travels with the brief");
    assert.ok(
      !brief.includes("SINGLE BIGGEST REMAINING GAP"),
      "an error string must not be framed as a gap for the builder to close",
    );
  });

  it("after a broken iteration the next brief carries the failure, and the creative gap survives it", async () => {
    // Iteration 1 renders black (broken); iteration 2 is lit and judged normally.
    let fake: Rig["preview"] | null = null;
    let attempt = 0;
    const { rig } = await runOnce(
      {
        compare: "tie",
        onBuild: () => {
          attempt++;
          if (fake) fake.pixelStatsNext = { ...fake.pixelStatsNext, litFraction: attempt === 1 ? 0 : 0.6 };
        },
      },
      {
        maxIterations: 2,
        preview: (r) => {
          fake = r.preview;
        },
      },
    );
    const briefs = rig.server.requests
      .map((r) => r.body as { messages?: Array<{ role: string; content: unknown }> } | null)
      .filter((b) =>
        b?.messages?.some((m) => flattenMessageContent(m.content).includes("never reached the blind judge")),
      );
    assert.ok(briefs.length >= 1, "iteration 2 is told the previous attempt failed, not what to 'close'");
    const text = briefs[0]!.messages!.map((m) => flattenMessageContent(m.content)).join("\n");
    assert.match(text, /renders effectively black/, "the mechanical reason is quoted verbatim");
    assert.match(text, /speed and clarity/, "the last real gap (the reference notes) is still the creative target");
    assert.ok(!text.includes("THE SINGLE BIGGEST REMAINING GAP"));
  });

  it("the first live iteration is briefed as a first playable", async () => {
    const { rig } = await runOnce({ compare: "challenger" });
    const briefs = rig.server.requests
      .map((r) => r.body as { messages?: Array<{ role: string; content: unknown }> } | null)
      .filter((b) => b?.messages?.some((m) => flattenMessageContent(m.content).includes("first playable")));
    assert.ok(briefs.length >= 1, "iteration 1 must not be a tiny gap-close");
  });

  it("Loop-on intake starts a run via start_unattended_run without a title quiz", async () => {
    let commissioned = false;
    const rig = await startRig({
      respond: (request) => {
        const text = request.messages.map((m) => String(m.content ?? "")).join("\n");
        if (text.includes("BUILD A") && text.includes("BUILD B")) {
          return { text: JSON.stringify({ pick: "tie", biggest_gap: "presence", reason: "scripted" }) };
        }
        if (!commissioned) {
          commissioned = true;
          return {
            toolCalls: [
              {
                id: "c1",
                name: "start_unattended_run",
                arguments: {
                  goal: "AAA photoreal rainy night city you walk through",
                  direction: "AAA photoreal rainy night city",
                },
              },
            ],
            text: "Starting the run.",
          };
        }
        if (text.includes("unattended run")) {
          return {
            toolCalls: [
              {
                id: "c2",
                name: "write_file",
                arguments: { project: "rainy-night-city", file: "src/run.js", contents: "export const run = 1;\n" },
              },
            ],
            text: "Building the first playable.",
          };
        }
        return { text: "Done." };
      },
    });
    rigs.push(rig);

    const threadId = await rig.core.createGameThread();
    await rig.core.sendUserMessage("I want to make some kind of game", { thread: threadId, loop: { hours: 1 } });

    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_started").length >= 1,
      45_000,
      "run_started from intake",
    );
    const started = customEvents(events, "run_started")[0]!;
    assert.match(String(started.goal), /rainy/);
    assert.equal(started.reference && (started.reference as { kind?: string }).kind, "direction");
    assert.equal(started.project, "rainy-night-city");
    const launched = await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 1,
      5000,
      "intake acknowledged after launch",
    );
    assert.equal(
      customEvents(launched, "run_finished").length,
      0,
      "a launched commission is handled while its build remains active, so restart cannot replay intake",
    );
    await rig.core.sendUserMessage("Which checks passed?", { thread: threadId });
    const queued = await rig.core.store.listEvents(threadId);
    assert.equal(customEvents(queued, "coordinator_message_queued").length, 2);
    assert.equal(
      customEvents(queued, "coordinator_message_handled").length,
      1,
      "the next message waits for the build despite the handled intake",
    );

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.ok(completions.length >= 1, "the interview called the model");
    assert.match(JSON.stringify(completions[0]!.body), /Loop is ON/);
    assert.match(JSON.stringify(completions[0]!.body), /Never quiz them on game titles/);

    await rig.core.stopThread(threadId);
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 2,
      15000,
      "queued follow-up after Stop",
    );
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").length >= 1,
      30_000,
      "run_finished after stop",
    );
  });
});

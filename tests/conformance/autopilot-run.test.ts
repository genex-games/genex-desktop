/**
 * Autopilot — the orchestrator over the real rig.
 *
 * Real harness process, real substrate, real git snapshots, scripted model. The scripted
 * responder plays every role the run asks for: the decomposer, the facet builders, the blind
 * facet critics, and the global judge. On the rig's direct (fake-ollama) engine the profile
 * forces sequential facets against the live folder — the A7 local path.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { newestFixtureBuild, type FakeReply } from "../helpers/fake-ollama.ts";
import type { CompleteRequest, DelegateRequest } from "../../src/substrate/engines/types.ts";
import {
  concurrencyProfile,
  decompose,
  inheritedConsoleAfterLoad,
  makeLock,
  schedule,
} from "../../src/harness-seed/loop/autopilot.ts";
import {
  acceptRound,
  chooseMove,
  facetPrompt,
  moveVerdict,
  movesThisRound,
  runFacetLoop,
  tooLateToStart,
} from "../../src/harness-seed/loop/facet-loop.ts";
import { iterationDigest } from "../../src/harness-seed/loop/director.ts";
import { launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import { renderBrief } from "../../src/harness-seed/loop/library.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

// A v2 plan: typed specs with checks the harness can score against the fake preview's stats
// (litFraction 0.6, meanLuma 42/255 ≈ 0.16), so both identity checks pass on the first build.
const PLAN = {
  facets: [
    {
      id: "terrain",
      title: "Terrain",
      intent: "sculpt the terrain and skybox",
      owns: ["src/terrain.js"],
      identity: ["terrain"],
      budgetShare: 0.5,
      checks: [{ id: "terrain-lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" }],
    },
    {
      id: "lighting",
      title: "Lighting",
      intent: "moody sunset lighting",
      owns: ["src/lighting.js"],
      identity: ["mood"],
      budgetShare: 0.5,
      checks: [{ id: "moody-luma", kind: "pixel", camera: "default", expr: "meanLuma < 0.6", weight: "identity" }],
    },
  ],
  // Every trait is off unless the plan declares one (M4.4): a plan that says nothing gets no
  // HUD rule, no look check and no movement check, so the rig declares the kind it means.
  game: { kind: "first-person" },
  mainOwner: "terrain",
  base: { notes: "one palette", files: [{ path: "src/palette.js", purpose: "shared colours" }] },
  integrationNotes: "shared palette",
  assumptions: ["chose sunset lighting — no reference given"],
};

/** A delegated prompt that is a facet build turn (not the base builder, integrator or playtester). */
function facetPromptOf(prompt: string): "terrain" | "lighting" | null {
  if (prompt.includes("YOUR FACET: Terrain")) return "terrain";
  if (prompt.includes("YOUR FACET: Lighting")) return "lighting";
  return null;
}

/** Which facet a builder brief belongs to, read off the brief itself. */
function facetOf(text: string): string | null {
  if (text.includes("YOUR FACET: Terrain")) return "terrain";
  if (text.includes("YOUR FACET: Lighting")) return "lighting";
  return null;
}

function makeAutopilotResponder(
  options: {
    plan?: unknown;
    /** Per-facet exit rule: given the facet id and how often it has been judged, is it satisfied? */
    satisfiedWhen?: (facet: string, judgeCount: number) => boolean;
  } = {},
) {
  const buildsByFacet = new Map<string, number>();
  const judgesByFacet = new Map<string, number>();
  const order: string[] = [];
  const builderPrompts: string[] = [];
  const counts = { decompose: 0, facetJudge: 0, globalJudge: 0, builds: 0, playtests: 0 };
  const respond = (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
    const text = request.messages.map((m) => m.content).join("\n");

    // The decomposer: the only prompt carrying the engine hint.
    if (text.includes("ENGINE HINT: maxParallel")) {
      counts.decompose++;
      return { text: JSON.stringify(options.plan ?? PLAN) };
    }

    // Facet critic — checked before the global judge: both carry BUILD A/B, only this one
    // names the facet under judgement.
    if (text.includes("THE FACET UNDER JUDGEMENT")) {
      counts.facetJudge++;
      const facet = text.includes("THE FACET UNDER JUDGEMENT: Terrain") ? "terrain" : "lighting";
      const judged = (judgesByFacet.get(facet) ?? 0) + 1;
      judgesByFacet.set(facet, judged);
      const aIsIncumbent = newestFixtureBuild(request) === "B";
      return {
        text: JSON.stringify({
          pick: aIsIncumbent ? "B" : "A", // always the challenger
          satisfied: options.satisfiedWhen ? options.satisfiedWhen(facet, judged) : true,
          biggest_gap: "more depth in the fog",
          reason: "scripted facet critic",
        }),
      };
    }

    // Global blind verdict at the end of the run.
    if (text.includes("BUILD A") && text.includes("BUILD B")) {
      counts.globalJudge++;
      const aIsIncumbent = newestFixtureBuild(request) === "B";
      return {
        text: JSON.stringify({ pick: aIsIncumbent ? "B" : "A", biggest_gap: "", reason: "scripted global" }),
      };
    }

    // The playtester (integration facet): answers its play checks after "playing".
    if (text.includes("QUESTIONS TO ANSWER AT THE END")) {
      counts.playtests++;
      return {
        text: JSON.stringify({
          answers: { "integration-play": { answer: "yes", note: "walked the world" } },
          report: "scripted play",
        }),
      };
    }

    // Builder turns inside a facet loop: one write, then done.
    const facet = facetOf(text);
    if (facet) {
      builderPrompts.push(text);
      const n = (buildsByFacet.get(facet) ?? 0) + 1;
      buildsByFacet.set(facet, n);
      if (n % 2 === 1) {
        counts.builds++;
        order.push(facet);
        return {
          toolCalls: [
            {
              id: `call_${facet}_${n}`,
              name: "write_file",
              arguments: {
                project: "duskworld",
                file: `src/${facet}.js`,
                contents: `// ${facet} work\nexport const ${facet} = true;\n`,
              },
            },
          ],
          text: `Working on ${facet}.`,
        };
      }
      return { text: `Done with ${facet} for this iteration.` };
    }

    return { text: "ok" };
  };
  return { respond, counts, order, builderPrompts };
}

describe("autopilot scheduling primitives", () => {
  it("concurrencyProfile: direct engines are sequential, delegated parallel", () => {
    const described = [
      { id: "ollama", kind: "direct" },
      { id: "claude-code", kind: "delegated" },
      { id: "codex", kind: "delegated" },
    ];
    assert.deepEqual(concurrencyProfile(described as never, "ollama"), { maxParallel: 1, delegated: false });
    assert.equal(concurrencyProfile(described as never, "claude-code").maxParallel > 1, true);
    assert.equal(concurrencyProfile(described as never, "codex").maxParallel > 1, true);
  });

  it("schedule() with maxParallel 1 runs items strictly in order; >1 overlaps", async () => {
    const events: string[] = [];
    await schedule([1, 2, 3], 1, async (n: number) => {
      events.push(`start${n}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end${n}`);
    });
    assert.deepEqual(events, ["start1", "end1", "start2", "end2", "start3", "end3"]);

    const overlapped: string[] = [];
    await schedule([1, 2], 2, async (n: number) => {
      overlapped.push(`start${n}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      overlapped.push(`end${n}`);
    });
    assert.deepEqual(overlapped.slice(0, 2), ["start1", "start2"], "two workers start before either ends");
  });

  it("takes the run's console baseline after the game is up, not at did-finish-load", async () => {
    // `preview.load` resolves at did-finish-load — before the first frame, before a shader
    // compiles. Read on the next line, the baseline missed exactly the error it exists to
    // forgive, and the base pass then voided the build for inheriting it.
    let up = false;
    const asked: string[] = [];
    const ctx = {
      call: async (method: string) => {
        asked.push(method);
        if (method === "preview.evaluate") {
          const answer = up;
          up = true; // the game comes up between the first look and the second
          return answer;
        }
        if (method === "preview.console")
          return up
            ? [
                { level: "error", message: "THREE.WebGLProgram: shader error" },
                { level: "warn", message: "noisy" },
              ]
            : [];
        return null;
      },
    };
    assert.deepEqual(await inheritedConsoleAfterLoad(ctx as never, { settleMs: 3_000, beatMs: 1 }), [
      "THREE.WebGLProgram: shader error",
    ]);
    assert.ok(asked.filter((m) => m === "preview.evaluate").length >= 2, "it waits for the game to say it is up");
    // A game that never comes up costs the settle and no more.
    const dead = { call: async () => null };
    assert.deepEqual(await inheritedConsoleAfterLoad(dead as never, { settleMs: 1, beatMs: 1 }), []);
  });

  it("promises the run only once the start can be accepted", async () => {
    const appended: Array<{ batch: Array<Record<string, unknown>> }> = [];
    const host = {
      workspace: "/nowhere",
      notify: () => {},
      heartbeat: () => {},
      call: async (method: string, params: { batch: Array<Record<string, unknown>> }) => {
        if (method === "game.list") return [{ name: "moth" }];
        if (method === "game.validate") return { contract: "loaded", problems: [] };
        if (method === "events.append") appended.push(params);
        return null;
      },
    };
    const ctx = { ...host, threadId: "t-1", cancelled: false, setStatus: () => {} };
    const running = { runId: "run-1", project: "moth", goal: "g" };
    const studio = {
      host,
      cancels: new Set<string>(),
      moodBoards: new Map(),
      activeRuns: new Map([["run-1", { run: running, threadId: "t-1", settled: Promise.resolve() }]]),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ctx,
    };
    // A run already owning this chat or this game refuses the second one…
    await assert.rejects(
      launchFromIntake(studio as never, ctx as never, { threadId: "t-1", project: "moth" }, { goal: "a moth game" }),
      /a build is already running for moth/,
    );
    // …and it refuses before the user is promised a run that never starts.
    assert.doesNotMatch(JSON.stringify(appended), /Building until about/);
    // The boot path's own refusal reaches the chat, not only an event no surface renders.
    const run = {
      runId: "run-2",
      project: "moth",
      goal: "g",
      reference: { name: "r", shots: [] },
      budgets: { wallClockMs: 1 },
    };
    await handleRunStart(studio as never, { type: "run_start", threadId: "t-2", run });
    const refusal = appended.at(-1)?.batch ?? [];
    assert.deepEqual(
      refusal.map((entry) => entry.type),
      ["custom", "messages"],
    );
    assert.equal(refusal[0]?.event_type, "run_start_blocked");
    assert.equal(studio.startingRuns.size, 0, "a refused start reserves nothing");
  });

  it("makeLock() serialises holders", async () => {
    const lock = makeLock();
    const trace: string[] = [];
    const hold = async (name: string, ms: number) => {
      const release = await lock();
      trace.push(`in:${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      trace.push(`out:${name}`);
      release();
    };
    await Promise.all([hold("a", 20), hold("b", 5)]);
    assert.deepEqual(trace, ["in:a", "out:a", "in:b", "out:b"]);
  });
});

describe("autopilot: a 2-facet run on the fake engine", () => {
  it("decomposes, runs facets sequentially, integrates in place, and closes with a global verdict", async () => {
    const { respond, counts, order } = makeAutopilotResponder();
    const rig = await startRig({ respond });
    rigs.push(rig);

    assert.equal(rig.core.host.hasCapability("autopilot"), true, "the seed claims autopilot");

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a moody dusk exploration world",
      project: "duskworld",
      mode: "autopilot",
      classic: true,
      reference: { name: "quiet dusk wandering", shots: [], kind: "direction" },
      budgets: { wallClockMs: 300_000, maxIterations: 4 },
    });

    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
      120_000,
      "autopilot run_finished",
    );

    // The plan card and the decision card landed.
    const started = customEvents(events, "autopilot_started");
    assert.equal(started.length, 1);
    assert.deepEqual(
      (started[0]!.facets as Array<{ id: string }>).map((f) => f.id),
      ["terrain", "lighting"],
    );
    assert.equal(started[0]!.maxParallel, 1, "direct engine ⇒ sequential profile");
    const decisions = customEvents(events, "autopilot_decision");
    assert.equal(decisions.length, 1);
    assert.match(String(decisions[0]!.decision), /sunset lighting/);

    // The shared base was built and committed before the facets forked.
    const base = customEvents(events, "autopilot_base");
    assert.equal(base.length, 1);
    assert.equal(base[0]!.ok, true, JSON.stringify(base[0]));

    // Both facets iterated, each satisfied on its first win; sequential means terrain's build
    // finished before lighting's began. The merged build then got its own integration facet.
    const iterations = customEvents(events, "facet_iteration");
    assert.deepEqual([...new Set(iterations.map((i) => i.facetId))].sort(), ["integration", "lighting", "terrain"]);
    const facetIterations = iterations.filter((i) => i.facetId !== "integration");
    assert.ok(facetIterations.every((i) => i.winner === "challenger" && i.satisfied === true));
    assert.deepEqual(order, ["terrain", "lighting"], "facets built strictly one at a time");
    // Verified scoreboard: the planner's identity check passed and flipped on the first build,
    // beside the harness-owned checks (one screen on every facet, one input path on the
    // facet that owns main.js) — all measured, all passing on the fake game.
    for (const record of facetIterations) {
      const board = record.scoreboard as {
        total: number;
        passing: number;
        unmeasured: number;
        identityTotal: number;
        identityPassing: number;
        flips: string[];
        results: Array<{ id: string; pass: boolean | null }>;
      };
      const own = record.facetId === "terrain" ? "terrain-lit" : "moody-luma";
      assert.ok(board.flips.includes(own), `${own} flipped`);
      const measuredByHarness = board.results.filter((r) => !r.id.startsWith("defect-"));
      assert.ok(
        measuredByHarness.every((r) => r.pass === true),
        `every planner and harness check on ${record.facetId}'s board passed: ${JSON.stringify(board.results)}`,
      );
      // The facet critic's gap ("more depth in the fog") became a vision check, seeded as
      // failing on the build it was named on: an all-pass board never coexists with a defect.
      assert.ok(
        board.results.some((r) => r.id.startsWith("defect-more-depth") && r.pass === false),
        "the judge's gap is a failing check on the board",
      );
      assert.equal(board.unmeasured, 0);
      assert.equal(board.identityPassing, board.identityTotal);
      assert.ok(
        board.results.some((r) => r.id === "single-hud" && r.pass === true),
        "the harness-owned screen check rides on every facet",
      );
      assert.equal(
        board.results.some((r) => r.id === "look-turns-camera"),
        record.facetId === "terrain",
        "the input checks ride on the main owner only",
      );
      assert.equal(record.verdictSource, "checks");
    }
    const integration = iterations.find((i) => i.facetId === "integration")!;
    assert.equal(integration.winner, "challenger");
    assert.ok(counts.playtests >= 1, "the integrated build was playtested");
    assert.ok(
      (integration.scoreboard as { results: Array<{ id: string; pass: boolean }> }).results.some(
        (r) => r.id === "integration-play" && r.pass,
      ),
    );

    // Live-dir mode accumulates both facets' accepted work in the game folder.
    const gameDir = path.join(rig.core.layout.gamesRoot, "duskworld");
    assert.match(await readFile(path.join(gameDir, "src", "terrain.js"), "utf8"), /terrain work/);
    assert.match(await readFile(path.join(gameDir, "src", "lighting.js"), "utf8"), /lighting work/);

    // The run closed with the global blind verdict and a durable journal.
    const finished = customEvents(events, "run_finished")[0]!;
    assert.equal(finished.mode, "autopilot");
    assert.ok(finished.optimization, "a durable optimization outcome accompanies final publication");
    const stageAt = events.findIndex((e) => e.data.type === "custom" && e.data.event_type === "optimization_updated");
    const finishAt = events.findIndex((e) => e.data.type === "custom" && e.data.event_type === "run_finished");
    assert.ok(stageAt >= 0 && stageAt < finishAt, "Optimization precedes final publication");
    assert.equal((finished.globalVerdict as { pick?: string })?.pick, "challenger");
    assert.ok(finished.finalSnapshot, "an accepted result is snapshotted");
    assert.deepEqual(
      [finished.stopCode, finished.stoppedBecause],
      ["done", "facets settled toward the direction"],
      "the close says why it stopped as a code, beside the sentence",
    );
    assert.equal(counts.globalJudge >= 1, true);
    const threadId = (await rig.core.store.listThreads()).find(
      (t) => (t.metadata as { project?: string })?.project === "duskworld",
    )!.id;
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as {
      phase?: string;
      facets?: Record<string, { satisfied?: boolean }>;
    };
    assert.equal(journal?.phase, "done");
    assert.equal(journal?.facets?.terrain?.satisfied, true);
    assert.equal(journal?.facets?.lighting?.satisfied, true);

    // The brief reached the builder as a file in the game folder (live mode), self-ignored by git.
    assert.match(await readFile(path.join(gameDir, ".studio", "BRIEF.md"), "utf8"), /## Checks/);
    assert.equal((await readFile(path.join(gameDir, ".studio", ".gitignore"), "utf8")).trim(), "*");
  });

  it("a delegated engine runs facets in parallel worktrees and merges them into the live game", async () => {
    const rig = await startRig();
    rigs.push(rig);

    const delegatedCwds: string[] = [];
    const delegatedRequests: DelegateRequest[] = [];
    const otherDelegations: DelegateRequest[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseOverlap: () => void;
    const overlap = new Promise<void>((resolve) => {
      releaseOverlap = resolve;
    });
    rig.core.engines.register({
      id: "fake-delegate",
      label: "Fake contractor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      // The judge/decomposer side of a delegated engine: fresh-context completions.
      complete: async (request: CompleteRequest) => {
        const text = request.messages.map((m) => String(m.content)).join("\n") + "\n" + (request.systemPrompt ?? "");
        let reply = "ok";
        if (text.includes("ENGINE HINT: maxParallel")) reply = JSON.stringify(PLAN);
        else if (text.includes("THE FACET UNDER JUDGEMENT")) {
          const aIsIncumbent = newestFixtureBuild(request) === "B";
          // The taste judge: no veto, an uncapped defect ledger, satisfied.
          reply = JSON.stringify({
            pick: aIsIncumbent ? "B" : "A",
            satisfied: true,
            regression: null,
            newCheck: null,
            defects: ["water seam — camBridge", "blobby hand — default"],
            reason: "scripted",
          });
        } else if (text.includes("BUILD A") && text.includes("BUILD B")) {
          const aIsIncumbent = newestFixtureBuild(request) === "B";
          reply = JSON.stringify({ pick: aIsIncumbent ? "B" : "A", biggest_gap: "", reason: "scripted" });
        }
        return {
          message: { role: "assistant", content: reply },
          usage: {},
          stopReason: "stop",
          model: "fake",
          engine: "fake-delegate",
        };
      },
      // The contractor: writes its facet's file straight into the worktree it was pointed at.
      // The base builder, the integration facet and the playtester are delegations too — they
      // answer "ok" and write nothing, so the facet assertions below stay about facets.
      delegate: async (request: DelegateRequest) => {
        otherDelegations.push(request);
        const facet = facetPromptOf(request.prompt);
        if (!facet) {
          if (request.playtest) {
            return {
              ok: true,
              summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }),
              usage: {},
              turns: 1,
              engine: "fake-delegate",
            };
          }
          return { ok: true, summary: "ok", usage: {}, turns: 1, engine: "fake-delegate" };
        }
        delegatedCwds.push(request.cwd);
        delegatedRequests.push(request);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A rendezvous proves overlap without depending on how quickly the second worktree
        // starts on a busy Mac. A serial scheduler still fails at the bounded deadline.
        if (inFlight === 2) releaseOverlap!();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("facet contractors did not overlap")), 15_000);
          void overlap.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        await writeFile(path.join(request.cwd, `${facet}.js`), `// ${facet} worktree work\n`);
        inFlight--;
        return {
          ok: true,
          summary: `built ${facet}`,
          usage: {},
          turns: 1,
          engine: "fake-delegate",
          sessionId: `ses_${facet}`,
        };
      },
    });

    // The game declares one scripted demo, so accepted facets must record its `demo:` camera
    // (a filter that matches the on-disk demo_ file prefix instead of the demo: camera name
    // reports demos: [] on every facet and leaves the loss check inert).
    rig.preview.demoNames = ["boot"];

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a moody dusk exploration world",
      project: "worktreeworld",
      mode: "autopilot",
      classic: true,
      engine: "fake-delegate",
      reference: { name: "quiet dusk wandering", shots: [], kind: "direction" },
      budgets: { wallClockMs: 300_000, maxIterations: 4 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
      120_000,
      "worktree autopilot run_finished",
    );

    const started = customEvents(events, "autopilot_started")[0]!;
    assert.equal((started.maxParallel as number) > 1, true, "delegated engine ⇒ parallel profile");

    // Both facets were delegated into scratch worktrees — not the live folder — concurrently.
    assert.equal(delegatedCwds.length, 2);
    const scratch = path.resolve(rig.core.layout.scratch);
    assert.ok(
      delegatedCwds.every((cwd) => cwd.startsWith(scratch + path.sep)),
      `cwds: ${delegatedCwds.join(", ")}`,
    );
    assert.equal(maxInFlight, 2, "facet contractors overlapped");

    // The merges landed both facets' work in the live game, and the worktrees were removed.
    const gameDir = path.join(rig.core.layout.gamesRoot, "worktreeworld");
    assert.match(await readFile(path.join(gameDir, "terrain.js"), "utf8"), /terrain worktree work/);
    assert.match(await readFile(path.join(gameDir, "lighting.js"), "utf8"), /lighting worktree work/);
    for (const cwd of delegatedCwds) {
      await assert.rejects(readFile(path.join(cwd, "terrain.js")), "worktrees are cleaned up after integration");
    }
    const finished = customEvents(events, "run_finished")[0]!;
    assert.equal((finished.globalVerdict as { pick?: string })?.pick, "challenger");

    // Every accepted facet recorded the demo camera it exposes, under its evidence name.
    const threadId = (await rig.core.store.listThreads()).find(
      (t) => (t.metadata as { project?: string })?.project === "worktreeworld",
    )!.id;
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as {
      base?: { ok?: boolean; commit?: string | null };
      facets?: Record<string, { demos?: string[]; sessionId?: string | null }>;
    };
    assert.equal(journal.base?.ok, true, "the shared base committed before the facets forked");
    assert.ok(journal.base?.commit, "the base commit is what every facet worktree forked from");
    for (const [facetId, facet] of Object.entries(journal?.facets ?? {})) {
      assert.deepEqual(facet.demos, ["boot"], `facet ${facetId} records the demos the game declares`);
    }
    // Persistent builder: the facet's contractor session id is remembered for resume.
    assert.equal(journal.facets?.terrain?.sessionId, "ses_terrain");

    // Builders run at exactly the run's model and effort — an unset effort stays unset, never
    // a silent "low" floor.
    assert.ok(delegatedRequests.length > 0);
    for (const request of delegatedRequests) {
      assert.equal(request.effort, undefined, "no effort floor is invented for builders");
      // Builder eyes: the capture grant points at the delegation's own worktree, and the studio
      // injected the mid-turn handler that renders it.
      assert.equal(path.resolve(String(request.selfCapture?.root)), path.resolve(request.cwd));
      assert.equal(typeof request.onCapture, "function");
      // The brief was written into the worktree before the build turn, self-ignored by git.
      assert.match(request.prompt, /READ .*\.studio\/BRIEF\.md FIRST/);
    }
    // A classic Autopilot's builders carry no worker grant: they stay unattended, as before.
    for (const request of otherDelegations) assert.equal(request.worker, undefined, "no worker seat");
    // The base builder ran in the live folder; the playtester played the integrated build
    // read-only with live tools bound to a pooled preview.
    assert.ok(otherDelegations.some((r) => /BASE BUILDER/.test(r.prompt) && r.cwd === gameDir));
    const playtest = otherDelegations.find((r) => r.playtest);
    assert.ok(playtest, "the integration facet convened a playtester");
    assert.equal(playtest!.readOnly, true);
    assert.ok((playtest!.liveTools ?? []).some((t) => t.name === "press_keys"));
    assert.equal(typeof playtest!.onLiveTool, "function");

    // Every iteration record carries the verified scoreboard beside the judge's defects.
    const iterationRecords = customEvents(events, "facet_iteration");
    assert.ok(iterationRecords.length > 0);
    for (const record of iterationRecords) {
      const board = record.scoreboard as { results: Array<{ id: string; pass: boolean }> } | null;
      assert.ok(board && board.results.length >= 1, "a scoreboard rides on every iteration");
      assert.ok(
        (record.defects as string[]).includes("water seam — camBridge"),
        "the taste judge's defects still reach the record",
      );
    }
    // Continuous integration: every accepted facet commit was merged into the integration branch.
    const merges = customEvents(events, "integration_merge").filter(
      (m) => m.stage === "continuous" && m.conflict === false,
    );
    assert.ok(merges.length >= 2, `both facets merged continuously (${merges.length})`);

    // Every accepted build stays reachable after its worktree is removed: one ref per worker
    // in the game's own repo, moved forward as the loop accepts. Before this, an accepted
    // commit nobody integrated was unreferenced the moment the worktree went.
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    for (const facetId of ["terrain", "lighting"]) {
      const ref = (await api["run.exec"]!({
        command: `git rev-parse refs/studio/runs/${runId}/workers/${facetId}`,
        project: "worktreeworld",
        timeoutMs: 30_000,
      })) as { code: number; stdout: string };
      assert.equal(ref.code, 0, `facet ${facetId} has no ref of its own`);
      const containing = (await api["run.exec"]!({
        command: `git for-each-ref --contains ${ref.stdout.trim()}`,
        project: "worktreeworld",
        timeoutMs: 30_000,
      })) as { stdout: string };
      assert.match(containing.stdout, new RegExp(`refs/studio/runs/${runId}/workers/${facetId}`), containing.stdout);
    }
  });

  it("contractor intake: the contractor interviews over the MCP bridge, no model leaks, and the mood board survives", async () => {
    // The composer clears its chips the moment a message is sent, so only the FIRST interview
    // message carries frames; and with a contractor selected the interview now runs on the
    // contractor itself (intake tools bridged in as MCP tools). The run spec must still get
    // the board (kind "reference") and must NOT inherit any interview model (sword-fighting
    // burned a run delegating to Claude Code with model "qwen3.8:27b-mlx").
    const rig = await startRig({ respond: () => ({ text: "ok" }) });
    rigs.push(rig);

    const delegateModels: Array<string | undefined> = [];
    let interviewCalls = 0;
    rig.core.engines.register({
      id: "fake-delegate",
      label: "Fake contractor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async (request: CompleteRequest) => {
        const text = request.messages.map((m) => String(m.content)).join("\n") + "\n" + (request.systemPrompt ?? "");
        const reply = text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(PLAN) : "ok";
        return {
          message: { role: "assistant", content: reply },
          usage: {},
          stopReason: "stop",
          model: "fake",
          engine: "fake-delegate",
        };
      },
      delegate: async (request: DelegateRequest) => {
        if (request.interviewTools?.length) {
          // The interview turns: first a question back to the user, then the intake call.
          interviewCalls++;
          if (interviewCalls === 1) {
            return {
              ok: true,
              summary: "Which mood exactly?",
              usage: {},
              turns: 1,
              engine: "fake-delegate",
              sessionId: "ses_interview",
            };
          }
          return {
            ok: true,
            summary: "Recap: a grey courtyard to wander in. Starting it.",
            usage: {},
            turns: 1,
            engine: "fake-delegate",
            sessionId: "ses_interview",
            studioToolCalls: [
              {
                name: "start_autopilot",
                args: { goal: "a grey courtyard to wander in", direction: "dead grey daylight" },
              },
            ],
          };
        }
        if (request.director) {
          // The intake leads to a director's run: this director starts one judged
          // worker, waits for it, and finishes without landing.
          delegateModels.push(request.model);
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
          // The plan the user reads, before any builder starts (M3.8).
          await call("plan", {
            summary: "This run: a grey courtyard you can wander in.",
            workers: JSON.stringify([
              {
                id: "courtyard",
                title: "Courtyard",
                seam: "the courtyard",
                owns: "src/",
                done: ["there is daylight in the courtyard"],
                minutes: 3,
              },
            ]),
          });
          await call("worker_start", {
            id: "courtyard",
            title: "Courtyard",
            brief: "a grey courtyard to wander in",
            mode: "loop",
            minutes: "3",
            checks: JSON.stringify([
              { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
            ]),
          });
          for (let i = 0; i < 40; i++) {
            const waited = JSON.parse(String(await call("wait", { seconds: "3", worker: "courtyard" })));
            if (waited.status?.workers?.[0]?.state !== "running") break;
          }
          await call("finish", { summary: "a grey courtyard, one worker", land: "no" });
          return {
            ok: true,
            summary: "run done",
            usage: {},
            turns: 3,
            engine: "fake-delegate",
            sessionId: "ses_director",
          };
        }
        delegateModels.push(request.model);
        await writeFile(path.join(request.cwd, "note.js"), "// built\n");
        return { ok: true, summary: "built", usage: {}, turns: 1, engine: "fake-delegate" };
      },
    });

    const threadId = await rig.core.createGameThread();
    const frames = [
      { data: Buffer.from("frame-one").toString("base64"), mimeType: "image/png", label: "board 1" },
      { data: Buffer.from("frame-two").toString("base64"), mimeType: "image/png", label: "board 2" },
    ];
    await rig.core.sendUserMessage("make a grey courtyard sim", {
      thread: threadId,
      engine: "fake-delegate",
      autopilot: { hours: 1, frames },
    });
    await waitForLog(
      rig.core,
      (log) => log.some((e) => JSON.stringify(e.data).includes("Which mood exactly?")),
      30_000,
      "interview question from the contractor itself",
    );
    // Composer chips are gone now — the second message carries no frames.
    await rig.core.sendUserMessage("dead grey daylight", {
      thread: threadId,
      engine: "fake-delegate",
      autopilot: { hours: 1, frames: [] },
    });

    const startedLog = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_started").length >= 1,
      60_000,
      "run_started from contractor intake",
    );
    const started = customEvents(startedLog, "run_started")[0]!;
    assert.equal(
      (started.reference as { kind?: string }).kind,
      "reference",
      "the board sent one message earlier still reaches the run",
    );

    await waitForLog(
      rig.core,
      (log) => customEvents(log, "facet_iteration").length >= 1,
      90_000,
      "first facet iteration",
    );
    assert.ok(delegateModels.length >= 1, "the contractor was actually delegated to");
    assert.ok(
      delegateModels.every((m) => m === undefined),
      `the interview's local model leaked into the delegation: ${delegateModels.join(", ")}`,
    );

    await rig.core.host.dispatch({ type: "run_stop", runId: String(started.runId) });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").length >= 1,
      60_000,
      "run_finished after stop",
    );
  });

  it("conflicting facet worktrees fall to the integrator session, and the game still closes judged", async () => {
    const rig = await startRig();
    rigs.push(rig);

    let integratorPrompt: string | null = null;
    rig.core.engines.register({
      id: "fake-delegate",
      label: "Fake contractor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async (request: CompleteRequest) => {
        const text = request.messages.map((m) => String(m.content)).join("\n") + "\n" + (request.systemPrompt ?? "");
        let reply = "ok";
        if (text.includes("ENGINE HINT: maxParallel")) reply = JSON.stringify(PLAN);
        else if (text.includes("THE FACET UNDER JUDGEMENT")) {
          const aIsIncumbent = newestFixtureBuild(request) === "B";
          reply = JSON.stringify({
            pick: aIsIncumbent ? "B" : "A",
            satisfied: true,
            regression: null,
            newCheck: null,
            biggest_gap: "",
            reason: "s",
          });
        } else if (text.includes("BUILD A") && text.includes("BUILD B")) {
          const aIsIncumbent = newestFixtureBuild(request) === "B";
          reply = JSON.stringify({ pick: aIsIncumbent ? "B" : "A", biggest_gap: "", reason: "s" });
        }
        return {
          message: { role: "assistant", content: reply },
          usage: {},
          stopReason: "stop",
          model: "fake",
          engine: "fake-delegate",
        };
      },
      delegate: async (request: DelegateRequest) => {
        // The integrator session: recognisable by its own brief.
        if (request.prompt.includes("You are the integrator")) {
          integratorPrompt = request.prompt;
          await writeFile(path.join(request.cwd, "shared.js"), "// integrated: both moods reconciled\n");
          return { ok: true, summary: "integrated", usage: {}, turns: 1, engine: "fake-delegate" };
        }
        const facet = facetPromptOf(request.prompt);
        if (!facet) {
          // Base builder, integration facet builder, playtester: touch nothing.
          if (request.playtest)
            return {
              ok: true,
              summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }),
              usage: {},
              turns: 1,
              engine: "fake-delegate",
            };
          return { ok: true, summary: "ok", usage: {}, turns: 1, engine: "fake-delegate" };
        }
        // Both facets rewrite the SAME file with different content — a guaranteed conflict.
        await writeFile(path.join(request.cwd, "shared.js"), `// ${facet} owns this file\n`);
        return { ok: true, summary: `built ${facet}`, usage: {}, turns: 1, engine: "fake-delegate" };
      },
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a moody dusk exploration world",
      project: "conflictworld",
      mode: "autopilot",
      classic: true,
      engine: "fake-delegate",
      reference: { name: "quiet dusk wandering", shots: [], kind: "direction" },
      budgets: { wallClockMs: 300_000, maxIterations: 4 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
      120_000,
      "conflict run_finished",
    );

    const finished = customEvents(events, "run_finished")[0]!;
    assert.ok(Array.isArray(finished.integratorConflicts), "the report names the conflicted facets");
    assert.ok((finished.integratorConflicts as string[]).length >= 1);
    assert.ok(integratorPrompt, "an integrator session was convened");
    assert.match(String(integratorPrompt), /worktree/);
    assert.match(String(integratorPrompt), /INTEGRATION NOTES.*shared palette/);
    // The conflict surfaced at the continuous merge, while it was one file — not only at the end.
    const conflicted = customEvents(events, "integration_merge").filter((m) => m.conflict === true);
    assert.ok(conflicted.length >= 1, "the continuous merge recorded the conflict");
    const shared = await readFile(path.join(rig.core.layout.gamesRoot, "conflictworld", "shared.js"), "utf8");
    assert.match(shared, /integrated: both moods reconciled/, "the integrator's resolution is what shipped");
  });

  it("steering: addressed coordinator guidance reaches later facet briefs", async () => {
    // Two iterations per facet so there is a boundary for steering to land on.
    const { respond, builderPrompts } = makeAutopilotResponder({
      satisfiedWhen: (_facet, judged) => judged >= 2,
    });
    const rig = await startRig({ respond });
    rigs.push(rig);

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a moody dusk exploration world",
        project: "steerworld",
        mode: "autopilot",
        classic: true,
        reference: { name: "quiet dusk wandering", shots: [], kind: "direction" },
        budgets: { wallClockMs: 300_000, maxIterations: 8 },
      })
      .catch(() => {});

    // As soon as the first facet iteration lands, the user "types into the run".
    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "facet_iteration"),
      60_000,
      "first facet_iteration",
    );
    const threadId = (await rig.core.store.listThreads()).find(
      (t) => (t.metadata as { project?: string })?.project === "steerworld",
    )!.id;
    await rig.core.runFeedback({ threadId, runId, text: "make the fog much redder" });

    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
      120_000,
      "steered run_finished",
    );
    const steered = builderPrompts.filter((p) => p.includes("USER STEERING") && p.includes("make the fog much redder"));
    assert.ok(steered.length >= 1, "at least one later facet brief carries the steering message");
  });

  it("kill mid-run ⇒ paused (not finished-dead); resume replays the journal", async () => {
    // Terrain satisfies immediately; lighting never does before the kill, then needs one more
    // judged iteration after the resume.
    const { respond, counts, order } = makeAutopilotResponder({
      satisfiedWhen: (facet, judged) => (facet === "terrain" ? judged >= 1 : judged >= 2),
    });
    const rig = await startRig({ respond });
    rigs.push(rig);

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a moody dusk exploration world",
        project: "pauseworld",
        mode: "autopilot",
        classic: true,
        reference: { name: "quiet dusk wandering", shots: [], kind: "direction" },
        budgets: { wallClockMs: 300_000, maxIterations: 20 },
      })
      .catch(() => {});

    // Wait until terrain is done and lighting has iterated once, then kill the harness cold.
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "facet_iteration").some((i) => i.facetId === "lighting"),
      60_000,
      "lighting mid-flight",
    );
    await rig.core.host.stop();
    const terrainBuildsBeforeKill = order.filter((f) => f === "terrain").length;

    // The next boot closes the run as interrupted AND marks it paused, never redispatching.
    await rig.core.start();
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "autopilot_paused"),
      30_000,
      "autopilot_paused",
    );
    const closure = customEvents(events, "run_finished").find((r) => r.runId === runId)!;
    assert.match(String(closure.stoppedBecause), /interrupted by restart/);
    const threadId = (await rig.core.store.listThreads()).find(
      (t) => (t.metadata as { project?: string })?.project === "pauseworld",
    )!.id;
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as {
      phase?: string;
      facets?: Record<string, { done?: boolean; satisfied?: boolean }>;
    };
    assert.equal(journal.phase, "paused");
    assert.equal(journal.facets?.terrain?.done, true, "the finished facet survived in the journal");

    // Resume: the user's click. The plan replays (no second decompose), terrain replays from
    // the journal (no new builds), lighting restarts and finishes.
    assert.equal(counts.decompose, 1);
    await rig.core.resumeAutopilot(runId);
    const finishedEvents = await waitForLog(
      rig.core,
      (log) =>
        customEvents(log, "run_finished").some(
          (r) => r.runId === runId && !/interrupted by restart/.test(String(r.stoppedBecause)),
        ),
      120_000,
      "resumed run_finished",
    );
    assert.equal(counts.decompose, 1, "resume never re-decomposes — the journal's plan is the plan");
    const resumed = customEvents(finishedEvents, "autopilot_resumed");
    assert.equal(resumed.length, 1);
    assert.deepEqual(resumed[0]!.doneFacets, ["terrain"]);
    assert.equal(
      order.filter((f) => f === "terrain").length,
      terrainBuildsBeforeKill,
      "the completed facet was replayed from the journal, not rebuilt",
    );
    const finalJournal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as { phase?: string };
    assert.equal(finalJournal.phase, "done");
  });

  it("a 1-facet plan retains Gauntlet creative events and finalizes Optimization before publication", async () => {
    const { respond } = makeAutopilotResponder({
      plan: {
        facets: [{ id: "whole", title: "Whole game", brief: "just build it", budgetShare: 1 }],
        integrationNotes: "",
        assumptions: [],
      },
    });
    const rig = await startRig({ respond });
    rigs.push(rig);

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "one small game",
      project: "tinygame",
      mode: "autopilot",
      classic: true,
      reference: { name: "a calm feeling", shots: [], kind: "direction" },
      budgets: { wallClockMs: 120_000, maxIterations: 1 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
      90_000,
      "degenerate run_finished",
    );
    assert.equal(customEvents(events, "run_started")[0]!.mode, "autopilot");
    assert.ok(customEvents(events, "optimization_updated").length >= 1);
    assert.ok(customEvents(events, "run_finished")[0]!.optimization);
    assert.equal(customEvents(events, "autopilot_started").length, 0, "no synthetic facet plan card");
    assert.equal(customEvents(events, "facet_iteration").length, 0);
    assert.ok(customEvents(events, "run_iteration").length >= 1, "gauntlet iterations ran instead");
  });
});

/**
 * M3.3 — who owns the move. The harness's planner and its liveness critic used to name "the ONE
 * structural move" every iteration and make it mandatory, so rounds spent on the director's
 * brief were reset for missing what nobody had asked for.
 */
/** A seed loop module and every module under its folder, joined, so a count covers the split. */
function loopTree(module: string, folder: string): string {
  const loop = new URL("../../src/harness-seed/loop/", import.meta.url);
  const nested = readdirSync(new URL(`${folder}/`, loop), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => `${folder}/${file}`);
  return [module, ...nested].map((file) => readFileSync(new URL(file, loop), "utf8")).join("\n");
}

describe("the move belongs to the director", () => {
  /** A worker's contract, as the loop reads it; `as never` because the seed is plain JS. */
  const spec = (extra: Record<string, unknown> = {}): never =>
    ({ id: "dirt", checks: [], milestones: [], ...extra }) as never;
  const grew = (fix: string): never =>
    ({ grow: [{ key: "purpose", score: 1, reason: "nothing to do here", fix }] }) as never;
  const taste = { pick: "challenger", veto: false, moveDelivered: false, scale: "polish" } as never;

  it("hands out the director's ladder and never asks the planner while it owns one", () => {
    const ladder = [
      { id: "mud", what: "mud builds up on the panels" },
      { id: "clods", what: "clods fly off the wheels" },
    ];
    const owned = spec({ milestones: ladder, moveOwner: "director" });
    assert.deepEqual(chooseMove({ spec: owned }), { source: "milestone", milestone: ladder[0], mandatory: true });
    assert.equal(chooseMove({ spec: owned, milestonesDone: ["mud"] as never }).milestone, ladder[1]);
    // The ladder is climbed: the next move is the director's call (worker_steer move=), and the
    // planner is not asked — not even for the liveness critic's grow gap, which is guidance.
    const climbed = chooseMove({
      spec: owned,
      milestonesDone: ["mud", "clods"] as never,
      lastLiveness: grew("a wet-mud puddle zone system"),
      polishStreak: 3,
    });
    assert.deepEqual(climbed, { source: "none", mandatory: false });
    // Nobody owning the ladder: the harness still names one — it is what stops polish-only
    // runs — and the critic's own gap beats a planner guess.
    assert.equal(chooseMove({ spec: spec(), lastLiveness: grew("a wet-mud puddle zone system") }).source, "critic");
    assert.equal(chooseMove({ spec: spec() }).source, "planner");
  });

  /**
   * The ladder reaches a builder, and not only in theory. Every rung above is chosen inside a
   * gate that used to be "identity first" for everyone: an empty board (round one) or one failing
   * `done` check — the normal state of a running worker — skipped the whole block, so a
   * `worker_start move=` was accepted, answered "its next round builds it", and handed to nobody
   * until the round the worker was about to finish on anyway.
   */
  it("gives the director's ladder to the first round, before any identity check has passed", () => {
    const owned = spec({ milestones: [{ id: "mud", what: "mud builds up on the panels" }], moveOwner: "director" });
    const failing = { "mud-on-panels": { id: "mud-on-panels", weight: "identity", pass: false } } as never;
    const holding = { "mud-on-panels": { id: "mud-on-panels", weight: "identity", pass: true } } as never;
    assert.equal(movesThisRound(owned, {} as never), true, "round one, nothing measured yet");
    assert.equal(movesThisRound(owned, failing), true, "and every round the worker is still owed");
    // The harness's own planner, critic and pending moves still wait for the part to be itself.
    assert.equal(movesThisRound(spec(), {} as never), false);
    assert.equal(movesThisRound(spec(), failing), false);
    assert.equal(movesThisRound(spec(), holding), true);
  });

  it("makes a move the harness invented guidance until two accepted builds have only polished", () => {
    assert.equal(chooseMove({ spec: spec() }).mandatory, false);
    assert.equal(chooseMove({ spec: spec(), polishStreak: 1 }).mandatory, false);
    assert.equal(chooseMove({ spec: spec(), polishStreak: 2 }).mandatory, true, "the escalation still has teeth");
    // A rung of a ladder somebody wrote is mandatory from the first iteration it is asked for.
    assert.equal(chooseMove({ spec: spec({ milestones: [{ id: "mud", what: "mud builds up" }] }) }).mandatory, true);
    // A move that did not land is re-issued (MOVE_ATTEMPTS = 2), then a fresh one is asked for.
    const once = { what: "a jetty to walk out on", source: "planner", delivered: false, attempts: 1 };
    assert.equal(chooseMove({ spec: spec(), moves: [once] as never }).source, "pending");
    assert.equal(chooseMove({ spec: spec(), moves: [{ ...once, attempts: 2 }] as never }).source, "planner");
    assert.equal(chooseMove({ spec: spec(), moves: [{ ...once, delivered: true }] as never }).source, "planner");
  });

  it("keeps a round the judge preferred that missed an invented move, and says so", () => {
    const board = {} as never;
    const comparison = { flips: [], regressions: [] } as never;
    const invented = moveVerdict({
      move: { what: "a wet-mud puddle zone system", source: "planner", mandatory: false } as never,
      board,
      taste,
    });
    assert.equal(invented.missing, true);
    assert.equal(invented.costsRound, false, "an invented move never resets a build the judge preferred");
    assert.match(String(invented.note), /the move was not delivered, and it did not cost the round: a wet-mud puddle/);
    assert.equal(
      acceptRound({ spec: spec(), board, comparison, taste, moveMissing: invented.costsRound }).accepted,
      true,
    );

    // The director's own rung still decides: it asked for it, and a build without it is undone.
    const asked = moveVerdict({
      move: { what: "mud builds up on the panels", source: "milestone", mandatory: true } as never,
      board,
      taste,
    });
    assert.equal(asked.costsRound, true);
    assert.equal(asked.note, null);
    const decided = acceptRound({ spec: spec(), board, comparison, taste, moveMissing: asked.costsRound });
    assert.equal(decided.accepted, false);
    assert.equal(decided.source, "no-move");

    // Measured by its own check, or answered by a judge that did not answer: not missing.
    const measured = moveVerdict({
      move: { what: "three pools", check: { id: "pools" }, mandatory: true } as never,
      board: { pools: { pass: true } } as never,
      taste,
      won: true as never,
    });
    assert.deepEqual([measured.measured, measured.missing, measured.delivered], [true, false, true]);
    assert.equal(
      moveVerdict({ move: { what: "x", mandatory: true } as never, board, taste: { pick: "challenger" } as never })
        .missing,
      false,
      "a judge that did not answer gives the benefit of the doubt",
    );
    // Delivered is only ever true of a round that was kept, and only answered once that is known.
    assert.equal(moveVerdict({ move: { what: "x" } as never, board, taste }).delivered, null);
    assert.equal(moveVerdict({ move: { what: "x" } as never, board, taste, won: false as never }).delivered, false);
  });

  it("puts what was asked for, and what did not arrive, on the record the director reads", () => {
    const digest = iterationDigest({
      iteration: 4,
      winner: "challenger",
      reason: "no check moved; taste judge preferred the challenger",
      move: {
        what: "a wet-mud puddle zone system",
        source: "planner",
        mandatory: false,
        delivered: false,
        note: "the move was not delivered, and it did not cost the round: a wet-mud puddle zone system",
      },
    } as never) as {
      won: boolean;
      move: { what: string; mandatory: boolean; delivered: boolean | null; note: string | null } | null;
    };
    assert.equal(digest.won, true);
    assert.equal(digest.move!.what, "a wet-mud puddle zone system");
    assert.equal(digest.move!.delivered, false);
    assert.equal(digest.move!.mandatory, false);
    assert.match(String(digest.move!.note), /it did not cost the round/);
    // A round with no move says so rather than inventing one.
    assert.equal((iterationDigest({ iteration: 1, winner: "incumbent" } as never) as { move: unknown }).move, null);
  });

  it("asks the planner for a move only in the branch chooseMove hands it", async () => {
    // The facet loop is facet-loop.ts and every module under loop/facet/, its phases among them.
    const facetLoop = loopTree("facet-loop.ts", "facet");
    const calls = [...facetLoop.matchAll(/await nextMove\(/g)];
    assert.equal(calls.length, 1, "the loop asks the planner for a move in exactly one place");
    assert.equal([...facetLoop.matchAll(/await askPlannerForMove\(/g)].length, 1, "one branch asks the planner");
    // The move is chosen in plan.ts, and only the planner's branch there calls askPlannerForMove.
    const source = await readFile(
      path.join(import.meta.dirname, "../../src/harness-seed/loop/facet/phases/plan.ts"),
      "utf8",
    );
    const asks = [...source.matchAll(/await askPlannerForMove\(/g)];
    const at = asks[0]!.index!;
    const guard = source.lastIndexOf("choice.source === MoveSource.Planner", at);
    const chooser = source.lastIndexOf("chooseMove(", at);
    assert.ok(
      chooser > 0 && guard > chooser,
      "…and it is inside the branch chooseMove chose, so a director's ladder skips it",
    );
  });

  it("tells the builder whether the move is mandatory, in the brief and in the prompt", () => {
    const brief = (mandatory: boolean): string =>
      String(
        renderBrief({
          run: { runId: "r", goal: "g" },
          spec: { id: "dirt", title: "Dirt", intent: "mud", checks: [] },
          iteration: 2,
          board: {},
          comparison: null,
          move: { what: "mud builds up on the panels", mandatory },
        } as never),
      );
    assert.match(
      brief(true),
      /## THE MOVE this iteration \(mandatory — a build that only tunes what already exists is a loss\)/,
    );
    assert.match(
      brief(false),
      /## THE MOVE this iteration \(asked for — build it first; a build without it is judged on its own merits and the move is asked again\)/,
    );
    const prompt = (mandatory: boolean): string =>
      String(
        facetPrompt({
          run: { runId: "r", goal: "g" },
          spec: { id: "dirt", title: "Dirt", intent: "mud", checks: [], cameras: ["default"] },
          iteration: 2,
          resumed: false,
          briefFile: ".studio/BRIEF.md",
          worktree: "/w",
          move: { what: "mud builds up on the panels", mandatory },
        } as never),
      );
    assert.match(prompt(true), /THE MOVE THIS ITERATION \(mandatory\).*LOSES/s);
    assert.match(prompt(false), /THE MOVE THIS ITERATION \(asked for\)/);
    assert.doesNotMatch(prompt(false), /LOSES/);
  });
});

/**
 * Rounds that can finish (M3.4). The only start gate a worker had was "is there any time left?",
 * so on the first real run every second-round worker began a round it could not finish: the
 * build turn was cut at the deadline, the half-written game was judged as a partial, three of
 * the five lost, and the morning counted those rounds as undone. A worker now measures its own
 * rounds — the build turn, then evidence and the judge — and starts another only when what is
 * left covers one with room to spare; and a turn the clock is about to cut is asked, in the same
 * session, to finish cleanly instead.
 */
describe("a round is started only when it can finish", () => {
  type LoopCall = { method: string; params: Record<string, any> };
  /**
   * Just enough studio for a facet loop up to and including its build turn. `delegate` answers
   * the build turns; the default ends the loop the moment the first one starts, because what
   * comes after a turn (evidence, the judge, the commit) is not what these tests are about.
   */
  const runLoop = async (
    over: Record<string, unknown>,
    delegate?: (params: Record<string, any>, ctx: { cancelled: boolean }) => unknown,
  ) => {
    const calls: LoopCall[] = [];
    const ctx = {
      workspace: path.join(import.meta.dirname, "no-such-workspace"),
      cancelled: false,
      notify: () => {},
      setStatus: () => {},
      call: async (method: string, params: Record<string, any>) => {
        calls.push({ method, params });
        if (method === "engine.delegate") {
          if (delegate) return delegate(params, ctx);
          ctx.cancelled = true;
          return { ok: true, sessionId: "stub" };
        }
        if (method === "run.exec") return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567", stderr: "" };
        if (method === "engine.describe") return [{ id: "codex", kind: "delegated" }];
        return null;
      },
    };
    const result = await runFacetLoop(
      ctx as never,
      {
        runThreadId: "run-thread",
        facetThreadId: "facet-thread",
        run: { runId: "run_sizing", project: "plaza", engine: "codex" },
        facet: { id: "plaza", title: "Plaza", intent: "paint the plaza", checks: [] },
        worktree: "/scratch/autopilot/run_sizing/plaza",
        ...over,
      } as never,
    );
    const builds = calls.filter((c) => c.method === "engine.delegate");
    return { result, calls, builds };
  };

  it("refuses a round its own measured rounds do not fit in, and says so in the owner's words", async () => {
    // Fifteen minutes of building and five of judging, measured on its earlier rounds; six left.
    const { result, builds } = await runLoop({
      deadline: Date.now() + 6 * 60_000,
      resumeState: { iterations: 1, emaBuildMs: 15 * 60_000, emaAfterMs: 5 * 60_000 },
    });
    assert.equal(result.iterations, 1, "the round it already has, and no second one");
    assert.match(result.stoppedBecause, /^stopped early to finish cleanly/, result.stoppedBecause);
    assert.match(result.stoppedBecause, /a round here takes about 20 min and 6 min are left/, result.stoppedBecause);
    assert.doesNotMatch(result.stoppedBecause, /exhausted|at the user/);
    assert.equal(builds.length, 0, "no build turn was started");
  });

  it("refuses the first round on what the run has measured, and never on nothing at all", async () => {
    // A worker with no rounds of its own goes by the run's median (the director passes it).
    const measured = await runLoop({ deadline: Date.now() + 6 * 60_000, minIterationMs: 20 * 60_000 });
    assert.equal(measured.result.iterations, 0);
    assert.match(measured.result.stoppedBecause, /a round here takes about 20 min and 6 min are left/);
    assert.equal(measured.builds.length, 0);

    // Nothing measured anywhere: a worker is never refused its first round on a guess.
    const blind = await runLoop({ deadline: Date.now() + 6 * 60_000 });
    assert.equal(blind.builds.length, 1, "the build turn started");
    assert.equal(blind.result.iterations, 1);
  });

  it("starts one when there is room for it, and leaves the judge its measured share of the clock", async () => {
    const roomy = await runLoop({
      deadline: Date.now() + 40 * 60_000,
      resumeState: { iterations: 1, emaBuildMs: 15 * 60_000, emaAfterMs: 5 * 60_000 },
    });
    assert.equal(roomy.builds.length, 1, "the second round began");
    assert.equal(roomy.result.iterations, 2);
    // The turn is given what is left minus the five minutes this worker's rounds have needed
    // after the build, and the wind-down reserve — not the whole clock, which is what cut it.
    const budget = roomy.builds[0]!.params.timeoutMs as number;
    assert.ok(
      budget < 35 * 60_000 && budget > 30 * 60_000,
      `${Math.round(budget / 60_000)} min of the 40 that are left`,
    );
  });

  it("meets the clock with a finish-cleanly message in the same session, not a cut", async () => {
    const wound = await runLoop(
      {
        deadline: Date.now() + 40 * 60_000,
        resumeState: { iterations: 1, emaBuildMs: 15 * 60_000, emaAfterMs: 5 * 60_000 },
      },
      (params, ctx) => {
        // The first turn runs out its budget: edits on disk, session alive, nothing tidied.
        if (!params.resume)
          return {
            ok: false,
            stopReason: "deadline",
            errorText: "time budget exhausted",
            sessionId: "plaza-1",
            summary: "",
          };
        ctx.cancelled = true;
        return { ok: true, sessionId: "plaza-1", summary: "reloaded, notes written" };
      },
    );
    assert.equal(wound.builds.length, 2, "the turn was not simply left cut");
    assert.equal(wound.builds[1]!.params.resume, "plaza-1", "the same session, which still has everything it read");
    assert.match(String(wound.builds[1]!.params.prompt), /^TIME: your build turn is at its limit/);
    assert.match(String(wound.builds[1]!.params.prompt), /Finish the edit you are inside so the game still runs/);
    assert.ok((wound.builds[1]!.params.timeoutMs as number) <= 3 * 60_000, "and it is a wrap-up, not another round");
    const wind = wound.calls.filter(
      (c) => c.method === "events.append" && JSON.stringify(c.params).includes("facet_wind_down"),
    );
    assert.equal(wind.length, 1, "the round says the clock was met, once");
  });

  it("holds a round to its own two halves: the build turn, then evidence and the judge", () => {
    const left = (min: number) => min * 60_000;
    // A gate that reserved only the build would move the cut from the build to the judge.
    assert.equal(tooLateToStart({ leftMs: left(22), buildMs: left(15) }), null, "build alone fits");
    assert.match(
      String(tooLateToStart({ leftMs: left(22), buildMs: left(15), afterMs: left(5) })),
      /about 20 min and 22 min are left/,
    );
    // Exactly the headroom is enough; a few minutes under is not.
    assert.equal(tooLateToStart({ leftMs: left(25), buildMs: left(20) }), null);
    assert.match(String(tooLateToStart({ leftMs: left(24), buildMs: left(20) })), /^stopped early to finish cleanly/);
    // The worker's own measurement outranks the run's median once it has one.
    assert.equal(tooLateToStart({ leftMs: left(10), buildMs: left(2), afterMs: left(1), runMs: left(40) }), null);
    assert.equal(tooLateToStart({ leftMs: left(6) }), null, "nothing measured, nothing refused");
    assert.equal(tooLateToStart({ leftMs: left(6), runMs: 0 }), null);
  });
});

/**
 * M4.4 — the game declaration the planner is shown. The shape is copied as it stands, so the
 * three traits printed in it are declarations: `"hud":false,"mouseLook":false,"keyboardMove":
 * false` came back filled in beside a first-person kind, an explicit false outranks the kind's
 * own traits, and every board silently lost the four harness-owned checks the kind exists to
 * bring. The traits are named in words instead; absent, each takes the declared kind's value.
 */
describe("the shape the planner copies declares a kind, not three falses", () => {
  const askFor = async (answer: Record<string, unknown>): Promise<{ ask: string; plan: Record<string, any> }> => {
    let ask = "";
    const ctx = {
      call: async (method: string, params: { messages?: Array<{ content: string }> }) => {
        if (method !== "engine.complete") throw new Error(method);
        ask = (params.messages ?? []).map((m) => m.content).join("\n");
        return { message: { role: "assistant", content: JSON.stringify(answer) } };
      },
    };
    const plan = await decompose(
      ctx as never,
      {
        run: { runId: "r", goal: "a first-person skate plaza" },
        profile: { maxParallel: 2, delegated: true },
      } as never,
    );
    return { ask, plan: plan as Record<string, any> };
  };
  const FACETS = [
    {
      id: "plaza",
      title: "Plaza",
      intent: "the plaza",
      owns: ["src/plaza.js"],
      checks: [{ id: "plaza-lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" }],
      budgetShare: 1,
    },
  ];

  it("prints no trait value to copy, and a copied kind brings that kind's own traits", async () => {
    const { ask, plan } = await askFor({
      game: { kind: "first-person", playScript: null },
      facets: FACETS,
      mainOwner: "plaza",
      assumptions: [],
    });
    assert.doesNotMatch(ask, /"hud":\s*false/, "a false in the shape is a declaration the planner copies");
    assert.doesNotMatch(ask, /"mouseLook":\s*false/);
    assert.doesNotMatch(ask, /"keyboardMove":\s*false/);
    assert.match(ask, /"game":\{"kind":"<one of /, "the kind is still the shape's own field");
    // The behaviour the falses cost: a kind declared alone brings its own traits, so the
    // harness-owned HUD, look and movement checks reach the board.
    assert.deepEqual(plan.game, {
      kind: "first-person",
      hud: true,
      mouseLook: true,
      keyboardMove: true,
      playScript: null,
    });
  });

  it("still lets a plan say this game differs from its kind", async () => {
    const { plan } = await askFor({
      game: { kind: "first-person", hud: false, playScript: null },
      facets: FACETS,
      mainOwner: "plaza",
      assumptions: [],
    });
    assert.equal(plan.game.hud, false, "an explicit false is a declaration and still wins");
    assert.equal(plan.game.mouseLook, true, "and what it did not name keeps the kind's own value");
  });
});

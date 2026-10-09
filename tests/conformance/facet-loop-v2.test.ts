import { gitFile } from "../helpers/git.ts";
/**
 * The v2 facet loop over the real rig: a delegated engine, two
 * facets with typed checks, and a scripted judge. What is proven here, end to end:
 *
 *  - acceptance by verified scoreboard: a flip with no regression is accepted; a no-flip build
 *    that no camera can tell apart from the incumbent is rejected without a judge call;
 *  - the taste veto: the judge may block only with a named regression, and that regression
 *    becomes a new vision check the next iteration must pass (crops are cut from the judged frame);
 *  - memory: the contractor session is resumed, lost attempts survive on `attempt/<facet>/<n>`
 *    and their diff summary reaches the next brief;
 *  - spikes: an identity check that fails twice is solved in a spike worktree, and the passing
 *    spike becomes a recipe in the technique library that the next brief carries;
 *  - the code reviewer: a Math.random() in the diff is caught and fixed in the same session
 *    before any evidence is spent.
 */
import { newestFixtureBuild } from "../helpers/fake-ollama.ts";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import type { CompleteRequest, DelegateRequest } from "../../src/substrate/engines/types.ts";
import {
  MAX_PROMPT_LIST,
  briefWithMovedSections,
  facetPrompt,
  pinFixRecipe,
} from "../../src/harness-seed/loop/facet-loop.ts";
import {
  checksFromDefects,
  craftForNewCheck,
  loadRecipes,
  recipesForChecks,
  renderBrief,
} from "../../src/harness-seed/loop/library.ts";
import { fileURLToPath } from "node:url";

const rigs: Rig[] = [];
// Finished scenarios must release their harness and HTTP server before the next
// scenario starts. Cleanup failures are test failures, not ignored background work.
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.stop();
    assert.equal(rig.core.host.state, "stopped", "the scenario releases its harness before the next test");
  }
});

const PLAN = {
  facets: [
    {
      id: "water",
      title: "Water",
      intent: "a dark mirror marsh under a black sky",
      owns: ["src/water.js"],
      identity: ["dark sky", "lit marsh"],
      budgetShare: 0.6,
      checks: [
        { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        { id: "dark-sky", kind: "pixel", camera: "default", expr: "top < 0.1", weight: "identity" },
      ],
    },
    {
      id: "sky",
      title: "Sky",
      intent: "a sun in the sky",
      owns: ["src/sky.js"],
      identity: ["sun"],
      budgetShare: 0.4,
      checks: [
        { id: "sky-lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        {
          id: "sun-visible",
          kind: "vision",
          camera: "default",
          crop: [0, 0, 1, 0.5],
          ask: "Is the sun visible in the upper half?",
          weight: "normal",
        },
      ],
    },
  ],
  // Every trait is off unless the plan declares one (M4.4): a plan that says nothing gets no
  // HUD rule, no look check and no movement check, so the rig declares the kind it means.
  game: { kind: "first-person" },
  mainOwner: "water",
  base: null,
  integrationNotes: "one palette",
  assumptions: [],
};

describe("facet loop v2: scoreboard, veto, memory, spikes, review", () => {
  it("runs two facets to satisfaction through the verified-scoreboard rules", async () => {
    const rig = await startRig();
    rigs.push(rig);

    const tasteCalls: Record<string, number> = { Water: 0, Sky: 0, Integration: 0 };
    const visionAsks: string[] = [];
    const reviewDiffs: string[] = [];
    const delegations: DelegateRequest[] = [];
    const builds: Record<string, number> = { water: 0, sky: 0 };
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
        else if (text.includes("QUESTIONS (")) {
          // A board of picture questions travels in one call per camera (M3.10): one reply,
          // keyed by check id.
          visionAsks.push(text);
          const ids = [...text.matchAll(/^- (\S+) — IMAGE /gm)].map((m) => m[1]!);
          reply = JSON.stringify({
            answers: Object.fromEntries(ids.map((id) => [id, { answer: "yes", confidence: 0.9, note: "a sun" }])),
          });
        } else if (text.includes("QUESTION:")) {
          visionAsks.push(text);
          reply = JSON.stringify({ answer: "yes", confidence: 0.9, note: "a sun" });
        } else if (text.includes("DIFF:")) {
          reviewDiffs.push(text);
          reply = JSON.stringify({ violations: [], summary: "clean" });
        } else if (text.includes("THE FACET UNDER JUDGEMENT")) {
          const facet = /THE FACET UNDER JUDGEMENT: (\w+)/.exec(text)?.[1] ?? "?";
          tasteCalls[facet] = (tasteCalls[facet] ?? 0) + 1;
          const aIsIncumbent = newestFixtureBuild(request) === "B";
          const challenger = aIsIncumbent ? "B" : "A";
          const incumbent = aIsIncumbent ? "A" : "B";
          if (facet === "Water" && tasteCalls.Water === 2) {
            // Iteration 2: the checks did not move, the pixels did; the taste judge vetoes with a
            // named regression that becomes a new vision check.
            reply = JSON.stringify({
              pick: incumbent,
              satisfied: false,
              // Judge text reaches the attempt's commit message through a shell (HQ-1).
              regression: { camera: "default", what: "the water went milky `echo judged` $(echo twice)" },
              newCheck: { id: "water-not-milky", camera: "default", ask: "Is the water clear, not milky?" },
              defects: ["milky water — default"],
              reason: "veto",
            });
          } else {
            const done = facet === "Water" ? tasteCalls.Water >= 3 : facet === "Sky" ? tasteCalls.Sky >= 2 : true;
            reply = JSON.stringify({
              pick: challenger,
              satisfied: done,
              regression: null,
              newCheck: null,
              defects: done ? [] : ["needs more"],
              reason: "scripted",
            });
          }
        } else if (text.includes("BUILD A") && text.includes("BUILD B")) {
          const aIsIncumbent = newestFixtureBuild(request) === "B";
          reply = JSON.stringify({ pick: aIsIncumbent ? "B" : "A", biggest_gap: "", reason: "scripted global" });
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
        delegations.push(request);
        const ok = (summary: string, extra: Record<string, unknown> = {}) => ({
          ok: true,
          summary,
          usage: {},
          turns: 1,
          engine: "fake-delegate",
          ...extra,
        });
        if (request.playtest)
          return ok(JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }));
        if (/CODE REVIEW before your build is judged/.test(request.prompt)) {
          await writeFile(
            path.join(request.cwd, "src", "water.js"),
            "// water, fixed: rng from update()\nexport const water = 1;\n",
          );
          return ok("fixed", { sessionId: "ses_water" });
        }
        if (/You are building a SPIKE/.test(request.prompt)) {
          // The spike builder: a page + a recipe. The fake preview's stats then say the sky is dark.
          await mkdir(path.join(request.cwd, "spike"), { recursive: true });
          await writeFile(
            path.join(request.cwd, "spike", "dark-sky.html"),
            "<!doctype html><script type=module src=./dark-sky.js></script>",
          );
          await writeFile(
            path.join(request.cwd, "spike", "dark-sky.js"),
            "scene.background = new THREE.Color(0x000000);\n",
          );
          await writeFile(
            path.join(request.cwd, "spike", "dark-sky.RECIPE.md"),
            "# Black sky gradient\n\n## Intent\nA sky that reads black at the zenith.\n\n## Sketch\n```js\nscene.background = new THREE.Color(0x000000);\n```\n\n## Port\nSet it in water.js.\n",
          );
          rig.preview.pixelStatsNext = {
            ...rig.preview.pixelStatsNext,
            bands: { top: 5, middle: 40, bottom: 80, left: 40, center: 40, right: 40 },
          };
          return ok("spike done");
        }
        if (/YOUR FACET: Water|facet "Water"/.test(request.prompt)) {
          builds.water++;
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          // Iteration 1 smuggles Math.random() in — the reviewer must catch it before evidence.
          const body =
            builds.water === 1
              ? "// water\nconst r = Math.random();\nexport const water = r;\n"
              : `// water attempt ${builds.water}\nexport const water = ${builds.water};\n`;
          await writeFile(path.join(request.cwd, "src", "water.js"), body);
          await mkdir(path.join(request.cwd, "docs", "notes"), { recursive: true });
          await writeFile(path.join(request.cwd, "docs", "notes", "NOTES.water.md"), `tried attempt ${builds.water}\n`);
          return ok(`built water ${builds.water}`, { sessionId: "ses_water" });
        }
        if (/YOUR FACET: Sky|facet "Sky"/.test(request.prompt)) {
          builds.sky++;
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "sky.js"), `// sky attempt ${builds.sky}\n`);
          return ok(`built sky ${builds.sky}`, { sessionId: "ses_sky" });
        }
        return ok("ok");
      },
    });

    // Facets run in parallel, so the fake diff answers per frame, not per global toggle: sky's
    // second iteration changes nothing visible — every camera reads identical to the incumbent.
    rig.preview.diffImages = async (a, b) => {
      rig.preview.diffs.push({ a, b });
      const invisible = /facet_sky\/iter_002\//.test(a);
      return {
        diff: {
          diffFraction: invisible ? 0 : 0.4,
          meanAbsDiff: invisible ? 0 : 30,
          grid: new Array(9).fill(invisible ? 0 : 0.4),
          compared: 1000,
        },
        heatmap: null,
      };
    };

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a dark mirror marsh with a sun",
      project: "marshworld",
      mode: "autopilot",
      classic: true,
      engine: "fake-delegate",
      reference: { name: "quiet marsh", shots: [], kind: "direction" },
      budgets: { wallClockMs: 3_600_000, maxIterations: 10, review: true },
    });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
      180_000,
      "v2 run_finished",
    );

    const iterations = customEvents(events, "facet_iteration") as Array<Record<string, unknown>>;
    const water = iterations.filter((i) => i.facetId === "water");
    const sky = iterations.filter((i) => i.facetId === "sky");
    const board = (record: Record<string, unknown>) =>
      record.scoreboard as {
        passing: number;
        total: number;
        flips: string[];
        regressions: string[];
        results: Array<{ id: string; pass: boolean }>;
      };

    // ── water: checks accept, the veto grows the scoreboard, the spike solves the hard check ──
    assert.ok(water.length >= 3, `water ran ${water.length} iterations`);
    assert.equal(water[0]!.winner, "challenger");
    assert.equal(water[0]!.verdictSource, "checks");
    assert.ok(board(water[0]!).flips.includes("lit"));
    // The harness's own checks ride on the board from the first iteration.
    assert.ok(
      board(water[0]!).results.some((r) => r.id === "single-hud" && r.pass),
      "one screen is on the board",
    );
    assert.ok(
      board(water[0]!).results.some((r) => r.id === "keys-move-player" && r.pass),
      "one input path is on the main owner's board",
    );
    // Which checks measured nothing, by id and not just by count: the run ledger keeps these,
    // and `rarelyMeasurable` can only warn about a check on real data.
    for (const round of water) {
      const scored = round.scoreboard as {
        unmeasuredChecks?: string[];
        results: Array<{ id: string; pass: boolean | null }>;
      };
      assert.ok(Array.isArray(scored.unmeasuredChecks), "the round says which checks measured nothing");
      assert.deepEqual(
        [...scored.unmeasuredChecks!].sort(),
        scored.results
          .filter((r) => r.pass !== true && r.pass !== false)
          .map((r) => r.id)
          .sort(),
      );
    }
    assert.equal(water[1]!.winner, "incumbent");
    assert.equal(water[1]!.verdictSource, "taste-veto");
    assert.equal(water[1]!.attemptBranch, `refs/studio/runs/${runId}/attempts/water/2`);
    const grownAll = customEvents(events, "facet_check_added");
    const added = grownAll.filter((e) => e.origin !== "judge");
    assert.equal(added.length, 1);
    assert.equal((added[0]!.check as { id: string; kind: string }).id, "water-not-milky");
    assert.equal((added[0]!.check as { id: string; kind: string }).kind, "vision");
    // Every defect the judge names becomes a vision check on the board, seeded as failing on
    // the build it was named on — so "all checks pass" can never coexist with a defect list.
    const fromDefects = grownAll.filter((e) => e.origin === "judge");
    assert.ok(
      fromDefects.some((e) => (e.check as { defect?: string }).defect === "milky water — default"),
      "the judge's defect became a check",
    );
    assert.ok(
      water.some((i) => board(i).results.some((r) => r.id.startsWith("defect-milky-water"))),
      "the judge-origin check rides on the scoreboard",
    );
    const spikes = customEvents(events, "facet_spike");
    assert.ok(
      spikes.some((s) => s.phase === "opened" && s.checkId === "dark-sky"),
      "the twice-failed identity check opened a spike",
    );
    const closed = spikes.find((s) => s.phase === "closed" && s.checkId === "dark-sky")!;
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(closed.recipe, "spike.water.dark-sky");
    const last = water.at(-1)!;
    assert.equal(last.winner, "challenger");
    assert.equal(last.satisfied, true, "identity checks pass and the taste judge is satisfied");
    assert.ok(
      board(last).results.some((r) => r.id === "dark-sky" && r.pass),
      "the spiked check passes after the port",
    );
    assert.ok(
      board(last).results.some((r) => r.id === "water-not-milky" && r.pass),
      "the judge-added vision check is now part of the contract",
    );

    // The recipe landed in the technique library, with the spike as evidence.
    const recipeFile = path.join(rig.core.layout.harnessWs, "library", "recipes", "spike.water.dark-sky.json");
    const recipe = JSON.parse(await readFile(recipeFile, "utf8")) as {
      title: string;
      sketch: string;
      status: string;
      evidence: Array<{ spike?: string }>;
    };
    assert.equal(recipe.title, "Black sky gradient");
    assert.match(recipe.sketch, /0x000000/);
    assert.ok(recipe.evidence.some((e) => e.spike === "dark-sky"));
    // …and the session after the spike opened on it. The spike's result reaches the builder
    // through `.studio/BRIEF.md` — since M4.8b a delegated prompt points at that file and does
    // not repeat what it already says — and the spike worktree rides along as a read root.
    const afterSpike = delegations.find(
      (d) =>
        /YOUR FACET: Water|facet "Water"/.test(d.prompt) &&
        (d.extraReads ?? []).some((dir) => /spike-water-dark-sky/.test(dir)),
    );
    assert.ok(afterSpike, "the next water session opened on the spike's worktree");
    assert.equal(
      /A spike SOLVED check dark-sky/.test(afterSpike!.prompt),
      false,
      "the prompt points at the brief instead of carrying the spike result twice",
    );

    // The lost attempt is a real, reachable commit in the game's repo — on a ref of the
    // studio's own, so the user's `git branch` is still only their own (M2.7) — and its diff
    // summary reached the brief.
    const gameDir = path.join(rig.core.layout.gamesRoot, "marshworld");
    const attempt = `refs/studio/runs/${runId}/attempts/water/2`;
    const { stdout: branches } = await gitFile(["-C", gameDir, "branch", "--list"]);
    assert.doesNotMatch(branches, /attempt\//, branches);
    const { stdout: refs } = await gitFile(["-C", gameDir, "for-each-ref", "--format=%(refname)", "refs/studio/"]);
    assert.match(refs, new RegExp(attempt));
    // The builder's own notes are committed with the round — under docs/notes/, not as an
    // eighth NOTES file in the root of somebody's game (M2.7).
    const { stdout: keptFiles } = await gitFile(["-C", gameDir, "ls-tree", "-r", "--name-only", attempt]);
    assert.match(keptFiles, /^docs\/notes\/NOTES\.water\.md$/m, keptFiles);
    assert.doesNotMatch(keptFiles, /^NOTES\.water\.md$/m, keptFiles);
    // The judge's words are the message, as written: nothing in them ran (HQ-1).
    const { stdout: attemptMessage } = await gitFile(["-C", gameDir, "log", "-1", "--format=%s", attempt]);
    assert.equal(
      attemptMessage.trim(),
      "facet water iteration 2: attempt (taste-veto) — taste veto: the water went milky `echo judged` $(echo twice)",
    );
    const briefAfterLoss = delegations.find(
      (d) => /YOUR FACET: Water|facet "Water"/.test(d.prompt) && d.prompt.includes(attempt),
    );
    assert.ok(briefAfterLoss, "the retained attempt is named in the next brief");

    // Persistent session: iteration 2+ resumed the contractor with its session id.
    const resumed = delegations.filter((d) => d.resume === "ses_water");
    assert.ok(resumed.length >= 2, `water resumed its session ${resumed.length} times`);
    assert.ok(resumed.some((d) => /You are resuming your own session/.test(d.prompt)));

    // The code reviewer caught Math.random() and the fix happened in the same session, before evidence.
    const reviews = customEvents(events, "facet_review");
    assert.ok(
      reviews.some(
        (r) =>
          r.facetId === "water" && (r.violations as Array<{ what: string }>).some((v) => /Math\.random/.test(v.what)),
      ),
    );
    assert.ok(
      delegations.some((d) => /CODE REVIEW before your build is judged/.test(d.prompt) && d.resume === "ses_water"),
    );
    assert.ok(reviewDiffs.length >= 1, "the model reviewer saw the diff");

    // ── sky: a vision check with a crop, and an invisible diff rejected without a judge ──
    assert.ok(sky.length >= 3, `sky ran ${sky.length} iterations`);
    assert.equal(sky[0]!.winner, "challenger");
    assert.ok(board(sky[0]!).results.some((r) => r.id === "sun-visible" && r.pass));
    assert.ok(
      visionAsks.some((t) => /Is the sun visible/.test(t)),
      "the vision check asked its one question",
    );
    // Once water carries more than one picture question about the same camera they travel in one
    // call (M3.10): a board of six used to be six Claude sessions.
    const batched = visionAsks.filter((t) => /^QUESTIONS \(\d+\)/m.test(t));
    assert.ok(
      batched.some((t) => /water-not-milky/.test(t) && /defect-milky-water/.test(t)),
      `two questions about one camera, one call: ${batched.length} batched asks`,
    );
    assert.ok(!visionAsks.some((t) => /QUESTIONS \(1\)/.test(t)), "a lone question keeps the single-question prompt");
    assert.ok(rig.preview.crops.length >= 1, "the crop was cut from the judged frame");
    assert.equal(sky[1]!.winner, "incumbent");
    assert.equal(sky[1]!.verdictSource, "invisible");
    assert.equal(tasteCalls.Sky, 2, "the invisible iteration spent no judge call");
    assert.equal(sky.at(-1)!.satisfied, true);

    // The run closed with an integration facet and a verdict.
    const finished = customEvents(events, "run_finished")[0]!;
    assert.equal((finished.globalVerdict as { pick?: string })?.pick, "challenger");
    assert.ok(iterations.some((i) => i.facetId === "integration"));
    const threadId = (await rig.core.store.listThreads()).find(
      (t) => (t.metadata as { project?: string })?.project === "marshworld",
    )!.id;
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as {
      facets: Record<string, { sessionId?: string; spec?: { checks: Array<{ id: string }> } }>;
    };
    assert.equal(journal.facets.water!.sessionId, "ses_water");
    assert.ok(
      journal.facets.water!.spec!.checks.some((c) => c.id === "water-not-milky"),
      "the grown spec is journaled",
    );
    // Worktrees are gone; recipes and branches remain.
    const scratch = await readdir(path.join(rig.core.layout.scratch, "autopilot", runId)).catch(() => []);
    assert.equal(scratch.length, 0, `worktrees cleaned up: ${scratch.join(", ")}`);
  });
});

/**
 * The diet (M4.8b). A worker gets its instructions ONCE: `.studio/BRIEF.md` in its worktree,
 * and a prompt that points at the file. Before this, eleven sections were written twice — the
 * contract, the ownership rules, the ledger, the reference bullets — and the second copy was
 * the one that cost the window on every build turn of the run.
 */
export const TWELVE_CHECK_FIXTURE = (() => {
  const checks = Array.from({ length: 12 }, (_, i) => ({
    id: `check-${i + 1}`,
    kind: i % 3 === 0 ? "pixel" : i % 3 === 1 ? "probe" : "scene",
    camera: "default",
    expr: i % 3 === 1 ? "state.player.moved > 0" : "meanLuma in [0.3,0.5]",
    js: "count('tree') >= 4",
    weight: i < 3 ? "identity" : "normal",
  }));
  return {
    run: { runId: "run_diet", project: "plaza", goal: "a plaza people want to skate", engine: "claude-code" },
    spec: {
      id: "plaza",
      title: "The plaza",
      intent: "a stone plaza with benches and trees under a low sun",
      owns: ["src/plaza.js"],
      identity: ["stone", "benches", "trees"],
      checks,
      done: [
        { id: "check-1", what: "a plaza a player can walk across" },
        { id: "check-2", what: "benches you can sit on" },
      ],
    },
    board: Object.fromEntries(
      checks.map((c, i) => [
        c.id,
        {
          id: c.id,
          pass: i % 4 === 0 ? false : i % 4 === 1 ? true : null,
          reason: "the camera saw nothing where the check looks",
          weight: c.weight,
        },
      ]),
    ),
    defects: Array.from({ length: 12 }, (_, i) => `defect ${i + 1}: the stone reads as plastic under the sun`),
    steering: ["make the benches oak", "the sun sits lower than that"],
  };
})();

describe("the diet: every section reaches a worker once", () => {
  const { run, spec, board, defects, steering } = TWELVE_CHECK_FIXTURE;
  const briefOf = (opts: Record<string, unknown> = {}) =>
    briefWithMovedSections(
      renderBrief({
        run,
        spec,
        iteration: 4,
        board,
        comparison: null,
        attempts: [],
        recipes: [],
        steering,
        defects,
        screen: true,
        critic: "place",
      } as never),
      { spec, ownsMain: false, ownShape: false, ...opts } as never,
    );
  const promptOf = (opts: Record<string, unknown> = {}) =>
    facetPrompt({
      run,
      spec,
      iteration: 4,
      resumed: false,
      briefFile: "/w/.studio/BRIEF.md",
      briefText: null,
      board,
      defectList: defects,
      worktree: "/w",
      userSteering: steering,
      ownsMain: false,
      integrationNote: "INTEGRATION: the merge brought sky in",
      spike: "SPIKE RESULT: the technique works",
      lastFailure: "ReferenceError: THREE is not defined\n  at src/plaza.js:12",
      acceptedShots: ["a.png"],
      move: { what: "benches along the north edge", mandatory: true },
      ...opts,
    } as never);

  it("the delegated prompt keeps its opener, the pointer, the user and the move — and nothing the brief already says", () => {
    const prompt = promptOf();
    const brief = briefOf();
    // The literals the verify chain asserts survive the diet.
    assert.match(prompt, /^You are building ONE FACET/);
    assert.match(prompt, /READ .*\.studio\/BRIEF\.md FIRST/);
    assert.match(prompt, /USER STEERING \(obey this over everything below\):/);
    assert.match(prompt, /THE MOVE THIS ITERATION \(mandatory\)/);
    assert.match(prompt, /GAME GOAL: a plaza people want to skate/);

    for (const [what, pattern] of [
      ["the contract", /THE CONTRACT —/],
      ["identity features", /IDENTITY FEATURES/],
      ["done means", /DONE MEANS/],
      ["file ownership", /FILE OWNERSHIP|YOUR SEAM IN THIS GAME/],
      ["the integration note", /INTEGRATION: the merge brought sky in/],
      ["the spike result", /SPIKE RESULT: the technique works/],
      ["the defect ledger", /THE JUDGE'S DEFECT LEDGER/],
      ["the reference bullets", /reference stills in references\//],
      ["the behavioural demo", /expose a deterministic demo/],
      ["the keep-__studio bullet", /window\.__studio still works/],
      ["one screen one input path", /ONE SCREEN, ONE INPUT PATH/],
    ] as const) {
      assert.doesNotMatch(prompt, pattern, `${what} is in the brief, not in the prompt`);
    }
    assert.ok(prompt.length < 4_000, `the delegated prompt is ${prompt.length} bytes`);
    assert.ok(
      prompt.length < brief.length * 0.6,
      `${prompt.length} is ${Math.round((100 * prompt.length) / brief.length)}% of the ${brief.length}-byte brief`,
    );
  });

  it("the resumed branch obeys the same caps — most build turns after the first take it", () => {
    const resumed = promptOf({
      resumed: true,
      lastAttempt: { won: false, why: "no check flipped", flips: [], branch: "attempt/plaza/3" },
    });
    assert.match(resumed, /resuming your own session/);
    assert.match(resumed, /READ .*\.studio\/BRIEF\.md FIRST/);
    assert.doesNotMatch(resumed, /INTEGRATION: the merge brought sky in/);
    assert.doesNotMatch(resumed, /SPIKE RESULT: the technique works/);
    assert.doesNotMatch(resumed, /THE JUDGE'S DEFECT LEDGER/);
    assert.ok(resumed.length < 4_000, `the resumed prompt is ${resumed.length} bytes`);
  });

  it("caps the four lists that had no bound at all, and says how many it left out", () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `f-${i}`,
        { id: `f-${i}`, pass: false, reason: "nothing there", weight: "normal" },
      ]),
    );
    const steeringWall = Array.from({ length: 12 }, (_, i) => `steering ${i}: ${"x".repeat(900)}`);
    const long = facetPrompt({
      run,
      spec,
      iteration: 4,
      resumed: false,
      briefFile: "/w/.studio/BRIEF.md",
      briefText: null,
      board: many,
      worktree: "/w",
      ownsMain: false,
      userSteering: steeringWall,
      acceptedShots: [],
    } as never);
    assert.ok(long.includes(`(+${30 - MAX_PROMPT_LIST} more`), "the board says how many failing checks it left out");
    assert.match(long, /\(\+8 earlier instructions, in the brief\)/);
    // A failure report has no bound of its own — a bundler stack is thousands of lines.
    const failed = facetPrompt({
      run,
      spec,
      iteration: 4,
      resumed: false,
      briefFile: "/w/.studio/BRIEF.md",
      briefText: null,
      board: many,
      worktree: "/w",
      ownsMain: false,
      userSteering: steeringWall,
      lastFailure: "boom\n".repeat(3_000),
      acceptedShots: [],
    } as never);
    assert.match(failed, /\(\+\d+ earlier characters, clipped\)/);
    assert.ok(failed.includes("boom"), "and the tail of it — where the cause is — survives");
    for (const text of [long, failed])
      assert.ok(text.length < 10_000, `an adversarial run is still bounded: ${text.length} bytes`);
    // Every steering line is clipped, not one of them repeated whole.
    for (const line of long.split("\n")) assert.ok(line.length <= 1_200, `a prompt line of ${line.length} characters`);
  });

  it("the direct prompt — no brief file to read — keeps every section", () => {
    const direct = facetPrompt({
      run,
      spec,
      iteration: 4,
      resumed: false,
      briefFile: null,
      briefText: briefOf(),
      board,
      defectList: defects,
      worktree: "/w",
      userSteering: steering,
      ownsMain: false,
      integrationNote: "INTEGRATION: the merge brought sky in",
      spike: "SPIKE RESULT: the technique works",
      acceptedShots: ["a.png"],
    } as never);
    assert.match(direct, /THE CONTRACT —/);
    assert.match(direct, /IDENTITY FEATURES/);
    assert.match(direct, /DONE MEANS/);
    assert.match(direct, /FILE OWNERSHIP/);
    assert.match(direct, /THE JUDGE'S DEFECT LEDGER/);
    assert.match(direct, /SPIKE RESULT: the technique works/);
    assert.match(direct, /INTEGRATION: the merge brought sky in/);
    assert.match(direct, /expose a deterministic demo/);
    assert.match(direct, /window\.__studio still works/);
  });

  it("the four moved sections land in the brief, in both ownership shapes", () => {
    const template = briefOf();
    assert.match(template, /## Done means/);
    assert.match(template, /- a plaza a player can walk across — measured by check check-1/);
    assert.match(template, /- YOUR FILES: put this facet's work in its own module — src\/plaza\.js/);
    assert.match(
      template,
      /Touch src\/main\.js ONLY to add your single import \+ init line inside the "FACET WIRING" marker block/,
    );
    assert.match(template, /expose a deterministic demo/);
    // And the sections renderBrief already carried, which the prompt now stops repeating.
    const withSpike = renderBrief({
      run,
      spec,
      iteration: 4,
      board,
      comparison: null,
      spike: "A spike SOLVED check dark-sky — port it",
      integration: "INTEGRATION: the merge brought sky in",
      defects,
    } as never);
    assert.match(withSpike, /## Spike result\nA spike SOLVED check dark-sky/);
    assert.match(withSpike, /## Integration\nINTEGRATION: the merge brought sky in/);
    assert.match(withSpike, /## The judge's defect ledger/);
    assert.match(withSpike, /## Checks \(the contract/);

    const owner = briefOf({ ownsMain: true });
    assert.match(owner, /- This worker OWNS src\/main\.js and src\/studio\.js/);
    assert.doesNotMatch(owner, /FACET WIRING/);

    const own = briefOf({ ownShape: true, entryMain: "src/main.ts", build: "npm run build" });
    assert.match(own, /- YOUR SEAM: src\/plaza\.js\./);
    assert.match(own, /This worker does NOT own src\/main\.ts, src\/studio\.js or index\.html/);
    assert.match(own, /- Run `npm run build` before you finish/);
    const unbuilt = briefOf({ ownShape: true, entryMain: "src/main.ts", build: null });
    assert.doesNotMatch(unbuilt, /before you finish: the studio runs the same build/);

    // Rendered once: the day renderBrief carries these itself, the splice is a no-op.
    assert.equal(briefWithMovedSections(template, { spec, ownsMain: false, ownShape: false } as never), template);
  });
});

/**
 * M4.7 — THE FIX's recipe is IN the brief, not merely promised by it. The fix's line says the
 * recipe is "under Recipes that apply below", but that list is retrieval sorted by score and cut
 * to three, and an exact check-id match outscores the fix's own match on the gap's prose: two
 * failing craft checks were enough to drop it while the promise stayed, and the builder either
 * hunted for it by hand or invented the fourth way the brief had just forbidden.
 */
describe("the fix's recipe is in the brief that promises it", () => {
  const seedDir = path.join(fileURLToPath(new URL("../..", import.meta.url)), "src", "harness-seed");
  const fixRun = { runId: "run_fix", project: "village", goal: "a winter village" };
  const fixSpec = { id: "reeds", title: "The reeds", intent: "the pond edge", checks: [], identity: [], cameras: [] };

  it("pins it when the sort would drop it, without growing the brief's budget", async () => {
    const recipes = await loadRecipes(seedDir);
    assert.ok(recipes.length > 10, `the shipped library is there: ${recipes.length} recipes`);
    // The gap the judge has repeated three times, and the craft recipe retrieved from its words.
    const gap = "the reeds are grey faceted balls on sticks";
    const fixCheck = checksFromDefects([gap], { limit: 1 })[0]!;
    const recipe = craftForNewCheck(recipes, fixCheck)[0]?.recipe;
    assert.ok(recipe, `the library knows this gap: ${JSON.stringify(fixCheck)}`);
    const fix = { what: gap, checkId: null, streak: 3, mandatory: false, losses: 0, recipe };

    // A handful of failing craft checks of other packs push it out by score alone: an exact
    // check-id match scores far above a match on the gap's prose.
    const failing = [
      "materials-mapped-identity",
      "materials-no-flat-buildings",
      "materials-roughness-varies",
      "masonry-reads-weathered",
      "grade-black-point",
    ].map((id) => ({ id, kind: "scene" }));
    const retrieved = recipesForChecks(recipes, [...failing, ...checksFromDefects([gap], { limit: 1 })], undefined, {
      project: fixRun.project,
    } as never);
    assert.equal(
      retrieved.some((entry) => entry.recipe.id === recipe.id),
      false,
      `retrieval alone drops it: ${retrieved.map((e) => e.recipe.id).join(", ")}`,
    );

    const pinned = pinFixRecipe(retrieved, fix, fixCheck.id);
    assert.equal(pinned[0]!.recipe.id, recipe.id, "the fix's recipe comes first");
    assert.equal(pinned.length, retrieved.length, "and the brief carries no more recipes than before");
    // The brief now keeps the promise its own FIX section makes.
    const brief = renderBrief({ run: fixRun, spec: fixSpec, iteration: 4, board: {}, fix, recipes: pinned } as never);
    assert.match(
      brief,
      new RegExp(
        `The library has a recipe for exactly this: .*\\(${recipe.id.replace(".", "\\.")}\\) — it is under "Recipes that apply" below`,
      ),
    );
    assert.match(
      brief,
      new RegExp(`### .*\\(${recipe.id.replace(".", "\\.")}, `),
      "and it is rendered under that heading",
    );

    // A fix whose recipe retrieval already found is left exactly where it was, and a fix with
    // no recipe at all changes nothing.
    const already = pinFixRecipe(retrieved, { ...fix, recipe: retrieved[0]!.recipe });
    assert.deepEqual(
      already.map((e) => e.recipe.id),
      retrieved.map((e) => e.recipe.id),
    );
    assert.deepEqual(
      pinFixRecipe(retrieved, { ...fix, recipe: null }).map((e) => e.recipe.id),
      retrieved.map((e) => e.recipe.id),
    );
    assert.deepEqual(
      pinFixRecipe(retrieved, null).map((e) => e.recipe.id),
      retrieved.map((e) => e.recipe.id),
    );
    // Nothing retrieved at all: the fix's recipe is still the one recipe the brief carries.
    assert.deepEqual(
      pinFixRecipe<(typeof retrieved)[number]>([], fix as never, fixCheck.id).map((e) => e.recipe.id),
      [recipe.id],
    );
    // The check on the board, when the gap has one, is what the recipe is credited for.
    assert.equal(
      pinFixRecipe<(typeof retrieved)[number]>([], { ...fix, checkId: "reeds-organic" } as never, fixCheck.id)[0]!
        .primaryCheckId,
      "reeds-organic",
    );
  });
});

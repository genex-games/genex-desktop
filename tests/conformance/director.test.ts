import { gitFile } from "../helpers/git.ts";
/**
 * The director — the run as one agent's decisions. The tools it is given, the brief
 * it opens with, the contract a worker is started on, and one run through the real core and
 * the real harness child: a scripted director session starts a worker, waits for it, looks at
 * its build, integrates it, judges the integrated build, shows it to the user, and finishes —
 * every call crossing the studio → harness dispatch that answers, the integration branch
 * landing in the live folder at the end.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  EngineError,
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type DelegateResult,
  type LiveToolResult,
} from "../../src/substrate/engines/types.ts";
import {
  customEvents,
  makeFakePreview,
  startRig,
  waitForLog,
  type FakePreview,
  type Rig,
} from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import {
  DIRECTOR_TOOLS,
  MAX_DIRECTOR_MEMORY,
  MAX_WAIT_S,
  MONITOR_TICK_MS,
  PLAN_REVIEW_WAIT_MS,
  WINDOW_RETRIES_MS,
  clampBoard,
  clampDirectorMemory,
  compilePlan,
  directorMemoryKeep,
  compileWorkerSpec,
  contractBrief,
  directorBrief,
  directorTool,
  headSynced,
  landingWords,
  loopDigest,
  loopNote,
  makeRouteDefect,
  medianMinutes,
  monitorEveryMs,
  monitorFindings,
  monitorNote,
  planReviewWaitMs,
  plainly,
  shortBudgetWarning,
  singleWorkerBrief,
  startingHeads,
  waitDigest,
  waitForPlanGo,
  workerDigest,
  workerWindows,
  wrapReserveMs,
  wrapUpPrompt,
} from "../../src/harness-seed/loop/director.ts";
import { contractWiringAsk } from "../../src/harness-seed/loop/autopilot.ts";
import { unversionedNested } from "../../src/harness-seed/loop/gauntlet.ts";
import { judgeableFirst } from "../../src/harness-seed/loop/main.ts";
import { OPEN_RUNG_WHAT } from "../../src/harness-seed/loop/facet/growth.ts";
import {
  FACET_POLICY,
  FACET_POLICY_RANGE,
  ITERATION_HEADROOM,
  chooseMove,
  defectsToChecks,
  facetIsDone,
  judgeChecksToRetire,
  loopStateOf,
  normalizeFacetPolicy,
} from "../../src/harness-seed/loop/facet-loop.ts";
import { summarizeScoreboard, toScoreboard } from "../../src/harness-seed/loop/checks.ts";
import { CHECK_KINDS, renderCheckGrammar, renderChecks } from "../../src/harness-seed/loop/spec.ts";
import { KIND_NAMES } from "../../src/harness-seed/loop/kinds.ts";
import { CoreFact } from "../../src/harness-seed/loop/folder-facts.ts";
import { appIdentity } from "../../src/harness-seed/loop/project-prompts.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** git in a worktree, the way the director itself works in one: with its own hands. */
const git = async (cwd: string, args: string[]): Promise<string> => (await gitFile(args, { cwd })).stdout.trim();

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const json = (result: LiveToolResult): Record<string, any> => JSON.parse(text(result));

/**
 * The run's plan, which every director now writes before its first builder (M3.8) — the card
 * the user reads. The scripted sessions below call it the way a real one would.
 */
const planFor = (...ids: string[]): Record<string, unknown> => ({
  summary: "This run: make the plaza somewhere you would want to skate.",
  workers: JSON.stringify(
    ids.map((id) => ({
      id,
      title: id,
      seam: `the ${id}`,
      owns: `src/${id}.js`,
      done: [`the ${id} is there to see`],
      minutes: 20,
    })),
  ),
  base: "the integration branch as it stands",
  risks: "one window at a time on this machine",
});

/**
 * The vision a plan with a module contract gives beside it (loop/vision.ts): a loop worker under a
 * contract waits for both.
 */
const PLAZA_VISION = JSON.stringify({
  scale: "a plaza 40 metres across, three streets off it",
  far: "rooftops and a church spire past the nearest buildings, a dusk sky",
  set_pieces: ["the fountain at the plaza's heart", "a stair down to the river"],
  headroom: "the river bank and a market street the plaza could grow into",
});

/**
 * The same plan with the parts `singles` names built by one session only (`"mode":"single"`): one
 * looping part is left, so no module contract is needed before its worker starts (contract-gate.ts).
 */
const planWithSingle = (singles: string[], ...ids: string[]): Record<string, unknown> => {
  const plan = planFor(...ids);
  const parts = JSON.parse(String(plan.workers)) as Array<{ id: string }>;
  return {
    ...plan,
    workers: JSON.stringify(parts.map((part) => (singles.includes(part.id) ? { ...part, mode: "single" } : part))),
  };
};

describe("the director's tools and brief", () => {
  it("offers flat, uniquely named run tools that both bridges can carry", () => {
    const names = DIRECTOR_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "unique names");
    for (const reserved of ["computer", "look", "capture", "resolve_root"])
      assert.ok(!names.includes(reserved), `${reserved} is the studio's, not the harness's`);
    for (const tool of DIRECTOR_TOOLS) {
      assert.equal(tool.parameters.type, "object");
      for (const [key, prop] of Object.entries(tool.parameters.properties))
        assert.equal(
          (prop as { type: string }).type,
          "string",
          `${tool.name}.${key} is a string (the bridge carries strings)`,
        );
      for (const req of tool.parameters.required ?? [])
        assert.ok(req in tool.parameters.properties, `${tool.name} requires ${req} it declares`);
      assert.ok(tool.description.length > 40, `${tool.name} is described`);
    }
    for (const name of [
      "run_status",
      "worker_start",
      "worker_status",
      "worker_steer",
      "worker_stop",
      "worker_wait",
      "worker_mark",
      "judge",
      "playtest",
      "integrate",
      "show",
      "note",
      "finish",
    ])
      assert.ok(names.includes(name), name);
    assert.ok(MAX_WAIT_S <= 300, "a wait fits under the bridge shim's ten minutes");
  });

  it("briefs the director with the goal, the clock, its whereabouts, every tool, the playbook and the rules", () => {
    const now = Date.now();
    const brief = directorBrief({
      run: {
        runId: "run_d",
        project: "skate",
        goal: "refine the MACBA plaza",
        engine: "claude-code",
        reference: { name: "Skate 3", notes: "wet stone" },
        setup: {
          actions: [{ type: "tap", keys: ["i"] }],
          verify: { path: "maps.activeId", equals: "macba" },
          note: "I opens the picker",
        },
      },
      shape: { entry: "dist/index.html", main: "src/main.ts", build: "npm run build" },
      ownShape: true,
      capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
      skill: "# playbook\nlook first",
      softDeadline: now + 50 * 60_000,
      finalDeadline: now + 60 * 60_000,
      integrationWorktree: "/scratch/autopilot/run_d/integration",
      baseCommit: "abcdef1234567890",
    } as never);
    assert.match(brief, /You are the DIRECTOR of run run_d/);
    assert.match(brief, /GAME GOAL: refine the MACBA plaza/);
    assert.match(brief, /OWN SHAPE: entry src\/main\.ts, built with `npm run build`/);
    assert.match(brief, /THE REQUESTED STATE: .*I opens the picker.*verified by maps\.activeId/);
    assert.match(
      brief,
      /TIME: 60 minutes in all\. Your session ends at .* \(50 minutes from now\); the last 10 minutes are reserved/,
    );
    assert.match(
      brief,
      /cwd is the run's integration worktree \(\/scratch\/autopilot\/run_d\/integration\).*commit abcdef1234/,
    );
    // Flipped: "5 of 6 worker windows free" counted the lead's own
    // two windows as workers'. The line says how many workers may run at once.
    assert.match(
      brief,
      /CAPACITY: up to 4 workers at once \(the user's setting; two more windows are yours\), 9000 MB memory free/,
    );
    // The tool block is three lines (M4.8b): a header carrying this engine's grammar, one line
    // about the window, and one naming every tool. Every schema below is already shipped with
    // the tool itself; a second prose copy of the same thirteen was 3.6 KB of the director's
    // window, half of it truncated at forty characters into fragments.
    assert.match(brief, /YOUR TOOLS — call each one by its name, mcp__studio__<name>:/);
    assert.doesNotMatch(brief, /tool\.mjs/, "a Claude director is never shown the Codex bridge");
    const named = brief.split("\n").find((line) => line.startsWith("- The run's own tools:"))!;
    assert.equal(
      named,
      `- The run's own tools: ${DIRECTOR_TOOLS.map((t) => t.name).join(", ")}.`,
      "every tool is still named, in order",
    );
    assert.match(brief, /- Your window shows one build at a time: look points it .*computer .*capture/);
    // No parameter prose survives: the block says no field name of any tool's schema.
    const block = brief.slice(brief.indexOf("YOUR TOOLS"), brief.indexOf("THE PLAYBOOK:"));
    for (const tool of DIRECTOR_TOOLS) {
      for (const field of Object.keys(tool.parameters.properties)) {
        if (["id", "text", "target"].includes(field)) continue;
        assert.equal(block.includes(`${field}=`), false, `${tool.name}.${field} is documented twice`);
      }
    }
    const codex = directorBrief({
      run: { runId: "run_d", project: "skate", goal: "g", engine: "codex" },
      softDeadline: now + 1,
      finalDeadline: now + 2,
      integrationWorktree: "/w",
      baseCommit: null,
    } as never);
    assert.match(codex, /YOUR TOOLS — run each one as `node \.studio\/bridge\/tool\.mjs <name> --field=value`:/);
    assert.doesNotMatch(codex, /mcp__studio__/, "a Codex director is never shown a name it cannot call");
    assert.match(brief, /THE PLAYBOOK:\n# playbook\nlook first/);
    assert.match(brief, /RULES THAT NEVER MOVE:/);
    // Flipped: one worker per area a player can name, the UI too.
    // Flipped again: per area the ask names — "an area a player can name" grows a police pursuit
    // out of a street race — and the pool is a ceiling, never a quota.
    assert.match(brief, /delegate with plan and worker_start: a worker per area the ask names, the UI and HUD too/);
    assert.match(brief, /CAPACITY: .*A ceiling, not a quota: start the fewest workers that cover independent files/);
    assert.doesNotMatch(brief, /time lost/, "an idle window is not a loss: a system nobody asked for is");
    assert.match(brief, /Finish once required outcomes are verified; time is a ceiling/);
    assert.match(brief, /\.studio\/DIRECTOR\.md/);
    assert.ok(!brief.includes("YOU WERE RESUMED"));
    const resumed = directorBrief({
      run: { runId: "r", project: "p", goal: "g" },
      softDeadline: now + 1,
      finalDeadline: now + 2,
      integrationWorktree: "/w",
      baseCommit: null,
      resume: "workers are gone",
    } as never);
    assert.match(resumed, /YOU WERE RESUMED\. workers are gone/);
    assert.match(resumed, /STUDIO TEMPLATE/);
  });

  it("reserves a wrap-up slice and writes the wrap-up and worker briefs", () => {
    assert.equal(wrapReserveMs(60 * 60_000), 6 * 60_000);
    assert.equal(wrapReserveMs(24 * 3_600_000), 15 * 60_000);
    assert.equal(wrapReserveMs(10 * 60_000), 5 * 60_000);
    const wrap = wrapUpPrompt({
      run: { runId: "r" },
      finalDeadline: Date.now() + 8 * 60_000,
      integrationHead: "0123456789ab",
      integrationHealthy: false,
      workers: [
        { id: "a", state: "running" },
        { id: "b", state: "done" },
      ],
    } as never);
    assert.match(wrap, /8 minutes remain/);
    assert.match(wrap, /Workers still running: a/);
    assert.match(wrap, /0123456789 \(last health pass: problems — land=no unless you fixed them\)/);
    const single = singleWorkerBrief({
      run: { runId: "r", project: "p", goal: "g" },
      worker: { id: "plaza", title: "Plaza", brief: "paint the plaza", owns: ["src/plaza.js"], ownsMain: false },
      setup: { note: "the plaza" },
    } as never);
    assert.match(single, /YOUR BRIEF FROM THE DIRECTOR — Plaza:\npaint the plaza/);
    assert.match(single, /YOUR FILES: src\/plaza\.js — touch the entry module only in its FACET WIRING block/);
    assert.match(single, /Do not commit/);
    assert.match(single, /NOTES\.plaza\.md/);
  });

  /**
   * The step that makes somebody's own game judgeable at all (M2.6). Its brief is the base
   * builder's own-shape wiring task and nothing else, and the director's own brief says which
   * of the two things happened — the contract is in, or it is the lead's first job.
   */
  it("briefs the contract install as the wiring task alone, and tells the director which way it went", () => {
    const shape = { entry: "dist/index.html", main: "src/main.ts", build: "npm run build" };
    const brief = contractBrief({
      run: { runId: "run_c", goal: "make the crashes hurt" },
      projectLabel: "wreckage",
      shape,
    } as never);
    assert.match(brief, /making the game "wreckage" judgeable for run run_c/);
    assert.ok(brief.includes(contractWiringAsk(shape)), "the base builder's own sentence, not a second wording");
    assert.match(brief, /src\/studio\.d\.ts/, "and where the types are when the compiler refuses ./studio.js");
    assert.match(brief, /Run `npm run build` yourself/);
    assert.match(brief, /Change nothing else/);
    assert.match(brief, /Do not commit; the studio commits/);
    assert.match(
      brief,
      /GAME GOAL \(context — not this run's work\): make the crashes hurt/,
      "the goal is context here, not the job",
    );
    assert.doesNotMatch(brief, /FACET WIRING/, "no facets fork from this one — it is the game as it arrived");
    const unbuilt = contractBrief({
      run: { runId: "r", goal: "g" },
      projectLabel: "p",
      shape: { entry: "index.html", main: "src/main.js", build: null },
    } as never);
    assert.doesNotMatch(unbuilt, /Run `/, "a game with no build command is asked to run nothing");

    const now = Date.now();
    const args = {
      run: { runId: "r", project: "wreckage", goal: "g" },
      shape,
      ownShape: true,
      softDeadline: now + 60_000,
      finalDeadline: now + 120_000,
      integrationWorktree: "/w",
      baseCommit: "abc1234567",
    };
    const installed = directorBrief({
      ...args,
      contract: { ok: true, commit: "feedface0123456", error: null },
      startObserved: true,
    } as never);
    assert.match(installed, /THE GAME IS JUDGEABLE NOW: it arrived without the studio contract/);
    assert.match(installed, /wired it into src\/main\.ts and committed it \(feedface01\)/);
    assert.doesNotMatch(installed, /THE START COULD NOT BE OBSERVED/, "there is a before now, and it can be looked at");
    const failed = directorBrief({
      ...args,
      contract: { ok: false, commit: null, error: "the session changed nothing" },
      startObserved: false,
    } as never);
    assert.match(failed, /CONTRACT NOT INSTALLED — DO THIS FIRST/);
    assert.match(failed, /the session changed nothing/);
    assert.ok(failed.includes(contractWiringAsk(shape)), "the fallback asks for exactly the same wiring");
    assert.match(
      failed,
      /read src\/main\.ts: if the call is already there, say so in a note and carry on/,
      "and never sends the lead to rewrite what is already right",
    );
    assert.doesNotMatch(
      directorBrief({ ...args, contract: null } as never),
      /CONTRACT NOT INSTALLED|THE GAME IS JUDGEABLE NOW/,
      "a game that already loads it is told nothing",
    );
  });

  /**
   * A game that arrived as its own git repository (M2.5). With the user's consent the studio
   * versions that folder inside every fork, so "nothing inside is versioned … no edit inside it
   * is ever committed" — what the brief said in both worlds — was false in exactly the world it
   * mattered in, and sent the lead hand-porting code the fork already tracked. The lead can
   * always ask its own worktree, so the brief sends it there instead of guessing for it.
   */
  it("sends the lead to its own worktree about a repository inside the game, and never claims nothing there is versioned", async () => {
    const now = Date.now();
    const args = {
      run: { runId: "r", project: "flautout-remix", goal: "g" },
      softDeadline: now + 60_000,
      finalDeadline: now + 120_000,
      integrationWorktree: "/w",
      baseCommit: "abc1234567",
    };
    const brief = directorBrief({ ...args, nestedRepos: ["wreckage"] } as never);
    assert.match(brief, /NESTED REPOSITORIES: wreckage — each is a git repository of its own inside the game folder/);
    assert.match(brief, /Run `git ls-files -- <path>` in your worktree/);
    assert.match(brief, /your workers' edits inside it are committed, integrated and landed like any other/);
    assert.match(brief, /If it lists nothing, nothing inside it is versioned — vendor what the run builds on first/);
    assert.doesNotMatch(
      brief,
      /no edit inside it is ever committed/,
      "false the moment the user allowed the studio to version it",
    );
    assert.doesNotMatch(
      directorBrief({ ...args, nestedRepos: [] } as never),
      /NESTED REPOSITORIES/,
      "a game with no repository inside it hears nothing about one",
    );

    // The same question asked of a commit rather than of the lead: this is what the health pass
    // fails a merge on, because a build that carries none of the work done inside such a folder
    // still loads, and `git status` cannot see the difference (git does not walk a gitlink).
    const said = (answer: string) => async () => answer;
    assert.deepEqual(await unversionedNested(said("160000 commit 4b825dc642cb\twreckage"), ["wreckage"]), ["wreckage"]);
    assert.deepEqual(
      await unversionedNested(said("040000 tree 9a1b2c3d4e5f\twreckage"), ["wreckage"]),
      [],
      "versioned here: ordinary files",
    );
    assert.deepEqual(
      await unversionedNested(said(""), ["wreckage"]),
      [],
      "a path this commit does not carry at all is not a pointer",
    );
    assert.deepEqual(
      await unversionedNested(async () => {
        throw new Error("not a git worktree");
      }, ["wreckage"]),
      [],
      "a question git cannot answer never fails a merge",
    );
    assert.deepEqual(
      await unversionedNested(said("160000 commit 4b825dc642cb\twreckage"), []),
      [],
      "and a game with no repository inside it is never asked",
    );
  });

  /** And the user hears it before they walk away, in words that name no contract and no run. */
  it("says in the chat that this run starts by making the game judgeable — only when it is not", () => {
    const said = judgeableFirst({ contract: "missing", problems: [] } as never);
    assert.match(said, /Your game doesn't have the studio's connection yet/);
    assert.match(said, /whether a change made the game better/);
    assert.doesNotMatch(
      said,
      /contract|__studio|installStudio/,
      "the word the harness uses is not the word the user reads",
    );
    assert.equal(judgeableFirst({ contract: "loaded", problems: [] } as never), "");
    assert.equal(judgeableFirst(null), "", "a folder nobody could validate promises nothing");
    assert.equal(judgeableFirst(undefined), "");
  });

  it("answers a tool call for a run without a director with a sentence, never a throw", async () => {
    assert.match(
      String(await directorTool({ runId: "run_nobody", name: "run_status", args: {} })),
      /no director session for run run_nobody/,
    );
  });
});

/**
 * What the morning is allowed to say, and where the run stands when it is resumed. Both are
 * pure: the close reads them, the report carries them, and the screen shows the sentence.
 */
describe("the honest landing, the plain word and the run's own starting points", () => {
  it("calls a judge's pick a preference only when it was against the build the user had", () => {
    const over = (against: string) =>
      landingWords({ judged: { head: "h", ok: true, against, pick: "challenger" }, healthPassed: false } as never);
    assert.deepEqual(over("start"), { verified: true, how: "judge-pick", line: "made live, a judge preferred it" });
    assert.deepEqual(over("live"), { verified: true, how: "judge-pick", line: "made live, a judge preferred it" });
    // A pick over another worker's dead-end branch is not a verdict over the start.
    assert.deepEqual(over("shine"), { verified: false, how: "judge-saw-load", line: "made live, not judged better" });
    // Nor is a yes to a free-text question — the one that used to read "a judge preferred it".
    assert.deepEqual(
      landingWords({ judged: { head: "h", ok: true, against: null, pick: null, answer: true } } as never),
      {
        verified: false,
        how: "judge-saw-load",
        line: "made live, not judged better",
      },
    );
    // Nobody judged it: a fresh health pass says it loads, and nothing else claims more.
    assert.deepEqual(landingWords({ healthPassed: true }), {
      verified: false,
      how: "fresh-health-pass",
      line: "made live, not judged better",
    });
    assert.deepEqual(landingWords({}), {
      verified: false,
      how: "no-fresh-look",
      line: "made live, without a fresh look at it",
    });
  });

  it("keeps the base commit as a starting point when the run is resumed", () => {
    // First session, from scratch: the scaffold it forked from is the starting point.
    assert.deepEqual(startingHeads({ fromScratch: true, forkCommit: "scaffold", priorJournal: null } as never), [
      "scaffold",
    ]);
    // Resumed before any worker merged: the fork point IS the base this run built. Without it
    // the fork gate refused every worker — "the build at <sha> does not run" — on the empty
    // base the stage had just accepted.
    assert.deepEqual(
      startingHeads({
        fromScratch: true,
        forkCommit: "base",
        priorJournal: { director: { integrationHead: "base" }, base: { ok: true, commit: "base" } },
      } as never),
      ["base"],
    );
    // A resumed run standing on merged work: that head is a game and is judged like one.
    assert.deepEqual(
      startingHeads({
        fromScratch: true,
        forkCommit: "merged",
        priorJournal: { director: { integrationHead: "merged" }, base: { ok: false, commit: null } },
      } as never),
      [],
    );
    assert.deepEqual(startingHeads({}), []);
  });

  it("gives every decision card a sentence with no sha, ref or path in it", () => {
    assert.equal(
      plainly(
        "the integration branch 4f3a91bc22 did not load at the close — kept unlanded on refs/studio/runs/run_fixture123456/integration",
      ),
      "the integration branch did not load at the close — kept unlanded",
    );
    assert.equal(plainly("its work is on attempt/shine/3-stopped"), "its work is");
    assert.equal(
      plainly("the base session failed: ENOENT, open '/Users/someone/games/plaza/src/world.js'"),
      "the base session failed: ENOENT, open",
    );
    assert.equal(plainly("the starting point is ready"), "the starting point is ready");
  });

  it("lets the director write the user's sentence itself", () => {
    const note = DIRECTOR_TOOLS.find((t) => t.name === "note") as unknown as {
      parameters: { properties: Record<string, { description: string }>; required: string[] };
    };
    assert.ok(
      "plain" in note.parameters.properties,
      "the card the chat shows is the director's own words, not a scrub of its notes",
    );
    assert.deepEqual(
      note.parameters.required,
      ["text"],
      "and it is optional — a note is never refused for want of one",
    );
    assert.match(note.parameters.properties.plain!.description, /no shas/i);
  });
});

/**
 * The contract a worker is started on. The first director run wrote ten worker_start calls
 * with checks and no weights: every board read identityTotal 0, "satisfied" was unreachable,
 * and thirteen probes over `state.<facet>.<field>` read `missing:` for six hours because
 * nothing had ever read one against a real state().
 */
describe("a worker's contract: done, compiled and dry-run", () => {
  /** What the fork point reported the last time the harness looked at it. */
  const base = {
    state: { player: { x: 2, speed: 9 }, props: { moved: 0 }, maps: { activeId: "macba" } },
    demoStates: { "prop-run": { player: { x: 2, speed: 6 }, props: { moved: 3 } } },
    demos: ["prop-run"],
    cameras: ["default"],
  };
  const doneList = [
    {
      what: "a car that hits a bin keeps most of its speed",
      check: { id: "speed-kept", kind: "probe", demo: "prop-run", expr: "state.player.speed >= 5" },
    },
    {
      what: "the bin ends up somewhere else",
      check: { id: "props-moved", kind: "probe", demo: "prop-run", expr: "state.props.moved > 0" },
    },
  ];
  /** The spec's checks, as the loop reads them. */
  const checksOf = (spec: {
    checks: unknown[];
  }): Array<{ id: string; kind: string; weight: string; demo?: string; note?: string }> => spec.checks as never;
  const checkNamed = (spec: { checks: unknown[] }, id: string) => checksOf(spec).find((c) => c.id === id)!;

  it("compiles `done` into the identity checks the worker finishes on", () => {
    const compiled = compileWorkerSpec(
      {
        id: "contact",
        title: "Contact",
        brief: "props that do not stop cars",
        checks: [{ id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.4" }],
        done: doneList,
      } as never,
      base as never,
    );
    assert.equal(compiled.identityTotal, 2);
    assert.deepEqual(compiled.spec.done, [
      { id: "speed-kept", what: "a car that hits a bin keeps most of its speed" },
      { id: "props-moved", what: "the bin ends up somewhere else" },
    ]);
    // The board the loop will score, and the summary it exits on.
    const board = toScoreboard(
      checksOf(compiled.spec).map((c) => ({ id: c.id, kind: c.kind, weight: c.weight, pass: true })) as never,
    );
    const summary = summarizeScoreboard(board, compiled.spec);
    assert.ok(
      summary.identityTotal >= 2,
      `identityTotal ${summary.identityTotal}: a worker with no identity checks can never be satisfied`,
    );
    assert.equal(summary.identityAllPass, true);
    assert.equal(checkNamed(compiled.spec, "lit").weight, "normal");
    // The demo scope survives the compiler, and the sentence reaches the builder's brief.
    assert.equal(checkNamed(compiled.spec, "speed-kept").demo, "prop-run");
    assert.match(
      renderChecks(compiled.spec.checks),
      /speed-kept \[identity\] — probe on the state left by demo "prop-run".*a car that hits a bin keeps most of its speed/,
    );
    assert.deepEqual(compiled.unsatisfiable, []);
  });

  it("still weighs the prose identity list, so a brief written the old way is not a board of nothing", () => {
    const compiled = compileWorkerSpec(
      {
        id: "contact",
        brief: "props that do not stop cars",
        identity: ["props are knocked over by the car"],
        checks: [
          { id: "props-dont-stop-cars", kind: "probe", expr: "state.player.speed > 1" },
          { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.4" },
        ],
      } as never,
      base as never,
    );
    assert.equal(compiled.identityTotal, 1, "the check that says the same thing as the feature carries it");
    assert.equal(checkNamed(compiled.spec, "props-dont-stop-cars").weight, "identity");
    assert.equal(checkNamed(compiled.spec, "lit").weight, "normal");
  });

  it("reads a path a probe names as a string too, so `delta('state.…')` cannot dry-run clean and then score false for the whole run", () => {
    const compiled = compileWorkerSpec(
      {
        id: "contact",
        brief: "props that do not stop cars",
        forkedFrom: "0123456789abcdef0123456789abcdef01234567",
        done: [
          {
            what: "the bin ends up somewhere else",
            check: { id: "props-moved", kind: "probe", expr: "delta('state.props.moved') > 0" },
          },
          {
            what: "the crates are knocked over",
            check: { id: "crates", kind: "probe", expr: "delta('crates.knocked') > 0" },
          },
        ],
      } as never,
      base as never,
    );
    // `state.props.moved` resolves through the alias — the whole point of it; `crates.knocked`
    // does not, and the builder is told which paths the build must start reporting.
    assert.deepEqual(compiled.unsatisfiable, [{ id: "crates", missing: ["crates.knocked"] }]);
    assert.match(String(checkNamed(compiled.spec, "crates").note), /does not report crates\.knocked yet/);
    assert.doesNotMatch(String(checkNamed(compiled.spec, "props-moved").note ?? ""), /does not report/);
  });

  it("reads every check against the fork point: a path it does not report is unsatisfiable, an unlooked-at fork is notVerified", () => {
    const args = {
      id: "contact",
      brief: "props that do not stop cars",
      forkedFrom: "0123456789abcdef0123456789abcdef01234567",
      done: [
        {
          what: "a car that hits a bin keeps most of its speed",
          check: { id: "speed-kept", kind: "probe", expr: "state.contact.speedKept >= 0.7" },
        },
        { what: "the player is somewhere", check: { id: "player-there", kind: "probe", expr: "player.x > 0" } },
      ],
    };
    const compiled = compileWorkerSpec(args as never, base as never);
    assert.deepEqual(compiled.unsatisfiable, [{ id: "speed-kept", missing: ["state.contact.speedKept"] }]);
    assert.deepEqual(compiled.stateKeys, ["player", "props", "maps"], "the top-level keys state() actually has");
    assert.match(String(checkNamed(compiled.spec, "speed-kept").note), /does not report state\.contact\.speedKept yet/);
    assert.match(String(checkNamed(compiled.spec, "speed-kept").note), /player, props, maps/);
    assert.equal(compiled.notVerified, null);
    // It is a contract, not a rejection: the worker still starts, with the note in its brief.
    assert.equal(compiled.spec.checks.length, 2);
    assert.equal(compiled.identityTotal, 2);

    // Nobody has looked at this fork: not verified, and still not a refusal.
    const blind = compileWorkerSpec(args as never, null);
    assert.deepEqual(blind.unsatisfiable, []);
    assert.equal(blind.stateKeys, null);
    assert.match(String(blind.notVerified), /nothing has looked at 0123456789 in this run/);
    assert.equal(blind.spec.checks.length, 2);
  });

  it("refuses a floor on how much the build draws, and lets a screen part's board be judged by eye", () => {
    // `hud-rich: len(hud.items) >= 60` rewards a HUD drawn from thousands of rectangles.
    const compiled = compileWorkerSpec(
      {
        id: "hud",
        brief: "a dashboard you read at a glance",
        checks: [
          { id: "hud-rich", kind: "probe", expr: "len(hud.items) >= 60" },
          { id: "draw-budget", kind: "probe", expr: "__render.drawCalls <= 1000" },
        ],
      } as never,
      base as never,
    );
    assert.equal(compiled.problems.length, 1, compiled.problems.join("\n"));
    assert.match(compiled.problems[0]!, /hud-rich: a floor on how much the build draws/);
    assert.equal(
      checksOf(compiled.spec).some((c) => c.id === "hud-rich"),
      false,
    );
    assert.ok(checkNamed(compiled.spec, "draw-budget"));

    const looks = [
      { id: "speed-readable", kind: "vision", camera: "default", ask: "Can you read the speed at a glance?" },
      { id: "corners-clear", kind: "vision", camera: "default", ask: "Is the middle of the road clear of panels?" },
      { id: "lap-readable", kind: "vision", camera: "default", ask: "Can you read the lap?" },
      { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.1" },
    ];
    const screen = compileWorkerSpec(
      { id: "hud", brief: "a dashboard", checks: looks, critic: "screen" } as never,
      base as never,
    );
    assert.deepEqual(screen.problems, []);
    assert.equal(screen.spec.critic, "screen");
    const place = compileWorkerSpec({ id: "street", brief: "a street", checks: looks } as never, base as never);
    assert.match(place.problems.join("\n"), /3 of 4 checks are vision/);
  });

  it("holds the front-end's owner to its menu, not to play, and every other worker to play", () => {
    // `setup {"begin":false}` keeps the title on screen for that worker's evidence and judges
    // (evidence.ts reachPlay, PlayVia.Kept): a board that asked it to be in play, to move the
    // player from the menu, or to keep a full title panel inside the in-play HUD budget could
    // never pass, and its worker could never finish.
    const front = compileWorkerSpec(
      { id: "menu", brief: "a title, a countdown and results", kind: "racing", setup: { begin: false } } as never,
      null,
    );
    const ids = checksOf(front.spec).map((c) => c.id);
    for (const inPlay of ["reaches-play", "hud-coverage", "keys-move-player"])
      assert.ok(!ids.includes(inPlay), `${inPlay} is not on the front-end owner's board: ${ids.join(", ")}`);
    assert.ok(ids.includes("hud-overlap"), "a menu's pieces still must not run into each other");
    assert.ok(ids.includes("no-dom-ui"));

    const car = compileWorkerSpec({ id: "car", brief: "a car", kind: "racing" } as never, null);
    for (const inPlay of ["reaches-play", "hud-coverage", "keys-move-player"])
      assert.ok(checkNamed(car.spec, inPlay), `${inPlay} is on a normal worker's board`);

    // A harness check the ledger saw unmeasured is not the director's to re-point or drop.
    const rarely = compileWorkerSpec({ id: "car", brief: "a car", kind: "racing" } as never, null, {
      rarelyMeasurable: [
        { id: "reaches-play", rounds: 4 },
        { id: "hud-coverage", rounds: 3 },
      ],
    });
    assert.deepEqual(rarely.rarelyMeasurable, []);
  });

  it("finishes a worker on the checks it was given, not on the ones the judge grew", () => {
    const board = toScoreboard([
      { id: "speed-kept", kind: "probe", weight: "identity", pass: true },
      { id: "defect-milky-water", kind: "vision", weight: "normal", pass: false, reason: "still milky" },
    ] as never);
    const summary = summarizeScoreboard(board, { checks: [1, 2] } as never);
    assert.equal(
      facetIsDone({ won: true, verdict: { satisfied: true }, summary } as never),
      "the work it was given is done",
    );
    assert.equal(
      facetIsDone({ won: true, verdict: { satisfied: false }, summary } as never),
      null,
      "the taste judge still has a vote",
    );
    assert.equal(facetIsDone({ won: true, broken: true, verdict: { satisfied: true }, summary } as never), null);
    const stillFailing = summarizeScoreboard(
      toScoreboard([{ id: "speed-kept", kind: "probe", weight: "identity", pass: false, reason: "0.2" }]),
      { checks: [1] } as never,
    );
    assert.equal(facetIsDone({ won: true, verdict: { satisfied: true }, summary: stillFailing } as never), null);
  });

  it("compiles the director's move and milestones into the ladder the loop climbs", () => {
    // The ladder the director writes is the worker's move, one rung per accepted build. Without
    // it the harness's own planner names one every iteration — the run that motivated this
    // told five workers to build puddles and a tow truck while the brief said mud.
    /** The ladder as the loop reads it (the seed is plain JS: `moveOwner` is not in its shape). */
    const ladderOf = (compiled: { spec: unknown }) =>
      compiled.spec as {
        moveOwner?: string;
        milestones: Array<{ id: string; what: string; check?: { origin: string; milestone: string; note?: string } }>;
      };
    const compiled = ladderOf(
      compileWorkerSpec(
        {
          id: "dirt",
          brief: "mud on the panels",
          milestones: [
            { what: "mud builds up on the panels", check: { kind: "probe", expr: "state.player.speed >= 5" } },
            { what: "clods fly off the wheels" },
          ],
        } as never,
        base as never,
      ),
    );
    assert.equal(compiled.moveOwner, "director", "the harness never invents a move over a ladder the director wrote");
    // Flipped: the ladder ends with one open rung after the director's, which the reviewers' best
    // step inside the ask fills when it is reached.
    assert.deepEqual(
      compiled.milestones.map((m) => m.what),
      ["mud builds up on the panels", "clods fly off the wheels", OPEN_RUNG_WHAT],
    );
    assert.equal(compiled.milestones[0]!.check!.origin, "milestone");
    assert.equal(compiled.milestones[0]!.check!.milestone, compiled.milestones[0]!.id);
    // A rung is read against the fork point like any other check: a path the build does not
    // report yet is a note the director sees before the worker starts, not a dropped rung.
    const unreadable = ladderOf(
      compileWorkerSpec(
        {
          id: "dirt",
          brief: "x",
          milestones: [{ what: "clods fly", check: { kind: "probe", expr: "state.clods.count > 0" } }],
        } as never,
        base as never,
      ),
    );
    // Flipped with the open rung: the director's one rung, then the open one.
    assert.equal(unreadable.milestones.length, 2);
    assert.match(String(unreadable.milestones[0]!.check!.note), /does not report state\.clods\.count yet/);
    // No ladder: the spec says so, and the loop falls back to the planner as it always did.
    const none = ladderOf(compileWorkerSpec({ id: "dirt", brief: "x" } as never, base as never));
    assert.deepEqual(none.milestones, []);
    assert.equal(none.moveOwner, undefined);
  });

  /**
   * The finish stage: a worker that finishes what exists, where polish
   * is the work and wins on the blind pick. The director sets it on worker_start and flips it on
   * worker_steer; it rides on the spec like `moveOwner`, so the loop fixes it at the top of each
   * round, and the run log records a steer.
   */
  it("compiles a finishing worker's stage onto its spec, and leaves a build worker's spec as it was", () => {
    const finishing = compileWorkerSpec(
      { id: "paint", brief: "finish the street", stage: "finish" } as never,
      base as never,
    );
    assert.equal((finishing.spec as { stage?: string }).stage, "finish");
    const building = compileWorkerSpec({ id: "paint", brief: "build the street" } as never, base as never);
    assert.equal("stage" in building.spec, false, "a build worker's spec is byte for byte what it was");
  });

  it("refuses an unknown stage and a finish with a ladder by name, before it asks the machine for anything", async () => {
    const { startRefusal } = await import("../../src/harness-seed/loop/director/workers.ts");
    const asked: string[] = [];
    const loopRun = {
      ctx: { call: async (method: string) => void asked.push(method) },
      runningWorkers: () => [],
      softDeadline: Date.now() + 60 * 60_000,
      state: { finish: false, workers: new Map() },
      priorWorkers: [],
    };
    const refusal = async (args: Record<string, unknown>) =>
      String(await startRefusal(loopRun as never, "paint", { id: "paint", brief: "finish", ...args }));
    assert.match(await refusal({ stage: "polish" }), /stage: "polish" is not a stage \(build, finish\)/);
    assert.match(await refusal({ stage: "finish", move: "rain slicks the street" }), /contradict/);
    assert.match(
      await refusal({ stage: "finish", milestones: JSON.stringify([{ what: "traffic weaves" }]) }),
      /contradict/,
    );
    // A single session has no loop to read a stage: refused by name, never silently ignored.
    assert.match(await refusal({ stage: "finish", mode: "single" }), /single session/);
    assert.deepEqual(asked, [], "a typo is not a capacity problem: nothing was asked of the machine");
  });

  /**
   * One owner of the screen, so no part draws readouts of its own beside the HUD part's. The part
   * reviewed as a screen owns it; a second one is refused by name.
   */
  it("makes the part reviewed as a screen the screen's one owner, and refuses a second while it runs", async () => {
    const { startRefusal } = await import("../../src/harness-seed/loop/director/workers.ts");
    const start = DIRECTOR_TOOLS.find((t) => t.name === "worker_start")!;
    assert.match(
      String((start.parameters.properties as Record<string, { description?: string }>).critic?.description),
      /screen makes it the one part that draws on the screen/,
      "the director is told where it decides it",
    );
    const hud = compileWorkerSpec({ id: "hud", brief: "the HUD", critic: "screen" } as never, null);
    assert.equal((hud.spec as { ownsScreen?: boolean }).ownsScreen, true);
    const race = compileWorkerSpec({ id: "race", brief: "the race" } as never, null);
    assert.equal("ownsScreen" in race.spec, false, "any other part's spec is what it was");
    const loopRun = {
      ctx: { call: async () => null },
      runningWorkers: () => [{ id: "hud", state: "running", spec: hud.spec }],
      softDeadline: Date.now() + 60 * 60_000,
      state: { finish: false, workers: new Map([["hud", { id: "hud" }]]) },
      priorWorkers: [],
    };
    const refusal = async (id: string, args: Record<string, unknown>) =>
      String(await startRefusal(loopRun as never, id, { id, brief: "x", ...args }));
    assert.match(await refusal("menus", { critic: "screen" }), /"hud" already owns the screen/);
    assert.doesNotMatch(await refusal("race", {}), /owns the screen/, "a part that draws nothing is not refused");
    assert.doesNotMatch(
      await refusal("hud-2", { critic: "screen", replaces: "hud" }),
      /owns the screen/,
      "the owner's own restart takes the screen over",
    );
  });

  it("turns a running worker to finishing with worker_steer stage=, and back to building with a move", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const ladder = [{ id: "rain", what: "rain slicks the street" }];
    const worker = {
      id: "paint",
      title: "Paint",
      state: "running",
      mode: "loop",
      steering: [] as string[],
      spec: { id: "paint", checks: [], milestones: ladder, moveOwner: "director" } as Record<string, unknown>,
    };
    const steered: string[] = [];
    const loopRun = {
      ctx: { cancelled: false },
      toolCalls: 0,
      toolsInFlight: 0,
      run: { runId: "apex" },
      state: { workers: new Map([["paint", worker]]), integrationHead: null, finished: false },
      journal: null,
      saveJournal: async () => {},
      keepMemory: async () => {},
      syncHead: async () => {},
      appendRun: async (_type: string, payload: { text?: string }) => void steered.push(String(payload.text)),
      interruptWorker: async () => false,
    };
    const steer = async (args: Record<string, unknown>) =>
      String(await handler(loopRun as never, "worker_steer", { id: "paint", ...args }));
    assert.match(await steer({}), /worker_steer needs text, move or stage/);
    assert.match(await steer({ stage: "finish" }), /next round finishes/);
    assert.equal(worker.spec.stage, "finish", "the loop holds this spec: its next round reads it");
    assert.match(steered.at(-1)!, /stage: finish/, "the steer is on the record");
    assert.match(await steer({ stage: "polish" }), /stage: "polish" is not a stage/);
    assert.equal(worker.spec.stage, "finish", "a refused steer changes nothing");
    assert.match(await steer({ stage: "finish", move: "traffic weaves in both lanes" }), /contradict/);
    // The director's explicit move always wins: the worker is back in the build stage.
    assert.match(await steer({ move: "traffic weaves in both lanes" }), /THE MOVE/);
    assert.equal(worker.spec.stage, "build");
    assert.match(await steer({ stage: "finish" }), /next round finishes/);
    assert.match(await steer({ stage: "build" }), /next round builds/);
    assert.equal(worker.spec.stage, "build");
    const single = { ...worker, id: "solo", mode: "single", spec: null };
    loopRun.state.workers.set("solo", single as never);
    assert.match(
      String(await handler(loopRun as never, "worker_steer", { id: "solo", stage: "finish" })),
      /single session/,
    );
  });

  it("shows a finishing worker's stage to the lead, and nothing for a building one", () => {
    const worker = (spec: Record<string, unknown> | null) =>
      ({
        id: "paint",
        title: "Paint",
        mode: "loop",
        state: "running",
        startedAt: Date.now(),
        deadline: Date.now() + 60_000,
        iterations: [],
        roundMs: [],
        spec,
        result: null,
        loop: null,
        monitor: null,
        worktree: "/w",
      }) as never;
    assert.equal((workerDigest(worker({ stage: "finish", checks: [] })) as { stage?: string }).stage, "finish");
    assert.equal("stage" in (workerDigest(worker({ checks: [] })) as object), false);
    assert.equal("stage" in (workerDigest(worker(null)) as object), false);
  });

  it("inlines the check grammar in the tool the director actually reads", () => {
    const start = DIRECTOR_TOOLS.find((t) => t.name === "worker_start") as unknown as {
      parameters: { properties: Record<string, { description: string }> };
    };
    const checks = start.parameters.properties.checks!.description;
    for (const kind of ["scene", "pixel", "metric", "probe", "demo", "vision", "play"])
      assert.match(checks, new RegExp(`"kind":"${kind}"`), `the ${kind} shape`);
    // One grammar (M4.8a): the schema no longer keeps a copy of its own, it renders spec.ts's.
    assert.ok(
      checks.includes(renderCheckGrammar({ kinds: CHECK_KINDS, indent: "  ", helpers: false })),
      "the schema renders the one grammar, not a copy of it",
    );
    assert.match(checks, /under `state\.`/, "the state. grammar a probe is written in");
    assert.match(checks, /delta\(path\)/, "and the delta a movement probe is written with");
    assert.match(checks, /fractionAbove\(t\)/);
    assert.match(checks, /unsatisfiable/, "and that they are read against the fork point first");
    const done = start.parameters.properties.done!.description;
    assert.match(done, /2–4/);
    assert.match(done, /"what"/);
    assert.match(done, /"check"/);
    // The ladder is a parameter too, and steering can add a rung to a worker already running.
    assert.match(start.parameters.properties.move!.description, /ONE structural change/);
    assert.match(start.parameters.properties.milestones!.description, /ORDERED structural steps/);
    const steer = DIRECTOR_TOOLS.find((t) => t.name === "worker_steer") as unknown as {
      parameters: { properties: Record<string, { description: string }>; required: string[] };
    };
    assert.match(steer.parameters.properties.move!.description, /THE MOVE of the worker's next iteration/);
    assert.deepEqual(steer.parameters.required, ["id"], "a move on its own is a steer");
  });

  /**
   * And what it costs to start one that cannot finish a round. The loop's gate refuses the first
   * round before it counts as one, so the worker ends with `iterations: 0` — after its worktree,
   * its window and (on an unproven fork point) a whole evidence pass. The session floor of three
   * minutes says nothing about a game whose rounds take twenty.
   */
  it("warns at the start when a worker's budget cannot hold one round of this game", () => {
    const warned = shortBudgetWarning(12 * 60_000, 20 * 60_000);
    assert.match(String(warned), /a round on this game has been taking about 20 min and this worker has 12 —/);
    assert.match(String(warned), /Give it at least 25 min, or finish instead/);
    assert.equal(
      shortBudgetWarning(25 * 60_000, 20 * 60_000),
      null,
      "exactly the headroom the loop asks for is enough",
    );
    assert.equal(shortBudgetWarning(45 * 60_000, 20 * 60_000), null);
    assert.equal(shortBudgetWarning(5 * 60_000, null), null, "a run that has finished no round guesses at nothing");
  });
});

/**
 * The plan the user can read and approve (M3.8). The first real run had none: five workers
 * started at 16:25 on a 900-character decision card and a gitignored file, and in the morning
 * the Builds page showed ten parts, half of them red, with no page saying what the run set
 * out to do. Now a `plan` call comes first, and when the user asked to review it the first
 * worker waits for their word — bounded, and building anyway if nobody answers.
 */
describe("the run's plan, before anyone builds", () => {
  const parts = [
    {
      id: "Plaza Lighting",
      title: "Plaza lighting",
      seam: "the plaza's light",
      owns: "src/plaza.js, src/sky.js",
      done: ["the plaza reads as dusk"],
      minutes: "45",
    },
    { id: "benches", done: "benches you can sit on\nand a bin that falls over" },
  ];

  it("offers the tool before worker_start, and a way to say a restart is the same part", () => {
    const names = DIRECTOR_TOOLS.map((t) => t.name);
    assert.ok(names.includes("plan"), "the plan tool exists");
    assert.ok(names.indexOf("plan") < names.indexOf("worker_start"), "and is offered before the tool it gates");
    const plan = DIRECTOR_TOOLS.find((t) => t.name === "plan")!;
    assert.deepEqual(plan.parameters.required, ["summary", "workers"]);
    const start = DIRECTOR_TOOLS.find((t) => t.name === "worker_start")!;
    assert.ok("replaces" in start.parameters.properties, "a restart can name the part it continues");
  });

  it("compiles what the lead typed into the plan the user reads, and refuses what they could not", () => {
    const compiled = compilePlan({
      summary: "  This run: dusk on the plaza, and something to sit on.  ",
      workers: JSON.stringify(parts),
      base: "the starting point at dusk",
      risks: "the pool is small\nBlender is not installed",
    });
    assert.ok(!("error" in compiled), JSON.stringify(compiled));
    const plan = (compiled as { plan: any }).plan;
    assert.equal(plan.summary, "This run: dusk on the plaza, and something to sit on.");
    assert.deepEqual(
      plan.workers.map((w: any) => w.id),
      ["plaza-lighting", "benches"],
      "the ids are the ones worker_start takes",
    );
    assert.deepEqual(plan.workers[0].owns, ["src/plaza.js", "src/sky.js"]);
    assert.equal(plan.workers[0].minutes, 45);
    assert.deepEqual(
      plan.workers[1].done,
      ["benches you can sit on", "and a bin that falls over"],
      "lines a player could check, however they were typed",
    );
    assert.equal(plan.workers[1].title, "benches", "a part with no title is its own id");
    assert.equal(plan.workers[1].minutes, null);
    assert.deepEqual(plan.risks, ["the pool is small", "Blender is not installed"]);

    assert.match(
      (compilePlan({ workers: JSON.stringify(parts) }) as unknown as { error: string }).error,
      /summary is what this run is for/,
    );
    assert.match((compilePlan({ summary: "s" }) as unknown as { error: string }).error, /workers is a JSON array/);
    assert.match((compilePlan({ summary: "s", workers: "[{]" }) as unknown as { error: string }).error, /not JSON/);
    assert.match(
      (compilePlan({ summary: "s", workers: JSON.stringify([{ title: "no id" }]) }) as unknown as { error: string })
        .error,
      /every part needs the id/,
    );
    assert.match(
      (
        compilePlan({ summary: "s", workers: JSON.stringify([{ id: "a" }, { id: "a" }]) }) as unknown as {
          error: string;
        }
      ).error,
      /two parts called "a"/,
    );
    assert.match(
      (
        compilePlan({
          summary: "s",
          workers: JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ id: `w${i}` }))),
        }) as unknown as { error: string }
      ).error,
      /at most 12/,
    );
  });

  /**
   * The plan says what it leaves out and what it builds beyond the ask, so a part the lead invents
   * is never frozen as required acceptance without the user being asked about it.
   */
  it("names what the plan cuts and what it added beyond the ask: cuts join the scope, each addition is one card for the user, and never scope without their own words", async () => {
    const { setPlan } = await import("../../src/harness-seed/loop/director/workers.ts");
    const { createScope } = await import("../../src/harness-seed/loop/scope.ts");
    const workers = JSON.stringify([
      { id: "race", done: ["four rivals race one lap"] },
      { id: "pursuit", done: ["a pursuit meter fills"], added: true },
    ]);
    const args = {
      summary: "One race against four rivals.",
      workers,
      cut: "police\ntraffic",
      added: '["a pursuit meter"]',
    };
    const compiled = compilePlan(args) as { plan: any };
    assert.deepEqual(compiled.plan.cut, ["police", "traffic"]);
    assert.deepEqual(compiled.plan.added, ["a pursuit meter"]);
    assert.equal(compiled.plan.workers[1].added, true, "a part beyond the ask says so");
    assert.equal("added" in compiled.plan.workers[0], false);
    const bare = (compilePlan({ summary: "s", workers }) as { plan: any }).plan;
    assert.equal("cut" in bare || "added" in bare, false, "a plan that names neither is what it was");

    const said = "yes, keep the pursuit meter";
    const decisions: Array<[string, string | undefined]> = [];
    const notes: string[] = [];
    const loopRun = (budgets: Record<string, unknown> = {}, steers: string[] = []) => {
      const run = {
        runId: "apex",
        project: "apex",
        goal: "a street race",
        budgets,
        scope: createScope({ asked: ["a street race"], inScope: ["one race"], cut: ["open world"] }),
      };
      return {
        run,
        steers,
        ctx: { call: async () => null },
        resume: false,
        waking: false,
        softDeadline: Date.now() + 60 * 60_000,
        state: { plan: null, goals: undefined, planReviewUntil: null, planSaidFrom: 0, planGo: false } as any,
        journal: { director: {}, plan: {}, run: { ...run } } as any,
        saveJournal: async () => {},
        note: (text: string) => void notes.push(text),
        appendRun: async () => {},
        decision: async (text: string, plain?: string) => void decisions.push([text, plain]),
        // The user's steers so far, as the inbox reads them at each call: later ones arrive later.
        inbox: { steering: async () => [...steers] },
      };
    };
    const lead = loopRun();
    await setPlan(lead as never, { ...args, cut: "police\ntraffic\none race" });
    assert.equal(decisions.length, 1, `one card per addition: ${JSON.stringify(decisions)}`);
    assert.match(String(decisions[0]![1]), /a pursuit meter/);
    assert.deepEqual(lead.run.scope.cut, ["open world", "police", "traffic"], "cuts only grow");
    assert.deepEqual(lead.run.scope.inScope, ["one race"], "and never cut what the user asked for");
    assert.ok(
      notes.some((text) => text.includes("one race")),
      `the lead hears which cut was not taken: ${notes.join(" | ")}`,
    );
    assert.deepEqual(lead.run.scope.added, ["a pursuit meter"], "waiting for the user's yes");
    assert.ok(!lead.run.scope.inScope.includes("a pursuit meter"), "and not in scope by itself");
    assert.deepEqual(lead.journal.run.scope, lead.run.scope, "the journal keeps it for a Resume");
    await setPlan(lead as never, args);
    assert.equal(decisions.length, 1, "a replan naming the same addition posts nothing new");
    await setPlan(lead as never, { ...args, added: '["a helicopter"]', scope_instruction: "the user wants one" });
    assert.ok(!lead.run.scope.inScope.includes("a helicopter"), "a steer the user never wrote widens nothing");
    assert.equal(decisions.length, 2);
    // The user answers the card.
    lead.steers.push(said);
    await setPlan(lead as never, { ...args, scope_instruction: said });
    assert.ok(lead.run.scope.inScope.includes("a pursuit meter"), "their own words, quoted, widen it");
    assert.ok(!lead.run.scope.added.includes("a pursuit meter"));
    assert.equal(decisions.length, 2);

    const goal = loopRun({ completionPolicy: "goal" });
    await setPlan(goal as never, args);
    assert.deepEqual(
      goal.state.goals.entries.map((entry: { id: string; required: boolean }) => [entry.id, entry.required]),
      [
        ["race", true],
        ["pursuit", false],
      ],
      "an added part is an optional goal: it never holds the finish",
    );

    // Review of WP-SCOPE-2: a steer the user sent before the card asked them anything (here,
    // about the cars) is quoted to revise acceptance; it never says yes to the pursuit meter.
    const earlier = loopRun({ completionPolicy: "goal" }, ["make the cars faster"]);
    await setPlan(earlier as never, args);
    const revised = await setPlan(earlier as never, { ...args, scope_instruction: "make the cars faster" });
    assert.doesNotMatch(String(revised), /Scope revision needs/, "the steer revises acceptance, as it may");
    assert.ok(
      !earlier.run.scope.inScope.includes("a pursuit meter"),
      "an answer to nothing the card asked widens nothing",
    );
    assert.deepEqual(earlier.run.scope.added, ["a pursuit meter"], "it still waits for the user");

    // A goal-mode plan whose every part is beyond the ask would leave no goal that can pass.
    const nothingAsked = loopRun({ completionPolicy: "goal" });
    const refused = await setPlan(nothingAsked as never, {
      ...args,
      workers: JSON.stringify([{ id: "pursuit", done: ["a pursuit meter fills"], added: true }]),
    });
    assert.match(String(refused), /at least one part must be what the user asked for/);
    assert.equal(nothingAsked.state.plan, null, "and is not taken");
  });

  /**
   * Review SR-5: a card's place among the user's steers was a count of the steers its run's inbox
   * held. A reopened build hears the user only from its ask on, so a yes sent after the reopen sat
   * at an index below that count and never answered a card the finished build had posted.
   */
  it("SR-5. a yes the user sends after a reopen answers an addition the finished build asked about", async () => {
    const { setPlan } = await import("../../src/harness-seed/loop/director/workers.ts");
    const { createRunInbox } = await import("../../src/harness-seed/loop/run-inbox.ts");
    const { createScope } = await import("../../src/harness-seed/loop/scope.ts");
    const { HostMethod } = await import("../../src/harness-seed/loop/host-methods.ts");
    const { EventKind, RunEvent } = await import("../../src/harness-seed/loop/run-events.ts");
    const args = {
      summary: "One race against four rivals.",
      workers: JSON.stringify([
        { id: "race", done: ["four rivals race one lap"] },
        { id: "pursuit", done: ["a pursuit meter fills"], added: true },
      ]),
      added: '["a pursuit meter"]',
    };
    const log: any[] = [];
    const steer = (id: string, text: string, sentMs: number) =>
      log.push({
        id,
        created_at: new Date(sentMs).toISOString(),
        data: { type: EventKind.Custom, event_type: RunEvent.RunSteering, payload: { runId: "apex", text } },
      });
    const ctx = {
      threadId: "t",
      call: async (method: string, params: { after?: string }) => {
        if (method !== HostMethod.EventsList) return null;
        const from = params.after ? log.findIndex((event) => event.id === params.after) + 1 : 0;
        return log.slice(from);
      },
    };
    const decisions: string[] = [];
    const run = {
      runId: "apex",
      project: "apex",
      goal: "a street race",
      budgets: {},
      scope: createScope({ asked: ["a street race"], inScope: ["one race"] }),
    };
    const loopRunOn = (after: string | null, plan: any) => ({
      run,
      ctx,
      resume: after !== null,
      waking: false,
      softDeadline: Date.now() + 60 * 60_000,
      state: { plan, goals: undefined, planReviewUntil: null, planSaidFrom: 0, planGo: false } as any,
      journal: { director: {}, plan: {}, run: { ...run } } as any,
      saveJournal: async () => {},
      note: () => {},
      appendRun: async () => {},
      decision: async (text: string) => void decisions.push(text),
      inbox: createRunInbox(ctx as never, { threadId: "t", runId: "apex", after }),
    });
    // The finished build: two steers about the cars, then its plan's card about the pursuit meter.
    steer("s1", "make the cars faster", Date.now() - 120_000);
    steer("s2", "and louder", Date.now() - 60_000);
    const finished = loopRunOn(null, null);
    await setPlan(finished as never, args);
    assert.equal(decisions.length, 1, "the finished build asked about the pursuit meter");

    // Reopened: its inbox reads from the reopening ask on; the plan, and the card it asked, go on.
    log.push({ id: "ask", created_at: new Date().toISOString(), data: { type: EventKind.Custom } });
    const said = "yes, keep the pursuit meter";
    steer("s3", said, Date.now() + 1_000);
    const reopened = loopRunOn("ask", finished.state.plan);
    await setPlan(reopened as never, { ...args, scope_instruction: said });
    assert.ok(run.scope.inScope.includes("a pursuit meter"), "the user's yes after the reopen widens the scope");
    assert.equal(decisions.length, 1, "and nothing is asked twice");
  });

  it("takes what kind of game this is on the plan, and refuses a kind that is not one", () => {
    const one = JSON.stringify([{ id: "board" }]);
    const board = (
      compilePlan({ summary: "a chess board that reads", workers: one, kind: "static-board" }) as { plan: any }
    ).plan;
    assert.deepEqual(
      board.game,
      { kind: "static-board", hud: false, mouseLook: false, keyboardMove: false, playScript: null },
      "a declared kind brings its own traits and nothing else",
    );

    const scripted = (
      compilePlan({
        summary: "a builder you pan around",
        workers: one,
        kind: "free-camera",
        play_script: JSON.stringify([{ type: "drag", fromX: 100, fromY: 100, x: 300, y: 200 }]),
      }) as { plan: any }
    ).plan;
    assert.equal(scripted.game.kind, "free-camera");
    assert.equal(
      scripted.game.playScript.length,
      1,
      "the play script arrives as a JSON string and lands as one normalized action",
    );
    assert.equal(scripted.game.playScript[0].type, "drag");

    assert.equal(
      (compilePlan({ summary: "s", workers: one }) as { plan: any }).plan.game,
      null,
      "a plan that declares nothing declares nothing",
    );

    const refused = (compilePlan({ summary: "s", workers: one, kind: "fps" }) as unknown as { error: string }).error;
    assert.match(refused, /is not a kind/);
    for (const name of KIND_NAMES) assert.ok(refused.includes(name), `the refusal names ${name}`);
    assert.match(
      (compilePlan({ summary: "s", workers: one, play_script: "[{" }) as unknown as { error: string }).error,
      /play_script not JSON/,
    );
  });

  it("names the eight kinds where both engines read them, not only in a schema a bridge drops", () => {
    const brief = directorBrief({
      run: { runId: "run_k", project: "g", goal: "a plaza" },
      softDeadline: Date.now() + 3_600_000,
      finalDeadline: Date.now() + 7_200_000,
      integrationWorktree: "/w",
      baseCommit: null,
    } as never);
    const rules = brief.slice(brief.indexOf("RULES THAT NEVER MOVE:"));
    for (const name of KIND_NAMES) assert.ok(rules.includes(name), `the RULES a Codex director reads name ${name}`);
  });

  it("waits for the user only when they asked, never past the window, never into the time a worker needs", () => {
    assert.equal(planReviewWaitMs({ reviewPlan: false, sessionMsLeft: 8 * 3_600_000 }), 0, "nobody asked to read it");
    assert.equal(
      planReviewWaitMs({ reviewPlan: true, resume: true, sessionMsLeft: 8 * 3_600_000 }),
      0,
      "a resumed run was reviewed the first time",
    );
    assert.equal(
      planReviewWaitMs({ reviewPlan: true, sessionMsLeft: 8 * 3_600_000 }),
      PLAN_REVIEW_WAIT_MS,
      "the whole window on a long run",
    );
    assert.equal(
      planReviewWaitMs({ reviewPlan: true, sessionMsLeft: 10 * 60_000 }),
      7 * 60_000,
      "never into the three minutes a worker is worth",
    );
    assert.equal(planReviewWaitMs({ reviewPlan: true, sessionMsLeft: 2 * 60_000 }), 0, "and never negative");
  });

  it("ends the hold on the user's word, on anything else they say, on the call's own slice and on the window", async () => {
    // A clock the test moves: the window and the slice are minutes long, and no test may be.
    const rig = (said: string[][], windowMs = 15 * 60_000, step = 30_000) => {
      let clock = 1_000_000;
      const reads: string[][] = [...said];
      return {
        now: () => clock,
        sleep: async () => {
          clock += step;
        },
        read: async () => reads.shift() ?? [],
        until: clock + windowMs,
      };
    };
    const go = rig([[], [], ["go ahead, that is the run"]]);
    assert.deepEqual(
      await waitForPlanGo({ until: go.until, read: go.read, sleep: go.sleep, now: go.now }),
      { go: true, said: ["go ahead, that is the run"], reason: "go" },
      "the same one word the programmed pipeline's review has always taken",
    );

    const answered = rig([[], ["make the benches oak"]]);
    const said = await waitForPlanGo({
      until: answered.until,
      read: answered.read,
      sleep: answered.sleep,
      now: answered.now,
    });
    assert.deepEqual(
      said,
      { go: false, said: ["make the benches oak"], reason: "answered" },
      "their words outrank the plan; the lead gets them",
    );

    // Nobody answers: the call gives up its slice long before the window, and the window itself
    // is the auto-proceed — an unanswered run still builds.
    const quiet = rig([]);
    const sliced = await waitForPlanGo({
      until: quiet.until,
      sliceMs: 2 * 60_000,
      read: quiet.read,
      sleep: quiet.sleep,
      now: quiet.now,
    });
    assert.equal(sliced.reason, "slice", JSON.stringify(sliced));
    const overrun = rig([], 60_000);
    assert.equal(
      (await waitForPlanGo({ until: overrun.until, read: overrun.read, sleep: overrun.sleep, now: overrun.now }))
        .reason,
      "window",
      "a window shorter than the call's slice runs out inside it",
    );
    const stopped = rig([]);
    assert.equal(
      (
        await waitForPlanGo({
          until: stopped.until,
          read: stopped.read,
          sleep: stopped.sleep,
          now: stopped.now,
          stopped: async () => true,
        })
      ).reason,
      "stopped",
    );
  });

  it("clamps its own memory to a size a session can afford, on a line boundary, without accumulating banners", () => {
    const short = "# the run\nlooked at the plaza\ncommitted abc123";
    assert.equal(clampDirectorMemory(short), short, "a memory that fits comes back byte for byte");

    const long = Array.from({ length: 4_000 }, (_, i) => `line ${i}: what the director saw and decided`).join("\n");
    const clamped = clampDirectorMemory(long);
    assert.ok(clamped.length <= MAX_DIRECTOR_MEMORY, `${clamped.length} <= ${MAX_DIRECTOR_MEMORY}`);
    assert.ok(clamped.startsWith("line 0:"), "the head is what the run set out to do");
    assert.ok(
      clamped.trimEnd().endsWith("line 3999: what the director saw and decided"),
      "the tail is where it actually is",
    );
    for (const line of clamped.split("\n")) {
      if (line.includes("dropped by the studio")) continue;
      assert.match(line, /^line \d+: what the director saw and decided$/, "cut on a line boundary, never mid-sentence");
    }
    const banner = clamped.split("\n").filter((l) => l.includes("dropped by the studio"));
    assert.equal(banner.length, 1, "one banner");
    assert.match(banner[0], /\d+ characters of older notes dropped/, "and it says how much went");

    // The clamp runs on the way out (the artifact) and again on the way in (the restore); a
    // run resumed four times must not stack four banners.
    let again = clamped;
    for (let i = 0; i < 4; i += 1) again = clampDirectorMemory(again);
    assert.equal(again, clamped, "clamping a clamped memory changes nothing");
    assert.equal(again.split("\n").filter((l) => l.includes("dropped by the studio")).length, 1);

    // The head is roughly a third of the budget: the tail is where the run is now.
    const head = clamped.slice(0, clamped.indexOf("dropped by the studio"));
    assert.ok(head.length < clamped.length * 0.5, `head ${head.length} of ${clamped.length}`);

    // A 40 KB paragraph with no line breaks has no boundary to cut on: the head, not nothing.
    const paragraph = "x".repeat(MAX_DIRECTOR_MEMORY * 2);
    assert.ok(clampDirectorMemory(paragraph).length <= MAX_DIRECTOR_MEMORY);
    assert.ok(clampDirectorMemory(paragraph).startsWith("xxx"));
    assert.equal(clampDirectorMemory(null), "");
  });

  /**
   * The clamp is a size, not an event: it keeps clamping for as long as the file is over the
   * ceiling, and `keepMemory` runs at the top of EVERY director tool call. Said before the
   * "nothing changed" guard, its note went into the log on every call for the rest of the
   * run — and the log is capped at 400 entries, so within a couple of hundred calls it was
   * the only thing in the log the director's own `wait` reads back.
   */
  it("says the memory was clamped once per change, not once per tool call", () => {
    const long = Array.from({ length: 4_000 }, (_, i) => `line ${i}: what the director saw`).join("\n");
    const first = directorMemoryKeep(long, null);
    assert.equal(first.changed, true);
    assert.equal(first.text, clampDirectorMemory(long));
    assert.match(first.note!, /the director's memory was \d+ characters — kept \d+ \(head and tail\)/);
    // The same oversized file, on the next hundred tool calls: nothing new to keep, nothing said.
    for (let i = 0; i < 100; i += 1) {
      const again = directorMemoryKeep(long, first.text);
      assert.equal(again.changed, false, "the artifact is already what the file says");
      assert.equal(again.note, null, "and the clamp is not news a second time");
    }
    // A memory that grew since: kept again, and said again — once.
    const grown = `${long}\nline 4000: and then the sky went wrong`;
    const next = directorMemoryKeep(grown, first.text);
    assert.equal(next.changed, true);
    assert.ok(next.note, "a new clamp of a changed file is worth one line");
    assert.equal(directorMemoryKeep(grown, next.text).note, null);
    // A memory under the ceiling is kept whole and says nothing at all.
    const short = "# the run\nlooked at the plaza";
    const small = directorMemoryKeep(short, null);
    assert.equal(small.text, short);
    assert.equal(small.changed, true);
    assert.equal(small.note, null);
    assert.equal(directorMemoryKeep(short, short).changed, false);
  });

  it("keeps the brief itself bounded, so what grows is the playbook and not the boilerplate", () => {
    const now = Date.now();
    const skill = "# playbook\n" + "a rule the architect wrote\n".repeat(400);
    const brief = directorBrief({
      run: { runId: "run_b", project: "skate", goal: "refine the plaza", engine: "claude-code" },
      shape: { entry: "index.html", main: "src/main.js", build: null },
      ownShape: false,
      capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
      skill,
      softDeadline: now + 3_600_000,
      finalDeadline: now + 7_200_000,
      integrationWorktree: "/w",
      baseCommit: "abcdef1234567890",
    } as never);
    // Bounded on the brief MINUS the workspace's own playbook: skills/director.md is a file
    // SkillOpt and the architect grow on purpose, and holding the sum would hold them back. Genex's
    // identity, which every brief opens with, is not the director's boilerplate either.
    const identity = appIdentity({ folderLabel: "skate", facts: [{ id: CoreFact.WebGame, path: "." }] });
    assert.ok(brief.includes(identity), "the brief opens with Genex's identity");
    const own = brief.length - skill.length - identity.length;
    assert.ok(own < 5_000, `the brief's own words are ${own} characters`);
    assert.ok(brief.includes(skill.trim()), "and the playbook itself is carried whole");
    assert.match(brief, new RegExp(`under ${MAX_DIRECTOR_MEMORY} characters`), "the memory clause names the clamp");
  });

  it("tells the director in its brief that the plan comes first, and says so louder when the user is waiting", () => {
    const now = Date.now();
    const args = {
      shape: null,
      ownShape: false,
      capacity: null,
      skill: "",
      softDeadline: now + 60 * 60_000,
      finalDeadline: now + 70 * 60_000,
      integrationWorktree: "/w",
      baseCommit: "abc1234567",
    };
    const plain = directorBrief({ run: { runId: "run_p", project: "g", goal: "a plaza" }, ...args } as never);
    assert.match(plain, /Then say the plan/);
    assert.match(plain, /worker_start refuses until you have called it/);
    assert.doesNotMatch(plain, /THE USER ASKED TO READ IT FIRST/);
    const reviewed = directorBrief({
      run: { runId: "run_p", project: "g", goal: "a plaza", reviewPlan: true },
      ...args,
    } as never);
    assert.match(reviewed, /THE USER ASKED TO READ IT FIRST: your first worker_start waits for their word/);
  });
});

/**
 * The worker monitor and cross-worker defect routing (M3.5). Both are the same complaint from
 * the first real run: nothing between "worker started" and "iteration done" ever reached the
 * director, and every defect a judge named landed on whichever worker happened to be judged.
 */
describe("the studio's own look at a running worker, and whose defect it is", () => {
  const spec = {
    id: "plaza",
    title: "Plaza",
    intent: "the plaza",
    owns: ["src/plaza.js"],
    identity: ["red benches"],
    cameras: ["default"],
    checks: [],
  };

  it("looks at a worker fifteen times over its budget, at most three minutes apart", () => {
    assert.equal(monitorEveryMs(45 * 60_000), MONITOR_TICK_MS, "a long worker is looked at every three minutes");
    assert.equal(monitorEveryMs(4 * 60 * 60_000), MONITOR_TICK_MS, "and never less often, whatever its budget");
    assert.equal(
      monitorEveryMs(15 * 60_000),
      60_000,
      "a short worker is looked at oftener — its whole life is shorter",
    );
    assert.equal(monitorEveryMs(60_000), 10_000, "but never more often than every ten seconds");
  });

  it("sees a new file outside the worker's own files, which `git diff` alone cannot", () => {
    // `git status --porcelain`: the builder's own module, its notes, its brief — and one file
    // that is another worker's. Only the last is a violation, and it is untracked, so the diff
    // does not carry it at all.
    const status = " M src/plaza.js\n?? src/sky.js\n?? docs/notes/NOTES.plaza.md\n?? .studio/BRIEF.md\n";
    const found = monitorFindings({ status, diff: "", spec, ownsMain: false, main: "src/main.js" });
    assert.deepEqual(found.files, [".studio/BRIEF.md", "docs/notes/NOTES.plaza.md", "src/plaza.js", "src/sky.js"]);
    assert.deepEqual(found.violations, ["edited a file outside this facet's ownership (src/sky.js)"]);
    // The reviewer's own findings ride along, and a file named by both is said once.
    const diff =
      "+++ b/src/plaza.js\n@@ -1,0 +1,1 @@\n+const jitter = Math.random();\n+++ b/src/sky.js\n@@ -1,0 +1,1 @@\n+export const sky = 1;\n";
    const both = monitorFindings({ status, diff, spec, ownsMain: false, main: "src/main.js" });
    assert.equal(both.violations.filter((v) => v.includes("src/sky.js")).length, 1, JSON.stringify(both.violations));
    assert.ok(
      both.violations.some((v) => /Math\.random/.test(v)),
      JSON.stringify(both.violations),
    );
    // Its own files, its notes and the studio's folder are nobody's business.
    assert.deepEqual(
      monitorFindings({ status: " M src/plaza.js\n?? docs/notes/NOTES.plaza.md\n", diff: "", spec, ownsMain: false })
        .violations,
      [],
    );
  });

  it("M4.6: in a game the user brought, the look reports the seam and nothing about the template's rules", () => {
    const own = {
      id: "hud",
      title: "HUD",
      intent: "the hud",
      owns: ["app/hud.ts"],
      identity: [],
      cameras: ["default"],
      checks: [],
    };
    const status = " M app/hud.ts\n?? app/other.ts\n";
    const diff = "+++ b/app/hud.ts\n@@ -1,0 +1,1 @@\n+const jitter = Math.random();\n";
    const onTemplate = monitorFindings({ status, diff, spec: own, ownsMain: false, main: "src/main.ts" });
    assert.equal(onTemplate.violations.length, 2, JSON.stringify(onTemplate.violations));
    const ownGame = monitorFindings({ status, diff, spec: own, ownsMain: false, main: "src/main.ts", template: false });
    assert.deepEqual(
      ownGame.violations,
      ["edited a file outside this facet's ownership (app/other.ts)"],
      "the game's own randomness is the game",
    );
    assert.deepEqual(ownGame.files, ["app/hud.ts", "app/other.ts"]);
  });

  it("M4.6: the seam a director types is a path, a folder or a glob — and a glob has to be quoted", () => {
    const start = DIRECTOR_TOOLS.find((t) => t.name === "worker_start") as unknown as {
      parameters: { properties: Record<string, { description: string }> };
    };
    const owns = start.parameters.properties.owns!.description;
    assert.match(owns, /\*\* crosses them/, "the glob syntax is declared where the director reads it");
    assert.match(owns, /must be QUOTED/, "and an unquoted glob is a zsh command line on Codex");
    assert.match(
      owns,
      /everything but the entry, the contract and index\.html/,
      "what an empty seam means in a game of its own",
    );
  });

  it("says something only when what it sees has changed — every note costs the director a turn", () => {
    const look = (over: Record<string, unknown>) => ({
      id: "plaza",
      round: 1,
      minutesInRound: 4,
      files: ["src/plaza.js"],
      violations: [],
      ...over,
    });
    const first = monitorNote(
      null,
      look({ violations: ["edited a file outside this facet's ownership (src/sky.js)"] }),
    )!;
    assert.match(
      first.text,
      /^worker plaza: 4 min into round 1 — edited a file outside this facet's ownership \(src\/sky\.js\)/,
    );
    assert.match(first.text, /touched src\/plaza\.js/);
    // The same violation twenty minutes later is not news; a second one is.
    const before = { violations: ["edited a file outside this facet's ownership (src/sky.js)"], silentSaid: false };
    assert.equal(monitorNote(before, look({ minutesInRound: 20, violations: before.violations })), null);
    assert.match(
      monitorNote(
        before,
        look({
          minutesInRound: 20,
          violations: [...before.violations, "Math.random() in game code — two builds cannot be compared on one seed"],
        }),
      )!.text,
      /^worker plaza: 20 min into round 1 — Math\.random/,
    );
    assert.match(
      monitorNote(before, look({ minutesInRound: 20, violations: [] }))!.text,
      /the contract violations it had are gone/,
    );
    // A round that has written nothing at all: said once, then left alone.
    assert.equal(
      monitorNote(null, look({ minutesInRound: 8, files: [] })),
      null,
      "a quarter of an hour is a stall; eight minutes is a build",
    );
    const stalled = monitorNote(null, look({ minutesInRound: 14, files: [] }))!;
    assert.match(stalled.text, /worker plaza: 14 min into round 1 and nothing written yet/);
    assert.equal(stalled.silent, true);
    assert.equal(monitorNote({ violations: [], silentSaid: true }, look({ minutesInRound: 22, files: [] })), null);
  });

  it("hands a defect to the worker whose files it is in, with a line saying where it came from", () => {
    const specs = () => ({
      village: {
        id: "village",
        title: "Village",
        intent: "houses",
        owns: ["src/village.js"],
        identity: ["houses"],
        cameras: ["default", "camVillage"],
        checks: [{ id: "houses", kind: "scene", js: "count('house') > 3" }],
      },
      water: {
        id: "water",
        title: "Water",
        intent: "the bay",
        owns: ["src/water.js"],
        identity: ["bay water", "reflection"],
        cameras: ["default", "camDock"],
        checks: [{ id: "bay", kind: "scene", js: "count('water') > 0" }],
      },
    });
    const milky = "the bay's water reflection band is milky at the dock — camDock";
    const worker = (spec_: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
      id: spec_.id,
      mode: "loop",
      state: "running",
      spec: spec_,
      steering: [] as string[],
      ...over,
    });
    const { village, water } = specs();
    const workers = new Map<string, any>([
      ["village", worker(village)],
      ["water", worker(water)],
    ]);
    const ledger: Array<{ text: string; from: string; owner: string }> = [];
    const notes: string[] = [];
    const route = makeRouteDefect({
      workers,
      from: "village",
      ledger,
      note: (t: string) => notes.push(t),
    } as never) as (id: string, check: Record<string, unknown>) => boolean;

    // The judge, looking at the village, names the bay's milky reflection: water's seam.
    const grown = defectsToChecks(village as never, [milky, "the house roofs are flat boxes — camVillage"], {
      iteration: 3,
      facets: [village, water] as never,
      routeDefect: route as never,
    } as never) as Array<{ defect: string }>;
    assert.deepEqual(
      grown.map((g) => g.defect),
      ["the house roofs are flat boxes — camVillage"],
      "the village keeps only its own",
    );
    const landed = water.checks.filter((c) => (c as { origin?: string }).origin === "judge") as unknown as Array<{
      id: string;
      defect: string;
      camera: string;
    }>;
    assert.equal(landed.length, 1, JSON.stringify(water.checks));
    assert.match(landed[0]!.defect, /milky at the dock/);
    assert.ok(water.cameras.includes("camDock"));
    assert.equal(workers.get("water").steering.length, 1);
    assert.match(workers.get("water").steering[0], /A judge saw this while judging village.*it is in your files/s);
    assert.ok(
      notes.some((n) => /^worker water: a defect named while judging village is on its board/.test(n)),
      notes.join(" | "),
    );
    // The same defect again is not a second question on that board.
    assert.equal(route("water", { id: landed[0]!.id, defect: landed[0]!.defect } as never), true);
    assert.equal(water.checks.filter((c) => (c as { origin?: string }).origin === "judge").length, 1);
    // The answer is the contract: the facet loop emits `facet_defect_routed` on anything but false.
    assert.equal(
      route("water", {
        id: "defect-planks",
        defect: "the dock planks float above the bay water",
        camera: "camDock",
      } as never),
      true,
    );
    assert.equal(water.checks.at(-1)!.id, "defect-planks");

    // Nobody can hand themselves their own defect, and a worker that does not exist takes none.
    assert.equal(route("village", { id: "x", defect: "the roofs are flat" }), false, "a worker cannot route to itself");
    assert.equal(route("nobody", { id: "x", defect: "the roofs are flat" }), false);
    assert.equal(ledger.length, 0);

    // The owner has finished: the defect is not dropped and it is not grown on the wrong board —
    // it goes on the run's ledger, for the director's next integration.
    const over = specs();
    const done = new Map<string, any>([
      ["village", worker(over.village)],
      ["water", worker(over.water, { state: "done" })],
    ]);
    const shelved: Array<{ text: string; from: string; owner: string }> = [];
    const saidThen: string[] = [];
    const afterRoute = makeRouteDefect({
      workers: done,
      from: "village",
      ledger: shelved,
      note: (t: string) => saidThen.push(t),
    } as never) as (id: string, check: Record<string, unknown>) => boolean;
    const after = defectsToChecks(over.village as never, [milky], {
      iteration: 4,
      facets: [over.village, over.water] as never,
      routeDefect: afterRoute as never,
    } as never) as unknown[];
    assert.deepEqual(after, [], "not grown on the village that was only judged for it");
    assert.deepEqual(
      over.water.checks.map((c) => c.id),
      ["bay"],
      "and not on the finished worker's board, which nobody will build again",
    );
    assert.equal(shelved.length, 1, JSON.stringify(shelved));
    assert.equal(shelved[0]!.owner, "water");
    assert.equal(shelved[0]!.from, "village");
    assert.match(shelved[0]!.text, /milky/);
    assert.ok(
      saidThen.some((n) =>
        /^worker village: a defect the judge named is worker water's \(done\).*ledger for your next integration/.test(
          n,
        ),
      ),
      saidThen.join(" | "),
    );
  });

  it("answers a wait with a line per worker, not the run's whole status blob", () => {
    const now = Date.now();
    // Five workers, the shape of the recorded run: boards, moves, worktrees, a monitor look.
    const workers = ["contact", "crumple", "cars", "dirt", "post"].map((id, i) => ({
      id,
      title: `${id} — ${id} pass`,
      mode: "loop",
      state: "running",
      startedAt: now - 30 * 60_000,
      endedAt: null,
      deadline: now + 15 * 60_000,
      worktree: `/Users/owner/Library/Application Support/AI Game Studio/scratch/autopilot/run_fixture123456/${id}`,
      lastCommit: `0123456789abcdef0123456789abcdef0123${i}`,
      iterations: [
        {
          iteration: 1,
          won: true,
          stopped: false,
          scoreboard: { total: 9, passing: 3, unmeasured: 4, flips: ["speed-kept"], regressions: [], results: [] },
          move: {
            what: `a ${id} the player can feel through the wheel and the camera`,
            source: "planner",
            mandatory: false,
            delivered: false,
            note: `the move was not delivered, and it did not cost the round: a ${id}`,
          },
        },
      ],
      monitor: {
        minutesInRound: 12,
        files: ["src/main.js", `src/${id}.js`],
        violations: [`edited a file outside this facet's ownership (src/props.js)`],
        look: "screenshot",
      },
      steering: [],
      spec: { id, checks: [] },
      result: null,
      stopWhy: null,
      error: null,
    }));
    const full = JSON.stringify(workers.map((w) => workerDigest(w as never, now)));
    const lines = JSON.stringify(workers.map((w) => waitDigest(w as never, now)));
    assert.ok(
      lines.length * 2 < full.length,
      `a wait line is less than half a status digest: ${lines.length} vs ${full.length}`,
    );
    const line = waitDigest(workers[0] as never, now) as Record<string, unknown>;
    // What a waiting director needs is still all there: how it is doing, and what it is doing.
    assert.deepEqual(
      { ...line, violations: undefined },
      {
        id: "contact",
        state: "running",
        minutesLeft: 15,
        round: 2,
        accepted: 1,
        passing: "3/9",
        minutesInRound: 12,
        filesChanged: 2,
        lastLook: "screenshot",
        violations: undefined,
      },
    );
    assert.ok(!lines.includes("/Users/owner"), "no worktree paths");
    assert.ok(!lines.includes("run_fixture123456"), "no run ids");
    // A worker that is over says why, once, and nothing else.
    const done = waitDigest(
      {
        ...workers[1],
        state: "stopped",
        monitor: null,
        iterations: [],
        result: { stoppedBecause: "stopped by the director: the run is wrapping up" },
      } as never,
      now,
    );
    assert.deepEqual(done, {
      id: "crumple",
      state: "stopped",
      accepted: 0,
      stoppedBecause: "stopped by the director: the run is wrapping up",
    });
  });

  /**
   * What a round on this game costs (M3.4). Every worker used to be sized on the assumption
   * that a round takes eight minutes; the rounds of the first real run took nine to
   * forty-six, so a worker given forty minutes got one round and the next one's second round
   * was cut in half. The director now reads the measurement instead of the assumption.
   */
  it("reports how long a round has taken, so the next worker is sized from data and not from eight minutes", () => {
    const min = (n: number) => n * 60_000;
    assert.equal(medianMinutes([]), null, "nothing measured, nothing claimed");
    assert.equal(medianMinutes([min(9), min(46), min(20)]), 20);
    assert.equal(medianMinutes([0, -1, Number.NaN]), null, "only what was really measured counts");
    const worker = {
      id: "post",
      title: "Post",
      mode: "loop",
      state: "running",
      startedAt: Date.now() - min(60),
      endedAt: null,
      deadline: Date.now() + min(10),
      iterations: [],
      roundMs: [min(19), min(21), min(20)],
      lastCommit: null,
      result: null,
      monitor: null,
      stopWhy: null,
      error: null,
      worktree: "/scratch/post",
    };
    assert.equal(workerDigest(worker as never).iterationMinutes, 20);
    assert.ok(
      !("iterationMinutes" in workerDigest({ ...worker, roundMs: [] } as never)),
      "a worker with no finished round says nothing about its rounds",
    );
  });

  /**
   * The windows a run may hand out (M3.7). Two of the pool's are the director's — the one its
   * own session looks through and the one every judge, health and close pass leases for a moment
   * — because the first real run gave five of six to workers, took the sixth for itself, and
   * then ran every one of its health passes on the user's own live window.
   */
  it("keeps two windows out of the workers' share, and still runs one builder in a pool of two", () => {
    assert.equal(workerWindows(0), 0, "no pooled windows, no workers");
    assert.equal(workerWindows(2), 1, "a small pool still builds — the director shares its own window, out loud");
    assert.equal(workerWindows(3), 1);
    assert.equal(workerWindows(6), 4, "not five: the sixth was the director's, and the judges had none");
    assert.equal(workerWindows(12), 10);
    assert.equal(workerWindows(Number.NaN), 0);
    assert.ok(
      WINDOW_RETRIES_MS.reduce((total: number, wait: number) => total + wait, 0) <= 10_000,
      "a pass asks again for a few seconds, it does not queue behind a round",
    );
  });
});

/**
 * The loop the director can see (M4.10). A director hands out workers and then goes blind to
 * the machinery deciding their run: which round they are in, whether the judge's biggest gap
 * has become mandatory, how much of the judge-check budget is spent, what a round costs. These
 * are the pure halves of that — the policy it may set, the state the loop reports, the digests
 * it reads and the notes that wake its wait.
 */
describe("the loop the director can see, and the thresholds it may set", () => {
  it("syncs the head on every declared tool, and only spares the studio's own resolve_root", () => {
    for (const tool of DIRECTOR_TOOLS)
      assert.equal(headSynced(tool.name), true, `${tool.name} starts at the real head`);
    assert.equal(DIRECTOR_TOOLS.length, 15, "fifteen tools, all of them synced");
    // `resolve_root` is the studio asking where a target lives, not a director's decision: it
    // must not touch git. plan, worker_status, worker_steer, worker_stop and note used to be
    // outside the set, and note/worker_status are exactly what a director calls right after
    // committing by hand — so the studio believed the head was where the last integrate left it.
    assert.equal(headSynced("resolve_root"), false);
    for (const outside of ["plan", "worker_status", "worker_steer", "worker_stop", "note"]) {
      assert.equal(headSynced(outside), true, `${outside} was outside the old set and is inside now`);
    }
  });

  it("takes the eight loop thresholds on worker_start: refuses a name it does not know, clamps a number out of range, raises a contradiction", () => {
    const start = DIRECTOR_TOOLS.find((t) => t.name === "worker_start")!;
    const policy = (start.parameters.properties as Record<string, { type: string; description: string }>).policy;
    assert.ok(policy, "worker_start takes a policy");
    assert.equal(policy.type, "string", "a string, like every other parameter the bridges carry");
    for (const key of Object.keys(FACET_POLICY))
      assert.ok(policy.description.includes(key), `${key} is named where the director reads it`);
    // The defaults are on run_status, once — not restated in a description rendered in full
    // into every Codex brief.
    assert.ok(!/\{"/.test(policy.description), `the description carries no literal JSON: ${policy.description}`);

    // Nothing given is the harness's own policy, and nothing is claimed as an override.
    for (const nothing of [undefined, null, ""]) {
      const empty = normalizeFacetPolicy(nothing as never) as unknown as {
        policy: Record<string, number>;
        overrides: Record<string, number>;
        warnings: string[];
      };
      assert.deepEqual(empty.policy, FACET_POLICY);
      assert.deepEqual(empty.overrides, {});
      assert.deepEqual(empty.warnings, []);
    }
    // Accepted: the two the director named, and nothing else moved.
    const two = normalizeFacetPolicy('{"maxJudgeChecks":6,"brokenStreakLimit":3}') as unknown as {
      policy: Record<string, number>;
      overrides: Record<string, number>;
      warnings: string[];
    };
    assert.deepEqual(two.overrides, { maxJudgeChecks: 6, brokenStreakLimit: 3 });
    assert.equal(two.policy.maxJudgeChecks, 6);
    assert.equal(two.policy.brokenStreakLimit, 3);
    assert.equal(two.policy.fixAfterSameGap, FACET_POLICY.fixAfterSameGap, "what it did not name did not move");
    assert.deepEqual(two.warnings, []);
    // Refused by name: a typo that silently changed nothing would read as a policy that did.
    const unknown = normalizeFacetPolicy('{"maxJudgeCheks":6}') as unknown as { error: string };
    assert.match(unknown.error, /"maxJudgeCheks" is not one of this loop's thresholds/);
    for (const key of Object.keys(FACET_POLICY)) assert.ok(unknown.error.includes(key), `${key} is offered instead`);
    assert.match(
      (normalizeFacetPolicy('{"maxJudgeChecks":2.5}') as unknown as { error: string }).error,
      /maxJudgeChecks must be a whole number/,
    );
    assert.match(
      (normalizeFacetPolicy('{"maxJudgeChecks":"lots"}') as unknown as { error: string }).error,
      /maxJudgeChecks must be a whole number/,
    );
    assert.match((normalizeFacetPolicy("not json") as unknown as { error: string }).error, /policy: not JSON/);
    assert.match((normalizeFacetPolicy("[1,2]") as unknown as { error: string }).error, /a JSON object of thresholds/);
    // Clamped, with a warning: a run is not refused over a number that is merely too big.
    const clamped = normalizeFacetPolicy({ maxJudgeChecks: 99 }) as unknown as {
      policy: Record<string, number>;
      warnings: string[];
    };
    assert.equal(clamped.policy.maxJudgeChecks, FACET_POLICY_RANGE.maxJudgeChecks[1]);
    assert.match(clamped.warnings[0]!, /maxJudgeChecks 99 is outside 0–12; using 12/);
    // Raised: a fix that loses the round before it has ever been asked for is a contradiction.
    const raised = normalizeFacetPolicy({ fixAfterSameGap: 4 }) as unknown as {
      policy: Record<string, number>;
      overrides: Record<string, number>;
      warnings: string[];
    };
    assert.equal(raised.policy.fixLosesAfter, 4);
    assert.equal(raised.overrides.fixLosesAfter, 4, "the raise is an override too, so the director reads what it got");
    assert.match(raised.warnings.at(-1)!, /fixLosesAfter 3 is below fixAfterSameGap 4; using 4/);
  });

  /**
   * The three pure halves of the loop that read a threshold. Each takes the policy in the
   * options bag it already had, defaulted — so the frozen classic pipeline passes nothing and
   * behaves exactly as it did, and a worker started with a policy is decided by that policy
   * rather than by the harness's own numbers in three places it cannot see.
   */
  it("decides a worker's moves, retirements and grown checks by that worker's policy, and by the harness's own when nobody set one", () => {
    // chooseMove: how many accepted builds may polish, and how often one move is re-asked for.
    const moves = [{ what: "a heron wades in the reeds", source: "planner", delivered: false, attempts: 1 }];
    assert.equal(
      chooseMove({ moves, polishStreak: 1 } as never).mandatory,
      false,
      "the harness's own escalation is at two",
    );
    assert.equal(chooseMove({ moves, polishStreak: 2 } as never).mandatory, true);
    assert.equal(
      chooseMove({ moves, polishStreak: 2, policy: { ...FACET_POLICY, polishStreakEscalate: 4 } } as never).mandatory,
      false,
      "a director that wants four gets four",
    );
    assert.equal(chooseMove({ moves, polishStreak: 0 } as never).source, "pending", "a move stands a second attempt");
    assert.equal(
      chooseMove({ moves, polishStreak: 0, policy: { ...FACET_POLICY, moveAttempts: 1 } } as never).source,
      "planner",
      "and only one when that is the policy",
    );

    // judgeChecksToRetire: how many passes a judge-grown question needs before it has done its job.
    const spec = { checks: [{ id: "defect-fog", origin: "judge" }] };
    assert.deepEqual(judgeChecksToRetire(spec as never, { passes: { "defect-fog": 1 } } as never), []);
    assert.equal(
      (judgeChecksToRetire(spec as never, { passes: { "defect-fog": 2 } } as never) as Array<{ why: string }>)[0]?.why,
      "passed",
    );
    assert.deepEqual(
      judgeChecksToRetire(
        spec as never,
        { passes: { "defect-fog": 2 }, policy: { ...FACET_POLICY, judgeCheckRetirePasses: 3 } } as never,
      ),
      [],
      "a director that wants three passes gets three",
    );

    // defectsToChecks: how many defects become questions in one round, and how many may live.
    const defects = ["the fog bands", "the trees read as boulders", "the sky is flat"];
    const board = () => ({ id: "trees", checks: [] as unknown[], cameras: ["default"] });
    assert.equal((defectsToChecks(board() as never, defects) as unknown[]).length, 2, "two a round, by default");
    assert.equal(
      (
        defectsToChecks(board() as never, defects, {
          policy: { ...FACET_POLICY, defectChecksPerIteration: 3 },
        } as never) as unknown[]
      ).length,
      3,
    );
    const full = {
      id: "trees",
      checks: Array.from({ length: 4 }, (_, i) => ({ id: `grown-${i}`, origin: "judge", defect: `something ${i}` })),
      cameras: ["default"],
    };
    assert.equal((defectsToChecks(full as never, defects) as unknown[]).length, 0, "a full board grows nothing");
    assert.equal(
      (
        defectsToChecks(full as never, defects, {
          policy: { ...FACET_POLICY, maxJudgeChecks: 6 },
        } as never) as unknown[]
      ).length,
      2,
      "a director that wants six has room for two more",
    );
  });

  it("reports where a worker's loop stands, leaves out everything zero, and sizes the rounds its budget still holds", () => {
    const now = Date.now();
    const busy = loopStateOf({
      phase: "verifying",
      round: 5,
      polishStreak: 2,
      loseStreak: 1,
      brokenStreak: { reason: "TypeError: t.update is not a function", count: 1 },
      fix: {
        what: "the trees read as boulders on posts",
        checkId: "defect-trees",
        streak: 3,
        mandatory: true,
        losses: 1,
      },
      spec: {
        checks: [
          { id: "a", origin: "judge" },
          { id: "b", origin: "judge" },
          { id: "c", origin: "judge" },
          { id: "d", origin: "harness" },
        ],
      },
      retiredChecks: ["defect-fog"],
      emaBuildMs: 8 * 60_000,
      emaAfterMs: 2 * 60_000,
    } as never) as Record<string, any>;
    assert.equal(busy.estimateMs, 10 * 60_000, "a round is its build turn plus everything the verdict needs after it");
    const digest = loopDigest(busy as never) as Record<string, any>;
    assert.equal(digest.round, 5);
    assert.equal(digest.phase, "verifying");
    assert.equal(digest.polishStreak, 2);
    assert.equal(digest.loseStreak, 1);
    assert.equal(digest.judgeChecks, "3/4");
    assert.equal(digest.fix.mandatory, true);
    assert.equal(digest.fix.rounds, 3);
    assert.match(digest.brokenStreak, /^1\/2 — TypeError/);
    assert.deepEqual(digest.retiredChecks, ["defect-fog"]);
    assert.equal(digest.roundEstimateMinutes, 10);

    // A quiet worker costs three fields: nothing is polished, broken, fixed or retired.
    const quiet = loopStateOf({ phase: "building", round: 1, spec: { checks: [] } } as never);
    assert.deepEqual(loopDigest(quiet as never), { round: 1, phase: "building", judgeChecks: "0/4" });
    assert.equal(loopDigest(null as never), null);

    // The digest a director reads: the loop, and the rounds its clock still holds. The divisor
    // is ITERATION_HEADROOM's, because the loop refuses to START a round without that headroom
    // — telling a director it has a round the worker will refuse is worse than saying nothing.
    const worker = {
      id: "trees",
      title: "Trees",
      mode: "loop",
      state: "running",
      startedAt: now - 40 * 60_000,
      endedAt: null,
      deadline: now + 25 * 60_000,
      iterations: [],
      roundMs: [],
      lastCommit: null,
      result: null,
      monitor: null,
      stopWhy: null,
      error: null,
      worktree: "/scratch/trees",
      loop: busy,
      policyOverrides: { maxJudgeChecks: 6 },
    };
    const full = workerDigest(worker as never, now) as Record<string, any>;
    assert.equal(full.loop.judgeChecks, "3/4");
    assert.equal(full.roundsLeft, Math.floor(25 / (10 * ITERATION_HEADROOM)), "two whole rounds, not two and a half");
    assert.deepEqual(
      full.policy,
      { maxJudgeChecks: 6 },
      "only what this worker was started with; the defaults are on run_status",
    );
    assert.ok(
      !("roundsLeft" in (workerDigest({ ...worker, state: "done" } as never, now) as Record<string, unknown>)),
      "a worker that is over has no rounds left to have",
    );
    assert.ok(
      !("loop" in (workerDigest({ ...worker, loop: null } as never, now) as Record<string, unknown>)),
      "a worker whose loop said nothing carries no loop",
    );
    assert.ok(
      !("policy" in (workerDigest({ ...worker, policyOverrides: {} } as never, now) as Record<string, unknown>)),
      "a worker on the harness's own policy claims no policy",
    );

    // `wait` is called dozens of times a run: it gains exactly one line, and only the one a
    // waiting director has to act on.
    const line = waitDigest(worker as never, now) as Record<string, any>;
    assert.equal(line.mandatoryFix, "the trees read as boulders on posts");
    assert.ok(!("loop" in line) && !("judgeChecks" in line), `wait stays a line: ${JSON.stringify(line)}`);
    const easy = waitDigest(
      { ...worker, loop: { ...busy, fix: { ...busy.fix, mandatory: false } } } as never,
      now,
    ) as Record<string, unknown>;
    assert.ok(!("mandatoryFix" in easy), "a fix that is only asked for is not a wake-up");
  });

  it("bounds a worker's board in the status blob, and still answers with the counts a decision is made on", () => {
    const entries = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${prefix}-${i}`,
        kind: "vision",
        weight: "normal",
        reason: `${prefix} ${i} ${"x".repeat(400)}`,
      }));
    const board = {
      total: 30,
      passing: 9,
      unmeasured: 9,
      identityAllPass: false,
      failing: entries(9, "fail"),
      unmeasuredChecks: entries(9, "unmeasured"),
    };
    const bounded = clampBoard(board as never) as Record<string, any>;
    assert.equal(bounded.total, 30, "the counts are what a decision is made on and are all kept");
    assert.equal(bounded.identityAllPass, false);
    assert.equal(bounded.failing.length, 6);
    assert.equal(bounded.failingNotShown, 3);
    assert.equal(bounded.unmeasuredChecks.length, 6);
    assert.equal(bounded.unmeasuredNotShown, 3);
    assert.equal(bounded.failing[0].reason.length, 160, "a reason is a reason, not a paragraph");
    const small = clampBoard({ total: 2, passing: 2, failing: [], unmeasuredChecks: [] } as never) as Record<
      string,
      unknown
    >;
    assert.ok(
      !("failingNotShown" in small) && !("unmeasuredNotShown" in small),
      "a board that fits says nothing about what is not shown",
    );
    assert.equal(clampBoard(null as never), null);
  });

  it("wakes the director's wait on a transition of its worker's loop, most urgent first, and never twice on the same fact", () => {
    const base = loopStateOf({ phase: "building", round: 2, spec: { checks: [] } } as never) as Record<string, any>;
    const note = (before: unknown, now: unknown) => loopNote("trees", before as never, now as never);
    assert.equal(note(base, base), null, "nothing changed, nothing said");
    // 1. an unjudgeable build, and how many are left before the worker stops.
    const broken = { ...base, brokenStreak: { reason: "TypeError: t.update is not a function", count: 1 } };
    const brokenSaid = note(base, broken)!;
    assert.match(brokenSaid, /^worker trees: an unjudgeable build \(TypeError/);
    assert.match(brokenSaid, /1 more with the same cause and it stops/);
    assert.equal(note(broken, broken), null, "said once");
    // 2. the gap that has become mandatory — keyed on what it is and that it is mandatory.
    const asked = {
      ...base,
      fix: { what: "the trees read as boulders on posts", streak: 2, mandatory: false, losses: 0 },
    };
    assert.equal(note(base, asked), null, "a fix that is merely asked for is not news");
    const mandatory = { ...base, fix: { ...asked.fix, streak: 3, mandatory: true } };
    assert.match(
      note(asked, mandatory)!,
      /^worker trees: the judge has named the same gap 3 rounds running and it is now mandatory/,
    );
    assert.equal(
      note(mandatory, { ...mandatory, fix: { ...mandatory.fix, streak: 4 } }),
      null,
      "a mandatory streak that merely grows is the same fact",
    );
    assert.match(
      note(mandatory, { ...mandatory, fix: { what: "the sky bands", streak: 3, mandatory: true, losses: 0 } })!,
      /the sky bands/,
      "a different gap is a different fact",
    );
    // 3. the judge-check budget is spent.
    const roomy = { ...base, judgeChecks: { live: 3, max: 4, perRound: 2, retired: [] } };
    const full = { ...base, judgeChecks: { live: 4, max: 4, perRound: 2, retired: [] } };
    assert.match(note(roomy, full)!, /^worker trees: its board carries the most judge-grown questions it may \(4\/4\)/);
    assert.equal(note(full, full), null, "said once");
    // 4. a retirement — the id-set difference, never the length: the list is sliced to twelve,
    // so two retirements after the slice bites would look like none at all.
    const before12 = {
      ...base,
      judgeChecks: { live: 1, max: 4, perRound: 2, retired: Array.from({ length: 12 }, (_, i) => `old-${i}`) },
    };
    const after12 = {
      ...base,
      judgeChecks: { live: 1, max: 4, perRound: 2, retired: [...before12.judgeChecks.retired.slice(1), "defect-fog"] },
    };
    assert.equal(
      before12.judgeChecks.retired.length,
      after12.judgeChecks.retired.length,
      "the same length, a different set",
    );
    assert.match(note(before12, after12)!, /^worker trees: a judge-grown check has retired \(defect-fog\)/);
    // 5. the polish streak the next brief escalates on.
    const polished = { ...base, polishStreak: 2 };
    assert.match(
      note({ ...base, polishStreak: 1 }, polished)!,
      /^worker trees: 2 accepted builds in a row only polished — the next brief makes the move mandatory/,
    );
    assert.equal(note(polished, polished), null, "said once");
    // Most urgent first: a round that is broken AND mandatory AND full says the broken build.
    assert.match(
      note(base, {
        ...base,
        brokenStreak: broken.brokenStreak,
        fix: mandatory.fix,
        judgeChecks: full.judgeChecks,
        polishStreak: 2,
      })!,
      /an unjudgeable build/,
    );
    // A first look at a worker still reads as a transition — there is nothing it said before.
    assert.match(note(null, mandatory)!, /now mandatory/);
    assert.equal(note(null, null), null);
  });
});

/** `complete` is the run's judge (judge.ts `askJudge` asks the run's own engine); "{}" is a tie. */
function fakeEngine(
  rig: Rig,
  delegate: (request: DelegateRequest) => Promise<DelegateResult>,
  complete: (request: CompleteRequest) => Promise<CompleteResponse> = async () => ({
    message: { role: "assistant", content: "{}" },
    usage: {},
    model: "fixture",
    engine: "codex",
    stopReason: "stop",
  }),
): void {
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete,
    delegate,
  } as never);
}

/** The custom event types a run wrote, each once, in the order they first appear. */
function runEventTypes(events: Awaited<ReturnType<typeof waitForLog>>, runId: string): string[] {
  const types: string[] = [];
  for (const event of events) {
    if (event.data.type !== "custom") continue;
    const payload = (event.data as { payload?: { runId?: unknown } }).payload;
    if (payload?.runId !== runId || types.includes(event.data.event_type)) continue;
    types.push(event.data.event_type);
  }
  return types;
}

/** A run as the director's tool handler reads it, with a builder `plaza` and a recording host. */
function markingLoopRun(state: string) {
  const rec = ctxRecorder({
    handlers: {
      "artifact.read": () => null,
      "artifact.write": () => 1,
      "events.head": () => null,
      "events.list": () => [],
      "plugins.workerTypes": () => [],
      "engine.delegate": () => ({ ok: true, engine: "claude-code", summary: "read it", usage: {}, turns: 1 }),
    },
  });
  const integrated: unknown[] = [];
  const cards: string[] = [];
  const log: Array<{ seq: number; text: string }> = [];
  const plaza = { id: "plaza", title: "Plaza", state, mode: "loop" };
  const loopRun = {
    ctx: rec.ctx,
    toolCalls: 0,
    toolsInFlight: 0,
    run: { runId: `run-mark-${state}`, project: "skate", engine: "claude-code" },
    threadId: "t-mark",
    projectDir: "/games/skate",
    integrationWorktree: "/runs/skate/integration",
    gameFacts: undefined,
    state: { integrationHead: "aaa", finished: false, workers: new Map([["plaza", plaza]]), ledger: [] },
    journal: null,
    waitSeq: 0,
    softDeadline: Date.now() + 60_000,
    finalDeadline: Date.now() + 120_000,
    saveJournal: async () => {},
    keepMemory: async () => {},
    syncHead: async () => {},
    integrate: async (args: unknown) => {
      integrated.push(args);
      loopRun.state.integrationHead = "bbb";
      return "merged plaza";
    },
    decision: async (text: string) => {
      cards.push(text);
    },
    note: (text: string) => log.push({ seq: log.length + 1, text }),
    notesSince: (seq: number) => log.filter((entry) => entry.seq > seq),
    ledgerLines: () => [],
    routeUserSteers: async () => {},
    inbox: { steering: async () => [], finishing: async () => false },
  };
  return { loopRun, rec, integrated, cards, log };
}

/** The `worker_finished` records a director appended, by their payloads. */
function workerFinishes(rec: { paramsOf: (method: string) => Array<Record<string, unknown>> }) {
  return rec
    .paramsOf("events.append")
    .flatMap((params) =>
      ((params.batch as Array<Record<string, unknown>>) ?? []).flatMap((data) =>
        data.event_type === "worker_finished" ? [data.payload as Record<string, unknown>] : [],
      ),
    );
}

describe("the director's worker_mark and readers, in Genex's one worker model", () => {
  it("worker_mark used integrates the worker, and rejected stops its news", async () => {
    const { handler, wait } = await import("../../src/harness-seed/loop/director/tools.ts");
    const used = markingLoopRun("running");
    assert.equal(await handler(used.loopRun as never, "worker_mark", { id: "plaza", verdict: "used" }), "merged plaza");
    assert.deepEqual(used.integrated, [{ worker: "plaza" }], "used is integrate for that worker");
    assert.deepEqual(
      workerFinishes(used.rec).map(({ at: _at, ...row }) => row),
      [
        {
          runId: "run-mark-running",
          project: "skate",
          workerId: "plaza",
          title: "Plaza",
          verdict: "used",
          merged: true,
        },
      ],
      "the lead's verdict is a record: used and added to the game",
    );

    const rejected = markingLoopRun("done");
    rejected.loopRun.note("worker plaza: iteration 2 accepted");
    rejected.loopRun.note("USER SAYS: keep the plaza red");
    const answer = String(
      await handler(rejected.loopRun as never, "worker_mark", { id: "plaza", verdict: "rejected" }),
    );
    assert.match(answer, /Rejected plaza/);
    assert.deepEqual(rejected.integrated, [], "rejected integrates nothing");
    const [rejectedRow, ...more] = workerFinishes(rejected.rec);
    assert.equal(rejectedRow?.verdict, "rejected");
    assert.equal(rejectedRow?.merged, undefined, "a rejected builder's work was not added");
    assert.deepEqual(more, []);
    assert.match(rejected.cards.join("\n"), /rejected worker plaza/, "the feed says so");
    const waited = JSON.parse(String(await wait(rejected.loopRun as never, { seconds: "1" })));
    assert.deepEqual(waited.happened, ["USER SAYS: keep the plaza red"], "its news stops; the user's words do not");
    assert.deepEqual(waited.status.workers, [], "the digest no longer names it");
    const stillRunning = markingLoopRun("running");
    assert.match(
      String(await handler(stillRunning.loopRun as never, "worker_mark", { id: "plaza", verdict: "rejected" })),
      /still running/,
      "a running worker is stopped first",
    );
    assert.deepEqual(workerFinishes(stillRunning.rec), [], "and no verdict is recorded");
  });

  it("worker_mark rejected refuses a builder whose work is in the game already", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const usedFirst = markingLoopRun("done");
    await handler(usedFirst.loopRun as never, "worker_mark", { id: "plaza", verdict: "used" });
    const integratedFirst = markingLoopRun("done");
    const plaza = integratedFirst.loopRun.state.workers.get("plaza");
    assert.ok(plaza);
    Object.assign(plaza, { integrated: true });
    for (const [name, { loopRun, rec, cards }] of [
      ["marked used", usedFirst],
      ["integrated by the lead", integratedFirst],
    ] as const) {
      const before = workerFinishes(rec).length;
      const answer = String(await handler(loopRun as never, "worker_mark", { id: "plaza", verdict: "rejected" }));
      assert.match(answer, /already in the game/, name);
      assert.equal(workerFinishes(rec).length, before, `${name}: no verdict is recorded`);
      assert.deepEqual(cards, [], `${name}: the feed says nothing was set aside`);
    }
  });

  it("a builder's end is recorded: one the close-out finds still running stopped, a finished one with its summary", async () => {
    const { recordBuilderEnded } = await import("../../src/harness-seed/loop/workers/director-pool.ts");
    const cutOff = markingLoopRun("running");
    const plaza = cutOff.loopRun.state.workers.get("plaza");
    await recordBuilderEnded(cutOff.loopRun as never, plaza as never, "the run ended");
    const [stopped] = workerFinishes(cutOff.rec);
    assert.equal(stopped?.state, "stopped", "a builder cut off by the run's end did not finish");
    assert.equal(stopped?.stoppedBecause, "the run ended");
    const finished = markingLoopRun("done");
    // A single-session builder keeps its session's summary on itself, as `runSingleWorker` sets it.
    const done = { ...finished.loopRun.state.workers.get("plaza"), summary: "Paved the plaza. Tests pass." };
    await recordBuilderEnded(finished.loopRun as never, done as never, null);
    const [ended] = workerFinishes(finished.rec);
    assert.equal(ended?.state, "done");
    assert.equal(ended?.summary, "Paved the plaza.", "its own summary's first sentence");
    assert.equal(ended?.runId, "run-mark-done");
    assert.equal(ended?.delivered, undefined, "a builder that left no commit of its own hands nothing back");
    const handedBack = markingLoopRun("done");
    const committed = { ...handedBack.loopRun.state.workers.get("plaza"), from: "base1", lastCommit: "own1" };
    await recordBuilderEnded(handedBack.loopRun as never, committed as never, null);
    assert.equal(
      workerFinishes(handedBack.rec)[0]?.delivered,
      true,
      "a builder that finished with a commit of its own hands work back: it waits on the lead",
    );
    const unchanged = markingLoopRun("done");
    const atBase = { ...unchanged.loopRun.state.workers.get("plaza"), from: "base1", lastCommit: "base1" };
    await recordBuilderEnded(unchanged.loopRun as never, atBase as never, null);
    assert.equal(workerFinishes(unchanged.rec)[0]?.delivered, undefined, "its head still at its fork is nothing");
    const failed = markingLoopRun("failed");
    const failedWithCommit = { ...failed.loopRun.state.workers.get("plaza"), from: "base1", lastCommit: "own1" };
    await recordBuilderEnded(failed.loopRun as never, failedWithCommit as never, "it broke");
    assert.equal(workerFinishes(failed.rec)[0]?.delivered, undefined, "only a finished builder hands work back");
  });

  it("a builder that stops short says why in the app's own code: the lead stopped it, the Loop ended first, or an error", async () => {
    const { recordBuilderEnded } = await import("../../src/harness-seed/loop/workers/director-pool.ts");
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const codeOf = async (state: string, setUp: (run: ReturnType<typeof markingLoopRun>) => Promise<void> | void) => {
      const marking = markingLoopRun(state);
      await setUp(marking);
      const plaza = marking.loopRun.state.workers.get("plaza");
      await recordBuilderEnded(marking.loopRun as never, plaza as never, "lead-facing words");
      return workerFinishes(marking.rec)[0]?.stopCode;
    };
    const plazaOf = (marking: ReturnType<typeof markingLoopRun>) =>
      marking.loopRun.state.workers.get("plaza") as unknown as Record<string, unknown>;
    assert.equal(await codeOf("running", () => {}), "run_ended", "cut off by the run's end at its close-out");
    assert.equal(
      await codeOf("running", async (marking) => {
        const asked = Object.assign(marking.loopRun, {
          stopWorker: async (worker: Record<string, unknown>) => {
            worker.stopRequested = true;
          },
        });
        plazaOf(marking).iterations = [];
        const answer = String(await handler(asked as never, "worker_stop", { id: "plaza", why: "enough" }));
        assert.match(answer, /stop requested for plaza/);
        plazaOf(marking).state = "stopped";
      }),
      "stopped_by_lead",
      "the lead's worker_stop",
    );
    assert.equal(
      await codeOf("stopped", (marking) => {
        plazaOf(marking).stopRequested = true;
      }),
      "run_ended",
      "stopped by the run's close, not by the lead",
    );
    assert.equal(await codeOf("failed", () => {}), "error", "a failure");
    assert.equal(await codeOf("done", () => {}), undefined, "a finished builder has none");
  });

  it("a conflict worker's records name the work it fits in, in plain words, with no summary of Genex's own", async () => {
    const { recordBuilderEnded, recordBuilderStarted } = await import(
      "../../src/harness-seed/loop/workers/director-pool.ts"
    );
    const { CONFLICT_WORDS } = await import("../../src/harness-seed/loop/director/lead-session-prompts.ts");
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const { loopRun, rec } = markingLoopRun("done");
    const fitting = {
      id: "plaza-2",
      title: CONFLICT_WORDS.title("Plaza"),
      brief: "MERGE CONFLICT TO RESOLVE: keep both sides.",
      state: "done",
      mode: "single",
      from: "base1",
      lastCommit: "own1",
      merging: { of: "plaza", commit: "c1" },
      summary: CONFLICT_WORDS.mergedCleanly("plaza"),
    };
    loopRun.state.workers.set(fitting.id, fitting as never);
    await recordBuilderStarted(loopRun as never, fitting as never);
    await recordBuilderEnded(loopRun as never, fitting as never, null);
    await handler(loopRun as never, "worker_mark", { id: fitting.id, verdict: "used" });
    const records = rec
      .paramsOf("events.append")
      .flatMap((params) => (params.batch as Array<Record<string, unknown>>) ?? [])
      .filter((data) => String(data.event_type).startsWith("worker_"))
      .map((data) => data.payload as Record<string, unknown>);
    assert.equal(records.length, 3, "a start, an end and the lead's verdict");
    const forbidden = /merg|copy|lock|reader|writer|editor|isolation|sandbox|seat|conflict/i;
    for (const { title, task, summary } of records) {
      assert.equal(title, "Fit Plaza in with the rest of the game");
      assert.doesNotMatch(`${title} ${task ?? ""} ${summary ?? ""}`, forbidden);
    }
    assert.equal(records[1]?.summary, undefined, "Genex's own words on the merge are no summary of the worker's");
  });

  it("a reader started with isolation read works in place and never integrates", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const { closeReaders } = await import("../../src/harness-seed/loop/workers/director-pool.ts");
    const { loopRun, rec, integrated, log } = markingLoopRun("done");
    const started = String(
      await handler(loopRun as never, "worker_start", {
        id: "look",
        title: "Look",
        task: "Read the HUD.",
        isolation: "read",
      }),
    );
    assert.match(started, /^Started w1 \(read\)/);
    const status = String(await handler(loopRun as never, "worker_wait", { id: "w1", seconds: "5" }));
    assert.match(status, /w1 · Look · read · done/);
    const [delegation] = rec.paramsOf("engine.delegate");
    assert.equal(delegation?.readOnly, true, "it writes nothing");
    assert.equal(delegation?.cwd, undefined, "it works in the game folder itself");
    assert.deepEqual(delegation?.worker, { id: "w1", title: "Look", runId: loopRun.run.runId, research: false });
    assert.deepEqual(rec.paramsOf("snapshot.create"), [], "no copy is made for it");
    assert.match(log.map((entry) => entry.text).join("\n"), /worker w1: Look done/, "its end is the lead's news");
    assert.match(
      String(await handler(loopRun as never, "worker_mark", { id: "w1", verdict: "used" })),
      /nothing to merge/,
    );
    assert.deepEqual(integrated, [], "a reader never integrates");
    assert.match(
      String(await handler(loopRun as never, "worker_start", { id: "lock", task: "write here", isolation: "lock" })),
      /never in the game folder itself/,
      "the web method refuses a writer in place",
    );
    await closeReaders(loopRun as never);
  });

  it("a builder waiting on the person is the lead's news: worker_wait wakes on it and its line says so", async () => {
    const { handler, wait } = await import("../../src/harness-seed/loop/director/tools.ts");
    const { loopRun, rec, log } = markingLoopRun("running");
    const plaza = { iterations: [], deadline: Date.now() + 60_000, brief: "a red plaza", problems: [], steering: [] };
    Object.assign(loopRun.state.workers.get("plaza")!, plaza);
    // The run binds every tool's function to itself; this one hands `worker_wait` to the real one.
    Object.assign(loopRun, { wait: (args: Record<string, unknown>) => wait(loopRun as never, args) });
    const question = {
      id: "e1",
      data: {
        type: "custom",
        event_type: "tool_permission",
        payload: {
          requestId: "perm-1",
          state: "pending",
          worker: { id: "plaza" },
          title: "Plaza wants to run npm install",
        },
      },
    };
    rec.handle("events.list", (p) => (p.after ? [] : [question]));
    const started = Date.now();
    const waited = JSON.parse(String(await handler(loopRun as never, "worker_wait", { id: "plaza", seconds: "30" })));
    assert.ok(Date.now() - started < 10_000, "it woke at once");
    assert.match(waited.happened.join("\n"), /worker plaza is waiting for the person: Plaza wants to run npm install/);
    assert.equal(waited.status.workers[0]?.waitingForPerson, "Plaza wants to run npm install");
    assert.equal(log.filter((entry) => /waiting for the person/.test(entry.text)).length, 1, "told once");
    const status = JSON.parse(String(await handler(loopRun as never, "worker_status", { id: "plaza" })));
    assert.equal(status.waitingForPerson, "Plaza wants to run npm install");
    assert.equal(log.filter((entry) => /waiting for the person/.test(entry.text)).length, 1, "and not again");
  });

  it("a reader may be a researcher", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const { closeReaders } = await import("../../src/harness-seed/loop/workers/director-pool.ts");
    const { loopRun, rec } = markingLoopRun("done");
    await handler(loopRun as never, "worker_start", {
      title: "Look",
      task: "How do others do it?",
      isolation: "read",
      research: "yes",
    });
    const [delegation] = rec.paramsOf("engine.delegate");
    assert.equal((delegation?.worker as { research?: boolean } | undefined)?.research, true);
    await closeReaders(loopRun as never);
  });

  it("still answers the old name wait, which a kept playbook may call", async () => {
    const { handler, wait } = await import("../../src/harness-seed/loop/director/tools.ts");
    const { loopRun } = markingLoopRun("done");
    loopRun.state.workers.clear();
    // The run binds every tool's function to itself; this one hands `wait` to the real one.
    const bound = Object.assign(loopRun, { wait: (args: Record<string, unknown>) => wait(bound as never, args) });
    const waited = JSON.parse(String(await handler(bound as never, "wait", { seconds: "1" })));
    assert.deepEqual(waited.happened, ["nothing yet"]);
  });
});

describe("a director's run through the real core and harness", () => {
  it("starts a worker, waits, looks, integrates, judges, shows, finishes — and the integration branch lands", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    assert.equal(rig.core.host.hasCapability("director"), true, "the seed claims the director");
    const project = await rig.core.games.scaffold("director-smoke", { title: "Director smoke" });
    // Blender files beside the web game: the lead's identity must read the game's own facts, not
    // the web game a director builds by default.
    await mkdir(path.join(project.dir, "art"), { recursive: true });
    await writeFile(path.join(project.dir, "art", "tree.blend"), "BLENDER");
    // The user has the game open in Live: the one load in this test that is theirs.
    await rig.core.loadPreview({ project: project.name });
    const liveLoadsBefore = rig.preview.loads.length;
    const seen: { director: DelegateRequest[]; workers: DelegateRequest[] } = { director: [], workers: [] };
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.tools = (request.liveTools ?? []).map((t) => t.name);
        results.status0 = json(await call("run_status", {}));
        results.shot = await call("computer", { action: "screenshot" });
        results.noPlan = text(await call("worker_start", { id: "plaza", brief: "paint the plaza red" }));
        results.planned = text(await call("plan", planFor("plaza")));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        results.refused = text(await call("worker_start", { id: "plaza", brief: "again" }));
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("worker_wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "plaza" }));
        // A `done` entry with no check is refused before anything is created for it.
        results.badDone = text(
          await call("worker_start", {
            id: "bins",
            brief: "knock the bins over",
            done: JSON.stringify([{ what: "the bins move" }]),
          }),
        );
        results.looked = await call("look", { target: "plaza" });
        results.captured = await request.onCapture!({ cameras: "default" });
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.judged = json(
          await call("judge", {
            target: "integration",
            against: "none",
            checks: JSON.stringify([
              { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
            ]),
          }),
        );
        results.played = json(await call("playtest", { target: "integration", ask: "Can I walk across the plaza?" }));
        results.shown = text(await call("show", { target: "integration" }));
        results.noted = text(await call("note", { text: "plaza integrated and lit" }));
        results.bad = text(await call("integrate", { worker: "nobody" }));
        results.finished = text(
          await call("finish", { summary: "the plaza is red and lit", land: "yes", victory: "yes" }),
        );
        results.after = text(await call("worker_start", { id: "late", brief: "too late" }));
        return { ok: true, engine: "codex", turns: 14, usage: {}, sessionId: "director-1", summary: "run done" };
      }
      if (request.playtest)
        return {
          ok: true,
          engine: "codex",
          turns: 1,
          usage: {},
          sessionId: "playtester-1",
          summary: JSON.stringify({ answers: { "director-play": { answer: "yes", note: "Walked across the plaza" } } }),
        };
      seen.workers.push(request);
      assert.ok(request.selfCapture, "a worker has eyes");
      assert.ok(
        request.liveTools?.some((t) => t.name === "computer"),
        "and hands",
      );
      results.workerShot = await request.onLiveTool!("computer", { action: "screenshot" });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      await mkdir(path.join(request.cwd, "docs", "notes"), { recursive: true });
      await writeFile(path.join(request.cwd, "docs", "notes", "NOTES.plaza.md"), "# plaza\npainted red\n");
      return {
        ok: true,
        engine: "codex",
        turns: 3,
        usage: {},
        sessionId: "worker-1",
        summary: "painted the plaza red",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );
    // The session closes after the run does (finish answers from inside it): give the window its moment.
    await waitForLog(
      rig.core,
      () =>
        rig.events.some(
          (e) =>
            e.type === "preview.screen" &&
            (e.payload as { role: string; state: string }).role === "director" &&
            (e.payload as { state: string }).state === "closed",
        ),
      15_000,
      "the director's screen to close",
    );

    // The run announced itself as a director's, and the session got the tools.
    assert.equal(customEvents(events, "run_started").find((e) => e.runId === runId)?.mode, "director");
    assert.equal(customEvents(events, "autopilot_started").find((e) => e.runId === runId)?.director, true);
    assert.ok(
      results.played,
      JSON.stringify({
        integrated: results.integrated,
        judged: results.judged,
        status: results.status0,
        failed: customEvents(events, "run_failed"),
        errors: events.filter((e) => e.data.type === "error"),
      }),
    );
    assert.equal(results.played.answer, "yes", "reporting preserves the successful playtest tool answer");
    const interaction = customEvents(events, "run_interaction_evidence").find((e) => e.runId === runId)!;
    assert.equal(interaction.status, "passed");
    assert.equal(interaction.source, "independent-playtester");
    assert.equal(
      interaction.head,
      customEvents(events, "integration_merge").find((e) => e.runId === runId && e.conflict === false)?.head,
      "playtest evidence belongs to the revision actually tested",
    );
    assert.equal(seen.director.length, 1, "one director session");
    assert.equal(
      seen.workers.length,
      1,
      `one worker session — worker_start answered ${JSON.stringify(results.started)}; waited ${JSON.stringify(results.waited?.happened)}`,
    );
    const director = seen.director[0]!;
    // Its identity reads the game as the run found it ready: its folder and what it holds.
    const folderLabel = project.dir.split("/").slice(-2).join("/");
    assert.ok(director.prompt.includes(`the folder \`${folderLabel}\``), "the game's folder");
    assert.match(director.prompt, /it holds a web game at its root, Blender files in `art\/`/, "the game's facts");
    // Flipped (one session): the lead is its chat's own session — it sits in the game folder and
    // writes nothing; the integration worktree is the build it leads (its grant's root).
    const worktree = director.director!.root;
    assert.equal(await realpath(director.cwd), await realpath(project.dir), "the lead sits in the game folder");
    assert.ok(worktree.includes(path.join("autopilot", runId, "integration")), worktree);
    assert.equal(director.readOnly, true, "and only reads");
    for (const name of [
      "computer",
      "look",
      "run_status",
      "worker_start",
      "judge",
      "integrate",
      "show",
      "note",
      "finish",
    ])
      assert.ok(results.tools.includes(name), `${name} offered`);
    // A waking lead ends its turn instead of waiting inside it (director/wake.ts), so
    // `worker_wait` is not offered. Its handler still answers the call above, and the old name
    // `wait` too, for a playbook the agent kept that names it.
    assert.ok(!results.tools.includes("worker_wait"), "worker_wait is not offered to a waking lead");
    assert.ok(!results.tools.includes("wait"), "nor the old name");
    assert.ok(results.tools.includes("worker_mark"), "worker_mark is offered");

    // Tool answers, across the studio → harness dispatch.
    assert.ok(
      results.status0.time.hardMinutesLeft <= 15 &&
        results.status0.time.sessionMinutesLeft < results.status0.time.hardMinutesLeft,
      JSON.stringify(results.status0.time),
    );
    assert.equal(results.status0.integration.worktree, worktree);
    assert.equal(results.status0.capacity.windowsMax, 2);
    assert.ok(
      typeof results.shot !== "string" && results.shot.images?.length === 1,
      "the director's screenshot is a picture",
    );
    // The plan comes first: the run is refused until the user has something to read (M3.8).
    assert.match(results.noPlan, /call plan first/, results.noPlan);
    assert.match(results.planned, /the plan is in the user's chat/, results.planned);
    const planCard = customEvents(events, "autopilot_plan_review").find((e) => e.runId === runId)!;
    assert.deepEqual(
      (planCard.facets as Array<{ id: string; title: string }>).map((f) => f.id),
      ["plaza"],
    );
    assert.match(String(planCard.summary), /This run/);
    assert.equal(planCard.waitMinutes, 0, "nobody asked to review this one, so nothing waits for a word");
    assert.equal(results.started.started, "plaza");
    assert.equal(results.started.mode, "single");
    assert.match(results.refused, /already exists/);
    assert.equal(results.waited.status.workers[0].state, "done", JSON.stringify(results.waited));
    assert.ok(
      results.waited.happened.some((h: string) => /worker plaza done/.test(h)),
      JSON.stringify(results.waited.happened),
    );
    assert.equal(results.wstatus.state, "done");
    assert.match(results.wstatus.summary, /painted the plaza red/);
    assert.match(results.badDone, /done: every entry is \{"what"/, results.badDone);
    assert.ok(results.wstatus.lastCommit, "the studio committed the worker's folder");
    assert.match(text(results.looked), /the window now shows plaza \(/);
    assert.ok(
      typeof results.looked !== "string" && results.looked.images?.length === 1,
      "look answers with a screenshot",
    );
    assert.match(results.captured, /c\d+_default\.jpg/);
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.integrated.health.ok, true, JSON.stringify(results.integrated.health));
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged));
    assert.ok(results.judged.shots.length >= 1);
    assert.equal(results.judged.board.summary.passing, 1, JSON.stringify(results.judged.board));
    assert.match(results.shown, /Live's Reload now offers integration/);
    assert.equal(results.noted, "noted");
    assert.match(results.bad, /no worker "nobody"/);
    assert.match(results.finished, /the run is closed — the integrated build [0-9a-f]{10} is live/);
    assert.match(results.after, /finishing; no new workers/);

    // The feed: worker cards, the merge, the show, the decisions, the closure.
    const workerEvents = customEvents(events, "director_worker").filter((e) => e.runId === runId);
    assert.deepEqual(
      workerEvents.map((e) => e.state),
      ["running", "done"],
    );
    assert.ok(workerEvents[1]!.lastCommit);
    // The builder's own worker records, as its session left them: its start with the lead's brief,
    // its end with its session's first sentence; the integrate then puts its line in the game.
    const plazaRecords = (type: string) =>
      customEvents(events, type).filter((e) => e.runId === runId && e.workerId === "plaza");
    const [plazaStart, ...moreStarts] = plazaRecords("worker_started");
    assert.deepEqual(moreStarts, []);
    assert.equal(plazaStart?.title, "Plaza");
    assert.equal(plazaStart?.isolation, "copy");
    assert.equal(plazaStart?.task, "paint the plaza red");
    const [plazaEnd, ...moreEnds] = plazaRecords("worker_finished");
    assert.deepEqual(moreEnds, [], "integrate writes no worker record");
    assert.equal(plazaEnd?.state, "done");
    assert.equal(plazaEnd?.delivered, true, "it committed work of its own");
    assert.equal(plazaEnd?.stopCode, undefined);
    assert.equal(plazaEnd?.summary, "painted the plaza red", "the session's own words, as worker_status says them");
    const plazaLines = toEntries(events).flatMap((entry) =>
      entry.kind === EntryKind.Action && entry.action === EntryAction.Worker ? [entry.text] : [],
    );
    assert.deepEqual(plazaLines, ["Painted the plaza red. Added to your game."]);
    const merges = customEvents(events, "integration_merge").filter((e) => e.runId === runId);
    assert.equal(merges.length, 1);
    assert.equal(merges[0]!.stage, "director");
    assert.equal(merges[0]!.conflict, false);
    assert.equal(customEvents(events, "director_show").find((e) => e.runId === runId)?.target, "integration");
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /director started worker "Plaza" \(plaza, single, 5 min\)/.test(d)),
      decisions.join(" | "),
    );
    assert.ok(decisions.includes("director: plaza integrated and lit"));
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.mode, "director");
    assert.equal(finished.landed, true);
    assert.equal(finished.victory, true);
    assert.equal(finished.summary, "the plaza is red and lit");
    assert.equal((finished.workers as Record<string, { state: string }>).plaza.state, "done");
    assert.equal(finished.stoppedBecause, "the director finished the run");

    // The integration branch landed in the live folder; the worktrees are gone.
    assert.equal(await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), "export const plaza = 'red';\n");
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const log = (await api["run.exec"]!({
      command: "git log --oneline -5",
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(log.stdout, /integrated build/);
    assert.match(log.stdout, /integrate plaza/);
    await assert.rejects(stat(results.started.worktree), "the worker's worktree is removed");
    await assert.rejects(stat(worktree), "the integration worktree is removed");
    // Flipped: the user's window used to be loaded by the show and by the landing,
    // under them. Live now keeps what they opened; the show offered the integrated build and the
    // landing the changed game folder, each on Live's Reload.
    assert.equal(rig.preview.loads.length, liveLoadsBefore, "nothing the run did loaded the user's Live");
    const behind = rig.events
      .filter((e) => e.type === "live.behind")
      .map((e) => (e.payload as { reason: string | null }).reason);
    assert.ok(behind.includes("build"), `the show waits for Reload: ${JSON.stringify(behind)}`);
    assert.equal(behind.at(-1), "changed", `the landing waits for Reload: ${JSON.stringify(behind)}`);
    // The director's own window was on the strip, and closed with the session.
    const screens = rig.events
      .filter((e) => e.type === "preview.screen")
      .map((e) => e.payload as { role: string; state: string; label: string });
    assert.ok(
      screens.some((s) => s.role === "director" && s.state === "opened"),
      JSON.stringify(screens),
    );
    assert.ok(
      screens.some((s) => s.role === "director" && s.state === "closed"),
      `screens: ${JSON.stringify(screens)}`,
    );
    assert.ok(
      typeof results.workerShot !== "string" && results.workerShot.images?.length === 1,
      "the worker's screenshot is a picture",
    );
    assert.ok(
      screens.some((s) => s.role === "builder" && s.label === "Plaza"),
      `the worker's window carried its title: ${JSON.stringify(screens)}`,
    );

    // The whole run, pinned: the tools a web lead is offered, the run's event types in the order
    // they first appear, and the Builds graph's node kinds. Later phases flip these by name.
    assert.deepEqual(
      [...results.tools].sort(),
      [
        // Flipped: a lead may look at an app window (look-only, in every mode).
        "app_look",
        "blender__model",
        "blender__retrieve",
        "blender__status",
        "computer",
        "finish",
        "genex__asset",
        "genex__cli",
        "genex__cli-paid",
        "genex__package",
        "genex__publish",
        "genex__publish-status",
        "genex__skill",
        "goal_update",
        "integrate",
        // Flipped: a lead may run long commands in the background, in its chat's mode.
        "job_start",
        "job_status",
        "job_stop",
        "job_tail",
        "judge",
        "look",
        "note",
        // Flipped: a lead may look for a Genex plugin and show the person its card (and the
        // "Don't wait for me" card), each in the chat its run was started in.
        "offer_dont_wait",
        "plan",
        "playtest",
        "plugins_find",
        "plugins_suggest",
        "run_status",
        "show",
        "worker_mark",
        "worker_start",
        "worker_status",
        "worker_steer",
        "worker_stop",
      ],
      "the web lead's tools",
    );
    // `run_learning` is left out: the learning pass appends it after `run_finished`, so the snapshot
    // taken when `run_finished` lands holds it only when the poll happens to be late.
    assert.deepEqual(
      runEventTypes(events, runId).filter((type) => type !== "run_learning"),
      [
        "run_registered",
        "run_started",
        "autopilot_started",
        "session_activity",
        "autopilot_plan_review",
        "director_verdict",
        "director_worker",
        // Flipped: a builder also leaves the worker records every lead's workers leave.
        "worker_started",
        "autopilot_decision",
        "worker_finished",
        "integration_merge",
        "integration_health",
        "run_interaction_evidence",
        "director_show",
        "completion_call",
        "optimization_updated",
        "run_finished",
      ],
      "the run's event types, in first-appearance order",
    );
    assert.deepEqual(
      buildRunGraph(events)
        ?.nodes.map((node) => node.kind)
        .sort(),
      // Flipped: a run whose builder left worker records is a tree with the lead at its root; it
      // finished, so no finish check waits at its end.
      ["base", "facet", "final", "integration", "lead", "optimization", "run"],
      "the Builds graph's node kinds",
    );
  });

  /**
   * A game with a repository of its own inside it, which the studio was not allowed to version.
   * The merged build runs — it always did — and carries none of the work done inside that folder,
   * and `git status` cannot see the difference, because git does not walk into a gitlink. That is
   * a silent loss: a run's work reported as integrated and made live, and gone.
   * The health pass asks the commit instead, and says so in words the user reads.
   */
  it("fails the health pass on a merge that carries nothing from a repository inside the game", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-nested", { title: "Director nested" });
    // The user's own game, inside the folder they opened: its own repository, a pointer in this one.
    const nested = path.join(project.dir, "wreckage");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "car.js"), "export const car = 'wreck';\n");
    const asSomebody = ["-c", "user.email=you@example.com", "-c", "user.name=You"];
    await git(nested, ["init", "-q"]);
    await git(nested, ["add", "-A"]);
    await git(nested, [...asSomebody, "commit", "-q", "-m", "the game so far"]);
    await git(project.dir, ["add", "wreckage"]);
    await git(project.dir, [...asSomebody, "commit", "-q", "-m", "the game inside the folder"]);

    const results: Record<string, any> = {};
    let brief = "";
    fakeEngine(rig, async (request) => {
      if (request.director) {
        brief = request.prompt;
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.finished = text(await call("finish", { summary: "the plaza is red", land: "yes" }));
        return { ok: true, engine: "codex", turns: 6, usage: {}, sessionId: "director-nested", summary: "run done" };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      // …and a change inside the folder the studio does not version, which no commit will hold.
      await writeFile(path.join(request.cwd, "wreckage", "car.js"), "export const car = 'repaired';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-nested", summary: "painted it" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    // The lead was told where to ask, rather than told a falsehood in either direction. Flipped (one
    // session): a lead that writes nothing is told the health pass says so, not to run git itself.
    assert.match(brief, /NESTED REPOSITORIES: wreckage/, brief.slice(0, 2000));
    assert.match(brief, /a health pass says this build carries nothing from inside it/);
    // The merge happened and the build runs; the health pass fails it anyway, and says why.
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.integrated.health.ok, false, JSON.stringify(results.integrated.health));
    assert.ok(
      (results.integrated.health.problems as string[]).some((p) =>
        /wreckage\/ is the user's own repository and this build carries nothing from inside it/.test(p),
      ),
      JSON.stringify(results.integrated.health.problems),
    );
    const health = customEvents(events, "integration_health").find((e) => e.runId === runId)!;
    assert.equal(health.ok, false);
    // And the card the user reads says what actually happened, not "it did not start".
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((c) => /carries nothing from the folder inside your game that keeps its own history/.test(c)),
      cards.join(" | "),
    );
    assert.ok(!cards.some((c) => /did not start when it was checked/.test(c)), cards.join(" | "));
    // What the run still may do: the folder and this build hold that repository the same way,
    // so landing it is an ordinary merge and the rest of the run's work goes live as usual.
    assert.match(results.finished, /the run is closed — the integrated build [0-9a-f]{10} is live/, results.finished);
    assert.equal(await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), "export const plaza = 'red';\n");
  });

  /**
   * The same folder, with the consent the Open Game sheet records: the
   * fork versions that repository, so an edit inside it is committed, merged and healthy like any
   * other. What the run still may not do is add it to the *user's* history — that renames their
   * own `.git` aside, and belongs to their own button (`landBuild`), not to a merge at 4 a.m.
   */
  it("versions a consented repository inside the game, and leaves the landing of it to the user", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-consented", { title: "Director consented" });
    const nested = path.join(project.dir, "wreckage");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "car.js"), "export const car = 'wreck';\n");
    const asSomebody = ["-c", "user.email=you@example.com", "-c", "user.name=You"];
    await git(nested, ["init", "-q"]);
    await git(nested, ["add", "-A"]);
    await git(nested, [...asSomebody, "commit", "-q", "-m", "the game so far"]);
    // "Keep this folder", as the sheet writes it into the game's own studio.json.
    const meta = JSON.parse(await readFile(path.join(project.dir, "studio.json"), "utf8"));
    await writeFile(
      path.join(project.dir, "studio.json"),
      `${JSON.stringify({ ...meta, versionNested: true }, null, 2)}\n`,
    );
    await git(project.dir, ["add", "wreckage", "studio.json"]);
    await git(project.dir, [...asSomebody, "commit", "-q", "-m", "the game inside the folder"]);

    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "repair the car",
            mode: "single",
            minutes: "5",
            owns: "wreckage/car.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.finished = text(await call("finish", { summary: "the car is repaired", land: "yes" }));
        return {
          ok: true,
          engine: "codex",
          turns: 6,
          usage: {},
          sessionId: "director-consented",
          summary: "run done",
        };
      }
      await writeFile(path.join(request.cwd, "wreckage", "car.js"), "export const car = 'repaired';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-consented", summary: "repaired it" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "repair the car",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "car", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    // The edit inside the folder is ordinary versioned work: merged, and healthy.
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.integrated.health.ok, true, JSON.stringify(results.integrated.health));
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const head = customEvents(events, "run_finished").find((e) => e.runId === runId)!.integrationHead as string;
    const carried = (await api["run.exec"]!({
      command: `git show ${head}:wreckage/car.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(carried.stdout, /repaired/, "the run's work inside that folder is in the build");

    // …and the landing of it is the user's to make, in words that name no branch.
    assert.match(
      results.finished,
      /not landed: wreckage\/ is the user's own repository inside the game folder/,
      results.finished,
    );
    assert.match(results.finished, /make this build live from the outcome card/, results.finished);
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false);
    assert.equal((finished.landingResult as { why: string }).why, "nested-not-versioned");
    const close = customEvents(events, "director_verdict")
      .filter((e) => e.runId === runId)
      .find((e) => e.pass === "close")!;
    assert.match(
      String(close.because),
      /^Nothing was made live: part of this game keeps its own version history/,
      String(close.because),
    );
    assert.equal(
      await readFile(path.join(project.dir, "wreckage", "car.js"), "utf8"),
      "export const car = 'wreck';\n",
      "the user's own folder is untouched",
    );
  });

  it("a session limit ends the director: the head is kept on a ref, nothing is landed, and the run pauses — then the user can play or land any build", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-limit", { title: "Director limit" });
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.status0 = json(await call("run_status", {}));
        await call("plan", planFor("sign"));
        results.started = json(
          await call("worker_start", {
            id: "sign",
            title: "Sign",
            brief: "hang a sign",
            mode: "single",
            minutes: "5",
            owns: "src/sign.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "sign" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "sign" }));
        results.judged = json(await call("judge", { target: "integration", against: "none" }));
        results.status1 = json(await call("run_status", {}));
        // The engine's own limit, as the CLI reports it: a rate limit that resets hours away.
        throw new EngineError(
          "rate_limit",
          "codex",
          "You've hit your session limit · resets 9:50pm (Europe/Belgrade)",
          4 * 3_600_000,
        );
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-2", summary: "hung the sign" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a sign",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "sign", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a limit",
    );

    // The run's tools worked; the base was gated before the worker started.
    assert.equal(results.started.started, "sign", JSON.stringify(results.started));
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged));
    assert.match(results.status1.integration.ref, new RegExp(`refs/studio/runs/${runId}/integration`));
    assert.equal(results.status1.integration.lastJudge?.ok, true, JSON.stringify(results.status1.integration));
    const head: string = results.status1.integration.head;

    // The close: the limit named honestly, the run paused for Resume — and nothing landed (a close
    // on a lost provider cannot have the build checked, and Resume carries it on from its head).
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.equal((finished.landingResult as { why?: string }).why, "paused");
    assert.match(String(finished.stoppedBecause), /session limit/);
    assert.match(String(finished.stoppedBecause), /paused/);
    assert.match(String(finished.stoppedBecause), /nothing was landed/);
    assert.doesNotMatch(String(finished.stoppedBecause), /ran out of time/);
    assert.equal((finished.limit as { kind: string }).kind, "rate_limit");
    // When the limit was hit, so the host's auto-resume counts the reset from then, not from the close.
    const hitAt = (finished.limit as { at?: unknown }).at;
    assert.equal(typeof hitAt, "number", `limit.at: ${JSON.stringify(finished.limit)}`);
    assert.ok((hitAt as number) <= Date.parse(String(finished.finishedAt ?? new Date().toISOString())));
    assert.equal(finished.integrationRef, `refs/studio/runs/${runId}/integration`);
    assert.ok(String(finished.integrationHead).startsWith(head));
    assert.ok(
      customEvents(events, "autopilot_paused").some((e) => e.runId === runId),
      "the run is paused, not done",
    );
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /the engine hit its session limit/.test(d)),
      decisions.join(" | "),
    );
    await assert.rejects(
      readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "the game folder is as the user left it until the run resumes",
    );
    await assert.rejects(
      stat(path.join(rig.core.layout.runs, runId, "director", `close_${head.slice(0, 8)}`, "verdict.json")),
      "the paused close looks at nothing and judges nothing",
    );

    // The ref outlives the worktree: the head is reachable in the game's repo.
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const refs = (await api["run.exec"]!({
      command: `git show-ref refs/studio/runs/${runId}/integration`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(refs.stdout, new RegExp(`^${head}`));

    // After the run, the user plays a build from a copy and lands it — the same calls the chat's tools and the buttons make.
    const loadsBefore = rig.preview.loads.length;
    const [shown, repeated] = await Promise.all([
      rig.core.showBuild(project.name, head),
      rig.core.showBuild(project.name, head),
    ]);
    assert.deepEqual(repeated, shown, "overlapping Play requests share one scratch creation");
    assert.equal(rig.preview.loads.length, loadsBefore + 1, "one navigation for identical concurrent requests");
    await rig.core.showBuild(project.name, head);
    assert.ok(shown.commit.startsWith(head));
    assert.ok(shown.dir.includes(path.join("show", project.name)));
    assert.equal(await readFile(path.join(shown.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");
    assert.ok(rig.preview.loads.length > loadsBefore, "the user's window loaded the build");
    const landed = await rig.core.landBuild(project.name, head);
    assert.notEqual(landed.how, "already", "the paused close had landed nothing; the user's Make it live does");
    assert.equal(await readFile(path.join(project.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");
    await assert.rejects(rig.core.showBuild(project.name, "deadbeef"), /not in/);
    await assert.rejects(rig.core.landBuild(project.name, "nonsense"), /not a commit hash/);
  });
  /**
   * A game from scratch. Until now the run began on the empty scaffold: the fork gate refused
   * every worker ("every camera renders effectively black"), `judge against=start` answered "the
   * other build could not be observed", and the director hand-built the world for twelve minutes
   * before anyone could fork. The studio builds the starting point first now — the same stage the
   * classic pipeline always had — and everything that looks at it knows what it is looking at.
   */
  it("a run from scratch: the studio builds the starting point, workers fork from it, and judging against the start says first build", async () => {
    /** The empty scaffold as a window sees it: nothing drawn, and an inspection that proves it. */
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-scratch", { title: "From scratch" });
    const seen: { director: DelegateRequest[]; base: DelegateRequest[]; workers: DelegateRequest[] } = {
      director: [],
      base: [],
      workers: [],
    };
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      // Before the run's first session of any kind: the snapshots of this game taken so far.
      results.snapshotsAtFirstSession ??= (await rig.core.listAllEvents()).filter(
        (event) => event.data.type === "snapshot_created" && /director starting point/.test(String(event.data.reason)),
      ).length;
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.judged = json(await call("judge", { target: "integration", against: "start" }));
        // Flipped (module contract): plaza is a single session, so the plan has one looping part.
        await call("plan", planWithSingle(["plaza"], "plaza", "sky"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        // A fork from the worker's own commit is gated too — and that one is not a starting point.
        // Flipped (one session): the gate refuses a loop worker; a single one is a lead's repair
        // and starts on a build that does not run.
        results.refusedFork = text(
          await call("worker_start", { id: "sky", brief: "a sky", mode: "loop", from: "plaza" }),
        );
        results.workers = json(await call("worker_status", {}));
        // A single worker is a lead's hands: it starts on that same build, to repair it.
        results.repair = json(
          await call("worker_start", {
            id: "repair",
            title: "Repair",
            brief: "make the plaza draw",
            mode: "single",
            minutes: "5",
            from: "plaza",
            owns: "src/plaza.js",
          }),
        );
        results.finished = text(
          await call("finish", { summary: "the starting point stands; the plaza is next", land: "no" }),
        );
        return {
          ok: true,
          engine: "codex",
          turns: 9,
          usage: {},
          sessionId: "director-scratch",
          summary: "built the world's shape",
        };
      }
      if (path.basename(request.cwd) === "integration") {
        seen.base.push(request);
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "world.js"), "export const world = { groups: ['plaza'] };\n");
        return {
          ok: true,
          engine: "codex",
          turns: 2,
          usage: {},
          sessionId: "base-1",
          summary: "cameras, palette, empty groups",
        };
      }
      seen.workers.push(request);
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return {
        ok: true,
        engine: "codex",
        turns: 3,
        usage: {},
        sessionId: "worker-scratch",
        summary: "painted the plaza red",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza to skate",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished on a fresh scaffold",
    );

    // A web Loop snapshots the game before its first session, whatever that session is.
    assert.equal(results.snapshotsAtFirstSession, 1, "the director's starting snapshot came first");
    // The starting point: one base session, in the run's integration worktree, on the base brief.
    assert.equal(seen.base.length, 1, `one base session, got ${seen.base.length}`);
    assert.match(seen.base[0]!.prompt, /You are building the starting scene/);
    assert.match(seen.base[0]!.prompt, /Do not spend this stage designing a large framework/);
    assert.match(seen.base[0]!.prompt, /PREPARATION BUDGET: 3 minutes/);
    assert.match(seen.base[0]!.prompt, /^You are working inside Genex/, "the base builder is told first who runs it");
    assert.ok(seen.base[0]!.timeoutMs! <= 200_000, "preparation leaves most working time to the lead");
    assert.doesNotMatch(seen.base[0]!.prompt, /0 facets/, "a director's run has no facet roll call");
    assert.ok(
      customEvents(events, "autopilot_base_started").some((e) => e.runId === runId),
      "the graph sees the base while its builder is running",
    );
    const base = customEvents(events, "autopilot_base").find((e) => e.runId === runId)!;
    assert.equal(base.ok, true, JSON.stringify(base));
    assert.equal(base.empty, true, "an empty world with working cameras is a valid starting point");
    assert.equal(typeof base.commit, "string");

    // The director opens on it, knowing what it is.
    assert.equal(seen.director.length, 1);
    assert.match(seen.director[0]!.prompt, /THE STARTING POINT: this game was an empty project/);
    assert.ok(
      seen.director[0]!.prompt.includes(String(base.commit).slice(0, 10)),
      "the brief names the commit it stands on",
    );

    // Judged before anyone builds: observed (blank pixels and all), with nothing to compare it to.
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged.problems));
    assert.equal(results.judged.verdict.firstBuild, true, JSON.stringify(results.judged.verdict));
    assert.match(results.judged.verdict.note, /first build — nothing to compare/);

    // The first worker is accepted — the refusal that used to end a run from scratch is gone.
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.ok(
      String(base.commit).startsWith(results.started.forkedFrom),
      `${results.started.forkedFrom} is the starting point ${base.commit}`,
    );
    assert.equal(
      seen.workers.filter((request) => request.selfCapture?.facetId === "plaza").length,
      1,
      "the worker session ran",
    );
    const plaza = seen.workers.find((request) => request.selfCapture?.facetId === "plaza");
    assert.match(String(plaza?.prompt), /^You are working inside Genex/, "and so is the worker");
    assert.deepEqual(
      [plaza?.worker?.id, plaza?.worker?.title],
      ["plaza", "Plaza"],
      "a single session's builder carries the run's worker grant, which the host honoured",
    );

    // Every other fork is gated as well, and the worker's own build is not a starting point.
    assert.match(results.refusedFork, /does not run/);
    assert.match(results.refusedFork, /from=plaza/);
    assert.match(results.refusedFork, /renders effectively black/);
    assert.deepEqual(
      results.workers.map((w: { id: string }) => w.id),
      ["plaza"],
      "the refused fork left no worker behind",
    );
    // A lead's single worker starts on the build that does not run: repairing it is the job.
    assert.equal(results.repair.started, "repair", JSON.stringify(results.repair));
    assert.ok(
      String(results.started.forkedFrom) !== String(results.repair.forkedFrom),
      "from the worker's own build, not the starting point",
    );

    // Every card the lead wrote reaches the chat as a sentence, with the record beside it.
    const cards = customEvents(events, "autopilot_decision").filter((e) => e.runId === runId);
    assert.ok(cards.length >= 2, "the run wrote decision cards");
    for (const card of cards) {
      assert.equal(card.text, card.decision, "the record itself is unchanged");
      assert.equal(typeof card.plain, "string", JSON.stringify(card));
      assert.doesNotMatch(String(card.plain), /\b[0-9a-f]{7,40}\b|run_[a-z0-9]{6,}|refs\//, String(card.plain));
    }
    assert.ok(
      cards.some((c) => String(c.plain) === "this game is empty, so the studio is building the starting point first"),
      cards.map((c) => c.plain).join(" | "),
    );

    // Nothing landed (the director said so), and the starting point outlives the worktree.
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false);
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const world = (await api["run.exec"]!({
      command: `git show refs/studio/runs/${runId}/integration:src/world.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(world.stdout, /groups: \['plaza'\]/);
  });

  /**
   * The base session that dies mid-file. Its half-written edits used to stay in the integration
   * worktree while the brief told the director it stood on the empty scaffold — and then
   * `integrate` and `playtest` both refused it for uncommitted work it had never made.
   */
  it("a starting point that could not be built leaves nothing half-written behind it", async () => {
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-base-fail", { title: "Base fails" });
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        results.finished = text(await call("finish", { summary: "the starting point did not build", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 3,
          usage: {},
          sessionId: "director-base-fail",
          summary: "carried on",
        };
      }
      if (path.basename(request.cwd) === "integration") {
        // The base builder writes half of the world and its clock runs out.
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "world.js"), "export const world = { groups: [\n");
        return {
          ok: false,
          engine: "codex",
          turns: 1,
          usage: {},
          stopReason: "deadline",
          errorText: "the base session ran out of time",
          summary: "",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-base-fail", summary: "painted it" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza to skate",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a failed base",
    );

    const base = customEvents(events, "autopilot_base").find((e) => e.runId === runId)!;
    assert.equal(base.ok, false, JSON.stringify(base));
    assert.equal(base.commit, null);
    // What the director is told, and what is true of its worktree, are the same thing: the
    // reply carries no "uncommitted edits" note, because there are none.
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.equal(results.started.note, undefined, JSON.stringify(results.started));
    const card = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      card.some((line) => /could not be built/.test(line)),
      card.join(" | "),
    );
  });

  /**
   * A game from scratch on a run with room for a team: the studio builds no starting scene, and
   * the lead lays its contract and crude stubs first.
   */
  it("a run from scratch with room for a team builds no starting scene: the lead's first brief hands it the foundation", async () => {
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 6, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-foundation", { title: "Foundation first" });
    const seen: { director: DelegateRequest[]; others: DelegateRequest[] } = { director: [], others: [] };
    fakeEngine(rig, async (request) => {
      if (!request.director) {
        seen.others.push(request);
        return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "other", summary: "nothing" };
      }
      seen.director.push(request);
      await request.onLiveTool!("finish", { summary: "the foundation is the lead's", land: "no" });
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "director-foundation", summary: "done" };
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a neon street race",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "street race", shots: [] },
      budgets: { wallClockMs: 3 * 60 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished with the foundation left to the lead",
    );
    assert.deepEqual(seen.others, [], "no starting-scene session, nor any other");
    assert.deepEqual(
      customEvents(events, "autopilot_base_started").filter((e) => e.runId === runId),
      [],
      "no starting point is built",
    );
    assert.match(seen.director[0]!.prompt, /THE FOUNDATION IS YOURS/);
    assert.match(seen.director[0]!.prompt, /plan with contract= and vision=/);
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((line) => /the lead lays the foundation first/.test(line)),
      cards.join(" | "),
    );
  });

  /**
   * A game the user brought that never loads the studio contract. Nothing in it can be photographed, checked or compared: `window.__studio` is
   * missing, so every evidence pass reports a build that does not run, the fork gate refuses
   * every builder, and `judge against=start` can only say the other build could not be observed.
   * The run's first step now wires the contract in, inside the run's own worktree, and that
   * commit becomes the "before" every later build is judged against. The folder the user sees is
   * not touched until finish lands the branch.
   */
  it("a game that cannot be judged: the contract is installed first, in the worktree, and that commit is the run's before", async () => {
    /** No window can see a game whose page never installed the contract — live or pooled. */
    const previews: FakePreview[] = [];
    let wired = false;
    const running = {
      version: 1,
      seed: 1,
      frame: 0,
      fps: 60,
      phase: "playing",
      entities: {},
      player: { x: 0, y: 0, z: 0, yaw: 0 },
    };
    const watch = (preview: FakePreview): FakePreview => {
      preview.next = wired ? { ...running } : { __missing: true };
      previews.push(preview);
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => watch(makeFakePreview()) },
    );
    rigs.push(rig);
    watch(rig.preview);
    const contractNowLoads = (): void => {
      wired = true;
      for (const preview of previews) preview.next = { ...running };
    };

    // Somebody's own Vite game: its own entry, its own build, and no call to installStudio.
    const dir = path.join(await tmpDir("studio-unjudgeable-"), "wreckage");
    const build = "mkdir -p dist && cp index.html dist/index.html";
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><title>WRECKAGE</title><script type="module" src="/src/main.ts"></script>\n',
    );
    await writeFile(path.join(dir, "src", "main.ts"), "const scene = {};\nexport { scene };\n");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "wreckage", type: "module", scripts: { build } }),
    );
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({
        name: "wreckage",
        title: "Wreckage",
        createdAt: "",
        contractVersion: 1,
        entry: "dist/index.html",
        main: "src/main.ts",
        build,
        serve: "dist",
        own: true,
        kind: "three-vite",
      }),
    );
    const project = await rig.core.adoptProject(dir);
    assert.equal(project.built, true, "the folder is somebody's own game");
    assert.equal(
      (await rig.core.games.validate(project.name)).contract,
      "missing",
      "and its page never loads the contract",
    );

    const seen: { director: DelegateRequest[]; contract: DelegateRequest[]; workers: DelegateRequest[] } = {
      director: [],
      contract: [],
      workers: [],
    };
    const judgeCalls: string[][] = [];
    const results: Record<string, any> = {};
    fakeEngine(
      rig,
      async (request) => {
        if (request.director) {
          seen.director.push(request);
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
          // What the branch stands on the moment the session opens, and what the user's own
          // folder still holds while it does.
          results.status = json(await call("run_status", {}));
          // Flipped (one session): the branch is the worktree the lead leads, not the folder it sits in.
          const worktree = request.director.root;
          results.subject = await git(worktree, ["log", "-1", "--format=%s"]);
          results.sinceStart = await git(worktree, ["rev-list", "--count", `${results.status.integration.base}..HEAD`]);
          results.wiredAtHead = await git(worktree, ["show", "HEAD:src/main.ts"]);
          results.liveDuringTheLoopRun = await readFile(path.join(project.dir, "src", "main.ts"), "utf8");
          await call("plan", planFor("crumple"));
          results.started = json(
            await call("worker_start", {
              id: "crumple",
              title: "Crash damage",
              brief: "make the crashes crumple",
              mode: "single",
              minutes: "5",
              owns: "src/crumple.ts",
            }),
          );
          // M4.6 — the two refusals a game the user brought earns while a worker is running:
          // a second owner of an entry with no wiring block for them to meet in, and a worker
          // with no seam, which in somebody's own repository means nearly every file in it.
          results.refusedSecondOwner = text(
            await call("worker_start", {
              id: "sky",
              title: "Sky",
              brief: "a sky",
              mode: "single",
              minutes: "5",
              owns: "src/sky.ts",
              owns_main: "yes",
            }),
          );
          results.refusedNoSeam = text(
            await call("worker_start", {
              id: "loose",
              title: "Loose",
              brief: "anything",
              mode: "single",
              minutes: "5",
            }),
          );
          for (let i = 0; i < 30; i++) {
            results.waited = json(await call("wait", { seconds: "5", worker: "crumple" }));
            if (results.waited.status.workers[0]?.state !== "running") break;
          }
          results.integrated = json(await call("integrate", { worker: "crumple" }));
          results.judged = json(await call("judge", { target: "integration", against: "start" }));
          results.finished = text(
            await call("finish", { summary: "the crashes crumple now", land: "yes", victory: "no" }),
          );
          return {
            ok: true,
            engine: "codex",
            turns: 11,
            usage: {},
            sessionId: "director-wreck",
            summary: "wired, built, landed",
          };
        }
        if (request.selfCapture?.facetId === "contract") {
          seen.contract.push(request);
          await writeFile(
            path.join(request.cwd, "src", "main.ts"),
            'import { installStudio } from "./studio.js";\nconst scene = {};\ninstallStudio({ scene, renderer: {}, camera: {}, player: () => ({ x: 0, y: 0, z: 0, yaw: 0 }) });\nexport { scene };\n',
          );
          contractNowLoads();
          return {
            ok: true,
            engine: "codex",
            turns: 4,
            usage: {},
            sessionId: "contract-1",
            summary: "installStudio is called from src/main.ts",
          };
        }
        seen.workers.push(request);
        await writeFile(path.join(request.cwd, "src", "crumple.ts"), "export const crumple = true;\n");
        return {
          ok: true,
          engine: "codex",
          turns: 3,
          usage: {},
          sessionId: "worker-wreck",
          summary: "the panels crumple",
        };
      },
      // The judge: it never sees a label, only the pixels of two builds.
      async (request) => {
        judgeCalls.push((request.messages[0]?.images ?? []).map((image) => image.label ?? ""));
        return {
          engine: "codex",
          model: "fixture",
          stopReason: "stop",
          usage: {},
          message: {
            role: "assistant" as const,
            content: JSON.stringify({
              facets: { works: "A", visuals: "A", feel: "A", play: "A" },
              defects: ["the wing mirror floats"],
              reason: "one build shows more of the street",
            }),
          },
        };
      },
    );

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make the crashes hurt",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "Burnout", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished on an unjudgeable game",
    );

    // One session, on the wiring task alone, in the run's own worktree.
    assert.equal(seen.contract.length, 1, `one contract session, got ${seen.contract.length}`);
    // Flipped (one session): the lead sits in the game folder; the worktree is its grant's root.
    assert.equal(
      seen.contract[0]!.cwd,
      seen.director[0]!.director!.root,
      "in the integration worktree, never the live folder",
    );
    assert.match(seen.contract[0]!.prompt, /making the game "wreckage" judgeable/);
    // The ask is two lines now (M4.2b/M4.6): the studio's own code is already on the page and
    // finds the scene, the camera and the frames; the renderer and the player are what it cannot guess.
    assert.match(seen.contract[0]!.prompt, /Add the two lines to src\/main\.ts \(or a module it imports\)/);
    assert.match(seen.contract[0]!.prompt, /installStudio\(\{ renderer, player \}\)/);
    assert.match(seen.contract[0]!.prompt, /Change nothing else/);

    // Its commit is the run's first, and it is the wiring.
    assert.equal(results.subject, "studio: install contract", `the branch's first commit: ${results.subject}`);
    assert.equal(Number(results.sinceStart), 1, "one commit beyond the game the user brought, and it is that one");
    assert.match(results.wiredAtHead, /installStudio\(/, "the commit carries the wiring");
    assert.match(results.status.integration.head, /^[0-9a-f]{10}$/);
    assert.notEqual(
      results.status.integration.head,
      results.status.integration.base,
      "the branch has moved past what the user had",
    );

    // The director is told what happened, and no longer that its start could not be observed.
    assert.match(seen.director[0]!.prompt, /THE GAME IS JUDGEABLE NOW: it arrived without the studio contract/);
    assert.ok(
      seen.director[0]!.prompt.includes(results.status.integration.head),
      "the brief names the commit it stands on",
    );
    assert.doesNotMatch(seen.director[0]!.prompt, /THE START COULD NOT BE OBSERVED/);
    // (The playbook mentions the fallback by name; only the brief's own block is a heading.)
    assert.doesNotMatch(seen.director[0]!.prompt, /CONTRACT NOT INSTALLED — DO THIS FIRST/);

    // The builder forks from it — the gate that used to refuse every fork on this game.
    assert.equal(results.started.started, "crumple", JSON.stringify(results.started));
    assert.ok(
      results.status.integration.head.startsWith(String(results.started.forkedFrom).slice(0, 10)) ||
        String(results.started.forkedFrom).startsWith(results.status.integration.head),
      `${results.started.forkedFrom} is the contract commit`,
    );
    assert.equal(seen.workers.length, 1, "the builder session ran");
    // M4.6 — a single-session worker carries the seam the director typed all the way to the
    // engine, where the hook (Claude) and the locks (Codex) read it. It used to carry nothing.
    assert.deepEqual(seen.workers[0]!.ownership?.owns, ["src/crumple.ts"], JSON.stringify(seen.workers[0]!.ownership));
    assert.equal(seen.workers[0]!.ownership?.ownsMain, true);
    // …and the two refusals a game of its own earns while somebody is already building in it.
    assert.match(results.refusedSecondOwner, /already owns src\/main\.ts/, results.refusedSecondOwner);
    assert.match(results.refusedSecondOwner, /no FACET WIRING block/, results.refusedSecondOwner);
    assert.match(results.refusedNoSeam, /needs a seam/, results.refusedNoSeam);
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));

    // And `judge against=start` compares two builds that were both looked at.
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged.problems));
    assert.equal(results.judged.verdict.against, "start", JSON.stringify(results.judged.verdict));
    assert.equal(results.judged.verdict.error, undefined, JSON.stringify(results.judged.verdict));
    assert.equal(results.judged.verdict.note, undefined, "there is a before, so nothing excuses the comparison");
    assert.ok(
      ["challenger", "incumbent"].includes(String(results.judged.verdict.pick)),
      JSON.stringify(results.judged.verdict),
    );
    assert.deepEqual(results.judged.verdict.defects, ["the wing mirror floats"], "the judge answered on what it saw");
    const compared = judgeCalls.find(
      (labels) => labels.some((l) => l.startsWith("BUILD A")) && labels.some((l) => l.startsWith("BUILD B")),
    );
    assert.ok(compared, `the judge was shown both builds: ${JSON.stringify(judgeCalls)}`);

    // The live folder was untouched for the whole run, and holds the wiring only after finish landed it.
    assert.doesNotMatch(results.liveDuringTheLoopRun, /installStudio/, "the user's own folder is not edited mid-run");
    assert.match(
      await readFile(path.join(project.dir, "src", "main.ts"), "utf8"),
      /installStudio\(/,
      "the landed build brought it",
    );
    assert.equal(await readFile(path.join(project.dir, "src", "crumple.ts"), "utf8"), "export const crumple = true;\n");
    assert.equal((await rig.core.games.validate(project.name)).contract, "loaded", "the game is judgeable from now on");
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, JSON.stringify(finished.stoppedBecause));

    // And the user was told, in words that name no contract and no commit.
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((line) => /your game doesn't have the studio's connection yet/i.test(line)),
      cards.join(" | "),
    );
    assert.ok(
      cards.some((line) => /your game is connected to the studio now/i.test(line)),
      cards.join(" | "),
    );
  });

  /**
   * The other half of the same step: a session that says it wired the contract in but left a
   * page that still cannot be looked at. The proof is the game answering, never the session's
   * word — so nothing is committed, nothing half-written is left for a builder to fork from,
   * and the director is told, in the brief, that this is its own first job.
   */
  it("a contract session whose page still does not answer commits nothing, and the lead is told to wire it itself", async () => {
    const blind = (preview: FakePreview): FakePreview => {
      preview.next = { __missing: true };
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => blind(makeFakePreview()) },
    );
    rigs.push(rig);
    blind(rig.preview);
    const dir = path.join(await tmpDir("studio-unwired-"), "wreckage");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><title>WRECKAGE</title><script type="module" src="/src/main.js"></script>\n',
    );
    await writeFile(path.join(dir, "src", "main.js"), "const scene = {};\nexport { scene };\n");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "wreckage", type: "module" }));
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({
        name: "wreckage",
        title: "Wreckage",
        createdAt: "",
        contractVersion: 1,
        entry: "index.html",
        main: "src/main.js",
        build: null,
        serve: ".",
        own: true,
        kind: "three-modules",
      }),
    );
    const project = await rig.core.adoptProject(dir);
    const seen: { director: DelegateRequest[] } = { director: [] };
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        // Flipped (one session): the worktree is the build the lead leads, not the folder it sits in.
        results.dirty = await git(request.director.root, ["status", "--porcelain"]);
        await call("plan", planFor("crumple"));
        // Flipped (one session): a loop worker is refused; a single one is how a lead has it wired.
        results.refused = text(
          await call("worker_start", {
            id: "crumple",
            title: "Crash damage",
            brief: "make the crashes crumple",
            mode: "loop",
            minutes: "5",
          }),
        );
        results.finished = text(await call("finish", { summary: "the game still cannot be judged", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 4,
          usage: {},
          sessionId: "director-unwired",
          summary: "nothing to land",
        };
      }
      // It writes a note to itself and calls the job done; the page never installs anything.
      await writeFile(path.join(request.cwd, "NOTES.wiring.md"), "# wiring\nlooked at it\n");
      return {
        ok: true,
        engine: "codex",
        turns: 2,
        usage: {},
        sessionId: "contract-blind",
        summary: "wired it (it says)",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make the crashes hurt",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "Burnout", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      240_000,
      "director run_finished after an unwired contract",
    );

    assert.equal(
      results.dirty,
      "",
      `nothing half-written is left in the worktree; terminal=${JSON.stringify(customEvents(events, "run_finished").find((e) => e.runId === runId))}`,
    );
    assert.match(seen.director[0]!.prompt, /CONTRACT NOT INSTALLED — DO THIS FIRST/);
    // Flipped (the lead builds with its own hands): it adds the two lines itself, in the
    // integration worktree it leads, and commits them.
    assert.match(
      seen.director[0]!.prompt,
      /wire it yourself in the integration worktree — `import \{ installStudio \} from "\.\/studio\.js"`/,
      "and exactly what to do",
    );
    assert.match(seen.director[0]!.prompt, /installStudio\(\{ renderer, player \}\)/, "which is the whole ask");
    assert.match(
      results.refused,
      /does not run/,
      `a fork from a page nobody can see is still refused: ${results.refused}`,
    );
    assert.equal(customEvents(events, "run_finished").find((e) => e.runId === runId)!.landed, false);
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((line) => /the studio could not add its connection to your game/i.test(line)),
      cards.join(" | "),
    );
  });

  it("a worker the director stops keeps its work: no evidence pass, no verdict, no strike, and the round says who stopped it", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-stop", { title: "Director stop" });
    const results: Record<string, any> = {};
    const building: Record<string, boolean> = {};
    const grants: Record<string, DelegateRequest["worker"]> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        // Flipped (module contract): sky is a single session, so the plan has one looping part.
        await call("plan", planWithSingle(["sky"], "plaza", "sky"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            minutes: "10",
            owns: "src/plaza.js",
            done: JSON.stringify([
              {
                what: "the plaza is lit",
                check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
              },
            ]),
          }),
        );
        // Wait until the builder is actually mid-edit — a stop before the build turn would
        // prove nothing about the round it was in.
        for (let i = 0; i < 60 && !building.plaza; i++) await call("wait", { seconds: "1", worker: "plaza" });
        results.building = building.plaza === true;
        results.stopped = text(await call("worker_stop", { id: "plaza", why: "fixing the starting point" }));
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "plaza" }));
        // What the builder had written, read from the worktree before the run tears it down.
        results.onDisk = await readFile(path.join(results.started.worktree, "src", "plaza.js"), "utf8").catch((err) =>
          String(err),
        );
        // A single session stopped the same way: it obeyed, so its record says so too.
        results.startedSky = json(
          await call("worker_start", {
            id: "sky",
            title: "Sky",
            brief: "a dusk sky",
            mode: "single",
            minutes: "10",
            owns: "src/sky.js",
          }),
        );
        for (let i = 0; i < 60 && !building.sky; i++) await call("wait", { seconds: "1", worker: "sky" });
        await call("worker_stop", { id: "sky", why: "the plaza comes first" });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "sky" }));
          if (waited.status.workers.find((w: { id: string }) => w.id === "sky")?.state !== "running") break;
        }
        results.skystatus = json(await call("worker_status", { id: "sky" }));
        results.finished = text(
          await call("finish", { summary: "the plaza needs a starting point first", land: "no" }),
        );
        return {
          ok: true,
          engine: "codex",
          turns: 6,
          usage: {},
          sessionId: "director-stop",
          summary: "stopped the plaza",
        };
      }
      // The worker's build turn: half an edit, then the abort the director sends.
      assert.ok(request.signal, "a delegated build carries the abort signal the director stops it with");
      const who = path.basename(request.cwd);
      grants[who] = request.worker;
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", `${who}.js`), `export const ${who} = 'half-painted';\n`);
      building[who] = true;
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      // Exactly what claude-code reports for an aborted turn: not ok, but not an error either.
      return {
        ok: false,
        engine: "codex",
        turns: 2,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "worker-stopped",
        summary: "half the plaza",
      };
    });

    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const inGame = async (command: string): Promise<string> =>
      (
        (await api["run.exec"]!({ command, project: project.name, timeoutMs: 30_000 })) as { stdout: string }
      ).stdout.trim();
    // What the user's repository looks like the evening before, to compare with the morning.
    const before = {
      branches: await inGame("git branch --format='%(refname:short)'"),
      tags: await inGame("git tag --list"),
    };

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a stopped worker",
    );

    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.equal(results.building, true, "the builder was mid-edit when the director stopped it");
    // A loop builder's build turn is a worker of the run, seated by the host in the chat's mode.
    assert.deepEqual(
      [grants.plaza?.id, grants.plaza?.title],
      ["plaza", "Plaza"],
      "the facet loop's builder carries the run's worker grant",
    );

    // The round: recorded as stopped, with no winner, no board and no shots — nobody looked.
    const rounds = customEvents(events, "facet_iteration").filter((e) => e.runId === runId);
    assert.equal(rounds.length, 1, JSON.stringify(rounds));
    assert.equal(rounds[0]!.verdictSource, "stopped", JSON.stringify(rounds[0]));
    assert.equal(rounds[0]!.winner, null, "a round nobody judged has no winner");
    assert.equal(rounds[0]!.scoreboard, null);
    assert.deepEqual(rounds[0]!.shots, []);
    assert.match(String(rounds[0]!.reason), /stopped by the director: fixing the starting point/);
    assert.equal(rounds[0]!.attemptBranch, `refs/studio/runs/${runId}/attempts/plaza/1-stopped`);
    const stops = customEvents(events, "facet_stopped").filter((e) => e.runId === runId);
    assert.equal(stops.length, 1, JSON.stringify(stops));
    assert.equal(stops[0]!.by, "director");

    // Zero evidence passes for that iteration: the frames of a facet's look land under
    // runs/<run>/facet_<id>/iter_<n>/, and there are none.
    await assert.rejects(
      stat(path.join(rig.core.layout.runs, runId, "facet_plaza", "iter_001")),
      "the stopped round cost no evidence pass",
    );

    // No strike, no rollback, no blame: the loop ended on the stop itself.
    assert.equal(results.wstatus.state, "stopped");
    assert.match(
      results.wstatus.stoppedBecause,
      /^stopped by the director: fixing the starting point/,
      results.wstatus.stoppedBecause,
    );
    assert.match(results.wstatus.stoppedBecause, new RegExp(`refs/studio/runs/${runId}/attempts/plaza/1-stopped`));
    assert.doesNotMatch(results.wstatus.stoppedBecause, /unjudgeable|at the user/);
    assert.equal(results.wstatus.accepted, 0);
    assert.equal(results.wstatus.stoppedRounds, 1, JSON.stringify(results.wstatus));
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /director stopped worker plaza: fixing the starting point/.test(d)),
      decisions.join(" | "),
    );
    assert.ok(!decisions.some((d) => /unjudgeable builds/.test(d)), "no circuit-breaker strike for a stop");

    // The edits are where the director was told they are: still in the worktree, and on a ref.
    assert.equal(results.onDisk, "export const plaza = 'half-painted';\n", results.onDisk);
    assert.match(results.stopped, new RegExp(`refs/studio/runs/${runId}/attempts/plaza/1-stopped`), results.stopped);
    assert.match(results.stopped, /nothing is reset/);
    assert.match(
      await inGame(`git show refs/studio/runs/${runId}/attempts/plaza/1-stopped:src/plaza.js`),
      /half-painted/,
    );

    // …and the morning after, the game's repository looks exactly as the user left it: the
    // run's bookkeeping is all on refs of the studio's own. A first real run left eleven
    // `attempt/*` branches and a `snap/*` tag in somebody's game (M2.7).
    assert.equal(await inGame("git branch --format='%(refname:short)'"), before.branches, "the run added a branch");
    assert.equal(await inGame("git tag --list"), before.tags, "the run added a tag `git push --tags` would ship");
    assert.equal(before.branches, "main");
    assert.equal(before.tags, "");
    const studioRefs = (await inGame("git for-each-ref --format='%(refname)' refs/studio/"))
      .split("\n")
      .filter(Boolean);
    assert.ok(studioRefs.includes(`refs/studio/runs/${runId}/attempts/plaza/1-stopped`), studioRefs.join(" | "));
    assert.ok(
      studioRefs.some((ref) => ref.startsWith("refs/studio/snap/")),
      `the run's own starting-point snapshot: ${studioRefs.join(" | ")}`,
    );
    // One committer, not the five a run used to leave in `git log`.
    const committers = new Set((await inGame("git log --format='%an|%cn'")).split("\n").filter(Boolean));
    assert.deepEqual([...committers], ["AI Game Studio|AI Game Studio"], [...committers].join(" | "));

    // A single session the director stops says the same thing: the engine's "stopped by you"
    // is the engine's word for an abort, not a report about the owner.
    assert.equal(results.skystatus.state, "stopped");
    assert.equal(
      results.skystatus.stoppedBecause,
      "stopped by the director: the plaza comes first",
      JSON.stringify(results.skystatus),
    );

    const workerEvents = customEvents(events, "director_worker").filter(
      (e) => e.runId === runId && e.workerId === "plaza",
    );
    assert.equal(workerEvents.at(-1)!.state, "stopped");
    assert.match(String(workerEvents.at(-1)!.stoppedBecause), /stopped by the director/);
  });

  /**
   * Steering that arrives in a minute (M3.4). A build turn is one long delegation, so a steer
   * used to wait for the next round boundary — fifteen to twenty-three minutes on the first real
   * run, and for one worker it never arrived at all. Worse, a steer the user addressed to a
   * worker was filtered out of the director's own drain and delivered to nobody. Now the turn is
   * interrupted and the same session — everything it has read still in it — carries on with the
   * instruction in front of everything, and an addressed steer takes that path without the
   * director's hop.
   */
  it("a steer that cannot wait interrupts the build turn, and the user's own steer reaches the worker it names", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-steer", { title: "Director steer" });
    const results: Record<string, any> = {};
    const SESSION = "plaza-session";
    const turns: Array<{ at: number; prompt: string; resume: string | null }> = [];
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza",
            minutes: "8",
            owns: "src/plaza.js",
            owns_main: "no",
            done: JSON.stringify([
              {
                what: "the plaza is lit",
                check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
              },
            ]),
          }),
        );
        for (let i = 0; i < 60 && turns.length < 1; i++) await call("wait", { seconds: "1", worker: "plaza" });
        // The director sees the grade while the builder is mid-turn. Waiting for the boundary
        // would spend the whole round on the colour it has just been told is wrong.
        results.steerAt = Date.now();
        results.steered = text(
          await call("worker_steer", {
            id: "plaza",
            text: "the plaza is far too orange — take it greener",
            now: "yes",
          }),
        );
        // While it is still building, the user types into the run and names this worker.
        for (let i = 0; i < 120 && turns.length < 3; i++) await call("wait", { seconds: "1", worker: "plaza" });
        results.queued = text(await call("worker_steer", { id: "plaza", text: "and mind the kerbs" }));
        for (let i = 0; i < 60; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          const line = results.waited.status.workers[0];
          if (line?.state !== "running" || (line?.round ?? 1) > 1) break;
        }
        results.wstatus = json(await call("worker_status", { id: "plaza" }));
        await call("worker_stop", { id: "plaza", why: "one round is enough this run" });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "the plaza is greener than it was", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 9,
          usage: {},
          sessionId: "director-steer",
          summary: "steered the plaza",
        };
      }
      turns.push({ at: Date.now(), prompt: request.prompt, resume: request.resume ?? null });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      // The steer the user sent is the one it acts on — in the session it never left.
      if (/THE USER ASKS: .*greener still/.test(request.prompt)) {
        await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'greener still';\n");
        return { ok: true, engine: "codex", turns: 3, usage: {}, sessionId: SESSION, summary: "greener still" };
      }
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'orange';\n");
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 2,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: SESSION,
        summary: "half a plaza",
      };
    });

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a green plaza",
        project: project.name,
        mode: "autopilot",
        engine: "codex",
        reference: { name: "plaza", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
      })
      .catch(() => {});
    // The user's own steer, addressed to the worker, typed while it is building.
    await waitForLog(rig.core, () => turns.length >= 2, 120_000, "the director's steer to reach the build session");
    const threadId = (await rig.core.store.listThreads()).find(
      (t) => (t.metadata as { project?: string })?.project === project.name,
    )!.id;
    const userSteerAt = Date.now();
    await rig.core.runFeedback({ threadId, runId, facetId: "plaza", text: "make it greener still" });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      240_000,
      "director run_finished after two steers",
    );

    // The director's steer: the turn was interrupted, and the answer says so rather than
    // promising a boundary the round would never reach.
    assert.match(results.steered, /build turn was interrupted and it is carrying on/, results.steered);
    assert.ok(
      turns.length >= 3,
      `three build turns: the first, the director's steer, the user's — ${JSON.stringify(turns.map((t) => t.resume))}`,
    );
    assert.equal(turns[1]!.resume, SESSION, "the same session, not a fresh one");
    assert.match(turns[1]!.prompt, /A STEER ARRIVED WHILE YOU WERE WORKING/);
    assert.match(turns[1]!.prompt, /far too orange — take it greener/);
    assert.match(turns[1]!.prompt, /Continue where you were/);
    assert.ok(
      turns[1]!.at - results.steerAt < 60_000,
      `the steer reached the session in ${turns[1]!.at - results.steerAt}ms`,
    );

    // The user's steer, addressed to the worker: delivered to it, not to nobody.
    assert.equal(turns[2]!.resume, SESSION);
    assert.match(turns[2]!.prompt, /THE USER ASKS: .*make it greener still/);
    assert.ok(
      turns[2]!.at - userSteerAt < 60_000,
      `the user's steer reached the session in ${turns[2]!.at - userSteerAt}ms`,
    );
    const delivered = customEvents(events, "run_steering_delivered").filter(
      (e) => e.runId === runId && e.facetId === "plaza",
    );
    assert.equal(delivered.length, 1, JSON.stringify(delivered));
    assert.equal(delivered[0]!.stage, "now");
    const handed = customEvents(events, "facet_steered").filter((e) => e.runId === runId);
    assert.deepEqual(
      handed.map((e) => e.delivered),
      ["mid-round", "mid-round"],
    );

    // Neither interruption cost the round: it ran on to a verdict, and what the builder wrote
    // after the last steer is what was judged.
    const rounds = customEvents(events, "facet_iteration").filter((e) => e.runId === runId && e.facetId === "plaza");
    assert.equal(rounds[0]!.iteration, 1);
    assert.notEqual(rounds[0]!.verdictSource, "stopped", JSON.stringify(rounds[0]));
    assert.equal(rounds[0]!.winner, "challenger", String(rounds[0]!.reason));
    const accepted = String((rounds[0]!.verdict as { build: { head?: string } }).build.head ?? "");
    assert.match(accepted, /^[0-9a-f]{7,40}$/, "the round it kept has a commit");
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const show = (await api["run.exec"]!({
      command: `git show ${accepted}:src/plaza.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(show.stdout, /greener still/, "the accepted build is the one the steers asked for");

    // A steer that can wait still waits: the default is the top of the next round.
    assert.match(results.queued, /queued for plaza's next round/, results.queued);
    assert.equal(
      results.wstatus.iterationMinutes >= 0,
      true,
      `a measured round: ${JSON.stringify(results.wstatus.iterationMinutes)}`,
    );
  });

  /**
   * The other half of the same fix (M3.4): a single session used to be refused a steer outright
   * — "wait for it, or stop it and start another with the instruction in its brief" — because
   * there was no round boundary to queue one against. Interrupt-and-resume needs no boundary, so
   * a single session is steered like anything else, and always now.
   */
  it("a single session interrupted with no steer left to hand it carries on instead of failing", async () => {
    // Two steers in quick succession: the first interrupt's resume already took both, so the
    // second interrupt cuts a turn that has nothing new to hear. That turn used to end the worker.
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-empty-interrupt", { title: "Director empty interrupt" });
    const results: Record<string, any> = {};
    const turns: Array<{ prompt: string; resume: string | null }> = [];
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sky"));
        await call("worker_start", {
          id: "sky",
          title: "Sky",
          brief: "a dusk sky",
          mode: "single",
          minutes: "5",
          owns: "src/sky.js",
        });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "2", worker: "sky" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "sky" }));
        await call("finish", { summary: "the sky is done", land: "no" });
        return { ok: true, engine: "codex", turns: 3, usage: {}, sessionId: "director-empty", summary: "done" };
      }
      turns.push({ prompt: request.prompt, resume: request.resume ?? null });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
      if (turns.length > 1)
        return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "sky-session", summary: "blue" };
      // The late interrupt: nothing is waiting in the worker's queue when it lands.
      setImmediate(() => void api["engine.interrupt"]!({ cwd: request.cwd }));
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 1,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "sky-session",
        summary: "half a sky",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished after an empty interrupt",
    );

    assert.equal(turns.length, 2, `the session was resumed: ${JSON.stringify(turns.map((t) => t.resume))}`);
    assert.equal(turns[1]!.resume, "sky-session", "the same session carries on");
    assert.equal(results.wstatus.state, "done", JSON.stringify(results.wstatus));
  });

  it("a single session is steered too: no boundary to wait for, so the steer is handed over at once", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-steer-single", { title: "Director steer single" });
    const results: Record<string, any> = {};
    const turns: Array<{ prompt: string; resume: string | null }> = [];
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sky"));
        await call("worker_start", {
          id: "sky",
          title: "Sky",
          brief: "a dusk sky",
          mode: "single",
          minutes: "5",
          owns: "src/sky.js",
        });
        for (let i = 0; i < 60 && turns.length < 1; i++) await call("wait", { seconds: "1", worker: "sky" });
        // No `now`: a single session has no next round, so this is the only delivery there is.
        results.steered = text(
          await call("worker_steer", { id: "sky", text: "the sky is too purple — pull it back to blue" }),
        );
        results.movedToo = text(await call("worker_steer", { id: "sky", move: "the sky has stars" }));
        for (let i = 0; i < 60 && turns.length < 2; i++) await call("wait", { seconds: "1", worker: "sky" });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "sky" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "sky" }));
        results.finished = text(await call("finish", { summary: "the sky came back to blue", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 5,
          usage: {},
          sessionId: "director-single-steer",
          summary: "steered the sky",
        };
      }
      turns.push({ prompt: request.prompt, resume: request.resume ?? null });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      if (/back to blue/.test(request.prompt)) {
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
        return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "sky-session", summary: "blue" };
      }
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'purple';\n");
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 1,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "sky-session",
        summary: "a purple sky",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished after steering a single session",
    );

    assert.doesNotMatch(results.steered, /cannot be steered/, results.steered);
    assert.match(results.steered, /sky's build turn was interrupted and it is carrying on/, results.steered);
    assert.equal(
      turns.length,
      2,
      `the session was resumed, not restarted: ${JSON.stringify(turns.map((t) => t.resume))}`,
    );
    assert.equal(turns[1]!.resume, "sky-session");
    assert.match(turns[1]!.prompt, /A STEER ARRIVED WHILE YOU WERE WORKING/);
    assert.match(turns[1]!.prompt, /too purple — pull it back to blue/);
    // A ladder is the loop's, and saying so is not the same as refusing to steer at all.
    assert.match(results.movedToo, /no ladder to add a move to/, results.movedToo);
    assert.equal(results.wstatus.state, "done", JSON.stringify(results.wstatus));
    assert.equal(
      customEvents(events, "facet_steered").filter((e) => e.runId === runId && e.delivered === "mid-session").length,
      1,
    );
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const show = (await api["run.exec"]!({
      command: `git show ${results.wstatus.lastCommit}:src/sky.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(show.stdout, /blue/, "what it committed is what the steer asked for");
  });

  /**
   * One head. The director edits in its own worktree and commits — and `integrationHead` used
   * to move only on `integrate`, so the judge, the close's health pass and the merge could each
   * be talking about a different build. The first real run committed a grade fix at 17:54,
   * judged it ("grounded daylight? yes"), hit its session limit — and `git fsck` found that
   * commit unreachable in the morning while the report said the judge had passed what landed.
   */
  it("a commit the director makes with its own hands becomes the head that is judged, closed and landed", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-head", { title: "Director head" });
    const results: Record<string, any> = {};
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        // The wrap-up session the harness offers when a director stops without finishing.
        if (++sessions > 1)
          return {
            ok: true,
            engine: "codex",
            turns: 1,
            usage: {},
            sessionId: "director-wrap",
            summary: "nothing left to do",
          };
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sign"));
        results.started = json(
          await call("worker_start", {
            id: "sign",
            title: "Sign",
            brief: "hang a sign",
            mode: "single",
            minutes: "5",
            owns: "src/sign.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "sign" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "sign" }));
        // What the director does for itself: a fix quicker to make than to delegate, committed.
        await writeFile(path.join(request.cwd, "src", "haze.js"), "export const haze = 0.38;\n");
        await git(request.cwd, ["add", "-A"]);
        await git(request.cwd, [
          "-c",
          "user.name=AI Game Studio",
          "-c",
          "user.email=studio@ai-game-studio.local",
          "commit",
          "-q",
          "-m",
          "director: haze peak 0.62 to 0.38",
        ]);
        results.ownCommit = await git(request.cwd, ["rev-parse", "HEAD"]);
        results.status = json(await call("run_status", {}));
        results.judged = json(await call("judge", { target: "integration", against: "none" }));
        return {
          ok: true,
          engine: "codex",
          turns: 8,
          usage: {},
          sessionId: "director-head",
          summary: "fixed the haze",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-head", summary: "hung the sign" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a lit plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      // Flipped (one session): a director's own commit is the long turn's: a waking lead writes nothing.
      directorLoop: "turn",
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    const head: string = results.ownCommit;
    assert.ok(head && head !== results.integrated.head, "the director's commit is past the last merge");
    assert.equal(
      results.status.integration.head,
      head.slice(0, 10),
      "the next tool call sees what the director committed",
    );
    assert.equal(results.judged.head, head, "the judge names the sha it looked at");

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(finished.integrationHead, head, "the close landed the head it observed, not the last merge");
    // The close's own verdict, filed under the sha it looked at — the join key for both.
    const verdict = JSON.parse(
      await readFile(
        path.join(rig.core.layout.runs, runId, "director", `close_${head.slice(0, 8)}`, "verdict.json"),
        "utf8",
      ),
    );
    assert.equal(verdict.head, head);
    assert.equal(verdict.ok, true);
    // Both files are live: the worker's merge and the director's own commit on top of it.
    assert.equal(await readFile(path.join(project.dir, "src", "haze.js"), "utf8"), "export const haze = 0.38;\n");
    assert.equal(await readFile(path.join(project.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");

    // And the landing claims only what happened: nobody compared this build with anything.
    const landing = finished.landingResult as { ok: boolean; how: string; verified: boolean; line: string };
    assert.equal(landing.ok, true);
    assert.equal(landing.verified, false, "a health pass is not a judge's preference");
    assert.equal(landing.how, "fresh-health-pass");
    assert.equal(landing.line, "made live, not judged better");
    assert.doesNotMatch(String(finished.stoppedBecause), /the judge had passed it/);
    assert.match(String(finished.stoppedBecause), /landed \(fresh-health-pass\)/);
  });

  /**
   * The user's own evening, in the folder the run was going to land in. Landing merged
   * `--no-ff` into their branch and, when that conflicted, ran `git reset --hard` onto the run's
   * head — the studio throwing away commits nobody asked it to touch, in somebody's own
   * repository. Now the conflict is an answer: nothing is forced,
   * the build waits on its ref, and the close says why in words the user reads.
   */
  it("a landing that conflicts with the user's own commits lands nothing and leaves their branch exactly as it was", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-conflict", { title: "Director conflict" });
    const results: Record<string, any> = {};
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        if (++sessions > 1)
          return {
            ok: true,
            engine: "codex",
            turns: 1,
            usage: {},
            sessionId: "director-wrap",
            summary: "nothing left to do",
          };
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sign"));
        await call("worker_start", {
          id: "sign",
          title: "Sign",
          brief: "hang a sign",
          mode: "single",
          minutes: "5",
          owns: "src/sign.js",
        });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "sign" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "sign" }));
        // The user's evening: they wrote the same file, in their own folder, under their own
        // name, while the run worked in its worktree.
        await writeFile(path.join(project.dir, "src", "sign.js"), "export const sign = 'closed for repairs';\n");
        await git(project.dir, ["add", "-A"]);
        await git(project.dir, [
          "-c",
          "user.name=Simeon",
          "-c",
          "user.email=me@example.com",
          "commit",
          "-q",
          "-m",
          "mine: the sign says closed",
        ]);
        results.userHead = await git(project.dir, ["rev-parse", "HEAD"]);
        results.finished = text(await call("finish", { summary: "the sign is up", land: "yes" }));
        return {
          ok: true,
          engine: "codex",
          turns: 6,
          usage: {},
          sessionId: "director-conflict",
          summary: "hung the sign",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-conflict", summary: "hung the sign" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a lit plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a conflicting landing",
    );

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    const landing = finished.landingResult as { ok: boolean; how: string; line: string };
    assert.equal(landing.ok, false);
    assert.equal(landing.line, "nothing was made live");
    // The lead is told what happened in git's own terms; the user gets the close verdict's
    // sentence, which never mentions a merge.
    assert.match(
      results.finished,
      /not landed: merge into the live folder conflicted with changes of your own/,
      results.finished,
    );
    const close = (finished.verdicts as Array<{ pass: string; because: string }>).find((v) => v.pass === "close")!;
    assert.equal(
      close.because,
      "Nothing was made live: your game folder had changes of its own, so this build was left beside it.",
    );

    // The user's branch: their commit, their file, no merge in flight, nothing reset.
    assert.equal(await git(project.dir, ["rev-parse", "HEAD"]), results.userHead, "the run moved the user's branch");
    assert.equal(
      await readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "export const sign = 'closed for repairs';\n",
    );
    assert.equal(await git(project.dir, ["status", "--porcelain"]), "", "no half-merged tree left behind");
    assert.equal(await git(project.dir, ["log", "-1", "--format=%an"]), "Simeon");

    // And the build is not lost: it is on the run's ref, for "Make it live" to land once the
    // folder is theirs to merge into.
    const onRef = await git(project.dir, ["rev-parse", `refs/studio/runs/${runId}/integration`]);
    assert.equal(onRef, finished.integrationHead, "the integrated build is still reachable");
    assert.match(await git(project.dir, ["show", `${onRef}:src/sign.js`]), /open/);
  });

  /**
   * The run the user quits the app on (or the Mac loses power). The next boot closes the run
   * as PAUSED, with the head it reached and the ref that keeps it reachable, so the chat can
   * offer the build; and the resumed run lands what the first one merged. Before this, the
   * boot repair gated its pause on `mode` — a director's run is registered "autopilot" and
   * started "director" — so the run was closed dead, and a resumed director called its fork
   * point "the starting point", answering `finish land=yes` with "nothing beyond the starting
   * point" while eight merges sat on a ref nobody was shown.
   */
  for (const interruption of ["restart", "stop-queue"] as const)
    it(
      interruption === "restart"
        ? "a run the app died inside pauses with its head, and the resumed run lands what it merged"
        : "Stop interrupts a live director and sends its queued instruction with the same plan and integration head",
      async () => {
        const rig = await startRig(
          { replies: [] },
          { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
        );
        rigs.push(rig);
        const project = await rig.core.games.scaffold("director-resume", { title: "Director resume" });
        const results: Record<string, any> = {};
        const prompts: string[] = [];
        let sessions = 0;
        // Quitting the app takes the whole process: the harness child and the delegation it was
        // waiting on. This rig outlives its harness, so the director's session is released by hand
        // at the same moment the child is killed.
        let quit = () => {};
        const appQuit = new Promise<void>((resolve) => {
          quit = resolve;
        });
        fakeEngine(rig, async (request) => {
          // After the pause the chat's own session answers, in the game folder, with the paused
          // run's resume bridged in: it records the resume, and the studio resumes the run when
          // its reply ends.
          if (!request.director && request.liveTools?.some((tool) => tool.name === "run_status")) {
            results.afterLoopRun = request;
            assert.match(request.prompt, /PAUSED/);
            assert.match(request.prompt, /Keep going and land the saved sign/);
            assert.deepEqual(
              (request.interviewTools ?? []).map((tool) => tool.name),
              ["resume_run"],
            );
            return {
              ok: true,
              engine: "codex",
              turns: 1,
              usage: {},
              sessionId: "chat-after-pause",
              summary: "Continuing the saved plan.",
              studioToolCalls: [{ name: "resume_run", args: { text: "Keep going and land the saved sign" } }],
            };
          }
          if (request.director) {
            prompts.push(request.prompt);
            const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
            if (++sessions === 1) {
              await call("plan", planFor("sign"));
              results.started = json(
                await call("worker_start", {
                  id: "sign",
                  title: "Sign",
                  brief: "hang a sign",
                  mode: "single",
                  minutes: "5",
                  owns: "src/sign.js",
                }),
              );
              for (let i = 0; i < 30; i++) {
                results.waited = json(await call("wait", { seconds: "5", worker: "sign" }));
                if (results.waited.status.workers[0]?.state !== "running") break;
              }
              results.integrated = json(await call("integrate", { worker: "sign" }));
              results.judged = json(await call("judge", { target: "integration", against: "none" }));
              // The real Stop signal releases this session; the restart case kills its harness first.
              if (interruption === "stop-queue") {
                if (request.signal?.aborted) quit();
                else request.signal?.addEventListener("abort", quit, { once: true });
              }
              await appQuit;
              return {
                ok: false,
                engine: "codex",
                turns: 4,
                usage: {},
                stopReason: "stopped",
                errorText: "the app quit",
                summary: "",
              };
            }
            results.status2 = json(await call("run_status", {}));
            results.finished2 = text(await call("finish", { summary: "landing what last run merged", land: "yes" }));
            return {
              ok: true,
              engine: "codex",
              turns: 3,
              usage: {},
              sessionId: "director-resumed",
              summary: "landed the run's work",
            };
          }
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
          return {
            ok: true,
            engine: "codex",
            turns: 2,
            usage: {},
            sessionId: "worker-resume",
            summary: "hung the sign",
          };
        });

        const runId = rig.core.newRunId();
        void rig.core
          .dispatchRun({
            runId,
            goal: "a sign",
            project: project.name,
            mode: "autopilot",
            engine: "codex",
            reference: { name: "sign", shots: [] },
            budgets: { wallClockMs: 30 * 60_000 },
          })
          .catch(() => {});
        await waitForLog(rig.core, () => Boolean(results.judged), 120_000, "the first session's merge and judge");
        const head: string = results.integrated.head;
        const threadId = (await rig.core.store.listThreads()).find(
          (t) => (t.metadata as { project?: string })?.project === project.name,
        )!.id;

        if (interruption === "restart") {
          // Cmd+Q at 2am: the harness dies mid-run, the director's session with it.
          await rig.core.host.stop();
          quit();
          await new Promise((resolve) => setTimeout(resolve, 500));
          await rig.core.start();
        } else {
          await rig.core.sendUserMessage("Keep going and land the saved sign", {
            thread: threadId,
            engine: "codex",
            reviewPlan: true,
          });
          assert.equal(sessions, 1, "no second session answers a follow-up while the first director is building");
          const sent = await rig.core.store.listEvents(threadId);
          assert.equal(customEvents(sent, "coordinator_message_queued").length, 1);
          // Live chat: handed to the lead, whose first turn cannot be cut short to read it.
          assert.deepEqual(
            customEvents(sent, "coordinator_message_delivered").map((e) => [e.into, e.how]),
            [[runId, "lead"]],
          );
          await rig.core.stopThread(threadId);
        }
        const paused = await waitForLog(
          rig.core,
          (log) => customEvents(log, "autopilot_paused").some((e) => e.runId === runId),
          30_000,
          "autopilot_paused",
        );

        const closure = customEvents(paused, "run_finished").find((e) => e.runId === runId)!;
        if (interruption === "restart") assert.equal(closure.stoppedBecause, "interrupted by restart");
        else assert.match(String(closure.stoppedBecause), /stopped by the user/);
        assert.equal(closure.landed, false, "an interrupted run landed nothing, and says so");
        assert.ok(
          String(closure.integrationHead).startsWith(head),
          `${String(closure.integrationHead)} is the head the run reached (${head})`,
        );
        assert.equal(closure.integrationRef, `refs/studio/runs/${runId}/integration`);
        assert.notEqual(
          closure.integrationHead,
          closure.baseCommit,
          "the Play this build / Make it live card has a build to offer",
        );
        if (interruption === "restart") {
          assert.equal(
            ((await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as { phase?: string }).phase,
            "paused",
          );
          // An ordinary message resumes the saved run; no Resume button or fresh plan.
          await rig.core.sendUserMessage("Keep going and land the saved sign", { thread: threadId, engine: "codex" });
        }
        const after = await waitForLog(
          rig.core,
          (log) =>
            Boolean(results.finished2) &&
            customEvents(log, "run_finished").some((e) => e.runId === runId && e.landed === true),
          120_000,
          "the resumed run's closure and finish reply",
        );

        assert.equal(sessions, 2, "one resumed session");
        assert.equal(results.afterLoopRun?.coordinator, undefined, "the chat's own session resumed it, no coordinator");
        assert.notEqual(results.afterLoopRun?.readOnly, true);
        if (interruption === "stop-queue")
          assert.equal(
            customEvents(after, "coordinator_message_requeued").length,
            1,
            "the lead never heard it: Stop gave it back to the chat, which resumed the run with it",
          );
        assert.ok(
          customEvents(after, "run_steering").some(
            (e) => e.runId === runId && e.text === "Keep going and land the saved sign",
          ),
          "new guidance is saved before resumed builders start",
        );
        assert.match(prompts[1]!, /YOU WERE RESUMED/);
        assert.match(
          prompts[1]!,
          /THE USER SAYS[^\n]*\n- Keep going and land the saved sign/,
          "the resumed lead is told the instruction the chat resumed it with",
        );
        assert.match(
          prompts[1]!,
          /2 commits beyond the starting point/,
          "the resumed brief counts what is there to land (the worker's commit and its merge)",
        );
        assert.notEqual(
          results.status2.integration.head,
          results.status2.integration.base,
          "the resumed run knows the branch is ahead of the base",
        );
        assert.match(
          results.finished2,
          /the run is closed — the integrated build [0-9a-f]{10} is live/,
          results.finished2,
        );

        const landed = customEvents(after, "run_finished")
          .filter((e) => e.runId === runId)
          .at(-1)!;
        assert.equal(landed.landed, true, String(landed.stoppedBecause));
        assert.ok(String(landed.integrationHead).startsWith(head), "it landed the head the first session left");
        assert.notEqual(
          landed.integrationHead,
          landed.baseCommit,
          "the base is the run's own starting point, not last session's fork point",
        );
        assert.equal(
          await readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
          "export const sign = 'open';\n",
          "the first session's merge is live",
        );
        const landing = landed.landingResult as { verified: boolean; how: string; line: string };
        assert.equal(landing.verified, false, "nobody preferred it to anything — the morning says so");
        assert.equal(landing.line, "made live, not judged better");
        // The close looks for itself before it lands (M4.10) — `finish land=yes` used to land
        // whatever HEAD was — so the fresh pass is what this landing rests on. Last run's judge
        // survived the crash all the same: it is on the resumed session's run_status, where it is
        // the other half of the landing rule for a build the close could not photograph.
        assert.equal(landing.how, "fresh-health-pass", "the close took its own look at the head it landed");
        assert.ok(results.status2.integration.lastJudge, "last run's judge survived the crash in the journal");
        assert.ok(
          String(head).startsWith(String(results.status2.integration.lastJudge.head)),
          `${JSON.stringify(results.status2.integration.lastJudge)} is about the head the first session left (${head})`,
        );
      },
    );

  /**
   * A start nobody could photograph. The run began on a game that draws a black frame (not an
   * empty scaffold, which is allowed to be blank): there is no "before" to compare with. The
   * director used to be told nothing and answered `judge against=start` with "the other build
   * could not be observed", once per judge call it wasted.
   */
  it("a start nobody could photograph is said once: the brief warns, and judge against=start answers instead of failing", async () => {
    // The game folder itself — the run's "before" — draws nothing at all, in whichever window
    // it is photographed (the harness's own stand-in, not the user's Live); a build of the run
    // in a worktree draws as usual.
    const blindAtStart = (preview: FakePreview): FakePreview => {
      const lit = preview.pixelStatsNext;
      const black = { ...lit, meanLuma: 0, litFraction: 0 };
      Object.defineProperty(preview, "pixelStatsNext", {
        get: () => (preview.loadRoot === null ? black : lit),
        set: () => {},
      });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => blindAtStart(makeFakePreview()) },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-blind", { title: "Director blind" });
    const results: Record<string, any> = {};
    const prompts: string[] = [];
    fakeEngine(rig, async (request) => {
      if (request.director) {
        prompts.push(request.prompt);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.judged = json(await call("judge", { target: "integration", against: "start" }));
        results.finished = text(await call("finish", { summary: "there is nothing to compare this with", land: "no" }));
        return { ok: true, engine: "codex", turns: 3, usage: {}, sessionId: "director-blind", summary: "looked" };
      }
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "none", summary: "" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make it visible",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    assert.match(prompts[0]!, /THE START COULD NOT BE OBSERVED/, "the brief says so before the first call is spent");
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged.problems));
    assert.equal(results.judged.verdict.pick, null);
    assert.match(String(results.judged.verdict.note), /no start evidence: the starting build rendered black/);
    assert.doesNotMatch(
      JSON.stringify(results.judged.verdict),
      /could not be observed/,
      "a sentence the director can act on, not a failure",
    );

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false);
    assert.equal((finished.landingResult as { how: string; line: string }).how, "not-landed");
    assert.equal((finished.landingResult as { line: string }).line, "nothing was made live");
  });

  /**
   * The blind build turn. `wait` wakes on notes, and between "worker started" and "iteration 1"
   * nothing wrote one: a director asking for news was told "nothing yet" while every worker was
   * editing files it did not own, and found out only afterwards. Now the studio looks into each running worker's worktree
   * itself, with the reviewer it already has, and says what changed.
   */
  it("looks into a running worker's worktree: an edit outside its own files wakes the director's wait, once", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-monitor", { title: "Director monitor" });
    const results: Record<string, any> = {};
    const monitorCommands: unknown[] = [];
    const sandboxRun = rig.core.sandbox.run.bind(rig.core.sandbox);
    rig.core.sandbox.run = async (request) => {
      try {
        const result = await sandboxRun(request);
        if (request.label?.includes(":monitor:"))
          monitorCommands.push({
            command: request.command,
            code: result.code,
            stdout: result.stdout.slice(0, 2000),
            stderr: result.stderr.slice(0, 2000),
          });
        return result;
      } catch (error) {
        if (request.label?.includes(":monitor:"))
          monitorCommands.push({ command: request.command, error: String(error) });
        throw error;
      }
    };
    let building = false;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            minutes: "4",
            owns: "src/plaza.js",
            owns_main: "no",
            done: JSON.stringify([
              {
                what: "the plaza is lit",
                check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
              },
            ]),
          }),
        );
        // The director's own loop: wait, and read what happened. Nothing else wakes it here —
        // the builder never finishes its turn, so there is no iteration and no judge.
        const violation = /outside this facet's ownership \(src\/sky\.js\)/;
        for (let i = 0; i < 10; i++) {
          results.waited = json(await call("wait", { seconds: "15", worker: "plaza" }));
          if ((results.waited.happened as string[]).some((h) => violation.test(h))) break;
        }
        results.status = json(await call("run_status", {}));
        // The same violation is not news twice: two more looks pass in silence.
        results.again = json(await call("wait", { seconds: "40", worker: "plaza" }));
        results.stopped = text(await call("worker_stop", { id: "plaza", why: "it is editing the sky" }));
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "the plaza went wandering", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 8,
          usage: {},
          sessionId: "director-monitor",
          summary: "watched the plaza",
        };
      }
      // The builder: its own module, and one that belongs to nobody here. Then it works on,
      // as a real forty-minute turn does, until the director pulls it off.
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
      building = true;
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 2,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "worker-monitor",
        summary: "half a plaza",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished after the monitor spoke",
    ).catch(async (error: Error) => {
      const log = await rig.core.listAllEvents();
      const lifecycle = log
        .filter((e) => e.data.type === "custom" && /error|finished|stopped|failed/.test(e.data.event_type))
        .slice(-12)
        .map((e) => e.data);
      error.message += `\nMonitor diagnostics: ${JSON.stringify({ building, results, monitorCommands, lifecycle })}`;
      throw error;
    });

    assert.equal(building, true, "the builder was mid-turn the whole time");
    // The note: which worker, how long it has been in this round, and what the reviewer saw.
    const spoke = (results.waited.happened as string[]).filter((h) => /^worker plaza: \d+ min into round 1/.test(h));
    assert.equal(spoke.length, 1, JSON.stringify({ building, results, monitorCommands }));
    assert.match(spoke[0]!, /edited a file outside this facet's ownership \(src\/sky\.js\)/);
    assert.match(spoke[0]!, /touched .*src\/plaza\.js/);
    // …and the wait it woke carries the same three facts as a line, for every worker.
    const line = results.waited.status.workers[0];
    assert.equal(line.id, "plaza");
    assert.equal(line.round, 1);
    assert.ok(line.filesChanged >= 2, JSON.stringify(line));
    assert.deepEqual(line.violations, ["edited a file outside this facet's ownership (src/sky.js)"]);
    assert.equal(typeof line.minutesInRound, "number");
    // The status blob has it too, so the director never has to ask twice for what it just read.
    assert.deepEqual(results.status.workers[0].violations, line.violations);
    // A wait answers with the news and a line per worker — not the whole run's status.
    assert.ok(
      JSON.stringify(results.waited.status).length * 2 < JSON.stringify(results.status).length,
      `wait ${JSON.stringify(results.waited.status).length} vs run_status ${JSON.stringify(results.status).length}`,
    );
    assert.ok(!JSON.stringify(results.waited.status).includes(results.started.worktree), "no worktree paths in a wait");
    // Nothing changed in the worktree since, so nothing was said again: the director keeps its turn.
    assert.deepEqual(
      (results.again.happened as string[]).filter((h) => /outside this facet's ownership/.test(h)),
      [],
      JSON.stringify(results.again.happened),
    );
  });

  /**
   * Nothing the run made is lost with the worktree it was made in. A worker's worktree is
   * detached, so every commit nobody integrated was unreferenced the moment the close removed
   * it: in one morning's repo `git for-each-ref --contains` was empty for the very shas the
   * report named as the workers' `lastCommit`, and git would have collected them.
   */
  it("a plan the user asked to review holds the first worker until they say go — and the restart it names is the same part", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-review", { title: "Director review" });
    const runId = rig.core.newRunId();
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.brief = request.prompt;
        results.planned = text(await call("plan", planFor("plaza")));
        // The user reads the card in their chat and says the one word. It lands in the run's
        // inbox exactly as the coordinator's steering does.
        await rig.core.runFeedback({ threadId: await rig.core.threadForGame(project.name), runId, text: "go" });
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        // The plaza is restarted: the same part, a second builder. Nothing waits this time —
        // the window closed the moment the user answered.
        results.restarted = json(
          await call("worker_start", {
            id: "plaza2",
            title: "Plaza again",
            brief: "paint the plaza red, properly",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
            replaces: "plaza",
          }),
        );
        results.badRestart = text(
          await call("worker_start", { id: "gone", brief: "nothing to continue", mode: "single", replaces: "nobody" }),
        );
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza2" }));
          if (waited.status.workers.find((w: { id: string }) => w.id === "plaza2")?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "the plaza is red", land: "no" }));
        return { ok: true, engine: "codex", turns: 7, usage: {}, sessionId: "director-review", summary: "run done" };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-review", summary: "painted it" };
    });

    // `reviewPlan` rides on the run the harness builds (loop/main.ts writes it from the
    // composer's tick); the dispatch carries the run through untouched.
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      reviewPlan: true,
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    assert.match(results.brief, /THE USER ASKED TO READ IT FIRST/, "the lead is told the run is holding for them");
    assert.match(results.planned, /waits for their word — up to \d+ min/, results.planned);
    const planCard = customEvents(events, "autopilot_plan_review").find((e) => e.runId === runId)!;
    assert.ok(
      Number(planCard.waitMinutes) > 0,
      `the card says how long it waits: ${JSON.stringify(planCard.waitMinutes)}`,
    );
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /plan review: the user said go/.test(d)),
      decisions.join(" | "),
    );
    assert.equal(
      decisions.filter((d) => /^plan review:/.test(d)).length,
      1,
      "the window closes once; the second worker never waits again",
    );
    // The restart is the same part, and only a part of this run can be continued.
    assert.equal(results.restarted.started, "plaza2", JSON.stringify(results.restarted));
    assert.match(results.badRestart, /replaces: no worker "nobody"/, results.badRestart);
    const cards = customEvents(events, "director_worker").filter((e) => e.runId === runId);
    assert.equal(cards.find((e) => e.workerId === "plaza2" && e.state === "running")?.replaces, "plaza");
    assert.equal(
      cards.find((e) => e.workerId === "plaza" && e.state === "running")?.replaces,
      undefined,
      "a first attempt continues nothing",
    );
    // What the Builds page then draws for those two builders is one part: run-graph.test.ts.
  });

  /**
   * The other ending. A user who answers the plan with anything but "go" has still read it, and
   * their words outrank it — but the hold used to stay armed, so the next worker_start blocked
   * another four-minute slice and answered "the user asked to read the plan first and has not
   * answered yet", a minute after the studio had told the lead they answered. Fifteen minutes of
   * a run could go that way, on two contradictory sentences.
   */
  it("a plan the user answers with their own words releases the hold too, and says so once", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-answered", { title: "Director answered" });
    const runId = rig.core.newRunId();
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        await rig.core.append(
          [
            {
              type: "custom",
              event_type: "run_steering",
              payload: { runId, text: "make the benches oak", at: new Date().toISOString() },
            },
          ],
          await rig.core.threadForGame(project.name),
        );
        const start = {
          id: "plaza",
          title: "Plaza",
          brief: "paint the plaza red",
          mode: "single",
          minutes: "5",
          owns: "src/plaza.js",
        };
        results.answered = text(await call("worker_start", start));
        const at = Date.now();
        results.started = json(await call("worker_start", start));
        results.tookMs = Date.now() - at;
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        await call("finish", { summary: "the benches are oak", land: "no" });
        return {
          ok: true,
          engine: "codex",
          turns: 5,
          usage: {},
          sessionId: "director-answered",
          summary: "run done",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'oak';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-answered", summary: "oak benches" };
    });

    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      reviewPlan: true,
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    assert.match(results.answered, /the user answered your plan: "make the benches oak"/, results.answered);
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.ok(
      results.tookMs < 60_000,
      `the second start builds instead of waiting out another slice (${results.tookMs} ms)`,
    );
    const cards = customEvents(events, "autopilot_decision").filter((e) => e.runId === runId);
    const review = cards.filter((e) => /^plan review:/.test(String(e.decision)));
    assert.equal(review.length, 1, cards.map((e) => e.decision).join(" | "));
    assert.match(String(review[0]!.decision), /plan review: the user answered the plan/);
    assert.doesNotMatch(String(review[0]!.decision), /said go/, "the card never puts a word in their mouth");
    assert.match(String(review[0]!.plain), /^you answered the plan, so the builders are starting with what you said/);
  });

  it("a worker's commit outlives its worktree: the close refs it, and the user can still play it", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-keep", { title: "Director keep" });
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("bench"));
        results.started = json(
          await call("worker_start", {
            id: "bench",
            title: "Bench",
            brief: "put an oak bench in the plaza",
            mode: "single",
            minutes: "5",
            owns: "src/bench.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "bench" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "bench" }));
        // The bench is never integrated — the director does not think it is ready — and the
        // run ends. Its commit is exactly the kind that used to disappear.
        results.finished = text(await call("finish", { summary: "the bench is not right yet", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 5,
          usage: {},
          sessionId: "director-keep",
          summary: "left the bench where it is",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "bench.js"), "export const bench = 'oak';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-keep", summary: "put the bench in" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a bench",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "bench", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    const commit: string = results.wstatus.lastCommit;
    assert.ok(commit, `the worker committed: ${JSON.stringify(results.wstatus)}`);
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, "nothing was integrated or landed");
    assert.equal(
      (finished.workers as Record<string, { lastCommit: string }>).bench.lastCommit,
      commit,
      "the report names the commit",
    );
    await assert.rejects(stat(results.started.worktree), "the worktree it was made in is gone");

    // The acceptance: something in the game's repo still contains that commit.
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const containing = (await api["run.exec"]!({
      command: `git for-each-ref --contains ${commit}`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(
      containing.stdout,
      new RegExp(`refs/studio/runs/${runId}/workers/bench`),
      `no ref contains ${commit}: "${containing.stdout}"`,
    );
    const shown = (await api["run.exec"]!({
      command: `git show refs/studio/runs/${runId}/workers/bench:src/bench.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(shown.stdout, /bench = 'oak'/);
    // Which is what "Play this build" needs in the morning: the sha the report named, playable.
    const copy = await rig.core.showBuild(project.name, commit);
    assert.equal(await readFile(path.join(copy.dir, "src", "bench.js"), "utf8"), "export const bench = 'oak';\n");
  });

  /**
   * The director's memory. Its brief tells it to keep `.studio/DIRECTOR.md` current, and a
   * resumed session is told to read that file — but `.studio/` is ignored by git in every
   * worktree, so the file is never committed, and the worktree it lives in is removed at the
   * close. The run that paused on a session limit left no DIRECTOR.md anywhere under its run
   * folder, and the morning's resume opened by telling the director to read it.
   */
  it("the memory file the resumed run is told to read is there: kept at the close, restored into the fresh worktree", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-memory", { title: "Director memory" });
    const memory =
      "# what I know\n- the plaza camera is the one the user judges by\n- the haze peak above 0.5 washes the sky out\n";
    const results: Record<string, any> = {};
    const prompts: string[] = [];
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (!request.director) return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "none", summary: "" };
      prompts.push(request.prompt);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (++sessions === 1) {
        await mkdir(path.join(request.cwd, ".studio"), { recursive: true });
        await writeFile(path.join(request.cwd, ".studio", "DIRECTOR.md"), memory);
        await call("note", {
          text: "wrote down what I know about the plaza camera",
          plain: "made a note of what it learned",
        });
        // The engine's limit ends the session here: the run pauses with the file on disk.
        throw new EngineError(
          "rate_limit",
          "codex",
          "You've hit your session limit · resets 9:50pm (Europe/Belgrade)",
          4 * 3_600_000,
        );
      }
      results.memoryOnResume = await readFile(path.join(request.cwd, ".studio", "DIRECTOR.md"), "utf8").catch((err) =>
        String(err),
      );
      results.finished = text(await call("finish", { summary: "read my notes and stopped", land: "no" }));
      return {
        ok: true,
        engine: "codex",
        turns: 3,
        usage: {},
        sessionId: "director-memory-2",
        summary: "picked up where I left off",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza at dusk",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      // Flipped (one session): the memory file is the long turn's: a waking lead keeps none (the journal carries its run).
      directorLoop: "turn",
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "autopilot_paused").some((e) => e.runId === runId),
      120_000,
      "the run to pause on the limit",
    );

    // Kept as a run artefact — the record a developer, or the next run, can read.
    assert.equal(await readFile(path.join(rig.core.layout.runs, runId, "director", "DIRECTOR.md"), "utf8"), memory);

    await rig.core.resumeAutopilot(runId);
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").filter((e) => e.runId === runId).length >= 2,
      120_000,
      "the resumed run's closure",
    );

    assert.equal(sessions, 2, "one resumed session");
    // The worktree is new (the close removed the old one) and the notes are in it.
    assert.equal(results.memoryOnResume, memory, results.memoryOnResume);
    assert.match(prompts[1]!, /YOU WERE RESUMED/);
    assert.match(
      prompts[1]!,
      /Read \.studio\/DIRECTOR\.md — the notes you kept last session, restored into this worktree/,
      prompts[1]!.slice(0, 4_000),
    );
    assert.match(results.finished, /the run is closed/);
  });

  /**
   * The pool never lends the user's window (M3.7; flipped). Here it has none to give at all, so
   * every pass meets an exhausted pool. A
   * judge and a playtest are choices the director can make a minute later: they are told there is
   * no window. The close cannot be skipped — nobody else will ever look at this build — so it used
   * to borrow the user's window, say so on the run's thread and put their game back. It looks
   * through the studio's own stand-in now, and the user's window keeps what they opened.
   */
  it("with no window free: judge and playtest are told so, and the close looks without touching the user's window", async () => {
    // Every hidden window the run opens, and every folder it was pointed at.
    const windows: FakePreview[] = [];
    const looked: Array<string | null> = [];
    let blind = false;
    const rig = await startRig(
      { replies: [] },
      {
        previewPoolMax: 0,
        createHeadlessPreview: async () => {
          const window = makeFakePreview();
          if (blind) window.pixelStatsNext = { ...window.pixelStatsNext, litFraction: 0, meanLuma: 0 };
          const load = window.load.bind(window);
          window.load = async (name: string, entry?: string, root?: string, options?: { loopback?: boolean }) => {
            looked.push(root ?? null);
            return load(name, entry, root, options);
          };
          windows.push(window);
          return window;
        },
      },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-borrow", { title: "Director borrow" });
    // Every load of the user's own window, and what it was pointed at.
    const shown: Array<{ project: string; root: string | null }> = [];
    const load = rig.preview.load.bind(rig.preview);
    rig.preview.load = async (name: string, entry?: string, root?: string, options?: { loopback?: boolean }) => {
      shown.push({ project: name, root: root ?? null });
      return load(name, entry, root, options);
    };
    // The user opens the game: the one load of their window that is theirs.
    await rig.core.loadPreview({ project: project.name });
    const results: Record<string, any> = {};
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (!request.director) return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "none", summary: "" };
      // The wrap-up session has nothing to add; the close below is this test's subject.
      if (++sessions > 1)
        return {
          ok: true,
          engine: "codex",
          turns: 1,
          usage: {},
          sessionId: "director-borrow-2",
          summary: "nothing left to do",
        };
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      results.capacity = json(await call("run_status", {})).capacity;
      await call("plan", planFor("sign"));
      results.noWorker = text(
        await call("worker_start", {
          id: "sign",
          title: "Sign",
          brief: "hang a sign",
          minutes: "5",
          owns: "src/sign.js",
        }),
      );
      const loadsBefore = shown.length;
      results.judged = text(await call("judge", { target: "integration" }));
      results.played = text(await call("playtest", { target: "integration", ask: "does the sign light up?" }));
      results.borrowedForJudging = shown.length - loadsBefore;
      // The lead's own commit, so the close has something beyond the starting point to look at.
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'lit';\n");
      await git(request.cwd, ["add", "-A"]);
      await git(request.cwd, [
        "-c",
        "user.name=Studio",
        "-c",
        "user.email=studio@ai-game-studio.local",
        "commit",
        "-q",
        "-m",
        "the lead's own edit",
      ]);
      // The lead offers its own build to the user's Live; the user never presses Reload here.
      results.shown = text(await call("show", { target: "integration" }));
      // And the build now draws nothing wherever the close looks, so its look fails and nothing lands.
      blind = true;
      for (const window of windows) window.pixelStatsNext = { ...window.pixelStatsNext, litFraction: 0, meanLuma: 0 };
      return {
        ok: true,
        engine: "codex",
        turns: 5,
        usage: {},
        sessionId: "director-borrow",
        summary: "left it to the close",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a lit sign",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "sign", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      // Flipped (one session): the lead's own commit is the long turn's: a waking lead writes nothing.
      directorLoop: "turn",
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "the borrowed close to finish",
    );

    // Nothing to lend: the worker gate says so in the same words, and the judges wait their turn.
    assert.equal(results.capacity.windowsMax, 0);
    assert.match(results.noWorker, /no worker window free \(0 of 0 in use/, results.noWorker);
    assert.match(results.judged, /^no window free/, results.judged);
    assert.match(results.judged, /wait for one to finish or stop one/, results.judged);
    assert.match(results.played, /^no window free/, results.played);
    assert.equal(results.borrowedForJudging, 0, "neither pass touched the window the user is watching");

    // The close had to look, and it looked through the studio's own window: no borrow to announce.
    assert.deepEqual(customEvents(events, "director_window"), []);
    const worktree = path.join("autopilot", runId, "integration");
    assert.match(results.shown, /Live's Reload now offers integration/);
    assert.ok(
      looked.some((root) => root?.includes(worktree)),
      `the close never looked: ${JSON.stringify(looked)}`,
    );
    // The user's window kept what they opened, through the show, the close and the teardown.
    assert.deepEqual(shown, [{ project: project.name, root: null }], JSON.stringify(shown));

    // Nothing landed (the close's look found a black page).
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.equal(rig.preview.loadRoot, null, "the run did not end with the user's window on a removed worktree");
    await assert.rejects(
      stat(path.join(rig.core.layout.scratch, "autopilot", runId, "integration")),
      "the integration worktree is removed",
    );
  });

  /**
   * The policy a director may set for one worker, and the one close both roads take (M4.10).
   *
   * `finish land=yes` used to skip the fresh look entirely and land whatever HEAD happened to
   * be — so a director could hand the user a build that does not start, while the tool's own
   * description has always promised "when it is healthy". Here the head the director committed
   * by hand draws nothing, and the run keeps it unlanded and says why in the user's words.
   * The worker is still running when finish is called: the close stops it, waits for its own
   * end (a deferred resolved by the first statement of its finally, not a poll on a state that
   * is set before the ref is written), and only then looks.
   */
  it("takes a worker's loop policy, and lands nothing at finish when the head it would land does not run", async () => {
    // Every window this run can look through, so the close's borrowed or leased look sees the
    // same page the user would: a build that draws nothing.
    const windows: FakePreview[] = [];
    let dark = false;
    const darken = (preview: FakePreview) => {
      preview.pixelStatsNext = { ...preview.pixelStatsNext, litFraction: 0, meanLuma: 0 };
    };
    const rig = await startRig(
      { replies: [] },
      {
        previewPoolMax: 4,
        createHeadlessPreview: async () => {
          const preview = makeFakePreview();
          if (dark) darken(preview);
          windows.push(preview);
          return preview;
        },
      },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-policy", { title: "Director policy" });
    const results: Record<string, any> = {};
    let finishStartedAt = 0;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.status0 = json(await call("run_status", {}));
        await call("plan", planFor("sign"));
        results.started = json(
          await call("worker_start", {
            id: "sign",
            title: "Sign",
            brief: "hang a sign",
            mode: "single",
            minutes: "5",
            owns: "src/sign.js",
            policy: '{"maxJudgeChecks":6,"brokenStreakLimit":3}',
          }),
        );
        results.wstatus = json(await call("worker_status", { id: "sign" }));
        results.status1 = json(await call("run_status", {}));
        // A threshold nobody has: refused by name, and nothing is created for it.
        results.badPolicy = text(
          await call("worker_start", { id: "bad", brief: "with a typo", policy: '{"maxJudgeCheks":6}' }),
        );
        // Out of range is clamped, not refused — a run is not lost over a number too big.
        results.clamped = json(
          await call("worker_start", {
            id: "loud",
            title: "Loud",
            brief: "shout",
            mode: "single",
            minutes: "5",
            owns: "src/loud.js",
            policy: '{"maxJudgeChecks":99}',
          }),
        );
        // The lead's own commit, so the close has something beyond the starting point to look
        // at — and a page that now draws nothing, so the look it takes must refuse to land it.
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'lit';\n");
        await git(request.cwd, ["add", "-A"]);
        await git(request.cwd, [
          "-c",
          "user.name=Studio",
          "-c",
          "user.email=studio@ai-game-studio.local",
          "commit",
          "-q",
          "-m",
          "the lead's own edit",
        ]);
        dark = true;
        for (const preview of [rig.preview, ...windows]) darken(preview);
        // The workers are still running: the close stops them and waits for their own end.
        finishStartedAt = Date.now();
        results.finished = text(await call("finish", { summary: "the sign is up", land: "yes", victory: "yes" }));
        results.closeMs = Date.now() - finishStartedAt;
        return { ok: true, engine: "codex", turns: 8, usage: {}, sessionId: "director-policy", summary: "closed" };
      }
      // A worker that takes its time, so finish has something to settle.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-policy", summary: "hung the sign" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a lit sign",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "sign", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      // Flipped (one session): the lead's own commit is the long turn's: a waking lead writes nothing.
      directorLoop: "turn",
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "the policy run to finish",
    );

    // The defaults are on run_status, once; a worker carries only what it was started with.
    assert.deepEqual(results.status0.policy, { ...FACET_POLICY }, JSON.stringify(results.status0.policy));
    assert.deepEqual(
      results.status1.policy,
      { ...FACET_POLICY },
      "the run's own thresholds did not move because one worker's did",
    );
    assert.deepEqual(
      results.started.policy,
      { maxJudgeChecks: 6, brokenStreakLimit: 3 },
      JSON.stringify(results.started),
    );
    assert.deepEqual(
      results.wstatus.policy,
      { maxJudgeChecks: 6, brokenStreakLimit: 3 },
      JSON.stringify(results.wstatus.policy),
    );
    assert.equal(results.status1.workers.find((w: { id: string }) => w.id === "sign").policy.maxJudgeChecks, 6);
    assert.match(results.badPolicy, /"maxJudgeCheks" is not one of this loop's thresholds/, results.badPolicy);
    assert.equal(
      results.clamped.policy.maxJudgeChecks,
      FACET_POLICY_RANGE.maxJudgeChecks[1],
      JSON.stringify(results.clamped),
    );
    assert.match(String(results.clamped.policyWarnings?.[0]), /maxJudgeChecks 99 is outside 0–12; using 12/);

    // The close looked before it landed, found a page that draws nothing, and kept the build.
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.equal(
      finished.stoppedBecause,
      "the director finished the run",
      "the sentence the tests and the morning read is unchanged",
    );
    const landing = finished.landingResult as { ok: boolean; why: string; how: string; line: string };
    assert.equal(landing.ok, false);
    assert.equal(landing.why, "does-not-run", JSON.stringify(landing));
    assert.equal(landing.how, "not-landed");
    assert.equal(landing.line, "nothing was made live");
    assert.equal(finished.victory, false, "a victory is not claimed over a build nobody could land");
    assert.match(results.finished, /not landed: the integrated build did not load at the close/, results.finished);
    // And the user is told, in their own words, without a sha or a branch name in sight.
    const card = customEvents(events, "autopilot_decision").find((e) =>
      /did not start when it was checked at the end/.test(String(e.plain)),
    )!;
    assert.ok(
      card,
      `the plain card is missing: ${JSON.stringify(customEvents(events, "autopilot_decision").map((e) => e.plain))}`,
    );
    assert.ok(!/[0-9a-f]{10}/.test(String(card.plain)), String(card.plain));

    // The close waited for the workers it stopped and did not spin out its settle window: both
    // ended, in the record, before the run did.
    const order = events.map((e) => e.data as { event_type?: string; payload?: Record<string, any> });
    const finishedAt = order.findIndex((e) => e.event_type === "run_finished" && e.payload?.runId === runId);
    for (const id of ["sign", "loud"]) {
      const endedAt = order.findIndex(
        (e) => e.event_type === "director_worker" && e.payload?.workerId === id && e.payload?.state !== "running",
      );
      assert.ok(endedAt >= 0, `worker ${id} never reported its end`);
      assert.ok(endedAt < finishedAt, `worker ${id} ended after the run did (${endedAt} vs ${finishedAt})`);
    }
    assert.ok(
      results.closeMs < 60_000,
      `the close spun out its settle window instead of waiting on the workers: ${results.closeMs} ms`,
    );
  });

  /**
   * A game that already knows what it is (M4.4/M4.6). The kind lives in the user's own
   * studio.json — the one declaration source that survives a run — and the director wrote it
   * there without ever reading it back: a second run on a declared board game drove mouse-look
   * and WASD before every judgement and put no HUD, look or movement check on any board. Three
   * more things this run proves: the kind the plan declares reaches the card the user reads
   * before the builders start; the write into their folder is COMMITTED where it was made, so
   * the morning's "Make it my game" is not refused over an edit only the studio made; and a
   * worker with no seam runs alone whichever end of the run it was started from.
   */
  it("reads the kind the game already declares, commits the one it writes, and keeps a seamless worker alone", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-declared-"), "boardgame");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><title>BOARD</title><script type="module" src="/src/main.js"></script>\n',
    );
    await writeFile(
      path.join(dir, "src", "main.js"),
      'import { installStudio } from "./studio.js";\nconst scene = {};\ninstallStudio({ scene, renderer: {}, camera: {}, player: () => ({ x: 0, y: 0, z: 0, yaw: 0 }) });\nexport { scene };\n',
    );
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "boardgame", type: "module" }));
    // What an earlier run wrote into their file, and what this run must open knowing.
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({
        name: "boardgame",
        title: "Board game",
        createdAt: "",
        contractVersion: 1,
        entry: "index.html",
        main: "src/main.js",
        build: null,
        serve: ".",
        own: true,
        kind: "three-modules",
        game: { kind: "top-down", hud: true, mouseLook: false, keyboardMove: true, declaredBy: "an earlier run" },
      }),
    );
    const project = await rig.core.adoptProject(dir);
    const seen: { director: DelegateRequest[]; workers: DelegateRequest[] } = { director: [], workers: [] };
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        // The director looked and decided this is not the top-down game the file says.
        results.planned = text(await call("plan", { ...planFor("core"), kind: "first-person" }));
        // A worker with no seam owns nearly the whole repository, so it starts alone…
        results.startedCore = json(
          await call("worker_start", {
            id: "core",
            title: "The core",
            brief: "make the board read",
            mode: "single",
            minutes: "5",
          }),
        );
        // …and nobody may start beside it, seam of their own or not.
        results.refusedBeside = text(
          await call("worker_start", {
            id: "hud",
            title: "The HUD",
            brief: "a hud",
            mode: "single",
            minutes: "5",
            owns: "src/hud.js",
          }),
        );
        for (let i = 0; i < 30; i += 1) {
          results.waited = json(await call("wait", { seconds: "5", worker: "core" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "looked at the board", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 7,
          usage: {},
          sessionId: "director-declared",
          summary: "read what the game says it is",
        };
      }
      seen.workers.push(request);
      await writeFile(path.join(request.cwd, "src", "core.js"), "export const core = true;\n");
      return {
        ok: true,
        engine: "codex",
        turns: 2,
        usage: {},
        sessionId: "worker-declared",
        summary: "the board reads",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make the board read",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "chess", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished on a game that declares its kind",
    );

    // The declaration the studio wrote last time is read back before the session opens, and the
    // brief says so — the director confirms or corrects it instead of guessing again.
    assert.match(
      seen.director[0]!.prompt,
      /THIS GAME ALREADY SAYS WHAT IT IS: its studio\.json declares a top-down game/,
      seen.director[0]!.prompt.slice(0, 4_000),
    );

    // What the run decided is on the plan card the user reads before any builder starts.
    const card = customEvents(events, "autopilot_plan_review").find((e) => e.runId === runId)!;
    assert.equal((card.game as { kind?: string })?.kind, "first-person", JSON.stringify(card));

    // …and it is in their studio.json, committed by the studio that wrote it: the folder ends
    // the run exactly as clean as it began.
    const stored = JSON.parse(await readFile(path.join(project.dir, "studio.json"), "utf8"));
    assert.equal(stored.game.kind, "first-person", JSON.stringify(stored.game));
    assert.equal(stored.game.declaredBy, "plan");
    assert.equal(stored.name, "boardgame", "every key the file already had survived");
    assert.equal(
      await git(project.dir, ["status", "--porcelain"]),
      "",
      "no edit of the studio's own is left for the user to explain",
    );
    assert.match(await git(project.dir, ["log", "-1", "--format=%s"]), /studio: this game is a first-person game/);

    // The second worker was refused by name, and never started.
    assert.equal(results.startedCore.started, "core", JSON.stringify(results.startedCore));
    assert.match(results.refusedBeside, /worker "core" is running with no seam/, results.refusedBeside);
    assert.match(results.refusedBeside, /stop it or wait for it before starting "hud"/, results.refusedBeside);
    assert.equal(seen.workers.length, 1, "one builder session ran");
  });
});

describe("the selected direction-build duration", () => {
  it("spends the working budget, preserves wrap-up time and permits user Finish now", async () => {
    const { timedWorkRemaining } = await import("../../src/harness-seed/loop/director.ts");
    const run = { reference: { kind: "direction" } },
      deadline = 3_600_000 - wrapReserveMs(3_600_000);
    assert.equal(timedWorkRemaining(run as never, deadline, 9 * 60_000), true);
    assert.equal(timedWorkRemaining(run as never, deadline, deadline), false);
    assert.equal(timedWorkRemaining(run as never, deadline, 9 * 60_000, true), false);
    assert.equal(timedWorkRemaining({ reference: { kind: "reference" } } as never, deadline, 9 * 60_000), false);
  });
  it("refuses an early finish, resumes the director, starts a worker, and honors an explicit user finish", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("timed-director", { title: "Timed director" });
    const runId = rig.core.newRunId();
    let turns = 0,
      workers = 0;
    let refusal = "";
    fakeEngine(rig, async (request) => {
      if (!request.director) {
        workers++;
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
        return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "worker", summary: "Dusk sky" };
      }
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (++turns === 1) {
        refusal = text(
          await call("finish", { summary: "The starting point is playable", land: "yes", victory: "yes" }),
        );
        assert.match(refusal, /finish refused.*working minutes remain/);
        return {
          ok: true,
          engine: "codex",
          turns: 1,
          usage: {},
          sessionId: "timed-session",
          summary: "First playable",
        };
      }
      assert.equal(request.resume, "timed-session");
      assert.match(request.prompt, /timed build still has/);
      await call("plan", planFor("sky"));
      await call("worker_start", {
        id: "sky",
        title: "Dusk sky",
        brief: "Build a dusk sky",
        mode: "single",
        owns: "src/sky.js",
        minutes: "5",
      });
      for (let i = 0; i < 30; i++) {
        const status = json(await call("wait", { seconds: "1", worker: "sky" }));
        if (status.status.workers[0]?.state !== "running") break;
      }
      // The user's Finish, where the run's inbox reads it: the game's own thread, not the studio's.
      await rig.core.append(
        [{ type: "custom", event_type: "run_control", payload: { runId, action: "finish" } }],
        await rig.core.threadForGame(project.name),
      );
      assert.match(
        text(await call("finish", { summary: "Stopped early at the user’s request", land: "no" })),
        /run is closed/,
      );
      return {
        ok: true,
        engine: "codex",
        turns: 4,
        usage: {},
        sessionId: "timed-session",
        summary: "Finished as requested",
      };
    });
    await rig.core.dispatchRun({
      runId,
      goal: "A dusk scene",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "Dusk", kind: "direction", shots: [] },
      budgets: { wallClockMs: 3_600_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "timed direction completion",
    );
    assert.equal(turns, 2);
    assert.ok(workers >= 1);
    assert.equal(customEvents(events, "director_continued").length, 1);
    // The lead was woken once, to be asked what next (director/wake.ts): nothing else woke it.
    assert.deepEqual(customEvents(events, "director_continued")[0]!.reasons, ["idle_ask"]);
    assert.equal(customEvents(events, "run_finished").filter((e) => e.runId === runId).length, 1);
  });
});

/**
 * A plan of several looping parts holds its loop workers to a module contract, so parallel workers
 * never rewrite each other's modules around a shared state object nobody wrote down. Through the
 * real core and harness, no worker starts here — what is
 * proved is every refusal, and the contract the plan commits on the integration branch.
 */
describe("a module contract before loop workers", () => {
  it("MC1. refuses a loop worker until the plan carries a contract, its stubs exist and its seam leaves the other part alone", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-contract", { title: "Director contract" });
    const results: Record<string, any> = {};
    const contract = {
      conventions: ["the plaza is 40 metres across"],
      modules: [
        { path: "src/plaza.js", owner: "plaza", api: ["export function buildPlaza(scene)"] },
        { path: "src/sky.js", owner: "sky", api: ["export function buildSky(scene)"] },
      ],
    };
    fakeEngine(rig, async (request) => {
      if (!request.director)
        return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "worker", summary: "nothing" };
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      await call("plan", planFor("plaza", "sky"));
      results.noContract = text(await call("worker_start", { id: "plaza", brief: "pave it", owns: "src/plaza.js" }));
      results.badPath = text(
        await call("plan", {
          ...planFor("plaza", "sky"),
          contract: '{"modules":[{"path":"../x.js","owner":"plaza"}]}',
        }),
      );
      results.planned = text(
        await call("plan", { ...planFor("plaza", "sky"), contract: JSON.stringify(contract), vision: PLAZA_VISION }),
      );
      results.noStubs = text(await call("worker_start", { id: "plaza", brief: "pave it" }));
      results.wide = text(await call("worker_start", { id: "sky", brief: "a dusk sky", owns: "src/" }));
      results.finished = text(await call("finish", { summary: "a contract and nothing built", land: "no" }));
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "director-contract", summary: "done" };
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza under a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );
    assert.match(results.noContract, /2 parts that loop, and no module contract yet: call plan again with contract=/);
    assert.match(results.badPath, /^plan: contract path \.\.\/x\.js is not one file relative to the game/);
    assert.match(
      results.planned,
      /The module contract is committed on integration as docs\/MODULE-CONTRACT\.md \([0-9a-f]{10}\).*Stubs still to write before their loop workers start: src\/plaza\.js, src\/sky\.js/,
    );
    assert.match(
      results.noStubs,
      /the contract gives "plaza" src\/plaza\.js, which does not exist at [0-9a-f]{10}: write the stubs first/,
    );
    assert.match(results.wide, /owns= would reach other parts' modules \(src\/ → src\/plaza\.js, plaza's\)/);
    assert.deepEqual(
      customEvents(events, "director_worker").filter((e) => e.runId === runId),
      [],
      "nobody started",
    );
    const architecture = await git(project.dir, [
      "show",
      `refs/studio/runs/${runId}/integration:docs/MODULE-CONTRACT.md`,
    ]);
    assert.match(architecture, /### src\/plaza\.js — owned by `plaza` \(plaza\)/);
    assert.match(architecture, /- the plaza is 40 metres across/);
    const vision = await git(project.dir, ["show", `refs/studio/runs/${runId}/integration:docs/VISION.md`]);
    assert.match(vision, /## Headroom\n\nthe river bank and a market street/, "the vision is committed beside it");
  });

  /**
   * A game from scratch under a contract (review): the base stage accepted an empty world, the
   * plan's contract was committed on top of it, and every loop worker had to fork from that
   * commit — which the fork gate looked at as a game, not a start, and refused as "does not run".
   */
  it("MC2. a loop worker forks from the contract written on an empty starting point, and the close lands nothing", async () => {
    /** The empty scaffold as a window sees it: nothing drawn, and an inspection that proves it. */
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-contract-scratch", { title: "Contract from scratch" });
    const results: Record<string, any> = {};
    const contract = {
      modules: [
        { path: "src/world.js", owner: "plaza", api: ["export const world"] },
        { path: "src/sky.js", owner: "sky", api: ["export function buildSky(scene)"] },
      ],
    };
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.planned = text(
          await call("plan", { ...planFor("plaza", "sky"), contract: JSON.stringify(contract), vision: PLAZA_VISION }),
        );
        results.started = json(await call("worker_start", { id: "plaza", brief: "pave the plaza", minutes: "5" }));
        if (results.started.started) {
          await call("worker_stop", { id: "plaza", why: "the start is what this proves" });
          for (let i = 0; i < 30; i++) {
            const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
            if (waited.status.workers[0]?.state !== "running") break;
          }
        }
        results.finished = text(await call("finish", { summary: "a contract on the start", land: "yes" }));
        return { ok: true, engine: "codex", turns: 4, usage: {}, sessionId: "director-cs", summary: "done" };
      }
      if (path.basename(request.cwd) === "integration") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "world.js"), "export const world = { groups: ['plaza'] };\n");
        return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "base-cs", summary: "empty groups" };
      }
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "worker-cs", summary: "nothing yet" };
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza under a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished on a contract from scratch",
    );
    const base = customEvents(events, "autopilot_base").find((e) => e.runId === runId)!;
    assert.equal(base.empty, true, "the starting point is an empty world");
    assert.match(results.planned, /The module contract is committed on integration as docs\/MODULE-CONTRACT\.md/);
    // Red before the fix: "the build you would fork from does not run … renders effectively black".
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    const contractCommit = await git(project.dir, ["rev-parse", `refs/studio/runs/${runId}/integration`]);
    assert.ok(contractCommit.startsWith(results.started.forkedFrom), "from the contract's commit");
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, "the start and a document are nothing to land");
  });
});

describe("a game that keeps its own edited HUD", () => {
  it("notes the first-generation HUD it leaves alone, and keeps the owner's copy", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("held-hud", { title: "Held HUD" });
    // The game's first HUD, with the owner's own gauge helper in it: theirs, so the upgrade keeps it.
    const hudFile = path.join(project.dir, "src", "hud.js");
    const first = await readFile(path.join(import.meta.dirname, "..", "fixtures", "hud-generation-1.js.txt"), "utf8");
    const edited = `${first}// the main owner's own gauge helper\n`;
    await writeFile(hudFile, edited);
    fakeEngine(rig, async (request) => {
      if (!request.director) throw new Error("no worker is started");
      await request.onLiveTool!("finish", { summary: "nothing to build", land: "no" });
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "director-held", summary: "finished" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a dashboard",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dash", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "held-HUD run_finished",
    );
    const cards = customEvents(events, "autopilot_decision").filter((e) => e.runId === runId);
    const held = cards.find((e) => /left src\/hud\.js at HUD generation 1/.test(String(e.decision)));
    assert.ok(held, cards.map((e) => String(e.decision)).join(" | "));
    assert.match(String(held.plain), /text, bars and the crosshair/);
    assert.equal(await readFile(hudFile, "utf8"), edited, "the owner's HUD is untouched");
  });
});

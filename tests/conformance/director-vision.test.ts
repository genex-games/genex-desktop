/**
 * The vision, apart from the contract, and a foundation the lead lays itself.
 *
 * The contract freezes interfaces and ranges, never a world laid out inside it; the vision holds
 * the ambition every part grows toward. Contract lines are cut at a word, never mid-word. A run with
 * room for a team skips the starting scene: its lead lays crude stubs before the owners design the
 * content, and a short run's starting scene reads the user's scope.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { compilePlan } from "../../src/harness-seed/loop/director/rules.ts";
import { ARCHITECTURE_FILE } from "../../src/harness-seed/loop/director/contract-prompts.ts";
import { parseModuleContract } from "../../src/harness-seed/loop/director/module-contract.ts";
import {
  CONTRACT_REFUSALS_BEFORE_DERIVED,
  contractAtFork,
  contractBeforeFork,
  contractOnPlan,
} from "../../src/harness-seed/loop/director/contract-gate.ts";
import { recordLoopRun, restoreLoopRun } from "../../src/harness-seed/loop/director/journal.ts";
import { directorBrief, singleWorkerBrief } from "../../src/harness-seed/loop/director/briefs.ts";
import { foundationFirst } from "../../src/harness-seed/loop/director/foundation.ts";
import { buildStartingPoint } from "../../src/harness-seed/loop/director/setup.ts";
import { baseBrief } from "../../src/harness-seed/loop/prompts-build.ts";
import { facetPrompt } from "../../src/harness-seed/loop/facet/prompt.ts";
import { livenessCritique, tasteVeto } from "../../src/harness-seed/loop/judge.ts";
import { shipReview } from "../../src/harness-seed/loop/ship-review.ts";
import { createScope } from "../../src/harness-seed/loop/scope.ts";
import { scopeLines } from "../../src/harness-seed/loop/scope-prompts.ts";
import { WorkerMode } from "../../src/harness-seed/loop/outcomes.ts";
import { VISION_CHARS, VISION_FILE, VisionRefusal, parseVision } from "../../src/harness-seed/loop/vision.ts";
import { VISION_JUDGE_CHARS, visionExcerpt } from "../../src/harness-seed/loop/vision-prompts.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MINUTE = 60_000;

/** A plan of two looping parts, as the lead types it. */
const PARTS = [
  { id: "car", title: "Car handling", seam: "the car", owns: "src/car.js", done: ["the car drifts"], minutes: 30 },
  { id: "city", title: "City", seam: "the city", owns: "src/city.js", done: ["districts"], minutes: 30 },
];
const CONTRACT = {
  conventions: ["metres", "track length 2.5–4 km, 6–12 corners"],
  modules: [
    { path: "src/car.js", owner: "car", api: ["export function stepCar(state, input, dt)"] },
    { path: "src/city.js", owner: "city", api: ["export function buildCity(scene)"] },
  ],
};
/** The vision as the lead types it: the four sections. */
const VISION = {
  scale: "A downtown circuit of 2.5–4 km through about forty blocks, built at true metres.",
  far: "A skyline far away past the nearest towers, the harbour's black water, hills under a storm sky.",
  set_pieces: ["a bridge over the harbour", "a tunnel lit sodium orange"],
  headroom: "A second district across the water and a waterfront the circuit could grow into.",
};
const planArgs = ({ contract = CONTRACT as unknown, vision = VISION as unknown } = {}) => ({
  summary: "A night race through a wet neon city.",
  workers: JSON.stringify(PARTS),
  ...(contract === null ? {} : { contract: JSON.stringify(contract) }),
  ...(vision === null ? {} : { vision: JSON.stringify(vision) }),
});

/** Words of at most nine letters, `n` characters of them at least. */
function prose(n: number, word = "skyline"): string {
  const words: string[] = [];
  while (words.join(" ").length < n) words.push(`${word}${words.length % 10}`);
  return words.join(" ");
}

/** Was `kept` cut from `whole` only at a word boundary, the cut marked? */
function cutAtAWord(kept: string, whole: string): boolean {
  if (kept === whole) return true;
  if (!kept.endsWith("…")) return false;
  const head = kept.slice(0, -1);
  return whole.startsWith(head) && /\s/.test(whole.charAt(head.length));
}

/** A real repository standing in for the integration worktree: a base commit with the entry. */
async function integrationRepo() {
  const root = await tmpDir("studio-vision-");
  const repo = path.join(root, "integration");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(repo, "src", "main.js"), "// FACET WIRING\n");
  await fixtureGit(repo, ["add", "-A"]);
  await fixtureGit(repo, ["commit", "-q", "-m", "base"]);
  return { repo, head: await fixtureGit(repo, ["rev-parse", "HEAD"]) };
}

/** A run with only what the contract gate reads, over a real repository. */
function gateLoopRun(repo: string, head: string, plan: Record<string, unknown>) {
  const notes: string[] = [];
  const recorder = ctxRecorder({ handlers: { "run.exec": (p) => sh(String(p.command), String(p.cwd)) } });
  const loopRun: Record<string, any> = {
    ctx: recorder.ctx,
    run: { runId: "run_vision", project: "apex" },
    integrationWorktree: repo,
    lead: null,
    journal: { director: { integrationHead: head } },
    state: {
      plan,
      integrationHead: head,
      workers: new Map(),
      evidenceByHead: new Map(),
      healthByHead: new Map(),
      consoleByHead: new Map(),
      baseHeads: new Set(),
    },
    note: (text: string) => void notes.push(text),
    appendRun: async () => {},
    saveJournal: async () => {},
    protectHead: async () => {},
  };
  return { loopRun, notes };
}

describe("the vision, written by the harness beside the contract (P0)", () => {
  it("V1. a plan's vision is held to its four sections, cut at a word, and committed as docs/VISION.md with the contract, never over 6,000 characters", async () => {
    const huge = {
      scale: prose(5_000),
      far: prose(5_000),
      set_pieces: [1, 2, 3, 4].map(() => prose(3_000)),
      headroom: prose(5_000),
    };
    const compiled = compilePlan(planArgs({ vision: huge }));
    assert.equal(compiled.error, undefined, compiled.error);
    const vision = compiled.plan!.vision;
    assert.equal(vision.setPieces.length, 3, "two or three set-pieces, never more");
    for (const [kept, whole] of [
      [vision.scale, huge.scale],
      [vision.far, huge.far],
      [vision.headroom, huge.headroom],
      [vision.setPieces[0], huge.set_pieces[0]],
    ] as const)
      assert.ok(cutAtAWord(kept, whole), `cut at a word: …${kept.slice(-30)}`);

    const { repo, head } = await integrationRepo();
    const { loopRun } = gateLoopRun(repo, head, compiled.plan!);
    await contractOnPlan(loopRun as never);
    const files = (await fixtureGit(repo, ["show", "--name-only", "--format=", "HEAD"])).split("\n").sort();
    assert.deepEqual(files, [ARCHITECTURE_FILE, VISION_FILE].sort(), "one commit holds both documents");
    const text = await readFile(path.join(repo, VISION_FILE), "utf8");
    assert.ok(text.length <= VISION_CHARS, `docs/VISION.md is ${text.length} characters`);
    for (const heading of ["World scale", "Past the nearest building", "Set-pieces", "Headroom"])
      assert.match(text, new RegExp(`## ${heading}`));
    assert.deepEqual(loopRun.state.contract.vision, vision, "the run holds the vision it committed");
    const contractText = await readFile(path.join(repo, ARCHITECTURE_FILE), "utf8");
    assert.match(contractText, /Frozen: these interfaces and conventions\. Not frozen: content, layout, scale\./);
    assert.match(contractText, /Change it by re-planning, never by editing another part's module\./);
  });

  it("V2. a vision that leaves a section empty is refused by name, with the grammar", () => {
    const { far: _far, ...withoutFar } = VISION;
    const parsed = parseVision(JSON.stringify({ ...withoutFar, set_pieces: [] }));
    assert.equal(parsed.problem?.code, VisionRefusal.Missing);
    assert.deepEqual(parsed.problem?.missing, ["far", "set_pieces"]);
    assert.equal(parseVision("{not json").problem?.code, VisionRefusal.NotJson);
    assert.deepEqual(parseVision(""), { vision: null }, "a plan without one is a plan without one");
    const refused = compilePlan(planArgs({ vision: withoutFar }));
    assert.match(String(refused.error), /^plan: vision leaves far empty/);
    assert.match(String(refused.error), /vision is JSON: \{"scale"/, "the refusal carries the grammar");
  });
});

describe("the gate: no second loop worker before the vision (P0)", () => {
  it("V3. a loop worker under a contract with no vision is refused by name; the vision given, it forks only from the commit that holds it", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = gateLoopRun(repo, head, compilePlan(planArgs({ vision: null })).plan!);
    await contractOnPlan(loopRun as never);
    const contractOnly = loopRun.state.contract.commit;
    const refused = String(await contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop));
    assert.match(refused, /no vision yet/, refused);
    assert.match(refused, /vision=/);
    assert.doesNotMatch(refused, /no module contract yet/, "the contract it has is not asked for again");

    loopRun.state.plan = compilePlan(planArgs()).plan!;
    assert.match(String(await contractOnPlan(loopRun as never)), /docs\/VISION\.md/);
    assert.deepEqual(
      (await fixtureGit(repo, ["show", "--name-only", "--format=", "HEAD"])).split("\n"),
      [VISION_FILE],
      "the vision is committed; the contract it repeats is unchanged",
    );
    assert.equal(await contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop), null);
    const stale = await contractAtFork(loopRun as never, {
      id: "car",
      args: { id: "car" },
      mode: WorkerMode.Loop,
      commit: contractOnly,
    });
    assert.match(String(stale.refusal), /does not contain the module contract/, "a fork from before the vision");
  });

  it("V4. with neither, the refusal names both; a lead that never writes a vision is refused twice, then the build goes on with a note", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun, notes } = gateLoopRun(repo, head, compilePlan(planArgs({ contract: null, vision: null })).plan!);
    const start = () => contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop);
    for (let i = 0; i < CONTRACT_REFUSALS_BEFORE_DERIVED; i++) {
      const refused = String(await start());
      assert.match(refused, /no module contract yet: call plan again with contract=/);
      assert.match(refused, /no vision yet either/i);
    }
    assert.equal(await start(), null, "never stalled");
    assert.ok(
      notes.some((n) => /without a vision/.test(n)),
      notes.join("\n"),
    );
  });

  it("V5. a Resume keeps the vision committed with the contract", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = gateLoopRun(repo, head, compilePlan(planArgs()).plan!);
    await contractOnPlan(loopRun as never);
    const now = Date.UTC(2026, 9, 6, 2, 0, 0);
    const run = { runId: "run_v", project: "apex", goal: "a city", reference: { name: "City" } };
    const loopRunWith = (state: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
      run,
      started: now,
      softDeadline: now,
      finalDeadline: now,
      state: { judges: 0, plays: 0, ledger: [], workers: new Map(), log: [], planReviewUntil: 0, ...state },
      journal: { director: {} as Record<string, any> },
      ...over,
    });
    const first = loopRunWith({ baseHeads: new Set(), contract: loopRun.state.contract });
    recordLoopRun(first as never, now);
    const back = loopRunWith(
      { baseHeads: new Set() },
      { resume: true, priorJournal: { director: structuredClone(first.journal.director) } },
    ) as Record<string, any>;
    restoreLoopRun(back as never, now);
    assert.deepEqual(back.state.contract.vision, loopRun.state.contract.vision);
  });
});

describe("every worker and every judge of the game reads the vision (P0)", () => {
  const vision = compilePlan(planArgs()).plan!.vision;
  const run = (withVision: boolean) => ({
    runId: "apex",
    project: "apex",
    goal: "A neon night street race",
    reference: { name: "NFS", shots: [] },
    budgets: { wallClockMs: 1000 },
    ...(withVision ? { vision } : {}),
  });
  const HEADROOM = "A second district across the water";

  it("V6. a loop worker's brief, a single worker's brief, the taste judge, the liveness critic and the ship review carry the excerpt; a run without one reads nothing new", async () => {
    const facet = { id: "city", title: "The city", intent: "the wet neon city" };
    const sides = { challenger: { state: { lap: 1 } }, incumbentEvidence: { state: { lap: 0 } }, random: () => 0.1 };
    const asked = async (ask: (ctx: never) => Promise<unknown>) => {
      const recorder = ctxRecorder({
        handlers: { "engine.complete": () => ({ message: { content: '{"pick":"A","ship":false}' } }) },
      });
      await ask(recorder.ctx as never);
      const request = recorder.paramsOf("engine.complete")[0] as { messages: Array<{ content: string }> };
      return String(request.messages[0]?.content);
    };
    const worker = { id: "city", title: "The city", brief: "the city", owns: [], ownsMain: false } as never;
    const texts = async (withVision: boolean): Promise<Record<string, string>> => {
      const r = run(withVision) as never;
      return {
        builder: facetPrompt({ run: r, spec: { ...facet, checks: [] }, iteration: 1, resumed: false }),
        worker: singleWorkerBrief({ run: r, worker }),
        taste: await asked((ctx) => tasteVeto(ctx, { run: r, facet, ...sides })),
        liveness: await asked((ctx) => livenessCritique(ctx, { run: r, facet, evidence: { state: {} } as never })),
        ship: await asked((ctx) => shipReview(ctx, { run: r, evidence: { ok: true, shots: [] } as never, parts: [] })),
      };
    };
    const withVision = await texts(true);
    const without = await texts(false);
    for (const [name, text] of Object.entries(withVision)) {
      assert.match(text, /THE VISION/, `${name} reads the vision`);
      assert.ok(text.includes(HEADROOM), `${name} reads its headroom`);
      assert.match(text, /deepen/, `${name} hears that growing toward it deepens the ask`);
      assert.doesNotMatch(without[name]!, /THE VISION/, `${name}: a run without a vision has none`);
    }
  });

  it("V7. the excerpt keeps every section, each cut at a word, inside its bound", () => {
    const long = parseVision({
      scale: prose(5_000, "scale"),
      far: prose(5_000, "far"),
      set_pieces: [prose(900, "bridge")],
      headroom: `${HEADROOM} ${prose(5_000, "room")}`,
    }).vision!;
    const excerpt = visionExcerpt(long, VISION_JUDGE_CHARS);
    assert.ok(excerpt.length <= VISION_JUDGE_CHARS, `${excerpt.length} characters`);
    const sections: Array<[string, string]> = [
      ["World scale: ", long.scale],
      ["Past the nearest building: ", long.far],
      ["Set-pieces: ", long.setPieces.join("; ")],
      ["Headroom: ", long.headroom],
    ];
    const lines = excerpt.split("\n");
    for (const [index, [label, source]] of sections.entries()) {
      const line = lines[index] ?? "";
      assert.ok(line.startsWith(label), `${label} kept: ${line.slice(0, 40)}`);
      assert.ok(cutAtAWord(line.slice(label.length), source), `${label} cut at a word: …${line.slice(-30)}`);
    }
    assert.ok(excerpt.includes(HEADROOM), "the headroom is never the part a long scale pushed out");
  });
});

describe("contract lines are never clipped mid-word (P2)", () => {
  it("V8. a 300-character convention or API line is kept whole; a longer one is cut at a word, with an ellipsis", () => {
    const line300 = prose(300, "halfwidth").slice(0, 300).trimEnd();
    const line900 = prose(900, "corner");
    const parsed = parseModuleContract(
      {
        conventions: [line300, line900],
        modules: [{ path: "src/track.js", owner: "city", api: [line300, line900] }],
      },
      ["city"],
    );
    const contract = parsed.contract!;
    assert.equal(contract.conventions[0], line300, "a 300-character convention is kept whole");
    assert.equal(contract.modules[0]!.api[0], line300, "a 300-character API line is kept whole");
    for (const kept of [contract.conventions[1]!, contract.modules[0]!.api[1]!]) {
      assert.ok(kept.length <= 400, `${kept.length} characters`);
      assert.ok(cutAtAWord(kept, line900), `cut at a word: …${kept.slice(-30)}`);
    }
  });
});

describe("a run with room for a team: the lead lays the foundation", () => {
  it("V9. a run with room for a team and an hour of work lays its own foundation; a short run or a pool of one still gets a starting scene", () => {
    const pool = (max: number, headless = true) => ({ max, headless });
    assert.equal(foundationFirst({ remainingMs: 24 * 60 * MINUTE, capacity: pool(6) }), true);
    assert.equal(foundationFirst({ remainingMs: 61 * MINUTE, capacity: pool(4) }), true);
    assert.equal(foundationFirst({ remainingMs: 15 * MINUTE, capacity: pool(6) }), false, "a short run");
    assert.equal(foundationFirst({ remainingMs: 24 * 60 * MINUTE, capacity: pool(3) }), false, "one worker at a time");
    assert.equal(
      foundationFirst({ remainingMs: 24 * 60 * MINUTE, capacity: pool(6, false) }),
      false,
      "visible windows",
    );
    assert.equal(foundationFirst({ remainingMs: 24 * 60 * MINUTE, capacity: null }), false, "an unknown pool");
  });

  it("V10. on such a run the studio builds no starting scene: no session, the skip on the journal, a card, and a brief that hands the lead the foundation", async () => {
    const recorder = ctxRecorder({ unknown: { value: null } });
    const cards: string[] = [];
    const journal: Record<string, any> = { director: {} };
    const loopRun: Record<string, any> = {
      ctx: recorder.ctx,
      run: { runId: "run_apex", project: "apex", goal: "an NFS race" },
      state: { fromScratch: true },
      capacity: { max: 6, headless: true },
      softDeadline: Date.now() + 24 * 60 * MINUTE,
      journal,
      saveJournal: async () => {},
      decision: async (text: string, plain: string) => void cards.push(text, plain),
      appendRun: async () => {},
      note: () => {},
    };
    const start = await buildStartingPoint(loopRun as never);
    assert.equal(start?.skipped, true, JSON.stringify(start));
    assert.equal(journal.base?.skipped, true, "a Resume does not build one either");
    assert.deepEqual(recorder.calls, [], "no builder session, no window, no commit");
    assert.ok(
      cards.some((c) => /foundation/.test(c)),
      cards.join("\n"),
    );
    for (const lead of [null, { gameFolder: "/games/apex" }]) {
      const brief = directorBrief({
        run: loopRun.run,
        softDeadline: Date.now() + 60 * MINUTE,
        finalDeadline: Date.now() + 75 * MINUTE,
        integrationWorktree: "/runs/apex/integration",
        baseCommit: "a".repeat(40),
        startingPoint: start,
        lead,
      } as never);
      assert.match(brief, /contract= and vision=/, "the foundation is the contract and the vision");
      assert.match(brief, /12 minutes/, "in about twelve minutes");
      assert.match(brief, /stubs/);
      assert.doesNotMatch(brief, /starting point failed/, "a skip is no failure");
    }
  });

  it("V11. a starting scene the studio still builds reads the user's scope, and builds a crude playable skeleton", () => {
    const scope = createScope({
      asked: ["A neon night race on a closed circuit"],
      inScope: ["a closed circuit", "three rivals"],
      cut: ["police pursuit"],
    });
    const run = { runId: "run_s", goal: "A neon night race", reference: null, engine: "codex", scope } as never;
    const brief = baseBrief({ run, plan: { facets: [] }, projectLabel: "apex" });
    assert.ok(brief.includes(scopeLines(run)), "the user's words, what is in and what is cut");
    assert.match(brief, /crude playable skeleton/);
    assert.match(brief, /not a finished level/);
  });
});

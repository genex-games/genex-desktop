/**
 * The module contract, integration in waves, and lost registrations: without them parallel loop
 * workers rewrite each other's modules around a shared state object nobody wrote down, the
 * director integrates them one at a time with a health pass each, and a worker can delete cameras
 * other workers' checks look through without anything noticing.
 *
 * The plan carries a contract the harness holds to its shape and commits as docs/MODULE-CONTRACT.md;
 * a loop worker under a plan of several looping parts starts only from a commit that holds it, with
 * its modules stubbed and a seam that leaves the other parts' modules alone. `integrate` takes a
 * wave of workers with one health pass, and running workers take the integration branch once per
 * wave. A camera, demo or probe another facet depends on may not go missing — not in a facet's
 * round, not in a merge.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { compilePlan, compileWorkerSpec } from "../../src/harness-seed/loop/director/rules.ts";
import { rememberEvidence as rememberHeadEvidence } from "../../src/harness-seed/loop/director/loop-run.ts";
import { loopIntegration, startRefusal } from "../../src/harness-seed/loop/director/workers.ts";
import { priorFork, recordLoopRun, restoreLoopRun } from "../../src/harness-seed/loop/director/journal.ts";
import {
  ARCHITECTURE_FILE,
  contractPointer,
  renderArchitecture,
} from "../../src/harness-seed/loop/director/contract-prompts.ts";
import {
  ContractRefusal,
  contractPath,
  derivedContract,
  ownsClaimingOthers,
  parseModuleContract,
} from "../../src/harness-seed/loop/director/module-contract.ts";
import {
  CONTRACT_REFUSALS_BEFORE_DERIVED,
  contractAtFork,
  contractBeforeFork,
  contractOnPlan,
  holdsContract,
  missingAt,
  writeArchitecture,
} from "../../src/harness-seed/loop/director/contract-gate.ts";
import { closeTheLoopRun, integrate } from "../../src/harness-seed/loop/director/integrate.ts";
import { firstWaveIn, shipOwed } from "../../src/harness-seed/loop/director/art-direction.ts";
import { CompletionPolicy } from "../../src/harness-seed/loop/completion-policy.ts";
import { CONFLICT_MERGE } from "../../src/harness-seed/loop/director/conflict-worker.ts";
import {
  dependentsOf,
  lostRegistrations,
  RegistrationKind,
  registryRefusal,
} from "../../src/harness-seed/loop/registry.ts";
import { verifyChallenger } from "../../src/harness-seed/loop/facet/phases/verify.ts";
import { NotLandedReason, VerdictSource } from "../../src/harness-seed/loop/verdict.ts";
import { WorkerMode } from "../../src/harness-seed/loop/outcomes.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A plan of two looping parts, as the lead types it. */
const PARTS = [
  { id: "car", title: "Car handling", seam: "the car", owns: "src/car.js", done: ["the car drifts"], minutes: 30 },
  { id: "city", title: "City", seam: "the city", owns: "src/city.js", done: ["districts"], minutes: 30 },
];
const CONTRACT = {
  conventions: ["steer +1 = right", "metres"],
  modules: [
    {
      path: "src/car.js",
      owner: "car",
      api: ["export function stepCar(state, input, dt)"],
      state: "car",
      registers: { cameras: ["chase"] },
    },
    { path: "src/city.js", owner: "city", api: ["export function buildCity(scene)"] },
  ],
  shared: [{ path: "src/state.js", owner: "car" }],
};
const planArgs = (contract: unknown = CONTRACT, parts: unknown[] = PARTS) => ({
  summary: "This run: a city to drive through.",
  workers: JSON.stringify(parts),
  ...(contract === null ? {} : { contract: JSON.stringify(contract) }),
});

describe("the plan's module contract, held to its shape", () => {
  it("keeps a contract on the plan, and a plan without one exactly as it was", () => {
    const compiled = compilePlan(planArgs());
    assert.equal(compiled.error, undefined, compiled.error);
    assert.deepEqual(
      compiled.plan!.contract.modules.map((m: { path: string; owner: string }) => [m.path, m.owner]),
      [
        ["src/car.js", "car"],
        ["src/city.js", "city"],
      ],
    );
    assert.deepEqual(compiled.plan!.contract.conventions, ["steer +1 = right", "metres"]);
    assert.deepEqual(compiled.plan!.contract.modules[0].registers, { cameras: ["chase"], demos: [], probes: [] });
    const without = compilePlan(planArgs(null));
    assert.ok(!("contract" in without.plan!), "no contract key on a plan without one");
    assert.ok(!("single" in without.plan!.workers[0]), "a part says single only when it is");
  });

  it("refuses two owners for one path and an owner that is no part, by code, with the grammar", () => {
    const twice = parseModuleContract({ modules: [...CONTRACT.modules, { path: "src/car.js", owner: "city" }] }, [
      "car",
      "city",
    ]);
    assert.equal(twice.problem?.code, ContractRefusal.OwnedTwice);
    const sharedTwice = parseModuleContract(
      { modules: CONTRACT.modules, shared: [{ path: "src/city.js", owner: "car" }] },
      ["car", "city"],
    );
    assert.equal(sharedTwice.problem?.code, ContractRefusal.OwnedTwice, "a shared file is a path like any other");
    const stranger = parseModuleContract({ modules: [{ path: "src/x.js", owner: "hud" }] }, ["car", "city"]);
    assert.equal(stranger.problem?.code, ContractRefusal.UnknownOwner);
    assert.equal(parseModuleContract({ modules: [] }, ["car"]).problem?.code, ContractRefusal.NoModules);
    assert.equal(parseModuleContract("{not json", ["car"]).problem?.code, ContractRefusal.NotJson);
    const refused = compilePlan(planArgs({ modules: [{ path: "src/car.js", owner: "hud" }] }));
    assert.match(String(refused.error), /^plan: contract owner is not a part of this plan/);
    assert.match(String(refused.error), /contract is JSON: \{"conventions"/, "the refusal carries the grammar");
  });

  it("takes only a file relative to the game as a contract path", () => {
    const hostile = [
      "../outside.js",
      "/etc/passwd",
      "src/../../x.js",
      "src/*.js",
      "src/[ab].js",
      ".git/config",
      "src//car.js",
      "-rf",
      "a\\b.js",
      "line\nbreak.js",
      "",
    ];
    for (const value of hostile) {
      assert.equal(contractPath(value), null, JSON.stringify(value));
      const parsed = parseModuleContract({ modules: [{ path: value, owner: "car" }] }, ["car"]);
      assert.equal(parsed.problem?.code, ContractRefusal.BadPath, JSON.stringify(value));
    }
    assert.equal(contractPath("./src/car.js"), "src/car.js");
    assert.equal(contractPath("src/it's $(odd) name.js"), "src/it's $(odd) name.js", "quoted later, never refused");
  });

  it("counts a part marked single out of the looping parts", () => {
    const compiled = compilePlan(planArgs(null, [PARTS[0], { ...PARTS[1], mode: "single" }]));
    assert.equal(compiled.plan!.workers[1].single, true);
    // In any case, as worker_start reads mode= (review).
    const upper = compilePlan(planArgs(null, [PARTS[0], { ...PARTS[1], mode: "Single" }]));
    assert.equal(upper.plan!.workers[1].single, true);
  });
});

describe("the contract file and a worker's pointer to it", () => {
  const contract = parseModuleContract(CONTRACT, ["car", "city"]).contract!;

  it("renders every module with its owner, API, state and registrations, and the shared files", () => {
    const text = renderArchitecture(contract, { car: "Car handling", city: "City" });
    assert.equal(renderArchitecture(contract, { car: "Car handling", city: "City" }), text, "pure");
    for (const line of [
      "### src/car.js — owned by `car` (Car handling)",
      "- api: `export function stepCar(state, input, dt)`",
      "- state: `state.car`",
      "- registers cameras: chase",
      "### src/city.js — owned by `city` (City)",
      "- src/state.js — owned by `car`; the other parts read it",
      "- steer +1 = right",
    ])
      assert.ok(text.includes(line), `${line}\n---\n${text}`);
  });

  it("points a worker at the file, with its own modules' API and the conventions — not the others'", () => {
    const pointer = contractPointer(
      contract,
      contract.modules.filter((m) => m.owner === "city"),
    );
    assert.match(pointer, /docs\/MODULE-CONTRACT\.md/);
    assert.match(pointer, /src\/city\.js \(api: export function buildCity\(scene\)\)/);
    assert.match(pointer, /Conventions: steer \+1 = right; metres/);
    assert.ok(!pointer.includes("stepCar"), "another part's API stays in the file");
  });

  it("finds a seam that reaches another part's module: the path, a folder above it, a glob over it", () => {
    assert.deepEqual(ownsClaimingOthers(["src/city.js"], contract, "city"), [], "its own module is no claim");
    for (const own of ["src/", "src", "src/*.js", "src/car.js", "**/state.js"])
      assert.ok(ownsClaimingOthers([own], contract, "city").length > 0, own);
  });

  it("writes a contract from the plan's seams that names only files one part owns", () => {
    const derived = derivedContract(
      [
        { id: "car", owns: ["src/car.js", "src/shared.js", "src/"] },
        { id: "city", owns: ["src/city.js", "src/shared.js", "src/new.js"] },
      ],
      new Set(["src/car.js", "src/city.js", "src/shared.js"]),
    );
    assert.equal(derived.derived, true);
    assert.deepEqual(
      derived.modules.map((m) => [m.path, m.owner]),
      [
        ["src/car.js", "car"],
        ["src/city.js", "city"],
      ],
    );
  });
});

describe("what a build registers that another part depends on", () => {
  const facets = [
    { id: "race", cameras: ["chase"], checks: [] },
    {
      id: "city",
      cameras: ["street"],
      checks: [
        { id: "lit", kind: "pixel", camera: "skyline", expr: "litFraction > 0.2" },
        { id: "crash", kind: "probe", demo: "pileup", expr: "state.traffic.cars >= 3" },
      ],
    },
  ];
  const before = {
    cameras: ["default", "street", "skyline", "chase", "orbit"],
    demos: ["pileup", "drift"],
    state: { traffic: { cars: 4 } },
    demoStates: null,
  };

  it("a camera dropped while another part uses it is one loss; dropped and unused, none", () => {
    const lost = lostRegistrations({
      before,
      after: { ...before, cameras: ["default", "skyline", "chase"] },
      dependents: dependentsOf(facets, ["race"]),
    });
    assert.deepEqual(lost, [{ kind: RegistrationKind.Camera, name: "street", usedBy: ["city"] }]);
  });

  it("a demo a check runs and a probe path a check reads are losses too", () => {
    const lost = lostRegistrations({
      before,
      after: { ...before, demos: ["drift"], state: { traffic: {} } },
      dependents: dependentsOf(facets, ["race"]),
    });
    assert.deepEqual(
      lost.map((l) => [l.kind, l.name, l.usedBy]),
      [[RegistrationKind.Demo, "pileup", ["city"]]],
      "a demo-scoped probe neither look ran its demo for is not compared (review)",
    );
    // Both looks ran the demo: the path it read before and not after is a loss.
    const ran = (cars: Record<string, unknown>) => ({ ...before, demoStates: { pileup: { traffic: cars } } });
    assert.deepEqual(
      lostRegistrations({ before: ran({ cars: 4 }), after: ran({}), dependents: dependentsOf(facets, ["race"]) }).map(
        (l) => [l.kind, l.name, l.usedBy],
      ),
      [[RegistrationKind.Probe, "state.traffic.cars", ["city"]]],
    );
  });

  it("a look that could not read the state loses no probe: missing, truncated or cut", () => {
    for (const state of [
      { __missing: true },
      { __truncated: true, length: 90_000 },
      { traffic: {}, __cut: { chars: 90_000, paths: ["traffic.cars"] } },
    ]) {
      const lost = lostRegistrations({ before, after: { ...before, state }, dependents: dependentsOf(facets) });
      assert.deepEqual(lost, [], JSON.stringify(state));
    }
    assert.deepEqual(
      lostRegistrations({
        before: { ...before, cameras: null },
        after: { ...before, cameras: [] },
        dependents: dependentsOf(facets),
      }),
      [],
      "a look with no registry to compare loses nothing",
    );
  });

  it("refuses a facet's challenger by name, and never over its own cameras", () => {
    const refusal = registryRefusal({
      facetId: "race",
      facets,
      incumbent: { registeredCameras: before.cameras, registeredDemos: before.demos },
      challenger: { registeredCameras: ["default", "skyline"], registeredDemos: before.demos },
    });
    assert.match(String(refusal?.gap), /lost camera "street", which city depends on/);
    assert.equal(refusal?.lost.length, 1, "chase and orbit are race's own or nobody's");
  });
});

/** A verify phase over two looks at the same build, with nothing measured but the registry. */
async function verifyOver(
  challenger: Record<string, unknown>,
  {
    facets = [
      { id: "race", cameras: ["chase"], checks: [] },
      { id: "city", cameras: ["street"], checks: [] },
    ],
    incumbent = { registeredCameras: ["default", "street", "chase"], registeredDemos: [] },
  }: { facets?: unknown[]; incumbent?: Record<string, unknown> } = {},
) {
  const recorder = ctxRecorder({ handlers: { "events.append": () => true } });
  const loop = {
    ctx: recorder.ctx,
    run: { runId: "run_registry", project: "apex" },
    facet: { id: "race", title: "Race" },
    spec: { id: "race", title: "Race", checks: [] },
    board: {},
    legacy: false,
    facets,
    incumbentEvidence: { ok: true, shots: [], ...incumbent },
    handle: null,
    deadline: Date.now() + 60 * 60_000,
    budgetMs: 60 * 60_000,
    budgets: { observationDelays: [] },
    hasTime: () => false,
    delegated: false,
    biggestGap: "the same gap",
    appendRun: async () => {},
  };
  const round = {
    evidence: { ok: true, shots: [], problems: [], ...challenger },
    gamedChecks: [],
    iteration: 1,
    iterationId: "1",
    challengerBroken: false,
  };
  await verifyChallenger(loop as never, round as never);
  return round as typeof round & { verdict: Record<string, unknown>; verdictSource: string; won: boolean };
}

describe("a facet's round that loses what another facet depends on", () => {
  it("is refused on the checks, naming the camera and the facet that depends on it", async () => {
    const lost = await verifyOver({ registeredCameras: ["default", "chase"], registeredDemos: [] });
    assert.equal(lost.won, false);
    assert.equal(lost.verdictSource, VerdictSource.Checks);
    assert.match(String(lost.verdict.biggest_gap), /lost camera "street", which city depends on/);
    const kept = await verifyOver({ registeredCameras: ["default", "street"], registeredDemos: [] });
    assert.notEqual(kept.verdictSource, VerdictSource.Checks, "dropping its own camera is its own business");
  });
});

/** A real repository standing in for the integration worktree: a base commit with the entry. */
async function integrationRepo() {
  const root = await tmpDir("studio-contract-");
  const repo = path.join(root, "integration");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(repo, "index.html"), "<canvas></canvas>\n");
  await writeFile(path.join(repo, "src", "main.js"), "// FACET WIRING\n");
  await fixtureGit(repo, ["add", "-A"]);
  await fixtureGit(repo, ["commit", "-q", "-m", "base"]);
  return { root, repo, head: await fixtureGit(repo, ["rev-parse", "HEAD"]) };
}

/** Commit files in the repository with the fixture's identity; answers the new head. */
async function commitFiles(repo: string, files: Record<string, string>, message = "change"): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), text);
  }
  await fixtureGit(repo, ["add", "-A"]);
  await fixtureGit(repo, ["commit", "-q", "-m", message]);
  return fixtureGit(repo, ["rev-parse", "HEAD"]);
}

type Look = Record<string, any>;

/** A run with only what the contract gate and `integrate` read, over a real repository. */
function stubLoopRun(repo: string, head: string, plan: Record<string, any> | null) {
  const events: Array<{ type: string; payload: Record<string, any> }> = [];
  const notes: string[] = [];
  const looks: Array<Record<string, any>> = [];
  const recorder = ctxRecorder({
    handlers: {
      "run.exec": (p) => sh(String(p.command), String(p.cwd)),
      "assets.checkpoint": () => ({ committed: false }),
    },
  });
  const loopRun: Record<string, any> = {
    ctx: recorder.ctx,
    run: { runId: "run_contract", project: "apex", setup: null },
    integrationWorktree: repo,
    shape: { main: "src/main.js" },
    ownShape: false,
    lead: null,
    nestedRepos: [],
    journal: { director: { integrationHead: head } },
    state: {
      plan,
      integrationHead: head,
      integrationHealthy: null,
      workers: new Map(),
      evidenceByHead: new Map(),
      healthByHead: new Map(),
      consoleByHead: new Map(),
      baseHeads: new Set(),
      facetSpecs: [],
      ledger: [],
    },
    /** What the next health pass sees: a function of the head it looks at. */
    look: (_head: string): Look => ({ ok: true, problems: [], warnings: [], shots: [] }),
    note: (text: string) => void notes.push(text),
    appendRun: async (type: string, payload: Record<string, any>) => void events.push({ type, payload }),
    saveJournal: async () => {},
    protectHead: async () => {},
    decision: async () => {},
    writeVerdict: async () => {},
    recordVerdict: async () => ({}),
    workerCommit: async (worker: Record<string, any>) => worker.lastCommit,
    consoleInheritedBy: () => [],
    errorsLogged: () => [],
    shotsOf: () => [],
    ledgerLines: () => [],
    nestedGit: async () => "",
    withLease: (_lease: string, fn: (handle: string | null) => unknown) => fn(null),
    patientEvidence: async (_root: string, options: Record<string, any>) => {
      looks.push(options);
      return loopRun.look(loopRun.state.integrationHead);
    },
    // What the run keeps of a look, exactly as loop-run.ts keeps it.
    rememberEvidence: (commit: string, evidence: Look, options?: Record<string, unknown>) =>
      rememberHeadEvidence(loopRun as never, commit, evidence as never, options as never),
  };
  return { loopRun, events, notes, looks, recorder };
}

/** A worker branch off `from` that writes its own file: answers its commit. */
async function workerBranch(repo: string, from: string, name: string, files: Record<string, string>): Promise<string> {
  await fixtureGit(repo, ["checkout", "-q", "-b", name, from]);
  const commit = await commitFiles(repo, files, `worker ${name}`);
  await fixtureGit(repo, ["checkout", "-q", "main"]);
  return commit;
}

describe("the contract on the integration branch, and the gate a loop worker passes", () => {
  const plan = () => compilePlan(planArgs()).plan!;

  it("commits the contract file on the plan and names the stubs still to write", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun, events } = stubLoopRun(repo, head, plan());
    const said = await contractOnPlan(loopRun as never);
    const committed = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    assert.notEqual(committed, head, "one commit on the integration branch");
    assert.equal(loopRun.state.contract.commit, committed);
    assert.equal(loopRun.state.integrationHead, committed);
    assert.deepEqual(
      (await fixtureGit(repo, ["show", "--name-only", "--format=", "HEAD"])).split("\n"),
      [ARCHITECTURE_FILE],
      "that file alone",
    );
    assert.match(await readFile(path.join(repo, ARCHITECTURE_FILE), "utf8"), /### src\/car\.js — owned by `car`/);
    assert.match(
      String(said),
      /Stubs still to write before their loop workers start: src\/car\.js, src\/city\.js, src\/state\.js/,
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["director_progress"],
    );
    assert.equal(await contractOnPlan(loopRun as never), null, "the same contract again commits nothing");
  });

  it("tells a lead, which builds with its own hands in the integration worktree, to write the stubs there itself and commit — a single worker is the other way", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, plan());
    loopRun.lead = { folder: "/games/apex", chatSession: true };
    const said = String(await contractOnPlan(loopRun as never));
    assert.match(said, /Stubs still to write before their loop workers start: src\/car\.js/);
    const stubs = said.slice(said.indexOf("Stubs still to write"));
    assert.match(stubs, /yourself in the integration worktree/);
    assert.ok(stubs.includes(repo), "named by its full path");
    assert.ok(stubs.indexOf("yourself") < stubs.indexOf("mode=single"), "its own commit comes first, a worker second");
  });

  it("refuses a loop worker without a contract twice, then writes one from the plan's seams", async () => {
    const { repo, head } = await integrationRepo();
    await commitFiles(repo, { "src/car.js": "export {};\n" });
    const { loopRun, notes } = stubLoopRun(
      repo,
      await fixtureGit(repo, ["rev-parse", "HEAD"]),
      compilePlan(planArgs(null)).plan!,
    );
    for (let i = 0; i < CONTRACT_REFUSALS_BEFORE_DERIVED; i++) {
      const refused = await contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop);
      assert.match(String(refused), /2 parts that loop, and no module contract yet: call plan again with contract=/);
    }
    assert.equal(loopRun.state.contract, undefined, "nothing written while the lead can still write one");
    assert.equal(await contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop), null);
    assert.equal(loopRun.state.contract.spec.derived, true);
    assert.deepEqual(
      loopRun.state.contract.spec.modules.map((m: { path: string }) => m.path),
      ["src/car.js"],
      "only the seams that exist",
    );
    assert.ok(
      notes.some((n) => /the harness wrote one from the plan's owns/.test(n)),
      notes.join("\n"),
    );
    assert.notEqual(head, loopRun.state.integrationHead);
  });

  it("keeps the game's own docs/ARCHITECTURE.md byte for byte, and still commits the contract", async () => {
    const own = "docs/ARCHITECTURE.md";
    const handWritten = "# My game's own architecture notes\nhand written\n";
    const paths = [
      { name: "the lead's contract on the plan", plan: () => plan(), gate: contractOnPlan },
      {
        name: "the contract the harness derives after two refusals",
        plan: () => compilePlan(planArgs(null)).plan!,
        gate: async (loopRun: never) => {
          for (let i = 0; i <= CONTRACT_REFUSALS_BEFORE_DERIVED; i++)
            await contractBeforeFork(loopRun, { id: "car" }, WorkerMode.Loop);
        },
      },
    ];
    for (const { name, plan: planOf, gate } of paths) {
      const { repo } = await integrationRepo();
      const base = await commitFiles(repo, { [own]: handWritten, "src/car.js": "export {};\n" }, "the user's docs");
      const { loopRun } = stubLoopRun(repo, base, planOf());
      await gate(loopRun as never);
      assert.ok(loopRun.state.contract?.commit, `${name}: the contract is committed, so workers are not stalled`);
      assert.equal(await readFile(path.join(repo, own), "utf8"), handWritten, `${name}: the working file`);
      assert.equal(await fixtureGit(repo, ["show", `HEAD:${own}`]), handWritten.trimEnd(), `${name}: the head`);
      assert.match(await readFile(path.join(repo, ARCHITECTURE_FILE), "utf8"), /### src\/car\.js — owned by `car`/);
    }
  });

  it("never holds a single session, a conflict worker or a plan of one looping part", async () => {
    const { repo, head } = await integrationRepo();
    const exempt = [
      { plan: plan(), args: { id: "stubs" }, mode: WorkerMode.Single },
      { plan: plan(), args: { id: "car", [CONFLICT_MERGE]: { of: "car", commit: head } }, mode: WorkerMode.Loop },
      { plan: compilePlan(planArgs(null, [PARTS[0]])).plan!, args: { id: "car" }, mode: WorkerMode.Loop },
      {
        plan: compilePlan(planArgs(null, [PARTS[0], { ...PARTS[1], mode: "single" }])).plan!,
        args: { id: "car" },
        mode: WorkerMode.Loop,
      },
    ];
    for (const { plan: exemptPlan, args, mode } of exempt) {
      const { loopRun } = stubLoopRun(repo, head, exemptPlan);
      assert.equal(await contractBeforeFork(loopRun as never, args, mode), null, JSON.stringify(args));
      assert.deepEqual(await contractAtFork(loopRun as never, { id: args.id, args, mode, commit: head }), {
        owns: null,
      });
    }
  });

  it("refuses a fork without the contract, a worker whose modules are not stubbed, and a seam over another's module", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, plan());
    await contractOnPlan(loopRun as never);
    const gate = (args: Record<string, unknown>, commit: string) =>
      contractAtFork(loopRun as never, { id: String(args.id), args, mode: WorkerMode.Loop, commit });
    const before = await gate({ id: "car" }, head);
    assert.match(String(before.refusal), /does not contain the module contract/);
    const contract = loopRun.state.contract.commit;
    const unstubbed = await gate({ id: "car" }, contract);
    assert.match(
      String(unstubbed.refusal),
      /the contract gives "car" src\/car\.js, src\/state\.js, which do not exist/,
    );
    const stubbed = await commitFiles(repo, {
      "src/car.js": "export function stepCar() {}\n",
      "src/state.js": "export const state = {};\n",
    });
    assert.deepEqual(await gate({ id: "car" }, stubbed), { owns: ["src/car.js", "src/state.js"] }, "its contract seam");
    assert.deepEqual(await gate({ id: "car", owns: "src/car.js" }, stubbed), { owns: null }, "a seam of its own");
    const wide = await gate({ id: "car", owns: "src/" }, stubbed);
    assert.match(String(wide.refusal), /owns= would reach other parts' modules \(src\/ → src\/city\.js, city's\)/);
    const restart = await gate({ id: "car-2", replaces: "car" }, stubbed);
    assert.deepEqual(restart, { owns: ["src/car.js", "src/state.js"] }, "a restart is the same part");
  });

  it("never runs a path or a commit a contract names: every git question is quoted", async () => {
    const { root, repo, head } = await integrationRepo();
    const { recorder } = stubLoopRun(repo, head, null);
    const hostile = [
      "src/$(touch dollar).js",
      "src/`touch backtick`.js",
      "src/a; touch semi.js",
      "src/it's.js",
      "src/a && touch and.js",
    ];
    assert.deepEqual(await missingAt(recorder.ctx as never, repo, head, hostile), hostile, "none of them exists");
    assert.equal(await holdsContract(recorder.ctx as never, repo, "$(touch c)", head), false, "not a commit: no");
    assert.equal(await holdsContract(recorder.ctx as never, repo, head, "HEAD; touch d"), false);
    assert.deepEqual((await readdir(repo)).sort(), [".git", "index.html", "src"], "nothing in the names ran");
    assert.deepEqual((await readdir(path.join(repo, "src"))).sort(), ["main.js"]);
    assert.deepEqual((await readdir(root)).sort(), ["integration"]);
  });

  it("writes the contract only inside the worktree: a linked docs folder or file writes nothing", async () => {
    const cases = [
      {
        name: "docs is a link out of the worktree",
        arrange: async (repo: string, outside: string) => symlink(outside, path.join(repo, "docs")),
      },
      {
        name: "the contract file is a link out of the worktree",
        arrange: async (repo: string, outside: string) => {
          await mkdir(path.join(repo, "docs"));
          await symlink(path.join(outside, "victim.md"), path.join(repo, ARCHITECTURE_FILE));
        },
      },
      {
        name: "the contract file is a folder",
        arrange: async (repo: string) => mkdir(path.join(repo, ARCHITECTURE_FILE), { recursive: true }),
      },
    ];
    for (const { name, arrange } of cases) {
      const { root, repo } = await integrationRepo();
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "victim.md"), "untouched\n");
      await arrange(repo, outside);
      const refused = await writeArchitecture(repo, "# Architecture\n");
      assert.ok(refused, name);
      assert.deepEqual((await readdir(outside)).sort(), ["victim.md"], name);
      assert.equal(await readFile(path.join(outside, "victim.md"), "utf8"), "untouched\n", name);
    }
  });
});

describe("integration in waves", () => {
  it("merges a wave in order with one integration_merge each and ONE health pass, and closes the wave", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun, events, looks } = stubLoopRun(repo, head, null);
    const car = await workerBranch(repo, head, "car", { "src/car.js": "export const car = 1;\n" });
    const city = await workerBranch(repo, head, "city", { "src/city.js": "export const city = 1;\n" });
    for (const [id, commit] of [
      ["car", car],
      ["city", city],
    ])
      loopRun.state.workers.set(id, { id, title: id, from: head, lastCommit: commit, merging: null });
    loopRun.state.facetSpecs.push({
      id: "hud",
      cameras: [],
      checks: [{ id: "lap", kind: "probe", demo: "lap", expr: "state.lap >= 1" }],
    });
    const answer = JSON.parse(await integrate(loopRun as never, { worker: "car,city" }));
    assert.equal(answer.merged, true, JSON.stringify(answer));
    assert.deepEqual(answer.wave, { merged: ["car", "city"] });
    assert.deepEqual(
      events.filter((e) => e.type === "integration_merge").map((e) => e.payload.facetId),
      ["car", "city"],
    );
    assert.equal(events.filter((e) => e.type === "integration_health").length, 1, "one health pass for the wave");
    assert.equal(looks.length, 1);
    assert.deepEqual(looks[0]!.requiredDemos, ["lap"], "the demos workers' checks name");
    assert.equal(looks[0]!.maxDemos, 0);
    const merged = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    assert.equal(loopRun.state.waveHead, merged, "a healthy integrate closes the wave");
    // The lead's own commit moves the integration head, not the wave: workers take it with the next.
    const fix = await commitFiles(repo, { "src/main.js": "// FACET WIRING\n// fixed\n" }, "lead fix");
    loopRun.state.integrationHead = fix;
    assert.equal(loopRun.state.waveHead, merged);
    const closed = JSON.parse(await integrate(loopRun as never, { wave: "close" }));
    assert.equal(closed.wave, "closed");
    assert.equal(loopRun.state.waveHead, fix);
  });

  it("a clean merge brings each merged loop worker into the first wave the art director waits for", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, null);
    const car = await workerBranch(repo, head, "car", { "src/car.js": "export const car = 1;\n" });
    const city = await workerBranch(repo, head, "city", { "src/city.js": "export const city = 1;\n" });
    const building = (id: string, commit: string) => ({
      id,
      title: id,
      from: head,
      lastCommit: commit,
      merging: null,
      mode: WorkerMode.Loop,
      state: "running",
      spec: { id, checks: [] },
    });
    loopRun.state.workers.set("car", building("car", car));
    loopRun.state.workers.set("city", building("city", city));
    const waveIn = () => firstWaveIn(loopRun as never);
    assert.equal(waveIn(), false, "nothing merged yet");
    JSON.parse(await integrate(loopRun as never, { worker: "car" }));
    assert.equal(waveIn(), false, "city's kept work is not in yet");
    JSON.parse(await integrate(loopRun as never, { worker: "city" }));
    assert.equal(waveIn(), true, "every running loop worker has kept work on the integration branch");
  });

  it("answers a single worker's merge with exactly the keys it always had", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, null);
    const car = await workerBranch(repo, head, "car", { "src/car.js": "export const car = 1;\n" });
    loopRun.state.workers.set("car", { id: "car", title: "car", from: head, lastCommit: car, merging: null });
    const answer = JSON.parse(await integrate(loopRun as never, { worker: "car" }));
    assert.deepEqual(Object.keys(answer), ["merged", "union", "head", "health", "next"]);
    assert.equal(answer.next, "judge or look at integration before you build on it");
  });

  it("fails the health pass of a merge that lost a demo another worker's check runs, and names it", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun, notes } = stubLoopRun(repo, head, null);
    loopRun.state.evidenceByHead.set(head, { state: {}, demoStates: null, demos: ["pileup"], cameras: ["default"] });
    loopRun.state.facetSpecs.push({
      id: "city",
      cameras: [],
      checks: [{ id: "crash", kind: "probe", demo: "pileup", expr: "state.cars >= 3" }],
    });
    loopRun.look = () => ({
      ok: true,
      problems: [],
      warnings: [],
      shots: [],
      registeredCameras: ["default"],
      registeredDemos: [],
      state: {},
    });
    const race = await workerBranch(repo, head, "race", { "src/race.js": "export const race = 1;\n" });
    loopRun.state.workers.set("race", { id: "race", title: "race", from: head, lastCommit: race, merging: null });
    const answer = JSON.parse(await integrate(loopRun as never, { worker: "race" }));
    assert.equal(answer.health.ok, false);
    assert.match(answer.health.problems.join("\n"), /lost demo "pileup", which city depends on/);
    assert.deepEqual(answer.lost, [{ kind: "demo", name: "pileup", usedBy: ["city"] }]);
    assert.match(answer.next, /lost what another worker depends on/);
    assert.equal(loopRun.state.integrationHealthy, false);
    assert.equal(loopRun.state.waveHead, undefined, "an unhealthy merge closes no wave");
    assert.ok(
      notes.some((n) => /integrated race → .*health problems/.test(n)),
      notes.join("\n"),
    );
  });

  it("stops a wave at its first conflict and says what merged and what was not tried", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun, events } = stubLoopRun(repo, head, null);
    const car = await workerBranch(repo, head, "car", { "src/shared.js": "car\n" });
    const city = await workerBranch(repo, head, "city", { "src/shared.js": "city\n" });
    const hud = await workerBranch(repo, head, "hud", { "src/hud2.js": "hud\n" });
    for (const [id, commit] of [
      ["car", car],
      ["city", city],
      ["hud", hud],
    ])
      loopRun.state.workers.set(id, { id, title: id, from: head, lastCommit: commit, merging: null });
    const answer = JSON.parse(await integrate(loopRun as never, { worker: "car,city,hud" }));
    assert.equal(answer.merged, false);
    assert.deepEqual(answer.conflict, ["src/shared.js"]);
    assert.deepEqual(answer.wave, { merged: ["car"], notTried: ["hud"], skipped: {} });
    assert.equal(events.filter((e) => e.type === "integration_health").length, 0, "no health pass on half a wave");
    assert.equal(loopRun.state.integrationHealthy, null);
  });
});

/** A worker's spec as the director compiles it: every one looks through the harness's own `default` view. */
const workerSpec = (
  id: string,
  checks: unknown[] = [{ id: "lit", kind: "pixel", expr: "meanLuma > 0.1" }],
  cameras: string[] = [],
) => compileWorkerSpec({ id, title: id, brief: "b", owns: [`src/${id}.js`], cameras, checks } as never, null, {}).spec;

/** A look the health pass takes of the merged head. */
const healthLook = (over: Record<string, unknown>): Look => ({
  ok: true,
  problems: [],
  warnings: [],
  shots: [],
  registeredDemos: [],
  ...over,
});

/** The frames a look photographed, by camera. */
const shotsOf = (names: string[]) => names.map((camera) => ({ camera }));

/** A worker on its own branch off the integration head, ready to be merged. */
async function readyWorker(repo: string, loopRun: Record<string, any>, id: string): Promise<void> {
  const from = loopRun.state.integrationHead;
  const commit = await workerBranch(repo, from, id, { [`src/${id}.js`]: `export const ${id} = 1;\n` });
  loopRun.state.workers.set(id, { id, title: id, from, lastCommit: commit, merging: null });
}

describe("the harness's own view is never a registration (review)", () => {
  it("a template game's first named camera is no loss, though every compiled spec looks through default", async () => {
    // studio.js answers ["default"] for a game with no config.cameras, and only the named ones once it has any.
    const facets = [workerSpec("car"), workerSpec("city")];
    assert.ok(facets[1]!.cameras.includes("default"), "the compiled spec does look through default");
    const refusal = registryRefusal({
      facetId: "car",
      facets,
      incumbent: { registeredCameras: ["default"], registeredDemos: [], state: { a: 1 } },
      challenger: { registeredCameras: ["chase"], registeredDemos: [], state: { a: 1 } },
    });
    assert.equal(refusal, null, JSON.stringify(refusal));
    const round = await verifyOver(
      { registeredCameras: ["chase"], registeredDemos: [], state: { a: 1 } },
      { facets, incumbent: { registeredCameras: ["default"], registeredDemos: [], state: { a: 1 } } },
    );
    assert.notEqual(round.verdictSource, VerdictSource.Checks, String(round.verdict?.biggest_gap));
    // A named camera another compiled spec's check looks through is still a loss.
    const top = registryRefusal({
      facetId: "car",
      facets: [
        workerSpec("car"),
        workerSpec("city", [{ id: "sky", kind: "pixel", camera: "top", expr: "meanLuma > 0.1" }]),
      ],
      incumbent: { registeredCameras: ["chase", "top"], registeredDemos: [], state: { a: 1 } },
      challenger: { registeredCameras: ["chase"], registeredDemos: [], state: { a: 1 } },
    });
    assert.match(String(top?.gap), /lost camera "top", which city depends on/);
  });

  it("a merge compares the cameras the page registered, not the shots: default photographed before is no loss", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, null);
    loopRun.state.facetSpecs.push(
      workerSpec("city", [{ id: "sky", kind: "pixel", camera: "top", expr: "meanLuma > 0.1" }]),
    );
    // The head before, as a judge kept it: default is always photographed, and the page registers named ones only.
    loopRun.rememberEvidence(head, {
      ok: true,
      state: { a: 1 },
      shots: shotsOf(["default", "chase", "top"]),
      registeredCameras: ["chase", "top"],
      registeredDemos: [],
    });
    loopRun.look = () =>
      healthLook({ state: { a: 1 }, shots: shotsOf(["default", "chase", "top"]), registeredCameras: ["chase", "top"] });
    await readyWorker(repo, loopRun, "race");
    const kept = JSON.parse(await integrate(loopRun as never, { worker: "race" }));
    assert.equal(kept.health.ok, true, JSON.stringify(kept));
    assert.equal(kept.lost, undefined);
    // The next merge drops "top", which city's check looks through: that one is a loss.
    loopRun.look = () =>
      healthLook({ state: { a: 1 }, shots: shotsOf(["default", "chase"]), registeredCameras: ["chase"] });
    await readyWorker(repo, loopRun, "hud");
    const lost = JSON.parse(await integrate(loopRun as never, { worker: "hud" }));
    assert.deepEqual(lost.lost, [{ kind: "camera", name: "top", usedBy: ["city"] }]);
  });
});

describe("a wave that breaks one of its own workers (review)", () => {
  it("fails the wave's health pass when one merged worker drops a camera another merged worker's checks use", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, null);
    loopRun.state.facetSpecs.push(
      workerSpec("car", [{ id: "drift", kind: "pixel", camera: "chase", expr: "meanLuma > 0.1" }]),
      workerSpec("city"),
    );
    loopRun.rememberEvidence(head, {
      ok: true,
      state: { a: 1 },
      shots: shotsOf(["default", "chase"]),
      registeredCameras: ["chase"],
      registeredDemos: [],
    });
    // city's merge deleted config.cameras.chase: the merged page registers the default view only.
    loopRun.look = () => healthLook({ state: { a: 1 }, shots: shotsOf(["default"]), registeredCameras: ["default"] });
    await readyWorker(repo, loopRun, "car");
    const city = await workerBranch(repo, head, "city", { "src/city.js": "export const city = 1;\n" });
    loopRun.state.workers.set("city", { id: "city", title: "city", from: head, lastCommit: city, merging: null });
    const answer = JSON.parse(await integrate(loopRun as never, { worker: "car,city" }));
    assert.equal(answer.health.ok, false, JSON.stringify(answer));
    assert.deepEqual(answer.lost, [{ kind: "camera", name: "chase", usedBy: ["car"] }]);
    assert.equal(loopRun.state.waveHead, undefined, "an unhealthy wave closes nothing");
  });
});

describe("probe losses only between looks taken alike (review)", () => {
  const city = {
    id: "city",
    cameras: [],
    checks: [{ id: "crash", kind: "probe", demo: "pileup", expr: "state.traffic.cars >= 3" }],
  };

  it("a demo-scoped probe whose demo one look did not run is not compared", () => {
    const before = { cameras: [], demos: ["pileup"], state: {}, demoStates: { pileup: { traffic: { cars: 4 } } } };
    const notRun = lostRegistrations({
      before,
      after: { ...before, demoStates: { drift: { traffic: {} } } },
      dependents: dependentsOf([city]),
    });
    assert.deepEqual(notRun, [], "the other facet's demo was not run in this look");
    const ran = lostRegistrations({
      before,
      after: { ...before, demoStates: { pileup: { traffic: {} } } },
      dependents: dependentsOf([city]),
    });
    assert.deepEqual(ran, [{ kind: RegistrationKind.Probe, name: "state.traffic.cars", usedBy: ["city"] }]);
  });

  it("a merge compares probes only with a head its own health pass looked at, under the same setup", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, null);
    loopRun.state.facetSpecs.push(workerSpec("city", [{ id: "cars", kind: "probe", expr: "state.traffic.cars >= 3" }]));
    // A judge kept this head under the setup it asked for: paths only that setup reaches.
    loopRun.rememberEvidence(head, { ok: true, state: { traffic: { cars: 4 } }, shots: [], registeredDemos: [] });
    loopRun.look = () => healthLook({ state: { traffic: {} } });
    await readyWorker(repo, loopRun, "race");
    const kept = JSON.parse(await integrate(loopRun as never, { worker: "race" }));
    assert.equal(kept.health.ok, true, JSON.stringify(kept));
    // Health pass after health pass, both under the run's setup: a path gone is a loss.
    loopRun.look = () => healthLook({ state: { traffic: { cars: 4 } } });
    await readyWorker(repo, loopRun, "hud");
    assert.equal(JSON.parse(await integrate(loopRun as never, { worker: "hud" })).health.ok, true);
    loopRun.look = () => healthLook({ state: { traffic: {} } });
    await readyWorker(repo, loopRun, "sky");
    const lost = JSON.parse(await integrate(loopRun as never, { worker: "sky" }));
    assert.deepEqual(lost.lost, [{ kind: "probe", name: "state.traffic.cars", usedBy: ["city"] }]);
  });
});

describe("a contract that could not be committed (review)", () => {
  it("retries the contract it derives once the cause is gone, rather than refusing every loop worker", async () => {
    const { root, repo } = await integrationRepo();
    const stub = await commitFiles(repo, { "src/car.js": "export {};\n", "src/city.js": "export {};\n" });
    const { loopRun } = stubLoopRun(repo, stub, compilePlan(planArgs(null)).plan!);
    const start = () => contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop);
    for (let i = 0; i < CONTRACT_REFUSALS_BEFORE_DERIVED; i++) assert.ok(await start());
    // docs/ is a link out of the worktree: the derived contract is not written.
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(repo, "docs"));
    const failed = await start();
    assert.ok(failed, "refused while the contract cannot be written");
    assert.ok(loopRun.state.contractError);
    await unlink(path.join(repo, "docs"));
    assert.equal(await start(), null, "the derived contract is written on the next start");
    assert.ok(loopRun.state.contract, "and held");
    assert.equal(loopRun.state.contractError, null);
    assert.deepEqual(await readdir(outside), [], "nothing was written through the link");
    // A contract the lead gave that could not be committed still asks the lead to give it again.
    const given = stubLoopRun(repo, stub, compilePlan(planArgs()).plan!).loopRun;
    given.state.contractError = "git commit failed";
    const again = await contractBeforeFork(given as never, { id: "car" }, WorkerMode.Loop);
    assert.match(String(again), /git commit failed/);
  });
});

describe("a game the user brought, under a contract (review)", () => {
  it("lets a second contracted loop worker start with no owns=: its contract modules are its seam", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, compilePlan(planArgs()).plan!);
    await contractOnPlan(loopRun as never);
    const car = { id: "car", owns: ["src/car.js", "src/state.js"], ownsMain: false };
    Object.assign(loopRun, {
      ownShape: true,
      softDeadline: Date.now() + 60 * 60_000,
      priorWorkers: [],
      runningWorkers: () => [car],
    });
    loopRun.state.finish = null;
    const asked = await startRefusal(loopRun as never, "city", {});
    assert.notEqual(typeof asked, "string", String(asked));
    const single = await startRefusal(loopRun as never, "stubs", { mode: "single" });
    assert.match(String(single), /needs a seam/, "a single session has no contract seam");
  });
});

/**
 * A contract committed on the run's starting point (review): on a game from scratch the base
 * stage may accept an empty world, and the contract's commit on top of it became the fork point
 * every loop worker had to take. The fork gate looked at that commit as a game, not a start, and
 * refused every worker over the blank world the base stage had accepted; and a branch whose only
 * change was the contract file (now docs/MODULE-CONTRACT.md) counted as the run's work at the close.
 */
describe("a contract written on the run's starting point (review)", () => {
  const SEEN = { ok: true, state: { world: { groups: [] } }, shots: [{ camera: "default" }], problems: [] };
  /** A run standing on an empty starting point the base stage accepted: a base head, healthy, its look kept. */
  async function onEmptyStart(plan: Record<string, any>) {
    const { repo, head } = await integrationRepo();
    const stub = stubLoopRun(repo, head, plan);
    const { state } = stub.loopRun;
    state.baseHeads.add(head);
    state.healthByHead.set(head, true);
    state.consoleByHead.set(head, ["a warning the start already logs"]);
    stub.loopRun.rememberEvidence(head, SEEN);
    return { ...stub, repo, head };
  }
  /** What the fork gate and the close read of a commit: where it stands. */
  const standing = (state: Record<string, any>, commit: string) => ({
    base: state.baseHeads.has(commit),
    healthy: state.healthByHead.get(commit),
    console: state.consoleByHead.get(commit),
    evidence: state.evidenceByHead.get(commit),
  });

  it("the lead's contract on an empty start stands where the start stood: a starting point, healthy, its look kept", async () => {
    const { loopRun, head } = await onEmptyStart(compilePlan(planArgs()).plan!);
    await contractOnPlan(loopRun as never);
    const commit = loopRun.state.contract.commit;
    assert.notEqual(commit, head, "the contract is its own commit");
    assert.equal(loopRun.state.integrationHead, commit, "and the fork point of every loop worker");
    assert.deepEqual(standing(loopRun.state, commit), standing(loopRun.state, head));
  });

  it("so does the contract the harness derives, and one the lead gives again on top of it", async () => {
    const { loopRun, head } = await onEmptyStart(compilePlan(planArgs(null)).plan!);
    const start = () => contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop);
    for (let i = 0; i < CONTRACT_REFUSALS_BEFORE_DERIVED; i++) assert.ok(await start());
    assert.equal(await start(), null);
    const derived = loopRun.state.contract.commit;
    assert.notEqual(derived, head);
    assert.deepEqual(standing(loopRun.state, derived), standing(loopRun.state, head));
    loopRun.state.plan = compilePlan(planArgs()).plan!;
    await contractOnPlan(loopRun as never);
    const given = loopRun.state.contract.commit;
    assert.notEqual(given, derived);
    assert.deepEqual(standing(loopRun.state, given), standing(loopRun.state, head));
  });

  it("a contract on a head the run built is no starting point: only what is known of its parent carries over", async () => {
    const { loopRun, repo } = await onEmptyStart(compilePlan(planArgs()).plan!);
    const built = await commitFiles(repo, { "src/car.js": "export {};\n" }, "a worker's merge");
    loopRun.state.integrationHead = built;
    loopRun.state.healthByHead.set(built, false);
    await contractOnPlan(loopRun as never);
    const commit = loopRun.state.contract.commit;
    assert.equal(loopRun.state.baseHeads.has(commit), false);
    assert.equal(loopRun.state.healthByHead.get(commit), false, "a docs file does not make a broken build load");
    assert.equal(loopRun.state.evidenceByHead.has(commit), false, "nobody looked at its parent");
  });

  it("the close lands nothing and the art director owes no look when the branch holds only the contract", async () => {
    const cases = [
      { name: "from scratch, on the base stage's commit", scratch: true },
      { name: "on the game the user brought", scratch: false },
    ];
    for (const { name, scratch } of cases) {
      const { loopRun, head } = await onEmptyStart(compilePlan(planArgs()).plan!);
      if (!scratch) {
        loopRun.state.baseHeads.delete(head);
        loopRun.baseCommit = head;
      }
      await contractOnPlan(loopRun as never);
      const looked = loopRun.state.healthByHead.size;
      Object.assign(loopRun, {
        run: { ...loopRun.run, budgets: { completionPolicy: CompletionPolicy.Goal } },
        report: {},
        syncHead: async () => loopRun.state.integrationHead,
        runningWorkers: () => [],
        settleWorkers: async () => {},
        stopWorker: async () => {},
        closeRun: async () => {},
      });
      assert.equal(shipOwed(loopRun as never), false, name);
      const landed = await closeTheLoopRun(loopRun as never, { land: true, settleMs: 0 });
      assert.equal(landed.why, NotLandedReason.NothingNew, `${name}: ${JSON.stringify(landed)}`);
      assert.equal(loopRun.state.healthByHead.size, looked, `${name}: the close did not look`);
    }
  });

  it("a Resume keeps a contract written on the start a starting point", async () => {
    const { loopRun, head } = await onEmptyStart(compilePlan(planArgs()).plan!);
    await contractOnPlan(loopRun as never);
    const now = Date.UTC(2026, 9, 6, 2, 0, 0);
    const run = { runId: "run_j", project: "apex", goal: "a city", reference: { name: "City" } };
    /** A run with only what the journal's record and restore read, standing on the start. */
    const loopRunWith = (state: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
      run,
      started: now,
      softDeadline: now,
      finalDeadline: now,
      state: { judges: 0, plays: 0, ledger: [], workers: new Map(), log: [], planReviewUntil: 0, ...state },
      journal: { director: {} as Record<string, any> },
      ...over,
    });
    const first = loopRunWith({ baseHeads: new Set([head]), contract: loopRun.state.contract });
    recordLoopRun(first as never, now);
    const saved = structuredClone(first.journal.director);
    // `startingHeads` gives a resumed run its scaffold and base commit, never the contract's.
    const back = loopRunWith(
      { baseHeads: new Set([head]) },
      { resume: true, priorJournal: { director: saved } },
    ) as Record<string, any>;
    restoreLoopRun(back as never, now);
    assert.equal(back.state.contract.commit, loopRun.state.contract.commit);
    assert.ok(back.state.baseHeads.has(loopRun.state.contract.commit), "the fork gate looks at it as the start it is");
  });
});

describe("running loop workers follow the wave, not every commit (review)", () => {
  it("a loop worker's integration head stays on the wave's head after a lead commit until the wave closes", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun } = stubLoopRun(repo, head, null);
    const hook = loopIntegration(loopRun as never);
    assert.equal(await hook.head(), head, "before any wave: the integration head");
    loopRun.state.waveHead = head;
    const fix = await commitFiles(repo, { "src/main.js": "// FACET WIRING\n// lead\n" }, "lead fix");
    loopRun.state.integrationHead = fix;
    assert.equal(await hook.head(), head, "the lead's commit waits for the wave");
    await integrate(loopRun as never, { wave: "close" });
    assert.equal(await hook.head(), fix);
  });
});

describe("integrate's arguments (review)", () => {
  it("names worker= or wave=close when neither is given, and merges a repeated id once", async () => {
    const { repo, head } = await integrationRepo();
    const { loopRun, events } = stubLoopRun(repo, head, null);
    const empty = String(await integrate(loopRun as never, {}));
    assert.ok(!empty.includes("undefined"), empty);
    assert.match(empty, /worker=/);
    await readyWorker(repo, loopRun, "car");
    await readyWorker(repo, loopRun, "city");
    const answer = JSON.parse(await integrate(loopRun as never, { worker: "car,car,city" }));
    assert.deepEqual(answer.wave, { merged: ["car", "city"] });
    assert.equal(events.filter((e) => e.type === "integration_merge").length, 2);
  });
});

describe("the contract and the wave on the journal (review)", () => {
  const CONTRACT_COMMIT = "c0ffee0".padEnd(40, "1");
  const WAVE = "abcdef0".padEnd(40, "2");
  const run = { runId: "run_j", project: "apex", goal: "a city", reference: { name: "City" } };
  const now = Date.UTC(2026, 9, 6, 1, 0, 0);
  /** A run with only what the journal's record and restore read. */
  const journalLoopRun = (state: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
    run,
    started: now,
    softDeadline: now,
    finalDeadline: now,
    state: { judges: 0, plays: 0, ledger: [], workers: new Map(), log: [], planReviewUntil: 0, ...state },
    journal: { director: {} as Record<string, any> },
    ...over,
  });
  /** The run a Resume of `saved` starts. */
  const resumed = (saved: Record<string, unknown>) => {
    const loopRun = journalLoopRun({}, { resume: true, priorJournal: { director: saved } }) as Record<string, any>;
    restoreLoopRun(loopRun as never, now);
    return loopRun;
  };
  const spec = () => parseModuleContract(CONTRACT, ["car", "city"]).contract!;

  it("round-trips the contract and the wave's head through a Resume", () => {
    const loopRun = journalLoopRun({ contract: { commit: CONTRACT_COMMIT, spec: spec() }, waveHead: WAVE });
    recordLoopRun(loopRun as never, now);
    const back = resumed(structuredClone(loopRun.journal.director));
    assert.deepEqual(back.state.contract, { commit: CONTRACT_COMMIT, spec: spec() });
    assert.equal(back.state.waveHead, WAVE);
  });

  it("writes neither key for a run with neither, and keeps a saved commit that is no hash out", () => {
    const plain = journalLoopRun();
    recordLoopRun(plain as never, now);
    assert.ok(!("contract" in plain.journal.director) && !("waveHead" in plain.journal.director));
    for (const commit of ["HEAD", "HEAD; touch x", "", 42, null]) {
      const back = resumed({ contract: { commit, spec: spec() }, waveHead: commit });
      assert.equal(back.state.contract, undefined, String(commit));
      assert.equal(back.state.waveHead, undefined, String(commit));
    }
  });

  it("reads a partial saved contract as one with no shared files and no conventions", () => {
    const back = resumed({ contract: { commit: CONTRACT_COMMIT, spec: { modules: spec().modules } } });
    assert.deepEqual(back.state.contract.spec.shared, []);
    assert.deepEqual(back.state.contract.spec.conventions, []);
    assert.deepEqual(ownsClaimingOthers(["src/"], back.state.contract.spec, "city"), [
      { own: "src/", path: "src/car.js", owner: "car" },
    ]);
  });

  it("a finished build reopened forks from the folder as it is now: the finished run's wave head is not followed", () => {
    const back = resumed({
      contract: { commit: CONTRACT_COMMIT, spec: spec() },
      waveHead: WAVE,
      reopened: { at: new Date(now).toISOString(), finishedHead: WAVE },
    });
    assert.equal(back.state.waveHead, undefined);
    assert.equal(back.state.contract.commit, CONTRACT_COMMIT, "the contract it was held to goes on");
  });
});

describe("a build paused before the contract gate shipped, resumed (review)", () => {
  const now = Date.UTC(2026, 9, 6, 2, 0, 0);
  /** The plan as a pre-upgrade director kept it: two parts, no contract, no part marked single. */
  const oldPlan = () => compilePlan(planArgs(null)).plan!;
  /** A run over `repo` resumed from `saved` (its journal's director record), as setup.ts starts one. */
  const resumedOver = (repo: string, head: string, saved: Record<string, any>) => {
    const { loopRun } = stubLoopRun(repo, head, saved.plan ?? null);
    Object.assign(loopRun, {
      resume: true,
      priorJournal: { director: saved },
      started: now,
      softDeadline: now,
      finalDeadline: now,
    });
    Object.assign(loopRun.state, { log: [], planReviewUntil: 0, judges: 0, plays: 0 });
    restoreLoopRun(loopRun as never, now);
    return loopRun;
  };
  /** A pre-upgrade journal: a two-part plan and a worker that left a commit, and nothing of the contract. */
  async function preUpgrade() {
    const { repo, head } = await integrationRepo();
    const carWork = await workerBranch(repo, head, "car-before", { "src/car.js": "export const drift = 1;\n" });
    const saved = {
      plan: oldPlan(),
      integrationHead: head,
      workers: { car: { id: "car", title: "Car handling", state: "stopped", from: head, lastCommit: carWork } },
    };
    return { repo, head, carWork, saved };
  }

  it("starts a loop worker from a worker before the pause as it always did: no refusal, no contract commit", async () => {
    const { repo, head, carWork, saved } = await preUpgrade();
    const loopRun = resumedOver(repo, head, saved);
    assert.equal(priorFork(loopRun as never, "car")?.commit, carWork);
    const args = { id: "car", from: "car" };
    for (let i = 0; i <= CONTRACT_REFUSALS_BEFORE_DERIVED; i++) {
      assert.equal(await contractBeforeFork(loopRun as never, args, WorkerMode.Loop), null, `call ${i + 1}`);
    }
    const gate = await contractAtFork(loopRun as never, { id: "car", args, mode: WorkerMode.Loop, commit: carWork });
    assert.deepEqual(gate, { owns: null });
    assert.equal(await fixtureGit(repo, ["rev-parse", "HEAD"]), head, "no docs/MODULE-CONTRACT.md committed");
    assert.equal(loopRun.state.contract, undefined);
  });

  it("stays a build from before the gate through a second pause", async () => {
    const { repo, head, saved } = await preUpgrade();
    const loopRun = resumedOver(repo, head, saved);
    recordLoopRun(loopRun as never, now);
    const again = resumedOver(repo, head, structuredClone(loopRun.journal.director));
    for (let i = 0; i <= CONTRACT_REFUSALS_BEFORE_DERIVED; i++) {
      assert.equal(await contractBeforeFork(again as never, { id: "car" }, WorkerMode.Loop), null, `call ${i + 1}`);
    }
    assert.equal(again.state.contract, undefined);
  });

  it("holds its loop workers once its lead gives a contract", async () => {
    const { repo, head, saved } = await preUpgrade();
    const loopRun = resumedOver(repo, head, saved);
    loopRun.state.plan = compilePlan(planArgs()).plan!;
    assert.match(String(await contractOnPlan(loopRun as never)), /docs\/MODULE-CONTRACT\.md/);
    const args = { id: "city" };
    const gate = await contractAtFork(loopRun as never, { id: "city", args, mode: WorkerMode.Loop, commit: head });
    assert.match(String(gate.refusal), /does not contain the module contract/);
    recordLoopRun(loopRun as never, now);
    const again = resumedOver(repo, head, structuredClone(loopRun.journal.director));
    const stillHeld = await contractAtFork(again as never, { id: "city", args, mode: WorkerMode.Loop, commit: head });
    assert.match(String(stillHeld.refusal), /does not contain the module contract/, "and goes on holding them");
  });

  it("a build on this harness that paused before its first loop worker still needs a contract on Resume", async () => {
    const { repo, head } = await integrationRepo();
    const before = resumedOver(repo, head, {});
    before.resume = false;
    before.state.plan = oldPlan();
    recordLoopRun(before as never, now);
    const loopRun = resumedOver(repo, head, structuredClone(before.journal.director));
    const refused = await contractBeforeFork(loopRun as never, { id: "car" }, WorkerMode.Loop);
    assert.match(String(refused), /2 parts that loop, and no module contract yet/);
  });
});

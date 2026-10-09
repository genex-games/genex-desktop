/**
 * The Unreal lead's sub-agents (loop/unreal/agents.ts), through their entry points on a fake host:
 * each starts a delegated turn in its own copy of the game, offered only its kind's plugin tools and
 * attributed to its own part; what it delivers lands in the game folder only as regular files inside
 * its folder, within the caps and its manifest's contract; the lead hears its news until it marks
 * it; and the close stops the ones at work and keeps every delivered file.
 */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";
import {
  agentNews,
  agentStatus,
  landAgent,
  landPending,
  markAgent,
  relandAgents,
  settleAgents,
  startAgent,
  waitAgent,
} from "../../src/harness-seed/loop/unreal/agents.ts";
import {
  AGENT_MS,
  AgentKind,
  type AgentRecord,
  AgentState,
  CAST_AGENT_MS,
} from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { type Lead, newLeadJournal, oneGitWrite } from "../../src/harness-seed/loop/unreal/lead-journal.ts";
import { leadCloseOf, savePointRound } from "../../src/harness-seed/loop/unreal/lead-graph.ts";
import { leadToolHandler } from "../../src/harness-seed/loop/unreal/lead-tools.ts";
import { activate as activateBlender } from "../../src/plugins/blender/backend.ts";
import { type CtxRecorder, ctxRecorder } from "../helpers/ctx-recorder.ts";
import { tmpDir } from "../helpers/tmp.ts";

const COMMIT = "c0ffee1234";
const RUN = {
  runId: "run-lead",
  goal: "A lighthouse keeper on a stormy coast, armed with a katana",
  project: "night-spire",
  mode: "autopilot",
  engine: "claude-code",
  budgets: { wallClockMs: 3_600_000 },
} as unknown as Run;
const SEAT = {
  folder: "/games/night-spire",
  chatSession: false,
  sessionId: null,
  bookmarked: null,
  engine: undefined,
  model: null,
};

/** A regular file in the first Blender agent's folder, as `git ls-tree -r -l -z` lists it. */
const entry = (file: string, { mode = "100644", size = "2048", sha = "1".repeat(40) } = {}) =>
  `${mode} ${mode === "160000" ? "commit" : "blob"} ${sha} ${size}\t${file}`;
const FOLDER = "assets/agents/blender_model-1";
const MODEL = `${FOLDER}/katana.glb`;
const RENDER = `${FOLDER}/render.png`;
const MANIFEST = `${FOLDER}/manifest.json`;
const DELIVERY = [entry(MODEL), entry(RENDER), entry(MANIFEST, { size: "600" })];

/** A manifest the way the brief asks for it. */
function manifest(files: unknown[] = [katanaFile()], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "blender_model",
    title: "Katana",
    files,
    renders: [RENDER],
    importCalls: [`import_model {"file": "${MODEL}", "dest": "/Game/Genex/Katana", "name": "SM_Katana"}`],
    notes: "The blade's edge is its own material slot.",
    credits: 0,
    ...extra,
  });
}
function katanaFile(extra: Record<string, unknown> = {}) {
  return {
    path: MODEL,
    role: "mesh",
    triangles: 12400,
    sizeCm: [96, 4, 12],
    pivot: "grip",
    materials: ["Steel", "Wrap"],
    meshes: 1,
    ...extra,
  };
}

/** How the fake host answers one sub-agent's turn: done, failed, or held until the run's close aborts it. */
type Turn = "ok" | "fails" | "hangs";

/** The fake host: the game's git as the tests script it, the sub-agents' turns, and the clock. */
type Host = {
  rec: CtxRecorder;
  now: number;
  tree: string[];
  cppTree: string[];
  manifest: string | null;
  turns: Turn[];
  aborted: Set<string>;
  /** How many more checkouts into the game folder git refuses, as with another git holding its index. */
  checkoutFails: number;
  /** What a checkout into the game folder writes there, as git would (nothing unless a test says). */
  onCheckout?: () => void;
};

/** One git command's answer in the game folder or an agent's copy. */
function git(host: Host, command: string) {
  const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: "" });
  if (command.includes("ls-tree")) {
    const tree = command.includes("unreal/Source") ? host.cppTree : host.tree;
    return ok(tree.map((line) => `${line}\0`).join(""));
  }
  if (command.startsWith("git show"))
    return host.manifest === null ? { code: 128, signal: null, stdout: "", stderr: "fatal" } : ok(host.manifest);
  if (command.includes("rev-parse")) return ok(`${COMMIT}\n`);
  if (command.startsWith("git checkout") && host.checkoutFails > 0) {
    host.checkoutFails -= 1;
    return { code: 128, signal: null, stdout: "", stderr: "fatal: Unable to create '.git/index.lock': File exists." };
  }
  if (command.startsWith("git checkout")) host.onCheckout?.();
  return ok("");
}

/** A sub-agent's turn: its scripted ending, after a tick; a held one ends when its copy's turn is aborted. */
async function turn(host: Host, params: Record<string, unknown>) {
  const how = host.turns.shift() ?? "ok";
  const cwd = String(params.cwd);
  for (let i = 0; how === "hangs" && !host.aborted.has(cwd) && i < 200; i++) await tick();
  await tick();
  const ok = how === "ok";
  return {
    ok,
    engine: "claude-code",
    summary: ok ? "made it" : "",
    usage: {},
    turns: 2,
    errorText: ok ? undefined : "the model stopped",
  };
}

/** A lead on the fake host, in a real game folder (inputs are read there). */
async function leadOn(options: { offers?: Lead["offers"]; cpp?: Lead["cpp"]; dir?: string; critic?: unknown } = {}) {
  const dir = options.dir ?? (await tmpDir("lead-agents-"));
  const host = {} as Host;
  const rec = ctxRecorder({
    handlers: {
      "engine.complete": () => {
        if (options.critic === undefined || options.critic instanceof Error)
          throw options.critic ?? new Error("no critic here");
        return { message: { role: "assistant", content: JSON.stringify(options.critic) } };
      },
      "events.append": () => "e1",
      "artifact.write": () => 1,
      "engine.delegate": (p) => turn(host, p),
      "engine.abort": (p) => {
        host.aborted.add(String(p.cwd));
        return { aborted: 1 };
      },
      "run.exec": (p) => git(host, String(p.command)),
    },
  });
  Object.assign(host, {
    rec,
    now: 1_000_000,
    tree: [...DELIVERY],
    cppTree: [],
    manifest: manifest(),
    turns: [],
    aborted: new Set(),
    checkoutFails: 0,
  });
  const lead: Lead = {
    ctx: rec.ctx as unknown as HarnessCtx,
    run: RUN,
    threadId: "t1",
    clock: {
      now: () => host.now,
      sleep: async (ms) => {
        host.now += ms;
        await tick();
      },
    },
    game: { dir, title: "Night Spire" },
    journal: newLeadJournal(RUN, SEAT),
    started: host.now,
    softDeadline: host.now + 3_000_000,
    finalDeadline: host.now + 3_600_000,
    template: "",
    cpp: options.cpp ?? { available: true, module: "NightSpire" },
    offers: options.offers ?? { blender: true, genex: true },
    turn: null,
    halted: null,
    addModule: false,
    agentRuns: new Map(),
    saving: null,
  };
  return { lead, host, rec, dir };
}

const KATANA = { kind: "blender_model", title: "Katana", brief: "A katana, 96 cm long, the grip wrapped in red." };

/** Starts one sub-agent and waits until its turn has ended and its delivery is in. */
async function deliver(lead: Lead, args: Record<string, string> = KATANA): Promise<AgentRecord> {
  const answer = await startAgent(lead, args);
  const id = /Started worker (\S+):/.exec(answer)?.[1];
  assert.ok(id, answer);
  await Promise.all(lead.agentRuns.values());
  const agent = lead.journal.agents.find((a) => a.id === id);
  assert.ok(agent);
  return agent;
}

/** The files a landing checked out into the game folder (`git checkout <commit> -- …`, run in the game folder). */
const checkedOut = (rec: CtxRecorder): string =>
  rec
    .paramsOf("run.exec")
    .filter((p) => p.project && String(p.command).includes("checkout"))
    .map((p) => String(p.command))
    .join("\n");

/** The graph records of one part, oldest first. */
const workerRecords = (rec: CtxRecorder, part: string) =>
  rec
    .paramsOf("events.append")
    .flatMap((p) => p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>)
    .filter((e) => e.event_type === "director_worker" && e.payload.workerId === part)
    .map((e) => e.payload);

/** A part's worker records (`worker_started`, `worker_finished`), oldest first, each without the time it was written. */
const leadWorkerRecords = (rec: CtxRecorder, part: string) =>
  rec
    .paramsOf("events.append")
    .flatMap((p) => p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>)
    .filter((e) => ["worker_started", "worker_finished"].includes(e.event_type) && e.payload.workerId === part)
    .map((e) => {
      const { at, ...payload } = e.payload;
      assert.equal(typeof at, "string", "a worker record says when");
      return [e.event_type, payload];
    });

describe("a lead's sub-agent, started", () => {
  it("works in its own copy at medium effort, offered only its kind's tools and attributed to its own part", async () => {
    const { lead, rec } = await leadOn();
    await deliver(lead);
    const [delegation] = rec.paramsOf("engine.delegate");
    assert.ok(delegation);
    assert.match(String(delegation.cwd), /agent-blender_model-1$/);
    assert.equal(delegation.effort, "medium");
    assert.equal(delegation.timeoutMs, AGENT_MS);
    assert.deepEqual(delegation.toolAllow, ["blender__"]);
    assert.deepEqual(delegation.attribution, { runId: "run-lead", agentId: "agent-blender_model-1" });
    assert.equal(delegation.creditCap, 600, "the run's Genex credit cap, which the host holds its paid jobs to");
    const prompt = String(delegation.prompt);
    for (const said of [`${FOLDER}/manifest.json`, "+X", "pivot", "30,000 triangles", "metres", "import_model", "Weld"])
      assert.ok(prompt.includes(said), `the brief says ${said}`);
    assert.match(prompt, /never open, call or script the Unreal Editor/);
  });

  const OFFERED: Array<[string, Lead["offers"], string[], number]> = [
    ["a Meshy cast", { blender: true, genex: true }, ["genex__asset", "blender__"], CAST_AGENT_MS],
    ["a sound batch", { blender: true, genex: true }, ["genex__asset"], AGENT_MS],
    ["a texture with only Blender on", { blender: true, genex: false }, ["blender__"], AGENT_MS],
    ["C++", { blender: false, genex: false }, ["unreal__check-part"], AGENT_MS],
  ];
  const KIND_OF: Record<string, string> = {
    "a Meshy cast": AgentKind.GenexCast,
    "a sound batch": AgentKind.Sound,
    "a texture with only Blender on": AgentKind.Texture,
    "C++": AgentKind.Cpp,
  };
  for (const [what, offers, allow, timeout] of OFFERED) {
    it(`offers ${what} only its own tools`, async () => {
      const { lead, rec } = await leadOn({ offers });
      await startAgent(lead, { kind: KIND_OF[what] ?? "", title: "It", brief: "Make it." });
      await Promise.all(lead.agentRuns.values());
      const [delegation] = rec.paramsOf("engine.delegate");
      assert.deepEqual(delegation?.toolAllow, allow);
      assert.equal(delegation?.timeoutMs, timeout);
    });
  }

  it("numbers a sub-agent past what earlier runs delivered into the game, so it never lands over them", async () => {
    const { lead, dir } = await leadOn();
    await mkdir(path.join(dir, "assets", "agents", "blender_model-1"), { recursive: true });
    await mkdir(path.join(dir, "assets", "agents", "blender_model-3"), { recursive: true });
    await mkdir(path.join(dir, "unreal", "Source", "NightSpire", "Parts", "cpp_1"), { recursive: true });
    assert.equal((await deliver(lead)).id, "blender_model-4");
    assert.equal((await deliver(lead, { ...KATANA, title: "Scabbard" })).id, "blender_model-5");
    await startAgent(lead, { kind: "cpp", title: "Hit stop", brief: "A hit-stop component." });
    await Promise.all(lead.agentRuns.values());
    assert.equal(lead.journal.agents.at(-1)?.id, "cpp-2");
  });

  it("hands a prep agent its inputs inside its own copy, by their game-folder paths, which Local Blender takes", async () => {
    const { lead, rec, dir } = await leadOn();
    const input = "assets/agents/blender_model-1/katana.glb";
    await mkdir(path.join(dir, path.dirname(input)), { recursive: true });
    await writeFile(path.join(dir, input), "glTF");
    await startAgent(lead, { kind: "blender_prep", title: "Katana LODs", brief: "Three LODs.", inputs: input });
    await Promise.all(lead.agentRuns.values());
    const trail = rec.calls.map((c) => c.method);
    const copied = trail.indexOf("snapshot.worktree");
    assert.ok(trail.indexOf("snapshot.create") >= 0 && trail.indexOf("snapshot.create") < copied, "the copy holds it");
    const prompt = String(rec.paramsOf("engine.delegate")[0]?.prompt);
    assert.match(prompt, new RegExp(`Inputs[^\n]*${input.replace(/\./g, "\\.")}`));
    assert.ok(!prompt.includes(dir), "never the live game folder's own path");
    const host = async (method: string) => {
      if (method === "native.run") throw new Error("ran");
      throw new Error(`No ${method} here`);
    };
    const blender = await activateBlender({ call: host as never });
    const ctx = { project: "game", directory: dir, signal: new AbortController().signal, callId: 1, host };
    const call = blender.tool?.("model", { name: "katana-lods", inputs: input }, ctx as never) as Promise<unknown>;
    await assert.rejects(call, /^Error: ran$/, "Local Blender accepts the path and runs");
  });

  it("names a C++ agent's folder in the game's module in its brief", async () => {
    const { lead, rec } = await leadOn();
    await startAgent(lead, { kind: "cpp", title: "Hit stop", brief: "A hit-stop component." });
    await Promise.all(lead.agentRuns.values());
    const prompt = String(rec.paramsOf("engine.delegate")[0]?.prompt);
    assert.match(prompt, /unreal\/Source\/NightSpire\/Parts\/cpp_1\//);
    // What unreal__check-part needs to check that folder: a part of the same name with its classes listed.
    assert.match(prompt, /unreal\/parts\/cpp_1\/part\.json/);
    assert.match(prompt, /"cpp": \[/);
    assert.match(prompt, /apply\.py/);
    assert.match(prompt, /part=cpp_1/);
  });

  /** Runs a refused start: what it answered, and the journal and the host calls it left. */
  async function refusedStart(setup: (lead: Lead) => void | Promise<void>, args: Record<string, string>) {
    const made = await leadOn();
    await setup(made.lead);
    const before = made.lead.journal.agents.length;
    const answer = await startAgent(made.lead, args);
    return { ...made, answer, added: made.lead.journal.agents.length - before };
  }

  const REFUSED: Array<[string, (lead: Lead) => void | Promise<void>, Record<string, string>, RegExp]> = [
    [
      "an unknown kind",
      () => {},
      { kind: "photogrammetry", title: "x", brief: "y" },
      /no plugin that is on declares that worker type/,
    ],
    ["a missing brief", () => {}, { kind: "sound", title: "Wind", brief: " " }, /title and a whole brief/],
    [
      "Blender being off",
      (lead) => {
        lead.offers = { blender: false, genex: true };
      },
      KATANA,
      /Local Blender isn't on/,
    ],
    [
      "Genex being off, for sound",
      (lead) => {
        lead.offers = { blender: true, genex: false };
      },
      { kind: "sound", title: "Wind", brief: "A low wind." },
      /Genex Tools isn't on/,
    ],
    [
      "the run's Genex credits being spent",
      (lead) => {
        lead.journal.credits = { spent: 600, cap: 600 };
      },
      { kind: "genex_cast", title: "Goblin", brief: "A goblin." },
      /spent 600 of their 600 Genex credits/,
    ],
    [
      "a game that can't build C++",
      (lead) => {
        lead.cpp = { available: false, why: "no Xcode" };
      },
      { kind: "cpp", title: "Hit stop", brief: "A hit-stop component." },
      /can't build the game's C\+\+/,
    ],
  ];
  for (const [what, setup, args, said] of REFUSED) {
    it(`starts nothing for ${what}`, async () => {
      const { answer, added, rec } = await refusedStart(setup, args);
      assert.match(answer, /^No worker started/);
      assert.match(answer, said);
      assert.equal(added, 0, "no record");
      assert.deepEqual(rec.paramsOf("snapshot.worktree"), [], "no copy");
      assert.deepEqual(rec.paramsOf("engine.delegate"), [], "no turn");
    });
  }

  it("asks for the game's C++ module between turns when a C++ agent finds none", async () => {
    const { lead, rec } = await leadOn({ cpp: { available: true, module: null } });
    const answer = await startAgent(lead, { kind: "cpp", title: "Hit stop", brief: "A hit-stop component." });
    assert.match(answer, /no C\+\+ module yet/);
    assert.equal(lead.addModule, true);
    assert.deepEqual(rec.paramsOf("engine.delegate"), []);
  });

  it("starts at most two at once", async () => {
    const { lead, host, rec } = await leadOn();
    host.turns = ["hangs", "hangs"];
    await startAgent(lead, KATANA);
    await startAgent(lead, { ...KATANA, title: "Scabbard" });
    const third = await startAgent(lead, { ...KATANA, title: "Guard" });
    assert.match(third, /at most 2 workers work at once/);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(rec.paramsOf("engine.delegate").length, 2);
    await settleAgents(lead);
  });

  describe("its inputs, read from the game folder", () => {
    async function withInputs(inputs: string) {
      const dir = await tmpDir("lead-inputs-");
      const outside = await tmpDir("lead-outside-");
      await mkdir(path.join(dir, "assets/blender/job-1"), { recursive: true });
      await writeFile(path.join(dir, "assets/blender/job-1/model.glb"), "glb");
      await writeFile(path.join(outside, "secret.glb"), "secret");
      await symlink(path.join(outside, "secret.glb"), path.join(dir, "assets/link.glb"));
      await symlink(outside, path.join(dir, "assets/outside"));
      const made = await leadOn({ dir });
      const answer = await startAgent(made.lead, { kind: "blender_prep", title: "Weld", brief: "Weld it.", inputs });
      await Promise.all(made.lead.agentRuns.values());
      return { ...made, answer, dir };
    }

    const HOSTILE: Array<[string, string]> = [
      ["an absolute path", "/etc/hosts"],
      ["a home path", "~/model.glb"],
      ["a climb out", "../model.glb"],
      ["a climb through a folder", "assets/../../model.glb"],
      ["a Windows path", "assets\\blender\\job-1\\model.glb"],
      ["a hidden folder", ".git/config"],
      ["an empty segment", "assets//blender/job-1/model.glb"],
      ["a missing file", "assets/blender/job-2/model.glb"],
      ["a link out of the game", "assets/link.glb"],
      ["a file through a linked folder", "assets/outside/secret.glb"],
    ];
    for (const [what, input] of HOSTILE) {
      it(`refuses ${what}, and starts nothing`, async () => {
        const { answer, lead, rec } = await withInputs(`assets/blender/job-1/model.glb, ${input}`);
        assert.match(answer, /^No worker started: input /);
        assert.deepEqual(lead.journal.agents, []);
        assert.deepEqual(rec.paramsOf("snapshot.worktree"), []);
        assert.deepEqual(rec.paramsOf("engine.delegate"), []);
      });
    }

    it("hands the agent a game-folder input by its game-folder path, which its copy holds", async () => {
      const { answer, rec, dir } = await withInputs("assets/blender/job-1/model.glb");
      assert.match(answer, /^Started worker blender_prep-1/);
      const prompt = String(rec.paramsOf("engine.delegate")[0]?.prompt);
      assert.ok(prompt.includes("assets/blender/job-1/model.glb"));
      assert.ok(!prompt.includes(dir), "never the live game folder's own path");
    });
  });

  it("waits for room when the chat already runs as many workers as the person allows, then works", async () => {
    const { lead, host, rec } = await leadOn();
    let refusals = 1;
    rec.handle("engine.delegate", (p) => {
      if (refusals-- > 0)
        throw Object.assign(new Error("this chat already runs 8 workers"), { code: "too_many_workers" });
      return turn(host, p);
    });
    const before = host.now;
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Done, agent.error ?? "");
    assert.equal(rec.paramsOf("engine.delegate").length, 2, "asked again once there was room");
    assert.ok(host.now > before, "it waited on the run's clock");
  });

  it("a stop while it waits for room ends it as stopped: it never takes its turn, and the stop returns", async () => {
    const { lead, host, rec } = await leadOn();
    host.tree = [];
    rec.handle("engine.delegate", () => {
      throw Object.assign(new Error("this chat already runs 8 workers"), { code: "too_many_workers" });
    });
    const call = leadToolHandler(lead);
    await call("worker_start", { type: "sound", title: "Wind", task: "A low wind." });
    for (let i = 0; i < 5; i++) await tick();
    const refusedBefore = rec.paramsOf("engine.delegate").length;
    const before = host.now;
    assert.match(String(await call("worker_stop", { id: "sound-1" })), /^Stopping sound-1/);
    assert.ok(host.now - before < 60_000, "the stop did not wait out the worker's whole deadline");
    const [wind] = lead.journal.agents;
    assert.equal(wind?.state, AgentState.Stopped, wind?.error ?? "");
    assert.ok(rec.paramsOf("engine.delegate").length <= refusedBefore + 1, "no more asks for room after the stop");
  });

  it("ends with the host's reason when its copy of the game is refused, and the lead hears it", async () => {
    const { lead, host, rec } = await leadOn();
    host.tree = [];
    const refused =
      "This game is too large to copy, so nothing that needs its own copy of it can start; work in the game folder itself. A copy would take 6.1 GB, more than the 2 GB allowed (most of it in Content 5.2 GB).";
    rec.handle("snapshot.worktree", () => {
      throw new Error(refused);
    });
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Failed);
    assert.deepEqual(rec.paramsOf("engine.delegate"), [], "no turn without a copy");
    const [news] = agentNews(lead);
    assert.ok(news?.text.includes(refused), news?.text);
  });
});

describe("a sub-agent's delivery on its way into the game", () => {
  it("lands its regular files from its copy into the game folder, and its copy goes", async () => {
    const { lead, rec } = await leadOn();
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Done);
    assert.deepEqual(agent.landed.sort(), [MANIFEST, RENDER, MODEL].sort());
    assert.match(checkedOut(rec), new RegExp(`checkout ${COMMIT} -- .*katana\\.glb`));
    assert.equal(rec.paramsOf("snapshot.removeWorktree").length, 1, "its copy goes once landed");
    assert.equal(agent.worktree, null);
    assert.equal(agent.manifest?.files[0]?.triangles, 12400);
    const states = workerRecords(rec, "agent-blender_model-1").map((p) => p.state);
    assert.deepEqual(states, ["running", "done"]);
    assert.equal(workerRecords(rec, "agent-blender_model-1")[0]?.title, "Blender: Katana");
  });

  const HOSTILE: Array<[string, string]> = [
    ["a link", entry(`${FOLDER}/link.png`, { mode: "120000", size: "12" })],
    ["a submodule", entry(`${FOLDER}/sub`, { mode: "160000", size: "-" })],
    ["an oversized file", entry(`${FOLDER}/huge.png`, { size: "999999999" })],
    ["a file outside its folder", entry("unreal/Config/DefaultEngine.ini", { size: "10" })],
    ["a climb out of its folder", entry(`${FOLDER}/../../x.ini`, { size: "10" })],
    ["another agent's folder", entry("assets/agents/blender_model-10/x.png", { size: "10" })],
    ["a malformed entry", `100644 blob 10\t${FOLDER}/x.png`],
  ];
  for (const [what, line] of HOSTILE) {
    it(`lands nothing of ${what}, and still lands the regular files beside it`, async () => {
      const { lead, host, rec } = await leadOn();
      host.tree = [line, ...DELIVERY];
      const agent = await deliver(lead);
      const landed = checkedOut(rec);
      assert.match(landed, /katana\.glb/);
      const file = line.split("\t")[1] ?? "";
      assert.ok(!landed.includes(file.split("/").at(-1) ?? file), `${file} stays out of the game`);
      assert.ok(!agent.landed.includes(file));
      assert.equal(agent.refused.length, 1, "and the lead hears why");
    });
  }

  it("lands nothing at all when it made more files than one delivery takes", async () => {
    const { lead, host, rec } = await leadOn();
    host.tree = Array.from({ length: 200 }, (_, i) => entry(`${FOLDER}/tile-${i}.png`, { size: "10" }));
    const agent = await deliver(lead);
    assert.equal(checkedOut(rec), "", "nothing written");
    assert.equal(agent.state, AgentState.Failed);
    assert.match(String(agent.error), /200 files, more than the 64/);
  });

  it("keeps a file holding several meshes out, with the reason, unless its brief asked for several", async () => {
    const asked = await leadOn();
    asked.host.manifest = manifest([katanaFile({ meshes: 3, meshesAsked: true })]);
    assert.ok((await deliver(asked.lead)).landed.includes(MODEL), "asked for: it lands");
    const { lead, host, rec } = await leadOn();
    host.manifest = manifest([katanaFile({ meshes: 3 })]);
    const agent = await deliver(lead);
    assert.ok(!checkedOut(rec).includes("katana.glb"), "not asked for: it stays out");
    assert.ok(agent.landed.includes(RENDER), "the rest lands");
    const [news] = agentNews(lead);
    assert.match(
      news?.text ?? "",
      /katana\.glb holds 3 meshes, and one file holds one mesh unless the brief asked for more/,
    );
  });

  it("names a prop over its triangle budget in the news, and still lands it", async () => {
    const { lead, host } = await leadOn();
    host.manifest = manifest([katanaFile({ triangles: 148_000 })]);
    const agent = await deliver(lead);
    assert.ok(agent.landed.includes(MODEL));
    assert.match(agentNews(lead)[0]?.text ?? "", /148,000 triangles; a prop is at most 30,000/);
  });

  it("lands a delivery without a manifest, and tells the lead to look at the files itself", async () => {
    const { lead, host } = await leadOn();
    host.tree = [entry(MODEL), entry(RENDER)];
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Done);
    assert.equal(agent.manifest, null);
    assert.match(agentNews(lead)[0]?.text ?? "", /wrote no manifest\.json: look at the files yourself/);
  });

  it("lands what a turn that ended early delivered only when it wrote its manifest", async () => {
    const written = await leadOn();
    written.host.turns = ["fails"];
    assert.equal((await deliver(written.lead)).state, AgentState.Done);
    const { lead, host, rec } = await leadOn();
    host.turns = ["fails"];
    host.tree = [entry(MODEL)];
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Failed);
    assert.match(String(agent.error), /the model stopped/);
    assert.equal(checkedOut(rec), "");
  });

  it("counts the Genex credits its manifest says its jobs spent", async () => {
    const { lead, host } = await leadOn();
    const cast = "assets/agents/genex_cast-1";
    host.tree = [entry(`${cast}/goblin.glb`), entry(`${cast}/manifest.json`, { size: "300" })];
    host.manifest = manifest([{ path: `${cast}/goblin.glb`, role: "skeletal" }], { credits: 46 });
    const agent = await deliver(lead, { kind: "genex_cast", title: "Goblin", brief: "A goblin." });
    assert.equal(agent.credits, 46);
    assert.equal(lead.journal.credits.spent, 46);
  });

  it("marks a landed C++ delivery for the rebuild between turns", async () => {
    const { lead, host, rec } = await leadOn();
    host.tree = [];
    host.cppTree = [entry("unreal/Source/NightSpire/Parts/cpp_1/HitStop.h", { size: "400" })];
    const agent = await deliver(lead, { kind: "cpp", title: "Hit stop", brief: "A hit-stop component." });
    assert.equal(agent.state, AgentState.Done);
    assert.match(checkedOut(rec), /Parts\/cpp_1\/HitStop\.h/);
    assert.equal(lead.journal.between.rebuild, true);
  });

  it("tries a checkout git refused (another git held the game's index) again, and lands the delivery", async () => {
    const { lead, host, rec } = await leadOn();
    host.checkoutFails = 1;
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Done);
    assert.deepEqual(agent.landed.sort(), [MANIFEST, RENDER, MODEL].sort());
    assert.equal(checkedOut(rec).split("\n").filter(Boolean).length, 2, "asked twice");
  });

  it("keeps a delivery git wouldn't check out as delivered, not yet in the game, and lands it when asked again", async () => {
    const { lead, host } = await leadOn();
    host.checkoutFails = 99;
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Done, "never failed: its work is in its commit");
    assert.deepEqual(agent.landed, []);
    assert.match(agentNews(lead)[0]?.text ?? "", /not in the game folder yet/);
    host.checkoutFails = 0;
    await landPending(lead);
    assert.deepEqual(agent.landed.sort(), [MANIFEST, RENDER, MODEL].sort());
    assert.doesNotMatch(agentNews(lead)[0]?.text ?? "", /not in the game folder yet/);
  });

  it("checks a delivery out only once a save point's snapshot of the game folder is done", async () => {
    const { lead, rec } = await leadOn();
    let release = () => {};
    const snapshot = oneGitWrite(lead, () => new Promise<void>((resolve) => (release = resolve)));
    await startAgent(lead, KATANA);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(checkedOut(rec), "", "the landing waits for the snapshot");
    release();
    await snapshot;
    await Promise.all(lead.agentRuns.values());
    assert.match(checkedOut(rec), /katana\.glb/);
  });

  it("lands a delivery again from its commit after a rewind took it out", async () => {
    const { lead, rec } = await leadOn();
    await deliver(lead);
    await relandAgents(lead);
    const checkouts = checkedOut(rec).split("\n").filter(Boolean);
    assert.equal(checkouts.length, 2, "twice, the second time with its copy gone");
    assert.equal(rec.paramsOf("snapshot.worktree").length, 1);
  });
});

describe("the critic's look at a delivered model", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const BARE_GRIP = { defect: "The grip is bare steel, not wrapped in red", fix: "Wrap the grip in a red cord" };
  /** The landing checks the render out into the game folder. */
  const renderLands = (host: Host, dir: string) => {
    host.onCheckout = () => {
      mkdirSync(path.join(dir, FOLDER), { recursive: true });
      writeFileSync(path.join(dir, RENDER), PNG);
    };
  };

  it("looks at a delivered model's renders against its brief, and tells the lead not to import one that isn't ready", async () => {
    const { lead, host, rec, dir } = await leadOn({ critic: { ready: false, defects: [BARE_GRIP] } });
    renderLands(host, dir);
    const agent = await deliver(lead);
    const calls = rec.paramsOf("engine.complete");
    assert.equal(calls.length, 1);
    const [message] = (calls[0]?.messages ?? []) as Array<{ content: string; images: Array<{ label: string }> }>;
    assert.deepEqual(
      message?.images.map((image) => image.label),
      ["render.png"],
    );
    assert.match(String(message?.content), /A katana, 96 cm long, the grip wrapped in red\./);
    assert.deepEqual(agent.look, { verdict: "not-ready", defects: [BARE_GRIP] });
    const text = agentNews(lead)[0]?.text ?? "";
    assert.match(
      text,
      /The critic looked at its renders: not ready\.\n- The grip is bare steel[^\n]*fix: Wrap the grip/,
    );
    assert.match(text, /Don't put it in the game as it is/);
  });

  it("says a model the critic finds ready is ready", async () => {
    const { lead, host, dir } = await leadOn({ critic: { ready: true, defects: [] } });
    renderLands(host, dir);
    const agent = await deliver(lead);
    assert.deepEqual(agent.look, { verdict: "ready", defects: [] });
    assert.match(agentNews(lead)[0]?.text ?? "", /The critic looked at its renders: ready/);
  });

  it("asks nothing about a delivery without renders", async () => {
    const { lead, host, rec, dir } = await leadOn({ critic: { ready: true, defects: [] } });
    renderLands(host, dir);
    host.manifest = manifest([katanaFile()], { renders: [] });
    const agent = await deliver(lead);
    assert.deepEqual(rec.paramsOf("engine.complete"), []);
    assert.equal(agent.look, undefined);
  });

  const UNSEEN: Array<[string, (dir: string, outside: string) => void, unknown]> = [
    [
      "a render that leads out of the game",
      (dir, outside) => {
        mkdirSync(path.join(dir, FOLDER), { recursive: true });
        writeFileSync(path.join(outside, "x.png"), PNG);
        symlinkSync(path.join(outside, "x.png"), path.join(dir, RENDER));
      },
      { ready: true, defects: [] },
    ],
    [
      "a render that is not a picture",
      (dir) => {
        mkdirSync(path.join(dir, FOLDER), { recursive: true });
        writeFileSync(path.join(dir, RENDER), "not a picture");
      },
      { ready: true, defects: [] },
    ],
    ["a critic that can't answer", pngRender, new Error("the judge engine is not signed in")],
    ["an answer without a yes or no", pngRender, { defects: [BARE_GRIP] }],
  ];
  for (const [what, lands, critic] of UNSEEN)
    it(`tells the lead to look at the renders itself after ${what}`, async () => {
      const { lead, host, dir } = await leadOn({ critic });
      const outside = await tmpDir("lead-agents-outside-");
      host.onCheckout = () => lands(dir, outside);
      const agent = await deliver(lead);
      assert.equal(agent.state, AgentState.Done, "still delivered");
      assert.ok(agent.look && "error" in agent.look);
      assert.match(
        agentNews(lead)[0]?.text ?? "",
        /The critic couldn't look at its renders[^\n]*look at them yourself/,
      );
    });
});

/** A PNG render checked out into the game folder (for the table above). */
function pngRender(dir: string): void {
  mkdirSync(path.join(dir, FOLDER), { recursive: true });
  writeFileSync(path.join(dir, RENDER), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
}

describe("the lead's news of its sub-agents", () => {
  it("repeats a delivery's news, with its files, hero render and import call, until the lead marks it", async () => {
    const { lead } = await leadOn();
    await deliver(lead);
    const first = agentNews(lead);
    assert.equal(first.length, 1);
    const text = first[0]?.text ?? "";
    assert.match(text, /Worker blender_model-1 \(Blender: Katana\) delivered/);
    assert.match(text, /katana\.glb: mesh, 12,400 triangles, 96 × 4 × 12 cm, pivot grip/);
    assert.match(text, new RegExp(`Hero render: ${RENDER}`));
    assert.match(text, /import_model \{"file": "assets\/agents\/blender_model-1\/katana\.glb"/);
    assert.match(text, /mcp__studio__worker_mark with id=blender_model-1/);
    assert.equal(agentNews(lead).length, 1, "again, while unmarked");
    assert.match(await markAgent(lead, { id: "blender_model-1", verdict: "used" }), /Marked blender_model-1 used/);
    assert.deepEqual(agentNews(lead), []);
  });

  it("tells a failed agent's news once", async () => {
    const { lead, host } = await leadOn();
    host.turns = ["fails"];
    host.tree = [];
    await deliver(lead);
    const [news] = agentNews(lead);
    assert.match(news?.text ?? "", /Worker blender_model-1 \(Blender: Katana\) failed: the model stopped/);
    assert.deepEqual(agentNews(lead), []);
  });

  it("says where each one stands, with a delivery's manifest", async () => {
    const { lead } = await leadOn();
    assert.equal(agentStatus(lead), "No workers started yet.");
    await deliver(lead);
    assert.match(agentStatus(lead), /blender_model-1 \(Blender: Katana\): done, 0 min\nWorker blender_model-1/);
    assert.equal(agentStatus(lead, "nope"), "There is no worker nope.");
    assert.match(await waitAgent(lead, { id: "blender_model-1", seconds: "30" }), /: done/);
  });

  it("marks only a delivered sub-agent, with a known verdict; a rejected one stops on its part with the lead's note", async () => {
    const { lead, host, rec } = await leadOn();
    host.turns = ["hangs"];
    await startAgent(lead, KATANA);
    assert.match(await markAgent(lead, { id: "blender_model-1", verdict: "used" }), /is running/);
    assert.match(await markAgent(lead, { id: "nope", verdict: "used" }), /no worker nope/);
    await settleAgents(lead);
    const { lead: other, rec: otherRec } = await leadOn();
    await deliver(other);
    assert.match(
      await markAgent(other, { id: "blender_model-1", verdict: "maybe" }),
      /verdict must be used or rejected/,
    );
    await markAgent(other, { id: "blender_model-1", verdict: "rejected", note: "too short" });
    const last = workerRecords(otherRec, "agent-blender_model-1").at(-1);
    assert.equal(last?.state, "stopped");
    assert.match(String(last?.stoppedBecause), /too short/);
    assert.ok(rec);
  });

  it("a typed worker leaves the same records under its part's id, and both verdicts are recorded", async () => {
    const { lead, rec } = await leadOn();
    await deliver(lead);
    await markAgent(lead, { id: "blender_model-1", verdict: "used" });
    const { lead: other, rec: otherRec } = await leadOn();
    await deliver(other);
    await markAgent(other, { id: "blender_model-1", verdict: "rejected", note: "too short" });
    const scope = { runId: "run-lead", project: "night-spire" };
    const katana = { ...scope, workerId: "agent-blender_model-1", title: "Blender: Katana" };
    assert.deepEqual(leadWorkerRecords(rec, katana.workerId), [
      ["worker_started", { ...katana, isolation: "copy", type: AgentKind.BlenderModel, task: KATANA.brief }],
      ["worker_finished", { ...katana, state: "done", delivered: true }],
      ["worker_finished", { ...katana, verdict: "used" }],
    ]);
    assert.deepEqual(leadWorkerRecords(otherRec, katana.workerId).at(-1), [
      "worker_finished",
      { ...katana, verdict: "rejected", note: "too short" },
    ]);
  });
});

describe("a typed worker's verdict stands once given", () => {
  it("a used worker a save point took in cannot be rejected, and no verdict is given twice; the close still counts it used", async () => {
    const { lead, rec } = await leadOn();
    await deliver(lead);
    await markAgent(lead, { id: "blender_model-1", verdict: "used" });
    const point = {
      label: "Save 1",
      snapshotId: "snap-1",
      at: lead.clock.now(),
      summary: "the katana in the shrine",
      thumbnails: [],
      milestoneId: "lead",
      round: 1,
      auto: false,
      logErrors: [],
    };
    lead.journal.savePoints.push(point);
    await savePointRound(lead, point);
    const [katana] = lead.journal.agents;
    assert.equal(katana?.mergedInto, "Save 1", "the save point took it in");
    const recordsBefore = leadWorkerRecords(rec, "agent-blender_model-1").length;
    const partBefore = workerRecords(rec, "agent-blender_model-1").length;
    const answer = await markAgent(lead, { id: "blender_model-1", verdict: "rejected", note: "too short" });
    assert.match(answer, /already in the game/);
    assert.equal(katana?.mark?.verdict, "used", "its verdict stands");
    assert.equal(leadWorkerRecords(rec, "agent-blender_model-1").length, recordsBefore, "no verdict is recorded");
    assert.equal(workerRecords(rec, "agent-blender_model-1").length, partBefore, "its part does not stop");
    assert.match(String(leadCloseOf(lead.journal).summary), /1 used in the game/);

    const { lead: other, rec: otherRec } = await leadOn();
    await deliver(other);
    await markAgent(other, { id: "blender_model-1", verdict: "rejected", note: "too short" });
    const before = leadWorkerRecords(otherRec, "agent-blender_model-1").length;
    assert.match(await markAgent(other, { id: "blender_model-1", verdict: "used" }), /already marked rejected/);
    assert.equal(other.journal.agents[0]?.mark?.verdict, "rejected");
    assert.equal(leadWorkerRecords(otherRec, "agent-blender_model-1").length, before);
  });
});

describe("the close of a run with sub-agents", () => {
  it("stops the ones at work and keeps every delivered file; one that wrote its manifest lands", async () => {
    const { lead, host, rec } = await leadOn();
    await deliver(lead);
    host.turns = ["hangs", "hangs"];
    await startAgent(lead, { kind: "sound", title: "Wind", brief: "A low wind." });
    await startAgent(lead, { ...KATANA, title: "Scabbard" });
    for (let i = 0; i < 5; i++) await tick();
    host.tree = [];
    await settleAgents(lead);
    assert.equal(rec.paramsOf("engine.abort").length, 2, "both turns are aborted");
    const states = Object.fromEntries(lead.journal.agents.map((a) => [a.id, a.state]));
    assert.deepEqual(states, { "blender_model-1": "done", "sound-1": "stopped", "blender_model-2": "stopped" });
    assert.ok(lead.journal.agents[0]?.landed.includes(MODEL), "the delivered files stay");
    const removed = rec.paramsOf("run.exec").filter((p) => /\b(rm|clean|reset)\b/.test(String(p.command)));
    assert.deepEqual(removed, [], "nothing in the game folder is removed");
    assert.equal(rec.paramsOf("snapshot.removeWorktree").length, 3, "every copy goes");
  });

  it("lands a delivery whose manifest was written as the run closed", async () => {
    const { lead, host } = await leadOn();
    host.turns = ["hangs"];
    await startAgent(lead, KATANA);
    for (let i = 0; i < 5; i++) await tick();
    await settleAgents(lead);
    const [agent] = lead.journal.agents;
    assert.equal(agent?.state, AgentState.Done);
    assert.ok(agent?.landed.includes(MODEL));
  });

  it("lands from the same commit when asked again, without making another", async () => {
    const { lead, rec } = await leadOn();
    const agent = await deliver(lead);
    const commits = () => rec.paramsOf("run.exec").filter((p) => String(p.command).includes("commit")).length;
    const before = commits();
    assert.deepEqual((await landAgent(lead, agent)).sort(), agent.landed.sort());
    assert.equal(commits(), before);
  });
});

/** The worker types the bundled plugins declare for an Unreal game with Local Blender and Genex on. */
const TYPES_ON = ["blender_model", "blender_prep", "genex_cast", "sound", "texture", "cpp"];

describe("the lead's workers, in Genex's one worker model", () => {
  it("worker_start with a type runs today's agent of that kind, offered when a plugin that is on declares the type", async () => {
    // Local Blender off: the plugins that are on declare no Blender types.
    const off = await leadOn({
      offers: { blender: false, genex: true, types: ["genex_cast", "sound", "texture", "cpp"] },
    });
    const refused = String(
      await leadToolHandler(off.lead)("worker_start", { type: "blender_model", title: "Katana", task: "A katana." }),
    );
    assert.match(refused, /^No worker started: no plugin that is on declares that worker type/);
    assert.match(refused, /the known types are genex_cast, sound, texture, cpp/);
    assert.deepEqual(off.rec.paramsOf("engine.delegate"), [], "nothing started");

    const on = await leadOn({ offers: { blender: true, genex: true, types: TYPES_ON } });
    const call = leadToolHandler(on.lead);
    const started = String(
      await call("worker_start", { type: "blender_model", title: "Katana", task: "A katana, 96 cm." }),
    );
    assert.match(started, /^Started worker blender_model-1:/);
    await Promise.all(on.lead.agentRuns.values());
    const [delegation] = on.rec.paramsOf("engine.delegate");
    assert.match(String(delegation?.cwd), /agent-blender_model-1$/, "in its own copy");
    assert.deepEqual(delegation?.toolAllow, ["blender__"], "offered its kind's tools");
    assert.match(String(delegation?.prompt), /A katana, 96 cm\./, "its task is its brief");
    assert.match(
      String(await call("worker_status", { id: "blender_model-1" })),
      /blender_model-1 \(Blender: Katana\): done/,
    );
  });

  it("a typed start that asks for another isolation than its type's copy is refused, and nothing is made", async () => {
    const { lead, rec } = await leadOn({ offers: { blender: true, genex: true, types: TYPES_ON } });
    const call = leadToolHandler(lead);
    for (const args of [
      { type: "blender_model", title: "Katana", task: "A katana.", isolation: "read" },
      { kind: "texture", title: "Sky", brief: "A sky.", isolation: "lock", inputs: "x" },
    ])
      assert.match(
        String(await call("worker_start", args)),
        /^No worker started: a .* worker always works in a copy of its own/,
        JSON.stringify(args),
      );
    for (const method of ["snapshot.create", "snapshot.worktree", "engine.delegate"])
      assert.deepEqual(rec.paramsOf(method), [], `no ${method}`);
    assert.deepEqual(lead.journal.agents, []);
  });

  it("worker_stop stops a typed worker and keeps what it delivered", async () => {
    const { lead, host, rec } = await leadOn();
    host.turns = ["hangs"];
    const call = leadToolHandler(lead);
    await call("worker_start", { type: "blender_model", title: "Katana", task: "A katana." });
    for (let i = 0; i < 5; i++) await tick();
    assert.match(String(await call("worker_steer", { id: "blender_model-1", text: "longer" })), /cannot be steered/);
    assert.match(String(await call("worker_stop", { id: "blender_model-1" })), /^Stopping blender_model-1/);
    const aborted = rec.paramsOf("engine.abort");
    assert.equal(aborted.length, 1);
    assert.match(String(aborted[0]?.cwd), /agent-blender_model-1$/, "only its own copy's turn");
    assert.equal(lead.journal.agents[0]?.state, AgentState.Done, "its manifest was written: what it delivered lands");
    assert.ok(lead.journal.agents[0]?.landed.includes(MODEL));

    const bare = await leadOn();
    bare.host.turns = ["hangs"];
    bare.host.tree = [];
    const stop = leadToolHandler(bare.lead);
    await stop("worker_start", { type: "sound", title: "Wind", task: "A low wind." });
    for (let i = 0; i < 5; i++) await tick();
    await stop("worker_stop", { id: "sound-1" });
    const [wind] = bare.lead.journal.agents;
    assert.equal(wind?.state, AgentState.Stopped, "nothing delivered: it ends as stopped");
    assert.equal(wind?.error, "stopped by the lead");
    assert.match(String(await stop("worker_stop", { id: "sound-1" })), /not running/);
  });

  it("a typed worker that stops short says why in the app's own code: an error, the lead stopped it, or the Loop ended first", async () => {
    const stopCodeOf = (rec: CtxRecorder, part: string) =>
      leadWorkerRecords(rec, part).flatMap(([type, payload]) => {
        const end = payload as Record<string, unknown>;
        return type === "worker_finished" && end.state ? [[end.state, end.stopCode]] : [];
      });
    const failed = await leadOn();
    failed.host.turns = ["fails"];
    failed.host.tree = [];
    await deliver(failed.lead);
    assert.deepEqual(stopCodeOf(failed.rec, "agent-blender_model-1"), [["failed", "error"]]);

    const stopped = await leadOn();
    stopped.host.turns = ["hangs"];
    stopped.host.tree = [];
    const call = leadToolHandler(stopped.lead);
    await call("worker_start", { type: "sound", title: "Wind", task: "A low wind." });
    for (let i = 0; i < 5; i++) await tick();
    await call("worker_stop", { id: "sound-1" });
    assert.deepEqual(stopCodeOf(stopped.rec, "agent-sound-1"), [["stopped", "stopped_by_lead"]]);

    const closed = await leadOn();
    closed.host.turns = ["hangs"];
    await startAgent(closed.lead, { kind: "sound", title: "Wind", brief: "A low wind." });
    for (let i = 0; i < 5; i++) await tick();
    closed.host.tree = [];
    await settleAgents(closed.lead);
    assert.deepEqual(stopCodeOf(closed.rec, "agent-sound-1"), [["stopped", "run_ended"]]);

    const done = await leadOn();
    await deliver(done.lead);
    assert.deepEqual(stopCodeOf(done.rec, "agent-blender_model-1"), [["done", undefined]]);
  });

  it("a typeless worker_start runs a generic worker from the shared pool", async () => {
    const { lead, rec } = await leadOn();
    const call = leadToolHandler(lead);
    const started = String(
      await call("worker_start", { title: "Lights", task: "List the level's lights.", isolation: "read" }),
    );
    assert.match(started, /^Started w1 \(read\)/);
    assert.match(String(await call("worker_wait", { id: "w1", seconds: "5" })), /w1 · Lights · read · done/);
    const [delegation] = rec.paramsOf("engine.delegate");
    assert.equal(delegation?.readOnly, true, "a reader writes nothing");
    assert.equal(delegation?.cwd, undefined, "it works in the game folder itself");
    assert.equal(delegation?.toolAllow, undefined, "no type: no plugin tools of a type");
    assert.match(String(delegation?.prompt), /List the level's lights\./);
    assert.match(String(await call("worker_status", {})), /w1 · Lights/, "every worker's status names it");
    assert.match(String(await call("worker_start", { title: "No way", task: "Make it." })), /isolation read/);
    await settleAgents(lead);
  });

  it("a generic worker's end is in the lead's news once, as a typed worker's is", async () => {
    const { lead } = await leadOn();
    const call = leadToolHandler(lead);
    await call("worker_start", { title: "Lights", task: "List the level's lights.", isolation: "read" });
    await call("worker_wait", { id: "w1", seconds: "5" });
    const told = agentNews(lead).map((news) => news.text);
    assert.equal(told.filter((text) => /^worker w1: Lights done/.test(text)).length, 1, told.join("\n"));
    assert.deepEqual(
      agentNews(lead).filter((news) => news.id === "w1"),
      [],
      "told once",
    );
    await settleAgents(lead);
  });

  it("every worker's delegation carries the run's worker grant", async () => {
    const { lead, rec } = await leadOn();
    await deliver(lead);
    await leadToolHandler(lead)("worker_start", { title: "Lights", task: "List the lights.", isolation: "read" });
    await waitAgent(lead, { seconds: 1 });
    await settleAgents(lead);
    const grants = rec.paramsOf("engine.delegate").map((p) => p.worker);
    assert.deepEqual(grants, [
      { id: "blender_model-1", title: "Blender: Katana", runId: "run-lead" },
      { id: "w1", title: "Lights", runId: "run-lead", research: false },
    ]);
  });

  it("every worker's delegation carries the run's Genex credit cap, typed or generic", async () => {
    const { lead, rec } = await leadOn();
    lead.journal.credits = { spent: 0, cap: 600 };
    await deliver(lead);
    await leadToolHandler(lead)("worker_start", { title: "Lights", task: "List the lights.", isolation: "read" });
    await waitAgent(lead, { seconds: 1 });
    await settleAgents(lead);
    const caps = rec.paramsOf("engine.delegate").map((p) => [(p.worker as { id?: string })?.id, p.creditCap]);
    assert.deepEqual(caps, [
      ["blender_model-1", 600],
      ["w1", 600],
    ]);
  });

  it("a typed worker waiting on the person: its status says so, and worker_wait wakes on it once", async () => {
    const { lead, host, rec } = await leadOn();
    host.turns = ["hangs"];
    const log: Array<Record<string, unknown>> = [];
    rec.handle("events.list", (p) => {
      const at = log.findIndex((event) => event.id === p.after);
      return log.slice(at + 1);
    });
    const call = leadToolHandler(lead);
    await call("worker_start", { type: "blender_model", title: "Katana", task: "A katana." });
    for (let i = 0; i < 5; i++) await tick();
    const row = (id: string, state: string) => ({
      id,
      data: {
        type: "custom",
        event_type: "tool_permission",
        payload: {
          requestId: "perm-1",
          state,
          worker: { id: "blender_model-1" },
          title: "Blender: Katana wants to run blender",
        },
      },
    });
    log.push(row("e1", "pending"));
    const started = host.now;
    const woke = String(await call("worker_wait", { id: "blender_model-1", seconds: "200" }));
    assert.match(
      woke,
      /blender_model-1 \(Blender: Katana\): running, .*waiting for the person: Blender: Katana wants to run blender/,
    );
    assert.ok(host.now - started < 200_000, "it woke before its seconds were up");
    const again = host.now;
    assert.match(String(await call("worker_wait", { id: "blender_model-1", seconds: "5" })), /waiting for the person/);
    assert.ok(host.now - again >= 5_000, "a question already told does not wake it again");
    log.push(row("e2", "allowed"));
    assert.doesNotMatch(String(await call("worker_status", { id: "blender_model-1" })), /waiting for the person/);
    await settleAgents(lead);
  });

  it("a worker_wait for all of them that a generic worker ended leaves a typed worker's later question untold", async () => {
    const { lead, host, rec } = await leadOn();
    host.turns = ["hangs"];
    const log: Array<Record<string, unknown>> = [];
    rec.handle("events.list", (p) => log.slice(log.findIndex((event) => event.id === p.after) + 1));
    let endReader: () => void = () => {};
    rec.handle("engine.delegate", (p) => {
      if (!p.readOnly) return turn(host, p);
      return new Promise((resolve) => {
        endReader = () => resolve({ ok: true, engine: "claude-code", summary: "read it", usage: {}, turns: 1 });
      });
    });
    const call = leadToolHandler(lead);
    await call("worker_start", { type: "blender_model", title: "Katana", task: "A katana." });
    await call("worker_start", { title: "Lights", task: "List the lights.", isolation: "read" });
    for (let i = 0; i < 5; i++) await tick();
    const waiting = call("worker_wait", { seconds: "240" });
    for (let i = 0; i < 5; i++) await tick();
    endReader();
    await waiting;
    // The typed worker asks the person only after that wait answered.
    log.push({
      id: "e1",
      data: {
        type: "custom",
        event_type: "tool_permission",
        payload: { requestId: "perm-1", state: "pending", worker: { id: "blender_model-1" }, title: "Katana asks" },
      },
    });
    for (let i = 0; i < 50; i++) await tick();
    const before = host.now;
    assert.match(String(await call("worker_wait", { seconds: "5" })), /waiting for the person: Katana asks/);
    assert.ok(host.now - before < 5_000, "the question the lead was never shown wakes its next wait");
    await settleAgents(lead);
  });

  it("a stop that missed the typed worker's turn is sent again until it lands", async () => {
    const { lead, host, rec } = await leadOn();
    host.turns = ["hangs"];
    host.tree = [];
    let calls = 0;
    // The first stop finds no session yet (it was still being seated); the next one does.
    rec.handle("engine.abort", (p) => {
      calls += 1;
      if (calls === 1) return { aborted: 0 };
      host.aborted.add(String(p.cwd));
      return { aborted: 1 };
    });
    const call = leadToolHandler(lead);
    await call("worker_start", { type: "sound", title: "Wind", task: "A low wind." });
    for (let i = 0; i < 5; i++) await tick();
    await call("worker_stop", { id: "sound-1" });
    assert.equal(rec.paramsOf("engine.abort").length, 2, "sent again once nothing was found");
    const [wind] = lead.journal.agents;
    assert.equal(wind?.state, AgentState.Stopped);
    assert.equal(rec.paramsOf("engine.delegate").length, 1, "and it took no further turn");
  });

  it("a generic worker kept from before a restart is reached by its id, and its work can still be marked", async () => {
    const { lead, rec } = await leadOn();
    const kept = {
      id: "w1",
      title: "Sky",
      task: "x",
      isolation: "copy",
      type: null,
      research: false,
      state: "done",
      worktree: null,
      base: "a".repeat(40),
      commit: null,
      startedAt: 1,
      endedAt: 2,
      error: null,
      verdict: null,
      question: null,
      turn: null,
    };
    // Its work was kept on a ref of the game's repository before the restart: a used mark merges that commit.
    const used = { ...kept, id: "w2", title: "Rain", commit: "d".repeat(40) };
    rec.handle("artifact.read", (p) =>
      p.artifactId === `run-workers-${RUN.runId}` ? { workers: [kept, used] } : null,
    );
    const call = leadToolHandler(lead);
    try {
      assert.match(String(await call("worker_status", { id: "w1" })), /w1 · Sky · copy · done/);
      assert.match(String(await call("worker_mark", { id: "w1", verdict: "rejected" })), /^Rejected w1/);
      assert.match(String(await call("worker_status", {})), /w1 · Sky/);
      assert.match(
        String(await call("worker_mark", { id: "w2", verdict: "used" })),
        /^Merged w2's work into your folder/,
      );
      const merges = rec
        .paramsOf("run.exec")
        .filter((p) => p.project === RUN.project && /\bmerge\b.*--no-ff/.test(String(p.command)));
      assert.equal(merges.length, 1, "one merge, in the game folder");
      assert.match(String(merges[0]?.command), new RegExp("d".repeat(40)), "of the kept commit");
    } finally {
      await settleAgents(lead);
    }
  });

  it("a generic worker's snapshot and merge in the game folder wait for the lead's other git writes there", async () => {
    const { lead, host, rec } = await leadOn();
    rec.handle("snapshot.worktree", (p) => ({ path: `/copies/${String(p.name)}`, commit: "b".repeat(40) }));
    // The copy's own commit of its work, so marking it used merges something.
    rec.handle("run.exec", (p) =>
      String(p.cwd ?? "").startsWith("/copies/") && String(p.command).includes("rev-parse")
        ? { code: 0, signal: null, stdout: `${"e".repeat(40)}\n`, stderr: "" }
        : git(host, String(p.command)),
    );
    rec.handle("snapshot.create", () => ({ git: { game: "b".repeat(40) } }));
    const call = leadToolHandler(lead);
    // A landing (or a save point) holds the game's git index.
    let release = () => {};
    const landing = oneGitWrite(lead, () => new Promise<void>((resolve) => (release = resolve)));
    const started = call("worker_start", { title: "Sky", task: "Paint the sky.", isolation: "copy" });
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual(rec.paramsOf("snapshot.create"), [], "the copy's snapshot waits for the landing");
    release();
    await landing;
    assert.match(String(await started), /^Started w1/);
    assert.equal(rec.paramsOf("snapshot.create").length, 1);
    await call("worker_wait", { id: "w1", seconds: "5" });
    const merges = () =>
      rec.paramsOf("run.exec").filter((p) => p.project === RUN.project && /\bmerge\b/.test(String(p.command)));
    let again = () => {};
    const saving = oneGitWrite(lead, () => new Promise<void>((resolve) => (again = resolve)));
    const marked = call("worker_mark", { id: "w1", verdict: "used" });
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual(merges(), [], "the merge waits for the save point");
    again();
    await saving;
    assert.match(String(await marked), /^Merged w1/);
    assert.equal(merges().length, 1);
    await settleAgents(lead);
  });

  it("a typed worker whose copy is too large to make points at a worker in place, read by the refusal's code", async () => {
    const { lead, host, rec } = await leadOn();
    host.tree = [];
    const words = "This game is too large to copy; work in the game folder itself.";
    rec.handle("snapshot.worktree", () => {
      throw Object.assign(new Error(words), { code: "copy-too-large" });
    });
    const agent = await deliver(lead);
    assert.equal(agent.state, AgentState.Failed);
    assert.match(
      String(agent.error),
      /too large to copy; work in the game folder itself\. Start a worker with no type and isolation lock/,
    );
    rec.handle("snapshot.worktree", () => {
      throw new Error("too large to copy, said otherwise");
    });
    const other = await deliver(lead, { ...KATANA, title: "Scabbard" });
    assert.doesNotMatch(String(other.error), /isolation lock/, "never read from the words");
  });
});

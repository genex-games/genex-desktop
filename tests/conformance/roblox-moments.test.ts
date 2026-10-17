/**
 * The Roblox plugin at Genex's moments, over a stand-in Genex helper and Studio on the test's
 * clock: the place saved into the game folder before Genex's checkpoint (only what changed, large
 * containers split, a child past the host's cap left out and named by the host's own report), the
 * place loaded back after a restore with the scripts brought in step (or left waiting while Studio
 * is closed), health, the crash note, Team Create, the run's start, and the person told apart from
 * the agent's own marks.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ChatCheckpoints, CheckpointPhase } from "../../src/main/chat-checkpoints.ts";
import {
  AGENT_MARK_MAX_MS,
  AGENT_TRAIL_MS,
  agentBusyMarker,
  type AgentMarks,
  clearAgentPlay,
  markAgentPlay,
  readAgentMarks,
} from "../../src/plugins/roblox/agent-marks.ts";
import { createRobloxBackend, pendingThenScripts, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import {
  type HelperAsk,
  HelperLinkError,
  HelperLinkFailure,
  type RequestOptions,
} from "../../src/plugins/roblox/helper-link.ts";
import {
  CHUNK_BYTES,
  HelperErrorCode,
  HelperMessage,
  type HelperRequest,
  type HelperRequestBodies,
  helperHash,
  type PlacePart,
} from "../../src/plugins/roblox/helper-protocol.ts";
import { MOMENT_WORDS } from "../../src/plugins/roblox/hook-answers.ts";
import type { MomentServices } from "../../src/plugins/roblox/moment-ops.ts";
import {
  PENDING_LOAD,
  PENDING_SCRIPTS,
  PLACE_MANIFEST,
  SAVE_POINT_FILE_MAX_BYTES,
} from "../../src/plugins/roblox/place-files.ts";
import {
  createStudioWatch,
  FLUSH_MAX_MS,
  heroShotsAt,
  loadPlaceAt,
  type MomentOps,
  OPEN_WAIT_MS,
  openForRun,
  PERSON_ACTIVE_MS,
  personActive,
  RECONNECT_WAIT_MS,
  SAVE_PLACE_CHAT_MAX_MS,
  savePlaceAt,
  STUDIO_PING_MS,
  studioStateAt,
  teamNoteAt,
  viewportStill,
} from "../../src/plugins/roblox/studio-moments.ts";
import { type HookContext, HookEvent } from "../../src/shared/plugin-hooks.ts";
import { ensureRepo, git } from "../../src/substrate/snapshots.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "sky-race";
const CHAT_CHECKPOINT: HookContext = { on: HookEvent.CheckpointBefore, turn: "turn_1" };
const RUN_CHECKPOINT: HookContext = { on: HookEvent.CheckpointBefore, runId: "run_1", label: "Jump works" };
const RESTORE_BEFORE: HookContext = { on: HookEvent.RestoreBefore, forPerson: true };

/** What the stand-in helper and Studio were asked, in order. */
type Step = string;

/** The Genex helper's place as Studio holds it: parts by name, sent in chunks when the backend doesn't hold them. */
function studioPlace(initial: Record<string, Buffer>, steps: Step[]) {
  const parts = new Map(Object.entries(initial));
  const loads: Array<{ parts: PlacePart[]; uploaded: string[] }> = [];
  const state = {
    exportFails: undefined as HelperLinkError | undefined,
    others: [] as string[],
    pings: true,
    loadFails: undefined as Error | undefined,
  };
  const exportAnswer = (request: HelperRequestBodies["place.export"], options: RequestOptions) => {
    const known = new Map(request.known.map((part) => [part.name, part.hash]));
    const list: PlacePart[] = [];
    const sent: string[] = [];
    for (const [name, data] of parts) {
      const part = { name, hash: helperHash(data), bytes: data.length };
      list.push(part);
      if (!request.full && known.get(name) === part.hash) continue;
      const count = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
      for (let index = 0; index < count; index++) {
        const data64 = data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64");
        options.onChunk?.({ transfer: 1, part: name, index, count, data: data64 });
      }
      sent.push(name);
    }
    return { parts: list, sent, ms: 4 };
  };
  const ask = (async (type: HelperRequest, body: unknown, options: RequestOptions = {}) => {
    steps.push(type);
    if (type === HelperMessage.PlaceExport) {
      if (state.exportFails) throw state.exportFails;
      return exportAnswer(body as HelperRequestBodies["place.export"], options);
    }
    if (type === HelperMessage.PlaceLoad) {
      if (state.loadFails) throw state.loadFails;
      const request = body as HelperRequestBodies["place.load"];
      loads.push({ parts: request.parts, uploaded: (options.upload ?? []).map((one) => one.part) });
      return { loaded: request.parts.length };
    }
    if (type === HelperMessage.Team) return { others: state.others };
    if (type === HelperMessage.Activity) {
      if (!state.pings)
        throw new HelperLinkError(HelperLinkFailure.TimedOut, "The helper didn't answer activity in time.");
      return { editing: false };
    }
    throw new Error(`not asked in this test: ${type}`);
  }) as HelperAsk;
  return { ask, parts, loads, state };
}

const PLACE = () => ({
  "Workspace.rbxm": Buffer.from("baseplate and a red tower"),
  "ServerScriptService.rbxm": Buffer.from("scripts as instances"),
  "services.json": Buffer.from('{"Lighting":{"ClockTime":14}}'),
  "terrain.rbxm": Buffer.from("terrain"),
});

/** A game folder and the Studio operations of a moment on it; the test's clock and Studio. */
async function momentWorld(options: { initial?: Record<string, Buffer> } = {}) {
  const root = await realpath(await tmpDir("roblox-moments-"));
  const folder = path.join(root, GAME);
  await mkdir(path.join(folder, "src", "ServerScriptService"), { recursive: true });
  await writeFile(path.join(folder, "src", "ServerScriptService", "Main.server.luau"), "print('hi')\n");
  const steps: Step[] = [];
  const place = studioPlace(options.initial ?? PLACE(), steps);
  let clock = 5_000_000;
  const studio = {
    setUp: true,
    linked: true,
    bound: true,
    running: true,
    starting: false,
    listed: true,
    shot: { data: Buffer.from("jpeg bytes").toString("base64") } as { data: string } | null,
    /** Whether the scripts' reconcile runs to its end. */
    reconciles: true,
    /** Connects the helper once Genex opens Studio, after this long. */
    connectsAfterOpen: undefined as number | undefined,
  };
  const marks: AgentMarks = {};
  const watch = createStudioWatch(() => clock);
  const controller = new AbortController();
  let openedAt: number | undefined;
  const ops: MomentOps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    signal: controller.signal,
    mac: true,
    game: GAME,
    folder,
    setUp: async () => studio.setUp,
    linked: async () => studio.linked,
    bound: () => {
      const connected = openedAt !== undefined && studio.connectsAfterOpen !== undefined;
      return studio.bound || (connected && clock - (openedAt as number) >= (studio.connectsAfterOpen as number));
    },
    running: async () => studio.running,
    starting: async () => studio.starting,
    ask: place.ask,
    listed: async () => studio.listed,
    flush: async () => {
      steps.push("flush");
    },
    reapply: async (options) => {
      steps.push(options?.restored ? "reapply restored" : "reapply");
      return studio.reconciles;
    },
    open: async () => {
      steps.push("open");
      openedAt = clock;
      return { opened: true, message: "Opening sky-race in Roblox Studio." };
    },
    placeName: async () => "sky-race",
    shot: async () => {
      steps.push("shot");
      return studio.shot;
    },
    marks: async () => marks,
    asAgent: async (work) => {
      steps.push("agent:start");
      try {
        return await work();
      } finally {
        steps.push("agent:end");
      }
    },
    watch,
  };
  return {
    root,
    folder,
    ops,
    place,
    steps,
    studio,
    marks,
    watch,
    stop: () => controller.abort(),
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const placeFile = (folder: string, name: string) => path.join(folder, ".genex", "place", name);

describe("save-place: the place into the game folder before Genex's checkpoint", () => {
  it("sends the scripts still on their way first, then writes every part, then only the parts that changed", async () => {
    const world = await momentWorld();
    assert.deepEqual(await savePlaceAt(world.ops, CHAT_CHECKPOINT), {
      note: "Saved Roblox Studio's place (4 parts changed).",
    });
    assert.deepEqual(world.steps, ["flush", HelperMessage.PlaceExport], "the flush comes before the export");
    assert.equal(await readFile(placeFile(world.folder, "Workspace.rbxm"), "utf8"), "baseplate and a red tower");
    const untouched = (await stat(placeFile(world.folder, "terrain.rbxm"))).mtimeMs;

    world.place.parts.set("Workspace.rbxm", Buffer.from("baseplate, the tower deleted"));
    assert.deepEqual(await savePlaceAt(world.ops, CHAT_CHECKPOINT), {
      note: "Saved Roblox Studio's place (1 part changed).",
    });
    assert.equal(await readFile(placeFile(world.folder, "Workspace.rbxm"), "utf8"), "baseplate, the tower deleted");
    assert.equal(
      (await stat(placeFile(world.folder, "terrain.rbxm"))).mtimeMs,
      untouched,
      "an unchanged part is not written",
    );
    assert.deepEqual(await savePlaceAt(world.ops, RUN_CHECKPOINT), {}, "a run's save point that saved says nothing");
  });

  it("writes the parts before the host commits them: Genex's checkpoint holds the place as Studio had it", async () => {
    const world = await momentWorld();
    await ensureRepo(world.folder);
    const checkpoints = new ChatCheckpoints(path.join(world.root, "indexes"));
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    const commit = await checkpoints.take(world.folder, "thread_1", "msg_a", CheckpointPhase.Before);
    assert.ok(commit, "the checkpoint was taken");
    const held = await git(world.folder, ["show", `${commit}:.genex/place/Workspace.rbxm`]);
    assert.equal(held, "baseplate and a red tower");
    const manifest = await git(world.folder, ["show", `${commit}:.genex/place/${PLACE_MANIFEST}`]);
    assert.match(manifest, /"Workspace\.rbxm"/);
  });

  it("a container split per child lands as one file per child, and a child past the host's cap is left out by the host's checkpoint, which names it", async () => {
    const huge = Buffer.alloc(SAVE_POINT_FILE_MAX_BYTES + 1, 7);
    const world = await momentWorld({
      initial: {
        "Workspace.split/Baseplate.rbxm": Buffer.from("baseplate"),
        "Workspace.split/Island.rbxm": huge,
        "services.json": Buffer.from("{}"),
      },
    });
    await ensureRepo(world.folder);
    const answer = await savePlaceAt(world.ops, RUN_CHECKPOINT);
    assert.deepEqual(answer, {
      note: ".genex/place/Workspace.split/Island.rbxm is larger than 50 MB, so save points leave it out and Rewind can't bring it back.",
    });
    assert.equal(await readFile(placeFile(world.folder, "Workspace.split/Baseplate.rbxm"), "utf8"), "baseplate");
    const checkpoints = new ChatCheckpoints(path.join(world.root, "indexes"));
    const commit = await checkpoints.take(world.folder, "thread_1", "msg_a", CheckpointPhase.Before);
    assert.ok(commit);
    assert.deepEqual(await checkpoints.leftOut(world.folder, commit), {
      nested: [],
      skipped: [".genex/place/Workspace.split/Island.rbxm"],
    });
  });

  it("a flush that never settles holds a chat's save no longer than its limit", async () => {
    const world = await momentWorld();
    const limits: number[] = [];
    // A dialog in Studio holds the helper: the scripts' pushes never answer.
    world.ops.flush = (timeoutMs) => {
      limits.push(timeoutMs);
      return new Promise(() => {});
    };
    const started = world.now();
    const answer = await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    assert.deepEqual(limits, [FLUSH_MAX_MS]);
    assert.ok(world.now() - started <= SAVE_PLACE_CHAT_MAX_MS, `took ${world.now() - started} ms`);
    assert.deepEqual(answer, { note: "Saved Roblox Studio's place (4 parts changed)." });
  });

  it("stopped while the scripts flush (the host's step limit passed): nothing is exported or written", async () => {
    const world = await momentWorld();
    world.ops.flush = () => {
      world.stop();
      return new Promise(() => {});
    };
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    assert.ok(!world.steps.includes(HelperMessage.PlaceExport), world.steps.join(", "));
    await assert.rejects(stat(path.join(world.folder, ".genex", "place")), "no export lands after the snapshot");
  });

  it("an export whose answer comes after a Stop writes nothing", async () => {
    const world = await momentWorld();
    const ask = world.place.ask;
    world.ops.ask = (async (type, body, options) => {
      const answer = await ask(type, body, options);
      if (type === HelperMessage.PlaceExport) world.stop();
      return answer;
    }) as HelperAsk;
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    await assert.rejects(stat(placeFile(world.folder, PLACE_MANIFEST)), "no manifest without its parts");
    await assert.rejects(stat(placeFile(world.folder, "Workspace.rbxm")));
  });

  it("Studio with no way to export its place: the save point holds the scripts only, said plainly, never blocked", async () => {
    const world = await momentWorld();
    world.place.state.exportFails = new HelperLinkError(
      HelperLinkFailure.Answered,
      "SerializationService isn't available here",
      HelperErrorCode.Unsupported,
    );
    for (const hook of [RUN_CHECKPOINT, CHAT_CHECKPOINT]) {
      const answer = await savePlaceAt(world.ops, hook);
      assert.equal(answer.block, undefined);
      assert.match(String(answer.note), /save points hold the scripts only/);
    }
  });

  it("a run's save point is refused while Studio isn't connected; a chat's checkpoint notes it and holds the scripts", async () => {
    const world = await momentWorld();
    world.studio.bound = false;
    assert.deepEqual(await savePlaceAt(world.ops, RUN_CHECKPOINT), { block: MOMENT_WORDS.NotConnectedRun });
    assert.deepEqual(await savePlaceAt(world.ops, CHAT_CHECKPOINT), { note: MOMENT_WORDS.NotConnectedChat });
    assert.deepEqual(world.steps, [], "nothing asked of a Studio that isn't there");
  });

  it("before a restore: the newer place is saved first, others in Team Create are named, and a failed save keeps everything", async () => {
    const world = await momentWorld();
    world.place.state.others = ["Ana", "Bo"];
    assert.deepEqual(await savePlaceAt(world.ops, RESTORE_BEFORE), {
      note: "Others are in this place in Team Create (Ana, Bo): going back also undoes their edits since then.",
    });
    assert.deepEqual(world.steps, [HelperMessage.Team, "flush", HelperMessage.PlaceExport]);
    world.place.state.exportFails = new HelperLinkError(
      HelperLinkFailure.TimedOut,
      "The helper didn't answer place.export in time.",
    );
    const failed = await savePlaceAt(world.ops, RESTORE_BEFORE);
    assert.match(String(failed.block), /couldn't save Roblox Studio's place first/);
  });
});

describe("load-place: the restored place back into Studio", () => {
  it("loads every saved part, then brings Studio's scripts in step with the restored src/, both as Genex's own work", async () => {
    const world = await momentWorld();
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    world.steps.length = 0;
    assert.deepEqual(await loadPlaceAt(world.ops), {});
    // Flipped: the reconcile after a restore lets the restored files win.
    assert.deepEqual(world.steps, [
      "agent:start",
      HelperMessage.PlaceLoad,
      "agent:end",
      "agent:start",
      "reapply restored",
      "agent:end",
    ]);
    assert.deepEqual(world.place.loads[0]?.uploaded.sort(), Object.keys(PLACE()).sort(), "every part is sent");
  });

  it("with Studio closed it leaves pending-load.json, and the next connection loads it", async () => {
    const world = await momentWorld();
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    world.studio.bound = false;
    world.steps.length = 0;
    assert.deepEqual(await loadPlaceAt(world.ops), { note: MOMENT_WORDS.Pending });
    assert.deepEqual(world.steps, [], "nothing is asked of a Studio that isn't there");
    assert.match(await readFile(placeFile(world.folder, PENDING_LOAD), "utf8"), /"since"/);
    // Connected again: a load clears what waited.
    world.studio.bound = true;
    await loadPlaceAt(world.ops);
    await assert.rejects(readFile(placeFile(world.folder, PENDING_LOAD)), "the wait is cleared once loaded");
  });

  it("the helper's next connection loads what waited before the scripts are compared; a failed load keeps waiting", async () => {
    const world = await momentWorld();
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    world.studio.bound = false;
    await loadPlaceAt(world.ops);
    world.steps.length = 0;
    const logged: string[] = [];
    const scripts = {
      folder: async () => world.folder,
      bind: async (_game: string, options?: { restored?: boolean }) => {
        world.steps.push(options?.restored ? "restored scripts compared" : "scripts compared");
        return true;
      },
    };
    world.place.state.loadFails = new Error("Studio is busy");
    await pendingThenScripts(scripts, (line) => logged.push(line))(GAME, world.place.ask);
    // Flipped: a failed load still lets the restored files win; their wait is then done.
    assert.deepEqual(world.steps, [HelperMessage.PlaceLoad, "restored scripts compared"]);
    assert.match(logged.join("\n"), /pending load: Studio is busy/);
    assert.match(await readFile(placeFile(world.folder, PENDING_LOAD), "utf8"), /"since"/, "still waiting");
    world.place.state.loadFails = undefined;
    world.steps.length = 0;
    await pendingThenScripts(scripts, (line) => logged.push(line))(GAME, world.place.ask);
    assert.deepEqual(world.steps, [HelperMessage.PlaceLoad, "scripts compared"], "the load goes first");
    await assert.rejects(readFile(placeFile(world.folder, PENDING_LOAD)), "loaded, the wait is gone");
    world.steps.length = 0;
    await pendingThenScripts(scripts, () => {})(GAME, world.place.ask);
    assert.deepEqual(world.steps, ["scripts compared"], "nothing waiting: only the scripts");
  });

  it("a restored scripts' reconcile that didn't run to its end keeps its wait, now and at the next connection", async () => {
    const world = await momentWorld();
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    world.studio.reconciles = false;
    await loadPlaceAt(world.ops);
    assert.match(await readFile(placeFile(world.folder, PENDING_SCRIPTS), "utf8"), /"since"/, "still waiting");
    const reconciled = { now: false };
    const scripts = {
      folder: async () => world.folder,
      bind: async (_game: string, options?: { restored?: boolean }) => {
        world.steps.push(options?.restored ? "restored scripts compared" : "scripts compared");
        return reconciled.now;
      },
    };
    world.steps.length = 0;
    await pendingThenScripts(scripts, () => {})(GAME, world.place.ask);
    assert.deepEqual(world.steps, ["restored scripts compared"]);
    assert.match(await readFile(placeFile(world.folder, PENDING_SCRIPTS), "utf8"), /"since"/, "still waiting");
    reconciled.now = true;
    await pendingThenScripts(scripts, () => {})(GAME, world.place.ask);
    await assert.rejects(readFile(placeFile(world.folder, PENDING_SCRIPTS)), "done once it ran");
  });

  it("a save point with no saved place brings back the scripts alone, and says so", async () => {
    const world = await momentWorld();
    assert.deepEqual(await loadPlaceAt(world.ops), { note: MOMENT_WORDS.NoExport });
    // Flipped: the restored files win over Studio's newer scripts.
    assert.deepEqual(world.steps, ["agent:start", "reapply restored", "agent:end"], "the scripts still come back");
  });

  it("with Studio closed and no saved place, the restored scripts win at the next connection", async () => {
    const world = await momentWorld();
    world.studio.bound = false;
    assert.deepEqual(await loadPlaceAt(world.ops), { note: MOMENT_WORDS.NoExport });
    assert.deepEqual(world.steps, [], "nothing is asked of a Studio that isn't there");
    const scripts = {
      folder: async () => world.folder,
      bind: async (_game: string, options?: { restored?: boolean }) => {
        world.steps.push(options?.restored ? "restored scripts compared" : "scripts compared");
        return true;
      },
    };
    await pendingThenScripts(scripts, () => {})(GAME, world.place.ask);
    assert.deepEqual(world.steps, ["restored scripts compared"]);
    world.steps.length = 0;
    await pendingThenScripts(scripts, () => {})(GAME, world.place.ask);
    assert.deepEqual(world.steps, ["scripts compared"], "once only");
  });

  it("a load Studio refuses is a note, and the restored scripts still win; a restore's after step never blocks", async () => {
    const world = await momentWorld();
    await savePlaceAt(world.ops, CHAT_CHECKPOINT);
    world.place.state.loadFails = new Error("Studio couldn't read Workspace: bad bytes");
    world.steps.length = 0;
    const answer = await loadPlaceAt(world.ops);
    assert.equal(answer.block, undefined);
    assert.match(String(answer.note), /couldn't load the saved place \(Studio couldn't read Workspace: bad bytes\)/);
    assert.ok(world.steps.includes("reapply restored"), world.steps.join(", "));
  });
});

describe("studio-state: health", () => {
  it("blocks a run once the helper is unconnected: Studio gone at once, Studio open without the place after the reconnect wait", async () => {
    const world = await momentWorld();
    world.studio.bound = false;
    world.studio.running = false;
    assert.deepEqual(await studioStateAt(world.ops), { block: MOMENT_WORDS.Gone });
    world.studio.running = true;
    assert.deepEqual(await studioStateAt(world.ops), { pending: MOMENT_WORDS.Connecting });
    world.advance(RECONNECT_WAIT_MS);
    assert.deepEqual(await studioStateAt(world.ops), { block: MOMENT_WORDS.NotOpen });
    world.studio.starting = true;
    assert.deepEqual(
      await studioStateAt(world.ops),
      { pending: MOMENT_WORDS.Starting },
      "a Studio Genex just opened starts",
    );
  });

  it("notes a ping that timed out: a dialog may be open, look with app_look", async () => {
    const world = await momentWorld();
    assert.deepEqual(await studioStateAt(world.ops), {}, "quiet while Studio answers");
    world.place.state.pings = false;
    const answer = await studioStateAt(world.ops);
    assert.match(
      String(answer.pending),
      /^Roblox Studio isn't answering; a dialog may be open in Studio\. Look at Studio with app_look \(look only\)/,
    );
    assert.equal(answer.note, answer.pending);
    world.place.state.pings = true;
    world.studio.listed = false;
    assert.deepEqual(await studioStateAt(world.ops), { pending: MOMENT_WORDS.Unlisted });
  });

  it("blocks with the step when Studio isn't set up or the game has no place", async () => {
    const world = await momentWorld();
    world.studio.linked = false;
    assert.deepEqual(await studioStateAt(world.ops), { block: MOMENT_WORDS.NoPlace });
    world.studio.setUp = false;
    assert.deepEqual(await studioStateAt(world.ops), { block: MOMENT_WORDS.NotSetUp });
  });
});

describe("open-for-run: Studio connected before a Loop's first turn", () => {
  it("opens the place when it isn't connected and waits for its helper", async () => {
    const world = await momentWorld();
    world.studio.bound = false;
    world.studio.connectsAfterOpen = 20_000;
    assert.deepEqual(await openForRun(world.ops), { note: "Opened sky-race in Roblox Studio for the Loop." });
    assert.deepEqual(world.steps.slice(0, 1), ["open"]);
  });

  it("blocks once the wait ran out on its clock, and on a Stop", async () => {
    const world = await momentWorld();
    world.studio.bound = false;
    const started = world.now();
    assert.deepEqual(await openForRun(world.ops), { block: MOMENT_WORDS.NotConnected(OPEN_WAIT_MS / 60_000) });
    assert.ok(world.now() - started >= OPEN_WAIT_MS && world.now() - started < OPEN_WAIT_MS + STUDIO_PING_MS);
    const stopped = await momentWorld();
    stopped.studio.bound = false;
    stopped.stop();
    assert.deepEqual(await openForRun(stopped.ops), { block: MOMENT_WORDS.Stopped });
  });

  it("quiet when the helper answers; blocks when it doesn't (a dialog), or when Studio isn't set up", async () => {
    const world = await momentWorld();
    assert.deepEqual(await openForRun(world.ops), {});
    world.place.state.pings = false;
    assert.match(String((await openForRun(world.ops)).block), /dialog may be open/);
    world.studio.setUp = false;
    assert.deepEqual(await openForRun(world.ops), { block: MOMENT_WORDS.NotSetUp });
  });
});

describe("team-note, hero-shots", () => {
  it("names who else is in the place when that changes, asking the helper when it hasn't said", async () => {
    const world = await momentWorld();
    world.place.state.others = ["Ana"];
    assert.deepEqual(await teamNoteAt(world.ops), { note: "Also in this place in Team Create: Ana." });
    assert.deepEqual(await teamNoteAt(world.ops), {}, "the same people again say nothing");
    world.watch.team(GAME, ["Ana", "Bo"]);
    assert.deepEqual(await teamNoteAt(world.ops), { note: "Also in this place in Team Create: Ana, Bo." });
    assert.deepEqual(world.steps, [HelperMessage.Team], "asked once, then told");
  });

  it("a run's save point keeps the viewport's picture, a chat's takes none, the observer gets it within its time", async () => {
    const world = await momentWorld();
    const run = await heroShotsAt(world.ops, { on: HookEvent.CheckpointAfter, runId: "run_1" });
    assert.deepEqual(
      run.images?.map((image) => image.name),
      ["viewport"],
    );
    assert.deepEqual(await heroShotsAt(world.ops, { on: HookEvent.CheckpointAfter, turn: "turn_1" }), {});
    assert.equal((await viewportStill(world.ops, 40_000)).images?.length, 1);
    assert.deepEqual(await viewportStill(world.ops, 2_000), {}, "no time left to keep a picture: none taken");
    world.studio.bound = false;
    assert.deepEqual(await heroShotsAt(world.ops, { on: HookEvent.CheckpointAfter, runId: "run_1" }), {});
  });
});

describe("the person first: the agent's own work in Studio is not the person's", () => {
  it("activity the helper reports is the person's unless the agent's busy or play mark covers it", async () => {
    const world = await momentWorld();
    assert.equal(await personActive(world.ops), false, "nothing reported: nobody");
    world.watch.activity(GAME, true);
    assert.equal(await personActive(world.ops), true, "a selection with no mark is the person's");
    world.marks.busy = { since: world.now() - 1_000, until: world.now() - 500 };
    assert.equal(await personActive(world.ops), false, "Studio's record of the agent's execute_luau is the agent's");
    world.advance(AGENT_TRAIL_MS + 1_000);
    world.watch.activity(GAME, true);
    assert.equal(await personActive(world.ops), true, "the person's selection after the agent's write ended is theirs");
    world.advance(PERSON_ACTIVE_MS + 1);
    assert.equal(await personActive(world.ops), false, "activity past its time no longer counts");
    delete world.marks.busy;
    world.marks.play = { since: world.now() - 10 };
    world.watch.activity(GAME, true);
    assert.equal(
      await personActive(world.ops),
      false,
      "during the agent's play test, Studio's changes are the agent's",
    );
    delete world.marks.play;
    world.watch.activity(GAME, true);
    world.watch.activity(GAME, false);
    assert.equal(await personActive(world.ops), false, "the helper said the person stopped");
  });

  it("marks as files: believed while fresh, never when stale or dated ahead, play cleared when it ends", async () => {
    const folder = path.join(await realpath(await tmpDir("roblox-marks-")), "mcp", GAME);
    let clock = 9_000_000;
    const busy = agentBusyMarker(folder, () => clock);
    await busy.around(async () => {
      clock += 400;
    });
    assert.deepEqual(await readAgentMarks(folder, clock), { busy: { since: 9_000_000, until: 9_000_400 } });
    assert.deepEqual(
      await readAgentMarks(folder, clock + AGENT_MARK_MAX_MS + 1),
      {},
      "a mark past its age is not believed",
    );
    assert.deepEqual(await readAgentMarks(folder, 8_000_000), {}, "a mark dated ahead of now is not believed");
    await markAgentPlay(folder, clock);
    assert.deepEqual((await readAgentMarks(folder, clock)).play, { since: clock });
    await clearAgentPlay(folder);
    assert.equal((await readAgentMarks(folder, clock)).play, undefined);
    await writeFile(path.join(folder, "agent-play.json"), "not json");
    assert.equal((await readAgentMarks(folder, clock)).play, undefined, "a damaged mark says nothing");
  });
});

describe("the backend at Genex's moments", () => {
  /** The backend on a fake Mac, its helper link a stand-in whose watch the test feeds. */
  async function backendWorld() {
    const mac = await robloxMac({ studios: [{ id: "studio-1", name: "sky-race" }] });
    const game = await makeGame(mac, GAME, "Sky race");
    const shots: unknown[] = [];
    mac.deps.studio = {
      studios: async () => [{ id: "studio-1", name: "sky-race" }],
      callTool: async (name, args) => {
        shots.push({ name, args });
        return { content: [{ type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" }] };
      },
    };
    const watch = createStudioWatch(mac.deps.now);
    const flushes: Array<[string, number | undefined]> = [];
    const moments: MomentServices = {
      ask: () => (async () => ({ editing: false })) as unknown as HelperAsk,
      bound: () => "studio-1",
      flush: async (game, timeoutMs) => {
        flushes.push([game, timeoutMs]);
      },
      reapply: async () => true,
      watch,
    };
    mac.deps.moments = moments;
    const backend = createRobloxBackend(mac.deps);
    const call = (tool: string, hook?: HookContext) => {
      const { context } = hostFor(mac, game);
      return backend.tool?.(tool, {}, hook ? { ...context, hook } : context);
    };
    return { mac, game, backend, call, watch, shots, flushes };
  }

  it("a chat's save gives the scripts' flush the save's own limit", async () => {
    const world = await backendWorld();
    const place = path.join(world.game.directory, "sky-race.rbxlx");
    await writeFile(place, "<roblox/>");
    await mkdir(path.join(world.mac.storage, "links"), { recursive: true });
    await writeFile(
      path.join(world.mac.storage, "links", `${GAME}.json`),
      JSON.stringify({ kind: "roblox", project: place }),
    );
    await world.call(RobloxTool.SavePlace, CHAT_CHECKPOINT);
    assert.deepEqual(world.flushes, [[GAME, FLUSH_MAX_MS]]);
  });

  it("the crash note asks the person and never quits or kills Studio", async () => {
    const world = await backendWorld();
    assert.deepEqual(await world.call(RobloxTool.StudioCrashNote, { on: HookEvent.Crash, runId: "run_1" }), {
      note: MOMENT_WORDS.Crash,
    });
    assert.deepEqual(world.mac.launches, [], "nothing opened or quit");
    assert.ok(!world.mac.ran.some((file) => /osascript|taskkill|kill/.test(file)), "no quit and no kill");
  });

  it("the lock's probe answers the person's activity through the helper link's watch", async () => {
    const world = await backendWorld();
    assert.deepEqual(await world.call(RobloxTool.StudioActivity), { personActive: false });
    world.watch.activity(GAME, true);
    assert.deepEqual(await world.call(RobloxTool.StudioActivity), { personActive: true });
  });

  it("hero-shots takes Studio's own screen capture of the game's Studio; a moment's tool says nothing outside its moments", async () => {
    const world = await backendWorld();
    const answer = (await world.call(RobloxTool.HeroShots, { on: HookEvent.CheckpointAfter, runId: "run_1" })) as {
      images?: Array<{ name: string }>;
    };
    assert.deepEqual(
      answer.images?.map((image) => image.name),
      ["viewport"],
    );
    assert.deepEqual(world.shots, [
      {
        name: "screen_capture",
        args: {
          studio_id: "studio-1",
          capture_id: (world.shots[0] as { args: { capture_id: string } }).args.capture_id,
        },
      },
    ]);
    assert.deepEqual(await world.call(RobloxTool.SavePlace), {}, "called with no moment, it does nothing");
  });
});

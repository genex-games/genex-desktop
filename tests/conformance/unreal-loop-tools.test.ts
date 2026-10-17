/**
 * The Unreal Loop's plugin tools over a game folder: builders' `check-part` names every problem;
 * `run-part` refuses a part that doesn't pass and queues one that does; `part-result` hands back the
 * editor's shots; `export-reference` keeps the engine's reference for the gate. The editor is a
 * stand-in.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { LoopTool, PartProbe, PartRunState } from "../../src/plugins/unreal/editor-queue.ts";
import {
  type AnyLoopTool,
  createLoopTools,
  LeadLoopToolName,
  LoopEditorTool,
  LoopToolName,
} from "../../src/plugins/unreal/loop-tools.ts";
import { unrealPython } from "../../src/plugins/unreal/python-check.ts";
import { loadReference, storeReference } from "../../src/plugins/unreal/reference-store.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A guard against a wait that never ends: the queue's own waits run on the fake clock, never on this. */
const TEST_TIMEOUT = { timeout: 60_000 };

const PART = {
  title: "Lantern",
  goal: "Lanterns light the path.",
  blueprints: [{ name: "BP_Lantern", base: "Actor", components: [{ name: "Light", class: "PointLightComponent" }] }],
};

/** The Vehicle template's car, as the Genex editor helper's export_project writes the project file. */
const TEMPLATE = {
  map: "/Game/VehicleTemplate/Maps/VehicleExampleMap",
  gameMode: {
    path: "/Game/VehicleTemplate/Blueprints/BP_VehicleAdvGameMode",
    parent: "GameModeBase",
    defaultPawn: "BP_VehicleAdvOffroadCar",
  },
  blueprints: [
    {
      name: "BP_VehicleAdvOffroadCar",
      path: "/Game/VehicleTemplate/Blueprints/OffroadCar/BP_VehicleAdvOffroadCar",
      parent: "WheeledVehiclePawn",
      components: [{ name: "BackCamera", class: "CameraComponent" }],
      variables: [{ name: "IsReversing", type: "bool" }],
    },
  ],
  more: 0,
  inputActions: ["Throttle", "Steering"],
};

/** A reference that knows the event and the player pawn, so the gate checks node names for real. */
const SMALL_REFERENCE = {
  version: 1 as const,
  engine: "5.8.3",
  common: ["Game|GetPlayerPawn", "Development|PrintString"],
  contexts: { "Actor/EventGraph": ["AddEvent|EventBeginPlay"] },
  pins: { "AddEvent|EventBeginPlay": { inputs: [], outputs: [["then", "Exec"] as const] } },
};

/** Lantern's Blueprint text driving the template's car: a cast, a variable and a component of it. */
const DRIVES_THE_CAR = [
  "(event EventBeginPlay",
  "  (bind car (Utilities|Casting|CastToBP_VehicleAdvOffroadCar :Object (Game|GetPlayerPawn 0))",
  "    (:then (Class|BPVehicleAdvOffroadCar|SetIsReversing :self car :IsReversing (Class|BPVehicleAdvOffroadCar|GetIsReversing :self car))",
  "      (Development|PrintString (Class|BPVehicleAdvOffroadCar|GetBackCamera :self car)))",
  "    (:CastFailed)))",
].join("\n");

/**
 * The queue's clock: a sleep moves time on by its length and yields one turn, so every wait the queue
 * makes ends by its own rule however slow the machine is.
 */
function fakeClock() {
  let at = Date.now();
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
      await nextTurn();
    },
  };
}

type PartRunAnswer = {
  state: string;
  result?: { shots: Array<{ name: string; data: string }>; probes?: unknown };
};

/**
 * Asks `part-result` for `id` until `seen` holds or the run ended; every queue wait ends in the fake
 * time. The test's `signal` ends the loop when the test times out, naming the state it stalled in, so
 * a stalled part fails its test and the file still exits.
 */
async function untilRun(
  w: Awaited<ReturnType<typeof world>>,
  id: string,
  seen: (run: PartRunAnswer) => boolean,
  signal: AbortSignal,
): Promise<PartRunAnswer> {
  for (;;) {
    const run = (await w.call(LoopToolName.PartResult, { id })) as PartRunAnswer;
    if (seen(run) || run.state === PartRunState.Done || run.state === PartRunState.Failed) return run;
    if (signal.aborted) throw new Error(`part ${id} never ended: it is still ${run.state}`);
    await nextTurn(undefined, { signal }).catch(() => undefined);
  }
}

async function world(options: { applyHeld?: Promise<unknown> } = {}) {
  const root = await realpath(await tmpDir("studio-loop-tools-"));
  const game = path.join(root, "game");
  const storage = path.join(root, "storage");
  const projectDir = path.join(game, "unreal");
  const part = path.join(game, "unreal", "parts", "Lantern");
  await mkdir(part, { recursive: true });
  await mkdir(storage, { recursive: true });
  await writeFile(path.join(part, "part.json"), JSON.stringify(PART));
  await writeFile(path.join(part, "BP_Lantern.dsl"), "(event EventBeginPlay)");
  await writeFile(path.join(part, "test.json"), JSON.stringify({ steps: [{ shot: "lanterns" }] }));
  await writeFile(path.join(part, "apply.py"), "genex.save()\n");
  const shot = path.join(projectDir, "Saved", "Genex", "captures", "lanterns.png");
  const calls: Array<[AnyLoopTool, Record<string, unknown>]> = [];
  // `personPie`: the person pressed Play in Unreal, beside whatever the queue does.
  const state = { pie: false, personPie: false };
  const refuse: { export?: string; project?: string } = {};
  const editorCall = async (_storage: string, _game: string, tool: AnyLoopTool, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    if (tool === LoopTool.ApplyPart) {
      await options.applyHeld;
      return { ok: true };
    }
    if (tool === LoopTool.StartPlay) state.pie = true;
    if (tool === LoopTool.StopPlay) state.pie = false;
    if (tool === LoopTool.PlayState) return { pie: state.pie };
    if (tool === LoopTool.EditorActivity)
      return { camera: [0], selection: [], dirty: [], pie: state.pie || state.personPie };
    if (tool === LoopTool.ProbeCharacters) return { pawns: [{ label: "Lantern_0", gapCm: 30 }], more: 0 };
    if (tool === LoopTool.ProbeView) return { meshes: [], postProcess: { extreme: [] } };
    if (tool === LoopTool.CapturePlay) {
      await mkdir(path.dirname(shot), { recursive: true });
      await writeFile(shot, "PNG");
      return { queued: true, file: shot };
    }
    if (tool === LoopEditorTool.ExportReference && !("pins" in args))
      throw new Error("export_reference is missing pins (Unreal's schema needs every parameter)");
    if (tool === LoopEditorTool.ExportReference && refuse.export) return { error: refuse.export };
    if (tool === LoopEditorTool.ExportReference) {
      await mkdir(path.dirname(String(args.file)), { recursive: true });
      await writeFile(
        String(args.file),
        JSON.stringify({ version: 1, engine: "5.8.3", common: ["Development|PrintString"], contexts: {}, pins: {} }),
      );
    }
    if (tool === LoopEditorTool.ExportPythonNames)
      await writeFile(String(args.file), JSON.stringify({ Vector: ["x"] }));
    if (tool === LoopEditorTool.ExportProject && refuse.project) throw new Error(refuse.project);
    if (tool === LoopEditorTool.ExportProject) {
      await writeFile(String(args.file), JSON.stringify(TEMPLATE));
      return { file: args.file, blueprints: 1, more: 0, inputActions: 2, ms: 40 };
    }
    return { ok: true };
  };
  const clock = fakeClock();
  const tools = createLoopTools({
    platform: "darwin",
    engine: async () => ({ version: "5.8", directory: path.join(root, "engine") }),
    project: async () => path.join(projectDir, "Game.uproject"),
    xcode: async () => ({ state: XcodeState.Ready }),
    editorCall,
    editorAnswers: async () => true,
    // These tests never add a C++ module, so Unreal is never quit or opened.
    restart: { editors: async () => 0, quit: async () => {}, open: async () => {} },
    ...clock,
  });
  const context: PluginContext = {
    project: "valley",
    directory: game,
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  };
  const call = (name: (typeof LoopToolName)[keyof typeof LoopToolName], args: Record<string, unknown> = {}) =>
    tools.call(name, args, context, storage);
  return {
    root,
    game,
    storage,
    projectDir,
    part,
    calls,
    call,
    tools,
    refuse,
    state,
    engineDir: path.join(root, "engine"),
  };
}

/** Writes <project>/Saved/Genex/project.json, or makes it a link to `text` when `link`. */
async function writeProjectFile(projectDir: string, text: string, link = false) {
  const file = path.join(projectDir, "Saved", "Genex", "project.json");
  await mkdir(path.dirname(file), { recursive: true });
  await rm(file, { force: true });
  if (link) await symlink(text, file);
  else await writeFile(file, text);
}

/** A stand-in for the engine's own Python at its real place: it answers every apply.py check with `problem`. */
async function writeFakeUnrealPython(engineDir: string, problem: Record<string, unknown>) {
  const python = unrealPython(engineDir, "darwin");
  const answer = path.join(engineDir, "python-answer.json");
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(answer, JSON.stringify([problem]));
  await writeFile(python, `#!/bin/sh\ncat > /dev/null\ncat "${answer}"\n`);
  await chmod(python, 0o755);
}

describe("the Unreal Loop's tools", () => {
  it("check-part passes a good part and names each problem of a bad one", async () => {
    const w = await world();
    assert.match(String(await w.call(LoopToolName.CheckPart, { part: "Lantern" })), /Lantern passes/);
    await writeFile(path.join(w.part, "test.json"), JSON.stringify({ steps: [{ jump: true }] }));
    const answer = String(await w.call(LoopToolName.CheckPart, { part: "Lantern" }));
    assert.match(answer, /1 problem/);
    // Flipped (was /test\.json step 1/): each line is "- <file>[:<line>]: <message>", as compile errors read.
    assert.match(answer, /- test\.json: step 1/);
  });

  const posixOnly = process.platform === "win32" ? "the stand-in for Unreal's Python is a shell script" : false;
  it("check-part names each problem's suggestion once: a node's, an event's, a pin's and apply.py's", {
    skip: posixOnly,
  }, async () => {
    const w = await world();
    const printString = { inputs: [["execute", "Exec"] as const, ["InString", "string"] as const], outputs: [] };
    await storeReference(w.storage, "5.8", {
      ...SMALL_REFERENCE,
      pins: { ...SMALL_REFERENCE.pins, "Development|PrintString": printString },
    });
    await writeFakeUnrealPython(w.engineDir, {
      code: "unknown-name",
      line: 1,
      message: "apply.py: unreal.EditorLevelLibary doesn't exist in this engine",
      suggestions: ["EditorLevelLibrary"],
    });
    const text = ["(event EventBeginPla", '  (Development|PrintStrin "x")', '  (Development|PrintString :String "x"))'];
    await writeFile(path.join(w.part, "BP_Lantern.dsl"), text.join("\n"));
    const answer = String(await w.call(LoopToolName.CheckPart, { part: "Lantern" }));
    const lines = answer.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(lines.length, 4, answer);
    for (const line of lines) assert.equal(line.match(/Did you mean/g)?.length, 1, line);
    assert.match(answer, /EventBeginPlay/);
    assert.match(answer, /Did you mean Development\|PrintString/);
    assert.match(answer, /Did you mean InString/);
    assert.match(answer, /Did you mean EditorLevelLibrary/);
  });

  it("run-part refuses a part that fails its checks and never touches the editor", async () => {
    const w = await world();
    await writeFile(path.join(w.part, "part.json"), "{}");
    await assert.rejects(w.call(LoopToolName.RunPart, { part: "Lantern" }), /doesn't pass/);
    for (const part of ["../x", "", "a b"])
      await assert.rejects(w.call(LoopToolName.RunPart, { part }), /not a part name/);
    assert.deepEqual(w.calls, []);
  });

  it(
    "run-part queues a passing part; part-result hands back its shots and probes once done",
    TEST_TIMEOUT,
    async (t) => {
      const w = await world();
      const { id } = (await w.call(LoopToolName.RunPart, { part: "Lantern" })) as { id: string };
      const run = await untilRun(w, id, () => false, t.signal);
      assert.equal(run.state, PartRunState.Done, JSON.stringify(run));
      assert.equal(run.result?.shots[0]?.name, "lanterns");
      assert.equal(Buffer.from(run.result?.shots[0]?.data ?? "", "base64").toString(), "PNG");
      assert.deepEqual(run.result?.probes, {
        [PartProbe.Characters]: { pawns: [{ label: "Lantern_0", gapCm: 30 }], more: 0 },
        [PartProbe.View]: { meshes: [], postProcess: { extreme: [] } },
      });
      const applied = w.calls.find(([tool]) => tool === LoopTool.ApplyPart)?.[1];
      assert.equal(applied?.script, path.join(w.part, "apply.py"));
    },
  );

  it(
    "a play the person starts while a part is being applied is theirs: the queue plays only once it is playing",
    TEST_TIMEOUT,
    async (t) => {
      let release = () => {};
      const applyHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      const w = await world({ applyHeld });
      const { id } = (await w.call(LoopToolName.RunPart, { part: "Lantern" })) as { id: string };
      const applying = await untilRun(
        w,
        id,
        (run) => run.state === PartRunState.Applying && w.calls.some(([tool]) => tool === LoopTool.ApplyPart),
        t.signal,
      );
      assert.equal(applying.state, PartRunState.Applying, JSON.stringify(applying));
      w.state.personPie = true;
      const probe = (await w.tools.call(
        LeadLoopToolName.EditorActivity,
        {},
        {
          project: "valley",
          directory: w.game,
          signal: new AbortController().signal,
          callId: 2,
          host: (async () => w.storage) as never,
        },
        w.storage,
      )) as { personActive: boolean };
      assert.equal(probe.personActive, true, "the person's play while the part is applied");
      w.state.personPie = false;
      release();
    },
  );

  it("export-reference keeps the engine's reference and Python names for the gate", async () => {
    const w = await world();
    assert.equal(await loadReference(w.storage, "5.8"), null);
    await w.call(LoopToolName.ExportReference);
    assert.deepEqual((await loadReference(w.storage, "5.8"))?.common, ["Development|PrintString"]);
  });

  it("export-reference also has the editor write the template's project file, and a failure there fails nothing", async () => {
    const w = await world();
    const file = path.join(w.projectDir, "Saved", "Genex", "project.json");
    const answer = (await w.call(LoopToolName.ExportReference)) as { project?: unknown; nodes?: number };
    assert.deepEqual(w.calls.find(([tool]) => tool === LoopEditorTool.ExportProject)?.[1], { file });
    assert.deepEqual(answer.project, { blueprints: 1, more: 0, inputActions: 2 });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), TEMPLATE);
    w.refuse.project = "connection reset";
    const failed = (await w.call(LoopToolName.ExportReference)) as { project?: unknown; nodes?: number };
    assert.deepEqual(failed.project, { error: "connection reset" });
    assert.equal(failed.nodes, 1, "the node reference is still kept");
  });

  it("check-part lets a part cast to and use the template's own Blueprints once the editor exported them", async () => {
    const w = await world();
    await storeReference(w.storage, "5.8", SMALL_REFERENCE);
    await writeFile(path.join(w.part, "BP_Lantern.dsl"), DRIVES_THE_CAR);
    assert.match(String(await w.call(LoopToolName.CheckPart, { part: "Lantern" })), /CastToBP_VehicleAdvOffroadCar/);
    await writeProjectFile(w.projectDir, JSON.stringify(TEMPLATE));
    assert.match(String(await w.call(LoopToolName.CheckPart, { part: "Lantern" })), /^Lantern passes/);
    const found = (await w.call(LoopToolName.FindNodes, { query: "offroad reversing" })) as {
      nodes: Array<{ typeId: string }>;
    };
    assert.deepEqual(
      found.nodes.map((n) => n.typeId),
      ["Class|BPVehicleAdvOffroadCar|GetIsReversing", "Class|BPVehicleAdvOffroadCar|SetIsReversing"],
      "builders can look the template's nodes up too",
    );
  });

  it("check-part reads no template Blueprints from a project file that is a link, too large, not JSON or badly named", async () => {
    const w = await world();
    await storeReference(w.storage, "5.8", SMALL_REFERENCE);
    await writeFile(path.join(w.part, "BP_Lantern.dsl"), DRIVES_THE_CAR);
    const elsewhere = path.join(w.root, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify(TEMPLATE));
    const renamed = (name: string) =>
      JSON.stringify({ ...TEMPLATE, blueprints: [{ ...TEMPLATE.blueprints[0], name }] });
    const cases: Record<string, () => Promise<void>> = {
      "a link to a real project file": () => writeProjectFile(w.projectDir, elsewhere, true),
      "too large": () => writeProjectFile(w.projectDir, JSON.stringify({ ...TEMPLATE, pad: "x".repeat(5_000_000) })),
      "not JSON": () => writeProjectFile(w.projectDir, "{ blueprints: ["),
      "a list": () => writeProjectFile(w.projectDir, JSON.stringify([TEMPLATE])),
      "a name that is a path": () => writeProjectFile(w.projectDir, renamed("../BP_VehicleAdvOffroadCar")),
      "a name with text after it": () =>
        writeProjectFile(w.projectDir, renamed("BP_VehicleAdvOffroadCar (event EventTick)")),
      "its folder a link to one holding a real project file": async () => {
        const away = path.join(w.root, "away");
        await mkdir(away, { recursive: true });
        await writeFile(path.join(away, "project.json"), JSON.stringify(TEMPLATE));
        await rm(path.join(w.projectDir, "Saved", "Genex"), { recursive: true, force: true });
        await symlink(away, path.join(w.projectDir, "Saved", "Genex"));
      },
    };
    for (const [label, write] of Object.entries(cases)) {
      await write();
      assert.match(
        String(await w.call(LoopToolName.CheckPart, { part: "Lantern" })),
        /CastToBP_VehicleAdvOffroadCar/,
        label,
      );
    }
  });

  it("export-reference reports the editor's refusal and keeps nothing, even with an old export lying there", async () => {
    const w = await world();
    const old = path.join(w.projectDir, "Saved", "Genex", "reference.json");
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, JSON.stringify({ version: 1, engine: "5.8.3", common: ["Old|Node"], contexts: {}, pins: {} }));
    w.refuse.export = "The file must be inside the project's Saved/Genex folder.";
    await assert.rejects(w.call(LoopToolName.ExportReference), /must be inside the project's Saved\/Genex/);
    assert.equal(await loadReference(w.storage, "5.8"), null);
  });

  /** Epic's EditorToolset files as an installed engine holds them. */
  async function epicGuide(engineDir: string) {
    const python = path.join(
      engineDir,
      "Engine/Plugins/Experimental/Toolsets/EditorToolset/Content/Python/editor_toolset",
    );
    await mkdir(path.join(python, "skills"), { recursive: true });
    await mkdir(path.join(python, "toolsets"), { recursive: true });
    await writeFile(
      path.join(python, "skills", "blueprint_basics.py"),
      'import unreal\n\n_INSTRUCTIONS = """\\\nWRITING GRAPHS\n- Never guess node type IDs.\n"""\n',
    );
    await writeFile(
      path.join(python, "toolsets", "blueprint_dsl.py"),
      'X = 1\nUSAGE = """\\\nGRAMMAR OVERVIEW\n    (event EventName stmt ...)\n"""\n',
    );
    return python;
  }

  it("blueprint-guide hands builders Epic's own Blueprint guide and text syntax from the installed engine", async () => {
    const w = await world();
    await epicGuide(w.engineDir);
    const guide = String(await w.call(LoopToolName.BlueprintGuide));
    assert.match(guide, /Never guess node type IDs/);
    assert.match(guide, /GRAMMAR OVERVIEW/);
    assert.match(guide, /\(event EventName stmt \.\.\.\)/);
    assert.deepEqual(w.calls, [], "no editor needed");
  });

  it("blueprint-guide refuses a guide file that is a link out of the engine", async () => {
    const w = await world();
    const python = await epicGuide(w.engineDir);
    const outside = path.join(w.root, "outside.py");
    await writeFile(outside, 'USAGE = """\\\nSECRET\n"""\n');
    const dsl = path.join(python, "toolsets", "blueprint_dsl.py");
    await writeFile(dsl, "");
    const { rm } = await import("node:fs/promises");
    await rm(dsl);
    await symlink(outside, dsl);
    await assert.rejects(w.call(LoopToolName.BlueprintGuide), (error: Error) => !/SECRET/.test(error.message));
  });

  it("find-nodes looks node types up in the engine's reference, with their pins when known", async () => {
    const w = await world();
    await assert.rejects(w.call(LoopToolName.FindNodes, { query: "light" }), /reference/);
    await storeReference(w.storage, "5.8", {
      version: 1,
      engine: "5.8.3",
      common: ["Development|PrintString", "Rendering|Components|Light|SetIntensity", "Math|Float|Add"],
      contexts: { "Actor/EventGraph": ["Rendering|Components|Light|SetIntensity", "Game|GetPlayerPawn"] },
      pins: {
        "Rendering|Components|Light|SetIntensity": {
          inputs: [
            ["Exec", "Exec"],
            ["NewIntensity", "float"],
          ],
          outputs: [["Then", "Exec"]],
        },
      },
    });
    const found = (await w.call(LoopToolName.FindNodes, {
      query: "light intensity",
      base: "Actor",
      graph: "EventGraph",
    })) as {
      nodes: Array<{ typeId: string; pins?: unknown }>;
    };
    assert.deepEqual(
      found.nodes.map((n) => [n.typeId, Boolean(n.pins)]),
      [["Rendering|Components|Light|SetIntensity", true]],
    );
    const all = (await w.call(LoopToolName.FindNodes, { query: "print" })) as { nodes: Array<{ typeId: string }> };
    assert.deepEqual(
      all.nodes.map((n) => n.typeId),
      ["Development|PrintString"],
    );
    await assert.rejects(w.call(LoopToolName.FindNodes, { query: "" }), /query/);
  });
});

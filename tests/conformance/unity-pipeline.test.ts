import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import {
  editorStatus,
  listCommands,
  PipelineProblem,
  readDescriptor,
  runCommand,
} from "../../src/plugins/unity/pipeline.ts";
import { tmpDir } from "../helpers/tmp.ts";
import {
  droppedConnection,
  editor,
  json,
  openProject,
  refusedConnection,
  STAND_IN,
  writeDescriptor,
} from "../helpers/unity-editor-stand-in.ts";

const { pid: PID, port: PORT, token: TOKEN } = STAND_IN;

describe("the descriptor of an editor's Pipeline server", () => {
  it("names the port, the token and the editor's process", async () => {
    const root = await openProject();
    assert.deepEqual(await readDescriptor(root), { pid: PID, port: PORT, token: TOKEN });
    await writeDescriptor(root, { pid: PID, port: PORT, evalToken: TOKEN, unityVersion: "6000.6.0f1", mode: "editor" });
    assert.deepEqual(await readDescriptor(root), { pid: PID, port: PORT, token: TOKEN, unityVersion: "6000.6.0f1" });
  });

  it("is not believed unless it is a plain file of the project naming a usable port and token", async () => {
    const outside = await openProject();
    const unbelieved: Array<[string, (root: string) => Promise<unknown>]> = [
      ["no descriptor", async () => {}],
      [
        "a Library folder that is a link out of the project",
        (root) => symlink(path.join(outside, "Library"), path.join(root, "Library")),
      ],
      [
        "a descriptor that is a link out of the project",
        async (root) => {
          await mkdir(path.join(root, "Library", "Pipeline"), { recursive: true });
          await symlink(
            path.join(outside, "Library", "Pipeline", ".unity-pipeline-port"),
            path.join(root, "Library", "Pipeline", ".unity-pipeline-port"),
          );
        },
      ],
      [
        "a descriptor that is a folder",
        (root) => mkdir(path.join(root, "Library", "Pipeline", ".unity-pipeline-port"), { recursive: true }),
      ],
      ["text that is not JSON", (root) => writeDescriptor(root, "{ nope")],
      ["a list", (root) => writeDescriptor(root, [PID, PORT, TOKEN])],
      ["a port below 1", (root) => writeDescriptor(root, { pid: PID, port: 0, evalToken: TOKEN })],
      ["a port above 65535", (root) => writeDescriptor(root, { pid: PID, port: 70000, evalToken: TOKEN })],
      ["a port that is no whole number", (root) => writeDescriptor(root, { pid: PID, port: 80.5, evalToken: TOKEN })],
      ["a port as text", (root) => writeDescriptor(root, { pid: PID, port: "7811", evalToken: TOKEN })],
      ["no token", (root) => writeDescriptor(root, { pid: PID, port: PORT })],
      [
        "a token with a line break",
        (root) => writeDescriptor(root, { pid: PID, port: PORT, evalToken: "a\r\nx-evil: 1" }),
      ],
      ["a token with a space", (root) => writeDescriptor(root, { pid: PID, port: PORT, evalToken: "a b" })],
      [
        "a token past 512 characters",
        (root) => writeDescriptor(root, { pid: PID, port: PORT, evalToken: "t".repeat(513) }),
      ],
      ["no process id", (root) => writeDescriptor(root, { port: PORT, evalToken: TOKEN })],
      [
        "a descriptor past 16 KiB",
        (root) => writeDescriptor(root, { pid: PID, port: PORT, evalToken: TOKEN, pad: "x".repeat(17_000) }),
      ],
    ];
    for (const [what, arrange] of unbelieved) {
      const root = await realpath(await tmpDir("unity-pipeline-"));
      await arrange(root);
      assert.equal(await readDescriptor(root), undefined, what);
    }
  });
});

describe("a call to the editor's Pipeline server", () => {
  it("lists the editor's commands from this computer's own address, with the descriptor's token", async () => {
    const root = await openProject();
    const { deps, seen } = editor([
      json(200, {
        commands: [
          {
            name: "editor_play",
            description: "Enter Play mode",
            tags: ["editor/playmode", 7],
            mainThreadRequired: true,
            parameters: [
              {
                name: "wait",
                description: "Wait until playing.",
                type: "Boolean",
                required: false,
                defaultValue: null,
              },
              { name: "scene", type: "ObjectRef", required: true },
              { description: "a parameter with no name" },
              "not a parameter",
            ],
          },
          { name: "capture_game_view", summary: "Capture the Game view" },
          { name: "no_words" },
          { description: "no name" },
          "bare_name",
          { name: "Not A Name", description: "x" },
          { name: "Editor_Play", description: "a name run_command would refuse" },
        ],
      }),
    ]);
    assert.deepEqual(await listCommands(root, deps), {
      ok: true,
      result: [
        {
          name: "editor_play",
          description: "Enter Play mode",
          tags: ["editor/playmode"],
          parameters: [
            { name: "wait", type: "Boolean", required: false, description: "Wait until playing." },
            { name: "scene", type: "ObjectRef", required: true, description: "" },
          ],
        },
        { name: "capture_game_view", description: "Capture the Game view", tags: [], parameters: [] },
        { name: "no_words", description: "", tags: [], parameters: [] },
        { name: "bare_name", description: "", tags: [], parameters: [] },
      ],
    });
    assert.deepEqual(seen, [
      {
        url: `http://127.0.0.1:${PORT}/api/commands`,
        method: "GET",
        token: `Bearer ${TOKEN}`,
        body: undefined,
        redirect: "error",
      },
    ]);
  });

  it("reads a catalogue answered as a bare list too", async () => {
    const root = await openProject();
    const { deps } = editor([json(200, [{ name: "editor_stop", description: "Leave Play mode" }])]);
    assert.deepEqual(await listCommands(root, deps), {
      ok: true,
      result: [{ name: "editor_stop", description: "Leave Play mode", tags: [], parameters: [] }],
    });
  });

  it("runs a command and answers its result", async () => {
    const root = await openProject();
    const { deps, seen } = editor([json(200, { ok: true, result: { playing: true } })]);
    assert.deepEqual(await runCommand(root, { command: "editor_play", parameters: { wait: true } }, deps), {
      ok: true,
      result: { playing: true },
    });
    assert.deepEqual(seen, [
      {
        url: `http://127.0.0.1:${PORT}/api/exec`,
        method: "POST",
        token: `Bearer ${TOKEN}`,
        body: { command: "editor_play", parameters: { wait: true } },
        redirect: "error",
      },
    ]);
  });

  it("says the project is not open, asking nobody, with no descriptor or one whose editor is gone", async () => {
    const closed = await realpath(await tmpDir("unity-pipeline-"));
    const none = editor([]);
    assert.deepEqual(await runCommand(closed, { command: "editor_play", parameters: {} }, none.deps), {
      ok: false,
      problem: PipelineProblem.NotOpen,
    });
    const gone = editor([], { alive: false });
    assert.deepEqual(await listCommands(await openProject(), gone.deps), {
      ok: false,
      problem: PipelineProblem.NotOpen,
    });
    assert.deepEqual([none.seen, gone.seen], [[], []]);
  });

  it("waits out an editor that is busy or reloading, then goes on", async () => {
    const root = await openProject();
    const { deps, seen, sleeps } = editor([
      json(503, { busyReason: "compiling" }),
      refusedConnection(),
      json(200, { ok: true, result: "done" }),
    ]);
    assert.deepEqual(await runCommand(root, { command: "editor_play", parameters: {} }, deps), {
      ok: true,
      result: "done",
    });
    assert.equal(seen.length, 3);
    assert.deepEqual(sleeps, [250, 500]);
  });

  it("answers what keeps the editor busy once its wait runs out", async () => {
    const root = await openProject();
    const busy = editor(Array.from({ length: 40 }, () => json(503, { busyReason: "blocked_by_dialog" })));
    assert.deepEqual(await runCommand(root, { command: "editor_play", parameters: {} }, busy.deps, { waitMs: 5000 }), {
      ok: false,
      problem: PipelineProblem.Busy,
      detail: "blocked_by_dialog",
    });
    assert.ok(busy.sleeps.reduce((sum, ms) => sum + ms, 0) <= 5000, "never waits past its budget");

    const silent = editor(Array.from({ length: 40 }, refusedConnection));
    assert.deepEqual(await listCommands(root, silent.deps, { waitMs: 5000 }), {
      ok: false,
      problem: PipelineProblem.NotAnswering,
    });
  });

  it("never sends a command twice: a call that got no answer says it may have run", async () => {
    const root = await openProject();
    const { deps, seen, sleeps } = editor([droppedConnection()]);
    assert.deepEqual(await runCommand(root, { command: "delete_object", parameters: { id: 7 } }, deps), {
      ok: false,
      problem: PipelineProblem.Unknown,
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(sleeps, []);

    const reading = editor([droppedConnection(), json(200, { commands: [] })]);
    assert.deepEqual(await listCommands(root, reading.deps), { ok: true, result: [] });
  });

  it("reads the descriptor again when the editor refuses the token, and gives up on a second refusal", async () => {
    const root = await openProject();
    const restarted = editor([
      async () => {
        await writeDescriptor(root, { pid: PID, port: PORT + 1, evalToken: "fresh" });
        return json(401, { error: "unauthorized" });
      },
      json(200, { ok: true, result: 1 }),
    ]);
    assert.deepEqual(await runCommand(root, { command: "editor_play", parameters: {} }, restarted.deps), {
      ok: true,
      result: 1,
    });
    assert.deepEqual(
      restarted.seen.map((s) => [s.url, s.token]),
      [
        [`http://127.0.0.1:${PORT}/api/exec`, `Bearer ${TOKEN}`],
        [`http://127.0.0.1:${PORT + 1}/api/exec`, "Bearer fresh"],
      ],
    );

    const refused = editor([json(401, {}), json(401, {})]);
    assert.deepEqual(await runCommand(root, { command: "editor_play", parameters: {} }, refused.deps), {
      ok: false,
      problem: PipelineProblem.Refused,
    });
    assert.equal(refused.seen.length, 2);
  });

  it("answers a command's own failure in the editor's words", async () => {
    const root = await openProject();
    const failed = editor([
      json(200, { ok: false, error: "Parameter Validation Failed", errorDetails: "No camera found to capture." }),
      new Response("Internal Server Error", { status: 500 }),
      json(400, { error: "x".repeat(2000) }),
    ]);
    const call = { command: "capture_game_view", parameters: {} };
    assert.deepEqual(await runCommand(root, call, failed.deps), {
      ok: false,
      problem: PipelineProblem.Failed,
      detail: "Parameter Validation Failed: No camera found to capture.",
    });
    assert.deepEqual(await runCommand(root, call, failed.deps), {
      ok: false,
      problem: PipelineProblem.Failed,
      detail: "Internal Server Error",
    });
    const long = await runCommand(root, call, failed.deps);
    assert.equal(!long.ok && long.detail?.length, 600);
  });

  it("reads success and failure as Pipeline 0.8 spells them", async () => {
    const root = await openProject();
    const answers = editor([
      json(200, { success: true, result: { playing: true } }),
      json(400, { success: false, error: "Invalid Request", errorDetails: "Unknown command: fly" }),
      json(200, { success: false, error: "Not in Play mode" }),
    ]);
    const call = { command: "editor_play", parameters: {} };
    assert.deepEqual(await runCommand(root, call, answers.deps), { ok: true, result: { playing: true } });
    assert.deepEqual(await runCommand(root, call, answers.deps), {
      ok: false,
      problem: PipelineProblem.Failed,
      detail: "Invalid Request: Unknown command: fly",
    });
    assert.deepEqual(await runCommand(root, call, answers.deps), {
      ok: false,
      problem: PipelineProblem.Failed,
      detail: "Not in Play mode",
    });
  });

  it("reads where the editor's main thread stands", async () => {
    const root = await openProject();
    const { deps, seen } = editor([
      json(200, {
        status: "playing",
        compiling: true,
        domainReloadInProgress: false,
        playMode: "playing",
        projectPath: root,
      }),
      json(200, { status: "ready" }),
    ]);
    assert.deepEqual(await editorStatus(root, deps), {
      ok: true,
      result: { playMode: "playing", compiling: true, reloading: false },
    });
    assert.deepEqual([seen[0]?.method, seen[0]?.url], ["GET", `http://127.0.0.1:${PORT}/api/editor_status`]);
    assert.deepEqual(await editorStatus(root, deps), {
      ok: true,
      result: { playMode: "", compiling: false, reloading: false },
    });
  });

  it("says the main thread is stalled when it answers a look with nothing in its time, asking once", async () => {
    const root = await openProject();
    const { deps, seen, sleeps } = editor([new Error("The operation was aborted due to timeout")]);
    const timedOut = { ...deps, timeout: () => AbortSignal.abort() };
    assert.deepEqual(await editorStatus(root, timedOut), { ok: false, problem: PipelineProblem.Stalled });
    assert.deepEqual([seen.length, sleeps], [1, []]);
    assert.deepEqual(await editorStatus(await realpath(await tmpDir("unity-pipeline-")), deps), {
      ok: false,
      problem: PipelineProblem.NotOpen,
    });
  });

  it("reads a command the editor's main thread never ran as stalled, not as the command's failure", async () => {
    const root = await openProject();
    const { deps } = editor([
      json(400, {
        success: false,
        error: "Internal Server Error",
        errorDetails: "Main thread operation timed out after 60000ms",
      }),
    ]);
    assert.deepEqual(await runCommand(root, { command: "save_all", parameters: {} }, deps), {
      ok: false,
      problem: PipelineProblem.Stalled,
    });
  });

  it("ends with the stop's own reason when the call is stopped, sending nothing more", async () => {
    const root = await openProject();
    const stop = new AbortController();
    const { deps, seen } = editor([
      () => {
        stop.abort(new Error("stopped by the person"));
        return refusedConnection();
      },
    ]);
    await assert.rejects(
      runCommand(root, { command: "editor_play", parameters: {} }, deps, { signal: stop.signal }),
      /stopped by the person/,
    );
    assert.equal(seen.length, 1);
  });
});

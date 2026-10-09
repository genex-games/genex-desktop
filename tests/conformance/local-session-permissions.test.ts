/**
 * A Bonsai chat session the person answers follows the chat's permission mode: the studio runs its
 * tools, so it asks before each change the mode asks about (Manual: every edit and command; Accept
 * edits: every command; Auto: none), Plan offers and runs no change at all, a denied call never runs,
 * and the picker switches a running session (local-session-permissions.ts). Unattended work never asks.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { BONSAI_MODELS } from "../../src/substrate/bonsai/manifest.ts";
import { LocalSessions } from "../../src/substrate/engines/local-session.ts";
import { deniedWithWords, LOCAL_NOTE, modeChangedNote } from "../../src/substrate/engines/local-session-prompts.ts";
import type { PermissionMode } from "../../src/shared/permissions.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  type DelegateEvent,
  DelegateEventType,
  type DelegatePermissions,
  type DelegateRequest,
  type PermissionAsk,
  type PermissionControl,
  type PermissionReply,
} from "../../src/substrate/engines/types.ts";

const model = BONSAI_MODELS[0].id;
type Step = { name: string; arguments: unknown };

const reply = (content: string, calls?: Array<Step & { id: string }>): CompleteResponse => ({
  engine: "bonsai",
  model,
  usage: {},
  stopReason: calls ? "tool_calls" : "stop",
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

const WRITE: Step = { name: "write_file", arguments: { path: "jump.js", content: "export const jump = 1;" } };
const EDIT: Step = { name: "edit_file", arguments: { path: "jump.js", oldText: "1", newText: "2" } };
const COMMAND: Step = { name: "run_command", arguments: { command: "echo ran > ran.txt" } };

describe("a Bonsai chat session in the chat's mode", () => {
  let root: string;
  let cwd: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bonsai-perm-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Run one session whose model calls `steps`, one per round, then replies "Done". The person answers
   * each question with the next of `replies`; `onRound` runs before each completion.
   */
  async function session(
    mode: PermissionMode | null,
    steps: Step[],
    replies: PermissionReply[] = [],
    onRound: (round: number, control: PermissionControl | null) => void = () => {},
    engine?: "openrouter",
  ) {
    cwd = await mkdtemp(path.join(root, "game-"));
    await mkdir(cwd, { recursive: true });
    const asked: PermissionAsk[] = [];
    const answers: string[] = [];
    const requests: CompleteRequest[] = [];
    const controls: Array<PermissionControl | null> = [];
    let round = 0;
    const events: DelegateEvent[] = [];
    const sessions = new LocalSessions({
      ...(engine ? { engine } : {}),
      root: path.join(root, "sessions"),
      scratchRoot: path.join(root, "scratch"),
      protectedPaths: [path.join(root, "sessions")],
      contextWindow: 16384,
      complete: async (request) => {
        requests.push(request);
        const last = request.messages.findLast((message) => message.role === "tool");
        if (round > 0 && last) answers.push(last.content);
        onRound(round, controls.at(-1) ?? null);
        const step = steps[round++];
        return step ? reply("", [{ id: `c${round}`, ...step }]) : reply("Done");
      },
    });
    const permissions: DelegatePermissions | undefined =
      mode === null
        ? undefined
        : {
            mode,
            allow: [],
            directories: [],
            protectWrites: [],
            ask: async (ask) => {
              asked.push(ask);
              const answer = replies.shift();
              assert.ok(answer, `no answer was expected for ${ask.tool}`);
              return answer;
            },
            onControl: (control) => {
              controls.push(control);
            },
          };
    const request: DelegateRequest = {
      cwd,
      prompt: "Make it jump",
      onEvent: (event) => events.push(event),
      ...(permissions ? { permissions } : {}),
    };
    const result = await sessions.run(request, model);
    return { result, asked, answers, requests, controls, events };
  }

  const exists = (file: string) =>
    readFile(path.join(cwd, file), "utf8").then(
      () => true,
      () => false,
    );

  it("asks before every edit and command in Manual, and a denied one never runs", async () => {
    const run = await session(
      "default",
      [WRITE, COMMAND],
      [{ decision: "deny", message: "Not yet" }, { decision: "allow" }],
    );
    assert.equal(run.result.ok, true);
    assert.deepEqual(
      run.asked.map((ask) => [ask.tool, ask.title]),
      [
        ["Write", "Bonsai wants to write jump.js"],
        ["Bash", "Bonsai wants to run a command"],
      ],
    );
    // The session works in the game folder's real path (macOS's /var is /private/var).
    const file = path.join(await realpath(cwd), "jump.js");
    assert.deepEqual(run.asked[0]!.input, { file_path: file, content: "export const jump = 1;" });
    assert.deepEqual(run.asked[1]!.input, { command: "echo ran > ran.txt" });
    assert.equal(run.answers[0], deniedWithWords("Not yet"));
    assert.equal(await exists("jump.js"), false, "the denied write did not happen");
    assert.equal(await exists("ran.txt"), true, "the allowed command ran");
  });

  it("asks, reports and accounts in the name of the engine whose session it is", async () => {
    const run = await session("default", [WRITE], [{ decision: "deny" }], () => {}, "openrouter");
    assert.deepEqual(
      run.asked.map((ask) => ask.title),
      ["OpenRouter wants to write jump.js"],
    );
    assert.equal(run.result.engine, "openrouter");
    const engines = new Set(
      run.events.flatMap((event) =>
        event.type === DelegateEventType.Activity ? [(event.payload as { engine: string }).engine] : [],
      ),
    );
    assert.deepEqual([...engines], ["openrouter"], "no activity reads as Bonsai's");
  });

  it("asks only before commands in Accept edits", async () => {
    const run = await session("acceptEdits", [WRITE, EDIT, COMMAND], [{ decision: "deny" }]);
    assert.deepEqual(
      run.asked.map((ask) => ask.tool),
      ["Bash"],
    );
    assert.equal(await readFile(path.join(cwd, "jump.js"), "utf8"), "export const jump = 2;");
    assert.equal(run.answers[2], LOCAL_NOTE.denied);
    assert.equal(await exists("ran.txt"), false, "the denied command did not run");
  });

  it("offers and runs no change in Plan, and is told it plans", async () => {
    const run = await session("plan", [WRITE, COMMAND]);
    const offered = (run.requests[0]!.tools ?? []).map((tool) => tool.name);
    assert.deepEqual(offered.sort(), ["list_files", "read_file"]);
    assert.match(run.requests[0]!.systemPrompt ?? "", /PLAN MODE/);
    assert.deepEqual(run.answers, [LOCAL_NOTE.planModeRefused, LOCAL_NOTE.planModeRefused]);
    assert.equal(run.asked.length, 0, "nothing to ask: nothing changes before the plan is approved");
    assert.equal(await exists("jump.js"), false);
    assert.equal(await exists("ran.txt"), false);
  });

  it("asks nothing in Auto, in Bypass (which runs as Auto), or for unattended work", async () => {
    for (const mode of ["auto", "bypassPermissions", null] as const) {
      const run = await session(mode, [WRITE]);
      assert.equal(run.asked.length, 0, String(mode));
      assert.equal(await exists("jump.js"), true, String(mode));
      if (mode !== null) assert.doesNotMatch(run.requests[0]!.systemPrompt ?? "", /PLAN MODE/);
    }
  });

  it("reads the host's own words when the work ended around its question", async () => {
    const withdrawn = "The user stopped this work before answering.";
    const run = await session("default", [WRITE], [{ decision: "deny", withdrawn: true, message: withdrawn }]);
    assert.equal(run.answers[0], withdrawn);
  });

  it("takes the picker's switch while it runs: the next call is decided in the new mode", async () => {
    const run = await session("auto", [WRITE, EDIT], [{ decision: "allow" }], (round, control) => {
      if (round === 1) void control?.setMode("default");
    });
    assert.deepEqual(
      run.asked.map((ask) => ask.tool),
      ["Edit"],
      "the write before the switch ran unasked",
    );
    const told = run.requests[2]!.messages.some((message) => message.content === modeChangedNote("default"));
    assert.ok(told, "the model reads of the switch at its next round");
    assert.equal(run.controls.at(-1), null, "the picker's reach ends with the session");
    // Bypass is no mode Bonsai has: a switch to it runs as Auto.
    const bypass = await session("default", [WRITE, EDIT], [{ decision: "allow" }], (round, control) => {
      if (round === 1) void control?.setMode("bypassPermissions");
    });
    assert.equal(bypass.asked.length, 1, "asked before the switch only");
  });
});

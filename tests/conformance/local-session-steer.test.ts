/**
 * Steer on a local session (`DelegateRequest.steer`): Genex runs a Bonsai, OpenRouter or local
 * server session's loop itself, so a message the person sends while it works waits in the run's
 * inbox and is read at the top of the next round — in order, each reported read
 * (`steer_delivered`) and listed in the result's `steered` — without cutting anything. A message
 * that arrives while the final answer is written gets one more round; one the run can no longer
 * read is refused, or, when the run ends before reading it, never reported read, so the host
 * queues it again.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { BONSAI_MODELS } from "../../src/substrate/bonsai/manifest.ts";
import { BonsaiEngine } from "../../src/substrate/engines/bonsai.ts";
import { LocalServerEngine } from "../../src/substrate/engines/local-server.ts";
import { LocalSessions } from "../../src/substrate/engines/local-session.ts";
import { OpenRouterEngine } from "../../src/substrate/engines/openrouter.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  type DelegateEvent,
  DelegateEventType,
  type DelegateRequest,
  type LiveToolSpec,
  type SteerSend,
} from "../../src/substrate/engines/types.ts";
import { memoryServerSettings } from "../../src/substrate/local-server/settings.ts";
import { memoryKeyStore } from "../../src/substrate/provider-keys.ts";
import type { Message } from "../../src/substrate/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const model = BONSAI_MODELS[0].id;
const LOOK: LiveToolSpec = { name: "inspect", description: "inspect", parameters: { type: "object", properties: {} } };
/** The events a story is told from. */
const TOLD: ReadonlySet<string> = new Set([
  DelegateEventType.Assistant,
  DelegateEventType.User,
  DelegateEventType.SteerDelivered,
]);

const reply = (content: string, calls?: Array<{ id: string; name: string; arguments: unknown }>): CompleteResponse => ({
  engine: "bonsai",
  model,
  usage: {},
  stopReason: calls ? "tool_calls" : "stop",
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

/** A round that calls the inspect tool once. */
const looks = (id: string) => reply("", [{ id, name: LOOK.name, arguments: {} }]);

/** What one completion was asked, without its callbacks. */
function snapshot(request: CompleteRequest): CompleteRequest {
  return structuredClone({
    ...request,
    signal: undefined,
    onDelta: undefined,
    onContext: undefined,
    onActivity: undefined,
  });
}

/** The session's story as the host mirrors it: assistant turns, tool results, reads. */
const story = (events: DelegateEvent[]) =>
  events
    .filter((e) => TOLD.has(e.type))
    .map((e) => (e.type === DelegateEventType.SteerDelivered ? `read ${e.payload.id}` : e.type));

/**
 * A local session whose model answers each round with the next of `rounds` (each may act first,
 * with the door the session opened); `onLook` runs while the inspect tool runs.
 */
async function steerable(options: {
  rounds: Array<(door: SteerSend | null, request: CompleteRequest) => CompleteResponse>;
  onLook?: (door: SteerSend | null) => void;
  request?: Partial<DelegateRequest>;
  steer?: boolean;
}) {
  const root = await tmpDir("local-steer-");
  const cwd = path.join(root, "game");
  await mkdir(cwd);
  const seen: CompleteRequest[] = [];
  const events: DelegateEvent[] = [];
  const doors: Array<SteerSend | null> = [];
  const door = () => doors[0] ?? null;
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    protectedPaths: [],
    contextWindow: 16384,
    complete: async (request) => {
      const round = options.rounds[seen.length];
      seen.push(snapshot(request));
      assert.ok(round, `no reply scripted for round ${seen.length}`);
      return round(door(), request);
    },
  });
  const request: DelegateRequest = {
    cwd,
    prompt: "Build the menu",
    readOnly: true,
    liveTools: [LOOK],
    onLiveTool: async () => {
      options.onLook?.(door());
      return { text: "observed" };
    },
    onEvent: (e) => events.push(e),
    ...(options.steer === false ? {} : { steer: { ready: (send: SteerSend | null) => doors.push(send) } }),
    ...options.request,
  };
  const result = await sessions.run(request, model);
  const saved = JSON.parse(await readFile(path.join(root, "sessions", `${result.sessionId}.json`), "utf8"));
  return { result, seen, events, doors, door, saved, sessions, cwd, root };
}

const userTexts = (messages: Message[]) => messages.filter((m) => m.role === "user").map((m) => m.content);

describe("steering a running local session", () => {
  it("reads a message sent while a round's tool runs at the top of the next round, in order, and cuts nothing", async () => {
    const taken: boolean[] = [];
    const { result, seen, events, doors, saved } = await steerable({
      rounds: [() => looks("look1"), () => reply("Done")],
      onLook: (door) => {
        taken.push(door!({ id: "m1", text: "make it red" }));
        taken.push(door!({ id: "m2", text: "and the title bigger" }));
      },
    });
    assert.equal(doors.length, 1, "the door is opened exactly once");
    assert.equal(typeof doors[0], "function", "a local session takes input mid-turn");
    assert.deepEqual(taken, [true, true]);
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen[1]!.messages.slice(-3).map((m) => [m.role, m.content]),
      [
        ["tool", "observed"],
        ["user", "make it red"],
        ["user", "and the title bigger"],
      ],
      "the tool's answer stands, and the messages follow it in the order sent",
    );
    assert.deepEqual(story(events), ["assistant", "user", "read m1", "read m2", "assistant"]);
    assert.deepEqual(result.steered, ["m1", "m2"]);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "Done");
    assert.equal(result.turns, 2);
    assert.ok(
      saved.messages.some((m: Message) => m.role === "tool" && m.content === "observed"),
      "the tool's result is saved",
    );
    assert.deepEqual(userTexts(saved.messages).slice(-2), ["make it red", "and the title bigger"]);
    assert.deepEqual(saved.requirements.slice(-2), ["make it red", "and the title bigger"], "a compaction keeps them");
  });

  it("gives a message sent while the final answer is written one more round", async () => {
    let taken: boolean | undefined;
    const { result, seen, events } = await steerable({
      rounds: [
        (door) => {
          taken = door!({ id: "late", text: "one more thing: a pause key" });
          return reply("Done");
        },
        () => reply("Added the pause key"),
      ],
    });
    assert.equal(taken, true);
    assert.equal(seen.length, 2, "the session goes on for the message");
    assert.deepEqual(
      seen[1]!.messages.slice(-2).map((m) => [m.role, m.content]),
      [
        ["assistant", "Done"],
        ["user", "one more thing: a pause key"],
      ],
    );
    assert.deepEqual(story(events), ["assistant", "read late", "assistant"]);
    assert.deepEqual(result.steered, ["late"]);
    assert.equal(result.summary, "Added the pause key");
    assert.equal(result.ok, true);
  });

  it("refuses a message once the run has ended, and reports none read", async () => {
    const { result, events, door } = await steerable({ rounds: [() => reply("Done")] });
    assert.equal(door()!({ id: "after", text: "too late" }), false);
    assert.deepEqual(result.steered, []);
    assert.equal(events.filter((e) => e.type === DelegateEventType.SteerDelivered).length, 0);
  });

  it("never reports a message read that an abort left unread, and refuses one after it", async () => {
    const stop = new AbortController();
    const taken: boolean[] = [];
    const { result, events, door, saved } = await steerable({
      rounds: [() => looks("look1"), () => reply("never")],
      request: { signal: stop.signal },
      onLook: (send) => {
        taken.push(send!({ id: "m1", text: "make it red" }));
        stop.abort();
        taken.push(send!({ id: "m2", text: "and blue" }));
      },
    });
    assert.deepEqual(taken, [true, false], "taken before the stop, refused after it");
    assert.equal(result.ok, false);
    assert.deepEqual(result.steered, [], "the host queues it again");
    assert.equal(events.filter((e) => e.type === DelegateEventType.SteerDelivered).length, 0);
    assert.ok(!userTexts(saved.messages).includes("make it red"), "nothing unread enters the history");
    assert.equal(door()!({ id: "m3", text: "later" }), false);
  });

  it("leaves a message for a turn of its own when the session has no turn left to read it", async () => {
    let taken: boolean | undefined;
    const { result, seen, events } = await steerable({
      rounds: [
        (door) => {
          taken = door!({ id: "late", text: "one more thing" });
          return reply("Done");
        },
      ],
      request: { maxTurns: 1 },
    });
    assert.equal(taken, true);
    assert.equal(seen.length, 1);
    assert.equal(result.ok, true, "the answer stands");
    assert.deepEqual(result.steered, []);
    assert.equal(events.filter((e) => e.type === DelegateEventType.SteerDelivered).length, 0);
  });

  it("carries a message's pictures into the session", async () => {
    const still = { label: "the menu I want", mimeType: "image/png", data: "PICTURE" };
    const { seen, result } = await steerable({
      rounds: [() => looks("look1"), () => reply("Done")],
      onLook: (door) => {
        door!({ id: "pic", text: "like this", images: [still, { label: "empty", mimeType: "image/png", data: "" }] });
      },
    });
    const read = seen[1]!.messages.at(-1)!;
    assert.equal(read.role, "user");
    assert.equal(read.content, "like this");
    assert.deepEqual(read.images, [still], "a picture with no pixels is dropped");
    assert.deepEqual(result.steered, ["pic"]);
  });

  it("takes nothing mid-turn in an interview: its question or launch would already have decided", async () => {
    const { doors, result } = await steerable({
      rounds: [() => reply("Done")],
      request: {
        interviewTools: [
          { name: "launch_build", description: "launch", parameters: { type: "object", properties: {} } },
        ],
      },
    });
    assert.deepEqual(doors, [null]);
    assert.deepEqual(result.steered, []);
  });

  it("tells the host no when the session cannot start", async () => {
    const doors: Array<SteerSend | null> = [];
    const root = await tmpDir("local-steer-");
    const sessions = new LocalSessions({
      root: path.join(root, "sessions"),
      protectedPaths: [],
      contextWindow: 16384,
      complete: async () => reply("Done"),
    });
    await assert.rejects(
      sessions.run(
        { cwd: root, prompt: "x", resume: "not-a-session", steer: { ready: (send) => doors.push(send) } },
        model,
      ),
    );
    assert.deepEqual(doors, [null]);
  });

  it("resumes a saved session without steering exactly as before", async () => {
    const root = await tmpDir("local-steer-");
    const cwd = path.join(root, "game");
    await mkdir(cwd);
    await mkdir(path.join(root, "sessions"));
    const id = "00000000-0000-4000-8000-000000000001";
    const history: Message[] = [
      { role: "user", content: "Build the menu" },
      { role: "assistant", content: "Built it" },
    ];
    const file = path.join(root, "sessions", `${id}.json`);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        cwd: await realpath(cwd),
        model,
        messages: history,
        requirements: ["Build the menu"],
      }),
    );
    const seen: CompleteRequest[] = [];
    const sessions = new LocalSessions({
      root: path.join(root, "sessions"),
      protectedPaths: [],
      contextWindow: 16384,
      complete: async (request) => {
        seen.push(snapshot(request));
        return reply("Now the HUD is in");
      },
    });
    const result = await sessions.run({ cwd, prompt: "Now the HUD", resume: id }, model);
    assert.equal("steered" in result, false, "a run with no steer lists nothing");
    assert.equal(seen.length, 1);
    assert.deepEqual(
      seen[0]!.messages.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.match(seen[0]!.messages.at(-1)!.content, /^Now the HUD\n\n/);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["cwd", "messages", "model", "requirements", "version"]);
    assert.deepEqual(saved.requirements, ["Build the menu", "Now the HUD"]);
    assert.deepEqual(
      saved.messages.map((m: Message) => m.content),
      ["Build the menu", "Built it", seen[0]!.messages.at(-1)!.content, "Now the HUD is in"],
    );
  });

  it("an open door with nothing sent leaves the session's history as it would be without one", async () => {
    const plain = await steerable({ rounds: [() => looks("look1"), () => reply("Done")], steer: false });
    const steered = await steerable({ rounds: [() => looks("look1"), () => reply("Done")] });
    const shape = (requests: CompleteRequest[]) => requests.map((r) => r.messages.map((m) => [m.role, m.content]));
    assert.deepEqual(shape(steered.seen), shape(plain.seen));
    assert.equal("steered" in plain.result, false);
    assert.deepEqual(steered.result.steered, []);
  });
});

describe("the engines whose sessions Genex runs", () => {
  it("take the person's messages mid-turn", async () => {
    const root = await tmpDir("local-steer-engines-");
    const engines = [
      new BonsaiEngine({ root: path.join(root, "bonsai") }),
      new OpenRouterEngine({ root: path.join(root, "openrouter"), keys: memoryKeyStore("sk-or-test") }),
      new LocalServerEngine({
        root: path.join(root, "local-server"),
        settings: memoryServerSettings(),
        keys: memoryKeyStore(),
      }),
    ];
    for (const engine of engines) assert.equal(engine.steersMidTurn, true, engine.id);
  });
});

/**
 * The Play Protocol client over a scripted pipe pair: the handshake, id correlation, deadlines and
 * every hostile thing an engine's stdout can carry. Each row asserts the studio does not crash
 * and fails the right call with the right typed code — and nothing else.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { PlayErrorCode, PlayFailure, PlayOp } from "../../src/shared/play-protocol.ts";
import {
  MAX_PLAY_LINE_CHARS,
  type PlayDeadlines,
  PlayProtocolError,
  openPlayClient,
} from "../../src/substrate/play-protocol-client.ts";

/** Deadlines that fire only when the test moves time. */
function manualDeadlines(): PlayDeadlines & { advance(ms: number): void; pending(): number } {
  let now = 0;
  const timers = new Set<{ at: number; fire: () => void }>();
  return {
    after(ms, fire) {
      const timer = { at: now + ms, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.fire();
      }
    },
    pending: () => timers.size,
  };
}

/** A scripted engine: what the client writes is read back as requests; what the test says is its stdout. */
function fakeEngine() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  let buffered = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) requests.push(JSON.parse(line));
  });
  let exit: (value: { code: number | null; signal: string | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    exit = resolve;
  });
  const logs: string[] = [];
  return {
    streams: { readable: stdout, writable: stdin, exited },
    requests,
    logs,
    say: (line: string) => stdout.write(`${line}\n`),
    reply: (body: Record<string, unknown>) => stdout.write(`${JSON.stringify(body)}\n`),
    exit: (code: number | null = 1) => exit({ code, signal: null }),
  };
}

/** Let queued stream and promise callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The latest request's id, once the client has written it. */
async function lastId(engine: ReturnType<typeof fakeEngine>): Promise<number> {
  await settle();
  const last = engine.requests.at(-1);
  assert.ok(last, "the client wrote a request");
  return Number(last.id);
}

async function readyClient(engine = fakeEngine(), deadlines = manualDeadlines()) {
  const opening = openPlayClient(engine.streams, { deadlines, log: (line) => engine.logs.push(line) });
  engine.say(JSON.stringify({ event: "ready", protocol: 3 }));
  return { client: await opening, engine, deadlines };
}

/** The typed failure a promise rejected with. */
async function failure(promise: Promise<unknown>): Promise<PlayProtocolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlayProtocolError, `a PlayProtocolError, got ${String(error)}`);
    return error;
  }
  assert.fail("the call settled instead of failing");
}

describe("play protocol client — handshake", () => {
  it("opens on the ready line and keeps what it said", async () => {
    const { client } = await readyClient();
    assert.deepEqual(client.ready, { event: "ready", protocol: 3 });
  });

  const handshakes: Array<{
    name: string;
    script: (engine: ReturnType<typeof fakeEngine>, clock: ReturnType<typeof manualDeadlines>) => void;
    code: string;
  }> = [
    {
      name: "a process that never says ready",
      script: (_engine, clock) => clock.advance(60_000),
      code: PlayFailure.NotReady,
    },
    {
      name: "a fatal line instead of ready",
      script: (engine) => engine.say(JSON.stringify({ event: "fatal", error: "no GPU" })),
      code: PlayFailure.Fatal,
    },
    { name: "a process that exits before ready", script: (engine) => engine.exit(3), code: PlayFailure.Exited },
    {
      name: "garbage, then silence",
      script: (engine, clock) => {
        engine.say("{not json");
        engine.say("42");
        engine.say(JSON.stringify({ id: 1, ok: true }));
        clock.advance(60_000);
      },
      code: PlayFailure.NotReady,
    },
  ];
  for (const row of handshakes) {
    it(`refuses ${row.name} with ${row.code}`, async () => {
      const engine = fakeEngine();
      const clock = manualDeadlines();
      const opening = openPlayClient(engine.streams, { deadlines: clock, log: (line) => engine.logs.push(line) });
      row.script(engine, clock);
      const error = await failure(opening);
      assert.equal(error.code, row.code);
      assert.equal(clock.pending(), 0, "no deadline is left behind");
    });
  }

  it("names the engine's own reason when it says fatal", async () => {
    const engine = fakeEngine();
    const opening = openPlayClient(engine.streams, { deadlines: manualDeadlines() });
    engine.say(JSON.stringify({ event: "fatal", error: "no GPU adapter" }));
    assert.match((await failure(opening)).message, /no GPU adapter/);
  });

  it("opens after malformed lines that come before ready", async () => {
    const engine = fakeEngine();
    const opening = openPlayClient(engine.streams, { deadlines: manualDeadlines(), log: (l) => engine.logs.push(l) });
    engine.say("{oops");
    engine.say("[1,2]");
    engine.say(JSON.stringify({ event: "ready", protocol: 3 }));
    const client = await opening;
    assert.equal(client.ready.protocol, 3);
    assert.ok(engine.logs.length >= 1, "the dropped lines are logged");
  });
});

describe("play protocol client — calls", () => {
  it("correlates replies by id, whatever order they come in", async () => {
    const { client, engine } = await readyClient();
    const first = client.call(PlayOp.State, {});
    const firstId = await lastId(engine);
    const second = client.call(PlayOp.Step, { ms: 100 });
    const secondId = await lastId(engine);
    assert.notEqual(firstId, secondId);
    assert.deepEqual(engine.requests[1], { id: secondId, op: "step", ms: 100 });
    engine.reply({ id: secondId, ok: true, op: "step", result: { simulatedMs: 96 } });
    engine.reply({ id: firstId, ok: true, op: "state", result: { tick: 7 } });
    assert.deepEqual(await second, { simulatedMs: 96 });
    assert.deepEqual(await first, { tick: 7 });
  });

  it("rejects with the engine's own code when it refuses", async () => {
    const { client, engine } = await readyClient();
    const call = client.send("teleport", { to: "moon" });
    const id = await lastId(engine);
    engine.reply({ id, ok: false, op: "teleport", error: "unknown op teleport", code: PlayErrorCode.UnknownOp });
    const error = await failure(call);
    assert.equal(error.code, PlayErrorCode.UnknownOp);
    assert.equal(error.op, "teleport");
  });

  it("reads a refusal with no known code as bad-reply, never as success", async () => {
    const { client, engine } = await readyClient();
    const call = client.call(PlayOp.State, {});
    const id = await lastId(engine);
    engine.reply({ id, ok: false, op: "state", error: "nope", code: "made-up" });
    assert.equal((await failure(call)).code, PlayFailure.BadReply);
  });

  const hostile: Array<{ name: string; lines: (id: number) => string[]; logged: boolean }> = [
    { name: "a malformed JSON line", lines: () => ['{"id": 1, "ok": tru'], logged: true },
    {
      name: "a reply with an unknown id",
      lines: (id) => [JSON.stringify({ id: id + 99, ok: true, result: 1 })],
      logged: true,
    },
    { name: "an id-less event", lines: () => [JSON.stringify({ event: "log", text: "hello" })], logged: true },
    { name: "a bare number, null and an array", lines: () => ["7", "null", "[]"], logged: true },
    {
      name: "a reply whose id is a string",
      lines: (id) => [JSON.stringify({ id: String(id), ok: true, result: 2 })],
      logged: true,
    },
    { name: "a reply with no ok flag", lines: (id) => [JSON.stringify({ id, result: 3 })], logged: true },
  ];
  for (const row of hostile) {
    it(`ignores ${row.name} and still answers the call`, async () => {
      const { client, engine } = await readyClient();
      const call = client.call(PlayOp.State, {});
      const id = await lastId(engine);
      const before = engine.logs.length;
      for (const line of row.lines(id)) engine.say(line);
      await settle();
      engine.reply({ id, ok: true, op: "state", result: { fine: true } });
      assert.deepEqual(await call, { fine: true });
      if (row.logged) assert.ok(engine.logs.length > before, "what was dropped is logged");
    });
  }

  it("refuses an oversize reply: the call fails as oversize, the next line is read whole", async () => {
    const { client, engine } = await readyClient();
    const big = client.call(PlayOp.Screenshot, {});
    const bigId = await lastId(engine);
    engine.say(`{"id":${bigId},"ok":true,"result":"${"A".repeat(MAX_PLAY_LINE_CHARS + 10)}"}`);
    assert.equal((await failure(big)).code, PlayFailure.Oversize);
    const next = client.call(PlayOp.State, {});
    const nextId = await lastId(engine);
    engine.reply({ id: nextId, ok: true, op: "state", result: { after: true } });
    assert.deepEqual(await next, { after: true });
  });

  it("drops an oversize line it cannot attribute and lets the call's own deadline decide", async () => {
    const { client, engine, deadlines } = await readyClient();
    const call = client.call(PlayOp.State, {}, { timeoutMs: 1_000 });
    await lastId(engine);
    engine.say(`{"result":"${"B".repeat(MAX_PLAY_LINE_CHARS + 10)}"}`);
    await settle();
    deadlines.advance(1_000);
    assert.equal((await failure(call)).code, PlayFailure.Timeout);
  });

  it("times a call out, and ignores the late reply", async () => {
    const { client, engine, deadlines } = await readyClient();
    const call = client.call(PlayOp.State, {}, { timeoutMs: 500 });
    const id = await lastId(engine);
    deadlines.advance(500);
    assert.equal((await failure(call)).code, PlayFailure.Timeout);
    engine.reply({ id, ok: true, op: "state", result: {} });
    await settle();
    assert.equal(deadlines.pending(), 0);
  });

  it("fails every pending call when the process exits mid-call, and every later call at once", async () => {
    const { client, engine, deadlines } = await readyClient();
    const one = client.call(PlayOp.State, {});
    const two = client.call(PlayOp.Step, { ms: 16 });
    await settle();
    engine.exit(9);
    assert.equal((await failure(one)).code, PlayFailure.Exited);
    assert.equal((await failure(two)).code, PlayFailure.Exited);
    assert.equal(client.exited, true);
    assert.equal((await failure(client.call(PlayOp.State, {}))).code, PlayFailure.Exited);
    assert.equal(deadlines.pending(), 0, "no deadline is left behind");
  });

  it("treats stdout closing as the process going away", async () => {
    const { client, engine } = await readyClient();
    const call = client.call(PlayOp.State, {});
    await settle();
    engine.streams.readable.end();
    assert.equal((await failure(call)).code, PlayFailure.Exited);
  });
});

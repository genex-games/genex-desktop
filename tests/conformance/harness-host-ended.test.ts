/**
 * A harness process that has ended is never served, and a planned stop never kills a boot already
 * under way.
 *
 * `HarnessHost` over a fake sandbox whose children are stand-ins the test speaks for: their stdout
 * is a stream the test writes protocol lines to, and a kill ends them at once. No process starts.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, it } from "node:test";
import { HarnessHost } from "../../src/substrate/harness-host.ts";
import type { ProcessSandbox } from "../../src/substrate/spawn.ts";

/** A child process stand-in: no pid (so no process group is ever signalled), stdio streams, and a kill that ends it. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = undefined;
  readonly signals: string[] = [];
  exited = false;
  kill(signal: string): boolean {
    this.signals.push(signal);
    this.exit();
    return true;
  }
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
  }
  /** One protocol line from the harness. */
  say(message: object): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await nextTurn();
}

/** A host over a fake sandbox; every child it spawns is kept, newest last, and each `events.head` call is counted. */
function fakeHost() {
  const children: FakeChild[] = [];
  const served: string[] = [];
  const sandbox = {
    spawnLongLived: async () => {
      const child = new FakeChild();
      children.push(child);
      return { child };
    },
  } as unknown as ProcessSandbox;
  const host = new HarnessHost({
    workspace: "/nowhere/harness",
    bootstrap: "/nowhere/bootstrap.mjs",
    execPath: process.execPath,
    sandbox,
    updatesDir: "/nowhere/updates",
    platform: "darwin",
    api: {
      "events.head": async () => {
        served.push("events.head");
        return null;
      },
    },
  });
  return { host, children, served };
}

const READY = { kind: "ready", harnessVersion: "test", capabilities: [] };

describe("a harness process that has ended", () => {
  it("is never served a host call it wrote before it went", async () => {
    const { host, children, served } = fakeHost();
    const starting = host.start();
    await settle();
    const child = children[0];
    assert.ok(child);
    child.say(READY);
    await starting;
    await host.stop();
    // A request line the harness wrote just before it was stopped, read after its exit.
    child.say({ kind: "rpc", id: 1, method: "events.head", params: { threadId: "t1" } });
    await settle();
    assert.deepEqual(served, [], "the ended process's call never reached its handler");
  });

  it("a live harness's call is still served", async () => {
    const { host, children, served } = fakeHost();
    const starting = host.start();
    await settle();
    const child = children[0];
    assert.ok(child);
    child.say(READY);
    await starting;
    child.say({ kind: "rpc", id: 1, method: "events.head", params: { threadId: "t1" } });
    await settle();
    assert.deepEqual(served, ["events.head"]);
    await host.stop();
  });
});

describe("a planned stop", () => {
  it("waits for a boot already under way instead of killing it as it starts", async () => {
    const { host, children } = fakeHost();
    const booting = host.restart(undefined, { callerRecovers: true }).then(
      () => "booted",
      (error: Error) => `failed: ${error.message}`,
    );
    await settle();
    const first = children[0];
    assert.ok(first, "the boot spawned its harness");
    let stopped = false;
    const stopping = host.stopAfterRestarts().then(() => {
      stopped = true;
    });
    await settle();
    assert.deepEqual(first.signals, [], "the booting harness is not killed");
    assert.equal(stopped, false, "the planned stop waits for the boot");
    first.say(READY);
    assert.equal(await booting, "booted", "the boot under way finished");
    await stopping;
    assert.ok(first.exited, "and only then was it stopped");
  });
});

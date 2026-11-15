import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SendFailure } from "../../src/shared/composer.ts";
import { errorCodeIn } from "../../src/shared/errors.ts";
import { DispatchActionType } from "../../src/shared/protocol.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** How long a message sent during the start gets to go on its own, if nothing holds it. */
const UNHELD_SEND_MS = 500;

/** A sandbox start the test settles by hand. */
function sandboxStart(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const FAILURES = [
  Object.assign(new Error("srt-win acl stamp timed out after 60000ms"), { code: "srt_win_timeout" }),
  Object.assign(new Error("WFP egress probe: CreateProcessWithLogonW: Access is denied"), {
    code: "wfp_verify_failed",
  }),
  new Error("could not deny the sandbox user Credentials: ERROR_INVALID_PARAMETER"),
];

describe("sandbox startup before harness recovery", () => {
  for (const failure of FAILURES) {
    it(`preserves harness edits and reports the original sandbox failure: ${failure.message}`, async () => {
      const { core, close } = await coreLite();
      const main = path.join(core.layout.harnessWs, "loop", "main.ts");
      const shipped = await readFile(main, "utf8");
      await core.snapshot("harness", "healthy before the local edit", undefined, true);
      const edited = `${shipped}\n// A valid edit that a sandbox fault must not rewind.\n`;
      await writeFile(main, edited);
      let checked = 0;
      let starts = 0;
      let restarts = 0;
      core.sandbox.ensureReady = async () => {
        checked++;
        throw failure;
      };
      core.host.start = async () => {
        starts++;
        throw failure;
      };
      core.host.restart = async () => {
        restarts++;
        throw failure;
      };
      try {
        await assert.rejects(core.start(), (error) => error === failure);
        assert.equal((await readFile(main, "utf8")) === edited, true, "the existing harness code must survive");
        assert.equal(checked, 1, "sandbox readiness is checked before the harness boots");
        assert.equal(starts, 0, "no harness process starts before the sandbox is ready");
        assert.equal(restarts, 0, "a sandbox fault must not trigger rewind or reseeding");
      } finally {
        await close();
      }
    });
  }
});

describe("a message sent while the agents start", () => {
  // Field case (Windows, 0.1.29 and 0.1.41): the window opens before the sandbox and the harness
  // are up, which can take minutes; every send in that time was refused as harness_not_running
  // (17 in 75 s on one install, which then gave up).
  it("waits for the agents and goes once they are up", async () => {
    const { core, close } = await coreLite();
    const sandboxUp = sandboxStart();
    const order: string[] = [];
    core.sandbox.ensureReady = () => sandboxUp.promise;
    core.host.start = async () => {
      order.push("harness started");
    };
    core.host.dispatch = async (action) => {
      order.push(action.type);
      return undefined;
    };
    try {
      const starting = core.start();
      const sent = core.sendUserMessage("make a small racing game");
      await Promise.race([sent.catch(() => undefined), sleep(UNHELD_SEND_MS)]);
      sandboxUp.resolve();
      await starting;
      await sent;
      const started = order.indexOf("harness started");
      assert.ok(started >= 0, "the harness started");
      assert.ok(order.indexOf(DispatchActionType.UserMessage) > started, "the message goes after the start");
    } finally {
      await close();
    }
  });

  it("is refused as agents not running once their start failed", async () => {
    const { core, close } = await coreLite();
    const sandboxFailed = sandboxStart();
    // Rejected before the start reaches the sandbox: the start reads it there.
    sandboxFailed.promise.catch(() => undefined);
    core.sandbox.ensureReady = () => sandboxFailed.promise;
    try {
      const starting = core.start().catch(() => undefined);
      const refused = assert.rejects(
        core.sendUserMessage("make a small racing game"),
        (error) => errorCodeIn(SendFailure, error) === SendFailure.HarnessNotRunning,
      );
      sandboxFailed.reject(new Error("srt-win wfp verify failed"));
      await starting;
      await refused;
    } finally {
      await close();
    }
  });
});

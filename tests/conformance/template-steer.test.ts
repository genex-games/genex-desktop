/**
 * The template's racing-line assist (src/game-template/src/studio.js `config.steer`, `assist()`).
 *
 * A drive that holds the throttle and steers nothing ends against a wall, and the judges rate a
 * parked car. A racing game hands the
 * studio the steering a driver on its racing line would apply; while the harness asks for it, the
 * studio steers through the same keys a player holds, for the share of frames the line asks.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installStudio } from "../../src/game-template/src/studio.js";

type StudioApi = Record<string, (...args: unknown[]) => unknown>;

const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  for (const name of ["window", "document", "requestAnimationFrame"]) saved[name] = globals[name];
  globals.window = { addEventListener: () => {}, __studio_error: null };
  globals.document = { addEventListener: () => {}, pointerLockElement: null, querySelector: () => null, body: null };
  globals.requestAnimationFrame = () => 0;
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
});

/** A game whose update records the keys it was handed each frame, steered by `steer()`. */
function steeredGame(steer?: () => number) {
  const frames: string[][] = [];
  const api = installStudio({
    fixedStepMs: 10,
    update: (_dt: number, ctx: { keys: Set<string> }) => {
      frames.push([...ctx.keys]);
    },
    ...(steer ? { steer } : {}),
  } as never) as unknown as StudioApi;
  return { api, frames };
}

const steersRight = (keys: string[]) => keys.includes("ArrowRight") && keys.includes("KeyD");
const steersLeft = (keys: string[]) => keys.includes("ArrowLeft") && keys.includes("KeyA");

describe("the racing-line assist", () => {
  it("holds the steer keys for the share of frames config.steer asks, through ctx.keys", () => {
    let line = 0.5;
    const { api, frames } = steeredGame(() => line);
    assert.deepEqual(api.assist({ steer: true }), { ok: true, steer: true });
    api.step(200);
    assert.equal(frames.length, 20);
    assert.equal(frames.filter(steersRight).length, 10, "half the frames for half a lock");
    assert.equal(frames.filter(steersLeft).length, 0);
    frames.length = 0;
    line = -1;
    api.step(100);
    assert.ok(frames.every(steersLeft), "full lock left every frame");
    frames.length = 0;
    line = 0;
    api.step(100);
    assert.ok(
      frames.every((keys) => !steersLeft(keys) && !steersRight(keys)),
      "a straight line steers nothing",
    );
  });

  it("steers nothing until asked, and lets go when told to — never a key the player holds", () => {
    const { api, frames } = steeredGame(() => -1);
    api.step(50);
    assert.ok(
      frames.every((keys) => !steersLeft(keys)),
      "the assist is off until the harness asks",
    );
    api.injectInput({ down: ["ArrowRight"] });
    api.assist({ steer: true });
    api.step(50);
    assert.ok(frames.slice(-5).every(steersLeft));
    assert.deepEqual(api.assist({ steer: false }), { ok: true, steer: false });
    frames.length = 0;
    api.step(50);
    assert.ok(
      frames.every((keys) => !steersLeft(keys)),
      "the assist let go of its own keys",
    );
    assert.ok(
      frames.every((keys) => keys.includes("ArrowRight")),
      "the player's held key was never the assist's to drop",
    );
  });

  it("is switched off by seed(), so a reset game is never driven by a look that ended", () => {
    const { api, frames } = steeredGame(() => 1);
    api.assist({ steer: true });
    api.seed(3);
    frames.length = 0;
    api.step(50);
    assert.ok(frames.every((keys) => !steersRight(keys)));
  });

  it("answers steer() off config.steer, clamped, and says so when there is no racing line", () => {
    assert.deepEqual(steeredGame(() => 3).api.steer(), { ok: true, steer: 1 });
    assert.deepEqual(steeredGame(() => -0.25).api.steer(), { ok: true, steer: -0.25 });
    const throwing = steeredGame(() => {
      throw new Error("no track yet");
    }).api;
    assert.deepEqual(throwing.steer(), { ok: false, reason: "config.steer threw: no track yet" });
    const plain = steeredGame().api;
    assert.equal((plain.steer() as { ok: boolean }).ok, false);
    assert.equal((plain.assist({ steer: true }) as { ok: boolean }).ok, false);
  });

  it("tells a game that runs its own loop the assist has no frame to steer in", () => {
    const api = installStudio({ steer: () => 1 } as never) as unknown as StudioApi;
    const answer = api.assist({ steer: true }) as { ok: boolean; reason?: string };
    assert.equal(answer.ok, false);
    assert.match(String(answer.reason), /update/);
  });
});

/**
 * `loop/evidence.ts` around the pass: the one table of why a look came back unjudgeable, the
 * patience each caller takes from it, and the preview windows a look is taken through.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MISSING_CONTRACT,
  acquireWindow,
  classifyEvidenceFailure,
  loadRaced,
  observationOnlyFailure,
  patientEvidence,
  withLease,
} from "../../src/harness-seed/loop/evidence.ts";
import * as gauntlet from "../../src/harness-seed/loop/gauntlet.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const BLIND = "screenshot(default) failed: the window is occluded";
const NO_FRAME = "no camera produced a frame (asked for: default; registered: none)";
const DRIVE = "could not drive the game: preview.call timed out";
const CONSOLE = "2 console error(s)";

describe("why a look came back unjudgeable", () => {
  it("is the camera, the clock or the build", () => {
    assert.equal(classifyEvidenceFailure([]), "none");
    assert.equal(classifyEvidenceFailure([BLIND, NO_FRAME]), "observation");
    assert.equal(
      classifyEvidenceFailure([MISSING_CONTRACT]),
      "race",
      "a missing contract on a page whose boot nobody measured",
    );
    assert.equal(
      classifyEvidenceFailure([MISSING_CONTRACT], { readyAfterMs: 6_000 }),
      "build",
      "…and a build failure once the boot was measured",
    );
    assert.equal(classifyEvidenceFailure([BLIND, CONSOLE]), "build");
    assert.equal(
      classifyEvidenceFailure([DRIVE]),
      "build",
      "a pass that could not drive the game is not a blind camera",
    );
    assert.equal(observationOnlyFailure([BLIND]), true);
    assert.equal(
      observationOnlyFailure(["identical frames from every camera"]),
      false,
      "duplicate frames indict the camera wiring",
    );
  });

  it("names a load that raced the window, from the same table", () => {
    assert.equal(loadRaced([BLIND]), true);
    assert.equal(loadRaced([MISSING_CONTRACT]), true);
    assert.equal(loadRaced(["window.__studio is missing"]), true);
    assert.equal(loadRaced([DRIVE, BLIND]), true);
    assert.equal(loadRaced([NO_FRAME]), false, "a pass that took no frame has never been looked at again");
    assert.equal(loadRaced([BLIND, CONSOLE]), false);
    assert.equal(loadRaced([]), false);
  });

  it("is still what gauntlet.ts exports, for harness files that import it from there", () => {
    assert.equal(gauntlet.classifyEvidenceFailure, classifyEvidenceFailure);
    assert.equal(gauntlet.observationOnlyFailure, observationOnlyFailure);
    assert.equal(gauntlet.MISSING_CONTRACT, MISSING_CONTRACT);
  });
});

describe("a patient look", () => {
  const looks = (...answers: Array<Record<string, unknown> | Error>) => {
    let n = 0;
    const look = async () => {
      const next = answers[Math.min(n++, answers.length - 1)]!;
      if (next instanceof Error) throw next;
      return { ...next };
    };
    return { look, count: () => n };
  };

  it("looks again after a load race, and stops at the first pass that runs", async () => {
    const raced: unknown[] = [];
    const { look, count } = looks({ ok: false, problems: [BLIND] }, { ok: true, problems: [] });
    const evidence = await patientEvidence({ cancelled: false }, look as never, {
      delayMs: 1,
      onRace: (e: unknown) => raced.push(e),
    });
    assert.equal(evidence!.ok, true);
    assert.equal(count(), 2);
    assert.equal(raced.length, 1);
    assert.equal(evidence!.attempts, 3, "the answer says how many looks it was allowed");
  });

  it("stops at once on a build failure, and after its last attempt on a race that never settles", async () => {
    const broken = looks({ ok: false, problems: [CONSOLE] });
    assert.equal((await patientEvidence({ cancelled: false }, broken.look as never, { delayMs: 1 }))!.ok, false);
    assert.equal(broken.count(), 1);
    const racing = looks({ ok: false, problems: [BLIND] });
    await patientEvidence({ cancelled: false }, racing.look as never, { delayMs: 1, attempts: 3 });
    assert.equal(racing.count(), 3);
  });

  it("reads a look that threw as a failed pass, and a stopped run as the end", async () => {
    const thrown = looks(new Error(BLIND), { ok: true });
    const evidence = await patientEvidence({ cancelled: false }, thrown.look as never, { delayMs: 1 });
    assert.equal(evidence!.ok, true, "the throw was a race, looked at again");
    const stopped = looks({ ok: false, problems: [BLIND] });
    await patientEvidence({ cancelled: true }, stopped.look as never, { delayMs: 1 });
    assert.equal(stopped.count(), 1);
  });
});

describe("a window to look through", () => {
  it("asks again a few times, and never waits for a studio that has no pool", async () => {
    let asks = 0;
    const recorder = ctxRecorder({
      handlers: { "preview.acquire": () => (++asks < 3 ? Promise.reject(new Error("all leased")) : { handle: "h3" }) },
    });
    assert.equal(await acquireWindow(recorder.ctx, "director-judge", { retriesMs: [1, 1, 1] }), "h3");
    assert.equal(await acquireWindow(recorder.ctx, "director-judge", { pooled: false }), null);
    assert.equal(asks, 3);
  });

  it("tells a pass that can wait that no window is free, and never runs it", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "preview.acquire": () => Promise.reject(new Error("all leased")),
        "preview.capacity": () => ({ max: 4, inUse: 4 }),
      },
    });
    let ran = false;
    const answer = await withLease(recorder.ctx, "director-judge", async () => (ran = true), { retriesMs: [] });
    assert.equal(ran, false);
    assert.match(String((answer as { noWindow?: string }).noWindow), /^no window free \(4\/4 in use\)/);
  });

  // Flipped: a pass that cannot wait used to borrow the user's Live and load back
  // what it showed. A call that names no window now reaches the studio's stand-in, so the pass
  // looks there and leaves the user's window, and what it showed, alone.
  it("looks through the studio's own window for a pass that cannot wait, and puts nothing into Live", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "preview.acquire": () => Promise.reject(new Error("all leased")),
        "preview.showing": () => ({ project: "pong", root: "/stage/build-7", entry: "index.html" }),
        "preview.load": () => true,
      },
    });
    const answer = await withLease(
      recorder.ctx,
      "director-health",
      async (handle: string | null) => `looked with ${handle}`,
      { borrow: true, retriesMs: [] },
    );
    assert.equal(answer, "looked with null");
    assert.deepEqual(recorder.paramsOf("preview.showing"), []);
    assert.deepEqual(recorder.paramsOf("preview.load"), []);
  });

  it("releases a leased window however the look ends", async () => {
    const recorder = ctxRecorder({
      handlers: { "preview.acquire": () => ({ handle: "h1" }), "preview.release": () => true },
    });
    await assert.rejects(
      withLease(recorder.ctx, "director-playtest", async () => {
        throw new Error("the playtester crashed");
      }),
      /crashed/,
    );
    assert.deepEqual(recorder.paramsOf("preview.release"), [{ handle: "h1" }]);
  });
});

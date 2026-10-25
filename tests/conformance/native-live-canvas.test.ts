/**
 * Live's embedded Mac build, pure (`src/renderer/panels/stage/native-live.ts`): the canvas size a
 * slot asks the game for and where a pointer lands on the game's surface, which frames the canvas
 * draws (the shown run's, one at a time), and what captured input becomes on its way to
 * `nativeInput`: moves and wheel coalesced per frame, committed text clipped, gamepads sent on change
 * only, and every held key let go on release. `NativeLiveCanvas.tsx` wires these to the DOM;
 * `run-native-embed-ui.mjs` drives it in the app.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CanvasAction,
  canvasActions,
  canvasBacking,
  CanvasPhase,
  awaitsFirstFrame,
  buildingWords,
  canvasPhase,
  canvasWords,
  capturePress,
  clipText,
  createFrameGate,
  embedSizeOf,
  FrameVerdict,
  heldAfter,
  lookAction,
  mouseButtonOf,
  NO_HELD,
  padAction,
  padChanges,
  pointerOnRing,
  pointerOnSurface,
  pointerMoveAction,
  queueAction,
  releaseActions,
  releasesCapture,
  resizeDue,
  startingProgress,
  textAction,
} from "../../src/renderer/panels/stage/native-live.ts";
import { DESTINATION_WORDS, NATIVE_WORDS } from "../../src/renderer/words.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import {
  BootStage,
  NATIVE_FRAME_SIDE_MAX,
  NATIVE_GAMEPAD_AXES_MAX,
  NATIVE_GAMEPAD_BUTTONS_MAX,
  NATIVE_NO_RUN_ID,
  NATIVE_TEXT_MAX_UNITS,
  type NativeFrameMeta,
  type NativeInputAction,
  NativeInputKind,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  parseNativeEmbedSize,
  parseNativeInput,
} from "../../src/shared/native-contract.ts";

/** A frame of `runId` of pong-mac, as main sends it. */
function meta(fields: Partial<NativeFrameMeta> = {}): NativeFrameMeta {
  return { project: "pong-mac", runId: "run-1", generation: 1, seq: 1, slot: 0, width: 1600, height: 900, ...fields };
}

/** A pad as the Gamepad API hands it over. */
function pad(index: number, buttons: number[], axes: number[]) {
  return { index, buttons: buttons.map((value) => ({ value })), axes };
}

describe("the canvas's size and the pointer's place on the game", () => {
  it("asks for the slot's whole CSS pixels and the screen's ratio; a slot with no area asks for nothing", () => {
    assert.deepEqual(embedSizeOf({ width: 800.4, height: 450.6 }, 2), { width: 800, height: 451, dpr: 2 });
    assert.equal(embedSizeOf({ width: 0, height: 450 }, 2), null, "Live hidden: nothing to ask for");
    assert.equal(embedSizeOf({ width: 800, height: 0.4 }, 2), null);
    assert.deepEqual(embedSizeOf({ width: 9000, height: 20 }, 1), { width: NATIVE_FRAME_SIDE_MAX, height: 20, dpr: 1 });
    assert.deepEqual(embedSizeOf({ width: 640, height: 360 }, 0.5)?.dpr, 1, "a zoomed-out page asks at least 1x");
    assert.deepEqual(embedSizeOf({ width: 640, height: 360 }, 9)?.dpr, 4);
    assert.deepEqual(embedSizeOf({ width: 640, height: 360 }, Number.NaN)?.dpr, 1);
    for (const rect of [
      { width: 1, height: 1 },
      { width: 4096, height: 4096 },
      { width: 1234.5, height: 77.7 },
    ])
      for (const dpr of [0, 1, 1.5, 2, 3, 8, Number.POSITIVE_INFINITY]) {
        const size = embedSizeOf(rect, dpr);
        assert.deepEqual(parseNativeEmbedSize(size), size, `main accepts ${JSON.stringify([rect, dpr])}`);
      }
  });

  it("asks for the slot's exact device pixels when the browser reports them, so the ring is never resampled", () => {
    // A flex slot 812.5 CSS px wide at dpr 2 covers 1625 device px; the rounded CSS side gave 1626,
    // and the compositor stretched every frame by 1625/1626 (renderer pass 2, TS-F3).
    const device = { width: 1625, height: 915 };
    const size = embedSizeOf({ width: 812.5, height: 457.5 }, 2, device);
    assert.deepEqual(size, { width: 813, height: 458, dpr: 2, device });
    assert.deepEqual(
      canvasBacking(size ?? { width: 0, height: 0, dpr: 1 }),
      device,
      "the ring is the device-pixel box",
    );
    assert.deepEqual(parseNativeEmbedSize(size), size, "main accepts it");
    // At a fractional ratio (Windows 125%, page zoom) the rounding error is a whole device pixel too.
    const zoomed = embedSizeOf({ width: 640.4, height: 360.2 }, 1.25, { width: 801, height: 450 });
    assert.deepEqual(canvasBacking(zoomed ?? { width: 0, height: 0, dpr: 1 }), { width: 801, height: 450 });
    // A report that no longer matches the slot (a resize between the two) is left out: CSS times the ratio.
    const stale = embedSizeOf({ width: 812.5, height: 457.5 }, 2, { width: 1400, height: 915 });
    assert.deepEqual(stale, { width: 813, height: 458, dpr: 2 });
    assert.deepEqual(
      embedSizeOf({ width: 9000, height: 20 }, 1, { width: 9000, height: 20 }),
      {
        width: NATIVE_FRAME_SIDE_MAX,
        height: 20,
        dpr: 1,
      },
      "a capped side drops the device pixels",
    );
  });

  it("asks again when only the device pixels changed", () => {
    const sent = { width: 813, height: 458, dpr: 2, device: { width: 1625, height: 915 } };
    assert.equal(resizeDue(sent, { ...sent, device: { ...sent.device } }), null);
    const moved = { ...sent, device: { width: 1626, height: 915 } };
    assert.deepEqual(resizeDue(sent, moved), moved);
    assert.deepEqual(resizeDue({ width: 813, height: 458, dpr: 2 }, sent), sent);
  });

  it("backs the canvas with the ring (CSS pixels times the ratio, within the ring caps) while CSS keeps the slot", () => {
    assert.deepEqual(canvasBacking({ width: 800, height: 450, dpr: 2 }), { width: 1600, height: 900 });
    assert.deepEqual(canvasBacking({ width: 800, height: 450, dpr: 1 }), { width: 800, height: 450 });
    const huge = canvasBacking({ width: 4096, height: 2048, dpr: 4 });
    assert.ok(huge.width <= NATIVE_FRAME_SIDE_MAX && huge.height <= NATIVE_FRAME_SIDE_MAX, JSON.stringify(huge));
    assert.equal(huge.width / huge.height, 2, "the aspect is kept");
  });

  it("a pointer lands on the same place of the game whatever the ring-to-CSS scale, clamped to its edges", () => {
    const slot = { left: 100, top: 50, width: 800, height: 400 };
    assert.deepEqual(pointerOnSurface({ x: 500, y: 250 }, slot), { x: 0.5, y: 0.5 });
    assert.deepEqual(pointerOnSurface({ x: 100, y: 50 }, slot), { x: 0, y: 0 }, "top-left is the surface's top-left");
    assert.deepEqual(pointerOnSurface({ x: 2000, y: -9 }, slot), { x: 1, y: 0 }, "outside: held to the edge");
    // One CSS place, two screens: a Retina ring is twice the pixels, the place on the game is the same.
    for (const dpr of [1, 2]) {
      const ring = canvasBacking({ width: 800, height: 400, dpr });
      const at = pointerOnSurface({ x: 300, y: 150 }, slot);
      assert.deepEqual([at.x * ring.width, at.y * ring.height], [200 * dpr, 100 * dpr], `dpr ${dpr}`);
    }
    assert.deepEqual(pointerOnSurface({ x: 3, y: 3 }, { left: 0, top: 0, width: 0, height: 0 }), { x: 0.5, y: 0.5 });
  });

  it("a pointer goes to the game in ring pixels, which the game maps through its letterbox", () => {
    // A 4:3 slot over a 16:9 world at dpr 2: the ring is 1600x1200 and the game letterboxes a
    // 1600x900 world into it at y 150..1050 (frames.h `fit`, frames_test `input-in-ring-pixels`).
    const slot = { left: 0, top: 0, width: 800, height: 600 };
    const ring = canvasBacking({ width: 800, height: 600, dpr: 2 });
    const top = pointerOnRing({ x: 400, y: 75 }, slot, ring);
    assert.deepEqual(
      parseNativeInput([{ type: "move", ...top }]),
      [{ type: "move", x: 800, y: 150, px: true }],
      "the world's top edge, in ring pixels: the game reads y 0 there",
    );
    assert.deepEqual(pointerOnRing({ x: 400, y: 20 }, slot, ring), { x: 800, y: 40, px: true }, "on the bar");
    assert.deepEqual(pointerOnRing({ x: -50, y: 900 }, slot, ring), { x: 0, y: 1200, px: true }, "held to the ring");
  });
});

describe("which frames the canvas draws", () => {
  const shown = { project: "pong-mac", runId: "run-1" };

  it("draws only the shown run's frames: another game, another run or no run yet are not this canvas's", () => {
    const gate = createFrameGate();
    const painted: number[] = [];
    const paint = (seq: number) => () => void painted.push(seq);
    assert.equal(gate.draw(meta({ seq: 1 }), shown, paint(1)), FrameVerdict.Draw);
    assert.equal(gate.draw(meta({ seq: 2, project: "other" }), shown, paint(2)), FrameVerdict.Foreign);
    assert.equal(gate.draw(meta({ seq: 3, runId: "run-0" }), shown, paint(3)), FrameVerdict.Foreign, "an older run");
    assert.equal(gate.draw(meta({ seq: 4 }), null, paint(4)), FrameVerdict.Foreign, "nothing shown");
    const unstarted = { project: "pong-mac", runId: NATIVE_NO_RUN_ID };
    assert.equal(gate.draw(meta({ seq: 5, runId: NATIVE_NO_RUN_ID }), unstarted, paint(5)), FrameVerdict.Foreign);
    assert.deepEqual(painted, [1]);
    assert.deepEqual(gate.counts(), { drawn: 1, dropped: 4 });
  });

  // GA round 2: Native Live's first open showed one or two black frames between the starting card
  // and the game's first frame, because the card left as soon as the run was ready. The canvas now
  // stays veiled (the card's "Drawing the first frame") until the shown run's own first frame is drawn.
  it("names the run whose frame it drew last, and the canvas stays veiled until the shown run's first frame", () => {
    const gate = createFrameGate();
    assert.equal(gate.drawnRun(), null, "nothing drawn yet");
    gate.draw(meta({ seq: 1, runId: "run-0" }), shown, () => {});
    assert.equal(gate.drawnRun(), null, "another run's frame is not drawn");
    gate.draw(meta({ seq: 2 }), shown, () => {});
    assert.equal(gate.drawnRun(), "run-1");
    const ready = embedded(NativeRunState.Ready);
    assert.equal(awaitsFirstFrame(CanvasPhase.Playing, ready, null), true, "ready, nothing drawn: still veiled");
    assert.equal(awaitsFirstFrame(CanvasPhase.Playing, ready, "embed-0"), true, "an older run's frame does not count");
    assert.equal(awaitsFirstFrame(CanvasPhase.Playing, ready, "embed-1"), false, "its own first frame lifts the veil");
    assert.equal(
      awaitsFirstFrame(CanvasPhase.Starting, embedded(NativeRunState.Starting), null),
      false,
      "the card is up",
    );
    assert.equal(awaitsFirstFrame(CanvasPhase.Ended, embedded(NativeRunState.Stopped), null), false);
  });

  it("keeps one frame in flight: a frame that arrives mid-draw is dropped, and a draw that throws frees the gate", () => {
    const gate = createFrameGate();
    const verdicts: FrameVerdict[] = [];
    gate.draw(meta({ seq: 1 }), shown, () => {
      verdicts.push(gate.draw(meta({ seq: 2 }), shown, () => assert.fail("never drawn twice at once")));
    });
    assert.deepEqual(verdicts, [FrameVerdict.Busy]);
    assert.throws(() =>
      gate.draw(meta({ seq: 3 }), shown, () => {
        throw new Error("context lost");
      }),
    );
    assert.equal(
      gate.draw(meta({ seq: 4 }), shown, () => {}),
      FrameVerdict.Draw,
      "the gate is free again",
    );
    assert.deepEqual(gate.counts(), { drawn: 3, dropped: 1 });
  });
});

describe("captured input on its way to the game", () => {
  it("keeps one move per frame: the last place wins, a press between moves keeps its order", () => {
    let queue: NativeInputAction[] = [];
    for (const x of [0.1, 0.2, 0.3]) queue = queueAction(queue, { type: "move", x, y: 0.5 });
    assert.deepEqual(queue, [{ type: "move", x: 0.3, y: 0.5 }]);
    queue = queueAction(queue, { type: "mousedown", button: "left" });
    queue = queueAction(queue, { type: "move", x: 0.4, y: 0.5 });
    queue = queueAction(queue, { type: "move", x: 0.6, y: 0.5 });
    assert.deepEqual(queue, [
      { type: "move", x: 0.3, y: 0.5 },
      { type: "mousedown", button: "left" },
      { type: "move", x: 0.6, y: 0.5 },
    ]);
  });

  it("sums the wheel within a frame, in the DOM pixels the game counts", () => {
    let queue: NativeInputAction[] = [];
    queue = queueAction(queue, { type: "scroll", dx: 0, dy: 40 });
    queue = queueAction(queue, { type: "scroll", dx: 3, dy: 60 });
    assert.deepEqual(queue, [{ type: "scroll", dx: 3, dy: 100 }]);
  });

  it("clips committed text to 256 UTF-16 units without splitting a character, and sends no empty text", () => {
    const long = "a".repeat(NATIVE_TEXT_MAX_UNITS + 40);
    assert.equal(clipText(long).length, NATIVE_TEXT_MAX_UNITS);
    const emoji = `${"a".repeat(NATIVE_TEXT_MAX_UNITS - 1)}😀`;
    assert.equal(clipText(emoji), "a".repeat(NATIVE_TEXT_MAX_UNITS - 1), "half a surrogate pair is not sent");
    assert.deepEqual(textAction("é"), { type: NativeInputKind.Text, text: "é" });
    assert.equal(textAction(""), null);
    assert.ok(parseNativeInput([textAction(long)]), "main accepts the clipped text");
  });

  it("names mouse buttons the way the game does, and nothing for a button it has none of", () => {
    assert.deepEqual([0, 1, 2, 3].map(mouseButtonOf), ["left", "middle", "right", null]);
  });

  it("Esc and Cmd release the keyboard; other keys are the game's", () => {
    assert.equal(releasesCapture("Escape"), true);
    assert.equal(releasesCapture("Meta"), true);
    for (const key of ["a", " ", "Enter", "Shift", "Control", "Alt", "ArrowUp", "Tab"])
      assert.equal(releasesCapture(key), false, key);
  });

  it("on release lets go of every key, button and pad still held, so nothing stays pressed in the game", () => {
    let held = NO_HELD;
    held = heldAfter(held, { type: "down", keys: ["KeyW"] });
    held = heldAfter(held, { type: "down", keys: ["ShiftLeft"] });
    held = heldAfter(held, { type: "up", keys: ["ShiftLeft"] });
    held = heldAfter(held, { type: "mousedown", button: "right" });
    held = heldAfter(held, { type: NativeInputKind.Gamepad, index: 1, buttons: [1], axes: [0.5] });
    assert.deepEqual(releaseActions(held), [
      { type: "up", keys: ["KeyW"] },
      { type: "mouseup", button: "right" },
      { type: NativeInputKind.Gamepad, index: 1, buttons: [0], axes: [0] },
    ]);
    assert.deepEqual(releaseActions(NO_HELD), [], "nothing held, nothing sent");
  });
});

describe("mouse look while the pointer is locked", () => {
  const RECT = { left: 0, top: 0, width: 800, height: 450 };
  const RING = { width: 1600, height: 900 };

  it("a locked pointer's motion is look, in device pixels as the web shell sends it", () => {
    assert.deepEqual(lookAction({ x: 3, y: -2 }, 2), { type: "look", dx: 6, dy: -4 });
    assert.equal(lookAction({ x: 0, y: 0 }, 2), null, "no motion, nothing sent");
    assert.ok(parseNativeInput([lookAction({ x: 3, y: -2 }, 2)]), "main accepts it");
  });

  it("locked, a move is look and never a place; unlocked, it is the place and never look", () => {
    const event = { clientX: 400, clientY: 225, movementX: 5, movementY: 1 };
    assert.deepEqual(pointerMoveAction(event, { locked: true, rect: RECT, ring: RING, dpr: 2 }), {
      type: "look",
      dx: 10,
      dy: 2,
    });
    assert.deepEqual(pointerMoveAction(event, { locked: false, rect: RECT, ring: RING, dpr: 2 }), {
      type: "move",
      x: 800,
      y: 450,
      px: true,
    });
  });

  it("sums look within a frame, so a fast turn is one action and nothing is lost", () => {
    let queue: NativeInputAction[] = [];
    queue = queueAction(queue, { type: "look", dx: 4, dy: 1 });
    queue = queueAction(queue, { type: "look", dx: 6, dy: -3 });
    assert.deepEqual(queue, [{ type: "look", dx: 10, dy: -2 }]);
    queue = queueAction(queue, { type: "mousedown", button: "left" });
    queue = queueAction(queue, { type: "look", dx: 1, dy: 1 });
    assert.equal(queue.length, 3, "a press between turns keeps its order");
  });
});

describe("a press takes the pointer only where Chromium lets it (PW: the setPointerCapture spam)", () => {
  /** An element whose `setPointerCapture` throws as Chromium's does: under pointer lock, and for a pointer that is not down. */
  function element(options: { locked: boolean; down: readonly number[] }) {
    const captured: number[] = [];
    const doc = { pointerLockElement: options.locked ? {} : null };
    return {
      captured,
      ownerDocument: doc,
      setPointerCapture(pointerId: number) {
        if (doc.pointerLockElement)
          throw new DOMException("Failed to execute 'setPointerCapture'", "InvalidStateError");
        if (!options.down.includes(pointerId))
          throw new DOMException("Failed to execute 'setPointerCapture'", "NotFoundError");
        captured.push(pointerId);
      },
    };
  }

  const ROWS = [
    { name: "an unlocked press", locked: false, trusted: true, down: [1], takes: true },
    {
      name: "a press under mouse look's pointer lock (every cast)",
      locked: true,
      trusted: true,
      down: [1],
      takes: false,
    },
    { name: "a synthetic press (a script's, not the person's)", locked: false, trusted: false, down: [], takes: false },
    { name: "a press whose pointer was already let go", locked: false, trusted: true, down: [], takes: false },
  ] as const;
  for (const row of ROWS) {
    it(`${row.name} ${row.takes ? "takes" : "never takes"} the pointer, and never throws`, () => {
      const target = element(row);
      assert.equal(capturePress(target, { pointerId: 1, isTrusted: row.trusted }), row.takes);
      assert.deepEqual(target.captured, row.takes ? [1] : []);
    });
  }

  it("any other failure still surfaces", () => {
    const target = {
      ownerDocument: { pointerLockElement: null },
      setPointerCapture() {
        throw new TypeError("not an element");
      },
    };
    assert.throws(() => capturePress(target, { pointerId: 1, isTrusted: true }), TypeError);
  });
});

describe("gamepads", () => {
  it("reads a pad in the standard mapping's bounds, and none past the fourth", () => {
    const many = pad(
      0,
      Array.from({ length: 20 }, () => 2),
      [-3, 0.25, 0, 0, 0.5, 0.5],
    );
    const action = padAction(many);
    assert.equal(action?.buttons.length, NATIVE_GAMEPAD_BUTTONS_MAX);
    assert.equal(action?.axes.length, NATIVE_GAMEPAD_AXES_MAX);
    assert.deepEqual([action?.buttons[0], action?.axes[0], action?.axes[1]], [1, -1, 0.25]);
    assert.equal(padAction(pad(4, [1], [0])), null);
    assert.ok(parseNativeInput([action]), "main accepts it");
  });

  it("sends a pad's state when it changes, never the same state twice, and a neutral state once it is gone", () => {
    const first = padChanges(
      new Map(),
      [padAction(pad(0, [0, 1], [0, 0]))].filter((p) => p !== null),
    );
    assert.equal(first.actions.length, 1);
    const same = padChanges(
      first.last,
      [padAction(pad(0, [0, 1], [0, 0]))].filter((p) => p !== null),
    );
    assert.deepEqual(same.actions, [], "an unchanged pad sends nothing");
    const moved = padChanges(
      same.last,
      [padAction(pad(0, [0, 1], [0.5, 0]))].filter((p) => p !== null),
    );
    assert.deepEqual(moved.actions, [{ type: NativeInputKind.Gamepad, index: 0, buttons: [0, 1], axes: [0.5, 0] }]);
    const gone = padChanges(moved.last, []);
    assert.deepEqual(gone.actions, [{ type: NativeInputKind.Gamepad, index: 0, buttons: [0, 0], axes: [0, 0] }]);
    assert.deepEqual(padChanges(gone.last, []).actions, [], "said once");
  });
});

describe("resizing", () => {
  it("sends a new size only when it differs from the one the game has, so a frame's many observations are one call", () => {
    const sent = { width: 800, height: 450, dpr: 2 };
    assert.equal(resizeDue(sent, { ...sent }), null);
    assert.equal(resizeDue(sent, null), null, "Live hidden: the ring stays");
    assert.deepEqual(resizeDue(sent, { width: 801, height: 450, dpr: 2 }), { width: 801, height: 450, dpr: 2 });
    assert.deepEqual(resizeDue(sent, { width: 800, height: 450, dpr: 1 }), { width: 800, height: 450, dpr: 1 });
    assert.deepEqual(resizeDue(null, sent), sent);
  });
});

/** pong-mac's embedded run in `state`. */
function embedded(state: NativeRunState, extra: Partial<NativeRunStatus> = {}): NativeRunStatus {
  return {
    project: "pong-mac",
    runId: "embed-1",
    target: BuildTarget.Mac,
    state,
    mode: NativeRunMode.Embedded,
    pid: 4343,
    backend: null,
    refusal: null,
    problem: null,
    exit: null,
    owner: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: null,
    ...extra,
  };
}

describe("what Live's canvas says about the embedded run", () => {
  // Owner decision D11: while the game starts, the card says where its boot is (the pipelines n
  // of m) and the bar fills with it; a stage with no count shows its words alone.
  it("says where a starting game's boot is and fills the bar as its pipelines compile", () => {
    const at = (progress: NativeRunStatus["progress"]) =>
      startingProgress(embedded(NativeRunState.Starting, { progress }));
    assert.equal(startingProgress(null), null, "nothing before the host answered");
    assert.equal(at(null), null, "a game that names no stage");
    const device = at({ stage: BootStage.Device, done: null, total: null });
    assert.equal(device?.words, NATIVE_WORDS.boot.stage[BootStage.Device]);
    const some = at({ stage: BootStage.Pipelines, done: 12, total: 40 });
    assert.equal(some?.words, NATIVE_WORDS.boot.counted(BootStage.Pipelines, 12, 40));
    const all = at({ stage: BootStage.Pipelines, done: 40, total: 40 });
    assert.ok((device?.fill ?? 1) < (some?.fill ?? 0) && (some?.fill ?? 1) < (all?.fill ?? 0), "the bar only fills");
    assert.equal(
      canvasWords(
        CanvasPhase.Starting,
        embedded(NativeRunState.Starting, { progress: { stage: BootStage.Pipelines, done: 12, total: 40 } }),
      ).detail,
      NATIVE_WORDS.boot.counted(BootStage.Pipelines, 12, 40),
      "the card's detail is the boot's words",
    );
  });

  it("waits while the run is on its way, plays once it is ready, and says how it ended or why it was refused", () => {
    assert.equal(canvasPhase(null, false, true), CanvasPhase.Starting);
    for (const state of [NativeRunState.Building, NativeRunState.Admitting, NativeRunState.Starting])
      assert.equal(canvasPhase(embedded(state), false, true), CanvasPhase.Starting, state);
    assert.equal(canvasPhase(embedded(NativeRunState.Ready), false, true), CanvasPhase.Playing);
    assert.equal(
      canvasPhase(embedded(NativeRunState.Paused), false, true),
      CanvasPhase.Playing,
      "hidden Live pauses it",
    );
    for (const state of [NativeRunState.Stopped, NativeRunState.Crashed, NativeRunState.Killed])
      assert.equal(canvasPhase(embedded(state), false, true), CanvasPhase.Ended, state);
    assert.equal(canvasPhase(embedded(NativeRunState.Refused), false, true), CanvasPhase.Refused);
    assert.equal(canvasPhase(null, true, true), CanvasPhase.Failed, "the embed call itself failed");
    assert.equal(
      canvasPhase(embedded(NativeRunState.Ready), false, false),
      CanvasPhase.CantDraw,
      "no WebGL2: nothing draws",
    );
  });

  it("offers Pop out always, and Try again or Restart only where it can help", () => {
    const refused = (refusal: NativeRefusal) => embedded(NativeRunState.Refused, { refusal });
    assert.deepEqual(canvasActions(CanvasPhase.Starting, null), []);
    assert.deepEqual(canvasActions(CanvasPhase.Playing, embedded(NativeRunState.Ready)), []);
    assert.deepEqual(canvasActions(CanvasPhase.Refused, refused(NativeRefusal.FramesStalled)), [
      CanvasAction.TryAgain,
      CanvasAction.PopOut,
    ]);
    assert.deepEqual(
      canvasActions(CanvasPhase.Refused, refused(NativeRefusal.GamePredatesEmbedding)),
      [CanvasAction.PopOut],
      "a game made before embedding never embeds: Try again would refuse again",
    );
    assert.deepEqual(canvasActions(CanvasPhase.Ended, embedded(NativeRunState.Crashed)), [
      CanvasAction.Restart,
      CanvasAction.PopOut,
    ]);
    assert.deepEqual(canvasActions(CanvasPhase.CantDraw, null), [CanvasAction.PopOut]);
    assert.deepEqual(canvasActions(CanvasPhase.Failed, null), [CanvasAction.TryAgain, CanvasAction.PopOut]);
  });

  it("never offers Pop out for a game with no window of its own (a Rust game): Try again or Restart alone", () => {
    const noWindow = { popOut: false };
    const refused = (refusal: NativeRefusal) => embedded(NativeRunState.Refused, { refusal });
    assert.deepEqual(canvasActions(CanvasPhase.Ended, embedded(NativeRunState.Crashed), noWindow), [
      CanvasAction.Restart,
    ]);
    assert.deepEqual(canvasActions(CanvasPhase.Failed, null, noWindow), [CanvasAction.TryAgain]);
    assert.deepEqual(canvasActions(CanvasPhase.Refused, refused(NativeRefusal.FramesStalled), noWindow), [
      CanvasAction.TryAgain,
    ]);
    assert.deepEqual(canvasActions(CanvasPhase.Refused, refused(NativeRefusal.EmbedUnsupported), noWindow), []);
    assert.deepEqual(canvasActions(CanvasPhase.CantDraw, null, noWindow), []);
    assert.deepEqual(canvasActions(CanvasPhase.Playing, embedded(NativeRunState.Ready), noWindow), []);
  });

  it("says each refusal in the embed words, a failed Mac build in the Mac's words, and a crash as the card does", () => {
    const words = (status: NativeRunStatus | null, phase: CanvasPhase) => canvasWords(phase, status);
    assert.equal(
      words(embedded(NativeRunState.Refused, { refusal: NativeRefusal.GamePredatesEmbedding }), CanvasPhase.Refused)
        .detail,
      NATIVE_WORDS.embed.predates,
    );
    // A game with the ring that refused its surface: Live could not start it, which Try again may fix.
    const ringFailed = embedded(NativeRunState.Refused, { refusal: NativeRefusal.Unsupported });
    assert.equal(words(ringFailed, CanvasPhase.Refused).detail, NATIVE_WORDS.embed.failed);
    assert.deepEqual(canvasActions(CanvasPhase.Refused, ringFailed), [CanvasAction.TryAgain, CanvasAction.PopOut]);
    // A run whose frames failed is killed with its refusal (`NativeRuns.kill`): Live says why.
    assert.deepEqual(
      words(embedded(NativeRunState.Killed, { refusal: NativeRefusal.FramesStalled }), CanvasPhase.Ended),
      { title: NATIVE_WORDS.state[NativeRunState.Killed], detail: NATIVE_WORDS.embed.stalled },
    );
    assert.equal(
      words(embedded(NativeRunState.Killed, { refusal: NativeRefusal.FramesInvalid }), CanvasPhase.Ended).detail,
      NATIVE_WORDS.refusal[NativeRefusal.FramesInvalid],
    );
    assert.equal(
      words(embedded(NativeRunState.Killed), CanvasPhase.Ended).detail,
      NATIVE_WORDS.killed,
      "killed after it did not quit when asked",
    );
    const failedBuild = words(
      embedded(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed }),
      CanvasPhase.Refused,
    );
    assert.equal(failedBuild.title, NATIVE_WORDS.refusal[NativeRefusal.BuildFailed]);
    assert.doesNotMatch(String(failedBuild.detail), /last working build/);
    const crashed = words(
      embedded(NativeRunState.Crashed, { exit: { code: null, signal: "SIGSEGV" } }),
      CanvasPhase.Ended,
    );
    assert.deepEqual(crashed, {
      title: NATIVE_WORDS.state[NativeRunState.Crashed],
      detail: NATIVE_WORDS.crashed(null, "SIGSEGV"),
    });
    assert.equal(words(null, CanvasPhase.CantDraw).detail, NATIVE_WORDS.embed.cantDraw);
    assert.equal(words(null, CanvasPhase.Failed).detail, NATIVE_WORDS.embed.failed);
    assert.equal(
      words(embedded(NativeRunState.Building), CanvasPhase.Starting).title,
      NATIVE_WORDS.state[NativeRunState.Building],
    );
    assert.doesNotMatch(
      words(embedded(NativeRunState.Ready), CanvasPhase.Playing).title,
      /own window/,
      "it plays inside Live",
    );
  });
});

describe("what Live's canvas says while the Mac build is made", () => {
  const startedAt = "2026-10-01T00:00:00.000Z";
  const at = (ms: number) => Date.parse(startedAt) + ms;
  const building = embedded(NativeRunState.Building, { startedAt });

  it("says what is built, of which folder, for how long, and with which compiler", () => {
    const copy = buildingWords(building, { copy: true, stack: GameStack.RustWgpu, now: at(72_000) });
    assert.deepEqual(copy, {
      title: NATIVE_WORDS.embed.buildingCopy("1:12"),
      detail: DESTINATION_WORDS.buildStage[GameStack.RustWgpu],
    });
    assert.equal(
      buildingWords(building, { copy: false, stack: GameStack.RaylibCpp, now: at(5_000) })?.title,
      NATIVE_WORDS.embed.building("0:05"),
      "the game folder",
    );
    assert.equal(buildingWords(building, { copy: false, stack: null, now: at(0) })?.detail, null);
    const unread = embedded(NativeRunState.Building, { startedAt: "not a time" });
    assert.equal(
      buildingWords(unread, { copy: true, stack: null, now: at(0) })?.title,
      NATIVE_WORDS.embed.buildingCopy("0:00"),
    );
  });

  it("says nothing of a build once the run is past it; a failed build says its refusal and offers Try again", () => {
    const context = { copy: true, stack: GameStack.RustWgpu, now: at(1_000) };
    for (const state of [NativeRunState.Admitting, NativeRunState.Starting, NativeRunState.Ready])
      assert.equal(buildingWords(embedded(state, { startedAt }), context), null, state);
    assert.equal(buildingWords(null, context), null, "nothing answered yet");
    const failed = embedded(NativeRunState.Refused, { refusal: NativeRefusal.BuildFailed, pid: null });
    const phase = canvasPhase(failed, false, true);
    assert.equal(phase, CanvasPhase.Refused, "never left starting");
    assert.equal(canvasWords(phase, failed).title, NATIVE_WORDS.refusal[NativeRefusal.BuildFailed]);
    assert.deepEqual(canvasActions(phase, failed, { popOut: false }), [CanvasAction.TryAgain]);
  });
});

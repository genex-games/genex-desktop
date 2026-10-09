/** Immediate chat Stop, protected Escape, and keep-awake through saved-state settlement. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { composerEscapeIntent } from "../../src/renderer/stopping.ts";
import { escapeCancels, stopTurn } from "../../src/renderer/composer-stop.ts";
import {
  escapeStops,
  isStopping,
  requestChatStop,
  STOP_RETRY_MS,
  stopSettled,
} from "../../src/renderer/chat/chat-stop.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

/** Every renderer source file: the one-Stop rule is about the whole tree, not one panel. */
function rendererFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(path.join(root, "src/renderer"));
  return out;
}

describe("what Escape in the composer means", () => {
  it("never interrupts an active build", () => {
    assert.deepEqual(composerEscapeIntent({ runId: "run-a", turnInFlight: true }), { kind: "none" });
    assert.deepEqual(composerEscapeIntent({ runId: "run-a", turnInFlight: false }), { kind: "none" });
  });
  it("cancels a chat-only turn", () => {
    assert.deepEqual(composerEscapeIntent({ runId: null, turnInFlight: true }), { kind: "cancel-turn" });
  });
  it("leaves an idle chat alone", () => {
    assert.deepEqual(composerEscapeIntent({ runId: null, turnInFlight: false }), { kind: "none" });
  });
});

describe("the composer's Stop and Escape", () => {
  const inComposer = { closest: (selector: string) => (selector === "[data-promptbar]" ? {} : null) };
  const elsewhere = { closest: () => null };

  it("Stop interrupts its own conversation immediately, never the build", async () => {
    // Strict: any call other than the stubbed cancelTurn (stopRun, finishRun, …) is a failure.
    const studio = fakeStudioApi({ cancelTurn: async () => true }, { strict: true });
    const failures: unknown[] = [];
    stopTurn(studio.api, "chat-a", (err) => failures.push(err));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      studio.calls.map(({ method, args }) => [method, ...args]),
      [["cancelTurn", "chat-a"]],
    );
    assert.deepEqual(failures, []);
  });

  it("hands a refused Stop back to the composer to report", async () => {
    const refusal = new Error("That chat is not running anything.");
    const studio = fakeStudioApi(
      {
        cancelTurn: async () => {
          throw refusal;
        },
      },
      { strict: true },
    );
    const failures: unknown[] = [];
    stopTurn(studio.api, "chat-a", (err) => failures.push(err));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, [refusal]);
  });

  it("Escape reaches only the composer, and only a chat turn", () => {
    const chatTurn = { threadId: "chat-a", runId: null, turnInFlight: true };
    assert.equal(escapeCancels({ key: "Escape", target: inComposer }, chatTurn), "chat-a");
    assert.equal(
      escapeCancels({ key: "Escape", target: elsewhere }, chatTurn),
      null,
      "Escape outside the composer belongs to whatever has focus",
    );
    assert.equal(escapeCancels({ key: "Escape", target: null }, chatTurn), null);
    assert.equal(
      escapeCancels({ key: "Escape", target: inComposer }, { ...chatTurn, runId: "run-a" }),
      null,
      "during a build it has nothing to do",
    );
    assert.equal(
      escapeCancels({ key: "Escape", target: inComposer }, { ...chatTurn, turnInFlight: false }),
      null,
      "an idle chat is left alone",
    );
    assert.equal(escapeCancels({ key: "Escape", target: inComposer }, { ...chatTurn, threadId: null }), null);
    assert.equal(escapeCancels({ key: "Enter", target: inComposer }, chatTurn), null);
  });
});

describe("the chat's Stop, as the composer wires it", () => {
  const event = (id: string, data: EventEnvelope["data"]): EventEnvelope => ({
    id,
    thread_id: "chat-a",
    session_id: null,
    turn_id: null,
    created_at: "2026-09-24T00:00:00Z",
    data,
  });
  const seen = [event("e1", { type: "error", message: "x" })];

  it("the Stop button cancels this chat's turn through cancelTurn alone, and marks where it was pressed", async () => {
    const studio = fakeStudioApi({ cancelTurn: async () => true }, { strict: true });
    const mark = requestChatStop(studio.api, { threadId: "chat-a", stopping: false, events: seen, now: 7 }, () =>
      assert.fail("nothing refused"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(mark, { thread: "chat-a", after: "e1", at: 7 });
    assert.deepEqual(
      studio.calls.map(({ method, args }) => [method, ...args]),
      [["cancelTurn", "chat-a"]],
    );
  });

  it("a second Stop while the first settles asks nothing, and a refused Stop is handed back", async () => {
    const quiet = fakeStudioApi({}, { strict: true });
    assert.equal(
      requestChatStop(quiet.api, { threadId: "chat-a", stopping: true, events: seen }, () => {}),
      null,
      "the follow-up taking over is not cancelled",
    );
    assert.equal(
      requestChatStop(quiet.api, { threadId: null, stopping: false, events: seen }, () => {}),
      null,
    );
    assert.deepEqual(quiet.calls, []);
    const refusal = new Error("That chat is not running anything.");
    const refusing = fakeStudioApi(
      {
        cancelTurn: async () => {
          throw refusal;
        },
      },
      { strict: true },
    );
    const failures: unknown[] = [];
    requestChatStop(refusing.api, { threadId: "chat-a", stopping: false, events: seen }, (err) => failures.push(err));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, [refusal]);
  });

  it("a Stop still settling after a few seconds can be pressed again, and asks once more", async () => {
    const studio = fakeStudioApi({ cancelTurn: async () => true }, { strict: true });
    const first = requestChatStop(studio.api, { threadId: "chat-a", stopping: false, events: seen, now: 1_000 }, () =>
      assert.fail("nothing refused"),
    );
    const settling = { threadId: "chat-a", stopping: true, events: seen, mark: first };
    assert.equal(
      requestChatStop(studio.api, { ...settling, now: 1_000 + STOP_RETRY_MS - 1 }, () => {}),
      null,
      "a double press does not cancel the follow-up taking over",
    );
    const again = requestChatStop(studio.api, { ...settling, now: 1_000 + STOP_RETRY_MS }, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(again, { thread: "chat-a", after: "e1", at: 1_000 + STOP_RETRY_MS });
    assert.deepEqual(
      studio.calls.map(({ method, args }) => [method, ...args]),
      [
        ["cancelTurn", "chat-a"],
        ["cancelTurn", "chat-a"],
      ],
      "a Stop that was swallowed can be asked again",
    );
  });

  it("says Stopping until the stopped work records its end", () => {
    const mark = { thread: "chat-a", after: "e1", at: 0 };
    assert.equal(isStopping(mark, { threadId: "chat-a", running: true, events: seen }), true);
    assert.equal(
      isStopping(mark, { threadId: "chat-b", running: true, events: seen }),
      false,
      "another chat is not stopping",
    );
    assert.equal(
      isStopping(mark, { threadId: "chat-a", running: false, events: seen }),
      false,
      "nothing running is nothing stopping",
    );
    const ended = [...seen, event("e2", { type: "turn_ended", status: "cancelled" } as EventEnvelope["data"])];
    assert.equal(stopSettled(mark, ended), true);
    assert.equal(isStopping(mark, { threadId: "chat-a", running: true, events: ended }), false);
    const paused = [...seen, event("e3", { type: "custom", event_type: "autopilot_paused", payload: {} })];
    assert.equal(stopSettled(mark, paused), true, "a paused run has settled too");
    assert.equal(
      stopSettled({ thread: "chat-a", after: "e3", at: 0 }, paused),
      false,
      "only what came after the press counts",
    );
  });

  it("Escape in the composer cancels only a chat turn, through the same route", async () => {
    const studio = fakeStudioApi({ cancelTurn: async () => true }, { strict: true });
    const inComposer = { closest: (selector: string) => (selector === "[data-promptbar]" ? {} : null) };
    escapeStops(
      studio.api,
      { key: "Escape", target: inComposer },
      { threadId: "chat-a", runId: "run-a", turnInFlight: true },
    );
    escapeStops(studio.api, { key: "Escape", target: null }, { threadId: "chat-a", runId: null, turnInFlight: true });
    escapeStops(
      studio.api,
      { key: "Escape", target: inComposer },
      { threadId: "chat-a", runId: null, turnInFlight: true },
    );
    assert.deepEqual(
      studio.calls.map(({ method, args }) => [method, ...args]),
      [["cancelTurn", "chat-a"]],
    );
  });
});

/**
 * Source-level gates that remain. The renderer-wide ones are lints over the whole tree (they
 * survive files moving); the rest need a rendered window or the main process to prove otherwise.
 */
describe("the surfaces that obey it", () => {
  it("status lines do not duplicate composer Stop", () => {
    assert.doesNotMatch(read("src/renderer/ui/LoadingState.tsx"), /onStop|aria-label="Stop"/);
  });

  it("chat cancellation is the single renderer stop route", () => {
    // `window.studio.stopRun` is exposed to the whole renderer, so counting calls in App.tsx
    // alone would not notice a Stop added to RunGraph, PreviewPanel or a panel written later.
    const sources = rendererFiles().map((file) => ({
      file: path.relative(root, file),
      text: readFileSync(file, "utf8"),
    }));
    const callers = sources.filter(({ text }) => /studio\.stopRun\(/.test(text)).map(({ file }) => file);
    assert.deepEqual(callers, [], "the renderer stops only the selected chat through cancelTurn");
    const obsolete = sources
      .filter(({ text }) => text.includes("confirm-stop") || text.includes("offerKeepGoing"))
      .map(({ file }) => file);
    assert.deepEqual(obsolete, [], "no obsolete confirmation or keep-going offer remains");
  });

  it("the menus that close on Escape stop the press there", () => {
    const menu = read("src/renderer/ui/ModelMenu.tsx");
    assert.match(
      menu,
      /if\s*\(event\.key\s*===\s*["']Escape["']\)\s*\{[^}]*event\.stopPropagation\(\)/,
      "the portaled picker consumes Escape before the app can act on it",
    );
    const graph = read("src/renderer/panels/RunGraph.tsx");
    const escape = graph.slice(
      graph.indexOf('if (event.key === "Escape") {'),
      graph.indexOf('} else if (event.key === "0")'),
    );
    assert.match(escape, /event\.stopPropagation\(\)/);
    assert.match(escape, /else return;/, "an Escape this panel does not use must travel on");
  });
});

// The keep-awake hold, the stop and start handlers that drive it, and the build smoke's checks of
// both are behaviour tests now: tests/conformance/main-ipc.test.ts and the smoke's own required
// checks (tests/e2e/run-build-smoke.mjs).
describe("the build smoke covers the run controls", () => {
  it("and `npm run verify` actually runs that smoke", () => {
    // The runner passes --studio-build-smoke. Verification builds once, then invokes the
    // runner directly; the standalone UI script remains available for scoped iteration.
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    assert.match(scripts.verify!, /(?:npm run test:build-ui|node tests\/e2e\/run-build-smoke\.mjs)(?:\s*&&|$)/);
    assert.match(scripts["test:build-ui"]!, /run-build-smoke\.mjs/);
  });
});

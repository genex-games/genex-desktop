/**
 * The UI event map (`src/shared/ui-events.ts`) is the contract of the `studio:event` push channel.
 * The type half is enforced by `npm run typecheck` (the `@ts-expect-error` lines below fail the
 * typecheck if a mismatch ever compiles). These tests pin the runtime half: what the producers
 * hand the renderer, and that the map names exactly what they produce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import ts from "@typescript/typescript6";
import {
  UI_EVENT_TYPES,
  harnessUiEvent,
  isHostOnlyUiEvent,
  isUiEvent,
  isUiEventIn,
  isUiEventType,
  uiEvent,
  type UiEvent,
} from "../../src/shared/ui-events.ts";
import { createStudioBridge, type BridgeIpc } from "../../src/preload/studio-bridge.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { stringVocabularies, vocabularyValues } from "../helpers/vocabulary-scan.ts";

const SRC = path.resolve(import.meta.dirname, "../../src");
// Code shipped into the games themselves: its emitters are the game's, not the studio's.
const NOT_STUDIO = new Set(["game-template", "page", "node_modules"]);

async function studioSources(): Promise<string[]> {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        /\.(?:ts|tsx|mjs|js)$/.test(e.name) &&
        !path
          .relative(SRC, e.parentPath)
          .split(path.sep)
          .some((part) => NOT_STUDIO.has(part)),
    )
    .map((e) => path.join(e.parentPath, e.name));
}

/**
 * Every literal UI event name a producer passes: `emit("name", …)` (StudioCore and the dev
 * fixtures), `notify("name", …)` (the harness's `host.notify`/`ctx.notify`), `uiEvent("name", …)`
 * and `pushUiEvent({ type: "name", … })` (main). A name is a string literal or a vocabulary
 * member (`UiEvent.PreviewFrame`). The sources are parsed as data to derive what the channel
 * carries; nothing about their implementation text is asserted.
 */
async function producedNames(): Promise<Map<string, string[]>> {
  const files = await studioSources();
  const program = ts.createProgram(files, {
    allowJs: true,
    noResolve: true,
    noLib: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  });
  const vocabularies = stringVocabularies(program.getSourceFiles());
  const names = new Map<string, string[]>();
  const add = (name: string, file: string) => names.set(name, [...(names.get(name) ?? []), path.relative(SRC, file)]);
  const literals = (node: ts.Expression): readonly string[] =>
    ts.isStringLiteralLike(node) ? [node.text] : vocabularyValues(vocabularies, node);
  for (const file of files) {
    const source = program.getSourceFile(file);
    assert.ok(source, file);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : "";
        const [first] = node.arguments;
        if ((callee === "emit" || callee === "notify" || callee === "uiEvent") && first)
          for (const name of literals(first)) add(name, file);
        if (callee === "pushUiEvent" && first && ts.isObjectLiteralExpression(first)) {
          const type = first.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "type");
          if (type && ts.isPropertyAssignment(type)) for (const name of literals(type.initializer)) add(name, file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

test("contract: every literal name passed to emit, notify or pushUiEvent in src is a UiEventMap key, and every key is produced", async () => {
  const produced = await producedNames();
  // A scan that found nothing would pass vacuously; the producers name about eighty events.
  assert.ok(produced.size >= 60, `only ${produced.size} names found — has the scan stopped matching?`);
  // One name from each producer: the core, main's pushUiEvent, the harness seed, the dev fixtures.
  for (const known of ["preview.frame", "studio.ready", "judge.verdict", "coordinator.queued"])
    assert.ok(produced.has(known), known);
  const unknown = [...produced]
    .filter(([name]) => !isUiEventType(name))
    .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
  assert.deepEqual(unknown, [], "a producer sends a UI event the map does not name");
  const stale = UI_EVENT_TYPES.filter((name) => !produced.has(name));
  assert.deepEqual(stale, [], "the map names a UI event no producer sends");
});

test("StudioCore.emit hands the renderer the name and payload unchanged", async () => {
  const heard: UiEvent[] = [];
  const { core } = await coreLite({ init: false, onUiEvent: (event) => heard.push(event) });
  core.emit("game.changed", { project: "pong", file: "src/main.js" });
  core.emit("engines.changed", {});
  assert.deepEqual(heard, [
    { type: "game.changed", payload: { project: "pong", file: "src/main.js" } },
    { type: "engines.changed", payload: {} },
  ]);
});

test("a harness notification is forwarded as it came, a name outside the map included", async () => {
  const heard: UiEvent[] = [];
  const { api } = await coreLite({ init: false, onUiEvent: (event) => heard.push(event) });
  const notify = api()["ui.notify"] as (p: { type: string; payload?: unknown }) => Promise<unknown>;
  assert.equal(await notify({ type: "run.settled", payload: { runId: "run-1" } }), true);
  await notify({ type: "harness.invented", payload: { note: 1 } });
  await notify({ type: "judge.panel" });
  assert.deepEqual(heard, [
    { type: "run.settled", payload: { runId: "run-1" } },
    { type: "harness.invented", payload: { note: 1 } },
    { type: "judge.panel", payload: null },
  ]);
});

test("a C++ build's progress and the toolchain install are the host's own: a harness-forwarded copy is dropped", async () => {
  for (const name of ["build.progress", "toolchain.install"]) {
    assert.equal(isUiEventType(name), true, name);
    assert.equal(isHostOnlyUiEvent(name), true, name);
  }
  for (const name of ["preview.frame", "judge.verdict", "harness.invented"])
    assert.equal(isHostOnlyUiEvent(name), false);
  const heard: UiEvent[] = [];
  const { api } = await coreLite({ init: false, onUiEvent: (event) => heard.push(event) });
  const notify = api()["ui.notify"] as (p: { type: string; payload?: unknown }) => Promise<unknown>;
  const progress = { project: "pong", target: "web", purpose: "live", phase: "done", at: 1 };
  const job = { phase: "installed", entry: null, completed: 4, total: 4, startedAt: "2026-10-01T00:00:00.000Z" };
  assert.equal(await notify({ type: "build.progress", payload: progress }), false);
  assert.equal(await notify({ type: "toolchain.install", payload: job }), false);
  assert.equal(await notify({ type: "run.settled", payload: { runId: "run-1" } }), true);
  assert.deepEqual(heard, [{ type: "run.settled", payload: { runId: "run-1" } }]);
});

test("a native run's status and log are the host's own: a harness-forwarded copy is dropped", async () => {
  for (const name of ["native.status", "native.log"]) {
    assert.equal(isUiEventType(name), true, name);
    assert.equal(isHostOnlyUiEvent(name), true, name);
  }
  const heard: UiEvent[] = [];
  const { api } = await coreLite({ init: false, onUiEvent: (event) => heard.push(event) });
  const notify = api()["ui.notify"] as (p: { type: string; payload?: unknown }) => Promise<unknown>;
  const status = {
    project: "pong",
    runId: "nr-1",
    target: "macos",
    state: "ready",
    mode: "window",
    pid: 4242,
    backend: "metal-angle",
    refusal: null,
    problem: null,
    exit: null,
    owner: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: null,
  };
  // A forged status would put a card on the stage; a forged log, lines no game printed.
  assert.equal(await notify({ type: "native.status", payload: status }), false);
  assert.equal(
    await notify({ type: "native.log", payload: { project: "pong", runId: "nr-1", lines: ["x"], truncated: false } }),
    false,
  );
  assert.deepEqual(heard, []);
});

test("the preload delivers every pushed event to onEvent unfiltered", () => {
  const listeners = new Set<(event: unknown, payload: UiEvent) => void>();
  const ipc: BridgeIpc = {
    invoke: async () => ({ ok: true, value: null }),
    on(channel, listener) {
      if (channel === "studio:event") listeners.add(listener as (event: unknown, payload: UiEvent) => void);
    },
    off(_channel, listener) {
      listeners.delete(listener as (event: unknown, payload: UiEvent) => void);
    },
  };
  const heard: UiEvent[] = [];
  const off = createStudioBridge(ipc).onEvent((event) => heard.push(event));
  const pushed = [
    uiEvent("chat.delta", { threadId: "t", streamId: "s", delta: "hi" }),
    harnessUiEvent("harness.invented", 1),
  ];
  for (const event of pushed) for (const listener of [...listeners]) listener({}, event);
  off();
  assert.equal(listeners.size, 0);
  assert.deepEqual(heard, pushed);
});

test("the guards: a known name, a UI event, a family of names", () => {
  assert.equal(isUiEventType("preview.frame"), true);
  assert.equal(isUiEventType("blender.asset"), false);
  assert.equal(isUiEventType("toString"), false);
  assert.equal(isUiEventType(42), false);
  assert.equal(isUiEvent({ type: "run.settled", payload: { runId: "r" } }), true);
  assert.equal(isUiEvent({ type: "run.settled" }), false);
  assert.equal(isUiEvent({ type: "harness.invented", payload: {} }), false);
  assert.equal(isUiEvent(null), false);
  assert.equal(isUiEvent("run.settled"), false);
  const chat = uiEvent("chat.error", { threadId: "t", message: "no" });
  assert.equal(isUiEventIn(chat, "chat."), true);
  assert.equal(isUiEventIn(chat, "skillopt."), false);
  assert.equal(new Set(UI_EVENT_TYPES).size, UI_EVENT_TYPES.length);
});

// Never called: these lines are checked by the typecheck only.
function typecheckOnly(core: StudioCore, event: UiEvent): void {
  core.emit("delegation.started", { project: "pong", engine: "codex", active: 1 });
  // @ts-expect-error a name outside the map
  core.emit("game.renamed", {});
  // @ts-expect-error a payload that is not its name's
  core.emit("run.summary.changed", { project: "pong" });
  // @ts-expect-error a required field missing
  core.emit("chat.stream.ended", { threadId: "t" });
  if (event.type === "preview.frame") {
    const jpeg: string = event.payload.jpeg;
    void jpeg;
  }
  if (isUiEventIn(event, "chat.")) {
    const thread: string | undefined = event.payload.threadId;
    void thread;
    // @ts-expect-error a chat event is not a preview event
    void (event.type === "preview.frame");
  }
  // @ts-expect-error the renderer can only compare against a name main can send
  void (event.type === "blender.asset");
}
void typecheckOnly;

/**
 * The IPC channel map (`src/shared/ipc-channels.ts`) is the one contract between the preload and
 * main. The type half is enforced by `npm run typecheck` (the `@ts-expect-error` lines below fail
 * the typecheck if a mismatch ever compiles); these tests pin the runtime half: the preload's
 * calls use exactly the map's channels, main registers exactly those, and the fixture policy
 * classifies them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";
import {
  STUDIO_INVOKE_CHANNELS,
  STUDIO_PUSH_CHANNELS,
  type StudioInvokeChannel,
  type StudioPushChannel,
} from "../../src/shared/ipc-channels.ts";
import { createStudioBridge, type BridgeIpc } from "../../src/preload/studio-bridge.ts";
import { createIpcHandle, pushToRenderer, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import {
  FIXTURE_BLOCKED_CHANNELS,
  FIXTURE_NATIVE_STEPS,
  FIXTURE_SAFE_CHANNELS,
} from "../../src/main/dev/native-policy.ts";
import { STUDIO_METHODS } from "../helpers/fake-studio-api.ts";
import { RUN_SUMMARY_SPACING_MS } from "../../src/shared/run-summary-feed.ts";
import type { StudioApi } from "../../src/shared/studio-api.ts";

const INVOKE = Object.keys(STUDIO_INVOKE_CHANNELS) as StudioInvokeChannel[];
const PUSH = Object.keys(STUDIO_PUSH_CHANNELS) as StudioPushChannel[];

/** A recorder standing in for `ipcRenderer`: every invoke answers `answer(channel)`. */
function rendererIpc(answer: (channel: string) => IpcResult = () => ({ ok: true, value: null })) {
  const invokes: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, Set<(event: unknown, payload: never) => void>>();
  const ipc: BridgeIpc = {
    async invoke(channel, payload) {
      invokes.push({ channel, payload });
      return answer(channel);
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener as (event: unknown, payload: never) => void);
      listeners.set(channel, set);
    },
    off(channel, listener) {
      listeners.get(channel)?.delete(listener as (event: unknown, payload: never) => void);
    },
  };
  const push = (channel: string, payload: unknown) => {
    for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, payload as never);
  };
  const count = (channel: string) => listeners.get(channel)?.size ?? 0;
  return { ipc, invokes, push, count };
}

/** Call one `StudioApi` method with no arguments (subscriptions get a listener); returns the unsubscribe, if any. */
function callBare(api: StudioApi, method: keyof StudioApi): unknown {
  if (method === "onRunSummary") return api.onRunSummary("pong", "run-1", () => {});
  if (method.startsWith("on")) return (api[method] as (listener: () => void) => () => void)(() => {});
  return (api[method] as () => Promise<unknown>)().catch(() => {});
}

test("every preload call invokes the channel the map names for it, and every channel has its call", async () => {
  const { ipc, invokes, count } = rendererIpc();
  const api = createStudioBridge(ipc);
  const methodOf = new Map<string, string>(Object.entries(STUDIO_INVOKE_CHANNELS));
  const pushOf = new Map<string, string>(Object.entries(STUDIO_PUSH_CHANNELS));
  const used = new Set<string>();
  for (const method of STUDIO_METHODS) {
    const before = invokes.length;
    const unsubscribe = callBare(api, method);
    await new Promise((resolve) => setImmediate(resolve));
    const channels = invokes.slice(before).map((call) => call.channel);
    for (const channel of channels) used.add(channel);
    if (method === "onRunSummary") {
      // A summary subscription reads the summary once and re-reads it on `studio:event`.
      assert.deepEqual(channels, ["studio:run.summary"], method);
      assert.equal(count("studio:event"), 1, method);
    } else if (method.startsWith("on")) {
      assert.deepEqual(channels, [], method);
      const channel = PUSH.find((push) => pushOf.get(push) === method);
      assert.ok(channel, `${method} subscribes to no push channel of the map`);
      assert.equal(count(channel), 1, method);
    } else {
      const [channel = "", ...more] = channels;
      assert.deepEqual(more, [], `${method} should invoke exactly one channel`);
      assert.equal(
        methodOf.get(channel),
        method,
        `${method} invoked ${channel || "nothing"}, which the map gives to ${methodOf.get(channel)}`,
      );
    }
    if (typeof unsubscribe === "function") unsubscribe();
  }
  assert.deepEqual(
    [...used].sort(),
    [...INVOKE].sort(),
    "a channel of the map that no preload call uses, or the reverse",
  );
  for (const channel of PUSH) assert.equal(count(channel), 0, `${channel} listener left subscribed`);
});

test("the preload unwraps main's envelope: a value resolves, an error rejects with main's message", async () => {
  const { ipc } = rendererIpc((channel) =>
    channel === "studio:games" ? { ok: true, value: [{ name: "pong" }] } : { ok: false, error: "title taken" },
  );
  const api = createStudioBridge(ipc);
  assert.deepEqual(await api.games(), [{ name: "pong" }]);
  await assert.rejects(api.createGame("Pong"), { message: "title taken" });
});

test("the preload sends each payload in the shape main reads", async () => {
  const { ipc, invokes } = rendererIpc();
  const api = createStudioBridge(ipc);
  await api.bootstrap();
  await api.newGameThread();
  await api.newGameThread("pong");
  await api.reloadPreview();
  await api.mcpList(null);
  await api.revealProject("pong");
  await api.adoptFolder("/games/pong", { subdir: "web" });
  await api.createGame("Pong");
  await api.createGame("Pong", { parent: "/Users/me/Projects" });
  await api.pickGameLocation();
  await api.pickProject();
  await api.send("hi", { thread: "t1" });
  await api.cancelModelDownload();
  await api.recheckEngines();
  await api.pluginChooseFile("unreal", { title: "Choose a project", extensions: ["uproject"] });
  assert.deepEqual(invokes, [
    { channel: "studio:bootstrap", payload: undefined },
    { channel: "studio:thread.new", payload: {} },
    { channel: "studio:thread.new", payload: { project: "pong" } },
    { channel: "studio:preview.reload", payload: { retry: false } },
    { channel: "studio:mcp.list", payload: null },
    { channel: "studio:reveal-project", payload: { project: "pong" } },
    { channel: "studio:project.adopt", payload: { dir: "/games/pong", subdir: "web" } },
    { channel: "studio:game.create", payload: { title: "Pong" } },
    { channel: "studio:game.create", payload: { title: "Pong", parent: "/Users/me/Projects" } },
    { channel: "studio:game.location.pick", payload: undefined },
    { channel: "studio:project.pick", payload: undefined },
    { channel: "studio:send", payload: { text: "hi", thread: "t1" } },
    { channel: "studio:cancel-model-download", payload: {} },
    { channel: "studio:engines.recheck", payload: {} },
    {
      channel: "studio:plugins.choose-file",
      payload: { id: "unreal", request: { title: "Choose a project", extensions: ["uproject"] } },
    },
  ]);
});

test("push channels reach the matching subscription, and a summary subscription re-reads on its run's event", async (t) => {
  let reads = 0;
  const { ipc, push } = rendererIpc((channel) =>
    channel === "studio:run.summary" ? { ok: true, value: { read: ++reads } } : { ok: true, value: null },
  );
  const api = createStudioBridge(ipc);
  const heard: unknown[] = [];
  const offEvent = api.onEvent((event) => heard.push(["event", event.type]));
  const offTerminal = api.onTerminal((event) => heard.push(["terminal", event.type]));
  const offClaude = api.onClaudeLogin((state) => heard.push(["claude", state]));
  const offCodex = api.onCodexLogin((state) => heard.push(["codex", state.phase]));
  push("studio:event", { type: "game.changed", payload: {} });
  push("studio:terminal", { type: "removed", id: "t" });
  push("studio:claude-login", "state");
  push("studio:codex-login", { phase: "waiting" });
  assert.deepEqual(heard, [
    ["event", "game.changed"],
    ["terminal", "removed"],
    ["claude", "state"],
    ["codex", "waiting"],
  ]);
  for (const off of [offEvent, offTerminal, offClaude, offCodex]) off();

  // Re-reads of one run are spaced (shared/run-summary-feed.ts); the test's clock decides when.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const summaries: unknown[] = [];
  const off = api.onRunSummary("pong", "run-1", (summary) => summaries.push(summary));
  await settle();
  push("studio:event", { type: "run.summary.changed", payload: { runId: "run-2" } });
  push("studio:event", { type: "run.summary.changed", payload: "run-1" });
  t.mock.timers.tick(RUN_SUMMARY_SPACING_MS);
  await settle();
  // A listener always gets the whole graph; the reply held none.
  const read = (n: number) => ({ read: n, graphEvents: [] });
  assert.deepEqual(summaries, [read(1)], "another run's event, or a payload that names no run, reads nothing");
  push("studio:event", { type: "run.summary.changed", payload: { runId: "run-1" } });
  t.mock.timers.tick(RUN_SUMMARY_SPACING_MS);
  await settle();
  push("studio:event", { type: "preview.identity", payload: null });
  t.mock.timers.tick(RUN_SUMMARY_SPACING_MS);
  await settle();
  // A preview change patches the summary it names at once; it reads nothing.
  assert.deepEqual(summaries, [read(1), read(2), { ...read(2), preview: null }]);
  off();
});

test("main pushes through the same channel names the preload subscribes to", () => {
  const sent: unknown[][] = [];
  const target = {
    send: (...args: unknown[]) => {
      sent.push(args);
    },
  };
  pushToRenderer(target, "studio:event", { type: "game.changed", payload: {} });
  pushToRenderer(target, "studio:terminal", { type: "accessibility", enabled: true });
  // @ts-expect-error a push payload must be the subscribing listener's argument
  pushToRenderer(target, "studio:terminal", { type: "accessibility" });
  // @ts-expect-error a push channel must be one the preload subscribes to
  pushToRenderer(target, "studio:brand-new", {});
  assert.deepEqual(sent.slice(0, 2), [
    ["studio:event", { type: "game.changed", payload: {} }],
    ["studio:terminal", { type: "accessibility", enabled: true }],
  ]);
});

test("a handler that disagrees with the preload about a payload or a result does not compile", async () => {
  const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
  const handle = createIpcHandle(
    {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
    },
    { fixture: false, isStudioUi: () => true },
  );
  // @ts-expect-error the preload sends { threadId: string }
  handle("studio:cancel", (payload: { threadId: number }) => payload.threadId > 0);
  // @ts-expect-error studio:cancel answers cancelTurn's boolean
  handle("studio:cancel", () => "cancelled");
  // @ts-expect-error studio:send carries the text, not a thread id alone
  handle("studio:send", (payload: { threadId: string }) => payload.threadId === "");
  handle("studio:cancel", (payload) => payload.threadId === "t1");
  const cancel = listeners.get("studio:cancel");
  assert.ok(cancel);
  assert.deepEqual(await cancel({ sender: null, senderFrame: null }, { threadId: "t1" }), { ok: true, value: true });
});

test("the fixture policy classifies exactly the map's channels, plus the named native steps", () => {
  const classified = [...FIXTURE_SAFE_CHANNELS, ...FIXTURE_BLOCKED_CHANNELS].filter(
    (channel) => !FIXTURE_NATIVE_STEPS.has(channel),
  );
  assert.deepEqual(classified.sort(), [...INVOKE].sort());
  for (const step of FIXTURE_NATIVE_STEPS) {
    assert.ok(FIXTURE_BLOCKED_CHANNELS.has(step), step);
    assert.ok(!(step in STUDIO_INVOKE_CHANNELS), `${step} is a channel of the map; classify it as one`);
  }
});

/**
 * Contract: main registers every channel of the map exactly once. `main/index.ts` and the domain
 * registrars in `main/ipc/` import Electron, so they are parsed as data here — the `studio:*`
 * literals handed to `handle(...)` — and nothing about their implementation text is asserted.
 */
test("contract: main registers a handler for every channel of the map, and only those", () => {
  const mainDir = path.resolve(import.meta.dirname, "../../src/main");
  const files = [
    path.join(mainDir, "index.ts"),
    ...readdirSync(path.join(mainDir, "ipc"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(mainDir, "ipc", name)),
  ];
  const program = ts.createProgram(files, {
    noResolve: true,
    noLib: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  });
  const registered: string[] = [];
  const pushed: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [first, second] = node.arguments;
      if (
        node.expression.text === "handle" &&
        first &&
        ts.isStringLiteralLike(first) &&
        first.text.startsWith("studio:")
      )
        registered.push(first.text);
      if (node.expression.text === "pushToRenderer" && second && ts.isStringLiteralLike(second))
        pushed.push(second.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "send"
    ) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first) && first.text.startsWith("studio:"))
        pushed.push(`raw send ${first.text}`);
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) {
    const source = program.getSourceFile(file);
    assert.ok(source, path.relative(mainDir, file));
    visit(source);
  }
  // A scan that found nothing would pass vacuously; main registers over a hundred channels.
  assert.ok(registered.length > 100, `only ${registered.length} registrations found — has the scan stopped matching?`);
  assert.deepEqual(
    registered.filter((channel, i) => registered.indexOf(channel) !== i),
    [],
    "a channel registered twice",
  );
  assert.deepEqual([...registered].sort(), [...INVOKE].sort());
  assert.deepEqual(
    [...new Set(pushed)].sort(),
    [...PUSH].sort(),
    "main pushes through pushToRenderer on every push channel, never a raw send",
  );
});

test("run summary watchers share one read and release their listener after the last subscriber", async () => {
  const { ipc, invokes, count } = rendererIpc(() => ({ ok: true, value: { project: "pong", runId: "run-1" } }));
  const api = createStudioBridge(ipc);
  const a: unknown[] = [];
  const b: unknown[] = [];
  const offA = api.onRunSummary("pong", "run-1", (value) => a.push(value));
  const offB = api.onRunSummary("pong", "run-1", (value) => b.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invokes.length, 1);
  assert.equal(count("studio:event"), 1);
  assert.deepEqual(a, b);
  offA();
  assert.equal(count("studio:event"), 1);
  offB();
  assert.equal(count("studio:event"), 0);
});

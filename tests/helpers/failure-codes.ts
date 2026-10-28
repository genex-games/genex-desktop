/**
 * Hostile inputs for the analytics failure-code suites (`analytics-failure-codes*.test.ts`): words,
 * paths, Node codes and ids a failure may carry, none of which may reach an event property, and a
 * failure carried across IPC exactly as the app carries it (main's `handle`, then the preload).
 */
import assert from "node:assert/strict";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { createStudioBridge } from "../../src/preload/studio-bridge.ts";
import { EngineId } from "../../src/shared/providers.ts";
import type { EventProperties } from "../../src/renderer/analytics/properties.ts";

/** A thread id, as a failure might quote one. */
export const HOSTILE_THREAD = "thread-5b7e21";

/** Words, paths, Node codes and ids a failure may carry: none may leave in a property. */
export const HOSTILE = [
  "/Users/alice/Secret Game",
  "C:\\Users\\alice\\game",
  "file:///Users/alice/x.png",
  "ENOENT",
  "EACCES: permission denied, open '/Users/alice/.claude.json'",
  "Your usage limit resets at 5pm",
  "Invalid API key · Please run /login",
  "Could not answer this message: fetch failed",
  "http://10.0.0.7:11434",
  "sk-or-v1-0123456789abcdef",
  HOSTILE_THREAD,
];

/** Every string a property holds, arrays included. */
function strings(properties: EventProperties): string[] {
  return Object.values(properties).flatMap((value) => {
    if (typeof value === "string") return [value];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  });
}

/** Nothing hostile leaves, whole or in part. */
export function assertClean(label: string, properties: EventProperties): void {
  for (const value of strings(properties))
    for (const hostile of HOSTILE) assert.ok(!value.includes(hostile), `${label} leaks ${JSON.stringify(value)}`);
}

/** Thrown values whose `code` is not one of the app's: each must read as no code at all. */
export const HOSTILE_THROWS: ReadonlyArray<[string, unknown]> = [
  [
    "a Node error",
    Object.assign(new Error("ENOENT: no such file, open '/Users/alice/Secret Game'"), { code: "ENOENT" }),
  ],
  ["a path as code", Object.assign(new Error("failed"), { code: "/Users/alice/Secret Game" })],
  ["words as code", { message: "x", code: "Your usage limit resets at 5pm" }],
  ["a number as code", { code: 401 }],
  ["a string", "busy"],
  ["null", null],
  ["undefined", undefined],
  ["a plain error", new Error("Invalid API key · Please run /login")],
  ["an address as code", Object.assign(new Error("failed"), { code: "game://orchard/index.html" })],
  ["a signal as code", Object.assign(new Error("killed"), { code: "SIGKILL" })],
  ["a retired spelling as code", Object.assign(new Error("gone"), { code: "not-found" })],
];

/** What the renderer catches when main's handler throws `thrown`: through `ipc-handle` and the preload, as in the app. */
export async function crossed(thrown: unknown): Promise<unknown> {
  const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => listeners.set(channel, listener) },
    { fixture: false, isStudioUi: () => true },
  );
  handle("studio:cli-install.start", () => {
    throw thrown;
  });
  const invoke = listeners.get("studio:cli-install.start");
  assert.ok(invoke);
  const sender = { sender: "studio", senderFrame: "main-frame" };
  const bridge = createStudioBridge({
    invoke: (_channel, payload) => invoke(sender, payload),
    on: () => undefined,
    off: () => undefined,
  });
  return bridge.cliInstall(EngineId.Codex).then(
    () => assert.fail("the handler threw"),
    (err: unknown) => err,
  );
}

/** What main's call rejected with, after crossing IPC as the renderer would catch it. */
export async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  const thrown = await call.then(
    () => assert.fail("expected a refusal"),
    (err: unknown) => err,
  );
  return crossed(thrown);
}

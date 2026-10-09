/**
 * Harness call deadlines (B4): a host call nobody answers used to keep the harness awaiting it
 * forever, and the watchdog stays quiet while any call is in flight, so one game page whose
 * `state()` never returned froze a whole run unnoticed. Every call now has a class, and a class
 * with a deadline is answered with `RpcDeadline` once it passes (`substrate/rpc-deadlines.ts`).
 * These cases are about the host's bookkeeping, not containment, so the harness runs unsandboxed.
 */
import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { EventStore } from "../../src/substrate/event-store.ts";
import { HarnessHost } from "../../src/substrate/harness-host.ts";
import { RPC_CLASSES, RpcClass, rpcDeadlineMs } from "../../src/substrate/rpc-deadlines.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BOOTSTRAP = fileURLToPath(new URL("../../src/harness-boot/bootstrap.mjs", import.meta.url));
const FIXTURE_OK = fileURLToPath(new URL("../fixtures/harness-ok", import.meta.url));

/** The harness asks for the page's state, and logs how the call ended. */
const ASKS_THE_PAGE = `export async function createStudio(host) {
  return {
    status: () => "idle",
    healthcheck: async () => ({ ok: true }),
    async dispatch(action) {
      if (action.type !== "user_message") return;
      let outcome;
      try {
        outcome = { value: await host.call("preview.state", {}) };
      } catch (err) {
        outcome = { name: err.name, code: err.code, method: err.method };
      }
      await host.call("events.append", {
        threadId: action.threadId,
        batch: [{ type: "custom", event_type: "page_answered", payload: outcome }],
      });
    },
  };
}`;

/** A harness over a page that answers `preview.state` only when told to, with a deadline for page calls. */
async function hungPage(deadlineMs: number | null = 800) {
  const root = await tmpDir("studio-rpc-deadline-");
  const workspace = path.join(root, "workspaces", "harness");
  await mkdir(path.dirname(workspace), { recursive: true });
  await cp(FIXTURE_OK, workspace, { recursive: true });
  await writeFile(path.join(workspace, "loop", "main.mjs"), ASKS_THE_PAGE);
  const store = await EventStore.open(path.join(root, "exoharness"), "studio");
  const thread = await store.createThread({ title: "deadline" });
  const waiting: Array<(value: unknown) => void> = [];
  const sandbox = await ProcessSandbox.create({
    writableRoots: [root],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    enabled: false,
  });
  const host = new HarnessHost({
    workspace,
    bootstrap: BOOTSTRAP,
    execPath: process.execPath,
    sandbox,
    updatesDir: path.join(root, "updates"),
    api: {
      "events.head": async (params: { threadId: string }) => store.head(params.threadId),
      "events.append": async (params: { threadId: string; batch: never }) =>
        (await store.appendEvents(params.threadId, params.batch)).latestEventId,
      "preview.state": () =>
        new Promise<unknown>((resolve) => {
          waiting.push(resolve);
        }),
    },
    rpcDeadlineMs: (method) => (method === HostMethod.PreviewState ? deadlineMs : null),
  });
  /** Answer the oldest `preview.state` call still waiting. */
  const release = (value: unknown) => waiting.shift()?.(value);
  const answers = async () =>
    (await store.listEvents(thread)).flatMap((event) =>
      event.data.type === "custom" && event.data.event_type === "page_answered" ? [event.data.payload] : [],
    );
  return { host, store, thread, release, answers };
}

describe("harness call deadlines (B4)", () => {
  it("a page call past its deadline answers the harness with RpcDeadline, and the harness goes on", async () => {
    const r = await hungPage();
    await r.host.start();
    const asked = r.host.dispatch({ type: "user_message", threadId: r.thread, text: "look" }, 15_000);
    await sleep(300);
    assert.deepEqual(
      r.host.pendingRpcs().map((call) => call.method),
      [HostMethod.PreviewState],
      "the host names the call it is still servicing",
    );
    await asked;
    assert.deepEqual(await r.answers(), [
      { name: "RpcDeadline", code: "rpc_deadline", method: HostMethod.PreviewState },
    ]);
    assert.deepEqual(r.host.pendingRpcs(), [], "a timed-out call no longer counts as in flight");
    r.release({ late: true });
    await sleep(100);
    assert.equal(r.host.state, "ready", "a late answer is dropped, not sent twice");
    await r.host.stop();
  });

  it("an answer for a harness that has since restarted never reaches the new one", async () => {
    const r = await hungPage(null);
    await r.host.start();
    void r.host.dispatch({ type: "user_message", threadId: r.thread, text: "look" }).catch(() => {});
    await sleep(300);
    await r.host.restart();
    assert.deepEqual(r.host.pendingRpcs(), [], "the exited self's calls no longer mute the watchdog");
    const asked = r.host.dispatch({ type: "user_message", threadId: r.thread, text: "look again" }, 15_000);
    await sleep(300);
    r.release("stale"); // the old self's call, with the same RPC id as the new self's
    await sleep(200);
    r.release("fresh");
    await asked;
    assert.deepEqual(await r.answers(), [{ value: "fresh" }]);
    await r.host.stop();
  });

  it("page and record calls have deadlines; engine work, runs and snapshots bound themselves", () => {
    for (const method of [HostMethod.PreviewState, HostMethod.PreviewEvaluate, HostMethod.PreviewCall]) {
      assert.equal(RPC_CLASSES[method], RpcClass.Page, method);
      assert.ok((rpcDeadlineMs(method) ?? 0) > 0, method);
    }
    for (const method of [HostMethod.EventsList, HostMethod.ArtifactRead, HostMethod.GameRead]) {
      assert.ok((rpcDeadlineMs(method) ?? 0) > 0, method);
    }
    for (const method of [HostMethod.EngineDelegate, HostMethod.EngineComplete, HostMethod.RunExec]) {
      assert.equal(rpcDeadlineMs(method), null, method);
    }
    assert.ok(
      (rpcDeadlineMs(HostMethod.PreviewReady) ?? 0) > (rpcDeadlineMs(HostMethod.PreviewState) ?? 0),
      "loading a page may take longer than asking it something",
    );
  });
});

/**
 * The harness → host RPC contract (`src/shared/harness-api.ts`).
 *
 * The harness is agent-editable JavaScript, so its params are checked where its messages arrive:
 * `HarnessHost` refuses a path-bearing call whose params have the wrong shape before the handler
 * runs, and passes every other call through exactly as it was sent. These tests drive a real
 * `HarnessHost` over a fake child's pipes — the same line protocol the sandboxed process speaks —
 * and hold `StudioCore.api()` to the method map at compile time.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { z } from "zod";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  HARNESS_PARAM_SCHEMAS,
  harnessParamsProblem,
  type HarnessHostHandlers,
  type HarnessParams,
  type PathBearingMethod,
} from "../../src/shared/harness-api.ts";
import { encode, LineCodec, type RpcResponse } from "../../src/shared/protocol.ts";
import { HarnessHost } from "../../src/substrate/harness-host.ts";
import type { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** A child process as `HarnessHost` sees it: three pipes, a pid it never needs, and an exit. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    kill(signal: string) {
      setImmediate(() => child.emit("exit", null, signal));
      return true;
    },
  });
  return child;
}

interface Pipe {
  host: HarnessHost;
  calls: Array<{ method: string; params: unknown }>;
  rpc(method: string, params: unknown): Promise<RpcResponse>;
  stop(): Promise<void>;
}

/** A started host whose every api method records the params it received and answers "handled". */
async function pipe(methods: string[]): Promise<Pipe> {
  const child = fakeChild();
  const calls: Pipe["calls"] = [];
  const api = Object.fromEntries(
    methods.map((method) => [
      method,
      async (params: unknown) => {
        calls.push({ method, params });
        return "handled";
      },
    ]),
  );
  const sandbox = { spawnLongLived: async () => ({ child, sandboxed: false }) } as unknown as ProcessSandbox;
  const host = new HarnessHost({
    workspace: "/nowhere",
    bootstrap: "/nowhere/bootstrap.mjs",
    execPath: process.execPath,
    sandbox,
    api,
    updatesDir: "/nowhere/updates",
    // The fake child speaks only stdio; a Windows host would answer over its loopback inbox.
    platform: StudioPlatform.Linux,
  });
  const answers = new Map<number, (response: RpcResponse) => void>();
  const codec = new LineCodec();
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const message of codec.push<{ kind: string; id: number }>(chunk)) {
      if (message.kind === "rpc-result") answers.get(message.id)?.(message as RpcResponse);
    }
  });
  const started = host.start();
  child.stdout.write(encode({ kind: "ready", harnessVersion: "test", capabilities: [] }));
  await started;
  let nextId = 1;
  return {
    host,
    calls,
    rpc(method, params) {
      const id = nextId++;
      const answered = new Promise<RpcResponse>((resolve) => answers.set(id, resolve));
      child.stdout.write(encode({ kind: "rpc", id, method, params }));
      return answered;
    },
    stop: () => host.stop(50),
  };
}

const PATH_BEARING = Object.keys(HARNESS_PARAM_SCHEMAS) as PathBearingMethod[];

test("malformed params for a path-bearing method are refused with a clear error before the handler runs", async () => {
  const harness = await pipe(PATH_BEARING);
  try {
    const refusals: Array<[string, unknown, string]> = [
      ["game.read", { project: "pong", file: 42 }, "file"],
      ["game.write", { project: "pong", contents: "x" }, "file"],
      ["game.read", { file: "src/main.js" }, "project"],
      ["snapshot.removeWorktree", { project: "pong", path: { toString: "/" } }, "path"],
      ["snapshot.worktree", { project: "pong", name: 7 }, "name"],
      ["preview.load", { project: "pong", root: ["/etc"] }, "root"],
      ["game.export", { project: "pong", target: 1 }, "target"],
      ["run.exec", { command: "ls", cwd: false }, "cwd"],
      [
        "engine.delegate",
        { project: "pong", prompt: "go", selfCapture: { project: "pong", root: 5 } },
        "selfCapture.root",
      ],
      ["engine.delegate", { project: "pong", prompt: "go", extraReads: ["/refs", 3] }, "extraReads.1"],
      ["preview.pair", { runId: "r1", left: { path: 9 }, right: {} }, "left.path"],
      ["run.artifact", { runId: "r1", name: null, base64: "" }, "name"],
      ["game.scaffold", undefined, "params"],
      ["game.start", { project: "pong", starter: "Web" }, "starter"],
      ["game.start", { project: "pong", starter: "../web" }, "starter"],
      ["game.start", { project: "pong" }, "starter"],
      ["game.start", { starter: "web" }, "project"],
      ["game.start", { project: "pong", starter: "web", threadId: 7 }, "threadId"],
      ["game.start", { project: "pong", starter: "web", threadId: { id: "chat" } }, "threadId"],
      ["plugins.suggest", { project: "pong", plugin: "unreal" }, "threadId"],
      ["plugins.suggest", { project: "pong", plugin: "unreal", threadId: 7 }, "threadId"],
      ["plugins.tools", { project: 7 }, "project"],
      ["plugins.find", { project: ["/"] }, "project"],
      ["mcp.tools", { project: { toString: "/" } }, "project"],
      // A worker grant decides whether a session is seated in the chat's mode: refused whole when malformed.
      ["engine.delegate", { project: "pong", prompt: "go", worker: "w1" }, "worker"],
      ["engine.delegate", { project: "pong", prompt: "go", worker: { id: 7, title: "x" } }, "worker.id"],
      ["engine.delegate", { project: "pong", prompt: "go", worker: { id: "w1" } }, "worker.title"],
      [
        "engine.delegate",
        { project: "pong", prompt: "go", worker: { id: "w1", title: "x", research: "yes" } },
        "worker.research",
      ],
      [
        "engine.delegate",
        { project: "pong", prompt: "go", worker: { id: "w1", title: "x", runId: 3 } },
        "worker.runId",
      ],
      // A reviewer's run and the folder it reads are paths the host places: refused whole when malformed.
      ["engine.delegate", { project: "pong", prompt: "go", reviewer: "run" }, "reviewer"],
      [
        "engine.delegate",
        { project: "pong", prompt: "go", reviewer: { runId: "../x", reads: "/g" } },
        "reviewer.runId",
      ],
      ["engine.delegate", { project: "pong", prompt: "go", reviewer: { runId: "a/b", reads: "/g" } }, "reviewer.runId"],
      [
        "engine.delegate",
        { project: "pong", prompt: "go", reviewer: { runId: "r", reads: "x".repeat(1025) } },
        "reviewer.reads",
      ],
      ["engine.delegate", { project: "pong", prompt: "go", reviewer: { runId: "r" } }, "reviewer.reads"],
      ["plugins.workerTypes", { project: 7 }, "project"],
      ["plugins.workerTypes", {}, "project"],
      ["jobs.list", { project: ["/"] }, "project"],
      ["jobs.list", { project: "pong", runId: 7 }, "runId"],
      ["jobs.list", { project: "pong", endedAfter: "3" }, "endedAfter"],
    ];
    for (const [method, params, field] of refusals) {
      const answer = await harness.rpc(method, params);
      assert.equal(answer.ok, false, method);
      assert.equal(answer.error?.name, "InvalidParams", method);
      assert.match(
        answer.error?.message ?? "",
        new RegExp(`^invalid params for ${method.replace(".", "\\.")}: `),
        method,
      );
      const data = answer.error?.data as { method: string; issues: Array<{ path: string }> } | undefined;
      assert.equal(data?.method, method);
      const issues = data?.issues ?? [];
      assert.ok(
        issues.some((issue) => issue.path === field),
        `${method}: ${JSON.stringify(issues)} names ${field}`,
      );
    }
    assert.deepEqual(harness.calls, [], "no refused call reached a handler");
  } finally {
    await harness.stop();
  }
});

test("a well-formed call reaches its handler with the params exactly as the harness sent them", async () => {
  const harness = await pipe([...PATH_BEARING, "preview.state", "engine.abort"]);
  try {
    // Shapes the seed sends today, including fields the schema does not check and the nulls a
    // handler reads as "not given".
    const accepted: Array<[string, unknown]> = [
      ["game.read", { project: "pong", file: "NOTES.md" }],
      ["game.export", { project: "pong", candidateId: "opt-1" }],
      ["mcp.tools", { project: null }],
      ["snapshot.worktree", { project: "pong", commit: null, name: "integration", runId: "run-1" }],
      ["preview.load", { project: "pong", root: null, entry: "index.html", handle: "stage-1" }],
      [
        "preview.pair",
        {
          runId: "r1",
          left: { base64: "AAAA", mimeType: "image/png" },
          right: { path: "/runs/r1/a.jpg" },
          label: "pair",
        },
      ],
      ["preview.statsOf", undefined],
      [
        "engine.delegate",
        {
          project: "pong",
          prompt: "go",
          cwd: "/scratch/w1",
          selfCapture: { project: "pong", root: "/scratch/w1", runId: "r1", facetId: "build", iteration: 1 },
        },
      ],
      ["game.setCover", { project: "pong", threadId: "t1", family: "dunes", palette: "dusk", seed: 3 }],
      ["game.start", { project: "pong", starter: "web", threadId: "t1" }],
      [
        "engine.delegate",
        {
          project: "pong",
          prompt: "go",
          cwd: "/scratch/w1",
          worker: { id: "w1", title: "Scene builder", runId: "r1", research: true },
        },
      ],
      ["engine.delegate", { project: "pong", prompt: "go", worker: { id: "w2", title: "Reader", turn: "msg-1" } }],
      ["plugins.workerTypes", { project: "pong" }],
      ["jobs.list", { project: "pong", runId: "r1", endedAfter: 3 }],
      ["jobs.list", { project: "pong", runId: null }],
      // Not path-bearing: nothing is checked, whatever arrives.
      ["preview.state", 5],
      // Stop is never refused on its params.
      ["engine.abort", { cwd: 42 }],
    ];
    for (const [method, params] of accepted) {
      const answer = await harness.rpc(method, params);
      assert.deepEqual(answer, { kind: "rpc-result", id: answer.id, ok: true, value: "handled" }, method);
    }
    assert.deepEqual(
      harness.calls,
      accepted.map(([method, params]) => ({ method, params })),
    );
  } finally {
    await harness.stop();
  }
});

test("an unknown method is still answered as unknown, before any params check", async () => {
  const harness = await pipe(["game.read"]);
  try {
    const answer = await harness.rpc("game.delete", { project: 1 });
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.name, "UnknownMethod");
  } finally {
    await harness.stop();
  }
});

test("every params schema names a method the core serves, and stop control is deliberately unchecked", async () => {
  const { api } = await coreLite({ init: false });
  const served = new Set(Object.keys(api()));
  for (const method of PATH_BEARING) assert.ok(served.has(method), method);
  assert.ok(PATH_BEARING.length >= 30, `only ${PATH_BEARING.length} path-bearing methods`);
  for (const method of ["engine.abort", "engine.interrupt"])
    assert.equal(harnessParamsProblem(method, { cwd: 1 }), null, method);
  assert.equal(harnessParamsProblem("not.a.method", { project: 1 }), null);
});

// ── compile-time contract: checked by the typecheck, never called ─────────────────────────────

/** Every schema accepts every params value its method's type allows: no typed call is refused. */
type SchemaAccepts = {
  [K in PathBearingMethod]: HarnessParams<K> extends z.input<(typeof HARNESS_PARAM_SCHEMAS)[K]> ? true : false;
};
type EverySchemaAccepts = false extends SchemaAccepts[PathBearingMethod] ? false : true;
const everySchemaAcceptsItsType: EverySchemaAccepts = true;
void everySchemaAcceptsItsType;

function typecheckOnly(api: HarnessHostHandlers): void {
  // Params and results come from the map.
  const url: Promise<string> = api["preview.load"]({ project: "pong" });
  const tree: Promise<string[]> = api["game.tree"]({ project: "pong" });
  void url;
  void tree;
  // @ts-expect-error: game.read needs the file it reads
  void api["game.read"]({ project: "pong" });
  // @ts-expect-error: a folder is a string, never a number
  void api["snapshot.removeWorktree"]({ project: "pong", path: 1 });
  // @ts-expect-error: preview.load answers a URL, not a boolean
  const wrong: Promise<boolean> = api["preview.load"]({ project: "pong" });
  void wrong;
  // @ts-expect-error: no such method
  void api["game.delete"];
}
void typecheckOnly;

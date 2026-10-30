import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import {
  NativeJobState,
  NativeRuntimeState,
  PluginService,
  type PluginManifest,
  type PluginNativeResult,
} from "../../src/shared/plugins.ts";
import {
  NativeCleanupError,
  type NativeProcessRequest,
  type NativeProcessResult,
} from "../../src/substrate/plugins/native-process.ts";
import { tmpDir } from "../helpers/tmp.ts";

function manifest(): PluginManifest {
  return {
    apiVersion: 3,
    id: "background-test",
    name: "Background test",
    version: "1.0.0",
    publisher: "Test",
    description: "Synthetic native worker",
    backend: "backend.mjs",
    capabilities: ["native-runtime"],
    tools: [],
    actions: [],
    panels: [],
    skills: [],
    settings: [],
    nativeRuntimes: [
      {
        id: "worker",
        label: "Worker",
        candidates: ["/worker"],
        version: { args: [], pattern: "(1.0.0)", minimum: "1.0.0" },
      },
    ],
    nativeJobs: [
      {
        id: "make",
        runtime: "worker",
        args: [{ source: "output", name: "result.txt" }],
        inputs: [],
        values: {},
        outputs: ["result.txt"],
        timeoutMs: 2100000,
        maxOutputBytes: 1000,
        maxAssetBytes: 4096,
        gpu: true,
      },
    ],
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext) {
  const root = await tmpDir("native-background-");
  const game = path.join(root, "game");
  await mkdir(game);
  const started = deferred<NativeProcessRequest>();
  const ended = deferred<NativeProcessResult>();
  const finished = deferred<void>();
  const requests: NativeProcessRequest[] = [];
  const run = async (request: NativeProcessRequest) => {
    requests.push(request);
    started.resolve(request);
    return ended.promise;
  };
  const service = new PluginNativeServices(root, [], { runProcess: run });
  service.detect = async () => ({
    state: NativeRuntimeState.Ready,
    path: "/worker",
    version: "1.0.0",
    detail: "Ready",
  });
  const storage = path.join(root, "storage");
  const binding = { project: "game", directory: game };
  const controller = new AbortController();
  const spec = manifest();
  const events: PluginNativeResult[] = [];
  const call = (method: string, args: unknown, own = binding, at = storage) =>
    service.call(
      spec,
      root,
      at,
      method,
      args,
      own,
      { method: "tool", name: "make", signal: controller.signal },
      (event) => {
        const record = event as PluginNativeResult;
        events.push(record);
        if (record.state !== NativeJobState.Running) finished.resolve();
      },
    );
  t.after(async () => {
    ended.resolve({ code: null, signal: null, stdout: "", stderr: "", reason: "cancelled", pid: null });
    await service.stop();
  });
  return { root, storage, spec, service, started, ended, finished, binding, controller, call, events, requests };
}

test("native manifests allow the uniform 35-minute ceiling and reject any excess", () => {
  const spec = manifest();
  assert.equal(validateManifest(spec).nativeJobs?.[0]?.timeoutMs, 2100000);
  const job = spec.nativeJobs?.[0];
  assert.ok(job);
  for (const timeout of [2100001, 0, 999, NaN, Infinity, 1000.5]) {
    job.timeoutMs = timeout;
    assert.throws(() => validateManifest(spec), /timeoutMs/);
  }
});

test("background run returns its durable id, survives the invocation, and uses existing result records", async (t) => {
  const f = await fixture(t);
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  assert.deepEqual(Object.keys(answer), ["id"]);
  const request = await f.started.promise;
  assert.equal(request.timeoutMs, 2100000);
  assert.equal(request.gpu, true);
  const recordFile = path.join(f.storage, "native-jobs", answer.id, "job.json");
  const initial = JSON.parse(await readFile(recordFile, "utf8"));
  assert.equal(initial.state, NativeJobState.Running);
  f.controller.abort();
  assert.equal(request.signal.aborted, false, "the tool ending does not cancel a background job");
  await writeFile(request.args[0], "asset");
  f.ended.resolve({ code: 0, signal: null, stdout: "ok", stderr: "", reason: "exit", pid: null });
  await f.finished.promise;
  const result = (await f.call(PluginService.NativeResult, { id: answer.id })) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Completed);
  assert.deepEqual(result.files, ["result.txt"]);
  assert.equal(await readFile(path.join(result.output, "result.txt"), "utf8"), "asset");
  assert.deepEqual(await f.call(PluginService.NativeJobs, {}), [result]);
});

test("foreground execution stays capped at five minutes and invocation abort cancels it", async (t) => {
  const f = await fixture(t);
  const pending = f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {} });
  const request = await f.started.promise;
  assert.equal(request.timeoutMs, 300000);
  f.controller.abort();
  assert.equal(request.signal.aborted, true);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  const result = (await pending) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Cancelled);
  assert.deepEqual(await f.service.result(f.storage, result.id), result);
});

test("foreground invocation abort during runtime discovery returns a cancelled receipt without launching", async (t) => {
  const f = await fixture(t);
  const probing = deferred<void>();
  const discovered = deferred<void>();
  f.service.detect = async () => {
    probing.resolve();
    await discovered.promise;
    return { state: NativeRuntimeState.Ready, path: "/worker", version: "1.0.0", detail: "Ready" };
  };
  const pending = f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {} });
  await probing.promise;
  f.controller.abort();
  discovered.resolve();
  const result = (await pending) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Cancelled);
  assert.deepEqual(await f.service.result(f.storage, result.id), result);
  assert.deepEqual(f.requests, []);
});

test("foreground output failures return their durable failed receipt and worker logs", async (t) => {
  for (const scenario of [
    { name: "over the asset limit", output: "x".repeat(4097), reason: /aggregate size limit/ },
    { name: "no declared output", output: undefined, reason: /produced no declared output/ },
  ]) {
    await t.test(scenario.name, async (caseT) => {
      const f = await fixture(caseT);
      const pending = f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {} });
      const request = await f.started.promise;
      if (scenario.output !== undefined) await writeFile(request.args[0], scenario.output);
      f.ended.resolve({
        code: 0,
        signal: null,
        stdout: "worker output",
        stderr: "worker warning",
        reason: "exit",
        pid: null,
      });
      const result = (await pending) as PluginNativeResult;
      assert.equal(result.state, NativeJobState.Failed);
      assert.match(result.reason ?? "", scenario.reason);
      assert.equal(result.stdout, "worker output");
      assert.equal(result.stderr, "worker warning");
      assert.equal(result.exitCode, 0);
      assert.ok(result.finishedAt);
      assert.deepEqual(await f.service.result(f.storage, result.id), result);
    });
  }
});

test("foreground cleanup failure returns a failed receipt even when the caller cancelled", async (t) => {
  for (const cancelled of [false, true]) {
    await t.test(cancelled ? "cancelled caller" : "waiting caller", async (caseT) => {
      const f = await fixture(caseT);
      const pending = f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {} });
      await f.started.promise;
      if (cancelled) f.controller.abort();
      const failure = new NativeCleanupError();
      f.ended.reject(failure);
      const result = (await pending) as PluginNativeResult;
      assert.equal(result.state, NativeJobState.Failed);
      assert.equal(result.reason, failure.message);
      assert.deepEqual(await f.service.result(f.storage, result.id), result);
    });
  }
});

test("foreground input and package-staging failures reject before any worker starts", async (t) => {
  for (const stage of ["input", "package"] as const) {
    await t.test(stage, async (caseT) => {
      const f = await fixture(caseT);
      const recipe = f.spec.nativeJobs?.[0];
      assert.ok(recipe);
      const inputs: Record<string, string> = {};
      if (stage === "input") {
        recipe.inputs = ["source"];
        inputs.source = ".env";
      } else {
        recipe.args.unshift({ source: "package", name: "missing.mjs" });
      }
      await assert.rejects(
        f.call(PluginService.NativeRun, { job: "make", inputs, values: {} }),
        stage === "input" ? /Protected native input/ : /ENOENT/,
      );
      const records = await f.service.jobs(f.storage);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.state, NativeJobState.Failed);
      assert.ok(records[0]?.finishedAt);
      assert.deepEqual(f.requests, []);
    });
  }
});

test("a missing foreground runtime rejects with setup guidance and keeps a failed receipt", async (t) => {
  const f = await fixture(t);
  const detail = "Worker is not installed. Install it using the plugin publisher's guidance.";
  f.service.detect = async () => ({ state: NativeRuntimeState.Missing, detail });
  await assert.rejects(f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {} }), { message: detail });
  const records = await f.service.jobs(f.storage);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.state, NativeJobState.Failed);
  assert.ok(records[0]);
  assert.equal((await f.service.result(f.storage, records[0].id))?.reason, detail);
  assert.equal("stdout" in records[0], false);
  assert.equal("files" in records[0], false);
  assert.ok(records[0]?.finishedAt);
  assert.deepEqual(f.requests, []);
});

test("a missing background runtime returns an id whose durable receipt fails with setup guidance", async (t) => {
  const f = await fixture(t);
  const detail = "Worker is not installed. Install it using the plugin publisher's guidance.";
  f.service.detect = async () => ({ state: NativeRuntimeState.Missing, detail });
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  assert.match(answer.id, /^[a-f0-9-]{36}$/);
  await f.finished.promise;
  const result = (await f.call(PluginService.NativeResult, answer)) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Failed);
  assert.equal(result.reason, detail);
  assert.ok(result.finishedAt);
  assert.deepEqual(f.requests, []);
});

test("parallel background requests reserve one plugin root before either request can yield", async (t) => {
  const f = await fixture(t);
  const probing = deferred<void>();
  f.service.detect = async () => {
    await probing.promise;
    return { state: NativeRuntimeState.Ready, path: "/worker", detail: "Ready" };
  };
  const args = { job: "make", inputs: {}, values: {}, background: true };
  try {
    const answers = await Promise.allSettled([
      f.call(PluginService.NativeRun, args),
      f.call(PluginService.NativeRun, args),
    ]);
    assert.equal(answers.filter((answer) => answer.status === "fulfilled").length, 1);
    assert.equal(answers.filter((answer) => answer.status === "rejected").length, 1);
    assert.equal((await f.service.jobs(f.storage)).length, 1);
  } finally {
    probing.resolve();
  }
  await f.started.promise;
});

test("a background reservation spans projects and is released after the job finishes", async (t) => {
  const f = await fixture(t);
  const args = { job: "make", inputs: {}, values: {}, background: true };
  const first = (await f.call(PluginService.NativeRun, args)) as { id: string };
  const request = await f.started.promise;
  const otherGame = path.join(f.root, "other-game");
  await mkdir(otherGame);
  const other = { project: "other-game", directory: otherGame };
  await assert.rejects(f.call(PluginService.NativeRun, args, other));
  assert.equal(f.requests.length, 1);
  await writeFile(request.args[0], "first asset");
  f.ended.resolve({ code: 0, signal: null, stdout: "done", stderr: "", reason: "exit", pid: null });
  await f.finished.promise;
  const result = (await f.call(PluginService.NativeResult, first)) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Completed);
  const next = (await f.call(PluginService.NativeRun, args, other)) as { id: string };
  assert.notEqual(next.id, first.id);
});

test("different plugin roots can run background jobs independently", async (t) => {
  const f = await fixture(t);
  const args = { job: "make", inputs: {}, values: {}, background: true };
  const otherStorage = path.join(f.root, "other-storage");
  const [first, second] = (await Promise.all([
    f.call(PluginService.NativeRun, args),
    f.call(PluginService.NativeRun, args, f.binding, otherStorage),
  ])) as Array<{ id: string }>;
  assert.notEqual(first?.id, second?.id);
  assert.equal((await f.service.jobs(f.storage)).length, 1);
  assert.equal((await f.service.jobs(otherStorage)).length, 1);
});

test("background acknowledgement does not wait for a runtime probe", { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  const probing = deferred<void>();
  f.service.detect = async () => {
    await probing.promise;
    return { state: NativeRuntimeState.Ready, path: "/worker", detail: "Ready" };
  };
  try {
    const answer = (await f.call(PluginService.NativeRun, {
      job: "make",
      inputs: {},
      values: {},
      background: true,
    })) as { id: string };
    assert.match(answer.id, /^[a-f0-9-]{36}$/);
  } finally {
    probing.resolve();
  }
  await f.started.promise;
});

test("a background job holds its plugin package until completion, including after the tool returns", async (t) => {
  const f = await fixture(t);
  const held: string[] = [];
  let released = 0;
  f.service.hold = (id) => {
    held.push(id);
    return async () => {
      released++;
    };
  };
  await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true });
  await f.started.promise;
  assert.deepEqual(held, [f.spec.id]);
  assert.equal(released, 0);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  await f.service.stop();
  assert.equal(released, 1);
});

test("cancel respects plugin and project ownership, is idempotent, and stops only its job", async (t) => {
  const f = await fixture(t);
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  const request = await f.started.promise;
  assert.equal(await f.call(PluginService.NativeCancel, { id: answer.id }, { ...f.binding, project: "other" }), false);
  assert.equal(request.signal.aborted, false);
  assert.equal(await f.service.cancelJob(path.join(f.root, "other-plugin"), answer.id), false);
  assert.equal(request.signal.aborted, false);
  await assert.rejects(f.call(PluginService.NativeCancel, { id: "../outside" }), /Invalid job id/);
  assert.equal(await f.call(PluginService.NativeCancel, { id: answer.id }), true);
  assert.equal(request.signal.aborted, true);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  await f.finished.promise;
  assert.equal(
    ((await f.call(PluginService.NativeResult, answer)) as PluginNativeResult).state,
    NativeJobState.Cancelled,
  );
  assert.equal(await f.call(PluginService.NativeCancel, answer), false);
});

test("a restarted host marks running records interrupted without launching anything", async (t) => {
  const f = await fixture(t);
  const id = "12345678-1234-1234-1234-123456789abc";
  const directory = path.join(f.storage, "native-jobs", id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "job.json"),
    JSON.stringify({
      id,
      state: NativeJobState.Running,
      project: "game",
      recipe: "make",
      runtime: "worker",
      output: directory,
      files: [],
      createdAt: new Date().toISOString(),
    }),
  );
  const result = (await f.call(PluginService.NativeResult, { id })) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Interrupted);
  assert.match(result.reason ?? "", /not replayed/);
  assert.equal(result.finishedAt, undefined, "a restarted host does not know when the lost worker stopped");
  assert.equal(JSON.parse(await readFile(path.join(directory, "job.json"), "utf8")).state, NativeJobState.Interrupted);
});

test("host shutdown interrupts an independent background worker and waits for its record", async (t) => {
  const f = await fixture(t);
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  const request = await f.started.promise;
  const stopping = f.service.stop();
  assert.equal(request.signal.aborted, true);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  await stopping;
  const result = (await f.call(PluginService.NativeResult, answer)) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Interrupted);
  assert.ok(result.finishedAt);
});

test("plugin shutdown interrupts a foreground worker instead of recording caller cancellation", async (t) => {
  const f = await fixture(t);
  const pending = f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {} });
  const request = await f.started.promise;
  const stopping = f.service.stop(f.storage);
  assert.equal(request.signal.aborted, true);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  await stopping;
  const result = (await pending) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Interrupted);
  assert.ok(result.finishedAt);
  assert.deepEqual(await f.service.result(f.storage, result.id), result);
});

test("plugin shutdown keeps the stop time even when worker cleanup and later reads happen much later", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 21) });
  const f = await fixture(t);
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  const request = await f.started.promise;
  t.mock.timers.tick(1000);
  const stoppedAt = new Date().toISOString();
  const stopping = f.service.stop(f.storage);
  assert.equal(request.signal.aborted, true);
  t.mock.timers.tick(60000);
  f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
  await stopping;
  const result = (await f.call(PluginService.NativeResult, answer)) as PluginNativeResult;
  assert.equal(result.state, NativeJobState.Interrupted);
  assert.equal(result.finishedAt, stoppedAt, "cleanup time is not the worker's stop time");
  t.mock.timers.tick(60000);
  const later = (await f.call(PluginService.NativeResult, answer)) as PluginNativeResult;
  assert.equal(later.finishedAt, stoppedAt, "reading the receipt never changes its stop time");
});

test("200 concurrent result and list reads racing completion never overwrite the terminal receipt", async (t) => {
  const f = await fixture(t);
  const answer = (await f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true })) as {
    id: string;
  };
  const request = await f.started.promise;
  await writeFile(request.args[0], "completed asset");
  const reads = Array.from({ length: 200 }, async () => {
    const [result, jobs] = (await Promise.all([
      f.call(PluginService.NativeResult, answer),
      f.call(PluginService.NativeJobs, {}),
    ])) as [PluginNativeResult, PluginNativeResult[]];
    for (const record of [result, ...jobs]) {
      assert.notEqual(record.state, NativeJobState.Interrupted);
      if (record.state === NativeJobState.Completed) {
        assert.deepEqual(record.files, ["result.txt"]);
        assert.equal(record.stdout, "completed stdout");
      }
    }
  });
  f.ended.resolve({ code: 0, signal: null, stdout: "completed stdout", stderr: "", reason: "exit", pid: null });
  await Promise.all(reads);
  await f.finished.promise;
  const result = (await f.call(PluginService.NativeResult, answer)) as PluginNativeResult;
  const stored = JSON.parse(await readFile(path.join(f.storage, "native-jobs", answer.id, "job.json"), "utf8"));
  for (const record of [result, stored]) {
    assert.equal(record.state, NativeJobState.Completed);
    assert.deepEqual(record.files, ["result.txt"]);
    assert.equal(record.stdout, "completed stdout");
  }
});

test("an invalid background flag and protected inputs cannot launch a worker", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: "yes" }),
    /boolean/,
  );
  await assert.rejects(
    f.call(PluginService.NativeRun, { job: "make", inputs: { secret: ".env" }, values: {}, background: true }),
    /Unexpected native job inputs/,
  );
  assert.deepEqual(await f.service.jobs(f.storage), []);
  assert.deepEqual(f.events, []);
});

test("plugin shutdown fences background admission still awaiting its initial folders", async (t) => {
  const f = await fixture(t);
  const pending = f.call(PluginService.NativeRun, { job: "make", inputs: {}, values: {}, background: true });
  await f.service.stop(f.storage);
  const answer = (await pending) as { id: string };
  try {
    const first = await Promise.race([
      f.finished.promise.then(() => "stopped"),
      f.started.promise.then(() => "started"),
    ]);
    assert.equal(first, "stopped", "withdrawn plugin must not start its queued worker");
    assert.equal((await f.service.result(f.storage, answer.id))?.state, NativeJobState.Interrupted);
  } finally {
    f.ended.resolve({ code: null, signal: "SIGKILL", stdout: "", stderr: "", reason: "cancelled", pid: null });
    await f.service.stop(f.storage);
  }
});

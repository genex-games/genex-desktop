import { it } from "node:test";
import assert from "node:assert/strict";
import { customEvents, startRig, waitForLog } from "../helpers/studio-rig.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { createToolRegistry } from "../../src/harness-seed/tools/index.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

it("Claude, Codex and local builders receive the same host-owned asset status contract", async () => {
  const rig = await startRig({ replies: [] });
  try {
    await rig.core.games.scaffold("asset-tools");
    const threadId = await rig.core.createGameThread("asset-tools");
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    const observed: any[] = [];
    for (const engine of ["claude-code", "codex", "bonsai"]) {
      rig.core.engines.register({
        id: engine,
        label: engine,
        kind: engine === "bonsai" ? "direct" : "delegated",
        supportsSessions: true,
        status: async () => ({ code: "ready", detail: "fixture" }),
        models: async () => [],
        delegate: async (request: DelegateRequest) => {
          assert.ok(request.liveTools?.some((tool) => tool.name === "genex__asset"));
          assert.match(request.prompt, /Genex/);
          observed.push(JSON.parse(String(await request.onLiveTool!("genex__asset", { operation: "status" }))));
          await assert.rejects(
            Promise.resolve().then(() => request.onLiveTool!("genex__asset", { operation: "publish" })),
            /Unsupported/,
          );
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      await api["engine.delegate"]!({
        engine,
        project: "asset-tools",
        threadId,
        prompt: "Inspect optional asset tools",
      });
    }
    const registry = await createToolRegistry({
      workspace: rig.core.layout.harnessWs,
      call: (name: string, args: any) => api[name]!(args),
    } as never);
    const tool = {
      execute: async (args: any, ctx: any) => {
        if (args.project && args.project !== ctx.project) return "pinned";
        const r = await registry.execute({ name: "genex__asset", arguments: args }, ctx);
        return r.images ? r : r.content;
      },
    };
    const ctx = { project: "asset-tools", threadId, call: (name: string, args: any) => api[name]!(args) };
    observed.push(JSON.parse((await tool.execute({ operation: "status" }, ctx)) as never));
    assert.match((await tool.execute({ operation: "status", project: "another-game" }, ctx)) as never, /pinned/);
    for (const result of observed) {
      assert.ok(result.operations.includes("creature.animate"));
      assert.equal(result.operations.includes("publish"), false);
      assert.equal(result.connected, false);
      assert.equal(result.enabled, false);
      assert.equal(result.balance, null);
      assert.deepEqual(result.jobs, []);
    }
  } finally {
    await rig.stop();
  }
});

it("returns host inspection images through all provider tool paths without creating a paid job", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "asset-observation";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project),
      id = randomUUID();
    await mkdir(path.join(rig.core.games.dirFor(project), "assets"), { recursive: true });
    await writeFile(path.join(rig.core.games.dirFor(project), "assets/banner.png"), "fixture");
    const dir = path.join(rig.core.pluginServices.root("genex"), "projects", project, "jobs", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "job.json"),
      JSON.stringify({
        id,
        project,
        operation: "image",
        status: "downloaded",
        files: ["assets/banner.png"],
        createdAt: new Date().toISOString(),
      }),
    );
    rig.preview.evaluations.push({ match: "performance.getEntriesByType('resource')", value: ["assets/banner.png"] });
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    for (const engine of ["claude-code", "codex", "bonsai"]) {
      rig.core.engines.register({
        id: engine,
        label: engine,
        kind: engine === "bonsai" ? "direct" : "delegated",
        supportsSessions: true,
        status: async () => ({ code: "ready", detail: "fixture" }),
        models: async () => [],
        delegate: async (request: DelegateRequest) => {
          const result = (await request.onLiveTool!("genex__asset", { operation: "inspect_use", id })) as {
            text: string;
            images: unknown[];
          };
          assert.equal(result.images.length, 1);
          assert.equal(JSON.parse(result.text).use.stage, "integrated");
          assert.equal(JSON.parse(result.text).creditsCharged, undefined);
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      await api["engine.delegate"]!({ engine, project, threadId, prompt: "Inspect the fixture asset" });
    }
    const registry = await createToolRegistry({
      workspace: rig.core.layout.harnessWs,
      call: (name: string, args: any) => api[name]!(args),
    } as never);
    const tool = {
      execute: async (args: any, ctx: any) => {
        if (args.project && args.project !== ctx.project) return "pinned";
        const r = await registry.execute({ name: "genex__asset", arguments: args }, ctx);
        return r.images ? r : r.content;
      },
    };
    const result = (await tool.execute(
      { operation: "inspect_use", id },
      { project, threadId, call: (name: string, args: any) => api[name]!(args) },
    )) as { images: unknown[]; content: string };
    assert.equal(result.images.length, 1);
    assert.equal(JSON.parse(result.content).use.stage, "integrated");
  } finally {
    await rig.stop();
  }
});

it("removed Genex leaves coding, existing assets and public export independent", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "without-genex";
    await rig.core.games.scaffold(project);
    const root = rig.core.games.dirFor(project);
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets/saved.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await rig.core.plugins.remove("genex");
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    const local = await createToolRegistry({
      workspace: rig.core.layout.harnessWs,
      call: (name: string, args: any) => api[name]!(args),
    } as never);
    assert.equal(
      local.names().some((name: string) => name.startsWith("genex")),
      false,
    );
    assert.doesNotMatch(local.summary(), /Genex/);
    rig.core.engines.register({
      id: "codex",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        assert.equal(
          request.liveTools?.some((t) => t.name.startsWith("genex")),
          false,
        );
        assert.doesNotMatch(request.prompt, /Genex/);
        return { ok: true, engine: "codex", summary: "Built without plugins", turns: 1, usage: {} };
      },
    } as never);
    const result = await api["engine.delegate"]!({
      engine: "codex",
      project,
      prompt: "Build with procedural geometry",
    });
    assert.equal(result.ok, true);
    // Explicit static export isolates plugin independence from the rig's intentionally stubbed Three vendor.
    await writeFile(path.join(root, "index.html"), '<img src="assets/saved.svg">');
    await writeFile(path.join(root, "studio.json"), JSON.stringify({ exportFiles: ["index.html", "assets"] }));
    const exported = await rig.core.games.export(project, path.join(rig.core.layout.exports, "without-genex"));
    assert.ok(exported);
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(path.join(rig.core.layout.exports, "without-genex/assets/saved.svg"), "utf8"), /<svg/);
  } finally {
    await rig.stop();
  }
});

it("every engine path leaves the same host-owned record of a plugin tool call", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const expectedVersion = rig.core.plugins.list().find((p) => p.manifest.id === "genex")!.manifest.version;
    const project = "asset-ledger";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project),
      root = rig.core.games.dirFor(project),
      id = randomUUID();
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets/banner.png"), "fixture");
    const jobDir = path.join(rig.core.pluginServices.root("genex"), "projects", project, "jobs", id);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      path.join(jobDir, "job.json"),
      JSON.stringify({
        id,
        project,
        operation: "image",
        status: "downloaded",
        files: ["assets/banner.png"],
        createdAt: new Date().toISOString(),
      }),
    );
    rig.preview.evaluations.push({ match: "performance.getEntriesByType('resource')", value: ["assets/banner.png"] });
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    for (const engine of ["claude-code", "codex", "bonsai"]) {
      rig.core.engines.register({
        id: engine,
        label: engine,
        kind: engine === "bonsai" ? "direct" : "delegated",
        supportsSessions: true,
        status: async () => ({ code: "ready", detail: "fixture" }),
        models: async () => [],
        delegate: async (request: DelegateRequest) => {
          await request.onLiveTool!("genex__asset", { operation: "status" });
          await assert.rejects(
            Promise.resolve().then(() => request.onLiveTool!("genex__asset", { operation: "publish" })),
            /Unsupported/,
          );
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      // The worker attribution a facet delegation always carries.
      await api["engine.delegate"]!({
        engine,
        project,
        threadId,
        prompt: "Ask Genex for its status",
        selfCapture: { project, root, runId: `run-${engine}`, facetId: "world", iteration: 2 },
      });
    }
    // The local harness reaches the same plugin through the RPC, and must leave the same pair.
    const registry = await createToolRegistry({
      workspace: rig.core.layout.harnessWs,
      call: (name: string, args: any) => api[name]!(args),
    } as never);
    const ctx = { project, threadId, call: (name: string, args: any) => api[name]!(args) };
    await registry.execute({ name: "genex__asset", arguments: { operation: "status" } }, ctx as never);
    await registry.execute({ name: "genex__asset", arguments: { operation: "inspect_use", id } }, ctx as never);

    const events = await rig.core.store.listEvents(threadId);
    const custom = (name: string) =>
      events
        .filter((e) => e.data.type === "custom" && e.data.event_type === name)
        .map((e) => (e.data as { payload: any }).payload);
    const started = custom("plugin_tool_started"),
      finished = custom("plugin_tool");
    assert.deepEqual(
      started.map((s) => `${s.engine}:${s.args}`),
      [
        "claude-code:operation=status",
        "claude-code:operation=publish",
        "codex:operation=status",
        "codex:operation=publish",
        "bonsai:operation=status",
        "bonsai:operation=publish",
        "local:operation=status",
        `local:operation=inspect_use id=${id}`,
      ],
    );
    // Started first, finished after, paired by the id the start minted.
    assert.deepEqual(
      finished.map((f) => f.callId),
      started.map((s) => s.callId),
    );
    for (const first of events.filter((e) => e.data.type === "custom" && e.data.event_type === "plugin_tool_started"))
      assert.ok(
        events.findIndex((e) => e === first) <
          events.findIndex(
            (e) =>
              e.data.type === "custom" &&
              e.data.event_type === "plugin_tool" &&
              (e.data as { payload: any }).payload.callId === (first.data as { payload: any }).payload.callId,
          ),
      );
    for (const s of started) {
      assert.equal(s.pluginName, "Genex Tools");
      assert.equal(s.pluginId, "genex");
      assert.equal(s.tool, "asset");
      assert.equal(s.toolName, "genex__asset");
      assert.equal(s.project, project);
      assert.equal(s.threadId, threadId);
    }
    // Worker attribution at the payload's top level, which is the only place the Builds graph reads.
    for (const s of started.slice(0, 6)) {
      assert.equal(s.runId, `run-${s.engine}`);
      assert.equal(s.facetId, "world");
      assert.equal(s.iteration, 2);
      assert.equal(s.role, "builder");
    }
    for (const s of started.slice(6)) {
      assert.equal("runId" in s, false);
      assert.equal("facetId" in s, false);
      assert.equal(s.role, "chat");
    }

    assert.deepEqual(
      finished.map((f) => f.ok),
      [true, false, true, false, true, false, true, true],
    );
    for (const f of finished.filter((f) => !f.ok)) {
      assert.match(f.error, /Unsupported/);
      assert.equal(f.result, "");
      assert.equal(f.images, 0);
    }
    for (const f of finished) {
      assert.equal(f.version, expectedVersion);
      assert.equal(typeof f.durationMs, "number");
    }
    assert.deepEqual(
      finished.map((f) => f.images),
      [0, 0, 0, 0, 0, 0, 0, 1],
    );
    // The image the inspection returned is counted, never copied into the log.
    assert.equal(finished.at(-1)!.result.includes("base64"), false);
    assert.match(finished.at(-1)!.result, /"stage":"integrated"/);
  } finally {
    await rig.stop();
  }
});

it("agent publish requests wait for Studio consent on every engine path", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "publish-consent";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    // Only the Studio UI answers a card: the agent-facing RPC table carries no way to.
    assert.equal(
      Object.keys(api).some((name) => /consent/i.test(name)),
      false,
    );
    let asked = 0;
    const pendingAsks = (events: Awaited<ReturnType<typeof waitForLog>>) =>
      customEvents(events, "plugin_consent").filter((p) => p.state === "pending");
    const answerNext = async (approved: boolean) => {
      const events = await waitForLog(rig.core, (e) => pendingAsks(e).length > asked, 20_000, "a pending consent card");
      const all = pendingAsks(events);
      asked = all.length;
      const ask = all.at(-1)!;
      assert.equal(ask.tool, "genex__publish");
      assert.equal(ask.pluginId, "genex");
      assert.equal(ask.project, project);
      assert.match(String(ask.prompt), /Publish this game on Genex/);
      assert.equal(rig.core.resolveConsent(String(ask.consentId), approved), true);
      return ask;
    };
    const answered = (events: Awaited<ReturnType<typeof waitForLog>>, consentId: unknown) =>
      customEvents(events, "plugin_consent").find((p) => p.consentId === consentId && p.state !== "pending");
    for (const engine of ["claude-code", "codex", "bonsai"]) {
      rig.core.engines.register({
        id: engine,
        label: engine,
        kind: engine === "bonsai" ? "direct" : "delegated",
        supportsSessions: true,
        status: async () => ({ code: "ready", detail: "fixture" }),
        models: async () => [],
        delegate: async (request: DelegateRequest) => {
          // The declaration the engine is handed keeps the manifest's consent prompt (engines ignore it).
          const declared = request.liveTools as Array<{ name: string; confirmation?: string }> | undefined;
          assert.match(
            String(declared?.find((tool) => tool.name === "genex__publish")?.confirmation),
            /Publish this game on Genex/,
          );
          assert.equal(declared?.find((tool) => tool.name === "genex__publish-status")?.confirmation, undefined);
          const decline = answerNext(false);
          const declined = JSON.parse(String(await request.onLiveTool!("genex__publish", { operation: "draft" })));
          const ask = await decline;
          assert.equal(declined.consent, "declined");
          assert.equal(declined.by, "user");
          assert.match(String(declined.message), /declined/i);
          assert.equal(answered(await rig.core.listAllEvents(), ask.consentId)?.by, "user");
          // Reading the state asks the user nothing.
          assert.equal(
            JSON.parse(String(await request.onLiveTool!("genex__publish-status", { operation: "status" }))).connected,
            false,
          );
          // Flipped: the same request asked again before the user says anything is answered
          // with their no, not a second card. Once they speak, it is asked — and approved, it reaches
          // the backend, which refuses for want of an account.
          const repeated = JSON.parse(String(await request.onLiveTool!("genex__publish", { operation: "draft" })));
          assert.equal(repeated.consent, "declined");
          await rig.core.append(
            [{ type: "messages", messages: [{ role: "user", content: "ok, publish it" }] }],
            threadId,
          );
          const approve = answerNext(true);
          await assert.rejects(
            Promise.resolve().then(() => request.onLiveTool!("genex__publish", { operation: "draft" })),
            /Connect Genex Tools first/,
          );
          await approve;
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      await api["engine.delegate"]!({ engine, project, threadId, prompt: "Put this game online" });
    }
    // The local harness reaches the same wrapper through plugins.invoke.
    const registry = await createToolRegistry({
      workspace: rig.core.layout.harnessWs,
      call: (name: string, args: any) => api[name]!(args),
    } as never);
    const ctx = { project, threadId, call: (name: string, args: any) => api[name]!(args) };
    const decline = answerNext(false);
    const local = await registry.execute({ name: "genex__publish", arguments: { operation: "draft" } }, ctx as never);
    await decline;
    assert.equal(JSON.parse(local.content).consent, "declined");
    assert.equal(
      JSON.parse(
        (await registry.execute({ name: "genex__publish-status", arguments: { operation: "status" } }, ctx as never))
          .content,
      ).connected,
      false,
    );
    assert.equal(asked, 7);
    assert.ok(rig.events.some((event) => event.type === "plugin.consent"));
  } finally {
    await rig.stop();
  }
});

it("a consent question expires, and Stop or the end of a turn withdraws it", async () => {
  const quick = await startRig({ replies: [] }, { consentTimeoutMs: 200 });
  try {
    const project = "publish-expiry";
    await quick.core.games.scaffold(project);
    const threadId = await quick.core.createGameThread(project);
    const api = quick.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    const result = await api["plugins.invoke"]!({
      project,
      threadId,
      name: "genex__publish",
      args: { operation: "draft" },
    });
    assert.equal(result.consent, "declined");
    assert.equal(result.by, "timeout");
    // Flipped: nobody answering is not a no; the agent carries on and asks again later.
    assert.match(String(result.message), /not a no: carry on with other work and ask again later/);
    assert.equal(
      customEvents(await quick.core.listAllEvents(), "plugin_consent").filter(
        (p) => p.state === "declined" && p.by === "timeout",
      ).length,
      1,
    );
  } finally {
    await quick.stop();
  }
  const rig = await startRig({ replies: [] });
  try {
    const project = "publish-withdrawn";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    const invoke = () =>
      api["plugins.invoke"]!({ project, threadId, name: "genex__publish", args: { operation: "draft" } });
    const untilPending = async (count: number) =>
      waitForLog(
        rig.core,
        (e) => customEvents(e, "plugin_consent").filter((p) => p.state === "pending").length >= count,
        20_000,
        "a pending consent card",
      );
    const stopped = invoke();
    await untilPending(1);
    await rig.core.stopThread(threadId);
    assert.deepEqual(await stopped.then((r: any) => [r.consent, r.by]), ["declined", "stop"]);
    const ended = invoke();
    await untilPending(2);
    await rig.core.append([{ type: "turn_ended", status: "cancelled" }], threadId);
    assert.deepEqual(await ended.then((r: any) => [r.consent, r.by]), ["declined", "turn"]);
  } finally {
    await rig.stop();
  }
});

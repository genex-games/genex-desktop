/**
 * Connector tools reach every coding path, and only the paths that should have them.
 *
 * `mcp-client.test.ts` proves the client and the registry against a real stdio server. This file
 * proves the plumbing above them: that one connector the user configured becomes the same tool
 * on Claude Code, on Codex and in the local harness, that the sessions with a narrower job never
 * see it, that every call lands in the log as a `connector_tool` record, and that an agent has
 * no way to change the connector list at all.
 *
 * Nothing here talks to a real MCP server or a live account: the fixture in tests/fixtures/mcp
 * is the whole outside world.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { customEvents, startRig, waitForLog } from "../helpers/studio-rig.ts";
import { errorMessage } from "../../src/shared/errors.ts";
import type { McpConnector } from "../../src/shared/mcp.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { createToolRegistry } from "../../src/harness-seed/tools/index.ts";

const SERVER = path.resolve("tests/fixtures/mcp/echo-server.mjs");

function connector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    id: "echo",
    name: "Echo",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER],
    enabled: true,
    scope: "global",
    toolPolicy: { autoApprove: ["echo", "picture", "fail", "sleep", "weird.name/x"] },
    createdAt: new Date().toISOString(),
    ...overrides,
  } as McpConnector;
}

/** Approve only the synthetic Genex call owned by this fixture. */
async function approveFixtureConnector(
  rig: Awaited<ReturnType<typeof startRig>>,
  invoke: () => Promise<unknown>,
): Promise<unknown> {
  const pending = invoke();
  // The card still waiting: an earlier call's answered row may land after this one started.
  const waiting = (events: Parameters<typeof customEvents>[0]) => {
    const rows = customEvents(events, "plugin_consent");
    const answered = new Set(rows.filter((row) => row.state !== "pending").map((row) => row.consentId));
    return rows.find((row) => row.state === "pending" && !answered.has(row.consentId));
  };
  const ask = waiting(await waitForLog(rig.core, (events) => Boolean(waiting(events))));
  assert.ok(ask);
  rig.core.resolveConsent(String(ask.consentId), true);
  return pending;
}

/**
 * A plugin connector's call that needs no card (a tool its manifest says only reads, or any of its
 * tools in an Auto chat): how it settled, an answer or an error, with no `plugin_consent` row added.
 */
async function runsUnasked(
  rig: Awaited<ReturnType<typeof startRig>>,
  invoke: () => Promise<unknown>,
): Promise<{ value: unknown } | { error: unknown }> {
  const cards = async () => customEvents(await rig.core.listAllEvents(), "plugin_consent").length;
  const before = await cards();
  const outcome = await invoke().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  assert.equal(await cards(), before, "it ran with no card");
  return outcome;
}

it("connection status tracks a delegated response through revocation and clears when it settles", async () => {
  const rig = await startRig({ replies: [] });
  let reportStarted!: (request: DelegateRequest) => void, release!: () => void;
  const started = new Promise<DelegateRequest>((resolve) => {
    reportStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending: Promise<unknown> | undefined;
  try {
    const project = "connection-activity";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    await rig.core.mcp.save(connector(), {}, { trust: true });
    rig.core.engines.register({
      id: "bonsai",
      label: "fixture",
      kind: "direct",
      supportsSessions: true,
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        reportStarted(request);
        await finished;
        return { ok: true, engine: "bonsai", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    assert.equal((await rig.core.connectionSnapshot(threadId, project)).active, false);
    pending = api["engine.delegate"]!({
      engine: "bonsai",
      project,
      threadId,
      prompt: "Wait before calling the connector",
    });
    const request = await started;
    const active = await rig.core.connectionSnapshot(threadId, project);
    assert.equal(active.active, true, "a contractor is active even without an outer chat-turn lease");
    assert.equal(active.revision, active.appliedRevision);
    assert.equal(
      (await rig.core.connectionSnapshot(rig.core.mainThread, project)).active,
      false,
      "activity belongs to its initiating chat",
    );
    await rig.core.mcp.save(connector({ enabled: false }), {}, { trust: true });
    const revoked = await rig.core.connectionSnapshot(threadId, project);
    assert.equal(revoked.active, true);
    assert.notEqual(revoked.revision, revoked.appliedRevision, "the active response retains its acquired tool list");
    await assert.rejects(
      Promise.resolve().then(() => request.onLiveTool!("echo__echo", { text: "blocked" })),
      /switched off|configuration changed/,
    );
    release();
    await pending;
    assert.equal((await rig.core.connectionSnapshot(threadId, project)).active, false);
  } finally {
    release();
    await pending?.catch(() => {});
    await rig.stop();
  }
});

it("connector calls wait for host consent unless the user grants the exact tool", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "consent-game";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    await rig.core.mcp.save(connector({ toolPolicy: {} }), {}, { trust: true });
    await rig.core.mcp.toolsFor(project);
    const call = rig.core
      .api()
      ["mcp.invoke"]({ project, threadId, name: "echo__echo", args: { text: "held", readOnlyHint: true } });
    const ending = call.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const events = await waitForLog(rig.core, (rows) =>
      customEvents(rows, "plugin_consent").some((row) => row.state === "pending"),
    );
    const consent = customEvents(events, "plugin_consent").find((row) => row.state === "pending");
    assert.ok(consent, "server annotations or arguments cannot approve an action");
    assert.equal(customEvents(events, "connector_tool").length, 0, "no remote tool ran before consent");
    rig.core.resolveConsent(String(consent.consentId), false);
    assert.ok("error" in (await ending), "denial ends the call");
    await rig.core.mcp.save(connector({ toolPolicy: { autoApprove: ["echo"] } }), {}, { trust: true });
    await rig.core.mcp.toolsFor(project);
    assert.equal(
      await rig.core.api()["mcp.invoke"]({ project, threadId, name: "echo__echo", args: { text: "granted" } }),
      "granted",
    );
    const pending = customEvents(await rig.core.activityEvents(), "plugin_consent").filter(
      (row) => row.state === "pending",
    );
    assert.equal(pending.length, 0, "the exact tool's saved grant avoids a second question");
  } finally {
    await rig.stop();
  }
});

it("one connector becomes the same tool on Claude Code, on Codex and in the local harness", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "connected";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    // The trust the native dialog grants, granted here directly: no test ever opens a dialog.
    await rig.core.mcp.save(connector(), {}, { trust: true });
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
          const tool = request.liveTools?.find((t) => t.name === "echo__echo");
          assert.ok(tool, `${engine} was given the connector's tool`);
          // The real schema travels with it — the flat projection alone could not carry an array.
          assert.deepEqual(tool!.inputSchema?.required, ["text"]);
          assert.deepEqual(
            (tool!.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined)?.tags,
            { type: "array", items: { type: "string" }, description: "Labels to repeat." },
          );
          assert.equal(tool!.parameters.properties.tags?.type, "array");
          // A connector is named in the prompt only as a count, never tool by tool.
          assert.match(request.prompt, /\[CONNECTORS\]/);
          assert.match(request.prompt, /Echo: 5 tools, named echo__\*/);
          assert.doesNotMatch(request.prompt, /echo__echo/);
          assert.equal(
            await request.onLiveTool!("echo__echo", { text: "hi", tags: ["a", "b"], count: 2, mode: "a" }),
            "hi tags=a,b count=2 mode=a",
          );
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      await api["engine.delegate"]!({ engine, project, threadId, prompt: "Use the connector" });
    }

    // The local harness reaches the same connector through its own two RPCs.
    const registry = await createToolRegistry(
      { workspace: rig.core.layout.harnessWs, call: (name: string, args: any) => api[name]!(args) } as never,
      { project },
    );
    const definition = registry.definitions().find((d: { name: string }) => d.name === "echo__echo");
    assert.ok(definition, "the local harness lists the connector tool");
    assert.deepEqual(
      definition.parameters.required,
      ["text"],
      "definitions() hands the model the real schema, not the flat projection",
    );
    assert.equal(definition.parameters.properties.tags.items.type, "string");
    assert.match(registry.summary(), /\[CONNECTORS\]/);
    const answer = await registry.execute({ name: "echo__echo", arguments: { text: "local", count: 3 } }, {
      project,
      threadId,
      call: (name: string, args: any) => api[name]!(args),
    } as never);
    assert.equal(answer.ok, true);
    assert.equal(answer.content, "local count=3");

    // Every one of those calls is in the log, as its own kind of record.
    const events = await waitForLog(
      rig.core,
      (list) => customEvents(list, "connector_tool").length >= 4,
      20_000,
      "connector_tool records",
    );
    const records = customEvents(events, "connector_tool");
    assert.equal(records.length, 4);
    for (const record of records) {
      assert.equal(record.connectorId, "echo");
      assert.equal(record.tool, "echo", "the record names the server's own tool, not the sanitised alias");
      assert.equal(record.exposedName, "echo");
      assert.equal(record.ok, true);
      assert.equal(typeof record.durationMs, "number");
    }
    assert.equal(records[0]!.result, "hi tags=a,b count=2 mode=a");
    // A connector call is never filed as a plugin call: the ledger would name a plugin nobody installed.
    assert.equal(
      customEvents(events, "plugin_tool").some((r) => r.tool === "echo"),
      false,
    );
  } finally {
    await rig.stop();
  }
});

it("an image answer is carried and counted, and a failing tool is reported as a failure", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "connected-images";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    await rig.core.mcp.save(connector(), {}, { trust: true });
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    rig.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const picture = (await request.onLiveTool!("echo__picture", {})) as { text: string; images: unknown[] };
        assert.equal(picture.images.length, 1);
        // isError from a server is a failed tool call, and it reaches the agent as one.
        await assert.rejects(
          Promise.resolve().then(() => request.onLiveTool!("echo__fail", {})),
          /this tool refuses/,
        );
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "Look at the connector" });

    const events = await waitForLog(
      rig.core,
      (list) => customEvents(list, "connector_tool").length >= 2,
      20_000,
      "both connector records",
    );
    const records = customEvents(events, "connector_tool");
    const shown = records.find((r) => r.exposedName === "picture")!;
    assert.equal(shown.ok, true);
    assert.equal(shown.images, 1, "the count is kept; the bytes never enter the log");
    assert.equal(shown.result, "here it is");
    const failed = records.find((r) => r.exposedName === "fail")!;
    assert.equal(failed.ok, false);
    assert.match(String(failed.error), /this tool refuses/);
  } finally {
    await rig.stop();
  }
});

it("the sessions with a narrower job never receive a connector tool", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "narrow";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    await rig.core.mcp.save(connector(), {}, { trust: true });
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    const seen: Array<{ label: string; tools: string[]; prompt: string }> = [];
    rig.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        seen.push({
          label: String(request.prompt).split("\n")[0]!,
          tools: (request.liveTools ?? []).map((t) => t.name),
          prompt: request.prompt,
        });
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);

    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "read-only", readOnly: true });
    await api["engine.delegate"]!({
      engine: "claude-code",
      project,
      threadId,
      prompt: "interview",
      interviewTools: [
        {
          name: "ask",
          description: "Record an answer",
          parameters: { type: "object", properties: { answer: { type: "string" } } },
        },
      ],
    });
    assert.equal(seen.length, 2, "both delegations really reached the engine");
    assert.equal(seen[0]!.tools.includes("echo__echo"), false, "a read-only session must not reach a connector");
    assert.doesNotMatch(seen[0]!.prompt, /\[CONNECTORS\]/);
    // Flipped (step 1): a Loop chat that may launch a build is a full contractor and gets what
    // the Auto chat gets.
    assert.equal(seen[1]!.tools.includes("echo__echo"), true, "a Loop chat reaches the connector");

    // A candidate's tool registry is the optimizer's, and it is built from the game tools alone.
    const candidate = await createToolRegistry(
      { workspace: rig.core.layout.harnessWs, call: (name: string, args: any) => api[name]!(args) } as never,
      { candidateId: "trusted", project },
    );
    assert.equal(
      candidate.names().some((name: string) => name.startsWith("echo__")),
      false,
    );
    assert.doesNotMatch(candidate.summary(), /\[CONNECTORS\]/);
  } finally {
    await rig.stop();
  }
});

it("agents may use connectors and may not change them", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "no-mutation";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    await rig.core.mcp.save(connector(), {}, { trust: true });
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;

    // The whole connector surface an agent can reach: read the list, call a tool. Nothing else.
    const reachable = Object.keys(api).filter((name) => name.startsWith("mcp."));
    assert.deepEqual(reachable.sort(), ["mcp.invoke", "mcp.tools"]);

    const listed = await api["mcp.tools"]!({ project });
    assert.ok(listed.tools.some((t: { name: string }) => t.name === "echo__echo"));
    assert.match(listed.guidance, /Echo: 5 tools/);

    // A name that is not `<connector>__<tool>`, and a payload that is not an object, are refused
    // at the doorway rather than reaching a server.
    await assert.rejects(api["mcp.invoke"]!({ project, threadId, name: "echo", args: {} }), /Unknown connector tool/);
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: "echo__nope", args: {} }),
      /Unknown connector tool/,
    );
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: ["x"] as never }),
      /JSON object/,
    );
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "x".repeat(300_000) } }),
      /too large/,
    );

    // Switched off in the UI means switched off for every agent, at once.
    const saved = (await rig.core.mcp.list())[0]!.connector;
    await rig.core.mcp.save({ ...saved, enabled: false }, {}, { trust: true });
    await assert.rejects(
      api["mcp.invoke"]!({ project, threadId, name: "echo__echo", args: { text: "hi" } }),
      /switched off/,
    );
    assert.deepEqual((await api["mcp.tools"]!({ project })).tools, []);
  } finally {
    await rig.stop();
  }
});

/**
 * A plugin may ship an MCP server of its own. The connector it becomes is the plugin's: published
 * when the plugin is enabled, withdrawn when it is not, trusted by the install dialog the user
 * already answered, and given only what the manifest named — with the account credential going
 * down an anonymous pipe rather than through the environment.
 */
const PLUGIN_SERVER = path.resolve("tests/fixtures/mcp/plugin-server.mjs");
const PLUGIN_MANIFEST = {
  apiVersion: 2,
  id: "mcpdemo",
  version: "1.0.0",
  name: "MCP demo",
  publisher: "Studio tests",
  description: "A plugin that ships an MCP server of its own.",
  backend: "backend.mjs",
  capabilities: ["credentials", "settings"],
  tools: [],
  skills: [],
  panels: [],
  settings: [{ key: "endpoint", label: "Endpoint", type: "string", default: "https://example.invalid" }],
  actions: [{ name: "unlock", label: "Unlock saved account", confirmation: "Unlock the saved account." }],
  mcpServers: [
    {
      id: "echo",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      cwd: "storage:project",
      env: { FIXTURE_CREDENTIAL_FILE: "credential-file", FIXTURE_MODE: "literal:on", FIXTURE_URL: "setting:endpoint" },
      requires: { credential: true, settings: ["endpoint"] },
      description: "Echoes, and reports the process Studio started.",
    },
  ],
};
async function pluginPackage(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-plugin-"));
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(PLUGIN_MANIFEST, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    "export async function activate(){return {async action(){return {text:'ok'};}};}\n",
  );
  await cp(PLUGIN_SERVER, path.join(dir, "server.mjs"));
  return dir;
}

it("a plugin ships its own MCP server: started with it, fed on fd 3, and gone when it is switched off", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "plugged";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    // A node test run has no OS encryption, so the one boundary the host reads a plugin credential
    // through is stubbed here. Everything else on the path — the gate, the pipe, the child — is real.
    const services = rig.core.pluginServices;
    const real = services.call.bind(services);
    services.call = ((id: string, method: string, args: unknown, binding: unknown) =>
      method === "credentials.read"
        ? Promise.resolve("tok-e2e")
        : real(id, method, args as never, binding as never)) as typeof services.call;

    await rig.core.plugins.installLocal(await pluginPackage());
    await rig.core.plugins.setEnabled("mcpdemo", true);
    const view = async () => (await rig.core.mcp.list()).find((v) => v.connector.id === "mcpdemo-echo");
    const listed = await view();
    assert.ok(listed, "the plugin server is listed as a connector the plugin owns");
    assert.deepEqual(listed.connector.source, { plugin: "mcpdemo", server: "echo" });
    assert.equal(listed.health, "disabled", "a server that needs an account is not started to fail");
    assert.match(String(listed.error), /Unlock this plugin's account first/);
    for (const scope of [null, project, "another-project"]) {
      const scoped = (await rig.core.mcp.list(scope)).find((v) => v.connector.id === "mcpdemo-echo");
      assert.equal(scoped?.health, "disabled");
      assert.equal(scoped?.toolCount, 0);
      assert.match(
        String(scoped?.error),
        /Unlock this plugin's account first/,
        "plugin setup requirements remain visible in every project",
      );
    }

    await rig.core.plugins.action("mcpdemo", "unlock", {});
    assert.equal((await view())!.health, "idle");
    assert.equal((await view())!.trusted, true, "the plugin's install dialog is the trust gate");

    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    let probe: Record<string, any> | undefined;
    rig.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        assert.ok(
          request.liveTools?.some((t) => t.name === "mcpdemo-echo__echo"),
          "the server's tools are namespaced <plugin>-<server>__<tool>",
        );
        assert.equal(
          await approveFixtureConnector(rig, () => request.onLiveTool!("mcpdemo-echo__echo", { text: "hi" })),
          "hi",
        );
        probe = JSON.parse(
          String(await approveFixtureConnector(rig, () => request.onLiveTool!("mcpdemo-echo__probe", {}))),
        );
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "use the plugin server" });

    assert.ok(probe, "the delegation really called the plugin server");
    // It works in the plugin's own storage, one folder per project, with a HOME inside it so the
    // CLI-shaped startup of any such server cannot reach the user's own dotfiles.
    assert.ok(String(probe.cwd).endsWith(path.join("plugins", "data", "mcpdemo", "mcp", project)), String(probe.cwd));
    // macOS resolves the child's cwd through /private, so the two are compared where they differ.
    assert.ok(
      String(probe.home).endsWith(path.join("plugins", "data", "mcpdemo", "mcp", project, "home")),
      String(probe.home),
    );
    // A `node` server gets the bare token on fd 3 and `/dev/fd/3` as the variable (PLG-4); the
    // `GENEX_TOKEN=` line and the virtual path are only for Studio's own Genex CLI (host-cli).
    assert.equal(
      probe.fd3Digest,
      createHash("sha256").update("tok-e2e").digest("hex"),
      "the bare credential arrived on the pipe",
    );
    assert.equal(
      probe.fd3,
      "[redacted]",
      "and a server that repeats it does not hand it to the model, even when it is not token-shaped (SEC-4)",
    );
    assert.equal(probe.envNames.includes("GENEX_TOKEN"), false, "and never through the environment");
    assert.deepEqual(probe.env, {
      FIXTURE_CREDENTIAL_FILE: "/dev/fd/3",
      FIXTURE_MODE: "on",
      FIXTURE_URL: "https://example.invalid",
    });
    assert.equal(probe.envNames.includes("ELECTRON_RUN_AS_NODE"), true, "a packaged app has no node on its PATH");

    await rig.core.plugins.setEnabled("mcpdemo", false);
    assert.equal(await view(), undefined, "switching the plugin off takes its server with it");
    assert.deepEqual(
      (await api["mcp.tools"]!({ project })).tools.filter((t: { name: string }) => t.name.startsWith("mcpdemo-")),
      [],
    );
    await rig.core.plugins.setEnabled("mcpdemo", true);
    assert.ok(await view());
    await rig.core.plugins.remove("mcpdemo");
    assert.equal(await view(), undefined);
  } finally {
    await rig.stop();
  }
});

/** Local modeling and an optional remote modeling connector are independent choices. */
it("bundled main Genex MCP joins an existing chat after account unlock on every builder provider", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "genex-existing-chat";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    const declared = rig.core.plugins
      .list()
      .find((p) => p.manifest.id === "genex")!
      .manifest.mcpServers!.find((s) => s.id === "creator")!;
    assert.deepEqual(declared.requires, { credential: true }, "no Blender setting or second sign-in");
    const view = async () => (await rig.core.mcp.list()).find((v) => v.connector.id === "genex-creator");
    assert.equal((await view())!.health, "disabled");
    const services = rig.core.pluginServices,
      real = services.call.bind(services);
    services.call = ((id: string, method: string, args: unknown, binding: unknown) =>
      method === "credentials.read"
        ? Promise.resolve("creator-fixture-credential")
        : method === "credentials.clear"
          ? Promise.resolve(null)
          : real(id, method, args as never, binding as never)) as typeof services.call;
    await rig.core.plugins.action("genex", "unlock", {});
    assert.equal((await view())!.health, "idle");
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    for (const engine of ["codex", "claude-code", "bonsai"]) {
      rig.core.engines.register({
        id: engine,
        label: engine,
        kind: "delegated",
        status: async () => ({ code: "ready" }),
        models: async () => [],
        delegate: async (request: DelegateRequest) => {
          assert.ok(
            request.liveTools?.some((t) => t.name === "genex__asset"),
            "host delivery remains callable",
          );
          assert.ok(
            request.liveTools?.some((t) => t.name === "genex__publish"),
            "host publishing remains callable",
          );
          const tools = request.liveTools?.filter((t) => t.name.startsWith("genex-creator__")) ?? [];
          assert.equal(tools.length, 4);
          // A new chat is in Auto, where a plugin's connector runs with no card.
          assert.deepEqual(await runsUnasked(rig, () => request.onLiveTool!("genex-creator__generation_status", {})), {
            value: "Genex fixture: generation_status",
          });
          assert.doesNotMatch(JSON.stringify(request.liveTools), /creator-fixture-credential/);
          assert.ok(
            !request.liveTools?.some((t) => t.name === "genex-creator__generate"),
            "generation cannot bypass asset delivery",
          );
          return { ok: true, engine, summary: "fixture", turns: 1, usage: {} };
        },
      } as never);
      await api["engine.delegate"]!({ engine, project, threadId, prompt: "Check Genex" });
    }
    assert.equal((await view())!.health, "ready");
    assert.equal((await view())!.toolCount, 4);
    await rig.core.plugins.setEnabled("genex", false);
    assert.equal(await view(), undefined);
    await assert.rejects(
      api["mcp.invoke"]!({ name: "genex-creator__my_games", args: {}, project, threadId }),
      /Unknown connector tool/,
    );
    await rig.core.plugins.setEnabled("genex", true);
    assert.ok(
      (await api["mcp.tools"]!({ project })).tools.some((t: { name: string }) => t.name === "genex-creator__my_games"),
    );
    await rig.core.plugins.action("genex", "disconnect", {});
    assert.equal((await view())!.health, "disabled");
    assert.ok(
      !(await api["mcp.tools"]!({ project })).tools.some((t: { name: string }) => t.name.startsWith("genex-creator__")),
    );
  } finally {
    await rig.stop();
  }
});

/**
 * Epic's Unreal MCP on a local port, as UE 5.8.3 answers: `initialize` opens a session with the
 * tools capability (and an empty serverInfo name), and every tool call returns `returnValue`.
 */
async function fakeUnrealMcp(returnValue: string, project: string) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST") return void response.writeHead(request.method === "DELETE" ? 202 : 405).end();
    const message = JSON.parse(body);
    if (message.id === undefined) return void response.writeHead(202).end();
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { resources: {}, tools: { listChanged: true } },
            serverInfo: { name: "", title: "", version: "" },
          }
        : {
            content: [
              {
                type: "text",
                // The Genex editor helper's project_file names the project this editor has open.
                text: JSON.stringify({
                  returnValue: message.params?.arguments?.tool_name === "project_file" ? project : returnValue,
                }),
              },
            ],
          };
    const headers = { "content-type": "application/json", "mcp-session-id": "fake-session" };
    response.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  // Setup gives a project a port in Genex's block, 18000–18999; the bridge trusts no other.
  const start = 18_000 + Math.floor(Math.random() * 1000);
  for (let step = 0; step < 1000 && !server.listening; step++) {
    const port = 18_000 + ((start - 18_000 + step) % 1000);
    await new Promise<void>((resolve) => {
      server.once("error", () => resolve());
      server.listen(port, "127.0.0.1", () => resolve());
    });
  }
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { port: (server.address() as AddressInfo).port, close };
}

it("bundled Unreal Editor starts off, then finds the set-up project's editor from the plugin's storage", async () => {
  const rig = await startRig({ replies: [] });
  const drift = path.join(os.homedir(), "Documents", "Unreal Projects", "Drift", "Drift.uproject");
  const unreal = await fakeUnrealMcp("21 toolsets", drift);
  try {
    const project = "unreal-bridge";
    const game = await rig.core.games.scaffold(project);
    // The editor connector reaches a game that holds an Unreal project; one not linked to it still
    // goes to the project chosen in the panel.
    await writeFile(path.join(game.dir, "Bridge.uproject"), "{}");
    const threadId = await rig.core.createGameThread(project);
    const view = async () => (await rig.core.mcp.list()).find((v) => v.connector.id === "unreal-editor");
    assert.equal(rig.core.plugins.enabled("unreal"), false, "an early integration waits to be turned on");
    assert.equal(await view(), undefined);
    await rig.core.plugins.setEnabled("unreal", true);
    const connector = await view();
    assert.ok(connector, "enabling the plugin lists its connector");
    assert.equal(connector.trusted, true, "the bundled plugin's own dialog is the trust gate");
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    // What Set up Unreal leaves in the plugin's storage: the project and its own port.
    const record = path.join(rig.core.pluginServices.root("unreal"), "setup", "drift", "record.json");
    const setUp = async () => {
      await mkdir(path.dirname(record), { recursive: true });
      await writeFile(
        record,
        JSON.stringify({ project: drift, uproject: { added: [], enabled: [] }, port: unreal.port }),
      );
    };
    const answers: Array<Awaited<ReturnType<typeof runsUnasked>>> = [];
    rig.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const tools = request.liveTools?.filter((t) => t.name.startsWith("unreal-editor__")).map((t) => t.name);
        assert.deepEqual(tools?.sort(), [
          "unreal-editor__call_tool",
          "unreal-editor__describe_toolset",
          "unreal-editor__list_toolsets",
        ]);
        const onLiveTool = request.onLiveTool;
        assert.ok(onLiveTool, "the studio injects live tools");
        // The manifest says `list_toolsets` only reads: it never asks.
        const list = () => runsUnasked(rig, () => onLiveTool("unreal-editor__list_toolsets", {}));
        answers.push(await list());
        await setUp();
        answers.push(await list());
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    await api["engine.delegate"]({ engine: "claude-code", project, threadId, prompt: "Look at the Unreal project" });
    // A failed tool call reaches the engine as an Error; an answer as the tool's result.
    const [none, found] = answers.map((answer) =>
      "error" in answer ? errorMessage(answer.error) : JSON.stringify(answer.value),
    );
    assert.match(none, /set up/i, "with no project set up the agent learns what to do");
    assert.match(none, /Unreal button/);
    assert.match(found, /21 toolsets/, "the bridge reached the set-up project's own port");
    assert.match(found, /Drift/, "and names the project that answered");
  } finally {
    await rig.stop();
    await unreal.close();
  }
});

it("the Genex Blender server waits for its endpoint and never disables the local plugin", async () => {
  const rig = await startRig({ replies: [] });
  try {
    const project = "modelled";
    await rig.core.games.scaffold(project);
    const threadId = await rig.core.createGameThread(project);
    // The bundled manifest's own requirement, as the registry sees it.
    const declared = rig.core.plugins
      .list()
      .find((p) => p.manifest.id === "genex")!
      .manifest.mcpServers!.find((s) => s.id === "blender")!;
    assert.deepEqual(declared.requires, { credential: true, settings: ["blender-url"] });

    // Unlock the account, exactly as the user's own action does — the one boundary a node test
    // cannot cross (OS encryption) is stubbed; the gate, the sync and the reason are all real.
    const services = rig.core.pluginServices;
    const real = services.call.bind(services);
    services.call = ((id: string, method: string, args: unknown, binding: unknown) =>
      method === "credentials.read"
        ? Promise.resolve("tok-blender")
        : real(id, method, args as never, binding as never)) as typeof services.call;
    await rig.core.plugins.action("genex", "unlock", {});

    const view = async () => (await rig.core.mcp.list()).find((v) => v.connector.id === "genex-blender");
    const waiting = await view();
    assert.ok(waiting, "an unfinished server is listed, not hidden");
    assert.equal(waiting.connector.enabled, false, "and switched off, so nothing tries to start it");
    assert.match(String(waiting.error), /Set "blender-url" in this plugin's settings first\./);

    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const api = rig.core.api() as unknown as Record<string, (input: any) => Promise<any>>;
    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "model something" });
    assert.deepEqual(
      (requests.at(-1)!.liveTools ?? []).filter((t) => t.name.startsWith("genex-blender__")),
      [],
      "an endpoint-less server publishes no tools",
    );
    assert.ok(
      requests.at(-1)!.liveTools?.some((t) => t.name === "blender__model"),
      "local plugin remains available",
    );
    assert.doesNotMatch(requests.at(-1)!.prompt, /blender tool is off for this session/);
    assert.deepEqual(
      (await api["mcp.tools"]!({ project })).tools.filter((t: { name: string }) =>
        t.name.startsWith("genex-blender__"),
      ),
      [],
    );

    // Now one that really answers. The fixture server stands in for `genex blender mcp` with an
    // endpoint behind it: no test starts the real CLI, and none reaches a Blender service.
    await rig.core.mcp.registerPluginServer(
      "genex",
      { id: "blender", name: "Genex Tools · blender", command: "ignored", args: [] },
      { execPath: process.execPath, extraArgs: [SERVER] },
    );
    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "model something else" });
    assert.ok(
      (requests.at(-1)!.liveTools ?? []).some((t) => t.name === "genex-blender__echo"),
      "a connected server publishes its tools",
    );
    assert.ok(
      requests.at(-1)!.liveTools?.some((t) => t.name === "blender__model"),
      "remote setup does not disable local modeling",
    );
    assert.doesNotMatch(requests.at(-1)!.prompt, /blender tool is off for this session/);
    await rig.core.plugins.setEnabled("blender", false);
    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "remote only" });
    assert.ok(!requests.at(-1)!.liveTools?.some((t) => t.name === "blender__model"));
    assert.ok(requests.at(-1)!.liveTools?.some((t) => t.name === "genex-blender__echo"));
  } finally {
    await rig.stop();
  }
});

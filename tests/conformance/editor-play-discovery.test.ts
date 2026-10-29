/** Editor play is selected by the current engine link, or one complete explicitly fact-scoped plugin. */
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { editorPlayComputer, editorPlayPlugin } from "../../src/main/core/editor-play-session.ts";
import type { CoreInternals, StudioCore } from "../../src/main/studio-core.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { ENGINE_PLAY_TOOLS, EnginePlayTool } from "../../src/shared/engine-play.ts";
import { PluginCapability, type PluginManifest, PluginToolAudience } from "../../src/shared/plugins.ts";
import { CoreFact, FolderHolds, type GameKind } from "../../src/shared/project-facts.ts";
import { writeEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import { ENGINES, UNREAL_ENGINE } from "../helpers/engines.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FACT = "example-project";
type PlayManifest = Pick<PluginManifest, "id" | "capabilities" | "tools">;

function plugin(id = "example", facts: string[] = [FACT]): PlayManifest {
  return {
    id,
    capabilities: [],
    tools: ENGINE_PLAY_TOOLS.map((name) => ({
      name,
      audience: PluginToolAudience.Harness,
      facts,
      description: name,
      parameters: { type: "object", properties: {} },
    })),
  };
}

async function fixture(manifests: PlayManifest[], kind: GameKind = { facts: [{ id: FACT, path: "." }] }) {
  const directory = await realpath(await tmpDir("editor-play-discovery-"));
  const disabled = new Set<string>();
  const links = new Map<string, { project: string; kind: string }>();
  const linked = async (id: string) => {
    const project = path.join(directory, "game.uproject");
    await writeFile(project, "{}\n");
    await writeEngineBinding(directory, project, UNREAL_ENGINE.id, ENGINES);
    links.set(id, { project, kind: UNREAL_ENGINE.id });
    return project;
  };
  const core = {
    games: { dirFor: () => directory, kindOf: async () => kind },
    plugins: {
      list: () => manifests.map((manifest) => ({ manifest })),
      enabled: (id: string) => !disabled.has(id),
      engines: () => ENGINES,
    },
    engineLinks: { read: async (id: string) => links.get(id) ?? null },
  } as unknown as StudioCore;
  return {
    core,
    directory,
    discover: async () => (await editorPlayPlugin(core, "game"))?.id ?? null,
    linked,
    links,
    disabled,
  };
}

/** The real editor computer around a recording plugin transport, with no window or frame access. */
async function computerFixture(invokePluginTool: CoreInternals["pluginTools"]["invokePluginTool"]) {
  const { core, directory } = await fixture([plugin()]);
  const abort = new AbortController();
  const services = { previews: {}, pluginTools: { invokePluginTool } } as unknown as Pick<
    CoreInternals,
    "previews" | "pluginTools"
  >;
  const tools = await editorPlayComputer(
    core,
    services,
    { project: "game", directory, signal: abort.signal },
    {
      grant: { project: "game", root: directory },
      outDir: directory,
      session: {
        loaded: null,
        handle: () => "editor-test",
        get: async () => assert.fail("editor play has no browser window"),
        release: async () => {},
      },
    },
  );
  assert.ok(tools);
  return { tools, abort };
}

describe("editor play plugin discovery", () => {
  it("finds an enabled plugin by the explicit matching facts of all six harness tools", async () => {
    const f = await fixture([plugin()]);
    assert.equal(await f.discover(), "example");
    f.disabled.add("example");
    assert.equal(await f.discover(), null);
  });

  it("starts a play over only for a plugin whose play-open declares fresh", async () => {
    const joins = await fixture([plugin()]);
    assert.equal((await editorPlayPlugin(joins.core, "game"))?.restarts, false);
    const manifest = plugin();
    const open = manifest.tools.find((tool) => tool.name === EnginePlayTool.Open);
    assert.ok(open);
    open.parameters = { type: "object", properties: { fresh: { type: "boolean" } } };
    const restarts = await fixture([manifest]);
    assert.equal((await editorPlayPlugin(restarts.core, "game"))?.restarts, true);
  });

  it("refuses incomplete, agent-facing, unscoped and unrelated play tools", async () => {
    const cases: Array<[string, (manifest: PlayManifest) => void]> = [
      ["missing tool", (manifest) => manifest.tools.pop()],
      [
        "agent tool",
        (manifest) => {
          delete manifest.tools[0]?.audience;
        },
      ],
      [
        "unscoped tool",
        (manifest) => {
          delete manifest.tools[0]?.facts;
        },
      ],
      [
        "empty scope",
        (manifest) => {
          if (manifest.tools[0]) manifest.tools[0].facts = [];
        },
      ],
      [
        "unrelated tool",
        (manifest) => {
          if (manifest.tools[0]) manifest.tools[0].facts = ["other-project"];
        },
      ],
    ];
    for (const [label, change] of cases) {
      const manifest = plugin();
      change(manifest);
      assert.equal(await (await fixture([manifest])).discover(), null, label);
    }
  });

  it("does not infer an editor from an unclassified game or choose between matching plugins", async () => {
    for (const holds of [undefined, FolderHolds.OwnFiles, FolderHolds.Unreadable]) {
      const game = { facts: [], ...(holds ? { holds } : {}) };
      const f = await fixture([plugin("web-editor", [CoreFact.WebGame])], game);
      assert.equal(await f.discover(), null, String(holds));
    }
    const ambiguous = await fixture([plugin("first"), plugin("second")]);
    assert.equal(await ambiguous.discover(), null);
  });

  it("gives a current engine link priority over matching facts, including legacy unscoped tools", async () => {
    const engine = plugin("linked");
    for (const tool of engine.tools) delete tool.facts;
    engine.capabilities = [PluginCapability.GameEngine];
    const f = await fixture([plugin(), engine]);
    await f.linked(engine.id);
    assert.equal(await f.discover(), engine.id);
    f.disabled.add(engine.id);
    assert.equal(await f.discover(), null, "a disabled link owner cannot fall back to a fact match");
    f.disabled.clear();
    f.links.set(engine.id, { project: "/different/game.uproject", kind: UNREAL_ENGINE.id });
    assert.equal(await f.discover(), null, "a stale plugin link cannot fall back to a fact match");
  });

  it("requires the complete harness contract and engine capability for the linked owner", async () => {
    const engine = plugin("linked");
    const f = await fixture([engine]);
    await f.linked(engine.id);
    assert.equal(await f.discover(), null, "a link alone does not grant the game-engine capability");
    engine.capabilities = [PluginCapability.GameEngine];
    engine.tools = engine.tools.filter((tool) => tool.name !== EnginePlayTool.Close);
    assert.equal(await f.discover(), null, "a linked engine still needs all six harness tools");
  });

  it("refuses competing owners of the same engine link", async () => {
    const engines = [plugin("first"), plugin("second")];
    for (const engine of engines) engine.capabilities = [PluginCapability.GameEngine];
    const f = await fixture(engines);
    const project = await f.linked("first");
    f.links.set("second", { project, kind: UNREAL_ENGINE.id });
    assert.equal(await f.discover(), null);
  });
});

describe("editor play session cleanup", () => {
  it("dispatches play-close after cancellation without detaching ordinary calls from the session", async () => {
    const sent: Array<{ name: string; signal: AbortSignal | undefined }> = [];
    const { tools, abort } = await computerFixture(async (name, _args, _binding, signal) => {
      // PluginProcess refuses an already-cancelled call before sending it to the backend.
      signal?.throwIfAborted();
      sent.push({ name, signal });
      return {};
    });
    assert.equal((await tools.ensureLoaded()).problem, null);
    await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "state" });
    abort.abort();
    await tools.release();
    const close = sent.find((call) => call.name === `example__${EnginePlayTool.Close}`);
    assert.ok(close, "the backend receives play-close even after the session is cancelled");
    assert.ok(close.signal);
    assert.notEqual(close.signal, abort.signal);
    assert.equal(close.signal.aborted, false);
    for (const call of sent.filter((entry) => entry !== close)) assert.equal(call.signal, abort.signal, call.name);
  });

  it("bounds a stalled cleanup with its own deadline", async (t) => {
    const cleanup = new AbortController();
    const deadlines: number[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      deadlines.push(ms);
      return cleanup.signal;
    });
    let closeSignal: AbortSignal | undefined;
    const { tools, abort } = await computerFixture(async (name, _args, _binding, signal) => {
      signal?.throwIfAborted();
      if (name !== `example__${EnginePlayTool.Close}`) return {};
      closeSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await tools.ensureLoaded();
    abort.abort();
    const release = tools.release();
    assert.deepEqual(deadlines, [10 * SECOND_MS]);
    assert.equal(closeSignal, cleanup.signal);
    cleanup.abort(new Error("cleanup deadline expired"));
    await release;
    assert.equal(closeSignal?.aborted, true);
  });
});

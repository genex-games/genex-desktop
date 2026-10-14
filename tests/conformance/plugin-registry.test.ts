/**
 * What the registry hands a Rust · wgpu game's plugins. A backend reads the bound game's stack from
 * its call context; a backend on an API before Rust never receives a stack value its SDK does not
 * name: for a Rust game it receives no stack at all. Skills follow the same API rule as the
 * manifest: a pre-Rust list naming every old stack reaches a Rust game's brief and skill tool.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GameStack } from "../../src/shared/game-project.ts";
import { PluginSourceKind, RUST_SKILL_STACKS_API } from "../../src/shared/plugins.ts";
import { PluginManifestError, PluginManifestRefusal } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { copyOfExample, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";

/** A backend whose every tool, action and review answers with what its call context held. */
const ECHO_BACKEND = `export async function activate() {
  const echo = async (_name, _args, ctx) => ({ hasStack: "stack" in ctx, stack: ctx.stack ?? null });
  return { tool: echo, action: echo, review: echo };
}
`;

interface Echo {
  hasStack: boolean;
  stack: string | null;
}

/** A registry seeded with an echo plugin on `apiVersion`, with a file skill naming `stacks`. */
async function echoRegistry(apiVersion: number, stacks: readonly GameStack[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-registry-"));
  after(() => rm(root, { recursive: true, force: true }));
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  const dir = await copyOfExample(seeds, "echo", (m) => {
    m.id = "echo";
    m.apiVersion = apiVersion;
    m.skills = [{ name: "card", summary: "A card read on demand.", file: "skills/card.md", stacks }];
  });
  await writeFile(path.join(dir, "backend.mjs"), ECHO_BACKEND);
  await mkdir(path.join(dir, "skills"));
  await writeFile(path.join(dir, "skills", "card.md"), "# Card\n\nRead on demand.\n");
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => ({}));
  await registry.init();
  after(() => registry.cancel());
  const game = path.join(root, "game");
  await mkdir(game);
  return { registry, binding: { project: "game", directory: game } };
}

const PRE_RUST = [GameStack.ThreeJs, GameStack.RaylibCpp];

describe("the stack a backend receives", () => {
  test("an API 3 backend bound to a Rust game receives no stack", async () => {
    const { registry, binding } = await echoRegistry(3, PRE_RUST);
    const rust = { ...binding, stack: GameStack.RustWgpu };
    const tool = (await registry.tool("echo__greet", { name: "x" }, rust)) as Echo;
    assert.deepEqual(tool, { hasStack: false, stack: null }, "tool");
    const action = (await registry.action("echo", "count", {}, rust)) as Echo;
    assert.deepEqual(action, { hasStack: false, stack: null }, "action");
    const review = (await registry.review("echo", "count", {}, rust)) as Echo;
    assert.deepEqual(review, { hasStack: false, stack: null }, "review");
  });

  test("an API 3 backend still receives the pre-Rust stacks it knows", async () => {
    const { registry, binding } = await echoRegistry(3, PRE_RUST);
    for (const stack of PRE_RUST) {
      const echo = (await registry.tool("echo__greet", { name: "x" }, { ...binding, stack })) as Echo;
      assert.deepEqual(echo, { hasStack: true, stack }, stack);
    }
  });

  test("a backend on the Rust-aware API receives rust-wgpu", async () => {
    const { registry, binding } = await echoRegistry(RUST_SKILL_STACKS_API, [GameStack.RustWgpu]);
    const echo = (await registry.tool("echo__greet", { name: "x" }, { ...binding, stack: GameStack.RustWgpu })) as Echo;
    assert.deepEqual(echo, { hasStack: true, stack: GameStack.RustWgpu });
  });
});

describe("the skills a Rust game is handed", () => {
  test("an API 3 card naming every pre-Rust stack reaches a Rust game's brief and skill tool", async () => {
    const { registry, binding } = await echoRegistry(3, PRE_RUST);
    const snapshot = registry.snapshot([], undefined, GameStack.RustWgpu);
    assert.deepEqual(snapshot.applied.skills, ["echo/card"]);
    const page = (await registry.tool("echo__skill", { name: "card" }, { ...binding, stack: GameStack.RustWgpu })) as {
      text: string;
    };
    assert.match(page.text, /Read on demand/);
  });

  test("an API 3 card for one pre-Rust stack is withheld from a Rust game, and refused by name", async () => {
    const { registry, binding } = await echoRegistry(3, [GameStack.RaylibCpp]);
    assert.deepEqual(registry.snapshot([], undefined, GameStack.RustWgpu).applied.skills, []);
    assert.deepEqual(registry.snapshot([], undefined, GameStack.RaylibCpp).applied.skills, ["echo/card"]);
    await assert.rejects(
      registry.tool("echo__skill", { name: "card" }, { ...binding, stack: GameStack.RustWgpu }),
      /not for this game's stack/,
    );
  });

  test("a Rust-only card on the Rust-aware API reaches only a Rust game", async () => {
    const { registry } = await echoRegistry(RUST_SKILL_STACKS_API, [GameStack.RustWgpu]);
    assert.deepEqual(registry.snapshot([], undefined, GameStack.RustWgpu).applied.skills, ["echo/card"]);
    assert.deepEqual(registry.snapshot([], undefined, GameStack.ThreeJs).applied.skills, []);
    assert.deepEqual(registry.snapshot([], undefined, GameStack.RaylibCpp).applied.skills, []);
  });

  test("an API 3 package naming rust-wgpu is refused, typed, and serves nothing", async () => {
    const { registry } = await echoRegistry(3, PRE_RUST);
    const base = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-rusty-"));
    after(() => rm(base, { recursive: true, force: true }));
    const dir = await copyOfExample(base, "rusty", (m) => {
      m.id = "rusty";
      m.apiVersion = 3;
      m.skills = [{ name: "card", text: "A Rust card.", stacks: [GameStack.RustWgpu] }];
    });
    await assert.rejects(
      registry.installLocal(dir, PluginSourceKind.Local),
      (error: unknown) =>
        error instanceof PluginManifestError && error.code === PluginManifestRefusal.RustSkillStackNeedsApi,
    );
    const tools = registry.snapshot([], undefined, GameStack.RustWgpu).tools.map((t) => t.name);
    assert.equal(
      tools.some((name) => name.startsWith("rusty__")),
      false,
    );
  });
});

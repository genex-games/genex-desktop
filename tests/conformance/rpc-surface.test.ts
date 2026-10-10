/**
 * Characterization of the substrate RPC surface: the table `StudioCore.api()` hands the harness.
 *
 * The harness is the agent's own code and is copied, not imported, so a renamed or dropped key
 * breaks it only at run time, in the middle of a run. These tests make any change to the table
 * a deliberate edit: add or remove a key here in the same change that adds or removes it there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { coreLite } from "../helpers/core-lite.ts";

const API_KEYS = [
  "artifact.read",
  "artifact.write",
  "assets.checkpoint",
  "assets.inventory",
  "capabilities.describe",
  "context.policy",
  "coordinator.tool",
  "engine.abort",
  "engine.complete",
  "engine.delegate",
  "engine.delegations",
  "engine.describe",
  "engine.hardware",
  "engine.interrupt",
  "engine.steer",
  "events.append",
  "events.head",
  "events.inbox",
  "events.list",
  "events.messages",
  "game.attached",
  "game.contentStamp",
  "game.export",
  "game.list",
  "game.read",
  "game.recents",
  "game.references",
  "game.scaffold",
  "game.setCover",
  "game.setCoverShader",
  "game.tree",
  "game.upgradeContract",
  "game.validate",
  "game.write",
  "guardian.rebuild_and_restart",
  "guardian.validate_edit",
  "guardian.write_self",
  "learning.enabled",
  "mcp.invoke",
  "mcp.tools",
  "optimization.baseline",
  "optimization.close",
  "optimization.freeze",
  "optimization.open",
  "optimization.promote",
  "optimization.reconcile",
  "plugins.invoke",
  "plugins.preflightMultiplayer",
  "plugins.tools",
  "preview.acquire",
  "preview.call",
  "preview.capacity",
  "preview.console",
  "preview.crop",
  "preview.diff",
  "preview.evaluate",
  "preview.gesture",
  "preview.gpuErrors",
  "preview.input",
  "preview.computer",
  "preview.load",
  "preview.observe",
  "preview.pageUi",
  "preview.pair",
  "preview.profile",
  "preview.ready",
  "preview.release",
  "preview.reload",
  "preview.screens",
  "preview.screenshot",
  "preview.showing",
  "preview.state",
  "preview.statsOf",
  "preview.status",
  "preview.viewport",
  "run.artifact",
  "run.exec",
  "snapshot.create",
  "snapshot.diff",
  "snapshot.list",
  "snapshot.markHealthy",
  "snapshot.removeWorktree",
  "snapshot.restore",
  "snapshot.worktree",
  "studio.context",
  "thread.create",
  "thread.fork",
  "thread.list",
  "thread.main",
  "turn.append",
  "turn.begin",
  "turn.end",
  "ui.notify",
];

/**
 * Names the seed calls that `api()` legitimately does not serve, each with the reason. Empty
 * today: every name the seed spells out resolves to a key.
 */
const NOT_SERVED_BY_API: Record<string, string> = {};

test("core.api() exposes exactly the golden substrate method table", async () => {
  const { api } = await coreLite({ init: false });
  const table: Record<string, unknown> = api();
  assert.deepEqual(
    Object.keys(table).sort(),
    [...API_KEYS].sort(),
    "a change to the harness RPC surface must update this list deliberately",
  );
  for (const key of API_KEYS) assert.equal(typeof table[key], "function", key);
});

const seed = path.resolve(import.meta.dirname, "../../src/harness-seed");
const boot = path.resolve(import.meta.dirname, "../../src/harness-boot");

async function sourcesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.(ts|mjs|js)$/.test(e.name) && !e.name.endsWith(".d.ts"))
    .map((e) => path.join(e.parentPath, e.name));
}

/**
 * Every method name the harness passes to a `.call(...)` — `ctx.call`, `host.call` and the
 * scoped wrappers (`bounded`, `wrapped`, `callCtx`) all forward to the same table — written as a
 * literal (`"events.list"`) or as a member of the seed's generated copy of `HostMethod`
 * (`HostMethod.EventsList`; an unknown member is recorded as written, so it fails below). The
 * seed files are read as data here, to derive the contract the harness depends on; nothing about
 * the core's implementation text is asserted.
 */
async function seedCallNames(): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  const methods: Readonly<Record<string, string>> = HostMethod;
  for (const file of [...(await sourcesUnder(seed)), ...(await sourcesUnder(boot))]) {
    const text = await readFile(file, "utf8");
    const where = path.relative(path.resolve(import.meta.dirname, "../.."), file);
    const add = (name: string) => names.set(name, [...(names.get(name) ?? []), where]);
    for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\.call\(\s*(["'`])([a-zA-Z_]+\.[a-zA-Z_.]+)\1/g))
      add(match[2] ?? "");
    for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\.call\(\s*HostMethod\.([A-Za-z_$][\w$]*)/g)) {
      const member = match[1] ?? "";
      add(Object.hasOwn(methods, member) ? (methods[member] ?? "") : `HostMethod.${member}`);
    }
  }
  return names;
}

test("contract: every substrate method the harness seed calls by name is a key of core.api()", async () => {
  const { api } = await coreLite({ init: false });
  const keys = new Set(Object.keys(api()));
  const called = await seedCallNames();
  // A scan that found nothing would pass vacuously; the seed names dozens of methods.
  assert.ok(called.size >= 50, `only ${called.size} call names found — has the scan stopped matching?`);
  for (const known of ["events.list", "engine.complete", "preview.load", "snapshot.worktree", "turn.begin"])
    assert.ok(called.has(known), known);
  const missing = [...called]
    .filter(([name]) => !keys.has(name) && !(name in NOT_SERVED_BY_API))
    .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
  assert.deepEqual(missing, [], "the harness calls methods the core does not serve");
  for (const name of Object.keys(NOT_SERVED_BY_API))
    assert.ok(called.has(name) && !keys.has(name), `stale allowlist entry: ${name}`);
});

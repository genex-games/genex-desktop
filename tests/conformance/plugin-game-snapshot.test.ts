/**
 * `game.snapshot`: a `game-engine` plugin takes a snapshot of the game it is bound to before it
 * changes files there (the Unreal plugin, before it updates the Genex editor helper in the game's
 * project). The snapshot is an ordinary game snapshot, listed in Rewind under the plugin's reason. A plugin without `game-engine`, a call bound to no game and a
 * reason that is not one plain line are refused, and take no snapshot.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { personAllowsLocalTools } from "../helpers/plugins.ts";

const SNAP_TOOL = "snapdemo__snap";
const PLAIN_TOOL = "plaindemo__snap";
/** The longest reason a plugin may give (`MAX_SNAPSHOT_REASON_CHARS` in services.ts). */
const REASON_MAX = 200;

/** A local plugin whose `snap` tool asks the host for a snapshot of its bound game, with the given reason. */
async function snapPackage(id: string, capabilities: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `studio-${id}-`));
  const manifest = {
    apiVersion: 3,
    id,
    version: "1.0.0",
    name: `Demo ${id}`,
    publisher: "Studio tests",
    description: "Snapshots its game.",
    backend: "backend.mjs",
    capabilities,
    tools: [
      {
        name: "snap",
        description: "Snapshot the game.",
        parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
      },
    ],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    "export async function activate(){return {tool(n,a,c){return c.host('game.snapshot',{reason:a.reason})}};}\n",
  );
  return dir;
}

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) {
    lite.core.plugins.cancel();
    await lite.close();
  }
});

async function world() {
  const lite = await coreLite();
  lites.push(lite);
  const { core } = lite;
  await core.plugins.installLocal(await snapPackage("snapdemo", ["game-engine"]), "local", ["game-engine"]);
  await core.plugins.installLocal(await snapPackage("plaindemo", []), "local", []);
  // Loaded from folders, they start off: the person turns them on and allows their tools.
  for (const id of ["snapdemo", "plaindemo"]) await core.plugins.setEnabled(id, true);
  personAllowsLocalTools(core.plugins);
  const game = await core.games.scaffold("valley");
  const threadId = await core.threadForGame(game.name);
  const binding = { project: game.name, directory: game.dir, threadId };
  const count = () => core.snapshotIndex.all().length;
  return { core, binding, count };
}

it("snapshots the bound game under the plugin's reason, as Rewind lists it", async () => {
  const { core, binding } = await world();
  const answer = (await core.plugins.tool(SNAP_TOOL, { reason: "Before helper update" }, binding)) as {
    snapshotId?: string;
  };
  assert.equal(typeof answer.snapshotId, "string");
  const record = core.snapshotIndex.get(String(answer.snapshotId));
  assert.ok(record, "the snapshot is on the record");
  assert.equal(record.scope, SnapshotScope.Game);
  assert.equal(record.reason, "Before helper update");
});

it("refuses a plugin without game-engine, a call bound to no game and a reason that is not one plain line", async () => {
  const { core, binding, count } = await world();
  const before = count();
  const hostile: Array<{ label: string; call: () => Promise<unknown>; refusal: RegExp }> = [
    {
      label: "a plugin without game-engine",
      call: () => core.plugins.tool(PLAIN_TOOL, { reason: "Before helper update" }, binding),
      refusal: /capability denied/,
    },
    {
      label: "no bound game",
      call: () => core.pluginServices.call("snapdemo", "game.snapshot", { reason: "Before helper update" }),
      refusal: /Project required/,
    },
    ...["", "   ", "two\nlines", "a\u0000nul", "x".repeat(REASON_MAX + 1)].map((reason) => ({
      label: `the reason ${JSON.stringify(reason.slice(0, 12))}`,
      call: () => core.plugins.tool(SNAP_TOOL, { reason }, binding),
      refusal: /Invalid snapshot reason/,
    })),
    {
      label: "a reason that is not text",
      call: () => core.pluginServices.call("snapdemo", "game.snapshot", { reason: 42 }, binding),
      refusal: /Invalid snapshot reason/,
    },
  ];
  for (const { label, call, refusal } of hostile) await assert.rejects(call(), refusal, label);
  assert.equal(count(), before, "no snapshot was taken");
});

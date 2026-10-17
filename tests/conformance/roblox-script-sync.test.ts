import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { HelperAsk } from "../../src/plugins/roblox/helper-link.ts";
import { HelperLinkError, HelperLinkFailure } from "../../src/plugins/roblox/helper-link.ts";
import {
  HelperErrorCode,
  HelperMessage,
  helperHash,
  type HelperRequest,
  type HelperRequestBodies,
  RunContext,
  ScriptClass,
  type ScriptRef,
} from "../../src/plugins/roblox/helper-protocol.ts";
import { PENDING_SCRIPTS, writePendingScripts } from "../../src/plugins/roblox/place-files.ts";
import { scriptKey } from "../../src/plugins/roblox/script-paths.ts";
import {
  createScriptSync,
  createScriptSyncs,
  SCRIPT_RECORD,
  ScriptSyncMode,
  SYNC_DEBOUNCE_MS,
  type WatchFolder,
} from "../../src/plugins/roblox/script-sync.ts";
import { manualClock } from "../helpers/roblox-helper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MAIN: ScriptRef = {
  path: ["ServerScriptService", "Main"],
  class: ScriptClass.Script,
  runContext: RunContext.Legacy,
};
const MAIN_FILE = "src/ServerScriptService/Main.server.luau";
const SHARED: ScriptRef = { path: ["ReplicatedStorage", "Shared"], class: ScriptClass.ModuleScript };
const SHARED_FILE = "src/ReplicatedStorage/Shared.luau";

type Sent = { type: HelperRequest; body: unknown };

/**
 * The Genex helper in Studio, for one place: its scripts by key, each with its source and whether
 * Script Sync keeps it; it answers list, read, write (refusing a stale `base` with a conflict) and
 * remove (only while the hash matches), as the real helper does, and records every request.
 */
function fakeHelper(initial: Array<{ ref: ScriptRef; source: string; synced?: boolean }> = []) {
  const scripts = new Map(initial.map((entry) => [scriptKey(entry.ref), { synced: false, ...entry }]));
  const sent: Sent[] = [];
  const fail = (code: string, message: string) => new HelperLinkError(HelperLinkFailure.Answered, message, code);
  const handlers: { [T in HelperRequest]?: (body: HelperRequestBodies[T]) => unknown } = {
    [HelperMessage.ScriptsList]: () => ({
      scripts: [...scripts.values()].map(({ ref, source, synced }) => ({ ...ref, hash: helperHash(source), synced })),
    }),
    [HelperMessage.ScriptsRead]: (body) => ({
      scripts: body.scripts.flatMap((ref) => {
        const found = scripts.get(scriptKey(ref));
        return found ? [{ ...ref, source: found.source }] : [];
      }),
    }),
    [HelperMessage.ScriptsWrite]: (body) => {
      const found = scripts.get(scriptKey(body.script));
      if (body.base !== undefined && (!found || helperHash(found.source) !== body.base))
        throw fail(HelperErrorCode.Conflict, "changed in Studio");
      if (found?.synced) throw fail(HelperErrorCode.Refused, "Script Sync keeps it");
      scripts.set(scriptKey(body.script), { ref: body.script, source: body.source, synced: false });
      return { hash: helperHash(body.source) };
    },
    [HelperMessage.ScriptsRemove]: (body) => {
      const found = scripts.get(scriptKey(body.script));
      if (!found) return { removed: false };
      if (helperHash(found.source) !== body.hash) throw fail(HelperErrorCode.Conflict, "changed in Studio");
      scripts.delete(scriptKey(body.script));
      return { removed: true };
    },
  };
  const ask = (async (type, body) => {
    sent.push({ type, body });
    const handler = handlers[type] as ((body: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`unexpected ${type}`);
    return handler(body);
  }) as HelperAsk;
  return {
    ask,
    sent,
    source: (ref: ScriptRef) => scripts.get(scriptKey(ref))?.source,
    /** A person's edit in Studio, which the helper reports as `scripts.changed`. */
    edit: (ref: ScriptRef, source: string | null) => {
      if (source === null) scripts.delete(scriptKey(ref));
      else scripts.set(scriptKey(ref), { ref, source, synced: scripts.get(scriptKey(ref))?.synced ?? false });
      return { ...ref, source };
    },
    writes: () => sent.filter((entry) => entry.type === HelperMessage.ScriptsWrite),
    removes: () => sent.filter((entry) => entry.type === HelperMessage.ScriptsRemove),
  };
}

/** A watcher the test fires by hand, as fs.watch would after a write under `src/`. */
function handWatch() {
  const watching: Array<{ folder: string; onChange(): void; closed: boolean }> = [];
  const watch: WatchFolder = (folder, onChange) => {
    const entry = { folder, onChange, closed: false };
    watching.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
    };
  };
  return {
    watch,
    fire: () => {
      for (const entry of watching) if (!entry.closed) entry.onChange();
    },
    watching,
  };
}

async function gameFolder(files: Record<string, string> = {}) {
  const root = await realpath(await tmpDir("roblox-script-sync-"));
  const folder = path.join(root, "game");
  await mkdir(folder, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), text);
  }
  return { root, folder };
}

const read = (folder: string, file: string) => readFile(path.join(folder, file), "utf8");
const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

async function setUp(options: { files?: Record<string, string>; studio?: Parameters<typeof fakeHelper>[0] } = {}) {
  const { root, folder } = await gameFolder(options.files);
  const helper = fakeHelper(options.studio);
  const clock = manualClock();
  const watcher = handWatch();
  const log: string[] = [];
  const sync = createScriptSync({
    folder,
    ask: helper.ask,
    clock,
    watch: watcher.watch,
    log: (line) => log.push(line),
  });
  /** A file change: the watcher fires, and the pass runs once the quiet time has passed. */
  const settle = async () => {
    watcher.fire();
    clock.advance(SYNC_DEBOUNCE_MS);
    await sync.idle();
  };
  return { root, folder, helper, clock, watcher, sync, log, settle };
}

test("a file edited on disk is pushed to Studio once, with Studio's last hash, and nothing echoes back", async () => {
  const world = await setUp({ files: { [MAIN_FILE]: "print(1)\n" }, studio: [{ ref: MAIN, source: "print(1)\n" }] });
  assert.equal(await world.sync.start(), ScriptSyncMode.On);
  assert.equal(world.helper.writes().length, 0, "already in step");
  await writeFile(path.join(world.folder, MAIN_FILE), "print(2)\n");
  world.watcher.fire();
  world.clock.advance(SYNC_DEBOUNCE_MS - 1);
  await world.sync.idle();
  assert.equal(world.helper.writes().length, 0, "the quiet time hasn't passed");
  world.clock.advance(1);
  await world.sync.idle();
  assert.deepEqual(world.helper.writes(), [
    {
      type: HelperMessage.ScriptsWrite,
      body: { script: MAIN, source: "print(2)\n", base: helperHash("print(1)\n") },
    },
  ]);
  assert.equal(world.helper.source(MAIN), "print(2)\n");
  // The record's own write and a helper that reports the change anyway: neither is pushed again.
  await world.settle();
  await world.sync.changed({ ...MAIN, source: "print(2)\n" });
  await world.settle();
  assert.equal(world.helper.writes().length, 1);
  assert.equal(await read(world.folder, MAIN_FILE), "print(2)\n");
  const record = JSON.parse(await read(world.folder, SCRIPT_RECORD.join("/")));
  assert.equal(record.scripts["ServerScriptService/Main.server.luau"], helperHash("print(2)\n"));
});

test("a flush with a limit settles at that limit while Studio doesn't answer, and each push it sends asks within it", async () => {
  const { folder } = await gameFolder({ [MAIN_FILE]: "print(1)\n" });
  const helper = fakeHelper([{ ref: MAIN, source: "print(1)\n" }]);
  const clock = manualClock();
  const asked: Array<{ type: HelperRequest; timeoutMs: number | undefined }> = [];
  const held = { writes: false, lists: false };
  let reached = () => {};
  const pushed = new Promise<void>((resolve) => {
    reached = resolve;
  });
  // A dialog in Studio holds the helper: the requests it holds never answer.
  const ask = ((type, body, options) => {
    asked.push({ type, timeoutMs: options?.timeoutMs });
    if (type === HelperMessage.ScriptsWrite && held.writes) {
      reached();
      return new Promise(() => {});
    }
    if (type === HelperMessage.ScriptsList && held.lists) return new Promise(() => {});
    return helper.ask(type, body, options);
  }) as HelperAsk;
  const sync = createScriptSync({ folder, ask, clock, watch: handWatch().watch });
  assert.equal(await sync.start(), ScriptSyncMode.On);
  held.writes = true;
  await writeFile(path.join(folder, MAIN_FILE), "print(2)\n");
  let settled = false;
  const flushed = sync.flush(2_000).then(() => {
    settled = true;
  });
  await pushed;
  assert.deepEqual(asked.at(-1), { type: HelperMessage.ScriptsWrite, timeoutMs: 2_000 });
  clock.advance(1_999);
  await tick();
  assert.equal(settled, false, "the limit isn't shortened");
  clock.advance(1);
  await flushed;

  // Queued behind a reconcile that never ends (a new binding while the dialog stays open).
  const { folder: other } = await gameFolder({ [MAIN_FILE]: "print(1)\n" });
  held.writes = false;
  const queued = createScriptSync({ folder: other, ask, clock, watch: handWatch().watch });
  assert.equal(await queued.start(), ScriptSyncMode.On);
  held.lists = true;
  void queued.start();
  const behind = queued.flush(2_000);
  clock.advance(2_000);
  await behind;
});

test("a script changed in Studio is written to its file once and never pushed back", async () => {
  const world = await setUp({ files: { [MAIN_FILE]: "print(1)\n" }, studio: [{ ref: MAIN, source: "print(1)\n" }] });
  await world.sync.start();
  await world.sync.changed(world.helper.edit(MAIN, "print('studio')\n"));
  assert.equal(await read(world.folder, MAIN_FILE), "print('studio')\n");
  await world.settle();
  assert.equal(world.helper.writes().length, 0, "the file's own change isn't an edit to push");
  await world.sync.changed(world.helper.edit(SHARED, "return {}\n"));
  assert.equal(await read(world.folder, SHARED_FILE), "return {}\n", "a new script gets its Rojo-named file");
  await world.sync.changed(world.helper.edit(SHARED, null));
  assert.equal(await exists(path.join(world.folder, SHARED_FILE)), false, "removed in Studio, unchanged on disk");
});

test("edited in both places since the last sync: Studio's stays, the disk version goes to .genex/conflicts", async () => {
  const world = await setUp({ files: { [MAIN_FILE]: "base\n" }, studio: [{ ref: MAIN, source: "base\n" }] });
  await world.sync.start();
  await writeFile(path.join(world.folder, MAIN_FILE), "disk\n");
  await world.sync.changed(world.helper.edit(MAIN, "studio\n"));
  assert.equal(world.helper.source(MAIN), "studio\n");
  assert.equal(await read(world.folder, MAIN_FILE), "studio\n");
  const stamp = new Date(world.clock.now()).toISOString().replace(/[:.]/g, "-");
  assert.equal(await read(world.folder, `.genex/conflicts/${stamp}/${MAIN_FILE.slice(4)}`), "disk\n");
  await world.settle();
  assert.equal(world.helper.writes().length, 0);
});

test("a push that meets a Studio edit it hadn't heard of yet keeps Studio's and saves the disk version", async () => {
  const world = await setUp({ files: { [MAIN_FILE]: "base\n" }, studio: [{ ref: MAIN, source: "base\n" }] });
  await world.sync.start();
  world.helper.edit(MAIN, "studio\n");
  await writeFile(path.join(world.folder, MAIN_FILE), "disk\n");
  await world.settle();
  assert.equal(world.helper.source(MAIN), "studio\n", "the helper refused the stale base");
  assert.equal(await read(world.folder, MAIN_FILE), "studio\n");
  const conflicts = await readdir(path.join(world.folder, ".genex", "conflicts"), { recursive: true });
  assert.ok(conflicts.some((name) => name.endsWith("Main.server.luau")));
});

test("the reconcile on (re)connect decides each script by what changed since the last sync", async () => {
  const studio = [
    { ref: MAIN, source: "same\n" },
    { ref: module("ReplicatedStorage", "StudioNew"), source: "studio new\n" },
    { ref: module("ReplicatedStorage", "DiskGone"), source: "kept\n" },
    { ref: module("ReplicatedStorage", "DiskEdited"), source: "old\n" },
    { ref: module("ReplicatedStorage", "StudioEdited"), source: "studio\n" },
    { ref: module("ReplicatedStorage", "BothEdited"), source: "studio both\n" },
  ];
  const files = {
    [MAIN_FILE]: "same\n",
    "src/ReplicatedStorage/DiskNew.luau": "disk new\n",
    "src/ReplicatedStorage/StudioGone.luau": "kept\n",
    "src/ReplicatedStorage/DiskEdited.luau": "new\n",
    "src/ReplicatedStorage/StudioEdited.luau": "old\n",
    "src/ReplicatedStorage/BothEdited.luau": "disk both\n",
  };
  const record = {
    v: 1,
    written: [],
    scripts: Object.fromEntries(
      ["DiskGone", "StudioGone", "DiskEdited", "StudioEdited", "BothEdited"].map((name) => [
        `ReplicatedStorage/${name}.luau`,
        helperHash(name.endsWith("Gone") ? "kept\n" : "old\n"),
      ]),
    ),
  };
  const world = await setUp({ files: { ...files, ".genex/roblox.json": JSON.stringify(record) }, studio });
  await world.sync.start();
  const at = (name: string) => `src/ReplicatedStorage/${name}.luau`;
  assert.equal(await read(world.folder, at("StudioNew")), "studio new\n", "new in Studio: written to disk");
  assert.equal(world.helper.source(module("ReplicatedStorage", "DiskNew")), "disk new\n", "new on disk: pushed");
  assert.equal(world.helper.source(module("ReplicatedStorage", "DiskGone")), undefined, "deleted on disk: removed");
  assert.equal(await exists(path.join(world.folder, at("StudioGone"))), false, "removed in Studio: file deleted");
  assert.equal(world.helper.source(module("ReplicatedStorage", "DiskEdited")), "new\n");
  assert.equal(await read(world.folder, at("StudioEdited")), "studio\n");
  assert.equal(world.helper.source(module("ReplicatedStorage", "BothEdited")), "studio both\n");
  assert.equal(await read(world.folder, at("BothEdited")), "studio both\n");
  const conflicts = await readdir(path.join(world.folder, ".genex", "conflicts"), { recursive: true });
  assert.ok(conflicts.some((name) => name.endsWith("BothEdited.luau")));
  assert.deepEqual(
    world.helper.removes().map((entry) => entry.body),
    [{ script: module("ReplicatedStorage", "DiskGone"), hash: helperHash("kept\n") }],
  );
});

test("after a restore the restored files win: each goes to Studio, one Studio has alone goes, none is written over", async () => {
  // Git put back src/ and the record together, so the record matches the restored files; Studio
  // still holds the newer scripts (no export was loaded, or an older one).
  const restored = {
    [MAIN_FILE]: "v1\n",
    "src/ReplicatedStorage/OnlyRestored.luau": "restored\n",
  };
  const record = {
    v: 1,
    written: [],
    scripts: {
      "ServerScriptService/Main.server.luau": helperHash("v1\n"),
      "ReplicatedStorage/OnlyRestored.luau": helperHash("restored\n"),
    },
  };
  const studio = [
    { ref: MAIN, source: "v2\n" },
    { ref: module("ReplicatedStorage", "AddedLater"), source: "later\n" },
  ];
  const world = await setUp({ files: { ...restored, ".genex/roblox.json": JSON.stringify(record) }, studio });
  assert.equal(await world.sync.start({ restored: true }), ScriptSyncMode.On);
  assert.equal(await read(world.folder, MAIN_FILE), "v1\n", "the restored file stays");
  assert.equal(world.helper.source(MAIN), "v1\n", "and goes to Studio");
  assert.equal(world.helper.source(module("ReplicatedStorage", "OnlyRestored")), "restored\n");
  assert.equal(world.helper.source(module("ReplicatedStorage", "AddedLater")), undefined, "gone, as at the save point");
  assert.equal(await exists(path.join(world.folder, "src/ReplicatedStorage/AddedLater.luau")), false);
  assert.equal(await exists(path.join(world.folder, ".genex", "conflicts")), false, "no conflict: the restore decided");
  // The next connection's ordinary reconcile finds them in step.
  const writes = world.helper.writes().length;
  await world.sync.start();
  assert.equal(world.helper.writes().length, writes);
  assert.equal(await read(world.folder, MAIN_FILE), "v1\n");
});

test("a deleted file removes its script only while Studio's hash still matches the record", async () => {
  const world = await setUp({
    files: { [MAIN_FILE]: "a\n", [SHARED_FILE]: "b\n" },
    studio: [
      { ref: MAIN, source: "a\n" },
      { ref: SHARED, source: "b\n" },
    ],
  });
  await world.sync.start();
  world.helper.edit(SHARED, "edited in Studio\n");
  await rm(path.join(world.folder, MAIN_FILE));
  await rm(path.join(world.folder, SHARED_FILE));
  await world.settle();
  assert.equal(world.helper.source(MAIN), undefined, "unchanged in Studio: removed");
  assert.equal(world.helper.source(SHARED), "edited in Studio\n", "changed in Studio: kept");
  assert.equal(await read(world.folder, SHARED_FILE), "edited in Studio\n", "and its file comes back");
});

test("a file moved to another name for the same script keeps the script in Studio", async () => {
  const world = await setUp({ files: { [MAIN_FILE]: "print(1)\n" }, studio: [{ ref: MAIN, source: "print(1)\n" }] });
  await world.sync.start();
  await rm(path.join(world.folder, MAIN_FILE));
  await mkdir(path.join(world.folder, "src/ServerScriptService/Main"));
  await writeFile(path.join(world.folder, "src/ServerScriptService/Main/init.server.luau"), "print(1)\n");
  await world.settle();
  assert.equal(world.helper.source(MAIN), "print(1)\n");
  assert.deepEqual(world.helper.removes(), []);
  const record = JSON.parse(await read(world.folder, SCRIPT_RECORD.join("/")));
  assert.deepEqual(Object.keys(record.scripts), ["ServerScriptService/Main/init.server.luau"]);
});

test("a src folder that is a link is refused: nothing is asked of Studio and nothing written anywhere", async (t) => {
  if (process.platform === "win32") t.skip("creating links needs a privilege the Windows runner may lack");
  const { root, folder } = await gameFolder();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(folder, "src"), "dir");
  const helper = fakeHelper([{ ref: MAIN, source: "print(1)\n" }]);
  const watcher = handWatch();
  const sync = createScriptSync({ folder, ask: helper.ask, clock: manualClock(), watch: watcher.watch });
  assert.equal(await sync.start(), ScriptSyncMode.Refused);
  await sync.changed({ ...MAIN, source: "print(2)\n" });
  assert.deepEqual(helper.sent, []);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await exists(path.join(folder, ".genex")), false);
  assert.equal(watcher.watching.length, 0);
});

test("links inside src are never followed: a linked folder or file is neither read nor written", async (t) => {
  if (process.platform === "win32") t.skip("creating links needs a privilege the Windows runner may lack");
  const world = await setUp({ studio: [] });
  const outside = path.join(world.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "Secret.luau"), "secret\n");
  await mkdir(path.join(world.folder, "src"), { recursive: true });
  await symlink(outside, path.join(world.folder, "src", "ServerStorage"), "dir");
  await mkdir(path.join(world.folder, "src", "ReplicatedStorage"));
  await symlink(path.join(outside, "Secret.luau"), path.join(world.folder, "src", "ReplicatedStorage", "Linked.luau"));
  await mkdir(path.join(world.folder, "src", "ServerScriptService"));
  await writeFile(path.join(world.folder, "src", "ServerScriptService", "Plain.luau"), "plain\n");
  await world.sync.start();
  assert.deepEqual(
    world.helper.writes().map((entry) => (entry.body as { script: ScriptRef }).script),
    [module("ServerScriptService", "Plain")],
    "only the plain file is pushed; nothing reached through a link",
  );
  await world.sync.changed(world.helper.edit(module("ServerStorage", "Secret"), "overwritten\n"));
  await world.sync.changed(world.helper.edit(module("ReplicatedStorage", "Linked"), "overwritten\n"));
  assert.equal(await readFile(path.join(outside, "Secret.luau"), "utf8"), "secret\n");
  assert.deepEqual(await readdir(outside), ["Secret.luau"]);
});

test("scripts Studio's Script Sync keeps in files of their own are skipped both ways", async () => {
  const synced: ScriptRef = module("ReplicatedStorage", "Synced");
  const world = await setUp({
    files: { "src/ReplicatedStorage/Synced.luau": "disk\n" },
    studio: [
      { ref: synced, source: "studio\n", synced: true },
      { ref: SHARED, source: "return {}\n" },
    ],
  });
  await world.sync.start();
  assert.equal(await read(world.folder, SHARED_FILE), "return {}\n", "the script beside it is kept in step");
  assert.equal(await read(world.folder, "src/ReplicatedStorage/Synced.luau"), "disk\n", "not written from Studio");
  assert.equal(world.helper.writes().length, 0, "not pushed");
  await writeFile(path.join(world.folder, "src/ReplicatedStorage/Synced.luau"), "disk 2\n");
  await world.settle();
  await world.sync.changed(world.helper.edit(synced, "studio 2\n"));
  assert.equal(await read(world.folder, "src/ReplicatedStorage/Synced.luau"), "disk 2\n");
  assert.equal(world.helper.writes().length, 0);
});

test("a person's own default.project.json turns Genex's sync off; one Genex wrote doesn't", async () => {
  const world = await setUp({
    files: { "default.project.json": "{}", [MAIN_FILE]: "disk\n" },
    studio: [
      { ref: MAIN, source: "studio\n" },
      { ref: SHARED, source: "return {}\n" },
    ],
  });
  assert.equal(await world.sync.start(), ScriptSyncMode.Rojo);
  await writeFile(path.join(world.folder, MAIN_FILE), "disk 2\n");
  await world.settle();
  await world.sync.changed(world.helper.edit(SHARED, "return 1\n"));
  assert.deepEqual(world.helper.sent, [], "Rojo keeps the scripts in step");
  assert.equal(await exists(path.join(world.folder, SHARED_FILE)), false);
  assert.equal(await read(world.folder, MAIN_FILE), "disk 2\n");

  const genex = await setUp({
    files: {
      "default.project.json": "{}",
      ".genex/roblox.json": JSON.stringify({ v: 1, written: ["default.project.json"], scripts: {} }),
    },
    studio: [{ ref: SHARED, source: "return {}\n" }],
  });
  assert.equal(await genex.sync.start(), ScriptSyncMode.On);
  assert.equal(await read(genex.folder, SHARED_FILE), "return {}\n");
});

test("a project file Genex lists as its own while the sync runs keeps the sync on", async () => {
  const world = await setUp({ studio: [{ ref: SHARED, source: "return {}\n" }] });
  assert.equal(await world.sync.start(), ScriptSyncMode.On);
  // Use in this game lists the file first, then writes it: the next pass still sees Genex's file.
  await world.sync.written("default.project.json");
  await writeFile(path.join(world.folder, "default.project.json"), "{}");
  assert.equal(await world.sync.start(), ScriptSyncMode.On);
  const record = JSON.parse(await read(world.folder, SCRIPT_RECORD.join("/")));
  assert.deepEqual(record.written, ["default.project.json"]);
  assert.ok(record.scripts["ReplicatedStorage/Shared.luau"], "the scripts' hashes are kept beside it");
});

test("Studio's lock files beside a place are kept out of save points", async () => {
  const world = await setUp({ files: { ".gitignore": "node_modules\n" } });
  await world.sync.start();
  await world.sync.start();
  assert.equal(await read(world.folder, ".gitignore"), "node_modules\n*.rbxl.lock\n*.rbxlx.lock\n");
});

test("a source longer than Studio takes is left on disk with a note, not pushed", async () => {
  const world = await setUp({ files: { [MAIN_FILE]: `-- ${"x".repeat(200_001)}\n` }, studio: [] });
  await world.sync.start();
  assert.equal(world.helper.writes().length, 0);
  assert.ok(world.log.some((line) => line.includes("Main.server.luau")));
});

test("a change Studio refuses while a play test runs is sent again once the test ends", async () => {
  const { folder } = await gameFolder({ [MAIN_FILE]: "print(1)\n", [SHARED_FILE]: "return {}\n" });
  const helper = fakeHelper([
    { ref: MAIN, source: "print(1)\n" },
    { ref: SHARED, source: "return {}\n" },
  ]);
  const clock = manualClock();
  const watcher = handWatch();
  const studio = { playing: false };
  const busy = () =>
    new HelperLinkError(HelperLinkFailure.Answered, "Studio is running the game", HelperErrorCode.Busy);
  const ask = (async (type, body, options) => {
    const changes = type === HelperMessage.ScriptsWrite || type === HelperMessage.ScriptsRemove;
    if (studio.playing && changes) throw busy();
    return helper.ask(type, body, options);
  }) as HelperAsk;
  const sync = createScriptSync({ folder, ask, clock, watch: watcher.watch });
  assert.equal(await sync.start(), ScriptSyncMode.On);
  studio.playing = true;
  await writeFile(path.join(folder, MAIN_FILE), "print(2)\n");
  await rm(path.join(folder, SHARED_FILE));
  watcher.fire();
  clock.advance(SYNC_DEBOUNCE_MS);
  await sync.idle();
  assert.equal(helper.source(MAIN), "print(1)\n", "refused while the test runs");
  clock.advance(60_000);
  await sync.idle();
  assert.equal(helper.source(MAIN), "print(1)\n", "still refused while it runs on");
  studio.playing = false;
  clock.advance(60_000);
  await sync.idle();
  assert.equal(helper.source(MAIN), "print(2)\n", "sent once the test ended, with no file change to wake it");
  assert.equal(helper.source(SHARED), undefined, "and the deletion carried too");
  const writes = helper.writes().length;
  clock.advance(60_000);
  await sync.idle();
  assert.equal(helper.writes().length, writes, "nothing more to send: no further tries");
  assert.equal(clock.pending(), 0);
  sync.stop();
});

test("a watch that errors is armed again, so later file changes still reach Studio", async () => {
  const { folder } = await gameFolder({ [MAIN_FILE]: "print(1)\n" });
  const helper = fakeHelper([{ ref: MAIN, source: "print(1)\n" }]);
  const clock = manualClock();
  const watches: Array<{ onChange(): void; onError(error: unknown): void; closed: boolean }> = [];
  const watch: WatchFolder = (_folder, onChange, onError) => {
    const entry = { onChange, onError: onError ?? (() => {}), closed: false };
    watches.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
    };
  };
  const sync = createScriptSync({ folder, ask: helper.ask, clock, watch });
  assert.equal(await sync.start(), ScriptSyncMode.On);
  watches[0]?.onError(new Error("EMFILE: too many open files"));
  clock.advance(60_000);
  await sync.idle();
  const live = watches.filter((entry) => !entry.closed);
  assert.equal(watches.length, 2, "armed again");
  assert.equal(live.length, 1, "one watch at a time");
  await writeFile(path.join(folder, MAIN_FILE), "print(2)\n");
  live[0]?.onChange();
  clock.advance(SYNC_DEBOUNCE_MS);
  await sync.idle();
  assert.equal(helper.source(MAIN), "print(2)\n");
  sync.stop();
  assert.equal(clock.pending(), 0, "a stopped sync arms nothing");
});

/** Ways a script file the scan finds can't be taken; each leaves the file where it was. */
const UNTAKEN_FILES: Array<{ why: string; links?: boolean; make(folder: string, file: string): Promise<void> }> = [
  {
    why: "is longer than Studio takes",
    make: (folder, file) => writeFile(path.join(folder, file), `-- ${"x".repeat(200_001)}\n`),
  },
  {
    why: "isn't UTF-8 text",
    make: (folder, file) => writeFile(path.join(folder, file), Buffer.from([0x2d, 0x2d, 0xff, 0xfe, 0x0a])),
  },
  {
    why: "became a link",
    links: true,
    make: async (folder, file) => {
      const outside = path.join(path.dirname(folder), "outside.luau");
      await writeFile(outside, "outside\n");
      await rm(path.join(folder, file));
      await symlink(outside, path.join(folder, file));
    },
  },
  {
    why: "sits in a folder that can't be listed",
    links: true,
    make: (folder, file) => chmod(path.dirname(path.join(folder, file)), 0o000),
  },
];

for (const row of UNTAKEN_FILES) {
  test(`a script file that ${row.why} counts as present: Studio's copy and its record stay`, async (t) => {
    if (row.links && process.platform === "win32") t.skip("links and folder modes differ on Windows");
    const world = await setUp({
      files: { [MAIN_FILE]: "print(1)\n", [SHARED_FILE]: "return {}\n" },
      studio: [
        { ref: MAIN, source: "print(1)\n" },
        { ref: SHARED, source: "return {}\n" },
      ],
    });
    t.after(() => chmod(path.dirname(path.join(world.folder, MAIN_FILE)), 0o755).catch(() => {}));
    await world.sync.start();
    await row.make(world.folder, MAIN_FILE);
    await world.settle();
    await world.sync.changed(world.helper.edit(SHARED, "return 1\n"));
    assert.equal(await world.sync.start(), ScriptSyncMode.On);
    assert.deepEqual(world.helper.removes(), [], "nothing removed from Studio");
    assert.equal(world.helper.source(MAIN), "print(1)\n");
    const record = JSON.parse(await read(world.folder, SCRIPT_RECORD.join("/")));
    assert.equal(record.scripts["ServerScriptService/Main.server.luau"], helperHash("print(1)\n"), "still recorded");
    assert.equal(record.scripts["ReplicatedStorage/Shared.luau"], helperHash("return 1\n"), "the others sync on");
    assert.ok(
      world.log.some((line) => line.includes("src/ServerScriptService")),
      "and a note says why",
    );
  });
}

test("the sync for many games: a game's folder is learnt from its calls, and its helper's binding starts it", async () => {
  const { root, folder } = await gameFolder({ [MAIN_FILE]: "print(1)\n" });
  const storage = path.join(root, "storage");
  const helper = fakeHelper([]);
  const bound = new Set<string>();
  const watcher = handWatch();
  const syncs = createScriptSyncs({
    storage,
    ask: () => helper.ask,
    bound: (game) => bound.has(game),
    clock: manualClock(),
    watch: watcher.watch,
  });
  await syncs.bind("game-1");
  assert.deepEqual(helper.sent, [], "the folder isn't known yet");
  await syncs.seen("game-1", folder);
  assert.deepEqual(helper.sent, [], "not bound yet");
  bound.add("game-1");
  await syncs.seen("game-1", folder);
  assert.equal(helper.source(MAIN), "print(1)\n", "seen while bound: started");
  // A fresh backend reads the folder back from storage.
  const again = fakeHelper([
    { ref: MAIN, source: "print(1)\n" },
    { ref: SHARED, source: "return {}\n" },
  ]);
  const restarted = createScriptSyncs({
    storage,
    ask: () => again.ask,
    bound: () => true,
    clock: manualClock(),
    watch: handWatch().watch,
  });
  await restarted.bind("game-1");
  assert.equal(await read(folder, SHARED_FILE), "return {}\n");
  for (const game of ["../escape", "", "a/b", "x".repeat(200)]) await restarted.seen(game, folder);
  assert.deepEqual((await readdir(path.join(storage, "games"))).sort(), ["game-1.json"]);
  await restarted.changed("game-2", { ...SHARED, source: "x" });
  syncs.stop();
  restarted.stop();
});

const PENDING = path.join(".genex", "place", PENDING_SCRIPTS);

/**
 * A game just rewound: git put back src/ and the record (v1), a restore left the restored scripts'
 * reconcile waiting, and Studio still holds the newer script (v2). The helper fails as `failing` says.
 */
async function rewound(failing: { list?: HelperLinkError; write?: HelperLinkError }) {
  const record = { v: 1, written: [], scripts: { "ServerScriptService/Main.server.luau": helperHash("v1\n") } };
  const { root, folder } = await gameFolder({ [MAIN_FILE]: "v1\n", ".genex/roblox.json": JSON.stringify(record) });
  await writePendingScripts(folder, Date.now());
  const helper = fakeHelper([{ ref: MAIN, source: "v2\n" }]);
  const ask = (async (type, body, options) => {
    if (type === HelperMessage.ScriptsList && failing.list) throw failing.list;
    if (type === HelperMessage.ScriptsWrite && failing.write) throw failing.write;
    return helper.ask(type, body, options);
  }) as HelperAsk;
  const watcher = handWatch();
  const syncs = createScriptSyncs({
    storage: path.join(root, "storage"),
    ask: () => ask,
    bound: () => true,
    clock: manualClock(),
    watch: watcher.watch,
  });
  return { folder, helper, syncs, watcher };
}

const helperFailures = [
  ["timed out (a dialog in Studio)", new HelperLinkError(HelperLinkFailure.TimedOut, "no answer in time")],
  ["found the helper gone", new HelperLinkError(HelperLinkFailure.NotBound, "not connected")],
] as const;

for (const [why, error] of helperFailures)
  test(`a reconcile whose listing ${why} keeps the restored scripts' wait, and the next call retries it as a restore`, async () => {
    const failing: { list?: HelperLinkError } = { list: error };
    const world = await rewound(failing);
    // The game's first call while its helper is bound starts its sync.
    await world.syncs.seen("game-1", world.folder);
    assert.equal(await world.syncs.bind("game-1", { restored: true }), false, "nothing was reconciled");
    assert.equal(world.helper.source(MAIN), "v2\n");
    assert.equal(world.syncs.mode("game-1"), ScriptSyncMode.Off, "the sync isn't on, so the next call starts it");
    assert.equal(await exists(path.join(world.folder, PENDING)), true, "the wait stays");
    assert.equal(world.watcher.watching.length, 0);
    delete failing.list;
    await world.syncs.seen("game-1", world.folder);
    assert.equal(world.helper.source(MAIN), "v1\n", "the restored file won");
    assert.equal(await read(world.folder, MAIN_FILE), "v1\n");
    assert.equal(await exists(path.join(world.folder, ".genex", "conflicts")), false);
    assert.equal(await exists(path.join(world.folder, PENDING)), false, "its wait is done");
    assert.equal(world.syncs.mode("game-1"), ScriptSyncMode.On);
    assert.equal(world.watcher.watching.length, 1, "file edits reach Studio again");
    world.syncs.stop();
  });

test("a restored file that didn't reach Studio keeps the restore's wait", async () => {
  const failing: { write?: HelperLinkError } = {
    write: new HelperLinkError(HelperLinkFailure.TimedOut, "no answer in time"),
  };
  const world = await rewound(failing);
  await world.syncs.seen("game-1", world.folder);
  assert.equal(await world.syncs.bind("game-1", { restored: true }), false);
  assert.equal(await exists(path.join(world.folder, PENDING)), true);
  assert.equal(world.helper.source(MAIN), "v2\n");
  delete failing.write;
  assert.equal(await world.syncs.bind("game-1"), true, "the wait makes the next binding a restore");
  assert.equal(world.helper.source(MAIN), "v1\n");
  assert.equal(await exists(path.join(world.folder, PENDING)), false);
  world.syncs.stop();
});

function module(...names: string[]): ScriptRef {
  return { path: names, class: ScriptClass.ModuleScript };
}

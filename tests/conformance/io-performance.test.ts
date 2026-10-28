import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { pluginFixture } from "../helpers/plugins.ts";
import { readGenexJobs } from "../../src/main/game-assets.ts";
import { test } from "node:test";
import { EventStore } from "../../src/substrate/event-store.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { LineCodec } from "../../src/shared/protocol.ts";
import { openStudioLog } from "../../src/main/logs.ts";
import { findGitBash } from "../../src/substrate/windows-sandbox.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SCRUB_PROCESS_TIMEOUT_MS = 5_000;

test("log scrubbing handles long non-email words even when another address is present", async () => {
  // A separate process gives the regex a generous ceiling without hanging the test runner.
  const fixture = fileURLToPath(new URL("../fixtures/log-scrub-stress.mjs", import.meta.url));
  await promisify(execFile)(process.execPath, [fixture], { timeout: SCRUB_PROCESS_TIMEOUT_MS, windowsHide: true });
});

test("warm feed snapshots do not reopen conversation records", async (t) => {
  const store = await EventStore.open(await tmpDir());
  const thread = await store.createThread();
  await store.listAllSince();
  const read = fsPromises.readFile;
  let reads = 0;
  t.mock.method(fsPromises, "readFile", (...args: Parameters<typeof read>) => {
    if (String(args[0]).endsWith("record.json")) reads++;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const head = await store.head(thread);
  reads = 0;
  assert.deepEqual((await store.listAllSince(head ?? undefined)).events, []);
  assert.equal(reads, 0);
  const appended = await store.appendEvents(thread, [{ type: EventKind.Error, message: "fresh" }]);
  reads = 0;
  assert.equal((await store.listAllSince(head ?? undefined)).events.at(-1)?.id, appended.latestEventId);
  assert.equal(reads, 0);
});

test("line codec scans each partial chunk only once", (t) => {
  const codec = new LineCodec();
  const indexOf = String.prototype.indexOf;
  let scanned = 0;
  t.mock.method(String.prototype, "indexOf", function (this: string, search: string, position = 0) {
    if (search === "\n") scanned += this.length - position;
    return indexOf.call(this, search, position);
  });
  const payload = JSON.stringify({ text: "a".repeat(10000) });
  for (const character of payload) assert.deepEqual(codec.push(character), []);
  assert.deepEqual(codec.push("\r\n"), [{ text: "a".repeat(10000) }]);
  assert.ok(scanned <= payload.length * 3, `scanned ${scanned} characters for ${payload.length} bytes`);
});

test("log tail reads only the needed suffix and keeps split UTF-8 intact", async (t) => {
  const dir = await tmpDir();
  const log = openStudioLog(dir, { home: "/home/test" });
  fs.writeFileSync(log.file, `${"old\n".repeat(100000)}${"🙂".repeat(3000)}\nnewest\n`);
  const readFile = fs.readFileSync;
  let wholeReads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFile>) => {
    wholeReads++;
    return readFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    log.close();
  });
  assert.deepEqual(log.tail(2), ["🙂".repeat(3000), "newest"]);
  assert.equal(wholeReads, 0, "tail must use positional reads");
});

test("Git Bash discovery stops after a usable registry path", async () => {
  let fallbacks = 0;
  const bash = await findGitBash({
    registry: async () => "    InstallPath    REG_SZ    C:\\Git\r\n",
    execPath: async () => {
      fallbacks++;
      return "D:/Git/mingw64/libexec/git-core";
    },
    exists: () => true,
  });
  assert.equal(bash, "C:\\Git\\bin\\bash.exe");
  assert.equal(fallbacks, 0);
});

test("record index observes another handle and returns detached records", async () => {
  const root = await tmpDir();
  const first = await EventStore.open(root);
  const thread = await first.createThread({ title: "original" });
  const before = await first.listAllSince();
  const second = await EventStore.open(root);
  await second.updateThread(thread, { title: "external" });
  assert.ok((await first.listAllSince(before.cursor ?? undefined)).events.length > 0);
  const records = await first.listThreads();
  assert.equal(records[0]?.title, "external");
  if (records[0]) records[0].title = "mutated";
  assert.equal((await first.listThreads())[0]?.title, "external");
});

test("a slow record scan never holds the append lock", async (t) => {
  const root = await tmpDir();
  const store = await EventStore.open(root);
  const thread = await store.createThread();
  await store.listThreads();
  const second = await EventStore.open(root);
  await second.updateThread(thread, { title: "external" });
  let unblock = () => {};
  let reached = () => {};
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const read = fsPromises.readFile;
  let blocked = false;
  let appendRead = false;
  t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof read>) => {
    if (!blocked && String(args[0]) === store.recordPath(thread)) {
      blocked = true;
      reached();
      await gate;
    }
    if (blocked && String(args[0]) === store.recordPath(thread)) appendRead = true;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    unblock();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const scan = store.headsSnapshot();
  await entered;
  const append = store.appendEvents(thread, [{ type: EventKind.Error, message: "while scanning" }]);
  // Lock acquisition is a microtask; file completion is deliberately held by the gate.
  await setImmediate();
  const reachedAppendRead = appendRead;
  unblock();
  await Promise.all([scan, append]);
  assert.equal(reachedAppendRead, true);
});

test("installed seeds read their manifest without rewalking the bundled package", async (t) => {
  const fixture = await pluginFixture();
  const readdir = fsPromises.readdir;
  let seedWalks = 0;
  t.mock.method(fsPromises, "readdir", (...args: Parameters<typeof readdir>) => {
    if (String(args[0]).startsWith(path.join(fixture.seeds, "example"))) seedWalks++;
    return readdir(...args);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fixture.close();
  });
  const next = new PluginRegistry(fixture.registry.root, fixture.seeds, fixture.registry.bootstrap, async () => null);
  await next.init();
  next.cancel();
  assert.equal(seedWalks, 0);
  assert.equal(next.enabled("example"), true);
});

test("job polls reuse unchanged parsed records but observe replacement and containment changes", async (t) => {
  const home = await tmpDir();
  const id = "00000000-0000-0000-0000-000000000001";
  const dir = path.join(home, "genex", "projects", "game", "jobs", id);
  await fsPromises.mkdir(dir, { recursive: true });
  const file = path.join(dir, "job.json");
  await fsPromises.writeFile(file, JSON.stringify({ id, project: "game", files: [], status: "ready" }));
  await readGenexJobs(home, "game");
  const read = fsPromises.readFile;
  let reads = 0;
  t.mock.method(fsPromises, "readFile", (...args: Parameters<typeof read>) => {
    if (String(args[0]).endsWith(`${id}${path.sep}job.json`)) reads++;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal((await readGenexJobs(home, "game"))[0]?.status, "ready");
  assert.equal(reads, 0);
  await fsPromises.writeFile(file, JSON.stringify({ id, project: "game", files: [], status: "changed" }));
  assert.equal((await readGenexJobs(home, "game"))[0]?.status, "changed");
  assert.equal(reads, 1);
  await fsPromises.rm(file);
  assert.deepEqual(await readGenexJobs(home, "game"), []);
});

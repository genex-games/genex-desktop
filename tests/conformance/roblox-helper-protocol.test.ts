import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHelperLink, scriptTarget } from "../../src/plugins/roblox/helper-link.ts";
import {
  createHelperInbox,
  HELPER_PROTOCOL,
  HelperMessage,
  HelperRefusal,
  helperHash,
  isPartPath,
  isScriptPath,
  MAX_HELPER_FRAME_BYTES,
  MAX_SCRIPT_SOURCE_BYTES,
  type PendingType,
  type ScriptChange,
} from "../../src/plugins/roblox/helper-protocol.ts";
import { HELPER_VERSION } from "../../src/plugins/roblox/setup.ts";
import { BINDING_FILE } from "../../src/plugins/roblox/studio-binding.ts";
import { fakeStudio, manualClock, memoryHelper } from "../helpers/roblox-helper.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NOTHING_PENDING: PendingType = () => undefined;
const frame = (id: number, type: string, body: unknown) => JSON.stringify({ v: HELPER_PROTOCOL, id, type, body });
const MAIN = { path: ["ServerScriptService", "Main"], class: "Script", runContext: "Server" };
const SHARED = { path: ["ReplicatedStorage", "Shared"], class: "ModuleScript" };
const changed = (id: number, ref: Record<string, unknown>, source: unknown = "print(1)") =>
  frame(id, HelperMessage.ScriptsChanged, { ...ref, source });

test("a hello, a script change and an answer to a pending request are read with every field typed", () => {
  const inbox = createHelperInbox();
  const hello = inbox.read(
    frame(1, HelperMessage.Hello, { helper: 1, place: { id: "0", name: "Place1" } }),
    NOTHING_PENDING,
  );
  assert.deepEqual(hello, {
    ok: true,
    message: {
      kind: "event",
      id: 1,
      event: { type: "hello", body: { helper: 1, place: { id: "0", name: "Place1" } } },
    },
  });
  const change = inbox.read(changed(2, MAIN), NOTHING_PENDING);
  assert.ok(change.ok && change.message.kind === "event");
  assert.deepEqual(change.message.event.body, { ...MAIN, source: "print(1)" });
  const removed = inbox.read(changed(3, SHARED, null), NOTHING_PENDING);
  assert.ok(removed.ok && removed.message.kind === "event");
  assert.deepEqual(removed.message.event.body, { ...SHARED, source: null });
  const pending: PendingType = (re) => (re === 7 ? HelperMessage.ScriptsList : undefined);
  const answer = JSON.stringify({
    v: HELPER_PROTOCOL,
    id: 4,
    type: "answer",
    re: 7,
    ok: true,
    result: { scripts: [{ ...MAIN, hash: "abc123", synced: false }] },
  });
  assert.deepEqual(inbox.read(answer, pending), {
    ok: true,
    message: {
      kind: "answer",
      id: 4,
      re: 7,
      answer: {
        ok: true,
        type: "scripts.list",
        result: { scripts: [{ ...MAIN, hash: "abc123", synced: false }] },
      },
    },
  });
});

test("both sides hash bytes alike: FNV-1a over 32 bits, a string as its UTF-8 bytes", () => {
  // The published FNV-1a test vectors, and the hash the helper in Studio gave this source.
  assert.equal(helperHash(""), "811c9dc5");
  assert.equal(helperHash("a"), "e40c292c");
  assert.equal(helperHash("foobar"), "bf9cf968");
  assert.equal(helperHash('return { answer = 42, word = "héllo ✓" }\n'), "60c8dacd");
  assert.equal(helperHash(Buffer.from("foobar")), "bf9cf968");
});

const REF_ROWS: Array<{ name: string; ref: Record<string, unknown>; refusal: HelperRefusal }> = [
  {
    name: "a path that isn't a list",
    ref: { ...SHARED, path: "ReplicatedStorage/Shared" },
    refusal: HelperRefusal.BadPath,
  },
  { name: "a service alone", ref: { ...SHARED, path: ["ReplicatedStorage"] }, refusal: HelperRefusal.BadPath },
  {
    name: "a service the helper doesn't watch",
    ref: { ...SHARED, path: ["CoreGui", "Shared"] },
    refusal: HelperRefusal.BadPath,
  },
  { name: "an empty name", ref: { ...SHARED, path: ["ReplicatedStorage", ""] }, refusal: HelperRefusal.BadPath },
  {
    name: "a NUL in a name",
    ref: { ...SHARED, path: ["ReplicatedStorage", "a\u0000b"] },
    refusal: HelperRefusal.BadPath,
  },
  {
    name: "a name past the cap",
    ref: { ...SHARED, path: ["ReplicatedStorage", "x".repeat(1001)] },
    refusal: HelperRefusal.BadPath,
  },
  {
    name: "a path too deep",
    ref: { ...SHARED, path: ["ReplicatedStorage", ...Array(64).fill("Folder")] },
    refusal: HelperRefusal.BadPath,
  },
  {
    name: "a name that isn't text",
    ref: { ...SHARED, path: ["ReplicatedStorage", 7] },
    refusal: HelperRefusal.BadPath,
  },
  { name: "another class", ref: { ...SHARED, class: "CoreScript" }, refusal: HelperRefusal.BadField },
  {
    name: "a ModuleScript with a run context",
    ref: { ...SHARED, runContext: "Server" },
    refusal: HelperRefusal.BadField,
  },
  { name: "a Script without one", ref: { path: MAIN.path, class: "Script" }, refusal: HelperRefusal.BadField },
  { name: "an unknown run context", ref: { ...MAIN, runContext: "Everywhere" }, refusal: HelperRefusal.BadField },
];

test("a script the helper names is checked whole: its service, every name, its class and run context", () => {
  for (const row of REF_ROWS) {
    const read = createHelperInbox().read(changed(1, row.ref), NOTHING_PENDING);
    assert.deepEqual(read, { ok: false, refusal: row.refusal }, row.name);
  }
  // Instance names are Studio's own: a slash, dots or a reserved word are names like any other.
  const odd = { ...SHARED, path: ["ReplicatedStorage", "../a/b", "CON", "名前 ✓"] };
  const read = createHelperInbox().read(changed(1, odd), NOTHING_PENDING);
  assert.ok(read.ok && read.message.kind === "event");
  assert.deepEqual(read.message.event.body, { ...odd, source: "print(1)" });
});

const PATH_ROWS: Array<{ name: string; path: unknown }> = [
  { name: "a parent step", path: "../outside.server.luau" },
  { name: "a parent step inside", path: "ServerScriptService/../../x.luau" },
  { name: "an absolute path", path: "/etc/passwd.luau" },
  { name: "a Windows drive", path: "C:/Windows/x.luau" },
  { name: "a backslash", path: "ServerScriptService\\Main.luau" },
  { name: "a NUL", path: "Main\u0000.luau" },
  { name: "a control character", path: "Main\n.luau" },
  { name: "an empty segment", path: "ServerScriptService//Main.luau" },
  { name: "a dot segment", path: "./Main.luau" },
  { name: "not a script", path: "ServerScriptService/Main.lua" },
  { name: "only the ending", path: ".luau" },
  { name: "too long", path: `${"a/".repeat(600)}x.luau` },
  { name: "not text", path: 42 },
];

test("a script file or place part path that could leave its folder is no path at all", () => {
  for (const row of PATH_ROWS) assert.equal(isScriptPath(row.path), false, row.name);
  const partRows = [
    "../outside.rbxm",
    "Workspace/../../x.rbxm",
    "/etc/x.rbxm",
    "C:/Windows/x.rbxm",
    "Workspace\\x.rbxm",
    "x\u0000.rbxm",
    "Workspace//x.rbxm",
    "./x.rbxm",
    "Workspace/x.lua",
    ".rbxm",
    `${"a/".repeat(600)}x.rbxm`,
    42,
  ];
  for (const part of partRows) assert.equal(isPartPath(part), false, String(part));
  assert.equal(isPartPath("Workspace.split/Tower~2.rbxm"), true);
  assert.equal(isPartPath("services.json"), true);
  const chunk = frame(1, HelperMessage.DataChunk, { transfer: 3, part: "../x.rbxm", index: 0, count: 1, data: "AAAA" });
  assert.deepEqual(
    createHelperInbox().read(chunk, () => HelperMessage.PlaceExport),
    {
      ok: false,
      refusal: HelperRefusal.BadPath,
    },
  );
});

const ROWS: Array<{ name: string; texts: string[]; refusal: HelperRefusal; pending?: PendingType }> = [
  { name: "malformed JSON", texts: ["{not json"], refusal: HelperRefusal.Malformed },
  { name: "a JSON array", texts: ["[1,2]"], refusal: HelperRefusal.Malformed },
  {
    name: "another protocol",
    texts: [JSON.stringify({ v: 99, id: 1, type: "activity", body: { editing: true } })],
    refusal: HelperRefusal.Version,
  },
  { name: "an unknown type", texts: [frame(1, "scripts.delete-everything", {})], refusal: HelperRefusal.UnknownType },
  {
    name: "a request type only the backend sends",
    texts: [frame(1, HelperMessage.ScriptsWrite, { path: "a.luau", source: "" })],
    refusal: HelperRefusal.UnknownType,
  },
  {
    name: "a missing id",
    texts: [JSON.stringify({ v: 1, type: "activity", body: { editing: true } })],
    refusal: HelperRefusal.BadId,
  },
  {
    name: "a fractional id",
    texts: [frame(1.5, HelperMessage.Activity, { editing: true })],
    refusal: HelperRefusal.BadId,
  },
  {
    name: "a repeated id",
    texts: [frame(5, HelperMessage.Activity, { editing: true }), changed(5, MAIN)],
    refusal: HelperRefusal.RepeatedId,
  },
  {
    name: "an older id",
    texts: [frame(5, HelperMessage.Activity, { editing: true }), changed(4, MAIN)],
    refusal: HelperRefusal.RepeatedId,
  },
  {
    name: "an answer to nothing asked",
    texts: [JSON.stringify({ v: 1, id: 1, type: "answer", re: 99, ok: true, result: {} })],
    refusal: HelperRefusal.UnknownAnswer,
  },
  {
    name: "a chunk of no export",
    texts: [frame(1, HelperMessage.DataChunk, { transfer: 3, part: "a.rbxm", index: 0, count: 1, data: "AAAA" })],
    refusal: HelperRefusal.UnknownAnswer,
  },
  {
    name: "an answer of the wrong shape",
    texts: [JSON.stringify({ v: 1, id: 1, type: "answer", re: 7, ok: true, result: { scripts: "all" } })],
    refusal: HelperRefusal.BadField,
    pending: (re) => (re === 7 ? HelperMessage.ScriptsList : undefined),
  },
  {
    name: "an extra field",
    texts: [frame(1, HelperMessage.ScriptsChanged, { ...SHARED, source: "", write: "/etc/hosts" })],
    refusal: HelperRefusal.BadField,
  },
  {
    name: "a missing source",
    texts: [frame(1, HelperMessage.ScriptsChanged, SHARED)],
    refusal: HelperRefusal.BadField,
  },
  {
    name: "an oversize source",
    texts: [changed(1, MAIN, "x".repeat(MAX_SCRIPT_SOURCE_BYTES + 1))],
    refusal: HelperRefusal.Oversize,
  },
  { name: "an oversize message", texts: [" ".repeat(MAX_HELPER_FRAME_BYTES + 1)], refusal: HelperRefusal.Oversize },
  ...REF_ROWS.map((row) => ({ name: `a script with ${row.name}`, texts: [changed(1, row.ref)], refusal: row.refusal })),
];

test("hostile messages are refused by the reader, each for its own reason", () => {
  for (const row of ROWS) {
    const inbox = createHelperInbox();
    const reads = row.texts.map((text) => inbox.read(text, row.pending ?? NOTHING_PENDING));
    assert.deepEqual(reads.at(-1), { ok: false, refusal: row.refusal }, row.name);
  }
});

const PLACE1 = { id: "studio-1", name: "Place1" };

/** A game linked to Place1, its helper bound, with a sink that writes what Studio changed. */
async function boundGame() {
  const root = await realpath(await tmpDir("roblox-helper-protocol-"));
  const storage = path.join(root, "storage");
  const game = path.join(root, "games", "game-1");
  const outside = path.join(root, "outside");
  await mkdir(path.join(storage, "links"), { recursive: true });
  await mkdir(path.join(game, "src", "ServerScriptService"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(game, "Place1.rbxl"), "<roblox/>");
  await writeFile(path.join(outside, "victim.luau"), "untouched");
  const link = { kind: "roblox", project: path.join(game, "Place1.rbxl"), linkedAt: "2026-10-15T12:00:00.000Z" };
  await writeFile(path.join(storage, "links", "game-1.json"), JSON.stringify(link));
  const studio = fakeStudio([PLACE1]);
  const written: ScriptChange[] = [];
  const helperLink = createHelperLink({
    storage,
    studio: studio.client,
    clock: manualClock(),
    newSession: () => "session-1",
    sinks: {
      scriptsChanged: (_game, change) => {
        written.push(change);
      },
    },
  });
  const helper = memoryHelper(helperLink, { studio, studioId: PLACE1.id });
  helper.hello();
  await helperLink.idle();
  assert.equal(helperLink.bound("game-1"), PLACE1.id);
  await readFile(path.join(storage, "mcp", "game-1", BINDING_FILE));
  return { root, game, outside, studio, written, helper, helperLink };
}

/** Every file under `dir` with its contents, links not followed. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full);
    if (entry.isSymbolicLink()) out[key] = "<link>";
    else if (entry.isFile()) out[key] = await readFile(full, "utf8");
    else out[key] = "<dir>";
  }
  return out;
}

/** Makes a link, or says why this system can't (Windows without the right to make them). */
async function linkOrSkip(target: string, at: string, type: "file" | "dir"): Promise<string | undefined> {
  try {
    await symlink(target, at, type === "dir" ? "junction" : "file");
    return undefined;
  } catch (error) {
    return `links can't be made here: ${(error as NodeJS.ErrnoException).code}`;
  }
}

test("hostile messages from a bound helper write no file and call nothing in Studio", async () => {
  const world = await boundGame();
  const before = await tree(world.root);
  const callsBefore = world.studio.calls.length;
  const rows: Array<{ name: string; text: (id: number) => string }> = [
    { name: "malformed JSON", text: () => "{not json" },
    { name: "an unknown type", text: (id) => frame(id, "scripts.wipe", { path: "x.luau" }) },
    {
      name: "an answer to nothing asked",
      text: (id) => JSON.stringify({ v: 1, id, type: "answer", re: 999, ok: true, result: {} }),
    },
    {
      name: "an oversize source",
      text: (id) => changed(id, MAIN, "x".repeat(MAX_SCRIPT_SOURCE_BYTES + 1)),
    },
    {
      name: "a chunk of no export",
      text: (id) =>
        frame(id, HelperMessage.DataChunk, { transfer: 1, part: "a.rbxm", index: 0, count: 1, data: "AAAA" }),
    },
    ...REF_ROWS.map((row) => ({
      name: `a script with ${row.name}`,
      text: (id: number) => changed(id, row.ref, "pwned"),
    })),
  ];
  for (const row of rows) {
    world.helper.raw(row.text(world.helper.nextId()));
    world.helper.skipTo(world.helper.nextId());
    await world.helperLink.idle();
    assert.deepEqual(world.written, [], row.name);
  }
  // A repeated id: the same message twice, the second refused.
  const id = world.helper.nextId();
  world.helper.raw(changed(id, MAIN, "once"));
  world.helper.raw(changed(id, MAIN, "twice"));
  await world.helperLink.idle();
  assert.deepEqual(world.written, [{ ...MAIN, source: "once" }], "only the first of two messages with one id is taken");
  // The binding file is refreshed by time, and no time passed.
  assert.deepEqual(await tree(world.root), before);
  assert.equal(world.studio.calls.length, callsBefore, "no call reached Studio");
  world.helperLink.close();
});

test("a script file through a link, or onto one, is no file the backend writes", async (t) => {
  const world = await boundGame();
  const fileLink = path.join(world.game, "src", "ServerScriptService", "Evil.server.luau");
  const folderLink = path.join(world.game, "src", "Linked");
  const skipped =
    (await linkOrSkip(path.join(world.outside, "victim.luau"), fileLink, "file")) ??
    (await linkOrSkip(world.outside, folderLink, "dir"));
  if (skipped) return t.skip(skipped);
  const before = await tree(world.root);
  for (const file of ["ServerScriptService/Evil.server.luau", "Linked/victim.luau", "Linked/new.server.luau"])
    await assert.rejects(scriptTarget(world.game, file), file);
  assert.deepEqual(await tree(world.root), before);
  assert.equal(await readFile(path.join(world.outside, "victim.luau"), "utf8"), "untouched");
  world.helperLink.close();
});

test("a src folder that is a link refuses every script file", async (t) => {
  const world = await boundGame();
  const src = path.join(world.game, "src");
  const { rm } = await import("node:fs/promises");
  await rm(src, { recursive: true });
  const skipped = await linkOrSkip(world.outside, src, "dir");
  if (skipped) return t.skip(skipped);
  await assert.rejects(scriptTarget(world.game, "victim.luau"));
  assert.equal(await readFile(path.join(world.outside, "victim.luau"), "utf8"), "untouched");
  world.helperLink.close();
});

test("a plain script change from the bound helper reaches the sink as Studio names it", async () => {
  const world = await boundGame();
  world.helper.say(HelperMessage.ScriptsChanged, { ...MAIN, source: "print(2)" });
  world.helper.say(HelperMessage.ScriptsChanged, { ...SHARED, source: null });
  await world.helperLink.idle();
  assert.deepEqual(world.written, [
    { ...MAIN, source: "print(2)" },
    { ...SHARED, source: null },
  ]);
  assert.equal(
    await scriptTarget(world.game, "ServerScriptService/Main.server.luau"),
    path.join(world.game, "src", "ServerScriptService", "Main.server.luau"),
  );
  world.helperLink.close();
});

/** What the real helper in Studio sent on Genex's socket, and what it was asked. */
const RECORDED = JSON.parse(
  await readFile(path.resolve(import.meta.dirname, "../fixtures/roblox-studio/helper-recorded.json"), "utf8"),
) as { frames: Array<{ from?: "helper"; text?: string; to?: "helper"; id?: number; type?: string }> };

test("everything the real helper sent replays through the reader: its hello, answers, chunks and refusals", () => {
  const asked = new Map<number, string>();
  for (const frame of RECORDED.frames)
    if (frame.to && frame.type !== HelperMessage.DataChunk) asked.set(frame.id as number, frame.type as string);
  const inbox = createHelperInbox();
  const reads = RECORDED.frames
    .filter((frame) => frame.from === "helper")
    .map((frame) => inbox.read(frame.text as string, (re) => asked.get(re) as never));
  for (const read of reads) assert.ok(read.ok, JSON.stringify(read));
  const messages = reads.flatMap((read) => (read.ok ? [read.message] : []));
  const hello = messages[0];
  assert.ok(hello?.kind === "event" && hello.event.type === HelperMessage.Hello);
  assert.deepEqual(hello.event.body, { helper: HELPER_VERSION, place: { id: "0", name: "p16-s9b.rbxlx" } });
  const answers = messages.flatMap((message) => (message.kind === "answer" ? [message.answer] : []));
  assert.deepEqual(
    answers.map((answer) => (answer.ok ? answer.type : answer.error.code)),
    [
      HelperMessage.SessionMark,
      HelperMessage.ScriptsWrite,
      HelperMessage.ScriptsList,
      HelperMessage.ScriptsRead,
      HelperMessage.PlaceExport,
      HelperMessage.Activity,
      HelperMessage.Team,
      HelperMessage.ModelImport,
      "conflict",
    ],
  );
});

test("the real helper's export arrives whole: each part's chunks join to its size and hash, as Luau computed them", () => {
  const inbox = createHelperInbox();
  const exportId = RECORDED.frames.find((frame) => frame.type === HelperMessage.PlaceExport)?.id;
  const pending: PendingType = (re) => (re === exportId ? HelperMessage.PlaceExport : HelperMessage.SessionMark);
  const chunks = new Map<string, Buffer[]>();
  let parts: Array<{ name: string; hash: string; bytes: number }> = [];
  for (const frame of RECORDED.frames.filter((entry) => entry.from === "helper")) {
    const read = inbox.read(frame.text as string, pending);
    if (!read.ok) continue;
    const message = read.message;
    if (message.kind === "event" && message.event.type === HelperMessage.DataChunk) {
      const body = message.event.body;
      chunks.set(body.part, [...(chunks.get(body.part) ?? []), Buffer.from(body.data, "base64")]);
    }
    if (message.kind === "answer" && message.re === exportId && message.answer.ok)
      parts = (message.answer.result as { parts: typeof parts }).parts;
  }
  assert.ok(parts.length > 0);
  assert.ok(
    parts.some((part) => part.bytes > 0),
    "the place has a part with bytes in it",
  );
  for (const part of parts) {
    const bytes = Buffer.concat(chunks.get(part.name) ?? []);
    assert.equal(bytes.length, part.bytes, part.name);
    assert.equal(helperHash(bytes), part.hash, part.name);
  }
});

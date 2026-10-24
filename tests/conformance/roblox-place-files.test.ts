import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HelperAsk, RequestOptions, Upload } from "../../src/plugins/roblox/helper-link.ts";
import {
  CHUNK_BYTES,
  HelperMessage,
  type HelperRequest,
  type HelperRequestBodies,
  helperHash,
  type PlacePart,
} from "../../src/plugins/roblox/helper-protocol.ts";
import {
  exportPlace,
  hasPendingLoad,
  loadPendingPlace,
  loadPlace,
  PENDING_LOAD,
  PLACE_MANIFEST,
  PlaceFailure,
  PlaceFilesError,
  readManifest,
  writePendingLoad,
} from "../../src/plugins/roblox/place-files.ts";
import { HELPER_VERSION } from "../../src/plugins/roblox/setup.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Asked = { type: HelperRequest; body: unknown; upload?: Upload[] };

/** An export's answer over `parts`, its chunks handed to `onChunk`; a tampered part's bytes are zeroed. */
function exportAnswer(
  parts: Map<string, Buffer>,
  request: HelperRequestBodies["place.export"],
  options: RequestOptions,
  tamper: ReadonlySet<string>,
) {
  const known = new Map(request.known.map((part) => [part.name, part.hash]));
  const list: PlacePart[] = [];
  const sent: string[] = [];
  for (const [name, data] of parts) {
    const part = { name, hash: helperHash(data), bytes: data.length };
    list.push(part);
    if (!request.full && known.get(name) === part.hash) continue;
    const bytes = tamper.has(name) ? Buffer.from(data).fill(0) : data;
    const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    for (let index = 0; index < count; index++) {
      const data64 = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64");
      options.onChunk?.({ transfer: 1, part: name, index, count, data: data64 });
    }
    sent.push(name);
  }
  return { parts: list, sent, ms: 3 };
}

/**
 * The Genex helper's place as the backend sees it: parts by name. An export sends the parts whose
 * hash the backend doesn't hold (all of them when full), in chunks; `tamper` changes a part's
 * bytes after its hash was taken, as a damaged transfer would.
 */
function studioPlace(initial: Record<string, Buffer>) {
  const parts = new Map(Object.entries(initial));
  const asked: Asked[] = [];
  const tamper = new Set<string>();
  let failLoad = false;
  const ask = (async (type: HelperRequest, body: unknown, options: RequestOptions = {}) => {
    asked.push({ type, body, ...(options.upload ? { upload: options.upload } : {}) });
    if (type === HelperMessage.PlaceLoad) {
      if (failLoad) throw new Error("Studio couldn't load the save point");
      return { loaded: (body as HelperRequestBodies["place.load"]).parts.length };
    }
    return exportAnswer(parts, body as HelperRequestBodies["place.export"], options, tamper);
  }) as HelperAsk;
  return {
    ask,
    asked,
    parts,
    tamper,
    failLoads: (fail: boolean) => {
      failLoad = fail;
    },
  };
}

const PLACE = () => ({
  "Workspace.rbxm": Buffer.from("workspace bytes"),
  "StarterPlayer/StarterPlayerScripts.rbxm": Buffer.from("player scripts"),
  "Lighting.rbxm": Buffer.alloc(0),
  "services.json": Buffer.from('{"Lighting":{"ClockTime":9}}'),
  "terrain.rbxm": Buffer.from("terrain"),
});

async function gameFolder() {
  const root = await realpath(await tmpDir("roblox-place-files-"));
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(game, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "victim.rbxm"), "untouched");
  return { root, game, outside, place: path.join(game, ".genex", "place") };
}

/** Every file under `dir` with its contents, links not followed. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const key = path.relative(dir, path.join(entry.parentPath, entry.name));
    if (entry.isSymbolicLink()) out[key] = "<link>";
    else if (entry.isFile()) out[key] = await readFile(path.join(entry.parentPath, entry.name), "utf8");
    else out[key] = "<dir>";
  }
  return out;
}

async function linkOrSkip(target: string, at: string, type: "file" | "dir"): Promise<string | undefined> {
  try {
    await symlink(target, at, type === "dir" ? "junction" : "file");
    return undefined;
  } catch (error) {
    return `links can't be made here: ${(error as NodeJS.ErrnoException).code}`;
  }
}

test("a first export asks for the whole place and writes every part and the manifest", async () => {
  const { game, place } = await gameFolder();
  const studio = studioPlace(PLACE());
  const done = await exportPlace(studio.ask, game);
  assert.deepEqual(studio.asked[0]?.body, { full: true, known: [] });
  assert.equal(done.written.length, 5);
  for (const [name, data] of Object.entries(PLACE())) assert.deepEqual(await readFile(path.join(place, name)), data);
  const manifest = await readManifest(game);
  assert.equal(manifest?.helper, HELPER_VERSION);
  assert.deepEqual(
    manifest?.parts.map((part) => part.name),
    Object.keys(PLACE()),
  );
});

test("a later export names what the folder holds, writes only what changed and removes what is gone", async () => {
  const { game, place } = await gameFolder();
  const studio = studioPlace(PLACE());
  await exportPlace(studio.ask, game);
  studio.parts.set("Workspace.rbxm", Buffer.from("workspace after a move"));
  studio.parts.delete("terrain.rbxm");
  studio.parts.set("ServerStorage.split/Big~2.rbxm", Buffer.alloc(CHUNK_BYTES + 5, 1));
  const done = await exportPlace(studio.ask, game);
  const second = studio.asked[1]?.body as { full: boolean; known: Array<{ name: string }> };
  assert.equal(second.full, false);
  assert.deepEqual(
    second.known.map((part) => part.name),
    Object.keys(PLACE()),
  );
  assert.deepEqual(done.written.sort(), ["ServerStorage.split/Big~2.rbxm", "Workspace.rbxm"]);
  assert.deepEqual(done.removed, ["terrain.rbxm"]);
  assert.equal(await readFile(path.join(place, "Workspace.rbxm"), "utf8"), "workspace after a move");
  assert.equal((await readFile(path.join(place, "ServerStorage.split", "Big~2.rbxm"))).length, CHUNK_BYTES + 5);
  assert.deepEqual(
    (await readdir(place)).sort(),
    ["Lighting.rbxm", PLACE_MANIFEST, "ServerStorage.split", "StarterPlayer", "Workspace.rbxm", "services.json"].sort(),
  );
});

test("a full export is asked again when the folder's manifest is another helper version's", async () => {
  const { game, place } = await gameFolder();
  const studio = studioPlace(PLACE());
  await exportPlace(studio.ask, game);
  const manifest = JSON.parse(await readFile(path.join(place, PLACE_MANIFEST), "utf8"));
  await writeFile(path.join(place, PLACE_MANIFEST), JSON.stringify({ ...manifest, helper: HELPER_VERSION - 1 }));
  await exportPlace(studio.ask, game);
  assert.deepEqual(studio.asked[1]?.body, { full: true, known: [] });
});

test("a damaged, short or unsent part writes nothing at all", async () => {
  const rows: Array<{ name: string; spoil(studio: ReturnType<typeof studioPlace>): void }> = [
    { name: "bytes other than their hash", spoil: (studio) => studio.tamper.add("Workspace.rbxm") },
    {
      name: "a part named but neither sent nor held",
      spoil: (studio) => {
        const ask = studio.ask;
        studio.ask = (async (type: HelperRequest, body: unknown, options?: RequestOptions) => {
          const answer = (await ask(type as "place.export", body as HelperRequestBodies["place.export"], {
            ...options,
            onChunk: (chunk) => (chunk.part === "Lighting.rbxm" ? undefined : options?.onChunk?.(chunk)),
          })) as { parts: PlacePart[]; sent: string[]; ms: number };
          return { ...answer, sent: answer.sent.filter((name) => name !== "Lighting.rbxm") };
        }) as HelperAsk;
      },
    },
    {
      name: "a missing chunk",
      spoil: (studio) => {
        studio.parts.set("Workspace.rbxm", Buffer.alloc(CHUNK_BYTES * 2, 3));
        const ask = studio.ask;
        studio.ask = (async (type: HelperRequest, body: unknown, options?: RequestOptions) =>
          ask(type as "place.export", body as HelperRequestBodies["place.export"], {
            ...options,
            onChunk: (chunk) => (chunk.index === 1 ? undefined : options?.onChunk?.(chunk)),
          })) as HelperAsk;
      },
    },
  ];
  for (const row of rows) {
    const { root, game } = await gameFolder();
    const studio = studioPlace(PLACE());
    row.spoil(studio);
    const before = await tree(root);
    await assert.rejects(
      exportPlace(studio.ask, game),
      (error: unknown) => error instanceof PlaceFilesError && error.code === PlaceFailure.Damaged,
      row.name,
    );
    const after = await tree(root);
    // Only the empty export folder may have been made.
    for (const key of Object.keys(after))
      if (!(key in before)) assert.equal(after[key], "<dir>", `${row.name}: ${key}`);
  }
});

test("an export through a link anywhere on the way writes nothing outside the place folder", async (t) => {
  const rows: Array<{
    name: string;
    plant(world: Awaited<ReturnType<typeof gameFolder>>): Promise<string | undefined>;
  }> = [
    { name: ".genex is a link", plant: (w) => linkOrSkip(w.outside, path.join(w.game, ".genex"), "dir") },
    {
      name: "the place folder is a link",
      plant: async (w) => {
        await mkdir(path.join(w.game, ".genex"));
        return linkOrSkip(w.outside, w.place, "dir");
      },
    },
    {
      name: "a part's folder is a link",
      plant: async (w) => {
        await mkdir(w.place, { recursive: true });
        return linkOrSkip(w.outside, path.join(w.place, "StarterPlayer"), "dir");
      },
    },
  ];
  for (const row of rows) {
    const world = await gameFolder();
    const skipped = await row.plant(world);
    if (skipped) return t.skip(skipped);
    const outsideBefore = await tree(world.outside);
    await assert.rejects(exportPlace(studioPlace(PLACE()).ask, world.game), row.name);
    assert.deepEqual(await tree(world.outside), outsideBefore, row.name);
  }
  // A link where a part goes is replaced by the part; its target is never written.
  const world = await gameFolder();
  await mkdir(world.place, { recursive: true });
  const skipped = await linkOrSkip(
    path.join(world.outside, "victim.rbxm"),
    path.join(world.place, "Workspace.rbxm"),
    "file",
  );
  if (skipped) return t.skip(skipped);
  await exportPlace(studioPlace(PLACE()).ask, world.game);
  assert.equal(await readFile(path.join(world.outside, "victim.rbxm"), "utf8"), "untouched");
  assert.equal(await readFile(path.join(world.place, "Workspace.rbxm"), "utf8"), "workspace bytes");
});

test("a load sends every saved part ahead of its request, each checked against the manifest", async () => {
  const { game } = await gameFolder();
  const studio = studioPlace(PLACE());
  await exportPlace(studio.ask, game);
  assert.equal(await loadPlace(studio.ask, game), 5);
  const load = studio.asked.at(-1);
  assert.ok(load);
  assert.equal(load.type, HelperMessage.PlaceLoad);
  assert.deepEqual(
    Object.fromEntries((load.upload ?? []).map((upload) => [upload.part, Buffer.from(upload.data)])),
    PLACE(),
  );
  assert.deepEqual(
    (load.body as { parts: PlacePart[] }).parts.map((part) => part.name),
    Object.keys(PLACE()),
  );
});

test("a saved part that isn't what the manifest says, or is a link, loads nothing", async (t) => {
  const changed = await gameFolder();
  const studio = studioPlace(PLACE());
  await exportPlace(studio.ask, changed.game);
  await writeFile(path.join(changed.place, "Workspace.rbxm"), "edited by hand");
  const asks = studio.asked.length;
  await assert.rejects(
    loadPlace(studio.ask, changed.game),
    (error: unknown) => error instanceof PlaceFilesError && error.code === PlaceFailure.Unreadable,
  );
  assert.equal(studio.asked.length, asks, "Studio was asked nothing");

  const linked = await gameFolder();
  await exportPlace(studio.ask, linked.game);
  await rm(path.join(linked.place, "terrain.rbxm"));
  await writeFile(path.join(linked.outside, "terrain.rbxm"), "terrain");
  const skipped = await linkOrSkip(
    path.join(linked.outside, "terrain.rbxm"),
    path.join(linked.place, "terrain.rbxm"),
    "file",
  );
  if (skipped) return t.skip(skipped);
  await assert.rejects(
    loadPlace(studio.ask, linked.game),
    (error: unknown) => error instanceof PlaceFilesError && error.code === PlaceFailure.Unreadable,
  );

  const empty = await gameFolder();
  await assert.rejects(
    loadPlace(studio.ask, empty.game),
    (error: unknown) => error instanceof PlaceFilesError && error.code === PlaceFailure.NoManifest,
  );
  assert.deepEqual(await readdir(empty.game), [], "reading made no folder");
});

test("a pending load waits in the folder until the helper is next reached, and a failed one keeps waiting", async () => {
  const { game, place } = await gameFolder();
  const studio = studioPlace(PLACE());
  assert.equal(await hasPendingLoad(game), false);
  assert.equal(await loadPendingPlace(studio.ask, game), false, "nothing waits: nothing loads");
  assert.equal(studio.asked.length, 0);
  await exportPlace(studio.ask, game);
  await writePendingLoad(game, Date.parse("2026-10-15T12:00:00.000Z"));
  assert.deepEqual(JSON.parse(await readFile(path.join(place, PENDING_LOAD), "utf8")), {
    since: "2026-10-15T12:00:00.000Z",
  });
  studio.failLoads(true);
  await assert.rejects(loadPendingPlace(studio.ask, game));
  assert.equal(await hasPendingLoad(game), true, "a failed load keeps waiting");
  studio.failLoads(false);
  assert.equal(await loadPendingPlace(studio.ask, game), true);
  assert.equal(await hasPendingLoad(game), false);
  assert.equal(studio.asked.filter((asked) => asked.type === HelperMessage.PlaceLoad).length, 2);
});

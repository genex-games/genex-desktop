/**
 * A remix's Git LFS files come over https without git-lfs: the clone's pointer files name each
 * model's SHA-256 and size, Genex's git answers where each one is (the Git LFS batch API), and a
 * model takes its pointer's place only once its bytes match. Nothing here runs git or git-lfs, so
 * a Mac where an app opened from the Dock finds no git-lfs remixes like any other.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadLfsFiles, findLfsPointers, type LfsDownloadDeps, parseLfsPointer } from "../../src/main/play/lfs.ts";
import { DOWNLOAD_STALL_MS, type StallClock, stallGuard } from "../../src/main/play/remix.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = "https://git.genex.games/u-1/lost-cathedral.git";
const BATCH = `${REPO}/info/lfs/objects/batch`;
const STORAGE = "https://storage.genex.example";

const oidOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const pointerOf = (bytes: Buffer): string =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oidOf(bytes)}\nsize ${bytes.length}\n`;

/** A request the fake network saw. */
interface Seen {
  url: string;
  method: string;
  /** The Authorization header it carried, or null. */
  authorization: string | null;
  objects: Array<{ oid: string; size: number }>;
}

/** What the fake batch API answers for one asked object; `undefined` leaves it out. */
type Answer = (object: { oid: string; size: number }) => unknown;

/** Where a storage address redirects to, or undefined to serve it. */
type Redirect = (url: string) => string | undefined;

/**
 * Genex's git and its storage: the batch API answers with `answer`, storage serves `store`, and an
 * address `redirect` names answers 302 there.
 */
function fakeNetwork(store: Map<string, Buffer>, answer?: Answer, redirect?: Redirect) {
  const seen: Seen[] = [];
  const located: Answer = (object) =>
    store.has(object.oid)
      ? { ...object, actions: { download: { href: `${STORAGE}/${object.oid}?sig=abc`, expires_in: 3600 } } }
      : { ...object, error: { code: 404, message: "Object does not exist" } };
  const fetch: LfsDownloadDeps["fetch"] = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const objects = url === BATCH ? (JSON.parse(String(init?.body)) as { objects: Seen["objects"] }).objects : [];
    seen.push({ url, method, objects, authorization: new Headers(init?.headers).get("authorization") });
    if (url === BATCH) return Response.json({ objects: objects.map(answer ?? located).filter(Boolean) });
    const location = redirect?.(url);
    if (location) return new Response(null, { status: 302, headers: { location } });
    const bytes = store.get(new URL(url).pathname.slice(1));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("no", { status: 404 });
  };
  return { fetch, seen };
}

/** A clone in a temporary folder: `files` written as given, a `.git` folder beside them. */
async function cloneWith(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await tmpDir("studio-remix-lfs-");
  await mkdir(path.join(dir, ".git"), { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body);
  }
  return dir;
}

/** The network, no stall clock that ever fires, and every progress report kept. */
function depsOn(fetch: LfsDownloadDeps["fetch"]) {
  const heard: Array<[number, number]> = [];
  const deps: LfsDownloadDeps = {
    fetch,
    models: (done, total) => {
      heard.push([done, total]);
    },
    guard: () => stallGuard({ setTimeout: () => null, clearTimeout: () => {} }),
    routed: async (files) => new Set(files),
  };
  return { deps, heard };
}

const MODEL = Buffer.from("glTF model bytes ".repeat(500));
const SOUND = Buffer.from("a footstep sound");

describe("Remix's Git LFS files over https", () => {
  it("reads a pointer exactly as Git LFS writes it, and nothing else", () => {
    const oid = oidOf(MODEL);
    const cases: Array<[string, { oid: string; size: number } | null]> = [
      [pointerOf(MODEL), { oid, size: MODEL.length }],
      [pointerOf(MODEL).replaceAll("\n", "\r\n"), { oid, size: MODEL.length }],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12`, { oid, size: 12 }],
      ["", null],
      ["hello\n", null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.slice(1)}\nsize 12\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.toUpperCase()}\nsize 12\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid md5:${oid}\nsize 12\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize -1\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 99999999999999999999\n`, null],
      [`version https://example.com/spec\noid sha256:${oid}\nsize 12\n`, null],
      [`${pointerOf(MODEL)}trailing\n`, null],
    ];
    for (const [text, expected] of cases) assert.deepEqual(parseLfsPointer(text), expected, JSON.stringify(text));
  });

  it("finds the clone's pointers, never its .git, a big file, or what a link points at", async () => {
    const outside = await cloneWith({ "elsewhere.glb": pointerOf(MODEL) });
    const dir = await cloneWith({
      "public/models/player.glb": pointerOf(MODEL),
      "public/sounds/step 1.mp3": pointerOf(SOUND),
      "index.html": "<h1>game</h1>",
      ".git/lfs-looking": pointerOf(MODEL),
      "big.bin": `${pointerOf(MODEL)}${"x".repeat(2048)}`,
    });
    await symlink(path.join(outside, "elsewhere.glb"), path.join(dir, "linked.glb"));
    await symlink(outside, path.join(dir, "linked-folder"));
    const found = await findLfsPointers(dir, async (files) => new Set(files));
    assert.deepEqual(found.map((pointer) => pointer.file.split(path.sep).join("/")).sort(), [
      "public/models/player.glb",
      "public/sounds/step 1.mp3",
    ]);
  });

  it("puts every model in its pointer's place, downloading each object once, and tells the bytes", async () => {
    const dir = await cloneWith({
      "public/models/player.glb": pointerOf(MODEL),
      "public/models/copy-of-player.glb": pointerOf(MODEL),
      "public/sounds/step.mp3": pointerOf(SOUND),
      "index.html": "<h1>game</h1>",
    });
    const store = new Map([
      [oidOf(MODEL), MODEL],
      [oidOf(SOUND), SOUND],
    ]);
    const { fetch, seen } = fakeNetwork(store);
    const { deps, heard } = depsOn(fetch);
    await downloadLfsFiles(dir, REPO, deps);
    assert.deepEqual(await readFile(path.join(dir, "public/models/player.glb")), MODEL);
    assert.deepEqual(await readFile(path.join(dir, "public/models/copy-of-player.glb")), MODEL);
    assert.deepEqual(await readFile(path.join(dir, "public/sounds/step.mp3")), SOUND);
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), "<h1>game</h1>");
    // One batch to the game's own repository, then one download per object: the shared model once.
    const [batch, ...downloads] = seen;
    assert.deepEqual([batch?.method, batch?.url], ["POST", BATCH]);
    assert.deepEqual(
      downloads.map(({ method, url }) => [method, url.split("?")[0]]).sort(),
      [...store.keys()].map((oid) => ["GET", `${STORAGE}/${oid}`]).sort(),
    );
    const total = MODEL.length + SOUND.length;
    assert.deepEqual(heard[0], [0, total]);
    assert.deepEqual(heard.at(-1), [total, total]);
    for (let index = 1; index < heard.length; index += 1)
      assert.ok((heard[index]?.[0] ?? 0) >= (heard[index - 1]?.[0] ?? 0), "the bytes only grow");
    assert.deepEqual(await readdir(path.join(dir, ".git")), [], "no half downloads left beside the clone");
  });

  it("asks for at most a hundred objects a batch", async () => {
    const files: Record<string, Buffer> = {};
    const store = new Map<string, Buffer>();
    for (let index = 0; index < 205; index += 1) {
      const bytes = Buffer.from(`model ${index}`);
      files[`models/${index}.glb`] = Buffer.from(pointerOf(bytes));
      store.set(oidOf(bytes), bytes);
    }
    const dir = await cloneWith(files);
    const { fetch, seen } = fakeNetwork(store);
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    const batches = seen.filter((request) => request.method === "POST");
    assert.deepEqual(
      batches.map((batch) => batch.objects.length),
      [100, 100, 5],
    );
    assert.deepEqual(await readFile(path.join(dir, "models/204.glb")), Buffer.from("model 204"));
  });

  it("does nothing for a clone with no pointers", async () => {
    const dir = await cloneWith({ "index.html": "<h1>game</h1>" });
    const { fetch, seen } = fakeNetwork(new Map());
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    assert.deepEqual(seen, []);
  });

  it("refuses what Genex's git or its storage answers wrong, and leaves every pointer as it was", async () => {
    const located =
      (href: string, header?: unknown): Answer =>
      (object) => ({
        ...object,
        actions: { download: { href, ...(header ? { header } : {}) } },
      });
    const wrongBytes = new Map([[oidOf(MODEL), Buffer.from("not the model")]]);
    const longer = new Map([[oidOf(MODEL), Buffer.concat([MODEL, Buffer.from("more")])]]);
    const cases: Array<{
      name: string;
      fetch?: LfsDownloadDeps["fetch"];
      store?: Map<string, Buffer>;
      answer?: Answer;
      redirect?: Redirect;
      refused: RegExp;
    }> = [
      { name: "bytes that are not the model", store: wrongBytes, refused: /didn’t match/ },
      { name: "more bytes than the pointer says", store: longer, refused: /didn’t match/ },
      { name: "an object the server does not have", store: new Map(), refused: /2 of this game’s files/ },
      { name: "an object left out of the answer", answer: () => undefined, refused: /2 of this game’s files/ },
      { name: "a plain http download", answer: located(`http://storage.genex.example/x`), refused: /refused/ },
      {
        name: "a download with a password",
        answer: located(`https://u:p@storage.genex.example/x`),
        refused: /refused/,
      },
      { name: "a download that is not a link", answer: located("ext::sh -c touch"), refused: /refused/ },
      { name: "a header that is not text", answer: located(`${STORAGE}/x`, { Authorization: 1 }), refused: /refused/ },
      {
        name: "a download redirected to plain http",
        redirect: (url) => (url.startsWith(STORAGE) ? "http://storage.genex.example/x" : undefined),
        refused: /refused/,
      },
      {
        name: "a download redirected to an address with a password",
        redirect: (url) => (url.startsWith(STORAGE) ? "https://u:p@storage.genex.example/x" : undefined),
        refused: /refused/,
      },
      {
        name: "a download redirected with no address",
        fetch: async (input) =>
          String(input) === BATCH
            ? fakeNetwork(new Map([[oidOf(MODEL), MODEL]])).fetch(input, { method: "POST", body: batchBody() })
            : new Response(null, { status: 302 }),
        refused: /refused/,
      },
      {
        name: "a batch redirected elsewhere",
        fetch: async () => new Response(null, { status: 307, headers: { location: `${REPO}/elsewhere` } }),
        refused: /refused/,
      },
      {
        name: "an answer naming a path for an object",
        answer: (object) => ({ ...object, oid: "../../x", actions: { download: { href: `${STORAGE}/x` } } }),
        refused: /2 of this game’s files/,
      },
      {
        name: "a batch that fails",
        fetch: async () => new Response("down", { status: 503 }),
        refused: /answered 503/,
      },
      {
        name: "a batch that is not JSON",
        fetch: async () => new Response("<html>", { status: 200 }),
        refused: /couldn’t be read/,
      },
      {
        name: "a batch of the wrong shape",
        fetch: async () => Response.json({ objects: "all of them" }),
        refused: /couldn’t be read/,
      },
    ];
    for (const { name, fetch, store, answer, redirect, refused } of cases) {
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL), "b/c.glb": pointerOf(MODEL) });
      const network = fakeNetwork(store ?? new Map([[oidOf(MODEL), MODEL]]), answer, redirect);
      await assert.rejects(downloadLfsFiles(dir, REPO, depsOn(fetch ?? network.fetch).deps), refused, name);
      assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL), name);
      assert.equal(await readFile(path.join(dir, "b/c.glb"), "utf8"), pointerOf(MODEL), name);
      assert.deepEqual((await readdir(dir)).sort(), [".git", "a.glb", "b"], `${name}: nothing written beside them`);
      assert.deepEqual(await readdir(path.join(dir, ".git")), [], `${name}: no half download kept`);
      const offHost = network.seen.filter(
        (request) => !request.url.startsWith(REPO) && !request.url.startsWith(STORAGE),
      );
      assert.deepEqual(offHost, [], `${name}: nothing requested off Genex's git and storage`);
    }
  });

  it("follows a storage redirect to another https address", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const moved = (url: string) => (url.startsWith(`${STORAGE}/`) ? `${STORAGE}/moved/${oidOf(MODEL)}` : undefined);
    const store = new Map([
      [oidOf(MODEL), MODEL],
      [`moved/${oidOf(MODEL)}`, MODEL],
    ]);
    const { fetch, seen } = fakeNetwork(store, undefined, (url) => (url.includes("/moved/") ? undefined : moved(url)));
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL);
    assert.equal(seen.at(-1)?.url, `${STORAGE}/moved/${oidOf(MODEL)}`);
  });

  it("sends the answer's headers to its own storage host only, never on to another a redirect names", async () => {
    const cases: Array<{ name: string; to: string; carried: string | null }> = [
      { name: "another host", to: `https://cdn.genex.example/${oidOf(MODEL)}`, carried: null },
      { name: "the same host", to: `${STORAGE}/moved/${oidOf(MODEL)}`, carried: "Bearer token" },
    ];
    for (const { name, to, carried } of cases) {
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
      const store = new Map([
        [oidOf(MODEL), MODEL],
        [`moved/${oidOf(MODEL)}`, MODEL],
      ]);
      const signed: Answer = (object) => ({
        ...object,
        actions: { download: { href: `${STORAGE}/${object.oid}`, header: { Authorization: "Bearer token" } } },
      });
      const { fetch, seen } = fakeNetwork(store, signed, (url) =>
        url === `${STORAGE}/${oidOf(MODEL)}` ? to : undefined,
      );
      await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
      assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL, name);
      const [, first, second] = seen;
      assert.deepEqual([first?.url, first?.authorization], [`${STORAGE}/${oidOf(MODEL)}`, "Bearer token"], name);
      assert.deepEqual([second?.url, second?.authorization], [to, carried], name);
    }
  });

  it("downloads only the pointers the clone's attributes route through Git LFS", async () => {
    const dir = await cloneWith({ "models/a.glb": pointerOf(MODEL), "docs/pointer-example.txt": pointerOf(SOUND) });
    const { fetch, seen } = fakeNetwork(
      new Map([
        [oidOf(MODEL), MODEL],
        [oidOf(SOUND), SOUND],
      ]),
    );
    const asked: string[][] = [];
    const deps: LfsDownloadDeps = {
      ...depsOn(fetch).deps,
      routed: async (files) => {
        asked.push(files.map((file) => file.split(path.sep).join("/")).sort());
        return new Set(files.filter((file) => file.endsWith(".glb")));
      },
    };
    await downloadLfsFiles(dir, REPO, deps);
    assert.deepEqual(
      asked,
      [["docs/pointer-example.txt", "models/a.glb"]],
      "only pointer-shaped files are asked about",
    );
    assert.deepEqual(await readFile(path.join(dir, "models/a.glb")), MODEL);
    assert.equal(await readFile(path.join(dir, "docs/pointer-example.txt"), "utf8"), pointerOf(SOUND));
    assert.deepEqual(
      seen.flatMap((request) => request.objects.map((object) => object.oid)),
      [oidOf(MODEL)],
    );
  });

  it("asks Genex's git only at the game's own repository", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const { fetch, seen } = fakeNetwork(new Map([[oidOf(MODEL), MODEL]]));
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    const batch = seen.find((request) => request.method === "POST");
    assert.equal(batch?.url, BATCH);
  });

  it("gives Genex's git up once it stops answering, so a later remix is not held up", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const timers = manualTimers();
    let asked = () => {};
    const waiting = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const fetch: LfsDownloadDeps["fetch"] = (_input, init) =>
      new Promise((_resolve, reject) => {
        asked();
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const deps: LfsDownloadDeps = { ...depsOn(fetch).deps, guard: () => stallGuard(timers.clock) };
    const download = downloadLfsFiles(dir, REPO, deps);
    await waiting;
    timers.advance(DOWNLOAD_STALL_MS);
    await assert.rejects(download, /stopped answering/);
    assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL));
  });

  it("gives a model up once its download stops moving", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const timers = manualTimers();
    let waiting = () => {};
    const stuck = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const { fetch: answering } = fakeNetwork(new Map([[oidOf(MODEL), MODEL]]));
    const fetch: LfsDownloadDeps["fetch"] = async (input, init) => {
      if (String(input) === BATCH) return answering(input, init);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(MODEL.subarray(0, 10));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
        pull() {
          waiting();
          return new Promise(() => {});
        },
      });
      return new Response(body);
    };
    const deps: LfsDownloadDeps = { ...depsOn(fetch).deps, guard: () => stallGuard(timers.clock) };
    const download = downloadLfsFiles(dir, REPO, deps);
    await stuck;
    timers.advance(DOWNLOAD_STALL_MS);
    await assert.rejects(download, /stopped moving/);
    assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL));
  });
});

/** A batch request's body asking for the model, as `downloadLfsFiles` sends it. */
const batchBody = (): string => JSON.stringify({ objects: [{ oid: oidOf(MODEL), size: MODEL.length }] });

/** Timers the test moves by hand. */
function manualTimers(): { clock: StallClock; advance: (ms: number) => void } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      setTimeout: (run, ms) => {
        next += 1;
        timers.set(next, { at: now + ms, run });
        return next;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    advance: (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

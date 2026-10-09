import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_INDEX_URL,
  PluginMarketplace,
  STUDIO_CATALOG_POLICY,
  applyCatalogPolicy,
  parseGithubSpec,
  validateIndex,
  versionGte,
} from "../../src/substrate/plugins/marketplace.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import type {
  PluginIndex,
  PluginIndexEntry,
  PluginInfo,
  PluginManifest,
  PluginScan,
  PluginSource,
} from "../../src/shared/plugins.ts";

const source = path.resolve("src/plugins/example");
const FILES = ["plugin.json", "backend.mjs", "panel.html"] as const;
const SHA = "a".repeat(40);
const REPO = "acme/studio-plugins";
/** Where official records point now, and where the published catalog's records still point. */
const NEW_OFFICIAL_REPO = "genex-games/genex-desktop";
const LEGACY_OFFICIAL_REPO = "Rabneba/ai-game-studio";
/** The object id GitHub reports for a blob; staging refuses any byte that does not hash to it. */
const blobSha = (bytes: Buffer) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");

function network() {
  const routes = new Map<string, () => Response | Promise<Response>>();
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const route = routes.get(url);
    if (!route) throw new Error(`no route for ${url}`);
    return route();
  }) as unknown as typeof fetch;
  return { routes, calls, fetchImpl };
}
const body = (bytes: Buffer) => new Response(new Uint8Array(bytes));
const json = (value: unknown) => () => body(Buffer.from(JSON.stringify(value)));
async function exampleFiles() {
  const files = new Map<string, Buffer>();
  for (const name of FILES) files.set(name, await readFile(path.join(source, name)));
  return files;
}
/** Serve a pinned commit: the git-trees answer plus one raw blob per file. */
function mountRepo(
  routes: Map<string, () => Response | Promise<Response>>,
  options: {
    files: Map<string, Buffer>;
    subdir?: string;
    sha?: string;
    repo?: string;
    extra?: Array<Record<string, unknown>>;
    truncated?: boolean;
    corrupt?: string;
  },
) {
  const sha = options.sha ?? SHA,
    repo = options.repo ?? REPO,
    prefix = options.subdir ? `${options.subdir}/` : "";
  const tree = [...options.files].map(([name, bytes]) => ({
    path: `${prefix}${name}`,
    mode: "100644",
    type: "blob",
    sha: blobSha(bytes),
    size: bytes.length,
  }));
  routes.set(
    `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`,
    json({ sha, truncated: options.truncated === true, tree: [...tree, ...(options.extra ?? [])] }),
  );
  for (const [name, bytes] of options.files)
    routes.set(`https://raw.githubusercontent.com/${repo}/${sha}/${prefix}${name}`, () =>
      body(name === options.corrupt ? Buffer.from("tampered") : bytes),
    );
  return { sha, repo };
}
async function fixture(options?: { offline?: boolean; studioVersion?: string }) {
  const base = await mkdtemp(path.join(os.tmpdir(), "studio-market-"));
  const root = path.join(base, "plugins");
  await mkdir(root, { recursive: true });
  const net = network();
  const marketplace = new PluginMarketplace({
    root,
    studioVersion: options?.studioVersion ?? "0.1.0",
    fetchImpl: net.fetchImpl,
    offline: options?.offline,
  });
  return {
    base,
    root,
    marketplace,
    ...net,
    async clean() {
      await rm(base, { recursive: true, force: true });
    },
  };
}
const entryFor = (over: Partial<PluginIndexEntry> = {}): PluginIndexEntry => ({
  id: "example",
  name: "Plugin SDK example",
  publisher: "Studio development",
  description: "Local SDK example.",
  category: "tools",
  tier: "community",
  repo: REPO,
  sha: SHA,
  version: "1.0.0",
  capabilities: ["settings"],
  ...over,
});
const indexFor = (entries: PluginIndexEntry[]): PluginIndex => ({
  version: 1,
  updatedAt: "2026-09-18T00:00:00.000Z",
  plugins: entries,
});

test("a malformed listing is refused without hiding valid catalog entries", async () => {
  const f = await fixture();
  try {
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor(), entryFor({ id: "broken", sha: "mutable" })])));
    const view = await f.marketplace.index(true);
    assert.deepEqual(
      view.entries.map((entry) => entry.id),
      ["example"],
    );
    assert.match(view.error ?? "", /ignored 1 invalid catalog entry/i);
    assert.equal(view.stale, false);
  } finally {
    await f.clean();
  }
});
const installedInfo = (id: string, version: string, origin: PluginSource): PluginInfo => ({
  manifest: { id, version, publisher: "Studio development" } as PluginManifest,
  source: origin.kind,
  enabled: true,
  removed: false,
  health: "stopped",
  state: "enabled",
  origin,
});

test("the index schema is validated field by field, so a bad entry never reaches the trust dialog", () => {
  assert.equal(DEFAULT_INDEX_URL, "https://plugins.genex.games/catalog/v1/index.json");
  const ok = validateIndex(
    indexFor([entryFor({ subdir: "plugins/example", docsUrl: "https://docs.example/p", minStudioVersion: "0.1.0" })]),
  );
  assert.equal(ok.plugins.length, 1);
  assert.equal(ok.plugins[0]!.subdir, "plugins/example");
  assert.throws(() => validateIndex({ ...indexFor([]), version: 2 }), /Invalid marketplace index/);
  assert.throws(() => validateIndex(indexFor([entryFor({ sha: "abc123" })])), /sha/);
  assert.throws(() => validateIndex(indexFor([entryFor({ repo: "not-a-repo" })])), /repo/);
  assert.throws(() => validateIndex(indexFor([entryFor({ docsUrl: "http://docs.example/p" })])), /https/);
  assert.throws(() => validateIndex(indexFor([entryFor({ tier: "gold" as PluginIndexEntry["tier"] })])), /tier/);
  assert.throws(
    () => validateIndex(indexFor([entryFor({ category: "games" as PluginIndexEntry["category"] })])),
    /category/,
  );
  assert.throws(() => validateIndex(indexFor([entryFor(), entryFor()])), /Duplicate/);
  assert.throws(() => validateIndex(indexFor([entryFor({ subdir: "../escape" })])), /Invalid plugin path/);
  assert.throws(() => validateIndex(indexFor([entryFor({ id: "Example" })])), /entry id/);
  assert.throws(() => validateIndex(indexFor([entryFor({ version: "1.0" })])), /version/);
  assert.throws(
    () => validateIndex(indexFor([entryFor({ artifact: { url: "http://a.example/p", sha256: "0".repeat(64) } })])),
    /artifact/,
  );
  assert.throws(
    () => validateIndex(indexFor([entryFor({ artifact: { url: "https://a.example/p", sha256: "zz" } })])),
    /artifact/,
  );
});
test("a GitHub spec must name a repository and a full commit sha", () => {
  assert.deepEqual(parseGithubSpec(`acme/repo@${SHA}`), { repo: "acme/repo", owner: "acme", name: "repo", sha: SHA });
  assert.deepEqual(parseGithubSpec(`acme/repo/sub/dir@${SHA}`), {
    repo: "acme/repo",
    owner: "acme",
    name: "repo",
    sha: SHA,
    subdir: "sub/dir",
  });
  assert.equal(parseGithubSpec(`acme/repo@${SHA.toUpperCase()}`).sha, SHA);
  for (const bad of ["acme/repo@abc123", "acme/repo", "acme@" + SHA, "", 42])
    assert.throws(() => parseGithubSpec(bad), /spec/, String(bad));
  assert.throws(() => parseGithubSpec(`acme/repo/../x@${SHA}`), /Invalid plugin path/);
  assert.equal(versionGte("0.2.0", "0.1.9"), true);
  assert.equal(versionGte("0.1.0", "0.1.0"), true);
  assert.equal(versionGte("0.1.0", "1.0.0"), false);
  // A release candidate of Studio meets its release's minimum, and no later one.
  assert.equal(versionGte("0.1.0-rc.1", "0.1.0"), true);
  assert.equal(versionGte("0.1.0-rc.1", "0.1.1"), false);
});
test("the index is cached for six hours, served stale on failure and never fetched offline", async () => {
  const f = await fixture();
  try {
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor()])));
    const first = await f.marketplace.index();
    assert.deepEqual(
      first.entries.map((e) => e.id),
      ["example"],
    );
    assert.equal(first.stale, false);
    assert.equal(first.error, undefined);
    assert.equal(first.url, DEFAULT_INDEX_URL);
    assert.equal(f.calls.length, 1);
    await f.marketplace.index();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.marketplace.index(true)).stale, false);
    assert.equal(f.calls.length, 2);
    const cacheFile = path.join(f.root, "cache", "index.json");
    const cache = JSON.parse(await readFile(cacheFile, "utf8"));
    cache.fetchedAt = Date.now() - 7 * 60 * 60 * 1000;
    await writeFile(cacheFile, JSON.stringify(cache));
    await f.marketplace.index();
    assert.equal(f.calls.length, 3);
    f.routes.set(DEFAULT_INDEX_URL, () => {
      throw new Error("network down");
    });
    const stale = await f.marketplace.index(true);
    assert.equal(stale.stale, true);
    assert.match(stale.error!, /network down/);
    assert.deepEqual(
      stale.entries.map((e) => e.id),
      ["example"],
    );
    assert.ok(stale.fetchedAt! > 0);
  } finally {
    await f.clean();
  }
  const override = await fixture();
  try {
    await writeFile(
      path.join(override.root, "marketplace.json"),
      JSON.stringify({ indexUrl: "https://mirror.example/index.json" }),
    );
    override.routes.set("https://mirror.example/index.json", json(indexFor([entryFor({ id: "mirrored" })])));
    const view = await override.marketplace.index();
    assert.equal(view.url, "https://mirror.example/index.json");
    assert.deepEqual(
      view.entries.map((e) => e.id),
      ["mirrored"],
    );
    await writeFile(
      path.join(override.root, "marketplace.json"),
      JSON.stringify({ indexUrl: "http://mirror.example/index.json" }),
    );
    const refused = await override.marketplace.index(true);
    assert.match(refused.error!, /https/);
    assert.equal(override.calls.length, 1);
  } finally {
    await override.clean();
  }
  const offline = await fixture({ offline: true });
  try {
    offline.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor()])));
    const view = await offline.marketplace.index(true);
    assert.deepEqual(offline.calls, []);
    assert.equal(view.stale, true);
    assert.equal(view.error, "Studio is offline in this profile");
    assert.deepEqual(view.entries, []);
    assert.equal(view.fetchedAt, null);
    // Offline is a property of the marketplace, not of the index route: staging a pinned commit
    // opens no socket either, so a fixture profile cannot reach GitHub by any path.
    await assert.rejects(offline.marketplace.stageGithub(`${REPO}@${SHA}`), /Studio is offline in this profile/);
    assert.deepEqual(offline.calls, []);
  } finally {
    await offline.clean();
  }
});
test("a pinned commit stages through the tree API and installs with its origin recorded", async () => {
  const f = await fixture();
  try {
    mountRepo(f.routes, { files: await exampleFiles() });
    const staged = await f.marketplace.stageGithub(`${REPO}@${SHA}`);
    assert.equal(staged.manifest.id, "example");
    assert.equal(staged.scan.verdict, "safe");
    assert.deepEqual(staged.origin, { kind: "github", repo: REPO, sha: SHA });
    const seeds = path.join(f.base, "seeds");
    await mkdir(seeds, { recursive: true });
    const registry = new PluginRegistry(
      path.join(f.base, "installed"),
      seeds,
      path.resolve("src/plugin-sdk/backend.mjs"),
      async () => null,
    );
    await registry.init();
    try {
      await registry.installLocal(staged.stage, "github", ["settings"], staged.origin, staged.scan);
      const info = registry.list().find((p) => p.manifest.id === "example")!;
      assert.equal(info.source, "github");
      assert.deepEqual(info.origin, { kind: "github", repo: REPO, sha: SHA });
      assert.equal(info.scan!.verdict, "safe");
      const state = JSON.parse(await readFile(path.join(registry.root, "installed.json"), "utf8"));
      assert.deepEqual(state.example.origin, { kind: "github", repo: REPO, sha: SHA });
    } finally {
      registry.cancel();
    }
    await rm(staged.stage, { recursive: true, force: true });
  } finally {
    await f.clean();
  }
});
test("staging refuses tampered blobs, links, submodules, truncated trees, oversized packages and a missing manifest", async () => {
  const f = await fixture();
  try {
    const files = await exampleFiles();
    mountRepo(f.routes, { files, corrupt: "backend.mjs" });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${SHA}`), /Integrity check failed/);
    const linked = "b".repeat(40);
    mountRepo(f.routes, {
      files,
      sha: linked,
      extra: [{ path: "link", mode: "120000", type: "blob", sha: "c".repeat(40), size: 5 }],
    });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${linked}`), /symlinks or submodules/);
    const moduled = "d".repeat(40);
    mountRepo(f.routes, {
      files,
      sha: moduled,
      extra: [{ path: "vendor", mode: "160000", type: "commit", sha: "e".repeat(40) }],
    });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${moduled}`), /symlinks or submodules/);
    const cut = "f".repeat(40);
    mountRepo(f.routes, { files, sha: cut, truncated: true });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${cut}`), /truncated/);
    const huge = "1".repeat(40);
    mountRepo(f.routes, {
      files,
      sha: huge,
      extra: [{ path: "big.bin", mode: "100644", type: "blob", sha: "2".repeat(40), size: 9 * 1024 * 1024 }],
    });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${huge}`), /exceeds 8388608 bytes/);
    const total = "3".repeat(40);
    mountRepo(f.routes, {
      files,
      sha: total,
      extra: Array.from({ length: 10 }, (_, i) => ({
        path: `chunk${i}.bin`,
        mode: "100644",
        type: "blob",
        sha: String(i).repeat(40),
        size: 7 * 1024 * 1024,
      })),
    });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${total}`), /exceeds 67108864 bytes/);
    const many = "4".repeat(40);
    mountRepo(f.routes, {
      files,
      sha: many,
      extra: Array.from({ length: 401 }, (_, i) => ({
        path: `f${i}.js`,
        mode: "100644",
        type: "blob",
        sha: "a".repeat(40),
        size: 1,
      })),
    });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${many}`), /exceeds 400 files/);
    const bare = "5".repeat(40);
    const withoutManifest = new Map(files);
    withoutManifest.delete("plugin.json");
    mountRepo(f.routes, { files: withoutManifest, sha: bare });
    await assert.rejects(f.marketplace.stageGithub(`${REPO}@${bare}`), /No plugin\.json/);
  } finally {
    await f.clean();
  }
});
test("a subdirectory spec stages only that folder and records it in the origin", async () => {
  const f = await fixture();
  try {
    const files = await exampleFiles();
    mountRepo(f.routes, { files, subdir: "plugins/example" });
    const outside = `https://api.github.com/repos/${REPO}/git/trees/${SHA}?recursive=1`;
    const tree = JSON.parse(await (await f.routes.get(outside)!()).text());
    tree.tree.push({ path: "README.md", mode: "100644", type: "blob", sha: "9".repeat(40), size: 4 });
    f.routes.set(outside, json(tree));
    const staged = await f.marketplace.stageGithub(`${REPO}/plugins/example@${SHA}`);
    try {
      assert.deepEqual(staged.origin, { kind: "github", repo: REPO, sha: SHA, subdir: "plugins/example" });
      assert.equal(staged.manifest.id, "example");
      assert.ok(!f.calls.some((u) => u.endsWith("/README.md")));
      assert.equal(
        await readFile(path.join(staged.stage, "plugin.json"), "utf8"),
        files.get("plugin.json")!.toString(),
      );
    } finally {
      await rm(staged.stage, { recursive: true, force: true });
    }
  } finally {
    await f.clean();
  }
});
test("an index install must match the pinned manifest, respects minStudioVersion and reports updates", async () => {
  const f = await fixture();
  const seeds = path.join(f.base, "seeds");
  await mkdir(seeds, { recursive: true });
  const registry = new PluginRegistry(
    path.join(f.base, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async () => null,
  );
  await registry.init();
  try {
    const files = await exampleFiles();
    mountRepo(f.routes, { files });
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ version: "9.9.9" })])));
    await f.marketplace.index();
    await assert.rejects(
      f.marketplace.installIndex("example", registry, ["settings"]),
      /does not match the plugin at that commit \(version\)/,
    );
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ publisher: "Somebody else" })])));
    await f.marketplace.index(true);
    await assert.rejects(f.marketplace.installIndex("example", registry, ["settings"]), /\(publisher\)/);
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ capabilities: ["settings", "credentials"] })])));
    await f.marketplace.index(true);
    await assert.rejects(
      f.marketplace.installIndex("example", registry, ["settings", "credentials"]),
      /\(capabilities\)/,
    );
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ minStudioVersion: "9.0.0" })])));
    await f.marketplace.index(true);
    await assert.rejects(
      f.marketplace.installIndex("example", registry, ["settings"]),
      /needs Studio 9\.0\.0 or newer/,
    );
    await assert.rejects(f.marketplace.installIndex("absent", registry), /not in the marketplace index/);
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ minStudioVersion: "0.1.0" })])));
    await f.marketplace.index(true);
    const installed = await f.marketplace.installIndex("example", registry, ["settings"]);
    assert.equal(installed.manifest.version, "1.0.0");
    assert.equal(installed.scan.verdict, "safe");
    assert.deepEqual(installed.origin, { kind: "index", repo: REPO, sha: SHA });
    const info = registry.list().find((p) => p.manifest.id === "example")!;
    assert.equal(info.source, "index");
    assert.deepEqual(info.origin, { kind: "index", repo: REPO, sha: SHA });
    assert.deepEqual(f.marketplace.updates(registry.list()), []);
    const moved = "7".repeat(40);
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ sha: moved, version: "1.1.0" })])));
    await f.marketplace.index(true);
    assert.deepEqual(f.marketplace.updates(registry.list()), [
      { id: "example", installedVersion: "1.0.0", version: "1.1.0", sha: moved },
    ]);
    assert.deepEqual(
      f.marketplace.updates([installedInfo("example", "1.0.0", { kind: "local", directory: "/tmp/x" })]),
      [],
    );
    assert.deepEqual(
      f.marketplace.updates([
        { ...installedInfo("example", "1.0.0", { kind: "index", repo: REPO, sha: moved }), removed: true },
      ]),
      [],
    );
    assert.deepEqual(
      f.marketplace.updates([installedInfo("example", "1.0.0", { kind: "github", repo: REPO, sha: "8".repeat(40) })]),
      [{ id: "example", installedVersion: "1.0.0", version: "1.1.0", sha: moved }],
    );
  } finally {
    registry.cancel();
    await f.clean();
  }
});
/**
 * Reinstalling a removed cataloged plugin. What must not happen: a dialog about the manifest the old
 * record carries, an install of whatever the index pins today, or a package nobody scanned.
 */
test("re-acquiring a removed plugin stages the commit its record pins and asks about that code", async () => {
  const f = await fixture();
  const seeds = path.join(f.base, "seeds");
  await mkdir(seeds, { recursive: true });
  const registry = new PluginRegistry(
    path.join(f.base, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async () => null,
  );
  await registry.init();
  try {
    const files = await exampleFiles();
    mountRepo(f.routes, { files });
    // The index has moved on to another commit, whose package says something else about itself.
    const moved = "7".repeat(40);
    const newer = new Map(files);
    newer.set(
      "plugin.json",
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(files.get("plugin.json")!.toString()),
          version: "2.0.0",
          description: "A later commit.",
        }),
      ),
    );
    mountRepo(f.routes, { files: newer, sha: moved });
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ sha: moved, version: "2.0.0" })])));
    const record: PluginInfo = {
      ...installedInfo("example", "1.0.0", { kind: "index", repo: REPO, sha: SHA }),
      removed: true,
      enabled: false,
      state: "disabled",
    };
    record.manifest = {
      ...record.manifest,
      name: "A name from the old record",
      capabilities: ["settings"],
    } as PluginManifest;
    const shown: Array<{
      name: string;
      version: string;
      verdict: string;
      origin: PluginSource;
      note: string | undefined;
    }> = [];
    const watch =
      (answer: boolean) => async (manifest: PluginManifest, scan: PluginScan, origin: PluginSource, note?: string) => {
        shown.push({ name: manifest.name, version: manifest.version, verdict: scan.verdict, origin, note });
        return answer;
      };
    await assert.rejects(f.marketplace.reacquire(record, registry, watch(false)), /Cancelled by user/);
    assert.equal(
      registry.list().some((p) => p.manifest.id === "example"),
      false,
      "a declined dialog installs nothing",
    );
    await f.marketplace.reacquire(record, registry, watch(true));
    assert.equal(shown.length, 2);
    for (const ask of shown) {
      assert.equal(ask.version, "1.0.0", "the staged manifest is what the user is asked about");
      assert.equal(ask.name, "Plugin SDK example", "never the name the removed record happened to carry");
      assert.equal(ask.verdict, "safe", "and the code that was just staged is what was scanned");
      assert.deepEqual(ask.origin, { kind: "index", repo: REPO, sha: SHA });
      assert.match(String(ask.note), /now pins 777777777777/, "a moved index is said out loud, not installed");
    }
    assert.ok(!f.calls.some((u) => u.includes(moved)), "nothing was fetched at the commit the index moved to");
    assert.ok(f.calls.some((u) => u === `https://api.github.com/repos/${REPO}/git/trees/${SHA}?recursive=1`));
    const info = registry.list().find((p) => p.manifest.id === "example")!;
    assert.equal(info.manifest.version, "1.0.0");
    assert.equal(info.source, "index");
    assert.equal(info.removed, false);
    assert.deepEqual(info.origin, { kind: "index", repo: REPO, sha: SHA });
    assert.equal(info.scan!.verdict, "safe", "the card carries the scan of the code that was installed");
    await assert.rejects(
      f.marketplace.reacquire({ ...record, origin: { kind: "local", directory: "/tmp/x" } }, registry),
      /does not know where this plugin came from/,
    );
  } finally {
    registry.cancel();
    await f.clean();
  }
});
test("a curated artifact entry installs through the shared envelope path with its digest and scan", async () => {
  const f = await fixture();
  const seeds = path.join(f.base, "seeds");
  await mkdir(seeds, { recursive: true });
  const registry = new PluginRegistry(
    path.join(f.base, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async () => null,
  );
  await registry.init();
  try {
    const files = await exampleFiles();
    const envelope = Buffer.from(
      JSON.stringify(Object.fromEntries([...files].map(([name, bytes]) => [name, bytes.toString("base64")]))),
    );
    const sha256 = createHash("sha256").update(envelope).digest("hex");
    // Content-addressed on an origin the app's catalog policy allows (GX-3).
    const at = (digest: string) => `https://plugins.genex.games/releases/example/1.0.0/${digest}.json`,
      url = at(sha256);
    f.routes.set(url, () => body(envelope));
    f.routes.set(at("0".repeat(64)), () => body(envelope));
    f.routes.set(
      DEFAULT_INDEX_URL,
      json(indexFor([entryFor({ artifact: { url: at("0".repeat(64)), sha256: "0".repeat(64) } })])),
    );
    await f.marketplace.index();
    await assert.rejects(f.marketplace.installIndex("example", registry, ["settings"]), /digest mismatch/);
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([entryFor({ artifact: { url, sha256 } })])));
    await f.marketplace.index(true);
    const installed = await f.marketplace.installIndex("example", registry, ["settings"]);
    assert.equal(installed.scan.verdict, "safe");
    assert.deepEqual(installed.origin, { kind: "index", repo: REPO, sha: SHA, url, sha256 });
    const info = registry.list().find((p) => p.manifest.id === "example")!;
    assert.equal(info.source, "index");
    assert.equal(info.scan!.verdict, "safe");
    assert.deepEqual(info.origin, { kind: "index", repo: REPO, sha: SHA, url, sha256 });
  } finally {
    registry.cancel();
    await f.clean();
  }
});

test("catalog updates require a newer compatible release from the same publisher and source", async () => {
  const f = await fixture();
  try {
    const installed = installedInfo("example", "1.0.0", { kind: "index", repo: REPO, sha: SHA });
    const next = entryFor({ version: "1.1.0", sha: "b".repeat(40) });
    for (const override of [
      { version: "1.0.0" },
      { version: "0.9.0" },
      { publisher: "Other" },
      { repo: "other/repo" },
      { subdir: "other" },
      { minStudioVersion: "99.0.0" },
    ]) {
      f.routes.set(DEFAULT_INDEX_URL, json(indexFor([{ ...next, ...override }])));
      await f.marketplace.index(true);
      assert.deepEqual(f.marketplace.updates([installed]), [], JSON.stringify(override));
    }
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([next])));
    await f.marketplace.index(true);
    assert.equal(f.marketplace.updates([installed]).length, 1);
    assert.equal(
      f.marketplace.updates([{ ...installed, enabled: false }]).length,
      1,
      "disabled plugins can update without enabling",
    );
  } finally {
    await f.clean();
  }
});

test("the app holds the catalog policy itself: reserved official identities and artifact origins (GX-3)", () => {
  const digest = "c".repeat(64);
  const hosted = (id: string, version: string) => ({
    url: `https://plugins.genex.games/releases/${id}/${version}/${digest}.json`,
    sha256: digest,
  });
  const official = entryFor({
    id: "genex",
    name: "Genex",
    publisher: "Genex",
    tier: "official",
    repo: "Rabneba/ai-game-studio",
    version: "1.3.2",
    artifact: hosted("genex", "1.3.2"),
  });
  const index = indexFor([
    official,
    entryFor({ id: "blender", name: "Impostor", publisher: "Mallory", tier: "community", repo: "mallory/tools" }),
    entryFor({ id: "acme-tool", name: "Acme", publisher: "Acme", tier: "official", repo: "acme/tool" }),
    entryFor({
      id: "elsewhere",
      name: "Elsewhere",
      publisher: "Acme",
      artifact: { url: `https://evil.example/elsewhere/1.0.0/${digest}.json`, sha256: digest },
    }),
    entryFor({
      id: "mutable",
      name: "Mutable",
      publisher: "Acme",
      artifact: { url: "https://plugins.genex.games/releases/latest.json", sha256: digest },
    }),
    entryFor({ id: "from-github", name: "From GitHub", publisher: "Acme" }),
  ]);
  const byId = new Map(applyCatalogPolicy(index, STUDIO_CATALOG_POLICY).plugins.map((e) => [e.id, e]));
  assert.deepEqual(byId.get("genex"), official, "the official entry that matches the map is kept as it is");
  assert.equal(byId.has("blender"), false, "a reserved official id from anyone else is refused");
  assert.equal(byId.get("acme-tool")?.tier, "community", '"official" is not the index\'s to grant');
  assert.equal(byId.has("elsewhere"), false, "an artifact from an origin the app does not know is refused");
  assert.equal(byId.has("mutable"), false, "an artifact URL must name its id, version and digest");
  assert.equal(byId.get("from-github")?.tier, "community");
  assert.deepEqual(
    applyCatalogPolicy(indexFor([{ ...official, publisher: "Genex Games" }]), STUDIO_CATALOG_POLICY).plugins,
    [],
    "the official publisher is exact",
  );
  assert.deepEqual(
    applyCatalogPolicy(indexFor([{ ...official, repo: "someone/fork" }]), STUDIO_CATALOG_POLICY).plugins,
    [],
    "so is its source repository",
  );
});

test("an official id is accepted from its new source repository and the legacy one, and from nowhere else", () => {
  const official = entryFor({ id: "blender", name: "Blender", publisher: "Studio", tier: "official" });
  for (const repo of [NEW_OFFICIAL_REPO, LEGACY_OFFICIAL_REPO]) {
    const kept = applyCatalogPolicy(indexFor([{ ...official, repo }]), STUDIO_CATALOG_POLICY).plugins;
    assert.deepEqual(kept, [{ ...official, repo }], repo);
  }
  for (const repo of ["genex-games/genex-plugins", "Rabneba/genex-desktop", "someone/ai-game-studio"]) {
    const kept = applyCatalogPolicy(indexFor([{ ...official, repo }]), STUDIO_CATALOG_POLICY).plugins;
    assert.deepEqual(kept, [], `${repo} is an impostor`);
  }
  const wrongPublisher = { ...official, repo: NEW_OFFICIAL_REPO, publisher: "Genex" };
  assert.deepEqual(applyCatalogPolicy(indexFor([wrongPublisher]), STUDIO_CATALOG_POLICY).plugins, []);
});

test("an official plugin installed from the legacy repository updates from the new one: the same source", async () => {
  const f = await fixture();
  try {
    const installed: PluginInfo = {
      ...installedInfo("genex", "1.3.2", { kind: "index", repo: LEGACY_OFFICIAL_REPO, sha: SHA }),
      manifest: { id: "genex", version: "1.3.2", publisher: "Genex" } as PluginManifest,
    };
    const next = entryFor({ id: "genex", name: "Genex", publisher: "Genex", tier: "official", version: "1.4.0" });
    const moved = { ...next, repo: NEW_OFFICIAL_REPO, sha: "b".repeat(40) };
    f.routes.set(DEFAULT_INDEX_URL, json(indexFor([moved])));
    await f.marketplace.index(true);
    assert.deepEqual(f.marketplace.updates([installed]), [
      { id: "genex", installedVersion: "1.3.2", version: "1.4.0", sha: moved.sha },
    ]);
    const community = {
      ...installedInfo("genex", "1.3.2", { kind: "index", repo: "someone/fork", sha: SHA }),
      manifest: { id: "genex", version: "1.3.2", publisher: "Genex" } as PluginManifest,
    };
    assert.deepEqual(f.marketplace.updates([community]), [], "a fork is not an official source");
  } finally {
    await f.clean();
  }
});
test("an index that breaks the policy never offers the entry for install", async () => {
  const f = await fixture();
  try {
    const digest = "d".repeat(64);
    f.routes.set(
      DEFAULT_INDEX_URL,
      json(
        indexFor([
          entryFor({ artifact: { url: `https://evil.example/example/1.0.0/${digest}.json`, sha256: digest } }),
          entryFor({ id: "genex", name: "Genex", publisher: "Mallory", tier: "official" }),
        ]),
      ),
    );
    const view = await f.marketplace.index(true);
    assert.deepEqual(view.entries, []);
    const refuse = async () => {
      throw new Error("installed");
    };
    await assert.rejects(
      f.marketplace.installIndex("example", { installLocal: refuse, installEnvelope: refuse }),
      /not in the marketplace index/,
    );
    assert.ok(
      !f.calls.some((url) => url.startsWith("https://evil.example")),
      "nothing was downloaded from the refused origin",
    );
  } finally {
    await f.clean();
  }
});

const API = `https://api.github.com/repos/${REPO}`;
const RELEASE_DATE = "2026-09-12T10:00:00Z";
const COMMIT_DATE = "2026-09-28T08:30:00Z";
const missing = () => new Response("{}", { status: 404 });
/** GitHub's answer for a commit a ref points at. */
const commitAt = (sha: string) => json({ sha, commit: { committer: { date: COMMIT_DATE } } });
/** A repository whose latest release is `tag`, at the example plugin's commit. */
function releasedRepo(routes: ReturnType<typeof network>["routes"], files: Map<string, Buffer>, subdir?: string) {
  routes.set(`${API}/releases/latest`, json({ tag_name: "v1.4.0", published_at: RELEASE_DATE }));
  routes.set(`${API}/commits/v1.4.0`, commitAt(SHA));
  mountRepo(routes, { files, subdir });
}

test("a pasted repository link installs its latest release, pinned to that release's exact commit", async () => {
  const f = await fixture();
  try {
    releasedRepo(f.routes, await exampleFiles());
    const found = await f.marketplace.lookupGithub(`https://github.com/${REPO}`);
    assert.deepEqual(found, {
      kind: "plugin",
      repo: REPO,
      sha: SHA,
      spec: `${REPO}@${SHA}`,
      version: { kind: "release", label: "v1.4.0", date: RELEASE_DATE },
      plugin: {
        id: "example",
        name: "Plugin SDK example",
        description: "Local SDK example: tool, skill, settings, isolated panel, a confirmed tool and a toolbar button.",
        publisher: "Studio development",
        version: "1.0.0",
      },
    });
    const staged = await f.marketplace.stageGithub(found.kind === "plugin" ? found.spec : "");
    assert.deepEqual(staged.origin, { kind: "github", repo: REPO, sha: SHA });
    await rm(staged.stage, { recursive: true, force: true });
  } finally {
    await f.clean();
  }
});

test("a repository without releases installs the newest code on its default branch, and says so", async () => {
  const f = await fixture();
  try {
    f.routes.set(`${API}/releases/latest`, missing);
    f.routes.set(API, json({ default_branch: "trunk" }));
    f.routes.set(`${API}/commits/trunk`, commitAt(SHA));
    mountRepo(f.routes, { files: await exampleFiles() });
    const found = await f.marketplace.lookupGithub(`${REPO}`);
    assert.equal(found.kind, "plugin");
    assert.deepEqual(found.kind === "plugin" && found.version, { kind: "branch", label: "trunk", date: COMMIT_DATE });
    assert.equal(found.kind === "plugin" && found.spec, `${REPO}@${SHA}`);
  } finally {
    await f.clean();
  }
});

test("a folder link pins its branch and installs only that folder", async () => {
  const f = await fixture();
  try {
    f.routes.set(`${API}/commits/main`, commitAt(SHA));
    mountRepo(f.routes, { files: await exampleFiles(), subdir: "plugins/example" });
    const found = await f.marketplace.lookupGithub(`https://github.com/${REPO}/tree/main/plugins/example`);
    assert.equal(found.kind, "plugin");
    if (found.kind !== "plugin") return;
    assert.equal(found.spec, `${REPO}/plugins/example@${SHA}`);
    assert.equal(found.subdir, "plugins/example");
    assert.deepEqual(found.version, { kind: "ref", label: "main", date: COMMIT_DATE });
    assert.ok(!f.calls.some((u) => u.includes("/releases/")), "a named branch needs no release lookup");
  } finally {
    await f.clean();
  }
});

test("a commit link needs no version lookup; a repository with its one plugin in a folder finds it", async () => {
  const f = await fixture();
  try {
    mountRepo(f.routes, { files: await exampleFiles(), subdir: "plugin" });
    const found = await f.marketplace.lookupGithub(`https://github.com/${REPO}/commit/${SHA}`);
    assert.equal(found.kind, "plugin");
    assert.equal(found.kind === "plugin" && found.spec, `${REPO}/plugin@${SHA}`);
    assert.deepEqual(found.kind === "plugin" && found.version, { kind: "commit", label: SHA.slice(0, 7) });
    assert.deepEqual(
      f.calls.filter((u) => u.startsWith("https://api.github.com")),
      [`${API}/git/trees/${SHA}?recursive=1`],
    );
  } finally {
    await f.clean();
  }
});

test("a repository with several plugins lists them to choose from, each pinned to the same commit", async () => {
  const f = await fixture();
  try {
    const files = await exampleFiles();
    releasedRepo(f.routes, files, "plugins/one");
    const tree = `${API}/git/trees/${SHA}?recursive=1`;
    const one = JSON.parse(await (await f.routes.get(tree)!()).text());
    const second = Buffer.from(
      JSON.stringify({ ...JSON.parse(files.get("plugin.json")!.toString()), id: "second", name: "Second" }),
    );
    one.tree.push({ path: "plugins/two/plugin.json", mode: "100644", type: "blob", sha: blobSha(second), size: 1 });
    f.routes.set(tree, json(one));
    f.routes.set(`https://raw.githubusercontent.com/${REPO}/${SHA}/plugins/two/plugin.json`, () => body(second));
    const found = await f.marketplace.lookupGithub(`https://github.com/${REPO}`);
    assert.equal(found.kind, "choose");
    if (found.kind !== "choose") return;
    assert.deepEqual(found.version, { kind: "release", label: "v1.4.0", date: RELEASE_DATE });
    assert.deepEqual(
      found.plugins.map((p) => [p.plugin.name, p.spec]),
      [
        ["Plugin SDK example", `${REPO}/plugins/one@${SHA}`],
        ["Second", `${REPO}/plugins/two@${SHA}`],
      ],
    );
  } finally {
    await f.clean();
  }
});

test("a link that leads to no plugin says why, in a code the page words itself", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.marketplace.lookupGithub("https://gitlab.com/acme/tools"), {
      kind: "problem",
      problem: "not-a-link",
    });
    assert.equal(f.calls.length, 0, "a link that is not GitHub's is never fetched");

    f.routes.set(`${API}/releases/latest`, missing);
    f.routes.set(API, missing);
    assert.deepEqual(await f.marketplace.lookupGithub(REPO), { kind: "problem", problem: "not-found" });

    f.routes.set(`${API}/commits/nope`, () => new Response("{}", { status: 422 }));
    assert.deepEqual(await f.marketplace.lookupGithub(`https://github.com/${REPO}/tree/nope`), {
      kind: "problem",
      problem: "not-found",
    });

    const files = await exampleFiles();
    const bare = new Map(files);
    bare.delete("plugin.json");
    releasedRepo(f.routes, bare);
    assert.deepEqual(await f.marketplace.lookupGithub(REPO), { kind: "problem", problem: "no-plugin" });

    const broken = new Map(files);
    broken.set("plugin.json", Buffer.from(JSON.stringify({ id: "Not An Id" })));
    releasedRepo(f.routes, broken);
    const invalid = await f.marketplace.lookupGithub(REPO);
    assert.equal(invalid.kind === "problem" && invalid.problem, "invalid-plugin");
    assert.ok(invalid.kind === "problem" && invalid.detail, "an invalid manifest says what is wrong");

    f.routes.set(
      `${API}/releases/latest`,
      () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    assert.deepEqual(await f.marketplace.lookupGithub(REPO), { kind: "problem", problem: "rate-limited" });
    f.routes.set(`${API}/releases/latest`, () => new Response("{}", { status: 429 }));
    assert.deepEqual(await f.marketplace.lookupGithub(REPO), { kind: "problem", problem: "rate-limited" });

    assert.ok(
      f.calls.every(
        (u) => u.startsWith("https://api.github.com/") || u.startsWith("https://raw.githubusercontent.com/"),
      ),
      "a lookup reaches GitHub and nothing else",
    );
  } finally {
    await f.clean();
  }
});

test("a manifest that does not match the tree's object id is refused before it is shown", async () => {
  const f = await fixture();
  try {
    releasedRepo(f.routes, await exampleFiles());
    f.routes.set(`https://raw.githubusercontent.com/${REPO}/${SHA}/plugin.json`, () => body(Buffer.from("{}")));
    await assert.rejects(f.marketplace.lookupGithub(REPO), /Integrity check failed for plugin\.json/);
  } finally {
    await f.clean();
  }
});

test("an offline profile looks nothing up", async () => {
  const f = await fixture({ offline: true });
  try {
    await assert.rejects(f.marketplace.lookupGithub(REPO), /offline/i);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.clean();
  }
});

test("another version of a looked-up plugin: its recent releases and default branch, then that version pinned", async () => {
  const f = await fixture();
  try {
    f.routes.set(
      `${API}/releases?per_page=10`,
      json([
        { tag_name: "v1.4.0", published_at: RELEASE_DATE, draft: false },
        { tag_name: "v1.5.0-rc", published_at: RELEASE_DATE, draft: true },
        { tag_name: "v1.3.0", published_at: "2026-08-01T00:00:00Z", draft: false },
      ]),
    );
    f.routes.set(API, json({ default_branch: "main" }));
    assert.deepEqual(await f.marketplace.githubVersions(REPO), [
      { kind: "release", label: "v1.4.0", date: RELEASE_DATE },
      { kind: "release", label: "v1.3.0", date: "2026-08-01T00:00:00Z" },
      { kind: "branch", label: "main" },
    ]);
    const older = "b".repeat(40);
    f.routes.set(`${API}/commits/v1.3.0`, commitAt(older));
    mountRepo(f.routes, { files: await exampleFiles(), sha: older });
    const found = await f.marketplace.lookupGithub(REPO, {
      kind: "release",
      label: "v1.3.0",
      date: "2026-08-01T00:00:00Z",
    });
    assert.equal(found.kind === "plugin" && found.spec, `${REPO}@${older}`);
    assert.deepEqual(found.kind === "plugin" && found.version, {
      kind: "release",
      label: "v1.3.0",
      date: "2026-08-01T00:00:00Z",
    });
    await assert.rejects(f.marketplace.githubVersions("../etc"), /Invalid repository/);
  } finally {
    await f.clean();
  }
});

test("a GitHub install fetches the package, not the repository around it: no dotfiles or authoring files", async () => {
  const f = await fixture();
  try {
    const files = await exampleFiles();
    files.set(".github/workflows/ci.yml", Buffer.from("on: push\n"));
    files.set(".gitignore", Buffer.from("node_modules\n"));
    files.set("AGENTS.md", Buffer.from("Notes for a coding agent.\n"));
    mountRepo(f.routes, { files });
    const staged = await f.marketplace.stageGithub(`${REPO}@${SHA}`);
    try {
      assert.deepEqual((await readdir(staged.stage)).sort(), [...FILES].sort());
      assert.equal(staged.scan.verdict, "safe", JSON.stringify(staged.scan.findings));
      const fetched = f.calls.filter((url) => url.startsWith("https://raw.githubusercontent.com/"));
      assert.equal(fetched.length, FILES.length, "files outside the package are never downloaded");
    } finally {
      await rm(staged.stage, { recursive: true, force: true });
    }
  } finally {
    await f.clean();
  }
});

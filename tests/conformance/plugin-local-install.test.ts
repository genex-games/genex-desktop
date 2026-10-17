import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  asksBeforeInstall,
  installLocalPlugin,
  pluginOriginWords,
  reviewPluginInstall,
} from "../../src/main/plugin-local-install.ts";
import type { PluginManifest, PluginSource } from "../../src/shared/plugins.ts";
import { accountFixture, accountPackage, copyOfExample, installLocalOn, pluginFixture } from "../helpers/plugins.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-local-review-"));
  const source = path.join(root, "author"),
    seeds = path.join(root, "seeds");
  await cp(path.resolve("src/plugins/example"), source, { recursive: true });
  await mkdir(seeds);
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async () => null,
  );
  await registry.init();
  t.after(async () => {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  });
  const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
  const save = () => writeFile(path.join(source, "plugin.json"), JSON.stringify(manifest));
  return { root, source, registry, manifest, save };
}

test("local reinstall reviews the current manifest and scan, can be cancelled, and installs only reviewed bytes", async (t) => {
  const f = await fixture(t);
  await installLocalPlugin(f.registry, f.source, async () => true);
  // Loaded from a folder, it starts off: the person turns it on.
  await f.registry.setEnabled("example", true);
  await f.registry.setSetting("example", "greeting", "Saved greeting");
  await f.registry.remove("example");
  f.manifest.version = "2.0.0";
  f.manifest.capabilities.push("export");
  await f.save();
  const backend = path.join(f.source, "backend.mjs");
  const reviewed = (await readFile(backend, "utf8")) + "\n// https://new-provider.example.test\n";
  await writeFile(backend, reviewed);
  let reviews = 0;
  const review = async (approve: boolean) =>
    installLocalPlugin(
      f.registry,
      f.source,
      async (manifest, origin, scan, previous) => {
        reviews++;
        assert.equal(manifest.version, "2.0.0");
        assert.ok(manifest.capabilities.includes("export"));
        assert.equal(previous?.version, "1.0.0");
        assert.deepEqual(origin, { kind: "local", directory: f.source });
        assert.equal(scan.verdict, "caution");
        assert.ok(scan.findings.some((finding) => finding.rule === "host-undeclared"));
        if (approve) await writeFile(backend, 'throw new Error("unreviewed edit while dialog is open")');
        return approve;
      },
      "example",
    );
  await review(false);
  assert.equal(f.registry.list()[0]!.removed, true);
  await review(true);
  assert.equal(reviews, 2);
  const installed = f.registry.list()[0]!;
  assert.equal(installed.manifest.version, "2.0.0");
  assert.equal(installed.enabled, false, "loaded again after removal, it starts off");
  assert.equal(installed.scan?.verdict, "caution");
  await f.registry.setEnabled("example", true);
  assert.equal((await f.registry.settings("example")).greeting, "Saved greeting");
  assert.deepEqual(await f.registry.action("example", "hello", {}), {
    text: "The isolated plugin backend is working.",
  });
  assert.deepEqual(await readdir(path.join(f.registry.root, "staging")), []);
});

test("local reinstall refuses a changed identity and links before asking for trust", async (t) => {
  const f = await fixture(t);
  await installLocalPlugin(f.registry, f.source, async () => true);
  await f.registry.remove("example");
  let asked = false;
  const confirm = async () => {
    asked = true;
    return true;
  };
  f.manifest.id = "different-plugin";
  await f.save();
  await assert.rejects(installLocalPlugin(f.registry, f.source, confirm, "example"), /different plugin/);
  assert.equal(asked, false);
  assert.equal(f.registry.list()[0]!.removed, true);
  f.manifest.id = "example";
  await f.save();
  await symlink(f.root, path.join(f.source, "escape"));
  await assert.rejects(installLocalPlugin(f.registry, f.source, confirm, "example"), /links/);
  assert.equal(asked, false);
  assert.deepEqual(await readdir(path.join(f.registry.root, "staging")), []);
});

test("local update preserves disabled state and cleans the staged review on confirmation failure", async (t) => {
  const f = await fixture(t);
  await installLocalPlugin(f.registry, f.source, async () => true);
  await f.registry.setEnabled("example", false);
  f.manifest.version = "1.1.0";
  await f.save();
  await assert.rejects(
    installLocalPlugin(f.registry, f.source, async () => {
      throw new Error("dialog unavailable");
    }),
    /dialog unavailable/,
  );
  assert.equal(f.registry.list()[0]!.manifest.version, "1.0.0");
  await installLocalPlugin(f.registry, f.source, async () => true);
  assert.equal(f.registry.list()[0]!.manifest.version, "1.1.0");
  assert.equal(f.registry.enabled("example"), false);
  assert.deepEqual(await readdir(path.join(f.registry.root, "staging")), []);
});

const GITHUB: PluginSource = { kind: "github", repo: "someone/acct", sha: "b".repeat(40) };
/** The trust dialog's facts, before it is shown: what the install replaces, and what it must refuse outright. */
test("the install review names a replacement, refuses a connector id and never calls a typed GitHub spec cataloged", async () => {
  const f = await accountFixture();
  try {
    const a = await accountPackage(f.base, "a", "Publisher A"),
      b = await accountPackage(f.base, "b", "Publisher B");
    const localA: PluginSource = { kind: "local", directory: a.dir };
    assert.deepEqual(reviewPluginInstall(f.registry, a.manifest, localA, []), {});
    await installLocalOn(f.registry, a.dir, a.manifest.capabilities);
    assert.deepEqual(
      reviewPluginInstall(f.registry, a.manifest, localA, []),
      {},
      "an update from the same publisher and source is not a replacement",
    );
    const review = reviewPluginInstall(f.registry, b.manifest, GITHUB, []);
    assert.equal(review.replaces?.publisher, "Publisher A");
    assert.equal(review.replaces?.name, "Account a");
    assert.deepEqual(review.replaces?.origin, localA);
    // A connector already answers for `<id>__*`: a plugin under that id would have its calls routed there.
    const other = await copyOfExample(f.base, "figma", (m) => {
      m.id = "figma";
    });
    const figma = JSON.parse(await readFile(path.join(other, "plugin.json"), "utf8")) as PluginManifest;
    assert.throws(
      () => reviewPluginInstall(f.registry, figma, { kind: "local", directory: other }, ["figma"]),
      /connector/,
    );
    const bundled = await pluginFixture();
    try {
      assert.throws(
        () => reviewPluginInstall(bundled.registry, { ...figma, id: "example" }, GITHUB, []),
        /ships with Studio/,
      );
    } finally {
      await bundled.close();
    }
    assert.match(pluginOriginWords(GITHUB), /someone\/acct@bbbbbbbbbbbb \(not in the catalog\)/);
    assert.doesNotMatch(pluginOriginWords(GITHUB), /cataloged/);
    assert.match(pluginOriginWords({ ...GITHUB, kind: "index" }), /cataloged, not audited/);
  } finally {
    await f.close();
  }
});

test("Studio's own plugin installs and updates without asking; code from anywhere else, or a seed that takes over another plugin, asks", async () => {
  const BUNDLED: PluginSource = { kind: "bundled" };
  const seeded = await pluginFixture();
  try {
    const seed = seeded.registry.bundledManifest("example");
    assert.ok(seed);
    const update = { ...seed, version: "9.0.0" };
    assert.equal(asksBeforeInstall(BUNDLED, reviewPluginInstall(seeded.registry, update, BUNDLED, [])), false);
  } finally {
    await seeded.close();
  }
  const elsewhere: PluginSource[] = [
    { kind: "local", directory: "/tmp/example" },
    GITHUB,
    { ...GITHUB, kind: "index" },
    { kind: "catalog", url: "https://plugins.example.invalid/a.zip", sha256: "c".repeat(64) },
  ];
  for (const origin of elsewhere) assert.equal(asksBeforeInstall(origin, {}), true, origin.kind);
  assert.equal(asksBeforeInstall(undefined, {}), true, "an unnamed origin is not taken for Studio's own");
  // A local plugin took the id before Studio shipped a seed under it: the seed erases its account and data.
  const local = await pluginFixture({ installed: "local" });
  try {
    const manifest = local.registry.list()[0]?.manifest;
    assert.ok(manifest);
    const review = reviewPluginInstall(local.registry, { ...manifest, publisher: "Genex" }, BUNDLED, []);
    assert.ok(review.replaces);
    assert.equal(asksBeforeInstall(BUNDLED, review), true);
  } finally {
    await local.close();
  }
});

test("a local install copies the package, not the author's checkout: no .git, dotfiles or authoring files", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, ".git"));
  await writeFile(path.join(f.source, ".git", "config"), "[core]\n");
  await writeFile(path.join(f.source, ".env"), "TOKEN=1\n");
  await writeFile(path.join(f.source, "AGENTS.md"), "Notes for a coding agent.\n");
  await installLocalPlugin(f.registry, f.source, async (_manifest, _origin, scan) => {
    assert.equal(scan.verdict, "safe", JSON.stringify(scan.findings));
    return true;
  });
  const versions = path.join(f.root, "installed", "packages", "example");
  const [installed] = await readdir(versions);
  assert.ok(installed, "the package was installed");
  const files = await readdir(path.join(versions, installed));
  assert.deepEqual(
    files.filter((name) => name.startsWith(".") || name === "AGENTS.md"),
    [],
  );
  assert.ok(files.includes("plugin.json"));
});

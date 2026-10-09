import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { checkCatalog } from "../../marketplace/template/scripts/check-catalog.mjs";
import { stageArtifact } from "../../marketplace/template/scripts/stage-artifact.mjs";

async function fixture(tier = "community") {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-release-"));
  const pkg = path.join(root, "package");
  await cp("src/plugins/example", pkg, { recursive: true });
  const config = path.join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      artifactBaseUrl: "https://plugins.example.invalid/releases",
      packages: [{ directory: pkg, category: "tools", tier, repo: "acme/plugins", sha: "a".repeat(40) }],
    }),
  );
  const output = path.join(root, "output");
  execFileSync(process.execPath, ["scripts/prepare-plugin-catalog.mjs", config, output], { stdio: "pipe" });
  const catalog = path.join(output, "catalog"),
    uploads = path.join(output, "uploads");
  const index = JSON.parse(await readFile(path.join(catalog, "index.json"), "utf8"));
  const entry = index.plugins[0];
  const previous = path.join(root, "previous");
  await cp(catalog, previous, { recursive: true });
  async function save() {
    await writeFile(path.join(catalog, "index.json"), JSON.stringify(index));
    await mkdir(path.join(catalog, "records", entry.id), { recursive: true });
    await writeFile(path.join(catalog, "records", entry.id, `${entry.version}.json`), JSON.stringify(entry));
  }
  const check = (artifacts: string | undefined = undefined) =>
    checkCatalog({ root: catalog, previous, policyRoot: previous, artifacts, remote: false });
  return {
    root,
    catalog,
    uploads,
    index,
    entry,
    previous,
    save,
    check,
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
test("portable catalog preparation validates actual packages without executing backend code", async () => {
  const f = await fixture();
  try {
    const report = await f.check(f.uploads);
    assert.equal(report.entries, 1);
    assert.equal(report.artifactsVerified.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(f.root, "output/preparation.json"), "utf8")).published, false);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["scripts/prepare-plugin-catalog.mjs", path.join(f.root, "config.json"), path.join(f.root, "output")],
          { stdio: "pipe" },
        ),
      /EEXIST/,
    );
    assert.equal((await f.check(f.uploads)).entries, 1, "existing preparation preserved");
  } finally {
    await f.clean();
  }
});
test("release gate refuses repacks, removed history, ownership takeover and rollback", async () => {
  for (const scenario of ["repack", "remove", "publisher", "repo", "downgrade"]) {
    const f = await fixture();
    try {
      if (scenario === "remove") await rm(path.join(f.catalog, "records", f.entry.id, `${f.entry.version}.json`));
      else if (scenario === "repack") {
        f.entry.sha = "b".repeat(40);
        await f.save();
      } else {
        f.entry.version = scenario === "downgrade" ? "0.0.1" : "2.0.0";
        if (scenario === "publisher") f.entry.publisher = "Other";
        if (scenario === "repo") f.entry.repo = "other/plugins";
        f.entry.artifact.url = `https://plugins.example.invalid/releases/${f.entry.id}/${f.entry.version}/${f.entry.artifact.sha256}.json`;
        await f.save();
      }
      await assert.rejects(f.check(), /record|ownership|higher version/i, scenario);
    } finally {
      await f.clean();
    }
  }
});
test("release gate pins artifact bytes and rejects traversal without executing files", async () => {
  const f = await fixture();
  try {
    const artifact = path.join(f.uploads, f.entry.id, f.entry.version, `${f.entry.artifact.sha256}.json`);
    await writeFile(artifact, "tampered");
    await assert.rejects(f.check(f.uploads), /digest/);
    const envelope = Buffer.from(
      JSON.stringify({
        "plugin.json": Buffer.from("{}").toString("base64"),
        "../escape": Buffer.from("x").toString("base64"),
      }),
    );
    const digest = createHash("sha256").update(envelope).digest("hex");
    f.entry.artifact.sha256 = digest;
    f.entry.artifact.url = `https://plugins.example.invalid/releases/${f.entry.id}/${f.entry.version}/${digest}.json`;
    await f.save();
    await writeFile(path.join(path.dirname(artifact), `${digest}.json`), envelope);
    await assert.rejects(checkCatalog({ root: f.catalog, artifacts: f.uploads }), /Unsafe package path/);
  } finally {
    await f.clean();
  }
});
test("base policy cannot be expanded by a candidate and official IDs are reserved", async () => {
  const f = await fixture();
  try {
    f.entry.artifact.url = f.entry.artifact.url.replace("plugins.example.invalid", "attacker.invalid");
    await f.save();
    await assert.rejects(f.check(), /Unapproved artifact origin/);
    f.entry.artifact.url = f.entry.artifact.url.replace("attacker.invalid", "plugins.example.invalid");
    f.entry.tier = "official";
    await f.save();
    await assert.rejects(f.check(), /Official identity not approved/);
  } finally {
    await f.clean();
  }
});
test("an official package's policy names its repositories, current first, and passes the catalog's own tests", async () => {
  const f = await fixture("official");
  try {
    const policy = JSON.parse(await readFile(path.join(f.catalog, "policy.json"), "utf8"));
    assert.deepEqual(policy.official, { [f.entry.id]: { publisher: f.entry.publisher, repos: ["acme/plugins"] } });
    assert.equal((await f.check(f.uploads)).entries, 1);
    // The prepared repository carries its validator's tests; they include "this catalog passes".
    execFileSync(process.execPath, ["--test", "scripts/check-catalog.test.mjs"], { cwd: f.catalog, stdio: "pipe" });
  } finally {
    await f.clean();
  }
});

/** A catalog host for `checkCatalog({ remote })`: the bytes it serves by URL, and a 404 for anything else. */
function host(served: Map<string, Buffer>, status: (url: string) => number | undefined = () => undefined) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    const code = status(url);
    if (code) return new Response("", { status: code });
    const bytes = served.get(url);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("missing", { status: 404 });
  };
}

test("a new release whose artifact is not uploaded yet is pending only when asked, and never an old one", async () => {
  const f = await fixture();
  try {
    const released = await readFile(
      path.join(f.uploads, f.entry.id, f.entry.version, `${f.entry.artifact.sha256}.json`),
    );
    const served = new Map([[f.entry.artifact.url, released]]);
    const old = { ...f.entry, artifact: { ...f.entry.artifact } };
    f.entry.version = "2.0.0";
    f.entry.artifact.url = `https://plugins.example.invalid/releases/${f.entry.id}/2.0.0/${f.entry.artifact.sha256}.json`;
    await f.save();
    const remote = (fetch: ReturnType<typeof host>, allowPendingNew: boolean) =>
      checkCatalog({
        root: f.catalog,
        previous: f.previous,
        policyRoot: f.previous,
        remote: true,
        allowPendingNew,
        fetch,
      });

    const report = await remote(host(served), true);
    assert.deepEqual(report.pending, [{ id: f.entry.id, version: "2.0.0", url: f.entry.artifact.url }]);
    assert.deepEqual(
      report.artifactsVerified.map((a: { version: string }) => a.version),
      [old.version],
      "the released artifact is still downloaded and checked",
    );
    await assert.rejects(remote(host(served), false), /Artifact HTTP 404/, "strict by default");
    await assert.rejects(remote(host(new Map()), true), /Artifact HTTP 404/, "a released artifact never goes pending");
    await assert.rejects(
      remote(
        host(served, (url) => (url === f.entry.artifact.url ? 500 : undefined)),
        true,
      ),
      /Artifact HTTP 500/,
      "only a missing object is pending; a failing host is not",
    );
    await assert.rejects(
      checkCatalog({ root: f.catalog, remote: true, allowPendingNew: true, fetch: host(served) }),
      /Artifact HTTP 404/,
      "without a previous catalog nothing is new, so nothing can be pending",
    );
  } finally {
    await f.clean();
  }
});

test("stage-artifact copies a contributor's release asset into uploads only when its bytes match the record", async () => {
  const f = await fixture();
  try {
    const bytes = await readFile(path.join(f.uploads, f.entry.id, f.entry.version, `${f.entry.artifact.sha256}.json`));
    const record = `records/${f.entry.id}/${f.entry.version}.json`;
    const from = "https://github.com/acme/plugins/releases/download/v1.0.0/example-1.0.0.json";
    const asset = "https://release-assets.githubusercontent.com/acme/example-1.0.0.json";
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    const github = async (input: string | URL | Request) => {
      const url = String(input);
      if (url === from) return redirect(asset);
      return url === asset ? new Response(new Uint8Array(bytes)) : new Response("", { status: 404 });
    };
    const stage = (out: string, extra: Record<string, unknown> = {}) =>
      stageArtifact({ root: f.catalog, record, from, out: path.join(f.root, out), fetch: github, ...extra });

    const staged = await stage("staged");
    const key = `releases/${f.entry.id}/${f.entry.version}/${f.entry.artifact.sha256}.json`;
    assert.equal(staged.key, key);
    assert.equal(
      staged.file,
      path.join(f.root, "staged", f.entry.id, f.entry.version, `${f.entry.artifact.sha256}.json`),
    );
    assert.deepEqual(await readFile(staged.file), bytes);
    assert.equal(staged.sha256, f.entry.artifact.sha256);

    const refused: Array<[string, Record<string, unknown>, RegExp]> = [
      ["tampered", { fetch: async () => new Response("tampered") }, /digest/],
      ["plain http", { from: from.replace("https:", "http:") }, /HTTPS/],
      ["downgrade", { fetch: async () => redirect("http://example.invalid/x.json") }, /HTTPS/],
      ["loop", { fetch: async () => redirect(from) }, /redirect/i],
      ["oversized", { maxBytes: 16 }, /too large/i],
      ["outside records", { record: "../policy.json" }, /record/i],
      ["not a record", { record: "index.json" }, /record/i],
    ];
    for (const [name, extra, error] of refused) {
      await assert.rejects(stage(name, extra), error, name);
      assert.equal(existsSync(path.join(f.root, name)), false, `${name} writes nothing`);
    }
  } finally {
    await f.clean();
  }
});

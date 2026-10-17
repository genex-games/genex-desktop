/**
 * scripts/check-plugin-versions.ts: a bundled plugin whose files changed against a base ref must
 * carry a higher version in its plugin.json than it had there. A new plugin passes, a removed one
 * is not checked, uncommitted and untracked edits count, and no base means a skip line. Hostile
 * refs, manifests and folders are refused with a line and leave the repository as it was.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkPluginVersions } from "../../scripts/check-plugin-versions.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

const git = async (cwd: string, ...args: string[]) => (await gitFile(args, { cwd })).stdout.toString().trim();

/** Write a plugin folder under src/plugins with the given manifest (an object, or raw text). */
function writePlugin(root: string, id: string, manifest: unknown, extra: Record<string, string> = {}) {
  const dir = path.join(root, "src", "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  const text = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(dir, "plugin.json"), text);
  for (const [file, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), body);
}

const manifest = (version: unknown) => ({ id: "x", name: "X", version });

/** A repo whose first commit holds the given plugins at 1.0.0; returns its folder and that commit. */
async function repoWith(ids: string[] = ["alpha"]) {
  const root = await tmpDir("plugin-versions-");
  await git(root, "init", "-q", "-b", "work");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "README.md"), "repo\n");
  for (const id of ids) writePlugin(root, id, manifest("1.0.0"), { "backend.js": "export default {};\n" });
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base");
  return { root, base: await git(root, "rev-parse", "HEAD") };
}

async function commitAll(root: string) {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "change");
}

const refusals = (report: { ok: boolean; lines: string[] }) => (report.ok ? [] : report.lines);

describe("check-plugin-versions: the rule", () => {
  it("a changed plugin with the same version is refused, naming it and both versions", async () => {
    const { root, base } = await repoWith(["alpha", "beta"]);
    fs.writeFileSync(path.join(root, "src/plugins/alpha/backend.js"), "export default { changed: true };\n");
    await commitAll(root);
    const report = checkPluginVersions(root, { base });
    assert.equal(report.ok, false);
    const refused = report.lines.filter((line) => line.includes("alpha"));
    assert.equal(refused.length, 1, report.lines.join("\n"));
    assert.match(refused[0], /1\.0\.0.*1\.0\.0/);
    assert.ok(!report.lines.some((line) => line.includes("beta") && /not above|refused/.test(line)));
  });

  it("a changed plugin with a higher version passes; a lower one is refused", async () => {
    const { root, base } = await repoWith(["alpha", "beta"]);
    writePlugin(root, "alpha", manifest("1.1.0"));
    writePlugin(root, "beta", manifest("0.9.9"));
    await commitAll(root);
    const report = checkPluginVersions(root, { base });
    assert.equal(report.ok, false);
    assert.ok(report.lines.some((line) => line.includes("beta") && line.includes("0.9.9")));
    assert.ok(!report.lines.some((line) => line.includes("alpha") && line.includes("not above")));
    writePlugin(root, "beta", manifest("2.0.0"));
    assert.deepEqual(refusals(checkPluginVersions(root, { base })), []);
  });

  it("compares each part as a number, not as text", async () => {
    const { root, base } = await repoWith();
    writePlugin(root, "alpha", manifest("1.0.10"));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "to 1.0.10");
    const mid = await git(root, "rev-parse", "HEAD");
    writePlugin(root, "alpha", manifest("1.0.9"));
    assert.equal(checkPluginVersions(root, { base: mid }).ok, false);
    writePlugin(root, "alpha", manifest("1.0.11"));
    assert.equal(checkPluginVersions(root, { base }).ok, true);
  });

  it("an unchanged plugin passes; a new plugin passes; a removed plugin is not checked", async () => {
    const { root, base } = await repoWith(["alpha", "beta", "gamma"]);
    writePlugin(root, "delta", manifest("0.1.0"));
    fs.rmSync(path.join(root, "src/plugins/gamma"), { recursive: true });
    await commitAll(root);
    const report = checkPluginVersions(root, { base });
    assert.equal(report.ok, true, report.lines.join("\n"));
  });

  it("uncommitted and untracked changes count", async () => {
    const { root, base } = await repoWith(["alpha", "beta"]);
    fs.writeFileSync(path.join(root, "src/plugins/alpha/backend.js"), "export default { edited: 1 };\n");
    fs.writeFileSync(path.join(root, "src/plugins/beta/new-file.md"), "untracked\n");
    const both = checkPluginVersions(root, { base });
    assert.equal(both.ok, false);
    assert.ok(both.lines.some((line) => line.includes("alpha")));
    assert.ok(both.lines.some((line) => line.includes("beta")));
    await git(root, "add", "src/plugins/alpha/backend.js");
    const staged = checkPluginVersions(root, { base });
    assert.ok(staged.lines.some((line) => line.includes("alpha") && line.includes("not above")));
  });

  it("with no base it says so and passes", async () => {
    const { root } = await repoWith();
    fs.writeFileSync(path.join(root, "src/plugins/alpha/backend.js"), "export default { edited: 1 };\n");
    const report = checkPluginVersions(root);
    assert.equal(report.ok, true);
    assert.match(report.lines.join("\n"), /no base/i);
  });

  it("without --base it measures from where the branch left origin/dev", async () => {
    const { root, base } = await repoWith();
    await git(root, "update-ref", "refs/remotes/origin/dev", base);
    fs.writeFileSync(path.join(root, "src/plugins/alpha/backend.js"), "export default { edited: 1 };\n");
    await commitAll(root);
    const report = checkPluginVersions(root);
    assert.equal(report.ok, false);
    assert.ok(report.lines.some((line) => line.includes("alpha") && line.includes("not above")));
  });

  it("a plugin id with a space or with non-ASCII letters is read and named as it is", async () => {
    const { root, base } = await repoWith(["my plugin", "plügin"]);
    fs.writeFileSync(path.join(root, "src/plugins/my plugin/backend.js"), "export default { edited: 1 };\n");
    fs.writeFileSync(path.join(root, "src/plugins/plügin/backend.js"), "export default { edited: 1 };\n");
    const report = checkPluginVersions(root, { base });
    assert.equal(report.ok, false);
    assert.ok(report.lines.some((line) => line.includes("src/plugins/my plugin")));
    assert.ok(report.lines.some((line) => line.includes("src/plugins/plügin")));
    writePlugin(root, "my plugin", manifest("1.0.1"));
    writePlugin(root, "plügin", manifest("1.0.1"));
    assert.equal(checkPluginVersions(root, { base }).ok, true);
  });
});

/** What a hostile run may not change: the repo's status, its object count, and files beside it. */
async function snapshot(root: string) {
  return {
    status: await git(root, "status", "--porcelain", "--untracked-files=all"),
    objects: await git(root, "count-objects", "-v"),
    beside: fs.readdirSync(path.dirname(root)).filter((name) => name.startsWith("pwned")),
    cwd: fs.readdirSync(process.cwd()).filter((name) => name.startsWith("pwned")),
  };
}

describe("check-plugin-versions: hostile inputs", () => {
  const HOSTILE_REFS = [
    { name: "an option disguised as a ref", ref: (out: string) => `--output=${out}` },
    { name: "a config override", ref: () => "-c core.pager=evil" },
    { name: "a shell sequence", ref: () => "HEAD;rm -rf ." },
    { name: "a command substitution", ref: (out: string) => `$(touch ${out})` },
    { name: "an empty ref", ref: () => "" },
    { name: "a ref with a NUL", ref: () => "HEAD\0--output=x" },
  ];
  for (const row of HOSTILE_REFS)
    it(`refuses ${row.name} as the base and changes nothing`, async () => {
      const { root } = await repoWith();
      fs.writeFileSync(path.join(root, "src/plugins/alpha/backend.js"), "export default { edited: 1 };\n");
      const out = path.join(root, "pwned-output");
      const before = await snapshot(root);
      const report = checkPluginVersions(root, { base: row.ref(out) });
      assert.equal(report.ok, false);
      assert.match(report.lines.join("\n"), /base/i);
      assert.equal(fs.existsSync(out), false);
      assert.equal(fs.existsSync(path.join(root, "pwned")), false);
      assert.deepEqual(await snapshot(root), before);
    });

  it("refuses a base that names a blob, not a commit", async () => {
    const { root } = await repoWith();
    const blob = await git(root, "rev-parse", "HEAD:README.md");
    const before = await snapshot(root);
    const report = checkPluginVersions(root, { base: blob });
    assert.equal(report.ok, false);
    assert.match(report.lines.join("\n"), /not a commit/);
    assert.deepEqual(await snapshot(root), before);
  });

  const HOSTILE_MANIFESTS: Array<{ name: string; write: (root: string) => void; says: RegExp }> = [
    {
      name: "a missing plugin.json",
      write: (root) => fs.rmSync(path.join(root, "src/plugins/alpha/plugin.json")),
      says: /plugin\.json is missing/,
    },
    { name: "invalid JSON", write: (root) => writePlugin(root, "alpha", "{ not json"), says: /not valid JSON/ },
    { name: "a missing version", write: (root) => writePlugin(root, "alpha", { id: "alpha" }), says: /no version/ },
    { name: "a numeric version", write: (root) => writePlugin(root, "alpha", manifest(2)), says: /no version/ },
    {
      name: "a two-part version",
      write: (root) => writePlugin(root, "alpha", manifest("1.2")),
      says: /MAJOR\.MINOR\.PATCH/,
    },
    {
      name: "a prerelease version",
      write: (root) => writePlugin(root, "alpha", manifest("1.2.3-beta")),
      says: /prerelease/,
    },
    {
      name: "a 10 kB version",
      write: (root) => writePlugin(root, "alpha", manifest("9".repeat(10_000))),
      says: /too long/,
    },
    {
      name: "a manifest that is an array",
      write: (root) => writePlugin(root, "alpha", "[1, 2]"),
      says: /no version/,
    },
  ];
  for (const row of HOSTILE_MANIFESTS)
    it(`refuses ${row.name} in a changed plugin, with a short line`, async () => {
      const { root, base } = await repoWith();
      row.write(root);
      const before = await snapshot(root);
      const report = checkPluginVersions(root, { base });
      assert.equal(report.ok, false);
      const text = report.lines.join("\n");
      assert.match(text, row.says);
      assert.match(text, /src\/plugins\/alpha/);
      assert.ok(text.length < 1_000, "a hostile value is never echoed in full");
      assert.deepEqual(await snapshot(root), before);
    });

  it("never reads a plugin folder through a link to outside the repo", async () => {
    const { root, base } = await repoWith();
    const outside = await tmpDir("plugin-versions-outside-");
    writePlugin(outside, "evil", manifest("9.9.9"));
    fs.symlinkSync(path.join(outside, "src/plugins/evil"), path.join(root, "src/plugins/linked"), "dir");
    const before = await snapshot(root);
    const report = checkPluginVersions(root, { base });
    assert.equal(report.ok, false);
    const text = report.lines.join("\n");
    assert.match(text, /src\/plugins\/linked.*link/);
    assert.ok(!text.includes("9.9.9"), "nothing behind the link was read");
    assert.deepEqual(await snapshot(root), before);
  });

  it("never reads a plugin.json that is a link", async () => {
    const { root, base } = await repoWith();
    const outside = await tmpDir("plugin-versions-outside-");
    fs.writeFileSync(path.join(outside, "plugin.json"), JSON.stringify(manifest("9.9.9")));
    fs.rmSync(path.join(root, "src/plugins/alpha/plugin.json"));
    fs.symlinkSync(path.join(outside, "plugin.json"), path.join(root, "src/plugins/alpha/plugin.json"));
    const report = checkPluginVersions(root, { base });
    assert.equal(report.ok, false);
    assert.ok(!report.lines.join("\n").includes("9.9.9"));
  });
});

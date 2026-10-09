/**
 * The developer kit is the scripts an author runs before Studio ever sees their package, so this
 * suite spawns them exactly as `npm run plugin:new` / `npm run plugin:doctor` do — real processes,
 * real exit codes, a temporary working directory — and checks the package they produce with the
 * same `inspectPackage` the installer uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { inspectPackage } from "../../src/substrate/plugins/manifest.ts";
import { isFileSkill, PLUGIN_GUIDE_URL } from "../../src/shared/plugins.ts";
import { packageBin } from "../../scripts/package-bin.ts";
import { STUDIO_CATALOG_POLICY } from "../../src/substrate/plugins/marketplace.ts";

const scaffold = path.resolve("scripts/plugin-new.ts");
const doctor = path.resolve("scripts/plugin-doctor.ts");
const pack = path.resolve("scripts/pack-plugin.ts");
const submit = path.resolve("scripts/plugin-submit.ts");
const unpack = path.resolve("scripts/plugin-unpack.ts");
const example = path.resolve("src/plugins/example");

const run = (script: string, args: string[], cwd: string) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-devkit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A writable copy of the example, so a test can break one file and doctor the rest. */
function copyExample(dir: string, name: string): string {
  const target = path.join(dir, name);
  fs.cpSync(example, target, { recursive: true });
  return target;
}

test("plugin:new scaffolds an installable package with the example substituted out of it", async (t) => {
  const dir = temp(t);
  const result = run(scaffold, ["my-plugin", "--out", dir], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plugin:doctor/, "the scaffold must print the next command");

  const target = path.join(dir, "my-plugin");
  const manifest = await inspectPackage(target);
  assert.equal(manifest.id, "my-plugin");
  assert.equal(manifest.name, "My plugin");
  assert.equal(manifest.apiVersion, 2);
  assert.equal(manifest.publisher, "Unpublished");
  assert.match(manifest.description, /My plugin/);

  // A scaffold that kept the example's tool names would teach every model the wrong ones.
  for (const skill of manifest.skills) {
    if (isFileSkill(skill)) continue;
    assert.ok(!skill.text.includes("example__"), `skill ${skill.name} still names example__ tools`);
    assert.match(skill.text, /my-plugin__greet/);
  }
  for (const file of fs.readdirSync(target)) {
    if (!fs.statSync(path.join(target, file)).isFile()) continue;
    assert.ok(
      !fs.readFileSync(path.join(target, file), "utf8").includes("example__"),
      `${file} still names example__ tools`,
    );
  }
  assert.deepEqual(fs.readdirSync(target).sort(), [
    "AGENTS.md",
    "backend.mjs",
    "jsconfig.json",
    "panel.html",
    "plugin-sdk",
    "plugin.json",
  ]);
  assert.ok(fs.readFileSync(path.join(target, "plugin-sdk/index.d.ts"), "utf8").includes("PluginNativeRuntime"));
  const check = spawnSync(
    process.execPath,
    [packageBin("typescript", "tsc"), "-p", path.join(target, "jsconfig.json")],
    { encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(manifest.toolbar?.[0]?.ariaLabel, "My plugin demo", "the aria-label must not collide with the example");
});

test("plugin:new refuses a reserved id, a malformed id and an occupied directory", (t) => {
  const dir = temp(t);
  const reserved = run(scaffold, ["example", "--out", dir], dir);
  assert.equal(reserved.status, 1);
  assert.match(reserved.stderr, /reserved/);

  const genex = run(scaffold, ["Genex", "--out", dir], dir);
  assert.equal(genex.status, 1);
  assert.match(genex.stderr, /Invalid plugin id/);
  assert.equal(run(scaffold, ["genex", "--out", dir], dir).status, 1);
  assert.equal(run(scaffold, ["blender", "--out", dir], dir).status, 1);

  assert.equal(run(scaffold, ["taken", "--out", dir], dir).status, 0);
  const again = run(scaffold, ["taken", "--out", dir], dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(run(scaffold, [], dir).status, 1, "no id at all is a usage error");
});

/** Run a panel's inline scripts against a bare stand-in for the sandboxed frame; returns its window. */
function loadPanel(html: string): Record<string, any> {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.ok(scripts.length > 0, "the panel has inline scripts");
  const element = () => ({ textContent: "", style: {}, append() {}, setAttribute() {} });
  const window: Record<string, any> = vm.createContext({
    addEventListener() {},
    parent: { postMessage() {} },
    document: { querySelector: () => ({}), createElement: element, createTextNode: () => ({}) },
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  for (const script of scripts) vm.runInContext(script, window);
  return window;
}

test("plugin:new inlines the current panel SDK into the scaffolded panel (PLG-9)", async (t) => {
  const dir = temp(t);
  assert.equal(run(scaffold, ["panel-check", "--out", dir], dir).status, 0);
  const target = path.join(dir, "panel-check");
  const html = fs.readFileSync(path.join(target, "panel.html"), "utf8");
  assert.ok(!html.includes("STUDIO_PANEL_SDK"), "the marker is replaced");
  const window = loadPanel(html);
  assert.equal(typeof window.studioPlugin?.call, "function");
  assert.equal(
    typeof window.studioPlugin?.onContextChanged,
    "function",
    "the bridge index.d.ts declares is the bridge the panel has",
  );
  assert.equal(typeof window.studioPlugin?.ui?.status, "function", "ui.js comes with it");
  assert.deepEqual(
    fs.readdirSync(path.join(target, "plugin-sdk")),
    ["index.d.ts"],
    "no unused bridge copy beside the panel",
  );
  const doctor = run(path.resolve("scripts/plugin-doctor.ts"), [target, "--json"], dir);
  assert.equal(JSON.parse(doctor.stdout).ok, true, doctor.stdout);
});

test("plugin:pack packs the package only: no dotfiles, dot-folders or editor files, and no links (PLG-9)", async (t) => {
  const dir = temp(t);
  assert.equal(run(scaffold, ["packed", "--out", dir], dir).status, 0);
  const target = path.join(dir, "packed");
  fs.mkdirSync(path.join(target, ".git"));
  fs.writeFileSync(path.join(target, ".git", "config"), '[remote "origin"]');
  fs.writeFileSync(path.join(target, ".env"), "API_KEY=secret");
  fs.mkdirSync(path.join(target, "assets", ".cache"), { recursive: true });
  fs.writeFileSync(path.join(target, "assets", ".cache", "x"), "cache");
  fs.writeFileSync(path.join(target, "assets", "icon.txt"), "icon");
  const artifact = path.join(dir, "packed.json");
  const packed = run(pack, [target, artifact], dir);
  assert.equal(packed.status, 0, packed.stderr);
  const files = Object.keys(JSON.parse(fs.readFileSync(artifact, "utf8"))).sort();
  assert.deepEqual(files, ["assets/icon.txt", "backend.mjs", "panel.html", "plugin.json"]);

  fs.symlinkSync(path.join(dir, "packed.json"), path.join(target, "assets", "linked.json"));
  const linked = run(pack, [target, path.join(dir, "linked.json")], dir);
  assert.notEqual(linked.status, 0, "a link is refused, never followed into the artifact");
  assert.equal(fs.existsSync(path.join(dir, "linked.json")), false);
});

test("plugin:doctor reports the example as installable, safe and ready", (t) => {
  const dir = temp(t);
  const result = run(doctor, [example, "--json"], dir);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.id, "example");
  assert.equal(report.probe, "ready");
  assert.equal(report.scan.verdict, "safe");
  assert.deepEqual(report.scan.findings, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.toolbar, [
    { id: "demo", label: "Example", ariaLabel: "Example plugin demo", target: "panel:demo", status: "count" },
  ]);

  // The human report is what an author actually reads.
  const human = run(doctor, [example], dir);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^ok\s/);
  assert.match(human.stdout, /Scan: safe/);
  assert.match(human.stdout, /Probe: ready/);
});

test("plugin:doctor fails a backend that cannot be loaded and echoes its stderr", (t) => {
  const dir = temp(t);
  const target = copyExample(dir, "broken");
  fs.writeFileSync(
    path.join(target, "backend.mjs"),
    "process.stderr.write('activation exploded\\n');\nthrow new Error('boom at import');\n",
  );
  const result = run(doctor, [target, "--json"], dir);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.probe, "failed");
  assert.ok(
    report.errors.some((e: string) => /boom at import/.test(e)),
    report.errors.join("\n"),
  );
  assert.ok(
    report.stderr.some((line: string) => line.includes("activation exploded")),
    "backend stderr must reach the report",
  );
});

test("plugin:doctor refuses an unreadable package and reports panel CSP problems as warnings", (t) => {
  const dir = temp(t);
  const invalid = copyExample(dir, "invalid");
  fs.writeFileSync(path.join(invalid, "plugin.json"), JSON.stringify({ apiVersion: 2, id: "invalid" }));
  const broken = run(doctor, [invalid, "--json"], dir);
  assert.equal(broken.status, 1);
  assert.match(JSON.parse(broken.stdout).errors.join("\n"), /not installable/);
  assert.equal(run(doctor, [path.join(dir, "absent")], dir).status, 1);

  const csp = copyExample(dir, "csp");
  const panel = path.join(csp, "panel.html");
  fs.writeFileSync(panel, `<script src="https://cdn.example.test/chart.js"></script>${fs.readFileSync(panel, "utf8")}`);
  const result = run(doctor, [csp, "--json"], dir);
  const report = JSON.parse(result.stdout);
  assert.ok(
    report.warnings.some((w: string) => /external script/.test(w)),
    report.warnings.join("\n"),
  );
  assert.ok(
    report.warnings.some((w: string) => /cdn\.example\.test/.test(w)),
    report.warnings.join("\n"),
  );
  // The scan sees the undeclared host too, and that is a disclosure, not an installation block.
  assert.equal(report.scan.verdict, "caution");
  assert.equal(report.probe, "ready");
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
  assert.equal(result.status, 0);
});

test("plugin:new leaves the author's coding agent a guide that names this plugin, the guide and the checks", (t) => {
  const dir = temp(t);
  const result = run(scaffold, ["agent-ready", "--out", dir], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(PLUGIN_GUIDE_URL), "the next steps link the public guide, not a repo-relative path");
  assert.match(result.stdout, /Load local plugin…/, "the next steps use the menu item's real name");
  const agents = fs.readFileSync(path.join(dir, "agent-ready", "AGENTS.md"), "utf8");
  assert.ok(agents.includes(PLUGIN_GUIDE_URL));
  assert.match(agents, /agent-ready__greet/, "it names the plugin's own tool spelling");
  for (const command of ["plugin:doctor", "plugin:pack", "plugin:submit"]) assert.ok(agents.includes(command), command);
});

/**
 * A contributor's clone of the catalog before their first release: the repository genex-plugins is
 * made from (its validator included), with the policy the published catalog enforces.
 */
function emptyCatalog(dir: string): string {
  const catalog = path.join(dir, "genex-plugins");
  fs.cpSync(path.resolve("marketplace/template"), catalog, { recursive: true });
  fs.writeFileSync(path.join(catalog, "policy.json"), JSON.stringify(STUDIO_CATALOG_POLICY));
  fs.writeFileSync(
    path.join(catalog, "index.json"),
    JSON.stringify({ version: 1, updatedAt: "2026-09-18T00:00:00.000Z", plugins: [] }),
  );
  return catalog;
}

/** A copy of the catalog as it is now: the base branch a pull request is checked against. */
function snapshot(catalog: string, to: string): string {
  fs.cpSync(catalog, to, { recursive: true });
  return to;
}

/** Put an artifact where the maintainer's upload puts it: `<uploads>/<id>/<version>/<sha256>.json`. */
function upload(uploads: string, artifact: string, record: { id: string; version: string }): string {
  const sha256 = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  const file = path.join(uploads, record.id, record.version, `${sha256}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(artifact, file);
  return sha256;
}

/**
 * The catalog's own `scripts/check-catalog.mjs`, run inside the clone the way its pull-request CI
 * runs it: the base's validator and policy judge the candidate's records and history, here with the
 * uploaded artifacts read from disk instead of the public origin.
 */
function catalogCheck(catalog: string, base: string, uploads: string) {
  const args = ["--root", ".", "--previous", base, "--policy-root", base, "--artifacts", uploads];
  // Its CLI runs only when argv[1] is its own resolved URL, so name it through no link (macOS /var).
  const validator = fs.realpathSync(path.join(base, "scripts/check-catalog.mjs"));
  return spawnSync(process.execPath, [validator, ...args], {
    cwd: catalog,
    encoding: "utf8",
  });
}

const SOURCE = ["--repo", "acme/submitted", "--sha", "a".repeat(40), "--category", "tools"];

test("plugin:submit writes a community record and index entry the catalog's own check accepts", (t) => {
  const dir = temp(t);
  const catalog = emptyCatalog(dir);
  const base = snapshot(catalog, path.join(dir, "base"));
  const uploads = path.join(dir, "uploads");
  assert.equal(run(scaffold, ["submitted", "--out", dir], dir).status, 0);
  const target = path.join(dir, "submitted");
  const scaffolded = JSON.parse(fs.readFileSync(path.join(target, "plugin.json"), "utf8"));
  fs.writeFileSync(path.join(target, "plugin.json"), JSON.stringify({ ...scaffolded, publisher: "Acme" }));
  const docs = ["--docs-url", "https://example.com/submitted"];
  const result = run(submit, [target, "--catalog", catalog, ...SOURCE, ...docs], dir);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const record = JSON.parse(fs.readFileSync(path.join(catalog, "records/submitted/0.1.0.json"), "utf8"));
  const index = JSON.parse(fs.readFileSync(path.join(catalog, "index.json"), "utf8"));
  assert.deepEqual(index.plugins, [record], "the index lists exactly the new record");
  assert.notEqual(index.updatedAt, "2026-09-18T00:00:00.000Z");
  assert.equal(record.tier, "community");
  assert.equal(record.publisher, "Acme");
  assert.equal(record.repo, "acme/submitted");
  assert.equal(record.docsUrl, "https://example.com/submitted");
  const artifact = path.join(dir, "submitted-0.1.0.json");
  assert.ok(result.stdout.includes(artifact), "it says which file to attach to the release");
  const bytes = fs.readFileSync(artifact);
  assert.ok(!Object.keys(JSON.parse(bytes.toString())).includes("AGENTS.md"), "authoring files stay out");
  const sha256 = upload(uploads, artifact, record);
  assert.deepEqual(record.artifact, {
    url: `https://plugins.genex.games/releases/submitted/0.1.0/${sha256}.json`,
    sha256,
  });

  const checked = catalogCheck(catalog, base, uploads);
  assert.equal(checked.status, 0, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.entries, 1);
  assert.deepEqual(
    report.artifactsVerified.map((a: { id: string; version: string; bytes: number }) => [a.id, a.version, a.bytes]),
    [["submitted", "0.1.0", bytes.length]],
    "the artifact the author attaches is the one the record pins",
  );

  const released = snapshot(catalog, path.join(dir, "released"));
  const again = run(submit, [target, "--catalog", catalog, ...SOURCE], dir);
  assert.equal(again.status, 1, "a released version is never rewritten");
  assert.match(again.stderr, /already/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(catalog, "records/submitted/0.1.0.json"), "utf8")), record);

  const manifest = JSON.parse(fs.readFileSync(path.join(target, "plugin.json"), "utf8"));
  fs.writeFileSync(path.join(target, "plugin.json"), JSON.stringify({ ...manifest, version: "0.2.0" }));
  const update = run(submit, [target, "--catalog", catalog, ...SOURCE], dir);
  assert.equal(update.status, 0, update.stderr + update.stdout);
  const updated = JSON.parse(fs.readFileSync(path.join(catalog, "index.json"), "utf8"));
  assert.deepEqual(
    updated.plugins.map((p: { version: string }) => p.version),
    ["0.2.0"],
    "the entry moves to the new version",
  );
  assert.ok(fs.existsSync(path.join(catalog, "records/submitted/0.1.0.json")), "history is kept");
  upload(uploads, path.join(dir, "submitted-0.2.0.json"), updated.plugins[0]);
  const next = catalogCheck(catalog, released, uploads);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).records, 2, "the update is checked against the released history");
});

test("plugin:submit refuses an official id, a placeholder publisher, a bad source and an artifact inside the catalog, writing nothing", (t) => {
  const dir = temp(t);
  const catalog = emptyCatalog(dir);
  const official = copyExample(dir, "official");
  const manifest = JSON.parse(fs.readFileSync(path.join(official, "plugin.json"), "utf8"));
  fs.writeFileSync(path.join(official, "plugin.json"), JSON.stringify({ ...manifest, id: "genex" }));
  const plain = copyExample(dir, "plain");
  // A record's publisher is its owner for every later release, so the scaffold's placeholder never becomes one.
  assert.equal(run(scaffold, ["unnamed", "--out", dir], dir).status, 0);
  const unnamed = path.join(dir, "unnamed");
  const cases: Array<[string, string[], RegExp]> = [
    ["official id", [official, "--catalog", catalog, ...SOURCE], /official/i],
    ["placeholder publisher", [unnamed, "--catalog", catalog, ...SOURCE], /publisher/],
    ["short sha", [plain, "--catalog", catalog, ...SOURCE.slice(0, 2), "--sha", "abc", "--category", "tools"], /sha/],
    ["bad repo", [plain, "--catalog", catalog, "--repo", "acme", ...SOURCE.slice(2)], /repo/],
    ["bad category", [plain, "--catalog", catalog, ...SOURCE.slice(0, 4), "--category", "games"], /category/],
    ["http docs", [plain, "--catalog", catalog, ...SOURCE, "--docs-url", "http://example.com"], /HTTPS/],
    ["no catalog", [plain, ...SOURCE], /Usage/],
    [
      "artifact inside",
      [plain, "--catalog", catalog, ...SOURCE, "--artifact", path.join(catalog, "a.json")],
      /outside/,
    ],
  ];
  for (const [name, args, error] of cases) {
    const result = run(submit, args, dir);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, error, name);
    assert.equal(fs.existsSync(path.join(catalog, "records")), false, `${name} writes no record`);
  }
  const index = JSON.parse(fs.readFileSync(path.join(catalog, "index.json"), "utf8"));
  assert.deepEqual(index.plugins, []);
});

test("plugin:unpack restores a packed artifact exactly, for review, and refuses unsafe envelopes", (t) => {
  const dir = temp(t);
  const artifact = path.join(dir, "example.json");
  assert.equal(run(pack, [example, artifact], dir).status, 0);
  const restored = path.join(dir, "restored");
  const result = run(unpack, [artifact, restored], dir);
  assert.equal(result.status, 0, result.stderr);
  for (const file of Object.keys(JSON.parse(fs.readFileSync(artifact, "utf8"))))
    assert.deepEqual(fs.readFileSync(path.join(restored, file)), fs.readFileSync(path.join(example, file)), file);
  assert.equal(run(unpack, [artifact, restored], dir).status, 1, "an existing folder is never written into");

  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const hostile: Array<[string, unknown]> = [
    ["parent", { "plugin.json": b64("{}"), "../escaped": b64("x") }],
    ["absolute", { "plugin.json": b64("{}"), [path.join(dir, "absolute")]: b64("x") }],
    ["backslash", { "plugin.json": b64("{}"), "..\\escaped": b64("x") }],
    ["dot segment", { "plugin.json": b64("{}"), "a/./b": b64("x") }],
    ["not text", { "plugin.json": 5 }],
    ["array", [b64("x")]],
    ["null", null],
  ];
  for (const [name, envelope] of hostile) {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(envelope));
    const target = path.join(dir, "out", name);
    const refused = run(unpack, [file, target], dir);
    assert.equal(refused.status, 1, name);
    assert.equal(fs.existsSync(target), false, `${name} leaves no folder`);
  }
  assert.equal(fs.existsSync(path.join(dir, "escaped")), false);
  assert.equal(fs.existsSync(path.join(dir, "out", "escaped")), false);
  assert.equal(fs.existsSync(path.join(dir, "absolute")), false);
});

test("plugin:pack answers a missing argument with its usage, not a stack trace", (t) => {
  const dir = temp(t);
  const result = run(pack, [], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: npm run plugin:pack/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("plugin:doctor judges what would ship: a git checkout and the scaffold's own files do not make a plugin unsafe", (t) => {
  const dir = temp(t);
  assert.equal(run(scaffold, ["versioned", "--out", dir], dir).status, 0);
  const target = path.join(dir, "versioned");
  fs.mkdirSync(path.join(target, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(target, ".git", "config"), "[core]\n");
  fs.writeFileSync(path.join(target, ".git", "hooks", "pre-commit.sample"), "#!/bin/sh\nexit 0\n");
  const result = run(doctor, [target, "--json"], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scan.verdict, "safe", JSON.stringify(report.scan.findings));
  assert.deepEqual(report.scan.findings, []);
});

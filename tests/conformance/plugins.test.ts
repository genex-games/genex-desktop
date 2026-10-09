import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, cp, mkdir, readFile, writeFile, rename, rm, stat, symlink } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import net from "node:net";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PluginConsentDeclined, PluginRegistry, type PluginMcpLaunch } from "../../src/substrate/plugins/registry.ts";
import { SecretStorageIssue } from "../../src/shared/secret-storage.ts";
import { SecretStorageUnavailableError } from "../../src/substrate/secrets.ts";
import { EXAMPLE_PLUGIN, copyOfExample as copyOf, pluginFixture as fixture } from "../helpers/plugins.ts";
import {
  RESERVED_TOOLBAR_LABELS,
  canonicalManifest,
  inspectPackage,
  validateManifest,
} from "../../src/substrate/plugins/manifest.ts";
import type { PluginChange, PluginInfo, PluginManifest, PluginSource } from "../../src/shared/plugins.ts";
import { CallCutOff } from "../../src/shared/plugins.ts";
import { PluginCallCutOff } from "../../src/substrate/plugins/process.ts";
const source = EXAMPLE_PLUGIN;
test("bundled plugin uses a real child, tools and settings share one contract; disabled fails closed", async () => {
  const f = await fixture();
  try {
    assert.equal(f.registry.tools()[0]!.name, "example__greet");
    assert.match(f.registry.guidance(), /example__greet/);
    await f.registry.setSetting("example", "greeting", "Welcome");
    assert.deepEqual(await f.registry.tool("example__greet", { name: "Ada" }, f.binding), {
      text: "Welcome Ada",
      project: "game",
    });
    assert.equal(f.registry.list()[0]!.health, "ready");
    await f.registry.setEnabled("example", false);
    assert.deepEqual(f.registry.tools(), []);
    assert.equal(f.registry.guidance(), "");
    await assert.rejects(f.registry.tool("example__greet", { name: "Ada" }, f.binding), /unavailable/);
  } finally {
    await f.close();
  }
});
test("removal survives restart, retains data and restores explicitly", async () => {
  const f = await fixture();
  try {
    await f.registry.setSetting("example", "greeting", "Saved");
    await f.registry.remove("example");
    const next = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, async () => null);
    await next.init();
    assert.equal(next.enabled("example"), false);
    assert.equal(next.list()[0]!.removed, true);
    await next.restore("example");
    assert.equal(next.enabled("example"), true);
    assert.equal((await next.settings("example")).greeting, "Saved");
    next.cancel();
  } finally {
    await f.close();
  }
});
test("tools reject undeclared fields, invalid types and unsupported operations", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.registry.tool("example__greet", { name: "Ada", credentials: "oops" }, f.binding),
      /Invalid tool input/,
    );
    await assert.rejects(f.registry.tool("example__greet", { name: 3 }, f.binding), /Invalid tool input/);
    await assert.rejects(f.registry.tool("example__publish", {}, f.binding), /Unknown/);
  } finally {
    await f.close();
  }
});
test("local package validation rejects links, incompatibility and duplicate declarations", async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.root, "bad");
    await cp(source, dir, { recursive: true });
    await symlink("/tmp", path.join(dir, "escape"));
    await assert.rejects(inspectPackage(dir), /links/);
    const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
    assert.throws(() => validateManifest({ ...manifest, apiVersion: 4 }), /incompatible/);
    assert.throws(() => validateManifest({ ...manifest, tools: [...manifest.tools, ...manifest.tools] }), /duplicate/);
  } finally {
    await f.close();
  }
});
test("package inspection refuses a link or special file at any depth and accepts a deep plain tree", {
  skip: process.platform === "win32" && "named pipes, socket files and unprivileged links are POSIX file kinds",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-walk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = (dir: string) => path.join(dir, "assets", "deep", "deeper");
  const listening: net.Server[] = [];
  t.after(() => {
    for (const server of listening) server.close();
  });
  const cases: Array<[string, (dir: string) => Promise<void>]> = [
    ["a link at the top", (dir) => symlink("/tmp", path.join(dir, "escape"))],
    ["a link deep inside", (dir) => symlink("/etc/hosts", path.join(nested(dir), "hosts"))],
    ["a dangling link", (dir) => symlink(path.join(dir, "missing"), path.join(nested(dir), "gone"))],
    ["a link to a folder inside", (dir) => symlink(path.join(dir, "assets"), path.join(nested(dir), "loop"))],
    ["a named pipe", async (dir) => void execFileSync("mkfifo", [path.join(nested(dir), "pipe")])],
    [
      "a socket",
      (dir) =>
        new Promise<void>((resolve, reject) => {
          const server = net.createServer().listen(path.join(nested(dir), "s"), () => resolve());
          listening.push(server);
          server.on("error", reject);
        }),
    ],
  ];
  for (const [name, plant] of cases) {
    const dir = path.join(root, name.replaceAll(" ", "-"));
    await cp(source, dir, { recursive: true });
    await mkdir(nested(dir), { recursive: true });
    await writeFile(path.join(nested(dir), "plain.txt"), "plain");
    await plant(dir);
    await assert.rejects(inspectPackage(dir), /links or special files/, name);
  }
  const plain = path.join(root, "plain");
  await cp(source, plain, { recursive: true });
  for (let i = 0; i < 20; i++) {
    await mkdir(path.join(plain, "assets", `d${i}`, "inner"), { recursive: true });
    await writeFile(path.join(plain, "assets", `d${i}`, "inner", "f.txt"), String(i));
  }
  assert.equal(
    (await inspectPackage(plain)).id,
    JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8")).id,
  );
});
test("updates wait for sessions and failed activation retains working version", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const release = f.registry.lease();
    const dir = path.join(f.root, "update");
    await cp(source, dir, { recursive: true });
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    m.version = "1.1.0";
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));
    await f.registry.installLocal(dir);
    assert.equal(f.registry.list()[0]!.manifest.version, "1.0.0");
    assert.equal(f.registry.list()[0]!.pendingVersion, "1.1.0");
    await release();
    assert.equal(f.registry.list()[0]!.manifest.version, "1.1.0");
    await writeFile(path.join(dir, "backend.mjs"), 'throw new Error("broken startup")');
    await assert.rejects(f.registry.installLocal(dir), /broken startup/);
    assert.equal(f.registry.list()[0]!.manifest.version, "1.1.0");
  } finally {
    await f.close();
  }
});
test("permission expansion requires approval, process crashes do not replay", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const dir = path.join(f.root, "update");
    await cp(source, dir, { recursive: true });
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    m.capabilities.push("credentials");
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));
    await assert.rejects(f.registry.installLocal(dir), /Permission expansion/);
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(){process.exit(9)}}}",
    );
    await f.registry.installLocal(dir, "local", m.capabilities);
    await assert.rejects(
      f.registry.tool("example__greet", { name: "Ada" }, f.binding),
      (error: unknown) =>
        error instanceof PluginCallCutOff && error.reason === CallCutOff.PluginEnded && /exited/.test(error.message),
    );
    assert.equal(f.registry.list()[0]!.health, "failed");
  } finally {
    await f.close();
  }
});
test("host file services bind project, reject traversal and isolate plugin storage", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "public.txt"), "public");
    assert.equal(await f.services.call("example", "project.read", { path: "public.txt" }, f.binding), "public");
    await assert.rejects(f.services.call("example", "project.read", { path: "../secret" }, f.binding), /Invalid/);
    await assert.rejects(
      f.services.call("example", "project.write", { path: ".env", text: "bad" }, f.binding),
      /Protected/,
    );
    await f.services.call("example", "jobs.write", { id: "job", value: { generation: "existing" } });
    assert.equal(await f.services.call("other", "jobs.read", { id: "job" }), null);
  } finally {
    await f.close();
  }
});
test("backend cannot unlock credentials from a tool call", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const dir = path.join(f.root, "evil");
    await cp(source, dir, { recursive: true });
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    m.capabilities.push("credentials");
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return c.host('credentials.read')}}}",
    );
    await f.registry.installLocal(dir, "local", m.capabilities);
    await assert.rejects(f.registry.tool("example__greet", { name: "Ada" }, f.binding), /Explicit account unlock/);
  } finally {
    await f.close();
  }
});
test("disable while an update waits never re-enables the plugin", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const release = f.registry.lease();
    await f.registry.installLocal(source);
    await f.registry.setEnabled("example", false);
    await release();
    assert.equal(f.registry.enabled("example"), false);
  } finally {
    await f.close();
  }
});
test("cancelled invocation is not retried and cannot access host services afterwards", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const dir = path.join(f.root, "slow");
    await cp(source, dir, { recursive: true });
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return new Promise((resolve,reject)=>{c.signal.addEventListener('abort',()=>reject(new Error('aborted')));});}}}",
    );
    await f.registry.installLocal(dir);
    const stop = new AbortController();
    const job = f.registry.tool("example__greet", { name: "Ada" }, f.binding, stop.signal);
    setTimeout(() => stop.abort(), 30);
    await assert.rejects(job, /Stopped local/);
  } finally {
    await f.close();
  }
});
test("curated artifacts require matching digest and exact manifest, without install hooks", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  try {
    const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
    const files: Record<string, string> = {};
    for (const file of ["plugin.json", "backend.mjs", "panel.html"])
      files[file] = (await readFile(path.join(source, file))).toString("base64");
    const bytes = Buffer.from(JSON.stringify(files));
    const { createHash } = await import("node:crypto");
    const entry = { manifest, url: "https://catalog.example/plugin.json", sha256: "0".repeat(64) };
    await writeFile(path.join(f.root, "catalog.json"), JSON.stringify([entry]));
    globalThis.fetch = async () => new Response(bytes);
    await assert.rejects(f.registry.installCatalog("example", []), /digest/);
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(f.root, "catalog.json"), JSON.stringify([entry]));
    await f.registry.installCatalog("example", []);
    assert.equal(f.registry.list()[0]!.source, "catalog");
    assert.deepEqual(await f.registry.tool("example__greet", { name: "Ada" }, f.binding), {
      text: "Hello Ada",
      project: "game",
    });
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
test("parallel first calls share one backend activation", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const dir = path.join(f.root, "parallel");
    await cp(source, dir, { recursive: true });
    await writeFile(
      path.join(dir, "backend.mjs"),
      "let count=0;export async function activate(){count++;await new Promise(r=>setTimeout(r,25));return {tool(){return {activations:count};}}}",
    );
    await f.registry.installLocal(dir);
    const results = await Promise.all([
      f.registry.tool("example__greet", { name: "Ada" }, f.binding),
      f.registry.tool("example__greet", { name: "Lin" }, f.binding),
    ]);
    assert.deepEqual(results, [{ activations: 1 }, { activations: 1 }]);
  } finally {
    await f.close();
  }
});

const manifestOf = async () =>
  JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8")) as PluginManifest & Record<string, unknown>;
test("validateManifest returns a canonical manifest in fixed key order and drops unknown top-level keys", async () => {
  const manifest = await manifestOf();
  const shuffled = {
    zzz: "dropped",
    toolbar: manifest.toolbar,
    actions: manifest.actions,
    settings: manifest.settings,
    panels: manifest.panels,
    skills: manifest.skills,
    tools: manifest.tools,
    capabilities: manifest.capabilities,
    backend: manifest.backend,
    description: manifest.description,
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    id: manifest.id,
    apiVersion: 2,
  };
  const canonical = validateManifest(shuffled);
  assert.deepEqual(Object.keys(canonical), [
    "apiVersion",
    "id",
    "version",
    "name",
    "publisher",
    "description",
    "backend",
    "capabilities",
    "tools",
    "skills",
    "panels",
    "settings",
    "actions",
    "toolbar",
  ]);
  assert.ok(!("zzz" in canonical));
  assert.equal(canonicalManifest(shuffled), canonicalManifest(manifest));
  assert.equal(JSON.stringify(canonical), canonicalManifest(manifest));
  const { toolbar: _t, ...v1 } = { ...manifest, apiVersion: 1, tools: [manifest.tools[0]] };
  assert.deepEqual(Object.keys(validateManifest(v1)).slice(-1), ["actions"]);
  assert.ok(!("toolbar" in validateManifest(v1)));
  assert.deepEqual(Object.keys(validateManifest({ ...manifest, network: { hosts: ["api.example"] } })).slice(-2), [
    "network",
    "toolbar",
  ]);
});
test("API 2 fields are rejected under apiVersion 1 instead of being ignored", async () => {
  const manifest = await manifestOf();
  assert.throws(() => validateManifest({ ...manifest, apiVersion: 1 }), /requires apiVersion 2/);
  const { toolbar: _t, ...noToolbar } = { ...manifest, apiVersion: 1 };
  assert.throws(() => validateManifest(noToolbar), /tools\[\]\.confirmation requires apiVersion 2/);
  const v1 = { ...noToolbar, tools: [manifest.tools[0]] };
  assert.throws(() => validateManifest({ ...v1, toolbar: manifest.toolbar }), /toolbar requires apiVersion 2/);
  assert.throws(() => validateManifest({ ...v1, network: { hosts: ["x.example"] } }), /network requires apiVersion 2/);
  assert.equal(validateManifest(v1).apiVersion, 1);
  assert.throws(
    () => validateManifest({ ...manifest, tools: [manifest.tools[0], { ...manifest.tools[1], confirmation: "" }] }),
    /confirmation/,
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        tools: [manifest.tools[0], { ...manifest.tools[1], confirmation: "x".repeat(301) }],
      }),
    /confirmation/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, tools: [manifest.tools[0], { ...manifest.tools[1], confirmation: 7 }] }),
    /Invalid tool confirmation/,
  );
  assert.equal(
    validateManifest({ ...manifest, tools: [manifest.tools[0], { ...manifest.tools[1], confirmation: "x" }] }).tools[1]!
      .confirmation,
    "x",
  );
  assert.throws(
    () => validateManifest({ ...manifest, network: { hosts: Array.from({ length: 33 }, (_, i) => `h${i}.example`) } }),
    /network hosts/,
  );
  assert.throws(() => validateManifest({ ...manifest, network: { hosts: ["not a host"] } }), /network hosts/);
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        tools: [{ ...manifest.tools[0], parameters: { type: "object", properties: { list: { type: "array" } } } }],
      }),
    /scalar/,
  );
});
test("toolbar validation: reserved labels, undeclared targets, confirmed status actions and the item cap", async () => {
  const manifest = await manifestOf();
  const item = manifest.toolbar![0]!;
  const withToolbar = (toolbar: unknown) => ({ ...manifest, toolbar });
  assert.ok(RESERVED_TOOLBAR_LABELS.has("Assets") && RESERVED_TOOLBAR_LABELS.has("Close plugins"));
  for (const label of [
    "Assets",
    "Retry",
    "Ready",
    "Live",
    "Builds",
    "Export",
    "Plugins",
    "Reload",
    "State",
    "Close plugins",
    "assets",
  ])
    assert.throws(() => validateManifest(withToolbar([{ ...item, label }])), /Invalid toolbar label.*reserved/, label);
  assert.throws(() => validateManifest(withToolbar([{ ...item, ariaLabel: "Assets" }])), /Invalid toolbar ariaLabel/);
  assert.throws(
    () => validateManifest(withToolbar([{ ...item, target: { kind: "action", name: "missing" } }])),
    /Invalid toolbar target: unknown action/,
  );
  assert.throws(
    () => validateManifest(withToolbar([{ ...item, target: { kind: "panel", id: "missing" } }])),
    /Invalid toolbar target: unknown panel/,
  );
  assert.throws(
    () => validateManifest(withToolbar([{ ...item, target: { kind: "link", url: "https://x" } }])),
    /Invalid toolbar target/,
  );
  const confirmed = {
    ...manifest,
    actions: [...manifest.actions, { name: "spend", label: "Spend", confirmation: "Spend credits?" }],
  };
  assert.throws(
    () => validateManifest({ ...confirmed, toolbar: [{ ...item, status: "spend" }] }),
    /Invalid toolbar status.*confirmation/,
  );
  assert.throws(() => validateManifest(withToolbar([{ ...item, status: "missing" }])), /Invalid toolbar status/);
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...item, id: `b${i}`, ariaLabel: `Button ${i}` }));
  assert.throws(() => validateManifest(withToolbar(many(5))), /at most 4/);
  assert.equal(validateManifest(withToolbar(many(4))).toolbar!.length, 4);
  assert.throws(
    () => validateManifest(withToolbar([item, { ...item, ariaLabel: "Other" }])),
    /Invalid toolbar item id/,
  );
  assert.throws(() => validateManifest(withToolbar([item, { ...item, id: "two" }])), /ariaLabel/);
  assert.throws(() => validateManifest(withToolbar([{ ...item, label: "x".repeat(25) }])), /label/);
  assert.throws(() => validateManifest(withToolbar([{ ...item, icon: "12345" }])), /icon/);
  assert.throws(
    () => validateManifest(withToolbar([{ ...item, target: { kind: "action", name: "hello", args: { nested: {} } } }])),
    /args/,
  );
  assert.throws(
    () =>
      validateManifest(
        withToolbar([
          {
            ...item,
            target: {
              kind: "action",
              name: "hello",
              args: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])),
            },
          },
        ]),
      ),
    /args/,
  );
  const ok = validateManifest(
    withToolbar([
      {
        ...item,
        icon: "★",
        target: { kind: "action", name: "hello", args: { loud: true, n: 1, s: "x" } },
        extra: "dropped",
      },
    ]),
  );
  assert.deepEqual(ok.toolbar, [
    {
      id: "demo",
      label: "Example",
      ariaLabel: "Example plugin demo",
      icon: "★",
      requiresProject: false,
      target: { kind: "action", name: "hello", args: { loud: true, n: 1, s: "x" } },
      status: "count",
    },
  ]);
});
test("publish actions are sensitive and require trusted confirmation", async () => {
  const manifest = await manifestOf();
  for (const name of ["publish-draft", "publish-gallery"]) {
    assert.throws(
      () => validateManifest({ ...manifest, actions: [...manifest.actions, { name, label: "Publish" }] }),
      /trusted confirmation/,
    );
    assert.doesNotThrow(() =>
      validateManifest({
        ...manifest,
        actions: [...manifest.actions, { name, label: "Publish", confirmation: "Put the game online?" }],
      }),
    );
  }
});
test("toolbar() lists only enabled installed plugins and the status action answers with a badge", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.registry.toolbar(), [
      {
        plugin: "example",
        item: {
          id: "demo",
          label: "Example",
          ariaLabel: "Example plugin demo",
          requiresProject: false,
          target: { kind: "panel", id: "demo" },
          status: "count",
        },
      },
    ]);
    assert.equal(f.registry.list()[0]!.state, "enabled");
    assert.deepEqual(f.registry.list()[0]!.origin, { kind: "bundled" });
    assert.deepEqual(await f.registry.action("example", "count", {}), { badge: "0" });
    await f.registry.tool("example__greet", { name: "Ada" }, f.binding);
    assert.deepEqual(await f.registry.action("example", "count", {}), { badge: "1" });
    await f.registry.setEnabled("example", false);
    assert.deepEqual(f.registry.toolbar(), []);
    assert.equal(f.registry.list()[0]!.state, "disabled");
    await f.registry.setEnabled("example", true);
    assert.equal(f.registry.toolbar().length, 1);
    await f.registry.remove("example");
    assert.deepEqual(f.registry.toolbar(), []);
    assert.equal(f.registry.list()[0]!.state, "disabled");
  } finally {
    await f.close();
  }
});
test("confirmed tools fail closed without a consent hook, honour a decline and run once approved", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.registry.tools().find((t) => t.name === "example__shout")?.confirmation,
      "The example plugin wants to shout your text back.",
    );
    await assert.rejects(
      f.registry.tool("example__shout", { text: "hi" }, f.binding),
      /requires user consent, which is unavailable in this session/,
    );
    f.registry.consent = async () => ({ approved: false, by: "user" });
    await assert.rejects(
      f.registry.tool("example__shout", { text: "hi" }, f.binding),
      (e: unknown) => e instanceof PluginConsentDeclined && e.by === "user" && /declined/.test(e.message),
    );
    f.registry.consent = async () => ({ approved: false, by: "timeout" });
    // Flipped: a card nobody answered is not a no, so its error no longer says "declined".
    await assert.rejects(f.registry.tool("example__shout", { text: "hi" }, f.binding), (e: unknown) => {
      assert.ok(e instanceof PluginConsentDeclined);
      assert.equal(e.by, "timeout");
      assert.match(e.message, /^Nobody answered example__shout\..*not a no/);
      assert.doesNotMatch(e.message, /declined/);
      return true;
    });
    const seen: unknown[] = [];
    f.registry.consent = async (id, tool, args, binding) => {
      seen.push({ id, tool: tool.name, confirmation: tool.confirmation, args, binding });
      return { approved: true, by: "user" };
    };
    assert.deepEqual(await f.registry.tool("example__shout", { text: "hi" }, f.binding), {
      text: "HI",
      project: "game",
    });
    assert.deepEqual(seen, [
      {
        id: "example",
        tool: "shout",
        confirmation: "The example plugin wants to shout your text back.",
        args: { text: "hi" },
        binding: f.binding,
      },
    ]);
    seen.length = 0;
    await f.registry.tool("example__greet", { name: "Ada" }, f.binding);
    assert.equal(seen.length, 0);
    f.registry.consent = async () => {
      await f.registry.setEnabled("example", false);
      return { approved: true, by: "user" };
    };
    await assert.rejects(f.registry.tool("example__shout", { text: "hi" }, f.binding), /unavailable/);
  } finally {
    await f.close();
  }
});
test("onChange reports install, update (including a leased update), enable, disable, remove and failure", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const changes: PluginChange[] = [];
    f.registry.onChange = (c) => changes.push(c);
    await f.registry.installLocal(
      await copyOf(f.root, "second", (m) => {
        m.id = "second";
        m.name = "Second";
      }),
    );
    assert.deepEqual(changes.splice(0), [{ id: "second", reason: "installed" }]);
    const dir = await copyOf(f.root, "update", (m) => {
      m.version = "1.1.0";
    });
    await f.registry.installLocal(dir);
    assert.deepEqual(changes.splice(0), [{ id: "example", reason: "updated" }]);
    const release = f.registry.lease();
    const later = await copyOf(f.root, "later", (m) => {
      m.version = "1.2.0";
    });
    await f.registry.installLocal(later);
    assert.deepEqual(changes, []);
    assert.equal(f.registry.list()[0]!.pendingVersion, "1.2.0");
    await release();
    assert.deepEqual(changes.splice(0), [{ id: "example", reason: "updated" }]);
    assert.equal(f.registry.list()[0]!.manifest.version, "1.2.0");
    await f.registry.setEnabled("example", false);
    await f.registry.setEnabled("example", true);
    await f.registry.remove("second");
    assert.deepEqual(changes.splice(0), [
      { id: "example", reason: "disabled" },
      { id: "example", reason: "enabled" },
      { id: "second", reason: "removed" },
    ]);
    await f.registry.installLocal(
      await copyOf(f.root, "crash", (m) => {
        m.id = "crash";
      }).then(async (d) => {
        await writeFile(
          path.join(d, "backend.mjs"),
          "export async function activate(){return {tool(){process.exit(9)}}}",
        );
        return d;
      }),
    );
    changes.length = 0;
    await assert.rejects(f.registry.tool("crash__greet", { name: "Ada" }, f.binding), /exited/);
    assert.deepEqual(changes, [{ id: "crash", reason: "failed" }]);
    f.registry.onChange = () => {
      throw new Error("listener bug");
    };
    await f.registry.setEnabled("example", false);
    assert.equal(f.registry.enabled("example"), false);
  } finally {
    await f.close();
  }
});
test("catalog compare is canonical: reordered keys and unknown fields still match, a changed manifest does not", async () => {
  const f = await fixture();
  const original = globalThis.fetch;
  try {
    const manifest = await manifestOf();
    const files: Record<string, string> = {};
    for (const file of ["plugin.json", "backend.mjs", "panel.html"])
      files[file] = (await readFile(path.join(source, file))).toString("base64");
    const bytes = Buffer.from(JSON.stringify(files));
    const { createHash } = await import("node:crypto");
    const reordered = { unknownField: "ignored", ...Object.fromEntries(Object.entries(manifest).reverse()) };
    const entry = {
      manifest: reordered,
      url: "https://catalog.example/plugin.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(path.join(f.root, "catalog.json"), JSON.stringify([entry]));
    globalThis.fetch = async () => new Response(bytes);
    await f.registry.installCatalog("example", []);
    const info = f.registry.list()[0]!;
    assert.equal(info.source, "catalog");
    assert.deepEqual(info.origin, { kind: "catalog", url: entry.url, sha256: entry.sha256 });
    await writeFile(
      path.join(f.root, "catalog.json"),
      JSON.stringify([{ ...entry, manifest: { ...manifest, name: "Renamed" } }]),
    );
    await assert.rejects(f.registry.installCatalog("example", []), /Catalog manifest mismatch/);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
test("restore re-acquires a local plugin from its recorded origin and names a gone folder", async () => {
  const f = await fixture();
  try {
    const dir = await copyOf(f.root, "local", (m) => {
      m.id = "local-one";
      m.name = "Local one";
    });
    await f.registry.installLocal(dir);
    const find = (r: PluginRegistry) => r.list().find((p) => p.manifest.id === "local-one")!;
    assert.deepEqual(find(f.registry).origin, { kind: "local", directory: dir });
    assert.equal(find(f.registry).state, "enabled");
    await f.registry.remove("local-one");
    assert.equal(find(f.registry).removed, true);
    assert.deepEqual(find(f.registry).origin, { kind: "local", directory: dir });
    const next = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, (id, m, a, b) =>
      f.services.call(id, m, a, b),
    );
    await next.init();
    try {
      assert.deepEqual(find(next).origin, { kind: "local", directory: dir });
      await next.restore("local-one");
      assert.equal(next.enabled("local-one"), true);
      assert.deepEqual(await next.tool("local-one__greet", { name: "Ada" }, f.binding), {
        text: "Hello Ada",
        project: "game",
      });
      await next.remove("local-one");
      await rm(dir, { recursive: true, force: true });
      await assert.rejects(next.restore("local-one"), /The folder this plugin was loaded from is gone; load it again/);
      assert.equal(next.enabled("local-one"), false);
      await assert.rejects(next.restore("never-installed"), /ENOENT|no such file/);
    } finally {
      next.cancel();
    }
  } finally {
    await f.close();
  }
});
test("code dropped under packages is listed as not-enabled until allowed; records outside Studio storage are force-disabled", async () => {
  const f = await fixture();
  try {
    const dropped = path.join(f.registry.root, "packages", "dropped", "x");
    await cp(source, dropped, { recursive: true });
    const dm = JSON.parse(await readFile(path.join(dropped, "plugin.json"), "utf8"));
    dm.id = "dropped";
    await writeFile(path.join(dropped, "plugin.json"), JSON.stringify(dm));
    const outside = await copyOf(f.root, "outside", (m) => {
      m.id = "outside";
    });
    const state = JSON.parse(await readFile(path.join(f.registry.root, "installed.json"), "utf8"));
    state.outside = {
      directory: outside,
      manifest: JSON.parse(await readFile(path.join(outside, "plugin.json"), "utf8")),
      source: "local",
      enabled: true,
      removed: false,
    };
    await writeFile(path.join(f.registry.root, "installed.json"), JSON.stringify(state));
    const next = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, (id, m, a, b) =>
      f.services.call(id, m, a, b),
    );
    await next.init();
    try {
      const find = (id: string) => next.list().find((p) => p.manifest.id === id)!;
      assert.equal(find("dropped").unlisted, true);
      assert.equal(find("dropped").state, "not-enabled");
      assert.equal(find("dropped").enabled, false);
      assert.deepEqual(find("dropped").origin, { kind: "local", directory: dropped });
      assert.ok(!next.tools().some((t) => t.name.startsWith("dropped__")));
      assert.deepEqual(
        next.toolbar().filter((t) => t.plugin === "dropped"),
        [],
      );
      assert.doesNotMatch(next.guidance(), /\[dropped\//);
      await assert.rejects(next.tool("dropped__greet", { name: "Ada" }, f.binding), /unavailable/);
      await assert.rejects(next.setEnabled("dropped", true), /Install the plugin first/);
      assert.equal(find("outside").enabled, false);
      assert.equal(find("outside").state, "disabled");
      assert.match(find("outside").error!, /outside Studio storage/);
      await assert.rejects(next.tool("outside__greet", { name: "Ada" }, f.binding), /unavailable/);
      await next.allowUnlisted("dropped", ["settings"]);
      assert.equal(find("dropped").state, "enabled");
      assert.equal(find("dropped").unlisted, undefined);
      assert.equal(next.list().filter((p) => p.manifest.id === "dropped").length, 1);
      assert.deepEqual(await next.tool("dropped__greet", { name: "Ada" }, f.binding), {
        text: "Hello Ada",
        project: "game",
      });
      assert.equal(
        await stat(dropped).then(
          () => "present",
          () => "gone",
        ),
        "gone",
      );
      await assert.rejects(next.allowUnlisted("dropped"), /Unknown plugin/);
    } finally {
      next.cancel();
    }
  } finally {
    await f.close();
  }
});
/** A registry over `root` that shares the fixture's seeds, bootstrap and host services. */
async function reopened(f: Awaited<ReturnType<typeof fixture>>, root: string): Promise<PluginRegistry> {
  const next = new PluginRegistry(root, f.seeds, f.registry.bootstrap, (id, m, a, b) => f.services.call(id, m, a, b));
  await next.init();
  return next;
}
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
// The AI Game Studio → Genex data-folder migration renames the folder, or copies it when the rename
// fails; install records written before it still name packages by their old absolute path.
for (const [moved, relocate] of [
  ["renamed", (from: string, to: string) => rename(from, to)],
  ["copied", (from: string, to: string) => cp(from, to, { recursive: true })],
] as const)
  test(`a data folder ${moved} to a new name keeps its plugins, loaded from the new folder's packages`, async () => {
    const f = await fixture();
    try {
      f.registry.cancel();
      const root = path.join(f.root, "Genex");
      await relocate(f.registry.root, root);
      const next = await reopened(f, root);
      try {
        const example = next.list().find((p) => p.manifest.id === "example")!;
        assert.equal(example.error, undefined);
        assert.equal(example.state, "enabled");
        assert.deepEqual(await next.tool("example__greet", { name: "Ada" }, f.binding), {
          text: "Hello Ada",
          project: "game",
        });
        const saved = JSON.parse(await readFile(path.join(root, "installed.json"), "utf8"));
        assert.equal(path.dirname(saved.example.directory), path.join(root, "packages", "example"));
        assert.equal(await exists(saved.example.directory), true);
      } finally {
        next.cancel();
      }
    } finally {
      await f.close();
    }
  });
test("an update that waited for a lease under a renamed data folder applies from the new folder", async () => {
  const f = await fixture();
  try {
    f.registry.cancel();
    const old = f.registry.root;
    const update = path.join(old, "packages", "example", "1.0.1-waiting");
    await cp(EXAMPLE_PLUGIN, update, { recursive: true });
    const installed = JSON.parse(await readFile(path.join(old, "installed.json"), "utf8"));
    await writeFile(
      path.join(old, "pending.json"),
      JSON.stringify({ example: { ...installed.example, directory: update } }),
    );
    const root = path.join(f.root, "Genex");
    await rename(old, root);
    const next = await reopened(f, root);
    try {
      assert.equal(next.list().find((p) => p.manifest.id === "example")!.error, undefined);
      const saved = JSON.parse(await readFile(path.join(root, "installed.json"), "utf8"));
      assert.equal(saved.example.directory, path.join(root, "packages", "example", "1.0.1-waiting"));
    } finally {
      next.cancel();
    }
  } finally {
    await f.close();
  }
});
// Builds before the fix refused those records and then swept the copies they no longer named, so a
// renamed folder can hold records whose package is gone.
for (const enabled of [true, false])
  test(`a bundled plugin whose package copy is gone is copied again from its seed, staying ${enabled ? "on" : "off"}`, async () => {
    const f = await fixture();
    try {
      await f.registry.setEnabled("example", enabled);
      f.registry.cancel();
      const root = path.join(f.root, "Genex");
      await rename(f.registry.root, root);
      await rm(path.join(root, "packages", "example"), { recursive: true });
      await mkdir(path.join(root, "packages", "example"));
      const next = await reopened(f, root);
      try {
        const example = next.list().find((p) => p.manifest.id === "example")!;
        assert.equal(example.error, undefined);
        assert.equal(example.enabled, enabled);
        const saved = JSON.parse(await readFile(path.join(root, "installed.json"), "utf8"));
        assert.equal(path.dirname(saved.example.directory), path.join(root, "packages", "example"));
        assert.equal(await exists(path.join(saved.example.directory, "plugin.json")), true);
      } finally {
        next.cancel();
      }
    } finally {
      await f.close();
    }
  });
test("a plugin from a folder whose package copy is gone stays disabled and says the package is missing", async () => {
  const f = await fixture({ installed: "local" });
  try {
    f.registry.cancel();
    await rm(path.join(f.registry.root, "packages", "example"), { recursive: true });
    const next = await reopened(f, f.registry.root);
    try {
      const example = next.list().find((p) => p.manifest.id === "example")!;
      assert.equal(example.enabled, false);
      assert.match(example.error!, /package is missing/);
      assert.equal(await exists(path.join(f.registry.root, "packages", "example")), false);
    } finally {
      next.cancel();
    }
  } finally {
    await f.close();
  }
});
// Only the same package under this storage is ever read: a record naming any other folder is
// refused, and that folder is neither loaded nor removed.
for (const [named, at, error] of [
  ["a plain folder", "outside", /outside Studio storage/],
  ["another plugin's package", "elsewhere/packages/other/1.0.0-a", /outside Studio storage/],
  ["a folder not under packages", "elsewhere/plugins/outside/1.0.0-a", /outside Studio storage/],
  [
    "a path that climbs out of packages",
    "elsewhere/packages/outside/1.0.0-a/../../../outside-b",
    /outside Studio storage/,
  ],
  ["a package this storage does not hold", "elsewhere/packages/outside/1.0.0-a", /package is missing/],
] as const)
  test(`an install record naming ${named} is refused without reading or removing it`, async () => {
    const f = await fixture();
    try {
      f.registry.cancel();
      const directory = path.join(f.root, at);
      await mkdir(path.dirname(directory), { recursive: true });
      await copyOf(path.dirname(directory), path.basename(directory), (m) => {
        m.id = "outside";
      });
      const state = JSON.parse(await readFile(path.join(f.registry.root, "installed.json"), "utf8"));
      state.outside = {
        directory: `${f.root}/${at}`,
        manifest: JSON.parse(await readFile(path.join(directory, "plugin.json"), "utf8")),
        source: "local",
        enabled: true,
        removed: false,
      };
      await writeFile(path.join(f.registry.root, "installed.json"), JSON.stringify(state));
      const next = await reopened(f, f.registry.root);
      try {
        const outside = next.list().find((p) => p.manifest.id === "outside")!;
        assert.equal(outside.enabled, false);
        assert.match(outside.error!, error);
        await assert.rejects(next.tool("outside__greet", { name: "Ada" }, f.binding), /unavailable/);
        assert.equal(await exists(path.join(directory, "plugin.json")), true);
      } finally {
        next.cancel();
      }
    } finally {
      await f.close();
    }
  });
test("export.stage is capability-gated, needs the host export and stages under plugin storage", async () => {
  const f = await fixture({ installed: "local" });
  try {
    const dir = await copyOf(f.root, "exporter");
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return c.host('export.stage',{})}}}",
    );
    await f.registry.installLocal(dir);
    await assert.rejects(f.registry.tool("example__greet", { name: "Ada" }, f.binding), /capability denied/);
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    m.capabilities.push("export");
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));
    await f.registry.installLocal(dir, "local", m.capabilities);
    await assert.rejects(f.registry.tool("example__greet", { name: "Ada" }, f.binding), /Export unavailable/);
    const seen: Array<{ binding: unknown; target: string }> = [];
    f.services.exportStage = async (binding, target) => {
      seen.push({ binding, target });
      return { dir: target, files: 1, included: ["index.html"], excluded: [] };
    };
    const target = path.join(f.services.root("example"), "publish", "game", "dist");
    assert.deepEqual(await f.registry.tool("example__greet", { name: "Ada" }, f.binding), {
      dir: target,
      files: 1,
      included: ["index.html"],
      excluded: [],
    });
    assert.deepEqual(seen, [{ binding: f.binding, target }]);
    assert.ok((await stat(path.dirname(target))).isDirectory());
    // The copy has no package.json, so the game's Genex part of its own rides along for the CLI.
    await writeFile(
      path.join(f.binding.directory, "package.json"),
      JSON.stringify({ dependencies: { "@genex-ai/embed-sdk": "0.30.0", three: "^0.170.0" } }),
    );
    const withSdk = await f.registry.tool("example__greet", { name: "Ada" }, f.binding);
    assert.deepEqual(withSdk.genex, { dependencies: { "@genex-ai/embed-sdk": "0.30.0" } });
    await assert.rejects(
      f.services.call("example", "export.stage", {}, { project: "../escape", directory: f.root }),
      /Invalid project name/,
    );
    await assert.rejects(f.services.call("example", "export.stage", {}), /Project required/);
  } finally {
    await f.close();
  }
});
test("assets.deliver reports the delivered files to the host ledger and a failing ledger never fails delivery", async () => {
  const f = await fixture();
  try {
    const out = path.join(f.services.root("example"), "out");
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "a.png"), "x");
    const jobId = "11111111-1111-1111-1111-111111111111",
      other = "22222222-2222-2222-2222-222222222222";
    let seen: unknown;
    f.services.onDelivered = async (id, delivered, binding) => {
      seen = { id, delivered, binding };
    };
    const files = await f.services.call("example", "assets.deliver", { output: out, jobId }, f.binding);
    // Workspace-relative and `/`-separated on every platform: the ledger and the agent read it so.
    assert.deepEqual(files, [`assets/example/${jobId}/a.png`]);
    assert.deepEqual(seen, { id: "example", delivered: { jobId, files }, binding: f.binding });
    f.services.onDelivered = async () => {
      throw new Error("ledger down");
    };
    assert.deepEqual(await f.services.call("example", "assets.deliver", { output: out, jobId: other }, f.binding), [
      `assets/example/${other}/a.png`,
    ]);
    assert.equal(await readFile(path.join(f.root, "assets", "example", other, "a.png"), "utf8"), "x");
  } finally {
    await f.close();
  }
});

/** Poll a condition the registry reaches on its own; asserted with a deadline, never a sleep. */
const until = async (probe: () => Promise<boolean>, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await delay(150);
  }
};
/**
 * Hands the registry's folder watcher to the test: when the OS reports an edit is its own business
 * (fs.watch coalesces, and runs late under load), so each edit is announced right after it is written.
 */
function watchByHand(registry: PluginRegistry) {
  const open = new Set<() => void>();
  const folders: string[] = [];
  registry.watchFolder = (directory, onChange) => {
    folders.push(directory);
    open.add(onChange);
    return {
      close() {
        open.delete(onChange);
      },
    };
  };
  return {
    /** Every folder the registry asked to watch, in order. */
    folders,
    /** Report an edit to every watcher still open, as the file system would. */
    edited() {
      for (const onChange of open) onChange();
    },
  };
}
test("by default a watched folder listens with the file system's own watcher, whose change event is the edit", async () => {
  const f = await fixture();
  try {
    let heard = 0;
    const watcher = f.registry.watchFolder(f.root, () => {
      heard += 1;
    });
    try {
      assert.ok(watcher instanceof EventEmitter, "the default is a real fs.watch handle");
      // Emitted by hand, synchronously: nothing awaits the OS, so no real event can land in between.
      watcher.emit("change", "change", "backend.mjs");
      assert.equal(heard, 1);
    } finally {
      watcher.close();
    }
  } finally {
    await f.close();
  }
});
test("watch reloads a local plugin from the folder it was loaded from, defers under a lease and refuses other origins", async () => {
  const f = await fixture();
  try {
    const dir = await copyOf(f.root, "watched", (m) => {
      m.id = "watched";
      m.name = "Watched";
    });
    await f.registry.installLocal(dir);
    const watcher = watchByHand(f.registry);
    const find = () => f.registry.list().find((p) => p.manifest.id === "watched")!;
    assert.equal(find().watching, false);
    await assert.rejects(f.registry.watch("example", true), /loaded from a local folder/);
    await assert.rejects(f.registry.watch("absent", true), /Enable the plugin first/);
    const changes: PluginChange[] = [];
    f.registry.onChange = (c) => changes.push(c);
    await f.registry.watch("watched", true);
    assert.equal(find().watching, true);
    assert.deepEqual(watcher.folders, [dir]);
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return {text:`Reloaded ${a.name}`,project:c.project};}}}",
    );
    watcher.edited();
    assert.ok(
      await until(async () => changes.some((c) => c.id === "watched" && c.reason === "reloaded")),
      `the edit did not reload within 5 s: ${JSON.stringify(changes)}`,
    );
    assert.equal(
      ((await f.registry.tool("watched__greet", { name: "Ada" }, f.binding)) as { text: string }).text,
      "Reloaded Ada",
    );
    const release = f.registry.lease();
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    m.version = "1.2.0";
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));
    watcher.edited();
    assert.ok(
      await until(async () => find().pendingVersion === "1.2.0"),
      "the leased edit never became pending within 5 s",
    );
    assert.equal(find().manifest.version, "1.0.0");
    changes.length = 0;
    await release();
    assert.equal(find().manifest.version, "1.2.0");
    assert.deepEqual(changes, [{ id: "watched", reason: "reloaded" }]);
    await f.registry.watch("watched", false);
    assert.equal(find().watching, false);
    await f.registry.watch("watched", true);
    await f.registry.setEnabled("watched", false);
    assert.equal(find().watching, false);
    await f.registry.setEnabled("watched", true);
    await f.registry.watch("watched", true);
    f.registry.cancel();
    assert.equal(find().watching, false);
  } finally {
    await f.close();
  }
});
test("code that is read again is scanned again: a reload and a restore never keep the old verdict", async () => {
  const f = await fixture();
  try {
    const dir = await copyOf(f.root, "rescanned", (m) => {
      m.id = "rescanned";
      m.name = "Rescanned";
    });
    const scanned: string[] = [];
    // Stands in for scanPackage: the host sets the real one. What matters is that it is asked again,
    // against the copy being installed, and that the card takes the answer.
    f.registry.scan = async (directory, manifest) => {
      const code = await readFile(path.join(directory, "backend.mjs"), "utf8");
      scanned.push(`${manifest.id}:${directory}`);
      return {
        verdict: code.includes("execSync") ? "dangerous" : "safe",
        findings: [],
        files: 3,
        bytes: code.length,
        scannedAt: new Date().toISOString(),
      };
    };
    await f.registry.installLocal(dir);
    const find = () => f.registry.list().find((p) => p.manifest.id === "rescanned")!;
    assert.equal(find().scan!.verdict, "safe");
    assert.equal(scanned.length, 1);
    const watcher = watchByHand(f.registry);
    await f.registry.watch("rescanned", true);
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return {text:'ok',project:c.project};}}}\n// now shells out: execSync\n",
    );
    watcher.edited();
    assert.ok(
      await until(async () => find().scan?.verdict === "dangerous"),
      "the reload kept the verdict of code that is no longer there",
    );
    assert.ok(scanned.length > 1, "the reloaded copy was scanned, not the one already on the card");
    assert.ok(scanned.at(-1)!.startsWith("rescanned:"));
    assert.notEqual(scanned.at(-1), scanned[0], "and it was the newly installed copy that was read");
    await f.registry.remove("rescanned");
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return {text:'ok',project:c.project};}}}\n",
    );
    const before = scanned.length;
    await f.registry.restore("rescanned");
    assert.equal(find().scan!.verdict, "safe", "a restore from the folder reads that folder as it is now");
    assert.equal(scanned.length, before + 1);
  } finally {
    await f.close();
  }
});
/**
 * The race the serialized queue exists for: a remove already waiting in line when a watched edit
 * fires. The reload is queued behind it, so by the time it runs the plugin is gone — and it must
 * stay gone. The first, ordinary reload proves an announced edit reloads at all here.
 */
test("a watched edit never brings back a plugin removed while the reload was queued", async () => {
  const f = await fixture();
  try {
    const dir = await copyOf(f.root, "racing", (m) => {
      m.id = "racing";
      m.name = "Racing";
    });
    await f.registry.installLocal(dir);
    const find = () => f.registry.list().find((p) => p.manifest.id === "racing")!;
    const watcher = watchByHand(f.registry);
    const changes: PluginChange[] = [];
    f.registry.onChange = (c) => changes.push(c);
    await f.registry.watch("racing", true);
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return {text:`Reloaded ${a.name}`,project:c.project};}}}",
    );
    watcher.edited();
    assert.ok(
      await until(async () => changes.some((c) => c.id === "racing" && c.reason === "reloaded")),
      `the edit did not reload within 5 s: ${JSON.stringify(changes)}`,
    );
    assert.equal(
      ((await f.registry.tool("racing__greet", { name: "Ada" }, f.binding)) as { text: string }).text,
      "Reloaded Ada",
    );
    changes.length = 0;
    // One slow install holds the queue, so the remove behind it has not run when the watcher fires.
    const slowDir = await copyOf(f.root, "slow", (m) => {
      m.id = "slow";
      m.name = "Slow";
    });
    await writeFile(
      path.join(slowDir, "backend.mjs"),
      "export async function activate(){await new Promise(r=>setTimeout(r,2000));return {tool(n,a,c){return {text:'ok',project:c.project};}}}",
    );
    const blocked = f.registry.installLocal(slowDir);
    const removal = f.registry.remove("racing");
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return {text:`Resurrected ${a.name}`,project:c.project};}}}",
    );
    watcher.edited();
    await Promise.all([blocked, removal]);
    assert.equal(find().removed, true);
    assert.equal(
      await until(async () => find().removed === false, 1500),
      false,
      "a queued reload brought a removed plugin back",
    );
    assert.equal(f.registry.enabled("racing"), false);
    assert.equal(find().watching, false);
    assert.deepEqual(
      changes.filter((c) => c.id === "racing"),
      [{ id: "racing", reason: "removed" }],
      "the remove is the last word on the plugin",
    );
    await assert.rejects(f.registry.tool("racing__greet", { name: "Ada" }, f.binding), /unavailable/);
  } finally {
    await f.close();
  }
});
test("a removed sha-pinned plugin is re-acquired through the marketplace hook, never silently from disk", async () => {
  const f = await fixture();
  try {
    const dir = await copyOf(f.root, "pinned", (m) => {
      m.id = "pinned";
      m.name = "Pinned";
    });
    const origin: PluginSource = {
      kind: "github",
      repo: "acme/studio-plugins",
      sha: "a".repeat(40),
      subdir: "plugins/pinned",
    };
    await f.registry.installLocal(dir, "github", ["settings"], origin);
    const find = () => f.registry.list().find((p) => p.manifest.id === "pinned")!;
    assert.deepEqual(find().origin, origin);
    assert.equal(find().source, "github");
    await f.registry.remove("pinned");
    await assert.rejects(f.registry.restore("pinned"), /needs the marketplace, which is unavailable in this session/);
    const asked: PluginInfo[] = [];
    f.registry.reacquire = async (info) => {
      asked.push(info);
      await f.registry.installLocal(dir, "github", info.manifest.capabilities, info.origin, info.scan);
    };
    assert.equal((await f.registry.restore("pinned")).id, "pinned");
    assert.equal(f.registry.enabled("pinned"), true);
    assert.deepEqual(
      asked.map((i) => i.origin),
      [origin],
    );
    assert.equal(asked[0]!.removed, true);
    await f.registry.remove("pinned");
    f.registry.reacquire = async () => {
      /* the marketplace answered but installed nothing */
    };
    await assert.rejects(f.registry.restore("pinned"), /was not reinstalled/);
  } finally {
    await f.close();
  }
});
test("backend stderr reaches the developer debug sink without becoming plugin status", async () => {
  const f = await fixture();
  try {
    const dir = await copyOf(f.root, "noisy", (m) => {
      m.id = "noisy";
      m.name = "Noisy";
    });
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){process.stderr.write('token=secret-looking output\\n');return {tool(n,a,c){return {text:'ok',project:c.project};}}}",
    );
    const lines: Array<{ id: string; line: string }> = [];
    f.registry.debug = (id, line) => {
      lines.push({ id, line });
    };
    await f.registry.installLocal(dir);
    assert.equal(lines.length, 0);
    assert.deepEqual(await f.registry.tool("noisy__greet", { name: "Ada" }, f.binding), {
      text: "ok",
      project: "game",
    });
    assert.ok(
      await until(async () => lines.some((l) => l.id === "noisy" && l.line.includes("secret-looking output")), 2000),
      "stderr never reached the debug sink",
    );
    const info = f.registry.list().find((p) => p.manifest.id === "noisy")!;
    assert.equal(info.error, undefined);
    assert.equal(info.health, "ready");
  } finally {
    await f.close();
  }
});

/**
 * A plugin may ship MCP servers of its own. The manifest names sources, never values, and the
 * shape it may name is narrow on purpose: a server is native code the host starts on this Mac.
 */
const genexManifest = async () =>
  JSON.parse(await readFile(path.resolve("src/plugins/genex/plugin.json"), "utf8")) as PluginManifest &
    Record<string, unknown>;
const mcpServer = (overrides: Record<string, unknown> = {}) => ({
  id: "echo",
  transport: "stdio" as const,
  command: "node" as const,
  args: ["server.mjs"],
  cwd: "storage" as const,
  description: "A server that echoes.",
  ...overrides,
});
test("mcpServers is API 2 only, and what a plugin may declare about a server it ships is narrow", async () => {
  const manifest = await manifestOf();
  const withServers = (mcpServers: unknown) => ({ ...manifest, mcpServers });
  const { toolbar: _t, ...noToolbar } = { ...manifest, apiVersion: 1, tools: [manifest.tools[0]] };
  assert.throws(
    () => validateManifest({ ...noToolbar, mcpServers: [mcpServer()] }),
    /mcpServers requires apiVersion 2/,
  );
  // The `__` in a tool name must stay unambiguous, so a server id carries no underscore.
  assert.throws(() => validateManifest(withServers([mcpServer({ id: "my_server" })])), /Invalid mcpServers id/);
  assert.throws(() => validateManifest(withServers([mcpServer({ id: "Echo" })])), /Invalid mcpServers id/);
  assert.throws(() => validateManifest(withServers([mcpServer(), mcpServer()])), /Invalid mcpServers id/);
  assert.throws(
    () =>
      validateManifest(
        withServers([
          mcpServer(),
          mcpServer({ id: "b" }),
          mcpServer({ id: "c" }),
          mcpServer({ id: "d" }),
          mcpServer({ id: "e" }),
        ]),
      ),
    /at most 4 servers/,
  );
  // A host CLI is Studio's program, not the package's: a different trust class, and not on offer.
  assert.throws(
    () => validateManifest(withServers([mcpServer({ command: "host-cli", args: ["blender", "mcp"] })])),
    /reserved for the bundled Genex plugin/,
  );
  assert.throws(() => validateManifest(withServers([mcpServer({ command: "npx" })])), /Invalid mcpServers command/);
  assert.throws(() => validateManifest(withServers([mcpServer({ transport: "http" })])), /is stdio/);
  assert.throws(() => validateManifest(withServers([mcpServer({ args: [] })])), /needs the script to run/);
  assert.throws(
    () => validateManifest(withServers([mcpServer({ args: ["/usr/local/bin/server.mjs"] })])),
    /Invalid plugin path/,
  );
  assert.throws(() => validateManifest(withServers([mcpServer({ args: ["../escape.mjs"] })])), /Invalid plugin path/);
  assert.throws(() => validateManifest(withServers([mcpServer({ cwd: "package" })])), /Invalid mcpServers cwd/);
  assert.throws(() => validateManifest(withServers([mcpServer({ description: "" })])), /needs a description/);
  assert.throws(() => validateManifest(withServers([mcpServer({ callTimeoutMs: 1_800_001 })])), /callTimeoutMs/);
  assert.throws(() => validateManifest(withServers([mcpServer({ maxTools: 0 })])), /maxTools/);
  // Env values name a source. Anything else, including a value, is refused.
  assert.throws(
    () => validateManifest(withServers([mcpServer({ env: { TOKEN: "sk-live-1234" } })])),
    /use setting:<key>, secret:<name>, literal:<value> or credential-file/,
  );
  assert.throws(
    () => validateManifest(withServers([mcpServer({ env: { TOKEN: "setting:missing" } })])),
    /setting "missing" is not declared/,
  );
  assert.throws(
    () => validateManifest(withServers([mcpServer({ env: { lower: "literal:x" } })])),
    /environment variable name/,
  );
  assert.throws(
    () => validateManifest(withServers([mcpServer({ env: { TOKEN: "credential-file" } })])),
    /credentials capability/,
  );
  assert.throws(
    () => validateManifest(withServers([mcpServer({ requires: { credential: true } })])),
    /requires.credential needs the credentials capability/,
  );
  assert.throws(
    () => validateManifest(withServers([mcpServer({ requires: { settings: ["missing"] } })])),
    /requires.settings: "missing" is not declared/,
  );
  // What survives is canonical: the section last, its keys in one order, unknown fields dropped.
  const canonical = validateManifest(
    withServers([
      mcpServer({
        extra: "dropped",
        env: { ZED: "literal:z", ALPHA: "setting:greeting" },
        toolPolicy: { deny: ["dangerous"] },
        maxTools: 8,
        callTimeoutMs: 900_000,
      }),
    ]),
  );
  assert.deepEqual(Object.keys(canonical).slice(-2), ["toolbar", "mcpServers"]);
  assert.deepEqual(Object.keys(canonical.mcpServers![0]!), [
    "id",
    "transport",
    "command",
    "args",
    "cwd",
    "env",
    "toolPolicy",
    "maxTools",
    "callTimeoutMs",
    "description",
  ]);
  assert.deepEqual(canonical.mcpServers![0]!.env, { ALPHA: "setting:greeting", ZED: "literal:z" });
  assert.ok(!("extra" in canonical.mcpServers![0]!));
  assert.equal(
    canonicalManifest(withServers([mcpServer()])),
    canonicalManifest(validateManifest(withServers([mcpServer()]))),
  );
});
test("the bundled Genex manifest declares main MCP and optional Blender, with writes kept in host tools", async () => {
  const genex = await genexManifest();
  const canonical = validateManifest(genex);
  const creator = canonical.mcpServers!.find((s) => s.id === "creator")!;
  assert.equal(creator.command, "node");
  assert.deepEqual(creator.args, ["creator-mcp.mjs"]);
  assert.deepEqual(creator.requires, { credential: true });
  assert.deepEqual(creator.env, { GENEX_ENV_FILE: "credential-file" });
  assert.deepEqual(creator.toolPolicy?.allow, ["search_games", "search_animations", "my_games", "generation_status"]);
  const server = canonical.mcpServers!.find((s) => s.id === "blender")!;
  assert.equal(server.id, "blender");
  assert.equal(server.command, "host-cli", "the CLI Studio ships is the only host program on offer");
  // The same API base the asset adapter spawns the CLI with, so both halves talk to one service.
  assert.deepEqual(server.args, ["blender", "mcp", "--api-url", "https://api.genex.games"]);
  assert.equal(server.cwd, "storage:project");
  assert.deepEqual(server.env, {
    GENEX_API_URL: "literal:https://api.genex.games",
    GENEX_BLENDER_URL: "setting:blender-url",
    GENEX_ENV_FILE: "credential-file",
  });
  // Without an endpoint the CLI still lists six tools and answers every one of them with a setup
  // hint, so the setting is a requirement, not a preference: unset, the server publishes nothing.
  assert.deepEqual(server.requires, { credential: true, settings: ["blender-url"] });
  // It resolves a caller-supplied absolute path and writes bytes to it, with no containment check.
  assert.deepEqual(server.toolPolicy, { deny: ["blender_export_glb"] });
  assert.equal(server.callTimeoutMs, 900_000);
  assert.ok(
    genex.settings!.some((s) => s.key === "blender-url"),
    "the endpoint the server needs is a declared setting",
  );
});
test("a plugin's MCP servers are published with it, withdrawn with it, and given the credential only after unlock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-mcp-"));
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  const seed = path.join(seeds, "example");
  await cp(source, seed, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(seed, "plugin.json"), "utf8"));
  manifest.capabilities.push("credentials");
  manifest.actions.push({ name: "unlock", label: "Unlock saved account", confirmation: "Unlock the saved account." });
  manifest.mcpServers = [
    {
      id: "echo",
      transport: "stdio",
      command: "node",
      args: ["backend.mjs"],
      cwd: "storage:project",
      env: { TOKEN_FILE: "credential-file" },
      requires: { credential: true },
      description: "A server that echoes.",
    },
  ];
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  const asked: string[] = [];
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async (id, method) => {
      asked.push(method);
      if (method === "storage.root") return path.join(root, "data", id);
      if (method === "credentials.read") return "tok-registry";
      throw new Error(`unexpected host service ${method}`);
    },
  );
  try {
    await registry.init();
    const seen: Array<{ kind: string; id: string; servers?: unknown; launch?: PluginMcpLaunch }> = [];
    registry.mcpHost = {
      register: (id, servers, launch) => {
        seen.push({ kind: "register", id, servers, launch });
      },
      unregister: (id) => {
        seen.push({ kind: "unregister", id });
      },
    };
    await registry.syncMcpServers();
    assert.equal(seen.at(-1)!.kind, "register", "an enabled plugin publishes its servers");
    const launch = seen.at(-1)!.launch!;
    assert.ok(launch.packageDir.startsWith(path.join(root, "installed", "packages", "example") + path.sep));
    assert.equal(await launch.projectStorage("alpha"), path.join(root, "data", "example", "mcp", "alpha"));
    await assert.rejects(launch.projectStorage("../escape"), /Invalid project/);
    assert.equal(await launch.credentialFile(), undefined, "the host does not read the store behind the user");
    assert.equal(asked.includes("credentials.read"), false);
    seen.length = 0;
    await registry.action("example", "unlock", {});
    assert.equal(await launch.credentialFile(), "GENEX_TOKEN=tok-registry\n", "one env-file line, for the pipe");
    assert.equal(seen.at(-1)!.kind, "register", "unlocking republishes, so a waiting server becomes available");
    await registry.setEnabled("example", false);
    assert.deepEqual(seen.at(-1), { kind: "unregister", id: "example" });
    assert.equal(await launch.credentialFile(), undefined, "disabling takes the authorization with it");
    await registry.setEnabled("example", true);
    assert.equal(seen.at(-1)!.kind, "register");
    // Changing what a server runs is an expansion of the same kind a new capability is. The update
    // arrives as Studio's own (`bundled`): a local folder can no longer take a bundled plugin's id.
    const changed = path.join(root, "changed");
    await cp(seed, changed, { recursive: true });
    const next = JSON.parse(await readFile(path.join(changed, "plugin.json"), "utf8"));
    next.version = "1.1.0";
    next.mcpServers[0].args = ["other.mjs"];
    await writeFile(path.join(changed, "plugin.json"), JSON.stringify(next));
    await assert.rejects(registry.installLocal(changed, "bundled"), /Permission expansion requires confirmation/);
    await registry.installLocal(changed, "bundled", next.capabilities);
    assert.deepEqual((seen.at(-1)!.servers as Array<{ args: string[] }>)[0]!.args, ["other.mjs"]);
    await registry.remove("example");
    assert.deepEqual(seen.at(-1), { kind: "unregister", id: "example" });
  } finally {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Reinstalling something the user removed is an install, not an update. The host has just shown
 * the install dialog for the manifest that is about to land — capabilities, servers and all — so
 * the expansion gates that protect a silent update must not stand in front of it with no way past.
 */
test("a removed bundled plugin can be reinstalled after its seed grew new capabilities and servers", async () => {
  const f = await fixture();
  try {
    await f.registry.remove("example");
    assert.equal(f.registry.list().find((p) => p.manifest.id === "example")!.removed, true);
    // Studio updates: the bundled seed on disk is now a later version that declares an MCP server
    // and one more capability than the record the profile kept.
    const seed = path.join(f.seeds, "example");
    const grown = JSON.parse(await readFile(path.join(seed, "plugin.json"), "utf8"));
    grown.version = "9.9.0";
    grown.capabilities = [...grown.capabilities, "credentials"];
    grown.mcpServers = [mcpServer({ args: ["backend.mjs"] })];
    await writeFile(path.join(seed, "plugin.json"), JSON.stringify(grown));
    const manifest = await f.registry.restore("example");
    assert.equal(manifest.version, "9.9.0");
    assert.equal(f.registry.enabled("example"), true);
    assert.deepEqual(
      manifest.mcpServers!.map((s) => s.id),
      ["echo"],
    );
    assert.deepEqual(await f.registry.tool("example__greet", { name: "Ada" }, f.binding), {
      text: "Hello Ada",
      project: "game",
    });
    // And an update — the same manifest arriving from Studio while the plugin is installed — is still gated.
    const changed = await copyOf(f.root, "grown-again", (m) => {
      m.version = "9.9.1";
      m.capabilities = grown.capabilities;
      m.mcpServers = [mcpServer({ args: ["backend.mjs"], cwd: "storage:project" })];
    });
    await assert.rejects(f.registry.installLocal(changed, "bundled"), /Permission expansion requires confirmation/);
  } finally {
    await f.close();
  }
});

test("an unlock that fails leaves the plugin locked, and its servers without a credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-unlock-"));
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  const seed = path.join(seeds, "example");
  await cp(source, seed, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(seed, "plugin.json"), "utf8"));
  manifest.capabilities.push("credentials");
  manifest.actions.push({ name: "unlock", label: "Unlock saved account", confirmation: "Unlock the saved account." });
  manifest.mcpServers = [
    mcpServer({ args: ["backend.mjs"], env: { TOKEN_FILE: "credential-file" }, requires: { credential: true } }),
  ];
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  // A backend whose unlock refuses: the Keychain prompt was cancelled, the password was wrong.
  await writeFile(
    path.join(seed, "backend.mjs"),
    "export async function activate(){return {async action(name){if(name==='unlock')throw new Error('Keychain access was denied');return {ok:true};}};}",
  );
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async (id, method) => {
      if (method === "storage.root") return path.join(root, "data", id);
      if (method === "credentials.read") return "tok-registry";
      throw new Error(`unexpected host service ${method}`);
    },
  );
  try {
    await registry.init();
    const seen: Array<{ kind: string; launch?: PluginMcpLaunch }> = [];
    registry.mcpHost = {
      register: (id, servers, launch) => {
        seen.push({ kind: "register", launch });
      },
      unregister: () => {
        seen.push({ kind: "unregister" });
      },
    };
    await registry.syncMcpServers();
    const launch = seen.at(-1)!.launch!;
    await assert.rejects(registry.action("example", "unlock", {}), /Keychain access was denied/);
    assert.equal(await launch.credentialFile(), undefined, "a refused unlock does not authorize the server");
    assert.equal(seen.at(-1)!.kind, "register", "and the server is republished, so the card still says why");
  } finally {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unlock refused by a locked secret store says why, though the backend reports a generic failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-keyring-"));
  const seeds = path.join(root, "seeds"),
    seed = path.join(seeds, "example");
  await mkdir(seeds);
  await cp(source, seed, { recursive: true });
  const manifest = await manifestOf();
  manifest.capabilities.push("credentials");
  manifest.actions.push(
    ...["connect", "unlock", "disconnect"].map((name) => ({
      name,
      label: name,
      confirmation: "Explicit account action",
    })),
    { name: "status", label: "Status" },
  );
  manifest.account = { connect: "connect", unlock: "unlock", disconnect: "disconnect", status: "status" };
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  // Like the Genex backend: whatever the host answers, the backend raises its own generic error.
  await writeFile(
    path.join(seed, "backend.mjs"),
    `export async function activate(){return {async action(n,a,c){if(n==='unlock'){try{await c.host('credentials.read',{});}catch{throw new Error('Saved account could not be unlocked. Automatic retries are paused.');}}return {};}};}`,
  );
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async () => {
      throw new SecretStorageUnavailableError(SecretStorageIssue.NoKeyring);
    },
  );
  try {
    await registry.init();
    await assert.rejects(registry.action("example", "unlock", {}), /Start GNOME Keyring or KWallet/);
    await assert.rejects(
      registry.action("example", "unlock", {}),
      /Start GNOME Keyring or KWallet/,
      "and says so again",
    );
  } finally {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test("successful browser credential save publishes MCP without unlock and launches reuse one memory lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-account-flow-"));
  const seeds = path.join(root, "seeds"),
    seed = path.join(seeds, "example");
  await mkdir(seeds);
  await cp(source, seed, { recursive: true });
  const manifest = await manifestOf();
  manifest.capabilities.push("credentials");
  manifest.actions.push(
    ...["connect", "unlock", "disconnect"].map((name) => ({
      name,
      label: name,
      confirmation: "Explicit account action",
    })),
    { name: "status", label: "Status" },
  );
  manifest.account = { connect: "connect", unlock: "unlock", disconnect: "disconnect", status: "status" };
  manifest.mcpServers = [mcpServer({ args: ["backend.mjs"], requires: { credential: true } })];
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(seed, "backend.mjs"),
    `export async function activate(){return {async action(n,a,c){if(n==='status'){await c.host('credentials.write',{token:'approved-token'});return {connected:true};}if(n==='unlock')await c.host('credentials.read',{});if(n==='disconnect')await c.host('credentials.clear',{});return {};}};}`,
  );
  let reads = 0,
    writes = 0;
  let token: string | null = "saved-token";
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async (id, method, args) => {
      if (method === "credentials.read") {
        reads++;
        return token;
      }
      if (method === "credentials.write") {
        writes++;
        token = args.token;
        return;
      }
      if (method === "credentials.clear") {
        token = null;
        return;
      }
      throw new Error("Unexpected service " + method);
    },
  );
  let launch: PluginMcpLaunch | undefined;
  let publications = 0;
  registry.mcpHost = {
    register: (_id, _servers, l) => {
      launch = l;
      publications++;
    },
    unregister: () => {},
  };
  try {
    await registry.init();
    await registry.syncMcpServers();
    assert.equal(await registry.accountState("example"), "locked");
    assert.equal(reads, 0, "reading account readiness never opens credential storage");
    await assert.rejects(registry.action("example", "status", {}), /Explicit account connection/);
    await registry.action("example", "connect", {});
    const before = publications;
    await registry.action("example", "status", {});
    assert.equal(await registry.accountState("example"), "unlocked");
    assert.ok(publications > before, "finishing browser authorization republishes the servers");
    assert.equal(await launch!.credentialFile(), "GENEX_TOKEN=approved-token\n");
    assert.equal(await launch!.credentialFile(), "GENEX_TOKEN=approved-token\n");
    assert.equal(reads, 0, "a new sign-in never needs to reread its saved token");
    assert.equal(writes, 1);
    await registry.action("example", "unlock", {});
    assert.equal(reads, 0, "unlock of the current lease is idempotent");
    await registry.setEnabled("example", false);
    assert.equal(await launch!.credentialFile(), undefined);
    assert.equal(
      await registry.accountState("example"),
      "locked",
      "backend enablement and account unlock are separate",
    );
    await registry.setEnabled("example", true);
    await registry.action("example", "unlock", {});
    assert.equal(reads, 1);
    await registry.syncMcpServers();
    await launch!.credentialFile();
    await launch!.credentialFile();
    assert.equal(reads, 1, "status and repeated child launches do not prompt again");
    await registry.action("example", "disconnect", {});
    await registry.action("example", "unlock", {});
    assert.equal(
      await registry.accountState("example"),
      "not connected",
      "an empty OS store is not an authenticated account",
    );
  } finally {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled seed upgrades are offered explicitly and removed seeds never resurrect", async () => {
  const f = await fixture();
  try {
    const original = f.registry.list()[0]!.manifest.version;
    const manifest = JSON.parse(await readFile(path.join(f.seeds, "example", "plugin.json"), "utf8"));
    manifest.version = "9.0.0";
    await writeFile(path.join(f.seeds, "example", "plugin.json"), JSON.stringify(manifest));
    f.registry.cancel();
    const next = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, (id, m, a, b) =>
      f.services.call(id, m, a, b),
    );
    try {
      await next.init();
      assert.equal(next.list()[0]!.manifest.version, original);
      assert.equal(next.list()[0]!.availableVersion, "9.0.0");
      await next.restore("example", manifest.capabilities);
      assert.equal(next.list()[0]!.manifest.version, "9.0.0");
      await next.remove("example");
      await next.init();
      assert.equal(next.list()[0]!.removed, true);
      assert.equal(next.list()[0]!.availableVersion, undefined);
    } finally {
      next.cancel();
    }
  } finally {
    await f.close();
  }
});

test("successful account unlock survives host restart, denied restoration never loops, disconnect stays disconnected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-remember-account-")),
    seeds = path.join(root, "seeds"),
    seed = path.join(seeds, "example");
  await mkdir(seeds);
  await cp(source, seed, { recursive: true });
  const manifest = await manifestOf();
  manifest.capabilities.push("credentials");
  manifest.account = { connect: "connect", unlock: "unlock", disconnect: "disconnect", status: "status" };
  manifest.actions.push(
    ...["connect", "unlock", "disconnect", "status"].map((name) => ({
      name,
      label: name,
      ...(name === "status" ? {} : { confirmation: "Connect account" }),
    })),
  );
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(seed, "backend.mjs"),
    `export async function activate(){return {async action(n,a,c){if(n==='unlock')await c.host('credentials.read',{});if(n==='disconnect')await c.host('credentials.clear',{});return {};}};}`,
  );
  let reads = 0,
    denied = false,
    token: string | null = "saved-token";
  const registries: PluginRegistry[] = [];
  const make = () => {
    const r = new PluginRegistry(
      path.join(root, "installed"),
      seeds,
      path.resolve("src/plugin-sdk/backend.mjs"),
      async (_id, m) => {
        if (m === "credentials.read") {
          reads++;
          if (denied) throw new Error("OS refused");
          return token;
        }
        if (m === "credentials.clear") {
          token = null;
          return;
        }
        throw new Error(m);
      },
    );
    registries.push(r);
    return r;
  };
  try {
    const first = make();
    await first.init();
    assert.equal(reads, 0);
    await first.action("example", "unlock", {});
    assert.equal(reads, 1);
    first.cancel();
    const second = make();
    await second.init();
    assert.equal(await second.accountState("example"), "unlocked");
    assert.equal(reads, 2);
    await second.accountState("example");
    assert.equal(reads, 2);
    second.cancel();
    denied = true;
    const refused = make();
    await refused.init();
    assert.equal(await refused.accountState("example"), "failed");
    await refused.accountState("example");
    assert.equal(reads, 3);
    refused.cancel();
    denied = false;
    const third = make();
    await third.init();
    await third.action("example", "disconnect", {});
    third.cancel();
    const fourth = make();
    await fourth.init();
    assert.equal(await fourth.accountState("example"), "locked");
    assert.equal(reads, 4);
    assert.equal(token, null);
  } finally {
    for (const r of registries) r.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test("connect reusing a saved account persists restart restoration and disconnect intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-remember-account-")),
    seeds = path.join(root, "seeds"),
    seed = path.join(seeds, "example");
  await mkdir(seeds);
  await cp(source, seed, { recursive: true });
  const manifest = await manifestOf();
  manifest.capabilities.push("credentials");
  manifest.account = { connect: "connect", unlock: "unlock", disconnect: "disconnect", status: "status" };
  manifest.actions.push(
    ...["connect", "unlock", "disconnect", "status"].map((name) => ({
      name,
      label: name,
      ...(name === "status" ? {} : { confirmation: "Connect account" }),
    })),
  );
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(seed, "backend.mjs"),
    `export async function activate(){return {async action(n,a,c){if(n==='unlock'||n==='connect')await c.host('credentials.read',{});if(n==='disconnect')await c.host('credentials.clear',{});return {};}};}`,
  );
  let reads = 0,
    denied = false,
    token: string | null = "saved-token";
  const registries: PluginRegistry[] = [];
  const make = () => {
    const r = new PluginRegistry(
      path.join(root, "installed"),
      seeds,
      path.resolve("src/plugin-sdk/backend.mjs"),
      async (_id, m) => {
        if (m === "credentials.read") {
          reads++;
          if (denied) throw new Error("OS refused");
          return token;
        }
        if (m === "credentials.clear") {
          token = null;
          return;
        }
        throw new Error(m);
      },
    );
    registries.push(r);
    return r;
  };
  try {
    const first = make();
    await first.init();
    assert.equal(reads, 0);
    await Promise.all([first.action("example", "connect", {}), first.action("example", "connect", {})]);
    assert.equal(reads, 1, "concurrent connection requests share one credential read");
    first.cancel();
    const second = make();
    await second.init();
    assert.equal(await second.accountState("example"), "unlocked");
    assert.equal(reads, 2);
    await second.accountState("example");
    assert.equal(reads, 2);
    second.cancel();
    denied = true;
    const refused = make();
    await refused.init();
    assert.equal(await refused.accountState("example"), "failed");
    await refused.accountState("example");
    assert.equal(reads, 3);
    refused.cancel();
    denied = false;
    const third = make();
    await third.init();
    await third.action("example", "disconnect", {});
    third.cancel();
    const fourth = make();
    await fourth.init();
    assert.equal(await fourth.accountState("example"), "locked");
    assert.equal(reads, 4);
    assert.equal(token, null);
  } finally {
    for (const r of registries) r.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test("re-enable and reinstall restore prior account consent once without retrying denied access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-account-lifecycle-")),
    seeds = path.join(root, "seeds"),
    seed = path.join(seeds, "example");
  await mkdir(seeds);
  await cp(source, seed, { recursive: true });
  const manifest = await manifestOf();
  manifest.capabilities.push("credentials");
  manifest.account = { connect: "connect", unlock: "unlock", disconnect: "disconnect", status: "status" };
  manifest.actions.push(
    ...["connect", "unlock", "disconnect", "status"].map((name) => ({
      name,
      label: name,
      ...(name === "disconnect" ? { confirmation: "Disconnect account" } : {}),
    })),
  );
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(seed, "backend.mjs"),
    `export async function activate(){return {async action(n,a,c){if(n==='connect')await c.host('credentials.read',{});if(n==='disconnect')await c.host('credentials.clear',{});return {};}};}`,
  );
  let reads = 0,
    denied = false,
    token: string | null = "saved-token";
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    seeds,
    path.resolve("src/plugin-sdk/backend.mjs"),
    async (_id, method) => {
      if (method === "credentials.read") {
        reads++;
        if (denied) throw Error("OS refused");
        return token;
      }
      if (method === "credentials.clear") {
        token = null;
        return;
      }
      throw Error(method);
    },
  );
  try {
    await registry.init();
    await registry.setEnabled("example", false);
    await registry.setEnabled("example", true);
    assert.equal(reads, 0, "enable alone cannot grant account consent");
    await registry.action("example", "connect", {});
    assert.equal(reads, 1);
    await registry.setEnabled("example", false);
    assert.equal(await registry.accountState("example"), "locked");
    await registry.setEnabled("example", true);
    assert.equal(await registry.accountState("example"), "unlocked");
    assert.equal(reads, 2);
    await registry.remove("example");
    await registry.restore("example", manifest.capabilities);
    assert.equal(await registry.accountState("example"), "unlocked");
    assert.equal(reads, 3);
    denied = true;
    await registry.setEnabled("example", false);
    await registry.setEnabled("example", true);
    assert.equal(await registry.accountState("example"), "failed");
    assert.equal(reads, 4);
    await registry.setEnabled("example", true);
    await registry.action("example", "status", {});
    assert.equal(reads, 4, "duplicate enable and status cannot retry denied credential access");
    denied = false;
    await registry.action("example", "disconnect", {});
    await registry.setEnabled("example", false);
    await registry.setEnabled("example", true);
    await registry.remove("example");
    await registry.restore("example", manifest.capabilities);
    assert.equal(reads, 4, "explicit disconnect prevents later restoration");
    assert.equal(token, null);
  } finally {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * R5: an installed bundled plugin is replaced only through an offered update, and one is offered
 * only for a newer version. This build's Genex (publish settle, "Allow a new upload", telemetry
 * off) must reach a profile that still holds the last released Genex, 1.4.2.
 */
test("a profile holding the last released Genex is offered this build's Genex", async () => {
  const { makeResources } = await import("../helpers/resources.ts");
  const resources = await makeResources();
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-update-"));
  const released = path.join(root, "released");
  await mkdir(released);
  await cp(path.join(resources, "plugins", "genex"), path.join(released, "genex"), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(released, "genex", "plugin.json"), "utf8"));
  manifest.version = "1.4.2";
  await writeFile(path.join(released, "genex", "plugin.json"), JSON.stringify(manifest));
  const installed = path.join(root, "installed");
  const bootstrap = path.join(resources, "plugin-sdk", "backend.mjs");
  const before = new PluginRegistry(installed, released, bootstrap, async () => null);
  try {
    await before.init();
  } finally {
    before.cancel();
  }
  const after = new PluginRegistry(installed, path.join(resources, "plugins"), bootstrap, async () => null);
  try {
    await after.init();
    const genex = after.list().find((p) => p.manifest.id === "genex")!;
    assert.equal(genex.manifest.version, "1.4.2", "the installed copy stays until the user updates");
    assert.ok(genex.availableVersion, "an update to this build's Genex is offered");
  } finally {
    after.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

/** Every page of one Genex skill read, joined. */
async function readGenexSkill(registry: PluginRegistry, name: string, binding: { project: string; directory: string }) {
  let text = "";
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = (await registry.tool("genex__skill", { name, offset }, binding)) as {
      text: string;
      nextOffset?: number;
    };
    text += page.text;
    offset = page.nextOffset;
  }
  return text;
}

/**
 * The built Genex payload gives agents its vendored skills as index lines and serves each one, preface
 * first, through genex__skill in the host. Disabled, it gives nothing. Neither state writes agent
 * skill folders or contracts into the game.
 */
test("bundled Genex indexes its vendored skills, serves them through genex__skill, and withdraws them when disabled", async () => {
  const { makeResources } = await import("../helpers/resources.ts");
  const { splitVendoredSkill } = await import("../../scripts/refresh-genex-skills.ts");
  const resources = await makeResources({ tsc: false });
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-skills-"));
  const game = path.join(root, "game");
  await mkdir(game);
  const binding = { project: "game", directory: game };
  const vendor = JSON.parse(await readFile(path.resolve("src/plugins/genex/skills/vendor.json"), "utf8"));
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    path.join(resources, "plugins"),
    path.join(resources, "plugin-sdk", "backend.mjs"),
    async () => null,
  );
  const noAgentFiles = async () => {
    for (const entry of [".claude", ".agents", "AGENTS.md"])
      await assert.rejects(stat(path.join(game, entry)), { code: "ENOENT" }, entry);
  };
  try {
    await registry.init();
    const guidance = registry.guidance();
    assert.match(guidance, /\[genex\/genex-threejs-multiplayer\] [^\n]*MANDATORY before networking code/);
    assert.match(guidance, /genex__skill \{"name":"genex-threejs-multiplayer"\}/);
    assert.doesNotMatch(guidance, /Two rules that decide whether it feels good/, "a card's body is never in the brief");
    assert.doesNotMatch(guidance, /\[genex\/asset-workflow\]/, "the duplicate of the asset tool's description is gone");
    const tools = registry.tools().filter((t) => t.name.startsWith("genex__"));
    for (const text of [guidance, ...tools.map((t) => t.description)]) assert.doesNotMatch(text, /npx genex/);
    const names = tools.map((t) => t.name);
    for (const name of ["genex__skill", "genex__cli", "genex__cli-paid", "genex__package"])
      assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
    const multiplayer = splitVendoredSkill(await readGenexSkill(registry, "genex-threejs-multiplayer", binding));
    const preface = await readFile(
      path.resolve("src/plugins/genex/skills/genex-threejs-multiplayer/PREFACE.md"),
      "utf8",
    );
    assert.equal(multiplayer.preface, preface, "the Studio preface comes first");
    assert.equal(
      createHash("sha256").update(multiplayer.upstream).digest("hex"),
      vendor.files["genex-threejs-multiplayer/SKILL.md"].sha256,
    );
    await noAgentFiles();
    await registry.setEnabled("genex", false);
    assert.doesNotMatch(registry.guidance(), /\[genex\//);
    assert.ok(!registry.tools().some((t) => t.name.startsWith("genex__")));
    await assert.rejects(
      registry.tool("genex__skill", { name: "genex-threejs-multiplayer" }, binding),
      /Plugin genex is unavailable/,
    );
    await noAgentFiles();
  } finally {
    registry.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test("a name that breaks the id rule is refused with the rule, so get_scene is fixable from the error alone", async () => {
  const manifest = await manifestOf();
  const [tool] = manifest.tools;
  const named: Array<[string, Record<string, unknown>]> = [
    ["tool", { tools: [{ ...tool, name: "get_scene" }] }],
    ["action", { actions: [{ name: "Run_It", label: "Run" }] }],
    ["setting", { settings: [{ key: "api_key", label: "Key", type: "string", default: "" }] }],
    ["panel", { panels: [{ id: "My Panel", title: "Panel", file: "panel.html", placement: "settings" }] }],
    ["plugin skill", { skills: [{ name: "how_to", text: "Use it." }] }],
  ];
  for (const [kind, change] of named)
    assert.throws(
      () => validateManifest({ ...manifest, ...change }),
      new RegExp(`Invalid ${kind} name .*lowercase letters, digits and hyphens`),
      kind,
    );
});

test("a plugin server whose connector id would be too long is refused by the manifest, where doctor sees it", async () => {
  const manifest = await manifestOf();
  const withServer = (id: string, server: string) => ({ ...manifest, id, mcpServers: [mcpServer({ id: server })] });
  // `<plugin>-<server>` becomes the connector id, which is at most 32 characters.
  assert.throws(() => validateManifest(withServer("a-long-plugin-name-for-tools", "server")), /connector id/);
  assert.doesNotThrow(() => validateManifest(withServer("short-plugin", "server")));
});

/**
 * What a plugin leaves behind across versions: old package copies and failed-install leftovers are
 * swept (PLG-5), a hot reload cannot change what a plugin's MCP servers run without a new review
 * (PLG-6), stored settings reach a new version only as declared keys of the declared type (PLG-7),
 * and a `node` MCP server is handed its credential as the bare token (PLG-4).
 */
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { PluginChange } from "../../src/shared/plugins.ts";
import { PluginRegistry, type PluginMcpLaunch } from "../../src/substrate/plugins/registry.ts";
import { pluginBackendEnv } from "../../src/substrate/plugins/process.ts";
import { scanPackage } from "../../src/substrate/plugins/scan.ts";
import {
  EXAMPLE_PLUGIN,
  copyOfExample,
  installLocalOn,
  type PluginFixture,
  pluginFixture,
} from "../helpers/plugins.ts";

test("a plugin backend starts with the basics and nothing else of Studio's environment, on Windows too", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/Users/ada",
    TMPDIR: "/tmp/ada",
    GITHUB_TOKEN: "leak",
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\Ada",
    APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    PATHEXT: ".EXE;.CMD",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    ProgramData: "D:\\ProgramData",
    ProgramFiles: "D:\\Program Files",
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
  };
  const mac = pluginBackendEnv(parent, "darwin");
  assert.deepEqual(Object.keys(mac).sort(), ["ELECTRON_RUN_AS_NODE", "HOME", "PATH", "TMPDIR"]);
  const { PATH: _unused, ...windowsParent } = parent;
  const windows = pluginBackendEnv({ ...windowsParent, Path: "C:\\Windows" }, "win32");
  assert.equal(windows.PATH, "C:\\Windows", "PATH is read whatever its case");
  for (const name of [
    "SystemRoot",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "PATHEXT",
    "ComSpec",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ])
    assert.equal(windows[name], parent[name as keyof typeof parent], name);
  assert.equal(windows.GITHUB_TOKEN, undefined);
  // A development test of Unity's setup card gives the backend a made-up Mac to look in.
  const testMac = pluginBackendEnv({ ...parent, STUDIO_ENGINE_TEST_ROOT: "/tmp/test-mac" }, "darwin");
  assert.equal(testMac.STUDIO_ENGINE_TEST_ROOT, "/tmp/test-mac");
});

/** A local plugin whose every action answers with the PATH its backend was started with. */
async function installPathProbe(f: PluginFixture): Promise<void> {
  const probe = await copyOfExample(f.root, "probe", (m) => {
    m.id = "probe";
    m.name = "PATH probe";
  });
  await writeFile(
    path.join(probe, "backend.mjs"),
    "export async function activate() { return { async action() { return { path: process.env.PATH }; } }; }\n",
  );
  await installLocalOn(f.registry, probe);
}

test("a plugin backend finds the user's tools on the login PATH, not the Finder's bare one", async () => {
  const loginPath = "/Users/ada/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin";
  assert.equal(pluginBackendEnv({ PATH: "/usr/bin:/bin" }, "darwin", loginPath).PATH, loginPath);
  const f = await pluginFixture();
  try {
    await installPathProbe(f);
    f.registry.toolPath = async () => loginPath;
    assert.deepEqual(await f.registry.action("probe", "count", {}), { path: loginPath });
  } finally {
    await f.close();
  }
});

test("a plugin backend keeps Studio's own PATH when the login shell cannot answer", async () => {
  const f = await pluginFixture();
  try {
    await installPathProbe(f);
    f.registry.toolPath = async () => {
      throw new Error("login shell timed out");
    };
    assert.deepEqual(await f.registry.action("probe", "count", {}), { path: process.env.PATH });
  } finally {
    await f.close();
  }
});

const packageCopies = async (registry: PluginRegistry, id: string) =>
  (await readdir(path.join(registry.root, "packages", id)).catch(() => [] as string[])).sort();

test("an update removes the package copy it replaced", async () => {
  const f = await pluginFixture({ installed: "local" });
  try {
    assert.equal((await packageCopies(f.registry, "example")).length, 1);
    await f.registry.installLocal(
      await copyOfExample(f.root, "v2", (m) => {
        m.version = "1.1.0";
      }),
    );
    const copies = await packageCopies(f.registry, "example");
    assert.equal(copies.length, 1, copies.join(", "));
    assert.match(copies[0]!, /^1\.1\.0-/);
    assert.deepEqual(
      await f.registry.tool("example__greet", { name: "Ada" }, f.binding),
      { text: "Hello Ada", project: "game" },
      "the running version is the one kept",
    );
  } finally {
    await f.close();
  }
});

test("an update superseded while the plugin was leased leaves no copy behind", async () => {
  const f = await pluginFixture({ installed: "local" });
  try {
    const release = f.registry.lease();
    await f.registry.installLocal(
      await copyOfExample(f.root, "v2", (m) => {
        m.version = "1.1.0";
      }),
    );
    await f.registry.installLocal(
      await copyOfExample(f.root, "v3", (m) => {
        m.version = "1.2.0";
      }),
    );
    assert.equal((await packageCopies(f.registry, "example")).length, 2, "the running copy and the one pending");
    await release();
    const copies = await packageCopies(f.registry, "example");
    assert.equal(copies.length, 1, copies.join(", "));
    assert.match(copies[0]!, /^1\.2\.0-/);
  } finally {
    await f.close();
  }
});

test("start-up sweeps copies no record points to and staging leftovers, but never unlisted code", async () => {
  const f = await pluginFixture();
  try {
    const packages = path.join(f.registry.root, "packages");
    await cp(EXAMPLE_PLUGIN, path.join(packages, "example", "0.9.0-crashed-before-activation"), { recursive: true });
    await mkdir(path.join(f.registry.root, "staging", "left-by-a-crash"), { recursive: true });
    await cp(EXAMPLE_PLUGIN, path.join(packages, "dropped", "x"), { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(packages, "dropped", "x", "plugin.json"), "utf8"));
    await writeFile(path.join(packages, "dropped", "x", "plugin.json"), JSON.stringify({ ...manifest, id: "dropped" }));
    f.registry.cancel();
    const next = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, async () => null);
    await next.init();
    try {
      const copies = await packageCopies(next, "example");
      assert.equal(copies.length, 1, copies.join(", "));
      assert.ok(!copies.includes("0.9.0-crashed-before-activation"));
      assert.deepEqual(await readdir(path.join(next.root, "staging")).catch(() => []), []);
      assert.deepEqual(
        await packageCopies(next, "dropped"),
        ["x"],
        "code dropped without a record stays listed for the user to allow",
      );
      assert.equal(next.list().find((p) => p.manifest.id === "dropped")?.unlisted, true);
      assert.deepEqual(await next.tool("example__greet", { name: "Ada" }, f.binding), {
        text: "Hello Ada",
        project: "game",
      });
    } finally {
      next.cancel();
    }
  } finally {
    await f.close();
  }
});

/** A registry whose folder watcher is driven by the test: fs.watch is best effort and needs file handles. */
function manualWatch(registry: PluginRegistry) {
  const changed: Array<() => void> = [];
  registry.watchFolder = (_directory, onChange) => {
    changed.push(onChange);
    return { close() {} };
  };
  const changes: PluginChange[] = [];
  registry.onChange = (change) => changes.push(change);
  /** Resolves once a change for `reason` arrives at or after index `from` of `changes`. */
  const next = (reason: PluginChange["reason"], from = 0) =>
    new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`no ${reason} change`));
      }, 5000);
      const poll = setInterval(() => {
        if (changes.slice(from).some((c) => c.reason === reason)) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 20);
    });
  return {
    fire: () => {
      for (const onChange of changed) onChange();
    },
    changes,
    next,
  };
}

test("a hot reload that changes what a plugin's MCP servers run is refused until the folder is loaded again", async () => {
  const f = await pluginFixture();
  try {
    const server = {
      id: "echo",
      transport: "stdio",
      command: "node",
      args: ["backend.mjs"],
      cwd: "storage",
      description: "Echo.",
    };
    const dir = await copyOfExample(f.root, "watched", (m) => {
      m.id = "watched";
      m.name = "Watched";
      m.mcpServers = [server];
    });
    await installLocalOn(f.registry, dir);
    const watch = manualWatch(f.registry);
    await f.registry.watch("watched", true);

    const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    await writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ ...manifest, mcpServers: [{ ...server, args: ["other.mjs"] }] }),
    );
    await writeFile(path.join(dir, "other.mjs"), "");
    watch.fire();
    await watch.next("failed");
    const info = f.registry.list().find((p) => p.manifest.id === "watched")!;
    assert.match(info.error ?? "", /MCP servers changed; load the folder again to review/);
    assert.deepEqual(
      info.manifest.mcpServers?.[0]?.args,
      ["backend.mjs"],
      "the reviewed declaration is still the one installed",
    );

    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ ...manifest, version: "1.0.1" }));
    watch.fire();
    await watch.next("reloaded");
    assert.equal(
      f.registry.list().find((p) => p.manifest.id === "watched")!.manifest.version,
      "1.0.1",
      "an edit that leaves the servers alone still reloads",
    );
  } finally {
    await f.close();
  }
});

test("a hot reload that edits, adds or removes skills says which, by name, and the plugin keeps the last change", async () => {
  const f = await pluginFixture();
  try {
    // The host scans every reload: the digests are what tell a file skill's edited bytes apart.
    f.registry.scan = scanPackage;
    const dir = await copyOfExample(f.root, "skilled", (m) => {
      m.id = "skilled";
      m.name = "Skilled";
      m.apiVersion = 3;
      m.skills.push({ name: "card", summary: "A card.", file: "skills/card.md" });
    });
    await mkdir(path.join(dir, "skills"));
    await writeFile(path.join(dir, "skills", "card.md"), "# Card\n");
    await installLocalOn(f.registry, dir);
    const watch = manualWatch(f.registry);
    await f.registry.watch("skilled", true);
    const reload = async () => {
      const seen = watch.changes.length;
      watch.fire();
      await watch.next("reloaded", seen);
      const change = watch.changes.slice(seen).find((c) => c.reason === "reloaded");
      return {
        change: change?.skills,
        info: f.registry.list().find((p) => p.manifest.id === "skilled")?.lastSkillChange,
      };
    };
    const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    const rewrite = (m: unknown) => writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));

    await rewrite({ ...manifest, skills: [{ ...manifest.skills[0], text: "Greet in French." }, manifest.skills[1]] });
    const inline = { added: [], changed: ["greeting"], removed: [] };
    assert.deepEqual(await reload(), { change: inline, info: inline }, "an inline skill's new text is named");

    await writeFile(path.join(dir, "skills", "card.md"), "# Card\n\nNew advice.\n");
    const file = { added: [], changed: ["card"], removed: [] };
    assert.deepEqual(await reload(), { change: file, info: file }, "a file skill's new bytes are named");

    await rewrite({ ...manifest, skills: [manifest.skills[1], { name: "extra", text: "More." }] });
    const swapped = { added: ["extra"], changed: [], removed: ["greeting"] };
    assert.deepEqual(await reload(), { change: swapped, info: swapped });

    await rewrite({ ...manifest, version: "1.0.1", skills: [manifest.skills[1], { name: "extra", text: "More." }] });
    assert.deepEqual(
      await reload(),
      { change: undefined, info: undefined },
      "a reload that leaves skills alone names none",
    );
  } finally {
    await f.close();
  }
});

test("an update that waited on a lease when Studio closed still says which skills it changed after the restart", async () => {
  const f = await pluginFixture({ installed: "local" });
  try {
    f.registry.lease();
    await f.registry.installLocal(
      await copyOfExample(f.root, "v2", (m) => {
        m.version = "1.1.0";
        m.skills = [
          { ...m.skills[0], text: "Greet in French." },
          { name: "extra", text: "More." },
        ];
      }),
    );
    assert.equal(f.registry.list().find((p) => p.manifest.id === "example")?.manifest.version, "1.0.0", "leased");
    f.registry.cancel();
    const restarted = new PluginRegistry(f.registry.root, f.seeds, f.registry.bootstrap, async () => ({}));
    await restarted.init();
    const example = restarted.list().find((p) => p.manifest.id === "example");
    restarted.cancel();
    assert.equal(example?.manifest.version, "1.1.0", "the waiting update took effect at startup");
    assert.deepEqual(example?.lastSkillChange, { added: ["extra"], changed: ["greeting"], removed: [] });
  } finally {
    await f.close();
  }
});

test("stored settings reach a new version only as declared keys of the declared type", async () => {
  const f = await pluginFixture({ installed: "local" });
  try {
    await f.registry.setSetting("example", "greeting", "Hi");
    const data = path.join(f.registry.root, "data", "example", "settings.json");
    await writeFile(data, JSON.stringify({ ...JSON.parse(await readFile(data, "utf8")), removed: "left over" }));
    await f.registry.installLocal(
      await copyOfExample(f.root, "v2", (m) => {
        m.version = "1.1.0";
        m.settings = [
          { key: "greeting", label: "Greeting", type: "number", default: 2 },
          { key: "mood", label: "Mood", type: "string", default: "calm" },
        ];
      }),
    );
    assert.deepEqual(
      await f.registry.settings("example"),
      { greeting: 2, mood: "calm" },
      "a retyped key falls back to its default; a removed key is gone",
    );
    await f.registry.setSetting("example", "mood", "bright");
    assert.deepEqual(
      JSON.parse(await readFile(data, "utf8")),
      { greeting: 2, mood: "bright" },
      "the next save drops what the plugin no longer declares",
    );
  } finally {
    await f.close();
  }
});

test("a node MCP server's credential is the bare token, and only after an explicit unlock", async () => {
  const f = await pluginFixture();
  try {
    const dir = await copyOfExample(f.root, "acct", (m) => {
      m.id = "acct";
      m.capabilities.push("credentials");
      m.actions.push({ name: "unlock", label: "Unlock", confirmation: "Unlock the saved account." });
      m.mcpServers = [
        {
          id: "echo",
          transport: "stdio",
          command: "node",
          args: ["backend.mjs"],
          cwd: "storage",
          env: { TOKEN_FILE: "credential-file" },
          requires: { credential: true },
          description: "Echo.",
        },
      ];
    });
    const registry = new PluginRegistry(
      path.join(f.root, "acct-installed"),
      f.seeds,
      f.registry.bootstrap,
      async (_id, method) => {
        if (method === "credentials.read") return "tok=with/symbols==";
        if (method === "storage.root") return path.join(f.root, "acct-data");
        throw new Error(`unexpected host service ${method}`);
      },
    );
    try {
      await registry.init();
      await installLocalOn(registry, dir);
      let launch: PluginMcpLaunch | undefined;
      registry.mcpHost = {
        register: (_id, _servers, l) => {
          launch = l;
        },
        unregister: () => {},
      };
      await registry.syncMcpServers();
      assert.equal(await launch!.credential(), undefined);
      await registry.action("acct", "unlock", {});
      assert.equal(
        await launch!.credential(),
        "tok=with/symbols==",
        "no GENEX_TOKEN= framing for a third-party server",
      );
      assert.equal(
        await launch!.credentialFile(),
        "GENEX_TOKEN=tok=with/symbols==\n",
        "the env-file line stays for Studio's own Genex CLI",
      );
    } finally {
      registry.cancel();
    }
  } finally {
    await f.close();
  }
});

test("the tokens plugin accounts hold this session are known to the log redactor, and only while unlocked (SEC-1)", async () => {
  const f = await pluginFixture();
  try {
    const dir = await copyOfExample(f.root, "acct", (m) => {
      m.id = "acct";
      m.capabilities.push("credentials");
      m.actions.push({ name: "unlock", label: "Unlock", confirmation: "Unlock the saved account." });
    });
    const registry = new PluginRegistry(
      path.join(f.root, "acct-installed"),
      f.seeds,
      f.registry.bootstrap,
      async (_id, method) => {
        if (method === "credentials.read") return "held-plugin-FAKE-token";
        if (method === "storage.root") return path.join(f.root, "acct-data");
        throw new Error(`unexpected host service ${method}`);
      },
    );
    try {
      await registry.init();
      await installLocalOn(registry, dir);
      assert.deepEqual(registry.heldCredentials(), [], "nothing is read from the saved account to answer this");
      await registry.action("acct", "unlock", {});
      assert.deepEqual(registry.heldCredentials(), ["held-plugin-FAKE-token"]);
      await registry.setEnabled("acct", false);
      assert.deepEqual(registry.heldCredentials(), [], "a locked account's token is no longer held");
    } finally {
      registry.cancel();
    }
  } finally {
    await f.close();
  }
});

/**
 * The app's account plugin (Genex): its account and the actions the host names (sign-in, Publish)
 * belong to the person, so turning the plugin off takes only its agent-facing parts away. Another
 * plugin's account still locks when it is turned off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { removeTree } from "../helpers/tmp.ts";

/** The actions the host keeps for the account plugin while it is off. */
const KEPT = ["status", "connect", "unlock", "disconnect", "cancel", "publish"];

/**
 * A backend with an account: connect starts a browser sign-in, status saves the approved token,
 * publish stands for Publish, and tidy for an action the plugin keeps to itself.
 */
const BACKEND = `export async function activate(){return {
  async review(){return {message:'Publish this game?'};},
  async action(n,a,c){
    if(n==='connect'){await c.host('credentials.read',{});return {userCode:'ABCD-1234'};}
    if(n==='status'){if(a&&a.approve)await c.host('credentials.write',{token:'approved-token'});return {connected:true,pid:process.pid};}
    if(n==='unlock')await c.host('credentials.read',{});
    if(n==='disconnect')await c.host('credentials.clear',{});
    if(n==='publish')return {published:true};
    if(n==='tidy')return {tidied:true};
    return {};
  }};}`;

interface AccountFixture {
  root: string;
  /** A registry over the fixture's folders and token store; `account` names the app's account plugin. */
  open(account?: string): Promise<PluginRegistry>;
  /** The saved token, as the host's credential store holds it. */
  saved(): string | null;
  /** Whether the plugin's servers are published to the MCP host right now. */
  published(): boolean;
  close(): Promise<void>;
}

/** The example plugin as an account plugin with Publish, seeded as Studio's own. */
async function accountFixture(): Promise<AccountFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-app-account-"));
  const seed = path.join(root, "seeds", "example");
  await mkdir(path.dirname(seed), { recursive: true });
  await cp(EXAMPLE_PLUGIN, seed, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(seed, "plugin.json"), "utf8")) as PluginManifest;
  manifest.capabilities.push("credentials");
  manifest.actions.push(
    ...["status", "connect", "unlock", "cancel", "tidy"].map((name) => ({ name, label: name })),
    { name: "disconnect", label: "disconnect", confirmation: "Sign out" },
    { name: "publish", label: "Publish", confirmation: "Put this game online" },
  );
  manifest.account = {
    connect: "connect",
    unlock: "unlock",
    disconnect: "disconnect",
    status: "status",
    cancel: "cancel",
  };
  manifest.mcpServers = [
    {
      id: "main",
      transport: "stdio",
      command: "node",
      args: ["backend.mjs"],
      cwd: "storage",
      description: "The account's own server.",
      requires: { credential: true },
    } as NonNullable<PluginManifest["mcpServers"]>[number],
  ];
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(seed, "backend.mjs"), BACKEND);
  let token: string | null = null;
  let servers = false;
  const registries: PluginRegistry[] = [];
  return {
    root,
    async open(account) {
      const registry = new PluginRegistry(
        path.join(root, "installed"),
        path.join(root, "seeds"),
        PLUGIN_SDK_BACKEND,
        async (_id, method, args) => {
          if (method === "credentials.read") return token;
          if (method === "credentials.write") token = args.token;
          else if (method === "credentials.clear") token = null;
          else if (method !== "storage.root") throw new Error(`Unexpected service ${method}`);
          return method === "storage.root" ? path.join(root, "data") : undefined;
        },
      );
      if (account) registry.appAccount = { id: account, actions: KEPT };
      registry.mcpHost = {
        register: () => {
          servers = true;
        },
        unregister: () => {
          servers = false;
        },
      };
      registries.push(registry);
      await registry.init();
      await registry.syncMcpServers();
      return registry;
    },
    saved: () => token,
    published: () => servers,
    async close() {
      for (const registry of registries) registry.cancel();
      await removeTree(root);
    },
  };
}

/** Sign in as the person does: the browser sign-in starts, then the status read saves the token. */
async function signIn(registry: PluginRegistry): Promise<void> {
  await registry.action("example", "connect", {});
  await registry.action("example", "status", { approve: true });
}

test("turning the app's account plugin off keeps its account and its account actions", async () => {
  const f = await accountFixture();
  try {
    const registry = await f.open("example");
    await signIn(registry);
    assert.equal(await registry.hostCredential("example"), "approved-token");
    await registry.setEnabled("example", false);
    assert.equal(await registry.accountState("example"), "unlocked", "off never signs the person out");
    assert.equal(await registry.hostCredential("example"), "approved-token", "Play's calls keep the token");
    assert.deepEqual(registry.tools(), [], "the agent loses its tools");
    assert.equal(f.published(), false, "and its servers");
    assert.equal(await registry.hostCredentialFile("example").catch(() => undefined), undefined);
    assert.deepEqual(await registry.action("example", "publish", {}), { published: true }, "Publish still runs");
    assert.ok(await registry.review("example", "publish", {}), "and its review");
    assert.equal(registry.servesAction("example", "publish"), true);
    assert.equal(registry.servesAction("example", "tidy"), false);
    await assert.rejects(registry.action("example", "tidy", {}), /unavailable/, "an action it keeps to itself waits");
    await registry.setEnabled("example", true);
    assert.equal(f.published(), true, "back on, its servers come back with the account");
    assert.equal(registry.tools().length > 0, true);
  } finally {
    await f.close();
  }
});

test("a sign-in finishes while the app's account plugin is off, and leaves it off", async () => {
  const f = await accountFixture();
  try {
    const registry = await f.open("example");
    await registry.setEnabled("example", false);
    await signIn(registry);
    assert.equal(f.saved(), "approved-token");
    assert.equal(await registry.accountState("example"), "unlocked");
    assert.equal(await registry.hostCredential("example"), "approved-token");
    assert.equal(registry.enabled("example"), false, "turned off by the person, it stays off");
    await registry.action("example", "disconnect", {});
    assert.equal(f.saved(), null, "signing out while off clears the account");
    assert.equal(await registry.hostCredential("example"), undefined);
  } finally {
    await f.close();
  }
});

test("a saved account of the app's account plugin is restored at start while it is off", async () => {
  const f = await accountFixture();
  try {
    const first = await f.open("example");
    await signIn(first);
    await first.setEnabled("example", false);
    first.cancel();
    const second = await f.open("example");
    assert.equal(second.enabled("example"), false);
    assert.equal(await second.accountState("example"), "unlocked");
    assert.equal(await second.hostCredential("example"), "approved-token");
  } finally {
    await f.close();
  }
});

test("turning the app's account plugin off keeps its backend, so a Publish under way goes on", async () => {
  const f = await accountFixture();
  try {
    const registry = await f.open("example");
    const before = (await registry.action("example", "status", {})) as { pid: number };
    await registry.setEnabled("example", false);
    const after = (await registry.action("example", "status", {})) as { pid: number };
    assert.equal(after.pid, before.pid, "the same backend answers");
  } finally {
    await f.close();
  }
});

test("a sign-in turns the app's account plugin back on, unless the person turned it off", async () => {
  const f = await accountFixture();
  try {
    const first = await f.open("example");
    await first.setEnabled("example", false);
    assert.equal(await first.enableForSignIn("example"), false);
    assert.equal(first.enabled("example"), false, "the person's off stays");
    first.cancel();
    // Off without the person on record (a record that failed to load, an older profile): a sign-in turns it on.
    const file = path.join(f.root, "installed", "installed.json");
    const records = JSON.parse(await readFile(file, "utf8"));
    delete records.example.turnedOff;
    await writeFile(file, JSON.stringify(records));
    const second = await f.open("example");
    assert.equal(second.enabled("example"), false);
    assert.equal(await second.enableForSignIn("example"), true);
    assert.equal(second.enabled("example"), true);
    assert.equal(await second.enableForSignIn("example"), false, "already on");
  } finally {
    await f.close();
  }
});

test("a sign-in never turns on a plugin that isn't the app's account plugin", async () => {
  const f = await accountFixture();
  try {
    const registry = await f.open();
    const file = path.join(f.root, "installed", "installed.json");
    await registry.setEnabled("example", false);
    const records = JSON.parse(await readFile(file, "utf8"));
    delete records.example.turnedOff;
    await writeFile(file, JSON.stringify(records));
    registry.cancel();
    const reopened = await f.open();
    assert.equal(await reopened.enableForSignIn("example"), false);
    assert.equal(reopened.enabled("example"), false);
  } finally {
    await f.close();
  }
});

test("the app's account plugin can't be removed, only turned off", async () => {
  const f = await accountFixture();
  try {
    const registry = await f.open("example");
    await assert.rejects(registry.remove("example"), /turn it off/);
    const info = registry.list().find((p) => p.manifest.id === "example");
    assert.equal(info?.removed, false);
    assert.equal(info?.enabled, true);
  } finally {
    await f.close();
  }
});

test("another plugin's account still locks, and its actions wait, while it is off", async () => {
  const f = await accountFixture();
  try {
    const registry = await f.open("genex");
    await signIn(registry);
    await registry.setEnabled("example", false);
    assert.equal(await registry.accountState("example"), "locked");
    assert.equal(await registry.hostCredential("example"), undefined);
    assert.equal(registry.servesAction("example", "publish"), false);
    await assert.rejects(registry.action("example", "publish", {}), /unavailable/);
    await registry.remove("example");
    assert.equal(registry.list().find((p) => p.manifest.id === "example")?.removed, true);
  } finally {
    await f.close();
  }
});

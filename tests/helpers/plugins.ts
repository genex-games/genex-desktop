/**
 * Plugin registry fixtures: the bundled example plugin seeded into a throwaway registry with real
 * backend children, and copies of it with an edited manifest for install/update cases.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";

const repo = path.resolve(import.meta.dirname, "../..");
/** The bundled example plugin's source folder. */
export const EXAMPLE_PLUGIN = path.join(repo, "src/plugins/example");
export const PLUGIN_SDK_BACKEND = path.join(repo, "src/plugin-sdk/backend.mjs");

export interface PluginFixture {
  root: string;
  seeds: string;
  registry: PluginRegistry;
  binding: { project: string; directory: string };
  services: PluginServices;
  close(): Promise<void>;
}

/**
 * A registry with the example plugin, initialized, with a `game` binding at `root`. By default the
 * example is a bundled seed; `installed: 'local'` loads it from its folder instead, for suites that
 * update it from other local folders (a bundled id is Studio's alone and refuses those). `observe`
 * is the host's answer to the `observe` service (an empty object unless the test brings its own).
 */
export async function pluginFixture(
  options: { installed?: "bundled" | "local"; observe?: ConstructorParameters<typeof PluginServices>[2] } = {},
): Promise<PluginFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-plugins-"));
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  if (options.installed !== "local") await cp(EXAMPLE_PLUGIN, path.join(seeds, "example"), { recursive: true });
  const services = new PluginServices(path.join(root, "data"), {}, options.observe ?? (async () => ({})));
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, (id, m, a, b) =>
    services.call(id, m, a, b),
  );
  await registry.init();
  if (options.installed === "local") await registry.installLocal(EXAMPLE_PLUGIN, "local");
  const binding = { project: "game", directory: root };
  return {
    root,
    seeds,
    registry,
    binding,
    services,
    async close() {
      registry.cancel();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A copy of the example plugin at `root/name`, its `plugin.json` passed through `mutate`. */
export async function copyOfExample(root: string, name: string, mutate?: (manifest: any) => void): Promise<string> {
  const dir = path.join(root, name);
  await cp(EXAMPLE_PLUGIN, dir, { recursive: true });
  if (mutate) {
    const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    mutate(manifest);
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  }
  return dir;
}

/** An account plugin: `greet` answers with whatever `credentials.session` hands the backend. */
export async function accountPackage(
  root: string,
  name: string,
  publisher: string,
  mutate?: (manifest: any) => void,
): Promise<{ dir: string; manifest: PluginManifest }> {
  const dir = await copyOfExample(root, name, (m) => {
    m.id = "acct";
    m.name = `Account ${name}`;
    m.publisher = publisher;
    m.capabilities = ["settings", "credentials"];
    m.actions.push(
      ...["connect", "unlock", "disconnect"].map((action) => ({
        name: action,
        label: action,
        confirmation: "Explicit account action",
      })),
      { name: "status", label: "Status" },
    );
    m.account = { connect: "connect", unlock: "unlock", disconnect: "disconnect", status: "status" };
    mutate?.(m);
  });
  await writeFile(
    path.join(dir, "backend.mjs"),
    "export async function activate(){return {async tool(n,a,c){return {session:await c.host('credentials.session')};},async action(n,a,c){if(n==='unlock')await c.host('credentials.read',{});return {ok:true};}};}",
  );
  return { dir, manifest: JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8")) };
}

/**
 * A registry with no seeds whose host services are keyed by plugin id, exactly as PluginServices keys
 * storage and the secret store; the store already holds `TOKEN-OF-A` for `acct`, as after a sign-in.
 */
export async function accountFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "studio-plugin-identity-"));
  const seeds = path.join(base, "seeds");
  await mkdir(seeds);
  const tokens = new Map<string, string>([["acct", "TOKEN-OF-A"]]);
  const service = async (id: string, method: string, args: any) => {
    const storage = path.join(base, "data", id);
    if (method === "storage.root") {
      await mkdir(storage, { recursive: true });
      return storage;
    }
    if (method === "credentials.read") return tokens.get(id) ?? null;
    if (method === "credentials.write") {
      tokens.set(id, args.token);
      return;
    }
    if (method === "credentials.clear") {
      tokens.delete(id);
      return;
    }
    throw new Error(`unexpected host service ${method}`);
  };
  const open = async () => {
    const r = new PluginRegistry(path.join(base, "installed"), seeds, PLUGIN_SDK_BACKEND, service);
    await r.init();
    return r;
  };
  const registries: PluginRegistry[] = [];
  const registry = await open();
  registries.push(registry);
  return {
    base,
    tokens,
    registry,
    binding: { project: "game", directory: base },
    storageMarker: path.join(base, "data", "acct", "owned-by-a.txt"),
    async relaunch() {
      const r = await open();
      registries.push(r);
      return r;
    },
    async close() {
      for (const r of registries) r.cancel();
      await rm(base, { recursive: true, force: true });
    },
  };
}

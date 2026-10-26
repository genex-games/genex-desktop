/**
 * Packaging prune steps, run by Forge's afterPrune hook (forge.config.cjs) on the copied app.
 *
 * Forge's own prune keeps every production dependency's tree, including the trees of packages its
 * `ignore` list never copied. The Genex CLI is one: the plugin payload vendors its own copy under
 * dist/resources/plugins/genex, so the app-level tree (@sentry, @opentelemetry, ...) is dead
 * weight. The coding CLIs' native packages are external installations and must not ship.
 */
const fs = require("node:fs/promises");
const path = require("node:path");

/** Dependencies the packaged app never loads from its own node_modules. */
function excludedDependency(name) {
  return (
    name === "@genex-ai/cli-demo" ||
    name.startsWith("@anthropic-ai/claude-agent-sdk-") ||
    name === "@openai/codex" ||
    name.startsWith("@openai/codex-")
  );
}

async function readManifest(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Node's lookup: the nearest node_modules/<name> from `from` up to the app folder. */
async function resolvePackage(appDir, from, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (await readManifest(candidate)) return candidate;
    if (dir === appDir || !dir.startsWith(appDir + path.sep)) return null;
  }
}

/** Package folders reachable from the app's dependencies without passing an excluded name. */
async function reachablePackages(appDir, excluded = excludedDependency) {
  const reached = new Set();
  const queue = [appDir];
  while (queue.length) {
    const dir = queue.shift();
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    const names = new Set(
      [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].flatMap((deps) =>
        Object.keys(deps ?? {}),
      ),
    );
    for (const name of names) {
      if (excluded(name)) continue;
      const found = await resolvePackage(appDir, dir, name);
      if (found && !reached.has(found)) {
        reached.add(found);
        queue.push(found);
      }
    }
  }
  return reached;
}

/** Every installed package folder under `dir`/node_modules, nested ones included. */
async function installedPackages(dir) {
  const modules = path.join(dir, "node_modules");
  const entries = await fs.readdir(modules, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folders = entry.name.startsWith("@")
      ? (await fs.readdir(path.join(modules, entry.name), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => path.join(modules, entry.name, e.name))
      : [path.join(modules, entry.name)];
    for (const folder of folders) found.push(folder, ...(await installedPackages(folder)));
  }
  return found;
}

async function removeEmptyScopes(dir) {
  const modules = path.join(dir, "node_modules");
  const entries = await fs.readdir(modules, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(modules, entry.name);
    if (entry.name.startsWith("@")) {
      const inside = await fs.readdir(folder);
      if (!inside.length) {
        await fs.rmdir(folder);
        continue;
      }
      for (const name of inside) await removeEmptyScopes(path.join(folder, name));
    } else await removeEmptyScopes(folder);
  }
}

/** Remove installed packages that no kept dependency reaches; returns the removed folders. */
async function pruneUnreachable(appDir, excluded = excludedDependency) {
  const reached = await reachablePackages(appDir, excluded);
  const removed = [];
  for (const folder of await installedPackages(appDir)) {
    if (reached.has(folder) || removed.some((parent) => folder.startsWith(parent + path.sep))) continue;
    await fs.rm(folder, { recursive: true, force: true });
    removed.push(folder);
  }
  await removeEmptyScopes(appDir);
  return removed;
}

const PTY_RUNTIME = new Set(["package.json", "lib", "typings", "build", "prebuilds"]);
/** The native files node-pty loads: its addons, macOS's spawn helper, Windows's winpty agent and DLL. */
const PTY_BINARY = /\.(?:node|dll|exe)$|^spawn-helper$/;
/** Where the conpty backend finds its bundled conpty.dll and OpenConsole.exe (Windows only). */
const PTY_CONPTY_DIR = "conpty";
/** Debug symbols the compiler leaves beside Windows binaries; nothing loads them. */
const DEBUG_SYMBOLS = /\.pdb$/i;

/** The names in `dir`, or none when it does not exist. */
async function namesIn(dir) {
  return fs.readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

/** Keep only the entries of `dir` whose name `keep` accepts; every other file or folder goes. */
async function keepOnly(dir, keep) {
  for (const name of await namesIn(dir)) {
    if (!keep(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Remove every debug-symbol file under `dir`. */
async function removeDebugSymbols(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && DEBUG_SYMBOLS.test(entry.name))
      await fs.rm(path.join(entry.parentPath, entry.name), { force: true });
  }
}

/**
 * Keep node-pty's runtime: lib/, the rebuilt binaries in build/Release (with conpty/ on Windows)
 * and the prebuild for the target (its loader falls back to it). Sources, other platforms'
 * prebuilds, intermediate objects and PDBs go.
 */
async function trimNodePty(appDir, platform, arch) {
  const root = path.join(appDir, "node_modules", "node-pty");
  if ((await namesIn(root)).length === 0) return;
  await keepOnly(root, (name) => PTY_RUNTIME.has(name) || /^LICENSE/i.test(name));
  await keepOnly(path.join(root, "prebuilds"), (name) => name === `${platform}-${arch}`);
  await keepOnly(path.join(root, "build"), (name) => name === "Release");
  const release = path.join(root, "build", "Release");
  await keepOnly(release, (name) => PTY_BINARY.test(name) || name === PTY_CONPTY_DIR);
  await removeDebugSymbols(release);
  await removeDebugSymbols(path.join(root, "prebuilds"));
}

/**
 * sandbox-runtime's vendored helpers, by the one platform that runs each: the Linux seccomp filter
 * (substrate/spawn.ts `packagedSeccomp`) and the Windows broker. macOS needs neither, and codesign
 * would try to sign their ELF and PE files inside a Developer ID bundle.
 */
const SANDBOX_VENDOR_PLATFORM = { seccomp: "linux", "srt-win": "win32" };
/**
 * sandbox-runtime's JVM proxy agent, which every platform's sandbox hands Java (`JAVA_TOOL_OPTIONS`,
 * substrate/spawn.ts `packagedJavaAgent`): its jar is kept, its build script is not.
 */
const SANDBOX_JAVA_AGENT = { folder: "java-proxy-agent", jar: "srt-proxy-agent.jar" };

/** Keep only the target platform's and architecture's sandbox-runtime helper, and the JVM agent's jar; drop the rest. */
async function trimSandboxVendor(appDir, platform, arch) {
  const vendor = path.join(appDir, "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor");
  const agent = path.join(vendor, SANDBOX_JAVA_AGENT.folder);
  for (const name of await fs.readdir(agent).catch(() => [])) {
    if (name !== SANDBOX_JAVA_AGENT.jar) await fs.rm(path.join(agent, name), { recursive: true, force: true });
  }
  for (const [helper, owner] of Object.entries(SANDBOX_VENDOR_PLATFORM)) {
    const folder = path.join(vendor, helper);
    if (owner !== platform) {
      await fs.rm(folder, { recursive: true, force: true });
      continue;
    }
    for (const name of await fs.readdir(folder).catch(() => [])) {
      if (name !== arch) await fs.rm(path.join(folder, name), { recursive: true, force: true });
    }
  }
}

/**
 * Refuse to package a checkout whose node_modules is a symlink (a worktree sharing another
 * checkout's install). The packager copies the link as a link, so its prune and the hooks above
 * would delete the linked tree's devDependencies and other platforms' binaries in place.
 */
async function refuseLinkedModules(appDir) {
  const modules = path.join(appDir, "node_modules");
  const stat = await fs.lstat(modules).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink())
    throw new Error(
      `Refusing to package: ${modules} is a symlink, and packaging would prune the linked install in place. Package from a checkout with its own node_modules (npm ci).`,
    );
}

module.exports = {
  excludedDependency,
  reachablePackages,
  pruneUnreachable,
  trimNodePty,
  trimSandboxVendor,
  refuseLinkedModules,
};

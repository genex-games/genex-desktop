/**
 * The packaged app keeps only what runs on the target: Forge's afterPrune hooks drop the node-pty
 * files for other platforms and every package reachable only through a dependency the package
 * deliberately leaves out (the Genex CLI, which the plugin payload vendors, and the coding CLIs'
 * native packages). Drives the real hooks from forge.config.cjs on a synthetic app folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import forgeConfig from "../../forge.config.cjs";
import { tmpDir } from "../helpers/tmp.ts";

type Hook = (options: { buildPath: string; electronVersion: string; platform: string; arch: string }) => unknown;

async function runAfterPrune(buildPath: string, platform: string, arch: string): Promise<void> {
  for (const hook of forgeConfig.packagerConfig.afterPrune as Hook[]) {
    await hook({ buildPath, electronVersion: "43.4.1", platform, arch });
  }
}

async function put(root: string, file: string, text = ""): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

const pkg = (name: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: "1.0.0", ...fields });

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

async function directories(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/** A pruned app folder as Forge leaves it: the Genex CLI itself was ignored at copy, its tree was not. */
async function appFolder(): Promise<string> {
  const app = await tmpDir("studio-package-prune-");
  await put(
    app,
    "package.json",
    pkg("ai-game-studio", {
      dependencies: {
        "@anthropic-ai/claude-agent-sdk": "1",
        "@genex-ai/cli-demo": "1",
        "node-pty": "1",
        "shared-lib": "1",
        "peer-host": "1",
      },
    }),
  );
  await put(app, "dist/main/main.mjs");
  // Reachable from the app.
  await put(app, "node_modules/shared-lib/package.json", pkg("shared-lib", { dependencies: { inner: "1" } }));
  await put(app, "node_modules/shared-lib/node_modules/inner/package.json", pkg("inner"));
  await put(app, "node_modules/peer-host/package.json", pkg("peer-host", { peerDependencies: { "peer-dep": "1" } }));
  await put(app, "node_modules/peer-dep/package.json", pkg("peer-dep"));
  await put(
    app,
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    pkg("@anthropic-ai/claude-agent-sdk", {
      dependencies: { "shared-lib": "1" },
      optionalDependencies: {
        "@anthropic-ai/claude-agent-sdk-darwin-arm64": "1",
        "@anthropic-ai/claude-agent-sdk-linux-x64": "1",
      },
    }),
  );
  // Excluded coding CLI binaries.
  await put(
    app,
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json",
    pkg("@anthropic-ai/claude-agent-sdk-darwin-arm64"),
  );
  await put(app, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude", "binary");
  await put(app, "node_modules/@openai/codex/package.json", pkg("@openai/codex"));
  await put(app, "node_modules/@openai/codex-darwin-arm64/package.json", pkg("@openai/codex-darwin-arm64"));
  // Reachable only through the ignored Genex CLI.
  await put(
    app,
    "node_modules/@sentry/node/package.json",
    pkg("@sentry/node", { dependencies: { "@opentelemetry/api": "1", "shared-lib": "1" } }),
  );
  await put(app, "node_modules/@sentry/node/node_modules/nested-only/package.json", pkg("nested-only"));
  await put(app, "node_modules/@opentelemetry/api/package.json", pkg("@opentelemetry/api"));
  // node-pty after the rebuild step.
  await put(app, "node_modules/node-pty/package.json", pkg("node-pty"));
  await put(app, "node_modules/node-pty/LICENSE");
  await put(app, "node_modules/node-pty/lib/index.js");
  await put(app, "node_modules/node-pty/binding.gyp");
  await put(app, "node_modules/node-pty/src/unix/pty.cc");
  await put(app, "node_modules/node-pty/deps/winpty/src/agent.cc");
  await put(app, "node_modules/node-pty/third_party/conpty/1.23/win10-x64/conpty.dll");
  await put(app, "node_modules/node-pty/scripts/post-install.js");
  await put(app, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node");
  await put(app, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  await put(app, "node_modules/node-pty/prebuilds/darwin-x64/pty.node");
  await put(app, "node_modules/node-pty/prebuilds/win32-x64/pty.node");
  await put(app, "node_modules/node-pty/prebuilds/win32-x64/pty.pdb");
  await put(app, "node_modules/node-pty/prebuilds/win32-arm64/conpty.pdb");
  return app;
}

test("afterPrune drops packages reachable only through excluded dependencies, keeping shared and nested ones", async () => {
  const app = await appFolder();
  await put(app, "node_modules/node-pty/build/Release/pty.node");
  await put(app, "node_modules/node-pty/build/Release/spawn-helper");
  await runAfterPrune(app, "darwin", "arm64");
  const kept = (await files(app)).filter((file) => !file.startsWith("node_modules/node-pty/"));
  assert.deepEqual(kept, [
    "dist/main/main.mjs",
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    "node_modules/peer-dep/package.json",
    "node_modules/peer-host/package.json",
    "node_modules/shared-lib/node_modules/inner/package.json",
    "node_modules/shared-lib/package.json",
    "package.json",
  ]);
  const scopes = (await directories(app)).filter((dir) => /^node_modules\/@[^/]+$/.test(dir)).sort();
  assert.deepEqual(scopes, ["node_modules/@anthropic-ai"], "emptied scope folders are removed");
});

test("afterPrune keeps node-pty's runtime files for the target and the rebuilt binary, nothing else", async () => {
  const app = await appFolder();
  await put(app, "node_modules/node-pty/build/Release/pty.node");
  await put(app, "node_modules/node-pty/build/Release/spawn-helper");
  await put(app, "node_modules/node-pty/build/Release/obj.target/pty/src/unix/pty.o");
  await put(app, "node_modules/node-pty/build/Release/pty.pdb");
  await put(app, "node_modules/node-pty/build/Makefile");
  await runAfterPrune(app, "darwin", "arm64");
  const pty = (await files(app)).filter((file) => file.startsWith("node_modules/node-pty/"));
  assert.deepEqual(pty, [
    "node_modules/node-pty/LICENSE",
    "node_modules/node-pty/build/Release/pty.node",
    "node_modules/node-pty/build/Release/spawn-helper",
    "node_modules/node-pty/lib/index.js",
    "node_modules/node-pty/package.json",
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  ]);
});

test("afterPrune keeps the target prebuild when the rebuild produced nothing, and drops all prebuilds for a platform without one", async () => {
  const mac = await appFolder();
  await runAfterPrune(mac, "darwin", "x64");
  const macPty = (await files(mac)).filter((file) => file.startsWith("node_modules/node-pty/prebuilds/"));
  assert.deepEqual(macPty, ["node_modules/node-pty/prebuilds/darwin-x64/pty.node"]);

  const linux = await appFolder();
  await put(linux, "node_modules/node-pty/build/Release/pty.node");
  await runAfterPrune(linux, "linux", "x64");
  const linuxPty = (await files(linux)).filter((file) => file.startsWith("node_modules/node-pty/"));
  assert.ok(!linuxPty.some((file) => file.includes("/prebuilds/")), linuxPty.join("\n"));
  assert.ok(linuxPty.includes("node_modules/node-pty/build/Release/pty.node"));
});

/** node-pty's Windows runtime as the rebuild and its post-install leave it: conpty and winpty, with PDBs. */
const WINDOWS_PTY_RUNTIME = [
  "conpty.node",
  "conpty/OpenConsole.exe",
  "conpty/conpty.dll",
  "conpty_console_list.node",
  "pty.node",
  "winpty-agent.exe",
  "winpty.dll",
];

test("afterPrune on Windows keeps node-pty's conpty and winpty files for the target, without PDBs", async () => {
  const app = await appFolder();
  for (const file of WINDOWS_PTY_RUNTIME) {
    await put(app, `node_modules/node-pty/build/Release/${file}`);
    await put(app, `node_modules/node-pty/prebuilds/win32-x64/${file}`);
  }
  for (const pdb of ["conpty.pdb", "pty.pdb", "winpty.pdb", "winpty-agent.pdb"])
    await put(app, `node_modules/node-pty/build/Release/${pdb}`);
  await put(app, "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.pdb");
  await put(app, "node_modules/node-pty/build/Release/obj/pty/pty.obj");
  await runAfterPrune(app, "win32", "x64");
  const pty = (await files(app)).filter((file) => file.startsWith("node_modules/node-pty/"));
  const expected = [
    "node_modules/node-pty/LICENSE",
    ...WINDOWS_PTY_RUNTIME.map((file) => `node_modules/node-pty/build/Release/${file}`),
    "node_modules/node-pty/lib/index.js",
    "node_modules/node-pty/package.json",
    ...WINDOWS_PTY_RUNTIME.map((file) => `node_modules/node-pty/prebuilds/win32-x64/${file}`),
  ].sort();
  assert.deepEqual(pty, expected);
});

/**
 * sandbox-runtime's vendored helpers as npm installs them: Linux seccomp and Windows srt-win, both
 * arches, each beside its build script, and the JVM proxy agent every platform's sandbox hands Java.
 */
async function sandboxVendor(app: string): Promise<void> {
  const vendor = "node_modules/@anthropic-ai/sandbox-runtime/vendor";
  await put(app, "node_modules/@anthropic-ai/sandbox-runtime/package.json", pkg("@anthropic-ai/sandbox-runtime"));
  for (const arch of ["arm64", "x64"]) {
    await put(app, `${vendor}/seccomp/${arch}/apply-seccomp`, "elf");
    await put(app, `${vendor}/srt-win/${arch}/srt-win.exe`, "pe");
  }
  for (const helper of ["seccomp", "srt-win", "java-proxy-agent"]) await put(app, `${vendor}/${helper}/build.ts`, "ts");
  await put(app, `${vendor}/java-proxy-agent/srt-proxy-agent.jar`, "jar");
}

const vendorFiles = async (app: string) =>
  (await files(app))
    .filter((file) => file.startsWith("node_modules/@anthropic-ai/sandbox-runtime/vendor/"))
    .map((file) => file.slice("node_modules/@anthropic-ai/sandbox-runtime/vendor/".length));

test("afterPrune keeps only the target's sandbox helper: none on macOS, seccomp on Linux, srt-win on Windows", async () => {
  const jar = "java-proxy-agent/srt-proxy-agent.jar";
  const cases = [
    { platform: "darwin", arch: "arm64", kept: [jar] },
    { platform: "linux", arch: "x64", kept: [jar, "seccomp/x64/apply-seccomp"] },
    { platform: "linux", arch: "arm64", kept: [jar, "seccomp/arm64/apply-seccomp"] },
    { platform: "win32", arch: "arm64", kept: [jar, "srt-win/arm64/srt-win.exe"] },
  ];
  for (const { platform, arch, kept } of cases) {
    const app = await appFolder();
    await put(app, "package.json", pkg("ai-game-studio", { dependencies: { "@anthropic-ai/sandbox-runtime": "1" } }));
    await sandboxVendor(app);
    await runAfterPrune(app, platform, arch);
    assert.deepEqual(await vendorFiles(app), kept, `${platform}-${arch}`);
  }
});

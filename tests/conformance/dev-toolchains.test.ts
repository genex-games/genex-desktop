/**
 * The one place tests learn where the developer's pinned toolchains are (`tests/helpers/dev-toolchains.ts`):
 * an absent tool skips its row with the reason, `GENEX_REQUIRE_TOOLCHAINS=1` turns that skip into a
 * failure naming the tool, and an emcc run gets a private cache so the shared emsdk is never written.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { ToolchainId } from "../../src/shared/toolchain.ts";
import { crossPrewarmDigest } from "../../src/substrate/toolchain-store/locate.ts";
import { CURRENT_LOCK_FILE, lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import {
  DEV_TOOL,
  devStoreLock,
  devStoreLockFile,
  devTool,
  devToolchains,
  needsPrewarmed,
  needsTools,
  privateEmscripten,
} from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** Every entry under `root` with its size and modification time: what "left as it was" is checked by. */
async function listing(root: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  for (const rel of await readdir(root, { recursive: true })) {
    const info = await lstat(path.join(root, rel));
    seen.set(rel, `${info.isDirectory() ? "dir" : info.size}:${info.mtimeMs}`);
  }
  return seen;
}

describe("the developer's toolchains", () => {
  it("default to the repository's .studio-dev/toolchains, or GENEX_DEV_TOOLCHAINS when it is set", () => {
    assert.equal(devToolchains({}).root, path.join(REPO, ".studio-dev", "toolchains"));
    assert.equal(devToolchains({ GENEX_DEV_TOOLCHAINS: "/elsewhere/tools" }).root, "/elsewhere/tools");
  });

  it("an absent tool is a skip with its reason; a present one is its path", async () => {
    const root = await tmpDir("dev-toolchains-");
    const tools = devToolchains({ GENEX_DEV_TOOLCHAINS: root });
    assert.deepEqual(tools.devTool("cmake"), { skip: "not run: cmake absent" });
    assert.deepEqual(tools.needsTools("cmake", "ninja"), { skip: "not run: cmake absent" });
    const ninja = path.join(root, ...DEV_TOOL.ninja.split("/"));
    await mkdir(path.dirname(ninja), { recursive: true });
    await writeFile(ninja, "");
    assert.deepEqual(tools.devTool("ninja"), { path: ninja });
    assert.deepEqual(tools.needsTools("ninja"), {});
    assert.deepEqual(tools.needsTools("ninja", "emcc"), { skip: "not run: emcc absent" });
  });

  it("under GENEX_REQUIRE_TOOLCHAINS=1 an absent tool fails its row, naming the tool", async () => {
    const root = await tmpDir("dev-toolchains-");
    const ninja = path.join(root, ...DEV_TOOL.ninja.split("/"));
    await mkdir(path.dirname(ninja), { recursive: true });
    await writeFile(ninja, "");
    const required = devToolchains({ GENEX_DEV_TOOLCHAINS: root, GENEX_REQUIRE_TOOLCHAINS: "1" });
    assert.throws(() => required.needsTools("ninja", "emcc"), /emcc/);
    assert.throws(() => required.needsTools("zig"), /zig .*absent/);
    assert.deepEqual(required.needsTools("ninja"), {});
    // Only "1" requires: anything else is the permanent skip the CI runner relies on.
    for (const value of ["0", "", "true"])
      assert.deepEqual(
        devToolchains({ GENEX_DEV_TOOLCHAINS: root, GENEX_REQUIRE_TOOLCHAINS: value }).needsTools("zig"),
        {
          skip: "not run: zig absent",
        },
      );
  });

  it("a private emcc run compiles with its own cache and leaves the shipped emsdk as it was", {
    ...needsTools("emsdk", "emcc", "emsdkPython", "emsdkNode", "emscriptenCache"),
    timeout: 120_000,
  }, async () => {
    const emsdk = (devTool("emsdk") as { path: string }).path;
    const emcc = (devTool("emcc") as { path: string }).path;
    const before = await listing(emsdk);
    const dir = await tmpDir("private-emscripten-");
    const env = await privateEmscripten(path.join(dir, "em"));
    assert.equal(env.EM_CACHE, path.join(dir, "em", "em-cache"));
    assert.equal(env.EMCC_SKIP_SANITY_CHECK, "1");
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
    assert.match(await readFile(env.EM_CONFIG ?? "", "utf8"), /^LLVM_ROOT = /m);
    await writeFile(path.join(dir, "hello.c"), "int answer(void) { return 42; }\n");
    await execFileAsync(emcc, ["-c", path.join(dir, "hello.c"), "-o", path.join(dir, "hello.o")], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir, ...env },
    });
    const object = await readFile(path.join(dir, "hello.o"));
    assert.deepEqual([...object.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], "a wasm object");
    const after = await listing(emsdk);
    assert.deepEqual(
      [...after].filter(([rel, entry]) => before.get(rel) !== entry),
      [],
      "nothing under the shipped emsdk was added or changed",
    );
    assert.equal(after.size, before.size);
    // A second run cannot reuse a cache another run already owns.
    await assert.rejects(privateEmscripten(path.join(dir, "em")), /em-cache/);
  });
});

describe("the dev store's prewarm", () => {
  /** A dev store whose current lock is `digest` and whose prewarm for it lists `outputs`. */
  async function store(outputs: string[] | null, digest = "d".repeat(64), cross?: string): Promise<string> {
    const root = await tmpDir("dev-toolchains-prewarm-");
    const devStore = path.join(root, ...DEV_TOOL.devStore.split("/"));
    await mkdir(path.join(devStore, "locks", digest.slice(0, 12)), { recursive: true });
    await writeFile(path.join(devStore, "current-lock.json"), JSON.stringify({ version: 1, entries: {}, digest }));
    if (outputs)
      await writeFile(
        path.join(devStore, "locks", digest.slice(0, 12), "prewarm.json"),
        JSON.stringify({ lock: digest, recipe: "r", ...(cross ? { cross } : {}), outputs, at: "" }),
      );
    return root;
  }

  it("a destination is prewarmed when the current lock's prewarm.json lists its genex cmake file", async () => {
    const root = await store(["em-cache", "genex-web.cmake", "raylib-web-es3/lib/libraylib.a"]);
    const tools = devToolchains({ GENEX_DEV_TOOLCHAINS: root }, { repo: root });
    assert.deepEqual(tools.needsPrewarmed("web"), {});
    assert.deepEqual(tools.needsPrewarmed("macos"), { skip: "not run: dev store has no macos prewarm" });
    assert.deepEqual(tools.needsPrewarmed("web", "macos"), { skip: "not run: dev store has no macos prewarm" });
  });

  it("a store with no current lock, no prewarm or a prewarm for another lock prewarms nothing", async () => {
    const empty = await tmpDir("dev-toolchains-prewarm-empty-");
    const none = await store(null);
    const other = await store(["genex-web.cmake"]);
    await writeFile(
      path.join(other, ...DEV_TOOL.devStore.split("/"), "locks", "d".repeat(12), "prewarm.json"),
      JSON.stringify({ lock: "e".repeat(64), recipe: "r", outputs: ["genex-web.cmake"], at: "" }),
    );
    for (const root of [empty, none, other])
      assert.deepEqual(devToolchains({ GENEX_DEV_TOOLCHAINS: root }, { repo: root }).needsPrewarmed("web"), {
        skip: "not run: dev store has no web prewarm",
      });
  });

  it("a Windows or Linux prewarm made from another cross format reads as not prewarmed, as the lane reads it", async () => {
    const outputs = ["genex-web.cmake", "genex-windows.cmake", "genex-linux.cmake"];
    const staleRoot = await store(outputs, undefined, "0".repeat(12));
    const stale = devToolchains({ GENEX_DEV_TOOLCHAINS: staleRoot }, { repo: staleRoot });
    assert.deepEqual(stale.needsPrewarmed("web"), {}, "the web's outputs do not depend on the cross format");
    assert.deepEqual(stale.needsPrewarmed("windows"), { skip: "not run: dev store has no windows prewarm" });
    const current = await store(outputs, undefined, crossPrewarmDigest());
    assert.deepEqual(
      devToolchains({ GENEX_DEV_TOOLCHAINS: current }, { repo: current }).needsPrewarmed("windows", "linux"),
      {},
    );
  });

  it("under GENEX_REQUIRE_TOOLCHAINS=1 a missing prewarm fails its row, naming the destination", async () => {
    const root = await store(["genex-web.cmake"]);
    const required = devToolchains({ GENEX_DEV_TOOLCHAINS: root, GENEX_REQUIRE_TOOLCHAINS: "1" }, { repo: root });
    assert.deepEqual(required.needsPrewarmed("web"), {});
    assert.throws(() => required.needsPrewarmed("macos"), /macos prewarm/);
  });

  it("a dev store holding only the Rust stack's parts is absent for the C++ rows until it has their current lock", async () => {
    const root = await tmpDir("dev-toolchains-rust-only-");
    const devStore = path.join(root, ...DEV_TOOL.devStore.split("/"));
    await mkdir(path.join(devStore, "rust"), { recursive: true });
    await writeFile(path.join(devStore, "current-lock.rust-wgpu.json"), "{}");
    const tools = devToolchains({ GENEX_DEV_TOOLCHAINS: root }, { repo: root });
    assert.deepEqual(tools.needsTools("devStore"), { skip: "not run: devStore absent" });
    assert.deepEqual(tools.devTool("devStore"), { skip: "not run: devStore absent" });
    const required = devToolchains({ GENEX_DEV_TOOLCHAINS: root, GENEX_REQUIRE_TOOLCHAINS: "1" }, { repo: root });
    assert.throws(() => required.needsTools("devStore"), /devStore absent/);
    await writeFile(path.join(devStore, CURRENT_LOCK_FILE), JSON.stringify({ version: 1, entries: {}, digest: "d" }));
    assert.deepEqual(tools.needsTools("devStore"), {});
    assert.deepEqual(tools.devTool("devStore"), { path: devStore });
  });

  it("the developer's dev store has the browser prewarmed for its current lock", needsTools("devStore"), () => {
    assert.deepEqual(needsPrewarmed("web"), {});
  });

  it("names the pinned archives and the CI-built ANGLE folders", () => {
    assert.equal(DEV_TOOL.raylibArchive, "downloads/raylib-6.0.tar.gz");
    assert.equal(DEV_TOOL.zigLinuxArchive, "downloads/zig-x86_64-linux-0.16.0.tar.xz");
    assert.equal(DEV_TOOL.angleWindows, "angle-windows-x64-d3d11/c5bf49e78850");
    assert.equal(DEV_TOOL.angleLinux, "angle-linux-x64-vulkan/c5bf49e78850");
    assert.equal(DEV_TOOL.sysrootX11, "sysroot-linux-x64-x11");
    assert.equal(DEV_TOOL.glfwWayland, "glfw-wayland-fc7a27ac010b");
    assert.equal(DEV_TOOL.linuxSysroot, "linux-sysroot-x64/8031a635e032");
  });
});

/** sha256 and modification time of a file: what "never written" is checked by. */
async function fingerprint(file: string): Promise<string> {
  const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
  return `${createHash("sha256").update(bytes).digest("hex")}:${info.mtimeMs}`;
}

describe("the lock the dev store's real rows build with", () => {
  /** Three distinct well-formed locks: the store's, the worktree's and the one the environment names. */
  const LOCKS = {
    store: lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: "aaaaaaaaaaaa" } }),
    worktree: lockOf({ [ToolchainId.Zig]: { version: "0.16.0", sha12: "bbbbbbbbbbbb" } }),
    env: lockOf({ [ToolchainId.Ninja]: { version: "1.13.2", sha12: "cccccccccccc" } }),
  };

  /** A toolchains folder whose dev store names `LOCKS.store`, a repository whose worktree file names `LOCKS.worktree`. */
  async function layout(withWorktreeLock: boolean) {
    const root = await tmpDir("dev-store-lock-");
    const tools = path.join(root, "toolchains");
    const repo = path.join(root, "repo");
    const store = path.join(tools, ...DEV_TOOL.devStore.split("/"));
    await mkdir(store, { recursive: true });
    await mkdir(path.join(repo, ".studio-dev"), { recursive: true });
    const files = {
      store: path.join(store, "current-lock.json"),
      worktree: path.join(repo, ".studio-dev", "dev-store-lock.json"),
      env: path.join(root, "elsewhere-lock.json"),
    };
    await writeFile(files.store, JSON.stringify(LOCKS.store));
    if (withWorktreeLock) await writeFile(files.worktree, JSON.stringify(LOCKS.worktree));
    await writeFile(files.env, JSON.stringify(LOCKS.env));
    return { root, tools, repo, files };
  }

  it("GENEX_DEV_STORE_LOCK beats the worktree's .studio-dev/dev-store-lock.json, which beats the store's current lock", async () => {
    const both = await layout(true);
    const env = { GENEX_DEV_TOOLCHAINS: both.tools };
    assert.equal(devStoreLockFile({ ...env, GENEX_DEV_STORE_LOCK: both.files.env }, both.repo), both.files.env);
    assert.deepEqual(
      await devToolchains({ ...env, GENEX_DEV_STORE_LOCK: both.files.env }, { repo: both.repo }).lock(),
      LOCKS.env,
    );
    assert.equal(devStoreLockFile(env, both.repo), both.files.worktree);
    assert.deepEqual(await devToolchains(env, { repo: both.repo }).lock(), LOCKS.worktree);
    const storeOnly = await layout(false);
    assert.equal(devStoreLockFile({ GENEX_DEV_TOOLCHAINS: storeOnly.tools }, storeOnly.repo), storeOnly.files.store);
    assert.deepEqual(
      await devToolchains({ GENEX_DEV_TOOLCHAINS: storeOnly.tools }, { repo: storeOnly.repo }).lock(),
      LOCKS.store,
    );
  });

  it("a lock file that is missing, not JSON or not a lock is no lock", async () => {
    const { tools, repo, root } = await layout(false);
    for (const text of [null, "{", JSON.stringify({ ...LOCKS.env, digest: "e".repeat(64) })]) {
      const file = path.join(root, "bad-lock.json");
      if (text !== null) await writeFile(file, text);
      const tools2 = devToolchains(
        { GENEX_DEV_TOOLCHAINS: tools, GENEX_DEV_STORE_LOCK: text === null ? path.join(root, "absent.json") : file },
        { repo },
      );
      assert.equal(await tools2.lock(), null, String(text));
    }
  });

  it("needsPrewarmed reads the same lock: a worktree lock with no prewarm of its own prewarms nothing", async () => {
    const { tools, repo, files } = await layout(true);
    const store = path.dirname(files.store);
    const prewarmed = (digest: string) =>
      writeFile(
        path.join(store, "locks", digest.slice(0, 12), "prewarm.json"),
        JSON.stringify({ lock: digest, recipe: "r", outputs: ["genex-web.cmake"], at: "" }),
      );
    await mkdir(path.join(store, "locks", LOCKS.store.digest.slice(0, 12)), { recursive: true });
    await prewarmed(LOCKS.store.digest);
    const env = { GENEX_DEV_TOOLCHAINS: tools };
    assert.deepEqual(devToolchains(env, { repo }).needsPrewarmed("web"), {
      skip: "not run: dev store has no web prewarm",
    });
    await mkdir(path.join(store, "locks", LOCKS.worktree.digest.slice(0, 12)), { recursive: true });
    await prewarmed(LOCKS.worktree.digest);
    assert.deepEqual(devToolchains(env, { repo }).needsPrewarmed("web"), {});
  });

  it("reading the lock never writes any lock file", async () => {
    const { tools, repo, files } = await layout(true);
    const before = await Promise.all(Object.values(files).map(fingerprint));
    const tools2 = devToolchains({ GENEX_DEV_TOOLCHAINS: tools }, { repo });
    await tools2.lock();
    tools2.needsPrewarmed("web", "windows");
    assert.deepEqual(await Promise.all(Object.values(files).map(fingerprint)), before);
  });

  it("the developer's dev store's current-lock.json is left as it was", needsTools("devStore"), async () => {
    const shared = path.join(devToolchains().root, ...DEV_TOOL.devStore.split("/"), "current-lock.json");
    const before = await fingerprint(shared);
    await devStoreLock();
    needsPrewarmed("web");
    devStoreLockFile();
    assert.equal(await fingerprint(shared), before);
  });
});

describe("the head start's cross packages and Docker images", () => {
  it("a cross package is its folder under .studio-dev/cross-build-work, else a skip, or a failure when required", async () => {
    const repo = await tmpDir("dev-cross-package-");
    const tools = devToolchains({ GENEX_DEV_TOOLCHAINS: repo }, { repo });
    assert.deepEqual(tools.crossPackage(BuildTarget.Windows), { skip: "not run: windows cross package absent" });
    assert.deepEqual(tools.needsCrossPackage(BuildTarget.Linux), { skip: "not run: linux cross package absent" });
    const required = devToolchains({ GENEX_DEV_TOOLCHAINS: repo, GENEX_REQUIRE_TOOLCHAINS: "1" }, { repo });
    assert.throws(() => required.needsCrossPackage(BuildTarget.Linux), /linux cross package/);
    const windows = path.join(repo, ".studio-dev", "cross-build-work", "windows-x64", "package");
    await mkdir(windows, { recursive: true });
    assert.deepEqual(tools.crossPackage(BuildTarget.Windows), { path: windows });
    assert.deepEqual(required.needsCrossPackage(BuildTarget.Windows), {});
  });

  it("a Docker image is needed through the docker CLI: absent CLI or a hostile name is a skip, or a failure when required", () => {
    const noDocker = devToolchains({ PATH: "/nonexistent" });
    assert.match(noDocker.needsDocker("ubuntu:24.04").skip ?? "", /^not run: docker image ubuntu:24\.04 /);
    const required = devToolchains({ PATH: "/nonexistent", GENEX_REQUIRE_TOOLCHAINS: "1" });
    assert.throws(() => required.needsDocker("ubuntu:24.04"), /ubuntu:24\.04/);
    for (const hostile of ["--help", "-v", "", "a b", "x;rm -rf ~", "../image"])
      assert.match(noDocker.needsDocker(hostile).skip ?? "", /is not an image name/, hostile);
  });
});

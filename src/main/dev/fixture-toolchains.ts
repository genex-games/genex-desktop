/**
 * The `cpp-game` fixture: two C++ · raylib games scaffolded through the real path, and a
 * pre-seeded, disposable toolchain store in the product's layout (receipts, a prewarmed lock
 * folder, `current-lock.json`) whose `cmake` and `ninja` are small stub scripts. The C++ lane runs
 * them under the sandbox like the real tools; no install IPC and no compiler ever runs.
 *
 * - `cmake -S <src> -B <bin> …` records the source root in `<bin>/.stub-source`.
 * - `cmake --build <bin>` copies the committed emcc output (`tests/fixtures/raylib-wasm/index.*`)
 *   into `<bin>/out/`, or, when `<src>/src/main.cpp` holds `GENEX_FORCE_ERROR`, prints one clang
 *   diagnostic and exits 1.
 *
 * The store also keeps an older CMake no lock names, so Settings → Toolchains has one version to
 * remove. With {@link FIXTURE_TOOLCHAIN_STORE_ENV} naming an absolute directory outside the
 * profile (the C++ lane's L4 runner, pointing at the developer's real store),
 * `<userData>/toolchains` becomes a link to it instead, which the service never prunes. Nothing
 * here runs outside a fixture profile.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BuildTarget, GameStack } from "../../shared/game-project.ts";
import { ToolchainHost, ToolchainId, type ToolchainLock, toolchainHostOf } from "../../shared/toolchain.ts";
import { ScaffoldCaller } from "../../substrate/game-workspace.ts";
import { isInside } from "../../substrate/paths.ts";
import { shellQuote } from "../../substrate/spawn.ts";
import { readRecipe, recipeSha12 } from "../../substrate/toolchain-store/genex-cmake.ts";
import { ReceiptSource, type ToolchainReceipt } from "../../substrate/toolchain-store/install.ts";
import {
  COMPONENT_LAYOUT,
  EM_CACHE_FOLDER,
  lockFolder,
  lockOutputs,
  PREWARM_FILE,
  RAYLIB_HEADERS,
  RECEIPT_FILE,
} from "../../substrate/toolchain-store/locate.ts";
import { lockOf, writeCurrentLock } from "../../substrate/toolchain-store/lock.ts";
import type { StudioCore } from "../studio-core.ts";

/** The environment variable that links the fixture's store to a real one (an absolute directory). */
export const FIXTURE_TOOLCHAIN_STORE_ENV = "GENEX_FIXTURE_TOOLCHAIN_STORE";

/** The line the stub prints when a game's source asks for a compile error. */
export const FIXTURE_FORCED_ERROR = "src/main.cpp:12:5: error: use of undeclared identifier 'GENEX_FORCE_ERROR'";

/** The two games the fixture seeds, by name, with their destinations. */
export const FIXTURE_CPP_GAMES = [
  { name: "pong-cpp", title: "Pong", targets: [BuildTarget.Web, BuildTarget.Mac] },
  { name: "pong-mac", title: "Pong for Mac", targets: [BuildTarget.Mac] },
] as const;

/** The `rust-game` fixture's game: a Rust · wgpu game for the browser and the Mac. */
export const FIXTURE_RUST_GAME = {
  name: "ferris-rust",
  title: "Ferris",
  targets: [BuildTarget.Web, BuildTarget.Mac],
} as const;

/**
 * The Rust game the `rust-game` fixture seeds: scaffolded once through the library from the
 * shipped Rust template (a fixture profile is a development build, so the gate is open), with its
 * chat, and no Rust toolchain. The fixture's stub Rust store is `fixture-rust.ts`'s.
 */
export async function seedRustGame(core: StudioCore): Promise<void> {
  const { name, title, targets } = FIXTURE_RUST_GAME;
  if ((await core.games.list()).some((game) => game.name === name)) return;
  await core.games.scaffold(name, { title, stack: GameStack.RustWgpu, targets });
  await core.threadForGame(name);
}

/** Marks a store a fixture seeded (the C++ or the Rust one), so relinking or reseeding never removes anything else. */
export const FIXTURE_STORE_MARKER = ".genex-fixture-store";
const MARKER = FIXTURE_STORE_MARKER;
/** Where the stub cmake keeps the committed web build it copies (inside its own install folder). */
const WEB_OUTPUT_DIR = "share/genex-fixture-web";
/** Written into each seeded file that only has to exist. */
const PLACEHOLDER = "genex fixture: never run\n";
const WHEN = "2026-10-01T00:00:00.000Z";

declare const __STUDIO_DEV_BUILD__: { checkout: string; buildId: string } | null | undefined;

/** One component the fake store holds: its folder's files, and the stub scripts among them. */
interface FakeComponent {
  id: ToolchainId;
  version: string;
  files: readonly string[];
  /** Whether the current lock names it; the one that is not is what "Remove old versions" removes. */
  locked: boolean;
}

/** The fake store's components on `host`, at the paths the store's locate reads (`COMPONENT_LAYOUT`). */
function fakeComponents(host: ToolchainHost): FakeComponent[] {
  const cmake = COMPONENT_LAYOUT.cmake[host];
  return [
    { id: ToolchainId.Cmake, version: "4.4.3", files: [cmake], locked: true },
    { id: ToolchainId.Cmake, version: "4.4.2", files: [cmake], locked: false },
    { id: ToolchainId.Ninja, version: "1.13.2", files: [COMPONENT_LAYOUT.ninja[host]], locked: true },
    {
      id: ToolchainId.Emsdk,
      version: "6.0.10",
      files: [
        `${COMPONENT_LAYOUT.emscripten}/emcc`,
        COMPONENT_LAYOUT.emscriptenToolchainFile,
        `${COMPONENT_LAYOUT.emscriptenCache}/sysroot/include/stdio.h`,
        `${COMPONENT_LAYOUT.llvm}/clang`,
        COMPONENT_LAYOUT.python[host],
        COMPONENT_LAYOUT.node[host],
      ],
      locked: true,
    },
    {
      id: ToolchainId.RaylibSource,
      version: "6.0",
      files: ["CMakeLists.txt", ...RAYLIB_HEADERS.map((header) => `src/${header}`)],
      locked: true,
    },
  ];
}

/** A stable 12-hex digest per fake component, as an install folder is named. */
function fakeSha256(component: Pick<FakeComponent, "id" | "version">): string {
  return createHash("sha256").update(`genex-fixture:${component.id}@${component.version}`).digest("hex");
}

/** The stub `cmake`: configure records the source root; build copies the web output or fails as clang would. */
export function stubCmake(webOutput: string): string {
  const output = shellQuote(webOutput);
  const forced = shellQuote(FIXTURE_FORCED_ERROR);
  return `#!/bin/sh
# Genex fixture stand-in for CMake (the cpp-game fixture): no compiler runs.
if [ "$1" = "--version" ]; then echo "cmake version 4.4.3 (genex fixture stub)"; exit 0; fi
if [ "$1" = "--build" ]; then
  bin="$2"
  source_root=$(/bin/cat "$bin/.stub-source" 2>/dev/null) || { echo "genex fixture cmake: $bin was never configured" >&2; exit 1; }
  if /usr/bin/grep -q GENEX_FORCE_ERROR "$source_root/src/main.cpp" 2>/dev/null; then
    echo "FAILED: CMakeFiles/game.dir/src/main.cpp.o"
    echo ${forced}
    echo "ninja: build stopped: subcommand failed."
    exit 1
  fi
  /bin/mkdir -p "$bin/out" || exit 1
  for file in ${output}/index.*; do
    [ -f "$file" ] || { echo "genex fixture cmake: no web build was seeded" >&2; exit 1; }
    /bin/cp "$file" "$bin/out/" || exit 1
  done
  echo "[1/1] Linking CXX executable out/index.html"
  exit 0
fi
src=""
bin=""
while [ $# -gt 0 ]; do
  case "$1" in
    -S) src="$2"; shift 2 ;;
    -B) bin="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$src" ] || [ -z "$bin" ]; then echo "genex fixture cmake: expected -S <source> -B <build>" >&2; exit 2; fi
/bin/mkdir -p "$bin" && printf '%s\\n' "$src" > "$bin/.stub-source" || exit 1
echo "-- Configuring done (genex fixture stub)"
echo "-- Build files have been written to: $bin"
`;
}

/** The stub `ninja`: answers its version; the stub cmake never calls it. */
const STUB_NINJA = `#!/bin/sh
# Genex fixture stand-in for Ninja (the cpp-game fixture).
if [ "$1" = "--version" ]; then echo "1.13.2"; exit 0; fi
echo "genex fixture ninja: the fixture's cmake builds without ninja" >&2
exit 1
`;

/** The contents of one seeded file: the two stubs are scripts, everything else a placeholder. */
function fileText(component: FakeComponent, cmakeStub: string): { text: string; mode: number } {
  if (component.id === ToolchainId.Cmake) return { text: cmakeStub, mode: 0o755 };
  if (component.id === ToolchainId.Ninja) return { text: STUB_NINJA, mode: 0o755 };
  return { text: PLACEHOLDER, mode: 0o755 };
}

/** Writes one component's install folder and its receipt; answers the receipt. */
async function seedComponent(
  store: string,
  component: FakeComponent,
  place: { host: ToolchainHost; webOutput: string },
): Promise<ToolchainReceipt> {
  const sha256 = fakeSha256(component);
  const sha12 = sha256.slice(0, 12);
  const folder = path.join(store, component.id, `${component.version}-${sha12}`);
  const cmakeStub = stubCmake(path.join(folder, WEB_OUTPUT_DIR));
  let bytes = 0;
  for (const rel of component.files) {
    const file = path.join(folder, rel);
    const { text, mode } = fileText(component, cmakeStub);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { mode });
    bytes += Buffer.byteLength(text);
  }
  if (component.id === ToolchainId.Cmake)
    bytes += await copyWebOutput(place.webOutput, path.join(folder, WEB_OUTPUT_DIR));
  const receipt: ToolchainReceipt = {
    id: component.id,
    version: component.version,
    sha256,
    sha12,
    bytes,
    host: component.id === ToolchainId.RaylibSource ? null : place.host,
    target: null,
    source: ReceiptSource.Archive,
    installedAt: WHEN,
  };
  await writeFile(path.join(folder, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Copies the committed emcc output's `index.*` files; answers their bytes (0 when there is none). */
async function copyWebOutput(from: string, to: string): Promise<number> {
  await mkdir(to, { recursive: true });
  const names = await readdir(from).catch(() => []);
  let bytes = 0;
  for (const name of names.filter((item) => item.startsWith("index."))) {
    await copyFile(path.join(from, name), path.join(to, name));
    bytes += (await stat(path.join(to, name))).size;
  }
  return bytes;
}

/** The prewarmed lock folder the lane locates: every web output the store checks, and its record. */
async function seedLockFolder(store: string, lock: ToolchainLock): Promise<void> {
  const folder = lockFolder(store, lock);
  const outputs = lockOutputs(BuildTarget.Web);
  for (const rel of outputs) {
    const file = path.join(folder, ...rel.split("/"));
    // The Emscripten cache is a folder the lane clones; every other output is a file.
    if (rel === EM_CACHE_FOLDER) {
      await mkdir(path.join(file, "sysroot"), { recursive: true });
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, PLACEHOLDER);
  }
  // The shipped recipe's digest: the store locates only a lock folder prewarmed from it.
  const record = { lock: lock.digest, recipe: recipeSha12(readRecipe()), outputs, at: WHEN };
  await writeFile(path.join(folder, PREWARM_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/** Whether `dir` is a store this fixture seeded, or an empty folder (the one `init` made). */
async function isOursOrEmpty(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => null);
  return names !== null && (names.length === 0 || names.includes(MARKER));
}

/**
 * Makes `store` a plain folder the fixture may write: removes a link an earlier launch made, and
 * refuses (false) a folder the fixture did not seed.
 */
async function claimStore(store: string): Promise<boolean> {
  const found = await lstat(store).catch(() => null);
  if (found?.isSymbolicLink()) await unlink(store);
  else if (found && !(await isOursOrEmpty(store))) return false;
  await mkdir(store, { recursive: true });
  return true;
}

/**
 * Seeds the fake store into `store` (a fixture profile's `layout.toolchains`) and answers its
 * current lock; null when `store` holds something the fixture did not seed, which it never touches.
 */
export async function seedFixtureToolchainStore(
  store: string,
  options: { webOutput: string; platform?: NodeJS.Platform },
): Promise<ToolchainLock | null> {
  if (!(await claimStore(store))) return null;
  await writeFile(path.join(store, MARKER), "The cpp-game fixture's disposable toolchain store.\n");
  const host = toolchainHostOf(options.platform ?? process.platform, process.arch) ?? ToolchainHost.MacArm64;
  const components = fakeComponents(host);
  const entries: ToolchainLock["entries"] = {};
  for (const component of components) {
    const receipt = await seedComponent(store, component, { host, webOutput: options.webOutput });
    if (component.locked) entries[component.id] = { version: receipt.version, sha12: receipt.sha12 };
  }
  const lock = lockOf(entries);
  await seedLockFolder(store, lock);
  await writeCurrentLock(store, lock);
  return lock;
}

/**
 * The real directory `target` names, when the store may link to it: an absolute path to a folder
 * outside the profile `store` lives in, and not one of the profile's ancestors. Null otherwise,
 * since a link to the store itself, into the profile or above it would loop, or turn the whole
 * profile into the store the service reads and prunes.
 */
async function linkTarget(store: string, target: string): Promise<string | null> {
  if (!path.isAbsolute(target)) return null;
  const real = await realpath(target).catch(() => null);
  const profile = await realpath(path.dirname(store)).catch(() => null);
  if (!real || !profile) return null;
  const isDir = await stat(real).then((found) => found.isDirectory());
  // A filesystem root holds every profile, though `isInside("/", …)` does not say so.
  const isRoot = real === path.parse(real).root;
  const overlaps = isRoot || isInside(profile, real) || isInside(real, profile);
  return isDir && !overlaps ? real : null;
}

/**
 * Points `store` at `target` when it names an absolute directory outside the profile: `store`
 * becomes a link to its real path. False, and nothing changed, for a relative path, a missing
 * folder, a file, the store itself, anything inside the profile or above it, or a `store` the
 * fixture did not seed.
 */
export async function linkFixtureToolchainStore(store: string, target: string): Promise<boolean> {
  const real = await linkTarget(store, target);
  if (!real) return false;
  const found = await lstat(store).catch(() => null);
  if (found?.isSymbolicLink()) await unlink(store);
  else if (found) {
    if (!(await isOursOrEmpty(store))) return false;
    await rm(store, { recursive: true, force: true });
  }
  await symlink(real, store, "dir");
  return true;
}

/** The checkout the developer build came from; from source (tests), the repository this file is in. */
export function fixtureCheckoutRoot(): string {
  const build = typeof __STUDIO_DEV_BUILD__ === "undefined" ? null : __STUDIO_DEV_BUILD__;
  return build?.checkout ?? fileURLToPath(new URL("../../../", import.meta.url));
}

/** The committed emcc output the stub cmake serves (`tests/fixtures/raylib-wasm/`). */
export function fixtureWebOutput(): string {
  return path.join(fixtureCheckoutRoot(), "tests", "fixtures", "raylib-wasm");
}

/**
 * The two raylib games, scaffolded once through the real template path, each with a chat. Their
 * creation is retired for the harness and the person (M6.3), so the fixture makes them as the
 * host itself ({@link ScaffoldCaller.Internal}).
 */
async function seedRaylibGames(core: StudioCore): Promise<void> {
  const listed = new Set((await core.games.list()).map((game) => game.name));
  for (const game of FIXTURE_CPP_GAMES) {
    if (listed.has(game.name)) continue;
    await core.games.scaffold(game.name, {
      title: game.title,
      stack: GameStack.RaylibCpp,
      targets: game.targets,
      caller: ScaffoldCaller.Internal,
    });
    await core.threadForGame(game.name);
  }
}

/**
 * The `cpp-game` fixture's seed: the raylib games, then the store, linked when the environment
 * names a real one and seeded otherwise. It runs on every launch, so a reused profile follows the
 * environment of this launch.
 */
export async function seedCppGame(core: StudioCore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await seedRaylibGames(core);
  const store = core.layout.toolchains;
  const target = env[FIXTURE_TOOLCHAIN_STORE_ENV];
  const linked = Boolean(target) && (await linkFixtureToolchainStore(store, target ?? ""));
  // The developer's store serves other profiles and tests: Remove old versions never touches it.
  if (linked) core.toolchains.markStoreShared();
  else await seedFixtureToolchainStore(store, { webOutput: fixtureWebOutput() });
}

/**
 * A C++ game's Mac app export. The `.app` is assembled from the lane's admitted window build, the
 * store's pinned ANGLE, the build's assets and the licence notices, with a host-written
 * `Info.plist`; it is staged beside the target, scanned for held credentials, signed ad hoc inside
 * out (never `--deep`) and swapped into place, with the export marker and a README beside it.
 * Developer ID signing and notarization are argv builders that run only for a person, behind
 * `GENEX_EXPORT_SIGN_IDENTITY_OK=1`, which no row here sets for a real `codesign`. The pure rows
 * run on every POSIX host over fake executables and a fake `exec`; the darwin rows build a stub
 * game with clang, sign it with the real `codesign`, start it, and export the real starter built
 * by the real lane against the dev store.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import {
  ExportError,
  ExportRefusal,
  ExportSigning,
  type ExportSigningChoice,
} from "../../src/shared/game-export-contract.ts";
import { BuildTarget, GameStack, ProjectKind, type ProjectShape } from "../../src/shared/game-project.ts";
import { MAC_GAME_RPATH, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import { layoutFor, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { exportMacGame, type NativeExportDeps } from "../../src/main/core/native-export-run.ts";
import { CppBuildPurpose, CppBuilds } from "../../src/main/cpp-build.ts";
import { exportPublicGame } from "../../src/substrate/game-export.ts";
import {
  type AdmittedMacBundle,
  admitMacBundle,
  type BundleExec,
  type MacAngle,
  readMachO,
} from "../../src/substrate/native-bundle.ts";
import {
  adhocSignArgv,
  appNameOf,
  developerIdSignArgv,
  exportMacApp,
  gameNotices,
  type MacExportRequest,
  type MacNotice,
  notarizeArgv,
  storeNotices,
} from "../../src/substrate/native-export.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { currentLock, locateToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { DEV_TOOLCHAINS, needsPrewarmed, needsTools } from "../helpers/dev-toolchains.ts";
import { dylib, gameCommands, macClang, macClangSkip, machO } from "../helpers/macho.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { raylibLanes } from "../helpers/game-lanes.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "raylib-W3-EXPORT");
const FIXTURES = path.join(REPO, "tests", "cpp", "bundle_fixtures");
const TEMPLATE = path.join(REPO, "src", "game-template-cpp");
const POSIX = process.platform === "win32" && "POSIX links and modes";
const DARWIN = process.platform !== "darwin" && "not run: plutil and codesign are a Mac's";
const MAC_HOST =
  process.platform === "darwin" && process.arch === "arm64"
    ? {}
    : { skip: "not run: Mac builds need an Apple silicon Mac" };

const BUNDLE_ID = "games.genex.game.0123456789ab";
const GOOD_GAME = () => machO({ commands: gameCommands() });
const TOKEN = "genex-FAKE-held-token-for-the-mac-export";
const NOW = Date.UTC(2026, 9, 1, 23, 59, 30);
const SIGNING_GATE = "GENEX_EXPORT_SIGN_IDENTITY_OK";
const DEVELOPER_ID: ExportSigningChoice = {
  kind: ExportSigning.DeveloperId,
  identity: "Developer ID Application: Pat Example (ABCDE12345)",
  keychainProfile: "genex-notary",
};
const ADHOC: ExportSigningChoice = { kind: ExportSigning.AdHoc };
const RAYLIB_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.cpp",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RaylibCpp,
  serve: ".",
};

/** A host program call as the fake `exec` records it: the program, then its arguments. */
type Call = string[];

/** An `exec` that records every call and answers `code` (codesign, plutil, notarytool never run). */
function fakeExec(code = 0): { exec: BundleExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: BundleExec = async (file, args) => {
    calls.push([file, ...args]);
    return { code, stdout: "", stderr: code === 0 ? "" : "refused by the fake" };
  };
  return { exec, calls };
}

/** codesign, plutil and the stub game, without a shell: what the host's `exec` is in production. */
const hostExec: BundleExec = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
};

/** Every entry under `dir` (links not followed), `/`-separated and sorted; `[]` when there is no `dir`. */
async function tree(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => entry.split(path.sep).join("/")).sort();
}

/** The store's Mac ANGLE: two libraries, the manifest pinning them, and its licences folder. */
async function storeWith(base: string, libraries: { egl?: Buffer; gles?: Buffer } = {}): Promise<MacAngle> {
  const dir = path.join(base, "store", "angle-macos");
  await mkdir(path.join(dir, "licenses"), { recursive: true });
  const egl = libraries.egl ?? dylib("@rpath/libEGL.dylib");
  const gles = libraries.gles ?? dylib("@rpath/libGLESv2.dylib");
  await writeFile(path.join(dir, "libEGL.dylib"), egl);
  await writeFile(path.join(dir, "libGLESv2.dylib"), gles);
  await writeFile(path.join(dir, "licenses", "angle.txt"), "ANGLE: BSD 3-Clause\n");
  await writeFile(path.join(dir, "licenses", "third_party_zlib.txt"), "zlib licence\n");
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const manifest = JSON.stringify({
    schema: 1,
    files: {
      "libEGL.dylib": { sha256: sha(egl), size: egl.length },
      "libGLESv2.dylib": { sha256: sha(gles), size: gles.length },
    },
  });
  await writeFile(path.join(dir, "manifest.json"), manifest);
  return {
    dir,
    egl: path.join(dir, "libEGL.dylib"),
    gles: path.join(dir, "libGLESv2.dylib"),
    manifestSha256: sha(Buffer.from(manifest)),
  };
}

/** The store's raylib source, as far as the notices read it: raylib's, GLFW's and miniaudio's licences. */
async function raylibSourceWith(base: string): Promise<string> {
  const dir = path.join(base, "store", "raylib");
  await mkdir(path.join(dir, "src", "external", "glfw"), { recursive: true });
  await writeFile(path.join(dir, "LICENSE"), "raylib: zlib/libpng licence\n");
  await writeFile(path.join(dir, "src", "external", "glfw", "LICENSE.md"), "GLFW: zlib/libpng licence\n");
  await writeFile(
    path.join(dir, "src", "external", "miniaudio.h"),
    "/* miniaudio header */\nint ma_version(void);\n/*\nminiaudio: public domain or MIT No Attribution\n*/\n",
  );
  return dir;
}

/** A workspace: the game folder (with `third_party/`), the exports root, the lane's `out/` and the store. */
async function workspace(prefix: string, files: { game?: Buffer; assets?: Record<string, Buffer | string> } = {}) {
  const base = await realpath(await tmpDir(prefix));
  const game = path.join(base, "games", "pong");
  await mkdir(path.join(game, "third_party", "box2d"), { recursive: true });
  await writeFile(path.join(game, "third_party", "box2d", "LICENSE"), "box2d: MIT\n");
  await mkdir(path.join(game, "third_party", "stb"), { recursive: true });
  await writeFile(path.join(game, "third_party", "stb", "COPYING.txt"), "stb: public domain\n");
  await writeFile(path.join(game, "third_party", "stb", "stb_image.h"), "/* not a licence */\n");
  const out = path.join(base, "build", "out");
  await mkdir(path.join(out, "assets", "sprites"), { recursive: true });
  await writeFile(path.join(out, "game"), files.game ?? GOOD_GAME(), { mode: 0o755 });
  await writeFile(path.join(out, "game-headless"), GOOD_GAME(), { mode: 0o755 });
  for (const [rel, bytes] of Object.entries(files.assets ?? { "sprites/ship.png": "png bytes", "level.json": "{}" })) {
    await mkdir(path.dirname(path.join(out, "assets", rel)), { recursive: true });
    await writeFile(path.join(out, "assets", rel), bytes);
  }
  const angle = await storeWith(base);
  const raylib = await raylibSourceWith(base);
  const exportsRoot = path.join(base, "exports");
  return { base, game, out, angle, raylib, exportsRoot, target: path.join(exportsRoot, "pong-mac") };
}

/** The window build admitted from `out/`. */
async function admittedWindow(out: string, mode: NativeRunMode = NativeRunMode.Window): Promise<AdmittedMacBundle> {
  const admission = await admitMacBundle(out, { mode });
  assert.ok(admission.ok, JSON.stringify(admission));
  return admission.bundle;
}

/** A complete request over a workspace, with `patch` applied. */
async function requestFor(
  w: Awaited<ReturnType<typeof workspace>>,
  exec: BundleExec,
  patch: Partial<MacExportRequest> = {},
): Promise<MacExportRequest> {
  const notices: MacNotice[] = [
    ...storeNotices({ raylibSource: w.raylib, angleDir: w.angle.dir }),
    ...(await gameNotices(w.game)),
  ];
  return {
    admitted: await admittedWindow(w.out),
    angle: w.angle,
    notices,
    bundleId: BUNDLE_ID,
    title: "Pong & <Co>",
    fallbackName: "pong",
    signing: ADHOC,
    source: w.game,
    target: w.target,
    exportsRoot: w.exportsRoot,
    exec,
    now: () => NOW,
    secretValues: [TOKEN],
    env: {},
    ...patch,
  };
}

/** Whether two files hold the same bytes (never `deepEqual` on megabytes: its diff alone can exhaust memory). */
async function sameBytes(a: string, b: string): Promise<boolean> {
  return (await readFile(a)).equals(await readFile(b));
}

/** The `.studio-export-*` staging folders left beside a target. */
async function stagingLeft(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.startsWith(".studio-export-"));
}

/** What a refused export must leave: no target, no staging folder, nothing spawned. */
async function assertNothingWritten(w: { exportsRoot: string; target: string }, calls: Call[], label: string) {
  assert.equal(existsSync(w.target), false, `${label}: no export folder`);
  assert.deepEqual(await stagingLeft(w.exportsRoot), [], `${label}: no staging folder`);
  assert.deepEqual(calls, [], `${label}: nothing spawned`);
}

const refusedWith = (code: ExportRefusal, detail?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof ExportError, String(error));
  assert.equal(error.code, code, error.message);
  if (detail) assert.match(error.message, detail);
  return true;
};

const APP = "Pong & <Co>.app";
const CODESIGN = "/usr/bin/codesign";

/** Everything a Mac app export of the workspace's game holds, folders included. */
const APP_TREE = [
  "Contents",
  "Contents/Frameworks",
  "Contents/Frameworks/libEGL.dylib",
  "Contents/Frameworks/libGLESv2.dylib",
  "Contents/Info.plist",
  "Contents/MacOS",
  "Contents/MacOS/game",
  "Contents/Resources",
  "Contents/Resources/assets",
  "Contents/Resources/assets/level.json",
  "Contents/Resources/assets/sprites",
  "Contents/Resources/assets/sprites/ship.png",
  "Contents/Resources/notices",
  "Contents/Resources/notices/NOTICES.txt",
  "Contents/Resources/notices/angle",
  "Contents/Resources/notices/angle/angle.txt",
  "Contents/Resources/notices/angle/third_party_zlib.txt",
  "Contents/Resources/notices/glfw",
  "Contents/Resources/notices/glfw/LICENSE.md",
  "Contents/Resources/notices/miniaudio",
  "Contents/Resources/notices/miniaudio/LICENSE.txt",
  "Contents/Resources/notices/raylib",
  "Contents/Resources/notices/raylib/LICENSE",
  "Contents/Resources/notices/third_party",
  "Contents/Resources/notices/third_party/box2d",
  "Contents/Resources/notices/third_party/box2d/LICENSE",
  "Contents/Resources/notices/third_party/stb",
  "Contents/Resources/notices/third_party/stb/COPYING.txt",
];

describe("exportMacApp: the app's layout", { skip: POSIX }, () => {
  it("lays out the app, its README and the marker beside it, and signs it ad hoc inside out", async () => {
    const w = await workspace("mac-export-layout-");
    const { exec, calls } = fakeExec();
    const result = await exportMacApp(await requestFor(w, exec));
    const target = w.target;
    const app = path.join(target, APP);
    assert.equal(result.app, app);
    assert.equal(result.signed, ExportSigning.AdHoc);
    assert.deepEqual((await readdir(target)).sort(), [".studio-export.json", APP, "README.txt"]);
    assert.deepEqual(await tree(app), APP_TREE);
    assert.equal(result.files, 14);
    assert.ok(
      await sameBytes(path.join(app, "Contents", "MacOS", "game"), path.join(w.out, "game")),
      "the window build",
    );
    assert.equal(((await lstat(path.join(app, "Contents", "MacOS", "game"))).mode & 0o111) !== 0, true, "executable");
    const marker = JSON.parse(await readFile(path.join(target, ".studio-export.json"), "utf8"));
    assert.equal(marker.studioExport, 1);
    assert.equal(marker.destination, BuildTarget.Mac);
    assert.equal(marker.app, APP);
    assert.equal(
      existsSync(path.join(app, ".studio-export.json")),
      false,
      "the marker is beside the app, never inside",
    );
    // Signed in the staging folder beside the target, then swapped in whole.
    const staged = calls[2]?.at(-1) ?? "";
    assert.equal(path.basename(staged), APP);
    assert.equal(path.dirname(path.dirname(staged)), path.dirname(target));
    const frameworks = path.join(staged, "Contents", "Frameworks");
    const adhoc = [CODESIGN, "--force", "--sign", "-", "--timestamp=none"];
    assert.deepEqual(calls, [
      [...adhoc, path.join(frameworks, "libEGL.dylib")],
      [...adhoc, path.join(frameworks, "libGLESv2.dylib")],
      [...adhoc, staged],
      [CODESIGN, "--verify", "--strict", staged],
    ]);
  });

  it("writes a host Info.plist: the title, the library's bundle id, the window executable, no LSUIElement", async () => {
    const w = await workspace("mac-export-plist-");
    const { exec } = fakeExec();
    await exportMacApp(await requestFor(w, exec));
    const plist = await readFile(path.join(w.target, APP, "Contents", "Info.plist"), "utf8");
    const value = (key: string) => new RegExp(`<key>${key}</key>\\n\\t([^\\n]*)`).exec(plist)?.[1];
    assert.equal(value("CFBundleName"), "<string>Pong &amp; &lt;Co&gt;</string>");
    assert.equal(value("CFBundleDisplayName"), "<string>Pong &amp; &lt;Co&gt;</string>");
    assert.equal(value("CFBundleIdentifier"), `<string>${BUNDLE_ID}</string>`);
    assert.equal(value("CFBundleExecutable"), "<string>game</string>");
    assert.equal(value("CFBundlePackageType"), "<string>APPL</string>");
    assert.equal(value("CFBundleShortVersionString"), "<string>1.0</string>");
    assert.equal(value("CFBundleVersion"), "<string>2026.1001.2359</string>");
    assert.equal(value("LSMinimumSystemVersion"), "<string>13.0</string>");
    assert.equal(value("NSHighResolutionCapable"), "<true/>");
    assert.equal(value("LSApplicationCategoryType"), "<string>public.app-category.games</string>");
    // Lane FR: macOS 26 reads LSSupportsGameMode, macOS 14 and 15 GCSupportsGameMode.
    assert.equal(value("LSSupportsGameMode"), "<true/>");
    assert.equal(value("GCSupportsGameMode"), "<true/>");
    assert.equal(plist.includes("LSUIElement"), false, "a player's app has a Dock icon");
  });

  it("plutil -lint accepts the Info.plist (darwin)", { skip: DARWIN }, async () => {
    const w = await workspace("mac-export-plutil-");
    await exportMacApp(await requestFor(w, fakeExec().exec));
    const linted = await hostExec("/usr/bin/plutil", ["-lint", path.join(w.target, APP, "Contents", "Info.plist")]);
    assert.equal(linted.code, 0, linted.stdout + linted.stderr);
  });
});

describe("exportMacApp: its name, its ANGLE and its notices", { skip: POSIX }, () => {
  it("names the app after the title without a path separator, a colon or a control character, and falls back", () => {
    const cases: Array<[string, string, string]> = [
      ["Pong", "pong", "Pong"],
      ["Pong/../x", "pong", "Pong..x"],
      ["a:b\u0000c\nd", "pong", "abcd"],
      ["..hidden", "pong", "hidden"],
      ["", "pong-cpp", "pong-cpp"],
      ["///", ":", "Game"],
      ["x".repeat(200), "pong", "x".repeat(64)],
    ];
    for (const [title, fallback, name] of cases) assert.equal(appNameOf(title, fallback), name, JSON.stringify(title));
  });

  it("copies the store's ANGLE byte for byte, the libraries the lock pins", async () => {
    const w = await workspace("mac-export-angle-");
    await exportMacApp(await requestFor(w, fakeExec().exec));
    const frameworks = path.join(w.target, APP, "Contents", "Frameworks");
    assert.ok(await sameBytes(path.join(frameworks, "libEGL.dylib"), w.angle.egl), "libEGL");
    assert.ok(await sameBytes(path.join(frameworks, "libGLESv2.dylib"), w.angle.gles), "libGLESv2");
  });

  it("carries the notices: raylib, GLFW, miniaudio, ANGLE with its licences, and every third_party licence", async () => {
    const w = await workspace("mac-export-notices-");
    await exportMacApp(await requestFor(w, fakeExec().exec));
    const notices = path.join(w.target, APP, "Contents", "Resources", "notices");
    assert.equal(
      await readFile(path.join(notices, "miniaudio", "LICENSE.txt"), "utf8"),
      "/*\nminiaudio: public domain or MIT No Attribution\n*/\n",
    );
    assert.equal(await readFile(path.join(notices, "third_party", "box2d", "LICENSE"), "utf8"), "box2d: MIT\n");
    const index = await readFile(path.join(notices, "NOTICES.txt"), "utf8");
    for (const named of [
      "raylib/LICENSE",
      "glfw/LICENSE.md",
      "miniaudio/LICENSE.txt",
      "angle/angle.txt",
      "third_party/box2d/LICENSE",
      "third_party/stb/COPYING.txt",
    ])
      assert.ok(index.includes(named), named);
    assert.equal(existsSync(path.join(notices, "third_party", "stb", "stb_image.h")), false, "only licence files");
  });

  it("never follows a link among the game's third_party licences", async () => {
    const w = await workspace("mac-export-notice-link-");
    const secret = path.join(w.base, "id_rsa");
    await writeFile(secret, "-----BEGIN OPENSSH PRIVATE KEY----- not the game's");
    await mkdir(path.join(w.game, "third_party", "evil"));
    await symlink(secret, path.join(w.game, "third_party", "evil", "LICENSE"));
    await symlink(path.join(w.base, "store"), path.join(w.game, "third_party", "linked"), "dir");
    await exportMacApp(await requestFor(w, fakeExec().exec));
    const notices = path.join(w.target, APP, "Contents", "Resources", "notices", "third_party");
    assert.deepEqual((await readdir(notices)).sort(), ["box2d", "stb"]);
    const linked = path.join(w.base, "linked-game");
    await mkdir(linked);
    await symlink(path.join(w.game, "third_party"), path.join(linked, "third_party"), "dir");
    assert.deepEqual(await gameNotices(linked), [], "a third_party that is a link gives no notice");
  });

  it("the README beside the app says how another Mac opens it", async () => {
    const w = await workspace("mac-export-readme-");
    await exportMacApp(await requestFor(w, fakeExec().exec));
    const readme = await readFile(path.join(w.target, "README.txt"), "utf8");
    assert.match(readme, /Privacy & Security/);
    assert.match(readme, /Open Anyway/);
  });
});

describe("exportMacApp: refused builds and held credentials, writing nothing", { skip: POSIX }, () => {
  it("a store ANGLE that is not the pinned build: admission-refused naming angle-digest", async () => {
    const w = await workspace("mac-export-tampered-");
    await writeFile(w.angle.gles, dylib("@rpath/libGLESv2.dylib", ["/usr/lib/libz.1.dylib"]));
    const { exec, calls } = fakeExec();
    await assert.rejects(
      exportMacApp(await requestFor(w, exec)),
      refusedWith(ExportRefusal.AdmissionRefused, new RegExp(NativeRefusal.AngleDigest)),
    );
    await assertNothingWritten(w, calls, "tampered ANGLE");
  });

  it("an executable swapped after admission for one linking OpenGL: admission-refused naming links-opengl", async () => {
    const w = await workspace("mac-export-swapped-");
    const { exec, calls } = fakeExec();
    const request = await requestFor(w, exec);
    const opengl = "/System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL";
    await writeFile(
      path.join(w.out, "game"),
      machO({ commands: gameCommands({ dylibs: ["@rpath/libEGL.dylib", "@rpath/libGLESv2.dylib", opengl] }) }),
    );
    await assert.rejects(
      exportMacApp(request),
      refusedWith(ExportRefusal.AdmissionRefused, new RegExp(NativeRefusal.LinksOpenGl)),
    );
    await assertNothingWritten(w, calls, "swapped executable");
  });

  it("the headless build is never exported: admission-refused", async () => {
    const w = await workspace("mac-export-headless-");
    const { exec, calls } = fakeExec();
    const request = await requestFor(w, exec, { admitted: await admittedWindow(w.out, NativeRunMode.Headless) });
    await assert.rejects(exportMacApp(request), refusedWith(ExportRefusal.AdmissionRefused));
    await assertNothingWritten(w, calls, "headless");
  });

  for (const [name, files] of [
    ["a held token in the executable", { game: Buffer.concat([GOOD_GAME(), Buffer.from(TOKEN)]) }],
    ["a held token in an asset", { assets: { "save.json": `{"key":"${TOKEN}"}` } }],
  ] as const) {
    it(`${name}: secret-found, nothing in place`, async () => {
      const w = await workspace("mac-export-secret-", files);
      const { exec, calls } = fakeExec();
      await assert.rejects(exportMacApp(await requestFor(w, exec)), (error: unknown) => {
        refusedWith(ExportRefusal.SecretFound)(error);
        assert.equal((error as Error).message.includes(TOKEN), false, "the refusal never repeats the value");
        return true;
      });
      await assertNothingWritten(w, calls, name);
    });
  }
});

describe("exportMacApp: refused folders and signings, writing nothing", { skip: POSIX }, () => {
  it("a folder Genex did not make: not-an-export-folder, left as it was", async () => {
    const w = await workspace("mac-export-foreign-");
    await mkdir(w.target, { recursive: true });
    await writeFile(path.join(w.target, "thesis.txt"), "mine");
    const { exec, calls } = fakeExec();
    await assert.rejects(exportMacApp(await requestFor(w, exec)), refusedWith(ExportRefusal.NotAnExportFolder));
    assert.deepEqual(await readdir(w.target), ["thesis.txt"]);
    assert.deepEqual(await stagingLeft(w.exportsRoot), []);
    assert.deepEqual(calls, []);
  });

  it("hostile targets are refused before anything is made there", async () => {
    const w = await workspace("mac-export-hostile-");
    const outside = path.join(w.base, "outside");
    await mkdir(outside);
    await mkdir(w.exportsRoot, { recursive: true });
    const linkedFolder = path.join(w.exportsRoot, "linked-mac");
    await symlink(outside, linkedFolder, "dir");
    const file = path.join(w.exportsRoot, "a-file");
    await writeFile(file, "a file");
    await symlink(outside, path.join(w.exportsRoot, "out-link"), "dir");
    const rows: Array<[string, string]> = [
      ["a symlinked folder", linkedFolder],
      ["a file", file],
      ["a folder inside the game", path.join(w.game, "exports", "pong-mac")],
      ["a link out of the exports root", path.join(w.exportsRoot, "out-link", "pong-mac")],
      ["a folder outside the exports root", path.join(outside, "pong-mac")],
      ["the exports root's parent by traversal", path.join(w.exportsRoot, "..", "pong-mac")],
    ];
    for (const [label, target] of rows) {
      const { exec, calls } = fakeExec();
      const before = { outside: await tree(outside), game: await tree(w.game), exports: await tree(w.exportsRoot) };
      await assert.rejects(exportMacApp(await requestFor(w, exec, { target })), Error, label);
      assert.deepEqual(await tree(outside), before.outside, `${label}: outside untouched`);
      assert.deepEqual(await tree(w.game), before.game, `${label}: the game untouched`);
      assert.deepEqual(await tree(w.exportsRoot), before.exports, `${label}: exports untouched`);
      assert.equal(await readFile(file, "utf8"), "a file", label);
      assert.deepEqual(calls, [], `${label}: nothing spawned`);
    }
  });

  it("unsigned is no way to export a Mac app: signing-invalid", async () => {
    const w = await workspace("mac-export-unsigned-");
    const { exec, calls } = fakeExec();
    const request = await requestFor(w, exec, { signing: { kind: ExportSigning.None } });
    await assert.rejects(exportMacApp(request), refusedWith(ExportRefusal.SigningInvalid));
    await assertNothingWritten(w, calls, "unsigned");
  });

  it("Developer ID without the gate, or not asked by a person: signing-unavailable, nothing spawned", async () => {
    const w = await workspace("mac-export-devid-");
    const rows: Array<[string, Partial<MacExportRequest>]> = [
      ["no gate, a person", { person: true, env: {} }],
      ["the gate open, not a person", { person: false, env: { [SIGNING_GATE]: "1" } }],
      ["the gate set to anything but 1", { person: true, env: { [SIGNING_GATE]: "true" } }],
    ];
    for (const [label, patch] of rows) {
      const { exec, calls } = fakeExec();
      const request = await requestFor(w, exec, { signing: DEVELOPER_ID, ...patch });
      await assert.rejects(exportMacApp(request), refusedWith(ExportRefusal.SigningUnavailable), label);
      await assertNothingWritten(w, calls, label);
    }
  });

  it("a failed signature leaves no app and no staging folder", async () => {
    const w = await workspace("mac-export-signfail-");
    await assert.rejects(exportMacApp(await requestFor(w, fakeExec(1).exec)), Error);
    assert.equal(existsSync(w.target), false);
    assert.deepEqual(await stagingLeft(w.exportsRoot), []);
  });
});

describe("exportMacApp: beside the web export, and again", { skip: POSIX }, () => {
  it("the web export and the Mac export are siblings: neither wipes the other", async () => {
    const w = await workspace("mac-export-siblings-");
    const page = path.join(w.base, "page");
    await mkdir(page);
    await writeFile(path.join(page, "index.html"), "<p>pong</p>");
    const web = path.join(w.exportsRoot, "pong");
    await exportPublicGame(page, web, ["index.html"]);
    await exportMacApp(await requestFor(w, fakeExec().exec));
    assert.ok(existsSync(path.join(web, "index.html")), "the web export stays");
    await exportPublicGame(page, web, ["index.html"]);
    assert.ok(existsSync(path.join(w.target, APP, "Contents", "MacOS", "game")), "the Mac export stays");
    await exportMacApp(await requestFor(w, fakeExec().exec, { now: () => NOW + 1000 }));
    assert.deepEqual(
      (await readdir(w.exportsRoot)).sort(),
      ["pong", "pong-mac"],
      "a second export replaces its own folder only",
    );
  });
});

describe("exportMacApp: staged where no sandboxed process writes", { skip: POSIX }, () => {
  it("links planted in the exports folder while the app is signed change nothing outside it", async () => {
    const w = await workspace("mac-export-staging-");
    const victim = path.join(w.base, "victim.txt");
    await writeFile(victim, "the person's own file");
    const planted: string[] = [];
    const calls: Call[] = [];
    // A sandboxed process watching the exports folder acts while the host signs: it plants links
    // named like the README and the marker the host writes next in any staging folder it finds.
    const exec: BundleExec = async (file, args) => {
      calls.push([file, ...args]);
      for (const name of (existsSync(w.exportsRoot) ? await readdir(w.exportsRoot) : []).filter((entry) =>
        entry.startsWith(".studio-export-"),
      ))
        for (const file of ["README.txt", ".studio-export.json"]) {
          await symlink(victim, path.join(w.exportsRoot, name, file)).catch(() => {});
          planted.push(path.join(name, file));
        }
      return { code: 0, stdout: "", stderr: "" };
    };
    const stagingRoot = path.join(w.base, "export-staging");
    await exportMacApp(await requestFor(w, exec, { stagingRoot }));
    assert.equal(await readFile(victim, "utf8"), "the person's own file");
    assert.deepEqual(planted, [], "nothing was staged in the exports folder");
    assert.equal((await lstat(path.join(w.target, "README.txt"))).isFile(), true);
    const staged = calls[0]?.at(-1) ?? "";
    assert.ok(staged.startsWith(`${stagingRoot}${path.sep}`), `signed in the host's own folder: ${staged}`);
    assert.deepEqual(await stagingLeft(stagingRoot), []);
  });
});

describe("the signing argv", () => {
  const app = "/exports/pong-mac/Pong.app";
  const libraries = [`${app}/Contents/Frameworks/libEGL.dylib`, `${app}/Contents/Frameworks/libGLESv2.dylib`];

  it("ad hoc: each library, then the app; --timestamp=none; never --deep", () => {
    assert.deepEqual(adhocSignArgv(app, libraries), [
      { file: CODESIGN, args: ["--force", "--sign", "-", "--timestamp=none", libraries[0]] },
      { file: CODESIGN, args: ["--force", "--sign", "-", "--timestamp=none", libraries[1]] },
      { file: CODESIGN, args: ["--force", "--sign", "-", "--timestamp=none", app] },
    ]);
  });

  it("Developer ID: --timestamp and the hardened runtime, the libraries before the app, never --deep", () => {
    if (DEVELOPER_ID.kind !== ExportSigning.DeveloperId) throw new Error("a Developer ID choice");
    const steps = developerIdSignArgv(app, libraries, DEVELOPER_ID);
    const flags = ["--force", "--sign", DEVELOPER_ID.identity, "--timestamp", "--options", "runtime"];
    assert.deepEqual(steps, [
      { file: CODESIGN, args: [...flags, libraries[0]] },
      { file: CODESIGN, args: [...flags, libraries[1]] },
      { file: CODESIGN, args: [...flags, app] },
    ]);
    assert.ok(steps.every((step) => !step.args.includes("--deep")));
  });

  it("notarization: zip with the parent kept, submit and wait, staple, then ask Gatekeeper", () => {
    assert.deepEqual(notarizeArgv(app, "/tmp/Pong.zip", "genex-notary"), [
      { file: "/usr/bin/ditto", args: ["-c", "-k", "--keepParent", app, "/tmp/Pong.zip"] },
      {
        file: "/usr/bin/xcrun",
        args: ["notarytool", "submit", "/tmp/Pong.zip", "--keychain-profile", "genex-notary", "--wait"],
      },
      { file: "/usr/bin/xcrun", args: ["stapler", "staple", app] },
      { file: "/usr/sbin/spctl", args: ["-a", "-vv", "-t", "exec", app] },
    ]);
  });

  it("Developer ID runs only for a person with the gate open: sign inside out, verify, notarize (fake exec)", {
    skip: POSIX,
  }, async () => {
    const w = await workspace("mac-export-devid-run-");
    const { exec, calls } = fakeExec();
    const request = await requestFor(w, exec, { signing: DEVELOPER_ID, person: true, env: { [SIGNING_GATE]: "1" } });
    const result = await exportMacApp(request);
    assert.equal(result.signed, ExportSigning.DeveloperId);
    const programs = calls.map((call) => `${path.basename(call[0] ?? "")} ${call[1] ?? ""}`);
    assert.deepEqual(programs, [
      "codesign --force",
      "codesign --force",
      "codesign --force",
      "codesign --verify",
      "ditto -c",
      "xcrun notarytool",
      "xcrun stapler",
      "spctl -a",
    ]);
    assert.ok(calls.every((call) => !call.includes("--deep")));
  });
});

let libraries = 0;
/** The core's services for a Mac export over a lite core's real library and a lane that answers `out/`. */
async function deps(w: Awaited<ReturnType<typeof workspace>>, over: Partial<NativeExportDeps> = {}) {
  libraries += 1;
  const { core } = await coreLite({ gamesRoot: path.join(w.base, `library-${libraries}`) });
  const game = await core.games.scaffold("pong", {
    title: "Pong",
    stack: GameStack.RaylibCpp,
    caller: ScaffoldCaller.Internal,
    targets: [BuildTarget.Web, BuildTarget.Mac],
  });
  const builds: unknown[] = [];
  const { exec, calls } = fakeExec();
  const lock = { version: 1 as const, entries: {}, digest: "e".repeat(64) };
  const native: NativeExportDeps = {
    host: StudioPlatform.Mac,
    games: core.games,
    gameBuilds: raylibLanes({
      ensure: async (input) => {
        builds.push(input);
        return { ok: true, output: w.out, lastGood: w.out, problem: null, ran: true };
      },
    }),
    toolchains: {
      currentLock: async () => lock,
      locate: async () => ({
        ok: true,
        toolchain: {
          lock,
          cmake: "",
          ninja: "",
          emscripten: null,
          genexCmake: {},
          raylibSource: w.raylib,
          angle: w.angle,
        },
      }),
    },
    exec,
    resources: w.base,
    stagingRoot: path.join(w.base, "export-staging"),
    exportsRoot: w.exportsRoot,
    secretValues: () => [TOKEN],
    now: () => NOW,
    env: {},
    ...over,
  };
  return { core, game, native, builds, calls };
}

describe("exportMacGame", { skip: POSIX }, () => {
  it("builds the Mac window target for export, then exports it under the bundle id the library keeps", async () => {
    const w = await workspace("mac-export-game-");
    const { core, game, native, builds } = await deps(w);
    const first = await exportMacGame(native, { game, targetDir: w.target, signing: ADHOC });
    assert.equal(first.destination, BuildTarget.Mac);
    assert.equal(first.artifact, path.join(w.target, "Pong.app"));
    assert.deepEqual(
      builds.map((input) => {
        const { target, purpose } = input as { target: string; purpose: string };
        return [target, purpose];
      }),
      [[BuildTarget.Mac, CppBuildPurpose.Export]],
    );
    const plist = () => readFile(path.join(w.target, "Pong.app", "Contents", "Info.plist"), "utf8");
    const id = await core.games.bundleIdFor("pong");
    assert.ok((await plist()).includes(`<string>${id}</string>`));
    await exportMacGame(native, { game, targetDir: w.target, signing: ADHOC });
    assert.ok((await plist()).includes(`<string>${id}</string>`), "a second export reuses the recorded id");
    assert.equal(await core.games.bundleIdFor("pong"), id);
  });

  it("refuses what it cannot export before anything is built or written", async () => {
    const w = await workspace("mac-export-game-refused-");
    const { game, native, builds, calls } = await deps(w);
    const rows: Array<[string, NativeExportDeps, typeof game, ExportSigningChoice, ExportRefusal]> = [
      ["off a Mac", { ...native, host: StudioPlatform.Windows }, game, ADHOC, ExportRefusal.MacBuildsNeedAMac],
      [
        "a game without the Mac among its destinations",
        native,
        { ...game, destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web] } },
        ADHOC,
        ExportRefusal.NotADestination,
      ],
      [
        "a three.js game",
        native,
        { ...game, shape: { ...RAYLIB_SHAPE, kind: ProjectKind.StudioTemplate } },
        ADHOC,
        ExportRefusal.NotADestination,
      ],
      ["Developer ID without the gate", native, game, DEVELOPER_ID, ExportRefusal.SigningUnavailable],
    ];
    for (const [label, d, g, signing, code] of rows) {
      await assert.rejects(exportMacGame(d, { game: g, targetDir: w.target, signing }), refusedWith(code), label);
      assert.deepEqual(builds, [], `${label}: nothing built`);
      await assertNothingWritten(w, calls, label);
    }
  });

  it("a failed build is build-failed; a refused admission is admission-refused naming the refusal", async () => {
    const w = await workspace("mac-export-game-failed-");
    const failed = await deps(w, {
      gameBuilds: raylibLanes({
        ensure: async () => ({ ok: false, output: null, lastGood: null, problem: null, ran: true }),
      }),
    });
    await assert.rejects(
      exportMacGame(failed.native, { game: failed.game, targetDir: w.target, signing: ADHOC }),
      refusedWith(ExportRefusal.BuildFailed),
    );
    await writeFile(path.join(w.out, "game"), dylib("@rpath/libgame.dylib"));
    const refused = await deps(w);
    await assert.rejects(
      exportMacGame(refused.native, { game: refused.game, targetDir: w.target, signing: ADHOC }),
      refusedWith(ExportRefusal.AdmissionRefused, new RegExp(NativeRefusal.NotAnExecutable)),
    );
    await assertNothingWritten(w, refused.calls, "admission refused");
  });
});

/** Writes `source` and builds it into `bin/game` against stub ANGLE libraries, as the lane links a game. */
async function clangGame(bin: string, source: string): Promise<{ egl: string; gles: string; exe: string }> {
  await mkdir(bin, { recursive: true });
  const version = "-mmacosx-version-min=13.0";
  const egl = path.join(bin, "libEGL.dylib");
  const gles = path.join(bin, "libGLESv2.dylib");
  await macClang([
    version,
    "-dynamiclib",
    "-install_name",
    "@rpath/libEGL.dylib",
    path.join(FIXTURES, "stub_egl.c"),
    "-o",
    egl,
  ]);
  await macClang([
    version,
    "-dynamiclib",
    "-install_name",
    "@rpath/libGLESv2.dylib",
    path.join(FIXTURES, "stub_gles.c"),
    "-o",
    gles,
  ]);
  const main = path.join(bin, "main.c");
  await writeFile(main, source);
  const exe = path.join(bin, "game");
  await macClang([version, main, "-o", exe, `-L${bin}`, "-lEGL", "-lGLESv2", `-Wl,-rpath,${MAC_GAME_RPATH}`]);
  return { egl, gles, exe };
}

/** A game that binds both ANGLE stubs and exits 0 only when no studio protocol pipe is named. */
const NO_PIPE_GAME = `
#include <stdlib.h>
extern void *eglGetDisplay(void *native_display);
extern const unsigned char *glGetString(unsigned int name);
int main(void) {
  if (!eglGetDisplay(0) || !glGetString(0x1F00)) return 3;
  return getenv("GENEX_STUDIO_FD") ? 2 : 0;
}
`;

describe("a clang-built game, exported and signed for real (darwin)", { skip: macClangSkip() }, () => {
  it("starts without fd 3 from the app, and codesign --verify --strict accepts the ad-hoc app", async () => {
    const w = await workspace("mac-export-clang-");
    const built = await clangGame(path.join(w.base, "clang"), NO_PIPE_GAME);
    await cp(built.exe, path.join(w.out, "game"));
    const angle = await storeWith(path.join(w.base, "clang-store"), {
      egl: await readFile(built.egl),
      gles: await readFile(built.gles),
    });
    const result = await exportMacApp(await requestFor(w, hostExec, { angle, title: "Pong" }));
    const verified = await hostExec(CODESIGN, ["--verify", "--strict", "--verbose=2", result.app]);
    assert.equal(verified.code, 0, verified.stderr);
    const exe = path.join(result.app, "Contents", "MacOS", "game");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GENEX_STUDIO_FD"));
    const started = await execFileAsync(exe, [], { env }).then(
      () => 0,
      (error: { code?: number }) => error.code ?? 1,
    );
    assert.equal(started, 0, "the exported game runs with no studio pipe");
    const piped = await execFileAsync(exe, [], { env: { ...env, GENEX_STUDIO_FD: "3" } }).then(
      () => 0,
      (error: { code?: number }) => error.code ?? 1,
    );
    assert.equal(piped, 2, "the stub does tell the two apart");
    const details = await hostExec(CODESIGN, ["-dv", result.app]);
    assert.match(details.stderr, /Signature=adhoc/);
  });
});

describe("the starter, built for the Mac by the real lane and exported (darwin)", {
  ...needsTools("devStore"),
  ...MAC_HOST,
  ...(process.platform === "darwin" ? needsPrewarmed(BuildTarget.Mac) : {}),
  timeout: 15 * MINUTE_MS,
}, () => {
  let sandbox: ProcessSandbox | null = null;
  before(async () => {
    await mkdir(EVIDENCE, { recursive: true });
  });
  after(async () => {
    await sandbox?.dispose();
  });

  it("plutil and codesign accept the exported starter, which carries the store's ANGLE", async () => {
    const store = await realpath(path.join(DEV_TOOLCHAINS, "dev-store"));
    const toolchains = await realpath(DEV_TOOLCHAINS);
    const lock = await currentLock(store);
    assert.ok(lock, "the dev store has a current lock");
    const located = await locateToolchain(store, lock, [BuildTarget.Mac]);
    if (!located.ok || !located.toolchain.angle || !located.toolchain.raylibSource)
      throw new Error(`the dev store holds no Mac ANGLE or raylib source: ${JSON.stringify(located)}`);
    const { angle, raylibSource } = located.toolchain;
    const root = await realpath(await tmpDir("mac-export-real-"));
    const layout = layoutFor(path.join(root, "userData"));
    const game = path.join(root, "games", "pong");
    await cp(TEMPLATE, game, { recursive: true });
    sandbox = await ProcessSandbox.create({
      writableRoots: [path.join(root, "games")],
      scratchDir: layout.scratch,
      secretPaths: [],
      denyWrite: [...studioBaseDenyWrites(layout, [game]), store, toolchains],
    });
    const box = sandbox;
    const builds = new CppBuilds({
      root: layout.cppBuilds,
      run: (request) => box.run(request),
      locate: (wanted, targets) => locateToolchain(store, wanted, targets),
      currentLock: () => currentLock(store),
      emit: () => {},
      platform: process.platform,
      cores: os.availableParallelism(),
      denyWrite: [store, toolchains, layout.nativeRuns],
      writeLock: async () => {},
    });
    const outcome = await builds.ensure({
      project: "pong",
      dir: game,
      shape: RAYLIB_SHAPE,
      target: BuildTarget.Mac,
      destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, BuildTarget.Mac] },
      purpose: CppBuildPurpose.Export,
      lock,
      recordLock: false,
    });
    assert.ok(outcome.ok && outcome.output, JSON.stringify(outcome.problem));
    const admitted = await admittedWindow(outcome.output);
    const exportsRoot = path.join(root, "exports");
    const result = await exportMacApp({
      admitted,
      angle,
      notices: [...storeNotices({ raylibSource, angleDir: angle.dir }), ...(await gameNotices(game))],
      bundleId: BUNDLE_ID,
      title: "Pong",
      fallbackName: "pong",
      signing: ADHOC,
      source: game,
      target: path.join(exportsRoot, "pong-mac"),
      exportsRoot,
      exec: hostExec,
      secretValues: [TOKEN],
    });
    const plist = path.join(result.app, "Contents", "Info.plist");
    const linted = await hostExec("/usr/bin/plutil", ["-lint", plist]);
    const verified = await hostExec(CODESIGN, ["--verify", "--strict", "--verbose=2", result.app]);
    const frameworks = path.join(result.app, "Contents", "Frameworks");
    await writeFile(
      path.join(EVIDENCE, "real-export.json"),
      `${JSON.stringify({ at: new Date().toISOString(), lock: lock.digest, app: result.app, files: result.files, plutil: linted, codesign: verified }, null, 2)}\n`,
    );
    assert.equal(linted.code, 0, linted.stdout);
    assert.equal(verified.code, 0, verified.stderr);
    // Signing rewrites each file's signature, never what it imports: the store's ANGLE, the lane's game.
    const imports = async (file: string) => (await readMachO(file)).dylibs;
    assert.deepEqual(await imports(path.join(frameworks, "libEGL.dylib")), await imports(angle.egl));
    assert.deepEqual(await imports(path.join(frameworks, "libGLESv2.dylib")), await imports(angle.gles));
    const exe = path.join(result.app, "Contents", "MacOS", "game");
    assert.deepEqual(await imports(exe), await imports(path.join(outcome.output, "game")));
    const notices = await readdir(path.join(result.app, "Contents", "Resources", "notices"));
    assert.deepEqual(notices.sort(), ["NOTICES.txt", "angle", "glfw", "miniaudio", "raylib"]);
  });
});

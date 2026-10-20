/**
 * MP-1b, the Android side of a `[net]` game (multiplayer wiring, G6): the one permission a net
 * export's manifest carries (`android.permission.INTERNET`, never for any other build), the
 * manifest check that holds a package to exactly that, and the bionic link shim for `-lpthread`.
 *
 * The real row links a C program with `-lpthread` through the person's NDK clang (API 29, as the
 * lane does) and needs only the NDK; it skips without one, and `GENEX_REQUIRE_TOOLCHAINS=1`
 * turns the skip into a failure. Nothing here builds libcolyseus or launches a device.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { ANDROID_PINS } from "../../src/shared/toolchain.ts";
import {
  type AndroidManifestSpec,
  AndroidOrientation,
  AndroidPackageError,
  AndroidPackageProblem,
  AndroidPermission,
  androidManifestFacts,
  androidManifestXml,
  checkAndroidManifest,
} from "../../src/substrate/android-package.ts";
import {
  ANDROID_LINK_SHIMS,
  androidLinkShimRustflags,
  androidNdkClang,
  writeAndroidLinkShims,
} from "../../src/main/rust-build-mobile.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);

const SPEC: AndroidManifestSpec = {
  applicationId: "games.genex.game.g0123456789ab",
  label: "Pond",
  versionCode: 1,
  versionName: "1.0",
  orientation: AndroidOrientation.Landscape,
};

/** A packaging refusal's code, or a failure naming what was thrown instead. */
function problemOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AndroidPackageError) return error.code;
    throw error;
  }
  assert.fail("expected an AndroidPackageError");
}

describe("a net export's manifest asks for the network, and only a net export's", () => {
  it("a net Android build's manifest holds android.permission.INTERNET", () => {
    const xml = androidManifestXml({ ...SPEC, network: true });
    assert.deepEqual(androidManifestFacts(xml).permissions, [AndroidPermission.Internet]);
    assert.doesNotThrow(() => checkAndroidManifest(xml, { network: true }));
  });

  for (const [name, spec] of [
    ["a build that names no network", SPEC],
    ["a build that says network: false", { ...SPEC, network: false }],
  ] as const) {
    it(`${name} never gains a permission`, () => {
      const xml = androidManifestXml(spec);
      assert.deepEqual(androidManifestFacts(xml).permissions, []);
      assert.doesNotThrow(() => checkAndroidManifest(xml));
    });
  }

  const INTERNET = `<uses-permission android:name="${AndroidPermission.Internet}" />`;
  const refused: Array<[string, () => string, { network?: boolean }]> = [
    [
      "INTERNET in a build that names no network",
      () => androidManifestXml(SPEC).replace("<application", `${INTERNET}\n  <application`),
      {},
    ],
    [
      "a net manifest checked as a build without network",
      () => androidManifestXml({ ...SPEC, network: true }),
      { network: false },
    ],
    [
      "a second permission beside INTERNET",
      () =>
        androidManifestXml({ ...SPEC, network: true }).replace(
          "<application",
          '<uses-permission android:name="android.permission.RECORD_AUDIO" />\n  <application',
        ),
      { network: true },
    ],
    [
      "INTERNET listed twice",
      () => androidManifestXml({ ...SPEC, network: true }).replace("<application", `${INTERNET}\n  <application`),
      { network: true },
    ],
    [
      "INTERNET spelled uses-permission-sdk-23",
      () =>
        androidManifestXml(SPEC).replace(
          "<application",
          `<uses-permission-sdk-23 android:name="${AndroidPermission.Internet}" />\n  <application`,
        ),
      { network: true },
    ],
    ["a net build whose manifest lost its permission", () => androidManifestXml(SPEC), { network: true }],
  ];
  for (const [name, xml, options] of refused) {
    it(`the manifest check refuses ${name}`, () => {
      assert.equal(
        problemOf(() => checkAndroidManifest(xml(), options)),
        AndroidPackageProblem.ManifestField,
      );
    });
  }
});

/** The NDK the real row links with: `ANDROID_NDK_HOME`, else the newest under the SDK's `ndk/`, else null. */
function installedNdk(): string | null {
  const named = process.env.ANDROID_NDK_HOME;
  if (named && existsSync(named)) return named;
  const sdk = path.join(os.homedir(), "Library", "Android", "sdk", "ndk");
  if (!existsSync(sdk)) return null;
  const versions = readdirSync(sdk).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const pinned = versions.find((version) => version === ANDROID_PINS.ndk);
  const chosen = pinned ?? versions[0];
  return chosen === undefined ? null : path.join(sdk, chosen);
}

/** The skip a real row takes without an NDK, or none; `GENEX_REQUIRE_TOOLCHAINS=1` fails instead. */
function ndkRow(ndk: string | null): { skip?: string } {
  if (ndk !== null) return {};
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1")
    throw new Error("GENEX_REQUIRE_TOOLCHAINS=1: the Android NDK absent");
  return { skip: "not run: the Android NDK absent" };
}

describe("-lpthread on bionic links against the shim", () => {
  it("the shim folder holds one empty ar archive per library bionic folds into libc", async () => {
    const dir = await tmpDir("android-shims-");
    await writeAndroidLinkShims(dir);
    for (const name of ANDROID_LINK_SHIMS) {
      assert.equal(await readFile(path.join(dir, name), "latin1"), "!<arch>\n");
    }
    assert.deepEqual(androidLinkShimRustflags(dir), ["-L", `native=${dir}`]);
  });

  it("refuses a shim folder that is not absolute", async () => {
    await assert.rejects(writeAndroidLinkShims("relative/shims"), TypeError);
  });

  const ndk = installedNdk();
  it("the NDK sysroot does not resolve -lpthread, and the shim does (NDK clang, API 29)", ndkRow(ndk), async () => {
    assert.ok(ndk !== null);
    const clang = androidNdkClang(ndk, process.platform);
    const dir = await tmpDir("android-pthread-");
    const source = path.join(dir, "main.c");
    await writeFile(source, "#include <pthread.h>\nint main(void) { return pthread_self() == 0; }\n");
    const bare = await run(clang, [source, "-o", path.join(dir, "bare"), "-lpthread", "-lm"]).then(
      () => null,
      (error: { stderr?: string }) => error.stderr ?? "",
    );
    assert.ok(bare !== null, "the NDK sysroot resolved -lpthread: the shim is not needed");
    assert.match(bare, /unable to find library -lpthread/);
    const shims = path.join(dir, "shims");
    await writeAndroidLinkShims(shims);
    await run(clang, [source, "-o", path.join(dir, "shimmed"), `-L${shims}`, "-lpthread", "-lm"]);
    assert.ok(existsSync(path.join(dir, "shimmed")));
  });
});

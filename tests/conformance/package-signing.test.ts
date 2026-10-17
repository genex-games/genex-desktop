/**
 * macOS release signing is decided by the environment alone: no identity, no `osxSign` (the
 * finished bundle is signed again ad-hoc once packaged); an identity signs with the hardened
 * runtime and the app's own entitlements; notarization needs the whole App Store Connect API key.
 * A signed build refuses the placeholder bundle id, because Developer ID permissions and Keychain
 * items are keyed by it. Drives scripts/package-signing.cjs, which forge.config.cjs calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import signing from "../../scripts/package-signing.cjs";
import forgeConfig from "../../forge.config.cjs";
import { FuseV1Options } from "@electron/fuses";

const IDENTITY = "Developer ID Application: Example Person (ABCDE12345)";
/** The identifier the fuses' ad-hoc re-sign leaves on a local build: Electron's own. */
const ELECTRON_ID = "com.github.Electron";
const REAL_ID = "com.example.aigamestudio";
const API_KEY = {
  APPLE_API_KEY: "/tmp/AuthKey_ABC.p8",
  APPLE_API_KEY_ID: "ABC123DEFG",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};

test("without a signing identity the build stays ad-hoc: no osxSign and no notarization", () => {
  assert.deepEqual(signing.macSigning({}, REAL_ID), {});
  assert.deepEqual(signing.macSigning({ MACOS_SIGN_IDENTITY: "" }, "local.example"), {});
});

test("a signing identity signs every file with the hardened runtime and the app's entitlements only", () => {
  const { osxSign, osxNotarize } = signing.macSigning({ MACOS_SIGN_IDENTITY: IDENTITY }, REAL_ID);
  assert.equal(osxNotarize, undefined);
  assert.ok(osxSign, "an identity configures osxSign");
  assert.equal(osxSign.identity, IDENTITY);
  for (const file of ["/x/AI Game Studio.app", "/x/AI Game Studio.app/Contents/Frameworks/X Helper (Renderer).app"]) {
    assert.deepEqual(osxSign.optionsForFile(file), { hardenedRuntime: true, entitlements: signing.ENTITLEMENTS });
  }
  const keychain = signing.macSigning(
    { MACOS_SIGN_IDENTITY: IDENTITY, MACOS_SIGN_KEYCHAIN: "/k/release.keychain-db" },
    REAL_ID,
  );
  assert.equal(keychain.osxSign?.keychain, "/k/release.keychain-db");
});

test("the entitlements grant V8's JIT, Apple events for app_look and the microphone (Play's voice chat), nothing else: no camera, no library-validation exemption", async () => {
  const plist = await readFile(signing.ENTITLEMENTS, "utf8");
  const keys = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<(\w+)\s*\/>/g)].map(([, key, value]) => `${key}=${value}`);
  assert.deepEqual(keys, [
    "com.apple.security.cs.allow-jit=true",
    "com.apple.security.automation.apple-events=true",
    "com.apple.security.device.audio-input=true",
  ]);
});

test("a signed build refuses a placeholder bundle id and names the fix", () => {
  assert.throws(
    () => signing.macSigning({ MACOS_SIGN_IDENTITY: IDENTITY }, "local.simeon.ai-game-studio"),
    (error: Error) => error.message.includes("local.simeon.ai-game-studio") && error.message.includes("APP_BUNDLE_ID"),
  );
});

test("the shipped config carries the one bundle id const, so an identity alone cannot sign a placeholder", () => {
  assert.equal(forgeConfig.packagerConfig.appBundleId, signing.APP_BUNDLE_ID);
  assert.equal(forgeConfig.packagerConfig.osxSign, undefined, "the test environment has no signing identity");
});

test("Genex ships as games.genex.desktop, which a Developer ID build signs", () => {
  assert.equal(signing.APP_BUNDLE_ID, "games.genex.desktop");
  assert.ok(signing.macSigning({ MACOS_SIGN_IDENTITY: IDENTITY }, signing.APP_BUNDLE_ID).osxSign);
  const { packagerConfig } = forgeConfig;
  assert.deepEqual([packagerConfig.name, packagerConfig.executableName], ["Genex", "genex"]);
});

test("the packaged binary keeps run-as-node and file:// privileges but refuses NODE_OPTIONS, --inspect and a loose app", () => {
  const plugin = (forgeConfig.plugins as { name: string; fusesConfig: Record<number, boolean> }[]).find(
    (entry) => entry.name === "fuses",
  );
  assert.ok(plugin, "the fuses plugin is configured");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(FuseV1Options).flatMap(([name, index]) =>
        typeof index === "number" ? [[name, plugin.fusesConfig[index]]] : [],
      ),
    ),
    {
      RunAsNode: true,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: undefined,
      GrantFileProtocolExtraPrivileges: true,
      WasmTrapHandlers: undefined,
    },
  );
});

test("notarization needs the signing identity and all three API key values", () => {
  const full = signing.macSigning({ MACOS_SIGN_IDENTITY: IDENTITY, ...API_KEY }, REAL_ID);
  assert.deepEqual(full.osxNotarize, {
    appleApiKey: API_KEY.APPLE_API_KEY,
    appleApiKeyId: API_KEY.APPLE_API_KEY_ID,
    appleApiIssuer: API_KEY.APPLE_API_ISSUER,
  });
  const partial = { MACOS_SIGN_IDENTITY: IDENTITY, APPLE_API_KEY: API_KEY.APPLE_API_KEY };
  assert.throws(
    () => signing.macSigning(partial, REAL_ID),
    (error: Error) => error.message.includes("APPLE_API_KEY_ID") && error.message.includes("APPLE_API_ISSUER"),
  );
  assert.throws(
    () => signing.macSigning(API_KEY, REAL_ID),
    (error: Error) => error.message.includes("MACOS_SIGN_IDENTITY"),
  );
});

test("Windows signing stays off without a certificate: no windowsSign on the packager or the Squirrel maker", () => {
  assert.equal(signing.windowsSigning({}), undefined);
  assert.equal(signing.windowsSigning({ WINDOWS_SIGN_CERTIFICATE_PASSWORD: "only a password" }), undefined);
  assert.equal(forgeConfig.packagerConfig.windowsSign, undefined, "the test environment has no Windows certificate");
  const squirrel = (forgeConfig.makers as { name: string; config: Record<string, unknown> }[]).find(
    (maker) => maker.name === "@electron-forge/maker-squirrel",
  );
  assert.ok(squirrel, "a Squirrel maker is configured");
  assert.equal(squirrel.config.windowsSign, undefined);
});

test("a Windows certificate file, a signing hook or signtool parameters each turn signing on, timestamped", () => {
  const file = signing.windowsSigning({
    WINDOWS_SIGN_CERTIFICATE_FILE: "C:\\certs\\genex.pfx",
    WINDOWS_SIGN_CERTIFICATE_PASSWORD: "secret",
  });
  assert.equal(file?.certificateFile, "C:\\certs\\genex.pfx");
  assert.equal(file?.certificatePassword, "secret");
  assert.match(String(file?.timestampServer), /^https?:\/\//);
  const hook = signing.windowsSigning({ WINDOWS_SIGN_HOOK_MODULE: "C:\\sign\\hook.cjs" });
  assert.equal(hook?.hookModulePath, "C:\\sign\\hook.cjs");
  assert.equal(hook?.certificateFile, undefined);
  const params = signing.windowsSigning({ WINDOWS_SIGN_PARAMS: "/dlib Azure.CodeSigning.Dlib.dll /dmdf meta.json" });
  assert.equal(params?.signWithParams, "/dlib Azure.CodeSigning.Dlib.dll /dmdf meta.json");
});

const codesign = (...args: string[]) => spawnSync("codesign", args, { encoding: "utf8" });

/** A one-executable app bundle whose Info.plist names `bundleId`, as the packager leaves one. */
async function miniApp(bundleId: string): Promise<{ app: string; name: (id: string) => Promise<void> }> {
  const app = path.join(await tmpDir("studio-sign-"), "Mini.app");
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  await copyFile("/usr/bin/true", path.join(app, "Contents", "MacOS", "mini"));
  const name = (id: string) =>
    writeFile(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>mini</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`,
    );
  await name(bundleId);
  return { app, name };
}

// The owner's installed Genex had Desktop refused by macOS without a prompt: tccd "Failed to get
// code requirements" for a signature named com.github.Electron that bound no Info.plist. The fuses'
// ad-hoc re-sign runs before the packager writes the app's own Info.plist.
test("a local macOS build is signed again once packaged, so its signature binds the Info.plist macOS reads", {
  skip: process.platform !== "darwin" && "codesign is macOS's",
}, async () => {
  const { app, name } = await miniApp(ELECTRON_ID);
  assert.equal(codesign("--sign", "-", "--force", "--deep", app).status, 0, "signed as the fuses sign it");
  await name(signing.APP_BUNDLE_ID);
  assert.notEqual(codesign("--verify", "--deep", "--strict", app).status, 0, "a plist written after it breaks it");

  signing.adHocSign(app);
  const verify = codesign("--verify", "--deep", "--strict", app);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(
    codesign("-dv", app).stderr,
    new RegExp(`^Identifier=${signing.APP_BUNDLE_ID.replaceAll(".", "\\.")}$`, "m"),
  );
});

test("forge signs a macOS output ad-hoc after packaging only when no identity signed it", async () => {
  const signed: string[] = [];
  const sign = (app: string) => signed.push(app);
  const output = (platform: string, dir: string) => ({ platform, arch: "arm64", outputPaths: [dir] });
  const local = signing.localSigningHook({}, "Genex", sign);
  await local({}, output("darwin", "/out/Genex-darwin-arm64"));
  await local({}, output("linux", "/out/Genex-linux-arm64"));
  await local({}, output("win32", "/out/Genex-win32-arm64"));
  const developerId = signing.localSigningHook(
    signing.macSigning({ MACOS_SIGN_IDENTITY: IDENTITY }, REAL_ID),
    "Genex",
    sign,
  );
  await developerId({}, output("darwin", "/out/Signed-darwin-arm64"));
  assert.deepEqual(signed, [path.join("/out/Genex-darwin-arm64", "Genex.app")]);
  assert.equal(typeof forgeConfig.hooks.postPackage, "function", "the shipped config signs its local build");
});

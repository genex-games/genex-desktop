/**
 * macOS release signing for forge.config.cjs, decided by the environment alone so the same config
 * makes an ad-hoc local build and a Developer ID release (.github/workflows/release.yml).
 *
 * - No `MACOS_SIGN_IDENTITY`: no `osxSign`, and forge's `postPackage` signs the finished bundle
 *   again ad-hoc (`localSigningHook`), so the build opens only on the Mac that built it.
 * - `MACOS_SIGN_IDENTITY` (optionally `MACOS_SIGN_KEYCHAIN`): hardened runtime and
 *   build/entitlements.mac.plist for the app and every helper.
 * - `APPLE_API_KEY` (path to the .p8), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: notarytool with an
 *   App Store Connect API key; the packager staples the ticket.
 *
 * Windows signing is the same kind of switch for a local build; release builds are signed by
 * SignPath after packaging instead (.github/actions/windows-signpath). With none of the
 * `WINDOWS_SIGN_*` values below, the packager and the Squirrel maker get no `windowsSign` and the
 * build is unsigned. `@electron/windows-sign` then
 * signs the app's executables and Setup.exe with signtool, from one of:
 * - `WINDOWS_SIGN_CERTIFICATE_FILE` (a .pfx), with `WINDOWS_SIGN_CERTIFICATE_PASSWORD`;
 * - `WINDOWS_SIGN_PARAMS`: signtool parameters of their own, such as Azure Artifact Signing's
 *   `/dlib … /dmdf …` or a cloud HSM's certificate selection;
 * - `WINDOWS_SIGN_HOOK_MODULE`: a module that signs each file itself.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

/**
 * The macOS bundle id, under the genex.games domain. Changing it after release resets every
 * installed copy's macOS permissions and Keychain access (docs/release-readiness.md).
 */
const APP_BUNDLE_ID = "games.genex.desktop";
/** Bundle ids with this prefix are placeholders that a Developer ID build refuses. */
const PLACEHOLDER_BUNDLE_PREFIX = "local.";
/** The hardened-runtime entitlements for the app and its helpers. */
const ENTITLEMENTS = path.join(__dirname, "..", "build", "entitlements.mac.plist");
/** The RFC 3161 timestamp server Windows signatures are countersigned by, so they outlive the certificate. */
const WINDOWS_TIMESTAMP_SERVER = "http://timestamp.digicert.com";
/** What a Windows signature names as the signed program and its home. */
const WINDOWS_SIGN_DESCRIPTION = "Genex";
const WINDOWS_SIGN_WEBSITE = "https://github.com/genex-games/genex-desktop";
/** The App Store Connect API key notarytool reads, all or none. */
const NOTARIZE_ENV = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];

const MESSAGE = {
  placeholderBundleId: (id) =>
    `Refusing to sign with the placeholder bundle id "${id}". Set APP_BUNDLE_ID in scripts/package-signing.cjs to the real reverse-DNS id first; changing it after release resets installed copies' permissions.`,
  partialNotarize: (missing) => `Notarization needs all of ${NOTARIZE_ENV.join(", ")}; missing ${missing.join(", ")}.`,
  notarizeUnsigned: "Notarization needs a Developer ID signature: set MACOS_SIGN_IDENTITY too.",
  adHocFailed: (app, why) => `Ad-hoc signing ${app} failed: ${why}`,
};

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ hardenedRuntime: boolean, entitlements: string }} FileSigning
 * @typedef {{ identity: string, keychain?: string, optionsForFile: (file: string) => FileSigning }} OsxSign
 * @typedef {{ appleApiKey: string, appleApiKeyId: string, appleApiIssuer: string }} OsxNotarize
 */

/**
 * The packager's `osxNotarize`, or undefined when no API key value is set.
 * @param {Env} env
 * @param {boolean} signed
 * @returns {OsxNotarize | undefined}
 */
function notarizeOptions(env, signed) {
  const missing = NOTARIZE_ENV.filter((name) => !env[name]);
  if (missing.length === NOTARIZE_ENV.length) return undefined;
  if (missing.length) throw new Error(MESSAGE.partialNotarize(missing));
  if (!signed) throw new Error(MESSAGE.notarizeUnsigned);
  return {
    appleApiKey: String(env.APPLE_API_KEY),
    appleApiKeyId: String(env.APPLE_API_KEY_ID),
    appleApiIssuer: String(env.APPLE_API_ISSUER),
  };
}

/**
 * `{ osxSign?, osxNotarize? }` for the packager config, from the environment and the bundle id.
 * @param {Env} env
 * @param {string} bundleId
 * @returns {{ osxSign?: OsxSign, osxNotarize?: OsxNotarize }}
 */
function macSigning(env, bundleId) {
  const identity = env.MACOS_SIGN_IDENTITY;
  const osxNotarize = notarizeOptions(env, Boolean(identity));
  if (!identity) return {};
  if (bundleId.startsWith(PLACEHOLDER_BUNDLE_PREFIX)) throw new Error(MESSAGE.placeholderBundleId(bundleId));
  /** @type {OsxSign} */
  const osxSign = {
    identity,
    ...(env.MACOS_SIGN_KEYCHAIN ? { keychain: env.MACOS_SIGN_KEYCHAIN } : {}),
    optionsForFile: () => ({ hardenedRuntime: true, entitlements: ENTITLEMENTS }),
  };
  return osxNotarize ? { osxSign, osxNotarize } : { osxSign };
}

/**
 * Sign a finished macOS app bundle again, ad-hoc, as it now is. Without an identity the only
 * signature a local build gets is the one @electron/fuses makes when it flips the fuses, before the
 * packager writes the app's own Info.plist (bundle id, folder-access strings, asar hash): it is
 * named com.github.Electron and binds no Info.plist. macOS's folder privacy (TCC) reads no code
 * requirement from that and refuses the app's agents the Desktop and Documents without asking.
 * @param {string} appPath
 * @param {typeof spawnSync} [run]
 */
function adHocSign(appPath, run = spawnSync) {
  const result = run(
    "codesign",
    ["--sign", "-", "--force", "--deep", "--preserve-metadata=entitlements,flags,runtime", appPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(MESSAGE.adHocFailed(appPath, String(result.stderr || result.error)));
}

/**
 * Forge's `postPackage` hook: each macOS output no identity signed is signed again ad-hoc
 * ({@link adHocSign}); a Developer ID build was signed by the packager's `osxSign`.
 * @param {{ osxSign?: OsxSign }} mac  what {@link macSigning} returned for this build
 * @param {string} productName  the app bundle's name, without `.app`
 * @param {(appPath: string) => void} [sign]
 * @returns {(forgeConfig: unknown, result: { platform: string, outputPaths: string[] }) => Promise<void>}
 */
function localSigningHook(mac, productName, sign = adHocSign) {
  return async (_forgeConfig, { platform, outputPaths }) => {
    if (platform !== "darwin" || mac.osxSign) return;
    for (const dir of outputPaths) sign(path.join(dir, `${productName}.app`));
  };
}

/**
 * @typedef {{ certificateFile?: string, certificatePassword?: string, signWithParams?: string,
 *   hookModulePath?: string, timestampServer: string, description: string, website: string }} WindowsSign
 */

/**
 * `@electron/windows-sign` options for the packager and the Squirrel maker, or undefined (unsigned)
 * while the environment names no certificate, signtool parameters or signing hook.
 * @param {Env} env
 * @returns {WindowsSign | undefined}
 */
function windowsSigning(env) {
  const how = {
    ...(env.WINDOWS_SIGN_CERTIFICATE_FILE
      ? {
          certificateFile: env.WINDOWS_SIGN_CERTIFICATE_FILE,
          certificatePassword: env.WINDOWS_SIGN_CERTIFICATE_PASSWORD,
        }
      : {}),
    ...(env.WINDOWS_SIGN_PARAMS ? { signWithParams: env.WINDOWS_SIGN_PARAMS } : {}),
    ...(env.WINDOWS_SIGN_HOOK_MODULE ? { hookModulePath: env.WINDOWS_SIGN_HOOK_MODULE } : {}),
  };
  if (Object.keys(how).length === 0) return undefined;
  return {
    ...how,
    timestampServer: WINDOWS_TIMESTAMP_SERVER,
    description: WINDOWS_SIGN_DESCRIPTION,
    website: WINDOWS_SIGN_WEBSITE,
  };
}

module.exports = { APP_BUNDLE_ID, ENTITLEMENTS, adHocSign, localSigningHook, macSigning, windowsSigning };

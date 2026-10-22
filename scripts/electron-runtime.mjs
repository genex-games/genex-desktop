import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/** One resolver for all development/test launches, including Electron's lazy install. */
export function resolveElectron(checkout = process.cwd()) {
  const require = createRequire(path.join(checkout, "package.json"));
  try {
    const executable = /** @type {unknown} */ (require("electron"));
    if (typeof executable !== "string") throw new Error("Electron resolver returned no executable path");
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch (error) {
    throw new Error(
      `Pinned Electron is unavailable. Run node node_modules/electron/install.js with network access, then retry. ${error.message}`,
    );
  }
}

/** A language tag as macOS lists one ("ja-JP", "zh-Hant-TW"); anything else is never passed on. */
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * `-AppleLanguages (…)` for `STUDIO_FIXTURE_SYSTEM_LANGUAGES="ja-JP,en-US"`: macOS hands this one
 * process that language list as the computer's (its argument domain; the computer's settings stay
 * as they are), so a fixture launch with `STUDIO_FIXTURE_LANGUAGE=system` meets Genex the way a
 * person on that Mac does. None without it, or off macOS.
 * @param {string} platform @param {NodeJS.ProcessEnv} env @returns {string[]}
 */
function standInLanguages(platform, env) {
  if (platform !== "darwin") return [];
  const tags = (env.STUDIO_FIXTURE_SYSTEM_LANGUAGES ?? "").split(",").map((tag) => tag.trim());
  const kept = tags.filter((tag) => LANGUAGE_TAG.test(tag));
  return kept.length ? ["-AppleLanguages", `(${kept.join(", ")})`] : [];
}

/** Disposable fixture profiles only. Never use mock encryption with real account data. */
export function fixtureElectronArgs(args, platform = process.platform, env = process.env) {
  return [...(platform === "darwin" ? ["--use-mock-keychain"] : []), ...args, ...standInLanguages(platform, env)];
}
/** @param {NodeJS.ProcessEnv} source @returns {NodeJS.ProcessEnv} */
export function fixtureElectronEnv(source = process.env) {
  const env = {
    ...source,
    STUDIO_DISABLE_OS_CREDENTIALS: "1",
    STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS: "0",
    STUDIO_LIVE_CLAUDE_CLI: "0",
    STUDIO_LIVE_OLLAMA: "0",
  };
  for (const key of FIXTURE_SCRUBBED_ENV) delete env[key];
  return env;
}
/**
 * Provider credentials and login homes a fixture run must not inherit. An agent session that
 * drives `studio:dev` carries its own Claude/Codex login in these, and the engines read them.
 */
export const FIXTURE_SCRUBBED_ENV = Object.freeze([
  "ELECTRON_RUN_AS_NODE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "GENEX_TOKEN",
]);

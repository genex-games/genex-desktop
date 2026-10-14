/**
 * Where the coding CLIs keep a sign-in on this Mac (SEC-3).
 *
 * `~/.codex` holds a ChatGPT refresh token when Codex uses its file store, `~/.claude` holds
 * Claude Code's settings and transcripts, and OpenCode keeps every provider it signs in to in
 * `auth.json` under its data folder (`$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`).
 * Studio borrows either subscription as the 'system' login, and `CODEX_HOME` / `CLAUDE_CONFIG_DIR`
 * can move them. No agent process reads or writes any of
 * them: the sandbox denies them, and every contractor is told (Codex) or ruled (Claude) off.
 * One list, so those boundaries cannot drift apart. A CLI still reads its own home — these lists
 * constrain the commands an agent runs, not the CLI process.
 */
import os from "node:os";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";

/** adb's and fastboot's SDK folder. */
const PLATFORM_TOOLS = "platform-tools";
/** The SDK folders whose programs reach a device or start one: either name alone marks a PATH entry as device tools. */
const DEVICE_TOOL_FOLDERS = [PLATFORM_TOOLS, "emulator"] as const;
/** Where Homebrew's `android-platform-tools` cask keeps adb (Apple silicon, then Intel): it links adb into a `bin` every build needs. */
const HOMEBREW_PLATFORM_TOOLS = [
  "/opt/homebrew/Caskroom/android-platform-tools",
  "/usr/local/Caskroom/android-platform-tools",
] as const;

/**
 * The person's other sign-in stores under the home folder, by their segments: SSH keys, the
 * keychains, cloud and GitHub logins, `.netrc`. No agent process reads them (`baseDenyRead`), no
 * worker reaches them (the never-touch list) and no plugin folder is or holds one.
 */
export const HOME_SIGN_IN_STORES: readonly (readonly string[])[] = [
  [".ssh"],
  ["Library", "Keychains"],
  [".aws"],
  [".config", "gh"],
  [".netrc"],
];

/**
 * The sign-in homes to protect: both default homes, the homes the environment points at, and any
 * resolved login home the caller names. Never the home folder itself, one of its ancestors or a
 * relative path — denying those would take the whole machine away from every build.
 */
export function credentialHomes(
  logins: ReadonlyArray<string | null | undefined> = [],
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string[] {
  const candidates = [
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    openCodeDataHome({}, home),
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? openCodeDataHome(env, home) : undefined,
    ...logins,
  ];
  return keptPaths(candidates, home);
}

/** True when `dir` is the home folder or one of its ancestors: denying it would take the whole home away. */
function coversHome(dir: string, home: string): boolean {
  const homeDir = path.resolve(home);
  return dir === homeDir || homeDir.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** Absolute, resolved, never the home folder or above it, each once. */
function keptPaths(candidates: ReadonlyArray<string | null | undefined>, home: string): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const dir = path.resolve(candidate);
    if (coversHome(dir, home) || out.includes(dir)) continue;
    out.push(dir);
  }
  return out;
}

/**
 * Where phone tooling keeps a person's keys and sign-ins (C1): adb's RSA key and the emulator
 * console token (`~/.android`, which `ANDROID_USER_HOME` or `ANDROID_EMULATOR_HOME` can move),
 * the emulator's discovery files (each running emulator's gRPC port and the token that endpoint
 * takes), App Store Connect API keys, provisioning profiles (Xcode 16 and later keep them under
 * `UserData`), Gradle's properties (signing and publishing passwords) and cargo's registry tokens
 * in both the default home and a moved `CARGO_HOME`. No agent process reads them: stage 1 has no
 * agent-driven device runs or publishing. A path that does not exist is still listed (macOS and
 * Linux skip an absent deny; Windows filters it before srt-win sees it).
 */
export function mobileCredentialHomes(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const cargoHomes = [path.join(home, ".cargo"), env.CARGO_HOME].filter((dir) => dir !== undefined);
  const gradleHome = env.GRADLE_USER_HOME;
  const apple = platform !== StudioPlatform.Windows;
  return keptPaths(
    [
      path.join(home, ".android"),
      env.ANDROID_USER_HOME,
      env.ANDROID_EMULATOR_HOME,
      env.ANDROID_SDK_HOME ? path.join(env.ANDROID_SDK_HOME, ".android") : undefined,
      path.join(home, ".emulator_console_auth_token"),
      emulatorDiscovery(env, home, platform),
      path.join(home, ".appstoreconnect"),
      path.join(home, "private_keys"),
      path.join(home, ".private_keys"),
      apple ? path.join(home, "Library", "MobileDevice") : undefined,
      apple ? path.join(home, "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles") : undefined,
      path.join(home, ".gradle"),
      gradleHome ? path.join(gradleHome, "gradle.properties") : undefined,
      ...cargoHomes.flatMap((dir) => [path.join(dir, "credentials"), path.join(dir, "credentials.toml")]),
    ],
    home,
  );
}

/**
 * The folder the Android emulator writes its discovery files in (`avd/running/pid_<n>.ini`, with
 * the gRPC token), read from the installed emulator's own strings: under the Mac's temporary
 * items, `XDG_RUNTIME_DIR` on Linux (absent: the emulator falls back under `~/.android`, already
 * denied), and the local temp folder on Windows.
 */
function emulatorDiscovery(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === StudioPlatform.Mac) return path.join(home, "Library", "Caches", "TemporaryItems", "avd");
  if (platform === StudioPlatform.Windows)
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Temp", "avd");
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "avd") : undefined;
}

/**
 * The Android SDK folders that drive a device: `platform-tools` (adb, fastboot) and `emulator`,
 * in every SDK this machine names (`ANDROID_HOME`, `ANDROID_SDK_ROOT`) and the default one. An
 * agent process neither finds them on PATH nor reads them, so it cannot run them by path (C1).
 * Builds need neither: the NDK, build-tools and platforms stay where they are.
 */
export function deviceToolDirs(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaultAndroidSdk(env, home, platform)];
  const dirs = keptPaths(roots, home).flatMap((root) => DEVICE_TOOL_FOLDERS.map((name) => path.join(root, name)));
  return [...new Set(dirs)];
}

/**
 * Device tools a package manager installed outside any SDK: on macOS, Homebrew's
 * `android-platform-tools` cask, whose `adb` link sits in a `bin` every build keeps on PATH. No
 * agent process reads or starts what the link points at (C1).
 */
export function packagedDeviceTools(platform: NodeJS.Platform = process.platform): string[] {
  return platform === StudioPlatform.Mac ? [...HOMEBREW_PLATFORM_TOOLS] : [];
}

/** Where Android Studio installs the SDK by default on `platform`. */
function defaultAndroidSdk(env: Record<string, string | undefined>, home: string, platform: NodeJS.Platform): string {
  if (platform === StudioPlatform.Mac) return path.join(home, "Library", "Android", "sdk");
  if (platform === StudioPlatform.Windows)
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk");
  return path.join(home, "Android", "Sdk");
}

/**
 * `value` (a PATH) without any folder that holds the device tools: one named `platform-tools` or
 * `emulator` anywhere (an SDK Studio was never told about, a hand-made copy), or one of
 * `toolDirs`. The sandbox's PATH floor and a caller's own PATH both pass through here, so the
 * SDK's `adb` and `emulator` never resolve in an agent process (C1). A link to adb in a shared
 * folder (Homebrew's `bin`) stays on PATH, but what it points at is never started
 * ({@link packagedDeviceTools}).
 */
export function withoutDeviceTools(value: string, toolDirs: readonly string[], delimiter: string): string {
  const denied = new Set(toolDirs.map((dir) => path.resolve(dir)));
  const folders: readonly string[] = DEVICE_TOOL_FOLDERS;
  const keep = (entry: string) => {
    if (!entry) return true;
    if (folders.includes(path.basename(entry).toLowerCase())) return false;
    return !path.isAbsolute(entry) || !denied.has(path.resolve(entry));
  };
  return value.split(delimiter).filter(keep).join(delimiter);
}

/** Where OpenCode keeps its sign-ins (`auth.json`): `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
export function openCodeDataHome(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const data =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  return path.join(data, "opencode");
}

/**
 * Where OpenCode 2.x keeps its background server's password: `service.json` in its config folder
 * (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`). That server runs outside every sandbox,
 * and a sandbox lets its processes onto localhost, so the password is what keeps them off it.
 */
export function openCodeServicePassword(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const config =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(config, "opencode", "service.json");
}

/**
 * The sign-in homes of the CLIs that run inside the studio's own sandbox (OpenCode, which has no
 * sandbox of its own): the only homes a sandbox may exempt for the CLI it runs (`SandboxOptions.ownHome`).
 */
export function sandboxedCliHomes(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string[] {
  return [openCodeDataHome(env, home)];
}

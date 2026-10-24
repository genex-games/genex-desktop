/**
 * Where the coding CLIs keep a sign-in on this Mac (SEC-3).
 *
 * `~/.codex` holds a ChatGPT refresh token when Codex uses its file store, `~/.claude` holds
 * Claude Code's settings and transcripts, OpenCode keeps every provider it signs in to in
 * `auth.json` under its data folder (`$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`),
 * and Cursor's CLI keeps its settings and chats in `~/.cursor` and the sign-in Genex has it write
 * to a file in `auth.json` (`cursorHomes`).
 * Studio borrows either subscription as the 'system' login, and `CODEX_HOME` / `CLAUDE_CONFIG_DIR`
 * can move them. No agent process reads or writes any of
 * them: the sandbox denies them, and every contractor is told (Codex) or ruled (Claude) off.
 * One list, so those boundaries cannot drift apart. A CLI still reads its own home — these lists
 * constrain the commands an agent runs, not the CLI process.
 */
import os from "node:os";
import path from "node:path";

/**
 * Sign-ins under a Mac's Library that Roblox keeps, by their segments under the home folder: the
 * apps' cookie jars (`HTTPStorages`, where Studio and the player keep the `.ROBLOSECURITY` session,
 * a whole account; every other app's jar there is a sign-in too) and Studio's own folder (its local
 * storage, its storage database and StudioMCP's token). Genex's Roblox plugin runs Studio and
 * StudioMCP outside every sandbox; an agent's command, which could be following a planted script,
 * never reads them. Place files live in Documents, not here.
 */
export const ROBLOX_MAC_SIGN_IN_STORES: readonly (readonly string[])[] = [
  ["Library", "HTTPStorages"],
  ["Library", "Roblox"],
];

/** Roblox's sign-ins on Windows, by their segments under `%LOCALAPPDATA%`. */
export const ROBLOX_WINDOWS_SIGN_IN_STORES: readonly (readonly string[])[] = [
  ["Roblox", "LocalStorage"],
  ["Roblox", "StudioMCP"],
];

/**
 * Roblox Studio's Assistant settings, which switch its MCP server on or off: no agent's command
 * writes them (Mac segments under the home folder; Windows under `%LOCALAPPDATA%`).
 */
export const ROBLOX_ASSISTANT_SETTINGS = {
  mac: ["Library", "Roblox", "AssistantSettings"],
  windows: ["Roblox", "AssistantSettings"],
} as const;

/**
 * The person's other sign-in stores under the home folder, by their segments: SSH keys, the
 * keychains, cloud and GitHub logins, `.netrc` and Roblox's sign-ins. No agent process reads them
 * (`baseDenyRead`), no worker reaches them (the never-touch list) and no plugin folder is or holds
 * one.
 */
export const HOME_SIGN_IN_STORES: readonly (readonly string[])[] = [
  [".ssh"],
  ["Library", "Keychains"],
  [".aws"],
  [".config", "gh"],
  [".netrc"],
  ...ROBLOX_MAC_SIGN_IN_STORES,
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
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates = [
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    openCodeDataHome({}, home),
    ...cursorHomes({}, home, platform),
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? openCodeDataHome(env, home) : undefined,
    ...cursorHomes(env, home, platform),
    ...logins,
  ];
  const homeDir = path.resolve(home);
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const dir = path.resolve(candidate);
    const covers = dir === homeDir || homeDir.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
    if (covers || out.includes(dir)) continue;
    out.push(dir);
  }
  return out;
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

/** A variable's folder when it names an absolute one. */
const absolute = (value: string | undefined): string | undefined =>
  value && path.isAbsolute(value) ? value : undefined;

/**
 * Where Cursor's CLI keeps its settings, chats and sign-in: `~/.cursor`, or the folders
 * `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR` and `XDG_CONFIG_HOME` move its settings and chats to; and
 * its `auth.json`, which is in `~/.cursor` on a Mac, `%APPDATA%\Cursor` on Windows and
 * `$XDG_CONFIG_HOME/cursor` (else `~/.config/cursor`) on Linux. On a Mac the CLI keeps a sign-in in
 * the Keychain unless it is told to use the file (`AGENT_CLI_CREDENTIAL_STORE=file`), and Genex
 * always tells it, since no sandbox lets a command reach the Keychain.
 */
export function cursorHomes(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const xdgConfig = absolute(env.XDG_CONFIG_HOME);
  const signIn = () => {
    if (platform === "win32")
      return path.join(absolute(env.APPDATA) ?? path.join(home, "AppData", "Roaming"), "Cursor");
    if (platform === "darwin") return undefined;
    return path.join(xdgConfig ?? path.join(home, ".config"), "cursor");
  };
  const homes = [
    path.join(home, ".cursor"),
    absolute(env.CURSOR_CONFIG_DIR),
    absolute(env.CURSOR_DATA_DIR),
    xdgConfig ? path.join(xdgConfig, "cursor") : undefined,
    signIn(),
  ];
  return [...new Set(homes.filter((dir): dir is string => Boolean(dir)).map((dir) => path.resolve(dir)))];
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
 * sandbox of its own, and Cursor, whose own sandbox cannot start inside Genex's): the only homes a
 * sandbox may exempt for the CLI it runs (`SandboxOptions.ownHome`).
 */
export function sandboxedCliHomes(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [openCodeDataHome(env, home), ...cursorHomes(env, home, platform)];
}

/**
 * Where the coding CLIs keep a sign-in on this Mac (SEC-3).
 *
 * `~/.codex` holds a ChatGPT refresh token when Codex uses its file store, `~/.claude` holds
 * Claude Code's settings and transcripts, OpenCode keeps every provider it signs in to in
 * `auth.json` under its data folder (`$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`),
 * and Grok Build keeps its Grok sign-in in `auth.json` under its home (`$GROK_HOME`, default `~/.grok`).
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
): string[] {
  const candidates = [
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    openCodeDataHome({}, home),
    grokHome({}, home),
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? openCodeDataHome(env, home) : undefined,
    env.GROK_HOME,
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

/** Where Grok Build keeps its sign-in (`auth.json`), sessions and settings: `$GROK_HOME`, else `~/.grok`. */
export function grokHome(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  return env.GROK_HOME && path.isAbsolute(env.GROK_HOME) ? env.GROK_HOME : path.join(home, ".grok");
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
 * The sign-in homes of the CLIs that run inside the studio's own sandbox (OpenCode and Grok Build,
 * which bring no sandbox of their own): the only homes a sandbox may exempt for the CLI it runs
 * (`SandboxOptions.ownHome`).
 */
export function sandboxedCliHomes(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string[] {
  return [openCodeDataHome(env, home), grokHome(env, home)];
}

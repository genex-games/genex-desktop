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

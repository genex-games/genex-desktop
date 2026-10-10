/**
 * The paths no agent process may read on any machine, by platform. The list is policy, not a
 * probe: a path that does not exist on this computer is still denied (sandbox-runtime skips an
 * absent deny path on macOS and Linux), so a keyring created after launch is covered too. Windows
 * has its own list: srt-win creates a placeholder for a missing deny path, so the macOS and Linux
 * folders are not sent there (the sandbox filters a missing Windows path out before srt-win sees it).
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { baseDenyRead, claudeFolderDenyWrites } from "../../src/substrate/spawn.ts";

const HOME = "/home/player";

/**
 * Whether sandbox-runtime's macOS profile denies writing `target` under `denies`, compiled as it
 * compiles them: `normalizePathForSandbox`, then a glob through `globToRegex` with a deny's subtree
 * tail (`denyGlobRegex`), a literal as a `subpath`. Paths as Seatbelt reports them (on-disk case);
 * Seatbelt matches bytes, not UTF-16 units, so a multi-byte case belongs in `sandbox.test.ts`.
 */
async function macDeny(denies: readonly string[]): Promise<(target: string) => boolean> {
  const { containsGlobChars, globToRegex, normalizePathForSandbox } = (await import(
    "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js"
  )) as {
    containsGlobChars: (p: string) => boolean;
    globToRegex: (glob: string) => string;
    normalizePathForSandbox: (p: string) => string;
  };
  const rules = denies.map((deny) => {
    const normalized = normalizePathForSandbox(deny);
    if (containsGlobChars(normalized)) return new RegExp(`${globToRegex(normalized).slice(0, -1)}(/.*)?$`);
    return { test: (target: string) => target === normalized || target.startsWith(`${normalized}/`) };
  });
  return (target) => rules.some((rule) => rule.test(target));
}

/** Every platform: SSH keys, cloud and GitHub credentials, netrc. */
const EVERYWHERE = [".ssh", ".aws", path.join(".config", "gh"), ".netrc"];

/** macOS and Linux: the macOS keychains folder (a no-op path on Linux). */
const KEYCHAINS = path.join("Library", "Keychains");

/** Linux desktop secret stores: GNOME Keyring, GnuPG, KWallet and the NSS database. */
const LINUX_SECRET_STORES = [
  path.join(".local", "share", "keyrings"),
  ".gnupg",
  path.join(".local", "share", "kwalletd"),
  path.join(".config", "kwalletrc"),
  ".pki",
];

/** Windows: stored Git credentials, the credential and DPAPI stores, and browser profiles. */
const WINDOWS_STORES = [
  ".git-credentials",
  "_netrc",
  path.join("AppData", "Roaming", "Microsoft", "Credentials"),
  path.join("AppData", "Roaming", "Microsoft", "Protect"),
  path.join("AppData", "Roaming", "GitHub CLI"),
  path.join("AppData", "Local", "Microsoft", "Credentials"),
  path.join("AppData", "Local", "Google", "Chrome", "User Data"),
  path.join("AppData", "Local", "Microsoft", "Edge", "User Data"),
  path.join("AppData", "Roaming", "Mozilla", "Firefox", "Profiles"),
];

const TABLE: Array<{ platform: NodeJS.Platform; denied: string[]; readable: string[] }> = [
  { platform: "linux", denied: [...EVERYWHERE, KEYCHAINS, ...LINUX_SECRET_STORES], readable: WINDOWS_STORES },
  { platform: "darwin", denied: [...EVERYWHERE, KEYCHAINS], readable: [...LINUX_SECRET_STORES, ...WINDOWS_STORES] },
  // Flipped in the Windows port: win32 no longer lists ~/Library/Keychains (srt-win would create it).
  { platform: "win32", denied: [...EVERYWHERE, ...WINDOWS_STORES], readable: [KEYCHAINS, ...LINUX_SECRET_STORES] },
];

describe("base deny-read list", () => {
  for (const row of TABLE) {
    it(`${row.platform}: denies ${row.denied.length} home paths and leaves the rest to the policy`, () => {
      // No APPDATA/LOCALAPPDATA: the Windows stores then sit under the home folder's AppData.
      const denied = baseDenyRead(HOME, row.platform, {});
      for (const relative of row.denied)
        assert.ok(denied.includes(path.join(HOME, relative)), `${row.platform} denies ~/${relative}`);
      for (const relative of row.readable)
        assert.ok(!denied.includes(path.join(HOME, relative)), `${row.platform} does not list ~/${relative}`);
    });
  }

  it("Windows follows APPDATA and LOCALAPPDATA where they point", () => {
    const env = { APPDATA: path.join(HOME, "roaming"), LOCALAPPDATA: path.join(HOME, "local") };
    const denied = baseDenyRead(HOME, "win32", env);
    assert.ok(denied.includes(path.join(HOME, "roaming", "Microsoft", "Credentials")));
    assert.ok(denied.includes(path.join(HOME, "local", "Google", "Chrome", "User Data")));
    assert.ok(!denied.includes(path.join(HOME, "AppData", "Roaming", "Microsoft", "Credentials")));
  });

  it("hides OpenCode 2.x's background-server password, where its config folder is", () => {
    // With it, any process allowed onto localhost could drive OpenCode's server, which runs outside every sandbox.
    for (const row of TABLE) {
      const denied = baseDenyRead(HOME, row.platform, {});
      assert.ok(denied.includes(path.join(HOME, ".config", "opencode", "service.json")), row.platform);
    }
    const moved = baseDenyRead(HOME, "darwin", { XDG_CONFIG_HOME: "/xdg/config" });
    assert.ok(moved.includes(path.join("/xdg/config", "opencode", "service.json")));
    const relative = baseDenyRead(HOME, "linux", { XDG_CONFIG_HOME: "relative" });
    assert.ok(
      relative.includes(path.join(HOME, ".config", "opencode", "service.json")),
      "a relative XDG folder is ignored",
    );
  });

  it("never denies the home folder itself", () => {
    for (const row of TABLE) assert.ok(!baseDenyRead(HOME, row.platform, {}).includes(HOME), row.platform);
  });
});

/**
 * A game's `.claude` folder is Claude Code's project settings: the person's own session in the game
 * loads its allow rules and hooks, so no agent process (the harness, its commands, a build) writes
 * it. On macOS a glob per folder covers every case and a folder not made yet; srt-win and Linux
 * expand or create what they are sent, so there only the folders that exist are named.
 */
describe("the games' .claude folders are write-denied", () => {
  const games = "/Users/me/AI Games";
  const kept = ["/Users/me/AI Games/pong", "/Users/me/Projects/racer", "/Users/me/odd[1]/maze"];

  // POSIX paths: the macOS policy is built where it runs.
  it("on macOS, by a case-blind glob under the games folder and beside each game kept elsewhere", {
    skip: process.platform === "win32",
  }, async () => {
    const denied = claudeFolderDenyWrites(games, kept, "darwin", () => false);
    assert.deepEqual(denied, [
      "/Users/me/AI Games/*/[.][cC][lL][aA][uU][dD][eE]",
      "/Users/me/Projects/racer/[.][cC][lL][aA][uU][dD][eE]",
      "/Users/me/odd[[]1]/maze/[.][cC][lL][aA][uU][dD][eE]",
    ]);
    const deny = await macDeny(denied);
    for (const target of [
      "/Users/me/AI Games/pong/.claude",
      "/Users/me/AI Games/pong/.CLAUDE/settings.json",
      "/Users/me/AI Games/new-game/.Claude/hooks/x.sh",
      "/Users/me/odd[1]/maze/.claude/settings.json",
    ])
      assert.ok(deny(target), `denied: ${target}`);
    for (const target of ["/Users/me/AI Games/pong/.claude-notes.md", "/Users/me/AI Games/pong/src/claude.js"])
      assert.ok(!deny(target), `writable: ${target}`);
  });

  /**
   * Game folders kept elsewhere whose paths sandbox-runtime reads as a glob (reachable by adopting a
   * folder). Each one's `.claude` is denied in any case; `writable` are folders the path's glob
   * reading would have hit instead, which stay alone. `*` and `?` may widen to any one character.
   */
  const HOSTILE: Array<{ name: string; dir: string; writable: string[] }> = [
    { name: "a bracketed tag", dir: "/Users/me/work/Pong [WIP]", writable: ["/Users/me/work/Pong W"] },
    { name: "a bracketed name", dir: "/Users/me/work/[x]", writable: ["/Users/me/work/x"] },
    { name: "a lone ]", dir: "/Users/me/work/a]b", writable: [] },
    { name: "a lone [", dir: "/Users/me/work/a[b", writable: [] },
    { name: "nested brackets", dir: "/Users/me/work/[[x]]", writable: ["/Users/me/work/x]"] },
    { name: "a range", dir: "/Users/me/work/[a-z]", writable: ["/Users/me/work/q"] },
    { name: "a negated class", dir: "/Users/me/work/[!x]", writable: ["/Users/me/work/!"] },
    { name: "a caret class", dir: "/Users/me/work/[^x]", writable: ["/Users/me/work/^", "/Users/me/work/x"] },
    { name: "a POSIX class name", dir: "/Users/me/work/[[:alpha:]]", writable: ["/Users/me/work/a]"] },
    { name: "an empty pair", dir: "/Users/me/work/[]", writable: [] },
    { name: "a star", dir: "/Users/me/work/star*", writable: ["/Users/me/work/star", "/Users/me/work/starry"] },
    { name: "a globstar", dir: "/Users/me/work/**", writable: ["/Users/me/work/a/b", "/Users/me/work/abc"] },
    { name: "a question mark", dir: "/Users/me/work/what?", writable: [] },
    { name: "a bracket in a parent folder", dir: "/Users/me/[odd]/pong", writable: ["/Users/me/o/pong"] },
    { name: "regex punctuation", dir: "/Users/me/work/(a|b)+.$^{1} [1]", writable: ["/Users/me/work/(a|b)+.$^{1} 1"] },
    { name: "a backslash", dir: "/Users/me/work/back\\slash [1]", writable: ["/Users/me/work/back\\slash 1"] },
    { name: "a control character", dir: "/Users/me/work/c\u0001d [1]", writable: ["/Users/me/work/c\u0001d 1"] },
    {
      name: "sandbox-runtime's placeholder",
      dir: "/Users/me/work/__GLOBSTAR__ [1]",
      writable: ["/Users/me/work/sub/deep 1", "/Users/me/work/sub/deep [1]"],
    },
    {
      name: "sandbox-runtime's slash placeholder",
      dir: "/Users/me/work/x__GLOBSTAR_SLASH__y [1]",
      writable: ["/Users/me/work/x/deep/y 1", "/Users/me/work/xy [1]"],
    },
  ];

  for (const row of HOSTILE)
    it(`on macOS, a game kept in a folder with ${row.name}`, { skip: process.platform === "win32" }, async () => {
      const denied = claudeFolderDenyWrites(games, [row.dir], "darwin", () => false);
      const deny = await macDeny(denied);
      for (const target of [
        `${row.dir}/.claude`,
        `${row.dir}/.claude/settings.json`,
        `${row.dir}/.Claude/settings.json`,
        `${row.dir}/.CLAUDE/hooks/pre.sh`,
      ])
        assert.ok(deny(target), `denied: ${target} by ${denied.join(", ")}`);
      for (const target of [
        `${row.dir}/src/main.js`,
        `${row.dir}/.claude-notes.md`,
        ...row.writable.map((dir) => `${dir}/.claude/settings.json`),
      ])
        assert.ok(!deny(target), `writable: ${target} past ${denied.join(", ")}`);
    });

  it("on macOS, a games folder whose own path reads as a glob keeps its glob for every game", {
    skip: process.platform === "win32",
  }, async () => {
    const root = "/Users/me/[AI] Games*";
    const denied = claudeFolderDenyWrites(root, [`${root}/pong`, "/Users/me/work/racer"], "darwin", () => false);
    assert.deepEqual(denied, [
      "/Users/me/[[]AI] Games?/*/[.][cC][lL][aA][uU][dD][eE]",
      "/Users/me/work/racer/[.][cC][lL][aA][uU][dD][eE]",
    ]);
    const deny = await macDeny(denied);
    for (const target of [`${root}/pong/.claude/settings.json`, `${root}/made-later/.Claude/hooks/x.sh`])
      assert.ok(deny(target), `denied: ${target}`);
    for (const target of [`${root}/pong/src/main.js`, "/Users/me/A Games*/pong/.claude/settings.json"])
      assert.ok(!deny(target), `writable: ${target}`);
  });

  it("on Windows and Linux, only the folders that exist, so nothing is created in a game", () => {
    const existing = path.join(path.resolve("/Users/me/AI Games/pong"), ".claude");
    for (const platform of ["win32", "linux"] as const)
      assert.deepEqual(
        claudeFolderDenyWrites(games, kept, platform, (p) => p === existing),
        [existing],
        platform,
      );
  });
});

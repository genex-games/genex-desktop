import { fixtureCodingCli } from "../helpers/external-cli.ts";
/**
 * A game chat's own Claude session asks the person, the way Claude Code asks in a terminal.
 *
 * The Agent SDK's `query()` is injected, so what is proven here is our half of the contract:
 * the options a chat's session starts with (its mode, no sandbox, no blanket shell, deny rules
 * at their real absolute paths, on POSIX and on Windows), how Claude Code's question and "always" suggestions travel to
 * the host and the person's answer comes back, and the mode reports and live control the
 * composer's picker relies on. Unattended sessions keep their contract (engine-delegated).
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { AUTO_MODE_BUDGET } from "../../src/substrate/engines/claude-auto-mode.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import {
  absoluteRule,
  absoluteRulePath,
  claudeProjectDirName,
  homeFence,
  permissionGrants,
  permissionRules,
  protectedTargets,
} from "../../src/substrate/engines/claude-permissions.ts";
import { credentialHomes } from "../../src/substrate/credential-homes.ts";
import { baseDenyRead } from "../../src/substrate/spawn.ts";
import type {
  AskFirst,
  DelegatePermissions,
  PermissionAsk,
  PermissionReply,
  ScreenedCall,
  WithdrawnAnswer,
} from "../../src/substrate/engines/types.ts";
import { PERMISSION_MODES, type ToolPermissionAnswer } from "../../src/shared/permissions.ts";
import { ruleDenies } from "../helpers/claude-rules.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

type Options = Record<string, unknown>;
type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const run = [
  {
    type: "system",
    subtype: "init",
    model: "claude-sonnet-5",
    session_id: "ses_chat",
    permissionMode: "default",
    tools: [],
  },
  { type: "system", subtype: "status", status: "requesting", session_id: "ses_chat" },
  { type: "system", subtype: "status", status: null, permissionMode: "acceptEdits", session_id: "ses_chat" },
  { type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 1, usage: {} },
];

function fakeQuery(messages: unknown[] = run, options: { throwOn?: Error; control?: boolean } = {}) {
  const seen: Options[] = [];
  const modes: string[] = [];
  const fn = ((params: { prompt: string; options?: Options }) => {
    seen.push({ prompt: params.prompt, ...params.options });
    return {
      async *[Symbol.asyncIterator]() {
        if (options.throwOn) throw options.throwOn;
        for (const message of messages) yield message;
      },
      ...(options.control
        ? {
            setPermissionMode: async (mode: string) => {
              modes.push(mode);
            },
          }
        : {}),
    };
  }) as never;
  return { fn, seen, modes };
}

async function engineFor(queryFn: never, protectedPaths: string[] = []): Promise<ClaudeCodeEngine> {
  const root = await tmpDir("studio-permissions-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  return new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    queryFn,
    protectedPaths,
  });
}

function chat(overrides: Partial<DelegatePermissions> = {}): DelegatePermissions {
  return {
    mode: "default",
    allow: [],
    directories: [],
    protectWrites: [],
    ask: async () => ({ decision: "allow" }),
    ...overrides,
  };
}

/** The session's canUseTool, answering with `answer` and recording what the host was asked. */
async function prompter(answer: PermissionReply | (() => Promise<PermissionReply>)) {
  const asked: Array<{ request: PermissionAsk; signal: AbortSignal }> = [];
  const { fn, seen } = fakeQuery();
  const engine = await engineFor(fn);
  await engine.delegate({
    prompt: "fix the jump",
    cwd: "/tmp/game-workspace",
    permissions: chat({
      ask: async (request, signal) => {
        asked.push({ request, signal });
        return typeof answer === "function" ? answer() : answer;
      },
    }),
  });
  return { canUseTool: seen[0]!.canUseTool as CanUseTool, asked };
}

it("project settings load only with an explicit host trust grant", async () => {
  const { fn, seen } = fakeQuery();
  const engine = await engineFor(fn);
  await engine.delegate({ prompt: "build", cwd: "/tmp/game-workspace", trustedProjectSettings: true });
  assert.deepEqual(seen[0]?.settingSources, ["project"]);
});

it("Claude file rules and unattended shells share the host's sensitive-read boundaries", async () => {
  const { fn, seen } = fakeQuery();
  const engine = await engineFor(fn);
  await engine.delegate({ prompt: "build", cwd: "/tmp/game-workspace" });
  const settings = seen[0]?.settings as { permissions: { deny: string[] } };
  const sandbox = seen[0]?.sandbox as { filesystem: { denyRead: string[] } };
  for (const root of baseDenyRead()) {
    assert.ok(settings.permissions.deny.includes(absoluteRule("Read", root)), root);
    assert.ok(sandbox.filesystem.denyRead.includes(root), root);
  }
});

const ask = (overrides: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  toolUseID: "tu_1",
  requestId: "req_1",
  ...overrides,
});

/** A Claude home as Claude Code keeps it: the working folder's own project (both spellings) beside others. */
async function claudeHome() {
  const root = await tmpDir("claude-home-fence-");
  const home = path.join(root, "dot-claude");
  const cwd = path.join(root, "AI Games", "pong");
  await mkdir(cwd, { recursive: true });
  const own = [...new Set([cwd, await realpath(cwd)].map((dir) => claudeProjectDirName(dir)))];
  const first = own[0] ?? "";
  const others = [
    "-Users-me-other-game",
    `${first}-2`,
    `${first}.old`,
    first.slice(0, -2),
    `${first.slice(0, 20)}${first[20] === "x" ? "y" : "x"}${first.slice(21)}`,
  ];
  const entries = ["plans", "shell-snapshots", "session-env", "todos", "file-history", "debug"];
  for (const dir of [...entries, ...[...own, ...others].map((name) => `projects/${name}`)])
    await mkdir(path.join(home, dir), { recursive: true });
  for (const file of [".credentials.json", "settings.json", "history.jsonl", "projects/.DS_Store"])
    await writeFile(path.join(home, file), "{}");
  return { home, cwd, own, others: [...others, ".DS_Store"] };
}

/** Realistic project folder names: other games beside this one, builder worktrees, other people's folders, long cut ones. */
function syntheticProjects(root: string, games: string): string[] {
  const many = (count: number, dir: (i: number) => string) => Array.from({ length: count }, (_, i) => dir(i));
  const dirs = [
    ...many(600, (i) => path.join(games, `game-${i}`)),
    ...many(100, (i) => path.join(games, `pong-${i}`)),
    ...many(100, (i) => path.join(games, `po${i}`)),
    ...many(400, (i) => path.join(root, "scratch", "autopilot", `run-${i % 40}`, `builder-${i}`)),
    ...many(600, (i) => `/Users/person${i % 7}/Projects/app-${i}`),
    ...many(200, (i) => path.join(games, "deep/".repeat(45), `game-${i}`)),
    games,
  ];
  return [...new Set(dirs.map((dir) => claudeProjectDirName(dir)))];
}

/** The session's settings as the SDK hands them to the CLI: one JSON argument, the sandbox inside. */
function sdkSettingsArgument(call: Options): string {
  const sandbox = call.sandbox as Options | undefined;
  return JSON.stringify({
    ...(call.settings as Options),
    ...(sandbox ? { sandbox: { ...sandbox, failIfUnavailable: true } } : {}),
  });
}

/** The deny rules a session's settings carry. */
function permissionsOf(call: Options): { deny: string[] } {
  return (call.settings as { permissions: { deny: string[] } }).permissions;
}

describe("a chat's own Claude session asks the person", () => {
  it("starts in the chosen mode, without a sandbox or a blanket shell, and asks through canUseTool", async () => {
    for (const mode of PERMISSION_MODES) {
      const { fn, seen } = fakeQuery();
      const root = await tmpDir("studio-permissions-");
      const secrets = path.join(root, "secrets");
      const homes = path.join(root, "engine-homes");
      const engine = await engineFor(fn, [secrets, homes]);
      await engine.delegate({
        prompt: "fix the jump",
        cwd: "/tmp/game-workspace",
        extraReads: ["/tmp/stills", "/tmp/game-workspace/assets"],
        denyReads: ["/tmp/sibling-game"],
        permissions: chat({
          mode,
          allow: ["Bash(npm test *)", "WebFetch(domain:example.com)"],
          directories: ["/Users/me/refs", "/tmp/stills", "/tmp/game-workspace/src", "/tmp/game-workspace"],
          protectWrites: [path.join(root, "settings.json"), path.join(root, "runs")],
        }),
      });
      const call = seen[0]!;
      assert.equal(call.permissionMode, mode, `${mode} reaches the CLI as its own SDK value`);
      assert.equal(call.allowDangerouslySkipPermissions, true, "the person may switch to Bypass mid-turn");
      assert.equal(typeof call.canUseTool, "function");
      assert.equal("sandbox" in call, false, "Claude Code's default: no sandbox key at all");
      const allowed = call.allowedTools as string[];
      assert.equal(allowed.includes("Bash"), false, "a blanket Bash allow would silence every question");
      assert.ok(
        allowed.includes("mcp__studio__checkpoint") && allowed.includes("WebSearch") && allowed.includes("WebFetch"),
      );
      assert.deepEqual(call.disallowedTools, ["SendMessage", "ListAgents", "AskUserQuestion", "EnterPlanMode"]);
      // Everything else is the contractor's contract, unchanged.
      assert.deepEqual(call.settingSources, [], "untrusted project settings and hooks stay disabled");
      assert.deepEqual(Object.keys(call.mcpServers as Options), ["studio"]);
      assert.equal(call.strictMcpConfig, true);
      assert.equal("hooks" in call, false);
      assert.deepEqual(
        call.additionalDirectories,
        ["/tmp/stills", "/Users/me/refs"],
        "granted folders join the reads, once, never the workspace itself",
      );
      const settings = call.settings as {
        permissions: { allow: string[]; deny: string[] };
        showThinkingSummaries: boolean;
      };
      assert.deepEqual(settings.permissions.allow, ["Bash(npm test *)", "WebFetch(domain:example.com)"]);
      // Every sign-in home (SEC-3) is fenced like the studio's own secrets; this session's own
      // Claude home is the studio's, outside them all.
      const fenced = [...new Set([secrets, homes, ...credentialHomes(), ...baseDenyRead()])];
      assert.deepEqual(settings.permissions.deny, [
        ...fenced.flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]),
        `Edit(/${path.join(root, "settings.json")}/**)`,
        `Edit(/${path.join(root, "runs")}/**)`,
        "Read(//tmp/sibling-game/**)",
      ]);
      assert.equal(settings.showThinkingSummaries, true);
    }
  });

  it("a read-only brief stays read-only, whatever else it carries", async () => {
    // Upstream's read-only sessions (a waking run's lead, the coordinator, a playtester) are never
    // the person's own: the host hands them no `permissions` (a lead the person talks to gets
    // `leadAsks`, below), and the engine keeps them read-only anyway.
    const { fn, seen } = fakeQuery();
    await (await engineFor(fn)).delegate({
      prompt: "what changed?",
      cwd: "/tmp/lead",
      readOnly: true,
      permissions: chat(),
    });
    const options = seen[0]!;
    assert.ok(!(options.allowedTools as string[]).includes("WebFetch"));
    for (const tool of ["Bash", "Edit", "Write", "WebFetch"])
      assert.ok((options.disallowedTools as string[]).includes(tool), `${tool} stays off`);
  });

  /**
   * Auto's classifier reads the studio's rules on top of Claude Code's own ("$defaults" first, its
   * soft and hard blocks untouched), in every mode: the picker can move a running session to Auto.
   * An unattended session never runs in Auto and carries none.
   */
  it("carries the studio's rules for Auto's classifier, built on Claude Code's own", async () => {
    const cwd = `/Users/someone/AI Games/${"a-long-game-name-".repeat(6)}`;
    for (const mode of ["default", "auto"] as const) {
      const { fn, seen } = fakeQuery();
      await (await engineFor(fn)).delegate({ prompt: "fix the jump", cwd, permissions: chat({ mode }) });
      const settings = seen[0]!.settings as { autoMode: Record<string, string[]> };
      const { autoMode } = settings;
      assert.deepEqual(
        Object.keys(autoMode).sort(),
        ["allow", "environment"],
        `${mode}: the blocks stay Claude Code's`,
      );
      assert.equal(autoMode.environment![0], "$defaults");
      assert.equal(autoMode.allow![0], "$defaults");
      assert.ok(
        autoMode.environment!.some((entry) => entry.startsWith("**Game folder**") && entry.includes(path.resolve(cwd))),
        "the game folder, and that it is checkpointed",
      );
      assert.ok(autoMode.allow!.some((entry) => entry.startsWith("Game Folder Work:")));
      assert.ok(JSON.stringify(autoMode).length <= AUTO_MODE_BUDGET, "small enough for one command-line argument");
    }
    const { fn, seen } = fakeQuery();
    await (await engineFor(fn)).delegate({ prompt: "build the sky", cwd: "/tmp/game-workspace" });
    assert.equal("autoMode" in (seen[0]!.settings as Options), false, "an unattended session never runs in Auto");
  });

  it("carries no allow key when nothing was saved", async () => {
    const { fn, seen } = fakeQuery();
    const engine = await engineFor(fn, ["/tmp/secrets"]);
    await engine.delegate({ prompt: "hi", cwd: "/tmp/game-workspace", permissions: chat() });
    const fenced = [...new Set(["/tmp/secrets", ...credentialHomes(), ...baseDenyRead()])];
    assert.deepEqual((seen[0]!.settings as Options).permissions, {
      deny: fenced.flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]),
    });
  });

  it("writes absolute rules the way Claude Code parses them", () => {
    assert.equal(absoluteRule("Read", "/Users/me/secrets", "darwin"), "Read(//Users/me/secrets/**)");
    assert.equal(
      absoluteRule("Edit", "/Users/me/Library/Application Support/Studio/runs/", "darwin"),
      "Edit(//Users/me/Library/Application Support/Studio/runs/**)",
    );
    // A glob character stays literal, and the escape survives the rule syntax's own.
    assert.equal(absoluteRule("Read", "/tmp/a[1]", "darwin"), "Read(//tmp/a\\\\[1\\\\]/**)");
  });

  it("writes a Windows path the way the CLI turns one into a rule: forward slashes, the drive its first folder", () => {
    // The CLI's own conversion: `C:\Users\me` is `//c/Users/me`; a single-slash or backslashed
    // rule would be read relative to the settings root and guard nothing.
    assert.equal(
      absoluteRulePath("C:\\Users\\me\\AppData\\Roaming\\Genex\\secrets", "win32"),
      "//c/Users/me/AppData/Roaming/Genex/secrets",
    );
    assert.equal(absoluteRule("Read", "D:\\Games\\pong", "win32"), "Read(//d/Games/pong/**)");
    assert.equal(
      absoluteRule("Edit", "C:\\Users\\me\\My Games (old)\\", "win32"),
      "Edit(//c/Users/me/My Games \\\\\\(old\\\\\\)/**)",
    );
    // A network share keeps its two leading slashes after the rule's own, as the CLI writes it.
    assert.equal(absoluteRulePath("\\\\server\\share\\games", "win32"), "///server/share/games");
    assert.equal(absoluteRulePath("/Users/me/game", "darwin"), "//Users/me/game");
  });

  it("fences the folders around Claude Code's own home whole, never the home itself", async () => {
    // A deny rule beats the CLI's exceptions for its own files, so a whole engine-homes fence
    // would refuse the plan Plan mode writes and the long tool output the model is told to Read.
    const root = await tmpDir("engine-homes-");
    const homes = path.join(root, "engine-homes");
    for (const dir of ["claude-code/plans", "codex", "plugins"])
      await mkdir(path.join(homes, dir), { recursive: true });
    await writeFile(path.join(homes, "permissions.json"), "{}");
    const secrets = path.join(root, "secrets");
    const fence = await protectedTargets([secrets, homes], path.join(homes, "claude-code"));
    assert.deepEqual(
      [...fence.whole].sort(),
      [secrets, path.join(homes, "codex"), path.join(homes, "permissions.json"), path.join(homes, "plugins")].sort(),
    );
    assert.deepEqual(fence.secrets, [path.join(homes, "claude-code", ".credentials.json")]);
    assert.deepEqual(
      fence.settings,
      ["settings.json", "settings.local.json", ".claude.json"].map((file) => path.join(homes, "claude-code", file)),
    );
    assert.equal(fence.home, path.join(homes, "claude-code"));
    // Borrowing the sign-in on this Mac: that home is itself a fenced sign-in home (SEC-3), never
    // fenced whole: its credentials by name, and inside it only what an unattended session needs
    // (`homeFence`, the cases below).
    const dotClaude = path.join(root, "dot-claude");
    const borrowed = await protectedTargets([secrets, dotClaude], dotClaude);
    assert.deepEqual(borrowed.whole, [secrets]);
    assert.deepEqual(borrowed.secrets, [path.join(dotClaude, ".credentials.json")]);
    assert.equal(borrowed.home, dotClaude);
    // No sign-in, or a home outside every fence: the folders stay whole.
    assert.deepEqual(await protectedTargets([secrets, homes], null), {
      whole: [secrets, homes],
      secrets: [],
      settings: [],
      home: null,
    });
    assert.deepEqual(await protectedTargets([secrets, homes], path.join(root, "elsewhere")), {
      whole: [secrets, homes],
      secrets: [],
      settings: [],
      home: null,
    });
  });

  it("names a project folder exactly as Claude Code does, a long one cut and hashed", () => {
    assert.equal(claudeProjectDirName("/Users/me/AI Games/pong"), "-Users-me-AI-Games-pong");
    assert.equal(claudeProjectDirName("C:\\Users\\me\\Spiele\\über"), "C--Users-me-Spiele--ber");
    // Past 200 characters: the first 200, then Java's string hash of the whole path in base 36
    // (the CLI's own `gT`; the value below is what CLI 2.1.281 computes for this path).
    const long = `/Users/me/${"a".repeat(300)}`;
    assert.equal(claudeProjectDirName(long), `-Users-me-${"a".repeat(190)}-cgp8v3`);
  });

  it("a person's session fences only the credentials and settings inside its Claude home, as a terminal would", async () => {
    // Parity with Claude Code for a person in a terminal: other projects' transcripts and the
    // prompt history are not listed rule by rule; a read outside the working folders asks in
    // Manual and Accept edits, Auto's classifier decides, Bypass allows.
    const { home, cwd } = await claudeHome();
    const rules = await permissionRules({
      protectedPaths: [home],
      configHome: home,
      cwd,
      denyReads: [],
      permissions: chat(),
    });
    assert.deepEqual(rules.deny, [
      absoluteRule("Read", path.join(home, ".credentials.json")),
      absoluteRule("Edit", path.join(home, ".credentials.json")),
      ...["settings.json", "settings.local.json", ".claude.json"].map((file) =>
        absoluteRule("Edit", path.join(home, file)),
      ),
    ]);
    for (const reachable of ["history.jsonl", "file-history", "projects/-Users-me-other-game", "plans"])
      assert.ok(!ruleDenies(rules.deny ?? [], "Read", path.join(home, reachable)), `asks, not fenced: ${reachable}`);
  });

  it("an unattended session reaches in its Claude home only what the CLI hands it, other projects fenced by a few globs", async () => {
    // Nobody answers an unattended session, so the fence stays an allow-list: its plan, shell
    // snapshot and environment, todos and this working folder's saved output.
    const { home, cwd, own, others } = await claudeHome();
    const warnings: string[] = [];
    const fence = await homeFence({ home, cwd, warn: (message) => warnings.push(message) });
    const denied = (entry: string) => ruleDenies(fence, "Read", path.join(home, entry));
    for (const entry of [
      "debug",
      "file-history/a",
      "history.jsonl",
      ...others.map((name) => `projects/${name}/t.jsonl`),
    ])
      assert.ok(denied(entry), `fenced: ${entry}`);
    for (const entry of [
      "plans/p.md",
      "shell-snapshots/s.sh",
      "session-env/e",
      "todos/t.json",
      "projects",
      ...own.flatMap((name) => [`projects/${name}`, `projects/${name}/tool-results/x.txt`]),
    ])
      assert.ok(!denied(entry), `reachable: ${entry}`);
    assert.deepEqual(warnings, []);
    // Its own project not made yet: nothing of it to fence, and every other project still is.
    const fresh = await homeFence({ home, cwd: path.join(path.dirname(cwd), "new-game"), warn: () => {} });
    for (const name of [...own, ...others])
      assert.ok(ruleDenies(fresh, "Read", path.join(home, "projects", name)), `fenced for another folder: ${name}`);
    // A long working folder: its cut name counts with any hash, as the CLI looks it up; the cut
    // name alone, or another long one, does not.
    const longCwd = path.join(path.dirname(cwd), "g".repeat(220));
    const cut = claudeProjectDirName(longCwd).slice(0, 200);
    const longOthers = [cut, claudeProjectDirName(path.join(path.dirname(cwd), "h".repeat(220)))];
    for (const name of [`${cut}-oldhash`, ...longOthers]) await mkdir(path.join(home, "projects", name));
    const long = await homeFence({ home, cwd: longCwd, warn: () => {} });
    assert.ok(!ruleDenies(long, "Read", path.join(home, "projects", `${cut}-oldhash`, "x")));
    for (const name of [...longOthers, ...own]) assert.ok(ruleDenies(long, "Read", path.join(home, "projects", name)));
  });

  it("leaves out, and names, a Claude-home entry no rule can spell", async () => {
    // A `?` and a trailing `*` stay wildcards in the CLI's matcher however they are escaped, and
    // trailing whitespace is stripped: a rule for such a name would fence the wrong entries.
    const { home, cwd, own } = await claudeHome();
    for (const odd of ["*", "todo?", "trail "]) await mkdir(path.join(home, odd), { recursive: true });
    await mkdir(path.join(home, "projects", "-*"), { recursive: true });
    const warnings: string[] = [];
    const fence = await homeFence({ home, cwd, warn: (message) => warnings.push(message) });
    for (const entry of ["plans/p.md", "todos/t.json", ...own.map((name) => `projects/${name}/tool-results/x.txt`)])
      assert.ok(!ruleDenies(fence, "Read", path.join(home, entry)), `still reachable: ${entry}`);
    assert.ok(!fence.some((rule) => /\/(\\\*|todo\?|trail |-\\\*)\/\*\*\)$/.test(rule)), "no rule spells an odd name");
    assert.equal(warnings.length, 1);
    for (const odd of ["*", "todo?", "trail ", "-*"]) assert.ok(warnings[0]!.includes(odd), `named: ${odd}`);
  });

  it("keeps the settings of a Claude home with thousands of projects small enough for any command line", async () => {
    // The SDK passes settings as ONE argument (`--settings <json>`); Windows allows 8,191
    // characters through a .cmd shim; one rule per project folder would pass that here.
    const root = await realpath(await tmpDir("claude-home-size-"));
    const home = path.join(root, "dot-claude");
    const games = path.join(root, "games");
    const cwd = path.join(games, "pong");
    await mkdir(cwd, { recursive: true });
    for (const entry of ["plans", "projects", "debug", "file-history", "statsig", "ide", "paste-cache"])
      await mkdir(path.join(home, entry), { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const names = syntheticProjects(root, games);
    assert.ok(names.length >= 2_000);
    await Promise.all([...names, claudeProjectDirName(cwd)].map((name) => mkdir(path.join(home, "projects", name))));
    const settingsJson = async (permissions?: DelegatePermissions) => {
      const { fn, seen } = fakeQuery();
      const engine = new ClaudeCodeEngine({
        resolveCli: fixtureCodingCli,
        engineHome: path.join(root, "engine"),
        systemHome: home,
        queryFn: fn,
        protectedPaths: [path.join(root, "secrets"), path.join(root, "engine-homes")],
      });
      await engine.delegate({ prompt: "build", cwd, ...(permissions ? { permissions } : {}) });
      return { json: sdkSettingsArgument(seen[0] as Options), deny: permissionsOf(seen[0] as Options).deny };
    };
    const unattended = await settingsJson();
    assert.ok(unattended.json.length < 6_000, `unattended settings: ${unattended.json.length} characters`);
    for (const name of names.slice(0, 400))
      assert.ok(ruleDenies(unattended.deny, "Read", path.join(home, "projects", name, "x")), `fenced: ${name}`);
    assert.ok(!ruleDenies(unattended.deny, "Read", path.join(home, "projects", claudeProjectDirName(cwd), "x")));
    // A person's session also carries the studio's rules for Auto, on their own budget.
    const person = await settingsJson(chat());
    assert.ok(person.json.length < 2_000 + AUTO_MODE_BUDGET, `person's settings: ${person.json.length} characters`);
  });

  it("never lets the Claude home's rules pass their budget, and says what it left readable", async () => {
    // A home built to cost the most: many top-level entries and a folder that leaves the
    // session's own name at every one of its characters.
    const { home, cwd, own } = await claudeHome();
    const ownName = own[0] ?? "";
    for (let i = 0; i < 20; i++) await mkdir(path.join(home, `cache-${i}`));
    for (let i = 1; i < ownName.length; i++)
      await mkdir(path.join(home, "projects", `${ownName.slice(0, i)}${ownName[i] === "z" ? "y" : "z"}tail`));
    const warnings: string[] = [];
    const fence = await homeFence({ home, cwd, warn: (message) => warnings.push(message) });
    assert.ok(JSON.stringify(fence).length <= 4_000, `home rules: ${JSON.stringify(fence).length} characters`);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /stay readable/);
    for (const name of own)
      assert.ok(!ruleDenies(fence, "Read", path.join(home, "projects", name, "x")), `own stays reachable: ${name}`);
    // Top-level entries come first: the prompt history is still fenced.
    assert.ok(ruleDenies(fence, "Read", path.join(home, "history.jsonl")));
  });

  it("hands the host Claude Code's question, reason cleaned of terminal codes", async () => {
    const { canUseTool, asked } = await prompter({ decision: "allow" });
    const input = { command: "npm install", description: "Install dependencies" };
    const result = await canUseTool(
      "Bash",
      input,
      ask({
        title: "Claude wants to run npm install",
        displayName: "Run command",
        description: "Install dependencies",
        decisionReason: "\u001b[1mThis command\u001b[22m changes \u001b[33mnode_modules\u001b[39m",
        blockedPath: "/tmp/elsewhere",
        agentID: "agent_7",
      }),
    );
    assert.deepEqual(result, { behavior: "allow", updatedInput: input });
    assert.deepEqual(asked[0]!.request, {
      tool: "Bash",
      input,
      toolUseId: "tu_1",
      title: "Claude wants to run npm install",
      displayName: "Run command",
      description: "Install dependencies",
      reason: "This command changes node_modules",
      blockedPath: "/tmp/elsewhere",
      agentId: "agent_7",
      always: [],
    });
  });

  it("translates 'always' suggestions into grants, and keeps them in the session, never the game folder", async () => {
    const suggestions = [
      {
        type: "addRules",
        rules: [
          { toolName: "Bash", ruleContent: "npm test *" },
          { toolName: "Bash", ruleContent: "echo (hi)" },
        ],
        behavior: "allow",
        destination: "localSettings",
      },
      {
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: "//Users/me/refs/**" }],
        behavior: "allow",
        destination: "session",
      },
      { type: "addRules", rules: [{ toolName: "WebSearch" }], behavior: "allow", destination: "cliArg" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      { type: "addDirectories", directories: ["/Users/me/refs"], destination: "session" },
      // Nothing that narrows or replaces permission is ever offered as "always".
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "rm *" }],
        behavior: "deny",
        destination: "localSettings",
      },
      { type: "replaceRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
      { type: "setMode", mode: "dontAsk", destination: "session" },
      { type: "addRules", rules: [], behavior: "allow", destination: "session" },
      // A whole shell or file tool reaches further than any one question: never offered.
      {
        type: "addRules",
        rules: [{ toolName: "Bash" }, { toolName: "Edit" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ];
    const grants = [
      { kind: "rule", rule: "Bash(npm test *)", scope: "game" },
      { kind: "rule", rule: "Bash(echo \\(hi\\))", scope: "game" },
      { kind: "rule", rule: "Read(//Users/me/refs/**)", scope: "chat" },
      { kind: "rule", rule: "WebSearch", scope: "chat" },
      { kind: "mode", mode: "acceptEdits" },
      { kind: "directory", path: "/Users/me/refs" },
    ];
    const kept = suggestions.slice(0, 5).map((update) => ({ ...update, destination: "session" }));
    assert.deepEqual(permissionGrants(suggestions as never), { grants, updates: kept });

    const { canUseTool, asked } = await prompter({ decision: "always" });
    const input = { command: "npm test" };
    const result = await canUseTool("Bash", input, ask({ suggestions }));
    assert.deepEqual(asked[0]!.request.always, grants);
    assert.deepEqual(result, { behavior: "allow", updatedInput: input, updatedPermissions: kept });
    assert.equal(suggestions[0]!.destination, "localSettings", "the CLI's own suggestion is not mutated");
  });

  it("approves a plan into the mode the person picked", async () => {
    const { canUseTool, asked } = await prompter({ decision: "approve_plan", mode: "acceptEdits" });
    const input = { plan: "# Plan\n\n1. Fix the jump." };
    const result = await canUseTool("ExitPlanMode", input, ask());
    assert.equal(asked[0]!.request.tool, "ExitPlanMode");
    assert.deepEqual(asked[0]!.request.input, input, "the plan itself travels in the input");
    assert.deepEqual(result, {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
  });

  it("approves a plan into Auto through Claude Code's own gate, never around it", async () => {
    // A mode set by an answer skips the CLI's Auto gate; the picker's request does not.
    const { fn, seen, modes } = fakeQuery(run, { control: true });
    await (await engineFor(fn)).delegate({
      prompt: "plan it",
      cwd: "/tmp/game-workspace",
      permissions: chat({ ask: async () => ({ decision: "approve_plan", mode: "auto" }) }),
    });
    const input = { plan: "1. Jump" };
    const result = await (seen[0]!.canUseTool as CanUseTool)("ExitPlanMode", input, ask());
    assert.deepEqual(result, {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(modes, ["auto"]);
  });

  it("tells Claude what the person said, and to stop rather than work around a bare deny", async () => {
    const cases: Array<[string, ToolPermissionAnswer, string]> = [
      ["Bash", { decision: "deny", message: "use yarn instead" }, "The user denied this and said: use yarn instead"],
      [
        "Bash",
        { decision: "deny" },
        "The user denied permission for this action. Don't retry it or work around it; stop and ask the user how to proceed.",
      ],
      [
        "Bash",
        { decision: "deny", message: "   " },
        "The user denied permission for this action. Don't retry it or work around it; stop and ask the user how to proceed.",
      ],
      [
        "ExitPlanMode",
        { decision: "deny", message: "split level 2 first" },
        "The user wants to keep planning: split level 2 first",
      ],
      ["ExitPlanMode", { decision: "deny" }, "The user wants to keep planning. Ask what to change."],
    ];
    for (const [tool, answer, message] of cases) {
      const { canUseTool } = await prompter(answer);
      assert.deepEqual(await canUseTool(tool, {}, ask()), { behavior: "deny", message });
    }
  });

  it("hands Claude the host's own withdrawal as it is, never as the person's words", async () => {
    // Stop and the turn's end are the host's doing: "The user denied this and said: The user
    // stopped…" would read as a reply the person typed.
    for (const tool of ["Bash", "ExitPlanMode"]) {
      for (const message of [
        "The user stopped this work before answering.",
        "The turn ended before the user answered.",
      ]) {
        const { canUseTool } = await prompter({ decision: "deny", withdrawn: true, message });
        assert.deepEqual(await canUseTool(tool, {}, ask()), { behavior: "deny", message }, `${tool}: ${message}`);
      }
    }
  });

  it("withdraws a question the work outlived, and never throws into the session", async () => {
    const { canUseTool } = await prompter(() => Promise.reject(new Error("turn ended")));
    assert.deepEqual(await canUseTool("Bash", { command: "ls" }, ask()), {
      behavior: "deny",
      message: "The permission request was withdrawn.",
    });

    const { canUseTool: cancelled, asked } = await prompter({ decision: "allow" });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await cancelled("Bash", { command: "ls" }, ask({ signal: controller.signal })), {
      behavior: "deny",
      message: "The permission request was withdrawn.",
    });
    assert.equal(asked.length, 0, "an already-cancelled question is never shown");
  });

  it("passes the SDK's own signal, so a cancelled prompt settles the host's card", async () => {
    const { canUseTool, asked } = await prompter({ decision: "allow" });
    const controller = new AbortController();
    await canUseTool("Bash", { command: "ls" }, ask({ signal: controller.signal }));
    assert.equal(asked[0]!.signal, controller.signal);
  });

  it("reports the mode the session really runs in, from init and from status changes", async () => {
    const { fn } = fakeQuery();
    const engine = await engineFor(fn);
    const modes: string[] = [];
    const result = await engine.delegate({
      prompt: "hi",
      cwd: "/tmp/game-workspace",
      permissions: chat({ mode: "auto", onMode: (mode) => modes.push(mode) }),
    });
    assert.deepEqual(
      modes,
      ["default", "acceptEdits"],
      "Auto fell back to Manual at start; a status without a mode is not a change",
    );
    assert.equal(result.ok, true);

    // A host callback that throws never ends the session it reports on.
    const again = await engineFor(fakeQuery().fn);
    const ok = await again.delegate({
      prompt: "hi",
      cwd: "/tmp/game-workspace",
      permissions: chat({
        onMode: () => {
          throw new Error("host bug");
        },
      }),
    });
    assert.equal(ok.ok, true);
  });

  it("keeps the rules of a partly whole-tool suggestion, without the whole tool", () => {
    const mixed = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash" }, { toolName: "Bash", ruleContent: "git add:*" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ];
    assert.deepEqual(permissionGrants(mixed as never), {
      grants: [{ kind: "rule", rule: "Bash(git add:*)", scope: "game" }],
      updates: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git add:*" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
  });

  it("takes the live control back at the first result, once", async () => {
    // The SDK closes the session's input at its first result; a later pick would reach nothing.
    const events: string[] = [];
    const stream = [
      {
        type: "system",
        subtype: "init",
        model: "claude-sonnet-5",
        session_id: "ses_chat",
        permissionMode: "default",
        tools: [],
      },
      { type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 1, usage: {} },
      { type: "system", subtype: "status", status: null, session_id: "ses_chat" },
    ];
    const { fn } = fakeQuery(stream, { control: true });
    await (await engineFor(fn)).delegate({
      prompt: "hi",
      cwd: "/tmp/game-workspace",
      permissions: chat({ onControl: (control) => events.push(control ? "control" : "released") }),
    });
    assert.deepEqual(events, ["control", "released"]);
  });

  it("hands the picker a live control while the turn runs, and takes it back when it ends", async () => {
    const { fn, modes } = fakeQuery(run, { control: true });
    const engine = await engineFor(fn);
    const controls: Array<{ setMode(mode: string): Promise<void> } | null> = [];
    await engine.delegate({
      prompt: "hi",
      cwd: "/tmp/game-workspace",
      permissions: chat({ onControl: (control) => controls.push(control) }),
    });
    assert.equal(controls.length, 2);
    assert.equal(controls[1], null);
    await controls[0]!.setMode("bypassPermissions");
    assert.deepEqual(modes, ["bypassPermissions"], "the picker's change reaches the running session");

    // A session that cannot switch says so instead of pretending.
    const plain = fakeQuery();
    const without: Array<{ setMode(mode: string): Promise<void> } | null> = [];
    await (await engineFor(plain.fn)).delegate({
      prompt: "hi",
      cwd: "/tmp/game-workspace",
      permissions: chat({ onControl: (control) => without.push(control) }),
    });
    await assert.rejects(() => without[0]!.setMode("plan"), /cannot change its permission mode/);

    // A session that fails still hands the control back.
    const failing = fakeQuery([], { throwOn: new Error("boom"), control: true });
    const ended: Array<unknown> = [];
    await assert.rejects(() =>
      engineFor(failing.fn).then((e) =>
        e.delegate({
          prompt: "hi",
          cwd: "/tmp/game-workspace",
          permissions: chat({ onControl: (control) => ended.push(control) }),
        }),
      ),
    );
    assert.equal(ended.length, 2);
    assert.equal(ended[1], null);
  });
});

/**
 * A build's lead (and the run's coordinator) is read-only and unattended, until the host hands it
 * `leadAsks`: then it keeps what the chat's own session keeps, starts in the chat's Auto, Accept
 * edits or Bypass, else in Manual so every edit and command reaches `canUseTool`, the host answers
 * for the chat's mode, and the picker switches it mid-turn. Everything else about its session stays
 * as it was.
 */
describe("a build's lead asks from the chat's mode, and the host answers", () => {
  const leadRequest = (extra: Record<string, unknown> = {}) => ({
    prompt: "lead the run",
    cwd: "/tmp/game-workspace",
    readOnly: true,
    resume: "chat-session",
    extraReads: ["/tmp/studio-scratch/autopilot/run_lead"],
    denyReads: ["/tmp/sibling-game"],
    director: { runId: "run_lead", threadId: "t", project: "game", root: "/tmp/build", chatSession: true },
    liveTools: [],
    onLiveTool: async () => "",
    ...extra,
  });
  const leadAsks = (overrides: Record<string, unknown> = {}) => ({
    mode: "default",
    allow: ["Bash(npm test *)"],
    directories: ["/Users/me/refs"],
    protectWrites: ["/tmp/studio/settings.json"],
    ask: async (): Promise<PermissionReply> => ({ decision: "allow" }),
    screen: async (): Promise<WithdrawnAnswer | AskFirst | null> => null,
    ...overrides,
  });

  it("keeps its tools, the web and helpers, starts in Manual with no sandbox, and carries the standing grants", async () => {
    const sessions: Options[] = [];
    for (const extra of [{}, { leadAsks: leadAsks() }]) {
      const { fn, seen } = fakeQuery();
      await (await engineFor(fn, ["/tmp/secrets"])).delegate(leadRequest(extra) as never);
      sessions.push(seen[0]!);
    }
    const [unattended, asking] = sessions as [Options, Options];
    // Without it: the unattended lead, byte for byte as before.
    assert.equal(unattended.permissionMode, "acceptEdits");
    assert.equal("canUseTool" in unattended, false);
    assert.equal((unattended.sandbox as Options).autoAllowBashIfSandboxed, true);
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"])
      assert.ok((unattended.disallowedTools as string[]).includes(tool), `${tool} is not an unattended lead's`);
    // With it: Manual, so nothing beyond reads in its folders and the studio's tools goes unasked.
    assert.equal(asking.permissionMode, "default");
    assert.equal(typeof asking.canUseTool, "function");
    // Flipped: a lead started outside Bypass was launched without the flag, so
    // nothing could switch it there. The picker switches a running lead now, as the chat's own
    // session, and the CLI reaches Bypass mid-turn only for a session launched with the flag.
    assert.equal(asking.allowDangerouslySkipPermissions, true, "the picker can switch it to Bypass");
    assert.equal("sandbox" in asking, false, "every command it runs was asked about first");
    // Flipped: it lost its helpers (Agent, Task) and asked before the web. It
    // keeps what the chat's own session keeps now: only messaging and its own ways to ask are not its.
    assert.deepEqual(asking.disallowedTools, ["SendMessage", "ListAgents", "AskUserQuestion", "EnterPlanMode"]);
    const allowed = asking.allowedTools as string[];
    for (const tool of ["Bash", "Edit", "Write"]) assert.equal(allowed.includes(tool), false, `${tool} asks first`);
    for (const tool of ["WebFetch", "WebSearch"])
      assert.ok(allowed.includes(tool), `${tool} runs unasked, as for the chat's own session`);
    assert.deepEqual(asking.additionalDirectories, [
      path.resolve("/tmp/studio-scratch/autopilot/run_lead"),
      path.resolve("/Users/me/refs"),
    ]);
    const rules = (asking.settings as { permissions: { allow: string[]; deny: string[] } }).permissions;
    assert.deepEqual(rules.allow, ["Bash(npm test *)"], "the person's saved rules stand");
    const fenced = [
      absoluteRule("Edit", "/tmp/secrets"),
      absoluteRule("Edit", "/tmp/studio/settings.json"),
      absoluteRule("Read", "/tmp/sibling-game"),
    ];
    for (const rule of fenced) assert.ok(rules.deny.includes(rule), `fenced: ${rule}`);
    // Everything else is its session as it was: where it sits, what it resumes, its tools.
    for (const key of ["cwd", "resume", "settingSources", "strictMcpConfig"])
      assert.deepEqual(asking[key], unattended[key], key);
  });

  it("starts in the chat's Auto or Accept edits, and fences none of its folders from writes", async () => {
    const sessions: Options[] = [];
    for (const mode of ["auto", "acceptEdits", "default", "bypassPermissions"] as const) {
      const { fn, seen } = fakeQuery();
      await (await engineFor(fn)).delegate(leadRequest({ leadAsks: leadAsks({ mode }) }) as never);
      sessions.push(seen[0]!);
    }
    const [auto, accepting, manual, bypassing] = sessions as [Options, Options, Options, Options];
    // A Bypass chat's lead runs in Bypass, as the chat's own session: what Claude Code still asks
    // there (its checks no mode skips) reaches the host, which cards it.
    assert.equal(bypassing.permissionMode, "bypassPermissions");
    assert.equal(bypassing.allowDangerouslySkipPermissions, true);
    assert.equal(typeof bypassing.canUseTool, "function");
    assert.equal(auto.permissionMode, "auto");
    assert.equal(accepting.permissionMode, "acceptEdits");
    for (const session of [auto, accepting]) {
      assert.equal(typeof session.canUseTool, "function", "what the mode still asks goes to the host");
      // Flipped: "never switched to Bypass". The picker may switch it there now.
      assert.equal(session.allowDangerouslySkipPermissions, true, "the picker can switch it to Bypass");
      assert.equal("sandbox" in session, false);
      const matchers = (session.hooks as { PreToolUse: Array<{ matcher?: string }> }).PreToolUse;
      assert.equal(matchers.length, 1, "the host's screen stands, to ask first once the chat leaves the mode");
    }
    const allowed = auto.allowedTools as string[];
    for (const tool of ["Bash", "Edit", "Write"])
      assert.equal(allowed.includes(tool), false, `${tool} is the classifier's`);
    // Flipped: a lead started in Auto had its folder and the host's read grants
    // fenced from writes by Edit rules. Only the chat's mode and the studio's own fence (secrets,
    // settings) limit it now, as the chat's own session.
    for (const session of [auto, accepting, manual]) {
      const deny = permissionsOf(session).deny;
      for (const dir of ["/tmp/game-workspace", "/tmp/studio-scratch/autopilot/run_lead"]) {
        const file = path.join(dir, "src", "main.js");
        assert.equal(
          ruleDenies(deny, "Edit", file),
          false,
          `${session.permissionMode}: writes in ${dir} are the mode's`,
        );
      }
      assert.ok(ruleDenies(deny, "Edit", "/tmp/studio/settings.json"), "the studio's own files stay fenced");
    }
    // The studio's rules for the classifier: a build session, never a read-only one, and no game
    // folder carve-out (its edits there are not checkpointed per message).
    const { autoMode } = auto.settings as { autoMode: Record<string, string[]> };
    assert.equal(autoMode.allow![0], "$defaults");
    assert.equal(
      autoMode.environment!.some((entry) => entry.startsWith("**Read-only session**")),
      false,
    );
    const build = autoMode.environment!.find((entry) => entry.startsWith("**Build session**"));
    assert.ok(build, "a build session");
    // The lead builds with its own hands: Auto's classifier reads that its edits and commits in the
    // integration worktree it leads are the work, not a session overstepping workers' ground.
    assert.match(build, /A lead edits and commits in the run's integration worktree/);
    assert.equal(
      autoMode.allow!.some((entry) => entry.startsWith("Game Folder Work:")),
      false,
    );
  });

  // Only the chat's own session handed the picker a live control: a lead's session kept the mode it
  // started in until its next session.
  it("hands the picker a live control of its running session, and takes it back when it ends", async () => {
    const { fn, modes } = fakeQuery(run, { control: true });
    const controls: Array<{ setMode(mode: string): Promise<void> } | null> = [];
    await (await engineFor(fn)).delegate(
      leadRequest({
        leadAsks: leadAsks({ onControl: (control: unknown) => controls.push(control as never) }),
      }) as never,
    );
    assert.equal(controls.length, 2);
    assert.equal(controls[1], null, "taken back");
    await controls[0]!.setMode("bypassPermissions");
    assert.deepEqual(modes, ["bypassPermissions"], "the picker's change reaches the lead's session");
  });

  it("refuses its own ways to ask or plan without the host, and never keeps a mode", async () => {
    const asked: PermissionAsk[] = [];
    const { fn, seen } = fakeQuery();
    await (await engineFor(fn)).delegate(
      leadRequest({
        leadAsks: leadAsks({
          ask: async (request: PermissionAsk): Promise<PermissionReply> => {
            asked.push(request);
            return { decision: "always" };
          },
        }),
      }) as never,
    );
    const canUseTool = seen[0]!.canUseTool as CanUseTool;
    for (const tool of ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]) {
      const result = await canUseTool(tool, {}, ask());
      assert.equal(result.behavior, "deny", tool);
      assert.match(String(result.message), /say in your reply/);
    }
    assert.equal(asked.length, 0, "none of them reaches the host");
    const suggestions = [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      { type: "addDirectories", directories: ["/Users/me/Desktop"], destination: "localSettings" },
    ];
    const input = { file_path: "/Users/me/Desktop/notes.txt" };
    const result = await canUseTool("Read", input, ask({ suggestions }));
    assert.deepEqual(asked[0]!.always, [{ kind: "directory", path: "/Users/me/Desktop" }]);
    assert.deepEqual(result, {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "addDirectories", directories: ["/Users/me/Desktop"], destination: "session" }],
    });
  });

  /**
   * Claude Code applies allow rules before it asks (review H1): a rule the person saved, or one in the
   * game's own settings, let the lead act without the host. A PreToolUse hook runs ahead of every
   * rule and in every mode, so the host screens each call there; reads and the studio's own tools
   * never wait on it.
   */
  it("screens every call but a read or the studio's own, ahead of Claude Code's rules, in the host's words", async () => {
    const away = "The person is not in the chat to approve this, so it was not allowed.";
    const screened: ScreenedCall[] = [];
    let reply: WithdrawnAnswer | AskFirst | null = { decision: "deny", withdrawn: true, message: away };
    let throws = false;
    const sessions: Options[] = [];
    for (const extra of [
      {
        leadAsks: leadAsks({
          screen: async (call: ScreenedCall) => {
            screened.push(call);
            if (throws) throw new Error("the host went away");
            return reply;
          },
        }),
      },
      {},
    ]) {
      const { fn, seen } = fakeQuery();
      await (await engineFor(fn)).delegate(leadRequest(extra) as never);
      sessions.push(seen[0]!);
    }
    const [asking, unattended] = sessions as [Options, Options];
    assert.equal("hooks" in unattended, false, "an unattended lead has nothing to screen");
    type Hook = (input: Record<string, unknown>, id: string, options: { signal: AbortSignal }) => Promise<unknown>;
    const matchers = (asking.hooks as { PreToolUse: Array<{ matcher?: string; hooks: Hook[] }> }).PreToolUse;
    assert.equal(matchers.length, 1);
    assert.equal(matchers[0]!.matcher, undefined, "every tool, not a list that a new one slips past");
    const hook = matchers[0]!.hooks[0]!;
    const call = (tool: string, input: Record<string, unknown> = {}) =>
      hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "tu" }, "tu", {
        signal: new AbortController().signal,
      });
    const refused = (reason: string) => ({
      decision: "block",
      reason,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    });
    for (const tool of ["Read", "Glob", "Grep", "LS", "NotebookRead", "ToolSearch", "TodoWrite", "mcp__studio__show"])
      assert.deepEqual(await call(tool, { file_path: "/tmp/x" }), {}, tool);
    assert.equal(screened.length, 0, "a read never waits on the host");
    const acts = ["Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Skill"];
    for (const tool of [...acts, "mcp__other__send"])
      assert.deepEqual(await call(tool, { command: "ls" }), refused(away), tool);
    assert.deepEqual(
      screened.map(({ tool }) => tool),
      [...acts, "mcp__other__send"],
    );
    assert.deepEqual(screened[0]!.input, { command: "ls" });
    reply = null;
    assert.deepEqual(await call("Bash", { command: "ls" }), {}, "the person is there: the rules and questions decide");
    // A lead started in Auto whose chat has left it: asked about first, whatever the classifier says.
    const leftAuto = "The chat switched from Auto to Manual.";
    reply = { askFirst: true, reason: leftAuto };
    assert.deepEqual(await call("Bash", { command: "ls" }), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: leftAuto,
      },
    });
    reply = null;
    throws = true;
    assert.deepEqual(
      await call("Bash", {}),
      refused(
        "The studio could not check this, so it was not allowed. Do not retry it; say in your reply what you needed.",
      ),
      "a screen that fails refuses",
    );
    // Not a tool call: nothing to screen.
    assert.deepEqual(
      await hook({ hook_event_name: "PostToolUse", tool_name: "Bash" }, "tu", { signal: new AbortController().signal }),
      {},
    );
  });

  it("keeps a facet's ownership hook beside nothing else", async () => {
    const { fn, seen } = fakeQuery();
    await (await engineFor(fn)).delegate({
      prompt: "build the sky",
      cwd: "/tmp/game-workspace",
      ownership: { facetId: "sky", owns: ["src/sky"], ownsMain: false },
    } as never);
    const matchers = (seen[0]!.hooks as { PreToolUse: Array<{ matcher?: string }> }).PreToolUse;
    assert.deepEqual(
      matchers.map((m) => m.matcher),
      ["Edit|Write|MultiEdit|NotebookEdit"],
    );
  });

  it("reads the host's deny as it is written", async () => {
    const message = "The person is not in the chat to approve this, so it was not allowed.";
    const { fn, seen } = fakeQuery();
    await (await engineFor(fn)).delegate(
      leadRequest({
        leadAsks: leadAsks({ ask: async () => ({ decision: "deny", withdrawn: true, message }) }),
      }) as never,
    );
    const canUseTool = seen[0]!.canUseTool as CanUseTool;
    assert.deepEqual(await canUseTool("Bash", { command: "ls ~/Downloads" }, ask()), { behavior: "deny", message });
  });
});

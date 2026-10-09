import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStudioDevArgs, parseOperation } from "../../scripts/studio-dev/args.ts";
import { FIXTURE_NAMES } from "../../src/main/dev/fixtures.ts";
import { devBuildArgs, launchEnv, main } from "../../scripts/studio-dev.ts";
import { gamesRootWarnings, liveEnvStripped, StudioDevWarning } from "../../scripts/studio-dev/live-env.ts";
import { fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";
import { freshMachineEnv } from "../../scripts/studio-dev/fresh-machine.ts";
import { strippedEnv } from "../../scripts/evals/lanes/common.ts";

test("fixtures lists the one exported fixture list without a profile or app", async () => {
  // Flipped from 19: the chat-workers fixture joined the list.
  assert.equal(FIXTURE_NAMES.length, 20);
  for (const added of [
    "first-launch",
    "notifications",
    "build-graph",
    "lead-graph",
    "sandbox-setup",
    "update-ready",
    "chat-workers",
  ])
    assert.ok((FIXTURE_NAMES as readonly string[]).includes(added), added);
  assert.deepEqual(await main(["fixtures"]), { fixtures: [...FIXTURE_NAMES] });
  // An unknown fixture is refused before any profile is allocated or build started.
  await assert.rejects(
    main(["start", "--profile", "cli-test-never-created", "--fixture", "nope"]),
    /unknown named fixture; one of app-basics/,
  );
});

test("lifecycle commands keep their flags; missing profile and unknown commands fail before any work", () => {
  assert.deepEqual(parseStudioDevArgs(["start", "--profile", "p", "--fixture", "sidebar", "--reuse"]), {
    command: "start",
    profile: "p",
    reuse: true,
    providers: undefined,
    fixture: "sidebar",
  });
  assert.deepEqual(parseStudioDevArgs(["stop", "--profile", "p"]), { command: "stop", profile: "p", reuse: false });
  assert.throws(() => parseStudioDevArgs(["status"]), /Usage: studio:dev/);
  assert.throws(() => parseStudioDevArgs(["launch", "--profile", "p"]), /unknown command launch/);
  assert.throws(() => parseStudioDevArgs(["start", "--profile", "--fixture", "x"]), /--profile needs a value/);
});

test("ui takes a request file, stdin or inline --json, exactly one of them", () => {
  assert.equal(parseStudioDevArgs(["ui", "--profile", "p", "--request", "/tmp/r.json"]).requestFile, "/tmp/r.json");
  assert.equal(parseStudioDevArgs(["diagnostics", "--profile", "p", "--request", "-"]).requestFile, "-");
  const inline = parseStudioDevArgs([
    "ui",
    "--profile",
    "p",
    "--json",
    '{"method":"click","params":{"selector":"[aria-label=\\"Send\\"]"}}',
  ]);
  assert.deepEqual(inline.operation, { method: "click", params: { selector: '[aria-label="Send"]' } });
  assert.equal(inline.requestFile, undefined);
  assert.throws(() => parseStudioDevArgs(["ui", "--profile", "p"]), /--request FILE, --request - or --json/);
  assert.throws(
    () => parseStudioDevArgs(["ui", "--profile", "p", "--request", "a.json", "--json", "{}"]),
    /one of --request or --json/,
  );
  // Inline requests get the same closed schema as files: no eval, no privileged fields.
  assert.throws(() =>
    parseStudioDevArgs(["ui", "--profile", "p", "--json", '{"method":"evaluate","params":{"expression":"1"}}']),
  );
  assert.throws(() => parseStudioDevArgs(["ui", "--profile", "p", "--json", '{"method":"stop","params":{"pid":1}}']));
  assert.throws(() => parseOperation("{not json"), /request is not JSON/);
  assert.deepEqual(parseOperation('{"method":"game.state","params":{}}'), { method: "game.state", params: {} });
});

test("snapshot, logs and capture shortcuts build the protocol operations with its defaults", () => {
  assert.deepEqual(parseStudioDevArgs(["snapshot", "--profile", "p"]).operation, {
    method: "snapshot",
    params: { surface: "desktop", limit: 150 },
  });
  assert.deepEqual(
    parseStudioDevArgs(["snapshot", "--profile", "p", "--scope", "[data-stage-view]", "--limit", "20"]).operation,
    { method: "snapshot", params: { surface: "desktop", scope: "[data-stage-view]", limit: 20 } },
  );
  assert.deepEqual(parseStudioDevArgs(["logs", "--profile", "p"]).operation, {
    method: "logs",
    params: { surface: "desktop", cursor: 0, limit: 100 },
  });
  assert.deepEqual(parseStudioDevArgs(["logs", "--profile", "p", "--surface", "core", "--cursor", "7"]).operation, {
    method: "logs",
    params: { surface: "core", cursor: 7, limit: 100 },
  });
  assert.deepEqual(parseStudioDevArgs(["capture", "--profile", "p"], 42).operation, {
    method: "capture",
    params: { surface: "desktop", name: "capture-42" },
  });
  assert.throws(() => parseStudioDevArgs(["logs", "--profile", "p", "--limit", "9999"]));
  assert.throws(() => parseStudioDevArgs(["logs", "--profile", "p", "--surface", "keychain"]));
  assert.throws(() => parseStudioDevArgs(["capture", "--profile", "p", "--name", "../private"]));
});

test("the CLI prints the fixture list as JSON and reports errors as JSON with exit 1", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/studio-dev.ts", ...args], { encoding: "utf8" });
  const ok = run("fixtures");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).fixtures, [...FIXTURE_NAMES]);
  const bad = run("ui", "--profile", "p");
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stderr).error, /--json is required/);
});

test("runs is a shortcut for the read-only runs operation", () => {
  assert.deepEqual(parseStudioDevArgs(["runs", "--profile", "p"]).operation, { method: "runs", params: {} });
  assert.throws(() => parseStudioDevArgs(["runs"]), /Usage: studio:dev/);
});

/** A caller that is itself a coding-agent session, with the account basics every launch keeps. */
const AGENT_SESSION_PARENT = {
  HOME: "/Users/operator",
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  CLAUDE_CONFIG_DIR: "/Users/operator/.claude-work",
  CODEX_HOME: "/Users/operator/.codex-work",
  GENEX_API_URL: "https://genex.test",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
  ANTHROPIC_API_KEY: "sk-ant-agent-session",
  ANTHROPIC_AUTH_TOKEN: "agent-token",
  OPENAI_API_KEY: "sk-agent-session",
  CODEX_API_KEY: "codex-agent-session",
  CODEX_ACCESS_TOKEN: "codex-access",
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "x",
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_AGENT_SDK_VERSION: "1.0.0",
  CLAUDE_EFFORT: "max",
  CLAUDE_PID: "4242",
  CLAUDE_PREVIEW_CLASSIFIER_FLOOR: "0.5",
  DISABLE_MICROCOMPACT: "1",
  API_TIMEOUT_MS: "900000",
  MCP_CONNECTION_NONBLOCKING: "true",
  MCP_SERVER_CONNECTION_BATCH_SIZE: "8",
  AI_AGENT: "claude-code",
  BAGGAGE: "session=x",
  USE_STAGING_OAUTH: "1",
  USE_LOCAL_OAUTH: "1",
  ELECTRON_RUN_AS_NODE: "1",
} as const;

test("a live launch does not hand the app the caller's agent-session variables", () => {
  const live = { providers: "live" };
  const env = launchEnv(live, AGENT_SESSION_PARENT);
  for (const name of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
    "DISABLE_MICROCOMPACT",
    "API_TIMEOUT_MS",
    "MCP_CONNECTION_NONBLOCKING",
    "MCP_SERVER_CONNECTION_BATCH_SIZE",
    "AI_AGENT",
    "BAGGAGE",
    "USE_STAGING_OAUTH",
    "USE_LOCAL_OAUTH",
    "ELECTRON_RUN_AS_NODE",
  ])
    assert.equal(env[name], undefined, `${name} must not reach a live app`);
  // The operator's explicit account homes, the account basics and the app's own switches stay.
  for (const name of ["HOME", "PATH", "LANG", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GENEX_API_URL"] as const)
    assert.equal(env[name], AGENT_SESSION_PARENT[name], name);
  // The start JSON names what it dropped, never a value.
  const stripped = liveEnvStripped(AGENT_SESSION_PARENT);
  assert.deepEqual(stripped, [...stripped].sort());
  assert.ok(stripped.includes("ANTHROPIC_BASE_URL") && stripped.includes("CLAUDE_CODE_SESSION_ID"));
  assert.ok(!stripped.includes("CLAUDE_CONFIG_DIR") && !stripped.includes("HOME"));
  assert.ok(
    stripped.every((name) => Object.hasOwn(AGENT_SESSION_PARENT, name)),
    "names only",
  );
  assert.ok(!JSON.stringify(stripped).includes("sk-ant-agent-session"));
  assert.deepEqual(liveEnvStripped({ HOME: "/Users/operator" }), []);
  // The caller's own environment is read, never changed.
  assert.equal(AGENT_SESSION_PARENT.CLAUDECODE, "1");
});

test("fixture and fresh-machine launches keep their own environments", (t) => {
  assert.deepEqual(launchEnv({ providers: "fixture" }, AGENT_SESSION_PARENT), fixtureElectronEnv(AGENT_SESSION_PARENT));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const roots = { home: path.join(home, "home"), secureStorage: path.join(home, "secure") };
  assert.deepEqual(
    launchEnv({ providers: "live", freshMachine: true, ...roots }, AGENT_SESSION_PARENT),
    freshMachineEnv(AGENT_SESSION_PARENT, roots),
  );
});

test("the eval lanes strip the same session variables a live launch does, and the account homes too", () => {
  for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ELECTRON_RUN_AS_NODE", "CLAUDE_CODE_SESSION_ID"])
    assert.equal(strippedEnv(AGENT_SESSION_PARENT)[name], undefined, name);
  assert.equal(strippedEnv(AGENT_SESSION_PARENT).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(strippedEnv(AGENT_SESSION_PARENT).GENEX_API_URL, undefined);
});

test("a live games root under a .claude folder is warned about, through a link too, and nothing is created", (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "games-root-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const claudeTree = path.join(base, "repo/.claude/worktrees/wt");
  fs.mkdirSync(claudeTree, { recursive: true });
  fs.mkdirSync(path.join(base, "plain"), { recursive: true });
  fs.symlinkSync(claudeTree, path.join(base, "plain/linked"));
  const games = (checkout: string) => path.join(checkout, ".studio-dev/profiles/p/games");
  const rows: Array<[string, string, string | null]> = [
    ["plain checkout", games(path.join(base, "plain")), null],
    ["worktree under .claude", games(claudeTree), path.join(base, "repo/.claude")],
    ["link into a .claude tree", games(path.join(base, "plain/linked")), path.join(base, "repo/.claude")],
    ["a .claude-like name", games(path.join(base, "plain/.claude-old/x")), null],
    ["a name ending in .claude", games(path.join(base, "plain/notes.claude")), null],
    ["a .Claude folder in another case", games(path.join(base, "repo/.Claude/x")), path.join(base, "repo/.Claude")],
    [
      "several missing folders below a link into a .claude tree",
      games(path.join(base, "plain/linked/not/yet/made")),
      path.join(base, "repo/.claude"),
    ],
  ];
  for (const [name, root, at] of rows) {
    const warnings = gamesRootWarnings(root);
    assert.deepEqual(warnings, at ? [{ code: StudioDevWarning.GamesRootUnderClaudeFolder, at }] : [], name);
    assert.equal(fs.existsSync(root), false, `${name}: the check creates nothing`);
  }
});

test("a fixture profile's build counts React commits for its checks; a live profile's does not", () => {
  assert.deepEqual(devBuildArgs("b-1", "fixture"), ["scripts/build.mjs", "--dev-build=b-1", "--commit-counts"]);
  assert.deepEqual(devBuildArgs("b-2", "live"), ["scripts/build.mjs", "--dev-build=b-2"]);
});

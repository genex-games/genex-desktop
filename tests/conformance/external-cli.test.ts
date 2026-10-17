import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cliVersion,
  codingCliBinary,
  discoverCodingCli,
  configureCodingClis,
  setCodingCliOverride,
  invalidateCodingCli,
  resolveCodingCli,
  requireCodingCli,
  standardCliDirs,
} from "../../src/substrate/engines/external-cli.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { cliName, writeCliLauncher } from "../helpers/external-cli.ts";
const root = await mkdtemp(path.join(os.tmpdir(), "studio-external-cli-"));
const options = { loginPath: "", home: root, env: { PATH: "" }, standardDirs: [], excludedRoots: [] };
const WINDOWS = process.platform === "win32";
const FLAGS =
  "--json --output-schema --ignore-user-config --skip-git-repo-check --input-format --output-format --strict-mcp-config --setting-sources --permission-mode --mcp-config --allowedTools --disallowedTools";
const exe = cliName;
const launcher = writeCliLauncher;
test("fixture host discovery does not execute a provider from the inherited PATH", async () => {
  const bin = path.join(root, "inherited-provider");
  const marker = path.join(root, "must-not-run");
  await launcher(
    path.join(bin, exe("codex")),
    `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 99\n`,
    `require("fs").writeFileSync(${JSON.stringify(marker)}, ""); process.exit(99);\n`,
  );
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    configureCodingClis(path.join(root, "isolated-settings.json"), [], {
      loginPath: "",
      home: root,
      env: { PATH: "" },
      standardDirs: [],
    });
    for (const provider of ["codex", "claude-code"] as const) {
      assert.equal((await resolveCodingCli(provider, undefined, undefined, true)).status.state, "missing");
    }
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    configureCodingClis(path.join(root, "settings.json"), [], options);
  }
});
async function cli(relative: string, version = "fixture 1.0") {
  const file = path.join(root, exe(relative));
  await launcher(
    file,
    `#!/bin/sh\ncase "$1" in\n --version) echo '${version}';;\n *) echo '${FLAGS}';;\nesac\n`,
    `console.log(process.argv[2] === "--version" ? ${JSON.stringify(version)} : ${JSON.stringify(FLAGS)});\n`,
  );
  await chmod(file, 0o755);
  return file;
}
test("external discovery order, GUI PATH, spaces, symlinks and duplicate installations", async () => {
  const first = await cli("login path/codex");
  const second = await cli("standard/codex");
  const alias = path.join(root, "linked");
  await symlink(path.dirname(first), alias, WINDOWS ? "junction" : undefined);
  const status = await discoverCodingCli("codex", {
    ...options,
    loginPath: alias,
    standardDirs: [path.dirname(second)],
  });
  assert.equal(status.status.path, path.join(alias, exe("codex")));
  assert.equal(status.status.state, "ready");
  assert.ok(status.env.PATH?.startsWith(alias));
  assert.equal(
    (await discoverCodingCli("codex", { ...options, standardDirs: [path.dirname(second)] })).status.path,
    second,
  );
  assert.equal(
    (await discoverCodingCli("codex", { ...options, override: second, loginPath: alias })).status.path,
    second,
  );
});
test("invalid manual override never falls back; bundled and project dependencies are excluded", async () => {
  const external = await cli("external/codex");
  const invalid = await discoverCodingCli("codex", {
    ...options,
    override: "/no/such/cli",
    loginPath: path.dirname(external),
  });
  assert.equal(invalid.status.state, "invalid_path");
  const bundled = await cli("studio/node_modules/@openai/codex/bin/codex");
  assert.equal(
    (await discoverCodingCli("codex", { ...options, loginPath: path.dirname(bundled) })).status.state,
    "missing",
  );
  const excluded = await discoverCodingCli("codex", {
    ...options,
    loginPath: path.dirname(external),
    excludedRoots: [path.dirname(external)],
  });
  assert.equal(excluded.status.state, "missing");
});
test("npm launchers report missing Node and carry the required launch environment", async () => {
  const shim = await cli("npm/claude");
  const js =
    'console.log(process.argv.includes("--version") ? "fixture 2" : "--input-format --output-format --strict-mcp-config --setting-sources --permission-mode --mcp-config --allowedTools --disallowedTools");\n';
  if (WINDOWS) {
    // npm's cmd-shim: the node.exe beside it, else the first node on PATH.
    await writeFile(shim.replace(/\.cmd$/, ".js"), js);
    await writeFile(
      shim,
      '@ECHO off\r\nSETLOCAL\r\nIF EXIST "%~dp0\\node.exe" (\r\n  SET "_prog=%~dp0\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%" "%~dp0\\claude.js" %*\r\n',
    );
  } else {
    await writeFile(shim, `#!/usr/bin/env node\n${js}`);
  }
  assert.equal(
    (await discoverCodingCli("claude-code", { ...options, override: shim })).status.state,
    "missing_runtime",
  );
  await mkdir(path.join(root, "node-bin"), { recursive: true });
  await symlink(process.execPath, path.join(root, "node-bin", WINDOWS ? "node.exe" : "node"));
  const found = await discoverCodingCli("claude-code", {
    ...options,
    override: shim,
    loginPath: path.join(root, "node-bin"),
  });
  assert.equal(found.status.state, "ready");
  assert.equal(found.status.version, "fixture 2");
});
test("external update and removal are observed on the next resolution", async () => {
  const binary = await cli("update/codex", "v1");
  assert.equal((await discoverCodingCli("codex", { ...options, override: binary })).status.version, "v1");
  await cli("update/codex", "v2");
  assert.equal((await discoverCodingCli("codex", { ...options, override: binary })).status.version, "v2");
  await rm(binary);
  assert.equal((await discoverCodingCli("codex", { ...options, override: binary })).status.state, "invalid_path");
});
test("unsupported commands and failed executables are actionable", async () => {
  const binary = await cli("old/codex");
  await launcher(binary, "#!/bin/sh\necho old-version\n", 'console.log("old-version");\n');
  const result = await discoverCodingCli("codex", { ...options, override: binary });
  assert.equal(result.status.state, "incompatible");
  assert.match(result.status.detail, /old-version/);
});
test("host-owned overrides persist, clear, and validate provider IDs", async () => {
  const settings = path.join(root, "host/settings.json");
  configureCodingClis(settings, [], options);
  await setCodingCliOverride("codex", "/invalid/manual");
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { codex: "/invalid/manual" });
  // With no automatic installation either, a broken saved path reads as not installed.
  assert.equal((await resolveCodingCli("codex")).status.state, "missing");
  await setCodingCliOverride("codex", null);
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), {});
  await assert.rejects(() => setCodingCliOverride("arbitrary" as never, "/bin/sh"), /Unknown/);
});
test("missing external Claude fails before any SDK call, including the judge", async () => {
  let called = 0;
  const engine = new ClaudeCodeEngine({
    engineHome: path.join(root, "claude-home"),
    executable: "/missing/external/claude",
    queryFn: (() => {
      called++;
      throw new Error("SDK called");
    }) as never,
  });
  await assert.rejects(() => engine.complete({ messages: [{ role: "user", content: "test" }] }), /selected path/);
  await assert.rejects(() => engine.delegate({ cwd: root, prompt: "test" }), /selected path/);
  assert.equal(called, 0);
});
test("Stop during CLI diagnostics kills the probe and never proceeds to execution", async () => {
  const binary = await cli("slow/codex");
  const pidFile = path.join(root, "slow/pid");
  const body = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`;
  // On Windows the pid is the Node under cmd.exe: Stop must end the whole tree.
  await launcher(binary, `#!${process.execPath}\n${body}`, body);
  const controller = new AbortController();
  const pending = discoverCodingCli("codex", { ...options, override: binary, signal: controller.signal });
  const rejected = assert.rejects(pending, /stopped by test/);
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) {
    try {
      pid = Number(await readFile(pidFile, "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  assert.ok(pid, "diagnostic process started");
  controller.abort(new Error("stopped by test"));
  await rejected;
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 10));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the local diagnostic process was released");
});
test("Stop while resolving Claude prevents both SDK entry points from launching", async () => {
  for (const operation of ["complete", "delegate"] as const) {
    let calls = 0;
    const controller = new AbortController();
    const engine = new ClaudeCodeEngine({
      engineHome: path.join(root, "stopped-home"),
      resolveCli: async (provider) => {
        controller.abort(new Error("stopped during discovery"));
        return {
          path: "/fixture/claude",
          env: {},
          status: { provider, state: "ready", selection: "automatic", detail: "", guidanceUrl: "" },
        };
      },
      queryFn: (() => {
        calls++;
        throw new Error("SDK must not start");
      }) as never,
    });
    if (operation === "complete") {
      await assert.rejects(
        () => engine.complete({ messages: [{ role: "user", content: "test" }], signal: controller.signal }),
        /stopped/,
      );
    } else {
      const result = await engine.delegate({ cwd: root, prompt: "test", signal: controller.signal });
      assert.equal(result.stopReason, "stopped");
      assert.equal(result.ok, false);
      assert.equal(result.sessionId, undefined);
    }
    assert.equal(calls, 0);
  }
});
test("an expired allocation during Claude discovery starts no SDK work", async () => {
  let calls = 0;
  const engine = new ClaudeCodeEngine({
    engineHome: path.join(root, "deadline-home"),
    resolveCli: async (provider, _override, signal) => {
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return {
        path: "/fixture/claude",
        env: {},
        status: { provider, state: "ready", selection: "automatic", detail: "", guidanceUrl: "" },
      };
    },
    queryFn: (() => {
      calls++;
      throw new Error("SDK must not start");
    }) as never,
  });
  const result = await engine.delegate({ cwd: root, prompt: "test", timeoutMs: 20 });
  assert.equal(result.stopReason, "deadline");
  assert.equal(result.turns, 0);
  assert.equal(calls, 0);
});
test("new sessions and explicit Recheck bypass readiness cache after an external update", async () => {
  const settings = path.join(root, "cache-host/settings.json");
  const binary = await cli("cache/codex", "first version");
  configureCodingClis(settings, [], options);
  await setCodingCliOverride("codex", binary);
  assert.equal((await resolveCodingCli("codex")).status.version, "first version");
  await cli("cache/codex", "second version");
  assert.equal((await requireCodingCli("codex")).status.version, "second version", "new session probes again");
  await rm(binary);
  assert.equal(
    (await resolveCodingCli("codex", undefined, undefined, true)).status.state,
    "missing",
    "Recheck sees removal",
  );
});
/** A CLI that notes every time it is asked anything, in `calls` beside it. */
async function countingCli(relative: string, version: string) {
  const file = path.join(root, exe(relative));
  const calls = `${file}.calls`;
  await launcher(
    file,
    `#!/bin/sh\necho "$1" >> '${calls}'\ncase "$1" in\n --version) echo '${version}';;\n *) echo '${FLAGS}';;\nesac\n`,
    `require("node:fs").appendFileSync(${JSON.stringify(calls)}, process.argv[2] + "\\n");\nconsole.log(process.argv[2] === "--version" ? ${JSON.stringify(version)} : ${JSON.stringify(FLAGS)});\n`,
  );
  await chmod(file, 0o755);
  const asked = async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { file, asked };
}

test("a new session reuses the login shell's PATH and an unchanged CLI's answers; Recheck asks again", {
  skip: WINDOWS && "a Windows .cmd shim stays the same file when its package updates, so its answers are never reused",
}, async () => {
  const settings = path.join(root, "session-reuse/settings.json");
  const binary = await countingCli("session-reuse/codex", "first version");
  let shells = 0;
  const loginShell = async () => {
    shells++;
    return "";
  };
  configureCodingClis(settings, [], { ...options, loginPath: undefined, loginShell });
  await setCodingCliOverride("codex", binary.file);
  assert.equal((await requireCodingCli("codex")).status.version, "first version");
  const askedOnce = await binary.asked();
  assert.equal((await requireCodingCli("codex")).status.version, "first version");
  assert.equal(await binary.asked(), askedOnce, "an unchanged CLI is not asked again");
  assert.equal(shells, 1, "the login shell is read once");
  invalidateCodingCli("codex");
  assert.equal((await requireCodingCli("codex")).status.version, "first version");
  assert.equal(shells, 2, "Recheck reads the login shell again");
  assert.equal(await binary.asked(), askedOnce * 2, "Recheck asks the CLI again");
});

test("a saved path that stopped working yields to a working automatic installation", async () => {
  const settings = path.join(root, "fallback-host/settings.json");
  const automatic = await cli("fallback/auto/codex", "auto 2.0.0");
  const stale = await cli("fallback/stale/codex", "stale 1.0.0");
  await launcher(stale, "#!/bin/sh\necho stale-version\n", 'console.log("stale-version");\n');
  configureCodingClis(settings, [], { ...options, loginPath: path.dirname(automatic) });
  try {
    await setCodingCliOverride("codex", "/moved/away/codex");
    let found = await resolveCodingCli("codex", undefined, undefined, true);
    assert.equal(found.status.state, "ready");
    assert.equal(found.status.path, automatic);
    assert.equal(found.status.selection, "automatic");
    await setCodingCliOverride("codex", stale);
    found = await resolveCodingCli("codex", undefined, undefined, true);
    assert.equal(found.status.path, automatic, "an outdated saved CLI yields too");
    assert.equal(
      (await resolveCodingCli("codex", stale, undefined, true)).status.state,
      "incompatible",
      "an explicit executable is never swapped",
    );
  } finally {
    configureCodingClis(path.join(root, "settings.json"), [], options);
  }
});
test("standard folders cover installers that never reach the login PATH", async () => {
  const home = path.join(root, "standard-home");
  for (const version of ["v18.20.1", "v22.3.0", "v9.0.0"])
    await mkdir(path.join(home, ".nvm/versions/node", version, "bin"), { recursive: true });
  const dirs = await standardCliDirs(home, "darwin");
  for (const dir of [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin"])
    assert.ok(dirs.includes(path.join(home, dir)), dir);
  const nvm = dirs.filter((dir) => dir.includes(".nvm"));
  assert.deepEqual(
    nvm.map((dir) => path.basename(path.dirname(dir))),
    ["v22.3.0", "v18.20.1", "v9.0.0"],
    "newest Node first",
  );
  assert.ok(dirs.indexOf("/opt/homebrew/bin") < dirs.indexOf(nvm[0]!));
});
test("standard folders cover the Node and package managers whose global installs need no PATH line", async () => {
  const home = path.join(root, "managers-home");
  const fnm = path.join(home, "Library/Application Support/fnm/node-versions");
  for (const version of ["v20.11.0", "v24.1.0"]) await mkdir(path.join(fnm, version), { recursive: true });
  const dirs = await standardCliDirs(home, "darwin", {}, []);
  for (const dir of ["Library/pnpm", ".local/share/mise/shims", ".asdf/shims"])
    assert.ok(dirs.includes(path.join(home, dir)), dir);
  assert.deepEqual(
    dirs.filter((dir) => dir.startsWith(fnm)),
    ["v24.1.0", "v20.11.0"].map((version) => path.join(fnm, version, "installation/bin")),
    "fnm's Node versions, newest first",
  );
});
test("a Mac with only the Claude and ChatGPT apps uses the copies they ship; an installed CLI wins", {
  skip: WINDOWS && "the desktop apps' copies are macOS launchers",
}, async () => {
  const home = path.join(root, "apps-home");
  const applications = path.join(root, "Applications");
  const claudeApp = (version: string, build: string) =>
    path.join(
      "apps-home/Library/Application Support/Claude/claude-code",
      version,
      build,
      "claude.app/Contents/MacOS/claude",
    );
  await cli(claudeApp("2.1.9", "0a1b2c3d4e5f"));
  const newest = await cli(claudeApp("2.1.286", "f2326db61802"));
  const codex = await cli("Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  const standardDirs = await standardCliDirs(home, "darwin", {}, [applications]);
  const found = async (provider: "claude-code" | "codex") =>
    (await discoverCodingCli(provider, { ...options, home, standardDirs })).status;
  assert.deepEqual(
    [await found("claude-code"), await found("codex")].map(({ state, path }) => ({ state, path })),
    [
      { state: "ready", path: newest },
      { state: "ready", path: codex },
    ],
  );
  const installed = await cli("apps-home/.local/bin/claude");
  assert.equal((await found("claude-code")).path, installed);
});
test("the ChatGPT app still under its old name, Codex, lends its copy too", {
  skip: WINDOWS && "the desktop apps' copies are macOS launchers",
}, async () => {
  const codex = await cli("Old Applications/Codex.app/Contents/Resources/codex-cli/bin/codex");
  const standardDirs = await standardCliDirs(root, "darwin", {}, [path.join(root, "Old Applications")]);
  const found = (await discoverCodingCli("codex", { ...options, standardDirs })).status;
  assert.deepEqual({ state: found.state, path: found.path }, { state: "ready", path: codex });
});
test("Windows standard folders: the native installers first, then npm's prefix and the Node managers", async () => {
  const env = { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" };
  assert.deepEqual(await standardCliDirs("C:\\Users\\Ada", "win32", env), [
    "C:\\Users\\Ada\\.local\\bin",
    "C:\\Users\\Ada\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin",
    "C:\\Users\\Ada\\AppData\\Roaming\\npm",
    "C:\\Program Files\\nodejs",
    "C:\\Users\\Ada\\AppData\\Local\\pnpm",
    "C:\\Users\\Ada\\AppData\\Local\\Volta\\bin",
    "C:\\Users\\Ada\\.bun\\bin",
    "C:\\Users\\Ada\\scoop\\shims",
  ]);
});
test("on Windows only a PATHEXT name is a CLI: npm's sh launcher and PowerShell shim beside it are skipped", async () => {
  const dir = path.join(root, "pathext");
  await mkdir(dir, { recursive: true });
  for (const name of ["codex", "codex.ps1", "codex.cmd"]) await writeFile(path.join(dir, name), "", { mode: 0o755 });
  const found = await discoverCodingCli("codex", { ...options, loginPath: dir, platform: "win32" });
  assert.equal(found.status.path, path.join(dir, "codex.cmd"));
  const posix = await discoverCodingCli("codex", { ...options, loginPath: dir, platform: "darwin" });
  assert.equal(posix.status.path, WINDOWS ? undefined : path.join(dir, "codex"));
});
test("the binary resolver names each coding CLI's executable and refuses any other engine", () => {
  assert.equal(codingCliBinary("codex"), "codex");
  assert.equal(codingCliBinary("claude-code"), "claude");
  for (const other of ["ollama", "bonsai", "constructor", "", "claude"]) assert.throws(() => codingCliBinary(other));
});
test("display versions drop product names", () => {
  assert.equal(cliVersion("2.1.280 (Claude Code)"), "2.1.280");
  assert.equal(cliVersion("codex-cli 0.155.1"), "0.155.1");
  assert.equal(cliVersion("codex-cli 0.2.0-alpha.3"), "0.2.0-alpha.3");
  assert.equal(cliVersion("fixture-1"), "fixture-1");
  assert.equal(cliVersion(undefined), undefined);
});
/** `opencode run --help`'s options: 1.18's, and 2.x's (which has no `--pure`, `--variant` or `--dir`). */
const OPENCODE_V1_FLAGS = "--format --session --model --agent --file --variant --pure --dir";
const OPENCODE_V2_FLAGS =
  "--standalone --server --continue --session --fork --model --agent --format --file --title --thinking --auto";
/** A fixture `opencode` answering `--version` with `version` and `run --help` with `flags`. */
async function openCodeCli(relative: string, version: string, flags: string): Promise<string> {
  const file = path.join(root, exe(relative));
  await launcher(
    file,
    `#!/bin/sh\ncase "$1" in\n --version) echo '${version}';;\n *) echo '${flags}';;\nesac\n`,
    `console.log(process.argv[2] === "--version" ? ${JSON.stringify(version)} : ${JSON.stringify(flags)});\n`,
  );
  await chmod(file, 0o755);
  return file;
}
test("OpenCode runs as 1.18 or as 2.x from 2.0.20; a version it cannot place is refused with what to do", async () => {
  const rows: Array<[version: string, flags: string, state: string, detail: RegExp | null]> = [
    ["1.18.35", OPENCODE_V1_FLAGS, "ready", null],
    ["opencode v2.0.20", OPENCODE_V2_FLAGS, "ready", null],
    ["opencode v2.0.26", OPENCODE_V2_FLAGS, "ready", null],
    ["opencode v2.4.1", OPENCODE_V2_FLAGS, "ready", null],
    ["opencode v2.0.19", OPENCODE_V2_FLAGS, "incompatible", /2\.0\.20/],
    ["0.15.3", OPENCODE_V1_FLAGS, "incompatible", /[Uu]pdate OpenCode/],
    ["opencode v3.0.0", OPENCODE_V2_FLAGS, "incompatible", /OpenCode 3/],
    ["opencode nightly", OPENCODE_V2_FLAGS, "incompatible", /version/],
    ["1.17.2", "--format --session --model --agent --file --dir", "incompatible", /--variant, --pure/],
    ["1.18.35", OPENCODE_V2_FLAGS, "incompatible", /--pure/],
    ["opencode v2.0.26", OPENCODE_V1_FLAGS, "incompatible", /--standalone/],
  ];
  for (const [index, [version, flags, state, detail]] of rows.entries()) {
    const binary = await openCodeCli(`opencode-gate/${index}/opencode`, version, flags);
    const found = await discoverCodingCli("opencode", { ...options, override: binary });
    assert.equal(found.status.state, state, version);
    if (detail) assert.match(found.status.detail, detail, version);
  }
});
test("an installation that cannot run yields to a working one further along the search; a manual choice never does", async () => {
  const outdated = await openCodeCli("search-old/opencode", "opencode v2.0.5", OPENCODE_V2_FLAGS);
  const working = await openCodeCli("search-ok/opencode", "1.18.35", OPENCODE_V1_FLAGS);
  const search = { ...options, loginPath: path.dirname(outdated), standardDirs: [path.dirname(working)] };
  const found = await discoverCodingCli("opencode", search);
  assert.equal(found.status.state, "ready");
  assert.equal(found.status.path, working);
  const onlyBroken = await discoverCodingCli("opencode", { ...options, loginPath: path.dirname(outdated) });
  assert.equal(onlyBroken.status.state, "incompatible", "with nothing better, the first one found explains why");
  assert.equal(onlyBroken.status.path, outdated);
  const manual = await discoverCodingCli("opencode", { ...search, override: outdated });
  assert.equal(manual.status.state, "incompatible");
  assert.equal(manual.status.path, outdated);
});
test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

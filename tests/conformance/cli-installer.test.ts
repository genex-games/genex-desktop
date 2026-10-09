import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  installCodingCli,
  installerCommand,
  installerSource,
  type InstallerRun,
} from "../../src/substrate/cli-installer.ts";
import { CliInstallProblem } from "../../src/shared/cli-install.ts";
import type { CodingProvider } from "../../src/shared/coding-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" && "runs its scripts with /bin/sh and /bin/bash";

// What the app's own environment can carry: keys, and either vendor's login home.
const PARENT = {
  HOME: "/Users/ada",
  PATH: "/usr/bin:/bin",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  CLAUDE_CONFIG_DIR: "/Users/ada/.claude-elsewhere",
  CODEX_HOME: "/Users/ada/.codex-elsewhere",
};

/** A fetch that answers every request with `body`, as if served from `url` (the request's own by default). */
function serving(body: string, init: { status?: number; url?: string } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const response = new Response(body, { status: init.status ?? 200 });
    Object.defineProperty(response, "url", { value: init.url ?? String(input) });
    return response;
  }) as typeof fetch;
}

const neverRuns: InstallerRun = async () => {
  throw new Error("the installer must not run");
};

test("each CLI's installer is its vendor's own script: shell on macOS and Linux, PowerShell on Windows", () => {
  const expected: Record<CodingProvider, [string, string | null]> = {
    "claude-code": ["https://claude.ai/install.sh", "https://claude.ai/install.ps1"],
    codex: ["https://chatgpt.com/codex/install.sh", "https://chatgpt.com/codex/install.ps1"],
    // OpenCode publishes no PowerShell installer: Windows has none to fetch.
    opencode: ["https://opencode.ai/install", null],
  };
  for (const [provider, [unix, windows]] of Object.entries(expected) as [CodingProvider, [string, string | null]][]) {
    for (const platform of ["darwin", "linux"] as const)
      assert.deepEqual(installerSource(provider, platform), { url: unix, extension: ".sh" }, `${provider} ${platform}`);
    assert.deepEqual(installerSource(provider, "win32"), windows && { url: windows, extension: ".ps1" }, provider);
  }
  assert.throws(() => installerSource("gemini" as CodingProvider, "darwin"), /unknown coding CLI/);
  assert.throws(() => installerSource("__proto__" as CodingProvider, "darwin"), /unknown coding CLI/);
});

test("a CLI with no installer for this system fails before anything is fetched or run", async () => {
  const outcome = await installCodingCli("opencode", {
    platform: "win32",
    fetch: (async () => {
      throw new Error("nothing is fetched");
    }) as typeof fetch,
    run: neverRuns,
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.problem, "download");
});

test("an installer runs from its saved file under the shell it was written for, never through a command line", () => {
  assert.deepEqual(installerCommand("claude-code", "darwin", "/tmp/i/install.sh", {}), {
    file: "/bin/bash",
    args: ["/tmp/i/install.sh"],
  });
  assert.deepEqual(installerCommand("codex", "linux", "/tmp/i/install.sh", {}), {
    file: "/bin/sh",
    args: ["/tmp/i/install.sh"],
  });
  assert.deepEqual(installerCommand("codex", "win32", "C:\\T\\install.ps1", { SystemRoot: "D:\\Win" }), {
    file: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\T\\install.ps1"],
  });
  assert.equal(
    installerCommand("claude-code", "win32", "C:\\T\\install.ps1", {}).file,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
});

test("an installer that cannot be fetched whole over HTTPS is never run and leaves nothing behind", async () => {
  const hostile: [string, typeof fetch][] = [
    ["not found", serving("echo hi", { status: 404 })],
    ["server error", serving("echo hi", { status: 500 })],
    [
      "offline",
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    ],
    ["redirected off HTTPS", serving("echo hi", { url: "http://claude.ai/install.sh" })],
    ["empty", serving("")],
    ["oversized", serving(`#!/bin/sh\n${"#".repeat(1024 * 1024)}`)],
  ];
  for (const [name, fetch] of hostile) {
    const tmpRoot = await tmpDir("cli-installer-");
    const outcome = await installCodingCli("claude-code", {
      platform: "darwin",
      env: PARENT,
      fetch,
      tmpRoot,
      run: neverRuns,
    });
    assert.deepEqual(
      { ok: outcome.ok, problem: !outcome.ok && outcome.problem },
      { ok: false, problem: CliInstallProblem.Download },
      name,
    );
    assert.deepEqual(readdirSync(tmpRoot), [], `${name}: nothing left behind`);
  }
});

test("a fetched installer runs as the person with its own switches, and without keys or the other vendor's home", {
  skip: POSIX_ONLY,
}, async () => {
  for (const provider of ["claude-code", "codex"] as const) {
    const tmpRoot = await tmpDir("cli-installer-");
    const report = path.join(await tmpDir("cli-installer-out-"), "env.txt");
    const fetch = serving(`#!/bin/sh\nenv > "${report}"\n`);
    const outcome = await installCodingCli(provider, { platform: process.platform, env: PARENT, fetch, tmpRoot });
    assert.deepEqual(outcome, { ok: true }, provider);
    const seen = Object.fromEntries(
      readFileSync(report, "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.equal(seen.HOME, PARENT.HOME, provider);
    assert.equal(seen.ANTHROPIC_API_KEY, undefined, provider);
    assert.equal(seen.OPENAI_API_KEY, undefined, provider);
    if (provider === "codex") {
      assert.equal(seen.CODEX_NON_INTERACTIVE, "1", "Codex's installer asks nothing");
      assert.equal(seen.CODEX_HOME, PARENT.CODEX_HOME, "Codex installs into the home the app runs it with");
      assert.equal(seen.CLAUDE_CONFIG_DIR, undefined);
    } else {
      assert.equal(seen.CLAUDE_CONFIG_DIR, PARENT.CLAUDE_CONFIG_DIR);
      assert.equal(seen.CODEX_HOME, undefined);
    }
    assert.deepEqual(readdirSync(tmpRoot), [], `${provider}: the saved installer is removed`);
  }
});

test("an installer that fails or hangs is reported with its last words, and a hung one is stopped", {
  skip: POSIX_ONLY,
}, async () => {
  const tmpRoot = await tmpDir("cli-installer-");
  const failed = await installCodingCli("codex", {
    platform: process.platform,
    env: PARENT,
    fetch: serving("#!/bin/sh\necho 'no space left' >&2\nexit 7\n"),
    tmpRoot,
  });
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.problem, CliInstallProblem.Installer);
  assert.match(!failed.ok ? failed.detail : "", /no space left/);

  const started = Date.now();
  const marker = path.join(await tmpDir("cli-installer-out-"), "finished");
  const hung = await installCodingCli("codex", {
    platform: process.platform,
    env: PARENT,
    fetch: serving(`#!/bin/sh\nsleep 30\ntouch "${marker}"\n`),
    tmpRoot,
    timeoutMs: 300,
  });
  assert.equal(!hung.ok && hung.problem, CliInstallProblem.TimedOut);
  assert.ok(Date.now() - started < 10_000, "the hung installer was not waited on");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readdirSync(tmpRoot), []);
});

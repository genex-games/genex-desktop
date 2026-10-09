import { cliName, fixtureCodingCli, wasStopped, writeCliLauncher } from "../helpers/external-cli.ts";
/**
 * Sign-in on a fresh Mac (M2.8), and what the judge costs to run (M3.10).
 *
 * The app ships the `claude` binary and then asked the user to install Claude Code: the login
 * helper only looked in Homebrew-ish directories, so a Mac that had never installed it reached
 * "Claude Code isn't installed on this Mac" with a link to a developer website — and the
 * sentence the user had typed still sitting in the composer. These tests hold the two halves of
 * the fix: the bundled binary is found first everywhere, and the sign-in it drives happens in
 * the app, with a Terminal window only for a CLI that cannot be driven from a pipe.
 *
 * The second half of the file is the judge's bill: every verdict is a one-shot CLI session, and a
 * session in a directory of its own leaves a transcript directory behind and re-uploads the same
 * rubric each call. The judge must also be the model the roles name, never a preference an older
 * build saved.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  ClaudeCodeEngine,
  claudeLaunchOptions,
  JUDGE_CWD,
  JUDGE_TRANSCRIPT_TTL_MS,
  claudeJudgeContent,
  sweepJudgeTranscripts,
} from "../../src/substrate/engines/claude-code.ts";
import {
  migrateStoredRoles,
  packStoredRoles,
  storedRolesKey,
  withAvailableEngines,
} from "../../src/renderer/stored-roles.ts";
import { resolveRoles, roleName } from "../../src/shared/model-roles.ts";
import { runStartWords } from "../../src/renderer/words.ts";
import { openingRoles, readStoredRoles, storeRoles } from "../../src/renderer/role-store.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import {
  ClaudeLoginController,
  MISSING_CLAUDE_CLI,
  allowedClaudeLoginUrl,
  type ClaudeTerminalOptions,
} from "../../src/main/claude-login.ts";
import {
  claudeAuthStatus,
  findClaudeBinary,
  parseAuthStatus,
  type ClaudeLoginStart,
} from "../../src/substrate/engines/claude-cli.ts";
import type { ClaudeLoginState } from "../../src/shared/claude-login.ts";
import { tmpDir } from "../helpers/tmp.ts";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = async (file: string): Promise<string> => readFile(path.join(root, file), "utf8");

/** `localStorage`'s three verbs over a map, counting what is written. */
function memoryStorage() {
  const items = new Map<string, string>();
  const storage = {
    writes: 0,
    getItem: (key: string): string | null => items.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.writes += 1;
      items.set(key, value);
    },
    removeItem: (key: string): void => void items.delete(key),
  };
  return storage;
}

// The engine sweeps the login homes it resolves the moment it is built, and `CLAUDE_CONFIG_DIR`
// is the first of them: a dev shell that has one exported must not hand this file a home it does
// not own. The sign-in cases below pass the config home they mean explicitly.
delete process.env.CLAUDE_CONFIG_DIR;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the sign-in state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The URL the CLI prints; the fake below wraps it in the terminal hyperlink escape it really uses. */
const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c-250a&state=secret-state&code_challenge=hidden";

/** Prints the link the way `claude auth login` does, then waits on stdin for the code. */
const PIPED_LOGIN = `import { writeFileSync } from "node:fs";
const esc = String.fromCharCode(27), bel = String.fromCharCode(7);
const url = ${JSON.stringify(AUTH_URL)};
process.stdout.write("Opening browser to sign in…\\n");
process.stdout.write("If the browser didn't open, visit: " + esc + "]8;;" + url + bel + url + esc + "]8;;" + bel + "\\n");
setTimeout(() => process.stdout.write("Paste code here if prompted > "), 20);
process.stdin.on("data", (chunk) => {
  writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/pasted.txt", String(chunk));
  process.stdout.write("Signed in as someone@example.com\\n");
  process.exit(0);
});`;

async function fixture(
  script: string,
  options: {
    confirms?: boolean | null;
    graceMs?: number;
    terminal?: ClaudeLoginStart;
    binary?: string;
    platform?: NodeJS.Platform;
  } = {},
) {
  const home = await tmpDir("studio-claude-login-");
  const file = path.join(home, "fake-claude.mjs");
  await writeFile(file, script);
  const states: ClaudeLoginState[] = [];
  const opened: string[] = [];
  const children: ChildProcess[] = [];
  const invocations: { binary: string; args: string[]; options: SpawnOptions }[] = [];
  const terminals: { configDir?: string | null; binary: string | null }[] = [];
  const terminalOptions: ClaudeTerminalOptions[] = [];
  let terminalCancelled = 0;
  let connected = 0;
  const controller = new ClaudeLoginController({
    findBinary: async () => options.binary ?? "/bundled/claude",
    spawn: ((command: string, args: string[], opts: SpawnOptions) => {
      invocations.push({ binary: command, args, options: opts });
      const child = spawn(process.execPath, [file], opts);
      children.push(child);
      return child;
    }) as typeof spawn,
    probe: async (dir, probed) => {
      assert.equal(dir, home);
      assert.equal(probed, options.binary ?? "/bundled/claude");
      return { loggedIn: options.confirms === undefined ? true : options.confirms, detail: "cli status" };
    },
    terminal: async (opts) => {
      terminalOptions.push(opts);
      terminals.push({ configDir: opts?.configDir, binary: (await opts?.findBinary?.()) ?? null });
      return {
        ...(options.terminal ?? { started: true }),
        cancel: async () => {
          terminalCancelled++;
        },
      };
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    onState: (state) => states.push(state),
    onConnected: async () => {
      connected++;
    },
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
    platform: options.platform,
  });
  return {
    controller,
    home,
    states,
    opened,
    children,
    invocations,
    terminals,
    terminalOptions,
    terminalCancelled: () => terminalCancelled,
    connected: () => connected,
  };
}

describe("external Claude authentication", () => {
  it("says 'not installed' only when there is genuinely no binary", async () => {
    const missing = await new ClaudeLoginController({
      findBinary: async () => null,
      openExternal: async () => {},
      onState: () => {},
      onConnected: async () => {},
    }).start(null);
    assert.deepEqual(missing, { started: false, missingCli: true, error: MISSING_CLAUDE_CLI });
  });

  it("replaces a sign-in in progress when another login home is asked for", async () => {
    const f = await fixture(PIPED_LOGIN);
    assert.equal((await f.controller.start(f.home)).started, true);
    const other = await tmpDir("studio-claude-other-");
    assert.equal((await f.controller.start(other)).started, true);
    assert.equal(f.invocations.length, 2, "the other account gets its own login process");
    assert.equal(f.invocations[1]!.options.env!.CLAUDE_CONFIG_DIR, other);
    assert.ok(
      f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null,
      "the interrupted sign-in was stopped",
    );
    assert.equal((await f.controller.start(other)).started, true);
    assert.equal(f.invocations.length, 2, "asking for the same home again reuses the sign-in");
    await f.controller.cancel();
  });

  it("asks in JSON, about the home it was given", async () => {
    const home = await tmpDir("studio-claude-status-");
    let asked: string[] = [];
    let askedAbout: string | undefined;
    const answer = await claudeAuthStatus(home, {
      findBinary: async () => "/bundled/claude",
      run: async (_binary, args, options) => {
        asked = args;
        askedAbout = options?.env?.CLAUDE_CONFIG_DIR;
        return { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "a@b.c" }), stderr: "" };
      },
    });
    assert.deepEqual(asked, ["auth", "status", "--json"]);
    assert.equal(askedAbout, home, "the question is about the studio's home, not the shell's");
    assert.deepEqual(answer, { loggedIn: true, detail: "a@b.c" });
    // A CLI old enough to reject the flag has told us nothing — that is not "signed out".
    assert.equal(parseAuthStatus(1, "", "error: unknown option '--json'").loggedIn, null);
    // Nor is a CLI that never answers: the probe's own timeout is "we could not ask" too.
    assert.equal(
      (
        await claudeAuthStatus(home, {
          findBinary: async () => "/bundled/claude",
          run: async () => {
            throw new Error("timed out asking Claude Code whether you are signed in");
          },
        })
      ).loggedIn,
      null,
    );
  });

  it("gets a real answer from the external Claude CLI about an empty studio home", async (t) => {
    // The one case that spawns the external CLI, so it is asked for: eight seconds is its whole
    // budget, and a loaded machine turning that into "we could not ask" is not a finding about
    // the sign-in. What holds on every run is the case above and the presence check below.
    if (process.env.STUDIO_LIVE_CLAUDE_CLI !== "1")
      return t.skip("set STUDIO_LIVE_CLAUDE_CLI=1 to ask the external Claude installation");
    const external = await findClaudeBinary();
    if (!external) return t.skip("external Claude CLI unavailable");
    const home = await tmpDir("studio-claude-status-");
    const status = await claudeAuthStatus(home, { findBinary: async () => external });
    assert.equal(status.loggedIn, false, "'no' about an empty studio home, not 'we could not ask'");
  });
});

describe("the Claude sign-in runs in the app", () => {
  it("signs in through a claude.cmd that is not npm's shim on Windows: cmd.exe by its full path, plain words bare, the rest escaped twice", async () => {
    const binary = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd";
    const f = await fixture(PIPED_LOGIN, { binary, platform: "win32" });
    try {
      assert.deepEqual(await f.controller.start(f.home), { started: true });
      const [started] = f.invocations;
      assert.match(started!.binary, /\\System32\\cmd\.exe$/);
      assert.deepEqual(started!.args, ["/d", "/v:off", "/s", "/c", `""${binary}" auth login"`]);
      assert.equal(started!.options.windowsVerbatimArguments, true);
      assert.equal(started!.options.env?.CLAUDE_CONFIG_DIR, f.home);
    } finally {
      for (const child of f.children) child.kill("SIGKILL");
      await f.controller.cancel().catch(() => {});
    }
  });

  it("reads the link out of the terminal escape, takes the pasted code, and verifies it", async () => {
    const f = await fixture(PIPED_LOGIN);
    try {
      const started = await f.controller.start(f.home);
      assert.deepEqual(started, { started: true });
      assert.equal(f.invocations[0]!.binary, "/bundled/claude");
      assert.deepEqual(f.invocations[0]!.args, ["auth", "login"]);
      assert.equal(f.invocations[0]!.options.env?.CLAUDE_CONFIG_DIR, f.home);
      assert.equal(f.invocations[0]!.options.env?.ANTHROPIC_API_KEY, undefined);
      assert.equal(f.controller.snapshot().hasBrowserUrl, true);
      await f.controller.openBrowser();
      assert.deepEqual(f.opened, [AUTH_URL]);
      // The prompt arrives with no newline after it; a line reader would never see it.
      await until(() => f.controller.snapshot().phase === "code");
      await assert.rejects(() => f.controller.submitCode("code\nrm -rf /"), /doesn't look like the code/);
      await f.controller.submitCode(" A1b2c3-d4#state ");
      await until(() => f.controller.snapshot().phase === "connected");
      assert.equal(await readFile(path.join(f.home, "pasted.txt"), "utf8"), "A1b2c3-d4#state\n");
      // The answered prompt is forgotten, so the CLI's parting line is not read as a second ask.
      const afterCode = f.states.slice(f.states.findIndex((state) => state.phase === "verifying"));
      assert.deepEqual(
        afterCode.map((state) => state.phase),
        ["verifying", "connected"],
      );
      assert.equal(f.connected(), 1);
      assert.equal(f.terminals.length, 0);
      // The authorize URL carries the PKCE challenge and the session state: main keeps it.
      assert.doesNotMatch(JSON.stringify(f.states), /secret-state|code_challenge|claude\.com/);
    } finally {
      await f.controller.cancel();
    }
  });

  it("does not call an unconfirmed sign-in connected", async () => {
    // `null` is the CLI saying it could not answer — which is not a sign-in.
    const f = await fixture(PIPED_LOGIN, { confirms: null });
    try {
      await f.controller.start(f.home);
      await until(() => f.controller.snapshot().phase === "code");
      await f.controller.submitCode("A1b2c3d4");
      await until(() => f.controller.snapshot().phase === "failed");
      assert.match(f.controller.snapshot().error!, /couldn't confirm/i);
      assert.equal(f.connected(), 0);
    } finally {
      await f.controller.cancel();
    }
  });

  it("asks again when the CLI refuses the code, instead of waiting on a prompt it already answered", async () => {
    const f = await fixture(`let tries = 0;
const url = ${JSON.stringify(AUTH_URL)};
process.stdout.write("If the browser didn't open, visit: " + url + "\\nPaste code here if prompted > ");
process.stdin.on("data", () => {
  if (++tries === 1) process.stdout.write("That code didn't work.\\nPaste code here if prompted > ");
  else process.exit(0);
});`);
    try {
      await f.controller.start(f.home);
      await until(() => f.controller.snapshot().phase === "code");
      await f.controller.submitCode("wrongcode");
      assert.equal(f.controller.snapshot().phase, "verifying");
      await until(() => f.controller.snapshot().phase === "code");
      await f.controller.submitCode("rightcode");
      await until(() => f.controller.snapshot().phase === "connected");
    } finally {
      await f.controller.cancel();
    }
  });

  it("hands a CLI it cannot drive to Terminal with the same binary — never to a 'not installed' card", async () => {
    const f = await fixture(
      `process.stderr.write("Raw mode is not supported on the current process.stdin\\n"); setInterval(() => {}, 1000);`,
      { graceMs: 100 },
    );
    try {
      const started = await f.controller.start(f.home);
      assert.deepEqual(started, { started: true });
      assert.equal(started.missingCli, undefined);
      assert.deepEqual(f.terminals, [{ configDir: f.home, binary: "/bundled/claude" }]);
      assert.equal(f.controller.snapshot().phase, "terminal");
      // The pipe attempt is not left running behind the Terminal window.
      assert.ok(wasStopped(f.children[0]!), "the CLI was stopped");
    } finally {
      await f.controller.cancel();
    }
  });

  it("hands over just as readily when the CLI says nothing at all and exits", async () => {
    const f = await fixture("process.exit(1)", { graceMs: 30_000 });
    const started = await f.controller.start(f.home);
    assert.deepEqual(started, { started: true });
    assert.equal(f.terminals.length, 1);
    assert.equal(f.controller.snapshot().phase, "terminal");
  });

  it("keeps untrusted links out of the browser it opens", () => {
    assert.equal(allowedClaudeLoginUrl("https://claude.com.evil.test/cai/oauth"), null);
    assert.equal(allowedClaudeLoginUrl("http://claude.com/cai/oauth"), null);
    assert.equal(allowedClaudeLoginUrl("https://user:pass@claude.com/cai/oauth"), null);
    assert.equal(allowedClaudeLoginUrl(AUTH_URL), AUTH_URL);
  });

  it("verifies the embedded PTY exit against the selected credential home", async () => {
    const f = await fixture("process.exit(1)");
    try {
      await f.controller.start(f.home);
      assert.equal(f.terminalOptions[0]!.env.CLAUDE_CONFIG_DIR, f.home);
      assert.equal(f.terminalOptions[0]!.env.ANTHROPIC_API_KEY, undefined);
      f.terminalOptions[0]!.onUrl(AUTH_URL);
      await f.controller.openBrowser();
      assert.equal(f.opened.at(-1), AUTH_URL);
      assert.doesNotMatch(JSON.stringify(f.states), /secret-state|code_challenge/);
      f.terminalOptions[0]!.onExit(0);
      await until(() => f.controller.snapshot().phase === "connected");
      assert.equal(f.connected(), 1);
    } finally {
      await f.controller.cancel();
    }
  });

  it("cancels the embedded PTY and ignores a late success", async () => {
    const f = await fixture("process.exit(1)");
    await f.controller.start(f.home);
    await f.controller.start(f.home);
    assert.equal(f.terminals.length, 1, "an active PTY sign-in is not restarted");
    await f.controller.cancel();
    assert.equal(f.terminalCancelled(), 1);
    f.terminalOptions[0]!.onExit(0);
    assert.equal(f.controller.snapshot().phase, "cancelled");
    assert.equal(f.connected(), 0);
  });

  it("does not trust a zero PTY exit without a confirmed account", async () => {
    const f = await fixture("process.exit(1)", { confirms: false });
    await f.controller.start(f.home);
    f.terminalOptions[0]!.onExit(0);
    await until(() => f.controller.snapshot().phase === "failed");
    assert.equal(f.connected(), 0);
  });
});

describe("the SDK starts the selected Claude on every platform", () => {
  it("hands a native binary to the SDK as it is, and an npm claude.cmd a spawner through cmd.exe", () => {
    const native = claudeLaunchOptions("C:\\Users\\Ada\\.local\\bin\\claude.exe", "win32");
    assert.deepEqual(native, {
      pathToClaudeCodeExecutable: "C:\\Users\\Ada\\.local\\bin\\claude.exe",
      executable: "node",
    });
    assert.equal(claudeLaunchOptions("/opt/homebrew/bin/claude", "darwin").spawnClaudeCodeProcess, undefined);
    const shim = claudeLaunchOptions("C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd", "win32");
    assert.equal(typeof shim.spawnClaudeCodeProcess, "function");
  });

  it("starts a real claude.cmd through its spawner with the SDK's arguments", {
    skip: process.platform !== "win32" && "Windows cmd.exe only",
  }, async () => {
    const root = await tmpDir("claude-cmd-");
    const shim = path.join(root, "npm", cliName("claude"));
    await writeCliLauncher(shim, "", "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const spawner = claudeLaunchOptions(shim).spawnClaudeCodeProcess;
    assert.ok(spawner);
    const child = spawner({
      command: shim,
      args: ["--output-format", "stream-json", "--settings", '{"a":"b c"}'],
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), ["--output-format", "stream-json", "--settings", '{"a":"b c"}']);
  });
});

describe("the app is wired to its own binary", () => {
  // The sign-in controllers' wiring (the executable the SDK spawns, both sign-in paths through the
  // controller) is driven through the IPC registrar in tests/conformance/main-ipc.test.ts.
  it("asks the resolved binary, with its environment, whether the studio's home is signed in", async () => {
    // Builds and judges hand the SDK the same path (engine-delegated.test.ts); this is the probe.
    const root = await tmpDir("studio-claude-probe-");
    const home = path.join(root, "claude-home"),
      seen = path.join(root, "seen.txt"),
      binary = path.join(root, "external", cliName("claude"));
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const answer = '{"loggedIn":true,"email":"fixture@example.invalid"}';
    await writeCliLauncher(
      binary,
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$CLAUDE_CONFIG_DIR" "$STUDIO_CLI_MARK" > "${seen}"\necho '${answer}'\n`,
      `const e = process.env;\nrequire("fs").writeFileSync(${JSON.stringify(seen)}, \`\${process.argv.slice(2).join(" ")}|\${e.CLAUDE_CONFIG_DIR}|\${e.STUDIO_CLI_MARK}\\n\`);\nconsole.log(${JSON.stringify(answer)});\n`,
    );
    const resolveCli: typeof fixtureCodingCli = async (provider) => {
      const fixture = await fixtureCodingCli(provider);
      return {
        ...fixture,
        path: binary,
        env: { PATH: "/usr/bin:/bin", STUDIO_CLI_MARK: "installation-env" },
        status: { ...fixture.status, path: binary },
      };
    };
    const engine = new ClaudeCodeEngine({
      resolveCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
    });
    assert.equal((await engine.probeAuth()).code, "ready");
    assert.equal(await readFile(seen, "utf8"), `auth status --json|${home}|installation-env\n`);
  });

  // A missing CLI now installs in place (`useCliInstall`, tested in cli-install-*.test.ts).
  it("the card can answer the CLI's code prompt", async () => {
    const card = await read("src/renderer/ui/SignInCard.tsx");
    assert.match(card, /claudeLoginCode\(code\)/, "the card can answer the CLI's code prompt");
  });
});

describe("what a run of judging leaves behind", () => {
  /** A `projects/` tree the way Claude Code writes one: a directory per working directory. */
  async function seedHome(): Promise<string> {
    const home = await tmpDir("studio-judge-home-");
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    const write = async (dir: string, file: string, ageMs: number) => {
      await mkdir(path.join(home, "projects", dir), { recursive: true });
      const full = path.join(home, "projects", dir, file);
      await writeFile(full, "{}\n");
      const at = new Date(Date.now() - ageMs);
      await utimes(full, at, at);
    };
    // The mkdtemp era: one directory per verdict, all of them from last month.
    await write("-private-var-folders-T-studio-judge-03aWRw", "a1.jsonl", 30 * 24 * 60 * 60_000);
    await write("-private-var-folders-T-studio-judge-06gFTw", "b2.jsonl", 30 * 24 * 60 * 60_000);
    // This run's verdicts, in the one stable directory: the old transcript goes, the new stays.
    await write("-private-var-folders-T-studio-judge-sessions", "old.jsonl", 30 * 24 * 60 * 60_000);
    await write("-private-var-folders-T-studio-judge-sessions", "this-run.jsonl", 60_000);
    // A game the user actually built in, older than any of it: never ours to delete.
    await write("-Users-me-ai-games-wreckage", "session.jsonl", 90 * 24 * 60 * 60_000);
    assert.ok(old < Date.now());
    return home;
  }

  it("sweeps a week-old judge transcript and nothing else", async () => {
    const home = await seedHome();
    const removed = await sweepJudgeTranscripts(home);
    const left = (await readdir(path.join(home, "projects"))).sort();
    assert.deepEqual(left, ["-Users-me-ai-games-wreckage", "-private-var-folders-T-studio-judge-sessions"]);
    assert.deepEqual(await readdir(path.join(home, "projects", "-private-var-folders-T-studio-judge-sessions")), [
      "this-run.jsonl",
    ]);
    assert.deepEqual(await readdir(path.join(home, "projects", "-Users-me-ai-games-wreckage")), ["session.jsonl"]);
    assert.equal(
      removed.filter((entry) => entry.includes("wreckage")).length,
      0,
      "a game's own transcripts are not housekeeping",
    );
    // A week is the window, so last run's verdicts are still there to read in the morning.
    assert.ok(JUDGE_TRANSCRIPT_TTL_MS >= 7 * 24 * 60 * 60_000);
    const second = await sweepJudgeTranscripts(home);
    assert.deepEqual(second, [], "nothing left to sweep, and no second pass at what stayed");
  });

  it("keeps everything when nothing is stale, and shrugs at a home that has none", async () => {
    const home = await seedHome();
    await sweepJudgeTranscripts(home, { now: Date.now() - 60 * 24 * 60 * 60_000 });
    assert.equal((await readdir(path.join(home, "projects"))).length, 4);
    assert.deepEqual(await sweepJudgeTranscripts(path.join(home, "nowhere")), []);
  });

  it("runs every verdict in one stable folder, so the CLI's own prefix is the same each time", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fn = ((params: { prompt: string; options?: Record<string, unknown> }) => {
      seen.push({ ...params.options });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "assistant", message: { content: [{ type: "text", text: '{"answer":"yes"}' }] } };
          yield { type: "result", subtype: "success", is_error: false, result: '{"answer":"yes"}', usage: {} };
        },
      };
    }) as never;
    const root = await tmpDir("studio-judge-engine-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const judgeCwd = path.join(root, "judge");
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "none"),
      queryFn: fn,
      judgeCwd,
      sweepOnBoot: true,
    });
    // The engine sweeps its own home when it is built — that is the boot pass.
    assert.deepEqual(await engine.swept, []);
    for (const question of ["is the sky lit?", "is the road there?"]) {
      await engine.complete({ systemPrompt: "JSON only.", messages: [{ role: "user", content: question }] });
    }
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.cwd, seen[1]!.cwd, "a fresh folder per verdict was a guaranteed cache miss");
    // The folder this run owns, not the machine-global one a live run's judge is sitting in.
    assert.equal(seen[0]!.cwd, judgeCwd);
    assert.match(JUDGE_CWD, /studio-judge-sessions$/);
    // Still a blind one-shot: the folder is shared, the session never is.
    assert.equal(seen[0]!.maxTurns, 1);
    assert.deepEqual(seen[0]!.allowedTools, []);
    assert.equal(seen[0]!.resume, undefined);
  });

  it("puts the frozen rubric first and the pictures last", () => {
    const parts = claudeJudgeContent({
      systemPrompt: "RUBRIC: answer from the pixels only.",
      messages: [
        {
          role: "user",
          content: "QUESTIONS: is the sky lit?",
          images: [
            { mimeType: "image/jpeg", data: "aaa", label: "IMAGE 1" },
            { mimeType: "image/jpeg", data: "bbb", label: "IMAGE 2" },
          ],
        },
      ],
    } as never);
    assert.deepEqual(
      parts.map((part) => part.type),
      ["text", "image", "image"],
    );
    const text = (parts[0] as { text: string }).text;
    assert.ok(
      text.startsWith("RUBRIC: answer from the pixels only."),
      "the unchanging half is the prefix a cache can hit",
    );
    assert.match(text, /QUESTIONS: is the sky lit\?$/);
  });
});

describe("which model judges the run", () => {
  it("drops a roles record an older build wrote, and keeps its own", () => {
    // What this install actually had: three slots filled with the orchestrator's model by a
    // build whose preset table said one pick meant one model everywhere.
    assert.equal(
      migrateStoredRoles(
        JSON.stringify({ planner: "claude-fable-5-1", builder: "claude-fable-5-1", judge: "claude-fable-5-1" }),
      ),
      null,
    );
    assert.equal(migrateStoredRoles(null), null);
    assert.equal(migrateStoredRoles("not json"), null);
    assert.equal(migrateStoredRoles(JSON.stringify({ v: 1, roles: { judge: "claude-fable-5-1" } })), null);
    const mine = { planner: "claude-fable-5-1", builder: "opus", judge: "sonnet" };
    assert.deepEqual(migrateStoredRoles(packStoredRoles(mine)), mine, "a pick made on this build survives");
    assert.equal(storedRolesKey("claude-code"), "studio.roles.claude-code");
    // And what the migration falls back to is the table's own answer, never the planner's model.
    assert.equal(resolveRoles("claude-code", "claude-fable-5-1").judge, "claude-fable-5-1");
  });

  it("is read through the migration by the composer, and stamped back once", () => {
    const storage = memoryStorage();
    const key = storedRolesKey("claude-code");
    // The record the stale judge came from: a bare triple an older build saved.
    storage.setItem(
      key,
      JSON.stringify({ planner: "claude-fable-5-1", builder: "claude-fable-5-1", judge: "claude-fable-5-1" }),
    );
    const opened = openingRoles(storage, "claude-code", "claude-fable-5-1");
    assert.equal(opened.judge, "claude-fable-5-1", "the composer no longer trusts a bare record");
    assert.deepEqual(migrateStoredRoles(storage.getItem(key)), opened, "the preset is stamped back at this version");
    // Once: the stamped record is what the next open reads, and nothing is written again.
    const writes = storage.writes;
    assert.deepEqual(
      openingRoles(storage, "claude-code", "opus"),
      opened,
      "a record this build wrote wins over the picked preset",
    );
    assert.equal(storage.writes, writes);
    // A record this build wrote is kept as picked.
    const mine = { planner: "claude-fable-5-1", builder: "opus", judge: "sonnet" };
    storeRoles(storage, "claude-code", mine);
    assert.deepEqual(readStoredRoles(storage, "claude-code"), mine);
    storeRoles(storage, "claude-code", null);
    assert.equal(storage.getItem(key), null);
    // A storage that refuses to be read is a storage with nothing in it.
    const locked = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    assert.equal(readStoredRoles(locked, "claude-code"), null);
  });

  it("names the judge in run activity details, and says nothing when there is nothing to name", async () => {
    const named = runStartWords({ name: "Dirt 5", kind: "direction" }, "Opus");
    assert.match(named, /Opus, reviewing without being told which build is which, picks the winner/);
    assert.match(named, /Dirt 5/);
    // "default" is the engine's own choice, which is not a name anybody can act on.
    for (const nothing of [null, "", "default", "same"]) {
      assert.match(runStartWords(null, nothing), /a reviewer that cannot see which is which picks the winner/);
    }
    // …by the judges' own engine's name for it, and with that engine named when the judges are
    // on the other subscription (cross-provider roles).
    // Both runs say who judged: the lead's own run_started carries it too, and on which engine.
    // director-cross-engine.test.ts proves it on a real run (a rig, L3); this keeps an L1 gate
    // until the payload has a pure builder, which is a seed change of its own.
    // The run's run_started is written where the run is prepared (director/setup.ts).
    const director = await read("src/harness-seed/loop/director/setup.ts");
    assert.match(director, /event_type: RunEvent\.RunStarted[\s\S]{0,400}judgeModel/);
    assert.match(director, /event_type: RunEvent\.RunStarted[\s\S]{0,600}judgeEngine: run\.judgeEngine/);
    const started = (payload: Record<string, unknown>): string => {
      const entries = toEntries([
        {
          id: "e1",
          thread_id: "t",
          session_id: null,
          turn_id: null,
          created_at: "2026-09-08T02:00:00.000Z",
          data: {
            type: "custom",
            event_type: "run_started",
            payload: { runId: "run_x", reference: { name: "Dirt 5", kind: "direction" }, ...payload },
          },
        },
      ]);
      // A routine line is folded into an activity row; either way it is the RUN line.
      const lines = entries.flatMap((entry) =>
        entry.kind === "activity" ? entry.rows : entry.kind === "system" ? [entry] : [],
      );
      const line = lines.find((row) => row.tag === "RUN");
      assert.ok(line, "run_started reads as the run's opening line");
      return line.text;
    };
    assert.equal(
      started({ engine: "claude-code", judgeModel: "opus" }),
      runStartWords({ name: "Dirt 5", kind: "direction" }, roleName("claude-code", "opus")),
    );
    assert.match(
      started({ engine: "claude-code", roles: { judge: "opus" } }),
      new RegExp(`${roleName("claude-code", "opus")}, reviewing`),
      "an older run's roles still name its judge",
    );
    assert.match(
      started({ engine: "claude-code", judgeEngine: "codex", judgeModel: "gpt-6-astra" }),
      /GPT-6-astra on Codex, reviewing/i,
    );
    assert.match(
      started({ engine: "claude-code", judgeEngine: "ollama", judgeModel: "qwen2.5vl" }),
      /qwen2\.5vl on Ollama, reviewing/,
      "a local reviewer's engine is named as a person says it",
    );
    assert.match(started({ engine: "claude-code" }), /a reviewer that cannot see which is which picks the winner/);
  });

  it("a remembered pick on a subscription that is not signed in falls back to this engine's default for that job", () => {
    const crossed = {
      planner: "claude-fable-5-1",
      builder: "gpt-6-astra",
      judge: "gpt-6-astra",
      engines: { builder: "codex", judge: "codex" },
    };
    assert.deepEqual(withAvailableEngines(crossed, ["codex"]), crossed, "signed in: kept as picked");
    assert.deepEqual(
      withAvailableEngines(crossed, []),
      { planner: "claude-fable-5-1", builder: undefined, judge: undefined },
      "signed out: the Codex models go with the engine",
    );
    const half = { planner: "claude-fable-5-1", builder: "gpt-6-astra", judge: "opus", engines: { builder: "codex" } };
    assert.deepEqual(withAvailableEngines(half, []), {
      planner: "claude-fable-5-1",
      builder: undefined,
      judge: "opus",
    });
    const plain = { planner: "claude-fable-5-1", builder: "opus", judge: "opus" };
    assert.equal(withAvailableEngines(plain, []), plain, "nothing crossed: the same record back");
    // A crossed record survives the store as written.
    assert.deepEqual(migrateStoredRoles(packStoredRoles(crossed)), crossed);
  });
});

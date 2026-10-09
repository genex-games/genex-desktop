import { fixtureCodingCli, wasStopped } from "../helpers/external-cli.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CodexLoginController, allowedLoginUrl, sanitizeLoginLine } from "../../src/main/codex-login.ts";
import { codexAuthStatus, codexSubscriptionEnv, parseCodexAuthStatus } from "../../src/substrate/engines/codex-cli.ts";
import { CodexEngine } from "../../src/substrate/engines/codex.ts";
import type { CodexLoginState } from "../../src/shared/codex-login.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for login state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(
  script: string,
  options: { method?: "chatgpt" | "api_key"; timeoutMs?: number; binary?: string; platform?: NodeJS.Platform } = {},
) {
  const binary = options.binary ?? "/bundled/codex";
  const home = await tmpDir("studio-login-");
  const file = path.join(home, "fake-cli.mjs");
  await writeFile(file, script);
  const states: CodexLoginState[] = [];
  const opened: string[] = [];
  const children: ChildProcess[] = [];
  const invocations: { binary: string; args: string[]; options: SpawnOptions }[] = [];
  let verified = 0;
  const controller = new CodexLoginController({
    findBinary: async () => binary,
    spawn: ((command: string, args: string[], opts: SpawnOptions) => {
      invocations.push({ binary: command, args, options: opts });
      // This seam records cmd.exe's launch, then runs Node with different arguments. Node needs
      // its normal quoting even when the recorded cmd.exe invocation deliberately used verbatim.
      const child = spawn(process.execPath, [file], { ...opts, windowsVerbatimArguments: false });
      children.push(child);
      return child;
    }) as typeof spawn,
    probe: async (dir, probed) => {
      assert.equal(dir, home);
      assert.equal(probed, binary);
      verified++;
      return { loggedIn: true, method: options.method ?? "chatgpt", detail: "native status" };
    },
    onState: (state) => states.push(state),
    openExternal: async (url) => {
      opened.push(url);
    },
    onConnected: async () => {},
    timeoutMs: options.timeoutMs,
    platform: options.platform,
  });
  return { controller, home, states, opened, children, invocations, verified: () => verified };
}

describe("native Codex login", () => {
  it("runs the bundled command in an isolated home, handles split output, and verifies the subscription", async () => {
    const f = await fixture(`process.stderr.write('https://auth.openai.com/oauth/');
      setTimeout(() => process.stderr.write('authorize?state=private&code_challenge=hidden\\n'), 20);
      setTimeout(() => process.exit(0), 200);`);
    try {
      await f.controller.start(f.home);
      await until(() => f.controller.snapshot().hasBrowserUrl);
      await f.controller.openBrowser();
      assert.equal(f.opened[0], "https://auth.openai.com/oauth/authorize?state=private&code_challenge=hidden");
      await until(() => f.controller.snapshot().phase === "connected");
      assert.equal(f.verified(), 1);
      assert.equal(f.invocations[0]!.binary, "/bundled/codex");
      assert.deepEqual(f.invocations[0]!.args, [
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        'cli_auth_credentials_store="auto"',
        "login",
      ]);
      assert.equal(f.invocations[0]!.options.env?.CODEX_HOME, f.home);
      assert.equal(f.invocations[0]!.options.cwd, f.home);
      assert.equal(f.invocations[0]!.options.shell, undefined);
      assert.equal(f.invocations[0]!.options.env?.OPENAI_API_KEY, undefined);
      assert.doesNotMatch(JSON.stringify(f.states), /private|code_challenge|hidden/);
      assert.equal(await readFile(path.join(f.home, "studio-login.json"), "utf8"), "{}\n");
      assert.match(await readFile(path.join(f.home, "config.toml"), "utf8"), /forced_login_method = "chatgpt"/);
      await assert.rejects(() => f.controller.openBrowser(), /No active/);
    } finally {
      await f.controller.dismiss();
    }
  });

  it("signs in through a codex.cmd that is not npm's shim on Windows: cmd.exe by its full path, plain words bare, the rest escaped twice", async () => {
    const binary = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd";
    const f = await fixture(
      `console.log('https://auth.openai.com/oauth/authorize?x=1'); setTimeout(() => process.exit(0), 50);`,
      {
        binary,
        platform: "win32",
      },
    );
    try {
      await f.controller.start(f.home);
      await until(() => f.controller.snapshot().phase === "connected");
      const [started] = f.invocations;
      assert.match(started!.binary, /\\System32\\cmd\.exe$/);
      assert.deepEqual(started!.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
      assert.equal(
        started!.args[4],
        `""${binary}" -c ^^^"forced_login_method=\\^^^"chatgpt\\^^^"^^^" -c ^^^"cli_auth_credentials_store=\\^^^"auto\\^^^"^^^" login"`,
      );
      assert.equal(started!.options.windowsVerbatimArguments, true);
      assert.equal(started!.options.shell, undefined);
    } finally {
      await f.controller.dismiss();
    }
  });

  it("shows native device codes and terminates the process on cancel", async () => {
    const f = await fixture(
      `console.log('https://auth.openai.com/codex/device'); console.log('  ABCD-EFGHI'); setInterval(() => {}, 1000);`,
    );
    try {
      await f.controller.start(f.home, "device");
      await until(() => f.controller.snapshot().deviceCode === "ABCD-EFGHI");
      assert.equal(f.invocations[0]!.args.at(-1), "--device-auth");
      await f.controller.cancel();
      assert.equal(f.controller.snapshot().phase, "cancelled");
      assert.equal(f.controller.snapshot().deviceCode, undefined);
      assert.ok(wasStopped(f.children[0]!), "the CLI was stopped");
      assert.equal(f.verified(), 0);
    } finally {
      await f.controller.dismiss();
    }
  });

  it("opens its window only for a device code, a failure, or when asked again, never over a browser sign-in", async () => {
    const browser = await fixture(
      "console.log('https://auth.openai.com/oauth/authorize?state=x'); setTimeout(() => process.exit(0), 100);",
    );
    await browser.controller.start(browser.home);
    await until(() => browser.controller.snapshot().phase === "connected");
    assert.equal(
      browser.states.some((state) => state.visible),
      false,
      "the browser does the sign-in; nothing covers it",
    );

    const failed = await fixture("console.error('Login was rejected'); process.exit(1)");
    await failed.controller.start(failed.home);
    await until(() => failed.controller.snapshot().phase === "failed");
    assert.equal(failed.controller.snapshot().visible, true, "a failure offers Try again and a device code");

    const device = await fixture("console.log('  ABCD-EFGHI'); setInterval(() => {}, 1000);");
    const again = await fixture("setInterval(() => {}, 1000)");
    try {
      await device.controller.start(device.home, "device");
      assert.equal(device.controller.snapshot().visible, true, "the device code has to be read somewhere");
      await again.controller.start(again.home);
      assert.equal(again.controller.snapshot().visible, false);
      await again.controller.start(again.home);
      assert.equal(again.controller.snapshot().visible, true, "pressing Connect again while it waits opens it");
    } finally {
      await device.controller.dismiss();
      await again.controller.dismiss();
    }
  });

  it("does not call a clean exit connected when native status reports API billing", async () => {
    const f = await fixture("process.exit(0)", { method: "api_key" });
    await f.controller.start(f.home);
    await until(() => f.controller.snapshot().phase === "failed");
    assert.match(f.controller.snapshot().error!, /API key/);
    assert.ok(!f.states.some((s) => s.phase === "connected"));
  });

  it("surfaces a native failure without declaring the account connected", async () => {
    const f = await fixture("console.error('Login was rejected'); process.exit(1)");
    await f.controller.start(f.home);
    await until(() => f.controller.snapshot().phase === "failed");
    assert.ok(f.controller.snapshot().lines.includes("Login was rejected"));
    assert.equal(f.verified(), 0);
  });

  it("times out and kills a stalled login", async () => {
    const f = await fixture("setInterval(() => {}, 1000)", { timeoutMs: 100 });
    try {
      await f.controller.start(f.home);
      await until(() => f.controller.snapshot().phase === "failed");
      assert.match(f.controller.snapshot().error!, /timed out/);
      assert.ok(wasStopped(f.children[0]!), "the CLI was stopped");
    } finally {
      await f.controller.dismiss();
    }
  });

  it("coalesces duplicate starts and waits for the old process before restarting", async () => {
    const f = await fixture("setInterval(() => {}, 1000)");
    try {
      await Promise.all([f.controller.start(f.home), f.controller.start(f.home)]);
      assert.equal(f.children.length, 1);
      await f.controller.cancel();
      await f.controller.start(f.home, "device");
      assert.equal(f.children.length, 2);
      assert.ok(wasStopped(f.children[0]!), "the CLI was stopped");
      assert.equal(f.controller.snapshot().phase, "waiting");
    } finally {
      await f.controller.dismiss();
    }
  });

  it("can cancel during runtime discovery without subsequently spawning", async () => {
    let release!: (value: string | null) => void;
    let spawned = false;
    const controller = new CodexLoginController({
      findBinary: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      spawn: (() => {
        spawned = true;
        throw new Error("unexpected spawn");
      }) as typeof spawn,
      onState: () => {},
      openExternal: async () => {},
      onConnected: async () => {},
    });
    const start = controller.start(await tmpDir("studio-cancel-login-"));
    await controller.dismiss();
    release("/bundled/codex");
    await start;
    assert.equal(spawned, false);
    assert.equal(controller.snapshot().visible, false);
  });

  it("does not overwrite existing native configuration", async () => {
    const f = await fixture("process.exit(0)");
    await writeFile(path.join(f.home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    await f.controller.start(f.home);
    await until(() => f.controller.snapshot().phase === "connected");
    assert.equal(await readFile(path.join(f.home, "config.toml"), "utf8"), 'cli_auth_credentials_store = "keyring"\n');
  });

  it("keeps untrusted links and credentials out of UI output", () => {
    assert.equal(allowedLoginUrl("https://auth.openai.com.evil.test/login"), null);
    assert.equal(allowedLoginUrl("file:///tmp/something"), null);
    assert.equal(allowedLoginUrl("https://user:pass@auth.openai.com/login"), null);
    assert.equal(sanitizeLoginLine("\u001b[31mhttps://auth.openai.com/login?state=secret\u001b[0m"), "[sign-in link]");
    assert.doesNotMatch(sanitizeLoginLine("access_token=secret sk-abcdef eyJabc.def.ghi"), /secret|abcdef|eyJabc/);
  });

  it("has a packaged runtime resolver and does not accept ambiguous login output", () => {
    assert.equal(parseCodexAuthStatus(0, "", "").loggedIn, null);
    assert.equal(parseCodexAuthStatus(0, "Logged in with an unsupported identity", "").loggedIn, null);
    assert.equal(parseCodexAuthStatus(1, "Logged in using ChatGPT", "failure").loggedIn, null);
    assert.equal(
      codexSubscriptionEnv({ OPENAI_API_KEY: "key", CODEX_API_KEY: "key", CODEX_ACCESS_TOKEN: "token" }).OPENAI_API_KEY,
      undefined,
    );
  });

  it("asks the same native binary for status with ambient API credentials removed", async () => {
    const status = await codexAuthStatus("/studio/home", {
      findBinary: async () => "/bundled/codex",
      run: async (binary, args, opts) => {
        assert.equal(binary, "/bundled/codex");
        assert.deepEqual(args, ["login", "status"]);
        assert.equal(opts?.env?.CODEX_HOME, "/studio/home");
        assert.equal(opts?.env?.CODEX_API_KEY, undefined);
        return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      },
    });
    assert.equal(status.method, "chatgpt");
  });

  it("does not infer readiness from stale files, and accepts keychain-only native status", async () => {
    const root = await tmpDir("studio-auth-state-");
    const home = path.join(root, "codex");
    await mkdir(home);
    await writeFile(path.join(home, "studio-login.json"), "{}");
    let signedIn = false;
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "system"),
      executable: "/bundled/codex",
      authStatusFn: async (selected) => {
        assert.equal(selected, home);
        return { loggedIn: signedIn, method: signedIn ? "chatgpt" : undefined, detail: "native status" };
      },
    });
    assert.equal((await engine.status()).code, "needs_login");
    signedIn = true;
    assert.equal((await engine.recheckLogin()).code, "ready");
    signedIn = false;
    assert.equal((await engine.recheckLogin()).code, "needs_login");
    assert.equal((await engine.resolveLogin()).source, "isolated");
  });

  it("carries the selected credential store from login into status, builds, resumes, and critics", async () => {
    const f = await fixture("process.exit(0)");
    await f.controller.start(f.home);
    await until(() => f.controller.snapshot().phase === "connected");
    const loginArgs = f.invocations[0]!.args.slice(0, -1);
    await codexAuthStatus(f.home, {
      findBinary: async () => "/bundled/codex",
      run: async (_binary, args, opts) => {
        assert.deepEqual(args, [...loginArgs, "login", "status"]);
        assert.equal(opts?.env?.CODEX_HOME, f.home);
        return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      },
    });
    const calls: string[][] = [];
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: f.home,
      systemHome: path.join(f.home, "unused"),
      executable: "/bundled/codex",
      execFn: async function* (invocation) {
        assert.equal(invocation.env.CODEX_HOME, f.home);
        assert.equal(invocation.argv[0], "exec", "auth overrides must be in the exec command scope");
        assert.deepEqual(invocation.argv.slice(-loginArgs.length - 1, -1), loginArgs);
        assert.ok(invocation.argv.includes("--ignore-user-config"));
        calls.push(invocation.argv);
        yield { type: "thread.started", thread_id: "resume-me" };
        yield { type: "item.completed", item: { type: "agent_message", text: "Done" } };
        yield { type: "turn.completed", usage: {} };
      },
    });
    const cwd = await tmpDir("studio-login-build-");
    await engine.delegate({ cwd, prompt: "Build" });
    await engine.delegate({ cwd, prompt: "Continue", resume: "resume-me" });
    await engine.complete({ messages: [{ role: "user", content: "Judge" }] });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1]!.slice(0, 3), ["exec", "resume", "resume-me"]);
    assert.ok(calls[2]!.includes("--ephemeral"));
  });
});

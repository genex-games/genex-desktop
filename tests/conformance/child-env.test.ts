/**
 * Credentials at the child boundary.
 *
 * SEC-2: a child process sees only what it needs. The agent-editable harness and every command it
 * runs through the sandbox get an allow-listed environment; a contractor CLI gets the parent's
 * environment minus every credential except its own sign-in.
 * SEC-3: the sign-in homes of both coding CLIs (and whatever login home is actually in use) are
 * unreadable to agent processes and named in every contractor's deny list.
 */
import { cliName, fixtureCodingCli, writeCliLauncher } from "../helpers/external-cli.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { absoluteRule, claudeProjectDirName } from "../../src/substrate/engines/claude-permissions.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import { codexSubscriptionEnv } from "../../src/substrate/engines/codex-cli.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { ruleDenies } from "../helpers/claude-rules.ts";
import { tmpDir } from "../helpers/tmp.ts";

// An engine looks at these before its own homes; a dev shell must not hand this file its own.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

/** Every credential a developer's shell might export, each with a value a test can grep for. */
const FOREIGN = {
  OPENAI_API_KEY: "sk-openai-leak",
  CODEX_API_KEY: "codex-key-leak",
  CODEX_ACCESS_TOKEN: "codex-access-leak",
  ANTHROPIC_API_KEY: "sk-ant-leak",
  ANTHROPIC_AUTH_TOKEN: "ant-auth-leak",
  GENEX_TOKEN: "genex-leak",
  GITHUB_TOKEN: "ghp-leak",
  GH_TOKEN: "gh-leak",
  NPM_TOKEN: "npm-leak",
  STRIPE_SECRET: "stripe-leak",
  SOME_SERVICE_API_KEY: "service-leak",
  AWS_SECRET_ACCESS_KEY: "aws-leak",
} as const;

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const successClaude = [
  { type: "system", subtype: "init", model: "claude-sonnet-5", tools: ["Bash"] },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
];

function claudeQuery() {
  const seen: Array<Record<string, unknown>> = [];
  const fn = ((params: { prompt: string; options?: Record<string, unknown> }) => {
    seen.push({ ...params.options });
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of successClaude) yield message;
      },
    };
  }) as never;
  return { fn, seen };
}

function codexExec() {
  const seen: Array<{ env: Record<string, string>; prompt: string }> = [];
  const fn: CodexExec = (invocation) => {
    seen.push({ env: invocation.env, prompt: invocation.prompt });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "thread.started", thread_id: "t" };
        yield { type: "item.completed", item: { id: "i", type: "agent_message", text: "done" } };
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
  };
  return { fn, seen };
}

describe("SEC-2: the sandbox gives its children an allow-listed environment", () => {
  it("a command run through the sandbox sees no credential from the studio's own environment", async () => {
    const root = await tmpDir("child-env-sandbox-");
    const sandbox = await ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      enabled: false,
    });
    const result = await withEnv({ ...FOREIGN, CLAUDE_CODE_OAUTH_TOKEN: "oauth-leak", HARMLESS_FLAG: "x" }, () =>
      sandbox.run({ command: "env", cwd: root, env: { HARNESS_WS: root } }),
    );
    assert.equal(result.code, 0);
    for (const value of [...Object.values(FOREIGN), "oauth-leak"])
      assert.ok(!result.stdout.includes(value), `${value} reached the child`);
    assert.ok(
      !/^HARMLESS_FLAG=/m.test(result.stdout),
      "an allow-list, not a strip list: unknown variables stay behind too",
    );
    assert.match(result.stdout, /^HARNESS_WS=/m, "what the caller sets for its own child still arrives");
    assert.match(result.stdout, /^HOME=/m);
    assert.match(result.stdout, /^PATH=/m);
    // Asked of a program the shell starts: Git Bash shows its own temp folders in POSIX form.
    const tmp = await sandbox.run({ command: "node -p process.env.TMPDIR", cwd: root });
    assert.equal(path.resolve(tmp.stdout.trim()), sandbox.scratchDir, tmp.stderr);
  });
});

describe("SEC-2: a contractor keeps its own sign-in and nobody else's", () => {
  it("the Claude contractor gets no OpenAI, Codex, Genex or GitHub credential, and no metered Anthropic key", async () => {
    const root = await tmpDir("child-env-claude-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const { fn, seen } = claudeQuery();
    // As in production: the resolved CLI's environment is the studio's own, with PATH widened.
    const resolveCli: typeof fixtureCodingCli = async (...args) => ({
      ...(await fixtureCodingCli(...args)),
      env: { ...process.env, PATH: "/fixture/runtime:/usr/bin:/bin" },
    });
    const engine = new ClaudeCodeEngine({
      resolveCli,
      engineHome: home,
      systemHome: path.join(root, "none"),
      queryFn: fn,
    });
    await withEnv({ ...FOREIGN, CODEX_HOME_HINT: "codex-hint", HARMLESS_FLAG: "x" }, () =>
      engine.delegate({ prompt: "build", cwd: root }),
    );
    const env = seen[0]!.env as Record<string, string>;
    for (const key of Object.keys(FOREIGN)) assert.equal(env[key], undefined, `${key} reached the Claude contractor`);
    assert.equal(env.CODEX_HOME_HINT, undefined, "another vendor's variables stay behind");
    assert.equal(env.HARMLESS_FLAG, "x", "the contractor's own toolchain environment still arrives");
    assert.equal(env.CLAUDE_CONFIG_DIR, home);
  });

  it("the Codex contractor gets no Anthropic, Claude, Genex or GitHub credential", async () => {
    const root = await tmpDir("child-env-codex-");
    const home = path.join(root, "codex-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "auth.json"), "{}");
    const { fn, seen } = codexExec();
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "none"),
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn: fn,
    });
    const cwd = path.join(root, "game");
    await mkdir(cwd, { recursive: true });
    await withEnv(
      { ...FOREIGN, CLAUDE_CODE_OAUTH_TOKEN: "oauth-leak", CLAUDE_CONFIG_DIR_HINT: "hint", HARMLESS_FLAG: "x" },
      () => engine.delegate({ prompt: "build", cwd }),
    );
    const env = seen[0]!.env;
    for (const key of [...Object.keys(FOREIGN), "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR_HINT"])
      assert.equal(env[key], undefined, `${key} reached the Codex contractor`);
    assert.equal(env.HARMLESS_FLAG, "x");
    assert.equal(env.CODEX_HOME, home);
  });

  it("the Codex sign-in and status helpers carry no foreign credential either", async () => {
    const env = await withEnv({ ...FOREIGN, CLAUDE_CODE_OAUTH_TOKEN: "oauth-leak" }, async () =>
      codexSubscriptionEnv({ ...process.env, CODEX_HOME: "/codex/home" }),
    );
    for (const key of [...Object.keys(FOREIGN), "CLAUDE_CODE_OAUTH_TOKEN"]) assert.equal(env[key], undefined, key);
    assert.equal(env.CODEX_HOME, "/codex/home");
  });

  it("every child commits as the studio, whatever identity the user's shell exports (R1)", async () => {
    const { childEnv } = await import("../../src/substrate/child-env.ts");
    const { STUDIO_COMMITTER } = await import("../../src/substrate/snapshots.ts");
    const parent = {
      PATH: "/usr/bin",
      GIT_AUTHOR_EMAIL: "me@example.invalid",
      GIT_COMMITTER_EMAIL: "me@example.invalid",
    };
    const requests: Array<Parameters<typeof childEnv>[1]> = [
      { base: "sandbox" },
      { base: "contractor", vendor: "claude" },
      { base: "contractor", vendor: "codex" },
    ];
    for (const request of requests) {
      const env = childEnv(parent, request);
      assert.equal(env.GIT_AUTHOR_NAME, STUDIO_COMMITTER.name, request.base);
      assert.equal(env.GIT_AUTHOR_EMAIL, STUDIO_COMMITTER.email, request.base);
      assert.equal(env.GIT_COMMITTER_NAME, STUDIO_COMMITTER.name, request.base);
      assert.equal(env.GIT_COMMITTER_EMAIL, STUDIO_COMMITTER.email, request.base);
    }
  });

  it("childEnv: one table for every boundary", async () => {
    const { childEnv } = await import("../../src/substrate/child-env.ts");
    const parent = {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp/me",
      TERM: "xterm",
      HARMLESS_FLAG: "x",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CONFIG_DIR: "/claude/home",
      CODEX_HOME: "/codex/home",
      OPENAI_BASE_URL: "https://proxy.example",
      OPENCODE_CONFIG: "/opencode/config.json",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      ...FOREIGN,
    };
    const rows: Array<{ name: string; request: Parameters<typeof childEnv>[1]; keeps: string[]; drops: string[] }> = [
      {
        name: "sandbox",
        request: { base: "sandbox", set: { HARNESS_WS: "/ws", GENEX_TOKEN: "the child's own, set on purpose" } },
        keeps: ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "HARNESS_WS", "GENEX_TOKEN"],
        drops: [
          "HARMLESS_FLAG",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
          "CODEX_HOME",
          "OPENAI_BASE_URL",
          "SSH_AUTH_SOCK",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "GITHUB_TOKEN",
          "AWS_SECRET_ACCESS_KEY",
        ],
      },
      {
        name: "claude contractor",
        request: { base: "contractor", vendor: "claude", keep: ["CLAUDE_CODE_OAUTH_TOKEN"] },
        keeps: ["PATH", "HOME", "HARMLESS_FLAG", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
        drops: [
          "OPENCODE_CONFIG",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CODEX_HOME",
          "OPENAI_BASE_URL",
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "GENEX_TOKEN",
          "GITHUB_TOKEN",
          "GH_TOKEN",
          "NPM_TOKEN",
          "STRIPE_SECRET",
          "SOME_SERVICE_API_KEY",
          "AWS_SECRET_ACCESS_KEY",
          "SSH_AUTH_SOCK",
        ],
      },
      {
        name: "codex contractor",
        request: { base: "contractor", vendor: "codex", set: { CODEX_HOME: "/studio/codex" } },
        keeps: ["PATH", "HOME", "HARMLESS_FLAG", "CODEX_HOME", "OPENAI_BASE_URL"],
        drops: [
          "OPENCODE_CONFIG",
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "CODEX_ACCESS_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
          "ANTHROPIC_API_KEY",
          "GENEX_TOKEN",
          "GITHUB_TOKEN",
          "SSH_AUTH_SOCK",
        ],
      },
      {
        // OpenCode signs in to many providers through its own store; it gets neither subscription
        // CLI's variables, nor any metered key the shell exports.
        name: "opencode contractor",
        request: { base: "contractor", vendor: "opencode", set: { OPENCODE_DISABLE_AUTOUPDATE: "1" } },
        keeps: ["PATH", "HOME", "HARMLESS_FLAG", "OPENCODE_CONFIG", "OPENCODE_DISABLE_AUTOUPDATE"],
        drops: [
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
          "CODEX_HOME",
          "OPENAI_BASE_URL",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "GENEX_TOKEN",
          "GITHUB_TOKEN",
          "SSH_AUTH_SOCK",
        ],
      },
      {
        name: "a tool of no vendor",
        request: { base: "contractor", vendor: "none" },
        keeps: ["PATH", "HOME", "HARMLESS_FLAG"],
        drops: ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENAI_BASE_URL", "OPENCODE_CONFIG", "SSH_AUTH_SOCK"],
      },
    ];
    for (const row of rows) {
      const env = childEnv(parent, row.request);
      for (const key of row.keeps) assert.ok(env[key] !== undefined, `${row.name}: keeps ${key}`);
      for (const key of row.drops) assert.equal(env[key], undefined, `${row.name}: drops ${key}`);
    }
    assert.equal(
      childEnv(parent, { base: "contractor", vendor: "codex", set: { CODEX_HOME: "/studio/codex" } }).CODEX_HOME,
      "/studio/codex",
      "what the caller sets wins",
    );
    assert.equal(childEnv({ ...parent, UNDEF: undefined }, { base: "contractor", vendor: "claude" }).UNDEF, undefined);
  });

  /** M6: credentials whose names the first table did not know, and values that carry a password. */
  it("childEnv: drops every credential spelling a developer's shell exports, in any case", async () => {
    const { childEnv } = await import("../../src/substrate/child-env.ts");
    const secrets = [
      "PGPASSWORD",
      "MYSQL_PWD",
      "SENTRY_DSN",
      "SLACK_WEBHOOK_URL",
      "SECRET_KEY_BASE",
      "GITHUB_PAT",
      "CI_JOB_JWT",
      "STRIPE_KEYS",
      "GITHUB_TOKENS",
      "OP_SESSION_my",
      "BW_SESSION",
      "npm_config__authToken",
      "NPM_CONFIG_//registry.npmjs.org/:_authToken",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
    ];
    const parent: Record<string, string> = {
      PATH: "/usr/bin",
      PWD: "/Users/me/game",
      OLDPWD: "/Users/me",
      HARMLESS_FLAG: "x",
      HTTPS_PROXY: "http://proxy.example:3128",
    };
    for (const name of secrets) {
      parent[name] = `${name}-leak`;
      parent[name.toLowerCase()] = `${name.toLowerCase()}-leak`;
    }
    // Names that say nothing, values that say everything.
    parent.DATABASE_URL = "postgres://app:hunter2@db.example/app";
    parent.REDIS_URL = "redis://:hunter2@cache.example:6379";
    parent.ALL_PROXY = "http://me:hunter2@proxy.example:3128";
    for (const vendor of ["claude", "codex"] as const) {
      const env = childEnv(parent, { base: "contractor", vendor });
      const leaked = Object.entries(env)
        .filter(([, value]) => /-leak$|hunter2/.test(value))
        .map(([key]) => key);
      assert.deepEqual(leaked, [], `${vendor} contractor`);
      for (const key of ["PATH", "PWD", "OLDPWD", "HARMLESS_FLAG", "HTTPS_PROXY"])
        assert.equal(env[key], parent[key], `${vendor}: keeps ${key}`);
    }
    // The other vendor's variables go whatever their case.
    const mixed = {
      openai_base_url: "u",
      Openai_Api_Key: "k",
      codex_home: "/c",
      anthropic_api_key: "a",
      Claude_Config_Dir: "/h",
    };
    assert.deepEqual(
      Object.keys(childEnv(mixed, { base: "contractor", vendor: "claude" })).filter((key) => key in mixed),
      ["Claude_Config_Dir"],
    );
    assert.deepEqual(
      Object.keys(childEnv(mixed, { base: "contractor", vendor: "codex" })).filter((key) => key in mixed),
      ["openai_base_url", "codex_home"],
    );
  });

  it("the Claude sign-in status question carries no foreign credential", async () => {
    const { claudeAuthStatus } = await import("../../src/substrate/engines/claude-cli.ts");
    let seen: NodeJS.ProcessEnv = {};
    await withEnv({ ...FOREIGN, PGPASSWORD: "pg-leak", HARMLESS_FLAG: "x" }, () =>
      claudeAuthStatus("/studio/claude", {
        findBinary: async () => "/bundled/claude",
        run: async (_binary, _args, options) => {
          seen = options?.env ?? {};
          return { code: 0, stdout: '{"loggedIn":true}', stderr: "" };
        },
      }),
    );
    for (const key of [...Object.keys(FOREIGN), "PGPASSWORD"])
      assert.equal(seen[key], undefined, `${key} reached claude auth status`);
    assert.equal(seen.CLAUDE_CONFIG_DIR, "/studio/claude");
    assert.equal(seen.HARMLESS_FLAG, "x");
  });

  it("the coding CLI's --version and --help probes carry no credential", async () => {
    const { discoverCodingCli } = await import("../../src/substrate/engines/external-cli.ts");
    const root = await tmpDir("child-env-probe-");
    const cli = path.join(root, cliName("claude"));
    const flags =
      "--input-format --output-format --strict-mcp-config --setting-sources --permission-mode --mcp-config --allowedTools --disallowedTools";
    // Prints what it was given where the studio reads its version.
    await writeCliLauncher(
      cli,
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "1.0.0 [$GITHUB_TOKEN$OPENAI_API_KEY$PGPASSWORD]"; else echo ${flags}; fi\n`,
      `const e = process.env; console.log(process.argv[2] === "--version" ? \`1.0.0 [\${e.GITHUB_TOKEN ?? ""}\${e.OPENAI_API_KEY ?? ""}\${e.PGPASSWORD ?? ""}]\` : ${JSON.stringify(flags)});\n`,
    );
    const installation = await discoverCodingCli("claude-code", {
      override: cli,
      loginPath: "",
      standardDirs: [],
      home: root,
      excludedRoots: [],
      env: { PATH: "/usr/bin:/bin", ...FOREIGN, PGPASSWORD: "pg-leak" },
    });
    assert.equal(installation.status.version, "1.0.0 []");
  });

  it("the Ollama server the studio starts carries no credential and no coding CLI's variables", async () => {
    const { OllamaSidecar } = await import("../../src/substrate/engines/ollama.ts");
    const root = await tmpDir("child-env-ollama-");
    const out = path.join(root, "env.txt");
    const binary = path.join(root, cliName("ollama"));
    await writeCliLauncher(
      binary,
      `#!/bin/sh\n/usr/bin/env > '${out}'\n`,
      `const env = Object.entries(process.env).map(([k, v]) => \`\${k}=\${v}\`).join("\\n");\nrequire("fs").writeFileSync(${JSON.stringify(out)}, env + "\\n");\n`,
    );
    // Nothing answers on port 9: the sidecar starts its own copy, which records its environment and exits.
    const sidecar = new OllamaSidecar({ host: "http://127.0.0.1:9", binary });
    await withEnv({ ...FOREIGN, CLAUDE_CODE_OAUTH_TOKEN: "oauth-leak", OLLAMA_MODELS: "/models" }, () =>
      sidecar.ensureRunning(500),
    );
    let text = "";
    for (let i = 0; i < 50 && !text; i++) {
      text = await readFile(out, "utf8").catch(() => "");
      if (!text) await new Promise((r) => setTimeout(r, 20));
    }
    for (const value of [...Object.values(FOREIGN), "oauth-leak"])
      assert.ok(!text.includes(value), `${value} reached ollama serve`);
    assert.match(text, /^OLLAMA_MODELS=\/models$/m, "its own settings still arrive");
    assert.match(text, /^OLLAMA_HOST=127\.0\.0\.1:9$/m);
  });
});

describe("SEC-3: both CLIs' sign-in homes are off limits to every agent process", () => {
  const dotCodex = path.join(os.homedir(), ".codex");
  const dotClaude = path.join(os.homedir(), ".claude");

  it("the sandbox denies reading and writing ~/.codex, ~/.claude and the homes the environment points at", async () => {
    const root = await tmpDir("child-env-policy-");
    const sandbox = await withEnv(
      { CODEX_HOME: path.join(root, "env-codex"), CLAUDE_CONFIG_DIR: path.join(root, "env-claude") },
      () =>
        ProcessSandbox.create({
          writableRoots: [root],
          scratchDir: path.join(root, "scratch"),
          secretPaths: [],
          enabled: false,
        }),
    );
    for (const dir of [dotCodex, dotClaude, path.join(root, "env-codex"), path.join(root, "env-claude")]) {
      assert.ok(sandbox.policy.denyRead.includes(dir), `denyRead holds ${dir}`);
      assert.ok(sandbox.policy.denyWrite.includes(dir), `denyWrite holds ${dir}`);
    }
  });

  it("the sandbox OpenCode runs in lets it reach its own sign-in home and no other (hostile table)", async () => {
    const root = await tmpDir("child-env-own-home-");
    const opencode = path.join(os.homedir(), ".local", "share", "opencode");
    const secrets = path.join(root, "secrets");
    const sandbox = await ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [secrets],
      enabled: false,
      // Only an exact credential home is exempted: a studio secret, another CLI's home, a parent of
      // a home, the home folder and a relative path named here all stay as they were.
      ownHome: [opencode, secrets, dotCodex, path.dirname(opencode), os.homedir(), "relative/opencode"],
    });
    assert.ok(!sandbox.policy.denyRead.includes(opencode), "OpenCode reads its own sign-in");
    assert.ok(!sandbox.policy.denyWrite.includes(opencode), "and keeps its sessions there");
    assert.ok(sandbox.policy.allowWrite.includes(opencode));
    for (const dir of [secrets, dotCodex, dotClaude]) {
      assert.ok(sandbox.policy.denyRead.includes(dir), `denyRead still holds ${dir}`);
      assert.ok(sandbox.policy.denyWrite.includes(dir), `denyWrite still holds ${dir}`);
    }
    for (const dir of [path.dirname(opencode), os.homedir(), "relative/opencode"])
      assert.ok(!sandbox.policy.allowWrite.includes(dir), `nothing but the exempted home is opened: ${dir}`);

    const other = await ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch-2"),
      secretPaths: [],
      enabled: false,
    });
    assert.ok(other.policy.denyRead.includes(opencode), "every other sandbox denies OpenCode's sign-in");
  });

  it("an environment pointing a login home at the whole home folder does not deny the home folder", async () => {
    const root = await tmpDir("child-env-home-");
    const sandbox = await withEnv({ CODEX_HOME: os.homedir(), CLAUDE_CONFIG_DIR: "/" }, () =>
      ProcessSandbox.create({
        writableRoots: [root],
        scratchDir: path.join(root, "scratch"),
        secretPaths: [],
        enabled: false,
      }),
    );
    assert.ok(!sandbox.policy.denyRead.includes(os.homedir()));
    assert.ok(!sandbox.policy.denyRead.includes("/"));
  });

  it("the Claude contractor's deny rules name both homes, and fence the borrowed login to what the session uses", async () => {
    const root = await tmpDir("child-env-claude-deny-");
    const systemHome = path.join(root, "dot-claude");
    await mkdir(systemHome, { recursive: true });
    await writeFile(path.join(systemHome, ".credentials.json"), "{}");
    // The person's own Claude home as Claude Code keeps it: other projects' transcripts and the
    // prompt history beside what the CLI hands this session.
    await writeFile(path.join(systemHome, "history.jsonl"), "{}\n");
    const ownProject = path.join(systemHome, "projects", claudeProjectDirName(await realpath(root)));
    const otherProject = path.join(systemHome, "projects", "-Users-me-another-project");
    for (const dir of [ownProject, otherProject, path.join(systemHome, "plans")]) await mkdir(dir, { recursive: true });
    const { fn, seen } = claudeQuery();
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "engine"),
      systemHome,
      queryFn: fn,
      protectedPaths: [path.join(root, "secrets")],
    });
    await engine.delegate({ prompt: "build", cwd: root });
    const options = seen[0]! as {
      settings?: { permissions?: { deny?: string[] } };
      sandbox?: { filesystem?: { denyWrite?: string[] } };
    };
    const deny = options.settings?.permissions?.deny ?? [];
    // Flipped (permissions port): every rule names its path absolutely (Claude Code's `//`).
    for (const dir of [path.join(root, "secrets"), dotCodex, dotClaude]) {
      assert.ok(deny.includes(absoluteRule("Read", dir)), `Read deny for ${dir}: ${JSON.stringify(deny)}`);
      assert.ok(options.sandbox?.filesystem?.denyWrite?.includes(dir), `denyWrite for ${dir}`);
    }
    // Flipped (review F2): the borrowed sign-in is this session's own Claude home. Its plans and
    // this folder's project (saved tool output the model is told to Read) stay reachable, so the
    // home is not fenced whole; everything else in it is, with the credentials, other projects by
    // a few globs (as Claude Code matches them). Its shell still writes none of it.
    for (const fenced of [
      path.join(systemHome, ".credentials.json"),
      path.join(systemHome, "history.jsonl"),
      path.join(otherProject, "t.jsonl"),
    ])
      assert.ok(ruleDenies(deny, "Read", fenced), `Read deny for ${fenced}`);
    for (const reachable of [
      systemHome,
      ownProject,
      path.join(ownProject, "tool-results", "x.txt"),
      path.join(systemHome, "plans"),
      path.join(systemHome, "projects"),
    ])
      assert.ok(!ruleDenies(deny, "Read", reachable), `reachable: ${reachable}`);
    assert.ok(options.sandbox?.filesystem?.denyWrite?.includes(systemHome), `denyWrite for ${systemHome}`);
  });

  it("the Codex contractor's brief names both homes and the system login it is borrowing", async () => {
    const root = await tmpDir("child-env-codex-deny-");
    const systemHome = path.join(root, "dot-codex");
    await mkdir(systemHome, { recursive: true });
    await writeFile(path.join(systemHome, "auth.json"), "{}");
    const { fn, seen } = codexExec();
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: path.join(root, "engine"),
      systemHome,
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn: fn,
      protectedPaths: [path.join(root, "secrets")],
    });
    const cwd = path.join(root, "game");
    await mkdir(cwd, { recursive: true });
    await engine.delegate({ prompt: "build", cwd });
    for (const dir of [path.join(root, "secrets"), dotCodex, dotClaude, systemHome])
      assert.ok(
        seen[0]!.prompt.includes(`  ${dir}\n`) || seen[0]!.prompt.endsWith(`  ${dir}`),
        `OFF LIMITS names ${dir}`,
      );
  });

  it("credentialHomes is the one list every boundary uses", async () => {
    const { credentialHomes } = await import("../../src/substrate/credential-homes.ts");
    // Absolute on this platform: `/Users/me` on macOS and Linux, `<drive>:\Users\me` on Windows.
    const at = (...parts: string[]) => path.resolve(path.sep, ...parts);
    const home = at("Users", "me");
    // Flipped (OpenCode): OpenCode's sign-in store joins the list, so no other agent reads it.
    const defaults = [
      at("Users", "me", ".codex"),
      at("Users", "me", ".claude"),
      at("Users", "me", ".local", "share", "opencode"),
    ];
    assert.deepEqual(credentialHomes([], {}, home), defaults);
    assert.deepEqual(
      credentialHomes(
        [at("login", "claude"), null, undefined, "relative/path", at("Users", "me", ".codex")],
        {
          CODEX_HOME: at("env", "codex"),
          CLAUDE_CONFIG_DIR: `${at("env", "claude")}${path.sep}`,
          XDG_DATA_HOME: at("env", "data"),
        },
        home,
      ),
      [...defaults, at("env", "codex"), at("env", "claude"), at("env", "data", "opencode"), at("login", "claude")],
    );
    assert.deepEqual(
      credentialHomes([at("Users"), at(), home], { CODEX_HOME: home, XDG_DATA_HOME: "relative" }, home),
      defaults,
      "never the home folder, its ancestors, the root or a relative data folder",
    );
  });
});

/**
 * Sandbox conformance.
 *
 * These tests run the **real** Seatbelt sandbox (no mocks): if containment silently stopped
 * working, the studio would still look fine while an unattended self-improving agent gained the
 * run of the machine. So the suite asserts the boundary from both sides — permitted work
 * succeeds, forbidden work fails.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeFolderDenyWrites, ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

let sandbox: ProcessSandbox;
let workspace: string;
let secrets: string;
let outside: string;
let scratch: string;

// Linux's sandbox proxy/observer remains active after the last command. Release the
// fixture-owned singleton so a passing test file can exit naturally on both platforms.
after(async () => {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  await SandboxManager.reset();
});

before(async () => {
  const root = await tmpDir("studio-sandbox-");
  workspace = path.join(root, "workspaces", "harness");
  secrets = path.join(root, "secrets");
  outside = path.join(root, "outside");
  scratch = path.join(root, "scratch");
  await mkdir(workspace, { recursive: true });
  await mkdir(secrets, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(secrets, "engine-token.json"), '{"token":"super-secret"}');
  await writeFile(path.join(outside, "user-file.txt"), "not the agent's business");

  sandbox = await ProcessSandbox.create({
    writableRoots: [workspace],
    scratchDir: scratch,
    secretPaths: [secrets],
  });
});

describe("sandboxed spawn", () => {
  it("runs commands and captures output", async () => {
    const result = await sandbox.run({ command: "echo hello from the sandbox", cwd: workspace });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "hello from the sandbox");
    assert.equal(result.sandboxed, true, "the fallback path must not be silently taken");
  });

  it("allows writes inside the workspace", async () => {
    const result = await sandbox.run({
      command: "printf 'built by the agent' > artifact.txt && cat artifact.txt",
      cwd: workspace,
    });
    assert.equal(result.code, 0);
    assert.equal(await readFile(path.join(workspace, "artifact.txt"), "utf8"), "built by the agent");
  });

  it("denies writes outside the workspace", async () => {
    const result = await sandbox.run({
      command: `printf 'escaped' > ${JSON.stringify(path.join(outside, "escape.txt"))}`,
      cwd: workspace,
    });
    assert.notEqual(result.code, 0, "write outside the writable roots must fail");
    await assert.rejects(() => readFile(path.join(outside, "escape.txt"), "utf8"), /ENOENT/);
  });

  it("gives the agent a private scratch dir as TMPDIR, not the shared system temp", async () => {
    const result = await sandbox.run({
      command: "printf 'tmp' > \"$TMPDIR/probe.txt\" && echo $TMPDIR",
      cwd: workspace,
    });
    assert.equal(result.code, 0);
    // Resolved: Git Bash on Windows spells it C:/Users/….
    assert.equal(path.resolve(result.stdout.trim()), scratch);
    assert.equal(await readFile(path.join(scratch, "probe.txt"), "utf8"), "tmp");

    const shared = await sandbox.run({
      command: `printf 'x' > ${JSON.stringify(path.join(os.tmpdir(), "studio-should-not-write.txt"))}`,
      cwd: workspace,
    });
    assert.notEqual(shared.code, 0, "the shared system temp dir must not be writable");
  });

  it("denies reads of the secrets directory", async () => {
    const result = await sandbox.run({
      command: `cat ${JSON.stringify(path.join(secrets, "engine-token.json"))}`,
      cwd: workspace,
    });
    assert.notEqual(result.code, 0, "secrets must be unreadable to agent processes");
    assert.ok(!result.stdout.includes("super-secret"));
  });

  it("denies reads of the user's ssh keys", async () => {
    const result = await sandbox.run({ command: `ls ${path.join(os.homedir(), ".ssh")}`, cwd: workspace });
    assert.notEqual(result.code, 0);
  });

  it("refuses an outbound host at the filtering proxy, without needing the internet", async () => {
    // The proxy judges the host name before any lookup, so a reserved name answers the same on
    // an offline machine: 403 is the refusal, where a DNS failure would read 000.
    const result = await sandbox.run({
      command: "curl -s -m 8 -o /dev/null -w '%{http_code}' http://studio-sandbox-probe.invalid/",
      cwd: workspace,
      timeoutMs: 30_000,
    });
    assert.equal(
      result.stdout.trim(),
      "403",
      `no domain is allow-listed by default: ${result.stdout} ${result.stderr}`,
    );
  });

  it("PH-3: a per-run domain really opens at the filtering proxy, for that run only", async () => {
    // The proxy judges the host before any lookup: 403 is its refusal, and a reserved name it
    // lets through fails DNS and comes back 502 — still no internet needed.
    const probe = "curl -s -m 8 -o /dev/null -w '%{http_code}' http://studio-overlay-probe.invalid/";
    const opened = await sandbox.run({
      command: probe,
      cwd: workspace,
      timeoutMs: 30_000,
      policy: { allowedDomains: ["studio-overlay-probe.invalid"] },
    });
    assert.equal(
      opened.stdout.trim(),
      "502",
      `the install overlay must reach the proxy: ${opened.stdout} ${opened.stderr}`,
    );
    const after = await sandbox.run({ command: probe, cwd: workspace, timeoutMs: 30_000 });
    assert.equal(after.stdout.trim(), "403", "the domain closes again when the run ends");
  });

  it("SEC-2: a sandboxed command sees none of the studio's credentials", async () => {
    process.env.STUDIO_SANDBOX_PROBE_TOKEN = "sandbox-token-leak";
    try {
      const result = await sandbox.run({ command: "env", cwd: workspace });
      assert.equal(result.code, 0);
      assert.ok(
        !result.stdout.includes("sandbox-token-leak"),
        "a token in the studio's environment reached a sandboxed shell",
      );
    } finally {
      delete process.env.STUDIO_SANDBOX_PROBE_TOKEN;
    }
  });

  it("never runs the user's shell rc file, even while the command's stdin stays open", async () => {
    // The fake home's rc file stands in for one that fails on this machine: what it prints would
    // otherwise lead a build's stderr, which is the problem the stage shows.
    const home = await tmpDir("studio-sandbox-home-");
    await writeFile(path.join(home, ".bashrc"), "echo rc-file-ran >&2\n");
    const command = "echo command-ran >&2";

    // A long-lived child keeps its stdin socket open, as the harness runtime's does.
    const { child } = await sandbox.spawnLongLived({ command, cwd: workspace, env: { HOME: home } });
    let longLived = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      longLived += chunk;
    });
    await once(child, "close");
    child.stdin?.destroy();
    assert.equal(longLived.trim(), "command-ran");

    const run = await sandbox.run({ command, cwd: workspace, env: { HOME: home } });
    assert.equal(run.code, 0);
    assert.equal(run.stderr.trim(), "command-ran");
  });

  // macOS only: on Linux srt runs a command in its own network namespace, so the host's loopback
  // is out of reach by design. The app ships for macOS, where Seatbelt leaves loopback open.
  const hostLoopback =
    process.platform === "darwin" ? false : "Linux: srt's network namespace hides the host's loopback";

  it("reaches a server on localhost, as the local model runtime and game server need", {
    skip: hostLoopback,
  }, async () => {
    const server = http.createServer((_request, response) => response.end("reached"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      for (const host of ["127.0.0.1", "localhost"]) {
        const result = await sandbox.run({
          command: `curl -s -m 5 http://${host}:${port}/`,
          cwd: workspace,
          timeoutMs: 20_000,
        });
        assert.equal(result.code, 0, host);
        assert.equal(result.stdout, "reached", host);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The two below reach past this process: the public internet and whatever runs on port 11434.
  // Opt in with STUDIO_NETWORK_TESTS=1; the two above cover the same boundary hermetically.
  const network =
    process.env.STUDIO_NETWORK_TESTS === "1" ? false : "opens the real network; set STUDIO_NETWORK_TESTS=1 to run";

  it("blocks outbound network by default", { skip: network }, async () => {
    const result = await sandbox.run({
      command: "curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com",
      cwd: workspace,
      timeoutMs: 30_000,
    });
    assert.notEqual(result.stdout.trim(), "200", "no domain is allow-listed by default");
  });

  it("allows localhost so the local model runtime stays reachable", { skip: network }, async () => {
    const result = await sandbox.run({
      command: "curl -s -m 5 http://127.0.0.1:11434/api/version || echo NO_OLLAMA",
      cwd: workspace,
      timeoutMs: 20_000,
    });
    assert.equal(result.code, 0);
    // Either Ollama answered or it is not running; what matters is that binding wasn't blocked.
    assert.ok(/version|NO_OLLAMA/.test(result.stdout), `unexpected output: ${result.stdout}`);
  });

  it("kills runaway processes on timeout (no cgroups, so the watchdog kills)", async () => {
    const started = Date.now();
    const result = await sandbox.run({ command: "sleep 30", cwd: workspace, timeoutMs: 1200 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 10_000, "must not wait for the child to finish");
    assert.notEqual(result.code, 0);
  });

  it("truncates flooding output instead of exhausting memory", async () => {
    const result = await sandbox.run({
      command: "yes 'flood' | head -c 2000000",
      cwd: workspace,
      maxOutputBytes: 4096,
      timeoutMs: 30_000,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 4096);
  });

  it("supports a per-run policy overlay without weakening the deny lists", async () => {
    const overlaid = sandbox["toRuntimeConfig"](sandbox.policy);
    assert.deepEqual(overlaid.network.allowedDomains, []);
    // A run may open a domain...
    const opened = await sandbox.run({
      command: "echo policy-overlay-ok",
      cwd: workspace,
      policy: { allowedDomains: ["registry.npmjs.org"] },
    });
    assert.equal(opened.code, 0);
    // ...but the secrets deny-read still holds inside that same run.
    const denied = await sandbox.run({
      command: `cat ${JSON.stringify(path.join(secrets, "engine-token.json"))}`,
      cwd: workspace,
      policy: { allowedDomains: ["registry.npmjs.org"] },
    });
    assert.notEqual(denied.code, 0);
  });

  it("reports the sandbox as available on this platform", async () => {
    assert.equal(sandbox.enabled, true);
    assert.equal(sandbox.initError, null);
  });

  it("allowWrite opens a later folder without weakening the deny list", async () => {
    const extra = path.join(await tmpDir("studio-sandbox-extra-"), "opened");
    await mkdir(extra, { recursive: true });
    sandbox.allowWrite(extra);
    const result = await sandbox.run({
      command: "printf 'from-opened' > note.txt && cat note.txt",
      cwd: extra,
    });
    assert.equal(result.code, 0);
    assert.equal(await readFile(path.join(extra, "note.txt"), "utf8"), "from-opened");

    const denied = await sandbox.run({
      command: `cat ${JSON.stringify(path.join(secrets, "engine-token.json"))}`,
      cwd: extra,
    });
    assert.notEqual(denied.code, 0);
  });
});

/**
 * A game's `.claude` folder is Claude Code's project settings, so no agent process writes it
 * (`claudeFolderDenyWrites`), even when the game's path reads as a glob to sandbox-runtime. Each
 * game sits in a writable folder, so only the deny can refuse; the rest of the game, and a
 * neighbour the path's glob reading would have hit, stay writable. Seatbelt matches bytes, which
 * the unit test's JavaScript regexes cannot show.
 */
describe("a game's .claude folder under Seatbelt", {
  skip: process.platform !== "darwin" && "Seatbelt is macOS-only",
}, () => {
  const GAMES: Array<{ name: string; dir: string }> = [
    { name: "a bracketed tag", dir: path.join("work", "Pong [WIP]") },
    { name: "a star and a question mark", dir: path.join("work", "a*b?") },
    { name: "an ASCII control character", dir: path.join("work", "c\u0001d [1]") },
    { name: "a two-byte control character", dir: path.join("work", "e\u0085f [1]") },
    { name: "sandbox-runtime's placeholder", dir: path.join("work", "x__GLOBSTAR_SLASH__y [1]") },
    { name: "a bracketed games folder", dir: path.join("[AI] Games", "pong") },
  ];
  let base: string;
  let games: ProcessSandbox;

  before(async () => {
    base = await realpath(await tmpDir("studio-sandbox-claude-"));
    const dirs = GAMES.map((row) => path.join(base, row.dir));
    for (const dir of [...dirs, path.join(base, "work", "Pong W")]) await mkdir(dir, { recursive: true });
    games = await ProcessSandbox.create({
      writableRoots: [base],
      scratchDir: path.join(base, "scratch"),
      secretPaths: [],
      denyWrite: claudeFolderDenyWrites(path.join(base, "[AI] Games"), dirs),
    });
  });

  for (const row of GAMES)
    it(`refuses a game folder with ${row.name} its .claude folder, in any case`, async () => {
      const dir = path.join(base, row.dir);
      const made = await games.run({ command: "mkdir -p .Claude && printf x > .Claude/settings.local.json", cwd: dir });
      assert.notEqual(made.code, 0, "a new .Claude folder must be refused");
      await assert.rejects(() => stat(path.join(dir, ".Claude")), /ENOENT/);
      // The person's own session made the folder; an agent still may not write into it.
      await mkdir(path.join(dir, ".claude"));
      const planted = await games.run({ command: "printf x > .claude/settings.json", cwd: dir });
      assert.notEqual(planted.code, 0, "settings planted in .claude must be refused");
      await assert.rejects(() => readFile(path.join(dir, ".claude", "settings.json"), "utf8"), /ENOENT/);
      const game = await games.run({ command: "mkdir -p src && printf x > src/main.js", cwd: dir });
      assert.equal(game.code, 0, game.stderr);
      assert.equal(game.sandboxed, true);
    });

  it("leaves the neighbour a bracketed name would have matched as a glob writable", async () => {
    const result = await games.run({
      command: "mkdir -p .claude && printf x > .claude/settings.json",
      cwd: path.join(base, "work", "Pong W"),
    });
    assert.equal(result.code, 0, result.stderr);
  });
});

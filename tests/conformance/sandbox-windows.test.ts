/**
 * Sandbox conformance on Windows: the **real** srt-win backend with Git Bash, no mocks.
 *
 * The same boundary `sandbox.test.ts` asserts on macOS, from both sides, as hostile-input
 * tables: writes outside the grants and reads anywhere else in the profile fail and leave nothing
 * behind; a domain nobody allowed is refused while an allowed one answers; the host reaches a
 * server inside the sandbox; the studio's environment stays out; a kill ends the whole tree; and
 * an Electron-as-Node boot from `%LOCALAPPDATA%` (where the installed app lives) runs Git.
 *
 * Windows only, on a machine whose sandbox is provisioned (the Windows CI job does that and sets
 * GENEX_WINDOWS_SANDBOX=ready). `windows-sandbox.test.ts` covers the same rules everywhere with fakes.
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { HarnessInbox } from "../../src/substrate/harness-inbox.ts";
import { SandboxLaunchCode, SandboxLaunchError } from "../../src/substrate/sandbox-unavailable.ts";
import { ProcessSandbox, killChild } from "../../src/substrate/spawn.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";
import { observeExit } from "../helpers/windows-process.ts";

/** Why this machine cannot run the suite, or false when it can. */
function skipReason(): string | false {
  if (process.platform !== "win32") return "Windows only: the srt-win backend";
  if (process.env.GENEX_WINDOWS_SANDBOX !== "ready") return "needs a provisioned sandbox (GENEX_WINDOWS_SANDBOX=ready)";
  return false;
}
const SKIP = skipReason();

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BOOTSTRAP = path.join(REPO, "src", "harness-boot", "bootstrap.mjs");
const FIXTURE_OK = path.join(REPO, "tests", "fixtures", "harness-ok");
const ELECTRON_DIST = path.join(REPO, "node_modules", "electron", "dist");
const RUN_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 180_000;
const HEARTBEAT_WAIT_MS = 30_000;
const KILL_SETTLE_MS = 4_000;
const SECRET = "profile-secret-content";

/** A value for Git Bash: forward slashes, single-quoted. */
const q = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'`;
const curl = (url: string, flags = "") => `curl -sS -m 15 ${flags} -o /dev/null -w '%{http_code}' ${q(url)}`;

let sandbox: ProcessSandbox;
let workspace: string;
let scratch: string;
let secrets: string;
let profileDir: string;
let electronInstall: string;
let bootstrap: string;

before(async () => {
  if (SKIP) return;
  // Long names, as the app's own folders have: `os.tmpdir()` can be spelled with an 8.3 name.
  const root = realpathSync.native(await tmpDir("genex-sandbox-win-"));
  workspace = path.join(root, "workspace");
  scratch = path.join(root, "scratch");
  secrets = path.join(workspace, ".secrets");
  // Ungranted places in the real user's profile, the shape of ~/Documents and %LOCALAPPDATA%.
  profileDir = path.join(os.homedir(), `genex-sandbox-probe-${process.pid}`);
  electronInstall = path.join(
    process.env.LOCALAPPDATA ?? os.homedir(),
    `genex-sandbox-probe-${process.pid}`,
    "app-0.0.0",
  );
  await mkdir(secrets, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(secrets, "token.txt"), SECRET);
  await writeFile(path.join(profileDir, "private.txt"), SECRET);
  const bootstrapDir = path.join(root, "bootstrap");
  await mkdir(bootstrapDir);
  bootstrap = path.join(bootstrapDir, "bootstrap.mjs");
  await cp(BOOTSTRAP, bootstrap);
  if (existsSync(ELECTRON_DIST)) await cp(ELECTRON_DIST, electronInstall, { recursive: true });
  sandbox = await ProcessSandbox.create({
    writableRoots: [workspace],
    scratchDir: scratch,
    secretPaths: [secrets],
    readableRoots: [electronInstall, bootstrapDir],
  });
});

after(async () => {
  if (SKIP) return;
  await sandbox.dispose();
  await removeTree(profileDir);
  await removeTree(path.dirname(electronInstall));
});

const inside = (command: string, extra: Partial<Parameters<ProcessSandbox["run"]>[0]> = {}) =>
  sandbox.run({ command, cwd: workspace, timeoutMs: RUN_TIMEOUT_MS, ...extra });

describe("Windows sandbox: identity and files", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("runs Git Bash commands as the sandbox user", async () => {
    const result = await inside("echo hello-sandbox; whoami");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.sandboxed, true);
    assert.match(result.stdout, /hello-sandbox/);
    assert.match(result.stdout, /srt-sandbox/i);
  });

  it("writes inside the workspace and uses its own scratch folder as TMPDIR", async () => {
    const result = await inside('printf built > artifact.txt && printf tmp > "$TMPDIR/probe.txt" && cat artifact.txt');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(workspace, "artifact.txt"), "utf8"), "built");
    assert.equal(await readFile(path.join(sandbox.scratchDir, "probe.txt"), "utf8"), "tmp");
  });

  it("refuses every write outside the grants and leaves no file", async () => {
    const targets = [
      path.join(profileDir, "escaped.txt"),
      path.join(os.homedir(), `genex-escaped-${process.pid}.txt`),
      `C:\\genex-escaped-${process.pid}.txt`,
      `C:\\Users\\Public\\genex-escaped-${process.pid}.txt`,
      path.join(workspace, "..", `escaped-${process.pid}.txt`),
      path.join(os.tmpdir(), `genex-escaped-${process.pid}.txt`),
    ];
    for (const target of targets) {
      const result = await inside(`printf escaped > ${q(target)}`);
      assert.notEqual(result.code, 0, `${target} must not be writable`);
      assert.equal(existsSync(target), false, `${target} must not exist`);
    }
  });

  it("refuses reads of the profile and of the secret paths inside a writable root", async () => {
    const files = [path.join(profileDir, "private.txt"), path.join(secrets, "token.txt")];
    for (const file of files) {
      const result = await inside(`cat ${q(file)}`);
      assert.notEqual(result.code, 0, `${file} must not be readable: ${result.stdout} ${result.stderr}`);
      assert.ok(!result.stdout.includes(SECRET), `${file} leaked`);
    }
    const folders = [
      os.homedir(),
      profileDir,
      secrets,
      path.join(process.env.APPDATA ?? os.homedir(), "Microsoft"),
      process.env.LOCALAPPDATA ?? os.homedir(),
    ];
    for (const folder of folders) {
      const listing = await inside(`ls -A ${q(folder)}`);
      assert.equal(listing.stdout.trim(), "", `${folder} must not be listable: ${listing.stderr}`);
    }
  });

  it("refuses a per-run write outside the session's grants before starting anything", async () => {
    await assert.rejects(
      inside("true", { policy: { allowWrite: [profileDir] } }),
      (error: unknown) => error instanceof SandboxLaunchError && error.code === SandboxLaunchCode.NotGranted,
    );
  });

  it("a per-run write deny on a folder binds that run only (the type gate's shape)", async () => {
    const gated = path.join(workspace, "gated");
    await mkdir(gated, { recursive: true });
    await writeFile(path.join(gated, "kept.txt"), "original");
    const policy = { denyWrite: [gated] };
    const attempts: Array<[string, string, string]> = [
      ["a new file", "printf new > gated/new.txt", path.join(gated, "new.txt")],
      ["a nested folder", "mkdir gated/sub", path.join(gated, "sub")],
    ];
    for (const [label, command, target] of attempts) {
      const denied = await inside(command, { policy });
      assert.notEqual(denied.code, 0, `${label} must not be writable`);
      assert.equal(existsSync(target), false, `${label} must not exist`);
    }
    const overwrite = await inside("printf changed > gated/kept.txt", { policy });
    assert.notEqual(overwrite.code, 0, "an existing file must not be writable");
    const removal = await inside("rm -f gated/kept.txt", { policy });
    assert.notEqual(removal.code, 0, "an existing file must not be removable");
    assert.equal(await readFile(path.join(gated, "kept.txt"), "utf8"), "original");
    const sibling = await inside("printf beside > beside-gated.txt", { policy });
    assert.equal(sibling.code, 0, `the rest of the workspace stays writable: ${sibling.stderr}`);
    const later = await inside("printf later > gated/later.txt");
    assert.equal(later.code, 0, `the deny ends with its run: ${later.stderr}`);
    assert.equal(await readFile(path.join(gated, "later.txt"), "utf8"), "later");
  });

  it("a folder opened later becomes writable after one regrant", async () => {
    const later = path.join(realpathSync.native(await tmpDir("genex-sandbox-later-")), "game");
    await mkdir(later, { recursive: true });
    sandbox.allowWrite(later);
    const result = await sandbox.run({ command: "printf later > late.txt", cwd: later, timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(later, "late.txt"), "utf8"), "later");
  });
});

describe("Windows sandbox: stdio", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("pipes a run's stdin to the command", async () => {
    const result = await inside("cat", { stdin: "from-the-host\n" });
    assert.equal(result.stdout, "from-the-host\n", result.stderr);
  });

  it("boots the harness bootstrap and hears it over the loopback inbox (stdin does not reach it)", async () => {
    const harness = path.join(workspace, "inbox-harness");
    await cp(FIXTURE_OK, harness, { recursive: true });
    assert.notEqual((await inside(`printf changed > ${q(bootstrap)}`)).code, 0, "the trusted bootstrap is read-only");
    const inbox = await HarnessInbox.open();
    const { child } = await sandbox.spawnLongLived({
      command: `${q(process.execPath)} ${q(bootstrap)}`,
      cwd: harness,
      env: { HARNESS_WS: harness, NODE_OPTIONS: "", ...inbox.env() },
    });
    try {
      let output = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      inbox.write(`${JSON.stringify({ kind: "shutdown", graceMs: 1_000 })}\n`);
      assert.equal(await inbox.connect(() => child.exitCode === null), true, "the host reached the inbox");
      const code = await new Promise((resolve) => child.once("exit", resolve));
      assert.match(output, /"kind":"ready"/);
      assert.equal(code, 0, "the harness shut down when asked over the inbox");
    } finally {
      inbox.close();
      killChild(child);
    }
  });
});

describe("Windows sandbox: environment", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("hands over the caller's variables and nothing of the studio's", async () => {
    process.env.GENEX_SANDBOX_PROBE_TOKEN = "studio-token-leak";
    try {
      const result = await inside('env; printf "own=%s" "$OWN_VALUE"', { env: { OWN_VALUE: "it's $(not run)" } });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!result.stdout.includes("studio-token-leak"), "a studio variable reached the sandbox");
      assert.match(result.stdout, /own=it's \$\(not run\)/);
      assert.ok(!result.stdout.includes(`USERPROFILE=${os.homedir()}`), "the child has its own profile");
    } finally {
      delete process.env.GENEX_SANDBOX_PROBE_TOKEN;
    }
  });

  it("runs Node and Git from a workspace under AppData (the realpath and git walks)", async () => {
    await writeFile(path.join(workspace, "mod.cjs"), 'module.exports = "mod-ok";');
    const node = await inside(`node -e 'console.log(require("./mod.cjs"))'`);
    assert.equal(node.stdout.trim(), "mod-ok", node.stderr);
    const git = await inside(
      "git init -q repo && cd repo && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.invalid commit -q -m first && git log --oneline",
    );
    assert.equal(git.code, 0, git.stderr);
    assert.match(git.stdout, /first/);
  });

  it("boots an Electron-as-Node entry installed under %LOCALAPPDATA%, which spawns Git", {
    skip: existsSync(ELECTRON_DIST) ? false : "no Electron binary in node_modules",
  }, async () => {
    const entry = path.join(electronInstall, "boot.mjs");
    await writeFile(
      entry,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], execFileSync("git", ["--version"], { encoding: "utf8" }));',
      ].join("\n"),
    );
    const out = path.join(workspace, "boot.txt");
    const exe = path.join(electronInstall, "electron.exe");
    const result = await inside(`export ELECTRON_RUN_AS_NODE=1; ${q(exe)} ${q(entry)} ${q(out)}`, {
      env: { NODE_OPTIONS: "" },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(await readFile(out, "utf8"), /git version/);
  });
});

/** A dual-stack HTTP server on the host's loopback. */
async function hostServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => response.end("host-ok"));
  await new Promise<void>((resolve) => server.listen(0, "::", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function hostGet(url: string): Promise<string | undefined> {
  return await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.text(),
    () => undefined,
  );
}

describe("Windows sandbox: network", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("refuses a domain nobody allowed, at the proxy and around it", async () => {
    const table: Array<[string, string]> = [
      ["through the proxy", curl("http://genex-sandbox-probe.invalid/")],
      ["around the proxy", curl("https://example.com/", "--noproxy '*'")],
    ];
    for (const [label, command] of table) {
      const result = await inside(command);
      assert.notEqual(result.stdout.trim(), "200", `${label}: ${result.stdout} ${result.stderr}`);
    }
    assert.equal((await inside(curl("http://genex-sandbox-probe.invalid/"))).stdout.trim(), "403");
  });

  it("opens a per-run domain for that run only", async () => {
    const probe = curl("http://genex-overlay-probe.invalid/");
    const opened = await inside(probe, { policy: { allowedDomains: ["genex-overlay-probe.invalid"] } });
    assert.equal(opened.stdout.trim(), "502", `the proxy let it through to DNS: ${opened.stderr}`);
    assert.equal((await inside(probe)).stdout.trim(), "403", "closed again after the run");
  });

  it("reaches an allowed registry over HTTPS with curl and with Node's fetch", async () => {
    const policy = { allowedDomains: ["registry.npmjs.org"] };
    const viaCurl = await inside(curl("https://registry.npmjs.org/left-pad"), { policy });
    assert.equal(viaCurl.stdout.trim(), "200", viaCurl.stderr);
    const viaNode = await inside(
      `node -e 'fetch("https://registry.npmjs.org/left-pad").then(r=>console.log(r.status),e=>console.log(e.cause?.code??e.message))'`,
      { policy },
    );
    assert.equal(viaNode.stdout.trim(), "200", viaNode.stderr);
  });

  it("reaches a host server through the proxy only when localhost is allowed", async () => {
    const server = await hostServer();
    try {
      const url = `http://localhost:${server.port}/`;
      assert.equal((await inside(curl(url), { policy: { allowedDomains: ["localhost"] } })).stdout.trim(), "200");
      assert.notEqual((await inside(curl(url))).stdout.trim(), "200", "not without the allowance");
      const direct = await inside(curl(`http://127.0.0.1:${server.port}/`, "--noproxy '*'"));
      assert.notEqual(direct.stdout.trim(), "200", "never around the proxy");
    } finally {
      await server.close();
    }
  });

  it("lets the host preview a server running inside the sandbox", async () => {
    const port = await freePort();
    const script = `require("http").createServer((q,s)=>s.end("inside-ok")).listen(${port},"127.0.0.1")`;
    const { child } = await sandbox.spawnLongLived({ command: `node -e ${q(script)}`, cwd: workspace });
    try {
      const deadline = Date.now() + HEARTBEAT_WAIT_MS;
      let body: string | undefined;
      while (!body && Date.now() < deadline) {
        body = await hostGet(`http://127.0.0.1:${port}/`);
        if (!body) await sleep(500);
      }
      assert.equal(body, "inside-ok");
    } finally {
      killChild(child);
    }
  });
});

/** Lines a heartbeat file has, 0 when it does not exist yet. */
async function beats(file: string): Promise<number> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).length;
}

/** Wait until `file` has at least `count` beats, or the wait runs out. */
async function beatsReach(file: string, count: number): Promise<number> {
  const deadline = Date.now() + HEARTBEAT_WAIT_MS;
  while ((await beats(file)) < count && Date.now() < deadline) await sleep(250);
  return beats(file);
}

describe("Windows sandbox: kill", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  /** A Node process in the workspace that appends a line to `name` five times a second. */
  const heartbeat = (name: string) =>
    `node -e 'const fs=require("fs");fs.writeFileSync("${name}.pid",String(process.pid));setInterval(()=>fs.appendFileSync("${name}", "b\\n"),200)'`;

  it("a timeout ends the whole tree", async () => {
    const file = path.join(workspace, "timeout.hb");
    const run = inside(`${heartbeat("timeout.hb")} & wait`, { timeoutMs: 6_000 });
    let observed: Awaited<ReturnType<typeof observeExit>> | undefined;
    try {
      assert.ok((await beatsReach(file, 3)) >= 3, "the heartbeat started");
      const pid = Number(await readFile(`${file}.pid`, "utf8"));
      observed = await observeExit(pid, { immediate: true });
      const result = await run;
      assert.equal(result.timedOut, true);
      // Broker pipe closure is not the child process's exit notification. Check the pinned
      // process immediately, before taking the file snapshot used to detect further writes.
      await observed.assertExited();
      const atKill = await beats(file);
      await sleep(KILL_SETTLE_MS);
      assert.equal(await beats(file), atKill, "nothing keeps beating after the kill");
    } finally {
      await run;
      await observed?.assertExited();
    }
  });

  it("killing a long-lived process ends its children", async () => {
    const file = path.join(workspace, "long.hb");
    const { child } = await sandbox.spawnLongLived({ command: `${heartbeat("long.hb")} & wait`, cwd: workspace });
    const exited = new Promise((resolve) => child.once("close", resolve));
    try {
      assert.ok((await beatsReach(file, 3)) >= 3, "the heartbeat started");
    } finally {
      killChild(child);
    }
    await exited;
    const atKill = await beats(file);
    await sleep(KILL_SETTLE_MS);
    assert.equal(await beats(file), atKill, "the grandchild went with it");
  });
});

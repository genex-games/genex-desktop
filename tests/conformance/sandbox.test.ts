/**
 * Sandbox conformance.
 *
 * These tests run the **real** Seatbelt sandbox (no mocks): if containment silently stopped
 * working, the studio would still look fine while an unattended self-improving agent gained the
 * run of the machine. So the suite asserts the boundary from both sides — permitted work
 * succeeds, forbidden work fails.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { NativeEnv, NativeError, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import {
  deviceToolDirs,
  mobileCredentialHomes,
  packagedDeviceTools,
  withoutDeviceTools,
} from "../../src/substrate/credential-homes.ts";
import {
  claudeFolderDenyWrites,
  closeDeviceBridges,
  phoneDenyRead,
  ProcessSandbox,
  shellQuote,
} from "../../src/substrate/spawn.ts";
import { cppShellEnv } from "../../src/substrate/engines/studio-tool-prompts.ts";
import { buildProbe, macClang, macClangSkip, probePipe, probeRunDir } from "../helpers/macho.ts";
import { running } from "../helpers/processes.ts";
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

  it("a command that exits without reading its stdin settles on its exit code, never a pipe error", async () => {
    // The child is gone before the host has written its input: the write fails EPIPE, which must
    // not fail the run (or the process) while the exit code and output still decide it.
    const unread = "x".repeat(4 * 1024 * 1024);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await sandbox.run({ command: "echo gone; exit 3", cwd: workspace, stdin: unread });
      assert.equal(result.code, 3, result.stderr);
      assert.equal(result.stdout, "gone\n");
    }
  });

  it("a run that asks for it (a C++ build) leaves nothing of its process group behind once it exits", async () => {
    // A build's CMake files are the agent's: a process one starts in the background must not
    // outlive the build and keep writing its folder while the host reads the output.
    const result = await sandbox.run({
      command: "sleep 30 & echo $!",
      cwd: workspace,
      reapGroup: true,
      timeoutMs: 20_000,
    });
    assert.equal(result.timedOut, false, "group cleanup, not the deadline, closes the inherited output pipes");
    assert.ok(result.durationMs < 10_000, `the background sleep ended with the run (${result.durationMs} ms)`);
    // Bubblewrap and Git Bash report PIDs in their own namespaces, not host PIDs. Never query
    // or signal them in the host. A live sleep retains the output pipes, so the timely close
    // above proves it ended; macOS also checks its actual host PID.
    if (process.platform !== StudioPlatform.Mac) return;
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1, result.stdout);
    for (let poll = 0; poll < 200 && running(pid); poll++) await sleep(10);
    const left = running(pid);
    if (left) process.kill(pid, "SIGKILL");
    assert.equal(left, false, "the background process ended with the run");
  });

  it("a build's descendant cannot leave its group with setsid(), so it ends with the run", {
    skip: process.platform !== "darwin" && "the group-leaving syscalls are denied in the Seatbelt profile (macOS)",
  }, async () => {
    // An agent's CMake files start a daemon in its own session: killing the build's group alone
    // missed it, and it kept writing the build's folder after the host read it.
    const survivor =
      'use POSIX; my $pid = fork(); if ($pid == 0) { POSIX::setsid(); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); sleep 30; exit 0; } print "$pid\\n";';
    const result = await sandbox.run({
      command: `/usr/bin/perl -e ${shellQuote(survivor)}`,
      cwd: workspace,
      reapGroup: true,
      timeoutMs: 20_000,
    });
    const pid = Number(result.stdout.trim().split("\n")[0]);
    assert.ok(Number.isSafeInteger(pid) && pid > 1, result.stdout + result.stderr);
    assert.ok(result.durationMs < 10_000, `the run resolved once the build exited (${result.durationMs} ms)`);
    for (let poll = 0; poll < 200 && running(pid); poll++) await sleep(10);
    const left = running(pid);
    if (left) process.kill(pid, "SIGKILL");
    assert.equal(left, false, "the setsid descendant ended with the run");
  });

  it("a run that does not reap its group keeps setsid(): an agent's own commands are unchanged", {
    skip: process.platform !== "darwin" && "macOS Seatbelt",
  }, async () => {
    const result = await sandbox.run({
      command: `/usr/bin/perl -e ${shellQuote("use POSIX; print POSIX::setsid() > 0 ? 'own session' : 'refused';")}`,
      cwd: workspace,
    });
    assert.equal(result.stdout.trim(), "own session", result.stderr);
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

/** A stand-in for adb or an emulator: what it accepted, and how to stop it. */
interface StandIn {
  accepted: () => number;
  close: () => Promise<void>;
}

/** Listen on `host`:`port` as a stand-in for adb or an emulator, counting what it accepts; null when it cannot bind. */
async function standIn(port: number, host: string): Promise<StandIn | null> {
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    socket.destroy();
  });
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
  if (!bound) return null;
  return { accepted: () => accepted, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * The adb server, the first emulator's console and adb ports, the last emulator port, and the
 * first and last emulator gRPC control ports.
 */
const BRIDGE_PORTS = [5037, 5554, 5555, 5585, 8554, 8585];
/** The loopback addresses a stand-in listens on: an IPv4 one, and the IPv6 one adb and the emulator may also use. */
const LOOPBACKS = [
  { host: "127.0.0.1", url: "127.0.0.1" },
  { host: "::1", url: "[::1]" },
] as const;
/** What a person who builds for phones keeps under the home folder, as fakes in a fake home. */
/**
 * Where the emulator writes its discovery files below the fake home: the Mac's temporary items, or
 * on Linux the `XDG_RUNTIME_DIR` {@link phoneSandbox} points into the fake home.
 */
const EMULATOR_RUNTIME = process.platform === "darwin" ? ["Library", "Caches", "TemporaryItems"] : ["xdg-runtime"];

const MOBILE_SECRETS = [
  [".android", "adbkey"],
  [".emulator_console_auth_token"],
  [".appstoreconnect", "private_keys", "AuthKey_C1TEST.p8"],
  ["private_keys", "AuthKey_C1TEST.p8"],
  [".private_keys", "AuthKey_C1TEST.p8"],
  ["Library", "MobileDevice", "Provisioning Profiles", "c1-test.mobileprovision"],
  ["Library", "Developer", "Xcode", "UserData", "Provisioning Profiles", "c1-test.mobileprovision"],
  // The emulator's discovery file: its gRPC port and the token that endpoint accepts.
  [...EMULATOR_RUNTIME, "avd", "running", "pid_1.ini"],
  [".gradle", "gradle.properties"],
  [".cargo", "credentials.toml"],
  [".cargo", "credentials"],
];

/** A fake home with every {@link MOBILE_SECRETS} file, cargo's own config and an SDK holding adb and the emulator. */
async function fakePhoneHome(): Promise<{ home: string; sdk: string; work: string }> {
  const home = await realpath(await tmpDir("studio-sandbox-c1-home-"));
  const sdk = path.join(home, "sdk");
  const work = path.join(home, "Pat's game");
  for (const parts of [...MOBILE_SECRETS, [".cargo", "config.toml"]]) {
    await mkdir(path.join(home, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(path.join(home, ...parts), "c1-fake-secret\n");
  }
  for (const tool of [path.join("platform-tools", "adb"), path.join("emulator", "emulator")]) {
    await mkdir(path.dirname(path.join(sdk, tool)), { recursive: true });
    await writeFile(path.join(sdk, tool), "#!/bin/sh\necho device-tool-ran\n", { mode: 0o755 });
  }
  await mkdir(work, { recursive: true });
  return { home, sdk, work };
}

/**
 * A sandbox made while HOME, ANDROID_HOME and XDG_RUNTIME_DIR name the fake ones (its deny lists
 * follow them as they are then), whose PATH floor puts the SDK's device tools first.
 */
async function phoneSandbox(fake: { home: string; sdk: string; work: string }): Promise<ProcessSandbox> {
  const saved = {
    HOME: process.env.HOME,
    ANDROID_HOME: process.env.ANDROID_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  };
  process.env.HOME = fake.home;
  process.env.ANDROID_HOME = fake.sdk;
  // Linux: the emulator's discovery folder follows XDG_RUNTIME_DIR (unused on a Mac).
  process.env.XDG_RUNTIME_DIR = path.join(fake.home, "xdg-runtime");
  try {
    const tools = [path.join(fake.sdk, "platform-tools"), path.join(fake.sdk, "emulator")];
    return await ProcessSandbox.create({
      writableRoots: [fake.work],
      scratchDir: path.join(fake.home, "scratch"),
      secretPaths: [],
      toolPath: async () => [...tools, "/usr/bin", "/bin"].join(":"),
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** A stand-in's address as a URL host and port, e.g. `[::1]:5037`. */
type BridgeAddress = `${(typeof LOOPBACKS)[number]["url"]}:${number}`;

/**
 * Stand-ins on every bridge port, on each loopback address, that is free here; a taken port (or an
 * IPv6 loopback this machine lacks) is reported and left unmeasured.
 */
async function bridgeStandIns(t: TestContext): Promise<Map<BridgeAddress, StandIn>> {
  const listeners = new Map<BridgeAddress, StandIn>();
  for (const port of BRIDGE_PORTS)
    for (const loopback of LOOPBACKS) {
      const listener = await standIn(port, loopback.host);
      if (listener) listeners.set(`${loopback.url}:${port}`, listener);
      else t.diagnostic(`${loopback.host} port ${port} cannot be listened on here: its row is not measured`);
    }
  return listeners;
}

/**
 * One command from `agent` that tries every stand-in's port by address and by name, then a preview
 * server on localhost: no stand-in accepts anything, and on macOS the preview still answers.
 */
async function assertBridgesClosed(t: TestContext, agent: ProcessSandbox, cwd: string): Promise<void> {
  const listeners = await bridgeStandIns(t);
  if (listeners.size === 0) return t.skip("every bridge port is in use on this machine");
  const preview = http.createServer((_request, response) => response.end("preview"));
  await new Promise<void>((resolve) => preview.listen(0, "127.0.0.1", resolve));
  try {
    const previewPort = (preview.address() as { port: number }).port;
    // By address (the IPv6 stand-in proves the ::1 deny: nothing else listens there), and by name.
    const probes = [...listeners.keys()].flatMap((address) => [
      `curl -s -m 3 -o /dev/null http://${address}/; echo "bridge ${address} curl=$?"`,
      `curl -s -m 3 -o /dev/null http://localhost:${address.slice(address.lastIndexOf(":") + 1)}/; echo "bridge ${address} curl=$?"`,
    ]);
    const command = [...probes, `curl -s -m 5 http://127.0.0.1:${previewPort}/; echo`].join("; ");
    const result = await agent.run({ command, cwd, timeoutMs: 45_000 });
    for (const [address, listener] of listeners)
      assert.equal(listener.accepted(), 0, `an agent command reached ${address}: ${result.stdout}`);
    // Linux runs the command in its own network namespace: the host's loopback (the preview too)
    // is out of reach by design there, so only macOS can show the preview still reached.
    if (process.platform === "darwin") assert.match(result.stdout, /^preview$/m, result.stderr);
  } finally {
    for (const listener of listeners.values()) await listener.close();
    preview.closeAllConnections();
    await new Promise<void>((resolve) => preview.close(() => resolve()));
  }
}

/**
 * C1 stage-1 containment, measured open for agent commands in M0b.2: an agent command reached the
 * adb server's port and the emulator ports on loopback, listed `~/.android` and could find adb.
 * No agent drives a device: the bridges are refused, the mobile credential homes unreadable and
 * the device tools unreachable, while a preview server on localhost stays reachable. Windows has
 * no adb rule in stage 1.
 */
describe("C1: device bridges and mobile credentials are out of an agent's reach", {
  skip: process.platform === "win32" && "stage 1 has no adb rule on Windows",
}, () => {
  let fake: { home: string; sdk: string; work: string };
  /** A sandbox over a fake home, writing a folder with an apostrophe (`'"'"'` inside the quoted profile). */
  let mobile: ProcessSandbox;

  before(async () => {
    fake = await fakePhoneHome();
    mobile = await phoneSandbox(fake);
  });

  it("refuses the adb server port and the emulator ports, and still reaches a preview server on localhost", {
    timeout: 60_000,
  }, async (t) => {
    await assertBridgesClosed(t, sandbox, workspace);
  });

  it("closes the bridges as well for a sandbox writing a folder with an apostrophe", { timeout: 60_000 }, async (t) => {
    await assertBridgesClosed(t, mobile, fake.work);
  });

  it("cannot read the mobile credential homes, and still reads the rest of the home folder it may", async () => {
    const reads = MOBILE_SECRETS.map(
      (parts) =>
        `cat ${shellQuote(path.join(fake.home, ...parts))} >/dev/null 2>&1 && echo ${shellQuote(`read ${parts.join("/")}`)}`,
    );
    const result = await mobile.run({
      command: [...reads, `cat ${shellQuote(path.join(fake.home, ".cargo", "config.toml"))}`].join("; "),
      cwd: fake.work,
    });
    assert.equal(result.sandboxed, true);
    assert.doesNotMatch(result.stdout, /^read /m, "a mobile credential was readable");
    assert.match(result.stdout, /c1-fake-secret/, `cargo's own config stays readable: ${result.stderr}`);
  });

  it("never finds adb or the emulator on PATH, the toolchain's or the caller's own, nor runs them by path", async () => {
    const lookups = [
      "command -v adb || echo no-adb",
      "command -v emulator || echo no-emulator",
      `${shellQuote(path.join(fake.sdk, "platform-tools", "adb"))} 2>/dev/null || echo adb-refused`,
      `${shellQuote(path.join(fake.sdk, "emulator", "emulator"))} 2>/dev/null || echo emulator-refused`,
    ].join("; ");
    const floor = await mobile.run({ command: lookups, cwd: fake.work });
    assert.deepEqual(floor.stdout.trim().split("\n"), ["no-adb", "no-emulator", "adb-refused", "emulator-refused"]);
    const own = await mobile.run({
      command: "command -v adb || echo no-adb",
      cwd: fake.work,
      env: { PATH: [path.join(fake.sdk, "platform-tools"), "/usr/bin", "/bin"].join(":") },
    });
    assert.equal(own.stdout.trim(), "no-adb", "a caller's own PATH loses the device tools too");
  });

  // A read deny stops a script, not a compiled program: exec maps a Mach-O without a file read.
  it("never starts a compiled device tool by path, nor through a link to it in another PATH folder", {
    skip: macClangSkip(),
  }, async () => {
    const source = path.join(fake.home, "device-tool.c");
    await writeFile(source, '#include <stdio.h>\nint main(void) { puts("device-tool-ran"); return 0; }\n');
    const adb = path.join(fake.sdk, "platform-tools", "adb-compiled");
    await macClang([source, "-o", adb]);
    // Where a package manager links adb (Homebrew's bin): a folder the PATH keeps.
    const bin = path.join(fake.home, "bin");
    await mkdir(bin, { recursive: true });
    await symlink(adb, path.join(bin, "adb"));
    const command = [
      `${shellQuote(adb)} || echo by-path-refused`,
      `${shellQuote(path.join(bin, "adb"))} || echo by-link-refused`,
      `PATH=${shellQuote(bin)}:/usr/bin:/bin adb || echo on-path-refused`,
    ].join("; ");
    const result = await mobile.run({ command, cwd: fake.work });
    assert.doesNotMatch(result.stdout, /device-tool-ran/, "a compiled device tool started");
    assert.deepEqual(result.stdout.trim().split("\n"), ["by-path-refused", "by-link-refused", "on-path-refused"]);
  });
});

/**
 * The C1 rules' own edges, without a sandbox: the bridge rules refuse a profile they cannot place
 * (a changed sandbox-runtime runs nothing rather than leave the bridges open), and the phone deny
 * lists follow the environment without ever taking the home folder away.
 */
describe("C1: where the bridge rules go, and the phone deny lists", () => {
  const GRANT = '(allow network-outbound (remote ip "localhost:*"))';
  const wrapped = (profile: string) => [
    "/bin/bash",
    "-c",
    `env A=1 /usr/bin/sandbox-exec -p ${profile} /bin/bash -c 'echo hi'`,
  ];
  const UNPLACEABLE: Array<{ name: string; argv: string[]; loopback: boolean }> = [
    { name: "no sandbox-exec at all", argv: ["/bin/sh", "-c", "echo hi"], loopback: true },
    { name: "an unquoted profile", argv: wrapped(`(version 1) ${GRANT}`), loopback: true },
    { name: "a double-quoted profile", argv: wrapped(`"(version 1)\n${GRANT}"`), loopback: true },
    { name: "a profile with no version head", argv: wrapped(`'(deny default)\n${GRANT}'`), loopback: true },
    {
      name: "local binding without the loopback grant",
      argv: wrapped("'(version 1)\n(deny default)'"),
      loopback: true,
    },
    {
      name: "a grant spelled differently",
      argv: wrapped(`'(version 1)\n(allow network-outbound (remote ip "localhost:*") )'`),
      loopback: true,
    },
  ];
  for (const row of UNPLACEABLE)
    it(`refuses ${row.name}`, () => {
      assert.throws(() => closeDeviceBridges(row.argv, row.loopback), /closes the device bridges/);
    });

  // The command after the profile is the agent's: its text proves nothing about the profile.
  it("refuses a profile without the grant even when the command text holds it, and never rewrites the command", () => {
    const command = (profile: string) => [
      "/bin/bash",
      "-c",
      `/usr/bin/sandbox-exec -p ${profile} /bin/bash -c 'echo ${GRANT}'`,
    ];
    assert.throws(
      () => closeDeviceBridges(command("'(version 1)\n(deny default)'"), true),
      /closes the device bridges/,
    );
    const closed = closeDeviceBridges(command(`'(version 1)\n${GRANT}'`), true);
    assert.ok(closed[2]?.endsWith(`/bin/bash -c 'echo ${GRANT}'`), "the command text is left as the agent wrote it");
  });

  it("a run without local binding needs no loopback grant: the bridges still close under Seatbelt", {
    skip: process.platform !== "darwin" && "Seatbelt is macOS's",
    timeout: 30_000,
  }, async (t) => {
    const listeners = await bridgeStandIns(t);
    if (listeners.size === 0) return t.skip("every bridge port is in use on this machine");
    try {
      const probes = [...listeners.keys()].map((address) => `curl -s -m 3 -o /dev/null http://${address}/`);
      const argv = [
        "/bin/bash",
        "-c",
        `/usr/bin/sandbox-exec -p '(version 1)\n(allow default)' /bin/bash -c '${probes.join("; ")}; echo probed'`,
      ];
      const closed = closeDeviceBridges(argv, false);
      const ran = await promisify(execFile)(closed[0] ?? "", closed.slice(1), { encoding: "utf8", timeout: 25_000 });
      assert.match(ran.stdout, /^probed$/m, ran.stderr);
      for (const [address, listener] of listeners)
        assert.equal(listener.accepted(), 0, `a command under the closed profile reached ${address}`);
    } finally {
      for (const listener of listeners.values()) await listener.close();
    }
  });

  // Resolved: on Windows a rooted path gains the current drive, as the lists resolve theirs.
  const HOME = path.resolve("/home/player");
  const at = (...parts: string[]) => path.resolve(...parts);
  it("phone homes follow the environment and never take the home folder or a relative path", () => {
    const moved = mobileCredentialHomes(
      { ANDROID_USER_HOME: at("/data/android"), CARGO_HOME: "/data/cargo", GRADLE_USER_HOME: "/data/gradle" },
      HOME,
      "linux",
    );
    // Flipped (C1 review): a moved CARGO_HOME no longer frees the default home's tokens.
    for (const expected of [
      at("/data/android"),
      at("/data/cargo/credentials"),
      at("/data/cargo/credentials.toml"),
      at("/data/gradle/gradle.properties"),
      path.join(HOME, ".android"),
      path.join(HOME, ".gradle"),
      path.join(HOME, ".cargo", "credentials"),
      path.join(HOME, ".cargo", "credentials.toml"),
    ])
      assert.ok(moved.includes(expected), expected);
    const discovery = mobileCredentialHomes({ XDG_RUNTIME_DIR: "/run/user/501" }, HOME, "linux");
    assert.ok(discovery.includes(at("/run/user/501/avd")), "the emulator's Linux discovery folder");
    for (const hostile of [HOME, "/home", "/", "relative/android", ""]) {
      const homes = mobileCredentialHomes(
        { ANDROID_USER_HOME: hostile, ANDROID_EMULATOR_HOME: hostile },
        HOME,
        "linux",
      );
      assert.ok(
        !homes.includes(HOME) && !homes.includes(at("/")) && !homes.includes(at("/home")),
        JSON.stringify(hostile),
      );
      assert.ok(
        homes.every((p) => path.isAbsolute(p)),
        JSON.stringify(hostile),
      );
    }
  });

  it("an agent's deny list has the phone homes and device tools; Windows gets only the ones that exist", () => {
    const mac = phoneDenyRead(HOME, "darwin", {});
    for (const parts of [
      [".android"],
      ["Library", "MobileDevice"],
      ["Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"],
      [".private_keys"],
      ["Library", "Caches", "TemporaryItems", "avd"],
      ["Library", "Android", "sdk", "platform-tools"],
    ])
      assert.ok(mac.includes(path.join(HOME, ...parts)), parts.join("/"));
    for (const cask of packagedDeviceTools("darwin")) assert.ok(mac.includes(cask), cask);
    assert.ok(packagedDeviceTools("darwin").includes("/opt/homebrew/Caskroom/android-platform-tools"));
    assert.deepEqual(packagedDeviceTools("linux"), []);
    assert.ok(!mobileCredentialHomes({}, HOME, "win32").includes(path.join(HOME, "Library", "MobileDevice")));
    assert.deepEqual(phoneDenyRead(HOME, "win32", {}), [], "nothing exists under a made-up home");
  });

  it("Windows denies everything inside the device-tool folders, and no deny's parent is the SDK root", async () => {
    // srt-win puts an inheritable deny on each target's parent and rewrites that parent's ACL for
    // every target, which walks the parent's whole tree. With the tool folders themselves denied,
    // the parent was the SDK root (about 190,000 entries on GitHub's Windows runner): 161 s for
    // platform-tools alone, past srt-win's 60 s limit, on every sandbox start (seen on a CI run).
    const home = await tmpDir("phone-deny-win-");
    const sdk = path.join(home, "sdk");
    const files = [
      ["platform-tools", "adb.exe"],
      ["platform-tools", "AdbWinApi.dll"],
      ["emulator", "emulator.exe"],
      ["emulator", "NOTICE.txt"],
      ["emulator", "lib64", "vulkan", "vulkan-1.dll"],
      ["emulator", "qemu", "windows-x86_64", "qemu-system-x86_64.exe"],
      ["ndk", "27.0", "source.properties"],
    ];
    for (const parts of files) {
      await mkdir(path.join(sdk, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(path.join(sdk, ...parts), "x");
    }
    const denied = phoneDenyRead(home, "win32", { ANDROID_HOME: sdk });
    const covered = (file: string) => denied.some((deny) => file === deny || file.startsWith(deny + path.sep));
    for (const parts of files.filter(([folder]) => folder !== "ndk"))
      assert.ok(covered(path.join(sdk, ...parts)), parts.join("/"));
    assert.ok(!covered(path.join(sdk, "ndk", "27.0", "source.properties")), "builds keep the NDK");
    for (const deny of denied) assert.notEqual(path.dirname(deny), sdk, deny);
    assert.ok(phoneDenyRead(home, "darwin", { ANDROID_HOME: sdk }).includes(path.join(sdk, "emulator")));
  });

  it("Windows denies an empty device-tool folder itself, so a tool added later is still denied", async () => {
    const home = await tmpDir("phone-deny-win-empty-");
    const sdk = path.join(home, "sdk");
    await mkdir(path.join(sdk, "platform-tools"), { recursive: true });
    assert.deepEqual(phoneDenyRead(home, "win32", { ANDROID_HOME: sdk }), [path.join(sdk, "platform-tools")]);
  });

  it("the device-tool folders are in every SDK the machine names and the platform's default one", () => {
    assert.deepEqual(deviceToolDirs({}, HOME, "darwin"), [
      path.join(HOME, "Library", "Android", "sdk", "platform-tools"),
      path.join(HOME, "Library", "Android", "sdk", "emulator"),
    ]);
    const named = deviceToolDirs({ ANDROID_HOME: "/opt/sdk", ANDROID_SDK_ROOT: HOME }, HOME, "linux");
    assert.ok(named.includes(at("/opt/sdk/platform-tools")) && named.includes(at("/opt/sdk/emulator")));
    assert.ok(named.includes(path.join(HOME, "Android", "Sdk", "platform-tools")));
    assert.ok(!named.includes(path.join(HOME, "platform-tools")), "an SDK root at the home folder is ignored");
  });

  it("a C++ session's shell PATH keeps the lock's tools first and loses the device tools", () => {
    const session = {
      store: "/store",
      path: ["/store/cmake/bin"],
      env: { GENEX_CMAKE: "/store/genex.cmake" },
      commandTimeoutMs: 1,
    };
    const env = cppShellEnv(
      session,
      ["/opt/sdk/platform-tools", "/usr/bin", "/opt/sdk/emulator"].join(path.delimiter),
      ["/opt/sdk/emulator"],
    );
    assert.equal(env.PATH, ["/store/cmake/bin", "/usr/bin"].join(path.delimiter));
    assert.equal(env.GENEX_CMAKE, "/store/genex.cmake");
  });

  it("a PATH loses every platform-tools folder and the named device-tool folders, and keeps the rest", () => {
    const tools = ["/opt/sdk/platform-tools", "/opt/sdk/emulator"];
    const value = [
      "/usr/bin",
      "/opt/sdk/platform-tools",
      "/elsewhere/Platform-Tools",
      "/opt/sdk/emulator/",
      // A custom SDK nobody named to Studio: its emulator folder goes by name as platform-tools does.
      "/custom/sdk/Emulator",
      "",
      "/bin",
    ];
    assert.equal(withoutDeviceTools(value.join(":"), tools, ":"), ["/usr/bin", "", "/bin"].join(":"));
    assert.equal(withoutDeviceTools("/usr/bin:/bin", tools, ":"), "/usr/bin:/bin");
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

/**
 * The game box: `spawnGame` starts one assembled bundle under its host-written game profile, in a
 * process group of its own, with fd 3 as the protocol pipe and nothing of the studio's environment.
 * Where the host has no game box, or the request names a run directory it does not own, nothing is
 * written and nothing starts.
 */
describe("ProcessSandbox.spawnGame", () => {
  /** A sandbox whose game box is `platform`'s, over a fresh native-runs root. */
  async function gameBox(platform: NodeJS.Platform = process.platform) {
    const base = await tmpDir("studio-game-box-");
    const runs = path.join(base, "native-runs");
    await mkdir(runs, { mode: 0o700 });
    const box = await ProcessSandbox.create({
      writableRoots: [],
      scratchDir: path.join(base, "scratch"),
      secretPaths: [],
      enabled: false,
      platform,
      nativeRunsRoot: runs,
    });
    return { base, runs, box };
  }

  /** A run directory under `runs` holding a stand-in executable (never started by these rows). */
  async function standIn(runs: string, runId = "0123456789abcdef") {
    const runDir = path.join(runs, runId);
    const bundle = path.join(runDir, "bundle");
    const exe = path.join(bundle, "Game.app", "Contents", "MacOS", "game");
    const state = path.join(runDir, "state");
    await mkdir(path.dirname(exe), { recursive: true });
    await mkdir(state);
    await writeFile(exe, '#!/bin/sh\ntouch "$GENEX_STATE_DIR/started"\n', { mode: 0o755 });
    return { runId, runDir, bundle, exe, state, mode: NativeRunMode.Headless, nonce: "a1b2c3d4" };
  }

  /** Every entry under `dir`, with a regular file's bytes and a link's target: what a refusal must leave as it was. */
  async function tree(dir: string): Promise<string[]> {
    const listed: string[] = [];
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath, entry.name);
      const info = await lstat(full);
      let what = "/";
      if (info.isSymbolicLink()) what = `-> ${await readlink(full)}`;
      else if (info.isFile()) what = await readFile(full, "utf8");
      listed.push(`${path.relative(dir, full)} ${what}`);
    }
    return listed.sort();
  }

  const refusedAs = (refusal: NativeRefusal) => (error: unknown) =>
    error instanceof NativeError && error.refusal === refusal;

  /** A second run dir under `runs` whose `bundle` is a link to `target` (absolute, or relative to the run dir). */
  async function linkedBundle(good: Awaited<ReturnType<typeof standIn>>, runs: string, target: string) {
    const runId = "aaaabbbbccccdddd";
    const runDir = path.join(runs, runId);
    const state = path.join(runDir, "state");
    await mkdir(state, { recursive: true });
    if (!path.isAbsolute(target)) {
      await mkdir(path.join(runDir, target, "Game.app", "Contents", "MacOS"), { recursive: true });
      await writeFile(path.join(runDir, target, "Game.app", "Contents", "MacOS", "game"), "x", { mode: 0o755 });
    }
    const bundle = path.join(runDir, "bundle");
    await symlink(target, bundle);
    return { ...good, runId, runDir, bundle, state, exe: path.join(bundle, "Game.app", "Contents", "MacOS", "game") };
  }

  it("has a game box on a Mac and nowhere else yet", async () => {
    assert.equal((await gameBox(StudioPlatform.Mac)).box.gameBoxAvailable(), true);
    assert.equal((await gameBox(StudioPlatform.Linux)).box.gameBoxAvailable(), false);
    assert.equal((await gameBox(StudioPlatform.Windows)).box.gameBoxAvailable(), false);
  });

  it("on Linux refuses no-game-box, and writes and starts nothing", {
    skip: process.platform === "win32" && "POSIX paths",
  }, async () => {
    const { base, runs, box } = await gameBox(StudioPlatform.Linux);
    const request = await standIn(runs);
    const before = await tree(base);
    await assert.rejects(box.spawnGame(request), refusedAs(NativeRefusal.NoGameBox));
    assert.deepEqual(await tree(base), before, "no profile, no home, no start marker");
  });

  /** Requests a game box must refuse before it writes a profile, each built from a good one. */
  const hostile: Array<{
    name: string;
    refusal: NativeRefusal;
    make(good: Awaited<ReturnType<typeof standIn>>, runs: string, base: string): Promise<Record<string, unknown>>;
  }> = [
    {
      name: "a run dir outside the native-runs root",
      refusal: NativeRefusal.Unsupported,
      async make(good, _runs, base) {
        const elsewhere = path.join(base, "elsewhere", good.runId);
        await mkdir(path.join(elsewhere, "bundle", "Game.app", "Contents", "MacOS"), { recursive: true });
        await mkdir(path.join(elsewhere, "state"));
        await writeFile(path.join(elsewhere, "bundle", "Game.app", "Contents", "MacOS", "game"), "x");
        return {
          ...good,
          runDir: elsewhere,
          bundle: path.join(elsewhere, "bundle"),
          state: path.join(elsewhere, "state"),
          exe: path.join(elsewhere, "bundle", "Game.app", "Contents", "MacOS", "game"),
        };
      },
    },
    {
      name: "the native-runs root itself",
      refusal: NativeRefusal.Unsupported,
      async make(good, runs) {
        return { ...good, runDir: runs };
      },
    },
    {
      name: "a run dir one level too deep",
      refusal: NativeRefusal.Unsupported,
      async make(good, runs) {
        return { ...good, runDir: path.join(runs, "nested", good.runId) };
      },
    },
    {
      name: "a run id that climbs out",
      refusal: NativeRefusal.Unsupported,
      async make(good, runs) {
        return { ...good, runId: "../x", runDir: path.join(runs, "../x") };
      },
    },
    {
      name: "a run dir that is a link to a folder outside",
      refusal: NativeRefusal.Unsupported,
      async make(good, runs, base) {
        const outside = path.join(base, "outside-run");
        await mkdir(outside);
        const linked = path.join(runs, "fedcba9876543210");
        await symlink(outside, linked);
        return { ...good, runId: "fedcba9876543210", runDir: linked };
      },
    },
    {
      name: "an exe outside the bundle",
      refusal: NativeRefusal.Unsupported,
      async make(good) {
        const exe = path.join(good.state, "game");
        await writeFile(exe, "x", { mode: 0o755 });
        return { ...good, exe };
      },
    },
    {
      name: "an exe that is a link to a system program",
      refusal: NativeRefusal.Unsupported,
      async make(good) {
        const exe = path.join(path.dirname(good.exe), "shell");
        await symlink("/bin/sh", exe);
        return { ...good, exe };
      },
    },
    {
      name: "a state folder outside the run dir",
      refusal: NativeRefusal.Unsupported,
      async make(good, _runs, base) {
        return { ...good, state: base };
      },
    },
    {
      name: "a bundle that is a link to a folder outside",
      refusal: NativeRefusal.Unsupported,
      async make(good, runs, base) {
        const outside = path.join(base, "outside-bundle");
        await mkdir(path.join(outside, "Game.app", "Contents", "MacOS"), { recursive: true });
        await writeFile(path.join(outside, "Game.app", "Contents", "MacOS", "game"), "x", { mode: 0o755 });
        return linkedBundle(good, runs, outside);
      },
    },
    {
      name: "a bundle that is a link to the run's own state",
      refusal: NativeRefusal.Unsupported,
      async make(good, runs) {
        return linkedBundle(good, runs, "state");
      },
    },
    {
      name: "a state/home planted as a link to a folder outside",
      refusal: NativeRefusal.Unsupported,
      async make(good, _runs, base) {
        await mkdir(path.join(base, "outside-home"));
        await symlink(path.join(base, "outside-home"), path.join(good.state, "home"));
        return good;
      },
    },
    {
      name: "a state/home planted as a file",
      refusal: NativeRefusal.Unsupported,
      async make(good) {
        await writeFile(path.join(good.state, "home"), "not a folder");
        return good;
      },
    },
    {
      name: "a profile.sb planted as a link to a file outside",
      refusal: NativeRefusal.Unsupported,
      async make(good, _runs, base) {
        await writeFile(path.join(base, "outside.sb"), "(version 1)(allow default)");
        await symlink(path.join(base, "outside.sb"), path.join(good.runDir, "profile.sb"));
        return good;
      },
    },
    {
      name: "a profile.sb planted as a dangling link",
      refusal: NativeRefusal.Unsupported,
      async make(good, _runs, base) {
        await symlink(path.join(base, "not-yet.sb"), path.join(good.runDir, "profile.sb"));
        return good;
      },
    },
    {
      name: "an exe that is another regular file in the bundle",
      refusal: NativeRefusal.Unsupported,
      async make(good) {
        const exe = path.join(good.bundle, "Game.app", "Contents", "Resources", "helper");
        await mkdir(path.dirname(exe), { recursive: true });
        await writeFile(exe, "x", { mode: 0o755 });
        return { ...good, exe };
      },
    },
    {
      name: "an embedded run",
      refusal: NativeRefusal.Unsupported,
      async make(good) {
        return { ...good, mode: NativeRunMode.Embedded };
      },
    },
    {
      name: "a nonce with a newline",
      refusal: NativeRefusal.Unsupported,
      async make(good) {
        return { ...good, nonce: "a1b2\nGENEX_STATE_DIR=/" };
      },
    },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name}, writing and starting nothing`, {
      skip: process.platform === "win32" && "POSIX links",
    }, async () => {
      const { base, runs, box } = await gameBox(StudioPlatform.Mac);
      const request = await row.make(await standIn(runs), runs, base);
      const before = await tree(base);
      await assert.rejects(box.spawnGame(request as never), refusedAs(row.refusal));
      assert.deepEqual(await tree(base), before);
    });
  }

  it("refuses a second start of the same run dir: its profile is written once", {
    skip: process.platform === "win32" && "POSIX",
  }, async () => {
    const { runs, box } = await gameBox(StudioPlatform.Mac);
    const request = await standIn(runs);
    await writeFile(path.join(request.runDir, "profile.sb"), "(version 1)(allow default)");
    await assert.rejects(box.spawnGame(request), refusedAs(NativeRefusal.Unsupported));
    assert.equal(await readFile(path.join(request.runDir, "profile.sb"), "utf8"), "(version 1)(allow default)");
  });

  describe("a started game (darwin)", { skip: macClangSkip() }, () => {
    let probe: string;
    before(async () => {
      probe = await buildProbe(await tmpDir("studio-game-probe-"));
    });

    it("gets four stdio slots, fd 3 a pipe, its own process group and exactly the native environment", {
      timeout: 60_000,
    }, async () => {
      const { runs, box } = await gameBox();
      const run = await probeRunDir(runs, probe);
      const child = await box.spawnGame({ ...run, mode: NativeRunMode.Headless, nonce: "a1b2c3d4" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const pipe = probePipe(child.fd3);
      assert.deepEqual(await pipe.ask("echo fd3"), { echo: "fd3" });
      const self = await pipe.ask("self");
      assert.equal(self.pid, child.pid);
      assert.equal(self.pgid, child.pid, "the game leads its own process group");
      assert.equal(self.stdin, "char-device", "stdin is /dev/null");
      const state = await realpath(run.state);
      const env = ((await pipe.ask("env")).env as string[]).sort();
      assert.deepEqual(
        env,
        [
          `${NativeEnv.AnglePlatform}=metal`,
          `${NativeEnv.StudioFd}=3`,
          `${NativeEnv.Nonce}=a1b2c3d4`,
          `${NativeEnv.StateDir}=${state}`,
          `${NativeEnv.Home}=${path.join(state, "home")}`,
        ].sort(),
      );
      void pipe.ask("exit 0").catch(() => {});
      assert.deepEqual(await child.exited, { code: 0, signal: null });
      assert.equal(stdout, "probe stdout\n");
      assert.equal(stderr, "probe stderr\n");
      const profile = await stat(path.join(run.runDir, "profile.sb"));
      assert.equal(profile.mode & 0o777, 0o600, "the profile is the host's alone");
      assert.equal((await stat(run.runDir)).mode & 0o777, 0o700);
      await box.dispose();
    });

    it("dispose kills a running game's whole group", { timeout: 60_000 }, async () => {
      const { runs, box } = await gameBox();
      const run = await probeRunDir(runs, probe);
      const child = await box.spawnGame({ ...run, mode: NativeRunMode.Headless, nonce: "a1b2c3d4" });
      assert.deepEqual(await probePipe(child.fd3).ask("echo alive"), { echo: "alive" });
      await box.dispose();
      assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
      assert.equal(running(child.pid), false);
    });

    it("kill after the game has exited signals nothing: its pid may be another process's by then", {
      timeout: 60_000,
    }, async (t) => {
      const { runs, box } = await gameBox();
      const run = await probeRunDir(runs, probe);
      const child = await box.spawnGame({ ...run, mode: NativeRunMode.Headless, nonce: "a1b2c3d4" });
      void probePipe(child.fd3)
        .ask("exit 0")
        .catch(() => {});
      assert.deepEqual(await child.exited, { code: 0, signal: null });
      const kill = t.mock.method(process, "kill", () => true);
      try {
        child.kill("SIGTERM");
        child.kill("SIGKILL");
        assert.equal(kill.mock.callCount(), 0, "no signal sent after the reap");
      } finally {
        kill.mock.restore();
      }
      await box.dispose();
    });

    it("kill(signal) reaches the game's group", { timeout: 60_000 }, async () => {
      const { runs, box } = await gameBox();
      const run = await probeRunDir(runs, probe);
      const child = await box.spawnGame({ ...run, mode: NativeRunMode.Headless, nonce: "a1b2c3d4" });
      assert.deepEqual(await probePipe(child.fd3).ask("echo alive"), { echo: "alive" });
      child.kill("SIGTERM");
      assert.deepEqual(await child.exited, { code: null, signal: "SIGTERM" });
      await box.dispose();
    });
  });
});

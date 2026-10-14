/**
 * The Seatbelt profile a native job runs under, proven from inside the sandbox with real
 * processes (GPX-1, GPX-2): a job may signal only itself, may start only programs from its
 * runtime's own folder, and leaves nothing running once Studio has recorded its end — not even a
 * descendant that started its own session. Output delivery never follows a link. An embedded
 * game's profile reaches exactly one frames service: its own run's.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { NativeEnv, NativeRunMode } from "../../src/shared/native-contract.ts";
import {
  GameProfileParam,
  gameProfileDefines,
  gameSandboxProfile,
  SANDBOX_EXEC,
} from "../../src/substrate/game-sandbox-profile.ts";
import { copyDeclaredOutput, copyRuntimeTree } from "../../src/substrate/plugins/native.ts";
import { nativeSandboxProfile, runNativeProcess } from "../../src/substrate/plugins/native-process.ts";
import { macClangSkip, type ProbeRunDir, probeRunDir } from "../helpers/macho.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long the cancel test waits for its job to fork: polls of POLL_MS each. */
const MARKER_POLLS = 1000;
const POLL_MS = 10;
/** Long enough that a cancel, never the timeout, ends the cancelled job. */
const CANCELLED_JOB_TIMEOUT_MS = 20_000;

const darwin = process.platform === "darwin";

async function job(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; root?: string } = {},
) {
  const root = options.root ?? (await tmpDir("native-sandbox-"));
  const output = path.join(root, "output"),
    scratch = path.join(root, "scratch");
  await mkdir(output);
  await mkdir(scratch);
  const started = Date.now();
  const result = await runNativeProcess({
    binary,
    args,
    cwd: root,
    scratch,
    reads: [],
    writes: [output],
    denyRead: [],
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 5000,
    maxOutputBytes: 16000,
  });
  return { ...result, root, output, ms: Date.now() - started };
}

describe("native job sandbox profile", { skip: !darwin && "Seatbelt is macOS-only" }, () => {
  it("names what a job may do instead of granting whole operation classes", () => {
    const profile = nativeSandboxProfile({
      binaryRoot: "/Applications/Tool.app",
      reads: ["/r"],
      writes: ["/w"],
      denied: ["/d"],
      gpu: false,
    });
    const rules = profile.split("\n");
    for (const broad of ["(allow process*)", "(allow signal)", "(allow mach-lookup)"])
      assert.ok(!rules.includes(broad), `${broad} is not granted`);
    assert.ok(
      rules.includes('(allow process-exec (subpath "/Applications/Tool.app"))'),
      "exec is limited to the runtime's folder",
    );
    assert.ok(rules.includes("(allow signal (target self))"));
    assert.ok(
      !rules.some((rule) => /launchservices|lsd\.|pasteboard/i.test(rule)),
      "nothing that launches or lists apps, or reads the clipboard",
    );
    const gpu = nativeSandboxProfile({
      binaryRoot: "/Applications/Tool.app",
      reads: [],
      writes: [],
      denied: [],
      gpu: true,
    }).split("\n");
    assert.ok(!gpu.includes("(allow signal)") && !gpu.includes("(allow process*)"));
    // Flipped deliberately: AppKit's RegisterApplication needs LaunchServices check-in,
    // so a GPU render may reach it; opening other apps, the pasteboard, screen capture and the
    // Dock stay refused.
    const deniedMach = gpu.find((rule) => rule.startsWith("(deny mach-lookup")) ?? "";
    for (const name of [
      "com.apple.lsd.open",
      "com.apple.pasteboard.1",
      "com.apple.ScreenCapture",
      "com.apple.dock.server",
    ])
      assert.ok(deniedMach.includes(name), `a GPU job cannot reach ${name}`);
    assert.ok(
      !deniedMach.includes("com.apple.coreservices.launchservicesd"),
      "a GPU job can check in with LaunchServices, which AppKit needs to start",
    );
  });

  it("a job cannot signal a process outside itself", async () => {
    const sibling = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      assert.ok(sibling.pid);
      const result = await job("/bin/kill", ["-TERM", String(sibling.pid)]);
      assert.notEqual(result.code, 0, "kill is refused");
      assert.match(result.stderr, /not permitted/i);
      assert.ok(running(sibling.pid), "the sibling survived");
    } finally {
      sibling.kill("SIGKILL");
    }
  });

  it("a job reaches no adb server or emulator port on loopback (C1, characterization: the profile denies network*)", async () => {
    const connects = [5037, 5554, 5555, 5585].map(
      (port) => `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo "bridge ${port} reached"`,
    );
    const result = await job("/bin/bash", ["-c", `${connects.join("; ")}; (exec 3<>/dev/tcp/127.0.0.1/5037)`]);
    assert.doesNotMatch(result.stdout, /reached/, "a device bridge connected");
    assert.match(result.stderr, /not permitted/i, "refused by the profile, not merely unanswered");
  });

  it("a job starts only programs inside its runtime's folder", async () => {
    const result = await job("/bin/sh", ["-c", "/bin/echo inside; /usr/bin/true && /bin/echo outside-ran"]);
    assert.match(result.stdout, /inside/, "its own folder (/bin) still runs");
    assert.doesNotMatch(result.stdout, /outside-ran/, "/usr/bin is not its runtime");
    assert.match(result.stderr, /\/usr\/bin\/true: Operation not permitted/);
  });

  it("a runtime that is a script may start the interpreter its own first line names, and nothing else outside it", async () => {
    const runtime = path.join(await tmpDir("native-script-runtime-"), "Tool.app", "Contents", "MacOS");
    await mkdir(runtime, { recursive: true });
    const tool = path.join(runtime, "Tool");
    await writeFile(tool, '#!/bin/sh\necho "script-ran $1"\n/usr/bin/true && echo outside-ran\n', { mode: 0o755 });
    const result = await job(tool, ["arg"]);
    assert.match(result.stdout, /script-ran arg/, result.stderr);
    assert.doesNotMatch(result.stdout, /outside-ran/, "the interpreter gains no other program");
    assert.equal(
      nativeSandboxProfile({
        binaryRoot: "/Applications/Tool.app",
        reads: [],
        writes: [],
        denied: [],
        gpu: false,
      }).includes("/bin/sh"),
      false,
      "a binary runtime gets no interpreter",
    );
  });

  it("a job may signal the helper processes it started, as Blender stops a worker (B4)", async () => {
    const result = await job("/usr/bin/perl", [
      "-e",
      'my $pid = fork(); if ($pid == 0) { sleep 30; exit 0; } kill("TERM", $pid) or die "kill: $!\\n"; waitpid($pid, 0); print "helper stopped\\n";',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /helper stopped/);
  });

  it("a script runtime whose first line is `/usr/bin/env <program>` may start that program from the job's PATH (B4)", async () => {
    const runtime = path.join(await tmpDir("native-env-runtime-"), "Tool.app", "Contents", "MacOS");
    await mkdir(runtime, { recursive: true });
    const tool = path.join(runtime, "Tool");
    await writeFile(tool, '#!/usr/bin/env bash\necho "env-ran $1"\n/usr/bin/true && echo outside-ran\n', {
      mode: 0o755,
    });
    const result = await job(tool, ["arg"]);
    assert.match(result.stdout, /env-ran arg/, result.stderr);
    assert.doesNotMatch(result.stdout, /outside-ran/, "env's program gains no other program");
  });

  it("a shell job may use the common text utilities, and still no program that opens apps or lists them (B4)", async () => {
    const result = await job("/bin/sh", [
      "-c",
      "/usr/bin/dirname /a/b; /usr/bin/yes x | /usr/bin/head -c 4 | /usr/bin/wc -c; /usr/bin/lsappinfo list >/dev/null 2>&1 || echo lsappinfo-refused; /usr/bin/open -h >/dev/null 2>&1 || echo open-refused",
    ]);
    assert.deepEqual(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.trim()),
      ["/a", "4", "lsappinfo-refused", "open-refused"],
      result.stderr,
    );
  });

  // A descendant that calls setsid() leaves the job's process group; killing -pid alone missed it.
  const SURVIVOR =
    'use POSIX; my $pid = fork(); if ($pid == 0) { POSIX::setsid(); sleep 30; exit 0; } print "$pid\\n"; $| = 1;';
  const survivorPid = (stdout: string) => Number(stdout.trim().split("\n")[0]);

  it("a timed-out job leaves no descendant running, even one in its own session", async () => {
    const result = await job("/usr/bin/perl", ["-e", `${SURVIVOR} sleep 30;`], { timeoutMs: 1500 });
    assert.equal(result.reason, "timeout");
    const pid = survivorPid(result.stdout);
    assert.ok(pid > 0, result.stdout + result.stderr);
    assert.ok(!running(pid), "the setsid descendant was stopped with the job");
    assert.ok(result.ms < 8000, `the job resolved in ${result.ms} ms`);
  });

  it("a cancelled job leaves no descendant running", async () => {
    // Cancel only once the descendant exists: a fixed delay raced perl's start on a loaded machine.
    const root = await tmpDir("native-sandbox-");
    const marker = path.join(root, "output", "forked");
    const forked = `open(my $m, ">", "output/forked.tmp"); close($m); rename("output/forked.tmp", "output/forked");`;
    const stop = new AbortController();
    const started = job("/usr/bin/perl", ["-e", `${SURVIVOR} ${forked} sleep 30;`], {
      signal: stop.signal,
      root,
      timeoutMs: CANCELLED_JOB_TIMEOUT_MS,
    });
    for (let tick = 0; tick < MARKER_POLLS && !existsSync(marker); tick++) await delay(POLL_MS);
    stop.abort();
    const result = await started;
    assert.equal(result.reason, "cancelled", result.stderr);
    const pid = survivorPid(result.stdout);
    assert.ok(pid > 0, result.stdout + result.stderr);
    assert.ok(!running(pid), "the setsid descendant was stopped with the job");
  });

  it("a job that exits normally takes its detached descendants with it", async () => {
    const result = await job("/usr/bin/perl", ["-e", SURVIVOR]);
    assert.equal(result.code, 0, result.stderr);
    const pid = survivorPid(result.stdout);
    assert.ok(pid > 0);
    assert.ok(!running(pid), "nothing keeps writing to output after the job is recorded");
    assert.ok(result.ms < 8000, `a descendant holding the output pipe does not hold the job open (${result.ms} ms)`);
  });
});

describe("runtime image copy", () => {
  it("keeps a framework's relative links relative, so they survive the image being detached", async () => {
    const root = await tmpDir("native-runtime-copy-");
    const mount = path.join(root, "mount"),
      app = path.join(mount, "Tool.app"),
      framework = path.join(app, "Contents/Frameworks/Kit.framework");
    await mkdir(path.join(framework, "Versions/A"), { recursive: true });
    await writeFile(path.join(framework, "Versions/A/Kit"), "binary");
    await symlink("A", path.join(framework, "Versions/Current"));
    await symlink("Versions/Current/Kit", path.join(framework, "Kit"));
    const stage = path.join(root, "stage", "Tool.app");
    await mkdir(path.dirname(stage));
    await copyRuntimeTree(app, stage);
    assert.equal(await readlink(path.join(stage, "Contents/Frameworks/Kit.framework/Versions/Current")), "A");
    await rm(mount, { recursive: true });
    assert.equal(
      await readFile(path.join(stage, "Contents/Frameworks/Kit.framework/Kit"), "utf8"),
      "binary",
      "the link resolves inside the copy once the image is gone",
    );
  });

  it("refuses a runtime whose links lead outside it", async () => {
    for (const target of ["/etc/hosts", "../../../outside"]) {
      const root = await tmpDir("native-runtime-escape-");
      const app = path.join(root, "mount", "Tool.app");
      await mkdir(path.join(app, "Contents"), { recursive: true });
      await symlink(target, path.join(app, "Contents", "escape"));
      await assert.rejects(copyRuntimeTree(app, path.join(root, "Tool.app")), /leads outside the runtime/, target);
    }
  });
});

describe("declared output delivery", () => {
  it("copies a regular file and refuses links, hard links and directories without reading them", async () => {
    const root = await tmpDir("native-delivery-");
    const output = path.join(root, "output"),
      delivery = path.join(root, "delivery");
    await mkdir(output);
    await mkdir(delivery);
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "TOP-SECRET");
    await writeFile(path.join(output, "model.glb"), "glb-bytes");
    await symlink(secret, path.join(output, "linked.glb"));
    await link(secret, path.join(output, "hard.glb"));
    await mkdir(path.join(output, "folder.glb"));

    await copyDeclaredOutput(output, "model.glb", path.join(delivery, "model.glb"));
    assert.equal(await readFile(path.join(delivery, "model.glb"), "utf8"), "glb-bytes");

    for (const [file, reason] of [
      ["linked.glb", /link|regular/i],
      ["hard.glb", /link/i],
      ["folder.glb", /regular/i],
      ["../secret.txt", /outside|path/i],
    ] as const) {
      await assert.rejects(copyDeclaredOutput(output, file, path.join(delivery, path.basename(file))), reason, file);
      await assert.rejects(readFile(path.join(delivery, path.basename(file))), /ENOENT/, `${file} delivered nothing`);
    }
  });
});

const execFileAsync = promisify(execFile);
/** The frames addon's own build (`native/genex-frames/build.sh`): the addon, the sender library and the test sender. */
const FRAMES_BUILD = path.resolve(import.meta.dirname, "../../native/genex-frames/build.sh");
/** Node's own N-API headers, which the addon builds against. */
const NODE_API_INCLUDE = path.join(path.dirname(path.dirname(process.execPath)), "include", "node");
/** A build of the addon and the test sender with Apple clang: well inside this. */
const FRAMES_BUILD_TIMEOUT_MS = 180_000;
/** What `bootstrap_look_up` answers when the profile refuses the name. */
const BOOTSTRAP_NOT_PRIVILEGED = 1100;

/** Why the frames rows do not run here, or false: they need Apple clang and Node's N-API headers. */
function framesSkip(): string | false {
  const clang = macClangSkip();
  if (clang) return clang;
  return existsSync(path.join(NODE_API_INCLUDE, "node_api.h"))
    ? false
    : `not run: no node_api.h in ${NODE_API_INCLUDE}`;
}

/** The addon's receive-only channel: checking a run's name in is all these rows need of it. */
interface FramesChannel {
  serviceName: string;
  close(): void;
}

/**
 * The test sender started as an embedded game is: under the generated embedded profile with the
 * run's own `FRAMES` (or, with `frames` null, under the headless profile), asked to look up
 * `service`. Resolves with its `ready` line's lookup answer.
 */
async function senderLookup(run: ProbeRunDir, frames: string | null, service: string): Promise<number> {
  const mode = frames === null ? NativeRunMode.Headless : NativeRunMode.Embedded;
  const runDir = await realpath(run.runDir);
  const profile = path.join(runDir, "profile.sb");
  await writeFile(profile, gameSandboxProfile({ mode }), { mode: 0o600 });
  const exe = await realpath(run.exe);
  const values = {
    [GameProfileParam.RunTag]: `genex-game-${run.runId}`,
    [GameProfileParam.Exe]: exe,
    [GameProfileParam.Bundle]: await realpath(run.bundle),
    [GameProfileParam.State]: await realpath(run.state),
    ...(frames === null ? {} : { [GameProfileParam.Frames]: frames }),
  };
  const args = [...gameProfileDefines(values, runDir, mode), "-f", profile, exe];
  const child = spawn(SANDBOX_EXEC, [...args, "--service", service], {
    cwd: values[GameProfileParam.State],
    env: { [NativeEnv.StudioFd]: "3", ...(frames === null ? {} : { [NativeEnv.FramesService]: frames }) },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const pipe = child.stdio[3] as Readable & Writable;
  let held = "";
  const ready = await new Promise<string>((resolve, reject) => {
    pipe.setEncoding("utf8");
    pipe.on("data", (chunk: string) => {
      held += chunk;
      if (held.includes("\n")) resolve(held.slice(0, held.indexOf("\n")));
    });
    child.once("exit", () => reject(new Error(`the sender exited before ready: ${held}`)));
  });
  // Closing the control channel ends a sender that connected; one that did not has exited already.
  pipe.end();
  await exited;
  return Number((JSON.parse(ready) as { lookup: unknown }).lookup);
}

describe("an embedded game's one frames service (darwin)", { skip: framesSkip() }, () => {
  it("under the generated embedded profile, the test sender looks up its own run's service (kr 0) and gets 1100 for another run's", {
    timeout: FRAMES_BUILD_TIMEOUT_MS,
  }, async () => {
    const base = await realpath(await tmpDir("native-frames-box-"));
    const out = path.join(base, "frames-build");
    await execFileAsync("/bin/bash", [FRAMES_BUILD], {
      env: { ...process.env, OUT: out, NODE_API_INCLUDE },
      timeout: FRAMES_BUILD_TIMEOUT_MS,
    });
    const runs = path.join(base, "native-runs");
    await mkdir(runs, { mode: 0o700 });
    const run = await probeRunDir(runs, path.join(out, "gxf_test_sender"));
    const addon = createRequire(import.meta.url)(path.join(out, "genex-frames.node")) as {
      open(runId: string, onEvent: () => void): FramesChannel;
    };
    // Both names exist: the host checked in this run's and another run's, so a refusal is the profile's.
    const own = addon.open(run.runId, () => {});
    const other = addon.open(randomBytes(8).toString("hex"), () => {});
    try {
      assert.equal(await senderLookup(run, own.serviceName, own.serviceName), 0, "its own run's service");
      assert.equal(
        await senderLookup(run, own.serviceName, other.serviceName),
        BOOTSTRAP_NOT_PRIVILEGED,
        "another run's service, checked in and refused by the profile",
      );
      assert.equal(
        await senderLookup(run, null, own.serviceName),
        BOOTSTRAP_NOT_PRIVILEGED,
        "the headless profile, which names no frames service, refuses even the run's own",
      );
    } finally {
      own.close();
      other.close();
    }
  });
});

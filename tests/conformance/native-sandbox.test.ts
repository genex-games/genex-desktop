/**
 * The Seatbelt profile a native job runs under, proven from inside the sandbox with real
 * processes (GPX-1, GPX-2): a job may signal only itself, may start only programs from its
 * runtime's own folder, and leaves nothing running once Studio has recorded its end — not even a
 * descendant that started its own session. Output delivery never follows a link.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { copyDeclaredOutput, copyRuntimeTree } from "../../src/substrate/plugins/native.ts";
import { nativeSandboxProfile, runNativeProcess } from "../../src/substrate/plugins/native-process.ts";
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

/** Real Windows native jobs: isolated input/output, no network and bounded process trees. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { windowsBaseEnv } from "../../src/substrate/child-env.ts";
import type { NativeProcessRequest } from "../../src/substrate/plugins/native-process.ts";
import { runNativeProcess } from "../../src/substrate/plugins/native-process.ts";
import {
  BLENDER_RENDER_SIZE,
  BLENDER_WRAPPER_PY,
  STUDIO_BLENDER_RESULT,
  frontRenderPath,
} from "../../src/plugins/blender/wrapper.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { observeExit } from "../helpers/windows-process.ts";

const exec = promisify(execFile);
const MARKER_POLLS = 500;
const POLL_MS = 20;
const PROGRESS_REPORT_MS = 5000;
const BLENDER = process.env.STUDIO_TEST_BLENDER;
const FBX_HEADER = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "ascii");
// An owned acceptance bundle beside dist/main resolves the helper from shipped resources.
const runProcess: typeof runNativeProcess = process.env.STUDIO_TEST_NATIVE_MODULE
  ? (await import(pathToFileURL(process.env.STUDIO_TEST_NATIVE_MODULE).href)).runNativeProcess
  : runNativeProcess;
const NATIVE_HELPER = process.env.STUDIO_TEST_NATIVE_MODULE
  ? path.resolve(path.dirname(process.env.STUDIO_TEST_NATIVE_MODULE), "../resources/windows-native/windows-native.ps1")
  : fileURLToPath(new URL("../../src/substrate/plugins/windows-native.ps1", import.meta.url));

async function setup() {
  const root = await tmpDir("native-windows-");
  const runtime = path.join(root, "Runtime with spaces");
  const input = path.join(root, "inputs Юникод");
  const output = path.join(root, "output");
  const scratch = path.join(root, "scratch");
  await Promise.all([runtime, input, output, scratch].map((folder) => mkdir(folder)));
  const binary = path.join(runtime, "node.exe");
  await copyFile(process.execPath, binary);
  const run = async (code: string, args: string[] = [], patch: Partial<NativeProcessRequest> = {}) => {
    const started = performance.now();
    const progress = new Map<string, number>();
    // Keep only trusted broker filenames, never specification/credential contents. If a hosted
    // runner stalls, distinguish compilation, ACL preparation and execution before cleanup.
    let observing = Promise.resolve();
    const probe = setInterval(() => {
      observing = observing
        .then(async () => {
          for (const name of await readdir(root)) {
            if (!name.startsWith(".native-control-")) continue;
            for (const file of await readdir(path.join(root, name)).catch(() => [])) {
              if (!progress.has(file)) progress.set(file, Math.round(performance.now() - started));
            }
          }
        })
        .catch(() => {});
    }, 100);
    try {
      const result = await runProcess({
        binary,
        args: ["-e", code, ...args],
        cwd: input,
        scratch,
        reads: [runtime, input],
        writes: [output],
        denyRead: [],
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
        ...patch,
      });
      const elapsedMs = Math.round(performance.now() - started);
      if (result.reason === "timeout" || elapsedMs > PROGRESS_REPORT_MS)
        console.info(
          "Native broker progress:",
          JSON.stringify({ elapsedMs, reason: result.reason, progress: Object.fromEntries(progress) }),
        );
      return result;
    } finally {
      clearInterval(probe);
      await observing;
    }
  };
  return { root, runtime, input, output, scratch, run };
}

async function marker(file: string) {
  for (let poll = 0; poll < MARKER_POLLS && !existsSync(file); poll++) await delay(POLL_MS);
  assert.ok(existsSync(file), `native child created ${file}`);
}

async function running(pid: number) {
  const { stdout } = await exec("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  return stdout.split("\n").some((line) => line.includes(`"${pid}"`));
}

async function noncanonicalFixture(folder: string, script: string) {
  await writeFile(
    script,
    `param([string]$Folder)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System.Runtime.InteropServices;
public static class FixtureAcl {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool SetFileSecurity(string path, uint info, byte[] descriptor);
}

'@
$acl = (Get-Item -LiteralPath $Folder).GetAccessControl()
$raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-111-222-333-444')
$ace = New-Object System.Security.AccessControl.CommonAce([System.Security.AccessControl.AceFlags]::Inherited, [System.Security.AccessControl.AceQualifier]::AccessAllowed, 128, $sid, $false, $null)
$raw.DiscretionaryAcl.InsertAce(0, $ace)
# Keep this hostile ordering independent of the fixture parent's inheritance: a private
# Windows profile may contain only inherited ACEs, which the first insertion alone leaves canonical.
$explicit = New-Object System.Security.AccessControl.CommonAce([System.Security.AccessControl.AceFlags]::None, [System.Security.AccessControl.AceQualifier]::AccessAllowed, 128, $sid, $false, $null)
$raw.DiscretionaryAcl.InsertAce($raw.DiscretionaryAcl.Count, $explicit)
$raw.SetFlags(($raw.ControlFlags -bor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -band (-bnot 0x500))
$bytes = New-Object byte[] $raw.BinaryLength
$raw.GetBinaryForm($bytes, 0)
if (-not [FixtureAcl]::SetFileSecurity($Folder, 4, $bytes)) { throw 'Cannot prepare owned DACL fixture' }
if ((Get-Item -LiteralPath $Folder).GetAccessControl().AreAccessRulesCanonical) { throw 'Fixture must be noncanonical' }
`,
  );
  await exec(path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    folder,
  ]);
}

async function securitySnapshot(files: string[], root: string, information = 7) {
  const spec = path.join(root, "acl-paths.json");
  const script = path.join(root, "read-acls.ps1");
  await writeFile(spec, JSON.stringify(files));
  await writeFile(
    script,
    `param([string]$Spec, [uint32]$Information)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
public static class AclSnapshot {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetNamedSecurityInfo(string path, int kind, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetFileSecurity(string path, uint info, byte[] descriptor, uint length, out uint needed);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string Read(string path, uint information) {
    if (information == 7) {
      uint needed;
      GetFileSecurity(path, information, null, 0, out needed);
      var raw = new byte[checked((int)needed)];
      if (!GetFileSecurity(path, information, raw, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var physical = new RawSecurityDescriptor(raw, 0);
      var aclBytes = new byte[physical.DiscretionaryAcl.BinaryLength];
      physical.DiscretionaryAcl.GetBinaryForm(aclBytes, 0);
      return ((int)physical.ControlFlags).ToString() + "|" + Convert.ToBase64String(aclBytes) + "|" + physical.GetSddlForm(AccessControlSections.All);
    }
    IntPtr owner, group, dacl, sacl, descriptor;
    uint status = GetNamedSecurityInfo(path, 1, information, out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0) throw new Win32Exception((int)status);
    try {
      var bytes = new byte[checked((int)GetSecurityDescriptorLength(descriptor))];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      return new RawSecurityDescriptor(bytes, 0).GetSddlForm(AccessControlSections.All);
    } finally { LocalFree(descriptor); }
  }
}
'@
$items = Get-Content -LiteralPath $Spec -Raw -Encoding UTF8 | ConvertFrom-Json
$records = @(foreach ($file in $items) { [AclSnapshot]::Read($file, $Information) })
ConvertTo-Json -InputObject $records -Compress
`,
  );
  const result = await exec(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, spec, String(information)],
  );
  return JSON.parse(result.stdout);
}

/** A legacy canonical DACL must keep its control flags when the broker adds file grants. */
async function legacyAclFixture(folder: string, script: string) {
  await writeFile(
    script,
    `param([string]$Folder)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;
public static class ExplicitFixtureAcl {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool SetFileSecurity(string path, uint info, byte[] descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetFileSecurity(string path, uint info, byte[] descriptor, uint size, out uint needed);
  public static void Prepare(string path) {
    uint needed;
    GetFileSecurity(path, 7, null, 0, out needed);
    var original = new byte[needed];
    if (!GetFileSecurity(path, 7, original, needed, out needed)) throw new IOException("Cannot read owned DACL fixture");
    var raw = new RawSecurityDescriptor(original, 0);
    for (int i = 0; i < raw.DiscretionaryAcl.Count; i++) raw.DiscretionaryAcl[i].AceFlags &= ~AceFlags.Inherited;
    raw.SetFlags(raw.ControlFlags & ~(ControlFlags.DiscretionaryAclProtected | ControlFlags.DiscretionaryAclAutoInherited | ControlFlags.DiscretionaryAclAutoInheritRequired));
    var bytes = new byte[raw.BinaryLength];
    raw.GetBinaryForm(bytes, 0);
    using (var pin = CreateFile(path, 0x00040080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (pin.IsInvalid || !SetFileSecurity(path, 4, bytes)) throw new IOException("Cannot prepare explicit DACL fixture");
    }
    var physical = new byte[needed];
    if (!GetFileSecurity(path, 7, physical, needed, out needed)) throw new IOException("Cannot check owned DACL fixture");
    var checkedAcl = new RawSecurityDescriptor(physical, 0);
    for (int i = 0; i < checkedAcl.DiscretionaryAcl.Count; i++)
      if ((checkedAcl.DiscretionaryAcl[i].AceFlags & AceFlags.Inherited) != 0) throw new IOException("Fixture must contain explicit ACEs");
  }
}
'@
[ExplicitFixtureAcl]::Prepare($Folder)
`,
  );
  await exec(path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    folder,
  ]);
}

async function blenderFbxJob(code: string, stagedSource?: string) {
  assert.ok(BLENDER);
  const f = await setup();
  const model = path.join(f.input, "model.py");
  const wrapper = path.join(f.scratch, "wrapper.py");
  const glb = path.join(f.output, "cube.glb");
  const fbx = path.join(f.output, "cube.fbx");
  const png = path.join(f.output, "cube.png");
  await writeFile(model, code);
  await writeFile(wrapper, BLENDER_WRAPPER_PY);
  const input = path.join(f.input, "source.glb");
  if (stagedSource) await copyFile(stagedSource, input);
  const result = await runProcess({
    binary: BLENDER,
    args: [
      "-b",
      "--factory-startup",
      "-noaudio",
      "--python-exit-code",
      "1",
      "--python",
      wrapper,
      "--",
      model,
      glb,
      png,
      "cube",
      ...(stagedSource ? [input] : []),
      "--fbx",
      fbx,
    ],
    cwd: f.input,
    scratch: f.scratch,
    reads: [f.input],
    writes: [f.output],
    denyRead: [],
    gpu: true,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    maxOutputBytes: 64_000,
  });
  assert.equal(result.code, 0, result.stderr);
  const line = result.stdout.split("\n").find((value) => value.startsWith(STUDIO_BLENDER_RESULT));
  assert.ok(line, result.stdout);
  const info = JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length));
  const bytes = await readFile(fbx);
  assert.equal(info.ok, true);
  assert.equal(info.fbxBytes, bytes.length);
  assert.deepEqual(bytes.subarray(0, FBX_HEADER.length), FBX_HEADER);
  assert.equal((await readFile(glb)).subarray(0, 4).toString("ascii"), "glTF");
  for (const file of [png, frontRenderPath(png)]) {
    const render = await readFile(file);
    assert.equal(render.subarray(1, 4).toString("ascii"), "PNG");
    assert.deepEqual([render.readUInt32BE(16), render.readUInt32BE(20)], [...BLENDER_RENDER_SIZE]);
  }
  return { glb, info };
}

describe("Windows native runtime", { skip: process.platform !== "win32" && "Windows AppContainer only" }, () => {
  it("the trusted PowerShell broker starts with Windows basics and no interactive input", async () => {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    for (const input of ["ignore", "pipe"] as const) {
      const child = spawn(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('broker-booted')"],
        {
          env: windowsBaseEnv(process.env),
          windowsHide: true,
          stdio: [input, "pipe", "pipe"],
          signal: AbortSignal.timeout(5000),
        },
      );
      child.stdin?.end();
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, `${input}: ${stderr}`);
      assert.equal(stdout.trim(), "broker-booted", input);
    }
  });

  it("preserves a noncanonical ACL, existing descendants and foreign junction targets", async () => {
    const f = await setup();
    const nested = path.join(f.output, "existing");
    const foreign = path.join(f.root, "foreign");
    await noncanonicalFixture(f.output, path.join(f.root, "fixture-acl.ps1"));
    await mkdir(nested);
    await mkdir(foreign);
    const existing = path.join(nested, "original.txt");
    const secret = path.join(foreign, "secret.txt");
    await writeFile(existing, "before");
    await writeFile(secret, "foreign-secret");
    const { symlink } = await import("node:fs/promises");
    await symlink(foreign, path.join(f.output, "foreign-link"), "junction");
    const paths = [f.output, nested, existing, foreign, secret];
    const snapshot = () => securitySnapshot(paths, f.root);
    const before = await snapshot();
    const descriptorBefore = await securitySnapshot(paths, f.root);
    const result = await f.run(
      `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1], 'after');
      fs.mkdirSync(process.argv[2]); fs.writeFileSync(process.argv[2] + '/new.txt', 'new');
      try { fs.readFileSync(process.argv[3]); process.exit(20); } catch (error) { console.log(error.code); }
    `,
      [existing, path.join(f.output, "created"), secret],
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /EACCES|EPERM/);
    assert.equal(await readFile(existing, "utf8"), "after");
    assert.deepEqual(await snapshot(), before, "original ACE order and foreign permissions are retained");
    assert.deepEqual(
      await securitySnapshot(paths, f.root),
      descriptorBefore,
      "owner, group and DACL control flags are restored",
    );
    const createdAcl = (await exec("icacls.exe", [path.join(f.output, "created/new.txt")])).stdout;
    assert.doesNotMatch(createdAcl, /S-1-15-2-/, "new descendants retain no temporary AppContainer grant");
    const createdLabel = await securitySnapshot([path.join(f.output, "created/new.txt")], f.root, 16);
    assert.doesNotMatch(createdLabel[0], /;;;LW\)/, "new descendants retain no temporary low integrity label");
    const brokerFile = path.join(f.output, "broker.json");
    const held = f
      .run(
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,broker:process.ppid})); setInterval(() => {}, 1000)",
        [brokerFile],
      )
      .catch((error: unknown) => error);
    await marker(brokerFile);
    const { pid, broker } = JSON.parse(await readFile(brokerFile, "utf8"));
    const observer = await observeExit(pid);
    await exec("taskkill.exe", ["/PID", String(broker), "/F"]);
    assert.ok((await held) instanceof Error);
    await observer.exited;
    assert.deepEqual(await snapshot(), before, "crash recovery also preserves existing descendants");
    assert.deepEqual(await securitySnapshot(paths, f.root), descriptorBefore);
  });

  it("runs the selected executable with literal spaced arguments and captures both output streams", async () => {
    const f = await setup();
    const descriptorBefore = await securitySnapshot([f.output], f.root);
    const before = descriptorBefore;
    const result = await f.run("console.log(process.argv[1]); console.error('stderr-ready')", [
      "a space & literal $value",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /a space & literal \$value/);
    assert.match(result.stderr, /stderr-ready/);
    const descriptorAfter = await securitySnapshot([f.output], f.root);
    assert.deepEqual(descriptorAfter, before, "job grants are revoked and physical ACE/control flags are exact");
    await writeFile(path.join(f.output, "after.txt"), "host-writable");
    assert.equal(await readFile(path.join(f.output, "after.txt"), "utf8"), "host-writable");
  });

  it("preserves legacy canonical DACL flags on existing folders and files", async () => {
    const f = await setup();
    const nested = path.join(f.output, "existing");
    await mkdir(nested);
    const existing = path.join(nested, "original.txt");
    await writeFile(existing, "before");
    const paths = [f.output, nested, existing];
    for (const file of paths) await legacyAclFixture(file, path.join(f.root, "legacy-acl.ps1"));
    const before = await securitySnapshot(paths, f.root);
    assert.ok(
      before.every((sddl: string) => !sddl.includes("D:AI")),
      "the fixture uses the legacy inheritance model",
    );
    const result = await f.run("require('node:fs').writeFileSync(process.argv[1], 'after')", [existing]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(existing, "utf8"), "after");
    assert.deepEqual(await securitySnapshot(paths, f.root), before, "ACE flags and DACL control bits are exact");
  });

  it("reads staged inputs, writes declared outputs, and refuses foreign reads, writes and network", async () => {
    const f = await setup();
    const staged = path.join(f.input, "source.txt");
    const secret = path.join(f.root, "private.txt");
    const foreign = path.join(f.root, "foreign.txt");
    const delivered = path.join(f.output, "asset.txt");
    await writeFile(staged, "input-ready");
    await writeFile(secret, "synthetic-secret");
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.end();
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const code = `
        const fs = require('node:fs');
        const [input, output, secret, foreign, port] = process.argv.slice(1);
        fs.writeFileSync(output, fs.readFileSync(input));
        for (const operation of [() => fs.readFileSync(secret), () => fs.writeFileSync(foreign, 'escaped')]) {
          try { operation(); process.exit(20); } catch (error) { console.log('FILE_DENIED:' + error.code); }
        }
        const socket = require('node:net').createConnection({ host: '127.0.0.1', port: Number(port) });
        socket.on('connect', () => process.exit(21));
        socket.on('error', error => console.log('NETWORK_DENIED:' + error.code));
      `;
      const result = await f.run(code, [staged, delivered, secret, foreign, String(address.port)]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await readFile(delivered, "utf8"), "input-ready");
      assert.equal(existsSync(foreign), false);
      assert.equal((result.stdout.match(/FILE_DENIED:/g) ?? []).length, 2);
      assert.match(result.stdout, /NETWORK_DENIED:EACCES/);
      assert.doesNotMatch(result.stdout, /synthetic-secret/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("two overlapping native jobs cannot use each other's file grants", async () => {
    const first = await setup();
    const second = await setup();
    const secret = path.join(first.input, "source.txt");
    const active = path.join(first.output, "active");
    await writeFile(secret, "first-only");
    const stop = new AbortController();
    const held = first.run(
      "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
      [active],
      { signal: stop.signal },
    );
    try {
      await marker(active);
      const result = await second.run(
        "try { require('node:fs').readFileSync(process.argv[1]); process.exit(30); } catch (error) { console.log(error.code); }",
        [secret],
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /EACCES|EPERM/);
    } finally {
      stop.abort();
      assert.equal((await held).reason, "cancelled");
    }
  });

  it("jobs sharing a noncanonical runtime queue and restore its original permissions", async () => {
    const first = await setup();
    const second = await setup();
    await noncanonicalFixture(first.runtime, path.join(first.root, "fixture-acl.ps1"));
    const before = (await exec("icacls.exe", [first.runtime])).stdout;
    const active = path.join(first.output, "active");
    const stop = new AbortController();
    const held = first.run(
      "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
      [active],
      { signal: stop.signal },
    );
    let queued: Promise<Awaited<ReturnType<typeof first.run>>> | undefined;
    try {
      await marker(active);
      queued = second.run("console.log('queued-job')", [], {
        binary: path.join(first.runtime, "node.exe"),
        binaryRoot: first.runtime,
      });
      let waiting: string | undefined;
      for (let poll = 0; poll < MARKER_POLLS && !waiting; poll++) {
        const control = (await readdir(second.root)).find((name) => name.startsWith(".native-control-"));
        if (control && existsSync(path.join(second.root, control, "grants.waiting"))) waiting = control;
        else await delay(POLL_MS);
      }
      assert.ok(waiting, "the second broker waits for the shared root instead of recording transient protection");
      stop.abort();
      assert.equal((await held).reason, "cancelled");
      const result = await queued;
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /queued-job/);
      assert.equal((await exec("icacls.exe", [first.runtime])).stdout, before);
    } finally {
      stop.abort();
      await held;
      await queued;
    }
  });

  it("failure to start the executable revokes grants and never retries outside the sandbox", async () => {
    const f = await setup();
    const before = await securitySnapshot([f.output], f.root);
    await assert.rejects(
      f.run("console.log('unexpected')", [], {
        binary: path.join(f.runtime, "missing.exe"),
        binaryRoot: f.runtime,
      }),
      /Start AppContainer native runtime/,
    );
    assert.deepEqual(await securitySnapshot([f.output], f.root), before);
    assert.equal((await f.run("console.log('next-job')")).code, 0, "failure leaves the next isolated job usable");
  });

  it("cancellation kills a detached descendant and restores folder permissions", async () => {
    const f = await setup();
    const before = await securitySnapshot([f.output], f.root);
    const pidFile = path.join(f.output, "child.pid");
    const entered = path.join(f.output, "root-entered");
    const stop = new AbortController();
    const held = f.run(
      `
      require('node:fs').writeFileSync(process.argv[2], String(process.pid));
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit', windowsHide: true });
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `,
      [pidFile, entered],
      { signal: stop.signal },
    );
    let observer: Awaited<ReturnType<typeof observeExit>> | undefined;
    try {
      await marker(pidFile);
      const pid = Number(await readFile(pidFile, "utf8"));
      observer = await observeExit(pid, { immediate: true });
      stop.abort();
      const result = await held;
      assert.equal(result.reason, "cancelled", result.stderr);
      // Query the pinned process immediately after completion: tasklist can show a dead process
      // until its handles close, or a newly reused PID in a parallel suite.
      await observer.assertExited();
      assert.deepEqual(await securitySnapshot([f.output], f.root), before);
    } catch (error) {
      stop.abort();
      const result = await held;
      console.info(
        "Native cancellation preparation:",
        JSON.stringify({
          entered: existsSync(entered),
          code: result.code,
          reason: result.reason,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );
      throw error;
    } finally {
      stop.abort();
      await held;
      await observer?.assertExited();
    }
  });

  it("a forcibly killed broker restores its exact folder grants and integrity labels", async () => {
    const f = await setup();
    const folders = [f.runtime, f.input, f.output, f.scratch];
    const before = await securitySnapshot(folders, f.root);
    const pidFile = path.join(f.output, "broker.json");
    const held = f
      .run(
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,broker:process.ppid})); setInterval(() => {}, 1000)",
        [pidFile],
      )
      .catch((error: unknown) => error);
    await marker(pidFile);
    const { pid, broker } = JSON.parse(await readFile(pidFile, "utf8"));
    const control = (await readdir(f.root)).find((name) => name.startsWith(".native-control-"));
    assert.ok(control);
    const { profile } = JSON.parse(await readFile(path.join(f.root, control, "spec.json"), "utf8"));
    const mappings =
      "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings";
    await exec("reg.exe", ["query", mappings, "/s", "/f", profile, "/d", "/e"]);
    await exec("taskkill.exe", ["/PID", String(broker), "/F"]);
    assert.ok((await held) instanceof Error, "a killed broker cannot report a successful native job");
    assert.equal(await running(pid), false, "kill-on-close stops its native process");
    const after = await securitySnapshot(folders, f.root);
    assert.deepEqual(after, before, "abnormal broker exit restores each granted directory");
    assert.equal(
      (await readdir(f.root)).some((name) => name.startsWith(".native-control-")),
      false,
    );
    await assert.rejects(exec("reg.exe", ["query", mappings, "/s", "/f", profile, "/d", "/e"]), { code: 1 });
  });

  it("the native child cannot read the broker specification or forge recovery records", async () => {
    const f = await setup();
    const ready = path.join(f.output, "ready");
    const target = path.join(f.input, "control-path.txt");
    const held = f.run(
      `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1], 'ready');
      const poll = setInterval(() => {
        if (!fs.existsSync(process.argv[2])) return;
        clearInterval(poll);
        const control = fs.readFileSync(process.argv[2], 'utf8');
        for (const operation of [() => fs.readFileSync(control + '/spec.json'), () => fs.appendFileSync(control + '/grants.log', 'forged')]) {
          try { operation(); process.exit(31); } catch (error) { console.log('CONTROL_DENIED:' + error.code); }
        }
      }, 20);
    `,
      [ready, target],
    );
    await marker(ready);
    const control = (await readdir(f.root)).find((name) => name.startsWith(".native-control-"));
    assert.ok(control);
    await writeFile(target, path.join(f.root, control));
    const result = await held;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((result.stdout.match(/CONTROL_DENIED:EACCES|CONTROL_DENIED:EPERM/g) ?? []).length, 2);
  });

  it("failed broker recovery stays bounded and retains its owned journal for repair", async () => {
    const f = await setup();
    const before = await securitySnapshot([f.output], f.root);
    const pidFile = path.join(f.output, "broker.json");
    const held = f
      .run(
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,broker:process.ppid})); setInterval(() => {}, 1000)",
        [pidFile],
      )
      .catch((error: unknown) => error);
    await marker(pidFile);
    const { pid, broker } = JSON.parse(await readFile(pidFile, "utf8"));
    const name = (await readdir(f.root)).find((value) => value.startsWith(".native-control-"));
    assert.ok(name);
    const control = path.join(f.root, name);
    const journal = path.join(control, "grants.log");
    const original = await readFile(journal, "utf8");
    try {
      await writeFile(journal, `${original}invalid-record\n`);
      const started = Date.now();
      await exec("taskkill.exe", ["/PID", String(broker), "/F"]);
      const error = await held;
      assert.ok(error instanceof Error);
      assert.match(error.message, /recovery records are retained/);
      assert.ok(error.message.includes(control));
      assert.ok(Date.now() - started < 10_000, "failed recovery also has a deadline");
      assert.equal(await running(pid), false);
      assert.equal(existsSync(journal), true, "failed recovery does not discard the only original labels");
    } finally {
      await writeFile(journal, original);
      await exec(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          NATIVE_HELPER,
          "-SpecFile",
          path.join(control, "spec.json"),
          "-CleanupOnly",
        ],
        { env: windowsBaseEnv(process.env), timeout: 15_000 },
      );
      assert.deepEqual(
        await securitySnapshot([f.output], f.root),
        before,
        "owned failure fixture restores its permissions",
      );
      assert.equal(path.dirname(control), f.root);
      await rm(control, { recursive: true, force: true });
    }
  });

  it("a startup deadline stops an unready broker without launching the runtime or leaving grants", async () => {
    const f = await setup();
    const before = (await exec("icacls.exe", [f.output])).stdout;
    const sideEffect = path.join(f.output, "must-not-run.txt");
    const started = Date.now();
    const timed = await f.run("require('node:fs').writeFileSync(process.argv[1], 'late')", [sideEffect], {
      timeoutMs: 1,
    });
    assert.equal(timed.reason, "timeout");
    assert.equal(timed.pid, null, "no runtime was created before the deadline");
    assert.ok(Date.now() - started < 10_000, "startup timeout also has bounded cleanup");
    assert.equal(existsSync(sideEffect), false, "a cancelled launch cannot run late");
    assert.equal((await exec("icacls.exe", [f.output])).stdout, before, "no temporary grants survive");
    assert.equal(
      (await readdir(f.root)).some((name) => name.startsWith(".native-control-")),
      false,
    );
  });

  it("a timeout is bounded and a normal exit also removes detached descendants", async () => {
    const f = await setup();
    const started = Date.now();
    const timed = await f.run("setInterval(() => {}, 1000)", [], { timeoutMs: 3000 });
    assert.equal(timed.reason, "timeout");
    assert.ok(Date.now() - started < 10_000, "timeout includes bounded sandbox cleanup");
    const stdioReport = path.join(f.output, "stdio-probe.json");
    const result = await f.run(
      `
      const fs = require('node:fs');
      const probe = {};
      for (const mode of ['r', 'w']) {
        try { fs.closeSync(fs.openSync('NUL', mode)); probe[mode] = 'opened'; }
        catch (error) { probe[mode] = error.code; }
      }
      fs.writeFileSync(process.argv[1], JSON.stringify(probe));
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit', windowsHide: true });
      console.log(child.pid); child.unref();
    `,
      [stdioReport],
    );
    if (existsSync(stdioReport)) console.info("Native NUL access:", await readFile(stdioReport, "utf8"));
    assert.equal(result.code, 0, result.stderr);
    const pid = Number(result.stdout.trim());
    assert.ok(pid > 0, result.stdout);
    assert.equal(await running(pid), false, "a completed runtime leaves no helper process");
  });

  it("the real Blender wrapper exports GLB and both CPU-rendered thumbnails", {
    skip: !BLENDER && "set STUDIO_TEST_BLENDER to an owned Windows Blender executable",
  }, async () => {
    const f = await setup();
    const model = path.join(f.input, "model.py");
    const wrapper = path.join(f.scratch, "wrapper.py");
    const glb = path.join(f.output, "cube.glb");
    const png = path.join(f.output, "cube.png");
    await writeFile(model, "import bpy\nbpy.ops.mesh.primitive_cube_add()\n");
    await writeFile(wrapper, BLENDER_WRAPPER_PY);
    assert.ok(BLENDER);
    const result = await runProcess({
      binary: BLENDER,
      args: [
        "-b",
        "--factory-startup",
        "-noaudio",
        "--python-exit-code",
        "1",
        "--python",
        wrapper,
        "--",
        model,
        glb,
        png,
        "cube",
      ],
      cwd: f.input,
      scratch: f.scratch,
      reads: [f.input],
      writes: [f.output],
      denyRead: [],
      gpu: true,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      maxOutputBytes: 64_000,
    });
    assert.equal(result.code, 0, result.stderr);
    const line = result.stdout.split("\n").find((value) => value.startsWith(STUDIO_BLENDER_RESULT));
    assert.ok(line, result.stdout);
    const info = JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length));
    assert.equal(info.ok, true);
    assert.equal(info.meshCount, 1);
    assert.equal(info.triangles, 12);
    assert.equal((await readFile(glb)).subarray(0, 4).toString("ascii"), "glTF");
    assert.deepEqual(info.renders, [png, frontRenderPath(png)]);
    for (const file of info.renders) {
      const bytes = await readFile(file);
      assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [...BLENDER_RENDER_SIZE]);
    }
  });

  it("real Blender exports binary FBX and transforms only its staged GLB input inside LPAC", {
    skip: !BLENDER && "set STUDIO_TEST_BLENDER to an owned Windows Blender executable",
  }, async () => {
    const created = await blenderFbxJob("import bpy\nbpy.ops.mesh.primitive_cube_add()\n");
    assert.equal(created.info.meshCount, 1);
    assert.equal(created.info.triangles, 12);
    const transformed = await blenderFbxJob(
      "bpy.ops.import_scene.gltf(filepath=ASSET_INPUTS['model'])\nfor obj in bpy.context.scene.objects:\n    if obj.type == 'MESH': obj.scale = (1, 2, 3)\n",
      created.glb,
    );
    assert.equal(transformed.info.meshCount, 1);
    assert.equal(transformed.info.triangles, 12);
    assert.deepEqual(transformed.info.size, [2, 4, 6]);
  });
});

/** A native Windows job uses its own AppContainer SID, independent of srt-win's shared grants. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECOND_MS } from "../../shared/duration.ts";
import { windowsBaseEnv } from "../child-env.ts";
import { killProcessTree } from "../process-tree.ts";
import { envValue } from "../toolchain.ts";
import { NativeEndReason, type NativeProcessRequest, type NativeProcessResult } from "./native-process-contract.ts";

const STOP_GRACE_MS = 10 * SECOND_MS;
const MAX_RECOVERY_STDERR_BYTES = 4096;
const MESSAGE = {
  helperFailed: (stderr: string) => `The isolated Windows native job failed: ${stderr}`,
  helperMissing: "The Windows native sandbox helper is missing from this build.",
  invalidOutcome: "The Windows native sandbox helper returned an invalid outcome.",
  recoveryFailed: (control: string) =>
    `Windows native access recovery failed. Its recovery records are retained at ${control}.`,
};

/** Resolve the trusted helper from source or the unpacked resources of this exact build. */
function helperPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.join(here, "windows-native.ps1");
  const resources = path.resolve(here, "../resources/windows-native/windows-native.ps1");
  const unpacked = resources.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const script = existsSync(source) ? source : unpacked;
  if (!existsSync(script)) throw new Error(MESSAGE.helperMissing);
  return script;
}

function startHelper(script: string, spec: string, cleanupOnly = false, interactive = false) {
  const system = envValue(process.env, "SystemRoot") || "C:\\Windows";
  const powershell = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-SpecFile",
    spec,
    ...(cleanupOnly ? ["-CleanupOnly"] : []),
  ];
  const options = { env: windowsBaseEnv(process.env), windowsHide: true };
  if (interactive) return spawn(powershell, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  return spawn(powershell, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
}

/** A fresh trusted broker can undo flushed grants after a crashed or forcibly stopped broker. */
async function recoverControl(script: string, control: string) {
  if (existsSync(path.join(control, "cleanup.ok"))) return;
  // Only the trusted C# broker can write this marker, before any account or ACL mutation.
  if (!existsSync(path.join(control, "broker.ready"))) return;
  const child = startHelper(script, path.join(control, "spec.json"), true);
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString("utf8")).slice(-MAX_RECOVERY_STDERR_BYTES);
  });
  const timeout = setTimeout(() => {
    void killProcessTree(child.pid);
  }, STOP_GRACE_MS);
  timeout.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(MESSAGE.helperFailed(stderr)))));
    });
    if (!existsSync(path.join(control, "cleanup.ok"))) throw new Error(MESSAGE.invalidOutcome);
  } catch (error) {
    throw new Error(MESSAGE.recoveryFailed(control), { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function readOutcome(control: string) {
  const outcome: unknown = JSON.parse(
    (await readFile(path.join(control, "result.json"), "utf8")).replace(/^\uFEFF/, ""),
  );
  if (!outcome || typeof outcome !== "object") throw new Error(MESSAGE.invalidOutcome);
  const value = outcome as Record<string, unknown>;
  const validCode = typeof value.code === "number" && Number.isInteger(value.code);
  const validPid =
    (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) ||
    (value.pid === null && value.reason === NativeEndReason.Cancelled);
  const validReason = value.reason === NativeEndReason.Exit || value.reason === NativeEndReason.Cancelled;
  if (!validCode || !validPid || !validReason) throw new Error(MESSAGE.invalidOutcome);
  return value as { code: number; pid: number | null; reason: NativeEndReason };
}

/** The child gets system basics and its own scratch environment, with no provider credentials. */
function nativeEnvironment(p: NativeProcessRequest): Record<string, string> {
  const basics = windowsBaseEnv(process.env);
  const system = envValue(process.env, "SystemRoot") || "C:\\Windows";
  return {
    ...basics,
    PATH: [path.dirname(p.binary), path.join(system, "System32")].join(";"),
    HOME: p.scratch,
    USERPROFILE: p.scratch,
    APPDATA: path.join(p.scratch, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(p.scratch, "AppData", "Local"),
    TMP: p.scratch,
    TEMP: p.scratch,
    TMPDIR: p.scratch,
    ...p.environment,
  };
}

/** Run a Windows native executable with no network capabilities and a distinct, temporary file identity. */
export async function runWindowsNativeProcess(p: NativeProcessRequest): Promise<NativeProcessResult> {
  p.signal.throwIfAborted();
  const script = helperPath();
  const control = path.join(path.dirname(p.scratch), `.native-control-${randomUUID()}`);
  await mkdir(control);
  try {
    const spec = path.join(control, "spec.json");
    await writeFile(
      spec,
      JSON.stringify({
        profile: `genex.native.${randomUUID()}`,
        binary: p.binary,
        args: p.args,
        cwd: p.cwd,
        reads: [...new Set([p.binaryRoot ?? path.dirname(p.binary), p.cwd, ...p.reads])],
        writes: [...new Set([...p.writes, p.scratch])],
        denied: p.denyRead,
        env: nativeEnvironment(p),
        control,
        parentPid: process.pid,
      }),
    );
    return await executeHelper(p, script, spec, control);
  } finally {
    await recoverControl(script, control);
    await rm(control, { recursive: true, force: true });
  }
}

/** The helper stops and cleans up its own job before the host falls back to killing a stuck broker. */
function executeHelper(p: NativeProcessRequest, script: string, spec: string, control: string) {
  const child = startHelper(script, spec, false, !!p.channel);
  child.stdin?.on("error", () => {});
  p.channel?.connect((payload) => {
    if (child.stdin?.writable) child.stdin.write(payload);
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let reason: NativeEndReason = NativeEndReason.Exit;
  let force: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on("data", (data) => {
    const output = p.channel ? p.channel.stdout(data) : data;
    truncated ||= stdout.length + output.length > p.maxOutputBytes;
    stdout = Buffer.concat([stdout, output]).subarray(-p.maxOutputBytes);
  });
  child.stderr.on("data", (data) => {
    truncated ||= stderr.length + data.length > p.maxOutputBytes;
    stderr = Buffer.concat([stderr, data]).subarray(-p.maxOutputBytes);
  });
  const stop = (why: NativeEndReason) => {
    if (reason !== NativeEndReason.Exit) return;
    reason = why;
    void writeFile(path.join(control, "stop"), "stop").catch(() => {});
    if (!existsSync(path.join(control, "broker.ready"))) void killProcessTree(child.pid);
    force = setTimeout(() => {
      void killProcessTree(child.pid);
    }, STOP_GRACE_MS);
    force.unref();
  };
  const abort = () => stop(NativeEndReason.Cancelled);
  const timeout = setTimeout(() => stop(NativeEndReason.Timeout), p.timeoutMs);
  timeout.unref();
  p.signal.addEventListener("abort", abort, { once: true });
  if (p.signal.aborted) abort();
  const cleanup = () => {
    clearTimeout(timeout);
    clearTimeout(force);
    p.signal.removeEventListener("abort", abort);
  };
  return new Promise<NativeProcessResult>((resolve, reject) => {
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", async (code) => {
      cleanup();
      try {
        resolve(await closedResult(code, reason, control, stdout, stderr, truncated));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** A stop during compilation has no runtime PID or outcome; completed brokers report their outcome. */
async function closedResult(
  code: number | null,
  reason: NativeEndReason,
  control: string,
  stdout: Buffer,
  stderr: Buffer,
  truncated: boolean,
): Promise<NativeProcessResult> {
  const output = { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), signal: null, truncated };
  if (code !== 0) {
    if (reason === NativeEndReason.Exit) throw new Error(MESSAGE.helperFailed(output.stderr));
    return { ...output, code: null, reason, pid: null };
  }
  const outcome = await readOutcome(control);
  return {
    ...output,
    code: outcome.code,
    pid: outcome.pid,
    reason: reason === NativeEndReason.Exit ? outcome.reason : reason,
  };
}

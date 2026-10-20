/**
 * The Windows sandbox starts when Windows has reserved some of srt-win's proxy ports
 * (60080-60089), as winnat does for Hyper-V, WSL and Docker, and says what to do when it reserved
 * all of them: the real srt-win backend, no mocks. A persistent TCP port reservation
 * (`CreatePersistentTcpPortReservation`, the reservation winnat makes) makes Windows refuse a
 * listen there with EACCES; an administered `netsh` exclusion does not.
 *
 * Its own file, so its starts are this process's own. Windows only, on a disposable machine whose
 * sandbox is provisioned (the Windows CI job): it reserves ports machine-wide, as administrator.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { SandboxLaunchCode, SandboxLaunchError } from "../../src/substrate/sandbox-unavailable.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);

/** Why this machine cannot run the suite, or false when it can. */
function skipReason(): string | false {
  if (process.platform !== "win32") return "Windows only: the srt-win backend";
  if (process.env.GENEX_WINDOWS_SANDBOX !== "ready") return "needs a provisioned sandbox (GENEX_WINDOWS_SANDBOX=ready)";
  if (process.env.CI !== "true") return "reserves ports machine-wide: a disposable CI machine only";
  return false;
}
const SKIP = skipReason();

const TEST_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 60_000;
const RANGE_LOW = 60080;
const RANGE_SIZE = 10;
/** The proxy's port in the sandboxed command's proxy variable, without its token. */
const PROXY_PORT = /@127\.0\.0\.1:(\d+)/;

/** iphlpapi's persistent TCP port reservation, from Windows PowerShell; the start port goes in network byte order. */
const RESERVATION_API = `
Add-Type -Namespace GenexTest -Name Ports -MemberDefinition @'
[DllImport("iphlpapi.dll")] public static extern uint CreatePersistentTcpPortReservation(ushort StartPort, ushort NumberOfPorts, out ulong Token);
[DllImport("iphlpapi.dll")] public static extern uint DeletePersistentTcpPortReservation(ushort StartPort, ushort NumberOfPorts);
'@`;

const networkOrder = (port: number) => ((port & 0xff) << 8) | (port >> 8);

async function powershell(script: string): Promise<string> {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
  });
  return stdout.trim();
}

let reserved: number | undefined;

/** Reserve the first `count` ports of the range, as winnat does. */
async function reserve(count: number): Promise<void> {
  const result = await powershell(
    `${RESERVATION_API}\n$t = 0; [GenexTest.Ports]::CreatePersistentTcpPortReservation(${networkOrder(RANGE_LOW)}, ${count}, [ref]$t)`,
  );
  assert.equal(result, "0", `the reservation failed with Windows error ${result}`);
  reserved = count;
}

async function release(): Promise<void> {
  if (reserved === undefined) return;
  await powershell(
    `${RESERVATION_API}\n[GenexTest.Ports]::DeletePersistentTcpPortReservation(${networkOrder(RANGE_LOW)}, ${reserved})`,
  );
  reserved = undefined;
}

let root: string | undefined;
let sandbox: ProcessSandbox | undefined;

async function start(name: string): Promise<{ sandbox: ProcessSandbox; workspace: string }> {
  // Long names, as the app's own folders have: `os.tmpdir()` can be spelled with an 8.3 name.
  root ??= realpathSync.native(await tmpDir("genex-sandbox-ports-"));
  const workspace = path.join(root, name);
  await mkdir(workspace, { recursive: true });
  sandbox = await ProcessSandbox.create({
    writableRoots: [workspace],
    scratchDir: path.join(root, `${name}-scratch`),
    secretPaths: [],
  });
  return { sandbox, workspace };
}

afterEach(async () => {
  if (SKIP) return;
  await sandbox?.dispose();
  sandbox = undefined;
  await release();
});

after(async () => {
  if (SKIP) return;
  if (root) await removeTree(root);
});

describe("Windows sandbox: reserved proxy ports", { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () => {
  it("starts on the ports Windows left free, and its commands reach the proxy there", async () => {
    await reserve(2);
    const { sandbox: started, workspace } = await start("partly-reserved");
    const result = await started.run({
      command: `printf '%s\\n' "$HTTP_PROXY"; curl -s -o /dev/null -w '%{http_code}' http://reserved-ports.invalid/`,
      cwd: workspace,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    assert.equal(result.code, 0, result.stderr);
    const [proxy = "", status = ""] = result.stdout.trim().split(/\r?\n/);
    const port = Number(PROXY_PORT.exec(proxy)?.[1]);
    assert.ok(port >= RANGE_LOW + 2 && port < RANGE_LOW + RANGE_SIZE, `the proxy listens on ${port}`);
    assert.notEqual(status, "000", "the sandboxed command reaches the proxy, which answers for the refused host");
  });

  it("says which ports and what to do when Windows reserved every one", async () => {
    await reserve(RANGE_SIZE);
    await assert.rejects(start("all-reserved"), (error: unknown) => {
      assert.ok(error instanceof SandboxLaunchError, String(error));
      assert.equal(error.code, SandboxLaunchCode.ProxyPortsRefused);
      return true;
    });
  });
});

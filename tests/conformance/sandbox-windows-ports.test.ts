/**
 * The Windows sandbox starts when Windows has reserved some of srt-win's proxy ports
 * (60080-60089), as winnat does for Hyper-V, WSL and Docker, and says what to do when it reserved
 * all of them: the real srt-win backend, no mocks. A persistent TCP port reservation
 * (`CreatePersistentTcpPortReservation`, the reservation winnat makes) makes Windows refuse a
 * listen there with EACCES; an administered `netsh` exclusion does not.
 *
 * Its own file, so its starts are this process's own. Windows only, on a disposable machine whose
 * sandbox is provisioned (the Windows CI job): it reserves ports machine-wide, as administrator, so
 * the Windows suite runs it alone (`RUN_ALONE` in scripts/test-windows.mjs).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
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
/** How long a reservation waits for other test files' sandboxes to let go of the range. */
const RESERVE_WAIT_MS = 120_000;
const RESERVE_RETRY_MS = 500;
/** Windows' answer to a reservation over a port something listens on: ERROR_SHARING_VIOLATION. */
const PORT_IN_USE = "32";
/** The proxy's port in the sandboxed command's proxy variable. */
const PROXY_PORT = /(?:127\.0\.0\.1|localhost):(\d+)/;
/** The credentials in a proxy URL, kept out of a failure's message. */
const PROXY_CREDENTIALS = /\/\/[^@/]*@/;

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

/**
 * Reserve the first `count` ports of the range, as winnat does. Other test files run sandboxes at
 * the same time, and Windows refuses to reserve a port one of their proxies listens on: wait for it.
 */
async function reserve(count: number): Promise<void> {
  const deadline = Date.now() + RESERVE_WAIT_MS;
  for (;;) {
    const result = await powershell(
      `${RESERVATION_API}\n$t = 0; [GenexTest.Ports]::CreatePersistentTcpPortReservation(${networkOrder(RANGE_LOW)}, ${count}, [ref]$t)`,
    );
    if (result === "0") {
      reserved = count;
      return;
    }
    if (result !== PORT_IN_USE || Date.now() > deadline)
      assert.fail(`the reservation failed with Windows error ${result}`);
    await sleep(RESERVE_RETRY_MS);
  }
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
    // The proxies are bound now; other test files' sandboxes need the range back.
    await release();
    const result = await started.run({
      // A file, not /dev/null: Windows paths reach native programs unchanged (MSYS_NO_PATHCONV), and curl.exe has no /dev/null.
      command: `printf '%s\\n' "\${HTTP_PROXY:-$http_proxy}"; status=$(curl -s -o proxy-answer.txt -w '%{http_code}' http://reserved-ports.invalid/); printf '%s\\n' "$status"`,
      cwd: workspace,
      timeoutMs: RUN_TIMEOUT_MS,
    });
    assert.equal(result.code, 0, result.stderr);
    const [proxy = "", status = ""] = result.stdout.trim().split(/\r?\n/);
    const port = Number(PROXY_PORT.exec(proxy)?.[1]);
    assert.ok(
      port >= RANGE_LOW + 2 && port < RANGE_LOW + RANGE_SIZE,
      `the proxy listens on ${port} (${proxy.replace(PROXY_CREDENTIALS, "//…@")})`,
    );
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

/**
 * srt-win starts every sandboxed command as the sandbox user through the Secondary Logon service
 * (`seclogon`); where hardening disabled it, Windows refuses each start. Genex reads the service's
 * start type from `sc qc seclogon` without elevation, and Set up turns it back on (Manual) behind
 * Windows' approval prompt. These pin the parse, the read and the elevated step's answers over
 * fakes; on the Windows runner the real `sc` is read and the elevated step runs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enableLogonService,
  LOGON_SERVICE_CANCELLED_EXIT,
  logonServiceStartType,
  ServiceStartType,
  serviceStartType,
} from "../../src/substrate/windows-logon-service.ts";

/** `sc qc seclogon` on an English Windows, with the start type line given. */
function scQc(startType: string): string {
  return [
    "[SC] QueryServiceConfig SUCCESS",
    "",
    "SERVICE_NAME: seclogon",
    "        TYPE               : 20  WIN32_SHARE_PROCESS",
    `        START_TYPE         : ${startType}`,
    "        ERROR_CONTROL      : 1   NORMAL",
    "        BINARY_PATH_NAME   : C:\\WINDOWS\\system32\\svchost.exe -k netsvcs -p",
    "        LOAD_ORDER_GROUP   :",
    "        TAG                : 0",
    "        DISPLAY_NAME       : Secondary Logon",
    "        DEPENDENCIES       :",
    "        SERVICE_START_NAME : LocalSystem",
    "",
  ].join("\r\n");
}

describe("the Secondary Logon service's start type", () => {
  it("is read from the start type's number in `sc qc`, whatever word follows it", () => {
    const rows: Array<[string, ServiceStartType | null]> = [
      ["4   DISABLED", ServiceStartType.Disabled],
      ["3   DEMAND_START", ServiceStartType.Demand],
      ["2   AUTO_START", ServiceStartType.Auto],
      ["2   AUTO_START  (DELAYED)", ServiceStartType.Auto],
      ["1   SYSTEM_START", ServiceStartType.System],
      ["0   BOOT_START", ServiceStartType.Boot],
      // The number decides: a localized word after it changes nothing.
      ["4   DESACTIVADO", ServiceStartType.Disabled],
    ];
    for (const [line, expected] of rows) assert.equal(serviceStartType(scQc(line)), expected, line);
    assert.equal(serviceStartType(scQc("4   DISABLED").replaceAll("\r\n", "\n")), ServiceStartType.Disabled, "LF");
  });

  it("is unknown when `sc` did not answer with one", () => {
    const rows = [
      "",
      "[SC] OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n",
      scQc("9   UNHEARD_OF"),
      scQc("DISABLED"),
    ];
    for (const output of rows) assert.equal(serviceStartType(output), null, JSON.stringify(output.slice(0, 60)));
  });

  it("is read from the start type's own line, never from another field that mentions it", () => {
    const named = scQc("3   DEMAND_START").replace("Secondary Logon", "START_TYPE : 4   DISABLED");
    assert.equal(serviceStartType(named), ServiceStartType.Demand);
  });

  it("answers what `sc qc seclogon` says, and unknown when it cannot be asked", async () => {
    assert.equal(await logonServiceStartType(async () => scQc("4   DISABLED")), ServiceStartType.Disabled);
    assert.equal(await logonServiceStartType(async () => scQc("3   DEMAND_START")), ServiceStartType.Demand);
    assert.equal(
      await logonServiceStartType(async () => {
        throw Object.assign(new Error("Command failed: sc.exe qc seclogon"), { code: 1060 });
      }),
      null,
    );
  });
});

describe("turning the Secondary Logon service back on", () => {
  it("is done when the elevated step exits cleanly", async () => {
    assert.deepEqual(await enableLogonService(async () => ({ status: 0, stderr: "" })), { cancelled: false });
  });

  it("is cancelled, not failed, when the approval prompt was dismissed", async () => {
    const answer = await enableLogonService(async () => ({ status: LOGON_SERVICE_CANCELLED_EXIT, stderr: "" }));
    assert.deepEqual(answer, { cancelled: true });
  });

  it("fails with the step's exit status and words when Windows would not change it", async () => {
    await assert.rejects(
      enableLogonService(async () => ({ status: 5, stderr: "[SC] ChangeServiceConfig FAILED 5: Access is denied." })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /seclogon/);
        assert.match(error.message, /\b5\b/);
        assert.match(error.message, /Access is denied/);
        return true;
      },
    );
    await assert.rejects(
      enableLogonService(async () => {
        throw new Error("spawn powershell.exe ENOENT");
      }),
      /ENOENT/,
    );
  });
});

describe("on the Windows runner", { skip: windowsRunnerSkip() }, () => {
  it("reads the real service's start type without elevation", async () => {
    const startType = await logonServiceStartType();
    assert.ok(startType !== null, "sc qc seclogon answered");
    assert.notEqual(startType, ServiceStartType.Disabled, "the runner starts sandboxed commands");
  });

  it("runs the elevated step and leaves the service on Manual", async () => {
    assert.deepEqual(await enableLogonService(), { cancelled: false });
    assert.equal(await logonServiceStartType(), ServiceStartType.Demand);
  });
});

/** The real `sc` and the elevated step run only on a disposable, already elevated Actions runner. */
function windowsRunnerSkip(): string | false {
  if (process.platform !== "win32") return "Windows only";
  if (process.env.GITHUB_ACTIONS !== "true") return "changes a Windows service: only on a disposable Actions runner";
  return false;
}

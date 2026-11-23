/**
 * srt-win starts every sandboxed command as the sandbox user with an interactive logon. Where a
 * policy or a security program took that account's "Allow log on locally" right, Windows refuses
 * each start (ERROR_LOGON_TYPE_NOT_GRANTED, feedback from 0.1.46 on a Chinese Windows 11), and Set
 * up gives the right back behind Windows' approval prompt. These pin the elevated step's answers
 * over fakes; on the Windows runner the real step runs against the real account.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ELEVATION_CANCELLED_EXIT } from "../../src/substrate/windows-elevated.ts";
import { allowSandboxLogon, sandboxLogonAllowed } from "../../src/substrate/windows-logon-right.ts";

describe("letting the sandbox user sign in", () => {
  it("is cancelled, not failed, when the approval prompt was dismissed, and nothing is remembered", async () => {
    const answer = await allowSandboxLogon(async () => ({ status: ELEVATION_CANCELLED_EXIT, stderr: "" }));
    assert.deepEqual(answer, { cancelled: true });
    assert.equal(sandboxLogonAllowed(), false);
  });

  it("fails with the step's exit status and what it stands for when Windows would not", async () => {
    const rows: Array<[number, RegExp]> = [
      [20, /no such account/],
      [22, /SeInteractiveLogonRight/],
      [23, /SeDenyInteractiveLogonRight/],
      [24, /PowerShell/],
      [77, /exit 77/],
    ];
    for (const [status, words] of rows) {
      await assert.rejects(
        allowSandboxLogon(async () => ({ status, stderr: "" })),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /srt-sandbox/);
          assert.match(error.message, new RegExp(`exit ${status}\\b`));
          assert.match(error.message, words);
          return true;
        },
      );
    }
    await assert.rejects(
      allowSandboxLogon(async () => {
        throw new Error("spawn powershell.exe ENOENT");
      }),
      /ENOENT/,
    );
    assert.equal(sandboxLogonAllowed(), false, "a failed step is not remembered as done");
  });

  it("is done when the elevated step exits cleanly, and the run remembers it", async () => {
    assert.deepEqual(await allowSandboxLogon(async () => ({ status: 0, stderr: "" })), { cancelled: false });
    assert.equal(sandboxLogonAllowed(), true);
  });
});

describe("on the Windows runner", { skip: windowsRunnerSkip() }, () => {
  it("runs the elevated step against the real sandbox account", async () => {
    assert.deepEqual(await allowSandboxLogon(), { cancelled: false });
  });
});

/** The elevated step changes the PC's security policy: only on a disposable, already elevated Actions runner. */
function windowsRunnerSkip(): string | false {
  if (process.platform !== "win32") return "Windows only";
  if (process.env.GITHUB_ACTIONS !== "true")
    return "changes Windows' security policy: only on a disposable Actions runner";
  return false;
}

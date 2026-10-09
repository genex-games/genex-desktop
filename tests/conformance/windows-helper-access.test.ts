import assert from "node:assert/strict";
import { test } from "node:test";
import type { WindowsSandboxUserStatus } from "@anthropic-ai/sandbox-runtime";
import { SandboxProblemCode } from "../../src/shared/boot.ts";
import { SandboxUnavailableError } from "../../src/substrate/sandbox-unavailable.ts";
import { windowsHelperAccess } from "../../src/substrate/windows-helper-access.ts";

const HELPER = "C:\\Genex\\srt-win.exe";
const READY: WindowsSandboxUserStatus = {
  provisioned: true,
  sid: "test-sandbox-sid",
  groupExists: true,
  inBuiltinUsers: true,
  inSandboxGroup: true,
  hiddenFromLogon: true,
  credPresent: true,
  realUserSid: "test-host-sid",
};

function fixture(status: WindowsSandboxUserStatus) {
  const grants: unknown[] = [];
  let revokes = 0;
  const access = windowsHelperAccess(HELPER, {
    resolveSrtWin: () => ({ exe: HELPER, prependArgs: [] }),
    getWindowsSandboxUserStatusAsync: async () => status,
    getWindowsWfpStatusAsync: async () => ({ state: "installed", filters: 6 }),
    grantWindowsAcl: (input) => {
      grants.push(input);
      return { outcomes: [] };
    },
    revokeWindowsAcl: () => {
      revokes++;
      return [];
    },
  });
  return { access, grants, revokes: () => revokes };
}

for (const status of [
  { ...READY, provisioned: false, credPresent: false, sid: undefined },
  { ...READY, credPresent: false },
  { ...READY, sid: undefined },
]) {
  test(`missing Windows provisioning opens setup before SDK initialization (${JSON.stringify(status)})`, async () => {
    const f = fixture(status);
    await assert.rejects(f.access.grant(), (error: unknown) => {
      assert.ok(error instanceof SandboxUnavailableError);
      assert.equal(error.problem.code, SandboxProblemCode.NotProvisioned);
      assert.deepEqual(error.problem.installCommands, []);
      return true;
    });
    await f.access.revoke();
    assert.deepEqual(f.grants, [], "no ACL mutation on a missing or incomplete install");
    assert.equal(f.revokes(), 0);
  });
}

test("a provisioned sandbox grants only the shipped helper and releases once", async () => {
  const f = fixture(READY);
  await f.access.grant();
  assert.equal(f.grants.length, 1);
  assert.deepEqual(f.grants[0], {
    read: [HELPER],
    write: [],
    sandboxUserSid: READY.sid,
    srtWin: { exe: HELPER, prependArgs: [] },
  });
  f.access.revokeSync();
  await f.access.revoke();
  assert.equal(f.revokes(), 1);
});

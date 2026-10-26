// Run the installed SandboxManager in its own process; no host ACLs or sandbox state are touched.
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2];
const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "dist");
const moduleUrl = (file) => pathToFileURL(path.join(dist, file)).href;
mock.module(moduleUrl("utils/platform.js"), { namedExports: { getPlatform: () => "windows", getWslVersion: () => undefined } });
const windows = await import(moduleUrl("sandbox/windows-sandbox-utils.js"));
const events = [];
const calls = [];
const gate = Promise.withResolvers();
const failure = new Error("synthetic ACL failure");
const srtWin = { exe: "fixture-srt-win", prependArgs: [] };
const outcomes = [{ path: "fixture", status: "stillHeld" }];
/** What a cleanup call answers: a revoke says it completed, so the restore may follow. */
const answer = (kind) => (kind === "revoke" ? { complete: true, outcomes, pending: [] } : outcomes);
const syncCleanup = (kind) => (opts) => {
  events.push(`sync ${kind}`);
  calls.push({ kind, opts });
  return answer(kind);
};
const asyncCleanup = (kind) => async (opts) => {
  events.push(`async ${kind} start`);
  calls.push({ kind, opts });
  await gate.promise;
  events.push(`async ${kind} end`);
  return answer(kind);
};
const capabilities = Object.values(windows.WINDOWS_SRT_WIN_CAPABILITIES);
mock.module(moduleUrl("sandbox/windows-sandbox-utils.js"), {
  namedExports: {
    ...windows,
    checkWindowsDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    getWindowsSandboxUserStatusAsync: async () => ({
      provisioned: true,
      credPresent: true,
      sid: "fixture-sid",
      capabilities,
    }),
    verifyWindowsWfpEgress: async () => {
      events.push("egress");
      if (["egress-failure", "exit-rollback"].includes(scenario)) throw failure;
    },
    resolveSrtWin: () => srtWin,
    expandWindowsFsPaths: (paths) => paths,
    grantWindowsAclPersistent: async () => {
      events.push("grant");
      if (scenario === "exit-grant") await new Promise(() => {});
      if (scenario === "grant-failure") throw failure;
    },
    revokeWindowsAclChecked: syncCleanup("revoke"),
    restoreWindowsAcl: syncCleanup("restore"),
    revokeWindowsAclCheckedAsync: asyncCleanup("revoke"),
    restoreWindowsAclAsync: asyncCleanup("restore"),
  },
});
const { SandboxManager } = await import(moduleUrl("sandbox/sandbox-manager.js"));
const config = {
  network: { allowedDomains: [], deniedDomains: [], httpProxyPort: 43120, socksProxyPort: 43121 },
  filesystem: { allowRead: ["fixture-read"], allowWrite: [], denyRead: ["fixture-secret"], denyWrite: [] },
  windows: { srtWin: { path: "fixture-srt-win" } },
};
const report = { events, calls };
let settled = false;
const starting = SandboxManager.initialize(config).catch((error) => {
  report.originalError = error === failure;
}).finally(() => { settled = true; });

if (["grant-failure", "egress-failure", "exit-grant", "exit-rollback"].includes(scenario)) {
  await setImmediate();
} else {
  await starting;
  settled = false;
}
if (scenario.startsWith("exit-")) {
  // The real exit event cannot finish promises. Both cleanup commands must run synchronously.
  process.once("exit", () => writeSync(1, JSON.stringify(report)));
  process.exit(0);
}
let cleanup = starting;
if (scenario === "reset") cleanup = SandboxManager.reset().finally(() => { settled = true; });
if (scenario === "signal") process.emit("SIGTERM");
await setImmediate();
report.beforeRelease = [...events];
report.settledBeforeRelease = settled;
gate.resolve();
await cleanup;
await setImmediate();
await SandboxManager.reset();
writeSync(1, JSON.stringify(report));

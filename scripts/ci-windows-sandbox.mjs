/**
 * Windows CI only: provision sandbox-runtime's Windows sandbox (the `srt-sandbox` user and its
 * WFP egress filters) with the vendored srt-win, so the sandbox suites can run on the runner. The
 * hosted runner is elevated and disposable, so the one-time install needs no UAC prompt there.
 * It creates a local user account: it refuses to run outside GitHub Actions, never on a personal
 * machine. On success it exports GENEX_WINDOWS_SANDBOX=ready to later steps; on failure it
 * prints an Actions error annotation with the reason and exits 1.
 */
import fs from "node:fs";
import { patchSandboxRuntime } from "./patch-sandbox-runtime.mjs";

const INSTALL_TIMEOUT_MS = 180_000;
const READY_ENV = "GENEX_WINDOWS_SANDBOX=ready";

/** The install result without the CA certificate body; the rest is diagnostic. */
function redacted(status) {
  return { ...status, user: { ...status.user, caCertPem: status.user?.caCertPem ? "(present)" : undefined } };
}

function fail(reason, detail) {
  console.log(`::error title=Windows sandbox setup::${reason}`);
  if (detail !== undefined) console.log(JSON.stringify(detail, null, 2));
  process.exit(1);
}

async function main() {
  if (process.platform !== "win32") fail("ci-windows-sandbox runs on Windows only");
  if (process.env.GITHUB_ACTIONS !== "true") fail("ci-windows-sandbox runs only on a disposable GitHub Actions runner");
  await patchSandboxRuntime();
  const srt = await import("@anthropic-ai/sandbox-runtime");
  const srtWin = srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
  const started = performance.now();
  const result = await srt.installWindowsSandboxAsync({ srtWin, timeoutMs: INSTALL_TIMEOUT_MS });
  const installMs = Math.round(performance.now() - started);
  const provisioned = result.user?.provisioned === true && !result.cancelled;
  if (!provisioned) fail("the srt-sandbox user was not provisioned", redacted(result));
  if (result.wfp?.state !== "installed") fail(`WFP filters are ${result.wfp?.state ?? "unknown"}`, redacted(result));
  console.log(`Windows sandbox ready in ${installMs} ms (${srt.VENDORED_SRT_WIN_EXE})`);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${READY_ENV}\n`);
}

main().catch((error) => fail(`install threw: ${error?.message ?? error}`, { code: error?.code, stack: error?.stack }));

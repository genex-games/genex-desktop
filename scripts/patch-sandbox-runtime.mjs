/** Local, version-guarded fixes to SRT 0.0.73, applied at install and build time.
 *
 * 1. An absolute executable needs no subprocess PATH lookup. SRT otherwise runs `which /bin/bash`
 *    with a one-second timeout and reports a present shell as missing under load.
 * 2. Windows `initialize()` runs srt-win without holding the event loop. SRT spawns its egress
 *    check (seconds on a fresh process) and the folder grants and deny stamps (which scale with
 *    the folders) with `spawnSync`; on Electron's main thread that froze the start window into
 *    "Not Responding". The same srt-win calls run through SRT's own `runSrtWinAsync` instead.
 * 3. Those steps report how long they took (`setStudioStepLog`), so Genex's log shows which part
 *    of a slow start the time went to.
 * 4. Rollback and reset also yield during ACL cleanup (two srt-win commands). Only the actual
 *    process exit event keeps synchronous cleanup, including partially applied initialization.
 * 5. Every srt-win ACL call (grant, stamp, revoke and restore, each sync and async) and the egress
 *    check wait {@link SRT_WIN_TIMEOUT_MS} instead of SRT's 60 and 30 seconds.
 *
 * Policy generation, arguments and outcomes are untouched. */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);

/** `original` with each [from, to] replaced once; a `from` found other than once means SRT changed. */
function replaceOnce(original, edits, what) {
  let fixed = original;
  for (const [from, to] of edits) {
    if (fixed.split(from).length !== 2) throw new Error(`${what} changed; the sandbox patch requires review`);
    fixed = fixed.replace(from, to);
  }
  return fixed;
}

/** Apply `patch` to `file` (relative to SRT's `dist`) unless `marker` shows it was applied. */
async function patchFile(dist, file, marker, patch) {
  const target = path.join(dist, file);
  const original = await readFile(target, "utf8");
  if (original.includes(marker)) return;
  await writeFile(target, patch(original));
}

const WHICH_MARKER = "// Studio: absolute executable lookup";
const ASYNC_MARKER = "// Studio: srt-win off the event loop";
const CLEANUP_MARKER = "// Studio: async ACL cleanup with synchronous exit fallback";
const DEADLINE_MARKER = "// Studio: srt-win deadlines";

/**
 * How long srt-win may take over an ACL call or the egress check. A grant or stamp passes an entry
 * down through everything under a folder, so a slow disk or an antivirus scanning each file it
 * touches can take a large folder past SRT's 60 seconds; the egress check, the first start as the
 * sandbox user after a cold boot, past its 30. Either running out of time fails the start.
 */
const SRT_WIN_TIMEOUT_MS = 120_000;
/**
 * The srt-win calls {@link patchDeadlines} gives {@link SRT_WIN_TIMEOUT_MS}, each with SRT's own
 * deadline: the ACL calls (SRT's synchronous ones and the async twins the patches above add) and
 * the egress check.
 */
const SRT_DEADLINES = [
  ...["grant", "stamp", "revoke", "restore"].flatMap((verb) => [
    [`${verb}WindowsAcl`, 60_000],
    [`${verb}WindowsAclAsync`, 60_000],
  ]),
  ["verifyWindowsWfpEgress", 30_000],
];

/** Derive an async twin from the pinned implementation, retaining its arguments, parsing and errors. */
function asyncTwin(original, name, from, to) {
  const signature = `function ${name}(`;
  if (original.split(signature).length !== 2) throw new Error(`SRT ${name} changed; review the cleanup patch`);
  const start = original.indexOf(signature);
  const end = original.indexOf("\n}", start);
  if (end < 0) throw new Error(`SRT ${name} has no function boundary; review the cleanup patch`);
  return replaceOnce(
    original.slice(start, end + 2),
    [
      [signature, `async function ${name}Async(`],
      [from, to],
    ],
    name,
  );
}

function patchManagerCleanup(original) {
  return replaceOnce(
    original,
    [
      [
        "grantWindowsAclAsync, stampWindowsAclAsync,",
        "grantWindowsAclAsync, stampWindowsAclAsync, revokeWindowsAclAsync, restoreWindowsAclAsync,",
      ],
      ["let windowsFsStampedSet;", `${CLEANUP_MARKER}\nlet studioWindowsAclPending = false;\nlet windowsFsStampedSet;`],
      [
        "const cleanupHandler = () => reset().catch(e => {",
        "const cleanupHandler = (exiting = false) => reset(exiting).catch(e => {",
      ],
      ["process.once('exit', cleanupHandler);", "process.once('exit', () => cleanupHandler(true));"],
      ["process.once('SIGINT', cleanupHandler);", "process.once('SIGINT', () => cleanupHandler());"],
      ["process.once('SIGTERM', cleanupHandler);", "process.once('SIGTERM', () => cleanupHandler());"],
      [
        "windowsFsSbUserSid = sb;",
        `windowsFsSbUserSid = sb;
            // Exit must release partial grants too, including while rollback is awaiting srt-win.
            studioWindowsAclPending = [acc.grantRead, acc.grantWrite, acc.denyRead, acc.denyWrite].some(paths => paths.length > 0);`,
      ],
      [
        "                revokeWindowsAcl({ sandboxUserSid: windowsFsSbUserSid, srtWin });",
        "                await revokeWindowsAclAsync({ sandboxUserSid: windowsFsSbUserSid, srtWin });",
      ],
      [
        "                restoreWindowsAcl({ sandboxUserSid: windowsFsSbUserSid, srtWin });",
        "                await restoreWindowsAclAsync({ sandboxUserSid: windowsFsSbUserSid, srtWin });",
      ],
      [
        "            windowsFsSbUserSid = undefined;",
        "            studioWindowsAclPending = false;\n            windowsFsSbUserSid = undefined;",
      ],
      ["async function reset() {", "async function reset(synchronousWindowsAcl = false) {"],
      [
        "if (windowsFsStampedSet && windowsFsSbUserSid) {",
        "if ((windowsFsStampedSet || studioWindowsAclPending) && windowsFsSbUserSid) {",
      ],
      [
        "        for (const e of revokeWindowsAcl({ sandboxUserSid: sb, srtWin }) ?? []) {",
        `        // Promises cannot finish in process's exit event; all live teardown yields instead.
        const revoked = synchronousWindowsAcl
            ? revokeWindowsAcl({ sandboxUserSid: sb, srtWin })
            : await revokeWindowsAclAsync({ sandboxUserSid: sb, srtWin });
        for (const e of revoked ?? []) {`,
      ],
      [
        "        for (const e of restoreWindowsAcl({ sandboxUserSid: sb, srtWin }) ?? []) {",
        `        const restored = synchronousWindowsAcl
            ? restoreWindowsAcl({ sandboxUserSid: sb, srtWin })
            : await restoreWindowsAclAsync({ sandboxUserSid: sb, srtWin });
        for (const e of restored ?? []) {`,
      ],
      [
        "    windowsFsStampedSet = undefined;",
        "    studioWindowsAclPending = false;\n    windowsFsStampedSet = undefined;",
      ],
    ],
    "SandboxManager's Windows cleanup",
  );
}

async function patchCleanup(dist) {
  await patchFile(dist, "sandbox/windows-sandbox-utils.js", CLEANUP_MARKER, (original) => {
    const parser = asyncTwin(
      original,
      "runSrtWinJsonAllowFail",
      "runSrtWin(args, opts)",
      "await runSrtWinAsync(args, opts)",
    );
    const twins = ["revokeWindowsAcl", "restoreWindowsAcl"].map(
      (name) => `export ${asyncTwin(original, name, "runSrtWinJsonAllowFail(", "await runSrtWinJsonAllowFailAsync(")}`,
    );
    return `${original}\n${CLEANUP_MARKER}.\n${parser}\n${twins.join("\n")}\n`;
  });
  await patchFile(dist, "sandbox/sandbox-manager.js", CLEANUP_MARKER, patchManagerCleanup);
  await patchFile(
    dist,
    "index.js",
    CLEANUP_MARKER,
    (original) =>
      `${original}\n${CLEANUP_MARKER}.\nexport { revokeWindowsAclAsync, restoreWindowsAclAsync } from './sandbox/windows-sandbox-utils.js';\n`,
  );
}

/**
 * The async twins of SRT's `grantWindowsAcl` and `stampWindowsAcl` (same arguments, same errors,
 * SRT's deadline until {@link patchDeadlines}), and the step log they and the egress check report to.
 */
const ACL_ASYNC = `
${ASYNC_MARKER}: initialize() grants and stamps through these.
let studioStepLog;
/** Genex's log of how long each srt-win step of initialize took: \`(step, ms)\`. */
export function setStudioStepLog(log) {
    studioStepLog = log;
}
function studioStep(step, started) {
    studioStepLog?.(step, Date.now() - started);
}
export async function grantWindowsAclAsync(opts) {
    const holder = opts.holderPid ?? process.pid;
    const stdin = JSON.stringify({ read: opts.read, write: opts.write });
    const started = Date.now();
    const r = await runSrtWinAsync(['acl', 'grant', '--holder-pid', \`\${holder}\`, '--sandbox-user-sid', opts.sandboxUserSid], { timeoutMs: 60000, stdin, srtWin: opts.srtWin });
    studioStep('acl grant', started);
    logForDebugging(\`[Sandbox Windows] acl grant exit=\${r.status}: \${r.stderr || r.stdout}\`);
    if (r.status !== 0) {
        throw new WindowsSandboxError('acl_grant_failed', \`srt-win acl grant exited \${r.status}: \${r.stderr || r.stdout}\`);
    }
}
export async function stampWindowsAclAsync(opts) {
    const holder = opts.holderPid ?? process.pid;
    const stdin = JSON.stringify({ denyRead: opts.denyRead, denyWrite: opts.denyWrite });
    const started = Date.now();
    const r = await runSrtWinAsync(['acl', 'stamp', '--holder-pid', \`\${holder}\`, '--sandbox-user-sid', opts.sandboxUserSid], { timeoutMs: 60000, stdin, srtWin: opts.srtWin });
    studioStep('acl stamp', started);
    logForDebugging(\`[Sandbox Windows] acl stamp exit=\${r.status}: \${r.stderr || r.stdout}\`);
    if (r.status !== 0) {
        throw new WindowsSandboxError('acl_stamp_failed', \`srt-win acl stamp exited \${r.status} \` +
            (r.status === 2 ? '(partial — some inputs skipped)' : '(failed)') +
            \`: \${r.stderr || r.stdout}\`);
    }
}
`;

/** `original` with SRT's deadline replaced inside each of {@link SRT_DEADLINES}; a call found other than once means SRT changed. */
function patchDeadlines(original) {
  let fixed = original;
  for (const [name, srtMs] of SRT_DEADLINES) {
    const signature = `function ${name}(`;
    if (fixed.split(signature).length !== 2) throw new Error(`SRT ${name} changed; review the srt-win deadline patch`);
    const start = fixed.indexOf(signature);
    const end = fixed.indexOf("\n}", start);
    if (end < 0) throw new Error(`SRT ${name} has no function boundary; review the srt-win deadline patch`);
    const body = replaceOnce(
      fixed.slice(start, end),
      [[`timeoutMs: ${srtMs}`, `timeoutMs: ${SRT_WIN_TIMEOUT_MS}`]],
      name,
    );
    fixed = fixed.slice(0, start) + body + fixed.slice(end);
  }
  return `${fixed}\n${DEADLINE_MARKER}: ${SRT_WIN_TIMEOUT_MS} ms for each ACL call and the egress check.\n`;
}

export async function patchSandboxRuntime() {
  const pkg = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  const metadata = JSON.parse(await readFile(pkg, "utf8"));
  if (metadata.version !== "0.0.73")
    throw new Error("Review the sandbox-runtime patches before changing sandbox-runtime version");
  const dist = path.join(path.dirname(pkg), "dist");
  await patchFile(dist, "utils/which.js", WHICH_MARKER, (original) => {
    const marker = "export function whichSync(bin) {";
    return (
      "import { accessSync, statSync, constants } from 'node:fs';\nimport { isAbsolute } from 'node:path';\n" +
      replaceOnce(
        original,
        [
          [
            marker,
            `${marker}
    ${WHICH_MARKER} must not depend on a timed subprocess.
    if (isAbsolute(bin)) {
        try { accessSync(bin, constants.X_OK); return statSync(bin).isFile() ? bin : null; }
        catch { return null; }
    }`,
          ],
        ],
        "Sandbox executable lookup",
      )
    );
  });
  await patchFile(dist, "sandbox/windows-sandbox-utils.js", ASYNC_MARKER, (original) => {
    const verify = "const r = runSrtWin(['wfp', 'verify', '--target', target], {";
    const fixed = replaceOnce(
      original,
      [
        [
          verify,
          `${ASYNC_MARKER}: the egress check.\n        const started = Date.now();\n        const r = await runSrtWinAsync(['wfp', 'verify', '--target', target], {`,
        ],
        [
          "logForDebugging(`[Sandbox Windows] wfp verify exit=",
          "studioStep('wfp verify', started);\n        logForDebugging(`[Sandbox Windows] wfp verify exit=",
        ],
      ],
      "srt-win's egress check",
    );
    return `${fixed}${ACL_ASYNC}`;
  });
  await patchFile(dist, "sandbox/sandbox-manager.js", ASYNC_MARKER, (original) =>
    replaceOnce(
      original,
      [
        [
          "stampWindowsAcl, restoreWindowsAcl, grantWindowsAcl, revokeWindowsAcl,",
          "stampWindowsAcl, restoreWindowsAcl, grantWindowsAcl, revokeWindowsAcl, grantWindowsAclAsync, stampWindowsAclAsync,",
        ],
        [
          "                grantWindowsAcl({",
          `                ${ASYNC_MARKER}.\n                await grantWindowsAclAsync({`,
        ],
        ["                stampWindowsAcl({", "                await stampWindowsAclAsync({"],
      ],
      "SandboxManager's Windows initialize",
    ),
  );
  await patchFile(
    dist,
    "index.js",
    ASYNC_MARKER,
    (original) =>
      `${original}\n${ASYNC_MARKER}.\nexport { grantWindowsAclAsync, stampWindowsAclAsync, setStudioStepLog } from './sandbox/windows-sandbox-utils.js';\n`,
  );
  await patchCleanup(dist);
  // Last, so the async twins above carry the deadline too.
  await patchFile(dist, "sandbox/windows-sandbox-utils.js", DEADLINE_MARKER, patchDeadlines);
}

/** Local, version-guarded fixes to SRT 0.0.81, applied at install and build time.
 *
 * 1. An absolute executable needs no subprocess PATH lookup. SRT otherwise runs `which /bin/bash`
 *    with a one-second timeout and reports a present shell as missing under load.
 * 2. The Windows session start reports how long its folder grants and its egress check took
 *    (`setStudioStepLog`), so Genex's log shows which part of a slow start the time went to.
 * 3. Rollback and reset release the session's Windows grants and denies without holding the event
 *    loop: SRT runs those two srt-win commands with `spawnSync`, which froze Electron's main thread
 *    into "Not Responding". Only the actual process exit event keeps the synchronous release, and it
 *    also releases a session whose grant srt-win is still writing.
 * 4. The release and the egress check wait {@link SRT_WIN_TIMEOUT_MS} instead of SRT's 60 and 30
 *    seconds.
 * 5. The Windows proxies try the next port of srt-win's loopback range when Windows refuses one
 *    (EACCES), as when another program holds it (EADDRINUSE). Hyper-V, WSL, Docker and
 *    administrators reserve ports in that range (`netsh int ipv4 show excludedportrange
 *    protocol=tcp`), and SRT gave up on the first, so the agents never started.
 *
 * SRT 0.0.81 starts a Windows session off the event loop itself (its one `acl grant --persistent`
 * and the egress check are async, with ten minutes for a root's first walk), so 0.0.73's async
 * initialize patch is gone. Policy generation, arguments and outcomes are untouched. */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);

/** The sandbox-runtime release these patches were written against. */
const SRT_VERSION = "0.0.81";

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
const STEP_MARKER = "// Studio: srt-win step times";
const CLEANUP_MARKER = "// Studio: async ACL cleanup with synchronous exit fallback";
const DEADLINE_MARKER = "// Studio: srt-win deadlines";
const PORT_MARKER = "// Studio: refused proxy ports";

/**
 * How long srt-win may take over releasing a session's grants and denies or the egress check. A
 * release takes entries back from every folder under a large grant, which a slow disk or an
 * antivirus scanning each file can take past SRT's 60 seconds; the egress check, the first start
 * as the sandbox user after a cold boot, past its 30. Either running out of time fails the start.
 */
const SRT_WIN_TIMEOUT_MS = 120_000;
/**
 * The srt-win calls {@link patchDeadlines} gives {@link SRT_WIN_TIMEOUT_MS}, each with SRT's own
 * deadline: the release (SRT's synchronous calls and the async twins the cleanup patch adds) and
 * the egress check.
 */
const SRT_DEADLINES = [
  ...["revokeWindowsAclChecked", "restoreWindowsAcl"].flatMap((name) => [
    [name, 60_000],
    [`${name}Async`, 60_000],
  ]),
  ["verifyWindowsWfpEgress", 30_000],
];

/** The function `name` declares in `original`, from its `function` keyword to its closing brace. */
function functionSource(original, name, what) {
  const signature = `function ${name}(`;
  if (original.split(signature).length !== 2) throw new Error(`SRT ${name} changed; review the ${what} patch`);
  const start = original.lastIndexOf("\n", original.indexOf(signature)) + 1;
  const end = original.indexOf("\n}", start);
  if (end < 0) throw new Error(`SRT ${name} has no function boundary; review the ${what} patch`);
  return original.slice(start, end + 2);
}

/** Derive an async twin from the pinned implementation, retaining its arguments, parsing and errors. */
function asyncTwin(original, name, edits) {
  const source = functionSource(original, name, "cleanup").replace(/^export /, "");
  return replaceOnce(source, [[`function ${name}(`, `async function ${name}Async(`], ...edits], name);
}

function patchManagerCleanup(original) {
  const release = asyncTwin(original, "releaseWindowsSessionAcls", [
    [
      "windowsAclRestoreAllowed(revokeWindowsAclChecked(o))",
      "windowsAclRestoreAllowed(await revokeWindowsAclCheckedAsync(o))",
    ],
    ["restoreWindowsAcl(o));", "await restoreWindowsAclAsync(o));"],
  ]);
  const fixed = replaceOnce(
    original,
    [
      [
        "revokeWindowsAclChecked, getWindowsSandboxUserStatusAsync,",
        "revokeWindowsAclChecked, revokeWindowsAclCheckedAsync, restoreWindowsAclAsync, getWindowsSandboxUserStatusAsync,",
      ],
      [
        "const cleanupHandler = () => reset().catch(e => {",
        "const cleanupHandler = (exiting = false) => reset(exiting).catch(e => {",
      ],
      [
        "        void cleanupHandler();",
        "        // Promises cannot finish in process's exit event: only here is the release synchronous.\n        void cleanupHandler(true);",
      ],
      ["process.once('SIGINT', cleanupHandler);", "process.once('SIGINT', () => cleanupHandler());"],
      ["process.once('SIGTERM', cleanupHandler);", "process.once('SIGTERM', () => cleanupHandler());"],
      [
        "                releaseWindowsSessionAcls(windowsFsSbUserSid, srtWin);",
        "                await releaseWindowsSessionAclsAsync(windowsFsSbUserSid, srtWin);",
      ],
      ["async function reset() {", "async function reset(synchronousWindowsAcl = false) {"],
      [
        "    if (windowsFsStampedSet && windowsFsSbUserSid) {",
        "    // Exit must release a grant still being written too, and one a rollback is still releasing.\n    if (windowsFsSbUserSid) {",
      ],
      [
        "        releaseWindowsSessionAcls(sb, srtWin);",
        `        if (synchronousWindowsAcl)
            releaseWindowsSessionAcls(sb, srtWin);
        else
            await releaseWindowsSessionAclsAsync(sb, srtWin);`,
      ],
    ],
    "SandboxManager's Windows cleanup",
  );
  return `${fixed}\n${CLEANUP_MARKER}.\n${release}\n`;
}

async function patchCleanup(dist) {
  await patchFile(dist, "sandbox/windows-sandbox-utils.js", CLEANUP_MARKER, (original) => {
    const parser = asyncTwin(original, "runSrtWinJsonAllowFail", [
      ["runSrtWin(args, opts)", "await runSrtWinAsync(args, opts)"],
    ]);
    const twins = ["revokeWindowsAclChecked", "restoreWindowsAcl"].map(
      (name) =>
        `export ${asyncTwin(original, name, [["runSrtWinJsonAllowFail(", "await runSrtWinJsonAllowFailAsync("]])}`,
    );
    return `${original}\n${CLEANUP_MARKER}.\n${parser}\n${twins.join("\n")}\n`;
  });
  await patchFile(dist, "sandbox/sandbox-manager.js", CLEANUP_MARKER, patchManagerCleanup);
}

/** The step log the session start's grant and egress check report to. */
const STEP_LOG = `
${STEP_MARKER}: the session start's grant and egress check report here.
let studioStepLog;
/** Genex's log of how long each srt-win step of initialize took: \`(step, ms)\`. */
export function setStudioStepLog(log) {
    studioStepLog = log;
}
function studioStep(step, started) {
    studioStepLog?.(step, Date.now() - started);
}
`;

/** `grantWindowsAclPersistent` and `verifyWindowsWfpEgress` timing their srt-win call. */
function patchSteps(original) {
  const fixed = replaceOnce(
    original,
    [
      [
        "export async function grantWindowsAclPersistent(opts) {",
        `export async function grantWindowsAclPersistent(opts) {\n    ${STEP_MARKER}.\n    const started = Date.now();`,
      ],
      [
        "    logForDebugging(`[Sandbox Windows] acl grant --persistent exit=",
        "    studioStep('acl grant', started);\n    logForDebugging(`[Sandbox Windows] acl grant --persistent exit=",
      ],
      [
        "        const r = await runSrtWinAsync(args, {\n            timeoutMs: 30000,",
        "        const started = Date.now();\n        const r = await runSrtWinAsync(args, {\n            timeoutMs: 30000,",
      ],
      [
        "        logForDebugging(`[Sandbox Windows] wfp verify exit=",
        "        studioStep('wfp verify', started);\n        logForDebugging(`[Sandbox Windows] wfp verify exit=",
      ],
    ],
    "srt-win's session start",
  );
  return `${fixed}${STEP_LOG}`;
}

/** `original` with SRT's deadline replaced inside each of {@link SRT_DEADLINES}; a call found other than once means SRT changed. */
function patchDeadlines(original) {
  let fixed = original;
  for (const [name, srtMs] of SRT_DEADLINES) {
    const source = functionSource(fixed, name, "srt-win deadline");
    const start = fixed.indexOf(source);
    const body = replaceOnce(source, [[`timeoutMs: ${srtMs}`, `timeoutMs: ${SRT_WIN_TIMEOUT_MS}`]], name);
    fixed = fixed.slice(0, start) + body + fixed.slice(start + source.length);
  }
  return `${fixed}\n${DEADLINE_MARKER}: ${SRT_WIN_TIMEOUT_MS} ms for the session release and the egress check.\n`;
}

/** `listenInRange` moving past a port Windows refuses as well as one in use. */
function patchProxyPorts(original) {
  return replaceOnce(
    original,
    [
      [
        "                    err?.code === 'EADDRINUSE' &&",
        `                    ${PORT_MARKER}: Windows refuses a reserved port with EACCES.
                    (err?.code === 'EADDRINUSE' || err?.code === 'EACCES') &&`,
      ],
    ],
    "SRT's proxy port range",
  );
}

export async function patchSandboxRuntime() {
  const pkg = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  const metadata = JSON.parse(await readFile(pkg, "utf8"));
  if (metadata.version !== SRT_VERSION)
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
  await patchFile(dist, "sandbox/windows-sandbox-utils.js", STEP_MARKER, patchSteps);
  await patchFile(
    dist,
    "index.js",
    STEP_MARKER,
    (original) =>
      `${original}\n${STEP_MARKER}.\nexport { setStudioStepLog } from './sandbox/windows-sandbox-utils.js';\n`,
  );
  await patchCleanup(dist);
  await patchFile(dist, "sandbox/listen-in-range.js", PORT_MARKER, patchProxyPorts);
  // Last, so the async twins above carry the deadline too.
  await patchFile(dist, "sandbox/windows-sandbox-utils.js", DEADLINE_MARKER, patchDeadlines);
}

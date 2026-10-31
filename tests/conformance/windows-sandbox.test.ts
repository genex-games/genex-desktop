/**
 * The Windows sandbox backend's own rules, on every platform (plan phase 3, W2): the grant union
 * and its regrant queue, the read-attributes grants above each root, the env file a command
 * sources, the deny paths srt-win may see, and ProcessSandbox's Windows launch driven through a
 * fake sandbox-runtime. `sandbox-windows.test.ts` proves the same against the real srt-win on a
 * Windows runner.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxProblemCode, WindowsSetupNeed } from "../../src/shared/boot.ts";
import { launchGameBridge } from "../../src/main/core/game-bridge-target.ts";
import { openCodeEvents } from "../../src/substrate/engines/opencode.ts";
import { HarnessHost } from "../../src/substrate/harness-host.ts";
import {
  SandboxLaunchCode,
  SandboxLaunchError,
  SandboxUnavailableError,
} from "../../src/substrate/sandbox-unavailable.ts";
import { ProcessSandbox, type SandboxRuntime } from "../../src/substrate/spawn.ts";
import {
  type AncestorGrantDeps,
  type AncestorGrants,
  type OwnAclDeps,
  type OwnAclEntry,
  type OwnAclEntries,
  type SessionMember,
  WindowsSandboxSession,
  ancestorDirs,
  ancestorGrants,
  bundledGitRoot,
  ensureHostGit,
  findGitBash,
  gitRootFromExecPath,
  gitRootFromRegistry,
  grantUnion,
  grantableToolDirs,
  grantsCover,
  insideWindowsPath,
  keepWindowsDenies,
  msysPath,
  msysPathList,
  granteeOf,
  groupSidOnce,
  ownAclEntries,
  renderEnvFile,
  routeWindowsDenies,
  routeWindowsGrants,
  sandboxEntriesLeft,
  sandboxGroupOf,
  sandboxSidOnce,
  setupGaps,
  srtWinExecFailure,
  srtWinPath,
  forgetKeptGrants,
  takeBackSandboxEntries,
  toolDirEntries,
  windowsAccessReport,
  windowsDenyHolders,
  windowsGrantHolders,
  type WindowsSetupGap,
  windowsRunEnv,
  windowsSetupGaps,
  writeDeniesBeyondRead,
} from "../../src/substrate/windows-sandbox.ts";
import { ServiceStartType } from "../../src/substrate/windows-logon-service.ts";
import {
  DenyAccess,
  GrantAccess,
  type FolderAceEdit,
  type FolderAceEditor,
  type FolderAceOutcome,
  FolderAceOp,
  type FolderOwnEdit,
  type FolderOwnEditor,
  folderAceCommand,
  folderAceEditor,
  folderAceOutcomes,
  folderAceProgress,
  folderOwnEditor,
  FOLDER_ACE_SCRIPT,
  icaclsArgs,
  OwnWalk,
  windowsPowerShell,
} from "../../src/substrate/windows-folder-ace.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The paths of an srt config's path list; Genex sends plain paths, never `{ path, literal }`. */
function entryPaths(entries: readonly (string | { path: string })[] | undefined): string[] {
  return (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));
}

/** How long a test waits for a file removed in the background: polls of POLL_MS each. */
const ENV_FILE_POLLS = 200;
const POLL_MS = 10;
/** Run input larger than any OS pipe buffer, so no write of it can finish before the reader closes. */
const PIPE_OVERFLOW_BYTES = 1024 * 1024;
const FAKE_PLAY_GAME = path.resolve(import.meta.dirname, "../fixtures/fake-play-game.mjs");
const PROFILE = "C:\\Users\\Ann";
/** The longest command line, and environment variable, Windows passes to a process. */
const WINDOWS_COMMAND_LINE_CHARS = 32_767;
const at = (...parts: string[]) => [PROFILE, ...parts].join("\\");

describe("grant union", () => {
  it("collapses repeats, nested folders and reads inside writes, comparing names without case", () => {
    const union = grantUnion([
      { write: [at("AI Games"), at("ai games", "Pong")], read: [at("AI Games", "assets"), "D:\\Tools"] },
      { write: [at("AppData", "Roaming", "Genex", "scratch")], read: ["d:\\tools\\node", "D:\\Tools"] },
    ]);
    assert.deepEqual(union.write, [at("AI Games"), at("AppData", "Roaming", "Genex", "scratch")]);
    assert.deepEqual(union.read, ["D:\\Tools"]);
  });

  it("covers a folder inside a granted one; a read is covered by a write, never the other way", () => {
    const applied = { write: [at("AI Games")], read: ["D:\\Tools"] };
    const table: Array<[string, { write: string[]; read: string[] }, boolean]> = [
      ["write inside a write root", { write: [at("AI Games", "Pong")], read: [] }, true],
      ["read inside a write root", { write: [], read: [at("ai games", "Pong")] }, true],
      ["read inside a read root", { write: [], read: ["D:\\Tools\\node"] }, true],
      ["write inside a read root", { write: ["D:\\Tools\\node"], read: [] }, false],
      ["a sibling with the root's name as prefix", { write: [at("AI Games2")], read: [] }, false],
      ["an escape through ..", { write: [at("AI Games", "..", "Documents")], read: [] }, false],
    ];
    for (const [label, needed, covered] of table) assert.equal(grantsCover(applied, needed), covered, label);
  });
});

describe("read-attributes grants above each root", () => {
  it("lists every folder strictly between the profile and a root, outermost first", () => {
    const dirs = ancestorDirs(PROFILE, [
      at("AppData", "Local", "Temp", "run-1", "ws"),
      at("AppData", "Local", "Programs", "Genex", "app-0.1.0"),
      at("AI Games"),
    ]);
    assert.deepEqual(dirs, [
      at("AppData"),
      at("AppData", "Local"),
      at("AppData", "Local", "Temp"),
      at("AppData", "Local", "Programs"),
      at("AppData", "Local", "Temp", "run-1"),
      at("AppData", "Local", "Programs", "Genex"),
    ]);
  });

  it("never names the profile, a folder outside it, a root or a folder inside a root", () => {
    const table: Array<[string, string[], string[]]> = [
      ["the profile itself", [PROFILE], []],
      ["directly under the profile", [at("AI Games")], []],
      ["another drive", ["D:\\Games\\Pong"], []],
      ["another user's profile with a shared prefix", ["C:\\Users\\Annabel\\AppData\\x"], []],
      ["an escape through ..", [at("AppData", "..", "..", "Bob", "x", "y")], []],
      ["a root inside another root", [at("AI Games"), at("AI Games", "sub", "Pong")], []],
      [
        "case differs from the profile",
        ["c:\\users\\ann\\AppData\\Local\\x"],
        ["c:\\users\\ann\\AppData", "c:\\users\\ann\\AppData\\Local"],
      ],
    ];
    for (const [label, roots, expected] of table) assert.deepEqual(ancestorDirs(PROFILE, roots), expected, label);
  });

  it("a data folder moved off the profile counts from the data folder itself down to each root inside it", () => {
    const data = "D:\\Genex";
    const table: Array<[string, string[], string[]]> = [
      ["a root directly in it", ["D:\\Genex\\scratch"], ["D:\\Genex"]],
      [
        "a root deeper in it",
        ["D:\\Genex\\reviewers\\call-1", "D:\\Genex\\scratch"],
        ["D:\\Genex", "D:\\Genex\\reviewers"],
      ],
      ["a root on the same drive outside it", ["D:\\Games\\Pong"], []],
      ["a folder that only shares its name's start", ["D:\\GenexOther\\x"], []],
      ["the data folder itself as a root", [data], []],
      ["case differs: spelled as the root is", ["d:\\genex\\runs"], ["d:\\genex"]],
    ];
    for (const [label, roots, expected] of table) assert.deepEqual(ancestorDirs(PROFILE, roots, data), expected, label);
  });

  it("a data folder still in the profile changes nothing", () => {
    const roots = [at("AppData", "Roaming", "Genex", "scratch")];
    assert.deepEqual(ancestorDirs(PROFILE, roots, at("AppData", "Roaming", "Genex")), ancestorDirs(PROFILE, roots));
  });

  const DEAD_PID = 3;
  const SID = "S-1-5-21-9";
  const done = (edits: readonly FolderAceEdit[]) => edits.map(() => ({ ok: true }) as const);
  /** Ancestor grants for holder `pid` in `holders`, logging every edit as `[pid, dir, op]`. */
  const holder = (holders: string, pid: number, calls: string[][], options: Partial<AncestorGrantDeps> = {}) =>
    ancestorGrants(holders, {
      sid: async () => SID,
      pid,
      alive: (other) => other !== DEAD_PID,
      retryDelayMs: 0,
      exists: () => true,
      edit: async (edits) => {
        for (const edit of edits) calls.push([`${pid}`, edit.dir, edit.op]);
        return done(edits);
      },
      editSync: (edits) => {
        for (const edit of edits) calls.push([`${pid}`, "sync", edit.dir, edit.op]);
        return done(edits);
      },
      ...options,
    });
  const removals = (calls: string[][]) => calls.filter((call) => call.includes(FolderAceOp.Remove));

  it("records each folder before granting it, grants by SID, and takes back what is no longer needed", async () => {
    const holders = await tmpDir("windows-grants-");
    const record = path.join(holders, "1.json");
    const calls: string[][] = [];
    const grants = holder(holders, 1, calls, {
      edit: async (edits) => {
        const recorded = JSON.parse(await readFile(record, "utf8")) as { dirs: string[] };
        for (const edit of edits) {
          if (edit.op === FolderAceOp.Grant) assert.ok(recorded.dirs.includes(edit.dir), "recorded before granted");
          calls.push([edit.dir, edit.op, edit.sid]);
        }
        return done(edits);
      },
      editSync: (edits) => {
        for (const edit of edits) calls.push(["sync", edit.dir, edit.op, edit.sid]);
        return done(edits);
      },
    });
    await grants.sync([at("AppData"), at("AppData", "Local")]);
    await grants.sync([at("AppData")]);
    // Every sync grants every folder again: srt-win's deny stamp and its reset may have removed
    // the sandbox user's entry on a folder this holder already granted.
    assert.deepEqual(calls, [
      [at("AppData"), FolderAceOp.Grant, SID],
      [at("AppData", "Local"), FolderAceOp.Grant, SID],
      [at("AppData"), FolderAceOp.Grant, SID],
      [at("AppData", "Local"), FolderAceOp.Remove, SID],
    ]);
    grants.revokeAllSync();
    assert.deepEqual(calls.at(-1), ["sync", at("AppData"), FolderAceOp.Remove, SID]);
    assert.equal(existsSync(record), false, "the record goes once everything is taken back");
  });

  it("revokes a released holder asynchronously while retaining the synchronous exit fallback", async () => {
    const holders = await tmpDir("windows-grants-");
    const calls: string[][] = [];
    const grants = holder(holders, 1, calls);
    await grants.sync([at("AppData")]);
    await grants.revokeAll();
    assert.deepEqual(removals(calls), [["1", at("AppData"), FolderAceOp.Remove]]);
    assert.equal(existsSync(path.join(holders, "1.json")), false);
    grants.revokeAllSync();
    assert.equal(removals(calls).length, 1);
  });

  it("keeps a folder another running Genex still needs (a dev profile beside the app)", async () => {
    const holders = await tmpDir("windows-grants-");
    const calls: string[][] = [];
    const app = holder(holders, 1, calls);
    const dev = holder(holders, 2, calls);
    await app.sync([at("AppData"), at("AppData", "Local")]);
    await dev.sync([at("AppData"), at("AppData", "Roaming")]);
    await app.sync([at("AppData")]);
    assert.deepEqual(removals(calls), [["1", at("AppData", "Local"), FolderAceOp.Remove]]);
    app.revokeAllSync();
    assert.equal(removals(calls).length, 1, "the dev profile still needs AppData");
    dev.revokeAllSync();
    const taken = removals(calls)
      .slice(1)
      .map((call) => call[2] ?? "");
    assert.deepEqual(taken.sort(), [at("AppData"), at("AppData", "Roaming")]);
    assert.deepEqual(await readdir(holders), [], "every record is gone");
  });

  it("takes back what a Genex that crashed left granted, except what a running one needs", async () => {
    const holders = await tmpDir("windows-grants-");
    const crashed = { sid: "S-1-5-21-9", dirs: [at("AppData"), at("Videos", "x")] };
    await writeFile(path.join(holders, `${DEAD_PID}.json`), JSON.stringify(crashed));
    await writeFile(path.join(holders, "notes.txt"), "not a record");
    const calls: string[][] = [];
    await holder(holders, 1, calls).sync([at("AppData")]);
    assert.deepEqual(removals(calls), [["1", at("Videos", "x"), FolderAceOp.Remove]]);
    assert.deepEqual((await readdir(holders)).sort(), ["1.json", "notes.txt"]);
  });

  it("tries again only the grants refused once (another process was changing the folder)", async () => {
    const holders = await tmpDir("windows-grants-");
    const batches: string[][] = [];
    let refusals = 1;
    const flaky: FolderAceEditor = async (edits) => {
      batches.push(edits.map((edit) => edit.dir));
      return edits.map((edit) =>
        edit.dir === at("AppData", "Local") && refusals-- > 0 ? { ok: false, error: "being changed" } : { ok: true },
      );
    };
    await holder(holders, 1, [], { edit: flaky }).sync([at("AppData"), at("AppData", "Local")]);
    assert.deepEqual(batches, [[at("AppData"), at("AppData", "Local")], [at("AppData", "Local")]]);
    const broken: FolderAceEditor = async (edits) => edits.map(() => ({ ok: false, error: "Access is denied." }));
    await assert.rejects(
      holder(holders, 2, [], { edit: broken }).sync([at("Music", "x")]),
      /could not let the sandbox user see the folder .*Music\\x: Access is denied\./,
    );
  });

  it("records under %LOCALAPPDATA%, shared by every profile and apart from the Squirrel install", () => {
    assert.equal(windowsGrantHolders(PROFILE, at("AppData", "Local")), at("AppData", "Local", "genex-sandbox-grants"));
    assert.equal(windowsGrantHolders(PROFILE, ""), at("AppData", "Local", "genex-sandbox-grants"));
  });

  it("skips a folder that is gone, rather than failing every later apply of the session", async () => {
    // A member's read root can be deleted while the process runs (a test's resources folder, an
    // uninstalled tool): its grant would then fail with "cannot find the file".
    const calls: string[][] = [];
    const gone = at("AppData", "Local", "Temp", "studio-res-1");
    const grants = holder(await tmpDir("windows-grants-"), 1, calls, { exists: (dir) => dir !== gone });
    await grants.sync([at("AppData"), gone]);
    assert.deepEqual(calls, [["1", at("AppData"), FolderAceOp.Grant]]);
  });

  it("fails, saying why, without the sandbox user's id, rather than leave its folders closed", async () => {
    // A sync follows a successful initialize, so the user exists. A missing id used to skip every
    // grant silently, and the harness then stopped at its first walk: EPERM, lstat C:\Users\…\AppData.
    const calls: string[][] = [];
    const grants = holder(await tmpDir("windows-grants-"), 1, calls, { sid: async () => null });
    await assert.rejects(grants.sync([at("AppData")]), /could not read the sandbox user's id/);
    assert.deepEqual(calls, []);
  });

  it("names the sandbox users' group in the folder grants, which other srt hosts' cleanup leaves alone", () => {
    const user = "S-1-5-21-1-1001";
    const group = "S-1-5-21-1-1002";
    assert.equal(granteeOf({ sid: user, groupSid: group, inSandboxGroup: true }), group);
    assert.equal(granteeOf({ sid: user, groupSid: group, inSandboxGroup: false }), user, "not a member yet");
    assert.equal(granteeOf({ sid: user }), user, "an srt-win that names no group");
    assert.equal(granteeOf({}), null, "no sandbox user yet");
  });

  it("asks again for the sandbox user's id when a probe comes back empty, and keeps it once found", async () => {
    const answers = [null, "S-1-5-21-9"];
    let asked = 0;
    const sid = sandboxSidOnce(async () => {
      asked++;
      return answers.shift() ?? null;
    }, 0);
    assert.equal(await sid(), "S-1-5-21-9");
    assert.equal(await sid(), "S-1-5-21-9");
    assert.equal(asked, 2, "a found id is never asked for again");
    let none = 0;
    const missing = sandboxSidOnce(async () => {
      none++;
      return null;
    }, 0);
    assert.equal(await missing(), null);
    assert.equal(none, 3, "three probes, then the caller says why it stops");
  });

  it("names only the sandbox users' group in Genex's own denies, asked again until srt-win can say", async () => {
    const group = "S-1-5-21-1-1002";
    assert.equal(sandboxGroupOf({ groupSid: group, inSandboxGroup: true }), group);
    assert.equal(sandboxGroupOf({ groupSid: group, inSandboxGroup: false }), null, "never the user's own SID");
    assert.equal(sandboxGroupOf({}), null);
    const answers: Array<string | null | Error> = [new Error("srt-win timed out"), null, group];
    let asked = 0;
    const sid = groupSidOnce(async () => {
      asked++;
      const answer = answers.shift() ?? null;
      if (answer instanceof Error) throw answer;
      return answer;
    }, 0);
    assert.equal(await sid(), null, "no group yet (Set up has not run)");
    assert.equal(asked, 2, "asked again only while srt-win could not say");
    assert.equal(await sid(), group, "asked again on the next call, and found");
    assert.equal(await sid(), group);
    assert.equal(asked, 3, "a found group is never asked for again");
  });

  it("lists who may open each folder from the profile down to the files, for the log", async () => {
    const listed: string[] = [];
    const lines = await windowsAccessReport(PROFILE, [at("AppData", "Local", "genex", "app-1")], async (dir) => {
      listed.push(dir);
      return `${dir} PC\\srt-sandbox:(RA)\r\n\r\nSuccessfully processed 1 files\r\n`;
    });
    assert.deepEqual(listed, [
      PROFILE,
      at("AppData"),
      at("AppData", "Local"),
      at("AppData", "Local", "genex"),
      at("AppData", "Local", "genex", "app-1"),
    ]);
    assert.equal(lines.length, listed.length * 2, "blank lines are dropped");
    assert.equal(lines[2], `${at("AppData")} PC\\srt-sandbox:(RA)`);
  });
});

describe("an entry on one folder alone", () => {
  const SID = "S-1-5-21-9";
  const edits: FolderAceEdit[] = [
    { dir: "C:\\Users\\Семён\\AppData", sid: SID, op: FolderAceOp.Grant },
    { dir: "C:\\Users\\Семён\\it's", sid: SID, op: FolderAceOp.Remove },
  ];

  it("runs Windows PowerShell by its full path and hands it the batch out of reach of any code page", () => {
    const command = folderAceCommand(edits, { SystemRoot: "D:\\Win" });
    assert.equal(command.file, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const script = command.env.GENEX_FOLDER_ACE_SCRIPT ?? "";
    assert.equal(Buffer.from(script, "base64").toString("utf8"), FOLDER_ACE_SCRIPT);
    const payload = command.env.GENEX_FOLDER_ACES ?? "";
    assert.match(payload, /^[A-Za-z0-9+/=]+$/, "only base64 crosses the process boundary");
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), edits);
  });

  it("hands PowerShell no module path of its own: one from PowerShell 7 loses ConvertFrom-Json", () => {
    const command = folderAceCommand(edits, {
      SystemRoot: "C:\\Windows",
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    });
    assert.equal(command.env.PSModulePath, undefined);
    assert.equal(command.env.SystemRoot, "C:\\Windows");
  });

  it("keeps its command line inside Windows' 32,767 characters, however long the script grows", () => {
    // The script outgrew it once: CreateProcess refused PowerShell ("The filename or extension is
    // too long"), every batch answered nothing, and every grant fell back to icacls.
    const command = folderAceCommand(edits, { SystemRoot: "C:\\Windows" });
    assert.ok([command.file, ...command.args].join(" ").length < WINDOWS_COMMAND_LINE_CHARS / 4);
    const variables = Object.values(command.env).map((value) => `${value}`.length);
    assert.ok(Math.max(...variables) < WINDOWS_COMMAND_LINE_CHARS, "and each variable inside the same limit");
  });

  it("reads one outcome line per edit, and nothing else as an answer", () => {
    const table: Array<[string, string, number, unknown]> = [
      [
        "one each",
        '{"ok":true}\r\n{"ok":false,"error":"Access is denied"}\n',
        2,
        [{ ok: true }, { ok: false, error: "Access is denied" }],
      ],
      ["too few", '{"ok":true}\n', 2, null],
      ["not JSON (PowerShell failed to start the script)", "#< CLIXML\n", 1, null],
      ["empty", "", 1, null],
      ["a line cut short is no answer yet", '{"ok":true}', 1, null],
      ["a list is not a line per edit", '[{"ok":true}]\n', 1, null],
      ["a batch refused whole", '{"refused":"the running user holds this SID"}', 1, null],
      ["a refusal without words", '{"ok":false}\n', 1, [{ ok: false, error: "refused" }]],
    ];
    for (const [label, stdout, count, expected] of table)
      assert.deepEqual(folderAceOutcomes(stdout, count), expected, label);
    assert.deepEqual(
      folderAceProgress('{"ok":true,"ms":3}\n{"ok":true,"ms":41000}\n{"ok":tr'),
      [
        { ok: true, ms: 3 },
        { ok: true, ms: 41_000 },
      ],
      "a batch stopped part way: the lines it finished",
    );
  });

  it("keeps what a batch finished before its deadline, and names the edit Windows was still on", async () => {
    // A batch used to answer every edit as timed out, its first one named: the profile, whose own
    // edit is on that folder alone, while the walk Windows was on was another folder's.
    const own = (dir: string): FolderOwnEdit => ({
      dir,
      sid: SID,
      op: FolderAceOp.Own,
      deny: null,
      guard: dir === PROFILE,
      grant: dir === PROFILE ? null : GrantAccess.Read,
      allows: dir !== PROFILE,
    });
    const batch = [PROFILE, at("anaconda3"), at("AppData", "Roaming", "npm")].map(own);
    const deadlines: Array<number | undefined> = [];
    const stopped = folderOwnEditor({
      powershell: async (_file, _args, _env, run) => {
        deadlines.push(run?.timeoutMs);
        throw Object.assign(new Error("Command failed"), { killed: true, stdout: '{"ok":true,"ms":4}\n' });
      },
    });
    const outcomes = await stopped(batch, { timeoutMs: 30_000 });
    assert.deepEqual(deadlines, [30_000], "the run's own deadline");
    assert.deepEqual(outcomes?.[0], { ok: true, ms: 4 }, "the profile's guard was done");
    assert.deepEqual(outcomes?.[1], {
      ok: false,
      error: "Windows was still passing the entries down after 30 s",
      timedOut: true,
    });
    assert.deepEqual(outcomes?.[2], {
      ok: false,
      error: "not reached: the batch ran out of time after 30 s",
      timedOut: true,
    });
    await stopped(batch);
    assert.deepEqual(deadlines, [30_000, 600_000], "ten minutes unless the run says");
    const quitting = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const aborted = folderOwnEditor({
      powershell: async (_file, _args, _env, run) => {
        signals.push(run?.signal);
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
      },
    });
    assert.equal(await aborted(batch, { signal: quitting.signal }), null, "a stopped walk finished nothing");
    assert.equal(signals[0], quitting.signal, "the run's signal reaches PowerShell");
  });

  it("makes the same change through icacls when PowerShell cannot run the batch", async () => {
    const icacls: string[][] = [];
    const editor = folderAceEditor({
      env: { SystemRoot: "C:\\Windows" },
      powershell: async () => {
        throw new Error(
          "Cannot invoke method. Method invocation is supported only on core types in this language mode.",
        );
      },
      icacls: async (args) => {
        icacls.push(args);
        if (args[0]?.endsWith("it's"))
          throw Object.assign(new Error("Command failed: icacls"), { stdout: "Access is denied." });
      },
    });
    assert.deepEqual(await editor(edits), [
      { ok: true },
      { ok: false, error: "Command failed: icacls: Access is denied." },
    ]);
    assert.deepEqual(icacls, edits.map(icaclsArgs));
    assert.deepEqual(icacls, [
      ["C:\\Users\\Семён\\AppData", "/grant", `*${SID}:(S,RA)`],
      ["C:\\Users\\Семён\\it's", "/remove:g", `*${SID}`],
    ]);
  });

  it("answers a batch PowerShell ran past its deadline on as timed out, and one it could not run as nothing", async () => {
    const edit: FolderOwnEdit = {
      dir: "C:\\x",
      sid: SID,
      op: FolderAceOp.Own,
      deny: null,
      guard: false,
      grant: GrantAccess.Read,
      allows: true,
    };
    const killed = folderOwnEditor({
      powershell: async () => Promise.reject(Object.assign(new Error("Command failed"), { killed: true })),
    });
    const [outcome] = (await killed([edit])) ?? [];
    assert.equal(outcome?.ok, false);
    assert.equal(outcome && !outcome.ok && outcome.timedOut, true);
    const locked = folderOwnEditor({ powershell: async () => Promise.reject(new Error("Cannot invoke method")) });
    assert.equal(await locked([edit]), null);
    assert.deepEqual(folderAceOutcomes('{"ok":true,"ms":41000}\n', 1), [{ ok: true, ms: 41_000 }]);
    assert.deepEqual(
      folderAceOutcomes('{"ok":true,"ms":12,"deferred":true}\n', 1),
      [{ ok: true, ms: 12, deferred: true }],
      "an edit that left its walk for later says so",
    );
    assert.deepEqual(
      folderAceOutcomes('{"ok":true,"ms":9,"refused":"Access is denied."}\n', 1),
      [{ ok: true, ms: 9, refused: "Access is denied." }],
      "a deny Windows refused where none was needed carries Windows' words",
    );
  });

  it("uses PowerShell's answer when it gives one, and runs nothing for no edits", async () => {
    let runs = 0;
    const editor = folderAceEditor({
      powershell: async () => {
        runs++;
        return '{"ok":true}\n{"ok":true}\n';
      },
      icacls: async () => assert.fail("icacls runs only when PowerShell cannot"),
    });
    assert.deepEqual(await editor(edits), [{ ok: true }, { ok: true }]);
    assert.deepEqual(await editor([]), []);
    assert.equal(runs, 1);
  });
});

describe("an entry on one folder alone, on Windows", {
  skip: process.platform !== "win32" && "edits real NTFS entries",
}, () => {
  /** A folder's own DACL as SDDL, read through icacls, which saves it without changing anything. */
  const sddl = (dir: string, scratch: string) => {
    const file = path.join(scratch, `acl-${randomUUID()}.txt`);
    execFileSync("icacls", [dir, "/save", file], { stdio: "ignore" });
    return readFileSync(file, "utf16le");
  };
  const GUESTS = "S-1-5-32-546";
  const USERS = "S-1-5-32-545";
  const guestsRead = /\(A;;0x100080;;;BG\)/;
  /** The sandbox user is in BUILTIN\Users: an allow for them on `dir` reaches it in everything below. */
  const openToUsers = (dir: string) =>
    execFileSync("icacls", [dir, "/grant", `*${USERS}:(OI)(CI)(RX)`], { stdio: "ignore" });

  it("edits each folder of a batch, any name, and says which one it could not", async () => {
    const root = realpathSync.native(await tmpDir("folder-ace-"));
    const named = path.join(root, "Семён ünïcødé 游戏 it's $(x) `y`");
    await mkdir(named);
    const editor = folderAceEditor();
    const outcomes = await editor([
      { dir: named, sid: GUESTS, op: FolderAceOp.Grant },
      { dir: path.join(root, "missing"), sid: GUESTS, op: FolderAceOp.Grant },
      { dir: named, sid: GUESTS, op: FolderAceOp.Grant },
    ]);
    assert.deepEqual(outcomes[0], { ok: true });
    assert.equal(outcomes[1]?.ok, false, "a folder that is not there is refused");
    assert.deepEqual(outcomes[2], { ok: true }, "a grant that is already there changes nothing");
    assert.equal(sddl(named, root).match(new RegExp(guestsRead, "g"))?.length, 1, "one entry, not two");
    assert.deepEqual(await editor([{ dir: named, sid: GUESTS, op: FolderAceOp.Remove }]), [{ ok: true }]);
    assert.doesNotMatch(sddl(named, root), guestsRead);
  });

  it("still grants where PowerShell is locked down (Constrained Language Mode)", async () => {
    const root = realpathSync.native(await tmpDir("folder-ace-locked-"));
    const editor = folderAceEditor({ env: { ...process.env, __PSLockdownPolicy: "4" } });
    assert.deepEqual(await editor([{ dir: root, sid: GUESTS, op: FolderAceOp.Grant }]), [{ ok: true }]);
    assert.match(sddl(root, root), guestsRead);
  });

  it("grants and takes back on the folder alone, never rewriting the folders under it", async () => {
    const root = realpathSync.native(await tmpDir("folder-only-grant-"));
    const above = path.join(root, "above");
    const moved = path.join(above, "deep", "moved");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(path.dirname(moved), { recursive: true });
    await mkdir(elsewhere);
    // A folder moved in keeps what it inherited where it was made, until something walks the
    // folders above it and works out again what they pass down: only a walk takes that away.
    execFileSync("icacls", [elsewhere, "/grant", `*${GUESTS}:(OI)(CI)(RA)`], { stdio: "ignore" });
    await mkdir(path.join(elsewhere, "moved"));
    await rename(path.join(elsewhere, "moved"), moved);
    const inheritedElsewhere = /\(A;[A-Z]*ID[A-Z]*;(?:0x80|LO);;;BG\)/;
    const granted = /\(A;;0x100080;;;BU\)/;
    assert.match(sddl(moved, root), inheritedElsewhere, "the moved folder kept what it inherited");
    const grants = ancestorGrants(path.join(root, "holders"), {
      sid: async () => USERS,
      pid: 1,
      alive: () => false,
    });
    await grants.sync([above]);
    assert.match(sddl(above, root), granted, "the folder has the grant");
    assert.match(sddl(moved, root), inheritedElsewhere, "nothing under the folder was rewritten by the grant");
    await grants.revokeAll();
    assert.doesNotMatch(sddl(above, root), granted, "the grant is taken back");
    assert.match(sddl(moved, root), inheritedElsewhere, "nothing under the folder was rewritten by the take-back");
  });

  it("denies a folder and everything in it, guards its parent alone, and takes both back", async () => {
    const root = realpathSync.native(await tmpDir("folder-deny-"));
    const above = path.join(root, "above");
    const secret = path.join(above, "secret");
    const key = path.join(secret, "nested", "key");
    const moved = path.join(above, "deep", "moved");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(path.dirname(key), { recursive: true });
    await writeFile(key, "key");
    openToUsers(secret);
    await mkdir(path.dirname(moved), { recursive: true });
    await mkdir(elsewhere);
    // As above: the moved folder keeps what it inherited elsewhere until something walks `above`,
    // the way srt-win's stamp of `secret` walked it (and the whole profile for `~\.ssh`).
    execFileSync("icacls", [elsewhere, "/grant", `*${GUESTS}:(OI)(CI)(RA)`], { stdio: "ignore" });
    await mkdir(path.join(elsewhere, "moved"));
    await rename(path.join(elsewhere, "moved"), moved);
    const inheritedElsewhere = /\(A;[A-Z]*ID[A-Z]*;(?:0x80|LO);;;BG\)/;
    const denies = ownAclEntries(path.join(root, "holders"), { sid: async () => GUESTS, pid: 1, alive: () => false });
    const { own } = routeWindowsDenies({ read: [secret], write: [] });
    assert.equal(await denies.sync(own), true);
    assert.match(sddl(secret, root), /\(D;OICI;FA;;;BG\)/, "the folder is denied, passed down");
    assert.match(sddl(key, root), /\(D;ID;FA;;;BG\)/, "a file below it inherits the deny");
    // SDDL spells FILE_DELETE_CHILD (0x40) DT, the directory-service "delete tree" right of the same bit.
    assert.match(
      sddl(above, root),
      /\(D;;(?:0x40|DT);;;BG\)/,
      "its parent may not have it deleted, on that folder alone",
    );
    assert.match(sddl(moved, root), inheritedElsewhere, "nothing else under the parent was rewritten");
    await denies.revokeAll();
    for (const dir of [secret, key, above]) assert.doesNotMatch(sddl(dir, root), /\(D;[^)]*;;;BG\)/, dir);
    assert.match(sddl(moved, root), inheritedElsewhere, "nor by the take-back");
  });

  /** The running user's SID, as `whoami` says it. */
  const runningUser = () => {
    const sid = /"(S-1-[^"]+)"/.exec(
      execFileSync(
        path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
        ["/user", "/fo", "csv", "/nh"],
        { encoding: "utf8" },
      ),
    )?.[1];
    assert.ok(sid, "the running user's SID");
    return sid;
  };
  /** A folder like a browser profile: only its owner, SYSTEM and the Administrators, passed down. */
  const ownerOnly = (dir: string) => {
    const closed = [`*${runningUser()}:(OI)(CI)(F)`, "*S-1-5-18:(OI)(CI)(F)", "*S-1-5-32-544:(OI)(CI)(F)"];
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", ...closed], { stdio: "ignore" });
  };
  const denyLater = (dir: string): FolderOwnEdit => ({
    dir,
    sid: GUESTS,
    op: FolderAceOp.Own,
    deny: DenyAccess.Read,
    guard: false,
    grant: null,
    allows: false,
    walk: OwnWalk.Later,
  });

  it("denies a folder only its owner may open on that folder alone at first, and passes it down later", async () => {
    // A lived-in Windows 11 profile: passing the deny down Chrome's profile took 17 s of the first
    // start, although only its owner, SYSTEM and the Administrators could open anything in it.
    const root = realpathSync.native(await tmpDir("folder-deny-closed-"));
    // The test's own root starts closed too: another program's sandbox (the real Codex CLI's) can
    // leave allows on the runner's temp folder that everything made under it would inherit.
    ownerOnly(root);
    const secret = path.join(root, "above", "User Data");
    const before = path.join(secret, "Default", "Cookies");
    await mkdir(path.dirname(before), { recursive: true });
    await writeFile(before, "before");
    ownerOnly(secret);
    const denies = ownAclEntries(path.join(root, "holders"), { sid: async () => GUESTS, pid: 1, alive: () => false });
    assert.equal(await denies.sync(routeWindowsDenies({ read: [secret], write: [] }).own), true);
    assert.match(sddl(secret, root), /\(D;OICI;FA;;;BG\)/, "the folder is denied, to pass down");
    assert.doesNotMatch(
      sddl(before, root),
      /;;;BG\)/,
      `nothing under it was walked during the start; the folder: ${sddl(secret, root)}`,
    );
    const later = path.join(secret, "Login Data");
    await writeFile(later, "later");
    assert.match(sddl(later, root), /\(D;ID;FA;;;BG\)/, "a file made in it meanwhile inherits the deny");
    // One made deeper inherits its folder's entries, still the owner's only, until the walk.
    const deeper = path.join(secret, "Default", "Login Data");
    await writeFile(deeper, "later");
    assert.doesNotMatch(sddl(deeper, root), /\(A;[^)]*;;;(?:BG|BU|WD|AU)\)/, "nothing opens it to the sandbox user");
    await denies.walkDeferred();
    assert.match(sddl(before, root), /\(D;ID;FA;;;BG\)/, "the walk later passes the deny down");
    await denies.revokeAll();
    for (const p of [secret, later, before]) assert.doesNotMatch(sddl(p, root), /\(D;[^)]*;;;BG\)/, p);
  });

  // The walk may wait only where the sandbox user can open nothing under the path with or without
  // it. Each of these opens something to it (BUILTIN\Users, which it is in), so the walk runs now.
  const hostile: Array<[string, (secret: string, root: string) => Promise<void>]> = [
    [
      "a folder moved in with an allow it inherited elsewhere",
      async (secret, root) => {
        const elsewhere = path.join(root, "elsewhere");
        await mkdir(path.join(elsewhere, "moved"), { recursive: true });
        execFileSync("icacls", [elsewhere, "/grant", `*${USERS}:(OI)(CI)(RX)`], { stdio: "ignore" });
        await rename(path.join(elsewhere, "moved"), path.join(secret, "Default", "moved"));
      },
    ],
    [
      "a file of its own allowing Users",
      async (secret) => {
        const file = path.join(secret, "Default", "shared.txt");
        await writeFile(file, "shared");
        execFileSync("icacls", [file, "/grant", `*${USERS}:(R)`], { stdio: "ignore" });
      },
    ],
    [
      "a protected folder allowing Users",
      async (secret) => {
        const folder = path.join(secret, "Default", "protected");
        await mkdir(folder);
        execFileSync("icacls", [folder, "/inheritance:d", "/grant", `*${USERS}:(OI)(CI)(RX)`], { stdio: "ignore" });
      },
    ],
    [
      "a file Everyone may read, deep down",
      async (secret) => {
        const file = path.join(secret, "Default", "a", "b", "c.txt");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "deep");
        execFileSync("icacls", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      },
    ],
  ];
  for (const [shape, plant] of hostile) {
    it(`passes a deny down at once over ${shape}`, async () => {
      const root = realpathSync.native(await tmpDir("folder-deny-open-"));
      const secret = path.join(root, "User Data");
      await mkdir(path.join(secret, "Default"), { recursive: true });
      ownerOnly(secret);
      await plant(secret, root);
      const outcomes = await folderOwnEditor()([denyLater(secret)]);
      assert.equal(outcomes?.[0]?.ok, true, JSON.stringify(outcomes));
      assert.equal(outcomes?.[0]?.ok && outcomes[0].deferred, undefined, "the walk did not wait");
      assert.match(sddl(path.join(secret, "Default"), root), /\(D;OICIID;FA;;;BG\)/, "it was passed down");
      await folderOwnEditor()([{ ...denyLater(secret), deny: null, walk: undefined }]);
    });
  }

  /**
   * What Chrome gives its own sandboxed processes on its profile's network folder: app container
   * and capability SIDs, which no process gets by its user, groups or logon.
   */
  const chromeSandboxes = async (secret: string) => {
    const network = path.join(secret, "Default", "Network");
    await mkdir(network, { recursive: true });
    await writeFile(path.join(network, "Cookies"), "cookies");
    const containers = ["S-1-15-2-1", "S-1-15-2-2", "S-1-15-3-1"].map((sid) => `*${sid}:(OI)(CI)(RX)`);
    execFileSync("icacls", [network, "/grant", ...containers], { stdio: "ignore" });
  };

  it("leaves the walk for later where only app containers may open something under the path besides", async () => {
    const root = realpathSync.native(await tmpDir("folder-deny-containers-"));
    const secret = path.join(root, "User Data");
    await mkdir(secret);
    await chromeSandboxes(secret);
    ownerOnly(secret);
    const outcomes = await folderOwnEditor()([denyLater(secret)]);
    assert.equal(outcomes?.[0]?.ok && outcomes[0].deferred, true, JSON.stringify(outcomes));
    await folderOwnEditor()([{ ...denyLater(secret), deny: null, walk: undefined }]);
  });

  /**
   * Token privileges and owners for the refusing fixtures, in C#: `Adjust` enables (2) or removes
   * (4) one privilege of the PowerShell process and answers Windows' error (0 when done), `Own`
   * sets a path's owner alone.
   */
  const TOKEN_HELPER = `Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class GenexTestToken {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct Privilege { public int Count; public long Luid; public int Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privilege state, int length, IntPtr previous, IntPtr returned);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string name, int type, int info, byte[] owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static int Adjust(string name, int attributes) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) return Marshal.GetLastWin32Error();
    var state = new Privilege { Count = 1, Attributes = attributes };
    if (!LookupPrivilegeValue(null, name, out state.Luid)) return Marshal.GetLastWin32Error();
    if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) return Marshal.GetLastWin32Error();
    return Marshal.GetLastWin32Error();
  }
  public static void Own(string path, string sid) {
    var owner = new SecurityIdentifier(sid);
    var bytes = new byte[owner.BinaryLength];
    owner.GetBinaryForm(bytes, 0);
    uint code = SetNamedSecurityInfo(path, 1, 1, bytes, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (code != 0) throw new Win32Exception((int)code, path);
  }
}
'@`;
  /** The privileges that let an elevated account past a DACL: what the hosted runner holds and a person's PowerShell does not. */
  const PAST_A_DACL = ["SeRestorePrivilege", "SeBackupPrivilege", "SeTakeOwnershipPrivilege", "SeSecurityPrivilege"];
  /** Runs a PowerShell script, handed over as UTF-16 base64 so no quoting touches it. */
  const powershellScript = (script: string, env: NodeJS.ProcessEnv) =>
    execFileSync(
      windowsPowerShell(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  /**
   * Make `sid` the owner of `dir` and of everything under it. Only SeRestorePrivilege may name
   * someone else, and SeTakeOwnershipPrivilege opens a folder the runner may only read: the hosted
   * runner is elevated and holds both, disabled until asked for (icacls /setowner left them so).
   */
  const setOwner = (dir: string, sid: string) => {
    powershellScript(
      `$ErrorActionPreference = 'Stop'
${TOKEN_HELPER}
foreach ($name in 'SeRestorePrivilege', 'SeTakeOwnershipPrivilege') {
  $code = [GenexTestToken]::Adjust($name, 2)
  if ($code -ne 0) { throw "could not enable $name ($code)" }
}
$paths = @($env:GENEX_OWNER_PATH) + @(Get-ChildItem -LiteralPath $env:GENEX_OWNER_PATH -Recurse -Force | ForEach-Object { $_.FullName })
foreach ($p in $paths) { [GenexTestToken]::Own($p, $env:GENEX_OWNER_SID) }
`,
      { GENEX_OWNER_PATH: dir, GENEX_OWNER_SID: sid },
    );
  };
  /**
   * Runs the folder script as a person's PowerShell would: without {@link PAST_A_DACL}. With them,
   * the runner's walk-now write (SetNamedSecurityInfoW) went through a folder that refused
   * SetFileSecurityW, so a refusal there is tested only this way.
   */
  const withoutPrivileges = async (_file: string, args: string[], env: NodeJS.ProcessEnv) => {
    const loader = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    const drop = PAST_A_DACL.map((name) => `[void][GenexTestToken]::Adjust('${name}', 4)`).join("\n");
    return powershellScript(`${TOKEN_HELPER}\n${drop}\n${loader}`, env);
  };
  /**
   * A folder the person may read but whose entries they may not change: SYSTEM owns it and the
   * person's own entry reads only, as security software or another owner can leave a browser
   * profile. `also` adds entries.
   */
  const refusesChanges = (dir: string, ...also: string[]) => {
    setOwner(dir, "S-1-5-18");
    const readOnly = [`*${runningUser()}:(OI)(CI)(RX)`, "*S-1-5-18:(OI)(CI)(F)", ...also];
    // While the person may still change the folder's entries: the second call takes that away.
    icacls(dir, "/remove:g", "*S-1-5-32-544");
    icacls(dir, "/inheritance:r", "/grant:r", ...readOnly);
    const descriptor = ownerAndDacl(dir);
    assert.match(descriptor, /^O:SY/, `SYSTEM owns the fixture: ${descriptor}`);
    assert.doesNotMatch(descriptor, /;;;BA\)/, `the Administrators have no entry: ${descriptor}`);
  };
  /** Runs icacls; a failure carries what icacls printed, which Node's message leaves out. */
  const icacls = (...args: string[]) => {
    try {
      execFileSync("icacls", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const said = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
      throw new Error(`icacls ${args.join(" ")}: ${said.trim()}`, { cause: error });
    }
  };
  /** A path's owner and DACL as SDDL, through PowerShell's Get-Acl (icacls /save leaves the owner out). */
  const ownerAndDacl = (target: string) =>
    powershellScript("(Get-Acl -LiteralPath $env:GENEX_ACL_PATH).Sddl", { GENEX_ACL_PATH: target }).trim();
  /** Give a {@link refusesChanges} folder back to the running user, as it inherits, so it can be removed. */
  const giveBack = (dir: string) => {
    setOwner(dir, runningUser());
    execFileSync("icacls", [dir, "/reset", "/T", "/C"], { stdio: "ignore" });
  };
  /** A start's own entries for denying `secret`, logging into `lines`. */
  const startDenying = (root: string, secret: string, lines: string[], options: Partial<OwnAclDeps> = {}) => {
    const denies = ownAclEntries(path.join(root, "holders"), {
      sid: async () => GUESTS,
      pid: 1,
      alive: () => false,
      log: (line) => lines.push(line),
      ...options,
    });
    return { denies, sync: () => denies.sync(routeWindowsDenies({ read: [secret], write: [] }).own) };
  };

  for (const [shape, plant] of [
    ["a folder only its owner, SYSTEM and the Administrators may open", async () => {}],
    ["a profile whose network folder Chrome opened to its own sandboxes", chromeSandboxes],
  ] as const) {
    it(`starts where Windows refuses a deny on ${shape}`, async () => {
      // A field PC refused the deny on Chrome's "User Data" at every start ("Access is denied"),
      // so the agents never started, though the sandbox user could open nothing in it anyway.
      const root = realpathSync.native(await tmpDir("folder-deny-refused-"));
      const above = path.join(root, "above");
      const secret = path.join(above, "User Data");
      const login = path.join(secret, "Default", "Login Data");
      await mkdir(path.dirname(login), { recursive: true });
      await writeFile(login, "login");
      await plant(secret);
      refusesChanges(secret);
      const lines: string[] = [];
      const start = startDenying(root, secret, lines);
      try {
        assert.equal(await start.sync(), true, "the start goes on");
        assert.doesNotMatch(sddl(secret, root), /;;;BG\)/, "the folder is left as it was");
        assert.match(sddl(above, root), /\(D;;(?:0x40|DT);;;BG\)/, "its parent is guarded as before");
        assert.ok(
          lines.some((line) => line.includes(secret)),
          `the log names the folder left as it was: ${lines.join(" | ")}`,
        );
        const next = startDenying(root, secret, lines, { pid: 2 });
        assert.equal(await next.sync(), true, "the next start tries again, and goes on again");
        await next.denies.revokeAll();
      } finally {
        giveBack(secret);
        await start.denies.revokeAll();
      }
    });
  }

  it("lets a walk Windows refuses go where the sandbox user can open nothing, without the runner's privileges", async () => {
    // A walk that runs now (here a deferred one run again) checks everything under the path itself.
    const root = realpathSync.native(await tmpDir("folder-deny-refused-walk-"));
    const secret = path.join(root, "User Data");
    await mkdir(path.join(secret, "Default", "Network"), { recursive: true });
    await writeFile(path.join(secret, "Default", "Network", "Cookies"), "cookies");
    refusesChanges(secret);
    const before = ownerAndDacl(secret);
    try {
      const outcomes = await folderOwnEditor({ powershell: withoutPrivileges })([
        { ...denyLater(secret), walk: OwnWalk.Again },
      ]);
      const [outcome] = outcomes ?? [];
      assert.equal(outcome?.ok && typeof outcome.refused, "string", JSON.stringify(outcomes));
      assert.equal(ownerAndDacl(secret), before, "the folder is left as it was");
    } finally {
      giveBack(secret);
    }
  });

  // Each of these opens something to the sandbox user, so a deny Windows refuses there still stops
  // the start. An entry on the folder alone lets the walk wait, so the deny is written on the folder
  // alone (SetFileSecurityW), which Windows refuses; one passed down or deeper walks now, refused
  // only without the runner's privileges.
  /** An allow for `sid` to list `dir` alone, set through .NET: icacls refuses a SID no account has. */
  const allowListing = (dir: string, sid: string) =>
    powershellScript(
      `$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:GENEX_ACL_PATH
$sid = New-Object Security.Principal.SecurityIdentifier $env:GENEX_ACL_SID
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'ReadAndExecute', 'None', 'None', 'Allow')))
Set-Acl -LiteralPath $env:GENEX_ACL_PATH -AclObject $acl`,
      { GENEX_ACL_PATH: dir, GENEX_ACL_SID: sid },
    );
  /** One shape: its name, the icacls entries it adds, how it plants one icacls cannot, and the start's editor. */
  type RefusedOpen = [string, string[], (secret: string) => void, Partial<OwnAclDeps>];
  const nothing = () => {};
  const refusedOpen: RefusedOpen[] = [
    ["Everyone may list it", ["*S-1-1-0:(RX)"], nothing, {}],
    ["Authenticated Users may list it", ["*S-1-5-11:(RX)"], nothing, {}],
    ["Users may list it", [`*${USERS}:(RX)`], nothing, {}],
    ["the sandbox users' group itself may list it", [`*${GUESTS}:(RX)`], nothing, {}],
    [
      "a SID that only looks like an app container's may list it",
      [],
      (secret) => allowListing(secret, "S-1-15-21-1-2-3-4"),
      {},
    ],
    [
      "Users may open everything in it",
      [`*${USERS}:(OI)(CI)(RX)`],
      nothing,
      { edit: folderOwnEditor({ powershell: withoutPrivileges }) },
    ],
  ];
  for (const [shape, also, plant, options] of refusedOpen) {
    it(`still stops where Windows refuses a deny on a folder ${shape}`, async () => {
      const root = realpathSync.native(await tmpDir("folder-deny-refused-open-"));
      const secret = path.join(root, "above", "User Data");
      await mkdir(path.join(secret, "Default"), { recursive: true });
      plant(secret);
      refusesChanges(secret, ...also);
      const before = ownerAndDacl(secret);
      const start = startDenying(root, secret, [], options);
      try {
        await assert.rejects(start.sync(), /could not set the sandbox user's entries on .*User Data/);
        assert.equal(ownerAndDacl(secret), before, "the folder is left as it was");
      } finally {
        giveBack(secret);
        await start.denies.revokeAll();
      }
    });
  }

  it("still refuses a grant or a guard Windows refuses, even where the sandbox user can open nothing", async () => {
    const root = realpathSync.native(await tmpDir("folder-grant-refused-"));
    const secret = path.join(root, "User Data");
    await mkdir(path.join(secret, "Default"), { recursive: true });
    refusesChanges(secret);
    const before = ownerAndDacl(secret);
    const own = { dir: secret, sid: GUESTS, op: FolderAceOp.Own, deny: null, walk: OwnWalk.Later } as const;
    try {
      const [aboveGrant] = await folderAceEditor()([{ dir: secret, sid: GUESTS, op: FolderAceOp.Grant }]);
      assert.equal(aboveGrant?.ok, false, "a grant above the grants");
      const [guard] = (await folderOwnEditor()([{ ...own, guard: true, grant: null, allows: false }])) ?? [];
      assert.equal(guard?.ok, false, "a guard");
      const granted = await folderOwnEditor({ powershell: withoutPrivileges })([
        { ...own, guard: false, grant: GrantAccess.Read, allows: true },
      ]);
      assert.equal(granted?.[0]?.ok, false, `a folder's grant: ${JSON.stringify(granted)}`);
      assert.equal(ownerAndDacl(secret), before, "the folder is left as it was");
    } finally {
      giveBack(secret);
    }
  });

  it("passes a deny down at once where the folder itself passes Users an allow", async () => {
    const root = realpathSync.native(await tmpDir("folder-deny-open-"));
    const secret = path.join(root, "User Data");
    await mkdir(path.join(secret, "Default"), { recursive: true });
    openToUsers(secret);
    const outcomes = await folderOwnEditor()([denyLater(secret)]);
    assert.equal(outcomes?.[0]?.ok && outcomes[0].deferred, undefined);
    assert.match(sddl(path.join(secret, "Default"), root), /\(D;OICIID;FA;;;BG\)/);
  });

  it("grants a folder and what is in it, and the folder entry above the grants comes and goes beside it", async () => {
    const root = realpathSync.native(await tmpDir("folder-grant-"));
    const game = path.join(root, "game");
    const file = path.join(game, "src", "main.js");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "game");
    const entries = ownAclEntries(path.join(root, "holders"), { sid: async () => GUESTS, pid: 1, alive: () => false });
    assert.equal(await entries.sync(routeWindowsGrants({ write: [], read: [game] }).own), true);
    const granted = /\(A;OICI;[^;]+;;;BG\)/;
    const inherited = /\(A;ID;[^;]+;;;BG\)/;
    assert.match(sddl(game, root), granted, "the folder is granted, passed down");
    assert.match(sddl(file, root), inherited, "a file in it inherits the grant");
    // A folder above another root gets the read-attributes entry; taking it back on this folder
    // (it stopped being one) must leave the folder's own grant alone.
    const editor = folderAceEditor();
    await editor([{ dir: game, sid: GUESTS, op: FolderAceOp.Grant }]);
    await editor([{ dir: game, sid: GUESTS, op: FolderAceOp.Remove }]);
    assert.match(sddl(game, root), granted, "the grant stays");
    assert.match(sddl(file, root), inherited);
    await entries.revokeAll();
    for (const p of [game, file]) assert.doesNotMatch(sddl(p, root), /;;;BG\)/, p);
  });

  it("walks nothing under a folder already granted when the next start sets the same entries", async () => {
    // srt-win passed its grant down through every file under the folder again at every start; a
    // games folder full of node_modules or a toolchain ran past its 60-second deadline each time.
    const root = realpathSync.native(await tmpDir("folder-grant-again-"));
    const game = path.join(root, "game");
    const moved = path.join(game, "node_modules", "moved");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(path.dirname(moved), { recursive: true });
    await mkdir(elsewhere);
    const first = ownAclEntries(path.join(root, "holders"), { sid: async () => GUESTS, pid: 1, alive: () => false });
    const own = routeWindowsGrants({ write: [], read: [game] }).own;
    assert.equal(await first.sync(own), true);
    // A folder moved in keeps what it inherited where it was made until a walk works it out again.
    execFileSync("icacls", [elsewhere, "/grant", `*${USERS}:(OI)(CI)(RA)`], { stdio: "ignore" });
    await mkdir(path.join(elsewhere, "moved"));
    await rename(path.join(elsewhere, "moved"), moved);
    const keptFromElsewhere = /\(A;[A-Z]*ID[A-Z]*;(?:0x80|LO);;;BU\)/;
    assert.match(sddl(moved, root), keptFromElsewhere);
    // The first process ended without taking its entries back; the next one starts.
    const next = ownAclEntries(path.join(root, "holders"), {
      sid: async () => GUESTS,
      pid: 2,
      alive: (pid) => pid === 2,
    });
    assert.equal(await next.sync(own), true);
    assert.match(sddl(moved, root), keptFromElsewhere, "nothing under the granted folder was walked again");
    assert.match(sddl(game, root), /\(A;OICI;[^;]+;;;BG\)/, "the grant is still there");
    await next.revokeAll();
  });

  it("denies a folder and guards the one above it without touching an allow Genex did not set there", async () => {
    const root = realpathSync.native(await tmpDir("folder-deny-beside-"));
    const above = path.join(root, "above");
    const secret = path.join(above, "secret");
    const open = path.join(above, "open.txt");
    await mkdir(secret, { recursive: true });
    await writeFile(open, "open");
    execFileSync("icacls", [above, "/grant", `*${GUESTS}:(OI)(CI)(RX)`], { stdio: "ignore" });
    const theirs = /\(A;OICI;0x1200a9;;;BG\)/i;
    assert.match(sddl(above, root), theirs);
    const entries = ownAclEntries(path.join(root, "holders"), { sid: async () => GUESTS, pid: 1, alive: () => false });
    assert.equal(await entries.sync(routeWindowsDenies({ read: [secret], write: [] }).own), true);
    assert.match(sddl(above, root), theirs, "the allow on the folder stays");
    assert.match(sddl(above, root), /\(D;;(?:0x40|DT);;;BG\)/, "beside the guard");
    assert.match(sddl(open, root), /\(A;ID;0x1200a9;;;BG\)/i, "and what is in the folder still inherits it");
    await entries.revokeAll();
    assert.match(sddl(above, root), theirs, "taking the deny back leaves it too");
  });

  it("refuses to deny anyone the running user is, setting nothing", async () => {
    const EVERYONE = "S-1-1-0";
    const root = realpathSync.native(await tmpDir("folder-deny-self-"));
    const target = path.join(root, "target");
    await mkdir(target);
    const edit = {
      dir: target,
      sid: EVERYONE,
      op: FolderAceOp.Own,
      deny: DenyAccess.Read,
      guard: true,
      grant: null,
      allows: false,
    } as const;
    assert.equal(await folderOwnEditor()([edit]), null);
    assert.doesNotMatch(sddl(target, root), /\(D;/);
  });

  for (const protectedAcl of [false, true]) {
    for (const access of [DenyAccess.Read, DenyAccess.Write]) {
      const inheritance = protectedAcl ? "protected" : "unprotected";
      it(`denies ${access} access on ${inheritance} DACL without changing inheritance`, async () => {
        const root = realpathSync.native(await tmpDir("folder-deny-inheritance-"));
        const above = path.join(root, "above");
        const secret = path.join(above, "secret");
        const key = path.join(secret, "nested", "key");
        const sibling = path.join(above, "sibling");
        await mkdir(path.dirname(key), { recursive: true });
        await mkdir(sibling);
        await writeFile(key, "fixture");
        openToUsers(secret);
        if (protectedAcl) execFileSync("icacls", [secret, "/inheritance:d"], { stdio: "ignore" });
        const protectedDacl = /D:P/;
        assert.equal(protectedDacl.test(sddl(secret, root)), protectedAcl, "fixture inheritance");
        const denies = ownAclEntries(path.join(root, "holders"), {
          sid: async () => GUESTS,
          pid: 1,
          alive: () => false,
        });
        const own = routeWindowsDenies({
          read: access === DenyAccess.Read ? [secret] : [],
          write: access === DenyAccess.Write ? [secret] : [],
        }).own;
        const mask = access === DenyAccess.Read ? "FA" : "(?:0x10156|DCLCRPDTCRSD)";
        try {
          assert.equal(await denies.sync(own), true);
          assert.match(sddl(secret, root), new RegExp(`\\(D;OICI;${mask};;;BG\\)`));
          assert.match(sddl(key, root), new RegExp(`\\(D;ID;${mask};;;BG\\)`));
          assert.match(sddl(above, root), /\(D;;(?:0x40|DT);;;BG\)/, "parent guard is not inherited");
          assert.doesNotMatch(sddl(sibling, root), /\(D;[^)]*;;;BG\)/, "guard stays on the parent alone");
          assert.equal(protectedDacl.test(sddl(secret, root)), protectedAcl, "deny preserves inheritance");
        } finally {
          await denies.revokeAll();
        }
        for (const dir of [secret, key, above]) assert.doesNotMatch(sddl(dir, root), /\(D;[^)]*;;;BG\)/, dir);
        assert.equal(protectedDacl.test(sddl(secret, root)), protectedAcl, "removal preserves inheritance");
      });
    }
  }
});

describe("toolchain and deny paths", () => {
  it("grants reading of the PATH folders under the profile that are safe to grant", () => {
    const denied = [at(".ssh"), at("AppData", "Roaming", "Microsoft", "Credentials")];
    const entries = [
      at("AppData", "Roaming", "nvm", "v24.18.0"),
      at("AppData", "Local", "Microsoft", "WindowsApps"),
      at("AppData", "Roaming"),
      PROFILE,
      "C:\\Program Files\\nodejs",
      at("scoop", "shims"),
      at("missing", "bin"),
      "relative\\bin",
    ];
    const exists = (dir: string) => !dir.includes("missing");
    assert.deepEqual(grantableToolDirs(entries, PROFILE, denied, { exists, entries: () => null }), [
      at("AppData", "Roaming", "nvm", "v24.18.0"),
      at("scoop", "shims"),
    ]);
  });

  it("grants pnpm's home without its package store, so the grant walks none of the store's files", () => {
    // srt-win's grant re-applies permissions through everything under a granted folder: granting
    // pnpm's home whole walked every package the person ever installed with pnpm.
    const pnpmHome = at("AppData", "Local", "pnpm");
    const npmPrefix = at("AppData", "Roaming", "npm");
    const listing: Record<string, string[]> = {
      [pnpmHome]: ["pnpm.exe", "pnpm", "pnpm.cmd", "global", ".tools", "store"],
      [`${pnpmHome}\\store`]: ["v3"],
      [npmPrefix]: ["pnpm", "pnpm.cmd", "node_modules"],
    };
    const disk = { exists: () => true, entries: (dir: string) => listing[dir] ?? null };
    const granted = grantableToolDirs([pnpmHome, npmPrefix], PROFILE, [], disk);
    const store = `${pnpmHome}\\store`;
    assert.ok(!granted.some((root) => insideWindowsPath(root, store)), granted.join("\n"));
    assert.deepEqual(
      new Set(granted),
      new Set([
        ...["pnpm.exe", "pnpm", "pnpm.cmd", "global", ".tools"].map((name) => `${pnpmHome}\\${name}`),
        // npm's prefix holds no store: its node_modules are the global CLIs it runs (OpenCode among them).
        npmPrefix,
      ]),
    );
    // The home itself still gets the read-attributes entry, so Git Bash finds `pnpm` there.
    assert.ok(ancestorDirs(PROFILE, granted).includes(pnpmHome));
  });

  it("grants a PATH folder whole when what it holds is no pnpm store, or cannot be listed", () => {
    const tools = at("tools");
    const unlisted = at("unlisted");
    const listing: Record<string, string[]> = {
      [tools]: ["tool.exe", "store"],
      [`${tools}\\store`]: ["items.json"],
    };
    const disk = { exists: () => true, entries: (dir: string) => listing[dir] ?? null };
    assert.deepEqual(grantableToolDirs([tools, unlisted], PROFILE, [], disk), [tools, unlisted]);
  });

  it("lists a PATH folder's files and folders but none of its links, whose targets a grant would open", async () => {
    // srt-win grants a link's target: a link in pnpm's home to `~\.ssh` must not become a grant there.
    const root = await tmpDir("tool-dir-entries-");
    const home = path.join(root, "pnpm");
    const secrets = path.join(root, ".ssh");
    await mkdir(path.join(home, "global"), { recursive: true });
    await mkdir(secrets);
    await writeFile(path.join(home, "pnpm.exe"), "");
    await symlink(secrets, path.join(home, "keys"), "junction");
    const listed = toolDirEntries(home);
    assert.deepEqual(listed?.sort(), ["global", "pnpm.exe"]);
    assert.equal(toolDirEntries(path.join(root, "missing")), null);
  });

  it("drops a missing deny path only in the profile outside every grant, where nothing could read it anyway", () => {
    // Off the profile (another drive) BUILTIN\Users can usually read, so a secret created there
    // after the session started would be readable unless its deny was stamped up front.
    const exists = (p: string) => p.endsWith(".ssh");
    const within = { roots: [at("AI Games")], profile: PROFILE };
    const offProfile = "D:\\Keys\\deploy.pem";
    const paths = [at(".ssh"), at(".aws"), at("AI Games", "Pong", ".env"), at(".SSH"), offProfile];
    const kept = keepWindowsDenies(paths, within, exists);
    assert.deepEqual(kept, [at(".ssh"), at("AI Games", "Pong", ".env"), offProfile]);
  });

  it("never denies OpenCode's own sign-in folder, which its sessions run as the sandbox user to read", () => {
    // A deny is an ACE for the whole sandbox group, so one member's deny shut OpenCode out of its
    // own sign-ins: every signed-in provider's model answered "Model unavailable".
    const openCode = at(".local", "share", "opencode");
    const scope = { roots: [], profile: PROFILE, readable: [openCode] };
    const paths = [at(".ssh"), openCode, at(".local", "share", "OpenCode", "auth.json"), at(".codex")];
    assert.deepEqual(
      keepWindowsDenies(paths, scope, () => true),
      [at(".ssh"), at(".codex")],
    );
  });
});

describe("read and write denies", () => {
  it("sends a path denied both ways as a read deny only, which already forbids writing", () => {
    const read = [at("secrets"), at(".ssh")];
    const write = [at("SECRETS"), at("judge"), at(".ssh", "config")];
    assert.deepEqual(writeDeniesBeyondRead(write, read), [at("judge"), at(".ssh", "config")]);
  });
});

describe("which Git: Git Bash and the host's git", () => {
  it("reads Git's install folder from the registry or from git --exec-path", () => {
    const reg =
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    C:\\Program Files\\Git\r\n";
    assert.equal(gitRootFromRegistry(reg), "C:\\Program Files\\Git");
    assert.equal(gitRootFromRegistry("ERROR: The system was unable to find the specified registry key"), null);
    assert.equal(gitRootFromExecPath("C:/Program Files/Git/mingw64/libexec/git-core\n"), "C:\\Program Files\\Git");
    assert.equal(gitRootFromExecPath("/usr/libexec/git-core"), null);
  });

  it("finds Genex's own Git in a packaged app's resources, and none outside a packaged app", () => {
    assert.equal(bundledGitRoot("C:\\Genex\\app-0.1.9\\resources"), "C:\\Genex\\app-0.1.9\\resources\\git");
    assert.equal(bundledGitRoot(undefined), null);
  });

  it("prefers an installed Git (registry, then git), then Genex's own, and reports none when none has bash.exe", async () => {
    const regOut = "    InstallPath    REG_SZ    C:\\Git\r\n";
    const exec = "D:/PortableGit/mingw64/libexec/git-core";
    const bundled = "C:\\Genex\\resources\\git";
    const found = (want: string) => (file: string) => file === want;
    const fail = async () => {
      throw new Error("not found");
    };
    const table: Array<[string, Parameters<typeof findGitBash>[0], string | null]> = [
      [
        "an installed Git before the bundled one",
        { bundled, registry: async () => regOut, execPath: async () => exec, exists: () => true },
        "C:\\Git\\bin\\bash.exe",
      ],
      [
        "bundled on a PC with no Git",
        { bundled, registry: fail, execPath: fail, exists: () => true },
        "C:\\Genex\\resources\\git\\bin\\bash.exe",
      ],
      [
        "bundled only, as the package job runs it, though Git is installed",
        { bundled, bundledOnly: true, registry: async () => regOut, execPath: async () => exec, exists: () => true },
        "C:\\Genex\\resources\\git\\bin\\bash.exe",
      ],
      [
        "bundled when the installed Git has no bash.exe",
        {
          bundled,
          registry: async () => regOut,
          execPath: fail,
          exists: found("C:\\Genex\\resources\\git\\bin\\bash.exe"),
        },
        "C:\\Genex\\resources\\git\\bin\\bash.exe",
      ],
      [
        "registry",
        { registry: async () => regOut, execPath: async () => exec, exists: () => true },
        "C:\\Git\\bin\\bash.exe",
      ],
      [
        "git",
        { registry: fail, execPath: async () => exec, exists: found("D:\\PortableGit\\bin\\bash.exe") },
        "D:\\PortableGit\\bin\\bash.exe",
      ],
      ["neither", { registry: fail, execPath: fail, exists: () => true }, null],
      ["no bash.exe", { registry: async () => regOut, execPath: async () => exec, exists: () => false }, null],
    ];
    for (const [label, lookup, expected] of table) {
      const bash = await findGitBash(lookup);
      assert.equal(bash === null ? null : bash.replaceAll("/", "\\"), expected, label);
    }
  });

  it("puts Git for Windows' cmd folder on PATH for the host's own git, or reports it missing", async () => {
    const regOut = "    InstallPath    REG_SZ    C:\\Git\r\n";
    const fail = async () => {
      throw new Error("not found");
    };
    const viaRegistry = { registry: async () => regOut, execPath: fail, exists: () => true };
    const bundled = { registry: fail, execPath: fail, exists: () => true, bundled: "C:\\Genex\\resources\\git" };
    const table: Array<[string, Parameters<typeof ensureHostGit>[0], string, boolean, string]> = [
      [
        "Genex's own Git, on a PC with none",
        bundled,
        "C:\\Windows",
        true,
        "C:\\Genex\\resources\\git\\cmd;C:\\Windows",
      ],
      [
        "an installed Git keeps its place beside Genex's own",
        { ...viaRegistry, bundled: "C:\\Genex\\resources\\git" },
        "C:\\Git\\cmd;C:\\Windows",
        true,
        "C:\\Git\\cmd;C:\\Windows",
      ],
      [
        "no Git for Windows",
        { registry: fail, execPath: fail, exists: () => true },
        "C:\\Windows",
        false,
        "C:\\Windows",
      ],
      ["installed, not on PATH", viaRegistry, "C:\\Windows", true, "C:\\Git\\cmd;C:\\Windows"],
      ["already on PATH", viaRegistry, "C:\\Windows;c:\\git\\CMD", true, "C:\\Windows;c:\\git\\CMD"],
      ["empty PATH", viaRegistry, "", true, "C:\\Git\\cmd"],
    ];
    for (const [label, lookup, before, found, after] of table) {
      const env: NodeJS.ProcessEnv = { PATH: before };
      assert.equal(await ensureHostGit(lookup, env), found, label);
      assert.equal(env.PATH, after, label);
    }
  });
});

describe("srt-win", () => {
  it("runs srt-win from the unpacked copy in a packaged app", () => {
    const packaged = path.join("/Genex", "resources", "app.asar", "node_modules", "@anthropic-ai", "sandbox-runtime");
    assert.equal(
      srtWinPath(packaged, "x64"),
      path.join(
        "/Genex",
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "@anthropic-ai",
        "sandbox-runtime",
        "vendor",
        "srt-win",
        "x64",
        "srt-win.exe",
      ),
    );
    const dev = path.join("/repo", "node_modules", "@anthropic-ai", "sandbox-runtime");
    assert.equal(srtWinPath(dev, "arm64"), path.join(dev, "vendor", "srt-win", "arm64", "srt-win.exe"));
  });

  it("reads srt-win's typed launch failure, and only a JSON line with a code", () => {
    assert.deepEqual(srtWinExecFailure('warn\n{"code":"mapped_drive_cwd","message":"Z: is a mapped drive"}\n'), {
      code: "mapped_drive_cwd",
      message: "Z: is a mapped drive",
    });
    assert.equal(srtWinExecFailure('{"not":"ours"}\n{broken'), null);
  });
});

/** The shell the env-file tests source their file in: Git Bash on Windows, bash elsewhere. */
async function testBash(): Promise<string> {
  if (process.platform !== "win32") return "/bin/bash";
  const bash = await findGitBash();
  assert.ok(bash, "the Windows runner has Git for Windows");
  return bash;
}

/** Source `file` in bash with `pre` run first, and print `script`'s output. */
async function sourced(file: string, script: string, pre = ""): Promise<string> {
  const quoted = `'${file.replaceAll("\\", "/")}'`;
  return execFileSync(await testBash(), ["-c", `${pre} . ${quoted}; ${script}`], { encoding: "utf8" });
}

describe("the env file", () => {
  it("delivers hostile values byte for byte", async () => {
    const values = {
      QUOTE: "it's",
      SUBST: "$(touch pwned) `touch pwned` ${HOME}",
      NEWLINE: "line one\nline two",
      SPACES: "  C:\\Program Files\\x  ",
    };
    const file = path.join(await tmpDir("windows-env-"), "run.env");
    await writeFile(file, renderEnvFile({ vars: values, toolPath: "" }));
    for (const [name, value] of Object.entries(values))
      assert.equal(await sourced(file, `printf '%s' "$${name}"`), value, name);
    assert.equal(existsSync(path.join(path.dirname(file), "pwned")), false, "nothing in a value ran");
  });

  it("refuses a variable name the shell would run as code", () => {
    for (const name of ["A;touch x", "1ST", "A B", "$(x)", ""])
      assert.throws(() => renderEnvFile({ vars: { [name]: "v" }, toolPath: "" }), /refusing/, JSON.stringify(name));
  });

  it("puts the toolchain after Git's /usr/bin and keeps what the shell had", async () => {
    const file = path.join(await tmpDir("windows-env-"), "run.env");
    await writeFile(file, renderEnvFile({ vars: {}, toolPath: "C:\\nvm\\v24;;D:\\Tools" }));
    const out = await sourced(file, 'printf "%s" "$PATH"', "PATH=/before;");
    assert.equal(out, "/usr/bin:/c/nvm/v24:/d/Tools:/before");
  });

  it("switches Git's credential helper off after the entries srt set", async () => {
    const file = path.join(await tmpDir("windows-env-"), "run.env");
    await writeFile(file, renderEnvFile({ vars: {}, toolPath: "" }));
    const pre = "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=C:/ws;";
    const out = await sourced(
      file,
      'printf "%s|%s|%s|%s=%s" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" "$GIT_CONFIG_KEY_1" "$GIT_CONFIG_VALUE_1"',
      pre,
    );
    assert.equal(out, "2|safe.directory|C:/ws|credential.helper=");
    assert.equal(await sourced(file, 'printf "%s=%s" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0"'), "1=credential.helper");
  });

  it("spells Windows paths the way Git Bash does", () => {
    const table: Array<[string, string]> = [
      ["C:\\Program Files\\nodejs", "/c/Program Files/nodejs"],
      ["d:\\x\\", "/d/x"],
      ["C:\\", "/c"],
      ["C:/x/y", "/c/x/y"],
      ["\\\\server\\share\\bin", "//server/share/bin"],
      ["/usr/bin", "/usr/bin"],
    ];
    for (const [windows, msys] of table) assert.equal(msysPath(windows), msys, windows);
    assert.equal(msysPathList("C:\\a;;D:\\b c;"), "/c/a:/d/b c");
  });

  it("leaves the sandbox user's own profile variables alone unless the caller sets them", () => {
    const vars = windowsRunEnv({
      env: { PATH: "C:\\x", USERPROFILE: "C:\\Users\\Ann", HOME: "C:\\Users\\Ann", LANG: "en_US.UTF-8", TMP: "C:\\T" },
      own: { HARNESS_WS: "C:\\ws", HOME: "C:\\home-for-this-run", PATH: "C:\\ignored" },
      scratch: "C:\\Users\\Ann\\AppData\\Roaming\\Genex\\scratch",
      curlHome: "C:\\s\\.curl",
    });
    assert.deepEqual(vars, {
      LANG: "en_US.UTF-8",
      TMP: "C:/Users/Ann/AppData/Roaming/Genex/scratch",
      TMPDIR: "C:/Users/Ann/AppData/Roaming/Genex/scratch",
      TEMP: "C:/Users/Ann/AppData/Roaming/Genex/scratch",
      CURL_HOME: "C:/s/.curl",
      GIT_TERMINAL_PROMPT: "0",
      NODE_USE_ENV_PROXY: "1",
      MSYS_NO_PATHCONV: "1",
      HARNESS_WS: "C:\\ws",
      HOME: "C:\\home-for-this-run",
    });
  });
});

// ── the grant session ────────────────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
} as SandboxRuntimeConfig;

function withDomains(domains: string[]): SandboxRuntimeConfig {
  return { ...BASE_CONFIG, network: { ...BASE_CONFIG.network, allowedDomains: domains } };
}

/** A sandbox-runtime error as srt-win's spawn chokepoint raises it: its code and first CLI arg. */
type InitializeFailure = { code: string; subcommand: string; message?: string };

/**
 * sandbox-runtime's error for an egress check srt-win could not start as the sandbox user, in
 * srt-win's words: ERROR_ACCESS_DENIED (`hresult` 0x80070005) where that user could not open the
 * program, or 0x80070422 where the Secondary Logon service is disabled.
 */
function refusedLogon(hresult: string, words: string): InitializeFailure {
  return {
    code: "wfp_verify_unparseable",
    subcommand: "wfp",
    message: `WFP egress fence could not be verified — \`srt-win wfp verify\` exited 1 with unparseable output "" (stderr: "srt-win: error: spawn runner for egress probe: CreateProcessWithLogonW(srt-sandbox): ${words} (${hresult}) — ensure the Secondary Logon service (seclogon) is running.")`,
  };
}

function fakeSessionRuntime() {
  const calls: string[] = [];
  const configs: SandboxRuntimeConfig[] = [];
  let gate: Promise<void> | null = null;
  const failures: InitializeFailure[] = [];
  const runtime = {
    initialize: async (config: SandboxRuntimeConfig) => {
      calls.push("initialize");
      configs.push(config);
      if (gate) await gate;
      const failure = failures.shift();
      if (!failure) return;
      const { message = `srt-win ${failure.subcommand} failed: ${failure.code}`, ...fields } = failure;
      throw Object.assign(new Error(message), fields);
    },
    reset: async () => {
      calls.push("reset");
    },
    updateConfig: (config: SandboxRuntimeConfig) => {
      calls.push("update");
      configs.push(config);
    },
  };
  return {
    runtime,
    calls,
    configs,
    last: () => configs.at(-1) as SandboxRuntimeConfig,
    hold: () => {
      let open = () => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    /** The next initializes fail with these sandbox-runtime codes, in order, from the egress check. */
    failInitialize: (...codes: string[]) => {
      failures.push(...codes.map((code) => ({ code, subcommand: "wfp" })));
    },
    /** The next initializes fail with this code from the given srt-win subcommand. */
    failInitializeIn: (subcommand: string, ...codes: string[]) => {
      failures.push(...codes.map((code) => ({ code, subcommand })));
    },
    /** The next initializes fail with these errors, in order. */
    failInitializeWith: (...errors: InitializeFailure[]) => {
      failures.push(...errors);
    },
  };
}

function fakeAncestors() {
  const synced: string[][] = [];
  let revoked = 0;
  const ancestors: AncestorGrants = {
    sync: async (dirs) => {
      synced.push([...dirs]);
    },
    revokeAll: async () => {
      revoked++;
    },
    revokeAllSync: () => {
      revoked++;
    },
  };
  return { ancestors, synced, revoked: () => revoked };
}

/**
 * Genex's own entries over a fake: each sync's entries, logged in `calls` as "own entries";
 * `available: false` answers as a PC where Genex cannot set them (no sandbox users' group).
 */
function fakeOwnEntries(
  calls: string[],
  options: { available?: boolean; walk?: () => Promise<void>; walks?: string[] } = {},
) {
  const synced: OwnAclEntry[][] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let revoked = 0;
  let walked = 0;
  const entries: OwnAclEntries = {
    sync: async (entries) => {
      calls.push("own entries");
      synced.push([...entries]);
      return options.available ?? true;
    },
    walkDeferred: async (run) => {
      walked++;
      run?.walking?.(options.walks ?? []);
      signals.push(run?.signal);
      await options.walk?.();
    },
    walks: () => options.walks ?? [],
    revokeAll: async () => {
      revoked++;
    },
    revokeAllSync: () => {
      revoked++;
    },
  };
  return { entries, synced, signals, revoked: () => revoked, walked: () => walked };
}

/**
 * A session over fakes; `realDenies` keeps the real filter of missing deny paths, `ownDenies`
 * lets Genex set the denies outside the grants itself (`unavailable`: a PC where it cannot).
 */
function session(
  options: {
    realDenies?: boolean;
    profile?: string;
    ownDenies?: boolean | "unavailable";
    exists?: (p: string) => boolean;
    walk?: () => Promise<void>;
    walks?: string[];
    walkDelayMs?: number;
    logonRetryMs?: number[];
  } = {},
) {
  const runtime = fakeSessionRuntime();
  const ancestors = fakeAncestors();
  const own = fakeOwnEntries(runtime.calls, {
    available: options.ownDenies !== "unavailable",
    ...(options.walk ? { walk: options.walk } : {}),
    ...(options.walks ? { walks: options.walks } : {}),
  });
  const logged: string[] = [];
  const value = new WindowsSandboxSession({
    runtime: runtime.runtime,
    profile: options.profile ?? PROFILE,
    ancestors: ancestors.ancestors,
    ...(options.ownDenies ? { own: own.entries } : {}),
    ...(options.realDenies ? {} : { keepDenies: (paths: readonly string[]) => [...paths], exists: () => true }),
    ...(options.exists ? { exists: options.exists } : {}),
    ...(options.walkDelayMs === undefined ? {} : { walkDelayMs: options.walkDelayMs }),
    ...(options.logonRetryMs ? { logonRetryMs: options.logonRetryMs } : {}),
    log: (line) => logged.push(line),
  });
  return { session: value, runtime, ancestors, own, logged };
}

const GAMES = at("AI Games");
const WS = at("AppData", "Roaming", "Genex", "workspaces");
const LATE = "D:\\Elsewhere\\Pong";

describe("the grant session", () => {
  it("initializes once, on the first join, with the member's grants and the folders above them", async () => {
    const s = session();
    await s.session.join({}, { grants: { write: [WS], read: [] }, config: BASE_CONFIG });
    assert.deepEqual(s.runtime.calls, ["initialize"]);
    assert.deepEqual(s.runtime.last().filesystem.allowWrite, [WS]);
    assert.deepEqual(s.ancestors.synced, [
      [at("AppData"), at("AppData", "Roaming"), at("AppData", "Roaming", "Genex")],
    ]);
  });

  it("grants the folders above the roots after srt-win initializes, and again after every regrant", async () => {
    // srt-win's deny stamp puts a FILE_DELETE_CHILD deny on each denied path's parent, and that
    // replaces the sandbox user's entry there: a read-attributes grant made before it on the same
    // folder (userData, the parent of secrets) was gone, and the harness failed to lstat it.
    const runtime = fakeSessionRuntime();
    const synced: string[][] = [];
    const ancestors: AncestorGrants = {
      sync: async (dirs) => {
        runtime.calls.push("ancestors");
        synced.push([...dirs]);
      },
      revokeAll: async () => {},
      revokeAllSync: () => {},
    };
    const value = new WindowsSandboxSession({ runtime: runtime.runtime, profile: PROFILE, ancestors });
    const owner = {};
    await value.join(owner, { grants: { write: [WS], read: [] }, config: BASE_CONFIG });
    assert.deepEqual(runtime.calls, ["initialize", "ancestors"]);
    value.update(owner, { write: [WS, LATE], read: [] });
    await value.settled();
    assert.deepEqual(runtime.calls, ["initialize", "ancestors", "reset", "initialize", "ancestors"]);
    assert.deepEqual(synced.at(-1), synced[0], "every folder is granted again after the regrant");
  });

  it("sets the folders above the roots again for a process that outlives the call, and only once applied", async () => {
    const s = session();
    await s.session.refreshAncestors();
    assert.deepEqual(s.ancestors.synced, [], "nothing is applied yet");
    await s.session.join({}, { grants: { write: [WS], read: [] }, config: BASE_CONFIG });
    await s.session.refreshAncestors();
    assert.equal(s.ancestors.synced.length, 2);
    assert.deepEqual(s.ancestors.synced[1], s.ancestors.synced[0]);
    assert.deepEqual(s.runtime.calls, ["initialize"], "no reset, no initialize: srt's own grants stand");
  });

  it("a failed grant above the roots undoes the initialize and fails the join", async () => {
    const runtime = fakeSessionRuntime();
    const ancestors: AncestorGrants = {
      sync: async () => {
        throw new Error("could not let the sandbox user see the folder");
      },
      revokeAll: async () => {},
      revokeAllSync: () => {},
    };
    const value = new WindowsSandboxSession({ runtime: runtime.runtime, profile: PROFILE, ancestors });
    await assert.rejects(
      value.join({}, { grants: { write: [WS], read: [] }, config: BASE_CONFIG }),
      /could not let the sandbox user see/,
    );
    assert.deepEqual(runtime.calls, ["initialize", "reset"]);
    assert.equal(value.applied, null);
  });

  it("a member whose grants are already covered changes nothing", async () => {
    const s = session();
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    await s.session.join({}, { grants: { write: [path.win32.join(GAMES, "Pong")], read: [] }, config: BASE_CONFIG });
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, ["initialize"]);
    assert.equal(s.session.regrants, 0);
  });

  it("waits for running commands, then applies every queued folder in one regrant", async () => {
    const s = session();
    const owner = {};
    await s.session.join(owner, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    const release = await s.session.acquire();
    s.session.update(owner, { write: [GAMES, LATE], read: [] });
    s.session.update(owner, { write: [GAMES, LATE], read: ["D:\\Tools"] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(s.runtime.calls, ["initialize"], "nothing is reset under a running command");
    assert.equal(s.session.covers({ write: [LATE], read: [] }), false);
    release();
    release();
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, ["initialize", "reset", "initialize"]);
    assert.equal(s.session.regrants, 1);
    assert.deepEqual(s.runtime.last().filesystem.allowWrite, [GAMES, LATE]);
    assert.deepEqual(s.runtime.last().filesystem.allowRead, ["D:\\Tools"]);
    assert.equal(s.session.covers({ write: [LATE], read: [] }), true);
  });

  it("a command that arrives during a regrant waits for it", async () => {
    const s = session();
    const owner = {};
    await s.session.join(owner, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    const open = s.runtime.hold();
    s.session.update(owner, { write: [GAMES, LATE], read: [] });
    let acquired = false;
    const waiting = s.session.acquire().then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(acquired, false, "no command starts while the grants are half applied");
    open();
    (await waiting)();
    assert.equal(s.session.covers({ write: [LATE], read: [] }), true);
  });

  it("a failed initialize is reported to the joiner and retried by the next command", async () => {
    const s = session();
    s.runtime.failInitialize("not_provisioned");
    await assert.rejects(
      s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG }),
      /not_provisioned/,
    );
    const release = await s.session.acquire();
    release();
    assert.deepEqual(s.runtime.calls, ["initialize", "initialize"]);
  });

  it("a member that brings a new deny path queues a regrant, an already applied one does not", async () => {
    const s = session();
    const denying = (paths: string[]) => ({
      ...BASE_CONFIG,
      filesystem: { ...BASE_CONFIG.filesystem, denyRead: paths },
    });
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: denying([at(".ssh")]) });
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: denying([at(".SSH")]) });
    await s.session.settled();
    assert.equal(s.session.regrants, 0);
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: denying([at("secrets")]) });
    await s.session.settled();
    assert.equal(s.session.regrants, 1);
    assert.deepEqual(s.runtime.last().filesystem.denyRead, [at(".ssh"), at(".SSH"), at("secrets")]);
  });

  it("a member that leaves takes its folders with it, at the next moment no command runs", async () => {
    const s = session();
    const stays = {};
    const leaves = {};
    await s.session.join(stays, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    await s.session.join(leaves, { grants: { write: [LATE], read: [] }, config: BASE_CONFIG });
    await s.session.settled();
    assert.equal(s.session.covers({ write: [LATE], read: [] }), true);
    const release = await s.session.acquire();
    s.session.leave(leaves);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.session.regrants, 1, "nothing is reset under a running command");
    release();
    await s.session.settled();
    assert.equal(s.session.regrants, 2);
    assert.deepEqual(s.runtime.last().filesystem.allowWrite, [GAMES]);
    assert.equal(s.session.covers({ write: [LATE], read: [] }), false);
    assert.equal(s.session.covers({ write: [GAMES], read: [] }), true);
  });

  it("a member that leaves nothing only it needed changes nothing", async () => {
    const s = session();
    const leaves = {};
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    await s.session.join(leaves, {
      grants: { write: [path.win32.join(GAMES, "Pong")], read: [] },
      config: BASE_CONFIG,
    });
    s.session.leave(leaves);
    s.session.leave(leaves);
    s.session.leave({});
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, ["initialize"]);
  });

  it("the last member out releases every grant, and a later join starts the session again", async () => {
    const s = session();
    const only = {};
    await s.session.join(only, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    s.session.leave(only);
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, ["initialize", "reset"]);
    assert.equal(s.session.applied, null);
    assert.equal(s.ancestors.revoked(), 1, "the folders above the roots are taken back too");
    await s.session.join({}, { grants: { write: [WS], read: [] }, config: BASE_CONFIG });
    assert.deepEqual(s.runtime.calls, ["initialize", "reset", "initialize"]);
    assert.deepEqual(s.runtime.last().filesystem.allowWrite, [WS]);
  });

  it("an srt-win timeout in an ACL step is not tried again, and says an antivirus can cause it", async () => {
    // Issue #476: a real-time antivirus scanning every file srt-win touched held its ACL step past
    // its deadline, and the agents never started with only srt-win's own words to go on.
    const s = session();
    s.runtime.failInitializeIn("acl", "srt_win_timeout");
    await assert.rejects(
      s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG }),
      (error: unknown) => {
        assert.ok(error instanceof SandboxLaunchError, String(error));
        assert.equal(error.code, SandboxLaunchCode.SrtWinTimeout);
        assert.match(error.message, /antivirus/i);
        assert.match(error.message, /srt-win acl failed: srt_win_timeout/, "srt-win's words stay for the report");
        return true;
      },
    );
    assert.deepEqual(s.runtime.calls, ["initialize"]);
  });

  it("an srt-win timeout in the egress check is tried once more, two attempts in all", async () => {
    const s = session();
    s.runtime.failInitialize("srt_win_timeout");
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    assert.deepEqual(s.runtime.calls, ["initialize", "initialize"]);

    const stuck = session();
    stuck.runtime.failInitialize("srt_win_timeout", "srt_win_timeout");
    await assert.rejects(
      stuck.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG }),
      /srt_win_timeout/,
    );
    assert.equal(stuck.runtime.calls.length, 2);
  });

  it("starts again after a pause when Windows refused srt-win's start as the sandbox user", async () => {
    // A first start from a new install can be refused once and start seconds later with nothing
    // changed; srt-win's own words blame the Secondary Logon service, which was running.
    const denied = refusedLogon("0x80070005", "Access is denied.");
    const once = session({ logonRetryMs: [0, 0] });
    once.runtime.failInitializeWith(denied);
    await once.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    assert.deepEqual(once.runtime.calls, ["initialize", "initialize"]);
    assert.ok(
      once.logged.some((line) => line.startsWith("egress check: Windows refused to start srt-win as the sandbox user")),
      once.logged.join("\n"),
    );

    const localized = session({ logonRetryMs: [0, 0] });
    localized.runtime.failInitializeWith(refusedLogon("0x80070005", "Accesso negato."), denied);
    await localized.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    assert.equal(localized.runtime.calls.length, 3, "Windows' words in any language: the HRESULT decides");

    const stuck = session({ logonRetryMs: [0, 0] });
    stuck.runtime.failInitializeWith(denied, denied, denied, denied);
    await assert.rejects(
      stuck.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG }),
      (error: unknown) => {
        assert.ok(error instanceof SandboxLaunchError);
        assert.equal(error.code, SandboxLaunchCode.SandboxUserRefused);
        assert.doesNotMatch(error.message, /srt-win|CreateProcessWithLogonW|seclogon/, "plain words");
        return true;
      },
    );
    assert.equal(stuck.runtime.calls.length, 3, "two pauses, three tries");
    assert.ok(
      stuck.logged.some((line) => line.includes("0x80070005")),
      "the log keeps srt-win's words",
    );
  });

  it("does not wait out a refusal that is not the sandbox user's: a disabled service is Set up's", async () => {
    const s = session({ logonRetryMs: [0, 0] });
    s.runtime.failInitializeWith(
      refusedLogon(
        "0x80070422",
        "The service cannot be started, either because it is disabled or because it has no enabled devices associated with it.",
      ),
    );
    await assert.rejects(
      s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG }),
      /0x80070422/,
    );
    assert.deepEqual(s.runtime.calls, ["initialize"]);
  });

  it("network changes apply live, with every member's domains and no regrant", async () => {
    const s = session();
    const a = {};
    const b = {};
    await s.session.join(a, { grants: { write: [GAMES], read: [] }, config: withDomains([]) });
    await s.session.join(b, { grants: { write: [GAMES], read: [] }, config: withDomains(["localhost"]) });
    s.session.network(a, withDomains(["registry.npmjs.org"]));
    assert.deepEqual(s.runtime.calls, ["initialize", "update"]);
    assert.deepEqual(s.runtime.last().network.allowedDomains, ["registry.npmjs.org", "localhost"]);
  });

  it("a network change that lands during a regrant reaches srt once the regrant is applied", async () => {
    // An install's registry closed while a folder opened mid-install was being granted: the
    // regrant had already built its config with the registry, and nothing pushed the closing.
    const s = session();
    const owner = {};
    await s.session.join(owner, { grants: { write: [GAMES], read: [] }, config: withDomains(["registry.npmjs.org"]) });
    const open = s.runtime.hold();
    s.session.update(owner, { write: [GAMES, LATE], read: [] });
    await new Promise((resolve) => setImmediate(resolve));
    s.session.network(owner, withDomains([]));
    open();
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, ["initialize", "reset", "initialize", "update"]);
    assert.deepEqual(s.runtime.last().network.allowedDomains, []);
  });

  it("logs how long srt's initialize and the folders above the roots took", async () => {
    const s = session();
    await s.session.join({}, { grants: { write: [WS], read: [] }, config: BASE_CONFIG });
    assert.deepEqual(
      s.logged.map((line) => line.replace(/\d+ ms$/, "N ms")),
      ["initialize: N ms", "folders above the grants: N ms"],
    );
  });

  it("dispose resets and takes back the folders above the roots", async () => {
    const s = session();
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    await s.session.dispose();
    assert.deepEqual(s.runtime.calls, ["initialize", "reset"]);
    assert.equal(s.ancestors.revoked(), 1);
  });
});

describe("deny paths Genex sets itself", () => {
  // srt-win's stamp puts an inheritable FILE_DELETE_CHILD deny on every denied path's parent, and
  // Windows passes it down through everything under that parent, once per path: for `~\.ssh` or
  // `~\.claude` the whole profile, for a game's `.claude` the whole game. A large profile or a few
  // large games ran past srt-win's 60-second deadline.
  const PONG = at("AI Games", "Pong");
  const NEVER_MADE = at("AI Games", "Pong", "never-made");
  const exists = (p: string) => p !== NEVER_MADE;
  const denying = (denyRead: string[], denyWrite: string[] = []): SessionMember => ({
    grants: { write: [PONG], read: [] },
    config: { ...BASE_CONFIG, filesystem: { ...BASE_CONFIG.filesystem, denyRead, denyWrite } },
  });
  const SECRETS = [
    at(".ssh"),
    at(".claude"),
    at("AppData", "Roaming", "Microsoft", "Credentials"),
    at("AI Games", "Pong", ".env"),
    "D:\\Keys\\deploy.pem",
    NEVER_MADE,
  ];
  const WRITE_ONLY = [at("AppData", "Local", "Roblox", "AssistantSettings"), at("AI Games", "Pong", ".claude")];

  it("never hands srt-win a deny on a path that exists outside its write roots, whose parent its stamp would walk whole", async () => {
    // Inside a write root the deny is srt-win's: its first grant of the root rewrote a file under a
    // folder Genex had denied as its own, protected and closed (EPERM on the harness's skills).
    // srt-win keeps a deny under a kept root with the root, so its walk of the parent runs once.
    const s = session({ ownDenies: true, exists });
    await s.session.join({}, denying(SECRETS, WRITE_ONLY));
    const sent = s.runtime.last().filesystem;
    assert.deepEqual(
      sent.denyRead,
      [at("AI Games", "Pong", ".env"), NEVER_MADE],
      "the write root's, and a missing path",
    );
    assert.deepEqual(sent.denyWrite, [at("AI Games", "Pong", ".claude")]);
    assert.deepEqual(s.own.synced, [
      [
        { path: PROFILE, deny: null, guard: true },
        { path: at(".claude"), deny: DenyAccess.Read, guard: false },
        { path: at(".ssh"), deny: DenyAccess.Read, guard: false },
        { path: at("AppData", "Local", "Roblox"), deny: null, guard: true },
        { path: at("AppData", "Local", "Roblox", "AssistantSettings"), deny: DenyAccess.Write, guard: false },
        { path: at("AppData", "Roaming", "Microsoft"), deny: null, guard: true },
        { path: at("AppData", "Roaming", "Microsoft", "Credentials"), deny: DenyAccess.Read, guard: false },
        { path: "D:\\Keys", deny: null, guard: true },
        { path: "D:\\Keys\\deploy.pem", deny: DenyAccess.Read, guard: false },
      ],
    ]);
    assert.deepEqual(s.runtime.calls, ["own entries", "initialize"], "denied before srt-win grants anything");
  });

  it("leaves every deny to srt-win, as before, where Genex cannot set them itself, and says so", async () => {
    const s = session({ ownDenies: "unavailable", exists });
    await s.session.join({}, denying(SECRETS, WRITE_ONLY));
    const sent = s.runtime.last().filesystem;
    assert.deepEqual(sent.denyRead, SECRETS);
    assert.deepEqual(sent.denyWrite, WRITE_ONLY);
    // srt-win's grant and stamp then walk each folder again: a timeout after it reads as that.
    assert.ok(
      s.logged.some((line) => line.startsWith("own entries off: srt-win sets all 9 grants and denies")),
      s.logged.join("\n"),
    );
  });

  it("sets them again on every regrant, and keeps them after the last member and dispose, for the next start", async () => {
    const s = session({ ownDenies: true });
    const owner = {};
    await s.session.join(owner, denying([at(".ssh")]));
    s.session.update(owner, { write: [PONG, LATE], read: [] });
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, ["own entries", "initialize", "reset", "own entries", "initialize"]);
    s.session.leave(owner);
    await s.session.settled();
    await s.session.join({}, denying([at(".ssh")]));
    await s.session.dispose();
    // Intentionally flipped: they were taken back here, and walked again at every start.
    assert.equal(s.own.revoked(), 0);
  });

  it("passes the deferred entries down after the start, off its path, and a regrant near that walk waits for it", async () => {
    let finish = () => {};
    const walking = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const s = session({ ownDenies: true, walk: () => walking, walks: [at(".ssh")], walkDelayMs: 0 });
    const owner = {};
    await s.session.join(owner, denying([at(".ssh")]));
    assert.equal(s.own.walked(), 0, "the start does not wait for the walk");
    await delay(0);
    await turn();
    assert.equal(s.own.walked(), 1, "the walk starts once the start is done");
    // Intentionally flipped: every regrant waited for the walk, and a first walk of a large folder
    // held up each command for as long as it ran.
    s.session.update(owner, { write: [PONG, LATE], read: [] });
    await s.session.settled();
    const regranted = ["own entries", "initialize", "reset", "own entries", "initialize"];
    assert.deepEqual(s.runtime.calls, regranted, "a folder elsewhere is granted while the walk runs");
    await delay(0);
    await turn();
    assert.equal(s.own.walked(), 1, "the walk that regrant left waits for the one still running");
    void s.session.join({}, denying([at(".ssh"), at(".ssh", "id_ed25519")]));
    await turn();
    await turn();
    assert.deepEqual(s.runtime.calls, regranted, "a deny inside the walked path waits for the walk");
    finish();
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, [...regranted, "reset", "own entries", "initialize"]);
    await delay(0);
    await turn();
    assert.ok(s.own.walked() >= 2, "then it runs, after the regrant near it");
    await s.session.dispose();
  });

  it("takes back a grant only once a walk under way on that folder is done", async () => {
    let finish = () => {};
    const walking = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const s = session({ ownDenies: true, walk: () => walking, walks: [PONG], walkDelayMs: 0 });
    const pong = {};
    const late = {};
    await s.session.join(pong, { grants: { write: [PONG], read: [] }, config: BASE_CONFIG });
    await s.session.join(late, { grants: { write: [LATE], read: [] }, config: BASE_CONFIG });
    await s.session.settled();
    await delay(0);
    await turn();
    assert.equal(s.own.walked(), 1, "the walk is under way");
    const before = [...s.runtime.calls];
    s.session.leave(pong);
    await turn();
    await turn();
    assert.deepEqual(s.runtime.calls, before, "the walk would set the grant again after it was taken back");
    finish();
    await s.session.settled();
    assert.deepEqual(s.runtime.calls, [...before, "reset", "own entries", "initialize"]);
    assert.ok(
      s.own.synced.at(-1)?.every((entry) => entry.path !== PONG),
      "then the grant is taken back",
    );
    await s.session.dispose();
  });

  it("starts a walk a grant left at once, and a deny's only after the start is past", async () => {
    const npm = at("AppData", "Roaming", "npm");
    const granting = session({ ownDenies: true, walks: [npm], walkDelayMs: 60_000 });
    await granting.session.join({}, { grants: { write: [PONG], read: [npm] }, config: BASE_CONFIG });
    await delay(0);
    await turn();
    assert.equal(granting.own.walked(), 1, "a command may need what the grant opens");
    await granting.session.dispose();
    const denying = session({ ownDenies: true, walks: [at(".ssh")], walkDelayMs: 60_000 });
    await denying.session.join({}, { grants: { write: [PONG], read: [npm] }, config: BASE_CONFIG });
    await delay(0);
    await turn();
    assert.equal(denying.own.walked(), 0, "a deny's walk opens nothing a command waits for");
    await denying.session.dispose();
  });

  it("stops a walk under way when Genex quits, leaving it for the next start", async () => {
    const s = session({ ownDenies: true, walk: () => new Promise<void>(() => {}), walks: [PONG], walkDelayMs: 0 });
    await s.session.join({}, { grants: { write: [PONG], read: [] }, config: BASE_CONFIG });
    await delay(0);
    await turn();
    assert.equal(s.own.signals[0]?.aborted, false);
    s.session.stopWalks();
    assert.equal(s.own.signals[0]?.aborted, true, "its PowerShell is stopped");
  });

  it("stops every walk when Genex quits, the one under way and one waiting behind it", async () => {
    let finish = () => {};
    const walking = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const s = session({ ownDenies: true, walk: () => walking, walks: [at(".ssh")], walkDelayMs: 0 });
    const owner = {};
    await s.session.join(owner, denying([at(".ssh")]));
    await delay(0);
    await turn();
    s.session.update(owner, { write: [PONG, LATE], read: [] });
    await s.session.settled();
    await delay(0);
    await turn();
    assert.equal(s.own.walked(), 1, "a second walk waits behind the first");
    s.session.stopWalks();
    assert.equal(s.own.signals[0]?.aborted, true, "the walk under way stops");
    finish();
    await delay(0);
    await turn();
    await turn();
    assert.equal(s.own.walked(), 1, "and the one waiting behind it never starts");
  });

  it("starts a deferred walk only once a regrant already running has finished", async () => {
    const s = session({ ownDenies: true, walkDelayMs: 10 });
    const owner = {};
    await s.session.join(owner, denying([at(".ssh")]));
    const release = s.runtime.hold();
    s.session.update(owner, { write: [PONG, LATE], read: [] });
    await turn();
    await delay(30);
    assert.equal(s.own.walked(), 0, "the walk waits for the regrant that is setting the entries");
    release();
    await s.session.settled();
    await turn();
    assert.equal(s.own.walked(), 1);
    await s.session.dispose();
  });

  it("starts no deferred walk once disposed", async () => {
    const s = session({ ownDenies: true, walkDelayMs: 0 });
    await s.session.join({}, denying([at(".ssh")]));
    await s.session.dispose();
    await delay(0);
    assert.equal(s.own.walked(), 0);
  });

  it("hands srt-win every write root and no read grant on a folder that exists", async () => {
    // A command writes only where srt-win's own grant names the root (its write-restricted token),
    // and srt-win keeps those between sessions. Its read grant passed its entry down through
    // everything under each folder at every start (a toolchain) and ran past its deadline.
    const runtime = fakeSessionRuntime();
    const own = fakeOwnEntries(runtime.calls);
    const npm = at("AppData", "Roaming", "npm");
    const install = at("AppData", "Local", "genex", "app-0.1.13");
    const gone = at("AppData", "Roaming", "uninstalled-tool");
    const value = new WindowsSandboxSession({
      runtime: runtime.runtime,
      profile: PROFILE,
      ancestors: fakeAncestors().ancestors,
      own: own.entries,
      launchDirs: [install],
      keepDenies: (paths) => [...paths],
      exists: (p) => p !== LATE && p !== gone,
    });
    await value.join({}, { grants: { write: [PONG, LATE], read: [npm, gone] }, config: BASE_CONFIG });
    const sent = runtime.last();
    assert.deepEqual(sent.filesystem.allowWrite, [PONG, LATE], "srt-win grants every write root, gone or not");
    assert.deepEqual(sent.filesystem.allowRead, [gone], "only a read root Genex cannot grant (gone here)");
    assert.equal(sent.git, undefined, "srt-win marks its own write grants safe for Git");
    assert.deepEqual(own.synced[0], [
      { path: install, deny: null, guard: false, grant: GrantAccess.Read },
      { path: npm, deny: null, guard: false, grant: GrantAccess.Read },
    ]);
    assert.deepEqual(runtime.calls, ["own entries", "initialize"], "the launch folders are among Genex's grants");
  });

  it("grants with srt-win, the folders it starts from among them, where Genex cannot set entries itself", async () => {
    const runtime = fakeSessionRuntime();
    const own = fakeOwnEntries(runtime.calls, { available: false });
    const install = at("AppData", "Local", "genex", "app-0.1.13");
    const broker = "D:\\Tools\\srt-win";
    const npm = at("AppData", "Roaming", "npm");
    const denyRead = [at(".ssh")];
    const denyWrite = [at(".config")];
    const value = new WindowsSandboxSession({
      runtime: runtime.runtime,
      profile: PROFILE,
      ancestors: fakeAncestors().ancestors,
      own: own.entries,
      launchDirs: [install, broker.toUpperCase().replaceAll("\\", "/")],
      keepDenies: (paths) => [...paths],
      exists: () => true,
    });
    const owner = {};
    await value.join(owner, {
      grants: { write: [PONG], read: [npm] },
      config: { ...BASE_CONFIG, filesystem: { ...BASE_CONFIG.filesystem, denyRead, denyWrite } },
    });
    const assertConfig = (write: string[]) => {
      const sent = runtime.last();
      const read = sent.filesystem.allowRead ?? [];
      assert.equal(read.length, 3, "only the member's read root and the launch folders are readable");
      for (const dir of [install, broker, npm]) {
        assert.ok(
          entryPaths(read).some((root) => insideWindowsPath(root, dir) && insideWindowsPath(dir, root)),
          `the session keeps the read grant on ${dir}`,
        );
      }
      assert.deepEqual(sent.filesystem.allowWrite, write);
      assert.deepEqual(sent.filesystem.denyRead, denyRead);
      assert.deepEqual(sent.filesystem.denyWrite, denyWrite);
      assert.equal(sent.git, undefined);
    };
    assertConfig([PONG]);
    assert.deepEqual(runtime.calls, ["own entries", "initialize"]);
    value.update(owner, { write: [PONG, LATE], read: [npm] });
    await value.settled();
    assertConfig([PONG, LATE]);
    assert.deepEqual(runtime.calls, ["own entries", "initialize", "reset", "own entries", "initialize"]);
    await value.dispose();
  });

  it("leaves srt-win every write root, and a read root that is gone, a drive root or a share", () => {
    const table: Array<[string, string]> = [
      ["a folder that is gone (srt-win drops it)", NEVER_MADE],
      ["a drive root", "D:\\"],
      ["a network share", "\\\\nas\\games"],
    ];
    for (const [label, root] of table) {
      const routes = routeWindowsGrants({ write: [root], read: [root] }, { realpath: (p) => p, exists });
      assert.deepEqual(routes, { srt: { read: [root], write: [root] }, own: [] }, label);
    }
    const npm = at("AppData", "Roaming", "npm");
    const both = routeWindowsGrants({ write: [PONG], read: [npm] }, { realpath: (p) => p, exists });
    assert.deepEqual(both, {
      srt: { read: [], write: [PONG] },
      own: [{ path: npm, deny: null, guard: false, grant: GrantAccess.Read }],
    });
  });

  it("denies a path where it really is, its spelling and links worked out", () => {
    const linked = at(".codex");
    const realpath = (p: string) => (p === linked ? "D:\\dotfiles\\codex" : path.win32.resolve(p));
    const routes = routeWindowsDenies(
      { read: [linked, at("AppData", "..", ".aws")], write: [at(".AWS")] },
      { realpath, exists: () => true },
    );
    assert.deepEqual(routes.srt, { read: [], write: [] });
    assert.deepEqual(routes.own, [
      { path: PROFILE, deny: null, guard: true },
      { path: at(".aws"), deny: DenyAccess.Read, guard: false },
      { path: "D:\\dotfiles", deny: null, guard: true },
      { path: "D:\\dotfiles\\codex", deny: DenyAccess.Read, guard: false },
    ]);
  });

  it("leaves srt-win only what it must make, or what has no folder to guard", () => {
    const table: Array<[string, string]> = [
      ["a path that does not exist yet (srt-win makes its placeholder)", NEVER_MADE],
      ["a drive root", "D:\\"],
      ["a network share", "\\\\nas\\keys\\deploy.pem"],
    ];
    for (const [label, denied] of table) {
      const routes = routeWindowsDenies({ read: [denied], write: [denied] }, { realpath: (p) => p, exists });
      assert.deepEqual(routes, { srt: { read: [denied], write: [denied] }, own: [] }, label);
    }
  });
});

describe("Genex's own deny entries", () => {
  const SID = "S-1-5-21-1-1002";
  const DEAD_PID = 3;
  const done = (edits: readonly FolderOwnEdit[]) => edits.map(() => ({ ok: true }) as const);
  const shape = (edit: FolderOwnEdit) => [edit.dir, `${edit.deny}`, edit.guard ? "guard" : "-"];
  /** Deny entries for holder `pid` in `holders`, logging every edit as `[pid, dir, deny, guard]`. */
  const holder = (holders: string, pid: number, calls: string[][], options: Partial<OwnAclDeps> = {}) =>
    ownAclEntries(holders, {
      sid: async () => SID,
      pid,
      alive: (other) => other !== DEAD_PID,
      retryDelayMs: 0,
      edit: async (edits) => {
        for (const edit of edits) calls.push([`${pid}`, ...shape(edit)]);
        return done(edits);
      },
      editSync: (edits) => {
        for (const edit of edits) calls.push([`${pid}`, "sync", ...shape(edit)]);
        return done(edits);
      },
      ...options,
    });
  const guard = { path: PROFILE, deny: null, guard: true };
  const ssh = { path: at(".ssh"), deny: DenyAccess.Read, guard: false };
  const assistant = {
    path: at("AppData", "Local", "Roblox", "AssistantSettings"),
    deny: DenyAccess.Write,
    guard: false,
  };

  it("says why Genex cannot set its own entries: no sandbox users' group, or PowerShell refused the batch", async () => {
    // Issue #476: the log said "no sandbox users' group, or PowerShell could not set them", and a
    // report could not tell an install to repair from a PowerShell an antivirus or policy blocks.
    const logged: string[] = [];
    const log = (line: string) => logged.push(line);
    const noGroup = holder(await tmpDir("windows-denies-"), 1, [], { sid: async () => null, log });
    assert.equal(await noGroup.sync([ssh]), false);
    const refused = holder(await tmpDir("windows-denies-"), 1, [], { edit: async () => null, log });
    assert.equal(await refused.sync([ssh]), false);
    assert.deepEqual(logged, [
      "own entries: the sandbox user is not in the sandbox users' group",
      "own entries: Windows PowerShell could not run Genex's batch (an antivirus or a policy may block it)",
    ]);
  });

  it("records each entry before setting it, and takes back what is no longer needed", async () => {
    const holders = await tmpDir("windows-denies-");
    const record = path.join(holders, "1.json");
    const calls: string[][] = [];
    const denies = holder(holders, 1, calls, {
      edit: async (edits) => {
        for (const edit of edits) {
          if (edit.deny || edit.guard) {
            const recorded = JSON.parse(await readFile(record, "utf8")) as { entries: OwnAclEntry[] };
            assert.ok(
              recorded.entries.some((entry) => entry.path === edit.dir),
              "recorded before set",
            );
          }
          assert.equal(edit.sid, SID);
          calls.push(shape(edit));
        }
        return done(edits);
      },
    });
    assert.equal(await denies.sync([guard, ssh]), true);
    assert.equal(await denies.sync([guard, assistant]), true);
    assert.deepEqual(calls, [
      [PROFILE, "null", "guard"],
      [at(".ssh"), "read", "-"],
      [PROFILE, "null", "guard"],
      [assistant.path, "write", "-"],
      [at(".ssh"), "null", "-"],
    ]);
    calls.length = 0;
    await denies.revokeAll();
    assert.deepEqual(calls, [
      [PROFILE, "null", "-"],
      [assistant.path, "null", "-"],
    ]);
    assert.equal(existsSync(record), false, "the record goes once everything is taken back");
  });

  it("sets each path to what every running Genex needs (a dev profile beside the app)", async () => {
    const holders = await tmpDir("windows-denies-");
    const calls: string[][] = [];
    const app = holder(holders, 1, calls);
    const dev = holder(holders, 2, calls);
    await app.sync([guard, ssh]);
    await dev.sync([{ ...ssh, deny: DenyAccess.Write }]);
    await app.sync([]);
    dev.revokeAllSync();
    app.revokeAllSync();
    assert.deepEqual(calls, [
      ["1", PROFILE, "null", "guard"],
      ["1", at(".ssh"), "read", "-"],
      ["2", at(".ssh"), "read", "-"],
      ["1", PROFILE, "null", "-"],
      ["1", at(".ssh"), "write", "-"],
      ["2", "sync", at(".ssh"), "null", "-"],
    ]);
    assert.deepEqual(await readdir(holders), [], "every record is gone");
  });

  it("takes back what a Genex that crashed left set, except what a running one needs", async () => {
    const holders = await tmpDir("windows-denies-");
    const crashed = { sid: SID, entries: [ssh, { path: at("Videos", "x"), deny: DenyAccess.Read, guard: false }] };
    await writeFile(path.join(holders, `${DEAD_PID}.json`), JSON.stringify(crashed));
    await writeFile(path.join(holders, "notes.txt"), "not a record");
    const calls: string[][] = [];
    await holder(holders, 1, calls).sync([ssh]);
    assert.deepEqual(calls, [
      ["1", at(".ssh"), "read", "-"],
      ["1", at("Videos", "x"), "null", "-"],
    ]);
    assert.deepEqual((await readdir(holders)).sort(), ["1.json", "notes.txt"]);
  });

  it("answers false without the sandbox users' group, or where PowerShell cannot set the entries", async () => {
    const holders = await tmpDir("windows-denies-");
    const calls: string[][] = [];
    assert.equal(await holder(holders, 1, calls, { sid: async () => null }).sync([ssh]), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(holders), [], "nothing recorded without a group");
    const locked = holder(holders, 2, calls, { edit: async () => null });
    assert.equal(await locked.sync([ssh]), false);
    // A batch PowerShell gave up on part way may have set some entries: the record keeps them.
    assert.deepEqual(await readdir(holders), ["2.json"]);
  });

  it("leaves the walk under a path for later where the editor may, and passes it down later, once", async () => {
    // A lived-in Windows 11 profile: passing the deny down Chrome's profile took 17 s of a first
    // start, although nothing in it was open to the sandbox user.
    const holders = await tmpDir("windows-denies-");
    const asked: FolderOwnEdit[][] = [];
    const denies = holder(holders, 1, [], {
      edit: async (edits) => {
        asked.push([...edits]);
        return edits.map((edit) =>
          edit.dir === ssh.path && edit.walk === OwnWalk.Later
            ? ({ ok: true, deferred: true } as const)
            : ({ ok: true } as const),
        );
      },
    });
    assert.equal(await denies.sync([guard, ssh]), true);
    assert.deepEqual(
      asked[0]?.map((edit) => edit.walk),
      [OwnWalk.Later, OwnWalk.Later],
      "every edit of a start may leave its walk for later",
    );
    await denies.walkDeferred();
    assert.deepEqual(
      asked[1]?.map((edit) => [edit.dir, edit.deny, edit.walk]),
      [[ssh.path, DenyAccess.Read, OwnWalk.Again]],
      "only the deferred path is walked, with the entries it needs",
    );
    await denies.walkDeferred();
    assert.equal(asked.length, 2, "a walk that ran is not run again");
  });

  it("keeps a walk a Genex that ended never ran, and runs it in the next one", async () => {
    const holders = await tmpDir("windows-denies-");
    const ended = { sid: SID, entries: [ssh], walks: [ssh.path] };
    await writeFile(path.join(holders, `${DEAD_PID}.json`), JSON.stringify(ended));
    const asked: FolderOwnEdit[][] = [];
    const next = holder(holders, 1, [], {
      edit: async (edits) => {
        asked.push([...edits]);
        return done(edits);
      },
    });
    assert.equal(await next.sync([ssh]), true);
    await next.walkDeferred();
    assert.deepEqual(
      asked.at(-1)?.map((edit) => [edit.dir, edit.walk]),
      [[ssh.path, OwnWalk.Again]],
    );
    assert.deepEqual(await readdir(holders), ["1.json"], "the ended Genex's record is gone, its walk carried over");
  });

  it("drops a deferred walk on a path no longer needed", async () => {
    const holders = await tmpDir("windows-denies-");
    const asked: FolderOwnEdit[][] = [];
    const denies = holder(holders, 1, [], {
      edit: async (edits) => {
        asked.push([...edits]);
        return edits.map((edit) =>
          edit.dir === ssh.path ? ({ ok: true, deferred: true } as const) : ({ ok: true } as const),
        );
      },
    });
    await denies.sync([ssh]);
    await denies.sync([guard]);
    const batches = asked.length;
    await denies.walkDeferred();
    assert.equal(asked.length, batches, "nothing left to walk");
  });

  it("tries again only the entries refused once, and lets a take-back on a path that is gone go", async () => {
    const holders = await tmpDir("windows-denies-");
    const batches: string[][] = [];
    let refusals = 1;
    const flaky: FolderOwnEditor = async (edits) => {
      batches.push(edits.map((edit) => edit.dir));
      return edits.map((edit) =>
        edit.dir === at(".ssh") && refusals-- > 0 ? { ok: false, error: "being changed" } : { ok: true },
      );
    };
    const denies = holder(holders, 1, [], { edit: flaky });
    await denies.sync([guard, ssh]);
    assert.deepEqual(batches, [[PROFILE, at(".ssh")], [at(".ssh")]]);
    const gone: FolderOwnEditor = async (edits) =>
      edits.map((edit) => (edit.deny || edit.guard ? { ok: true } : { ok: false, error: "cannot find the file" }));
    assert.equal(await holder(holders, 1, [], { edit: gone }).sync([]), true);
    const broken: FolderOwnEditor = async (edits) => edits.map(() => ({ ok: false, error: "Access is denied." }));
    await assert.rejects(
      holder(holders, 2, [], { edit: broken }).sync([ssh]),
      /could not set the sandbox user's entries on .*\\\.ssh: Access is denied\./,
    );
  });

  it("stops at a batch that ran out of time, keeping what it set for the next try", async () => {
    const holders = await tmpDir("windows-denies-");
    let batches = 0;
    const slow: FolderOwnEditor = async (edits) => {
      batches++;
      return edits.map(
        () => ({ ok: false, error: "still passing the entries down after 600 s", timedOut: true }) as const,
      );
    };
    await assert.rejects(
      holder(holders, 1, [], { edit: slow }).sync([guard, ssh]),
      /could not set the sandbox user's entries on .*: still passing the entries down/,
    );
    assert.equal(batches, 1, "a batch that ran out of time is not run again at once");
    const recorded = JSON.parse(await readFile(path.join(holders, "1.json"), "utf8")) as { entries: OwnAclEntry[] };
    assert.deepEqual(recorded.entries, [guard, ssh], "what it may have set stays recorded");
  });

  describe("grants the start does not wait for in full", () => {
    const install = at("AppData", "Local", "genex", "app-0.1.15");
    const conda = at("anaconda3");
    const npm = at("AppData", "Roaming", "npm");
    const game = at("AI Games", "Pong");
    const BUDGET_MS = 30_000;
    const WALK_MS = 3_600_000;
    const STILL_ON = "Windows was still passing the entries down after 30 s";
    const grantOf = (dir: string, grant: GrantAccess = GrantAccess.Read): OwnAclEntry => ({
      path: dir,
      deny: null,
      guard: false,
      grant,
    });
    type Asked = { dirs: string[]; walk: string[]; timeoutMs: number | undefined; walks: string[] };
    /** Windows over a batch: each edit answers `answer` within the budget, done otherwise; every batch logged with the record's walks then. */
    const windows =
      (holders: string, asked: Asked[], answer: (dir: string) => FolderAceOutcome): FolderOwnEditor =>
      async (edits, run) => {
        const record = JSON.parse(await readFile(path.join(holders, "1.json"), "utf8")) as { walks?: string[] };
        asked.push({
          dirs: edits.map((edit) => edit.dir),
          walk: edits.map((edit) => `${edit.walk}`),
          timeoutMs: run?.timeoutMs,
          walks: record.walks ?? [],
        });
        return edits.map((edit) => (run?.timeoutMs === BUDGET_MS ? answer(edit.dir) : { ok: true }));
      };
    const budgeted = (holders: string, edit: FolderOwnEditor, logged: string[] = []) =>
      holder(holders, 1, [], {
        edit,
        urgent: (dir) => dir === install,
        grantBudgetMs: BUDGET_MS,
        walkTimeoutMs: WALK_MS,
        log: (line) => logged.push(line),
      });

    it("waits for denies, write grants and urgent grants in full, for read grants only within a budget", async () => {
      // A first grant on a large folder can pass its entries down for longer than any start should
      // wait, and nothing of the agents may wait on it meanwhile.
      const holders = await tmpDir("windows-denies-");
      const asked: Asked[] = [];
      const logged: string[] = [];
      const timedOut = (dir: string): FolderAceOutcome =>
        dir === conda
          ? { ok: false, error: STILL_ON, timedOut: true }
          : { ok: false, error: "not reached: the batch ran out of time after 30 s", timedOut: true };
      const own = budgeted(holders, windows(holders, asked, timedOut), logged);
      const entries = [guard, ssh, grantOf(install), grantOf(game, GrantAccess.Modify), grantOf(conda), grantOf(npm)];
      assert.equal(await own.sync(entries), true, "the start goes on");
      assert.deepEqual(
        asked.map(({ dirs, timeoutMs }) => ({ dirs, timeoutMs })),
        [
          { dirs: [PROFILE, at(".ssh"), game, install], timeoutMs: undefined },
          { dirs: [conda, npm], timeoutMs: BUDGET_MS },
        ],
        "the folder the agents work in, as the ones the start needs, is set in full",
      );
      assert.deepEqual(asked[1]?.walks, [conda, npm], "recorded to walk before the budget runs: a crash keeps them");
      assert.deepEqual(own.walks(), [conda, npm], "both are passed down after the start");
      assert.deepEqual(logged, [
        `own entries: ${conda} is passed down after the start (${STILL_ON})`,
        `own entries: ${npm} is passed down after the start (not reached: the batch ran out of time after 30 s)`,
      ]);
      await own.walkDeferred();
      assert.deepEqual(asked.at(-1)?.dirs, [conda, npm]);
      assert.deepEqual(asked.at(-1)?.walk, [OwnWalk.Again, OwnWalk.Again]);
      assert.equal(asked.at(-1)?.timeoutMs, WALK_MS);
      assert.deepEqual(own.walks(), [], "passed down once the start was past");
    });

    it("leaves nothing to walk for a grant the budget finished", async () => {
      const holders = await tmpDir("windows-denies-");
      const own = budgeted(
        holders,
        windows(holders, [], () => ({ ok: true, ms: 40 })),
      );
      assert.equal(await own.sync([guard, grantOf(conda)]), true);
      assert.deepEqual(own.walks(), []);
    });

    it("sets in full a write grant narrowed to reading, which a stopped walk would leave writable", async () => {
      const holders = await tmpDir("windows-denies-");
      const asked: Asked[] = [];
      const own = budgeted(
        holders,
        windows(holders, asked, () => ({ ok: false, error: STILL_ON, timedOut: true })),
      );
      assert.equal(await own.sync([guard, grantOf(conda, GrantAccess.Modify)]), true);
      asked.length = 0;
      assert.equal(await own.sync([guard, grantOf(conda)]), true);
      assert.deepEqual(
        asked.map(({ dirs, timeoutMs }) => ({ dirs, timeoutMs })),
        [{ dirs: [PROFILE, conda], timeoutMs: undefined }],
      );
      assert.deepEqual(own.walks(), []);
    });

    it("tries a grant Windows refused within the budget again in full, and fails the start if it still refuses", async () => {
      const holders = await tmpDir("windows-denies-");
      const asked: Asked[] = [];
      let refusals = 1;
      const flaky = windows(holders, asked, () => ({ ok: false, error: "being changed" }));
      const once: FolderOwnEditor = async (edits, run) => {
        const outcomes = (await flaky(edits, run)) ?? [];
        if (run?.timeoutMs === BUDGET_MS) return outcomes;
        return edits.map((edit) =>
          edit.dir === npm && refusals-- > 0 ? { ok: false, error: "being changed" } : { ok: true },
        );
      };
      assert.equal(await budgeted(holders, once).sync([guard, grantOf(npm)]), true);
      assert.deepEqual(
        asked.map(({ dirs, timeoutMs }) => ({ dirs, timeoutMs })),
        [
          { dirs: [PROFILE], timeoutMs: undefined },
          { dirs: [npm], timeoutMs: BUDGET_MS },
          { dirs: [npm], timeoutMs: undefined },
          { dirs: [npm], timeoutMs: undefined },
        ],
        "refused within the budget, then once in full, then done",
      );
      const broken = await tmpDir("windows-denies-");
      const refusing: FolderOwnEditor = async (edits, run) =>
        edits.map((edit) =>
          edit.dir === npm || run?.timeoutMs === BUDGET_MS ? { ok: false, error: "Access is denied." } : { ok: true },
        );
      await assert.rejects(
        budgeted(broken, refusing).sync([guard, grantOf(npm)]),
        /could not set the sandbox user's entries on .*\\npm: Access is denied\./,
        "never left to a walk that would refuse it at every start",
      );
    });

    it("keeps a grant a sync took back while the walk set it again, so the next sync takes it back", async () => {
      const holders = await tmpDir("windows-denies-");
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let walking = false;
      const asked: Asked[] = [];
      const timed = windows(holders, asked, () => ({ ok: false, error: STILL_ON, timedOut: true }));
      const edit: FolderOwnEditor = async (edits, run) => {
        if (run?.timeoutMs === WALK_MS && !walking) {
          walking = true;
          await held;
        }
        return timed(edits, run);
      };
      const own = budgeted(holders, edit);
      await own.sync([guard, grantOf(conda)]);
      const walked = own.walkDeferred();
      await turn();
      await own.sync([guard]);
      release();
      await walked;
      const recorded = JSON.parse(await readFile(path.join(holders, "1.json"), "utf8")) as { entries: OwnAclEntry[] };
      assert.deepEqual(recorded.entries, [guard, grantOf(conda)], "the walk's grant stays recorded");
      asked.length = 0;
      await own.sync([guard]);
      assert.ok(
        asked.some((batch) => batch.dirs.includes(conda)),
        "and the next sync takes it back",
      );
    });

    it("says what it walks when it reads it, and stops when told", async () => {
      const holders = await tmpDir("windows-denies-");
      const signals: Array<AbortSignal | undefined> = [];
      const timed = windows(holders, [], () => ({ ok: false, error: STILL_ON, timedOut: true }));
      const own = budgeted(holders, async (edits, run) => {
        if (run?.timeoutMs === WALK_MS) {
          signals.push(run.signal);
          return null;
        }
        return timed(edits, run);
      });
      await own.sync([guard, grantOf(conda)]);
      const said: string[][] = [];
      const quitting = new AbortController();
      await own.walkDeferred({ signal: quitting.signal, walking: (paths) => said.push(paths) });
      assert.deepEqual(said, [[conda]]);
      assert.equal(signals[0], quitting.signal);
      assert.deepEqual(own.walks(), [conda], "a walk stopped part way stays to walk");
    });
  });

  it("says which edits Windows took long over: a first walk of a large folder", async () => {
    const logged: string[] = [];
    const timed: FolderOwnEditor = async (edits) =>
      edits.map((edit) => ({ ok: true, ms: edit.dir === at(".ssh") ? 41_000 : 30 }) as const);
    await holder(await tmpDir("windows-denies-"), 1, [], { edit: timed, log: (line) => logged.push(line) }).sync([
      guard,
      ssh,
    ]);
    assert.deepEqual(logged, [`own entries: ${at(".ssh")} took 41 s (once; they stay)`]);
  });

  it("goes on past a deny Windows refused where none was needed, says so, and tries it again next start", async () => {
    // The script answers so only where the sandbox user can open nothing at or under the path.
    const holders = await tmpDir("windows-denies-");
    const logged: string[] = [];
    const asked: FolderOwnEdit[][] = [];
    const refused: FolderOwnEditor = async (edits) => {
      asked.push([...edits]);
      return edits.map((edit) =>
        edit.deny ? ({ ok: true, refused: "Access is denied." } as const) : ({ ok: true } as const),
      );
    };
    const denies = holder(holders, 1, [], { edit: refused, log: (line) => logged.push(line) });
    assert.equal(await denies.sync([guard, ssh]), true);
    assert.deepEqual(logged, [
      `own entries: left ${at(".ssh")} as it is: Windows refused the deny (Access is denied.), and the sandbox user can open nothing in it`,
    ]);
    await denies.walkDeferred();
    assert.equal(asked.length, 1, "no walk is left for later");
    assert.equal(await denies.sync([guard, ssh]), true);
    assert.ok(
      asked[1]?.some((edit) => edit.dir === ssh.path && edit.deny === DenyAccess.Read),
      "the next start asks for the deny again",
    );
  });

  it("lets a later walk Windows refused where none was needed go, and says so", async () => {
    const holders = await tmpDir("windows-denies-");
    const logged: string[] = [];
    const asked: FolderOwnEdit[][] = [];
    const denies = holder(holders, 1, [], {
      log: (line) => logged.push(line),
      edit: async (edits) => {
        asked.push([...edits]);
        return edits.map((edit) => {
          if (edit.dir !== ssh.path) return { ok: true } as const;
          return edit.walk === OwnWalk.Later
            ? ({ ok: true, deferred: true } as const)
            : ({ ok: true, refused: "Access is denied." } as const);
        });
      },
    });
    assert.equal(await denies.sync([guard, ssh]), true);
    await denies.walkDeferred();
    assert.match(logged.join("\n"), /left .*\.ssh as it is: Windows refused the deny/);
    await denies.walkDeferred();
    assert.equal(asked.length, 2, "the walk is not tried again by this Genex");
  });

  it("touches the group's passed-down allows only on a folder Genex grants or once granted", async () => {
    // A deny or a guard on a folder must leave an allow there that Genex did not set (an admin's,
    // or the grant on the folder above a denied one) exactly as it is.
    const holders = await tmpDir("windows-denies-");
    const seen: FolderOwnEdit[] = [];
    const recording: FolderOwnEditor = async (edits) => {
      seen.push(...edits);
      return edits.map(() => ({ ok: true }) as const);
    };
    const denies = holder(holders, 1, [], { edit: recording });
    const game = { path: at("AI Games"), deny: null, guard: false, grant: GrantAccess.Modify };
    await denies.sync([guard, ssh, game]);
    const allows = (dir: string) => seen.filter((edit) => edit.dir === dir).map((edit) => edit.allows);
    assert.deepEqual(allows(PROFILE), [false], "a guard leaves the folder's allows alone");
    assert.deepEqual(allows(at(".ssh")), [false], "so does a deny");
    assert.deepEqual(allows(at("AI Games")), [true]);
    seen.length = 0;
    await denies.sync([guard, ssh]);
    const takenBack = seen.find((edit) => edit.dir === at("AI Games"));
    assert.deepEqual(takenBack && [takenBack.allows, takenBack.grant], [true, null], "a grant Genex set goes");
  });

  it("runs nothing when it has nothing to set and nothing to take back", async () => {
    let runs = 0;
    const denies = holder(await tmpDir("windows-denies-"), 1, [], {
      edit: async (edits) => {
        runs++;
        return done(edits);
      },
    });
    assert.equal(await denies.sync([]), true);
    await denies.revokeAll();
    assert.equal(runs, 0);
  });

  it("leaves an uninstall every recorded entry to take back, except what a running Genex needs", async () => {
    const local = await tmpDir("windows-uninstall-");
    const holders = { above: path.join(local, "genex-sandbox-grants"), own: path.join(local, "genex-sandbox-denies") };
    await mkdir(holders.own, { recursive: true });
    await mkdir(holders.above, { recursive: true });
    const game = { path: at("AI Games"), deny: null, guard: false, grant: GrantAccess.Modify };
    await writeFile(path.join(holders.own, `${DEAD_PID}.json`), JSON.stringify({ sid: SID, entries: [game, ssh] }));
    await writeFile(path.join(holders.own, "7.json"), JSON.stringify({ sid: SID, entries: [ssh] }));
    await writeFile(path.join(holders.above, `${DEAD_PID}.json`), JSON.stringify({ sid: SID, dirs: [at("AppData")] }));
    const alive = (pid: number) => pid === 7;
    const edits = sandboxEntriesLeft(holders, alive);
    assert.deepEqual(edits, [
      { dir: at("AppData"), sid: SID, op: FolderAceOp.Remove },
      { dir: at("AI Games"), sid: SID, op: FolderAceOp.Own, deny: null, guard: false, grant: null, allows: true },
      {
        dir: at(".ssh"),
        sid: SID,
        op: FolderAceOp.Own,
        deny: DenyAccess.Read,
        guard: false,
        grant: null,
        allows: false,
      },
    ]);
    const started: Array<{ file: string; env: NodeJS.ProcessEnv }> = [];
    const spawnBatch = (file: string, _args: string[], env: NodeJS.ProcessEnv) => {
      started.push({ file, env });
      return { unref: () => {} };
    };
    assert.equal(takeBackSandboxEntries(spawnBatch, PROFILE, { SystemRoot: "C:\\Windows" }, { holders, alive }), 3);
    assert.equal(started.length, 1, "one PowerShell batch, left to run after the uninstall launch exits");
    const payload = JSON.parse(Buffer.from(started[0]?.env.GENEX_FOLDER_ACES ?? "", "base64").toString("utf8"));
    assert.deepEqual(payload, edits);
    const none = await tmpDir("windows-uninstall-empty-");
    const empty = { above: path.join(none, "a"), own: path.join(none, "b") };
    assert.equal(
      takeBackSandboxEntries(() => assert.fail("nothing to take back"), PROFILE, {}, { holders: empty }),
      0,
    );
  });

  it("has srt-win forget the write grants it keeps, from a copy outside the folder Squirrel removes", async () => {
    const install = await tmpDir("windows-uninstall-srt-");
    const temp = await tmpDir("windows-uninstall-tmp-");
    const exe = path.join(install, "srt-win.exe");
    await writeFile(exe, "srt-win");
    await writeFile(path.join(install, "vcruntime140.dll"), "vc");
    await writeFile(path.join(install, "notes.txt"), "not a program");
    const started: Array<{ file: string; args: string[] }> = [];
    const spawnBatch = (file: string, args: string[]) => {
      started.push({ file, args });
      return { unref: () => {} };
    };
    assert.equal(forgetKeptGrants(spawnBatch, exe, temp), true);
    const [run] = started;
    assert.ok(run, "one srt-win, left to run after the uninstall launch exits");
    assert.deepEqual(run.args, ["--srt-win", "acl", "forget", "--all"]);
    assert.ok(insideWindowsPath(temp, run.file) || run.file.startsWith(temp), run.file);
    assert.equal(path.basename(run.file), "srt-win.exe");
    const copied = await readdir(path.dirname(run.file));
    assert.deepEqual(copied.sort(), ["srt-win.exe", "vcruntime140.dll"], "the program and the runtime it loads");
    // A build without srt-win (or one Windows will not let it copy) starts nothing, and never throws.
    started.length = 0;
    assert.equal(forgetKeptGrants(spawnBatch, path.join(install, "gone.exe"), temp), false);
    assert.deepEqual(started, []);
  });

  it("records under %LOCALAPPDATA%, beside the folder grants", () => {
    assert.equal(windowsDenyHolders(PROFILE, at("AppData", "Local")), at("AppData", "Local", "genex-sandbox-denies"));
    assert.equal(windowsDenyHolders(PROFILE, ""), at("AppData", "Local", "genex-sandbox-denies"));
  });
});

// ── ProcessSandbox's Windows launch, through a fake runtime ─────────────────────────────────

interface WrapCall {
  command: string;
  binShell: unknown;
  config: SandboxRuntimeConfig | undefined;
  cwd: string | undefined;
}

async function windowsSandbox(
  options: {
    wrapError?: object;
    initializeError?: object;
    bash?: string | null;
    setupGaps?: () => Promise<WindowsSetupGap[]>;
    startInBackground?: boolean;
    /** Hold srt's initialize until the returned open is called. */
    holdInitialize?: boolean;
    failInitializeIn?: { subcommand: string; code: string };
    /** Genex sets the denies outside the grants itself. */
    ownDenies?: boolean;
  } = {},
) {
  const root = realpathSync.native(await tmpDir("windows-launch-"));
  const workspace = path.join(root, "workspace");
  const secrets = path.join(root, "secrets");
  await mkdir(secrets, { recursive: true });
  const bash = options.bash === undefined ? await testBash() : options.bash;
  const wraps: WrapCall[] = [];
  const s = session({ realDenies: true, profile: root, ...(options.ownDenies ? { ownDenies: true } : {}) });
  const openInitialize = options.holdInitialize ? s.runtime.hold() : () => {};
  if (options.failInitializeIn)
    s.runtime.failInitializeIn(options.failInitializeIn.subcommand, options.failInitializeIn.code);
  if (options.initializeError) {
    const error = options.initializeError;
    s.runtime.runtime.initialize = async () => {
      throw error;
    };
  }
  const runtime = {
    isSupportedPlatform: () => true,
    checkDependencies: () => {
      throw new Error("the Windows backend never runs srt's dependency probes");
    },
    ...s.runtime.runtime,
    wrapWithSandboxArgv: (async (
      command: string,
      binShell: unknown,
      config?: SandboxRuntimeConfig,
      _signal?: AbortSignal,
      cwd?: string,
    ) => {
      wraps.push({ command, binShell, config, cwd });
      if (options.wrapError) throw options.wrapError;
      // As srt-win does, the command's stdin is never the pipe the host writes to.
      return { argv: [bash, "-c", `exec 0</dev/null; ${command}`], env: process.env };
    }) as SandboxRuntime["wrapWithSandboxArgv"],
    annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
  } as unknown as SandboxRuntime;
  const sandbox = await ProcessSandbox.create({
    writableRoots: [workspace],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [secrets, path.join(root, "never-created")],
    runtime,
    platform: "win32",
    windows: { bash, session: s.session, profile: root, setupGaps: options.setupGaps },
    toolPath: async () => "",
    ...(options.startInBackground ? { startInBackground: true } : {}),
  });
  return { sandbox, root, workspace, secrets, wraps, session: s, openInitialize };
}

describe("ProcessSandbox on Windows", () => {
  it("runs under Git Bash with the caller's environment from an env file it deletes first", async () => {
    const w = await windowsSandbox();
    const hostile = "it's $(echo ran) `echo ran`";
    const result = await w.sandbox.run({
      command: 'printf "%s|%s|%s|%s" "$PROBE" "$GIT_TERMINAL_PROMPT" "$MSYS_NO_PATHCONV" "$TMPDIR"',
      cwd: w.workspace,
      env: { PROBE: hostile },
    });
    assert.equal(result.code, 0, result.stderr);
    const scratch = w.sandbox.scratchDir.replaceAll("\\", "/");
    assert.equal(result.stdout, `${hostile}|0|1|${scratch}`);
    assert.equal(w.wraps[0]?.binShell, await testBash());
    const leftovers = (await readdir(w.sandbox.scratchDir)).filter((name) => name.startsWith(".env-"));
    assert.deepEqual(leftovers, [], "the env file is gone once the command has read it");
    const curlrc = await readFile(path.join(w.sandbox.scratchDir, ".curl", ".curlrc"), "utf8");
    assert.match(curlrc, /ssl-revoke-best-effort/);
    assert.equal(w.session.session.active, 0, "the run gave the session back");
  });

  it("keeps loopback closed, as the install Genex makes does, even for a run that asks for a local server", async () => {
    // srt-win refuses a session or a command whose loopback mode is not the installed one, and
    // Genex installs without --allow-loopback: commands reach the sandbox's proxies only.
    const w = await windowsSandbox();
    assert.equal(w.sandbox.policy.allowLocalBinding, true, "the policy still says what macOS and Linux open");
    const result = await w.sandbox.run({ command: "true", cwd: w.workspace, policy: { allowLocalBinding: true } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(w.session.runtime.last().network.allowLocalBinding, false, "the session");
    assert.equal(w.wraps[0]?.config?.network.allowLocalBinding, false, "the command");
  });

  it("feeds a run's stdin from a file the command opens and deletes, since srt-win does not pass it", async () => {
    const w = await windowsSandbox();
    const result = await w.sandbox.run({
      command: "cat; printf '|%s' \"$PROBE\"",
      cwd: w.workspace,
      stdin: "from-the-host\n",
      env: { PROBE: "p" },
    });
    assert.equal(result.stdout, "from-the-host\n|p", result.stderr);
    const leftovers = (await readdir(w.sandbox.scratchDir)).filter(
      (name) => name.startsWith(".stdin-") || name.startsWith(".env-"),
    );
    assert.deepEqual(leftovers, []);
  });

  it("sends a run's stdin only through the file, never down the pipe the command swaps away", async () => {
    // The command replaces its stdin with the file before reading any: input written down the
    // pipe as well would meet a closed reader (EPIPE), and this much input always outlasts it.
    const w = await windowsSandbox();
    const result = await w.sandbox.run({
      command: "wc -c",
      cwd: w.workspace,
      stdin: "x".repeat(PIPE_OVERFLOW_BYTES),
    });
    assert.equal(result.stdout.trim(), String(PIPE_OVERFLOW_BYTES), result.stderr);
  });

  it("delivers OpenCode's brief through the stdin file, so the CLI has a message to run", async () => {
    // Issue #303: the brief written down the pipe never reached `opencode run`, which failed
    // every build turn with "You must provide a message".
    const w = await windowsSandbox();
    const brief = "Write hello to out.txt\nit's $(echo ran)";
    // A stand-in CLI: Node, printing the whole of its stdin as one event.
    const cli = path.join(w.root, "cli.cjs");
    await writeFile(
      cli,
      'process.stdout.write(JSON.stringify({ brief: require("node:fs").readFileSync(0, "utf8") }) + "\\n");\n',
    );
    const seen: Array<Record<string, unknown>> = [];
    const invocation = {
      argv: [cli.replaceAll("\\", "/")],
      cwd: w.workspace,
      prompt: brief,
      env: {},
      signal: new AbortController().signal,
      domains: [],
    };
    const node = process.execPath.replaceAll("\\", "/");
    for await (const event of openCodeEvents(w.sandbox, node, invocation)) seen.push(event);
    assert.deepEqual(seen, [{ brief }]);
    const leftovers = (await readdir(w.sandbox.scratchDir)).filter((name) => name.startsWith(".stdin-"));
    assert.deepEqual(leftovers, [], "the stdin file is gone once the CLI has opened it");
    assert.equal(w.session.session.active, 0, "the CLI gave the session back");
  });

  it("drives a Play Protocol game it started, its requests reaching the game through the input relay", async () => {
    // srt-win drops stdin, so a game's requests went nowhere and its hello never answered.
    const w = await windowsSandbox();
    const node = process.execPath.replaceAll("\\", "/");
    const launched = await launchGameBridge({
      sandbox: w.sandbox,
      command: `'${node}' '${FAKE_PLAY_GAME.replaceAll("\\", "/")}'`,
      cwd: w.workspace,
      stopGraceMs: 2_000,
    });
    try {
      assert.equal(launched.target.hello?.protocol, 3);
      assert.match(
        w.wraps[0]?.command ?? "",
        /ELECTRON_RUN_AS_NODE=1; exec .*\.input-relay-/,
        "the relay runs in the game's place",
      );
    } finally {
      await launched.stop();
    }
    const leftovers = (await readdir(w.sandbox.scratchDir)).filter((name) => name.startsWith(".input-relay-"));
    assert.deepEqual(leftovers, [], "the relay's file is gone");
    assert.equal(w.session.session.active, 0, "the game gave the session back");
  });

  it("with the sandbox off (tests only), runs Git Bash with the Windows basics, never /bin/sh", async () => {
    const root = realpathSync.native(await tmpDir("windows-off-"));
    // On macOS and Linux a stand-in for Git Bash that says it ran; on Windows the real one.
    const bash = process.platform === "win32" ? await testBash() : path.join(root, "bash.exe");
    if (process.platform !== "win32")
      await writeFile(bash, '#!/bin/sh\necho via-git-bash\nexec /bin/bash "$@"\n', { mode: 0o755 });
    const sandbox = await ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      enabled: false,
      platform: "win32",
      windows: { bash },
    });
    const saved = process.env.SystemRoot;
    process.env.SystemRoot = saved ?? "C:\\Windows";
    try {
      const result = await sandbox.run({ command: "env", cwd: root });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.sandboxed, false);
      if (process.platform !== "win32") assert.match(result.stdout, /^via-git-bash$/m);
      assert.match(result.stdout, /^MSYS_NO_PATHCONV=1$/m);
      assert.match(result.stdout, /^SystemRoot=/im, "Windows programs need their basics to start");
    } finally {
      if (saved === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved;
    }
  });

  it("denies secrets session-wide, sends no grants per command and no deny path srt-win would create", async () => {
    const w = await windowsSandbox();
    const session = w.session.runtime.last().filesystem;
    assert.ok(session.denyRead.includes(w.secrets), "an existing secret path is denied for the session");
    assert.ok(!session.denyRead.includes(path.join(w.root, "never-created")), "a missing one is not sent");
    assert.ok(!session.denyWrite.includes(w.secrets), "a read-denied path is not write-denied as well");
    await w.sandbox.run({
      command: "true",
      cwd: w.workspace,
      policy: { denyWrite: [path.join(w.workspace, "later"), path.join(w.root, "elsewhere")] },
    });
    const run = w.wraps[0]?.config?.filesystem;
    assert.deepEqual(run?.allowWrite, []);
    assert.deepEqual(run?.allowRead ?? [], []);
    assert.deepEqual(run?.denyRead, [], "the instance's denies are the session's already");
    assert.deepEqual(run?.denyWrite, [path.join(w.workspace, "later")], "only a missing path inside a grant is sent");
    assert.equal(existsSync(path.join(w.root, "never-created")), false);
  });

  it("never stamps per command a path the session already denies itself", async () => {
    // srt-win would stamp it again for that command, walking everything under its parent folder.
    const w = await windowsSandbox({ ownDenies: true });
    const inner = path.join(w.secrets, "token");
    await writeFile(inner, "secret");
    assert.ok(!w.session.runtime.last().filesystem.denyRead.includes(w.secrets), "Genex denies it, not srt-win");
    await w.sandbox.run({
      command: "true",
      cwd: w.workspace,
      policy: { denyRead: [w.secrets, inner], denyWrite: [w.secrets, path.join(w.workspace, "later")] },
    });
    const run = w.wraps[0]?.config?.filesystem;
    assert.deepEqual(run?.denyRead, []);
    assert.deepEqual(run?.denyWrite, [path.join(w.workspace, "later")]);
  });

  it("a spawn that throws gives the session back and leaves no env file", async () => {
    // Node refuses an argument holding NUL synchronously, before any child exists.
    const w = await windowsSandbox();
    await assert.rejects(w.sandbox.run({ command: "true\0", cwd: w.workspace }), /null bytes/);
    await assert.rejects(w.sandbox.spawnLongLived({ command: "true\0", cwd: w.workspace }), /null bytes/);
    assert.equal(w.session.session.active, 0, "a leaked hold would keep every later regrant waiting");
    // The release removes the env file without waiting for it.
    const envFiles = async () => (await readdir(w.sandbox.scratchDir)).filter((name) => name.startsWith(".env-"));
    for (let tick = 0; tick < ENV_FILE_POLLS && (await envFiles()).length > 0; tick++) await delay(POLL_MS);
    assert.deepEqual(await envFiles(), []);
  });

  it("sets the folders above the roots again before a long-lived process, never before a run", async () => {
    // The harness walks every folder from the drive down to its bootstrap before running a line;
    // anything that rewrote one of them since the apply stops it there.
    const w = await windowsSandbox();
    const synced = () => w.session.ancestors.synced.length;
    const before = synced();
    await w.sandbox.run({ command: "true", cwd: w.workspace });
    assert.equal(synced(), before, "a run uses the grants as applied");
    const { child } = await w.sandbox.spawnLongLived({ command: "true", cwd: w.workspace });
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(synced(), before + 1);
    assert.equal(w.session.session.active, 0);
  });

  it("dispose leaves the session, which takes back the instance's grants", async () => {
    const w = await windowsSandbox();
    assert.notEqual(w.session.session.applied, null);
    await w.sandbox.dispose();
    await w.session.session.settled();
    assert.equal(w.session.session.applied, null);
    assert.equal(w.session.runtime.calls.at(-1), "reset");
  });

  it("refuses a per-run write outside the session's grants, and releases everything", async () => {
    const w = await windowsSandbox();
    const outside = path.join(await tmpDir("windows-outside-"), "x");
    const hostile = [outside, path.join(w.workspace, "..", "escape"), `${w.workspace}2`];
    for (const dir of hostile) {
      await assert.rejects(
        w.sandbox.run({ command: "true", cwd: w.workspace, policy: { allowWrite: [dir] } }),
        (error: unknown) => error instanceof SandboxLaunchError && error.code === SandboxLaunchCode.NotGranted,
        dir,
      );
    }
    assert.equal(w.wraps.length, 0, "nothing was wrapped, so nothing started");
    assert.equal(w.session.session.active, 0);
    const leftovers = (await readdir(w.sandbox.scratchDir)).filter((name) => name.startsWith(".env-"));
    assert.deepEqual(leftovers, []);
    const inside = await w.sandbox.run({
      command: "true",
      cwd: w.workspace,
      policy: { allowWrite: [path.join(w.workspace, "sub")] },
    });
    assert.equal(inside.code, 0, "a folder inside a granted root is fine");
  });

  it("maps srt-win's launch errors by code", async () => {
    const tooLong = await windowsSandbox({ wrapError: Object.assign(new Error("argv"), { code: "argv_too_long" }) });
    await assert.rejects(
      tooLong.sandbox.run({ command: "true", cwd: tooLong.workspace }),
      (error: unknown) => error instanceof SandboxLaunchError && error.code === SandboxLaunchCode.ArgvTooLong,
    );
    assert.equal(tooLong.session.session.active, 0);

    const w = await windowsSandbox();
    const mapped = `printf '%s\\n' '{"code":"mapped_drive_cwd","message":"Z:"}' >&2; exit 16`;
    await assert.rejects(
      w.sandbox.run({ command: mapped, cwd: w.workspace }),
      (error: unknown) => error instanceof SandboxLaunchError && error.code === SandboxLaunchCode.NetworkDrive,
    );
    const ownExit = await w.sandbox.run({ command: "exit 16", cwd: w.workspace });
    assert.equal(ownExit.code, 16, "a command's own exit 16 stays its result");
  });

  it("a folder opened later reaches the grants through one regrant", async () => {
    const w = await windowsSandbox();
    const later = path.join(realpathSync.native(await tmpDir("windows-later-")), "Pong");
    await mkdir(later);
    w.sandbox.allowWrite(later);
    await w.session.session.settled();
    assert.equal(w.session.session.regrants, 1);
    assert.ok(
      entryPaths(w.session.runtime.last().filesystem.allowWrite).some(
        (dir) => dir.toLowerCase() === path.win32.resolve(later).toLowerCase(),
      ),
    );
  });

  it("an unprovisioned sandbox and a missing Git for Windows are both the setup screen", async () => {
    await assert.rejects(
      windowsSandbox({ initializeError: Object.assign(new Error("user missing"), { code: "not_provisioned" }) }),
      (error: unknown) =>
        error instanceof SandboxUnavailableError && error.problem.code === SandboxProblemCode.NotProvisioned,
    );
    await assert.rejects(windowsSandbox({ bash: null }), (error: unknown) => {
      if (!(error instanceof SandboxUnavailableError)) return false;
      assert.equal(error.problem.code, SandboxProblemCode.GitMissing);
      assert.equal(error.problem.platform, "win32");
      return true;
    });
  });

  it("an unprovisioned PC is the setup screen when initialize refuses it untyped, by srt's own dependency check", async () => {
    // sandbox-runtime runs its dependency check first in initialize and throws a plain Error on
    // it; only a check of its own, asked after, says the sandbox user or its filters are missing.
    const unprovisioned = "Sandbox user is not provisioned (user=false, cred=false).";
    await assert.rejects(
      windowsSandbox({
        initializeError: new Error(`Sandbox dependencies not available: ${unprovisioned}`),
        setupGaps: async () => [{ need: WindowsSetupNeed.Sandbox, detail: unprovisioned }],
      }),
      (error: unknown) => {
        if (!(error instanceof SandboxUnavailableError)) return false;
        assert.equal(error.problem.code, SandboxProblemCode.NotProvisioned);
        assert.deepEqual(error.problem.details, [unprovisioned]);
        return true;
      },
    );
    // A failure the check does not explain, or a check that fails itself, stays the error it was.
    for (const setupGaps of [async () => [], async () => Promise.reject(new Error("srt-win missing"))]) {
      await assert.rejects(
        windowsSandbox({ initializeError: new Error("proxy port in use"), setupGaps }),
        (error: unknown) => !(error instanceof SandboxUnavailableError) && /proxy port in use/.test(String(error)),
      );
    }
  });
});

describe("ProcessSandbox on Windows, started in the background", () => {
  it("lets the core await sandbox readiness before trying to boot or recover the harness", async () => {
    const w = await windowsSandbox({ startInBackground: true, holdInitialize: true });
    let ready = false;
    const waiting = w.sandbox.ensureReady().then(() => {
      ready = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(ready, false, "the initialization in flight still owns readiness");
    } finally {
      w.openInitialize();
      await waiting;
      await w.sandbox.dispose();
    }
    assert.equal(ready, true);
  });

  it("reports a failed background start through readiness and allows a later explicit retry", async () => {
    const w = await windowsSandbox({
      startInBackground: true,
      holdInitialize: true,
      failInitializeIn: { subcommand: "acl", code: "acl_stamp_failed" },
    });
    const refused = assert.rejects(w.sandbox.ensureReady(), { code: "acl_stamp_failed" });
    w.openInitialize();
    try {
      await refused;
      await w.sandbox.ensureReady();
      assert.equal(w.session.runtime.calls.filter((call) => call === "initialize").length, 2);
    } finally {
      await w.sandbox.dispose();
    }
  });

  const ready = async (): Promise<WindowsSetupGap[]> => [];

  it("is created while srt still initializes, and a run waits for the start", async () => {
    const w = await windowsSandbox({ startInBackground: true, holdInitialize: true, setupGaps: ready });
    let finished = false;
    const run = w.sandbox.run({ command: "printf started", cwd: w.workspace }).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(finished, false, "the run waits for the start");
    assert.deepEqual(w.session.runtime.calls, ["initialize"], "the one start, shared by the run");
    w.openInitialize();
    const result = await run;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "started");
    assert.deepEqual(w.session.runtime.calls, ["initialize"]);
    await w.sandbox.dispose();
  });

  it("still refuses at once what Set up fixes: no sandbox user, no Git for Windows", async () => {
    const unprovisioned = "Sandbox user is not provisioned (user=false, cred=false).";
    await assert.rejects(
      windowsSandbox({
        startInBackground: true,
        setupGaps: async () => [{ need: WindowsSetupNeed.Sandbox, detail: unprovisioned }],
      }),
      (error: unknown) =>
        error instanceof SandboxUnavailableError && error.problem.code === SandboxProblemCode.NotProvisioned,
    );
    await assert.rejects(
      windowsSandbox({ startInBackground: true, bash: null, setupGaps: ready }),
      (error: unknown) =>
        error instanceof SandboxUnavailableError && error.problem.code === SandboxProblemCode.GitMissing,
    );
  });

  it("refuses at once a disabled Secondary Logon service, as a setup screen that names it", async () => {
    const off = "The Secondary Logon service (seclogon) is disabled.";
    await assert.rejects(
      windowsSandbox({
        startInBackground: true,
        setupGaps: async () => [{ need: WindowsSetupNeed.LogonService, detail: off }],
      }),
      (error: unknown) => {
        if (!(error instanceof SandboxUnavailableError)) return false;
        assert.equal(error.problem.code, SandboxProblemCode.NotProvisioned);
        assert.deepEqual(error.problem.windowsNeeds, [WindowsSetupNeed.LogonService]);
        assert.deepEqual(error.problem.details, [off]);
        return true;
      },
    );
  });

  it("a start that failed behind the window is tried again by the next run", async () => {
    const w = await windowsSandbox({
      startInBackground: true,
      setupGaps: ready,
      failInitializeIn: { subcommand: "acl", code: "acl_grant_failed" },
    });
    // The start behind the window fails first; a run that came during it would report that failure.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await w.sandbox.run({ command: "printf again", cwd: w.workspace });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "again");
    assert.deepEqual(w.session.runtime.calls, ["initialize", "initialize"]);
    await w.sandbox.dispose();
  });
});

describe("what is not set up yet", () => {
  const set = { provisioned: true, credPresent: true };
  const on = ServiceStartType.Demand;
  const needs = (gaps: WindowsSetupGap[]) => gaps.map((gap) => gap.need);

  it("names a missing sandbox user or credential, then missing filters, and nothing on a set-up PC", () => {
    const missing = { provisioned: false, credPresent: false };
    assert.equal(setupGaps({ user: missing, wfp: { state: "absent" }, logonService: on }).length, 1);
    const noCred = { provisioned: true, credPresent: false };
    assert.equal(setupGaps({ user: noCred, wfp: { state: "installed" }, logonService: on }).length, 1);
    assert.equal(setupGaps({ user: set, wfp: { state: "absent" }, logonService: on }).length, 1);
    assert.deepEqual(setupGaps({ user: set, wfp: { state: "installed" }, logonService: on }), []);
    // Reading the filters needs an administrator; srt treats it as informational, and so do we.
    assert.deepEqual(setupGaps({ user: set, wfp: { state: "cannot-read" }, logonService: on }), []);
  });

  it("asks for the install again where another release set the sandbox up, and only then", () => {
    const installed = { state: "installed" };
    const by = (markerVersion?: number, setupVersion?: number) => ({
      ...set,
      ...(markerVersion === undefined ? {} : { markerVersion }),
      ...(setupVersion === undefined ? {} : { setupVersion }),
    });
    for (const user of [by(2, 3), by(undefined, 3), by(4, 3)]) {
      assert.deepEqual(needs(setupGaps({ user, wfp: installed, logonService: on })), [WindowsSetupNeed.Reinstall]);
    }
    // This release's own install, or an srt-win that does not say which setup it needs.
    for (const user of [by(3, 3), by(2), set]) {
      assert.deepEqual(setupGaps({ user, wfp: installed, logonService: on }), [], JSON.stringify(user));
    }
    // A sandbox user that is not there is a first install, whatever a stale marker says.
    const missing = { provisioned: false, credPresent: false, markerVersion: 2, setupVersion: 3 };
    assert.deepEqual(needs(setupGaps({ user: missing, wfp: installed, logonService: on })), [WindowsSetupNeed.Sandbox]);
  });

  it("asks for the install again where the sandbox user is not in the sandbox users' group", () => {
    // Issue #476: an install without the group (made by another program's srt-win) turned Genex's
    // own entries off for good, so srt-win walked the profile for every deny at every start.
    const installed = { state: "installed" };
    for (const user of [
      { ...set, inSandboxGroup: false },
      { ...set, groupExists: false, inSandboxGroup: false },
    ]) {
      assert.deepEqual(needs(setupGaps({ user, wfp: installed, logonService: on })), [WindowsSetupNeed.Reinstall]);
    }
    // An srt-win that does not say leaves it as it is.
    assert.deepEqual(setupGaps({ user: { ...set, inSandboxGroup: true }, wfp: installed, logonService: on }), []);
    assert.deepEqual(setupGaps({ user: set, wfp: installed, logonService: on }), []);
  });

  it("names a disabled Secondary Logon service beside whatever else is missing", () => {
    const off = ServiceStartType.Disabled;
    const missing = { provisioned: false, credPresent: false };
    assert.deepEqual(needs(setupGaps({ user: set, wfp: { state: "installed" }, logonService: off })), [
      WindowsSetupNeed.LogonService,
    ]);
    assert.deepEqual(needs(setupGaps({ user: missing, wfp: { state: "absent" }, logonService: off })), [
      WindowsSetupNeed.Sandbox,
      WindowsSetupNeed.LogonService,
    ]);
    // Manual, automatic, or a start type `sc` could not say: Windows starts it when asked, or we cannot tell.
    for (const logonService of [ServiceStartType.Demand, ServiceStartType.Auto, null]) {
      assert.deepEqual(setupGaps({ user: set, wfp: { state: "installed" }, logonService }), [], String(logonService));
    }
  });

  it("asks srt-win and `sc` together; srt-win's failure is the start's own error, an unread service is no gap", async () => {
    const status = async () => ({ user: set, wfp: { state: "installed" } });
    const off = async () => ServiceStartType.Disabled;
    assert.deepEqual(needs(await windowsSetupGaps({ status, logonService: off })), [WindowsSetupNeed.LogonService]);
    const unread = async () => {
      throw new Error("sc.exe: Access is denied");
    };
    assert.deepEqual(await windowsSetupGaps({ status, logonService: unread }), []);
    const failing = async () => {
      throw new Error("srt-win missing");
    };
    await assert.rejects(windowsSetupGaps({ status: failing, logonService: off }), /srt-win missing/);
  });
});

// ── the harness host on Windows ─────────────────────────────────────────────────────────────

/**
 * A stand-in for a sandboxed bootstrap on Windows: stdin never reaches it, so it listens on the
 * inbox port the host put in its environment and takes lines only after the token.
 */
function fakeHarnessChild(env: Record<string, string>, options: { exitsOnShutdown: boolean }) {
  const lines: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kills: [] as Array<string | undefined>,
    lines,
    kill(signal?: string) {
      child.kills.push(signal);
      setImmediate(() => child.emit("exit", null, signal ?? "SIGTERM"));
      return true;
    },
  });
  const inbox = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", (chunk: string) => {
      text += chunk;
      lines.splice(0, lines.length, ...text.split("\n").filter(Boolean));
      const shutdown = lines.slice(1).some((line) => line.includes('"shutdown"'));
      if (shutdown && options.exitsOnShutdown) setImmediate(() => child.emit("exit", 0, null));
    });
  });
  child.once("exit", () => inbox.close());
  inbox.listen(Number(env.HARNESS_INBOX_PORT), "127.0.0.1", () =>
    child.stdout.write(`${JSON.stringify({ kind: "ready", pid: 4242, harnessVersion: "v1" })}\n`),
  );
  return child;
}

async function windowsHost(options: { exitsOnShutdown: boolean; onLog?: (line: string) => void }) {
  const root = await tmpDir("windows-host-");
  const spawned: Array<ReturnType<typeof fakeHarnessChild>> = [];
  const envs: Array<Record<string, string>> = [];
  const sandbox = {
    spawnLongLived: async (request: { env: Record<string, string> }) => {
      envs.push(request.env);
      const child = fakeHarnessChild(request.env, options);
      spawned.push(child);
      return { child, sandboxed: true };
    },
  } as unknown as ProcessSandbox;
  const host = new HarnessHost({
    workspace: root,
    bootstrap: path.join(root, "bootstrap.mjs"),
    execPath: path.join(root, "electron.exe"),
    sandbox,
    api: {},
    updatesDir: path.join(root, "updates"),
    platform: "win32",
    onLog: options.onLog,
  });
  await host.start();
  const child = spawned[0];
  assert.ok(child);
  return { host, child, env: envs[0] ?? {}, root };
}

describe("harness host on Windows", () => {
  it("joins stderr chunks, strips CRLF and flushes a final unterminated line", async (t) => {
    const lines: string[] = [];
    const { host, child } = await windowsHost({ exitsOnShutdown: true, onLog: (line) => lines.push(line) });
    t.after(() => host.stop(2_000));
    child.stderr.write("partial");
    assert.deepEqual(lines, []);
    child.stderr.write(" line\r");
    child.stderr.write("\nnext\nlast");
    child.stderr.end();
    await host.stop(2_000);
    assert.deepEqual(lines, ["partial line", "next", "last"]);
  });

  it("hands the harness its workspace by the long name, never an 8.3 or linked spelling", async () => {
    // The packaged smoke's workspace sat under C:\Users\RUNNER~1\…\Temp: the harness's module
    // resolution walked that spelling inside the sandbox and failed with EPERM. On macOS the
    // native realpath turns /var/folders into /private/var/folders the same way.
    const { host, env, root } = await windowsHost({ exitsOnShutdown: true });
    await host.stop(2_000);
    assert.equal(env.HARNESS_WS, realpathSync.native(root));
  });

  it("speaks to the harness over its loopback inbox, token first, since stdin does not reach it", async () => {
    const { host, child, env } = await windowsHost({ exitsOnShutdown: true });
    assert.match(env.HARNESS_INBOX_TOKEN ?? "", /^[0-9a-f]{64}$/);
    await host.stop(2_000);
    assert.equal(child.lines[0], env.HARNESS_INBOX_TOKEN, "the token is the first line");
    assert.match(child.lines[1] ?? "", /"kind":"shutdown"/);
    assert.equal(child.stdin.readableLength, 0, "nothing went to stdin");
  });

  it("stop asks for a shutdown and sends no SIGTERM, which Windows would turn into a hard kill", async () => {
    const { host, child } = await windowsHost({ exitsOnShutdown: true });
    await host.stop(2_000);
    assert.deepEqual(child.kills, [], "the harness left on its own");
  });

  it("stop kills the broker once the grace runs out", async () => {
    const { host, child } = await windowsHost({ exitsOnShutdown: false });
    const started = Date.now();
    await host.stop(150);
    assert.ok(Date.now() - started >= 140, "the grace was waited out");
    assert.deepEqual(child.kills, [undefined], "one plain kill of the broker ends the job");
  });
});

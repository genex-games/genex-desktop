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
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SandboxProblemCode } from "../../src/shared/boot.ts";
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
  WindowsSandboxSession,
  ancestorDirs,
  ancestorGrants,
  findGitBash,
  gitRootFromExecPath,
  gitRootFromRegistry,
  grantUnion,
  grantableToolDirs,
  grantsCover,
  keepWindowsDenies,
  msysPath,
  msysPathList,
  renderEnvFile,
  srtWinExecFailure,
  srtWinPath,
  windowsGrantHolders,
  windowsRunEnv,
  writeDeniesBeyondRead,
} from "../../src/substrate/windows-sandbox.ts";
import {
  type FolderAceEdit,
  type FolderAceEditor,
  FolderAceOp,
  folderAceCommand,
  folderAceEditor,
  folderAceOutcomes,
  FOLDER_ACE_SCRIPT,
  icaclsArgs,
} from "../../src/substrate/windows-folder-ace.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long a test waits for a file removed in the background: polls of POLL_MS each. */
const ENV_FILE_POLLS = 200;
const POLL_MS = 10;
/** Run input larger than any OS pipe buffer, so no write of it can finish before the reader closes. */
const PIPE_OVERFLOW_BYTES = 1024 * 1024;
const PROFILE = "C:\\Users\\Ann";
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

  it("grants nothing while the sandbox user does not exist yet", async () => {
    const calls: string[][] = [];
    await holder(await tmpDir("windows-grants-"), 1, calls, { sid: async () => null }).sync([at("AppData")]);
    assert.deepEqual(calls, []);
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
    const script = command.args.at(-1) ?? "";
    assert.equal(Buffer.from(script, "base64").toString("utf16le"), FOLDER_ACE_SCRIPT);
    const payload = command.env.GENEX_FOLDER_ACES ?? "";
    assert.match(payload, /^[A-Za-z0-9+/=]+$/, "only base64 crosses the process boundary");
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), edits);
  });

  it("reads one outcome per edit, and nothing else as an answer", () => {
    const table: Array<[string, string, number, unknown]> = [
      [
        "one each",
        '[{"ok":true},{"ok":false,"error":"Access is denied"}]',
        2,
        [{ ok: true }, { ok: false, error: "Access is denied" }],
      ],
      ["too few", '[{"ok":true}]', 2, null],
      ["not JSON (PowerShell failed to start the script)", "#< CLIXML", 1, null],
      ["empty", "", 1, null],
      ["not a list", '{"ok":true}', 1, null],
      ["a refusal without words", '[{"ok":false}]', 1, [{ ok: false, error: "refused" }]],
    ];
    for (const [label, stdout, count, expected] of table)
      assert.deepEqual(folderAceOutcomes(stdout, count), expected, label);
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
      ["C:\\Users\\Семён\\AppData", "/grant", `*${SID}:(RA)`],
      ["C:\\Users\\Семён\\it's", "/remove:g", `*${SID}`],
    ]);
  });

  it("uses PowerShell's answer when it gives one, and runs nothing for no edits", async () => {
    let runs = 0;
    const editor = folderAceEditor({
      powershell: async () => {
        runs++;
        return '[{"ok":true},{"ok":true}]';
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
  const guestsRead = /\(A;;(?:0x80|LO);;;BG\)/;

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
    const USERS = "S-1-5-32-545";
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
    const granted = /\(A;;(?:0x80|LO);;;BU\)/;
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
    assert.deepEqual(grantableToolDirs(entries, PROFILE, denied, exists), [
      at("AppData", "Roaming", "nvm", "v24.18.0"),
      at("scoop", "shims"),
    ]);
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
});

describe("read and write denies", () => {
  it("sends a path denied both ways as a read deny only, which already forbids writing", () => {
    const read = [at("secrets"), at(".ssh")];
    const write = [at("SECRETS"), at("judge"), at(".ssh", "config")];
    assert.deepEqual(writeDeniesBeyondRead(write, read), [at("judge"), at(".ssh", "config")]);
  });
});

describe("Git Bash and srt-win", () => {
  it("reads Git's install folder from the registry or from git --exec-path", () => {
    const reg =
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    C:\\Program Files\\Git\r\n";
    assert.equal(gitRootFromRegistry(reg), "C:\\Program Files\\Git");
    assert.equal(gitRootFromRegistry("ERROR: The system was unable to find the specified registry key"), null);
    assert.equal(gitRootFromExecPath("C:/Program Files/Git/mingw64/libexec/git-core\n"), "C:\\Program Files\\Git");
    assert.equal(gitRootFromExecPath("/usr/libexec/git-core"), null);
  });

  it("prefers the registry, falls back to git, and reports none when neither has bash.exe", async () => {
    const regOut = "    InstallPath    REG_SZ    C:\\Git\r\n";
    const exec = "D:/PortableGit/mingw64/libexec/git-core";
    const found = (want: string) => (file: string) => file === want;
    const fail = async () => {
      throw new Error("not found");
    };
    const table: Array<[string, Parameters<typeof findGitBash>[0], string | null]> = [
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

function fakeSessionRuntime() {
  const calls: string[] = [];
  const configs: SandboxRuntimeConfig[] = [];
  let gate: Promise<void> | null = null;
  const failures: string[] = [];
  const runtime = {
    initialize: async (config: SandboxRuntimeConfig) => {
      calls.push("initialize");
      configs.push(config);
      if (gate) await gate;
      const code = failures.shift();
      if (code) throw Object.assign(new Error(`srt-win failed: ${code}`), { code });
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
    /** The next initializes fail with these sandbox-runtime codes, in order. */
    failInitialize: (...codes: string[]) => {
      failures.push(...codes);
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

/** A session over fakes; `realDenies` keeps the real filter of missing deny paths. */
function session(options: { realDenies?: boolean; profile?: string } = {}) {
  const runtime = fakeSessionRuntime();
  const ancestors = fakeAncestors();
  const value = new WindowsSandboxSession({
    runtime: runtime.runtime,
    profile: options.profile ?? PROFILE,
    ancestors: ancestors.ancestors,
    ...(options.realDenies ? {} : { keepDenies: (paths: readonly string[]) => [...paths] }),
  });
  return { session: value, runtime, ancestors };
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

  it("an srt-win timeout is tried again, up to three attempts in all", async () => {
    const s = session();
    s.runtime.failInitialize("srt_win_timeout", "srt_win_timeout");
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    assert.deepEqual(s.runtime.calls, ["initialize", "initialize", "initialize"]);

    const stuck = session();
    stuck.runtime.failInitialize("srt_win_timeout", "srt_win_timeout", "srt_win_timeout");
    await assert.rejects(
      stuck.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG }),
      /srt_win_timeout/,
    );
    assert.equal(stuck.runtime.calls.length, 3);
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

  it("dispose resets and takes back the folders above the roots", async () => {
    const s = session();
    await s.session.join({}, { grants: { write: [GAMES], read: [] }, config: BASE_CONFIG });
    await s.session.dispose();
    assert.deepEqual(s.runtime.calls, ["initialize", "reset"]);
    assert.equal(s.ancestors.revoked(), 1);
  });
});

// ── ProcessSandbox's Windows launch, through a fake runtime ─────────────────────────────────

interface WrapCall {
  command: string;
  binShell: unknown;
  config: SandboxRuntimeConfig | undefined;
  cwd: string | undefined;
}

async function windowsSandbox(options: { wrapError?: object; initializeError?: object; bash?: string | null } = {}) {
  const root = realpathSync.native(await tmpDir("windows-launch-"));
  const workspace = path.join(root, "workspace");
  const secrets = path.join(root, "secrets");
  await mkdir(secrets, { recursive: true });
  const bash = options.bash === undefined ? await testBash() : options.bash;
  const wraps: WrapCall[] = [];
  const s = session({ realDenies: true, profile: root });
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
      return { argv: [bash, "-c", command], env: process.env };
    }) as SandboxRuntime["wrapWithSandboxArgv"],
    annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
  } as unknown as SandboxRuntime;
  const sandbox = await ProcessSandbox.create({
    writableRoots: [workspace],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [secrets, path.join(root, "never-created")],
    runtime,
    platform: "win32",
    windows: { bash, session: s.session, profile: root },
    toolPath: async () => "",
  });
  return { sandbox, root, workspace, secrets, wraps, session: s };
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
      w.session.runtime
        .last()
        .filesystem.allowWrite.some((dir) => dir.toLowerCase() === path.win32.resolve(later).toLowerCase()),
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

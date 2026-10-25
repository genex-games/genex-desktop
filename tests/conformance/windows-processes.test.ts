/**
 * Windows' processes with their command lines (WMI through Windows PowerShell), for the engine
 * plugins that find an editor by the project its arguments name. PowerShell is a stand-in here.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { endEditors, windowsEditors } from "../../src/plugins/unity/processes.ts";
import { windowsArgv, windowsProcesses, windowsProcessRows } from "../../src/substrate/windows-processes.ts";
import { processTable } from "../helpers/unity-editor-stand-in.ts";

const UNITY = "C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.32f1\\Editor\\Unity.exe";

describe("a Windows command line, split as Windows splits it", () => {
  it("groups quoted words and keeps backslashes that escape no quote", () => {
    const cases: Array<[string, string[]]> = [
      [
        `"${UNITY}" -projectpath "C:\\Users\\Ana Smith\\My Game" -useHub`,
        [UNITY, "-projectpath", "C:\\Users\\Ana Smith\\My Game", "-useHub"],
      ],
      ['a\\\\\\"b "c d\\\\" e', ['a\\"b', "c d\\", "e"]],
      ['x ""  y', ["x", "", "y"]],
      ["  \t ", []],
      ["", []],
    ];
    for (const [line, argv] of cases) assert.deepEqual(windowsArgv(line), argv, line);
  });
});

describe("PowerShell's answer, as process rows", () => {
  it("reads one object, many or none, with the arguments after the full program path", () => {
    const one = JSON.stringify({
      pid: 42,
      exec: UNITY,
      name: "Unity.exe",
      line: `"${UNITY}" -projectPath "D:\\Games\\rift"`,
    });
    assert.deepEqual(windowsProcessRows(one), [
      { pid: 42, exec: UNITY, args: `${UNITY} -projectPath D:\\Games\\rift` },
    ]);
    const many = JSON.stringify([
      { pid: 1, exec: "", name: "Unity.exe", line: "" },
      { pid: 2, exec: UNITY, name: "Unity.exe", line: null },
    ]);
    assert.deepEqual(windowsProcessRows(many), [
      { pid: 1, exec: "Unity.exe", args: "Unity.exe" },
      { pid: 2, exec: UNITY, args: UNITY },
    ]);
    assert.deepEqual(windowsProcessRows(""), []);
  });

  it("drops anything that is not a process", () => {
    const hostile = [
      "not json",
      "null",
      "7",
      '"text"',
      JSON.stringify([{ pid: -1, exec: UNITY }, { pid: 1.5, exec: UNITY }, { pid: 3 }, { pid: "4", exec: UNITY }]),
    ];
    for (const answer of hostile) assert.deepEqual(windowsProcessRows(answer), [], answer);
  });
});

describe("listing Windows' processes", () => {
  it("asks Windows' own PowerShell for the named programs, by an encoded script", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const rows = await windowsProcesses(["Unity.exe"], {
      env: { SystemRoot: "D:\\Win" },
      run: async (file, args) => {
        calls.push({ file, args });
        return "[]";
      },
    });
    assert.deepEqual(rows, []);
    assert.equal(calls[0]?.file, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const script = Buffer.from(String(calls[0]?.args.at(-1)), "base64").toString("utf16le");
    assert.match(script, /Win32_Process -Filter "Name LIKE 'Unity\.exe'"/);
  });

  it("runs that PowerShell without an inherited module path, which would lose Get-CimInstance", async () => {
    const seen: Array<NodeJS.ProcessEnv> = [];
    await windowsProcesses(["Unity.exe"], {
      env: { SystemRoot: "D:\\Win", PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules" },
      run: async (_file, _args, env) => {
        seen.push(env);
        return "[]";
      },
    });
    assert.equal(seen[0]?.PSModulePath, undefined);
    assert.equal(seen[0]?.SystemRoot, "D:\\Win");
  });

  it("never puts a name that is not a plain program name into the query, and runs nothing for none", async () => {
    const hostile = ["Unity.exe' OR Name LIKE '%", 'x" ; Remove-Item C:\\', "a b", "$(calc)", ""];
    let ran = 0;
    const run = async () => {
      ran += 1;
      return "[]";
    };
    assert.deepEqual(await windowsProcesses(hostile, { run }), []);
    assert.equal(ran, 0);
  });

  it("finds this test's own Node with its command line on a real Windows", {
    skip: process.platform !== "win32" && "Windows PowerShell and WMI are Windows'",
  }, async () => {
    const rows = await windowsProcesses([path.win32.basename(process.execPath)]);
    const own = rows?.find((row) => row.pid === process.pid);
    assert.ok(own, `this process (${process.pid}) is listed: ${JSON.stringify(rows)}`);
    assert.equal(own.exec.toLowerCase(), process.execPath.toLowerCase());
    assert.ok(own.args.startsWith(own.exec), own.args);
  });

  it("answers null when PowerShell fails, so a caller can fall back", async () => {
    const failing = async () => {
      throw new Error("ENOENT");
    };
    assert.equal(await windowsProcesses(["Unity.exe"], { run: failing }), null);
  });
});

describe("Unity's editors on Windows", () => {
  it("are found by the project their command line names, in any case and either separator", async () => {
    const listed = async () => [
      { pid: 11, exec: UNITY, args: `${UNITY} -projectpath C:/Users/Ana Smith/Games/Rift/unity -useHub` },
      { pid: 12, exec: UNITY, args: `${UNITY} -projectPath C:\\Users\\Ana Smith\\Games\\Rift\\unity-backup` },
    ];
    const rows = await windowsEditors(listed);
    const { env, sent } = processTable(rows);
    assert.equal(await endEditors(env, "c:\\users\\ana smith\\games\\rift\\unity"), true);
    assert.deepEqual(sent, [[11, "SIGTERM"]], "never the backup project's editor");
  });
});

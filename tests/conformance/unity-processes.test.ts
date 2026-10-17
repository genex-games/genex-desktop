import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editorPids, endEditors, tasklistEditors } from "../../src/plugins/unity/processes.ts";
import { EDITOR_PROGRAM, processRow, processTable } from "../helpers/unity-editor-stand-in.ts";

const EDITOR = EDITOR_PROGRAM;
const ROOT = "/Users/ada/Games/lantern/unity";
const row = processRow;
const table = processTable;

describe("the editor processes that have a game's Unity project open", () => {
  it("are the editors whose command line names the project, in either spelling of the flag", async () => {
    const { env } = table([
      row(11, EDITOR, `-projectPath ${ROOT}`),
      row(12, EDITOR, `-projectpath ${ROOT} -useHub -hubIPC -cloudEnvironment production`),
      row(13, EDITOR, `-batchmode -projectPath ${ROOT}`),
    ]);
    assert.deepEqual(await editorPids(env, ROOT), [11, 12, 13]);
  });

  it("are never another project's editor, Unity Hub, or a program that only names the folder", async () => {
    const { env } = table([
      row(21, EDITOR, `-projectPath ${ROOT}-backup`),
      row(22, EDITOR, `-projectPath ${ROOT}/Nested`),
      row(23, EDITOR, "-projectPath /Users/ada/Games/other/unity"),
      row(24, EDITOR, ""),
      row(25, "/Applications/Unity Hub.app/Contents/MacOS/Unity Hub", `-projectPath ${ROOT}`),
      row(
        26,
        "/Applications/Unity Hub.app/Contents/Frameworks/Unity Hub Helper.app/Contents/MacOS/Unity Hub Helper",
        ROOT,
      ),
      row(27, "/bin/zsh", `-c open -n -a Unity.app --args -projectPath ${ROOT}`),
      row(28, "/usr/bin/tail", `-f ${ROOT}/Logs/Editor.log`),
    ]);
    assert.deepEqual(await editorPids(env, ROOT), []);
  });
});

describe("Windows' Unity editors", () => {
  it("are the Unity.exe rows of the task list's CSV, by id, with no command line", () => {
    const csv = [
      '"Unity.exe","4242","Console","1","1,234,567 K"',
      '"Unity Hub.exe","51","Console","1","98,304 K"',
      '"UNITY.EXE","77","Console","1","5 K"',
      "INFO: No tasks are running which match the specified criteria.",
      "",
    ].join("\r\n");
    assert.deepEqual(tasklistEditors(csv), [
      { pid: 4242, exec: "Unity.exe", args: "" },
      { pid: 77, exec: "UNITY.EXE", args: "" },
    ]);
  });
});

describe("ending a project's editors", () => {
  it("asks each to end and says so once none is left, touching no other process", async () => {
    const { env, sent, running } = table([
      row(31, EDITOR, `-projectPath ${ROOT}`),
      row(32, EDITOR, "-projectPath /Users/ada/Games/other/unity"),
      row(33, "/bin/zsh", ""),
    ]);
    assert.equal(await endEditors(env, ROOT), true);
    assert.deepEqual(sent, [[31, "SIGTERM"]]);
    assert.deepEqual(running(), [32, 33]);
  });

  it("kills an editor that does not end when asked, after a grace", async () => {
    const { env, sent, slept } = table([row(41, EDITOR, `-projectPath ${ROOT}`)], { 41: ["SIGKILL"] });
    assert.equal(await endEditors(env, ROOT), true);
    assert.deepEqual(sent, [
      [41, "SIGTERM"],
      [41, "SIGKILL"],
    ]);
    assert.ok(slept.reduce((sum, ms) => sum + ms, 0) >= 10_000, "it waits out the grace first");
  });

  it("says an editor is still there when nothing ends it, and has nothing to do with none open", async () => {
    const stubborn = table([row(51, EDITOR, `-projectPath ${ROOT}`)], { 51: [] });
    assert.equal(await endEditors(stubborn.env, ROOT), false);
    const none = table([row(52, "/bin/zsh", "")]);
    assert.equal(await endEditors(none.env, ROOT), true);
    assert.deepEqual([none.sent, none.slept], [[], []]);
  });
});

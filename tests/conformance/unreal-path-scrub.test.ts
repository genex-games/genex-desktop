/**
 * What an agent reads of an Unreal run's output: no path of the computer, on a Mac or on Windows
 * (W15-10). The project's folder is taken out so its files read relative to it, the engine's too,
 * and any other absolute path is cut to its base name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathScrubber } from "../../src/plugins/unreal/ubt.ts";

const MAC_PROJECT = "/Users/ana/AI Games/rift/unreal";
const MAC_ENGINE = "/Users/Shared/Epic Games/UE_5.8";
const WINDOWS_PROJECT = "C:\\Users\\ana\\AI Games\\rift\\unreal";
const WINDOWS_ENGINE = "C:\\Program Files\\Epic Games\\UE_5.8";

describe("an Unreal run's output as an agent reads it", () => {
  it("keeps a Mac project's files relative to it and cuts any other path to its base name", async () => {
    const scrub = await pathScrubber(MAC_PROJECT, MAC_ENGINE);
    assert.equal(
      scrub(`Expected 16 at ${MAC_PROJECT}/Plugins/LevelTools/Source/Grid.cpp, see /Users/ana/Library/Logs/a.log`),
      "Expected 16 at Plugins/LevelTools/Source/Grid.cpp, see a.log",
    );
  });

  const windows: Array<{ name: string; said: string; reads: string }> = [
    {
      name: "a project file, with either separator after the project",
      said: `Expected 16 at ${WINDOWS_PROJECT}\\Plugins\\LevelTools\\Source/Grid.cpp`,
      reads: "Expected 16 at Plugins\\LevelTools\\Source/Grid.cpp",
    },
    {
      name: "the project spelled with forward slashes and another case",
      said: "in c:/users/ANA/AI Games/rift/unreal/Source/Rift/Rift.cpp(12)",
      reads: "in Source/Rift/Rift.cpp(12)",
    },
    {
      name: "an engine file",
      said: `at ${WINDOWS_ENGINE}\\Engine\\Source\\Runtime\\Core\\Private\\Misc\\Assert.cpp:12`,
      reads: "at Engine\\Source\\Runtime\\Core\\Private\\Misc\\Assert.cpp:12",
    },
    {
      name: "a file elsewhere under the user's home",
      said: "see C:\\Users\\ana\\AppData\\Local\\Temp\\UnrealEditor-Cmd.crash now",
      reads: "see UnrealEditor-Cmd.crash now",
    },
    {
      name: "a file on another drive, with forward slashes",
      said: "wrote D:/Builds/ana/out.log",
      reads: "wrote out.log",
    },
    {
      name: "a file on a network share",
      said: "copied \\\\server\\ana\\shared\\notes.txt",
      reads: "copied notes.txt",
    },
    {
      name: "a quoted path",
      said: "opened 'C:\\Users\\ana\\Documents\\notes.txt'",
      reads: "opened 'notes.txt'",
    },
  ];
  for (const { name, said, reads } of windows) {
    it(`on Windows, ${name}`, async () => {
      const scrub = await pathScrubber(WINDOWS_PROJECT, WINDOWS_ENGINE);
      const out = scrub(said);
      assert.equal(out, reads);
      assert.doesNotMatch(out, /ana/i, "no user name");
    });
  }

  it("leaves words that only look like a drive or a separator alone", async () => {
    const scrub = await pathScrubber(WINDOWS_PROJECT, WINDOWS_ENGINE);
    for (const said of ["Ratio 3:4 at A:B", "Result: Failed (OtherCompilationError)", "and/or \\n escapes"])
      assert.equal(scrub(said), said);
  });
});

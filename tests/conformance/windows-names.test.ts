/**
 * The one Windows file-name rule (`substrate/windows-names.ts`), which the PE gate and the export
 * archives both apply: every name Windows cannot hold as spelled is refused with a typed reason,
 * and the rule is at least as strict as each of the two rules it replaces over every name their
 * tables refused. A pure check: it reads and writes nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isWindowsSafeName,
  WINDOWS_NAME_MAX_BYTES,
  WindowsNameProblem,
  windowsNameProblem,
} from "../../src/substrate/windows-names.ts";

/** One segment Windows cannot hold, and why. */
const REFUSED: ReadonlyArray<[string, WindowsNameProblem]> = [
  ["", WindowsNameProblem.Empty],
  [".", WindowsNameProblem.DotSegment],
  ["..", WindowsNameProblem.DotSegment],
  ["a/b", WindowsNameProblem.Character],
  ["a\\b.png", WindowsNameProblem.Character],
  ["C:", WindowsNameProblem.Character],
  ["a.png:hidden", WindowsNameProblem.Character],
  ["x.png:Zone.Identifier", WindowsNameProblem.Character],
  ["what?.png", WindowsNameProblem.Character],
  ["star*.png", WindowsNameProblem.Character],
  ["a|b.png", WindowsNameProblem.Character],
  ["<a>.png", WindowsNameProblem.Character],
  ['say"hi".txt', WindowsNameProblem.Character],
  ["a\u0000b.png", WindowsNameProblem.Character],
  ["tab\t.png", WindowsNameProblem.Character],
  ["a\nb.png", WindowsNameProblem.Character],
  ["del\u007f.png", WindowsNameProblem.Character],
  ["c1\u0085.png", WindowsNameProblem.Character],
  ["a\uD800.png", WindowsNameProblem.Character],
  ["CON", WindowsNameProblem.Reserved],
  ["con", WindowsNameProblem.Reserved],
  ["con.png", WindowsNameProblem.Reserved],
  ["Con.tar.gz", WindowsNameProblem.Reserved],
  ["CON .txt", WindowsNameProblem.Reserved],
  ["PRN", WindowsNameProblem.Reserved],
  ["aux", WindowsNameProblem.Reserved],
  ["NUL", WindowsNameProblem.Reserved],
  ["nul.txt", WindowsNameProblem.Reserved],
  ["COM0", WindowsNameProblem.Reserved],
  ["COM1.txt", WindowsNameProblem.Reserved],
  ["Com1.ogg", WindowsNameProblem.Reserved],
  ["com9", WindowsNameProblem.Reserved],
  ["COM¹.txt", WindowsNameProblem.Reserved],
  ["com²", WindowsNameProblem.Reserved],
  ["COM³.dll", WindowsNameProblem.Reserved],
  ["LPT0", WindowsNameProblem.Reserved],
  ["lpt9.dat", WindowsNameProblem.Reserved],
  ["LPT¹", WindowsNameProblem.Reserved],
  ["CONIN$", WindowsNameProblem.Reserved],
  ["conout$.log", WindowsNameProblem.Reserved],
  ["trail.", WindowsNameProblem.Trailing],
  ["trail. ", WindowsNameProblem.Trailing],
  ["a.png ", WindowsNameProblem.Trailing],
  ["levels.", WindowsNameProblem.Trailing],
  ["evil.dll ", WindowsNameProblem.Trailing],
  ["a".repeat(WINDOWS_NAME_MAX_BYTES + 1), WindowsNameProblem.TooLong],
  ["é".repeat(128), WindowsNameProblem.TooLong],
  [`${"a".repeat(256)}.png`, WindowsNameProblem.TooLong],
];

/** Names Windows holds as spelled: near misses of each rule. */
const HELD: readonly string[] = [
  "game.exe",
  "libGLESv2.dll",
  "d3dcompiler_47.dll",
  "assets",
  "Assets",
  "a.b.c",
  "space in the middle.png",
  "é.png",
  ".hidden",
  "-rf",
  "CONSOLE.png",
  "con-game",
  "com10.txt",
  "lpt.txt",
  "COMA",
  "conin.txt",
  "nul game.txt",
  "a".repeat(WINDOWS_NAME_MAX_BYTES),
];

/**
 * Every path the two former rules' tables refused (the export archive's `UNSAFE_ASSET_NAMES`, the
 * PE gate's asset names and DLL names): each has a segment the one rule refuses.
 */
const FORMERLY_REFUSED_PATHS: readonly string[] = [
  "../escape.png",
  "a/../../escape.png",
  "/etc/passwd",
  "C:/x.png",
  "a\\b.png",
  "a//b.png",
  "./a.png",
  "",
  "con.png",
  "sub/NUL",
  "COM1.txt",
  "lpt9.dat",
  "COM¹.txt",
  "CONIN$",
  "sub./a.png",
  "a.png ",
  "a.png:hidden",
  "what?.png",
  "a|b.png",
  "a\u0000b.png",
  "a\uD800.png",
  "a\nb.png",
  `${"a".repeat(256)}.png`,
  "assets/a\\..\\..\\..\\evil.png",
  "assets/x.png:Zone.Identifier",
  "assets/CON.png",
  "assets/aux",
  "assets/Com1.ogg",
  "assets/q?*<>|.txt",
  'assets/say"hi".txt',
  "assets/tab\t.png",
  "assets/trail. ",
  "assets/trail.",
  "assets/levels./one.json",
  "assets./x.png",
  "Assets:s/x.png",
  "assets/evil.dll ",
  "helper.dll:s",
  "libEGL.dll:x",
  "CON",
  "game.",
  "x\ny",
  "a:b",
];

describe("the one Windows name rule", () => {
  for (const [name, problem] of REFUSED) {
    it(`refuses ${JSON.stringify(name.length > 40 ? `${name.slice(0, 12)}…(${name.length})` : name)} as ${problem}`, () => {
      assert.equal(windowsNameProblem(name), problem);
      assert.equal(isWindowsSafeName(name), false);
    });
  }

  it("holds every near miss as spelled", () => {
    for (const name of HELD) {
      assert.equal(windowsNameProblem(name), null, JSON.stringify(name));
      assert.equal(isWindowsSafeName(name), true, JSON.stringify(name));
    }
  });

  it("refuses a device name in any capitals and with any extension", () => {
    for (const device of ["con", "prn", "aux", "nul", "com0", "com5", "lpt3", "conin$", "conout$"])
      for (const spelled of [device, device.toUpperCase(), `${device[0]?.toUpperCase()}${device.slice(1)}`])
        for (const extension of ["", ".txt", ".tar.gz", " .png"])
          assert.equal(windowsNameProblem(`${spelled}${extension}`), WindowsNameProblem.Reserved, spelled + extension);
  });

  it("is at least as strict as the PE gate's and the archives' former rules over every name they refused", () => {
    for (const rel of FORMERLY_REFUSED_PATHS) {
      const refused = rel.split("/").some((segment) => windowsNameProblem(segment) !== null);
      assert.ok(refused, JSON.stringify(rel));
    }
  });

  it("counts a name's length in UTF-8 bytes, as every filesystem a player extracts to does", () => {
    assert.equal(windowsNameProblem("é".repeat(127)), null, "254 bytes");
    assert.equal(windowsNameProblem(`${"é".repeat(127)}a`), null, "255 bytes");
    assert.equal(windowsNameProblem(`${"é".repeat(127)}ab`), WindowsNameProblem.TooLong, "256 bytes");
  });
});

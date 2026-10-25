/**
 * scripts/check-mac-tools.ts: shipped code never runs a macOS program that only stands in for one of
 * Xcode's (`lipo`, `otool`, `xcrun`…), by its /usr/bin path or by name as a process's program,
 * since a player's Mac has no developer tools. Comments, macOS's own tools, Git (run on purpose),
 * a name that is only data and the development fixtures are not refused.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkMacTools, findXcodeStandIns, macToolFiles } from "../../scripts/check-mac-tools.ts";

const checker = path.resolve(import.meta.dirname, "../../scripts/check-mac-tools.ts");
const APP = "src/main/play/example.ts";

const toolsIn = (file: string, source: string) => findXcodeStandIns(file, source).map((f) => f.tool);

/** Each shape the check refuses, and the stand-in it names. */
const CAUGHT: Array<[string, string, string]> = [
  ["a tool table naming lipo by path", 'const TOOL = { Lipo: "/usr/bin/lipo" } as const;', "lipo"],
  ["otool run by path", 'await execFile("/usr/bin/otool", ["-L", program]);', "otool"],
  ["xcrun run by name", 'execFile("xcrun", ["--find", "swiftc"], done);', "xcrun"],
  ["strip spawned by name, single quotes", "const child = spawn('strip', [program]);", "strip"],
  ["a tool run through a dependency", 'await run("install_name_tool", args, options);', "install_name_tool"],
  ["a template path", "const tool = `/usr/bin/codesign_allocate`;", "codesign_allocate"],
  ["python3 run by path", 'execFileSync("/usr/bin/python3", ["-c", code]);', "python3"],
];

/** Shapes that look close and are fine. */
const ALLOWED: Array<[string, string, string]> = [
  ["a comment naming the tool", APP, "// `lipo` needs Apple's developer tools; /usr/bin/lipo is a stand-in\nf();"],
  ["macOS's own tools", APP, 'execFile("/usr/bin/ditto", ["-x", "-k", zip, dir]); run("/usr/bin/codesign", a);'],
  ["Git, run on purpose", APP, 'const GIT = "/usr/bin/git"; await exec("git", ["status"]);'],
  ["a real xcodebuild inside a chosen Xcode", APP, 'const tool = path.join(developer, "usr", "bin", "xcodebuild");'],
  ["a stand-in name that is only data", APP, 'const NAMES = ["python3", "make"]; if (cmd === "strip") skip();'],
  ["text that only mentions a stand-in", APP, 'throw new Error("lipo failed: /usr/bin/lipo -archs");'],
  ["the development fixtures, built on a developer's Mac", "src/main/dev/fixture.ts", 'exec("/usr/bin/lipo", a);'],
];

describe("Xcode stand-ins in shipped code", () => {
  for (const [name, source, tool] of CAUGHT) {
    it(`refuses ${name}`, () => {
      assert.deepEqual(toolsIn(APP, source), [tool]);
    });
  }

  for (const [name, file, source] of ALLOWED) {
    it(`lets ${name} through`, () => {
      assert.deepEqual(toolsIn(file, source), []);
    });
  }

  it("reports each finding at its line, with the line's text", () => {
    const source = 'import x from "y";\n\nconst LIPO = "/usr/bin/lipo";\nexecFile("xcrun", []);\n';
    const findings = findXcodeStandIns(APP, source).map((f) => [f.line, f.tool, f.text]);
    assert.deepEqual(findings, [
      [3, "lipo", 'const LIPO = "/usr/bin/lipo";'],
      [4, "xcrun", 'execFile("xcrun", []);'],
    ]);
  });

  it("walks src, not scripts, tests, build output or the game template, and the CLI fails on a finding", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-tools-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const offender = 'execFile("/usr/bin/lipo", ["-archs", program]);\n';
    const files: Record<string, string> = {
      "src/main/play/a.ts": offender,
      "src/renderer/b.tsx": "export const B = () => null;\n",
      "scripts/c.ts": offender,
      "src/game-template/src/main.js": offender,
      "src/renderer/dist/bundle.js": offender,
      "tests/conformance/d.test.ts": offender,
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    assert.deepEqual(macToolFiles(root), ["src/main/play/a.ts", "src/renderer/b.tsx"]);
    const report = checkMacTools(root);
    assert.equal(report.length, 1);
    assert.match(report[0] ?? "", /^src\/main\/play\/a\.ts:1: runs lipo, a stand-in for Xcode's/);

    const failing = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /1 Xcode stand-in\(s\)/);

    fs.writeFileSync(path.join(root, "src/main/play/a.ts"), "const archs = await machOProcessors(program);\n");
    const passing = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /no Xcode stand-ins in 2 files/);
  });
});

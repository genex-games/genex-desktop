/**
 * Links inside the studio window never navigate it (a contractor's
 * "[Base handoff](/…/NOTES.base-builder.md)" link would turn the whole app black). A file link opens
 * only a real document inside a game folder; anything else is shown in Finder or refused, so a
 * contractor's link can never run what it wrote (SECUI-1).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { routeStudioLink } from "../../src/main/link-policy.ts";
import { tmpDir } from "../helpers/tmp.ts";

const link = (file: string) => pathToFileURL(file).href;
const real = (file: string) => fs.realpathSync(file);
const touch = (file: string, text = "x\n", mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
};

async function folders() {
  const games = await tmpDir("studio-links-");
  const game = path.join(games, "skate-prod");
  const spaced = path.join(games, "AI Games", "hi");
  fs.mkdirSync(game, { recursive: true });
  fs.mkdirSync(spaced, { recursive: true });
  const outside = await tmpDir("studio-outside-");
  return { games, game, spaced, outside, projectDirs: [game, path.dirname(spaced)] };
}

describe("studio link policy", () => {
  it("opens https outside the window and refuses plain http", async () => {
    const { projectDirs } = await folders();
    assert.deepEqual(await routeStudioLink("https://example.com/x", { projectDirs }), {
      action: "external",
      url: "https://example.com/x",
    });
    assert.equal((await routeStudioLink("http://example.com/x", { projectDirs })).action, "refuse");
  });

  it("hands a document inside a game folder to its own app, never to the window", async () => {
    const { game, spaced, projectDirs } = await folders();
    touch(path.join(game, "NOTES.base-builder.md"));
    touch(path.join(spaced, "NOTES.md"));
    const route = await routeStudioLink(link(path.join(game, "NOTES.base-builder.md")), { projectDirs });
    assert.deepEqual(route, { action: "open-path", target: path.join(real(game), "NOTES.base-builder.md") });
    // Spaces arrive percent-encoded from the renderer.
    assert.ok(link(path.join(spaced, "NOTES.md")).includes("%20"));
    assert.deepEqual(await routeStudioLink(link(path.join(spaced, "NOTES.md")), { projectDirs }), {
      action: "open-path",
      target: path.join(real(spaced), "NOTES.md"),
    });
    // Every allowlisted type, whatever its case.
    for (const name of [
      "a.txt",
      "b.json",
      "c.html",
      "d.PNG",
      "e.jpeg",
      "f.svg",
      "g.mp3",
      "h.glb",
      "i.csv",
      "j.log",
      "k.webm",
    ]) {
      touch(path.join(game, "docs", name));
      assert.equal(
        (await routeStudioLink(link(path.join(game, "docs", name)), { projectDirs })).action,
        "open-path",
        name,
      );
    }
  });

  it("refuses files outside the game folders, including traversal out of one", async () => {
    const { game, outside, projectDirs } = await folders();
    touch(path.join(outside, "id_rsa"));
    touch(path.join(`${game}-evil`, "NOTES.md"));
    try {
      assert.equal((await routeStudioLink(link(path.join(outside, "id_rsa")), { projectDirs })).action, "refuse");
      const climb = `${link(game)}/../../${path.basename(outside)}/id_rsa`;
      assert.equal((await routeStudioLink(climb, { projectDirs })).action, "refuse");
      assert.equal(
        (await routeStudioLink(link(path.join(`${game}-evil`, "NOTES.md")), { projectDirs })).action,
        "refuse",
        "a sibling that merely shares the prefix",
      );
    } finally {
      fs.rmSync(`${game}-evil`, { recursive: true, force: true });
    }
  });

  it("refuses a link inside a game folder that leads out of it", async () => {
    const { game, outside, projectDirs } = await folders();
    touch(path.join(outside, "secret.md"));
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(game, "notes.md"));
    fs.symlinkSync(outside, path.join(game, "linked"));
    for (const target of [
      path.join(game, "notes.md"),
      path.join(game, "linked", "secret.md"),
      path.join(game, "linked"),
    ]) {
      assert.equal((await routeStudioLink(link(target), { projectDirs })).action, "refuse", target);
    }
  });

  it("refuses a file that does not exist, and a link whose target does not", async () => {
    const { game, projectDirs } = await folders();
    fs.symlinkSync(path.join(game, "nowhere.md"), path.join(game, "dangling.md"));
    for (const target of [
      path.join(game, "NOTES.md"),
      path.join(game, "dangling.md"),
      path.join(game, "no", "such", "dir.md"),
    ]) {
      assert.equal((await routeStudioLink(link(target), { projectDirs })).action, "refuse", target);
    }
    // A game folder that is gone contains nothing.
    const gone = path.join(path.dirname(game), "gone");
    assert.equal((await routeStudioLink(link(path.join(gone, "NOTES.md")), { projectDirs: [gone] })).action, "refuse");
  });

  it("never opens what a contractor could run: launchers, bundles and executables are shown in Finder", async () => {
    const { game, projectDirs } = await folders();
    touch(path.join(game, "tools", "Run Me.command"), "#!/bin/sh\necho hi\n", 0o755);
    touch(path.join(game, "x.terminal"));
    touch(path.join(game, "a.pkg"));
    touch(path.join(game, "go.sh"), "#!/bin/sh\n", 0o755);
    touch(path.join(game, "plain.command"), "echo hi\n", 0o644);
    fs.mkdirSync(path.join(game, "Evil.app", "Contents", "MacOS"), { recursive: true });
    touch(path.join(game, "Evil.app", "Contents", "MacOS", "Evil"), "#!/bin/sh\n", 0o755);
    // Windows runs by extension: its launchers are shown like the Mac's.
    const windowsLaunchers = ["setup.exe", "run.bat", "run.cmd", "run.ps1", "notes.lnk", "go.vbs", "go.js", "x.hta"];
    for (const name of windowsLaunchers) touch(path.join(game, name));
    // An allowlisted name is not enough: the exec bit makes it a program. Windows files have none.
    const execBit = process.platform !== "win32";
    if (execBit) touch(path.join(game, "NOTES.md"), "#!/bin/sh\n", 0o755);
    // A document name that links to a launcher inside the game is the launcher.
    fs.symlinkSync(path.join(game, "tools", "Run Me.command"), path.join(game, "handoff.md"));
    const cases: Array<[string, string]> = [
      [path.join(game, "tools", "Run Me.command"), path.join(real(game), "tools", "Run Me.command")],
      [path.join(game, "x.terminal"), path.join(real(game), "x.terminal")],
      [path.join(game, "a.pkg"), path.join(real(game), "a.pkg")],
      [path.join(game, "go.sh"), path.join(real(game), "go.sh")],
      [path.join(game, "plain.command"), path.join(real(game), "plain.command")],
      [path.join(game, "Evil.app"), path.join(real(game), "Evil.app")],
      ...windowsLaunchers.map((name): [string, string] => [path.join(game, name), path.join(real(game), name)]),
      [path.join(game, "handoff.md"), path.join(real(game), "tools", "Run Me.command")],
    ];
    if (execBit) cases.push([path.join(game, "NOTES.md"), path.join(real(game), "NOTES.md")]);
    for (const [target, shown] of cases) {
      assert.deepEqual(
        await routeStudioLink(link(target), { projectDirs }),
        { action: "reveal", target: shown },
        target,
      );
    }
  });

  it("decides by the last extension only, and shows anything without an openable one (L3)", async () => {
    const { game, projectDirs } = await folders();
    touch(path.join(game, "a.command.md"));
    touch(path.join(game, "a.md.command"));
    touch(path.join(game, "README"));
    fs.mkdirSync(path.join(game, "x.md"));
    assert.deepEqual(await routeStudioLink(link(path.join(game, "a.command.md")), { projectDirs }), {
      action: "open-path",
      target: path.join(real(game), "a.command.md"),
    });
    for (const name of ["a.md.command", "README", "x.md"]) {
      assert.deepEqual(
        await routeStudioLink(link(path.join(game, name)), { projectDirs }),
        { action: "reveal", target: path.join(real(game), name) },
        name,
      );
    }
  });

  it("shows a game folder, or a folder in it, in Finder rather than opening it", async () => {
    const { game, projectDirs } = await folders();
    fs.mkdirSync(path.join(game, "assets"));
    assert.deepEqual(await routeStudioLink(link(game), { projectDirs }), { action: "reveal", target: real(game) });
    assert.deepEqual(await routeStudioLink(link(path.join(game, "assets")), { projectDirs }), {
      action: "reveal",
      target: path.join(real(game), "assets"),
    });
  });

  it("refuses other schemes, remote file hosts and non-links in words", async () => {
    const { game, projectDirs } = await folders();
    touch(path.join(game, "NOTES.md"));
    const remote = link(path.join(game, "NOTES.md")).replace("file://", "file://attacker.example");
    for (const raw of ["javascript:alert(1)", "mailto:a@b.c", "not a url", "", remote]) {
      const route = await routeStudioLink(raw, { projectDirs });
      assert.equal(route.action, "refuse", raw);
      assert.ok(route.action === "refuse" && route.reason.length > 0);
    }
  });
});

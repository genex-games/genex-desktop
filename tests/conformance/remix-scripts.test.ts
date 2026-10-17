/**
 * A remix is someone else's game: its packages install with none of their setup scripts until the
 * person trusts them. The guard is host metadata on the game, set when the copy is adopted, kept
 * when it is reopened, and lifted only by the person's "Run setup scripts".
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SETUP_SCRIPTS_WORDS } from "../../src/renderer/words.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

describe("a remix's setup scripts", () => {
  let lite: CoreLite;

  before(async () => {
    lite = await coreLite();
  });
  after(async () => {
    await lite.close();
  });

  /** A copy of someone else's page, adopted as a remix is. */
  async function remixed(name: string): Promise<string> {
    const dir = path.join(lite.gamesRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>copy</title>");
    return (await lite.core.adoptProject(dir, { template: false, guardScripts: true })).name;
  }

  it("guards a remix from its adoption until the person trusts its scripts, reopening or not", async () => {
    const name = await remixed("guarded-copy");
    assert.equal(await lite.core.scriptsGuarded(name), true);
    await lite.core.adoptProject(lite.core.games.dirFor(name), { template: false });
    assert.equal(await lite.core.scriptsGuarded(name), true, "reopening the folder lifts nothing");
    await lite.core.games.trustScripts(name);
    assert.equal(await lite.core.scriptsGuarded(name), false);
  });

  it("installs a guarded game the guarded way, and the way its lockfile names once trusted", async () => {
    const name = await remixed("installed-copy");
    // No package.json: the guarded install has nothing to do and says so, before any network.
    const guarded = await lite.core.installPackages(name);
    assert.equal(guarded.ok, false);
    assert.match(guarded.lines.join("\n"), /no package\.json/);
    // Trusted, the press goes to the game's own install, which this page does not declare.
    const trusted = await lite.core.installPackages(name, { scripts: true });
    assert.match(trusted.lines.join("\n"), /declares no packages/);
    assert.equal(await lite.core.scriptsGuarded(name), false, "trusted once, trusted from then on");
  });

  it("never guards a game the person brought themselves", async () => {
    const dir = path.join(lite.gamesRoot, "own-game");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>mine</title>");
    const { name } = await lite.core.adoptProject(dir, { template: false });
    assert.equal(await lite.core.scriptsGuarded(name), false);
  });
});

describe("the window that asks to run a remix's setup scripts", () => {
  it("names who brought them, the game first, and counts past four packages", () => {
    const { body } = SETUP_SCRIPTS_WORDS;
    assert.match(body(false, ["sharp"]), /^sharp came with setup scripts/);
    assert.match(body(true, ["esbuild", "sharp"]), /^This game, esbuild and sharp came with/);
    assert.match(body(false, ["a", "b", "c", "d", "e", "f"]), /^a, b, c, d and 2 more came with/);
    assert.match(body(false, ["a"]), /Run them only if you trust this game\.$/);
  });
});

/**
 * A Rust · wgpu game on Genex (G6 MP-5c): one with a web build publishes its web export as a draft
 * or to the gallery, exactly the export's files and never its sources, and a networked game's
 * matchmaking reaches Genex from its genex.toml as a three.js game's does from its package.json.
 * One with no web build is refused `no-web-export` before anyone is asked. The slug a networked
 * export bakes in is the game's own Genex binding, read only for a plain project name.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertPublishable,
  genexDraftSlug,
  PublishRefusal,
  PublishRefusedError,
} from "../../src/main/core/genex-publish.ts";
import { RustFixtureKind, seedRustFixture } from "../../src/main/dev/fixture-rust.ts";
import { FIXTURE_RUST_GAME } from "../../src/main/dev/fixture-toolchains.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { readGenexGameManifest } from "../../src/substrate/genex-game-manifest.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A core with the Rust fixture game (Browser and Mac) and its stub Rust lane. */
async function rustCore() {
  const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("genex-publish-rust-")) });
  await seedRustFixture(lite.core, RustFixtureKind.Game);
  return lite;
}

/** Refused for having no web export: by its code. */
const refusedNoWebExport = (error: unknown): boolean => {
  assert.ok(error instanceof PublishRefusedError, String(error));
  assert.equal(error.code, PublishRefusal.NoWebExport);
  return true;
};

describe("publishing a Rust · wgpu game (G6 MP-5c)", () => {
  it("admits a Rust game with a web build, and lists exactly its web export's files, never its sources", async () => {
    const { core } = await rustCore();
    await assertPublishable(core, FIXTURE_RUST_GAME.name);
    const review = await core.publicCopyFiles(FIXTURE_RUST_GAME.name);
    for (const file of ["index.html", "game.js", "game_bg.wasm"]) assert.ok(review.included.includes(file), file);
    const sources = review.included.filter(
      (file) => file === "genex.toml" || /^(src|target|engine)\//.test(file) || file.endsWith(".rs"),
    );
    assert.deepEqual(sources, [], "no source, build folder or genex.toml goes online");
  });

  it("refuses a Rust game whose destinations hold no Browser: no-web-export, before anyone is asked", async () => {
    const lite = await coreLite({ gamesRoot: await realpath(await tmpDir("genex-publish-rust-")) });
    await lite.core.games.scaffold("ferris-desk", {
      title: "Ferris Desk",
      stack: GameStack.RustWgpu,
      targets: [BuildTarget.Mac],
    });
    await assert.rejects(assertPublishable(lite.core, "ferris-desk"), refusedNoWebExport);
  });

  it("refuses a Rust game that declares native-only GPU features: it has no web build", async () => {
    const { core } = await rustCore();
    const toml = path.join(core.games.dirFor(FIXTURE_RUST_GAME.name), "genex.toml");
    await writeFile(toml, `${await readFile(toml, "utf8")}\n[gpu]\nnative_features = ["subgroup"]\n`);
    await assert.rejects(assertPublishable(core, FIXTURE_RUST_GAME.name), refusedNoWebExport);
  });
});

describe("a networked Rust game's matchmaking reaches Genex from genex.toml (G6 MP-5c)", () => {
  const GAME = '[game]\ntitle = "Tag"\n';

  async function gameWith(toml: string, files: Record<string, string> = {}): Promise<string> {
    const dir = path.join(await realpath(await tmpDir("genex-rust-manifest-")), "tag");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "genex.toml"), toml);
    for (const [rel, text] of Object.entries(files)) await writeFile(path.join(dir, rel), text);
    return dir;
  }

  it("carries [net.matchmaking] as genex.matchmaking, in Genex's spelling", async () => {
    const dir = await gameWith(
      `${GAME}[net]\nenabled = true\n[net.matchmaking]\npreset = "arena"\nwin_condition = "firstToScore"\n[net.matchmaking.config]\nmaxPlayers = 8\n`,
    );
    assert.deepEqual(await readGenexGameManifest(dir), {
      dependencies: {},
      genex: { matchmaking: { preset: "arena", winCondition: "firstToScore", config: { maxPlayers: 8 } } },
    });
  });

  it("carries nothing for a game without networking, without matchmaking, or with a genex.toml that does not parse", async () => {
    for (const toml of [
      GAME,
      `${GAME}[net]\nenabled = true\n`,
      `${GAME}[net]\nenabled = false\n[net.matchmaking]\npreset = "open"\n`,
      `${GAME}[net]\nenabled = "yes"\n`,
    ]) {
      assert.equal(await readGenexGameManifest(await gameWith(toml)), undefined, toml);
    }
  });

  it("a package.json's own Genex block still wins", async () => {
    const dir = await gameWith(`${GAME}[net]\nenabled = true\n[net.matchmaking]\npreset = "arena"\n`, {
      "package.json": JSON.stringify({ genex: { matchmaking: { preset: "duel" } } }),
    });
    assert.deepEqual(await readGenexGameManifest(dir), {
      dependencies: {},
      genex: { matchmaking: { preset: "duel" } },
    });
  });

  it("never reads a genex.toml through a link", async () => {
    const outside = await gameWith(`${GAME}[net]\nenabled = true\n[net.matchmaking]\npreset = "arena"\n`);
    const dir = path.join(await realpath(await tmpDir("genex-rust-manifest-")), "linked");
    await mkdir(dir);
    await symlink(path.join(outside, "genex.toml"), path.join(dir, "genex.toml"));
    assert.equal(await readGenexGameManifest(dir), undefined);
  });
});

describe("the slug a networked export bakes in is the game's Genex binding (G6 MP-5c, hostile table)", () => {
  async function storageWith(project: string, meta: unknown): Promise<string> {
    const root = await realpath(await tmpDir("genex-binding-"));
    const dir = path.join(root, "publish", project, ".genex");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "project.json"), JSON.stringify(meta));
    return root;
  }

  it("reads the draft's slug from the publish workspace", async () => {
    const root = await storageWith("tag", { id: "p1", slug: "tag-run" });
    assert.equal(await genexDraftSlug(root, "tag"), "tag-run");
  });

  it("answers none for no draft, a malformed record, or a project name that is a path", async () => {
    const root = await storageWith("tag", { id: "p1", slug: "tag-run" });
    assert.equal(await genexDraftSlug(root, "other"), null);
    for (const project of ["", "..", "../tag", "tag/..", "a/b", ".genex", "tag\u0000"]) {
      assert.equal(await genexDraftSlug(root, project), null, JSON.stringify(project));
    }
    for (const meta of [null, [], { id: "p1" }, { slug: 7 }, { slug: "" }]) {
      assert.equal(await genexDraftSlug(await storageWith("tag", meta), "tag"), null, JSON.stringify(meta));
    }
  });

  it("never reads a binding through a link", async () => {
    const real = await storageWith("tag", { id: "p1", slug: "tag-run" });
    const root = await realpath(await tmpDir("genex-binding-"));
    await mkdir(path.join(root, "publish", "tag"), { recursive: true });
    await symlink(path.join(real, "publish", "tag", ".genex"), path.join(root, "publish", "tag", ".genex"));
    assert.equal(await genexDraftSlug(root, "tag"), null);
  });
});

/**
 * Play offers Remix only for a game whose source on Genex holds a game. A game whose creator never
 * shared its project has a README or a publish's bookkeeping as its source; its card and its viewer
 * show no Remix. Main asks git for the source's head and, once per commit, for its file names, keeps
 * the answer by commit and trusts it a while; a look that fails says no and keeps nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sourceHoldsGame } from "../../src/main/play/game-source.ts";
import {
  type KeptReadiness,
  READY_TRUST_MS,
  readyFor,
  remixReadiness,
  type SourceListing,
  withReadyRemix,
} from "../../src/main/play/remix-ready.ts";

const SOURCE = "https://git.genex.games/u-abc/megastructure.git";
const OTHER = "https://git.genex.games/u-abc/lost-cathedral.git";
/** The source of a game Studio published before its project could go: its publish's bookkeeping. */
const BOOKKEEPING = [
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "publish.json",
  "src/genex.config.ts",
  ".genex-agent/skills/x.md",
];
const BOOKKEEPING_PACKAGE = '{"name":"game-","private":true,"dependencies":{"@genex-ai/embed-sdk":"0.33.0"}}';

describe("a source that holds a game", () => {
  it("is known by its record, its page, the packages that build it, or an engine's project near the top", () => {
    const games: Array<[string, string[], string | null]> = [
      ["a Genex game's record", ["studio.json", "unity/Assets/Main.unity"], null],
      ["a page at its root", ["index.html", "src/main.js"], null],
      ["packages that build it", ["package.json", "src/main.ts"], '{"scripts":{"build":"vite build"}}'],
      ["a Unity project", ["unity/ProjectSettings/ProjectVersion.txt"], null],
      ["a Unity project two folders down", ["game/unity/ProjectSettings/ProjectVersion.txt"], null],
      ["a Godot project", ["godot/project.godot"], null],
      ["an Unreal project", ["Arena/Arena.uproject"], null],
      ["a Roblox place", ["place.rbxlx"], null],
      ["a Roblox game kept as files (Rojo)", ["game/default.project.json", "game/src/server/init.server.luau"], null],
    ];
    for (const [why, paths, pkg] of games) assert.equal(sourceHoldsGame(paths, pkg), true, why);
    const none: Array<[string, string[], string | null]> = [
      ["a README alone", ["README.md"], null],
      ["a publish's bookkeeping", BOOKKEEPING, BOOKKEEPING_PACKAGE],
      ["a package.json that runs nothing", ["package.json"], '{"dependencies":{}}'],
      ["a package.json that is not JSON", ["package.json"], "{"],
      ["a page that is not at the root", ["docs/index.html"], null],
      ["an engine mark too deep", ["a/b/c/ProjectSettings/ProjectVersion.txt", "a/b/c/project.godot"], null],
      [
        "an engine mark in a hidden folder",
        [".cache/ProjectSettings/ProjectVersion.txt", "node_modules/x/x.uproject"],
        null,
      ],
    ];
    for (const [why, paths, pkg] of none) assert.equal(sourceHoldsGame(paths, pkg), false, why);
  });
});

/** A readiness on a fake git: heads and listings by address, every call counted, on a clock the test moves. */
function fakeReadiness(
  options: { heads?: Record<string, string | null>; listings?: Record<string, SourceListing> } = {},
) {
  const heads: Record<string, string | null> = { [SOURCE]: "a".repeat(40), [OTHER]: "b".repeat(40), ...options.heads };
  const listings: Record<string, SourceListing> = {
    [SOURCE]: { paths: ["README.md"], packageJson: null },
    [OTHER]: { paths: ["index.html"], packageJson: null },
    ...options.listings,
  };
  const calls = { head: [] as string[], list: [] as string[], saves: 0 };
  let now = 1_000;
  let kept: Record<string, KeptReadiness> = {};
  let listing = 0;
  let mostAtOnce = 0;
  const readiness = remixReadiness({
    head: async (url) => {
      calls.head.push(url);
      const head = heads[url];
      if (head === undefined) throw new Error("git could not say");
      return head;
    },
    list: async (url) => {
      calls.list.push(url);
      listing += 1;
      mostAtOnce = Math.max(mostAtOnce, listing);
      await Promise.resolve();
      listing -= 1;
      const found = listings[url];
      if (!found) throw new Error("clone failed");
      return found;
    },
    load: async () => kept,
    save: async (next) => {
      calls.saves += 1;
      kept = structuredClone(next);
    },
    now: () => now,
  });
  return {
    readiness,
    calls,
    heads,
    advance: (ms: number) => {
      now += ms;
    },
    kept: () => kept,
    mostAtOnce: () => mostAtOnce,
  };
}

describe("Play's look at a game's source", () => {
  it("says no for a README, yes for a game, and keeps each answer by commit", async () => {
    const fake = fakeReadiness();
    assert.equal(await fake.readiness.ready(SOURCE), false);
    assert.equal(await fake.readiness.ready(OTHER), true);
    assert.deepEqual(fake.kept()[SOURCE], { head: "a".repeat(40), holds: false, at: 1_000 });
  });

  it("trusts a kept answer a while, then asks for the head again and lists only a new commit", async () => {
    const fake = fakeReadiness();
    await fake.readiness.ready(SOURCE);
    await fake.readiness.ready(SOURCE);
    assert.deepEqual(fake.calls.head, [SOURCE], "trusted for a while");
    fake.advance(READY_TRUST_MS);
    assert.equal(await fake.readiness.ready(SOURCE), false);
    assert.deepEqual(fake.calls.list, [SOURCE], "the same commit is not listed again");
    fake.heads[SOURCE] = "c".repeat(40);
    fake.advance(READY_TRUST_MS);
    assert.equal(await fake.readiness.ready(SOURCE), false);
    assert.equal(fake.calls.list.length, 2, "a new commit is listed");
  });

  it("says no and keeps nothing when git can't say, so the next look tries again", async () => {
    const fake = fakeReadiness({ heads: { [SOURCE]: undefined as unknown as string } });
    assert.equal(await fake.readiness.ready(SOURCE), false);
    assert.equal(fake.kept()[SOURCE], undefined);
    const unlisted = fakeReadiness({ listings: { [OTHER]: undefined as unknown as SourceListing } });
    assert.equal(await unlisted.readiness.ready(OTHER), false);
    assert.equal(unlisted.kept()[OTHER], undefined);
  });

  it("never asks git about an address that is not Genex's https git", async () => {
    const fake = fakeReadiness();
    for (const url of ["file:///tmp/x.git", "https://evil.example/u/x.git", "ssh://git.genex.games/u/x.git", "-c x=y"])
      assert.equal(await fake.readiness.ready(url), false, url);
    assert.deepEqual(fake.calls.head, []);
  });

  it("looks at one source once however many cards ask, and at a few sources at a time", async () => {
    const urls = Array.from({ length: 12 }, (_, n) => `https://git.genex.games/u-abc/game-${n}.git`);
    const heads = Object.fromEntries(urls.map((url, n) => [url, String(n).padStart(40, "0")]));
    const listings = Object.fromEntries(urls.map((url) => [url, { paths: ["studio.json"], packageJson: null }]));
    const fake = fakeReadiness({ heads, listings });
    const answers = await Promise.all([...urls, ...urls].map((url) => fake.readiness.ready(url)));
    assert.ok(answers.every(Boolean));
    assert.equal(fake.calls.list.length, urls.length, "each source listed once");
    assert.ok(fake.mostAtOnce() <= 4, `at most 4 at once, saw ${fake.mostAtOnce()}`);
  });
});

describe("what Play asks for its cards and its viewer", () => {
  it("answers by slug from the catalog's address, else the game's page, and drops what is not a slug", async () => {
    const fake = fakeReadiness();
    const worlds: string[] = [];
    const answers = await readyFor(["megastructure", "lost-cathedral", "gone", "../x", 7], fake.readiness, {
      sourceOf: (slug) => (slug === "megastructure" ? SOURCE : null),
      world: async (slug) => {
        worlds.push(slug);
        if (slug === "gone") throw new Error("404");
        return { cloneUrl: OTHER };
      },
    });
    assert.deepEqual(answers, { megastructure: false, "lost-cathedral": true, gone: false });
    assert.deepEqual(worlds, ["lost-cathedral", "gone"]);
  });

  it("gives the viewer a page whose Remix shows only when the source holds a game", async () => {
    const fake = fakeReadiness();
    const pages: Record<string, { remixable: boolean; cloneUrl: string | null }> = {
      megastructure: { remixable: true, cloneUrl: SOURCE },
      "lost-cathedral": { remixable: true, cloneUrl: OTHER },
      private: { remixable: false, cloneUrl: null },
    };
    const gallery = withReadyRemix({ world: async (slug: string) => pages[slug] ?? pages.private }, fake.readiness);
    assert.equal((await gallery.world("megastructure")).remixable, false);
    assert.equal((await gallery.world("lost-cathedral")).remixable, true);
    assert.equal((await gallery.world("private")).remixable, false);
    assert.deepEqual(fake.calls.head, [SOURCE, OTHER], "a game no one may remix is not looked at");
  });
});

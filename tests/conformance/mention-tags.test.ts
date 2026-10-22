/**
 * A message's @ tags made real (src/main/core/mention-tags.ts): local games become read roots,
 * genex.games sources are copied under `.studio/refs/`, assets are added to `src/assets/`, and
 * anything that can't be attached is named without writing anything.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { NotInLibrary } from "../../src/main/core/library-sharing.ts";
import {
  ASSET_MODULE_MAX_BYTES,
  assetModule,
  type MentionSources,
  type MentionTarget,
  resolveMentions,
} from "../../src/main/core/mention-tags.ts";
import {
  MENTION_CONTEXT_HEADING,
  MentionKind,
  MentionMiss,
  MentionOrigin,
  type MentionRef,
  MentionResult,
  mentionRef,
  pluginDoc,
  readMentionRefs,
  withoutMentionContext,
} from "../../src/shared/prompt-mention.ts";
import { removeAll, tmpDir } from "../helpers/tmp.ts";

const made: string[] = [];
after(() => removeAll(made));

async function game(): Promise<{ root: string; target: MentionTarget }> {
  const root = await tmpDir("mention-tags-");
  made.push(root);
  const gameDir = path.join(root, "racer");
  await mkdir(gameDir, { recursive: true });
  const library = new Map([["Neon Racer", path.join(root, "neon-racer")]]);
  return {
    root,
    target: { project: "racer", gameDir, webGame: true, libraryDir: async (name) => library.get(name) ?? null },
  };
}

const manifest = (over: Record<string, unknown> = {}) => ({
  manifest: {
    source: { code: "export const fireplace = 1;\n", filename: "stoneFireplace.ts", ...over },
    usage: { promptHint: "Metres, Y-up." },
  },
});

function sources(over: Partial<MentionSources> = {}): MentionSources & { clones: string[]; added: string[][] } {
  const clones: string[] = [];
  const added: string[][] = [];
  return {
    clones,
    added,
    world: async (slug) => ({
      title: slug,
      remixable: slug !== "closed",
      cloneUrl: `https://git.genex.games/someone/${slug}.git`,
      authorId: slug === "mine" ? "me" : "someone",
    }),
    me: async () => "me",
    clone: async (url, dest) => {
      clones.push(url);
      await mkdir(path.join(dest, ".git"), { recursive: true });
      await writeFile(path.join(dest, "main.ts"), "// the author's code\n");
    },
    assetManifest: async () => manifest(),
    addFromLibrary: async (project, generationId) => {
      added.push([project, generationId]);
      return [`assets/library/job-1/${generationId}.glb`];
    },
    ...over,
  };
}

/** Every name under `dir`, recursively, sorted. */
async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

const ref = (over: Partial<MentionRef> & { handle: string }): MentionRef => ({
  kind: MentionKind.Game,
  origin: MentionOrigin.Genex,
  title: over.handle,
  slug: over.handle,
  ...over,
});

describe("resolving @ tags", () => {
  it("a local game becomes a read root and a line naming its folder", async () => {
    const { root, target } = await game();
    const tags = await resolveMentions(
      [ref({ handle: "neon-racer", origin: MentionOrigin.Local, game: "Neon Racer", slug: undefined })],
      target,
      sources(),
    );
    assert.deepEqual(tags.readRoots, [path.join(root, "neon-racer")]);
    assert.equal(tags.outcomes[0]?.result, MentionResult.Read);
    assert.ok(tags.context.startsWith(MENTION_CONTEXT_HEADING));
    assert.match(tags.context, /neon-racer/);
  });

  it("a genex.games game is copied under .studio/refs without its history, replacing an older copy", async () => {
    const { target } = await game();
    const stale = path.join(target.gameDir, ".studio/refs/neon-rush");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "old.ts"), "old");
    const tags = await resolveMentions([ref({ handle: "neon-rush" })], target, sources());
    assert.deepEqual(tags.outcomes[0], {
      handle: "neon-rush",
      title: "neon-rush",
      kind: MentionKind.Game,
      origin: MentionOrigin.Genex,
      slug: "neon-rush",
      result: MentionResult.Copied,
      path: ".studio/refs/neon-rush",
    });
    assert.deepEqual(await readdir(stale), ["main.ts"]);
    assert.deepEqual(tags.readRoots, []);
  });

  it("the person's own game is copied even when it is not remixable", async () => {
    const { target } = await game();
    const own = await resolveMentions(
      [ref({ handle: "mine" })],
      target,
      sources({ world: async () => ({ title: "Mine", remixable: false, cloneUrl: "u", authorId: "me" }) }),
    );
    assert.equal(own.outcomes[0]?.result, MentionResult.Copied);
  });

  it("an asset's module is added under a free name with its header and usage", async () => {
    const { target } = await game();
    const assets = path.join(target.gameDir, "src/assets");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, "stoneFireplace.ts"), "mine");
    const tags = await resolveMentions(
      [ref({ handle: "stone-fireplace", kind: MentionKind.Asset })],
      target,
      sources(),
    );
    assert.equal(tags.outcomes[0]?.path, "src/assets/stoneFireplace-2.ts");
    assert.equal(await readFile(path.join(assets, "stoneFireplace.ts"), "utf8"), "mine");
    assert.match(
      await readFile(path.join(assets, "stoneFireplace-2.ts"), "utf8"),
      /Genex asset library[\s\S]*fireplace = 1/,
    );
    assert.match(tags.context, /Metres, Y-up\./);
  });

  it("refuses hostile or unavailable tags without writing anything", async () => {
    const cases: {
      name: string;
      ref: MentionRef;
      over?: Partial<MentionSources>;
      webGame?: boolean;
      miss: MentionMiss;
    }[] = [
      {
        name: "unknown local game",
        ref: ref({ handle: "x", origin: MentionOrigin.Local, game: "../racer" }),
        miss: MentionMiss.Gone,
      },
      { name: "slug with a path", ref: ref({ handle: "x", slug: "../../etc" }), miss: MentionMiss.Gone },
      { name: "not remixable", ref: ref({ handle: "closed" }), miss: MentionMiss.NotTakeable },
      {
        name: "clone fails",
        ref: ref({ handle: "flaky" }),
        over: { clone: () => Promise.reject(new Error("timed out")) },
        miss: MentionMiss.NotDownloaded,
      },
      {
        name: "module name escapes",
        ref: ref({ handle: "evil", kind: MentionKind.Asset }),
        over: { assetManifest: async () => manifest({ filename: "../../evil.ts" }) },
        miss: MentionMiss.NotDownloaded,
      },
      {
        name: "module too large",
        ref: ref({ handle: "big", kind: MentionKind.Asset }),
        over: { assetManifest: async () => manifest({ code: "x".repeat(ASSET_MODULE_MAX_BYTES + 1) }) },
        miss: MentionMiss.NotDownloaded,
      },
      {
        name: "asset in an engine game",
        ref: ref({ handle: "chair", kind: MentionKind.Asset }),
        webGame: false,
        miss: MentionMiss.NotWebGame,
      },
    ];
    for (const item of cases) {
      const { root, target } = await game();
      const tags = await resolveMentions([item.ref], { ...target, webGame: item.webGame ?? true }, sources(item.over));
      assert.equal(tags.outcomes[0]?.result, MentionResult.Unavailable, item.name);
      assert.equal(tags.outcomes[0]?.miss, item.miss, item.name);
      assert.deepEqual(tags.readRoots, [], item.name);
      assert.match(tags.context, /could not be attached/, item.name);
      const refs = await readdir(path.join(target.gameDir, ".studio/refs")).catch(() => []);
      assert.deepEqual(refs, [], `${item.name}: no copy left behind`);
      assert.deepEqual(await readdir(root), ["racer"], `${item.name}: nothing outside the game`);
      await readdir(path.join(target.gameDir, "src/assets")).then(
        (files) => assert.deepEqual(files, [], item.name),
        () => {},
      );
    }
  });

  it("never makes, removes or writes anything through a link planted in the game folder", async () => {
    const cases: { name: string; link: string; to: string; ref: MentionRef }[] = [
      { name: "refs folder is a link", link: ".studio/refs", to: "", ref: ref({ handle: "space-race" }) },
      { name: ".studio is a link", link: ".studio", to: "", ref: ref({ handle: "space-race" }) },
      {
        name: "the copy's folder is a link",
        link: ".studio/refs/space-race",
        to: "space-race",
        ref: ref({ handle: "space-race" }),
      },
      {
        name: "assets folder is a link",
        link: "src/assets",
        to: "",
        ref: ref({ handle: "stone-fireplace", kind: MentionKind.Asset }),
      },
      { name: "src is a link", link: "src", to: "", ref: ref({ handle: "stone-fireplace", kind: MentionKind.Asset }) },
    ];
    for (const item of cases) {
      const { root, target } = await game();
      const outside = path.join(root, "AI Games");
      await mkdir(path.join(outside, "space-race"), { recursive: true });
      await writeFile(path.join(outside, "space-race", "keep.ts"), "theirs");
      const before = await listing(outside);
      const link = path.join(target.gameDir, item.link);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(path.join(outside, item.to), link);
      const tags = await resolveMentions([item.ref], target, sources());
      assert.equal(tags.outcomes[0]?.result, MentionResult.Unavailable, item.name);
      assert.equal(tags.outcomes[0]?.miss, MentionMiss.NotDownloaded, item.name);
      assert.deepEqual(await listing(outside), before, `${item.name}: nothing outside the game changed`);
      assert.equal(await readFile(path.join(outside, "space-race", "keep.ts"), "utf8"), "theirs", item.name);
    }
  });

  it("a plugin tag names the plugin to the agent and fetches nothing", async () => {
    const { target } = await game();
    const tag = pluginDoc({ id: "local-blender", name: "Local Blender" });
    assert.equal(tag.handle, "local-blender");
    const tags = await resolveMentions(
      [mentionRef(tag)],
      target,
      sources({ clone: () => Promise.reject(new Error("no")) }),
    );
    assert.equal(tags.outcomes[0]?.result, MentionResult.Read);
    assert.equal(tags.outcomes[0]?.plugin, "local-blender");
    assert.deepEqual(tags.readRoots, []);
    assert.match(tags.context, /@local-blender \(plugin "Local Blender"\): a plugin that is on/);
  });

  it("a library asset is copied into the game through the library and named to the agent", async () => {
    const { target } = await game();
    const from = sources();
    const generation = "gen-mushroom-01";
    const tags = await resolveMentions(
      [ref({ handle: "giant-mushroom-tree", kind: MentionKind.Asset, origin: MentionOrigin.Library, generation })],
      { ...target, webGame: false },
      from,
    );
    assert.deepEqual(from.added, [["racer", generation]]);
    assert.equal(tags.outcomes[0]?.result, MentionResult.Added);
    assert.equal(tags.outcomes[0]?.path, `assets/library/job-1/${generation}.glb`);
    assert.equal(tags.outcomes[0]?.generation, generation);
    assert.match(tags.context, /Genex library[\s\S]*assets\/library\/job-1\/gen-mushroom-01\.glb/);
  });

  it("a library tag that can't be added is a miss, and a bad generation is refused before any call", async () => {
    const library = (generation?: string) =>
      ref({
        handle: "tree",
        kind: MentionKind.Asset,
        origin: MentionOrigin.Library,
        ...(generation ? { generation } : {}),
      });
    const cases: { name: string; ref: MentionRef; answer?: () => Promise<string[]>; miss: MentionMiss }[] = [
      { name: "no generation", ref: library(), miss: MentionMiss.Gone },
      { name: "a path for a generation", ref: library("../../etc/passwd"), miss: MentionMiss.Gone },
      { name: "a short generation", ref: library("abc"), miss: MentionMiss.Gone },
      {
        name: "not in the library",
        ref: library("gen-gone-0001"),
        answer: () => Promise.reject(new NotInLibrary()),
        miss: MentionMiss.Gone,
      },
      {
        name: "download refused",
        ref: library("gen-flaky-001"),
        answer: () => Promise.reject(new Error("timed out")),
        miss: MentionMiss.NotDownloaded,
      },
      {
        name: "nothing landed",
        ref: library("gen-empty-001"),
        answer: async () => [],
        miss: MentionMiss.NotDownloaded,
      },
    ];
    for (const item of cases) {
      const { target } = await game();
      const calls: string[] = [];
      const answer = item.answer ?? (async () => ["assets/library/x/tree.glb"]);
      const from = sources({
        addFromLibrary: (_project, generationId) => {
          calls.push(generationId);
          return answer();
        },
      });
      const tags = await resolveMentions([item.ref], target, from);
      assert.equal(tags.outcomes[0]?.result, MentionResult.Unavailable, item.name);
      assert.equal(tags.outcomes[0]?.miss, item.miss, item.name);
      assert.deepEqual(calls, item.answer && item.ref.generation ? [item.ref.generation] : [], `${item.name}: calls`);
      assert.deepEqual(from.clones, [], item.name);
      assert.match(tags.context, /could not be attached/, item.name);
    }
  });

  it("a message with no tags adds nothing", async () => {
    const { target } = await game();
    assert.deepEqual(await resolveMentions([], target, sources()), { readRoots: [], context: "", outcomes: [] });
  });
});

describe("tag input and the agent's lines", () => {
  it("reads a library tag's generation only when it is a generation id", () => {
    const library = { handle: "tree", kind: "asset", origin: "library", title: "Tree", generation: "gen-mushroom-01" };
    assert.deepEqual(readMentionRefs([library]), [library]);
    const hostile = ["../../etc", "a b c d e f g h", "x".repeat(65), 42, null, "short"];
    for (const generation of hostile) {
      const [read] = readMentionRefs([{ ...library, generation }]);
      assert.ok(read, String(generation));
      assert.equal("generation" in read, false, String(generation));
    }
    assert.deepEqual(readMentionRefs([{ ...library, origin: "library-plus" }]), []);
    assert.deepEqual(readMentionRefs([{ ...library, origin: "Library" }]), []);
  });

  it("reads only well-formed tags from the renderer, at most five", () => {
    const good = { handle: "a", kind: "game", origin: "genex", title: "A", slug: "a" };
    assert.deepEqual(readMentionRefs([good, { ...good, handle: "Bad Handle" }, { ...good, kind: "weapon" }, 7, null]), [
      good,
    ]);
    assert.equal(readMentionRefs(Array.from({ length: 9 }, (_, i) => ({ ...good, handle: `a${i}` }))).length, 5);
    assert.deepEqual(readMentionRefs("nope"), []);
  });

  it("the chat shows the words without the tags' lines", () => {
    assert.equal(withoutMentionContext(`mix @a${MENTION_CONTEXT_HEADING}- @a: …`), "mix @a");
    assert.equal(withoutMentionContext("plain"), "plain");
  });

  it("a module needs code and a plain file name", () => {
    assert.equal(assetModule({}), null);
    assert.equal(assetModule(manifest({ filename: "a b.ts" })), null);
    assert.deepEqual(assetModule(manifest()), {
      code: "export const fireplace = 1;\n",
      filename: "stoneFireplace.ts",
      usage: "Metres, Y-up.",
    });
  });
});

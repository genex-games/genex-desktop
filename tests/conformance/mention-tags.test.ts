/**
 * A message's @ tags made real (src/main/core/mention-tags.ts): local games become read roots,
 * genex.games sources are copied under `.studio/refs/`, assets are added to `src/assets/`, and
 * anything that can't be attached is named without writing anything.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
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
    target: { gameDir, webGame: true, libraryDir: async (name) => library.get(name) ?? null },
  };
}

const manifest = (over: Record<string, unknown> = {}) => ({
  manifest: {
    source: { code: "export const fireplace = 1;\n", filename: "stoneFireplace.ts", ...over },
    usage: { promptHint: "Metres, Y-up." },
  },
});

function sources(over: Partial<MentionSources> = {}): MentionSources & { clones: string[] } {
  const clones: string[] = [];
  return {
    clones,
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

  it("a message with no tags adds nothing", async () => {
    const { target } = await game();
    assert.deepEqual(await resolveMentions([], target, sources()), { readRoots: [], context: "", outcomes: [] });
  });
});

describe("tag input and the agent's lines", () => {
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

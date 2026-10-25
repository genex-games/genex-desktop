/**
 * Store items made before a game is on Genex (contract "Local item drafts"). The CLI keeps them in
 * the game's `.genex/items/` (`<localId>.json` and a `<localId>/` folder of its files), but Studio
 * never runs the CLI in the game (`genex-cli.ts`): it copies the game's local drafts into the run
 * folder, and after a `shop add|set|remove` carries what the CLI changed back into the game, never
 * through a link and never anything that is not a draft. Studio's own `shop sync` (after a publish)
 * sees the game's drafts the same way and takes the uploaded ones out of the game afterwards. The
 * person's "Other games can use it" on a local draft is main's own `shop set`, never the agent's.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { boundGameFolder } from "../../src/main/core/genex-bound-game.ts";
import { GenexCliService } from "../../src/main/core/genex-cli.ts";
import { GenexCliRefusal, GenexCliRefusalCode, genexCliRequest } from "../../src/main/core/genex-cli-policy.ts";
import { hasLocalDrafts, localDraftFingerprint } from "../../src/main/core/local-item-files.ts";
import { ITEM_DRAFT_KIND, ITEM_DRAFT_VERSION, type ListingRecord } from "../../src/shared/item-draft.ts";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import { StoreRefusal } from "../../src/shared/store-items.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ICE = "local_ab12cd34ef56";
const SLED = "local_0123456789ab";
const HASH = "3f9a".repeat(16);
const NEW_HASH = "b".repeat(64);
const ITEMS = [".genex", "items"] as const;

/** A profile with the game `space-race`, not on Genex unless `linked`, and a folder beside the games. */
async function profile(options: { linked?: boolean } = {}) {
  const root = await realpath(await tmpDir("genex-cli-local-"));
  const userData = path.join(root, "userData");
  const genexStorage = path.join(userData, "engine-homes", "genex");
  const gamesRoot = path.join(root, "AI Games");
  const game = path.join(gamesRoot, "space-race");
  const outside = path.join(root, "elsewhere");
  for (const dir of [path.join(game, ".genex", "scratch"), outside, path.join(root, "resources")])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(game, ".genex", "scratch", "ice.png"), "PNG-ice");
  await writeFile(path.join(outside, "secret.png"), "SECRET");
  if (options.linked) {
    const hosted = path.join(genexStorage, "publish", "space-race", ".genex");
    await mkdir(hosted, { recursive: true });
    await writeFile(path.join(hosted, "project.json"), JSON.stringify({ id: "proj_1", slug: "space-race-x1" }));
  }
  return { root, userData, genexStorage, gamesRoot, game, outside, scratch: path.join(userData, "scratch") };
}
type Profile = Awaited<ReturnType<typeof profile>>;

/** A local draft's files as the CLI writes them, under `items` (a game's or a run folder's `.genex/items`). */
async function writeDraft(items: string, localId: string, fields: Record<string, unknown> = {}, picture = "PNG-ice") {
  await mkdir(path.join(items, localId), { recursive: true });
  const draft = {
    localId,
    name: "Ice Shield",
    priceCoins: 300,
    type: "durable",
    tags: [],
    shareable: false,
    ...fields,
  };
  await writeFile(path.join(items, `${localId}.json`), JSON.stringify({ ...draft, files: { image: "picture.png" } }));
  await writeFile(path.join(items, localId, "picture.png"), picture);
}

/** Every file and link under `dir`, relative, with a file's text or a link's target: a tree to compare. */
async function tree(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isSymbolicLink()) out[rel] = "-> link";
    else if (entry.isDirectory()) Object.assign(out, await tree(full, base));
    else out[rel] = await readFile(full, "utf8");
  }
  return out;
}

/** The CLI's `--json` line for a local draft. */
const localLine = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: ITEM_DRAFT_KIND,
    version: ITEM_DRAFT_VERSION,
    state: "local",
    localId: ICE,
    name: "Ice Shield",
    priceCoins: 300,
    type: "durable",
    tags: [],
    shareable: false,
    contentHash: HASH,
    ...fields,
  });

/** What one run saw: its request, and the run folder's `.genex` as the CLI found it. */
interface Seen {
  request: RunRequest;
  genex: Record<string, string>;
}

/**
 * A sandbox that runs nothing: it records each run and the run folder's `.genex` then, lets `act`
 * play the CLI in the run folder, and answers `stdout` with `code`.
 */
function fakeSandbox(
  options: { stdout?: string; code?: number; act?: (cwd: string, request: RunRequest) => Promise<void> } = {},
) {
  const seen: Seen[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    seen.push({ request, genex: await tree(path.join(request.cwd, ".genex")) });
    await options.act?.(request.cwd, request);
    return {
      code: options.code ?? 0,
      signal: null,
      stdout: options.stdout ?? "{}",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      command: request.command,
      cwd: request.cwd,
    };
  };
  return { run, seen };
}

function service(
  p: Profile,
  sandbox: { run: (r: RunRequest) => Promise<RunResult> },
  drafts: Array<{ draft: ListingRecord; fingerprint: string | null }> = [],
  removed: string[][] = [],
) {
  return new GenexCliService({
    run: sandbox.run,
    credentialFile: async () => "GENEX_TOKEN=tok-synthetic\n",
    heldCredentials: () => ["tok-synthetic"],
    runsRoot: path.join(p.userData, "genex-cli"),
    resources: path.join(p.root, "resources"),
    genexStorage: p.genexStorage,
    protectedWrites: () => [p.gamesRoot, p.game],
    boundGame: (binding) =>
      boundGameFolder(binding, { gameDir: (name) => path.join(p.gamesRoot, name), scratch: p.scratch }),
    gameFolder: (name) => realpath(path.join(p.gamesRoot, name)),
    onListingDraft: async (draft, _binding, fingerprint) => {
      drafts.push({ draft, fingerprint: fingerprint ?? null });
    },
    onLocalDraftsRemoved: async (_project, localIds) => {
      removed.push([...localIds]);
    },
  });
}

const bound = (p: Profile, directory = p.game): PluginBinding => ({ project: "space-race", directory, threadId: "t1" });
const gameItems = (p: Profile) => path.join(p.game, ...ITEMS);
const runsLeft = (p: Profile) => readdir(path.join(p.userData, "genex-cli")).catch(() => []);

describe("a local `shop add` in a game that is not on Genex yet", () => {
  it("runs with no hosted project, and carries the CLI's draft into the game's .genex/items/", async () => {
    const p = await profile();
    const drafts: Array<{ draft: ListingRecord; fingerprint: string | null }> = [];
    const sandbox = fakeSandbox({
      stdout: localLine(),
      act: (cwd) => writeDraft(path.join(cwd, ...ITEMS), ICE),
    });
    const answer = await service(p, sandbox, drafts).run(
      { command: "shop add", args: "Ice Shield", options: { price: 300, image: ".genex/scratch/ice.png" } },
      bound(p),
      { paid: false },
    );
    assert.equal(answer.ok, true);
    const [run] = sandbox.seen;
    assert.ok(run);
    assert.equal(run.genex["project.json"], undefined, "no hosted project in the run folder");
    const items = await tree(gameItems(p));
    assert.deepEqual(Object.keys(items).sort(), [`${ICE}.json`, path.join(ICE, "picture.png")]);
    assert.equal(items[path.join(ICE, "picture.png")], "PNG-ice");
    assert.equal(drafts.length, 1, "its card goes up");
    assert.equal(drafts[0]?.draft.state, "local");
    assert.equal(
      drafts[0]?.fingerprint,
      await localDraftFingerprint(gameItems(p), ICE),
      "with what the game now holds",
    );
    assert.deepEqual(await runsLeft(p), [], "the run folder is gone");
  });

  it("refuses, before anything runs, a call bound to a folder that is not the game", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({ stdout: localLine() });
    await assert.rejects(
      service(p, sandbox).run(
        { command: "shop add", args: "Ice Shield", options: { price: 300 } },
        bound(p, p.outside),
        {
          paid: false,
        },
      ),
      /not bound to the game's own folder/,
    );
    assert.equal(sandbox.seen.length, 0);
    assert.deepEqual(await tree(p.outside), { "secret.png": "SECRET" });
  });

  it("keeps a run that failed from changing the game", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({
      code: 1,
      stdout: "price must be a whole number",
      act: (cwd) => writeDraft(path.join(cwd, ...ITEMS), ICE),
    });
    const answer = await service(p, sandbox).run(
      { command: "shop add", args: "Ice Shield", options: { price: 300 } },
      bound(p),
      { paid: false },
    );
    assert.equal(answer.ok, false);
    assert.deepEqual(await tree(gameItems(p)), {});
  });
});

describe("a local `shop set` and `shop remove`", () => {
  it("lets the CLI see the game's drafts, and carries only what it changed back", async () => {
    const p = await profile();
    await writeDraft(gameItems(p), ICE);
    await writeDraft(gameItems(p), SLED, { name: "Oak Sled" }, "PNG-sled");
    await writeFile(path.join(gameItems(p), "notes.txt"), "mine");
    const sledBefore = await localDraftFingerprint(gameItems(p), SLED);
    const sandbox = fakeSandbox({
      stdout: localLine({ priceCoins: 250, contentHash: NEW_HASH }),
      act: async (cwd) => {
        const items = path.join(cwd, ...ITEMS);
        await rm(path.join(items, ICE), { recursive: true });
        await writeDraft(items, ICE, { priceCoins: 250 }, "PNG-ice-2");
      },
    });
    const drafts: Array<{ draft: ListingRecord; fingerprint: string | null }> = [];
    const answer = await service(p, sandbox, drafts).run(
      { command: "shop set", args: ICE, options: { price: 250 } },
      bound(p),
      { paid: true },
    );
    assert.equal(answer.ok, true);
    const [run] = sandbox.seen;
    assert.ok(run);
    assert.equal(
      run.genex[path.join("items", `${ICE}.json`)]?.includes('"priceCoins":300'),
      true,
      "the CLI saw the draft",
    );
    assert.equal(run.genex[path.join("items", "notes.txt")], undefined, "only drafts go into the run folder");
    const items = await tree(gameItems(p));
    assert.equal(items[path.join(ICE, "picture.png")], "PNG-ice-2");
    assert.match(items[`${ICE}.json`] ?? "", /"priceCoins":250/);
    assert.equal(items["notes.txt"], "mine", "what is not a draft stays");
    assert.equal(await localDraftFingerprint(gameItems(p), SLED), sledBefore, "the other draft is untouched");
    assert.equal(drafts[0]?.draft.state === "local" && drafts[0].draft.contentHash, NEW_HASH);
  });

  it("removes the draft the CLI removed, and names it to the host", async () => {
    const p = await profile();
    await writeDraft(gameItems(p), ICE);
    await writeDraft(gameItems(p), SLED, { name: "Oak Sled" });
    const removed: string[][] = [];
    const sandbox = fakeSandbox({
      stdout: "{}",
      act: async (cwd) => {
        const items = path.join(cwd, ...ITEMS);
        await rm(path.join(items, ICE), { recursive: true });
        await rm(path.join(items, `${ICE}.json`));
      },
    });
    const answer = await service(p, sandbox, [], removed).run({ command: "shop remove", args: ICE }, bound(p), {
      paid: true,
    });
    assert.equal(answer.ok, true);
    assert.deepEqual(Object.keys(await tree(gameItems(p))).sort(), [`${SLED}.json`, path.join(SLED, "picture.png")]);
    assert.deepEqual(removed, [[ICE]]);
  });

  it("never writes back what `shop list` did in the run folder", async () => {
    const p = await profile();
    await writeDraft(gameItems(p), ICE);
    const before = await tree(gameItems(p));
    const sandbox = fakeSandbox({
      stdout: "[]",
      act: async (cwd) => writeDraft(path.join(cwd, ...ITEMS), SLED),
    });
    const answer = await service(p, sandbox).run({ command: "shop list" }, bound(p), { paid: false });
    assert.equal(answer.ok, true);
    assert.deepEqual(Object.keys(sandbox.seen[0]?.genex ?? {}).sort(), [
      path.join("items", `${ICE}.json`),
      path.join("items", ICE, "picture.png"),
    ]);
    assert.deepEqual(await tree(gameItems(p)), before);
  });
});

describe("a `shop add` in a game that is on Genex", () => {
  it("runs on the hosted project as before, and leaves the game's drafts as they were", async () => {
    const p = await profile({ linked: true });
    await writeDraft(gameItems(p), ICE);
    const before = await tree(gameItems(p));
    const sandbox = fakeSandbox({ stdout: "{}" });
    const answer = await service(p, sandbox).run(
      { command: "shop add", args: "Frost Axe", options: { price: 1200 } },
      bound(p),
      { paid: false },
    );
    assert.equal(answer.ok, true);
    assert.match(sandbox.seen[0]?.genex["project.json"] ?? "", /proj_1/);
    assert.deepEqual(await tree(gameItems(p)), before);
  });
});

/** Hostile game folders: what Studio copies into the run folder from each, and what it leaves alone. */
const hostileGame: Array<[string, (p: Profile) => Promise<void>, string[]]> = [
  [
    ".genex/items as a link out of the game",
    async (p) => {
      await mkdir(path.join(p.outside, "items"), { recursive: true });
      await writeDraft(path.join(p.outside, "items"), ICE);
      await mkdir(path.join(p.game, ".genex"), { recursive: true });
      await symlink(path.join(p.outside, "items"), gameItems(p));
    },
    [],
  ],
  [
    "a draft file that is a link to a file outside",
    async (p) => {
      await writeDraft(gameItems(p), SLED);
      await mkdir(path.join(gameItems(p), ICE));
      await symlink(path.join(p.outside, "secret.png"), path.join(gameItems(p), `${ICE}.json`));
    },
    [SLED],
  ],
  [
    "a draft folder that is a link out of the game",
    async (p) => {
      await writeDraft(gameItems(p), SLED);
      await writeFile(path.join(gameItems(p), `${ICE}.json`), "{}");
      await symlink(p.outside, path.join(gameItems(p), ICE));
    },
    [SLED],
  ],
  [
    "a picture in a draft that is a link out of the game",
    async (p) => {
      await writeDraft(gameItems(p), ICE);
      await rm(path.join(gameItems(p), ICE, "picture.png"));
      await symlink(path.join(p.outside, "secret.png"), path.join(gameItems(p), ICE, "picture.png"));
    },
    [],
  ],
  [
    "a folder inside a draft's folder",
    async (p) => {
      await writeDraft(gameItems(p), ICE);
      await mkdir(path.join(gameItems(p), ICE, "nested"));
    },
    [],
  ],
  [
    "a draft file larger than a draft is",
    async (p) => {
      await writeDraft(gameItems(p), ICE);
      await writeFile(path.join(gameItems(p), `${ICE}.json`), "x".repeat(70 * 1024));
    },
    [],
  ],
  [
    "a draft with more files than a draft has",
    async (p) => {
      await writeDraft(gameItems(p), ICE);
      for (let n = 0; n < 9; n++) await writeFile(path.join(gameItems(p), ICE, `extra-${n}.bin`), "x");
    },
    [],
  ],
  [
    "names that are not local ids",
    async (p) => {
      await mkdir(gameItems(p), { recursive: true });
      for (const name of [
        "evil.json",
        "local_AB12CD34EF56.json",
        "local_ab12.json",
        "last-sync.json",
        ".local_ab12cd34ef56.json",
      ])
        await writeFile(path.join(gameItems(p), name), "{}");
    },
    [],
  ],
  [
    "a draft with no folder of files is still a draft",
    async (p) => {
      await mkdir(gameItems(p), { recursive: true });
      await writeFile(path.join(gameItems(p), `${ICE}.json`), "{}");
    },
    [ICE],
  ],
];

describe("what goes from a hostile game folder into the run folder", () => {
  for (const [name, arrange, staged] of hostileGame) {
    it(`copies ${staged.length ? staged.join(", ") : "nothing"} for ${name}, and writes nothing outside`, async () => {
      const p = await profile();
      await arrange(p);
      const outside = await tree(p.outside);
      const sandbox = fakeSandbox({ stdout: "[]" });
      await service(p, sandbox).run({ command: "shop list" }, bound(p), { paid: false });
      const copied = Object.keys(sandbox.seen[0]?.genex ?? {})
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.basename(file, ".json"))
        .sort();
      assert.deepEqual(copied, staged);
      assert.deepEqual(await tree(p.outside), outside, "nothing outside the game changed");
      assert.deepEqual(await runsLeft(p), []);
    });
  }
});

describe("what the CLI leaves in the run folder, carried into a hostile game", () => {
  const hostileCarry: Array<[string, (p: Profile) => Promise<void>, (cwd: string, p: Profile) => Promise<void>]> = [
    [
      "through .genex/items linked out of the game",
      async (p) => {
        await mkdir(path.join(p.game, ".genex"), { recursive: true });
        await rm(path.join(p.game, ".genex", "scratch"), { recursive: true });
        await symlink(p.outside, gameItems(p));
      },
      (cwd) => writeDraft(path.join(cwd, ...ITEMS), ICE),
    ],
    [
      "through .genex as a file",
      async (p) => {
        await rm(path.join(p.game, ".genex"), { recursive: true });
        await writeFile(path.join(p.game, ".genex"), "not a folder");
      },
      (cwd) => writeDraft(path.join(cwd, ...ITEMS), ICE),
    ],
    [
      "a link the CLI left in a draft's folder",
      async () => {},
      async (cwd, p) => {
        await writeDraft(path.join(cwd, ...ITEMS), ICE);
        await symlink(path.join(p.outside, "secret.png"), path.join(cwd, ...ITEMS, ICE, "secret.png"));
      },
    ],
    [
      "a draft's folder the CLI made a link",
      async () => {},
      async (cwd, p) => {
        await mkdir(path.join(cwd, ...ITEMS), { recursive: true });
        await writeFile(path.join(cwd, ...ITEMS, `${ICE}.json`), "{}");
        await symlink(p.outside, path.join(cwd, ...ITEMS, ICE));
      },
    ],
  ];
  for (const [name, arrange, act] of hostileCarry) {
    it(`refuses ${name}, telling the agent, and changes nothing outside the game`, async () => {
      const p = await profile();
      await arrange(p);
      const outside = await tree(p.outside);
      const sandbox = fakeSandbox({ stdout: localLine(), act: (cwd) => act(cwd, p) });
      const drafts: Array<{ draft: ListingRecord; fingerprint: string | null }> = [];
      const answer = await service(p, sandbox, drafts).run(
        { command: "shop add", args: "Ice Shield", options: { price: 300 } },
        bound(p),
        { paid: false },
      );
      assert.equal(answer.ok, false);
      assert.match(String(answer.output), /\.genex\/items/);
      assert.deepEqual(drafts, [], "no card for a draft the game does not hold");
      assert.deepEqual(await tree(p.outside), outside);
      assert.deepEqual(await runsLeft(p), []);
    });
  }

  it("ignores what the CLI wrote under a name that is not a local id", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({
      stdout: localLine(),
      act: async (cwd) => {
        await writeDraft(path.join(cwd, ...ITEMS), ICE);
        await writeFile(path.join(cwd, ...ITEMS, "last-sync.json"), "{}");
        await writeFile(path.join(cwd, ...ITEMS, "evil.json"), "{}");
      },
    });
    const answer = await service(p, sandbox).run(
      { command: "shop add", args: "Ice Shield", options: { price: 300 } },
      bound(p),
      { paid: false },
    );
    assert.equal(answer.ok, true);
    assert.deepEqual(Object.keys(await tree(gameItems(p))).sort(), [`${ICE}.json`, path.join(ICE, "picture.png")]);
  });
});

/** The CLI's `shop sync --json` line. */
const syncLine = (items: unknown[]) => JSON.stringify({ kind: "genex.item_sync", version: 1, items });

describe("Studio's own `shop sync` after a publish", () => {
  /**
   * A publish makes the hosted project first and marks it published last, so a publish that failed
   * part-way, or one still running, leaves a record with no status or a draft one: the person's
   * "Sell when published" waits for the publish itself.
   */
  const records: Array<[string, string, boolean]> = [
    ["a project made by a publish that never finished", JSON.stringify({ id: "proj_1", slug: "space-race-x1" }), false],
    ["a draft", JSON.stringify({ id: "proj_1", slug: "space-race-x1", status: "draft" }), false],
    ["a published game", JSON.stringify({ id: "proj_1", slug: "space-race-x1", status: "published" }), true],
    ["a status spelled otherwise", JSON.stringify({ id: "proj_1", slug: "space-race-x1", status: "Published" }), false],
    [
      "a status that is not text",
      JSON.stringify({ id: "proj_1", slug: "space-race-x1", status: ["published"] }),
      false,
    ],
    ["published with no project", JSON.stringify({ slug: "space-race-x1", status: "published" }), false],
    ["a record that is not JSON", '{"status":"published"', false],
    ["a record that is a list", JSON.stringify([{ id: "proj_1", slug: "s", status: "published" }]), false],
  ];
  for (const [name, record, published] of records)
    it(`counts ${name} as ${published ? "" : "not "}published`, async () => {
      const p = await profile();
      const hosted = path.join(p.genexStorage, "publish", "space-race", ".genex");
      await mkdir(hosted, { recursive: true });
      await writeFile(path.join(hosted, "project.json"), record);
      const sandbox = fakeSandbox();
      assert.equal(await service(p, sandbox).published("space-race"), published);
      assert.equal(sandbox.seen.length, 0, "reading the record runs nothing");
    });

  it("counts a game with no publish record, or a name that is not a game's, as not published", async () => {
    const p = await profile();
    assert.equal(await service(p, fakeSandbox()).published("space-race"), false);
    await assert.rejects(service(p, fakeSandbox()).published("../space-race"));
  });

  it("runs on the hosted project with the game's drafts, then takes the uploaded ones out of the game", async () => {
    const p = await profile({ linked: true });
    await writeDraft(gameItems(p), ICE);
    await writeDraft(gameItems(p), SLED, { priceCoins: 7 });
    const sandbox = fakeSandbox({
      stdout: syncLine([
        { localId: ICE, contentHash: HASH, skuId: "sku_ice", state: "draft" },
        { localId: SLED, contentHash: NEW_HASH, error: "price_off_grid", field: "price" },
      ]),
    });
    const synced = await service(p, sandbox).syncLocalItems("space-race");
    assert.deepEqual(synced, [
      { localId: ICE, contentHash: HASH, skuId: "sku_ice", refusal: null, field: null },
      { localId: SLED, contentHash: NEW_HASH, skuId: null, refusal: StoreRefusal.PriceOffGrid, field: "price" },
    ]);
    const [run] = sandbox.seen;
    assert.ok(run);
    assert.match(run.request.command, /'shop' 'sync'/);
    assert.match(run.genex["project.json"] ?? "", /proj_1/);
    assert.ok(run.request.policy?.allowedDomains?.includes("*.r2.cloudflarestorage.com"), "it uploads files");
    assert.deepEqual(
      Object.keys(await tree(gameItems(p))).sort(),
      [`${SLED}.json`, path.join(SLED, "picture.png")],
      "the refused draft stays local",
    );
    assert.equal(await hasLocalDrafts(p.game), true);
  });

  it("keeps a draft the game changed while it was uploaded", async () => {
    const p = await profile({ linked: true });
    await writeDraft(gameItems(p), ICE);
    const sandbox = fakeSandbox({
      stdout: syncLine([{ localId: ICE, contentHash: HASH, skuId: "sku_ice", state: "draft" }]),
      act: async () => writeFile(path.join(gameItems(p), ICE, "picture.png"), "PNG-changed"),
    });
    await service(p, sandbox).syncLocalItems("space-race");
    assert.equal((await tree(gameItems(p)))[path.join(ICE, "picture.png")], "PNG-changed");
  });

  it("removes nothing outside the game when .genex/items became a link while it was uploaded", async () => {
    const p = await profile({ linked: true });
    await writeDraft(gameItems(p), ICE);
    await writeDraft(path.join(p.outside, "items"), ICE);
    const sandbox = fakeSandbox({
      stdout: syncLine([{ localId: ICE, contentHash: HASH, skuId: "sku_ice", state: "draft" }]),
      act: async () => {
        await rm(gameItems(p), { recursive: true });
        await symlink(path.join(p.outside, "items"), gameItems(p));
      },
    });
    const outside = await tree(p.outside);
    await service(p, sandbox).syncLocalItems("space-race");
    assert.deepEqual(await tree(p.outside), outside, "the draft the link leads to stays");
  });

  it("never takes out a draft the run was not given, whatever the sync says of it", async () => {
    const p = await profile({ linked: true });
    await writeDraft(gameItems(p), ICE);
    await writeDraft(gameItems(p), SLED);
    await mkdir(path.join(gameItems(p), SLED, "nested"));
    const sandbox = fakeSandbox({
      stdout: syncLine([
        { localId: ICE, contentHash: HASH, skuId: "sku_ice", state: "draft" },
        { localId: SLED, contentHash: HASH, skuId: "sku_sled", state: "draft" },
      ]),
    });
    await service(p, sandbox).syncLocalItems("space-race");
    const left = Object.keys(await tree(gameItems(p))).sort();
    assert.deepEqual(left, [`${SLED}.json`, path.join(SLED, "picture.png")], "the unclean draft was never copied");
  });

  it("runs nothing for a game that is not on Genex, or has no drafts", async () => {
    const unlinked = await profile();
    await writeDraft(gameItems(unlinked), ICE);
    const none = await profile({ linked: true });
    for (const p of [unlinked, none]) {
      const sandbox = fakeSandbox({ stdout: syncLine([]) });
      assert.equal(await service(p, sandbox).syncLocalItems("space-race"), null);
      assert.equal(sandbox.seen.length, 0);
    }
  });

  const hostileSync: Array<[string, string]> = [
    ["no JSON", "Uploaded 1 item."],
    ["another kind", JSON.stringify({ kind: "genex.item_draft", version: 1, items: [] })],
    ["another version", JSON.stringify({ kind: "genex.item_sync", version: 2, items: [] })],
    ["items that are not a list", JSON.stringify({ kind: "genex.item_sync", version: 1, items: {} })],
  ];
  for (const [name, stdout] of hostileSync)
    it(`answers no result, and leaves the game's drafts, for ${name}`, async () => {
      const p = await profile({ linked: true });
      await writeDraft(gameItems(p), ICE);
      const before = await tree(gameItems(p));
      assert.equal(await service(p, fakeSandbox({ stdout })).syncLocalItems("space-race"), null);
      assert.deepEqual(await tree(gameItems(p)), before);
    });

  it("leaves out entries that do not read, and never takes a draft out for one", async () => {
    const p = await profile({ linked: true });
    await writeDraft(gameItems(p), ICE);
    const before = await tree(gameItems(p));
    const stdout = syncLine([
      { localId: "../local_ab12cd34ef56", contentHash: HASH, skuId: "sku_ice" },
      { localId: ICE, contentHash: "nothex", skuId: "sku_ice" },
      { localId: ICE, contentHash: HASH, skuId: "../sku" },
      { localId: ICE, contentHash: HASH },
      "local_ab12cd34ef56",
    ]);
    assert.deepEqual(await service(p, fakeSandbox({ stdout })).syncLocalItems("space-race"), []);
    assert.deepEqual(await tree(gameItems(p)), before);
  });
});

describe("the person's Other games can use it on a local draft", () => {
  it("is main's own `shop set <localId> --shared`, carried back, with the new draft", async () => {
    const p = await profile();
    await writeDraft(gameItems(p), ICE);
    const before = await localDraftFingerprint(gameItems(p), ICE);
    const sandbox = fakeSandbox({
      stdout: localLine({ shareable: true, contentHash: NEW_HASH }),
      act: (cwd) => writeDraft(path.join(cwd, ...ITEMS), ICE, { shareable: true }),
    });
    const changed = await service(p, sandbox).setLocalShared("space-race", ICE, true);
    assert.equal(changed?.staged, before, "it names the bytes the run took from the game");
    assert.equal(changed?.draft.contentHash, NEW_HASH);
    assert.equal(changed?.draft.shareable, true);
    assert.equal(changed?.fingerprint, await localDraftFingerprint(gameItems(p), ICE));
    assert.match(sandbox.seen[0]?.request.command ?? "", /'shop' 'set' 'local_ab12cd34ef56' '--shared'/);
    assert.match((await tree(gameItems(p)))[`${ICE}.json`] ?? "", /"shareable":true/);
  });

  it("turns it off with --no-shared", async () => {
    const p = await profile();
    await writeDraft(gameItems(p), ICE, { shareable: true });
    const sandbox = fakeSandbox({ stdout: localLine() });
    await service(p, sandbox).setLocalShared("space-race", ICE, false);
    assert.match(sandbox.seen[0]?.request.command ?? "", /'--no-shared'/);
  });

  for (const localId of ["../local_ab12cd34ef56", "sku_frost", "local_AB12CD34EF56", "--json"])
    it(`refuses ${localId} as a local id before anything runs`, async () => {
      const p = await profile();
      const sandbox = fakeSandbox({ stdout: localLine() });
      await assert.rejects(service(p, sandbox).setLocalShared("space-race", localId, true));
      assert.equal(sandbox.seen.length, 0);
    });
});

describe("only Studio uploads local drafts, and only the person puts one on sale (D40)", () => {
  it("never runs `genex shop sync` for an agent, through either tool", () => {
    for (const paid of [true, false])
      assert.throws(
        () => genexCliRequest({ command: "shop sync" }, { paid }),
        (error: unknown) => error instanceof GenexCliRefusal && error.code === GenexCliRefusalCode.Unavailable,
      );
  });
});

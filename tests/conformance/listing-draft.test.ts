/**
 * The Listing draft card's source (marketplace plan 8.3, 10.3; D40). Studio draws the card only from
 * a real `genex shop add|set --json` answer of its own pinned CLI, for the game's own hosted
 * project: `draftInCliAnswer` reads that answer as hostile input, `GenexCliService` hands a draft to
 * the host once per such run, and nothing an agent writes (its words, a harness record or a harness
 * notification) can stand in for one.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GenexCliService } from "../../src/main/core/genex-cli.ts";
import { GenexCliRefusal, GenexCliRefusalCode, genexCliRequest } from "../../src/main/core/genex-cli-policy.ts";
import { refuseHostRecords } from "../../src/main/core/harness-events.ts";
import { draftInCliAnswer } from "../../src/main/core/item-draft.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import {
  ITEM_DRAFT_KIND,
  ITEM_DRAFT_VERSION,
  type ListingDraft,
  isLocalDraft,
  type ListingRecord,
  type LocalListingDraft,
  listingDraftOf,
  listingKey,
} from "../../src/shared/item-draft.ts";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import { ItemState, ItemType } from "../../src/shared/store-items.ts";
import { isHostOnlyUiEvent, UiEvent } from "../../src/shared/ui-events.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOSTED = "proj_1";
const PICTURE = "https://assets.genex.games/items/sku_frost/picture-1.png";

/** The CLI's `--json` draft for the Frost Axe, as the contract prints it. */
const cliDraft = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: ITEM_DRAFT_KIND,
  version: ITEM_DRAFT_VERSION,
  id: "sku_frost",
  projectId: HOSTED,
  type: "durable",
  name: "Frost Axe",
  description: "Ice-blue head. Freezes an enemy for a second on hit.",
  tags: ["axe"],
  iconUrl: PICTURE,
  modelUrl: null,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  state: "draft",
  active: false,
  shareable: true,
  resellable: false,
  retired: false,
  packageManifest: null,
  publishedAt: null,
  takenDownAt: null,
  createdAt: "2026-10-23T08:00:00.000Z",
  ...fields,
});

const FROST_AXE: ListingDraft = {
  project: "space-race",
  itemId: "sku_frost",
  name: "Frost Axe",
  description: "Ice-blue head. Freezes an enemy for a second on hit.",
  type: ItemType.Durable,
  priceCoins: 1200,
  priceDisplayUsdCents: 1200,
  iconUrl: PICTURE,
  state: ItemState.Draft,
  shareable: true,
};

/** A draft of an item on genex.games, or null for a local one or none. */
const onGenex = (draft: ListingRecord | null): ListingDraft | null => (draft && !isLocalDraft(draft) ? draft : null);

const answer = (output: unknown, fields: { command?: string; ok?: boolean } = {}) => ({
  command: fields.command ?? "shop add",
  ok: fields.ok ?? true,
  output,
});

describe("a listing draft in a Genex CLI answer", () => {
  it("is the item `shop add --json` made for the game's own hosted project", () => {
    assert.deepEqual(draftInCliAnswer(answer(cliDraft()), "space-race", HOSTED), FROST_AXE);
  });

  it("is also the item `shop set --json` changed, as genex.games answered it", () => {
    const changed = cliDraft({ priceCoins: 800, priceDisplayUsdCents: 800, shareable: false });
    assert.deepEqual(draftInCliAnswer(answer(changed, { command: "shop set" }), "space-race", HOSTED), {
      ...FROST_AXE,
      priceCoins: 800,
      priceDisplayUsdCents: 800,
      shareable: false,
    });
  });

  it("keeps a draft whose picture is not on a host the app loads, without the picture", () => {
    for (const iconUrl of ["http://assets.genex.games/a.png", "https://evil.example/a.png", "javascript:alert(1)", 7])
      assert.equal(
        onGenex(draftInCliAnswer(answer(cliDraft({ iconUrl })), "space-race", HOSTED))?.iconUrl,
        null,
        String(iconUrl),
      );
  });

  it("cleans bidi and control characters out of the name", () => {
    const draft = draftInCliAnswer(answer(cliDraft({ name: "Frost‮ Axe\u0007" })), "space-race", HOSTED);
    assert.equal(draft?.name, "Frost Axe");
  });

  const refused: ReadonlyArray<[string, ReturnType<typeof answer>, string | null]> = [
    ["another command printing a draft", answer(cliDraft(), { command: "shop list" }), HOSTED],
    ["a free command printing a draft", answer(cliDraft(), { command: "doctor" }), HOSTED],
    ["a failed run", answer(cliDraft(), { ok: false }), HOSTED],
    ["a game with no hosted project", answer(cliDraft()), null],
    ["another project's item", answer(cliDraft({ projectId: "proj_2" })), HOSTED],
    ["an item of no project", answer(cliDraft({ projectId: null })), HOSTED],
    ["a bare SKU from an older API (no kind)", answer({ ...cliDraft(), kind: undefined }), HOSTED],
    ["another kind", answer(cliDraft({ kind: "genex.item" })), HOSTED],
    ["another version", answer(cliDraft({ version: 2 })), HOSTED],
    ["a version as text", answer(cliDraft({ version: "1" })), HOSTED],
    ["the draft as text, as an agent could echo it", answer(JSON.stringify(cliDraft())), HOSTED],
    ["a list of drafts", answer([cliDraft()]), HOSTED],
    ["nothing", answer(null), HOSTED],
    ["an id that is a path", answer(cliDraft({ id: "../sku_frost" })), HOSTED],
    ["an id that is too long", answer(cliDraft({ id: "a".repeat(65) })), HOSTED],
    ["no name", answer(cliDraft({ name: "  " })), HOSTED],
    ["a name longer than an item may have", answer(cliDraft({ name: "a".repeat(81) })), HOSTED],
    ["a description longer than an item may have", answer(cliDraft({ description: "a".repeat(1001) })), HOSTED],
    ["a price over what Studio confirms", answer(cliDraft({ priceCoins: 100_001 })), HOSTED],
    ["a negative price", answer(cliDraft({ priceCoins: -1 })), HOSTED],
    ["a fractional price", answer(cliDraft({ priceCoins: 12.5 })), HOSTED],
    ["a price as text", answer(cliDraft({ priceCoins: "1200" })), HOSTED],
    ["no dollar value", answer(cliDraft({ priceDisplayUsdCents: undefined })), HOSTED],
    ["an unknown state", answer(cliDraft({ state: "published" })), HOSTED],
    ["an unknown type", answer(cliDraft({ type: "weapon" })), HOSTED],
    ["sharing that is not yes or no", answer(cliDraft({ shareable: "yes" })), HOSTED],
  ];
  for (const [name, given, hosted] of refused)
    it(`draws no card for ${name}`, () => assert.equal(draftInCliAnswer(given, "space-race", hosted), null));
});

const LOCAL_ID = "local_ab12cd34ef56";
const HASH = "3f9a".repeat(16);

/** The CLI's `--json` line for a local draft (contract "Local item drafts"). */
const cliLocal = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: ITEM_DRAFT_KIND,
  version: ITEM_DRAFT_VERSION,
  state: "local",
  localId: LOCAL_ID,
  name: "Ice Shield",
  description: "Blocks one hit.",
  priceCoins: 300,
  type: "durable",
  tags: ["shield"],
  shareable: false,
  contentHash: HASH,
  picture: `.genex/items/${LOCAL_ID}/picture.png`,
  ...fields,
});

const ICE_SHIELD: LocalListingDraft = {
  project: "space-race",
  state: "local",
  localId: LOCAL_ID,
  name: "Ice Shield",
  description: "Blocks one hit.",
  type: ItemType.Durable,
  priceCoins: 300,
  tags: ["shield"],
  shareable: false,
  contentHash: HASH,
};

describe("a local draft in a Genex CLI answer", () => {
  it("is the item `shop add --json` made in a game that is not on Genex yet", () => {
    assert.deepEqual(draftInCliAnswer(answer(cliLocal()), "space-race", null), ICE_SHIELD);
  });

  it("reads the same in a game that is on Genex (a local draft kept after a refused upload)", () => {
    assert.deepEqual(draftInCliAnswer(answer(cliLocal()), "space-race", HOSTED), ICE_SHIELD);
  });

  it("is the draft `shop set --json` changed, with its new hash", () => {
    const changed = cliLocal({ priceCoins: 250, contentHash: "b".repeat(64), description: undefined, tags: [] });
    assert.deepEqual(draftInCliAnswer(answer(changed, { command: "shop set" }), "space-race", null), {
      ...ICE_SHIELD,
      priceCoins: 250,
      contentHash: "b".repeat(64),
      description: null,
      tags: [],
    });
  });

  it("cleans bidi and control characters out of the name", () => {
    const draft = draftInCliAnswer(answer(cliLocal({ name: "Ice‮ Shield\u0007" })), "space-race", null);
    assert.equal(draft?.name, "Ice Shield");
  });

  const refused: ReadonlyArray<[string, ReturnType<typeof answer>]> = [
    ["another command printing a local draft", answer(cliLocal(), { command: "shop list" })],
    ["`shop remove` printing one", answer(cliLocal(), { command: "shop remove" })],
    ["a free command printing one", answer(cliLocal(), { command: "doctor" })],
    ["a failed run", answer(cliLocal(), { ok: false })],
    ["the line as text, as an agent could echo it", answer(JSON.stringify(cliLocal()))],
    ["another kind", answer(cliLocal({ kind: "genex.item" }))],
    ["another version", answer(cliLocal({ version: 2 }))],
    ["no local id", answer(cliLocal({ localId: undefined }))],
    ["a local id that is a path", answer(cliLocal({ localId: "../local_ab12cd34ef56" }))],
    ["a local id in capitals", answer(cliLocal({ localId: "local_AB12CD34EF56" }))],
    ["a local id too short", answer(cliLocal({ localId: "local_ab12" }))],
    ["a SKU id where the local id goes", answer(cliLocal({ localId: "sku_frost" }))],
    ["no content hash", answer(cliLocal({ contentHash: undefined }))],
    ["a hash in capitals", answer(cliLocal({ contentHash: HASH.toUpperCase() }))],
    ["a hash too short", answer(cliLocal({ contentHash: "abc" }))],
    ["a hash that is not hex", answer(cliLocal({ contentHash: "z".repeat(64) }))],
    ["no name", answer(cliLocal({ name: " " }))],
    ["a name longer than an item may have", answer(cliLocal({ name: "a".repeat(81) }))],
    ["a description longer than an item may have", answer(cliLocal({ description: "a".repeat(1001) }))],
    ["a description that is not text", answer(cliLocal({ description: 3 }))],
    ["a negative price", answer(cliLocal({ priceCoins: -1 }))],
    ["a fractional price", answer(cliLocal({ priceCoins: 2.5 }))],
    ["a price as text", answer(cliLocal({ priceCoins: "300" }))],
    ["a price over what Studio confirms", answer(cliLocal({ priceCoins: 100_001 }))],
    ["an unknown type", answer(cliLocal({ type: "weapon" }))],
    ["sharing that is not yes or no", answer(cliLocal({ shareable: "no" }))],
    ["tags that are not a list", answer(cliLocal({ tags: "shield" }))],
    ["eleven tags", answer(cliLocal({ tags: Array.from({ length: 11 }, (_, n) => `t${n}`) }))],
    ["a tag longer than 32", answer(cliLocal({ tags: ["a".repeat(33)] }))],
    ["a tag that is not text", answer(cliLocal({ tags: [7] }))],
  ];
  for (const [name, given] of refused)
    it(`draws no card for ${name}`, () => assert.equal(draftInCliAnswer(given, "space-race", null), null));
});

describe("the chat's reading of a local item_drafted record", () => {
  it("reads back what main recorded", () => {
    assert.deepEqual(listingDraftOf({ ...ICE_SHIELD }), ICE_SHIELD);
  });

  it("keys a local draft apart from any item on genex.games", () => {
    const named: ListingRecord = { ...FROST_AXE, itemId: LOCAL_ID };
    assert.notEqual(listingKey(ICE_SHIELD), listingKey(named));
  });

  const partial: ReadonlyArray<[string, unknown]> = [
    ["no game", { ...ICE_SHIELD, project: "" }],
    ["no local id", { ...ICE_SHIELD, localId: undefined }],
    ["no hash", { ...ICE_SHIELD, contentHash: null }],
    ["a SKU in place of the local id", { ...ICE_SHIELD, localId: undefined, itemId: "sku_frost" }],
    ["a price as text", { ...ICE_SHIELD, priceCoins: "300" }],
  ];
  for (const [name, payload] of partial)
    it(`draws no card for ${name}`, () => assert.equal(listingDraftOf(payload), null));
});

describe("the chat's reading of an item_drafted record", () => {
  it("reads back what main recorded", () => {
    assert.deepEqual(listingDraftOf({ ...FROST_AXE }), FROST_AXE);
  });

  it("keeps a record whose picture is not https, without the picture", () => {
    assert.equal(onGenex(listingDraftOf({ ...FROST_AXE, iconUrl: "file:///etc/passwd" }))?.iconUrl, null);
  });

  const partial: ReadonlyArray<[string, unknown]> = [
    ["an empty record", {}],
    ["no record", null],
    ["no game", { ...FROST_AXE, project: "" }],
    ["no item id", { ...FROST_AXE, itemId: undefined }],
    ["an id that is a path", { ...FROST_AXE, itemId: "a/b" }],
    ["no price", { ...FROST_AXE, priceCoins: undefined }],
    ["an unknown state", { ...FROST_AXE, state: "live" }],
    ["sharing that is not yes or no", { ...FROST_AXE, shareable: 1 }],
    ["a description that is not text", { ...FROST_AXE, description: 3 }],
  ];
  for (const [name, payload] of partial)
    it(`draws no card for ${name}`, () => assert.equal(listingDraftOf(payload), null));
});

describe("nothing an agent writes stands in for a CLI answer", () => {
  it("refuses an item_drafted record the harness appends", () => {
    const forged = customEventData(CustomEvent.ItemDrafted, { ...FROST_AXE });
    assert.throws(() => refuseHostRecords([forged]), /listing draft/);
  });

  it("keeps a harness notification from announcing a draft", () => {
    assert.equal(isHostOnlyUiEvent(UiEvent.ItemDrafted), true);
  });
});

/** A profile's folders with the game's draft published, so `shop` commands reach its hosted project. */
async function profile() {
  const root = await realpath(await tmpDir("listing-draft-"));
  const genexStorage = path.join(root, "userData", "engine-homes", "genex");
  const project = path.join(genexStorage, "publish", "space-race", ".genex");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(root, "resources"), { recursive: true });
  await writeFile(path.join(project, "project.json"), JSON.stringify({ id: HOSTED, slug: "space-race-x1" }));
  return { root, genexStorage };
}

/** A sandbox that runs nothing and prints `stdout` with exit `code`. */
const printing =
  (stdout: string, code = 0) =>
  async (request: RunRequest): Promise<RunResult> => ({
    code,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    sandboxed: true,
    command: request.command,
    cwd: request.cwd,
  });

async function cliService(
  stdout: string,
  onDraft: (draft: ListingRecord, binding: PluginBinding) => Promise<void>,
  code = 0,
) {
  const p = await profile();
  return new GenexCliService({
    run: printing(stdout, code),
    credentialFile: async () => "GENEX_TOKEN=tok-synthetic\n",
    heldCredentials: () => ["tok-synthetic"],
    runsRoot: path.join(p.root, "userData", "genex-cli"),
    resources: path.join(p.root, "resources"),
    genexStorage: p.genexStorage,
    protectedWrites: () => [],
    onListingDraft: onDraft,
  });
}

const BINDING: PluginBinding = { project: "space-race", directory: "/games/space-race", threadId: "t1" };
const SHOP_ADD = { command: "shop add", args: "Frost Axe", options: { price: 1200 } };

describe("a Studio-run CLI command and the Listing draft card", () => {
  it("hands the host the draft of a `shop add` run, with the call's binding, and answers the agent as before", async () => {
    const seen: Array<{ draft: ListingRecord; binding: PluginBinding }> = [];
    const cli = await cliService(`${JSON.stringify(cliDraft())}\n`, async (draft, binding) => {
      seen.push({ draft, binding });
    });
    const result = await cli.run(SHOP_ADD, BINDING, { paid: false });
    assert.deepEqual(seen, [{ draft: FROST_AXE, binding: BINDING }]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, cliDraft());
  });

  it("hands nothing for a draft a free command printed, a failed run or another project's item", async () => {
    const seen: ListingRecord[] = [];
    const record = async (draft: ListingRecord) => {
      seen.push(draft);
    };
    await (await cliService(JSON.stringify(cliDraft()), record)).run({ command: "doctor" }, BINDING, { paid: false });
    await (await cliService(JSON.stringify(cliDraft()), record, 1)).run(SHOP_ADD, BINDING, { paid: false });
    const other = JSON.stringify(cliDraft({ projectId: "proj_2" }));
    await (await cliService(other, record)).run(SHOP_ADD, BINDING, { paid: false });
    assert.deepEqual(seen, []);
  });

  it("still answers the agent when recording the card fails", async () => {
    const cli = await cliService(JSON.stringify(cliDraft()), async () => {
      throw new Error("log closed");
    });
    const result = await cli.run(SHOP_ADD, BINDING, { paid: false });
    assert.equal(result.ok, true);
  });
});

describe("only the person puts an item on sale (D40)", () => {
  it("never runs `genex shop publish` or `unpublish` for an agent, through either tool", () => {
    for (const command of ["shop publish", "shop unpublish"])
      for (const paid of [true, false])
        assert.throws(
          () => genexCliRequest({ command, args: "sku_frost" }, { paid }),
          (error: unknown) => error instanceof GenexCliRefusal && error.code === GenexCliRefusalCode.Unavailable,
          `${command} through ${paid ? "genex__cli-paid" : "genex__cli"}`,
        );
  });
});

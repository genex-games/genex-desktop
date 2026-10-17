/**
 * The Roblox Studio plugin's Creator Store insert (`plugins/roblox/insert-asset.ts`): an asset id
 * that isn't plain digits reaches no Studio; the price is read first (Studio's own `search_asset`,
 * else the asset's product info), and a paid asset, or one Genex can't show is free, is refused with
 * nothing inserted; a free one is inserted in the game's own Studio under the agent's busy mark, and
 * the answer lists every script it brought, flagging the ways backdoors hide.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { AskFirstAnswer, AskFirstGame } from "../../src/plugins/roblox/ai-tools.ts";
import { AGENT_BUSY_FILE } from "../../src/plugins/roblox/agent-marks.ts";
import { type InsertedScript, insertAsset } from "../../src/plugins/roblox/insert-asset.ts";
import type { StudioClient, StudioToolResult } from "../../src/plugins/roblox/studio-client.ts";
import { tmpDir } from "../helpers/tmp.ts";

const STUDIO = "studio-3";
const NOW = 1_800_000_000_000;
const USER = 9_172_881_962;
const FREE = "580221169";
const PAID = "107069227552617";

const text = (value: string, isError = false): StudioToolResult => ({
  content: [{ type: "text", text: value }],
  isError,
});

/** A Creator Store search result as Studio 0.743 answers `search_asset`. */
function searchAnswer(results: Array<Record<string, unknown>>): StudioToolResult {
  return text(JSON.stringify({ scope: "creator_store", status: "success", resultCount: results.length, results }));
}
const storeResult = (assetId: string, free: boolean, name = "Tree") => ({
  assetId,
  name,
  isFree: free,
  priceCents: free ? 0 : 399,
  ...(free ? {} : { priceLabel: "$3.99" }),
  creatorStoreUrl: `https://create.roblox.com/store/asset/${assetId}`,
  assetType: "Model",
  source: "creator_store",
});

/** The arguments a Luau step was sent with: the JSON in its last long string. */
function stepArgs(code: string): Record<string, unknown> {
  const found = /JSONDecode\(\[(=*)\[([\s\S]*)\]\1\]\)\)$/.exec(code);
  assert.ok(found, "the step's arguments close the code");
  return JSON.parse(found[2] ?? "{}");
}

type Call = { name: string; args: Record<string, unknown> };

interface StudioPlace {
  search?: StudioToolResult;
  info?: Record<string, unknown>;
  scripts?: InsertedScript[];
  insert?: StudioToolResult;
}

/** A stand-in Studio with one place: what search, product info, the insert and the script list answer. */
function standIn(place: StudioPlace) {
  const calls: Call[] = [];
  const studio: Pick<StudioClient, "callTool"> = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "search_asset") return place.search ?? searchAnswer([]);
      if (name === "insert_asset") return place.insert ?? text("Inserted the asset into Workspace.");
      if (name !== "execute_luau") return text(`no ${name}`, true);
      const step = stepArgs(String(args.code));
      if (step.op === "info") return text(JSON.stringify(place.info ?? { error: "not found" }));
      if (step.op === "children") return text(JSON.stringify({ ids: ["d1", "d2"] }));
      if (step.op === "scripts")
        return text(JSON.stringify({ added: ["Workspace.Tree"], scripts: place.scripts ?? [] }));
      return text("unknown step", true);
    },
  };
  return {
    studio,
    calls,
    steps: () => calls.filter((c) => c.name === "execute_luau").map((c) => stepArgs(String(c.args.code)).op),
  };
}

async function gameIn(bound = true): Promise<AskFirstGame & { marks: string }> {
  const root = await tmpDir("roblox-insert-");
  const marks = path.join(root, "storage", "mcp", "game-1");
  await mkdir(marks, { recursive: true });
  return {
    folder: path.join(root, "game"),
    storage: path.join(root, "storage"),
    marks,
    studio: () => (bound ? STUDIO : undefined),
  };
}

const insert = (place: StudioPlace, args: Record<string, unknown>, game: AskFirstGame) => {
  const stand = standIn(place);
  return { stand, answer: insertAsset({ studio: stand.studio, now: () => NOW }, args, game) };
};

const refused = (answer: AskFirstAnswer, pattern?: RegExp) => {
  assert.equal(answer.done, false, "refused");
  if (pattern) assert.match(answer.message, pattern);
};

describe("insert-asset", () => {
  it("refuses a paid asset, its price read through search_asset, with nothing inserted", async () => {
    const game = await gameIn();
    const { stand, answer } = insert(
      { search: searchAnswer([storeResult(FREE, true), storeResult(PAID, false, "VFX Sword Pack")]) },
      { id: PAID },
      game,
    );
    const answered = await answer;
    refused(answered, /\$3\.99/);
    assert.match(answered.message, /only free/);
    assert.deepEqual(
      stand.calls.map((call) => call.name),
      ["search_asset"],
    );
    assert.deepEqual(stand.calls[0]?.args, { query: PAID, scope: "creator_store", maxResults: 20, studio_id: STUDIO });
  });

  it("inserts a free asset in the game's Studio, and lists the scripts it brought with what to look at", async () => {
    const game = await gameIn();
    const scripts: InsertedScript[] = [
      { path: "Workspace.Tree.Sway", class: "Script", lines: 12, flags: [] },
      { path: "Workspace.Tree.Helper", class: "ModuleScript", lines: 40, flags: ["require with an id", "loadstring"] },
    ];
    const { stand, answer } = insert(
      { search: searchAnswer([storeResult(FREE, true)]), scripts },
      { id: FREE, name: "Tree", parent: "Workspace.Scenery" },
      game,
    );
    const answered = await answer;
    assert.equal(answered.done, true, answered.message);
    assert.deepEqual(
      stand.calls.map((call) => call.name),
      ["search_asset", "execute_luau", "insert_asset", "execute_luau"],
    );
    assert.deepEqual(stand.steps(), ["children", "scripts"]);
    assert.deepEqual(stand.calls[2]?.args, {
      assetId: FREE,
      assetName: "Tree",
      parentPath: "Workspace.Scenery",
      studio_id: STUDIO,
    });
    for (const call of stand.calls) assert.equal(call.args.studio_id, STUDIO, call.name);
    assert.equal(stand.calls[1]?.args.datamodel_type, "Edit");
    assert.deepEqual(answered.result, { assetId: FREE, added: ["Workspace.Tree"], scripts });
    assert.match(answered.message, /2 scripts/);
    assert.match(answered.message, /Workspace\.Tree\.Helper/);
    assert.match(answered.message, /require with an id/);
    const busy = JSON.parse(await readFile(path.join(game.marks, AGENT_BUSY_FILE), "utf8"));
    assert.deepEqual(busy, { since: NOW, until: NOW }, "the insert ran under the agent's busy mark");
  });

  it("says plainly when a free asset brought no scripts", async () => {
    const { answer } = insert({ search: searchAnswer([storeResult(FREE, true)]) }, { id: FREE }, await gameIn());
    const answered = await answer;
    assert.equal(answered.done, true, answered.message);
    assert.match(answered.message, /no scripts/);
  });

  it("an asset search doesn't find is read by its product info: public, or the person's own, goes in; anything else is refused", async () => {
    const CASES: Array<[string, Record<string, unknown>, boolean]> = [
      ["free to take", { publicDomain: true, creatorId: 5, creatorType: "User", user: USER, name: "Rock" }, true],
      [
        "the person's own",
        { publicDomain: false, creatorId: USER, creatorType: "User", user: USER, name: "Mine" },
        true,
      ],
      [
        "someone else's, not free",
        { publicDomain: false, creatorId: 5, creatorType: "User", user: USER, name: "Pack" },
        false,
      ],
      ["a group's", { publicDomain: false, creatorId: USER, creatorType: "Group", user: USER, name: "Pack" }, false],
      ["no answer", { error: "HTTP 400" }, false],
    ];
    for (const [why, info, inserts] of CASES) {
      const { stand, answer } = insert(
        { search: searchAnswer([storeResult("1", true)]), info },
        { id: "123456" },
        await gameIn(),
      );
      const answered = await answer;
      assert.equal(answered.done, inserts, `${why}: ${answered.message}`);
      assert.equal(
        stand.calls.some((call) => call.name === "insert_asset"),
        inserts,
        why,
      );
      if (!inserts) assert.match(answered.message, /free/, why);
    }
  });

  it("a search Studio refused falls back to the product info", async () => {
    const { stand, answer } = insert(
      {
        search: text("search is down", true),
        info: { publicDomain: true, creatorId: 5, creatorType: "User", user: USER },
      },
      { id: FREE },
      await gameIn(),
    );
    assert.equal((await answer).done, true);
    assert.ok(stand.calls.some((call) => call.name === "insert_asset"));
  });

  it("passes Studio's own refusal of the insert through in its words", async () => {
    const { answer } = insert(
      {
        search: searchAnswer([storeResult(FREE, true)]),
        insert: text("Asset is restricted and can't be inserted.", true),
      },
      { id: FREE },
      await gameIn(),
    );
    refused(await answer, /Asset is restricted and can't be inserted\./);
  });

  const NOT_AN_ID: Array<[string, unknown]> = [
    ["letters", "abc"],
    ["digits and letters", "12a"],
    ["nothing", ""],
    ["a minus", "-5"],
    ["zero", "0"],
    ["a leading zero", "0123"],
    ["an exponent", "1e9"],
    ["a space", "12 34"],
    ["a line break", "123\n4"],
    ["a number, not text", 580221169],
    ["past 20 digits", "123456789012345678901"],
    ["full-width digits", "１２３"],
    ["an asset address", "rbxassetid://580221169"],
  ];
  for (const [why, id] of NOT_AN_ID)
    it(`refuses an id that isn't plain digits (${why}), with no Studio call`, async () => {
      const { stand, answer } = insert({ search: searchAnswer([storeResult(FREE, true)]) }, { id }, await gameIn());
      refused(await answer, /digits/);
      assert.deepEqual(stand.calls, []);
    });

  const BAD_ARGS: Array<[string, Record<string, unknown>]> = [
    ["an unknown asset type", { id: FREE, type: "Script" }],
    ["a parent path with a line break", { id: FREE, parent: "Workspace\nX" }],
    ["an empty parent segment", { id: FREE, parent: "Workspace..X" }],
    ["a name with a line break", { id: FREE, name: "Tree\nTwo" }],
    ["a name past its length", { id: FREE, name: "x".repeat(101) }],
  ];
  for (const [why, args] of BAD_ARGS)
    it(`refuses ${why}, with no Studio call`, async () => {
      const { stand, answer } = insert({ search: searchAnswer([storeResult(FREE, true)]) }, args, await gameIn());
      refused(await answer);
      assert.deepEqual(stand.calls, []);
    });

  it("with no Studio bound to the game, says so and calls nothing", async () => {
    const { stand, answer } = insert(
      { search: searchAnswer([storeResult(FREE, true)]) },
      { id: FREE },
      await gameIn(false),
    );
    refused(await answer, /isn't open in Roblox Studio/);
    assert.deepEqual(stand.calls, []);
  });
});

/**
 * The `items-store` dev fixture: the fixture game stands for the account's Snowball on Genex (its
 * Genex publish record names Snowball's project, which the fixture store treats as the account's),
 * and its chat ends with the ask, the agent's reply and the Listing draft card for Frost Axe, through
 * a real core.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import {
  FIXTURE_ITEMS_GAME,
  FIXTURE_LOCAL_GAME,
  FIXTURE_LOCAL_SLUG,
  fixtureGameId,
  fixtureLocalRuns,
  seedItemsStore,
} from "../../src/main/dev/fixture-items.ts";
import { FIXTURE_ACCOUNT_TOKEN } from "../../src/main/dev/fixture-people.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { FIXTURE_NAMES, FixtureName } from "../../src/main/dev/fixture-kit.ts";
import { createFixtureStore, FixtureStoreItem } from "../../src/main/dev/fixture-store.ts";
import { isLocalDraft } from "../../src/shared/item-draft.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { coreLite } from "../helpers/core-lite.ts";

it("is a named fixture", () => {
  assert.equal(FixtureName.ItemsStore, "items-store");
  assert.ok((FIXTURE_NAMES as readonly string[]).includes("items-store"));
});

it("makes the fixture game Snowball on Genex and ends its chat with Frost Axe's Listing draft card", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const project = await core.games.scaffold("fixture-game", { title: "Fixture Game" });
    const threadId = await core.threadForGame(project.name);
    await seedItemsStore(core, project.name, threadId);

    const record = path.join(
      core.pluginServices.root(GENEX_PLUGIN_ID),
      "publish",
      project.name,
      ".genex",
      "project.json",
    );
    const hosted = JSON.parse(await readFile(record, "utf8")) as { id: unknown; slug: unknown };
    assert.equal(hosted.slug, FIXTURE_ITEMS_GAME);
    assert.match(String(hosted.id), /^fx\d{4}$/, "Snowball's id in the fixture catalog");

    const entries = toEntries(await core.store.listEvents(threadId));
    const last = entries.at(-1);
    assert.equal(last?.kind, EntryKind.ListingDraft);
    const shown = last?.kind === EntryKind.ListingDraft ? last.draft : null;
    assert.equal(shown && !isLocalDraft(shown) ? shown.itemId : null, FixtureStoreItem.FrostAxe);
    assert.equal(entries.at(-2)?.kind, EntryKind.Assistant);
  } finally {
    lite.core.plugins.cancel();
    await lite.close();
  }
});

it("gives a second game, not on Genex yet, a local draft that settles to On sale once it is published and approved", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const project = await core.games.scaffold("fixture-game", { title: "Fixture Game" });
    await seedItemsStore(core, project.name, await core.threadForGame(project.name));

    const threadId = await core.threadForGame(FIXTURE_LOCAL_GAME);
    const last = toEntries(await core.store.listEvents(threadId)).at(-1);
    const card = last?.kind === EntryKind.ListingDraft ? last.draft : null;
    assert.ok(card && isLocalDraft(card), "its chat ends with a local draft's card");
    const game = core.games.dirFor(FIXTURE_LOCAL_GAME);
    const items = path.join(game, ".genex", "items");
    assert.deepEqual((await readdir(items)).sort(), [card.localId, `${card.localId}.json`]);
    assert.equal((await core.localItems.view(FIXTURE_LOCAL_GAME)).drafts[card.localId]?.contentHash, card.contentHash);

    const request = createFixtureStore({ now: Date.now, fallback: fixturePlayRequest });
    const runs = fixtureLocalRuns({ request, token: async () => FIXTURE_ACCOUNT_TOKEN, core: () => core });
    assert.equal(await runs.sync(FIXTURE_LOCAL_GAME), null, "nothing goes up before the game is on Genex");

    await core.localItems.approve(FIXTURE_LOCAL_GAME, card.localId, card.contentHash);
    const record = path.join(core.pluginServices.root(GENEX_PLUGIN_ID), "publish", FIXTURE_LOCAL_GAME, ".genex");
    await mkdir(record, { recursive: true });
    const hosted = { id: await fixtureGameId(FIXTURE_LOCAL_SLUG), slug: FIXTURE_LOCAL_SLUG };
    await writeFile(path.join(record, "project.json"), JSON.stringify(hosted));
    const synced = await runs.sync(FIXTURE_LOCAL_GAME);
    assert.equal(synced?.length, 1);
    const skuId = synced?.[0]?.skuId ?? "";
    assert.match(skuId, /^fxm-\d+$/);
    assert.deepEqual(await readdir(items), [], "the uploaded draft left the game");
    const answer = await request(`/api/coin/skus/${skuId}/publish`, { method: "POST", token: FIXTURE_ACCOUNT_TOKEN });
    assert.equal(answer.status, 200, "the fixture store puts it on sale");
  } finally {
    lite.core.plugins.cancel();
    await lite.close();
  }
});

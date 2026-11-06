/**
 * The `native-review` dev fixture through a real core: five games on Genex whose sidebar lines read
 * the mockup's C1 from what the Genex plugin keeps, and whose news arrives as `genex_review` records
 * in each game's own chat after the window is up.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { nativeReviewArrivals, seedNativeReview } from "../../src/main/dev/fixture-native-review.ts";
import { CustomEvent, customPayload } from "../../src/shared/custom-events.ts";
import { GenexReviewChange, GenexSidebarLine } from "../../src/shared/genex-review.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { coreLite } from "../helpers/core-lite.ts";

it("lays down five games on Genex, each with the line the mockup gives it", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const project = await core.games.scaffold("fixture-game", { title: "Fixture Game" });
    await seedNativeReview(core, project.name, await core.threadForGame(project.name));
    const lines = await core.genexReviewLines();
    assert.deepEqual(Object.fromEntries(Object.entries(lines).map(([game, entry]) => [game, entry.line])), {
      "fixture-game": GenexSidebarLine.TakenDown,
      "review-skate": GenexSidebarLine.HumanReview,
      "review-stick": GenexSidebarLine.Public,
      "review-cathedral": GenexSidebarLine.Public,
      "review-silence": GenexSidebarLine.InReview,
    });
    assert.equal((await core.games.list()).find((game) => game.name === project.name)?.title, "Midnight Asphalt");
    assert.equal(await core.genexGameOfSlug("midnight-asphalt"), project.name, "a genex://create link finds it");
    assert.equal(await core.genexGameOfSlug("nowhere"), null);
  } finally {
    lite.core.plugins.cancel();
    await lite.close();
  }
});

it("tells each game's news in its own chat, and tells the window each change", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const told: string[] = [];
    const emit = core.emit.bind(core);
    core.emit = ((type, payload) => {
      if (type === UiEvent.GenexReviewChanged) told.push((payload as { project: string }).project);
      emit(type, payload);
    }) as typeof core.emit;
    const project = await core.games.scaffold("fixture-game", { title: "Fixture Game" });
    const threadId = await core.threadForGame(project.name);
    await seedNativeReview(core, project.name, threadId);
    await nativeReviewArrivals(core, project.name, 0);
    const last = (await core.store.listEvents(threadId)).at(-1);
    const review = last ? customPayload(last.data, CustomEvent.GenexReview) : null;
    assert.equal(review?.change, GenexReviewChange.TakenDown);
    assert.equal(review?.count, 3);
    assert.deepEqual(told, ["review-silence", "review-cathedral", "review-skate", "review-stick", "fixture-game"]);
  } finally {
    lite.core.plugins.cancel();
    await lite.close();
  }
});

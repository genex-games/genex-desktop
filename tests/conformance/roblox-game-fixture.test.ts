/**
 * The `roblox-game` dev fixture: the fixture game linked to a stand-in Roblox place at its top with
 * the bundled Roblox Studio plugin turned on, its chat holding the link line and the steps card,
 * through a real core and the real plugin.
 */
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { seedRobloxGame } from "../../src/main/dev/fixture-roblox.ts";
import { FIXTURE_NAMES, FixtureName } from "../../src/main/dev/fixture-kit.ts";
import { toolbarItems, visibleToolbarEntries } from "../../src/shared/plugin-toolbar.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { coreLite } from "../helpers/core-lite.ts";

const ROBLOX = "roblox";

it("is a named fixture", () => {
  assert.equal(FixtureName.RobloxGame, "roblox-game");
  assert.ok((FIXTURE_NAMES as readonly string[]).includes("roblox-game"));
});

it("turns Roblox Studio on, links the game to its place and puts the steps card in the chat", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const project = await core.games.scaffold("fixture-game", { title: "Fixture Game" });
    const threadId = await core.threadForGame(project.name);
    await seedRobloxGame(core, project, threadId);

    assert.equal(core.plugins.enabled(ROBLOX), true, "the plugin is on");

    const custom = (await core.store.listEvents(threadId))
      .map((e) => e.data)
      .filter((data) => data.type === EventKind.Custom)
      .map((data) => data as { event_type: string; payload: Record<string, unknown> });
    const linked = custom.find((e) => e.event_type === CustomEvent.EngineLinked)?.payload;
    assert.equal(linked?.engine, ROBLOX);
    assert.equal(linked?.label, "Roblox Studio");
    assert.equal(linked?.name, "FixtureGame");
    assert.equal(linked?.auto, true);
    const steps = custom.find((e) => e.event_type === CustomEvent.EngineSteps)?.payload;
    assert.deepEqual(steps, { pluginId: ROBLOX, project: project.name });

    const game = (await core.games.list()).find((g) => g.name === project.name);
    assert.equal(game?.linkedEngine?.label, "Roblox Studio", "the game's engine record names Roblox Studio");
    assert.ok(
      game?.facts.some((fact) => fact.id === "roblox-project"),
      "its facts hold the Roblox place",
    );
    const button = visibleToolbarEntries(toolbarItems(core.plugins.list(), project.name, game), {}).find(
      (entry) => entry.key === `${ROBLOX}:studio`,
    );
    assert.equal(button?.item.label, "Roblox Studio", "the game's toolbar shows the Roblox Studio button");
    const place = String(linked?.file);
    assert.equal(path.dirname(place), await realpath(project.dir), "the place sits at the game's top");
    assert.match(await readFile(place, "utf8"), /^<roblox /, "a place file Studio reads");
  } finally {
    // A core that was never started leaves its plugins' processes to the test.
    lite.core.plugins.cancel();
    await lite.close();
  }
});

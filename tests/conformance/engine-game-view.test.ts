/**
 * A game linked to any engine an installed plugin declares reads as an engine game, never as a web
 * page: the brief, the preview check, Live and the Loop ask whether the game is web, and only
 * Unreal's own card, editor and words stay keyed to Unreal. The made-up toy engine
 * (`tests/fixtures/toy-engine-plugin`, `projectInFolder: false`) stands for any other engine.
 * Tested through the pure rules the app and the harness apply.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { factsOfGame, loopProfileOf, servedAsWeb } from "../../src/harness-seed/loop/folder-facts.ts";
import { engineOfGame as seedEngineOfGame } from "../../src/harness-seed/loop/game-engine.ts";
import { holdsWebGame } from "../../src/harness-seed/loop/web-game.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { engineLoopGate, engineRewindNote, linkedEngineOf } from "../../src/renderer/engine-game.ts";
import { liveViewFor } from "../../src/renderer/live-views.ts";
import { loopAvailableFor } from "../../src/renderer/loop-setting.ts";
import {
  unrealLoopGate,
  unrealProjectInFolder,
  unrealProjectOf,
  unrealRewindNote,
} from "../../src/renderer/unreal-game.ts";
import { ENGINE_GAME_WORDS, UNREAL_WORDS } from "../../src/renderer/words.ts";
import { type EngineBinding, engineOf, isEngineGame, type LinkedEngine } from "../../src/shared/game-engine.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { ObserverLive } from "../../src/shared/observers.ts";
import { CoreFact, FactSource, servedAsWebGame } from "../../src/shared/project-facts.ts";
import { TOY_ENGINE, UNREAL_ENGINE } from "../helpers/engines.ts";

const GAME_DIR = "/Users/me/AI Games/garden";
const LINKED_AT = "2026-10-04T10:00:00.000Z";
const toyLink = (project: string): EngineBinding => ({ kind: TOY_ENGINE.id, project, linkedAt: LINKED_AT });
const unrealLink = (project: string): EngineBinding => ({ kind: UNREAL_ENGINE.id, project, linkedAt: LINKED_AT });
/** What the studio's descriptor says of a linked game's engine, as its plugin declares it. */
const described = ({ label, projectFiles, projectInFolder }: LinkedEngine): LinkedEngine => ({
  label,
  projectFiles,
  projectInFolder,
});

const TOY_FACTS = [{ id: TOY_ENGINE.fact, path: ".", source: FactSource.Link }];
const toyOutside = {
  dir: GAME_DIR,
  engine: toyLink("/Users/me/Documents/Toys/Garden/Garden.toyproj"),
  linkedEngine: described(TOY_ENGINE),
  facts: TOY_FACTS,
};
const toyInside = { ...toyOutside, engine: toyLink(`${GAME_DIR}/toy/Garden.toyproj`) };
/** An engine like the toy's that needs its project in the game folder, as Unreal does. */
const strictToy = { ...toyOutside, linkedEngine: { ...described(TOY_ENGINE), projectInFolder: true } };

describe("a game linked to an engine other than Unreal", () => {
  it("is an engine game, and every web-only and Unreal-only rule says no", () => {
    assert.equal(isEngineGame(engineOf(toyOutside.engine)), true);
    // Web only: the app's served facts, the harness's served facts, its web page check and its Loop.
    assert.equal(servedAsWebGame({ facts: TOY_FACTS }), false, "the app serves it as no web game");
    assert.equal(servedAsWeb(toyOutside), false, "the harness serves it as no web game");
    assert.equal(holdsWebGame(toyOutside), false, "no web page: no preview check at a turn's end");
    assert.equal(loopProfileOf(toyOutside), "open", "the one Loop in place, not the web Loop");
    assert.equal(liveViewFor(toyOutside, []).live, ObserverLive.Stills, "Live shows pictures, never a web preview");
    // Unreal only: the card, the editor's project and Unreal's own words.
    assert.equal(unrealProjectOf(toyOutside), null);
    assert.equal(unrealProjectInFolder(toyInside), false);
    assert.equal(unrealRewindNote(strictToy), null, "Unreal's own note names only Unreal's project");
  });

  it("reads as an engine game in the harness when the host lists no facts (an older descriptor)", () => {
    const older = { engine: toyLink("/Users/me/Documents/Toys/Garden/Garden.toyproj") };
    assert.equal(seedEngineOfGame(older), TOY_ENGINE.id);
    assert.equal(servedAsWeb(older), false);
    assert.equal(holdsWebGame(older), false);
    assert.equal(loopProfileOf(older), "open");
    assert.ok(!factsOfGame(older).some((fact) => fact.id === CoreFact.WebGame), "no web game at its root");
  });

  it("is never a web game or Unreal by its id alone, however it is spelled", () => {
    const table: Array<[unknown, boolean]> = [
      ["web", false],
      ["unreal", true],
      ["toy-engine", true],
      [undefined, false],
      [null, false],
      ["", false],
      ["Toy Engine", false],
      [3, false],
    ];
    for (const [kind, engine] of table) assert.equal(isEngineGame(kind), engine, String(kind));
  });
});

describe("the Loop and Rewind for an engine game", () => {
  it("runs the Loop when the engine keeps its project anywhere, and waits only for one that needs it in the folder", () => {
    assert.equal(loopAvailableFor(toyOutside), true, "the toy engine's project may live outside the folder");
    assert.equal(loopAvailableFor(toyInside), true);
    assert.equal(loopAvailableFor(strictToy), false, "an engine that needs its project in the folder waits");
    assert.equal(loopAvailableFor({ ...strictToy, engine: toyInside.engine }), true);
  });

  it("keeps an Unreal game's Loop and Rewind as they were, described or not", () => {
    const unrealOutside = {
      dir: GAME_DIR,
      engine: unrealLink("/Users/me/Documents/Unreal Projects/Valley/Valley.uproject"),
    };
    const unrealInside = { dir: GAME_DIR, engine: unrealLink(`${GAME_DIR}/unreal/Valley.uproject`) };
    for (const linkedEngine of [undefined, described(UNREAL_ENGINE)]) {
      const outside = { ...unrealOutside, ...(linkedEngine ? { linkedEngine } : {}) };
      const inside = { ...unrealInside, ...(linkedEngine ? { linkedEngine } : {}) };
      assert.equal(loopAvailableFor(outside), false);
      assert.equal(loopAvailableFor(inside), true);
      assert.equal(
        engineRewindNote(outside),
        "Rewind doesn’t undo changes made in Unreal: Valley is outside the game folder.",
      );
      assert.equal(engineRewindNote(outside), unrealRewindNote(outside));
      assert.equal(engineRewindNote(inside), null);
      assert.equal(
        engineLoopGate(outside),
        "Loops need the Unreal project inside this game’s folder, so Rewind can undo each step; Valley is in Documents › Unreal Projects. Make a new one from the Unreal button, or move Valley into this game’s folder and choose it there. Until then, it does what you ask, then stops.",
      );
      assert.equal(engineLoopGate(outside), unrealLoopGate(outside));
    }
    assert.equal(
      UNREAL_WORDS.loopUnavailable(null, ""),
      "Loops need this game’s Unreal project inside its folder, so Rewind can undo each step. A new Unreal project made from the Unreal button goes there. Until then, it does what you ask, then stops.",
    );
  });

  it("names the engine by its label, and its project by its own file kind", () => {
    assert.deepEqual(linkedEngineOf(toyOutside), described(TOY_ENGINE));
    assert.equal(linkedEngineOf({ dir: GAME_DIR }), null, "a web game has none");
    assert.equal(engineRewindNote(toyOutside), null, "its save points don't need the project: nothing to warn of");
    assert.equal(engineRewindNote(strictToy), ENGINE_GAME_WORDS.rewindNote("Toy", "Garden"));
    assert.match(engineLoopGate(strictToy), /^Loops need the Toy project inside this game’s folder/);
    assert.match(engineLoopGate(strictToy), /Garden is in Documents › Toys\./);
    for (const words of [engineRewindNote(strictToy) ?? "", engineLoopGate(strictToy)])
      assert.doesNotMatch(words, /Unreal|overnight|night|morning|tonight/i);
  });
});

describe("a link's line in the chat", () => {
  const linked = (payload: Record<string, unknown>): EventEnvelope => ({
    id: "000001",
    thread_id: "t1",
    turn_id: "turn",
    session_id: null,
    created_at: LINKED_AT,
    data: {
      type: "custom",
      event_type: "engine_linked",
      payload: { pluginId: TOY_ENGINE.id, project: "garden", title: "Garden", name: "Garden", ...payload },
    },
  });
  const lineOf = (payload: Record<string, unknown>) =>
    toEntries([linked(payload)]).find((e) => e.kind === EntryKind.Action && e.action === EntryAction.EngineLink);

  it("narrates a toy link by its label, and never calls another engine Unreal", () => {
    const labelled = lineOf({ engine: TOY_ENGINE.id, label: TOY_ENGINE.label });
    assert.ok(labelled?.kind === EntryKind.Action);
    assert.equal(labelled.text, "Garden now builds in Toy · Garden");
    const unlabelled = lineOf({ engine: TOY_ENGINE.id });
    assert.ok(unlabelled?.kind === EntryKind.Action);
    assert.doesNotMatch(unlabelled.text, /Unreal/, "a record naming another engine is not Unreal's");
    const older = lineOf({ pluginId: "unreal" });
    assert.ok(older?.kind === EntryKind.Action);
    assert.equal(older.text, "Garden now builds in Unreal · Garden", "a record from before engines were declared");
  });
});

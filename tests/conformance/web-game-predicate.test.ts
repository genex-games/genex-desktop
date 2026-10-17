/**
 * The one place a chat decides a game is a web page: a game the app linked to no other engine whose
 * facts hold a web game at its root (`GameProject.facts`). A descriptor made before facts were
 * listed reads by its `web` flag; one made before that, or no descriptor at all, is a web game, as
 * every game was before.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { holdsWebGame } from "../../src/harness-seed/loop/web-game.ts";

const UNREAL = { kind: GameEngine.Unreal, project: "/games/rally/Rally.uproject" };

describe("whether a chat's game is a web page", () => {
  it("is a web game only when no engine claims it and its folder does not say otherwise", () => {
    const table: Array<[string, unknown, boolean]> = [
      ["a descriptor with no flag", {}, true],
      ["a web folder", { web: true }, true],
      ["a folder with no web page", { web: false }, false],
      ["a game linked to Unreal", { engine: UNREAL }, false],
      ["a game linked to Unreal that also has a web page", { engine: UNREAL, web: true }, false],
      ["no descriptor", null, true],
      ["an unlisted game", undefined, true],
    ];
    for (const [name, game, web] of table) {
      assert.equal(holdsWebGame(game as never), web, name);
    }
  });

  it("reads the facts a descriptor carries, and a game with no kind yet is no web page", () => {
    const fact = (id: string, path: string) => ({ id, path, source: "core" });
    const table: Array<[string, unknown, boolean]> = [
      ["a game with no kind yet: nothing to look at yet", { facts: [] }, false],
      ["a web game at the root", { facts: [fact("web-game", ".")], web: true }, true],
      ["a Godot project", { facts: [fact("godot-project", ".")], web: false }, false],
      ["a web game in a folder below the root", { facts: [fact("web-game", "site")], web: false }, false],
    ];
    for (const [name, game, web] of table) {
      assert.equal(holdsWebGame(game as never), web, name);
    }
  });
});

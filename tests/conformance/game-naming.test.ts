/**
 * A game started from its first request is named by the model the user picked, before its folder
 * is made; whatever the model does, the game still gets a name it can be saved under.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nameFromReply, nameFromRequest, nameGame, UNTITLED_GAME } from "../../src/main/core/game-naming.ts";
import {
  EngineError,
  type CompleteRequest,
  type CompleteResponse,
  type Engine,
} from "../../src/substrate/engines/types.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";

const REQUEST = "A cozy fishing game on a tiny island. Catch fish, sell them at the dock, upgrade your rod.";

/** An engine that answers every completion with `reply` (or throws it), recording what it was asked. */
function engine(id: string, reply: string | Error | (() => Promise<string>), asked: CompleteRequest[] = []): Engine {
  return {
    id,
    label: id,
    complete: async (request: CompleteRequest): Promise<CompleteResponse> => {
      asked.push(request);
      if (reply instanceof Error) throw reply;
      const content = typeof reply === "function" ? await reply() : reply;
      return { message: { role: "assistant", content } } as CompleteResponse;
    },
  } as unknown as Engine;
}

/** The deps `nameGame` reads: these engines, an ungated budget, and the given timeout. */
function deps(engines: Engine[], timeoutMs = 1_000) {
  return {
    engines: {
      get: (id: string) => {
        const found = engines.find((candidate) => candidate.id === id);
        if (!found) throw new Error(`no engine ${id}`);
        return found;
      },
      firstReady: async () => engines[0] ?? null,
    },
    budget: { run: <T>(_work: unknown, work: () => Promise<T>) => work() },
    timeoutMs,
  };
}

describe("a game's name from its model's reply", () => {
  const cases: Array<[string, string | null]> = [
    ["Tiny Island Fishing", "Tiny Island Fishing"],
    ['"Tiny Island Fishing"', "Tiny Island Fishing"],
    ["“Tiny Island Fishing”.", "Tiny Island Fishing"],
    ["**Tiny Island Fishing**", "Tiny Island Fishing"],
    ["# Tiny Island Fishing\n\nA cozy game about fish.", "Tiny Island Fishing"],
    ["\n\n  Tiny   Island\tFishing  \n", "Tiny Island Fishing"],
    ["Île aux Poissons", "Île aux Poissons"],
    ["", null],
    ["   \n  ", null],
    ['""', null],
  ];
  for (const [reply, expected] of cases)
    it(`${JSON.stringify(reply)} → ${JSON.stringify(expected)}`, () => assert.equal(nameFromReply(reply), expected));

  it("a long reply is cut on a word, never mid-word, within the name's length", () => {
    const name = nameFromReply("The Extraordinarily Long Adventures Of A Very Small Fishing Boat Captain");
    assert.ok(name);
    assert.ok(name.length <= 40, name);
    assert.ok("The Extraordinarily Long Adventures Of A Very Small Fishing Boat Captain".startsWith(name));
    assert.ok(!name.endsWith(" "));
  });

  it("control characters never reach the name", () => {
    assert.equal(nameFromReply("Tiny\u0007 Island"), "Tiny Island");
  });
});

describe("a game's name from its request, when the model gives none", () => {
  it("is the request's first sentence, cut to a name's length", () => {
    assert.equal(nameFromRequest(REQUEST), "A cozy fishing game on a tiny island");
  });
  it("starts with a capital", () => {
    assert.equal(nameFromRequest("make a pong clone"), "Make a pong clone");
  });
  it("is Untitled game when the request has no words", () => {
    assert.equal(nameFromRequest("   \n!!!"), UNTITLED_GAME);
    assert.equal(nameFromRequest(""), UNTITLED_GAME);
  });
});

describe("naming a game", () => {
  it("asks the picked engine and model, with the request, in one tool-free completion", async () => {
    const asked: CompleteRequest[] = [];
    const named = await nameGame(
      deps([engine("other", "Wrong"), engine("claude-code", "Tiny Island Fishing", asked)]),
      {
        prompt: REQUEST,
        engine: "claude-code",
        model: "opus",
      },
    );
    assert.deepEqual(named, { title: "Tiny Island Fishing" });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.model, "opus");
    assert.deepEqual(asked[0]?.tools, []);
    assert.ok(JSON.stringify(asked[0]?.messages).includes("tiny island"));
  });

  it("uses the first ready engine when none was picked", async () => {
    assert.deepEqual(await nameGame(deps([engine("local", "Rod and Reel")]), { prompt: REQUEST }), {
      title: "Rod and Reel",
    });
  });

  it("leaves a game whose first message names none (a greeting, a test) Untitled, its name waiting for an idea", async () => {
    for (const reply of ["NONE", "None.", "**NONE**"])
      assert.deepEqual(await nameGame(deps([engine("a", reply)]), { prompt: "Hello" }), {
        title: UNTITLED_GAME,
        provisional: true,
      });
  });

  it("falls back to the request when the engine fails, answers nothing, or is not there", async () => {
    // The request's own words are a stand-in: the name still waits for the model's.
    const fallback = { title: "A cozy fishing game on a tiny island", provisional: true };
    assert.deepEqual(await nameGame(deps([engine("a", new Error("signed out"))]), { prompt: REQUEST }), fallback);
    assert.deepEqual(await nameGame(deps([engine("a", "")]), { prompt: REQUEST }), fallback);
    assert.deepEqual(await nameGame(deps([]), { prompt: REQUEST }), fallback);
    assert.deepEqual(await nameGame(deps([engine("a", "x")]), { prompt: REQUEST, engine: "missing" }), fallback);
    const cannotComplete = { id: "b", label: "b" } as unknown as Engine;
    assert.deepEqual(await nameGame(deps([cannotComplete]), { prompt: REQUEST }), fallback);
  });

  it("says the picked engine is out of usage, in its own words, so no game is made for a turn it cannot take", async () => {
    const weekly = "You've hit your weekly limit · resets 6pm";
    const limited = () => new EngineError(EngineFailureKind.UsageLimit, "claude-code", weekly);
    const picked = await nameGame(deps([engine("claude-code", limited())]), { prompt: REQUEST, engine: "claude-code" });
    assert.equal(picked.limited, weekly);
    assert.equal(picked.title, "A cozy fishing game on a tiny island", "it still has a name to show meanwhile");
    // Only the picked engine's cap says the turn cannot run; a wait that ends soon and any other
    // failure name the game from the request as before.
    const firstReady = await nameGame(deps([engine("claude-code", limited())]), { prompt: REQUEST });
    assert.equal(firstReady.limited, undefined, "an engine nobody picked says nothing of the turn's");
    for (const failure of [
      new EngineError(EngineFailureKind.RateLimit, "claude-code", "Session limit reached"),
      new EngineError(EngineFailureKind.Auth, "claude-code", "signed out"),
      new Error("You've hit your weekly limit"),
    ]) {
      const named = await nameGame(deps([engine("claude-code", failure)]), { prompt: REQUEST, engine: "claude-code" });
      assert.deepEqual(named, { title: "A cozy fishing game on a tiny island", provisional: true }, failure.message);
    }
  });

  it("does not wait past its time for a slow model", async () => {
    const slow = engine("slow", () => new Promise<string>((resolve) => setTimeout(() => resolve("Too Late"), 500)));
    const started = Date.now();
    const named = await nameGame(deps([slow], 20), { prompt: REQUEST });
    assert.deepEqual(named, { title: "A cozy fishing game on a tiny island", provisional: true });
    assert.ok(Date.now() - started < 400, "the name came from the request without waiting for the model");
  });

  it("refuses a request that is not text, and names an empty one Untitled game", async () => {
    await assert.rejects(nameGame(deps([]), { prompt: 42 as unknown as string }));
    assert.deepEqual(await nameGame(deps([engine("a", "")]), { prompt: "" }), {
      title: UNTITLED_GAME,
      provisional: true,
    });
  });
});

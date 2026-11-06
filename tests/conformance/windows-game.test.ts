/**
 * A game from Play on Windows runs in an AppContainer of its own (`windows-game.ts`). An
 * AppContainer reaches no loopback port, so no gateway can serve it: with a way to Genex, its
 * container gets the internet as a client and the game is told Genex's API, its sign-in ticket and
 * its name. Without one, or with an address that doesn't hold up, it is told nothing and its
 * container gets no network at all. The person's own environment never reaches it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameGenexEnv, NativeGameRequest } from "../../src/substrate/plugins/native-process.ts";
import { gameHostRequest } from "../../src/substrate/plugins/windows-game.ts";

const API = "https://api.genex.games";
const TICKET = "t".repeat(32);

const GAME: NativeGameRequest = {
  binary: "C:\\Genex\\games\\genex-strike\\1.0\\Win64\\BodycamProject-Win64-Shipping.exe",
  app: "C:\\Genex\\games\\genex-strike\\1.0",
  saves: "C:\\Genex\\games\\genex-strike\\saves",
  scratch: "C:\\Genex\\games\\.scratch-genex-strike-1",
  bundleId: "games.genex.play.genex-strike",
  bundleName: "BodycamProject",
  args: ["-fullscreen"],
};

/** The person's environment: Windows' own folders, and Genex values of their own that must not pass. */
const PERSON: NodeJS.ProcessEnv = {
  SystemRoot: "C:\\Windows",
  LOCALAPPDATA: "C:\\Users\\rab\\AppData\\Local",
  GENEX_API_URL: "https://elsewhere.example",
  GENEX_EMBED_TICKET: "p".repeat(32),
  GENEX_GAME: "another-game",
};

const withGenex = (env: GameGenexEnv): NativeGameRequest => ({ ...GAME, genex: { ports: [], env } });
const genexKeys = (env: Record<string, string>) => Object.keys(env).filter((key) => key.startsWith("GENEX_"));

describe("a Windows game's way to Genex", () => {
  it("tells a game with a way to Genex the API, its ticket and its name, and gives its container the internet", () => {
    const host = gameHostRequest(
      withGenex({ GENEX_API_URL: API, GENEX_EMBED_TICKET: TICKET, GENEX_GAME: "genex-strike" }),
      PERSON,
    );
    assert.equal(host.internet, true);
    assert.equal(host.env.GENEX_API_URL, API);
    assert.equal(host.env.GENEX_EMBED_TICKET, TICKET);
    assert.equal(host.env.GENEX_GAME, "genex-strike");
    assert.equal(host.env.SystemRoot, "C:\\Windows", "Windows' own folders still reach it");
  });

  it("signs a game in as a guest when there is no ticket, still online", () => {
    const host = gameHostRequest(withGenex({ GENEX_API_URL: API, GENEX_GAME: "genex-strike" }), PERSON);
    assert.equal(host.internet, true);
    assert.deepEqual(genexKeys(host.env).sort(), ["GENEX_API_URL", "GENEX_GAME"]);
  });

  it("keeps a game with no way to Genex offline and tells it nothing, the person's own values included", () => {
    const host = gameHostRequest(GAME, PERSON);
    assert.equal(host.internet, false);
    assert.deepEqual(genexKeys(host.env), []);
  });

  // Each address is refused whole: the game is told nothing of Genex and its container stays offline.
  const hostileApis: Array<[string, string]> = [
    ["plain http", "http://api.genex.games"],
    ["a loopback gateway the container can't reach", "http://127.0.0.1:41000"],
    ["a path after the origin", "https://api.genex.games/api/embed"],
    ["a query", "https://api.genex.games?next=https://elsewhere.example"],
    ["credentials", "https://player:secret@api.genex.games"],
    ["a line break smuggling another variable", "https://api.genex.games\r\nGENEX_GAME=other"],
    ["a NUL ending the variable early", "https://api.genex.games\u0000GENEX_GAME=other"],
    ["a file", "file:///C:/Windows/win.ini"],
    ["script", "javascript:alert(1)"],
    ["nothing", ""],
  ];
  for (const [why, api] of hostileApis) {
    it(`refuses ${why} as Genex's API, and the game stays offline`, () => {
      const host = gameHostRequest(
        withGenex({ GENEX_API_URL: api, GENEX_EMBED_TICKET: TICKET, GENEX_GAME: "genex-strike" }),
        PERSON,
      );
      assert.equal(host.internet, false, why);
      assert.deepEqual(genexKeys(host.env), [], why);
    });
  }

  // A good API with a bad ticket or name: the game goes online, without the value that doesn't hold up.
  const hostileValues: Array<[string, Partial<GameGenexEnv>, string]> = [
    ["a short ticket", { GENEX_EMBED_TICKET: "short" }, "GENEX_EMBED_TICKET"],
    ["a ticket with a NUL", { GENEX_EMBED_TICKET: `${TICKET}\u0000X=1` }, "GENEX_EMBED_TICKET"],
    ["a ticket with a space", { GENEX_EMBED_TICKET: `${TICKET} ${TICKET}` }, "GENEX_EMBED_TICKET"],
    ["a name climbing out", { GENEX_GAME: "../other" }, "GENEX_GAME"],
    ["a name with spaces", { GENEX_GAME: "Genex Strike" }, "GENEX_GAME"],
  ];
  for (const [why, values, dropped] of hostileValues) {
    it(`drops ${why} and keeps the rest`, () => {
      const env = { GENEX_API_URL: API, GENEX_EMBED_TICKET: TICKET, GENEX_GAME: "genex-strike", ...values };
      const host = gameHostRequest(withGenex(env), PERSON);
      assert.equal(host.internet, true, why);
      assert.equal(host.env.GENEX_API_URL, API, why);
      assert.equal(host.env[dropped], undefined, why);
    });
  }
});

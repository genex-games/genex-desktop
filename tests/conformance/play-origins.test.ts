/**
 * Where Play talks to genex.games. A release always uses genex.games' API, website and game hosts;
 * only a development profile may point Play at a local or test copy (a stand), through environment
 * variables main reads. Each origin must be a bare origin: https anywhere, plain http only on this
 * Mac. Anything else is ignored and that side stays on genex.games, so a typo never sends the
 * account's token anywhere new. A stand's games, the Genex host tools' CLI and the trust of a stand's
 * own CA follow the stand only while its API is the stand's. Links the app hands to the browser
 * follow the same website.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserMayOpen,
  developmentLaunch,
  devOrigin,
  devStand,
  genexPageAddress,
  onWebsite,
  PlayOriginEnv,
  playOrigins,
  websitePageOpener,
} from "../../src/main/play/origins.ts";
import { PLAY_ORIGIN } from "../../src/shared/play.ts";

const LOCAL = {
  [PlayOriginEnv.Api]: "http://localhost:3000",
  [PlayOriginEnv.Web]: "http://localhost:5173",
};

describe("Play's origins", () => {
  it("are genex.games' outside a development profile, whatever the environment says", () => {
    assert.deepEqual(playOrigins(LOCAL, false), PLAY_ORIGIN);
    assert.deepEqual(playOrigins({}, false), PLAY_ORIGIN);
  });

  it("follow the development profile's variables, each on its own", () => {
    assert.deepEqual(playOrigins(LOCAL, true), {
      api: "http://localhost:3000",
      web: "http://localhost:5173",
      games: PLAY_ORIGIN.games,
    });
    assert.deepEqual(playOrigins({ [PlayOriginEnv.Api]: "https://api.stand.example.test/" }, true), {
      api: "https://api.stand.example.test",
      web: PLAY_ORIGIN.web,
      games: PLAY_ORIGIN.games,
    });
    assert.deepEqual(playOrigins({}, true), PLAY_ORIGIN);
  });

  it("serve games from the stand's game host only while Play's API is the stand's", () => {
    const games = { [PlayOriginEnv.Games]: "https://localhost:8443" };
    assert.deepEqual(playOrigins({ ...LOCAL, ...games }, true), {
      api: "http://localhost:3000",
      web: "http://localhost:5173",
      games: "https://localhost:8443",
    });
    // genex.games' own account and tickets never go to a stand's game pages.
    assert.deepEqual(playOrigins(games, true), PLAY_ORIGIN);
    assert.deepEqual(
      playOrigins({ [PlayOriginEnv.Web]: "http://localhost:5173", ...games }, true).games,
      PLAY_ORIGIN.games,
    );
  });

  it("take a bare https origin anywhere and plain http only on this Mac", () => {
    const cases: Array<[string, string]> = [
      ["https://dev.genex.games", "https://dev.genex.games"],
      ["https://dev.genex.games/", "https://dev.genex.games"],
      ["  https://stand.example.test:8443  ", "https://stand.example.test:8443"],
      ["HTTPS://Stand.Example.Test", "https://stand.example.test"],
      ["http://localhost:3000", "http://localhost:3000"],
      ["http://127.0.0.1:5173/", "http://127.0.0.1:5173"],
      ["http://[::1]:3000", "http://[::1]:3000"],
    ];
    for (const [raw, origin] of cases) assert.equal(devOrigin(raw), origin, raw);
  });

  it("ignore anything that is not a bare origin, and keep genex.games for that side", () => {
    const hostile = [
      "",
      "   ",
      "localhost:3000",
      "not a url",
      "http://dev.genex.games",
      "http://192.168.1.20:3000",
      "http://localhost.evil.example:3000",
      "https://user:secret@dev.genex.games",
      "https://:secret@dev.genex.games",
      "https://dev.genex.games/api",
      "https://dev.genex.games/?next=1",
      "https://dev.genex.games/#x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://dev.genex.games",
      "ws://localhost:3000",
      "https://dev.genex.games\n.evil.example",
    ];
    for (const raw of hostile) {
      assert.equal(devOrigin(raw), null, JSON.stringify(raw));
      assert.deepEqual(
        playOrigins({ [PlayOriginEnv.Api]: raw, [PlayOriginEnv.Web]: raw, [PlayOriginEnv.Games]: raw }, true),
        PLAY_ORIGIN,
        JSON.stringify(raw),
      );
      // A stand's API with a hostile game host: games stay on genex.games, and nothing is trusted.
      const stand = devStand({ ...STAND, [PlayOriginEnv.Games]: raw }, DEVELOPMENT);
      assert.equal(stand.origins.games, PLAY_ORIGIN.games, JSON.stringify(raw));
      assert.equal(stand.gamesCaFile, null, JSON.stringify(raw));
    }
    assert.equal(devOrigin(undefined), null);
  });
});

/** A development profile's whole stand: the local stack's API, website, game host and CA. */
const STAND = {
  [PlayOriginEnv.Api]: "http://localhost:3000",
  [PlayOriginEnv.Web]: "http://localhost:5173",
  [PlayOriginEnv.Games]: "https://localhost:8443",
  [PlayOriginEnv.GamesCa]: "/tmp/mkt-e2e/certs/ca.pem",
};
/** A `studio:dev` profile, unpackaged, with live providers. */
const DEVELOPMENT = { developerProfile: true, packaged: false, fixture: false };
/** What every launch that is not a development one gets, whatever its environment says. */
const RELEASE_STAND = { origins: PLAY_ORIGIN, hostToolsApi: null, gamesCaFile: null };

describe("a development profile's stand", () => {
  it("is genex.games for every launch but an unpackaged, non-fixture development profile", () => {
    const launches: Array<[string, typeof DEVELOPMENT, boolean]> = [
      ["the released app", { developerProfile: false, packaged: true, fixture: false }, false],
      [
        "a packaged app started as a developer profile",
        { developerProfile: true, packaged: true, fixture: false },
        false,
      ],
      ["a packaged fixture launch", { developerProfile: true, packaged: true, fixture: true }, false],
      [
        "the normal profile from the checkout (npm start)",
        { developerProfile: false, packaged: false, fixture: false },
        false,
      ],
      ["a smoke or self-test run", { developerProfile: false, packaged: false, fixture: true }, false],
      ["a fixture development profile", { developerProfile: true, packaged: false, fixture: true }, false],
      ["a live development profile", DEVELOPMENT, true],
    ];
    for (const [name, launch, development] of launches) {
      assert.equal(developmentLaunch(launch), development, name);
      const stand = devStand(STAND, launch);
      if (development) continue;
      assert.deepEqual(stand, RELEASE_STAND, name);
      // Each variable on its own changes nothing either.
      for (const [key, value] of Object.entries(STAND))
        assert.deepEqual(devStand({ [key]: value }, launch), RELEASE_STAND, `${name}: ${key}`);
    }
  });

  it("points Play, the Genex host tools' CLI and the game hosts' trust at the stand in a development profile", () => {
    assert.deepEqual(devStand(STAND, DEVELOPMENT), {
      origins: { api: "http://localhost:3000", web: "http://localhost:5173", games: "https://localhost:8443" },
      hostToolsApi: "http://localhost:3000",
      gamesCaFile: "/tmp/mkt-e2e/certs/ca.pem",
    });
    // Without a stand API the host tools stay on genex.games with the Genex plugin's account.
    assert.deepEqual(devStand({}, DEVELOPMENT), RELEASE_STAND);
    assert.equal(devStand({ [PlayOriginEnv.Web]: "http://localhost:5173" }, DEVELOPMENT).hostToolsApi, null);
    // A CA is trusted only for a stand's own game host.
    const noGames = { ...STAND, [PlayOriginEnv.Games]: undefined };
    assert.equal(devStand(noGames, DEVELOPMENT).gamesCaFile, null);
  });

  it("refuses a CA file that is not one absolute path", () => {
    const refused = ["", "  ", "ca.pem", "./certs/ca.pem", "~/ca.pem", "/tmp/ca.pem\n/etc/passwd", "/tmp/ca\u0000.pem"];
    for (const raw of refused)
      assert.equal(
        devStand({ ...STAND, [PlayOriginEnv.GamesCa]: raw }, DEVELOPMENT).gamesCaFile,
        null,
        JSON.stringify(raw),
      );
  });
});

describe("a page of Play's website", () => {
  it("is an address on exactly that origin, however the path goes", () => {
    const web = "http://localhost:5173";
    assert.equal(onWebsite("http://localhost:5173/@rabneba", web), true);
    assert.equal(onWebsite("http://localhost:5173/c/ABCD-EFGH", web), true);
    for (const other of [
      "http://localhost:5174/@rabneba",
      "https://localhost:5173/@rabneba",
      "http://localhost:5173.evil.example/",
      "http://user@localhost:5173/",
      "https://genex.games/@rabneba",
      "not a url",
      // A blob: address borrows the origin of the address inside it.
      "blob:http://localhost:5173/9f2c",
    ])
      assert.equal(onWebsite(other, web), false, other);
    assert.equal(onWebsite("https://genex.games/@rabneba", PLAY_ORIGIN.web), true);
    for (const borrowed of ["blob:https://genex.games/9f2c", "blob:https://genex.games/@rabneba"]) {
      assert.equal(onWebsite(borrowed, PLAY_ORIGIN.web), false, borrowed);
      assert.equal(browserMayOpen(borrowed, PLAY_ORIGIN.web), false, borrowed);
    }
  });
});

describe("what the browser opens for Play", () => {
  it("opens any https address, and plain http only on the development website itself", () => {
    const web = "http://localhost:5173";
    assert.equal(browserMayOpen("https://x.com/intent/post?text=hi", web), true);
    assert.equal(browserMayOpen("http://localhost:5173/plans", web), true);
    for (const refused of [
      "http://localhost:3000/",
      "http://example.test/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ])
      assert.equal(browserMayOpen(refused, web), false, refused);
    assert.equal(browserMayOpen("http://localhost:5173/plans", PLAY_ORIGIN.web), false);
  });

  it("opens a sign-in page on the development website as it is, and refuses plain http anywhere else", () => {
    const web = "http://localhost:5173";
    assert.equal(genexPageAddress("http://localhost:5173/c/WXYZ-2345", web), "http://localhost:5173/c/WXYZ-2345");
    assert.equal(
      genexPageAddress("https://genex.games/device?code=1", PLAY_ORIGIN.web),
      "https://genex.games/device?code=1&s=desktop",
    );
    assert.throws(() => genexPageAddress("http://localhost:5173/c/WXYZ-2345", PLAY_ORIGIN.web));
    assert.throws(() => genexPageAddress("javascript:alert(1)", web));
  });

  it("opens Get Nex's page of the development website as sign-in does, and genex.games' page as before", () => {
    const opened: Array<[string, string]> = [];
    const opener = (web: string) =>
      websitePageOpener(
        web,
        (url) => opened.push(["website", url]),
        (url) => opened.push(["outside", url]),
      );
    opener("http://localhost:5173")("http://localhost:5173/inventory");
    opener(PLAY_ORIGIN.web)("https://genex.games/inventory");
    // Anything that is not a page of that website keeps the link rules of every other link.
    opener("http://localhost:5173")("https://genex.games/inventory");
    opener(PLAY_ORIGIN.web)("http://localhost:5173/inventory");
    assert.deepEqual(opened, [
      ["website", "http://localhost:5173/inventory"],
      ["website", "https://genex.games/inventory"],
      ["outside", "https://genex.games/inventory"],
      ["outside", "http://localhost:5173/inventory"],
    ]);
  });
});

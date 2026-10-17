/**
 * Where Play talks to genex.games. A release always uses genex.games' API and website; only a
 * development profile may point Play at a local or test copy, through two environment variables
 * main reads. Each must be a bare origin: https anywhere, plain http only on this Mac. Anything
 * else is ignored and that side stays on genex.games, so a typo never sends the account's token
 * anywhere new. Links the app hands to the browser follow the same website.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserMayOpen,
  devOrigin,
  genexPageAddress,
  onWebsite,
  PlayOriginEnv,
  playOrigins,
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
    assert.deepEqual(playOrigins(LOCAL, true), { api: "http://localhost:3000", web: "http://localhost:5173" });
    assert.deepEqual(playOrigins({ [PlayOriginEnv.Api]: "https://api.stand.example.test/" }, true), {
      api: "https://api.stand.example.test",
      web: PLAY_ORIGIN.web,
    });
    assert.deepEqual(playOrigins({}, true), PLAY_ORIGIN);
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
        playOrigins({ [PlayOriginEnv.Api]: raw, [PlayOriginEnv.Web]: raw }, true),
        PLAY_ORIGIN,
        JSON.stringify(raw),
      );
    }
    assert.equal(devOrigin(undefined), null);
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
});

/**
 * Which of a game's window opens are its coin purchase: genex.games' confirm address for one intent
 * (the SDK's `buy()`), or the blank popup the SDK reserves before it asks to be paid
 * (`requestPayment()`). Each is held to the SDK's own rule for a confirm address; everything else is
 * a link, which goes where links go today and is never captured.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyGameOpen,
  confirmIntentId,
  GameOpen,
  type GameOpenRequest,
} from "../../src/main/play/purchase-address.ts";

const CONFIRM = "https://genex.games";
const GAME = "https://lost-cathedral.genex.technology";
const SCOPE = { confirmOrigin: CONFIRM, gameOrigin: GAME };
/** The SDK's popup features, as `requestPayment()` and `buy()` both pass them. */
const POPUP = "popup,width=420,height=640";

/** A window open from the game's own page, as Electron describes it. */
const open = (url: string, overrides: Partial<GameOpenRequest> = {}): GameOpenRequest => ({
  url,
  frameName: "",
  features: POPUP,
  disposition: "new-window",
  referrer: { url: `${GAME}/` },
  ...overrides,
});

describe("A confirm address", () => {
  it("names the intent genex.games' own confirm page is for", () => {
    assert.equal(confirmIntentId(`${CONFIRM}/confirm/clx123`, CONFIRM), "clx123");
    assert.equal(confirmIntentId(`${CONFIRM}/confirm/cm9z_A-1`, `${CONFIRM}/`), "cm9z_A-1");
    assert.equal(confirmIntentId(`${CONFIRM}/confirm/${"a".repeat(64)}`, CONFIRM), "a".repeat(64));
  });

  it("names nothing for any other address", () => {
    const hostile = [
      "http://genex.games/confirm/clx123",
      "https://genex.games.evil.com/confirm/clx123",
      "https://evil.com/confirm/clx123",
      "https://xn--gnex-games-9db.com/confirm/clx123",
      "https://xn--genx-6qa.games/confirm/clx123",
      "https://genex.games:444/confirm/clx123",
      "https://api.genex.games/confirm/clx123",
      "javascript:alert(1)//genex.games/confirm/clx123",
      "data:text/html,https://genex.games/confirm/clx123",
      "about:srcdoc",
      "",
      "not a url",
      "https://user:pw@genex.games/confirm/clx123",
      "https://user@genex.games/confirm/clx123",
      "https://genex.games/confirm/clx123?x=1",
      "https://genex.games/confirm/clx123?",
      "https://genex.games/confirm/clx123#genex_ticket=secret",
      "https://genex.games/confirm/clx123#",
      "https://genex.games/confirm/",
      "https://genex.games/confirm",
      "https://genex.games/confirm/a/b",
      "https://genex.games/confirm/clx123/",
      "https://genex.games/confirm/..",
      "https://genex.games/confirm/%2e%2e",
      "https://genex.games/confirm/%2F",
      "https://genex.games/confirm/a%2Fb",
      "https://genex.games/confirm/clx%20123",
      `https://genex.games/confirm/${"a".repeat(65)}`,
      "https://genex.games/Confirm/clx123",
      "https://genex.games/CONFIRM/clx123",
      "https://genex.games/x/confirm/clx123",
      "https://genex.games//confirm/clx123",
    ];
    for (const raw of hostile) {
      assert.equal(confirmIntentId(raw, CONFIRM), null, raw);
      assert.deepEqual(classifyGameOpen(open(raw), SCOPE), { kind: GameOpen.Link }, raw);
    }
  });

  it("takes plain http only from a loopback website, and only that website's own", () => {
    const local = "http://localhost:3000";
    assert.equal(confirmIntentId(`${local}/confirm/clx123`, local), "clx123");
    assert.equal(confirmIntentId("http://127.0.0.1:8080/confirm/clx123", "http://127.0.0.1:8080"), "clx123");
    assert.equal(confirmIntentId("http://[::1]:8080/confirm/clx123", "http://[::1]:8080"), "clx123");
    assert.equal(confirmIntentId("http://localhost:3001/confirm/clx123", local), null, "another port");
    assert.equal(confirmIntentId(`${local}/confirm/clx123`, CONFIRM), null, "a production website never takes one");
    assert.equal(confirmIntentId(`${CONFIRM}/confirm/clx123`, local), null);
    const remote = "http://genex.example.com";
    assert.equal(confirmIntentId(`${remote}/confirm/clx123`, remote), null, "plain http elsewhere is never trusted");
    for (const bad of ["", "genex.games", "ftp://genex.games", "javascript:alert(1)"])
      assert.equal(confirmIntentId(`${CONFIRM}/confirm/clx123`, bad), null, bad);
  });
});

describe("A game's window open", () => {
  it("is the purchase's confirm when it opens genex.games' confirm address as a popup", () => {
    const buy = open(`${CONFIRM}/confirm/clx123`, { frameName: "genex_confirm_clx123" });
    assert.deepEqual(classifyGameOpen(buy, SCOPE), { kind: GameOpen.Confirm, intentId: "clx123" });
    assert.deepEqual(classifyGameOpen({ ...buy, referrer: { url: "" } }, SCOPE), {
      kind: GameOpen.Confirm,
      intentId: "clx123",
    });
  });

  it("reserves a hidden window only for a blank popup", () => {
    const reserve = open("about:blank", { frameName: "_blank" });
    assert.deepEqual(classifyGameOpen(reserve, SCOPE), { kind: GameOpen.Reserve });
    for (const features of ["popup", "popup=1", "popup=yes", "popup=true", " popup = yes ,width=1", "POPUP"])
      assert.deepEqual(classifyGameOpen({ ...reserve, features }, SCOPE), { kind: GameOpen.Reserve }, features);
    assert.deepEqual(classifyGameOpen({ ...reserve, referrer: { url: "" } }, SCOPE), { kind: GameOpen.Reserve });
  });

  it("leaves every other open a link", () => {
    const blank = open("about:blank");
    const links: Array<[string, GameOpenRequest]> = [
      ["no popup feature", { ...blank, features: "" }],
      ["only a size", { ...blank, features: "width=420,height=640" }],
      ["popup turned off", { ...blank, features: "popup=no" }],
      ["popup zero", { ...blank, features: "popup=0" }],
      ["popup false", { ...blank, features: "popup=false" }],
      ["a feature that only starts with popup", { ...blank, features: "popups" }],
      ["an empty address", { ...blank, url: "" }],
      ["a blank page with a fragment", { ...blank, url: "about:blank#x" }],
      ["a blank page with a query", { ...blank, url: "about:blank?x" }],
      ["a srcdoc page", { ...blank, url: "about:srcdoc" }],
      ["a tab, not a window", { ...blank, disposition: "foreground-tab" }],
      ["a background tab", { ...blank, disposition: "background-tab" }],
      ["another disposition", { ...blank, disposition: "other" }],
      ["a frame from another site", { ...blank, referrer: { url: "https://ads.example.com/frame" } }],
      ["another Genex game's frame", { ...blank, referrer: { url: "https://other.genex.technology/" } }],
      ["a frame with no real origin", { ...blank, referrer: { url: "data:text/html,x" } }],
      ["a referrer that is not an address", { ...blank, referrer: { url: "nonsense" } }],
      ["a confirm address as a tab", open(`${CONFIRM}/confirm/clx123`, { disposition: "foreground-tab" })],
      [
        "a confirm address from another site's frame",
        open(`${CONFIRM}/confirm/clx123`, { referrer: { url: "https://evil.com/" } }),
      ],
      ["an ordinary link", open("https://example.com/")],
      ["genex.games' home", open(`${CONFIRM}/`)],
    ];
    for (const [why, request] of links)
      assert.deepEqual(classifyGameOpen(request, SCOPE), { kind: GameOpen.Link }, why);
  });

  it("captures nothing when the confirm website is not one Studio trusts", () => {
    const scope = { confirmOrigin: "http://genex.example.com", gameOrigin: GAME };
    assert.deepEqual(classifyGameOpen(open("http://genex.example.com/confirm/clx123"), scope), { kind: GameOpen.Link });
    assert.deepEqual(
      classifyGameOpen(open("about:blank"), scope),
      { kind: GameOpen.Link },
      "nor a popup it could become",
    );
  });
});

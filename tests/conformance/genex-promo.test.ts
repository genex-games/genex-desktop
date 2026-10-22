/**
 * The Genex promo after the welcome: it is queued only by a finished welcome, shows only while
 * Genex could still be connected, settles for good once an account exists or it is dismissed,
 * and its card walks through offer → waiting for the browser → connected (or a retry).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  finishGenexPromo,
  GenexPromoState,
  genexPromoSettled,
  genexPromoVisible,
  PromoPhase,
  promoPhase,
  queueGenexPromo,
  type PromoInput,
} from "../../src/renderer/genex-promo.ts";
import { Overlay, type StageCover, webViewBounds } from "../../src/renderer/panels/stage/native-bounds.ts";
import { STORAGE_KEYS } from "../../src/renderer/storage.ts";

/** A rectangle as `getBoundingClientRect` reports it. */
function box(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function memory(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(STORAGE_KEYS.genexPromo, initial);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const visible = (input: Partial<PromoInput>): boolean =>
  genexPromoVisible({
    stored: GenexPromoState.Pending,
    plugin: { installed: true, enabled: true },
    account: "not connected",
    welcoming: false,
    pluginsOpen: false,
    ...input,
  });

describe("Genex promo", () => {
  it("is queued once by a finished welcome and never re-queued after it settles", () => {
    const fresh = memory();
    queueGenexPromo(fresh);
    assert.equal(fresh.values.get(STORAGE_KEYS.genexPromo), GenexPromoState.Pending);
    const dismissed = memory(GenexPromoState.Done);
    queueGenexPromo(dismissed);
    assert.equal(dismissed.values.get(STORAGE_KEYS.genexPromo), GenexPromoState.Done, "a dismissed promo stays gone");
    finishGenexPromo(fresh);
    assert.equal(fresh.values.get(STORAGE_KEYS.genexPromo), GenexPromoState.Done);
  });

  it("shows only for a queued promo while Genex can still be connected", () => {
    assert.equal(visible({}), true);
    assert.equal(visible({ stored: null }), false, "people who were never welcomed after this change");
    assert.equal(visible({ stored: GenexPromoState.Done }), false);
    assert.equal(visible({ welcoming: true }), false, "never over the welcome");
    assert.equal(visible({ pluginsOpen: true }), false, "Plugins already shows Genex");
    assert.equal(visible({ plugin: undefined }), false, "no Genex plugin to connect");
    assert.equal(visible({ plugin: { installed: false, enabled: true } }), false, "removed");
    assert.equal(visible({ plugin: { installed: true, enabled: false } }), false, "turned off on purpose");
    assert.equal(visible({ account: undefined }), false, "not before the account is known");
    assert.equal(visible({ account: "authorizing" }), true, "its own sign-in keeps it up");
    assert.equal(visible({ account: "failed" }), true, "a failed sign-in can be retried");
    assert.equal(visible({ account: "unlocked" }), false);
    assert.equal(
      visible({ account: "locked" }),
      true,
      "a new profile's account starts locked: nothing is known to be saved until it is unlocked",
    );
  });

  it("waits while a dialog needs the person's attention", () => {
    assert.equal(visible({ overlayOpen: true }), false, "New game and tools stay uncovered");
    assert.equal(visible({ overlayOpen: false }), true, "the queued offer can return over Home or a game's stage");
  });

  it("settles once a Genex account is connected", () => {
    assert.equal(genexPromoSettled("unlocked"), true);
    assert.equal(genexPromoSettled("locked"), false, "locked is also how a never-connected profile starts");
    assert.equal(genexPromoSettled("not connected"), false);
    assert.equal(genexPromoSettled("authorizing"), false);
    assert.equal(genexPromoSettled(undefined), false);
  });

  it("walks the card from the offer to connected", () => {
    const idle = { started: false, error: "", sawSignIn: false };
    const opening = { started: true, error: "", sawSignIn: false };
    const signingIn = { started: true, error: "", sawSignIn: true };
    assert.equal(promoPhase("not connected", idle), PromoPhase.Offer);
    assert.equal(promoPhase("locked", idle), PromoPhase.Offer);
    assert.equal(promoPhase("not connected", opening), PromoPhase.Waiting, "the browser is opening");
    assert.equal(promoPhase("authorizing", idle), PromoPhase.Waiting, "a sign-in begun elsewhere");
    assert.equal(promoPhase("authorizing", signingIn), PromoPhase.Waiting);
    assert.equal(promoPhase("unlocked", signingIn), PromoPhase.Connected);
    assert.equal(promoPhase("failed", opening), PromoPhase.Waiting, "a retry outruns the last failure");
    assert.equal(promoPhase("not connected", signingIn), PromoPhase.Failed, "a sign-in that ended without an account");
    assert.equal(promoPhase("not connected", { ...opening, error: "Sign-in cancelled" }), PromoPhase.Failed);
    assert.equal(promoPhase("failed", idle), PromoPhase.Failed, "the host says the last sign-in failed");
  });
});

describe("Native game visibility", () => {
  it("a floating promo over Live gives the view back to the DOM for Three.js and C++ web games", () => {
    const slot = box(620, 48, 820, 852);
    const promo = { kind: Overlay.Floating, rect: box(1064, 484, 360, 400) };
    const live: StageCover = {
      project: "my-first-game",
      visible: true,
      sidebarOverlay: false,
      buildsOpen: false,
      assetsOpen: false,
      fileOpen: false,
      showEmpty: false,
      liveLoading: false,
      toolbarOpen: false,
      cardOnStage: false,
      pluginCardOnStage: false,
      stillsOnStage: false,
      stopped: false,
      watching: true,
      native: false,
    };
    const shown = { x: 620, y: 48, width: 820, height: 852 };
    const hidden = { x: 0, y: 0, width: 0, height: 0 };
    assert.deepEqual(webViewBounds(live, slot, [promo]), hidden, "the game cannot paint over the floating promo");
    assert.deepEqual(
      webViewBounds({ ...live, project: "bounce-mac" }, slot, [promo]),
      hidden,
      "a C++ web build gives the same rectangle back",
    );
    const beside = { kind: Overlay.Floating, rect: box(1460, 484, 360, 400) };
    assert.deepEqual(webViewBounds(live, slot, [beside]), shown, "a panel beside the stage keeps the web view");
    assert.deepEqual(
      webViewBounds({ ...live, project: "bounce-mac", native: true }, slot, [promo]),
      hidden,
      "a C++ native canvas never exposes the web view",
    );
  });
});

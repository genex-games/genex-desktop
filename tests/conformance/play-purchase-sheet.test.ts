/**
 * The purchase sheet as the bar's layer draws it, rendered by React's server renderer from the plain
 * renderer build: each step's buttons and how they stand, the receipt once paid, the balance short,
 * the placeholder for a purchase with no picture, and a game's words whole but without the
 * characters that turn text around.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import {
  type PlayPurchaseSheet,
  PurchaseAnswer,
  PurchaseProblem,
  PurchaseRecovery,
  PurchaseStep,
} from "../../src/shared/play-purchase.ts";

/** What the test reaches in the bundle: the sheet's face, Radix's dialog root, and React's server renderer. */
interface SheetBundle {
  PurchaseFace: (props: { sheet: PlayPurchaseSheet; answer: (answer: PurchaseAnswer) => void }) => ReactElement;
  Root: unknown;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The sheet's face as the plain renderer build compiles it. */
async function sheetBundle(): Promise<SheetBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export { PurchaseFace } from "./src/renderer/play/PlayPurchase.tsx";',
        'export { Root } from "@radix-ui/react-dialog";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server.edge";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const OVERRIDE = String.fromCodePoint(0x202e);
const ISOLATE = String.fromCodePoint(0x2067);
/** Every character that turns the direction text runs in. */
const BIDI = /\p{Bidi_Control}/u;

/** An Ask sheet for a 75-coin gate, armed, with 1,240 coin to spend; `over` changes what the case needs. */
const sheetWith = (over: Partial<PlayPurchaseSheet> = {}): PlayPurchaseSheet => ({
  sheet: 4,
  step: PurchaseStep.Ask,
  problem: null,
  recovery: null,
  armed: true,
  game: { title: "Lantern Run", coverUrl: null },
  item: {
    name: "Open the iron gate",
    description: "Unlock the shortcut for this run.",
    imageUrl: "https://assets.genex.games/items/gate.png",
    quantity: 1,
    unitPriceCoins: 75,
  },
  price: { coins: 75, usdCents: 75 },
  balance: 1240,
  ...over,
});

/** The `<button>` tags in the markup that answer `answer`. */
const buttonsFor = (markup: string, answer: PurchaseAnswer): string[] =>
  markup.match(new RegExp(`<button[^>]*data-play-purchase-action="${answer}"[^>]*>`, "g")) ?? [];
const disabled = (tag: string): boolean => / disabled=""/.test(tag);

/** The sheet's face for `sheet` as markup, once the bundle is built. */
let draw: (sheet: PlayPurchaseSheet) => string;
before(async () => {
  const { PurchaseFace, Root, createElement, renderToStaticMarkup } = await sheetBundle();
  draw = (sheet) =>
    renderToStaticMarkup(
      createElement(Root, { open: true }, createElement(PurchaseFace, { sheet, answer: () => undefined })),
    );
});

describe("each step of the purchase sheet as drawn", () => {
  it("draws Ask with Cancel and Pay, Pay held until main arms it", () => {
    const unarmed = draw(sheetWith({ armed: false }));
    const [pay] = buttonsFor(unarmed, PurchaseAnswer.Pay);
    const [cancel] = buttonsFor(unarmed, PurchaseAnswer.Cancel);
    assert.ok(pay && cancel, unarmed);
    assert.ok(disabled(pay), `Pay waits to be armed: ${pay}`);
    assert.ok(!disabled(cancel), cancel);
    assert.match(unarmed, /Pay 75 coin/);
    assert.match(unarmed, /\$0\.75/);
    assert.match(unarmed, /1,165 coin/, "the balance after paying");
    const [armed] = buttonsFor(draw(sheetWith()), PurchaseAnswer.Pay);
    assert.ok(armed && !disabled(armed), armed);
  });

  it("keeps Pay busy and Cancel and ✕ out of reach while paying", () => {
    const markup = draw(sheetWith({ step: PurchaseStep.Paying, armed: false }));
    const [pay] = buttonsFor(markup, PurchaseAnswer.Pay);
    const [cancel] = buttonsFor(markup, PurchaseAnswer.Cancel);
    assert.match(pay ?? "", /aria-busy="true"/);
    assert.ok(cancel && disabled(cancel), cancel);
    const close = markup.match(/<button[^>]*data-play-purchase-close[^>]*>/)?.[0] ?? "";
    assert.ok(disabled(close), `✕ waits for genex.games too: ${close}`);
    assert.match(markup, /Paying…/);
  });

  it("draws the receipt once paid: the game has it, what is left, and only Back to game", () => {
    const markup = draw(sheetWith({ step: PurchaseStep.Paid, armed: false, balance: 1165 }));
    assert.match(markup, /Lantern Run has your receipt\./);
    assert.match(markup, /1,165 coin/);
    assert.equal(buttonsFor(markup, PurchaseAnswer.Back).length, 1);
    assert.equal(buttonsFor(markup, PurchaseAnswer.Pay).length, 0);
    assert.equal(buttonsFor(markup, PurchaseAnswer.Cancel).length, 0);
    assert.doesNotMatch(markup, /Unlock the shortcut/, "the receipt line takes the description's place");
  });

  it("shows what is missing when the balance is short, with Get coin and where it leads", () => {
    const markup = draw(
      sheetWith({ step: PurchaseStep.NotEnough, recovery: PurchaseRecovery.Waiting, armed: false, balance: 40 }),
    );
    assert.match(markup, /35 more needed/);
    assert.equal(buttonsFor(markup, PurchaseAnswer.GetCoin).length, 1);
    assert.equal(buttonsFor(markup, PurchaseAnswer.Pay).length, 0, "no Pay while short");
    assert.match(markup, /Opens genex\.games\. Pay comes back once the coin lands\./);
  });

  it("tells a purchase that timed out, with the item and Back to game", () => {
    const markup = draw(sheetWith({ step: PurchaseStep.Failed, problem: PurchaseProblem.Expired, armed: false }));
    assert.match(markup, /This purchase timed out/);
    assert.match(markup, /Open the iron gate/);
    assert.equal(buttonsFor(markup, PurchaseAnswer.Back).length, 1);
  });

  it("asks a signed-out player to sign in, with nothing of a purchase it could not read", () => {
    const markup = draw(
      sheetWith({
        step: PurchaseStep.SignedOut,
        recovery: PurchaseRecovery.Waiting,
        armed: false,
        item: null,
        price: null,
        balance: null,
      }),
    );
    assert.match(markup, /Sign in to buy things in games/);
    assert.equal(buttonsFor(markup, PurchaseAnswer.SignIn).length, 1);
    assert.equal(buttonsFor(markup, PurchaseAnswer.Cancel).length, 1);
    assert.doesNotMatch(markup, /\d coin/, "no price was read");
  });
});

describe("the purchase's picture and a game's words as drawn", () => {
  it("draws the placeholder tile for a purchase with no picture, and the picture when there is one", () => {
    const item = { name: "Second wind", description: null, imageUrl: null, quantity: 1, unitPriceCoins: 40 };
    const none = draw(sheetWith({ item }));
    assert.doesNotMatch(none, /<img [^>]*assets\.genex\.games/);
    assert.match(none, /data-icon="box"/);
    assert.match(draw(sheetWith()), /<img [^>]*src="https:\/\/assets\.genex\.games\/items\/gate\.png"/);
  });

  it("shows a game's words whole, how many, and never a character that turns them around", () => {
    const description = `${"Gems for the road. ".repeat(53)}End.`.slice(-1000);
    assert.equal(description.length, 1000);
    const markup = draw(
      sheetWith({
        game: { title: `Lantern ${ISOLATE}Run`, coverUrl: null },
        item: {
          name: `Gem pack ${OVERRIDE}nioc 1`,
          description: `${OVERRIDE}${description}`,
          imageUrl: null,
          quantity: 5,
          unitPriceCoins: 15,
        },
      }),
    );
    assert.doesNotMatch(markup, BIDI, "no direction controls reach the page");
    assert.ok(markup.includes(description), "the whole description, never cut");
    assert.match(markup, /Gem pack nioc 1/);
    assert.match(markup, /× 5/);
    assert.match(markup, /Lantern Run/);
  });
});

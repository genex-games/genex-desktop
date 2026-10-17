/**
 * A plugin panel on a dialog's card: the panel's heading becomes the dialog's title and its frame is
 * as tall as the panel, so the dialog scrolls once. The host's reading of what a panel tells it
 * (`panelHead`, `panelHeight`) runs always; the SDK's side (`src/plugin-sdk/panel.js`, inlined into a
 * small panel in a sandboxed frame of a stand-in host page) runs in headless Chrome, opt-in with
 * `STUDIO_BROWSER_TESTS=1` as the other browser suites are.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { inlinePanelSdk } from "../../src/plugin-sdk/inline-panel-sdk.mjs";
import { panelHead, panelHeight } from "../../src/renderer/panels/panel-bridge.ts";

describe("what a panel tells its dialog, read as data", () => {
  it("a heading needs a title; its words are trimmed, folded and capped, and Back is true only when said so", () => {
    const long = "x".repeat(500);
    const rows: Array<[Record<string, unknown>, ReturnType<typeof panelHead>]> = [
      [
        { title: "Set up Roblox Studio", description: "Genex checks each step.", back: false },
        { title: "Set up Roblox Studio", description: "Genex checks each step.", back: false },
      ],
      [
        { title: "  Choose \n your   place ", back: true },
        { title: "Choose your place", description: null, back: true },
      ],
      [
        { title: "Set up", description: "   ", back: "true" },
        { title: "Set up", description: null, back: false },
      ],
      [
        { title: long, description: long },
        { title: "x".repeat(80), description: "x".repeat(240), back: false },
      ],
      [{ title: "" }, null],
      [{ title: "   " }, null],
      [{ title: 42 }, null],
      [{ title: { toString: () => "Set up" } }, null],
      [{}, null],
    ];
    for (const [i, [message, head]] of rows.entries()) assert.deepEqual(panelHead(message), head, `row ${i}`);
  });

  it("a height is a finite, non-negative number of pixels, rounded up and capped", () => {
    const rows: Array<[unknown, number | null]> = [
      [612, 612],
      [612.2, 613],
      [0, 0],
      [99_999, 4000],
      [-1, null],
      [Number.NaN, null],
      [Number.POSITIVE_INFINITY, null],
      ["600", null],
      [null, null],
      [undefined, null],
    ];
    for (const [height, pixels] of rows) assert.equal(panelHeight({ height }), pixels, String(height));
  });
});

const SkipReason = { NotOptedIn: "launches Chrome; set STUDIO_BROWSER_TESTS=1 to run" } as const;
const skip = process.env.STUDIO_BROWSER_TESTS === "1" ? false : SkipReason.NotOptedIn;
/** How often and how many times a test looks for what the panel told its host. */
const WAIT_STEP_MS = 25;
const WAIT_TRIES = 200;

/** A panel with two pages, as engine panels have: setup (no Back), then places (with Back). */
const PANEL = `<!doctype html><html><head><style>body{margin:0;padding:20px}[hidden]{display:none}</style></head><body>
<section id="setup"><div data-panel-head><h2>Set up Roblox Studio</h2><p>Genex checks each step.</p></div>
<ol id="steps"><li>Studio</li></ol><button type="button" id="more">Choose another place</button></section>
<section id="places" hidden><div data-panel-head><h2>Choose your place</h2><p>Places open in Studio.</p></div>
<button type="button" id="back" data-panel-back>Back</button></section>
<!-- STUDIO_PANEL_SDK -->
<script>
// A panel's own globals may use any name: the SDK keeps its own out of the page's scope.
const HEAD = "mine", BACK = "mine", isShown = 0, shownOne = 0, lineOf = 0;
function tellDialog() {}
function sitOnCard() {}
document.getElementById("more").onclick = () => { setup.hidden = true; places.hidden = false; };
document.getElementById("back").onclick = () => { places.hidden = true; setup.hidden = false; };
</script></body></html>`;

/** The host: the panel in a sandboxed frame; it answers context with the surface in the query and records what the panel tells. */
const HOST = `<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/panel" style="width:480px;height:300px;border:0"></iframe>
<script>
const surface = new URLSearchParams(location.search).get("surface");
window.__told = [];
const frame = document.getElementById("f");
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const m = event.data;
  if (m.type === "studio-plugin-request") {
    const result = m.method === "context" ? { project: null, apiVersion: 3, theme: {}, surface } : null;
    frame.contentWindow.postMessage({ type: "studio-plugin-result", id: m.id, result }, "*");
  } else window.__told.push(m);
});
window.__back = () => frame.contentWindow.postMessage({ type: "studio-plugin-back" }, "*");
</script></body></html>`;

type Told = { type: string; title?: string; description?: string | null; back?: boolean; height?: number };

describe("the panel SDK on a dialog's card", { skip }, () => {
  let browser: Browser;
  let server: http.Server;
  let url = "";
  before(async () => {
    const panel = await inlinePanelSdk(PANEL);
    server = http.createServer((request, response) => {
      const page = request.url?.startsWith("/panel") ? panel : HOST;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium
      .launch({ channel: "chrome", headless: true })
      .catch(() => chromium.launch({ headless: true }));
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  const told = (tab: Page) => tab.evaluate(() => (window as unknown as { __told: Told[] }).__told);
  const last = (all: Told[], type: string) => all.filter((m) => m.type === type).at(-1);
  /** What the panel told last of `type`, once `ready` holds for it or the wait runs out. */
  async function until(tab: Page, type: string, ready: (m: Told | undefined) => boolean) {
    let m = last(await told(tab), type);
    for (let i = 0; i < WAIT_TRIES && !ready(m); i++) {
      await tab.waitForTimeout(WAIT_STEP_MS);
      m = last(await told(tab), type);
    }
    return m;
  }
  const frameOf = (tab: Page) => {
    const frame = tab.frames().find((f) => f.url().endsWith("/panel"));
    assert.ok(frame, "the panel's frame");
    return frame;
  };

  it("tells its visible heading and Back, follows the page it shows, and the dialog's Back presses its own", async () => {
    const tab = await browser.newPage();
    try {
      await tab.goto(`${url}?surface=card`);
      const setup = await until(tab, "studio-plugin-head", (m) => m?.title === "Set up Roblox Studio");
      assert.deepEqual(setup, {
        type: "studio-plugin-head",
        title: "Set up Roblox Studio",
        description: "Genex checks each step.",
        back: false,
      });
      const panel = frameOf(tab);
      assert.equal(
        await panel.locator("#setup [data-panel-head]").isVisible(),
        false,
        "the dialog shows it, not the panel",
      );
      await panel.click("#more");
      const places = await until(tab, "studio-plugin-head", (m) => m?.title === "Choose your place");
      assert.deepEqual(places, {
        type: "studio-plugin-head",
        title: "Choose your place",
        description: "Places open in Studio.",
        back: true,
      });
      assert.equal(await panel.locator("#back").isVisible(), false, "Back is the dialog's arrow");
      await tab.evaluate(() => (window as unknown as { __back: () => void }).__back());
      const again = await until(tab, "studio-plugin-head", (m) => m?.title === "Set up Roblox Studio");
      assert.equal(again?.back, false);
      assert.equal(await panel.locator("#setup").isVisible(), true, "the panel went back");
    } finally {
      await tab.close();
    }
  });

  it("tells its height and tells it again when it grows", async () => {
    const tab = await browser.newPage();
    try {
      await tab.goto(`${url}?surface=card`);
      const panel = frameOf(tab);
      const first = await until(tab, "studio-plugin-size", (m) => (m?.height ?? 0) > 0);
      const measured = await panel.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
      assert.equal(first?.height, measured);
      await panel.evaluate(() => {
        for (let i = 0; i < 20; i++)
          document
            .getElementById("steps")
            ?.append(Object.assign(document.createElement("li"), { textContent: `Step ${i}` }));
      });
      const grown = await until(tab, "studio-plugin-size", (m) => (m?.height ?? 0) > (first?.height ?? 0));
      assert.ok((grown?.height ?? 0) > (first?.height ?? 0), "taller after the steps grew");
      assert.equal(await panel.evaluate(() => document.documentElement.dataset.surface), "card");
    } finally {
      await tab.close();
    }
  });

  it("on a page it keeps its own heading and Back and tells nothing", async () => {
    const tab = await browser.newPage();
    try {
      await tab.goto(`${url}?surface=page`);
      const panel = frameOf(tab);
      await panel.waitForSelector("#setup [data-panel-head]", { state: "visible" });
      await tab.waitForTimeout(WAIT_STEP_MS * 8);
      assert.deepEqual(await told(tab), []);
      assert.equal(await panel.evaluate(() => document.documentElement.dataset.surface ?? null), null);
    } finally {
      await tab.close();
    }
  });
});

/**
 * A plugin panel can't load a font from anywhere, so a panel that wants Genex's type carries it:
 * `inlinePanelFonts` pastes the app's own font files in as data at the panel's fonts marker, and the
 * panel's CSP lets data fonts load and nothing else. The browser half serves a panel built that way
 * under the real CSP and asks Chrome whether the faces loaded; it is opt-in, like every browser
 * suite (`STUDIO_BROWSER_TESTS=1`).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "@playwright/test";
import { inlinePanelFonts, PANEL_FONTS, PANEL_FONTS_MARKER } from "../../src/plugin-sdk/inline-panel-sdk.mjs";
import { PLUGIN_PANEL_CSP } from "../../src/main/plugin-panel-csp.ts";

const FONTS = path.resolve("src/renderer/fonts");
const PAGE = `<!doctype html><html><head>${PANEL_FONTS_MARKER}</head><body><p>Panel</p></body></html>`;

describe("A panel's fonts", () => {
  it("are pasted in at the marker as data, one face per Genex family, byte for byte", async () => {
    const html = await inlinePanelFonts(PAGE, FONTS);
    assert.ok(!html.includes(PANEL_FONTS_MARKER));
    const faces = [...html.matchAll(/font-family:"([^"]+)"[^}]*url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)];
    assert.deepEqual(
      faces.map(([, family]) => family),
      PANEL_FONTS.map((font) => font.family),
    );
    for (const [i, [, , data]] of faces.entries())
      assert.deepEqual(Buffer.from(data, "base64"), await readFile(path.join(FONTS, PANEL_FONTS[i].file)));
  });

  it("leave a panel without the marker as it is", async () => {
    const plain = "<!doctype html><p>No fonts here</p>";
    assert.equal(await inlinePanelFonts(plain, FONTS), plain);
  });
});

const skip = process.env.STUDIO_BROWSER_TESTS === "1" ? false : "launches Chrome; set STUDIO_BROWSER_TESTS=1 to run";

describe("A panel's fonts under Studio's panel CSP", { skip }, () => {
  let browser: Browser;
  let server: http.Server;
  let url = "";
  before(async () => {
    const page = await inlinePanelFonts(PAGE, FONTS);
    server = http.createServer((_request, response) =>
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": PLUGIN_PANEL_CSP })
        .end(page),
    );
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

  it("load", async () => {
    const tab = await browser.newPage();
    try {
      await tab.goto(url);
      const loaded = await tab.evaluate(() =>
        Promise.all(
          [...document.fonts].map((face) =>
            face.load().then(
              () => [face.family.replaceAll('"', ""), face.status],
              () => [face.family.replaceAll('"', ""), "error"],
            ),
          ),
        ),
      );
      assert.deepEqual(
        loaded,
        PANEL_FONTS.map((font) => [font.family, "loaded"]),
      );
    } finally {
      await tab.close();
    }
  });
});

/**
 * The Genex wordmark and its G (`ui/GenexLogo.tsx`) paint all of themselves wherever layout puts
 * them. The sidebar centres the 80px wordmark (12.625px tall) beside the Play / Create switch at a
 * fractional top, and its letters' edges were cut, plainest at 100% (most Windows PCs). Rendered with
 * React's server renderer and painted in Chromium at whole and fractional offsets: wherever it lands,
 * a logo keeps all the ink it paints with nothing clipping it. Opt-in like every browser suite
 * (`STUDIO_BROWSER_TESTS=1`).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "@playwright/test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";

const SkipReason = { NotOptedIn: "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run" } as const;
const skip = process.env.STUDIO_BROWSER_TESTS === "1" ? false : SkipReason.NotOptedIn;

/** Screens at 100% (Windows' default), 125%, 150% and Retina. */
const SCALES = [1, 1.25, 1.5, 2];
/** Where layout can leave a logo: on a pixel, and parts of one (0.6875 is the sidebar's own top). */
const OFFSETS = [0, 0.25, 0.5, 0.6875, 0.75];
/** Room around each logo, in CSS px, so a drawing that overflows its box is still counted. */
const CELL = { width: 180, height: 40, margin: 8 };
/** Anti-aliasing moves a little ink between edge pixels; a cut edge lost one to ten percent. */
const INK_TOLERANCE = 0.01;

/** Each logo as the app draws it: the sidebar's 80px wordmark, onboarding's 142px one, the 14px G. */
const LOGOS = [
  { name: "sidebar wordmark", element: "GenexLogo", props: {}, css: "width:80px;height:auto" },
  { name: "onboarding wordmark", element: "GenexLogo", props: {}, css: "width:142px;height:auto" },
  { name: "G beside a name", element: "GenexMark", props: { size: 14 }, css: "" },
] as const;

async function logos(): Promise<Record<string, string>> {
  const result = await build({
    stdin: {
      contents: [
        'import { createElement } from "react";',
        'import { renderToStaticMarkup } from "react-dom/server.edge";',
        'import { GenexLogo, GenexMark } from "./src/renderer/ui/GenexLogo.tsx";',
        "const parts = { GenexLogo, GenexMark };",
        "export const markup = (name, props) => renderToStaticMarkup(createElement(parts[name], props));",
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
  const { markup } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return Object.fromEntries(LOGOS.map((logo) => [logo.name, markup(logo.element, logo.props)]));
}

/**
 * White ink on black, so a pixel's brightness is how much of it the logo covers. The first cell is
 * the reference, unclipped by an author rule whatever the component says; one cell per offset follows.
 */
function page(svg: string, css: string): string {
  const cell = (row: number, offset: number, className: string) => {
    const top = CELL.margin + row * CELL.height + offset;
    const left = CELL.margin + offset;
    return `<div class="${className}" style="position:absolute;top:${top}px;left:${left}px;display:flex">${svg}</div>`;
  };
  const cells = [cell(0, 0, "reference"), ...OFFSETS.map((offset, i) => cell(i + 1, offset, "placed"))];
  return `<!doctype html><html><head><style>
    :root { --logo: #fff; --logo-2: #fff; --logo-fade: 1; }
    body { margin: 0; background: #000; }
    svg { display: block; ${css} }
    .reference svg { overflow: visible; }
  </style></head><body>${cells.join("")}</body></html>`;
}

describe("the Genex logo painted at any offset", { skip }, () => {
  let browser: Browser;
  let markup: Record<string, string> = {};
  before(async () => {
    markup = await logos();
    browser = await chromium
      .launch({ channel: "chrome", headless: true })
      .catch(() => chromium.launch({ headless: true }));
  });
  after(async () => {
    await browser?.close();
  });

  /** The ink in each cell, the reference first: the sum of every pixel's red channel. */
  async function inkPerCell(svg: string, css: string, scale: number): Promise<number[]> {
    const count = OFFSETS.length + 1;
    const height = CELL.margin * 2 + count * CELL.height;
    const tab = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: CELL.width, height } });
    await tab.setContent(page(svg, css));
    const png = (await tab.screenshot()).toString("base64");
    const ink = await tab.evaluate(
      async ({ png, scale, cell, count }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no 2D canvas");
        context.drawImage(image, 0, 0);
        const sums: number[] = [];
        for (let i = 0; i < count; i++) {
          const y = Math.round((cell.margin + i * cell.height - cell.margin / 2) * scale);
          const rows = Math.round(cell.height * scale);
          const { data } = context.getImageData(0, y, image.naturalWidth, rows);
          let sum = 0;
          for (let p = 0; p < data.length; p += 4) sum += data[p] ?? 0;
          sums.push(sum);
        }
        return sums;
      },
      { png, scale, cell: CELL, count },
    );
    await tab.close();
    return ink;
  }

  for (const logo of LOGOS) {
    it(`keeps all of the ${logo.name}'s ink at 100%, 125%, 150% and 200%`, async () => {
      const losses: string[] = [];
      for (const scale of SCALES) {
        const [whole = 0, ...placed] = await inkPerCell(markup[logo.name] ?? "", logo.css, scale);
        assert.ok(whole > 0, `${logo.name} paints at ${scale}x`);
        for (const [i, ink] of placed.entries()) {
          const lost = 1 - ink / whole;
          if (lost > INK_TOLERANCE)
            losses.push(`${scale}x, moved ${OFFSETS[i]}px: ${(lost * 100).toFixed(1)}% of the ink cut`);
        }
      }
      assert.deepEqual(losses, []);
    });
  }
});

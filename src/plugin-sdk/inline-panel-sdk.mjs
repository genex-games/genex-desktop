/**
 * A panel runs in a sandboxed frame whose CSP allows inline scripts only, so the panel bridge
 * (`panel.js`) and its UI primitives (`ui.js`) are pasted into the panel at build time where it
 * says `<!-- STUDIO_PANEL_SDK -->`. One copy of the bridge, never a hand-kept one that drifts.
 * Plain Node, no Studio imports: `node inline-panel-sdk.mjs panel.html` works in any plugin folder
 * that carries this SDK folder.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PANEL_SDK_MARKER = "<!-- STUDIO_PANEL_SDK -->";
/** Where a panel that wants Genex's own type asks for it: the fonts go in here as data. */
export const PANEL_FONTS_MARKER = "<!-- STUDIO_PANEL_FONTS -->";
/** Genex's type, as the app ships it: words in Zalando Sans SemiExpanded, actions and machine text in Geist Mono. */
export const PANEL_FONTS = [
  { family: "Zalando Sans SemiExpanded", file: "ZalandoSansSemiExpanded-variable.woff2", weight: "200 900" },
  { family: "Geist Mono", file: "GeistMono-variable.woff2", weight: "100 900" },
];
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `html` with the marker replaced by the SDK scripts; unchanged when it has no marker.
 * @param {string} html
 * @param {string} [sdkDir] the folder holding panel.js and ui.js (this one by default)
 * @returns {Promise<string>}
 */
export async function inlinePanelSdk(html, sdkDir = here) {
  if (!html.includes(PANEL_SDK_MARKER)) return html;
  const [bridge, ui] = await Promise.all(
    ["panel.js", "ui.js"].map((file) => readFile(path.join(sdkDir, file), "utf8")),
  );
  // A function, so `$&` and friends inside the SDK source are never read as replacement patterns.
  return html.replace(PANEL_SDK_MARKER, () => `<script>${bridge}\n${ui}</script>`);
}

/**
 * `html` with the fonts marker replaced by Genex's faces as `data:` fonts, the only fonts a panel's
 * CSP lets load; unchanged when it has no marker.
 * @param {string} html
 * @param {string} fontsDir the folder holding the files PANEL_FONTS names (the app's `src/renderer/fonts`)
 * @returns {Promise<string>}
 */
export async function inlinePanelFonts(html, fontsDir) {
  if (!html.includes(PANEL_FONTS_MARKER)) return html;
  const faces = await Promise.all(
    PANEL_FONTS.map(async (font) => {
      const data = (await readFile(path.join(fontsDir, font.file))).toString("base64");
      return `@font-face{font-family:"${font.family}";font-style:normal;font-weight:${font.weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
    }),
  );
  return html.replace(PANEL_FONTS_MARKER, () => `<style>${faces.join("\n")}</style>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) await writeFile(file, await inlinePanelSdk(await readFile(file, "utf8")));
}

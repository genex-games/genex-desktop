/**
 * A panel runs in a sandboxed frame whose CSP allows inline scripts only, so the panel bridge
 * (`panel.js`), its UI primitives (`ui.js`) and its words in Genex's language (`words.js`, with the
 * plugin's translations from its `locales/` folder) are pasted into the panel at build time where it
 * says `<!-- STUDIO_PANEL_SDK -->`. One copy of the bridge, never a hand-kept one that drifts.
 * Plain Node, no Studio imports: `node inline-panel-sdk.mjs panel.html` works in any plugin folder
 * that carries this SDK folder, and takes the translations from `locales/` beside the panel.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES_FOLDER, panelLocalesScript, readPanelLocales } from "./panel-words.mjs";

export const PANEL_SDK_MARKER = "<!-- STUDIO_PANEL_SDK -->";
/** Where a panel that wants Genex's own type asks for it: the fonts go in here as data. */
export const PANEL_FONTS_MARKER = "<!-- STUDIO_PANEL_FONTS -->";
/**
 * Genex's type, as the app ships it: words in Zalando Sans SemiExpanded, actions and machine text in
 * Geist Mono. The Japanese, Korean and Chinese faces (1.5–2 MB each) stay out: pasted as data they
 * would add about 9 MB to every panel. `words.js` marks the panel's `lang`, so its stack's
 * `system-ui` picks the Mac's own face for that language (Hiragino Sans, Apple SD Gothic Neo, PingFang SC).
 */
export const PANEL_FONTS = [
  { family: "Zalando Sans SemiExpanded", file: "ZalandoSansSemiExpanded-variable.woff2", weight: "200 900" },
  { family: "Geist Mono", file: "GeistMono-variable.woff2", weight: "100 900" },
  // Zalando Sans has Latin only: Cyrillic and Greek come from TikTok Sans tuned to it (renderer/theme.css).
  {
    family: "TikTok Sans Genex",
    file: "TikTokSansGenex-variable.woff2",
    weight: "275 792",
    extra:
      "size-adjust:101.3%;unicode-range:U+0301,U+0370-03FF,U+0400-052F,U+1C80-1C88,U+1F00-1FFF,U+2116,U+2DE0-2DFF,U+A640-A69F;",
  },
];
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `html` with the marker replaced by the SDK scripts and the plugin's translated languages;
 * unchanged when it has no marker.
 * @param {string} html
 * @param {string} [sdkDir] the folder holding panel.js, ui.js and words.js (this one by default)
 * @param {string} [localesDir] the plugin's `locales/` folder; without one the panel speaks English
 * @returns {Promise<string>}
 */
export async function inlinePanelSdk(html, sdkDir = here, localesDir) {
  if (!html.includes(PANEL_SDK_MARKER)) return html;
  const [bridge, ui] = await Promise.all(
    ["panel.js", "ui.js"].map((file) => readFile(path.join(sdkDir, file), "utf8")),
  );
  const words = await panelWordsScripts(sdkDir, localesDir);
  // A function, so `$&` and friends inside the SDK source are never read as replacement patterns.
  return html.replace(PANEL_SDK_MARKER, () => `<script>${bridge}\n${ui}</script>${words}`);
}

/**
 * The SDK's words (`words.js`) after the plugin's translated languages, as the scripts that go
 * after a bridge: `inlinePanelSdk` puts them after `panel.js`, and a page that brings its own
 * `window.studioPlugin` (a test's stand-in host) puts them after that.
 * @param {string} [sdkDir] the folder holding words.js (this one by default)
 * @param {string} [localesDir] the plugin's `locales/` folder; without one the panel speaks English
 * @returns {Promise<string>}
 */
export async function panelWordsScripts(sdkDir = here, localesDir) {
  const words = await readFile(path.join(sdkDir, "words.js"), "utf8");
  const catalogs = localesDir ? panelLocalesScript(await readPanelLocales(localesDir)) : "";
  return `${catalogs}<script>${words}</script>`;
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
      return `@font-face{font-family:"${font.family}";font-style:normal;font-weight:${font.weight};font-display:swap;${font.extra ?? ""}src:url(data:font/woff2;base64,${data}) format("woff2")}`;
    }),
  );
  return html.replace(PANEL_FONTS_MARKER, () => `<style>${faces.join("\n")}</style>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) {
    const locales = path.join(path.dirname(file), LOCALES_FOLDER);
    await writeFile(file, await inlinePanelSdk(await readFile(file, "utf8"), here, locales));
  }
}

/**
 * A game's loading screen (renderer pass 2, owner decision D11): `genex.toml`'s `[render.loading]`
 * table, the one way a game styles what every destination shows from the first paint until its
 * first lit frame (the web shell's page, a desktop window, Live). The host's parser
 * (`substrate/genex-toml.ts`) and genex's `manifest.rs` read the same keys with the same checks,
 * held equal by `tests/fixtures/genex-toml-render.json`; the web build writes the checked values
 * into the shell (`webShellPage`), and the facade reads them from the `[render]` fragment the lane
 * compiles in.
 *
 * ```toml
 * [render.loading]
 * title = "Harbour Nights"   # what the screen names (default: [game] title), 1..=60 characters
 * background = "#1b2233"     # sRGB hex colours, #rrggbb
 * accent = "#7fb2ec"         # the spinner and the progress bar
 * text = "#eceae4"           # the title and the stage
 * logo = "ui/logo.png"       # a PNG, JPEG or WebP under the game's assets/, shown above the title
 * ```
 */

/** The keys of `[render.loading]`. Wire values. */
export const LoadingKey = {
  Title: "title",
  Background: "background",
  Accent: "accent",
  Text: "text",
  Logo: "logo",
} as const;
export type LoadingKey = (typeof LoadingKey)[keyof typeof LoadingKey];

/** `[render.loading]` as the game set it: each key left out takes {@link LOADING_DEFAULTS}' (the title the game's). */
export interface LoadingStyle {
  title?: string;
  background?: string;
  accent?: string;
  text?: string;
  /** A path under the game's `assets/` folder. */
  logo?: string;
}

/** The loading screen's colours when a game sets none: a lit slate with the shell's own blue. */
export const LOADING_DEFAULTS = {
  background: "#1b2233",
  accent: "#7fb2ec",
  text: "#eceae4",
} as const;

/** The longest title the screen shows, in characters (UTF-16 code units). */
export const LOADING_TITLE_MAX_CHARS = 60;

/** An sRGB colour as `#rrggbb`: the only colour form the screen takes (never a name or a function). */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** A logo's file name ends in one of the image formats every destination decodes. */
const LOGO_EXTENSION = /\.(png|jpe?g|webp)$/i;
/** The characters a logo path may hold: the asset-path rule's, no quote, space or backslash. */
const LOGO_CHARS = /^[A-Za-z0-9_.\-/]+$/;

/** Whether `value` is a loading colour, `#rrggbb`. */
export function isLoadingColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** A control character, as Rust's `char::is_control` reads one (C0, DEL and C1). */
const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** Whether `value` is a loading title: not blank, 1..=60 characters (code points), no control character. */
export function isLoadingTitle(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const chars = [...value];
  return chars.length <= LOADING_TITLE_MAX_CHARS && !chars.some((char) => isControl(char.codePointAt(0) ?? 0));
}

/**
 * Whether `value` is a logo path: relative to `assets/`, `/`-separated, no empty, `.` or `..`
 * segment, no leading `/`, only the asset-path characters, and an image extension.
 */
export function isLoadingLogo(value: unknown): value is string {
  if (typeof value !== "string" || !LOGO_CHARS.test(value) || !LOGO_EXTENSION.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The first key of `style` whose value breaks its rule, or null when every key it sets is good. */
export function loadingStyleProblem(style: LoadingStyle): LoadingKey | null {
  if (style.title !== undefined && !isLoadingTitle(style.title)) return LoadingKey.Title;
  for (const key of [LoadingKey.Background, LoadingKey.Accent, LoadingKey.Text] as const) {
    if (style[key] !== undefined && !isLoadingColor(style[key])) return key;
  }
  if (style.logo !== undefined && !isLoadingLogo(style.logo)) return LoadingKey.Logo;
  return null;
}

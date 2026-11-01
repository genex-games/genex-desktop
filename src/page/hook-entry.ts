/**
 * The hook bundle's entry — served as a module AFTER the page's import map, because a module tag
 * ahead of a map disables it.
 *
 * It exists so the hook is on every page, including a page whose `three` never passes through the
 * import map at all (a bundled game): `window.__studioHook` is there to report that the studio could
 * not attach, instead of being missing.
 * The import is a URL, left alone by the bundler, so this entry and the wrapper module the serve
 * layer generates load the SAME module record — one hook, one set of records, one world.
 */
// @ts-expect-error: a URL the page serves (src/page/hook.ts, bundled by scripts/build.mjs), not a file the compiler can find
import "/vendor/studio/hook.js";

/**
 * A Play asset tile's picture as the renderer draws it: an image's own file can be a full-size
 * original, so the browser fetches it only as its tile nears the screen and decodes it off the main
 * thread; with no picture yet, the kind's glyph stands in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { LibraryKind } from "../../src/shared/asset-library.ts";

/** The tile's picture as the plain renderer build compiles it, and React's server renderer. */
async function tileImage() {
  const result = await build({
    stdin: {
      contents: [
        'export { TileImage } from "./src/renderer/play/PlayAssets.tsx";',
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

test("an asset tile's picture loads only as its tile nears the screen, and decodes off the main thread", async () => {
  const { TileImage, createElement, renderToStaticMarkup } = await tileImage();
  const src = "https://assets.genex.technology/generations/gen-dusk-0007/image-main";
  const markup: string = renderToStaticMarkup(createElement(TileImage, { src, kind: LibraryKind.Image }));
  const image = /<img [^>]*>/.exec(markup)?.[0] ?? "";
  assert.ok(image.includes(`src="${src}"`), markup);
  assert.ok(image.includes('loading="lazy"'), `a full-size original waits for its tile: ${image}`);
  assert.ok(image.includes('decoding="async"'), image);
  const none: string = renderToStaticMarkup(createElement(TileImage, { src: null, kind: LibraryKind.Image }));
  assert.doesNotMatch(none, /<img /, "no picture yet: only the kind's glyph");
});

/**
 * What a step made, on its Builds row (panels/run-graph/BuildsList.tsx) and in its card: a sound
 * plays where it is, from its own button beside the row's header and never inside it; a picture
 * opens the lightbox; past three, +N opens the lightbox on the next picture, or the card when the
 * rest are not all pictures. Open, the row keeps the pictures it made at its right; its card lists
 * its sounds, the first six, then Show all, and draws no cut-down picture of one thing it made.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import type { ProjectAsset } from "../../src/shared/game-assets.ts";
import { type BuildsList, type ListRow, RowMark } from "../../src/renderer/panels/run-graph/builds-list.ts";
import type { AssetInfo } from "../../src/renderer/run-graph.ts";
import { AssetCardState } from "../../src/renderer/run-graph-assets.ts";
import { type AssetCard, PictureSource, type Step, StepState } from "../../src/renderer/run-steps.ts";
import { fakeStudioApi, installFakeStudio } from "../helpers/fake-studio-api.ts";

/** The list and the sounds' list as the plain renderer build compiles them, and React's server renderer. */
async function compiled() {
  const result = await build({
    stdin: {
      contents: [
        'export { BuildsList } from "./src/renderer/panels/run-graph/BuildsList.tsx";',
        'export { MadeSounds } from "./src/renderer/panels/inspector/MadeSounds.tsx";',
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

const PROJECT = "valley";
const FACET = "valley";

/** The game's record of a file it has. */
const record = (file: string, kind: ProjectAsset["kind"]): ProjectAsset => ({
  file,
  kind,
  bytes: 1000,
  mtime: "2026-11-20T22:00:00.000Z",
  source: "plugin",
});

/** One delivery of a file, joined to the game's record of it. */
function delivery(name: string, file: string, kind: ProjectAsset["kind"]): AssetInfo {
  return {
    preview: record(file, kind),
    inGame: true,
    name,
    file,
    bytes: 1000,
    render: null,
    renderFront: null,
    facetId: FACET,
    iteration: 1,
    ok: true,
    error: null,
    polygons: null,
    triangles: null,
    at: "2026-11-20T22:00:00.000Z",
    source: "genex",
    pluginName: "Genex",
    callId: `call-${name}`,
    jobId: `job-${name}`,
    state: AssetCardState.Delivered,
    files: [file],
    args: "",
    prompt: null,
    operation: null,
    tool: "asset",
  };
}

const sound = (name: string): AssetCard => ({
  id: `asset:${FACET}:${name}`,
  facetId: FACET,
  name,
  versions: [delivery(name, `assets/audio/${name}.ogg`, "audio")],
});

const picture = (name: string): AssetCard => ({
  id: `asset:${FACET}:${name}`,
  facetId: FACET,
  name,
  versions: [delivery(name, `assets/images/${name}.png`, "image")],
  picture: { source: PictureSource.File, file: `assets/images/${name}.png` },
});

/** A worker's finished step that made `assets`. */
function step(name: string, assets: AssetCard[]): Step {
  return {
    id: `session:${name}`,
    facetId: FACET,
    session: true,
    tries: [],
    shown: null,
    name,
    asked: null,
    state: StepState.InBuild,
    onLine: true,
    gate: null,
    checkedBy: null,
    verdict: null,
    assets,
  };
}

const row = (made: Step): ListRow => ({
  id: made.id,
  title: made.name,
  mark: RowMark.Added,
  at: null,
  detail: `${made.assets?.length ?? 0} made`,
  step: made,
  build: null,
});

const SOUNDS = Array.from({ length: 23 }, (_, i) => sound(`wind-${i + 1}`));
const PICTURES = Array.from({ length: 11 }, (_, i) => picture(`extra-${i + 1}`));
const VALLEY = row(step("Sounds of the valley", SOUNDS));
const CROWD = row(step("Crowd: women and a tax collector", PICTURES));
const LIST: BuildsList = { working: [], changes: [VALLEY, CROWD], leftOut: [] };

async function renderList(selected: string | null): Promise<string> {
  const { BuildsList: List, createElement, renderToStaticMarkup } = await compiled();
  const restore = installFakeStudio(fakeStudioApi());
  try {
    return renderList_(List, createElement, renderToStaticMarkup, selected);
  } finally {
    restore();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the compiled module's exports are untyped
function renderList_(List: any, createElement: any, renderToStaticMarkup: any, selected: string | null): string {
  return renderToStaticMarkup(
    createElement(List, {
      list: LIST,
      project: PROJECT,
      assetJobs: [],
      runId: "run-1",
      active: false,
      result: null,
      selected,
      onSelect: () => {},
      onClose: () => {},
      onLight: () => {},
      card: selected ? createElement("p", { "data-card-body": "" }, "The card") : null,
    }),
  );
}

/** The markup of the row named `id`, up to the next row. */
function rowMarkup(markup: string, id: string): string {
  const start = markup.indexOf(`data-graph-node="${id}"`);
  assert.ok(start >= 0, `the row ${id} is on the list`);
  const next = markup.indexOf("data-graph-node=", start + 1);
  return markup.slice(start, next < 0 ? undefined : next);
}

/** The row's header button, from its opening tag to its close. */
function headerOf(rowHtml: string): string {
  const start = rowHtml.indexOf("<button");
  return rowHtml.slice(start, rowHtml.indexOf("</button>", start) + "</button>".length);
}

test("a row's sounds play from buttons of their own, beside its header and never inside it", async () => {
  const valley = rowMarkup(await renderList(null), VALLEY.id);
  assert.match(headerOf(valley), /aria-expanded="false"/, "the row's first button is its header");
  assert.doesNotMatch(headerOf(valley), /Play Wind/, "no sound plays from inside the header");
  for (const name of ["Play Wind 1", "Play Wind 2", "Play Wind 3"])
    assert.ok(valley.includes(`aria-label="${name}"`), name);
  assert.ok(!valley.includes('aria-label="Play Wind 4"'), "three sounds show, the rest are counted");
  assert.match(valley, /aria-label="Show all 23"[^>]*>\+20</, "+20 opens the card, where every sound is");
});

test("a row's pictures open the lightbox, and +N opens it on the next picture", async () => {
  const crowd = rowMarkup(await renderList(null), CROWD.id);
  assert.ok(crowd.includes('aria-label="Open extra-1"'), "a picture opens the lightbox on itself");
  assert.match(crowd, /aria-label="Show all 11"[^>]*>\+8</);
  assert.doesNotMatch(headerOf(crowd), /Open extra/, "no picture opens from inside the header");
});

test("open, a row keeps the pictures it made at its right, and its sounds go to its card", async () => {
  const open = await renderList(CROWD.id);
  const crowd = rowMarkup(open, CROWD.id);
  assert.match(headerOf(crowd), /aria-expanded="true"/);
  assert.ok(
    crowd.indexOf('aria-label="Open extra-1"') < crowd.indexOf("data-card-body"),
    "the pictures stay above the card",
  );
  const valley = rowMarkup(await renderList(VALLEY.id), VALLEY.id);
  assert.ok(
    !valley.slice(0, valley.indexOf("data-card-body")).includes("Play Wind"),
    "an open sounds row hands its sounds to the card",
  );
});

test("the card lists the first six sounds as rows that play, then Show all", async () => {
  const { MadeSounds, createElement, renderToStaticMarkup } = await compiled();
  const markup: string = renderToStaticMarkup(createElement(MadeSounds, { project: PROJECT, cards: SOUNDS }));
  assert.equal(markup.match(/data-audio-strip=/g)?.length, 6);
  assert.match(markup, />Show all 23</);
  const pictures: string = renderToStaticMarkup(createElement(MadeSounds, { project: PROJECT, cards: PICTURES }));
  assert.equal(pictures, "", "a step that made only pictures shows none in its card: they are on its row");
});

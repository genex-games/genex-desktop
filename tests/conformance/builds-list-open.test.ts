/**
 * A row of the Builds list opens in place (panels/run-graph/BuildsList.tsx): its own header (mark,
 * name, when and how it stands) stays where it was and says it is open, and the card's body opens
 * under it, pushing the rows below down. The card does not draw a second heading of its own there,
 * nor grow in with an entrance; a card with no row above it (Your build) keeps its heading.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { GraphSelection } from "../../src/renderer/panels/inspector/selection.ts";
import { type BuildsList, type ListRow, RowMark } from "../../src/renderer/panels/run-graph/builds-list.ts";

/** The list and the card as the plain renderer build compiles them, and React's server renderer. */
async function compiled() {
  const result = await build({
    stdin: {
      contents: [
        'export { BuildsList } from "./src/renderer/panels/run-graph/BuildsList.tsx";',
        'export { Panel } from "./src/renderer/panels/inspector/chrome.tsx";',
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

const row = (id: string, title: string, mark: RowMark, detail: string): ListRow => ({
  id,
  title,
  mark,
  at: null,
  detail,
  step: null,
  build: null,
});

const LIST: BuildsList = {
  working: [row(GraphSelection.Lead, "Lead", RowMark.Working, "Planning the next step")],
  changes: [row(GraphSelection.Assets, "Assets", RowMark.Added, "2 made"), row("step:sky:1", "Sky", RowMark.Added, "")],
  leftOut: [],
};

/** The list with `selected` open, its card the Assets card. */
async function renderList(selected: string | null): Promise<string> {
  const { BuildsList: List, Panel, createElement, renderToStaticMarkup } = await compiled();
  const card = selected
    ? createElement(
        Panel,
        { id: selected, label: "Assets", title: "Assets", sub: "Two models made", onClose: () => {} },
        createElement("p", { "data-card-body": "" }, "What the run made"),
      )
    : null;
  return renderToStaticMarkup(
    createElement(List, {
      list: LIST,
      project: null,
      assetJobs: [],
      runId: "run-1",
      active: true,
      result: null,
      selected,
      onSelect: () => {},
      onClose: () => {},
      card,
    }),
  );
}

/** The opening tag of the row button named `id`. */
function rowTag(markup: string, id: string): string {
  const tag = new RegExp(`<button[^>]*data-graph-node="${id}"[^>]*>`).exec(markup)?.[0];
  assert.ok(tag, `the row ${id} is on the list`);
  return tag;
}
const attr = (tag: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

test("an open row keeps its own header where it was, says it is open, and its card opens under it", async () => {
  const closed = await renderList(null);
  const open = await renderList(GraphSelection.Assets);
  const before = rowTag(closed, GraphSelection.Assets);
  const after = rowTag(open, GraphSelection.Assets);
  assert.equal(attr(before, "aria-expanded"), "false");
  assert.equal(attr(after, "aria-expanded"), "true", "the header says its row is open");
  assert.equal(attr(after, "class"), attr(before, "class"), "the header is drawn exactly as the closed row was");
  const header = open.indexOf(after);
  const panel = open.indexOf('data-graph-panel="assets"');
  const next = open.indexOf('data-graph-node="step:sky:1"');
  assert.ok(header < panel && panel < next, "the card's body sits under its header and above the next row");
  assert.ok(open.includes("What the run made") && open.includes("Two models made"), "the card says what it said");
});

test("an open row's card draws no second heading and no entrance of its own", async () => {
  const open = await renderList(GraphSelection.Assets);
  const card = open.slice(open.indexOf("<section", open.indexOf('data-graph-panel="assets"') - 200));
  assert.equal(open.match(/>Assets</g)?.length, 1, "the name is said once, by the row");
  assert.doesNotMatch(card, /<h2/, "no heading of the card's own");
  assert.doesNotMatch(card, /animation/, "no zoom or fade in: it opens in place");
});

test("a card with no row above it keeps its heading and its Close button", async () => {
  const { Panel, createElement, renderToStaticMarkup } = await compiled();
  const markup = renderToStaticMarkup(
    createElement(Panel, { id: GraphSelection.Final, label: "Your build", title: "Your build", onClose: () => {} }),
  );
  assert.match(markup, /<h2[^>]*>Your build<\/h2>/);
  assert.match(markup, /aria-label="Close \(Esc\)"/);
  assert.doesNotMatch(markup, /animation/);
});

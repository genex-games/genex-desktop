/**
 * The Builds bar over the graph: up to three builds as tabs, more (or too little room for three
 * readable tabs) as one picker that names the open build in full and lists them all, newest first.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { buildWhen, type HistoryEntry } from "../../src/renderer/build-progress.ts";
import {
  BuildBarShape,
  barPlay,
  buildBarShape,
  MAX_BUILD_TABS,
  newestFirst,
  READABLE_TAB_PX,
} from "../../src/renderer/panels/run-graph/bar-shape.ts";
import { keyTakenElsewhere } from "../../src/renderer/panels/keyboard.ts";
import { RunState } from "../../src/shared/run-state.ts";

const NOW = new Date(2026, 9, 18, 16, 30);
const at = (days: number, hour: number): string =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days, hour, 5).toISOString();

const ASKS = [
  "Keep building the racing game",
  "Keep going with the track and the cars",
  "Keep improving the drift and the boost",
  "MEGA update: night mode, rain and headlights",
  "Please fix the camera shaking on sharp turns",
  "Run a full test drive of every track",
  "Continue where the last Loop stopped",
  "Can you add a garage screen with car colors?",
];

/** The chat's builds, oldest first as `buildHistory` reads them; the newest still working. */
function builds(count: number): HistoryEntry[] {
  return ASKS.slice(0, count).map((ask, i) => {
    const working = i === count - 1;
    return {
      runId: `run-${i + 1}`,
      rounds: 1,
      state: working ? RunState.Running : RunState.Finished,
      startedAt: at(i < 2 ? 1 : 0, 9 + i),
      ask,
      since: working ? NOW.getTime() - 60_000 : null,
    };
  });
}

/** The bar as the plain renderer build compiles it, and React's server renderer. */
async function bar() {
  const result = await build({
    stdin: {
      contents: [
        'export { BuildStatus } from "./src/renderer/panels/run-graph/chrome.tsx";',
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

async function renderBar(history: HistoryEntry[], open: string): Promise<string> {
  const { BuildStatus, createElement, renderToStaticMarkup } = await bar();
  const status = { strong: "Building", rest: "9 of 30 min" };
  const tabs = { builds: history, open, onOpen: () => {} };
  const action = createElement("button", { "data-play": "" }, "Play");
  return renderToStaticMarkup(createElement(BuildStatus, { status, tabs, action }));
}

const count = (markup: string, pattern: RegExp): number => markup.match(pattern)?.length ?? 0;

test("up to three builds stay tabs; a fourth turns the bar into one picker", () => {
  const roomy = 2000;
  for (let n = 1; n <= MAX_BUILD_TABS; n += 1) assert.equal(buildBarShape(n, roomy), BuildBarShape.Tabs, `${n} builds`);
  assert.equal(buildBarShape(MAX_BUILD_TABS + 1, roomy), BuildBarShape.Picker);
  assert.equal(buildBarShape(12, roomy), BuildBarShape.Picker);
});

test("a panel too narrow for readable tabs gets the picker too, but one build is always its tab", () => {
  assert.equal(buildBarShape(3, 3 * READABLE_TAB_PX), BuildBarShape.Tabs, "exactly room enough");
  assert.equal(buildBarShape(3, 3 * READABLE_TAB_PX - 1), BuildBarShape.Picker);
  assert.equal(buildBarShape(2, 2 * READABLE_TAB_PX - 1), BuildBarShape.Picker);
  assert.equal(buildBarShape(1, 40), BuildBarShape.Tabs, "nothing to pick between");
  assert.equal(buildBarShape(0, 0), BuildBarShape.Tabs);
});

test("the picker's list reads newest first without reordering the history", () => {
  const history = builds(4);
  assert.deepEqual(
    newestFirst(history).map((b) => b.runId),
    ["run-4", "run-3", "run-2", "run-1"],
  );
  assert.deepEqual(
    history.map((b) => b.runId),
    ["run-1", "run-2", "run-3", "run-4"],
  );
});

test("each build in the list says when it started: a time today, Yesterday, else its day", () => {
  const today = buildWhen(at(0, 15), NOW);
  assert.match(today, /\d{1,2}.\d{2}/, "a time of day");
  assert.doesNotMatch(today, /[ \u202f]/, "a no-break space: tabular figures widen a plain one");
  assert.equal(buildWhen(at(1, 15), NOW), "Yesterday");
  const earlier = buildWhen(at(9, 15), NOW);
  assert.match(earlier, /\d/);
  assert.notEqual(earlier, "Yesterday");
  assert.equal(buildWhen(null, NOW), "");
  assert.equal(buildWhen("not a date", NOW), "");
});

test("three builds render as three tabs beside Play", async () => {
  const markup = await renderBar(builds(3), "run-3");
  assert.equal(count(markup, /data-build-tab="/g), 3);
  assert.equal(count(markup, /data-build-picker/g), 0);
  assert.equal(count(markup, /data-play/g), 1);
});

test("eight builds render one picker with the open build's full name and the count, and Play", async () => {
  const history = builds(8);
  const markup = await renderBar(history, "run-7");
  assert.equal(count(markup, /data-build-tab="/g), 0, "no squeezed tabs");
  assert.equal(count(markup, /data-build-picker/g), 1);
  const picker = markup.match(/<button[^>]*data-build-picker[^>]*>.*?<\/button>/)?.[0] ?? "";
  assert.ok(picker.includes(ASKS[6] ?? ""), "the open build's whole ask");
  assert.match(picker, />8</, "how many builds it holds");
  assert.match(picker, /aria-haspopup="menu"/);
  assert.equal(count(markup, /data-play/g), 1);
});

test("Play stays on the bar for every build: its own build, else Live as the game is now", () => {
  const played: string[] = [];
  const play = () => {
    played.push("build");
  };
  const showLive = () => {
    played.push("live");
  };
  barPlay(true, play, showLive)?.();
  barPlay(false, play, showLive)?.();
  assert.deepEqual(played, ["build", "live"]);
  assert.equal(barPlay(false, play, undefined), null, "nothing to play and no Live to show");
});

test("an Escape the picker's open list already took leaves the graph's open card alone", () => {
  const escape = { key: "Escape", target: null };
  assert.equal(keyTakenElsewhere({ ...escape, defaultPrevented: true }), true, "the menu closed; the card stays");
  assert.equal(
    keyTakenElsewhere({ ...escape, defaultPrevented: false }),
    false,
    "nothing else took it: the card closes",
  );
});

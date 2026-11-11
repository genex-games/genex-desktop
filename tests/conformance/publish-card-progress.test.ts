/**
 * A working row of the Publish card while its send says how far it is: how much went and how fast in
 * its status line, a bar a screen reader can read under it, and the time left in the row's loader. A
 * row whose send says nothing keeps its own status, with the loader's clock counting up. Rendered
 * from the plain renderer build with React's server renderer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { GenexSendStage } from "../../src/shared/genex.ts";
import { PublishTarget } from "../../src/shared/publish-platforms.ts";
import { type CardRow, CardTone, CardWork } from "../../src/renderer/panels/plugins/genex/publish-card-view.ts";

async function views() {
  const result = await build({
    stdin: {
      contents: [
        'export { PublishCardRows } from "./src/renderer/panels/plugins/genex/PublishCard.tsx";',
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

const GB = 1024 ** 3;
const sending = (target: PublishTarget, name: string, more: Partial<CardRow> = {}): CardRow => ({
  target,
  name,
  tone: CardTone.Working,
  status: "Sending",
  side: null,
  since: new Date(Date.now() - 134_000).toISOString(),
  cloud: false,
  here: false,
  making: false,
  queued: false,
  live: false,
  busy: "Publishing",
  act: null,
  work: null,
  ...more,
});

/** The card as its rows need it: nothing is being pressed. */
const cardOf = (rows: CardRow[]) => ({ rows, acting: null, act: async () => {}, takeDown: async () => {} });

describe("a working row of the Publish card", () => {
  it("says how much went and how fast, with a bar, and how long is left in its loader", async () => {
    const { PublishCardRows, createElement, renderToStaticMarkup } = await views();
    const progress = {
      stage: GenexSendStage.Upload,
      doneBytes: Math.round(1.2 * GB),
      totalBytes: Math.round(4.6 * GB),
      at: Date.now(),
      bytesPerSecond: 38 * 1024 ** 2,
      target: "mac-arm64",
    };
    const rows = [sending(PublishTarget.Mac, "Mac", { progress }), sending(PublishTarget.Windows, "Windows")];
    const html: string = renderToStaticMarkup(createElement(PublishCardRows, { card: cardOf(rows) }));
    const [mac = "", windows = ""] = html.split("<li ").slice(1);
    assert.match(mac, /data-send-progress/);
    assert.match(mac, /role="progressbar"[^>]*aria-valuenow="26"/);
    assert.match(
      mac,
      /data-publish-platform-status[^>]*><span[^>]*>1\.2 GB of 4\.6 GB · 38 MB\/s</,
      "the status line says the send",
    );
    assert.match(
      mac,
      /data-publish-platform-busy="mac"[\s\S]*Publishing[\s\S]*2m left/,
      "the loader says how long is left",
    );
    assert.doesNotMatch(mac, /data-publish-platform-clock/, "the time left takes the running clock's place");
    assert.doesNotMatch(windows, /data-send-progress/, "a row whose send says nothing shows no bar");
    assert.match(windows, /data-publish-platform-status[^>]*><span[^>]*>Sending</, "and keeps its own status");
    assert.match(windows, /data-publish-platform-clock="windows"/, "with the clock of how long it has run");
  });

  it("names what is going on before the upload, with no bar for a size it does not know", async () => {
    const { PublishCardRows, createElement, renderToStaticMarkup } = await views();
    const progress = { stage: GenexSendStage.Zip, doneBytes: 0, totalBytes: 0, at: Date.now(), target: "mac-arm64" };
    const rows = [sending(PublishTarget.Mac, "Mac", { progress })];
    const html: string = renderToStaticMarkup(createElement(PublishCardRows, { card: cardOf(rows) }));
    assert.match(html, /data-publish-platform-status[^>]*><span[^>]*>Packing</);
    assert.doesNotMatch(html, /role="progressbar"/);
  });

  it("ends a row in its own button, in Queued while it waits, and in the menu of a platform players have", async () => {
    const { PublishCardRows, createElement, renderToStaticMarkup } = await views();
    const resting = { tone: CardTone.None, busy: null };
    const rows = [
      sending(PublishTarget.Web, "Web", { ...resting, tone: CardTone.Live, status: "Live · up to date", live: true }),
      sending(PublishTarget.Mac, "Mac", {
        ...resting,
        status: "Not built",
        act: { work: CardWork.Build, label: "Build on Mac" },
      }),
      sending(PublishTarget.Linux, "Linux", { ...resting, status: "Builds after Mac", queued: true }),
    ];
    const html: string = renderToStaticMarkup(createElement(PublishCardRows, { card: cardOf(rows) }));
    const [web = "", mac = "", linux = ""] = html.split("<li ").slice(1);
    assert.match(web, /data-publish-platform-more="web"/, "a live platform has its menu");
    assert.doesNotMatch(web, /data-publish-platform-act/);
    assert.match(mac, /data-publish-platform-act="build"[^>]*>Build on Mac</);
    assert.doesNotMatch(mac, /data-publish-platform-more/, "a platform players don't have has nothing to take down");
    assert.match(linux, /data-publish-platform-queued="linux"[^>]*>Queued</);
    assert.doesNotMatch(linux, /data-publish-platform-act/, "no button while it waits its turn");
  });
});

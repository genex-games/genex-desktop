/**
 * The microphone in Live: a game that declares it gets it once the person allowed it in Live's bar,
 * through Play's own gate (audio alone, from the game's own top frame). An undeclared game, an
 * agent's window, a frame of another origin and a camera request are refused with no prompt.
 */
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PreviewMicService } from "../../src/main/core/preview-mic.ts";
import {
  isMediaPermission,
  previewInputPermissions,
  previewMicMayAsk,
  previewMicShown,
  previewPermitted,
} from "../../src/main/preview-permissions.ts";
import { PreviewMicAsk } from "../../src/shared/preview-ai.ts";
import { declaresMicrophone } from "../../src/substrate/genex-game-manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PAGE = "http://localhost:41234/index.html?genex_local_test=1";
const NOW = 1_000_000;

describe("which media requests in a preview reach the person", () => {
  const audio = { mediaTypes: ["audio"], isMainFrame: true, requestingUrl: "http://localhost:41234/" };
  const table = [
    { name: "the game's own microphone request in Live", request: audio, live: true, asks: true },
    { name: "an agent's window", request: audio, live: false, asks: false },
    { name: "a frame inside the game", request: { ...audio, isMainFrame: false }, live: true, asks: false },
    {
      name: "a frame of another origin",
      request: { ...audio, requestingUrl: "https://evil.example/" },
      live: true,
      asks: false,
    },
    {
      name: "another loopback port",
      request: { ...audio, requestingUrl: "http://localhost:41235/" },
      live: true,
      asks: false,
    },
    { name: "the camera", request: { ...audio, mediaTypes: ["video"] }, live: true, asks: false },
    {
      name: "the camera with the microphone",
      request: { ...audio, mediaTypes: ["audio", "video"] },
      live: true,
      asks: false,
    },
    { name: "no media named", request: { ...audio, mediaTypes: [] }, live: true, asks: false },
    { name: "an address that is none", request: { ...audio, requestingUrl: "not a url" }, live: true, asks: false },
  ];
  for (const { name, request, live, asks } of table)
    it(`${asks ? "asks" : "refuses with no prompt"}: ${name}`, () => {
      assert.equal(previewMicMayAsk(request, PAGE, live, NOW), asks);
    });

  it("grants mouse-look without asking, never the microphone or the camera", () => {
    const live = previewInputPermissions(false);
    const agent = previewInputPermissions(true);
    assert.equal(previewPermitted("pointerLock", live), true);
    assert.equal(previewPermitted("fullscreen", live), true);
    assert.equal(previewPermitted("fullscreen", agent), false);
    assert.equal(previewPermitted("media", live), false);
    assert.equal(previewPermitted("geolocation", live), false);
    assert.equal(isMediaPermission("media"), true);
  });

  it("shows the microphone held only in Live, from the top frame, once allowed", () => {
    const check = { mediaType: "audio", isMainFrame: true };
    assert.equal(previewMicShown(check, true, true), true);
    assert.equal(previewMicShown(check, true, false), false);
    assert.equal(previewMicShown(check, false, true), false);
    assert.equal(previewMicShown({ ...check, isMainFrame: false }, true, true), false);
    assert.equal(previewMicShown({ ...check, mediaType: "video" }, true, true), false);
  });
});

/** A mic service over a game that does or does not declare the microphone, with what it showed. */
function mic(options: { declares: boolean; access?: boolean }) {
  const shown: Array<[string, string]> = [];
  let accessAsked = 0;
  const service = new PreviewMicService({
    declares: async () => options.declares,
    access: async () => {
      accessAsked += 1;
      return options.access ?? true;
    },
    show: (project, ask) => shown.push([project, ask]),
    askTimeoutMs: 200,
  });
  return { service, shown, accessAsked: () => accessAsked };
}

describe("the person allows a game the microphone in Live", () => {
  it("refuses an undeclared game with no prompt and no system ask", async () => {
    const { service, shown, accessAsked } = mic({ declares: false });
    assert.equal(await service.ask("inn"), false);
    assert.deepEqual(shown, []);
    assert.equal(accessAsked(), 0);
  });

  it("asks once in the bar, then grants the game for this session", async () => {
    const { service, shown } = mic({ declares: true });
    const asked = service.ask("inn");
    const again = service.ask("inn");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(shown, [["inn", PreviewMicAsk.Asking]], "two asks, one prompt");
    service.answer("inn", true);
    assert.deepEqual([await asked, await again], [true, true]);
    assert.equal(service.allowed("inn"), true);
    assert.equal(await service.ask("inn"), true, "no second prompt");
    assert.equal(shown.filter(([, ask]) => ask === PreviewMicAsk.Asking).length, 1);
    assert.equal(service.allowed("tavern"), false, "an allow is for its own game");
  });

  it("refuses on Not now, and on no answer", async () => {
    const { service, shown } = mic({ declares: true });
    const asked = service.ask("inn");
    await new Promise((resolve) => setImmediate(resolve));
    service.answer("inn", false);
    assert.equal(await asked, false);
    assert.equal(await service.ask("tavern"), false, "the timeout is a no");
    assert.deepEqual(shown.at(-1), ["tavern", PreviewMicAsk.Refused]);
  });

  it("refuses when the system does not let the app use the microphone", async () => {
    const { service, shown } = mic({ declares: true, access: false });
    const asked = service.ask("inn");
    await new Promise((resolve) => setImmediate(resolve));
    service.answer("inn", true);
    assert.equal(await asked, false);
    assert.deepEqual(shown.at(-1), ["inn", PreviewMicAsk.Refused]);
  });
});

describe("which games declare the microphone", () => {
  const cases = [
    { name: "package.json", file: "package.json", body: { genex: { capabilities: ["microphone"] } }, declares: true },
    { name: "a template's genex.json", file: "genex.json", body: { capabilities: ["microphone"] }, declares: true },
    {
      name: "another capability",
      file: "package.json",
      body: { genex: { capabilities: ["camera"] } },
      declares: false,
    },
    {
      name: "a string, not a list",
      file: "package.json",
      body: { genex: { capabilities: "microphone" } },
      declares: false,
    },
    { name: "nothing declared", file: "package.json", body: { name: "inn" }, declares: false },
  ];
  for (const { name, file, body, declares } of cases)
    it(`${declares ? "declares" : "does not declare"}: ${name}`, async () => {
      const dir = await tmpDir("studio-mic-game-");
      await writeFile(path.join(dir, file), JSON.stringify(body));
      assert.equal(await declaresMicrophone(dir), declares);
    });

  it("reads no file through a link out of the game", async () => {
    const dir = await tmpDir("studio-mic-link-");
    const outside = await tmpDir("studio-mic-outside-");
    await writeFile(path.join(outside, "genex.json"), JSON.stringify({ capabilities: ["microphone"] }));
    await symlink(path.join(outside, "genex.json"), path.join(dir, "genex.json"));
    assert.equal(await declaresMicrophone(dir), false);
  });
});

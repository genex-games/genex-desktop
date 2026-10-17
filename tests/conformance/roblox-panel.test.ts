/**
 * The real Roblox Studio panel (`src/plugins/roblox/panel.html`) against the real backend, in
 * headless Chrome. The panel's `window.studioPlugin` is a stand-in whose `call("action", …)` runs
 * `createRobloxBackend` over a fake Mac (`tests/helpers/roblox-mac.ts`): Studio's app is a stand-in,
 * while the home, the plugin's storage and the game folder are real temporary folders, and the
 * opener records what it would start and starts nothing. Every state shows its next step with a
 * headline or a primary button whose press sends its action; the place rows are blocks and link the
 * game; the footer and macOS's Documents note are there. Opt-in: it launches a browser, so it runs
 * only with `STUDIO_BROWSER_TESTS=1` and Chrome or a Playwright Chromium already installed.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium, type Frame, type Page } from "@playwright/test";
import type { PluginEngineAssistAnswer } from "../../src/plugin-sdk/index.d.ts";
import { inlinePanelSdk } from "../../src/plugin-sdk/inline-panel-sdk.mjs";
import { createRobloxBackend } from "../../src/plugins/roblox/backend.ts";
import { writeLiveData } from "../../src/plugins/roblox/live-data.ts";
import { firstPublishTask, publishTask } from "../../src/plugins/roblox/publish.ts";
import { LIVE_DATA_CLICK_PATH, MCP_SWITCH_CLICK_PATH, PUBLISH_CLICK_PATH } from "../../src/plugins/roblox/words.ts";
import {
  type Game,
  hostFor,
  makeGame,
  type OpenStudio,
  type RobloxMacOptions,
  robloxMac,
} from "../helpers/roblox-mac.ts";

const PANEL = path.resolve("src/plugins/roblox/panel.html");
/** How often and how many times a test looks for a request the panel sends after a press. */
const WAIT_STEP_MS = 50;
const WAIT_TRIES = 160;
const FOOTER = "Not affiliated with Roblox Corporation. For people 18 and over.";
const DOCUMENTS_NOTE = "macOS may ask to let Genex use your Documents folder: Roblox keeps its plugins there.";
const ACCOUNT = "9172881962";

const SkipReason = {
  NotOptedIn: "launches Chrome; set STUDIO_BROWSER_TESTS=1 to run",
} as const;
const skip = process.env.STUDIO_BROWSER_TESTS === "1" ? false : SkipReason.NotOptedIn;

/** The stand-in bridge: context names the open game (or none), actions go to the backend the test exposes. */
const BRIDGE = `<script>
window.studioPlugin = {
  call: async (method, name, args) => {
    if (method === "context") return { project: window.__game ?? null, apiVersion: 3, theme: { background: "#ffffff", foreground: "#111111", accent: "#2f6fed" } };
    const answer = await window.__backend(method, name ?? null, args ?? {});
    if (answer.error) throw new Error(answer.error);
    return answer.value;
  },
  chooseFile: async (request) => {
    await window.__backend("chooseFile", null, request);
    return window.__picked ?? null;
  },
};
</script>`;

/** What a computer is set up as, beyond the fake Mac: its settings switch, a game, and the place facts. */
interface Given extends RobloxMacOptions {
  /** Studio's MCP switch in the one account's settings file; no file when undefined. */
  switchOn?: boolean;
  /** A game is open in Genex. */
  game?: boolean;
  /** Genex set Studio up for real, writing the helper into the fake home (else only a record). */
  realSetup?: boolean;
}

/** A fake Mac with the panel's backend, in a game when asked, recording every action the panel sends. */
async function computer(given: Given) {
  const mac = await robloxMac({ ...given, setUp: given.realSetup ? false : given.setUp });
  await mkdir(path.join(mac.home, "Documents", "Roblox"), { recursive: true });
  if (given.switchOn !== undefined) {
    const settings = path.join(mac.home, "Library", "Roblox", "AssistantSettings");
    await mkdir(settings, { recursive: true });
    await writeFile(
      path.join(settings, `${ACCOUNT}.json`),
      JSON.stringify({ "mcp-server": { enabled: given.switchOn } }),
    );
  }
  const game: Game | undefined = given.game ? await makeGame(mac, "sky-race", "Sky Race") : undefined;
  const assists: unknown[] = [];
  const assist = (args: unknown): PluginEngineAssistAnswer => {
    assists.push(args);
    return { started: true };
  };
  const host = hostFor(mac, game, { assist });
  const backend = createRobloxBackend(mac.deps);
  const act = async (name: string, args: Record<string, unknown> = {}) =>
    backend.action?.(name, args as never, host.context);
  if (given.realSetup) {
    const running = mac.state.running;
    mac.state.running = false;
    await act("setup");
    mac.state.running = running;
  }
  /** The actions the panel sent, in order, without its status reads; and the pickers it opened. */
  const sent: Array<[string, Record<string, unknown>]> = [];
  return { mac, game, host, act, sent, assists };
}

type Computer = Awaited<ReturnType<typeof computer>>;

/** The panel's page or frame, whichever the test drives. */
type View = Page | Frame;

/** The step the panel shows as next, and what it offers. */
async function nowStep(view: View) {
  return view.evaluate(() => {
    const step = document.querySelector<HTMLElement>('#steps [aria-current="step"]');
    const primary = step?.querySelector<HTMLButtonElement>("button.primary");
    return {
      id: step?.dataset.step ?? "",
      name: step?.querySelector(".step-name")?.textContent ?? "",
      primary: primary?.textContent ?? "",
      buttons: [...(step?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map((button) => button.textContent),
      clickPath: [...(step?.querySelectorAll(".path-line .kbd") ?? [])].map((key) => key.textContent),
      waiting: step?.querySelector(".waiting")?.textContent ?? "",
      note: step?.querySelector(".note")?.textContent ?? "",
    };
  });
}

/** Each state the panel can open in, the step it names next and the action its primary sends. */
const STATES: Record<string, { given: Given; step: string; sends?: string }> = {
  "Studio missing": {
    given: { installed: false, setUp: false, running: false },
    step: "studio",
    sends: "get-studio",
  },
  "not set up, Studio closed": { given: { setUp: false, running: false }, step: "helper", sends: "setup" },
  "not set up, Studio open": { given: { setUp: false }, step: "helper", sends: "restart-studio" },
  "set up, Studio closed": { given: { running: false }, step: "sign-in", sends: "open-studio" },
  "Studio open, MCP off": {
    given: { answering: false, switchOn: false, game: true },
    step: "mcp",
    sends: "do-it-for-me",
  },
  "Studio ready, no place yet": { given: { game: true }, step: "place", sends: "places" },
  "Studio ready, no game open": { given: {}, step: "place", sends: "create" },
};

describe("The Roblox Studio panel", { skip }, () => {
  let browser: Browser;
  let server: http.Server;
  let url = "";
  before(async () => {
    const page = (await readFile(PANEL, "utf8")).replace("<!-- STUDIO_PANEL_SDK -->", BRIDGE);
    server = http.createServer((_request, response) =>
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium
      .launch({ channel: "chrome", headless: true })
      .catch(() => chromium.launch({ headless: true }));
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  /** The panel over computer `c`, with the backend's answers going through the stand-in bridge. */
  async function open(c: Computer) {
    const tab = await browser.newPage({ viewport: { width: 360, height: 760 } });
    await tab.exposeFunction("__backend", async (method: string, name: string, args: Record<string, unknown>) => {
      if (method === "chooseFile") {
        c.sent.push(["chooseFile", args]);
        return { value: null };
      }
      if (method !== "action") return { error: `unexpected ${method}` };
      if (name !== "status") c.sent.push([name, args]);
      try {
        return { value: await c.act(name, args) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    if (c.game) await tab.addInitScript((game) => Object.assign(window, { __game: game }), c.game.project);
    await tab.goto(url);
    await tab.waitForFunction(() => document.getElementById("app")?.getAttribute("aria-busy") === "false");
    return tab;
  }

  /** The names of the actions sent, once `ready` holds for them or the wait runs out. */
  async function sentOnce(tab: Page, c: Computer, ready: (names: string[]) => boolean) {
    const names = () => c.sent.map(([name]) => name);
    for (let i = 0; i < WAIT_TRIES && !ready(names()); i++) await tab.waitForTimeout(WAIT_STEP_MS);
    return names();
  }

  for (const [name, state] of Object.entries(STATES))
    it(`${name}: the next step has a headline and a primary that sends ${state.sends}`, async () => {
      const c = await computer(state.given);
      const tab = await open(c);
      try {
        const now = await nowStep(tab);
        assert.equal(now.id, state.step);
        assert.ok(now.name.trim(), `${name} names its step`);
        assert.ok(now.primary.trim(), `${name} offers a primary button`);
        await tab.click('#steps [aria-current="step"] button.primary');
        assert.ok((await sentOnce(tab, c, (names) => names.length > 0)).includes(state.sends ?? ""));
      } finally {
        await tab.close();
      }
    });

  it("every step is its own rounded block with a 1px outline, 8px apart", async () => {
    const c = await computer({ setUp: false, running: false });
    const tab = await open(c);
    try {
      const blocks = await tab.evaluate(() => {
        const steps = [...document.querySelectorAll<HTMLElement>("#steps > li")];
        return {
          count: steps.length,
          gap: getComputedStyle(document.getElementById("steps") as HTMLElement).rowGap,
          looks: steps.map((step) => {
            const style = getComputedStyle(step);
            return { radius: Number.parseFloat(style.borderTopLeftRadius), outline: style.boxShadow };
          }),
        };
      });
      assert.equal(blocks.gap, "8px");
      assert.ok(blocks.count >= 4);
      for (const look of blocks.looks) {
        assert.ok(look.radius >= 12, "rounded");
        assert.match(look.outline, /0px 0px 0px 1px inset/, "a 1px outline");
      }
    } finally {
      await tab.close();
    }
  });

  it("Studio missing: Get Roblox Studio leads, and no other step offers a button yet", async () => {
    const c = await computer({ installed: false, setUp: false, running: false });
    const tab = await open(c);
    try {
      const now = await nowStep(tab);
      assert.equal(now.primary, "Get Roblox Studio");
      const elsewhere = await tab.evaluate(
        () => document.querySelectorAll('#steps > li:not([aria-current="step"]) button').length,
      );
      assert.equal(elsewhere, 0);
    } finally {
      await tab.close();
    }
  });

  it("Studio open with its MCP server off offers Do it for me, Restart Studio and Studio's own clicks; Do it for me asks", async () => {
    const c = await computer({ answering: false, switchOn: false, game: true });
    const tab = await open(c);
    try {
      const now = await nowStep(tab);
      assert.deepEqual(now.buttons, ["Do it for me", "Restart Studio"]);
      assert.deepEqual(now.clickPath, MCP_SWITCH_CLICK_PATH.split(" › "));
      assert.equal(now.waiting, "Waiting for Studio to answer");
      await tab.click('#steps [aria-current="step"] button.primary');
      await sentOnce(tab, c, (names) => names.includes("do-it-for-me"));
      assert.deepEqual(c.sent, [["do-it-for-me", {}]]);
      assert.equal(c.assists.length, 1, "the backend asked Genex to click it");
      // Flipped: the answer is said in the panel's one live region, and under its step as text.
      await tab.waitForFunction(() =>
        /answer it in this game's chat, then watch Roblox Studio/.test(
          document.getElementById("announce")?.textContent ?? "",
        ),
      );
      assert.match(
        (await tab.locator('#steps [aria-current="step"] .say').textContent()) ?? "",
        /answer it in this game's chat/,
      );
    } finally {
      await tab.close();
    }
  });

  it("the Documents note shows before Set up on a Mac, and is gone once Genex set Studio up", async () => {
    const before = await computer({ setUp: false, running: false });
    const tab = await open(before);
    try {
      assert.equal((await nowStep(tab)).note, DOCUMENTS_NOTE);
    } finally {
      await tab.close();
    }
    const after = await computer({ realSetup: true, running: false });
    const later = await open(after);
    try {
      const notes = await later.evaluate(() =>
        [...document.querySelectorAll("#steps .note")].map((n) => n.textContent),
      );
      assert.deepEqual(notes, []);
      assert.equal((await nowStep(later)).id, "sign-in", "Set up is done; opening Studio is next");
    } finally {
      await later.close();
    }
  });

  it("offers Add Luau checks under the steps once Studio is set up, and its press sends it", async () => {
    const c = await computer({ game: true });
    const tab = await open(c);
    try {
      assert.equal(await tab.isVisible("#luau"), true);
      assert.equal(await tab.textContent("#luau"), "Add Luau checks");
      await tab.click("#luau");
      await sentOnce(tab, c, (names) => names.includes("add-luau-checks"));
      assert.deepEqual(c.sent, [["add-luau-checks", {}]]);
      await tab.waitForFunction(() => /Luau checks/.test(document.getElementById("setup-say")?.textContent ?? ""));
    } finally {
      await tab.close();
    }
    const before = await computer({ setUp: false, running: false });
    const early = await open(before);
    try {
      assert.equal(await early.isVisible("#luau"), false, "nothing to add before Studio is set up");
    } finally {
      await early.close();
    }
  });

  it("the footer says Genex isn't Roblox's and is for people 18 and over", async () => {
    const c = await computer({});
    const tab = await open(c);
    try {
      assert.equal(await tab.textContent("footer"), FOOTER);
    } finally {
      await tab.close();
    }
  });

  it("Choose your place lists each place as its own block, and Use in this game links it", async () => {
    const studios: OpenStudio[] = [
      { id: "studio-a", name: "Pet Valley 7781440219", placeId: "7781440219", universeId: "2611231458" },
      { id: "studio-b", name: "Place1" },
    ];
    const c = await computer({ game: true, studios });
    const tab = await open(c);
    try {
      await tab.click('#steps [aria-current="step"] button.primary');
      await tab.waitForSelector("#places:not([hidden]) #open-places > li");
      const rows = await tab.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#open-places > li")].map((row) => ({
          name: row.querySelector(".name")?.textContent,
          where: row.querySelector(".where")?.textContent,
          button: row.querySelector("button")?.textContent,
          radius: Number.parseFloat(getComputedStyle(row).borderTopLeftRadius),
        })),
      );
      assert.deepEqual(
        rows.map(({ name, where, button }) => ({ name, where, button })),
        [
          { name: "Pet Valley 7781440219", where: "Published · place 7781440219", button: "Use in this game" },
          { name: "Place1", where: "Not saved to a file yet", button: "Use in this game" },
        ],
      );
      for (const row of rows) assert.ok(row.radius >= 12, "each place is a rounded block");
      await tab.click("#open-places > li:nth-child(2) button");
      await sentOnce(tab, c, (names) => names.includes("use-place"));
      assert.deepEqual(c.sent.at(-1), ["use-place", { studio: "studio-b" }]);
      await tab.waitForSelector("#setup:not([hidden])");
      await tab.waitForFunction(
        () =>
          document.querySelector('#steps [data-step="place"] .step-name')?.textContent === "This game builds in Place1",
      );
    } finally {
      await tab.close();
    }
  });

  it("New Roblox game sends create; Open a place file… opens the picker for place files", async () => {
    const c = await computer({ game: true });
    const tab = await open(c);
    try {
      await tab.click('#steps [aria-current="step"] button.primary');
      await tab.waitForSelector("#places:not([hidden])");
      await tab.click("#places-file");
      await sentOnce(tab, c, (names) => names.includes("chooseFile"));
      assert.deepEqual(c.sent.at(-1), ["chooseFile", { title: "Choose a place file", extensions: ["rbxl", "rbxlx"] }]);
      await tab.click("#places-new");
      await sentOnce(tab, c, (names) => names.includes("create"));
      assert.deepEqual(c.sent.at(-1), ["create", {}]);
    } finally {
      await tab.close();
    }
  });

  it("once every step is done, a published place offers Publish an update, whose press hands the chat the task", async () => {
    const studios: OpenStudio[] = [
      { id: "studio-a", name: "Pet Valley", placeId: "7781440219", universeId: "2611231458" },
    ];
    const c = await computer({ game: true, studios });
    assert.equal(((await c.act("use-place", { studio: "studio-a" })) as { linked: boolean }).linked, true);
    const tab = await open(c);
    try {
      const place = '#steps [data-step="place"]';
      assert.equal(await tab.locator(`${place} [data-first-publish]`).count(), 0);
      const publish = tab.locator(`${place} button[data-action="publish-update"]`);
      assert.equal(await publish.textContent(), "Publish an update");
      const orClicks = await tab.locator(`${place} [data-or-in-studio] .kbd`).allTextContents();
      assert.deepEqual(orClicks, PUBLISH_CLICK_PATH.split(" › "), "Studio's own clicks, under the button");
      await publish.click();
      await sentOnce(tab, c, (names) => names.includes("publish-update"));
      assert.deepEqual(c.sent.at(-1), ["publish-update", {}]);
      await tab.waitForFunction(
        (selector) => /publishing the update/.test(document.querySelector(`${selector} .say`)?.textContent ?? ""),
        place,
      );
      assert.deepEqual(
        c.assists.map((args) => (args as { task: string }).task),
        [publishTask("Pet Valley")],
      );
    } finally {
      await tab.close();
    }
  });

  // Flipped: a place never published is published by Genex too. Its block offers Publish to Roblox
  // under a name field filled with the game's title, never the person's own clicks in Studio.
  it("a place never published offers Publish to Roblox under the game's name, which the person may change", async () => {
    const c = await computer({ game: true, studios: [{ id: "studio-b", name: "Place1" }] });
    assert.equal(((await c.act("use-place", { studio: "studio-b" })) as { linked: boolean }).linked, true);
    const tab = await open(c);
    try {
      const place = '#steps [data-step="place"]';
      assert.equal(await tab.locator(`${place} button[data-action="publish-update"]`).count(), 0);
      assert.equal(await tab.locator(`${place} [data-first-publish] .kbd`).count(), 0, "no clicks for the person");
      // Flipped: a small "Or in Studio" line keeps Studio's own clicks under the button, for a Mac
      // whose macOS permissions computer control lacks.
      const orClicks = await tab.locator(`${place} [data-or-in-studio] .kbd`).allTextContents();
      assert.deepEqual(orClicks, PUBLISH_CLICK_PATH.split(" › "));
      const field = tab.getByLabel("Name on Roblox");
      assert.equal(await field.inputValue(), "Sky Race");
      await field.fill("Sky Racers");
      const publish = tab.locator(`${place} button[data-action="first-publish"]`);
      assert.equal(await publish.textContent(), "Publish to Roblox");
      await publish.click();
      await sentOnce(tab, c, (names) => names.includes("first-publish"));
      assert.deepEqual(c.sent.at(-1), ["first-publish", { name: "Sky Racers" }]);
      await tab.waitForFunction(
        (selector) => /publishing Sky Racers/.test(document.querySelector(`${selector} .say`)?.textContent ?? ""),
        place,
      );
      assert.deepEqual(
        c.assists.map((args) => (args as { task: string }).task),
        [firstPublishTask("Sky Racers")],
      );
    } finally {
      await tab.close();
    }
  });

  it("where Genex can't click in Studio, a published place shows Studio's own clicks to publish, never Publish an update", async () => {
    const studios: OpenStudio[] = [
      { id: "studio-a", name: "Pet Valley", placeId: "7781440219", universeId: "2611231458" },
    ];
    const c = await computer({ game: true, studios, canClick: false });
    assert.equal(((await c.act("use-place", { studio: "studio-a" })) as { linked: boolean }).linked, true);
    const tab = await open(c);
    try {
      const place = '#steps [data-step="place"]';
      assert.equal(await tab.locator(`${place} button[data-action="publish-update"]`).count(), 0);
      const clicks = await tab.locator(`${place} [data-publish-clicks] .kbd`).allTextContents();
      assert.deepEqual(clicks, PUBLISH_CLICK_PATH.split(" › "));
    } finally {
      await tab.close();
    }
  });

  // Flipped: once published by hand, Genex links the game to it by itself; nobody chooses it again.
  it("where Genex can't click, a place never published shows Studio's clicks and says Genex picks it up after", async () => {
    const c = await computer({ game: true, studios: [{ id: "studio-b", name: "Place1" }], canClick: false });
    assert.equal(((await c.act("use-place", { studio: "studio-b" })) as { linked: boolean }).linked, true);
    const tab = await open(c);
    try {
      const place = '#steps [data-step="place"]';
      assert.equal(await tab.locator(`${place} button[data-action="first-publish"]`).count(), 0);
      const clicks = await tab.locator(`${place} [data-first-publish] .kbd`).allTextContents();
      assert.deepEqual(clicks, PUBLISH_CLICK_PATH.split(" › "));
      const words = (await tab.locator(`${place} [data-first-publish]`).textContent()) ?? "";
      assert.match(words, /by itself/);
      assert.doesNotMatch(words, /Choose another place/);
    } finally {
      await tab.close();
    }
  });

  it("while Studio waits for a place, the place step's buttons show beside the MCP step", async () => {
    const c = await computer({ answering: false, switchOn: true, game: true });
    const tab = await open(c);
    try {
      assert.equal((await nowStep(tab)).id, "mcp");
      const buttons = await tab.locator('#steps [data-step="place"] button').allTextContents();
      assert.ok(buttons.includes("Choose your place"), buttons.join(", "));
      assert.ok(
        buttons.some((label) => label.includes("New Roblox game")),
        buttons.join(", "),
      );
      assert.equal(await tab.locator('#steps [aria-current="step"]').count(), 1, "one step is next");
    } finally {
      await tab.close();
    }
  });

  it("the places view offers New Roblox game only to a game with no place, and a new one returns to the steps", async () => {
    const linked = await computer({ game: true, studios: [{ id: "studio-b", name: "Place1" }] });
    assert.equal(((await linked.act("use-place", { studio: "studio-b" })) as { linked: boolean }).linked, true);
    const first = await open(linked);
    try {
      await first.click('#steps [data-step="place"] button:has-text("Choose another place")');
      await first.waitForSelector("#places:not([hidden])");
      assert.equal(await first.locator("#places-new").isVisible(), false, "a game with a place can't make another");
      assert.equal(await first.locator("#places-file").isVisible(), true);
    } finally {
      await first.close();
    }
    const c = await computer({ game: true });
    const tab = await open(c);
    try {
      await tab.click('#steps [aria-current="step"] button.primary');
      await tab.waitForSelector("#places:not([hidden])");
      await tab.click("#places-new");
      await sentOnce(tab, c, (names) => names.includes("create"));
      await tab.waitForSelector("#setup:not([hidden])");
      assert.equal(await tab.locator('#steps [data-step="place"].done').count(), 1, "the place is ticked");
    } finally {
      await tab.close();
    }
  });

  it("a game whose Studio can reach its live saved data warns in the place block, with the switch to turn it off", async () => {
    const c = await computer({ game: true, studios: [{ id: "studio-b", name: "Place1" }] });
    assert.equal(((await c.act("use-place", { studio: "studio-b" })) as { linked: boolean }).linked, true);
    await writeLiveData(c.mac.storage, c.game?.project ?? "", { reachable: true, at: 0 });
    const tab = await open(c);
    try {
      const warning = await tab.evaluate(() => {
        const place = document.querySelector('#steps [data-step="place"]');
        return {
          text: place?.querySelector("[data-warning]")?.textContent ?? "",
          path: [...(place?.querySelectorAll("[data-warning] .kbd") ?? [])].map((key) => key.textContent),
        };
      });
      assert.match(warning.text, /Studio can reach this game's live saved data/);
      assert.deepEqual(warning.path, LIVE_DATA_CLICK_PATH.split(" › "));
    } finally {
      await tab.close();
    }
  });
});

/**
 * The host page for the sandboxed tests: the panel, with Studio's real bridge SDK pasted in, runs in
 * an iframe with `sandbox="allow-scripts"` as PluginPanelHost serves it. The host answers bridge
 * requests like PluginPanelHost: actions go to the test's backend, except the ones the test says the
 * person declines at Studio's confirmation (`window.__decline`), which come back as `cancelled`.
 */
const SANDBOX_HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="f" sandbox="allow-scripts" src="/panel" style="width:360px;height:740px;border:0"></iframe>
<script>
window.__requests = [];
window.__decline = window.__decline ?? [];
window.__game = window.__game ?? null;
async function answer(m) {
  if (m.method === "context") return { project: window.__game, apiVersion: 3, theme: { background: "#0e0d0f", foreground: "#dee0e2", accent: "#3c44c4" } };
  if (m.method === "chooseFile") return null;
  if (m.method !== "action") throw new Error("unexpected " + m.method);
  const reply = await window.__backend("action", m.name, m.args ?? {});
  if (reply.error) throw new Error(reply.error);
  return reply.value;
}
window.addEventListener("message", async (event) => {
  const f = document.getElementById("f");
  const m = event.data;
  if (event.source !== f.contentWindow || m?.type !== "studio-plugin-request") return;
  if (m.method === "action" && m.name !== "status") window.__requests.push([m.name, m.args]);
  const reply = (body) => f.contentWindow.postMessage({ type: "studio-plugin-result", id: m.id, ...body }, "*");
  if (m.method === "action" && window.__decline.includes(m.name)) return reply({ error: "Cancelled", code: "cancelled" });
  try { reply({ result: await answer(m) }); } catch (e) { reply({ error: String(e) }); }
});
</script></body></html>`;

describe("The Roblox Studio panel in Studio's sandboxed frame", { skip }, () => {
  let browser: Browser;
  let server: http.Server;
  let url = "";
  before(async () => {
    const panel = await inlinePanelSdk(await readFile(PANEL, "utf8"));
    server = http.createServer((request, response) =>
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(request.url?.startsWith("/panel") ? panel : SANDBOX_HOST),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium
      .launch({ channel: "chrome", headless: true })
      .catch(() => chromium.launch({ headless: true }));
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  /** The host page over computer `c`, and the panel's frame once it has rendered. */
  async function open(c: Computer, options: { decline?: string[] } = {}) {
    const tab = await browser.newPage({ viewport: { width: 400, height: 780 } });
    await tab.exposeFunction("__backend", async (_method: string, name: string, args: Record<string, unknown>) => {
      try {
        return { value: await c.act(name, args) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    // Set before the host page's own script runs, which keeps them.
    await tab.addInitScript(({ game, decline }) => Object.assign(window, { __game: game, __decline: decline }), {
      game: c.game?.project ?? null,
      decline: options.decline ?? [],
    });
    await tab.goto(url);
    const frame = await (await tab.waitForSelector("#f")).contentFrame();
    if (!frame) throw new Error("the panel frame did not load");
    await frame.waitForFunction(() => document.getElementById("app")?.getAttribute("aria-busy") === "false");
    const requests = async () =>
      ((await tab.evaluate(() => (window as unknown as { __requests: unknown[] }).__requests)) as Array<[string]>).map(
        ([name]) => name,
      );
    const focused = () =>
      frame.evaluate(() => {
        const a = document.activeElement;
        return {
          id: a?.id ?? "",
          text: a?.textContent?.trim() ?? "",
          action: (a as HTMLElement | null)?.dataset?.action ?? "",
        };
      });
    const sentOnce = async (ready: (names: string[]) => boolean) => {
      for (let i = 0; i < WAIT_TRIES && !ready(await requests()); i++) await tab.waitForTimeout(WAIT_STEP_MS);
      return requests();
    };
    return { tab, frame, requests, focused, sentOnce };
  }

  it("Tab walks the next step's buttons in reading order, then the click path is text, not stops", async () => {
    const c = await computer({ answering: false, switchOn: false, game: true });
    const p = await open(c);
    try {
      await p.frame.focus('#steps [aria-current="step"] button.primary');
      const order = [await p.focused()];
      for (let i = 0; i < 2; i++) {
        await p.tab.keyboard.press("Tab");
        order.push(await p.focused());
      }
      // Flipped: the place step's buttons follow, shown while Studio waits for a place.
      assert.deepEqual(
        order.map((stop) => stop.text),
        ["Do it for me", "Restart Studio", "Choose your place"],
      );
    } finally {
      await p.tab.close();
    }
  });

  it("names its parts for a screen reader: the steps list, the step that is next, and each done step", async () => {
    const c = await computer({ answering: false, switchOn: false, game: true });
    const p = await open(c);
    try {
      const names = await p.frame.evaluate(() => ({
        list: document.getElementById("steps")?.getAttribute("aria-label"),
        current: document.querySelector('#steps [aria-current="step"]')?.getAttribute("data-step"),
        done: [...document.querySelectorAll("#steps > li.done .sr-only")].map((mark) => mark.textContent),
        footer: document.querySelector("footer")?.textContent,
      }));
      assert.deepEqual(names, {
        list: "Setup steps",
        current: "mcp",
        done: ["Done:", "Done:"],
        footer: FOOTER,
      });
    } finally {
      await p.tab.close();
    }
  });

  it("Enter on Do it for me sends it once, keeps focus on it, and the answer is announced", async () => {
    const c = await computer({ answering: false, switchOn: false, game: true });
    const p = await open(c);
    try {
      await p.frame.focus('#steps [aria-current="step"] button.primary');
      await p.tab.keyboard.press("Enter");
      assert.deepEqual(
        (await p.sentOnce((names) => names.includes("do-it-for-me"))).filter((name) => name === "do-it-for-me"),
        ["do-it-for-me"],
      );
      // Flipped: one live region that stays in the page says each answer, so a screen reader reads it.
      await p.frame.waitForFunction(() => Boolean(document.getElementById("announce")?.textContent));
      assert.equal(
        await p.frame.evaluate(() => document.querySelectorAll('#steps [role="status"]').length),
        0,
        "no live region is made afresh with each draw",
      );
      assert.equal((await p.focused()).text, "Do it for me");
    } finally {
      await p.tab.close();
    }
  });

  it("after Set up, its button is gone and focus moves to the step that is next", async () => {
    const c = await computer({ setUp: false, running: false });
    const p = await open(c);
    try {
      await p.frame.focus('#steps [aria-current="step"] button.primary');
      await p.tab.keyboard.press("Enter");
      await p.sentOnce((names) => names.includes("setup"));
      await p.frame.waitForFunction(
        () => document.querySelector('#steps [aria-current="step"]')?.getAttribute("data-step") === "sign-in",
      );
      assert.equal((await p.focused()).text, "Sign in to Roblox");
    } finally {
      await p.tab.close();
    }
  });

  it("a confirmation the person declines shows no error and changes nothing", async () => {
    const c = await computer({ setUp: false, running: false });
    const p = await open(c, { decline: ["setup"] });
    try {
      await p.frame.focus('#steps [aria-current="step"] button.primary');
      await p.tab.keyboard.press("Enter");
      await p.sentOnce((names) => names.includes("setup"));
      await p.tab.waitForTimeout(400);
      const view = await p.frame.evaluate(() => ({
        say: document.querySelector('#steps [aria-current="step"] [role="status"]')?.textContent ?? "",
        step: document.querySelector('#steps [aria-current="step"]')?.getAttribute("data-step"),
      }));
      assert.deepEqual(view, { say: "", step: "helper" });
    } finally {
      await p.tab.close();
    }
  });

  it("Choose your place moves focus to its heading, and Back returns it to Choose your place", async () => {
    const c = await computer({ game: true, studios: [{ id: "studio-b", name: "Place1" }] });
    const p = await open(c);
    try {
      await p.frame.focus('#steps [aria-current="step"] button.primary');
      await p.tab.keyboard.press("Enter");
      await p.frame.waitForSelector("#places:not([hidden]) #open-places > li");
      assert.equal((await p.focused()).id, "places-title");
      await p.frame.focus("#places-back");
      await p.tab.keyboard.press("Enter");
      await p.frame.waitForSelector("#setup:not([hidden])");
      assert.equal((await p.focused()).text, "Choose your place");
    } finally {
      await p.tab.close();
    }
  });
});

/**
 * The real Unity panel (`src/plugins/unity/panel.html`) against the real backend, in headless
 * Chrome. The panel's `window.studioPlugin` is a stand-in whose `call("action", …)` runs
 * `createUnityBackend` over a fake computer (`helpers/unity-backend.ts`): installed editors in a
 * temporary Applications folder, a game folder, a stand-in editor, and an opener that records what
 * it would start and starts nothing. Every step the backend names must give the panel's list a
 * named first row, and its one button must send its action for the open game with no arguments.
 * Opt-in: it launches a browser, so it runs only with `STUDIO_BROWSER_TESTS=1` and Chrome or a
 * Playwright Chromium already installed.
 */
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { UnityAction } from "../../src/plugins/unity/backend.ts";
import { PanelStep } from "../../src/plugins/unity/panel-status.ts";
import { PIPELINE_VERSION } from "../../src/plugins/unity/pipeline.ts";
import { PLUGIN_CALL_TIMEOUT_MS } from "../../src/substrate/plugins/registry.ts";
import { backendOn, look, ready, withProject } from "../helpers/unity-backend.ts";
import { editorRow, type Reply, UNITY_PREFERENCES } from "../helpers/unity-editor-stand-in.ts";
import { panelWordsScripts } from "../../src/plugin-sdk/inline-panel-sdk.mjs";

const PANEL = path.resolve("src/plugins/unity/panel.html");
const UNITY_6 = "6000.3.10f1";
const SET_UP = { "com.unity.pipeline": PIPELINE_VERSION };
/** A narrow panel: nothing may be wider than it. */
const VIEWPORT = { width: 360, height: 640 };
/** More looks than a test's panel takes in its life: one as it opens, one after each press. */
const LOOKS = 6;

const SkipReason = {
  NotOptedIn: "launches Chrome; set STUDIO_BROWSER_TESTS=1 to run",
} as const;
const skip = process.env.STUDIO_BROWSER_TESTS === "1" ? false : SkipReason.NotOptedIn;

/** The stand-in bridge: context answers a light theme, actions go to the backend the test exposes, a refusal's code crossing as the SDK's does. */
const BRIDGE = `<script>
window.studioPlugin = {
  call: async (method, name, args, options) => {
    if (method === "context") return { project: "lantern", apiVersion: 3, theme: { background: "#ffffff", foreground: "#111111", accent: "#2f6fed", accentFill: "#2f6fed", accentForeground: "#ffffff", accentHover: "#2a63d4" } };
    const answer = await window.__backend(method, name ?? null, args ?? {}, options?.timeoutMs ?? null);
    if (answer.error) throw Object.assign(new Error(answer.error), answer.code ? { code: answer.code } : {});
    return answer.value;
  },
};
</script>`;

type Computer = Awaited<ReturnType<typeof backendOn>>;

/** A game with a set-up Unity 6 project, its editor installed and answering with `replies`. */
async function setUpGame(replies: Reply[] = []) {
  const computer = await backendOn([UNITY_6], replies);
  const root = await withProject(computer.game, UNITY_6, SET_UP);
  return { computer, root };
}

/** An editor's main thread answering every look the panel takes. */
const looks = (reply: () => Reply) => Array.from({ length: LOOKS }, reply);

/** The game the stand-in bridge names: the panel's first row carries it. */
const GAME = "lantern";

/**
 * One step the backend can name: how to reach it, what the list's first row is called, the word
 * beside its dot, the row that needs the person, and the button that acts with its words and action.
 */
type Shown = {
  arrange: () => Promise<Computer>;
  binding?: Record<string, never>;
  name: string;
  state?: string;
  lead?: string;
  /** The id of the line that says the step in a sentence. */
  says?: "text" | "lead-sub" | "hint";
  main?: ["primary" | "lead-act", string, UnityAction];
};
const STEPS: Record<PanelStep, Shown> = {
  [PanelStep.GetUnity]: {
    arrange: () => backendOn([]),
    name: "Get Unity 6",
    says: "text",
    main: ["primary", "Get Unity", UnityAction.GetUnity],
  },
  [PanelStep.NoGame]: { arrange: () => backendOn([UNITY_6]), binding: {}, name: "No game open", says: "text" },
  [PanelStep.NoProject]: { arrange: () => backendOn([UNITY_6]), name: "This game has no Unity project", says: "text" },
  [PanelStep.OldProject]: {
    arrange: async () => {
      const computer = await backendOn(["2022.3.13f1", UNITY_6]);
      await withProject(computer.game, "2022.3.13f1");
      return computer;
    },
    name: GAME,
    state: "Genex not added",
    lead: "This project needs Unity 6",
    says: "lead-sub",
    main: ["lead-act", "Open Unity Hub", UnityAction.GetUnity],
  },
  [PanelStep.NotSetUp]: {
    arrange: async () => {
      const computer = await backendOn([UNITY_6], [ready()]);
      await withProject(computer.game, UNITY_6);
      return computer;
    },
    name: GAME,
    state: "Genex not added",
    main: ["primary", "Open in Unity", UnityAction.Setup],
  },
  [PanelStep.NoEditor]: {
    arrange: async () => {
      const computer = await backendOn(["6000.0.26f1"]);
      await withProject(computer.game, UNITY_6, SET_UP);
      return computer;
    },
    name: GAME,
    state: "Not open",
    lead: "Unity 6.3 isn't installed",
    says: "lead-sub",
    main: ["lead-act", "Open Unity Hub", UnityAction.GetUnity],
  },
  [PanelStep.NotOpen]: {
    arrange: async () => (await setUpGame([ready(), ...looks(look)])).computer,
    name: GAME,
    state: "Not open",
    main: ["primary", "Open in Unity", UnityAction.OpenEditor],
  },
  [PanelStep.Opening]: {
    arrange: async () => {
      const { computer, root } = await setUpGame();
      computer.table.start(editorRow(55, root));
      return computer;
    },
    name: GAME,
    state: "Opening",
    says: "hint",
  },
  [PanelStep.Ready]: {
    arrange: async () => {
      const { computer, root } = await setUpGame(looks(look));
      await computer.openIn(root);
      return computer;
    },
    name: GAME,
    state: "Ready",
  },
  [PanelStep.Terms]: {
    arrange: async () => {
      const { computer, root } = await setUpGame();
      await rm(path.join(computer.env.home, ...UNITY_PREFERENCES));
      computer.table.start(editorRow(55, root));
      return computer;
    },
    name: GAME,
    state: "Waiting for you",
    lead: "Accept Unity's terms",
    says: "lead-sub",
  },
  [PanelStep.Stalled]: {
    arrange: async () => {
      const { computer, root } = await setUpGame(looks(() => new Error("no answer")));
      await computer.openIn(root);
      computer.deps.timeout = () => AbortSignal.abort();
      return computer;
    },
    name: GAME,
    state: "Not answering",
    lead: "Unity isn't answering",
    says: "lead-sub",
    main: ["lead-act", "Restart Unity", UnityAction.RestartEditor],
  },
};

describe("The Unity panel", { skip }, () => {
  let browser: Browser;
  let server: http.Server;
  let url = "";
  before(async () => {
    // The stand-in bridge, then the SDK's own words (in English: the stand-in names no language).
    const words = await panelWordsScripts();
    const page = (await readFile(PANEL, "utf8")).replace("<!-- STUDIO_PANEL_SDK -->", () => BRIDGE + words);
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

  /** What the panel sent besides its looks, and how each press is answered when the test says. */
  interface Wire {
    sent: Array<[string, Record<string, unknown>, number | null]>;
    /** Calls the backend has not answered yet. */
    open?: number;
    answer?: (name: string) => { error: string; code?: string } | undefined;
  }

  /** The panel over `computer`, its actions going through the stand-in bridge to the real backend. */
  async function open(computer: Computer, binding?: Record<string, never>, wire: Wire = { sent: [] }) {
    const tab = await browser.newPage({ viewport: VIEWPORT });
    const backend = async (method: string, name: string, args: Record<string, unknown>, wait: number | null) => {
      if (method !== "action") return { error: `unexpected ${method}` };
      const look = name === UnityAction.Status || name === UnityAction.Agents;
      if (!look) wire.sent.push([name, args, wait]);
      const scripted = look ? undefined : wire.answer?.(name);
      if (scripted) return scripted;
      wire.open = (wire.open ?? 0) + 1;
      try {
        return { value: await computer.act(name, args, binding) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      } finally {
        wire.open -= 1;
      }
    };
    await tab.exposeFunction("__backend", backend);
    await tab.goto(url);
    await tab.waitForFunction(() => document.getElementById("app")?.getAttribute("aria-busy") === "false");
    return { tab, wire };
  }

  const textOf = (tab: Page, id: string) => tab.locator(`#${id}`).innerText();
  const shown = (tab: Page, id: string) => tab.locator(`#${id}`).isVisible();
  /** A press has been sent, and the panel has drawn what the backend answered to it and to the look after. */
  async function settled(tab: Page, wire: Wire, presses = 1) {
    await tab.waitForFunction(() => document.getElementById("app")?.dataset.running === "");
    assert.equal(wire.sent.length, presses);
  }

  for (const [step, { arrange, binding, name, state, lead, says, main }] of Object.entries(STEPS)) {
    it(`shows ${step} as a named row${state ? ` that says "${state}"` : ""} with ${main ? `"${main[1]}"` : "no button"}`, async () => {
      const { tab, wire } = await open(await arrange(), binding);
      try {
        assert.equal(await textOf(tab, "name"), name);
        assert.equal(await shown(tab, "state"), Boolean(state), "a project says where it stands in a dot and a word");
        if (state) assert.equal(await tab.locator("#state-word").textContent(), state);
        assert.equal(await shown(tab, "lead"), Boolean(lead), "a row is added only for what needs the person");
        if (lead) assert.equal(await textOf(tab, "lead-title"), lead);
        if (says) assert.ok((await textOf(tab, says)).length > 20, "the step says what it means in a sentence");
        for (const id of ["primary", "lead-act"]) assert.equal(await shown(tab, id), main?.[0] === id, id);
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `nothing is wider than a ${VIEWPORT.width}px panel (${overflow}px over)`);
        if (!main) return;
        assert.equal(await textOf(tab, main[0]), main[1]);
        await tab.locator(`#${main[0]}`).click();
        await settled(tab, wire);
        assert.deepEqual(
          wire.sent.map(([sent, args]) => [sent, args]),
          [[main[2], {}]],
          "the press sends its action for the open game, with nothing of the panel's own",
        );
      } finally {
        await tab.close();
      }
    });
  }

  it("names the game, where it stands and its Unity in one line, in one font, and outwaits the host's limit for an action that opens Unity", async () => {
    const { computer } = await setUpGame([ready(), ...looks(look)]);
    const { tab, wire } = await open(computer);
    try {
      assert.equal(await textOf(tab, "name"), GAME);
      assert.equal(await textOf(tab, "state"), "Not open · Unity 6.3", "the word, then the project's Unity in short");
      assert.equal(await tab.locator("#state").getAttribute("title"), UNITY_6, "the whole version on hover");
      const fonts = await tab.evaluate(() => {
        const family = (el: Element) => getComputedStyle(el).fontFamily.split(",")[0]?.trim() ?? "";
        const words = [...document.querySelectorAll("#list :is(h2, p, span):not(:empty)")].map(family);
        return { words: [...new Set(words)], button: family(document.querySelector("#primary") ?? document.body) };
      });
      assert.equal(fonts.words.length, 1, `every word in one font (${fonts.words.join(", ")})`);
      assert.notEqual(fonts.button, fonts.words[0], "the code font is the button's alone");
      await tab.locator("#primary").click();
      await tab.waitForFunction(() => document.getElementById("state-word")?.textContent === "Ready");
      assert.equal(await tab.locator("#state").getAttribute("data-tone"), "ok", "a green dot beside Ready");
      assert.equal(await shown(tab, "primary"), false, "an open, ready Unity needs no button");
      assert.deepEqual(wire.sent, [[UnityAction.OpenEditor, {}, 200_000]]);
      assert.ok(200_000 > PLUGIN_CALL_TIMEOUT_MS, "the host's own answer reaches the panel before its wait ends");
      assert.equal(computer.launches.length, 1);
      assert.equal(await shown(tab, "error"), false);
    } finally {
      await tab.close();
    }
  });

  it("keeps the rare actions behind the three dots: Remove Genex while Unity is closed, Restart Unity while it is open", async () => {
    const closedGame = await open((await setUpGame([ready(), ...looks(look)])).computer);
    try {
      assert.equal(await shown(closedGame.tab, "undo"), false, "closed until the dots are pressed");
      await closedGame.tab.locator("#more summary").click();
      assert.equal(await textOf(closedGame.tab, "undo"), "Remove Genex from this project");
      assert.equal(await shown(closedGame.tab, "restart"), false);
      await closedGame.tab.locator("#undo").click();
      await settled(closedGame.tab, closedGame.wire);
      assert.deepEqual(closedGame.wire.sent[0]?.slice(0, 2), [UnityAction.UndoSetup, {}]);
      // The stand-in project was set up by hand, so Genex's record has nothing of its own to take back.
      assert.equal(await textOf(closedGame.tab, "done"), "Nothing of Genex's was left to remove.");
    } finally {
      await closedGame.tab.close();
    }

    const { computer, root } = await setUpGame(looks(look));
    await computer.openIn(root);
    const openGame = await open(computer);
    try {
      await openGame.tab.locator("#more summary").click();
      assert.equal(await textOf(openGame.tab, "restart"), "Restart Unity");
      assert.equal(await shown(openGame.tab, "undo"), false);
    } finally {
      await openGame.tab.close();
    }
  });

  it("shows whether agents may use Unity while the person plays as a switch, on unless turned off, and keeps the person's choice", async () => {
    const { computer, root } = await setUpGame(looks(look));
    await computer.openIn(root);
    const { tab, wire } = await open(computer);
    try {
      const box = tab.locator("#while-playing");
      assert.equal(await shown(tab, "agents"), true);
      assert.equal(await textOf(tab, "agents"), "Agents can use Unity while you play\nThis can stop your play.");
      assert.equal(await box.isChecked(), true, "on unless the person turned it off");
      await tab.getByText("Agents can use Unity while you play").click();
      await tab.waitForFunction(() => !(document.getElementById("while-playing") as HTMLInputElement).disabled);
      assert.equal(await box.isChecked(), false);
      assert.deepEqual(wire.sent, [[UnityAction.AgentsWait, {}, null]]);
      assert.deepEqual(await computer.act(UnityAction.Agents), { whilePlaying: false }, "kept for every game");
      await box.click();
      await tab.waitForFunction(() => (document.getElementById("while-playing") as HTMLInputElement).checked);
      assert.deepEqual(wire.sent.at(-1), [UnityAction.AgentsGoAhead, {}, null]);
    } finally {
      await tab.close();
    }
  });

  it("says why an action was refused, and says nothing when the person declined Genex's question", async () => {
    const refusing = await backendOn([UNITY_6]);
    await withProject(refusing.game, UNITY_6);
    const refused = await open(refusing, undefined, {
      sent: [],
      answer: () => ({ error: "This project has no Packages/manifest.json yet." }),
    });
    try {
      await refused.tab.locator("#primary").click();
      await refused.tab.waitForFunction(() => document.getElementById("error")?.textContent !== "");
      assert.match(await textOf(refused.tab, "error"), /no Packages\/manifest\.json yet/);
    } finally {
      await refused.tab.close();
    }

    const declining = await backendOn([UNITY_6]);
    await withProject(declining.game, UNITY_6);
    const declined = await open(declining, undefined, {
      sent: [],
      answer: () => ({ error: "Cancelled", code: "cancelled" }),
    });
    try {
      await declined.tab.locator("#primary").click();
      await settled(declined.tab, declined.wire);
      assert.equal(await shown(declined.tab, "error"), false, "a declined question is no error");
      assert.equal(await declined.tab.locator("#state-word").textContent(), "Genex not added");
      assert.equal(await shown(declined.tab, "primary"), true, "the button is back");
    } finally {
      await declined.tab.close();
    }
  });

  it("tells the person where Get Unity sent them, and what a restart could not do", async () => {
    const { tab } = await open(await backendOn([]));
    try {
      await tab.locator("#primary").click();
      await tab.waitForFunction(() => document.getElementById("done")?.textContent !== "");
      assert.equal(await textOf(tab, "done"), "Opened Unity's download page in your browser.");
    } finally {
      await tab.close();
    }

    const stubborn = await backendOn(
      [UNITY_6],
      looks(() => new Error("no answer")),
      { ends: { 8: [] } },
    );
    stubborn.table.start(editorRow(8, await withProject(stubborn.game, UNITY_6, SET_UP)));
    const held = await open(stubborn);
    try {
      await held.tab.locator("#more summary").click();
      await held.tab.locator("#restart").click();
      await held.tab.waitForFunction(() => document.getElementById("error")?.textContent !== "");
      assert.match(await textOf(held.tab, "error"), /could not be ended\. Quit it yourself/);
      assert.deepEqual(stubborn.launches, [], "no second editor beside the one that would not end");
    } finally {
      await held.tab.close();
    }
  });
});

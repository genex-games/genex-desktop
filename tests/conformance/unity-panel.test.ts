/**
 * The real Unity panel (`src/plugins/unity/panel.html`) against the real backend, in headless
 * Chrome. The panel's `window.studioPlugin` is a stand-in whose `call("action", …)` runs
 * `createUnityBackend` over a fake computer (`helpers/unity-backend.ts`): installed editors in a
 * temporary Applications folder, a game folder, a stand-in editor, and an opener that records what
 * it would start and starts nothing. Every step the backend names must give the panel a headline
 * and words, and its main button must send its action for the open game with no arguments.
 * Opt-in: it launches a browser, so it runs only with `STUDIO_BROWSER_TESTS=1` and Chrome or a
 * Playwright Chromium already installed.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import { editorRow, type Reply } from "../helpers/unity-editor-stand-in.ts";

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

/** One step the backend can name: how to reach it, its headline, and its main button's words and action. */
const STEPS: Record<
  PanelStep,
  { arrange: () => Promise<Computer>; binding?: Record<string, never>; title: RegExp; main?: [string, UnityAction] }
> = {
  [PanelStep.GetUnity]: {
    arrange: () => backendOn([]),
    title: /^Get Unity 6$/,
    main: ["Get Unity", UnityAction.GetUnity],
  },
  [PanelStep.NoGame]: { arrange: () => backendOn([UNITY_6]), binding: {}, title: /^No game open$/ },
  [PanelStep.NoProject]: { arrange: () => backendOn([UNITY_6]), title: /^No Unity project in this game$/ },
  [PanelStep.OldProject]: {
    arrange: async () => {
      const computer = await backendOn(["2022.3.13f1", UNITY_6]);
      await withProject(computer.game, "2022.3.13f1");
      return computer;
    },
    title: /^This project needs Unity 6$/,
    main: ["Open Unity Hub", UnityAction.GetUnity],
  },
  [PanelStep.NotSetUp]: {
    arrange: async () => {
      const computer = await backendOn([UNITY_6], [ready()]);
      await withProject(computer.game, UNITY_6);
      return computer;
    },
    title: /^Set up this project$/,
    main: ["Set up", UnityAction.Setup],
  },
  [PanelStep.NoEditor]: {
    arrange: async () => {
      const computer = await backendOn(["6000.0.26f1"]);
      await withProject(computer.game, UNITY_6, SET_UP);
      return computer;
    },
    title: /^Unity 6000\.3\.10f1 isn't installed$/,
    main: ["Open Unity Hub", UnityAction.GetUnity],
  },
  [PanelStep.NotOpen]: {
    arrange: async () => (await setUpGame([ready(), ...looks(look)])).computer,
    title: /^Unity isn't open$/,
    main: ["Open in Unity", UnityAction.OpenEditor],
  },
  [PanelStep.Opening]: {
    arrange: async () => {
      const { computer, root } = await setUpGame();
      computer.table.start(editorRow(55, root));
      return computer;
    },
    title: /^Unity is starting$/,
  },
  [PanelStep.Ready]: {
    arrange: async () => {
      const { computer, root } = await setUpGame(looks(look));
      await computer.openIn(root);
      return computer;
    },
    title: /^Unity is ready$/,
  },
  [PanelStep.Stalled]: {
    arrange: async () => {
      const { computer, root } = await setUpGame(looks(() => new Error("no answer")));
      await computer.openIn(root);
      computer.deps.timeout = () => AbortSignal.abort();
      return computer;
    },
    title: /^Unity isn't answering$/,
    main: ["Restart Unity", UnityAction.RestartEditor],
  },
};

describe("The Unity panel", { skip }, () => {
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

  /** What the panel sent besides its looks, and how each press is answered when the test says. */
  interface Wire {
    sent: Array<[string, Record<string, unknown>, number | null]>;
    answer?: (name: string) => { error: string; code?: string } | undefined;
  }

  /** The panel over `computer`, its actions going through the stand-in bridge to the real backend. */
  async function open(computer: Computer, binding?: Record<string, never>, wire: Wire = { sent: [] }) {
    const tab = await browser.newPage({ viewport: VIEWPORT });
    const backend = async (method: string, name: string, args: Record<string, unknown>, wait: number | null) => {
      if (method !== "action") return { error: `unexpected ${method}` };
      if (name !== UnityAction.Status) wire.sent.push([name, args, wait]);
      const scripted = name === UnityAction.Status ? undefined : wire.answer?.(name);
      if (scripted) return scripted;
      try {
        return { value: await computer.act(name, args, binding) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };
    await tab.exposeFunction("__backend", backend);
    await tab.goto(url);
    await tab.waitForFunction(() => document.getElementById("app")?.getAttribute("aria-busy") === "false");
    return { tab, wire };
  }

  const textOf = (tab: Page, id: string) => tab.locator(`#${id}`).innerText();
  const shown = (tab: Page, id: string) => tab.locator(`#${id}`).isVisible();

  for (const [step, { arrange, binding, title, main }] of Object.entries(STEPS)) {
    it(`shows ${step} with a headline, its words and ${main ? `"${main[0]}"` : "no main button"}`, async () => {
      const { tab, wire } = await open(await arrange(), binding);
      try {
        assert.match(await textOf(tab, "title"), title);
        assert.ok((await textOf(tab, "text")).length > 20, "the step says what it means in a sentence");
        assert.equal(await shown(tab, "primary"), Boolean(main));
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `nothing is wider than a ${VIEWPORT.width}px panel (${overflow}px over)`);
        if (!main) return;
        assert.equal(await textOf(tab, "primary"), main[0]);
        await tab.locator("#primary").click();
        await tab.waitForFunction(() => !(document.getElementById("primary") as HTMLButtonElement).disabled);
        assert.deepEqual(
          wire.sent.map(([name, args]) => [name, args]),
          [[main[1], {}]],
          "the press sends its action for the open game, with nothing of the panel's own",
        );
      } finally {
        await tab.close();
      }
    });
  }

  it("names the game's project folder, where it stands and its Unity, and outwaits the host's limit for an action that opens Unity", async () => {
    const { computer } = await setUpGame([ready(), ...looks(look)]);
    const { tab, wire } = await open(computer);
    try {
      assert.equal(await textOf(tab, "where"), "unity/");
      assert.equal(await textOf(tab, "version"), `Unity ${UNITY_6}`);
      assert.equal(await textOf(tab, "state"), "Not open", "the strip button's own word");
      assert.equal(await textOf(tab, "installed"), UNITY_6, "This computer names the Unity installed");
      await tab.locator("#primary").click();
      await tab.waitForFunction(() => document.getElementById("title")?.textContent === "Unity is ready");
      const ready = await tab.evaluate(() => {
        const word = document.getElementById("state-word");
        return {
          tone: document.getElementById("state")?.dataset.tone,
          word: word?.textContent,
          width: word?.getBoundingClientRect().width,
        };
      });
      assert.deepEqual(
        ready,
        { tone: "ok", word: "Ready", width: 1 },
        "Ready is the green dot alone, its word for screen readers",
      );
      assert.deepEqual(wire.sent, [[UnityAction.OpenEditor, {}, 200_000]]);
      assert.ok(200_000 > PLUGIN_CALL_TIMEOUT_MS, "the host's own answer reaches the panel before its wait ends");
      assert.equal(computer.launches.length, 1);
      assert.equal(await shown(tab, "error"), false);
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
      await declined.tab.waitForFunction(() => !(document.getElementById("primary") as HTMLButtonElement).disabled);
      assert.equal(declined.wire.sent.length, 1);
      assert.equal(await shown(declined.tab, "error"), false, "a declined question is no error");
      assert.equal(await textOf(declined.tab, "title"), "Set up this project");
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
      await held.tab.locator("#quiet").click();
      await held.tab.waitForFunction(() => document.getElementById("error")?.textContent !== "");
      assert.match(await textOf(held.tab, "error"), /could not be ended\. Quit it yourself/);
      assert.deepEqual(stubborn.launches, [], "no second editor beside the one that would not end");
    } finally {
      await held.tab.close();
    }
  });
});

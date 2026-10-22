/**
 * Publish an update (`plugins/roblox/publish.ts`): the panel's action and the agent's confirmed tool
 * `publish-update` both hand the game's chat the task "Publish … to Roblox: File › Publish to Roblox"
 * through `game.engine.assist`, so the person's own computer control clicks it in their Studio. Where
 * it can't (Windows, no driver, no chat, the person said no), the answer gives Studio's click path. A
 * place that was never published gets the first publish's click path and no assist: that publish is
 * the person's. Last, the agent's card and the assist turn through a real core with a fake driver.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { PluginEngineAssistAnswer, PluginEngineLink } from "../../src/plugin-sdk/index.d.ts";
import { createRobloxBackend, RobloxAction, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import {
  firstPublish,
  firstPublishTask,
  PUBLISH_CLICK_PATH,
  PublishAsker,
  PublishMiss,
  publishTask,
  publishUpdate,
  reviewFirstPublish,
  reviewPublish,
} from "../../src/plugins/roblox/publish.ts";
import { desktopControl } from "../../src/main/core/desktop-control.ts";
import { assistGrants, engineAppIds } from "../../src/main/core/desktop-assist.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { ConsentChoice, consentChoices, consentTitle } from "../../src/renderer/chat/consent-card.ts";
import {
  ENGINE_ASSIST_TASK_MAX_CHARS,
  EngineAssistRefusal,
  type PluginBinding,
  StudioConsentSource,
} from "../../src/shared/plugins.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import type { DesktopDriver } from "../../src/substrate/desktop-driver.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";

const MANIFEST = path.resolve(import.meta.dirname, "../../src/plugins/roblox/plugin.json");
const REMOTE = { placeId: "7781440219", universeId: "2650912" };

/** A game's link to a place file, published (with its ids) or never. */
const linkTo = (published: boolean): PluginEngineLink => ({
  kind: "roblox",
  project: "/games/sky-race/sky-race.rbxlx",
  linkedAt: new Date(0).toISOString(),
  name: "sky-race",
  ...(published ? { remote: REMOTE } : {}),
});

/** A host's assist that records each task and answers `answer`. */
function assisting(answer: PluginEngineAssistAnswer = { started: true }) {
  const tasks: string[] = [];
  const order: string[] = [];
  return {
    tasks,
    order,
    deps: {
      assist: async (task: string) => {
        tasks.push(task);
        order.push("assist");
        return answer;
      },
      flush: async () => {
        order.push("flush");
      },
    },
  };
}

describe("publish-update hands the task to the game's chat", () => {
  for (const asker of [PublishAsker.Person, PublishAsker.Agent])
    it(`asked by the ${asker}: a published place's task reaches the host, scripts sent to Studio first`, async () => {
      const host = assisting();
      const answer = await publishUpdate({ link: linkTo(true), name: "Sky Race" }, host.deps, asker);
      assert.equal(answer.started, true, answer.message);
      assert.deepEqual(host.tasks, [publishTask("Sky Race")]);
      assert.deepEqual(host.order, ["flush", "assist"], "the script files reach Studio before it publishes");
      assert.match(answer.message, /publish/i);
    });

  it("the task names the place and Studio's own clicks, in one plain line within the host's limit", () => {
    assert.match(publishTask("Sky Race"), /^Publish Sky Race to Roblox/);
    assert.ok(publishTask("Sky Race").includes(PUBLISH_CLICK_PATH));
    assert.ok(publishTask(undefined).startsWith("Publish this place to Roblox"));
    for (const name of ["", "  ", "a\nb\u0007c", "x".repeat(500), "Sky › Race\t2"]) {
      const task = publishTask(name);
      assert.ok(task.length <= ENGINE_ASSIST_TASK_MAX_CHARS, `${task.length} characters`);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
      assert.doesNotMatch(task, /[\u0000-\u001f\u007f]/, JSON.stringify(name));
      assert.ok(task.includes(PUBLISH_CLICK_PATH));
    }
  });

  const refusals: Array<[string, PluginEngineAssistAnswer]> = [
    ["no desktop control here (Windows, or no driver)", { started: false, reason: EngineAssistRefusal.Unavailable }],
    ["the person said no", { started: false, reason: EngineAssistRefusal.Declined }],
    ["no chat to click it", { started: false, reason: EngineAssistRefusal.NoChat }],
    ["not the person's call", { started: false, reason: EngineAssistRefusal.NotPerson }],
    ["no reason given", { started: false }],
  ];
  for (const [what, refused] of refusals)
    for (const asker of [PublishAsker.Person, PublishAsker.Agent])
      it(`${what}, asked by the ${asker}: nothing starts, and the answer gives Studio's click path`, async () => {
        const host = assisting(refused);
        const answer = await publishUpdate({ link: linkTo(true), name: "Sky Race" }, host.deps, asker);
        assert.equal(answer.started, false);
        assert.equal(answer.clickPath, PUBLISH_CLICK_PATH);
        assert.ok(answer.message.includes(PUBLISH_CLICK_PATH), answer.message);
        if (refused.reason) assert.equal(answer.reason, refused.reason);
      });

  // Flipped: a place never published is no longer the person's to publish by hand. Publish an update
  // points at the first publish (the agent's first-publish, the panel's Publish to Roblox), with no click path.
  it("asked by the agent, a place never published sends it to first-publish, clicking nothing", async () => {
    const host = assisting();
    const answer = await publishUpdate({ link: linkTo(false), name: "Sky Race" }, host.deps, PublishAsker.Agent);
    assert.deepEqual(host.order, [], "nothing is clicked or sent");
    assert.equal(answer.started, false);
    assert.equal(answer.reason, PublishMiss.FirstPublish);
    assert.equal(answer.clickPath, undefined);
    assert.match(answer.message, /roblox__first-publish/);
    assert.match(answer.message, /"Sky Race"/, "the name to pass");
  });

  it("asked by the person, a place never published points at Publish to Roblox, clicking nothing", async () => {
    const host = assisting();
    const answer = await publishUpdate({ link: linkTo(false), name: "Sky Race" }, host.deps, PublishAsker.Person);
    assert.deepEqual(host.order, []);
    assert.equal(answer.reason, PublishMiss.FirstPublish);
    assert.match(answer.message, /Publish to Roblox/);
  });

  it("a game with no place has nothing to publish, and asks nothing", async () => {
    const host = assisting();
    const answer = await publishUpdate({ link: null }, host.deps, PublishAsker.Person);
    assert.deepEqual(host.order, []);
    assert.equal(answer.started, false);
    assert.equal(answer.reason, PublishMiss.NoPlace);
  });

  it("a failed send of the script files still publishes: Studio holds what it last had", async () => {
    const host = assisting();
    const deps = {
      ...host.deps,
      flush: async () => {
        throw new Error("helper not connected");
      },
    };
    const answer = await publishUpdate({ link: linkTo(true) }, deps, PublishAsker.Person);
    assert.equal(answer.started, true);
    assert.equal(host.tasks.length, 1);
  });

  it("the panel's card names the place and says it reaches players on the person's account", () => {
    const review = reviewPublish({ link: linkTo(true), name: "Sky Race" });
    assert.match(String(review.message), /Sky Race/);
    assert.match(String(review.detail), /your Roblox account/);
    assert.ok(String(review.detail).includes(PUBLISH_CLICK_PATH));
    assert.doesNotMatch(String(review.detail), /this Mac/, "the card's words hold on any computer");
    assert.deepEqual(reviewPublish({ link: linkTo(false) }), {}, "a first publish keeps the manifest's card");
  });
});

describe("first-publish publishes a place never on Roblox, under the game's name", () => {
  for (const asker of [PublishAsker.Person, PublishAsker.Agent])
    it(`asked by the ${asker}: the task names the game, scripts reach Studio first`, async () => {
      const host = assisting();
      const place = { link: linkTo(false), name: "sky-race", title: "Sky Race" };
      const answer = await firstPublish(place, host.deps, asker, "Sky Racers");
      assert.equal(answer.started, true, answer.message);
      assert.equal(answer.name, "Sky Racers");
      assert.deepEqual(host.tasks, [firstPublishTask("Sky Racers")]);
      assert.deepEqual(host.order, ["flush", "assist"]);
      assert.match(answer.message, /Sky Racers/);
    });

  it("with no name asked for, the Genex game's title, else the place's name", async () => {
    const rows: Array<[string | undefined, Parameters<typeof firstPublish>[0], string]> = [
      [undefined, { link: linkTo(false), name: "sky-race", title: "Sky Race" }, "Sky Race"],
      ["  ", { link: linkTo(false), name: "sky-race", title: "Sky Race" }, "Sky Race"],
      [undefined, { link: linkTo(false), name: "sky-race" }, "sky-race"],
      [undefined, { link: linkTo(false) }, "My Roblox game"],
    ];
    for (const [requested, place, expected] of rows) {
      const host = assisting();
      const answer = await firstPublish(place, host.deps, PublishAsker.Agent, requested);
      assert.equal(answer.name, expected, JSON.stringify(place));
    }
  });

  it("a name is one plain line Roblox takes: controls gone, quotes softened, at most 50 characters", async () => {
    const host = assisting();
    const hostile = `a\n"b"\u0007${"x".repeat(80)}`;
    const answer = await firstPublish({ link: linkTo(false) }, host.deps, PublishAsker.Agent, hostile);
    const name = String(answer.name);
    assert.ok(name.length <= 50, name);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
    assert.doesNotMatch(name, /[\u0000-\u001f\u007f"]/);
  });

  it("the task says where to click, to keep Studio's settings, and where to stop, within the host's limit", () => {
    for (const name of ["Sky Race", "x".repeat(50), "Sky › Race"]) {
      const task = firstPublishTask(name);
      assert.ok(task.length <= ENGINE_ASSIST_TASK_MAX_CHARS, `${task.length} characters`);
      assert.ok(task.includes(PUBLISH_CLICK_PATH));
      assert.ok(task.includes(`"${name}"`));
      for (const word of [/new game/, /privacy/, /description empty/, /age/, /ID/, /two-step/, /terms/, /payment/])
        assert.match(task, word);
    }
  });

  it("a place already on Roblox is updated with publish-update instead, and nothing is clicked", async () => {
    const host = assisting();
    const answer = await firstPublish({ link: linkTo(true), name: "Sky Race" }, host.deps, PublishAsker.Agent);
    assert.deepEqual(host.order, []);
    assert.equal(answer.reason, PublishMiss.Published);
    assert.match(answer.message, /roblox__publish-update/);
    const none = await firstPublish({ link: null }, host.deps, PublishAsker.Agent);
    assert.equal(none.reason, PublishMiss.NoPlace);
  });

  for (const reason of [EngineAssistRefusal.Unavailable, EngineAssistRefusal.Declined])
    it(`answered ${reason}, the agent hears nothing was published and where the person's own clicks are`, async () => {
      const host = assisting({ started: false, reason });
      const answer = await firstPublish({ link: linkTo(false), title: "Sky Race" }, host.deps, PublishAsker.Agent);
      assert.equal(answer.started, false);
      assert.equal(answer.clickPath, PUBLISH_CLICK_PATH);
      assert.match(answer.message, /[Nn]othing was published/);
    });

  it("the panel's card names the game and keeps Studio's privacy", () => {
    const review = reviewFirstPublish({ link: linkTo(false), title: "Sky Race" }, "Sky Racers");
    assert.match(String(review.message), /Sky Racers/);
    assert.match(String(review.detail), /privacy/);
    assert.match(String(review.detail), /your Roblox account/);
    assert.deepEqual(reviewFirstPublish({ link: linkTo(true) }), {}, "a published place keeps the manifest's card");
  });
});

describe("the manifest's first publish", () => {
  it("the panel's Publish to Roblox and the agent's first-publish both ask on a card, naming the game", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
    const action = manifest.actions?.find((entry) => entry.name === RobloxAction.FirstPublish);
    assert.ok(action);
    assert.equal(action.label, "Publish to Roblox");
    assert.equal(action.native, true);
    const tool = manifest.tools.find((entry) => entry.name === RobloxTool.FirstPublish);
    assert.ok(tool);
    assert.deepEqual(tool.facts, ["roblox-project"]);
    assert.equal(tool.parameters.properties.name?.type, "string");
    assert.deepEqual(tool.confirmationInput, { parameter: "name", label: "Name on Roblox" });
    for (const card of [action.confirmation ?? "", tool.confirmation ?? ""]) {
      assert.ok(card.length > 0 && card.length <= 300, `${card.length} characters`);
      assert.match(card, /your Roblox account/);
      assert.match(card, /privacy/);
      assert.ok(card.includes(PUBLISH_CLICK_PATH), card);
    }
  });
});

describe("the manifest's Publish an update", () => {
  it("the panel action and the agent tool both ask on a card; the action runs only in a real profile", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
    const action = manifest.actions?.find((entry) => entry.name === RobloxAction.PublishUpdate);
    assert.ok(action);
    assert.equal(action.label, "Publish an update");
    assert.equal(action.native, true);
    const tool = manifest.tools.find((entry) => entry.name === RobloxTool.PublishUpdate);
    assert.ok(tool);
    assert.deepEqual(tool.facts, ["roblox-project"]);
    assert.equal(tool.needs, undefined, "the chat's next turn clicks it; the call itself waits on no one");
    for (const card of [action.confirmation ?? "", tool.confirmation ?? ""]) {
      assert.ok(card.length > 0 && card.length <= 300, `${card.length} characters`);
      assert.match(card, /your Roblox account/);
      assert.ok(card.includes(PUBLISH_CLICK_PATH), card);
    }
  });
});

describe("through the backend", () => {
  const onMacWorld = { skip: process.platform === "win32" ? "the fake Mac helper is POSIX-only" : false };

  it("the panel's action and the agent's tool pass the task for the linked, published place", onMacWorld, async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-b", name: "Sky Race", ...REMOTE }] });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const tasks: string[] = [];
    const host = hostFor(mac, game, {
      assist: (args) => {
        tasks.push(String((args as { task: string }).task));
        return { started: true };
      },
    });
    const backend = createRobloxBackend(mac.deps);
    const linked = (await backend.action?.(RobloxAction.UsePlace, { studio: "studio-b" }, host.context)) as {
      linked: boolean;
    };
    assert.equal(linked.linked, true);
    const status = (await backend.action?.(RobloxAction.Status, {}, host.context)) as { publish?: unknown };
    // Flipped: the status also says whether Genex can click Publish in Studio here (a Mac).
    assert.deepEqual(status.publish, { published: true, canClick: true });
    const pressed = (await backend.action?.(RobloxAction.PublishUpdate, {}, host.context)) as { started: boolean };
    assert.equal(pressed.started, true);
    const called = (await backend.tool?.(RobloxTool.PublishUpdate, {}, host.context)) as { started: boolean };
    assert.equal(called.started, true);
    assert.deepEqual(tasks, [publishTask("Sky Race"), publishTask("Sky Race")]);
    const review = await backend.review?.(RobloxAction.PublishUpdate, {}, host.context);
    assert.match(String(review?.message), /Sky Race/);
  });

  it(
    "a place file never published answers the first publish's click path, and the host is never asked",
    onMacWorld,
    async () => {
      const mac = await robloxMac();
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const file = path.join(game.directory, "sky-race.rbxlx");
      await writeFile(file, "<roblox/>");
      const host = hostFor(mac, game);
      const backend = createRobloxBackend(mac.deps);
      const linked = (await backend.action?.(RobloxAction.UsePlace, { file }, host.context)) as { linked: boolean };
      assert.equal(linked.linked, true);
      const status = (await backend.action?.(RobloxAction.Status, {}, host.context)) as { publish?: unknown };
      // Flipped: a place never published also names the game it would be published as.
      assert.deepEqual(status.publish, { published: false, canClick: true, name: "Sky Race" });
      mac.deps.canClick = () => false;
      const elsewhere = (await backend.action?.(RobloxAction.Status, {}, host.context)) as { publish?: unknown };
      assert.deepEqual(
        elsewhere.publish,
        { published: false, canClick: false, name: "Sky Race" },
        "where Genex can't click",
      );
      const answer = (await backend.action?.(RobloxAction.PublishUpdate, {}, host.context)) as { reason?: string };
      assert.equal(answer.reason, PublishMiss.FirstPublish);
      assert.ok(!host.calls.some((call) => call.method === "game.engine.assist"));
    },
  );

  it(
    "a place never published is published by the panel's press and the agent's tool, under the game's name",
    onMacWorld,
    async () => {
      const mac = await robloxMac();
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const file = path.join(game.directory, "sky-race.rbxlx");
      await writeFile(file, "<roblox/>");
      const tasks: string[] = [];
      const host = hostFor(mac, game, {
        assist: (args) => {
          tasks.push(String((args as { task: string }).task));
          return { started: true };
        },
      });
      const backend = createRobloxBackend(mac.deps);
      await backend.action?.(RobloxAction.UsePlace, { file }, host.context);
      const review = await backend.review?.(RobloxAction.FirstPublish, {}, host.context);
      assert.match(String(review?.message), /Sky Race/);
      const pressed = (await backend.action?.(RobloxAction.FirstPublish, {}, host.context)) as { started: boolean };
      assert.equal(pressed.started, true);
      const called = (await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context)) as
        | { message: string }
        | undefined;
      // Flipped: the answer also says to click now when the task joined this very turn.
      assert.match(String(called?.message), /end this turn/i);
      assert.match(String(called?.message), /in front of you in this turn/);
      assert.deepEqual(tasks, [firstPublishTask("Sky Race"), firstPublishTask("Sky Racers")]);
    },
  );

  it(
    "first-publish needs a name Roblox takes as it is: an empty, too long or changed one clicks nothing",
    onMacWorld,
    async () => {
      const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
      const declared = manifest.tools.find((entry) => entry.name === RobloxTool.FirstPublish);
      assert.deepEqual(declared?.parameters.required, ["name"]);
      const mac = await robloxMac();
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const file = path.join(game.directory, "sky-race.rbxlx");
      await writeFile(file, "<roblox/>");
      const host = hostFor(mac, game, { assist: () => ({ started: true }) });
      const backend = createRobloxBackend(mac.deps);
      await backend.action?.(RobloxAction.UsePlace, { file }, host.context);
      for (const name of ["  ", "x".repeat(70), 'Sky "Race"']) {
        const answer = (await backend.tool?.(RobloxTool.FirstPublish, { name }, host.context)) as {
          started: boolean;
          message: string;
        };
        assert.equal(answer.started, false, name);
        assert.match(answer.message, /Nothing was clicked/);
        assert.match(answer.message, /roblox__first-publish/);
      }
      assert.ok(!host.calls.some((call) => call.method === "game.engine.assist"), "nothing was handed over");
    },
  );

  it("with no desktop control, the answer gives the click path", onMacWorld, async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-b", name: "Sky Race", ...REMOTE }] });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const host = hostFor(mac, game);
    const backend = createRobloxBackend(mac.deps);
    await backend.action?.(RobloxAction.UsePlace, { studio: "studio-b" }, host.context);
    const answer = (await backend.action?.(RobloxAction.PublishUpdate, {}, host.context)) as {
      started: boolean;
      reason?: string;
      clickPath?: string;
    };
    assert.equal(answer.started, false);
    assert.equal(answer.reason, EngineAssistRefusal.Unavailable);
    assert.equal(answer.clickPath, PUBLISH_CLICK_PATH);
  });
});

/** A driver that answers pictures; nothing here clicks. */
function quietDriver(): DesktopDriver {
  const nothing = async () => {};
  return {
    screenshot: async () => ({
      image: Buffer.from("png"),
      mime: "image/png",
      width: 100,
      height: 100,
      screen: { width: 100, height: 100 },
    }),
    focus: async () => ({ app: null, secure: false }),
    move: nothing,
    click: nothing,
    mouse: nothing,
    drag: nothing,
    scroll: nothing,
    type: nothing,
    press: nothing,
    accessibility: async () => ({}),
    close: nothing,
  };
}

describe("the agent's card and the assist turn, through a real core with a fake driver", () => {
  let lite: CoreLite;
  let binding: PluginBinding;
  let threadId: string;
  let approve = true;
  /** What the next card's Allow sends as the edit of its field; undefined sends none. */
  let edit: string | undefined;
  const posted: Array<{ text: string; thread?: string; clientId?: string }> = [];

  before(async () => {
    lite = await coreLite({
      desktop: desktopControl({
        findDriver: async () => "/fake/cua-driver",
        connect: async () => quietDriver(),
        ownApp: () => false,
      }),
      onUiEvent: (event: UiEventData) => {
        if (event.type !== UiEvent.PluginConsent) return;
        const payload = event.payload as { consentId: string; state: string };
        if (payload.state !== "pending") return;
        const [yes, input] = [approve, edit];
        void Promise.resolve().then(() => lite.core.resolveConsent(payload.consentId, yes, false, input));
      },
    });
    const { core } = lite;
    await core.plugins.setEnabled("roblox", true);
    const dir = (await core.games.scaffold("obby")).dir;
    await writeFile(path.join(dir, "obby.rbxlx"), "<roblox/>");
    threadId = await core.threadForGame("obby");
    binding = { project: "obby", directory: dir, threadId };
    await core.engineLinks.link("roblox", binding, { project: path.join(dir, "obby.rbxlx"), remote: REMOTE });
    core.sendUserMessage = async (text, options = {}) => {
      posted.push({
        text,
        ...(options.thread ? { thread: options.thread } : {}),
        ...(options.clientId ? { clientId: options.clientId } : {}),
      });
    };
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  /** The consent cards the chat showed, as [source, state]. */
  const cards = async (): Promise<Array<[string, string]>> =>
    (await lite.core.store.listEvents(threadId))
      .filter((event) => event.data.type === "custom" && event.data.event_type === "plugin_consent")
      .map((event) => {
        const payload = (event.data as { payload: { pluginId: string; state: string } }).payload;
        return [payload.pluginId, payload.state] as [string, string];
      });

  it("the card shows; approved, with computer control off, the setting card follows and the chat gets the task", async () => {
    const { core } = lite;
    assert.equal(core.settings.computerControl, false);
    const answer = (await core.plugins.tool("roblox__publish-update", {}, binding)) as { started: boolean };
    assert.equal(answer.started, true, JSON.stringify(answer));
    assert.deepEqual(await cards(), [
      ["roblox", "pending"],
      ["roblox", "approved"],
      [StudioConsentSource.ComputerSetting, "pending"],
      [StudioConsentSource.ComputerSetting, "approved"],
    ]);
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.text, `Roblox Studio asks: ${publishTask("obby")}`);
    assert.equal(posted[0]?.thread, threadId);
    const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
    const grant = assistGrants(core).live(threadId);
    // Studio as this system names it: its bundle id on a Mac, its executable on Windows.
    const studio = engineAppIds(manifest.engine?.apps);
    assert.deepEqual(grant?.apps, new Set(studio), "the turn may click Roblox Studio only");
    assert.equal(studio.length, 1);
    assert.equal(grant?.messageId, posted[0]?.clientId);

    const entries = toEntries(await core.store.listEvents(threadId)).filter(
      (entry) => (entry as { consentId?: string }).consentId,
    ) as Array<Parameters<typeof consentTitle>[0]>;
    const [card] = entries;
    assert.ok(card);
    assert.equal(consentTitle(card), manifest.tools.find((tool) => tool.name === "publish-update")?.confirmation);
    assert.deepEqual(
      consentChoices(card).map((choice) => choice.id),
      [ConsentChoice.Once, ConsentChoice.Decline],
      "no Always allow",
    );
  });

  it("first-publish on a place never published: its card, then the chat gets the task under the name given", async () => {
    const { core } = lite;
    const dir = (await core.games.scaffold("tower")).dir;
    await writeFile(path.join(dir, "tower.rbxlx"), "<roblox/>");
    const towerThread = await core.threadForGame("tower");
    const tower = { project: "tower", directory: dir, threadId: towerThread };
    await core.engineLinks.link("roblox", tower, { project: path.join(dir, "tower.rbxlx") });
    const before = posted.length;
    const answer = (await core.plugins.tool("roblox__first-publish", { name: "Tower Run" }, tower)) as {
      started: boolean;
    };
    assert.equal(answer.started, true, JSON.stringify(answer));
    assert.equal(posted.length, before + 1);
    assert.equal(posted.at(-1)?.text, `Roblox Studio asks: ${firstPublishTask("Tower Run")}`);
    const cards = toEntries(await core.store.listEvents(towerThread)).filter(
      (entry) => (entry as { consentId?: string }).consentId,
    ) as Array<{ consentSourceId?: string; consentInput?: { label: string; value: string } }>;
    const card = cards.find((entry) => entry.consentSourceId === "roblox");
    assert.deepEqual(card?.consentInput, { label: "Name on Roblox", value: "Tower Run" }, "the name, editable");
  });

  it("first-publish's card edits the name: the person's edit is the game's name on Roblox", async () => {
    const { core } = lite;
    const dir = (await core.games.scaffold("ramp")).dir;
    await writeFile(path.join(dir, "ramp.rbxlx"), "<roblox/>");
    const ramp = { project: "ramp", directory: dir, threadId: await core.threadForGame("ramp") };
    await core.engineLinks.link("roblox", ramp, { project: path.join(dir, "ramp.rbxlx") });
    edit = "Ramp Rush";
    try {
      const answer = (await core.plugins.tool("roblox__first-publish", { name: "Ramp" }, ramp)) as { name?: string };
      assert.equal(answer.name, "Ramp Rush");
      assert.equal(posted.at(-1)?.text, `Roblox Studio asks: ${firstPublishTask("Ramp Rush")}`);
    } finally {
      edit = undefined;
    }
  });

  it("declined, nothing is posted", async () => {
    approve = false;
    const before = posted.length;
    try {
      await assert.rejects(lite.core.plugins.tool("roblox__publish-update", {}, binding), /declin|not allow/i);
      assert.equal(posted.length, before);
    } finally {
      approve = true;
    }
  });
});

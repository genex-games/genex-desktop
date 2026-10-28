/**
 * Do it for me (`game.engine.assist`): an engine plugin hands a setup task to the game's chat,
 * whose own session then clicks it with the person's computer control, limited to the apps the
 * plugin's manifest declares (`engine.apps`). The person starts one: a plugin action they pressed,
 * or a tool call whose card they approved; a plugin that came with Genex may also start one from its
 * own tools, for the setup it knows. A plugin that did not come with Genex shows the task on a card
 * first, and with computer control off a card offers to turn it on for every chat.
 *
 * First the service on a fake host (every refusal, and nothing happening on one), then the grant's
 * life, then the toy engine plugin through a real core: its own action, its confirmed tool, and the
 * calls that are not the person's.
 */
import assert from "node:assert/strict";
import { cp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  ASSIST_GRANT_MAX_MS,
  type AssistCard,
  AssistCardKind,
  AssistGrants,
  type AssistHost,
  assistAvailable,
  assistOpensPages,
  assistPageRefusal,
  assistGrants,
  declaredEngineApps,
  declaredPlayerApps,
  engineAppIds,
  engineAssist,
  assistUnderWay,
  followAssistDeliveries,
} from "../../src/main/core/desktop-assist.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { SteerDelivery } from "../../src/shared/message-queue.ts";
import { desktopControl } from "../../src/main/core/desktop-control.ts";
import { engineAppRefusal } from "../../src/main/core/desktop-target.ts";
import {
  EngineAssistRefusal,
  type PluginBinding,
  PluginSourceKind,
  PluginToolAudience,
  StudioConsentSource,
} from "../../src/shared/plugins.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import type { DesktopApp, DesktopDriver } from "../../src/substrate/desktop-driver.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TASK = "Turn on the toy editor's server: Toy › Settings › Server";
const BINDING: PluginBinding = { project: "garden", directory: "/games/garden", threadId: "chat-1" };

/** What a fake host saw: the cards it asked, the turns it posted and whether control was turned on. */
interface Seen {
  cards: AssistCard[];
  posted: Array<{ threadId: string; project: string; text: string; messageId: string }>;
  turnedOn: number;
  grantWaits: number;
}

/** A host with one plugin, `toy-engine`: bundled or local, its apps, and the person's answers. */
function fakeHost(
  options: {
    bundled?: boolean;
    apps?: string[];
    control?: boolean;
    desktop?: boolean;
    answers?: boolean[];
    now?: () => number;
    /** Whether this Mac gives the driver its grants while the press waits. */
    macGrants?: boolean;
  } = {},
) {
  const seen: Seen = { cards: [], posted: [], turnedOn: 0, grantWaits: 0 };
  let control = options.control ?? false;
  const answers = [...(options.answers ?? [])];
  const grants = new AssistGrants(options.now);
  let ids = 0;
  const host: AssistHost = {
    plugin: (id) =>
      id === "toy-engine"
        ? { name: "Toy Engine", bundled: options.bundled ?? true, apps: options.apps ?? ["com.example.toy"] }
        : null,
    desktopAvailable: async () => options.desktop ?? true,
    grantsReady: async () => {
      seen.grantWaits += 1;
      return options.macGrants ?? true;
    },
    computerControlOn: () => control,
    turnOnComputerControl: async () => {
      control = true;
      seen.turnedOn += 1;
    },
    gameChat: async () => "chat-of-game",
    ask: async (card) => {
      seen.cards.push(card);
      return answers.shift() ?? false;
    },
    post: async (threadId, project, text, messageId) => {
      seen.posted.push({ threadId, project, text, messageId });
    },
    grants,
    messageId: () => `msg_assist_${++ids}`,
  };
  return { host, seen, grants, control: () => control };
}

const assist = (host: AssistHost, binding: PluginBinding = BINDING) =>
  engineAssist(host, { pluginId: "toy-engine", binding, task: TASK, asked: true });

describe("game.engine.assist", () => {
  it("with computer control off, asks to turn it on; a yes turns it on and posts the task to the chat", async () => {
    const fake = fakeHost({ answers: [true] });
    assert.deepEqual(await assist(fake.host), { started: true });
    assert.deepEqual(fake.seen.cards, [{ kind: AssistCardKind.ComputerSetting }]);
    assert.equal(fake.seen.turnedOn, 1);
    assert.equal(fake.control(), true);
    assert.deepEqual(fake.seen.posted, [
      { threadId: "chat-1", project: "garden", text: `Toy Engine asks: ${TASK}`, messageId: "msg_assist_1" },
    ]);
    assert.deepEqual(fake.grants.live("chat-1"), {
      pluginId: "toy-engine",
      apps: new Set(["com.example.toy"]),
      messageId: "msg_assist_1",
      asked: true,
    });
  });

  it("waits for this Mac's grants after the setting, and starts nothing when the person doesn't give them", async () => {
    const given = fakeHost({ answers: [true] });
    assert.deepEqual(await assist(given.host), { started: true });
    assert.equal(given.seen.grantWaits, 1, "the task goes to the chat only once the driver can see and move");
    const withheld = fakeHost({ control: true, macGrants: false });
    assert.deepEqual(await assist(withheld.host), { started: false, reason: EngineAssistRefusal.Declined });
    assert.deepEqual(withheld.seen.posted, [], "nothing is handed to the chat to fail");
    assert.equal(withheld.grants.live("chat-1"), null);
    const declined = fakeHost({ answers: [false] });
    await assist(declined.host);
    assert.equal(declined.seen.grantWaits, 0, "no macOS prompt follows a no to the setting");
  });

  it("with computer control off, a no leaves it off and starts nothing", async () => {
    const fake = fakeHost({ answers: [false] });
    assert.deepEqual(await assist(fake.host), { started: false, reason: EngineAssistRefusal.Declined });
    assert.equal(fake.seen.turnedOn, 0);
    assert.deepEqual(fake.seen.posted, []);
    assert.equal(fake.grants.live("chat-1"), null);
  });

  it("with no desktop control here (Windows, or no driver), answers unavailable and asks nothing", async () => {
    const fake = fakeHost({ desktop: false, answers: [true] });
    assert.deepEqual(await assist(fake.host), { started: false, reason: EngineAssistRefusal.Unavailable });
    assert.deepEqual(fake.seen.cards, []);
    assert.deepEqual(fake.seen.posted, []);
  });

  it("for a plugin that came with Genex and control on, asks nothing more and posts the task", async () => {
    const fake = fakeHost({ control: true });
    assert.deepEqual(await assist(fake.host), { started: true });
    assert.deepEqual(fake.seen.cards, []);
    assert.equal(fake.seen.posted[0]?.text, `Toy Engine asks: ${TASK}`);
  });

  it("a call that names the game but no chat posts to the game's chat", async () => {
    const fake = fakeHost({ control: true });
    const { threadId: _chat, ...unbound } = BINDING;
    assert.deepEqual(await assist(fake.host, unbound), { started: true });
    assert.equal(fake.seen.posted[0]?.threadId, "chat-of-game");
    assert.ok(fake.grants.live("chat-of-game"));
  });

  it("for a plugin from a folder or the marketplace, a card shows the task first, every time", async () => {
    const declined = fakeHost({ bundled: false, control: true, answers: [false] });
    assert.deepEqual(await assist(declined.host), { started: false, reason: EngineAssistRefusal.Declined });
    assert.deepEqual(declined.seen.cards, [
      { kind: AssistCardKind.Task, pluginId: "toy-engine", pluginName: "Toy Engine", task: TASK },
    ]);
    assert.deepEqual(declined.seen.posted, []);

    const approved = fakeHost({ bundled: false, control: false, answers: [true, true] });
    assert.deepEqual(await assist(approved.host), { started: true });
    assert.deepEqual(
      approved.seen.cards.map((card) => card.kind),
      [AssistCardKind.Task, AssistCardKind.ComputerSetting],
      "the task is shown before computer control is offered",
    );
    assert.equal(approved.seen.posted.length, 1);
  });

  it("answers no-apps for an engine that declares no apps, and no-chat with no game, asking nothing", async () => {
    const noApps = fakeHost({ apps: [], answers: [true] });
    assert.deepEqual(await assist(noApps.host), { started: false, reason: EngineAssistRefusal.NoApps });
    const unknown = await engineAssist(noApps.host, {
      pluginId: "someone-else",
      binding: BINDING,
      task: TASK,
      asked: true,
    });
    assert.deepEqual(unknown, { started: false, reason: EngineAssistRefusal.NoApps });
    const noChat = fakeHost({ answers: [true] });
    const unbound = await engineAssist(noChat.host, {
      pluginId: "toy-engine",
      binding: undefined,
      task: TASK,
      asked: true,
    });
    assert.deepEqual(unbound, { started: false, reason: EngineAssistRefusal.NoChat });
    for (const fake of [noApps, noChat]) {
      assert.deepEqual(fake.seen.cards, []);
      assert.deepEqual(fake.seen.posted, []);
    }
  });

  it("a plugin that came with Genex may start its setup task from its own tool, unasked: no task card", async () => {
    const fake = fakeHost({ control: true });
    const answer = await engineAssist(fake.host, {
      pluginId: "toy-engine",
      binding: BINDING,
      task: TASK,
      asked: false,
    });
    assert.deepEqual(answer, { started: true });
    assert.deepEqual(fake.seen.cards, []);
    assert.equal(fake.seen.posted[0]?.text, `Toy Engine asks: ${TASK}`);
    // With computer control off, its own card still asks first.
    const off = fakeHost({ control: false, answers: [false] });
    const declined = await engineAssist(off.host, {
      pluginId: "toy-engine",
      binding: BINDING,
      task: TASK,
      asked: false,
    });
    assert.deepEqual(declined, { started: false, reason: EngineAssistRefusal.Declined });
    assert.deepEqual(off.seen.cards, [{ kind: AssistCardKind.ComputerSetting }]);
  });

  it("while the chat's assist is under way, an unasked one from the same plugin posts nothing and keeps the grant", async () => {
    const fake = fakeHost({ control: true });
    const unasked = { pluginId: "toy-engine", binding: BINDING, task: TASK, asked: false };
    assert.deepEqual(await engineAssist(fake.host, unasked), { started: true });
    const grant = fake.grants.live("chat-1");
    assert.equal(grant?.asked, false, "nobody pressed it, so its turn still asks its own cards");
    // The turn that answers it calls the plugin's tool again instead of clicking.
    assert.deepEqual(await engineAssist(fake.host, unasked), { started: false, reason: EngineAssistRefusal.InAssist });
    assert.equal(fake.seen.posted.length, 1, "nothing more was posted");
    assert.deepEqual(fake.grants.live("chat-1"), grant, "the grant is the first one's");
    // The person's own press still starts one.
    assert.deepEqual(await assist(fake.host), { started: true });
    assert.equal(fake.seen.posted.length, 2);
    assert.equal(fake.grants.live("chat-1")?.asked, true, "the press is the person's yes");
  });

  it("any other plugin's call the person didn't make is refused before any card", async () => {
    const fake = fakeHost({ bundled: false, control: true, answers: [true, true] });
    const answer = await engineAssist(fake.host, {
      pluginId: "toy-engine",
      binding: BINDING,
      task: TASK,
      asked: false,
    });
    assert.deepEqual(answer, { started: false, reason: EngineAssistRefusal.NotPerson });
    assert.deepEqual(fake.seen.cards, []);
    assert.deepEqual(fake.seen.posted, []);
  });

  it("says whether it can run here: a desktop with its driver, and apps the engine declares; asking nothing", async () => {
    assert.equal(await assistAvailable(fakeHost().host, "toy-engine"), true);
    assert.equal(
      await assistAvailable(fakeHost({ control: false }).host, "toy-engine"),
      true,
      "the setting is offered",
    );
    assert.equal(await assistAvailable(fakeHost({ desktop: false }).host, "toy-engine"), false, "no driver here");
    assert.equal(await assistAvailable(fakeHost({ apps: [] }).host, "toy-engine"), false, "nothing it may click");
    assert.equal(await assistAvailable(fakeHost().host, "someone-else"), false, "not an enabled plugin");
    const fake = fakeHost({ answers: [true] });
    await assistAvailable(fake.host, "toy-engine");
    assert.deepEqual(fake.seen.cards, []);
    assert.deepEqual(fake.seen.posted, []);
    assert.equal(fake.control(), false);
  });
});

describe("an assist's grant", () => {
  const grant = { pluginId: "toy-engine", apps: ["com.example.toy"], messageId: "msg_a" };

  it("lasts until the turn that answers its message ends, not another turn's end", () => {
    const grants = new AssistGrants(() => 0);
    grants.record("chat-1", grant);
    grants.turnEnded("chat-1", "msg_earlier");
    assert.ok(grants.live("chat-1"), "an earlier turn ending leaves it");
    assert.equal(grants.live("chat-2"), null, "another chat never holds it");
    grants.turnEnded("chat-1", "msg_a");
    assert.equal(grants.live("chat-1"), null);
  });

  it("tells its listeners when its turn ends, once, so Genex comes back to the front", () => {
    const grants = new AssistGrants(() => 0);
    const ended: string[] = [];
    const stop = grants.onEnded((threadId) => ended.push(threadId));
    grants.record("chat-1", grant);
    grants.turnEnded("chat-1", "msg_earlier");
    assert.deepEqual(ended, [], "another turn's end is not its end");
    grants.turnEnded("chat-1", "msg_a");
    grants.turnEnded("chat-1", "msg_a");
    assert.deepEqual(ended, ["chat-1"]);
    stop();
    grants.record("chat-1", grant);
    grants.turnEnded("chat-1", "msg_a");
    assert.deepEqual(ended, ["chat-1"], "a listener that stopped hears nothing more");
  });

  it("ends with the turn its message was steered into", () => {
    const grants = new AssistGrants(() => 0);
    grants.record("chat-1", grant);
    grants.steered("chat-1", "msg_running", "msg_other");
    grants.turnEnded("chat-1", "msg_running");
    assert.ok(grants.live("chat-1"), "a turn that took another message is not its turn");
    grants.steered("chat-1", "msg_running", "msg_a");
    grants.turnEnded("chat-1", "msg_running");
    assert.equal(grants.live("chat-1"), null);
  });

  it("follows its message into the turn the log says it reached, by interrupt too, never into a lead's run", () => {
    const delivered = (into: string, how: SteerDelivery, messageId = "msg_a") =>
      customEventData(CustomEvent.CoordinatorMessageDelivered, { messageId, into, how });
    const grants = new AssistGrants(() => 0);
    grants.record("chat-1", grant);
    followAssistDeliveries(grants, "chat-1", [delivered("run_7", SteerDelivery.Lead)]);
    assert.equal(grants.forTurn("chat-1", "run_7"), null, "a build's lead never clicks for the person");
    followAssistDeliveries(grants, "chat-1", [delivered("msg_running", SteerDelivery.Interrupt, "msg_other")]);
    assert.equal(grants.forTurn("chat-1", "msg_running"), null, "another message's delivery moves nothing");
    followAssistDeliveries(grants, "chat-1", [delivered("msg_running", SteerDelivery.Interrupt)]);
    assert.ok(grants.forTurn("chat-1", "msg_running"), "the turn resumed with the message in front holds it");
  });

  it("ends when the queue says its message was answered or taken back, even by a turn that never clicked", () => {
    const handled = (messageId: string) => customEventData(CustomEvent.CoordinatorMessageHandled, { messageId });
    const grants = new AssistGrants(() => 0);
    grants.record("chat-1", grant);
    followAssistDeliveries(grants, "chat-1", [handled("msg_other")]);
    assert.ok(grants.live("chat-1"), "another message answered leaves it");
    followAssistDeliveries(grants, "chat-1", [handled("msg_a")]);
    assert.equal(grants.live("chat-1"), null, "its turn ended, failed or not");
    grants.record("chat-1", grant);
    followAssistDeliveries(grants, "chat-1", [
      customEventData(CustomEvent.CoordinatorMessageRemoved, { messageId: "msg_a" }),
    ]);
    assert.equal(grants.live("chat-1"), null, "taken back before it was answered");
  });

  it("is under way for its plugin in its game's chat until its turn ends", async () => {
    const fake = fakeHost();
    const project = { project: "toy", directory: "/games/toy" };
    assert.equal(await assistUnderWay(fake.host, "toy-engine", project), false, "nothing asked yet");
    fake.host.grants.record("chat-of-game", grant);
    assert.equal(await assistUnderWay(fake.host, "toy-engine", project), true, "found through the game's chat");
    assert.equal(await assistUnderWay(fake.host, "someone-else", project), false, "another plugin's never");
    assert.equal(await assistUnderWay(fake.host, "toy-engine", { ...project, threadId: "chat-2" }), false);
    fake.host.grants.turnEnded("chat-of-game", "msg_a");
    assert.equal(await assistUnderWay(fake.host, "toy-engine", project), false);
  });

  it("drives the engine's app only in the turn that answers its message, never in a build turn running beside it", () => {
    const grants = new AssistGrants(() => 0);
    grants.record("chat-1", grant);
    assert.equal(grants.forTurn("chat-1", "msg_running"), null, "a turn still building is refused Studio");
    assert.ok(grants.forTurn("chat-1", "msg_a"), "the turn its message started");
    grants.steered("chat-1", "msg_running", "msg_a");
    assert.ok(grants.forTurn("chat-1", "msg_running"), "the running turn once its message was steered into it");
    assert.equal(grants.forTurn("chat-2", "msg_a"), null, "another chat never holds it");
    assert.ok(grants.forTurn("chat-1", undefined), "a session the host can't follow gets it within its limit");
  });

  it("never outlasts its limit, whatever the host could not see", () => {
    let now = 1_000;
    const grants = new AssistGrants(() => now);
    grants.record("chat-1", grant);
    now += ASSIST_GRANT_MAX_MS - 1;
    assert.ok(grants.live("chat-1"));
    now += 1;
    assert.equal(grants.live("chat-1"), null);
  });

  it("survives Genex quitting before its turn ends: the turn that answers its message after the restart holds it", async () => {
    const file = path.join(await tmpDir("assist-grants"), "assist-grants.json");
    let now = 1_000;
    const before = new AssistGrants(() => now, file);
    before.record("chat-1", { ...grant, asked: true });
    before.steered("chat-1", "msg_running", "msg_a");
    const after = new AssistGrants(() => now, file);
    assert.deepEqual(after.forTurn("chat-1", "msg_a"), { ...grant, apps: new Set(grant.apps), asked: true });
    assert.ok(after.forTurn("chat-1", "msg_running"), "the turn its message was steered into, too");
    assert.equal(after.forTurn("chat-1", "msg_build"), null, "still never a build turn beside it");
    now += ASSIST_GRANT_MAX_MS;
    assert.equal(new AssistGrants(() => now, file).live("chat-1"), null, "its limit counts from the press");
    now = 1_000;
    after.turnEnded("chat-1", "msg_a");
    assert.equal(new AssistGrants(() => now, file).live("chat-1"), null, "an ended grant stays ended");
  });

  it("starts with none from a grants file it can't read, and never takes a malformed one", async () => {
    const dir = await tmpDir("assist-grants-hostile");
    const rows: Array<[string, string]> = [
      ["not JSON", "{"],
      ["an array", "[]"],
      ["a grant with no apps", JSON.stringify({ "chat-1": { ...grant, apps: "com.example.toy", at: 1_000 } })],
      ["a grant with no time", JSON.stringify({ "chat-1": { ...grant } })],
      ["a grant with no message", JSON.stringify({ "chat-1": { pluginId: "toy-engine", apps: [], at: 1_000 } })],
      ["an app that is not text", JSON.stringify({ "chat-1": { ...grant, apps: [7], at: 1_000 } })],
    ];
    for (const [name, text] of rows) {
      const file = path.join(dir, `${name.replaceAll(" ", "-")}.json`);
      await writeFile(file, text);
      const grants = new AssistGrants(() => 1_000, file);
      assert.equal(grants.live("chat-1"), null, name);
      assert.equal(await readFile(file, "utf8"), text, `${name}: reading changes nothing`);
    }
    const missing = new AssistGrants(() => 1_000, path.join(dir, "absent", "assist-grants.json"));
    assert.equal(missing.live("chat-1"), null, "no file is no grant");
  });
});

/** A driver that answers pictures and records clicks; nothing here clicks. */
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

/** No arguments, for each tool below. */
const NO_ARGS = { type: "object", properties: {} };
/** The Do it for me the toy's backend answers, declared by this file's copy of the toy. */
const ASSIST_DECLARATIONS = {
  actions: [{ name: "do-it-for-me", label: "Do it for me" }],
  tools: [
    {
      name: "publish-toy",
      description: "Publish the toy game: the chat's agent clicks it in the toy editor.",
      parameters: NO_ARGS,
      confirmation: "Publish the toy game? The chat's agent clicks File › Publish in the toy editor.",
    },
    { name: "assist-quietly", audience: "harness", description: "A step of Genex's own.", parameters: NO_ARGS },
    { name: "assist-unasked", description: "A tool with no card of the toy's own.", parameters: NO_ARGS },
    { name: "can-assist", audience: "harness", description: "Whether Do it for me can run here.", parameters: NO_ARGS },
  ],
};

/** A copy of the toy engine plugin that declares its Do it for me action and tools. */
async function toyWithAssist(): Promise<string> {
  const dir = path.join(await realpath(await tmpDir("toy-assist-")), "toy-engine-plugin");
  await cp(TOY_PLUGIN, dir, { recursive: true });
  const file = path.join(dir, "plugin.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as { actions: unknown[]; tools: unknown[] };
  manifest.actions.push(...ASSIST_DECLARATIONS.actions);
  manifest.tools.push(...ASSIST_DECLARATIONS.tools);
  await writeFile(file, JSON.stringify(manifest, null, 2));
  return dir;
}

describe("the pages an assist may open in the person's browser", () => {
  const kiln = {
    enabled: true,
    removed: false,
    manifest: {
      id: "kiln",
      engine: {
        id: "kiln",
        label: "Kiln",
        projectFiles: [".kiln"],
        fact: "kiln",
        projectInFolder: false,
        pages: ["create.kiln.dev"],
      },
    },
  };
  const other = {
    ...kiln,
    manifest: { id: "other", engine: { ...kiln.manifest.engine, id: "other", pages: ["create.other.dev"] } },
  };
  const plugins = [kiln, other];
  const grant = { pluginId: "kiln" };

  it("lets an assist reach the person's browser only when its engine opens pages", () => {
    assert.equal(assistOpensPages(grant, plugins), true);
    const bare = { ...kiln, manifest: { ...kiln.manifest, engine: { ...kiln.manifest.engine, pages: [] } } };
    assert.equal(assistOpensPages(grant, [bare]), false);
    assert.equal(assistOpensPages(grant, [{ ...kiln, enabled: false }]), false, "a disabled engine opens none");
  });

  it("opens a page of a host the assist's own engine declares, in the turn that holds its grant", () => {
    assert.equal(assistPageRefusal(new URL("https://create.kiln.dev/dashboard/1/icon"), grant, plugins), null);
  });

  const refused: Array<[string, string, { pluginId: string } | null, RegExp]> = [
    ["a turn holding no grant", "https://create.kiln.dev/", null, /only in the turn that answers/],
    ["another engine's page", "https://create.other.dev/", grant, /create\.kiln\.dev/],
    ["a host that only ends like it", "https://evilcreate.kiln.dev/", grant, /create\.kiln\.dev/],
    ["a host that only starts like it", "https://create.kiln.dev.evil.example/", grant, /create\.kiln\.dev/],
    ["a page of the web at large", "https://example.com/", grant, /create\.kiln\.dev/],
  ];
  for (const [name, address, held, why] of refused) {
    it(`refuses ${name}`, () => {
      assert.match(String(assistPageRefusal(new URL(address), held, plugins)), why);
    });
  }

  it("refuses every page for a disabled engine, or one that declares none", () => {
    const off = { ...kiln, enabled: false };
    assert.match(String(assistPageRefusal(new URL("https://create.kiln.dev/"), grant, [off])), /declares no pages/);
    const bare = { ...kiln, manifest: { id: "kiln", engine: { ...kiln.manifest.engine, pages: undefined } } };
    assert.match(String(assistPageRefusal(new URL("https://create.kiln.dev/"), grant, [bare])), /declares no pages/);
  });
});

describe("the apps engines declare", () => {
  type Apps = { mac?: string[]; windows?: string[] };
  const plugin = (enabled: boolean, engine: { apps?: Apps; playerApps?: Apps }) => ({
    enabled,
    removed: false,
    manifest: {
      engine: { id: "kiln", label: "Kiln", projectFiles: [".kiln"], fact: "kiln", projectInFolder: false, ...engine },
    },
  });

  it("names the apps every enabled engine's games are played in, apart from its editors", () => {
    const plugins = [
      plugin(true, { apps: { mac: ["com.kiln.Editor"] }, playerApps: { mac: ["com.kiln.Player"] } }),
      plugin(false, { playerApps: { mac: ["com.off.Player"] } }),
    ];
    assert.deepEqual([...declaredPlayerApps(plugins, "darwin")], ["com.kiln.Player"]);
    assert.deepEqual([...declaredEngineApps(plugins, "darwin")], ["com.kiln.Editor"]);
  });

  it("names them on Windows by executable, as the desktop does, whatever case the manifest wrote", () => {
    const plugins = [
      plugin(true, {
        apps: { mac: ["com.kiln.Editor"], windows: ["KilnEditor.exe"] },
        playerApps: { mac: ["com.kiln.Player"], windows: ["KilnPlayerBeta.exe"] },
      }),
    ];
    assert.deepEqual([...declaredEngineApps(plugins, "win32")], ["kilneditor.exe"]);
    assert.deepEqual([...declaredPlayerApps(plugins, "win32")], ["kilnplayerbeta.exe"]);
    assert.deepEqual(
      engineAppIds({ mac: ["com.kiln.Editor"] }, "win32"),
      [],
      "a Mac-only engine declares nothing here",
    );
  });

  it("Unreal's Do it for me may drive Epic's launcher, only in the turn answering its task, never Unreal's editor", async () => {
    const manifest = validateManifest(JSON.parse(await readFile("src/plugins/unreal/plugin.json", "utf8")));
    const unreal = [{ enabled: true, removed: false, manifest }];
    const declared = declaredEngineApps(unreal, "win32");
    assert.deepEqual([...declared], ["epicgameslauncher.exe", "epicwebhelper.exe"]);
    assert.deepEqual([...declaredEngineApps(unreal, "darwin")], ["com.epicgames.EpicGamesLauncher"]);
    const launcher: DesktopApp = { name: "Epic Games Launcher", bundleId: "epicgameslauncher.exe", pid: 7 };
    assert.match(String(engineAppRefusal(launcher, { declared, granted: null })), /engine/, "outside its assist");
    assert.equal(engineAppRefusal(launcher, { declared, granted: declared }), null, "the turn answering its task");
    const editor: DesktopApp = { name: "Unreal Editor", bundleId: "unrealeditor.exe", pid: 8 };
    assert.match(String(engineAppRefusal(editor, { declared, granted: declared })), /not one of the apps/);
  });
});

describe("the toy engine's Do it for me, through a real core", () => {
  let lite: CoreLite;
  let binding: PluginBinding;
  let threadId: string;
  /** The answer the next cards get. */
  let approve = true;
  /** The turns posted to a chat. */
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
        const yes = approve;
        void Promise.resolve().then(() => lite.core.resolveConsent(payload.consentId, yes));
      },
    });
    const { core } = lite;
    await core.plugins.installLocal(await toyWithAssist(), PluginSourceKind.Local, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    const dir = (await core.games.scaffold("garden")).dir;
    threadId = await core.threadForGame("garden");
    binding = { project: "garden", directory: dir, threadId };
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

  /** The consent cards the chat shows since `from`, as [source, state]. */
  const cardsSince = async (from: number): Promise<Array<[string, string]>> => {
    const events = await lite.core.store.listEvents(threadId);
    const all = events
      .filter((event) => event.data.type === "custom" && event.data.event_type === "plugin_consent")
      .map((event) => {
        const payload = (event.data as { payload: { pluginId: string; state: string } }).payload;
        return [payload.pluginId, payload.state] as [string, string];
      });
    return all.slice(from);
  };

  it("the toy's action, with computer control off: the task card, then the setting card; approving turns it on and posts the task", async () => {
    const { core } = lite;
    assert.equal(core.settings.computerControl, false);
    const answer = await core.plugins.action(TOY_PLUGIN_ID, "do-it-for-me", {}, binding);
    assert.deepEqual(answer, { started: true });
    assert.deepEqual(await cardsSince(0), [
      [TOY_PLUGIN_ID, "pending"],
      [TOY_PLUGIN_ID, "approved"],
      [StudioConsentSource.ComputerSetting, "pending"],
      [StudioConsentSource.ComputerSetting, "approved"],
    ]);
    assert.equal(core.settings.computerControl, true, "Settings → Permissions → computer control is on");
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.text, "Toy Engine asks: Turn on the toy editor's server: Toy › Settings › Server");
    assert.equal(posted[0]?.thread, threadId, "the task goes to the game's chat");
    assert.deepEqual(assistGrants(core).live(threadId)?.apps, new Set(["com.example.toy"]));
    assert.equal(assistGrants(core).live(threadId)?.messageId, posted[0]?.clientId);
  });

  it("the setting card names computer control and says it is for every chat", async () => {
    const events = await lite.core.store.listEvents(threadId);
    const setting = events
      .map(
        (event) =>
          (event.data as { payload?: { pluginId?: string; pluginName?: string; prompt?: string; note?: string } })
            .payload,
      )
      .find((payload) => payload?.pluginId === StudioConsentSource.ComputerSetting);
    assert.equal(setting?.pluginName, "Computer control");
    // Flipped: the one-line question leaves "every chat" to the line under it.
    assert.equal(setting?.prompt, "Turn on computer control?");
    assert.match(String(setting?.note), /any chat/);
  });

  it("a confirmed tool whose card the person approved starts the task; declined, nothing is posted", async () => {
    const { core } = lite;
    const before = posted.length;
    approve = true;
    const started = await core.plugins.tool(`${TOY_PLUGIN_ID}__publish-toy`, {}, binding);
    assert.deepEqual(started, { started: true });
    assert.equal(posted.length, before + 1);
    assert.equal(posted.at(-1)?.text, "Toy Engine asks: Publish the toy game: File › Publish");

    approve = false;
    await assert.rejects(
      core.plugins.tool(`${TOY_PLUGIN_ID}__publish-toy`, {}, binding),
      /declined|did not allow|not allowed/i,
    );
    assert.equal(posted.length, before + 1);
    approve = true;
  });

  it("the toy learns from the host whether Do it for me can run here, asking nothing", async () => {
    const { core } = lite;
    const cardsBefore = (await cardsSince(0)).length;
    const can = await core.plugins.tool(
      `${TOY_PLUGIN_ID}__can-assist`,
      {},
      binding,
      undefined,
      PluginToolAudience.Harness,
    );
    assert.equal(can, true, "a driver is found and the toy declares its editor");
    assert.equal((await cardsSince(cardsBefore)).length, 0);
  });

  it("a harness step, a hook and an agent tool without its own card are not the person: nothing happens", async () => {
    const { core } = lite;
    const before = posted.length;
    const cardsBefore = (await cardsSince(0)).length;
    const quiet = await core.plugins.tool(
      `${TOY_PLUGIN_ID}__assist-quietly`,
      {},
      binding,
      undefined,
      PluginToolAudience.Harness,
    );
    assert.deepEqual(quiet, { started: false, reason: EngineAssistRefusal.NotPerson });
    const hooked = await core.plugins.tool(
      `${TOY_PLUGIN_ID}__assist-quietly`,
      {},
      { ...binding, hook: { on: HookEvent.TurnStart } },
      undefined,
      PluginToolAudience.Harness,
    );
    assert.deepEqual(hooked, { started: false, reason: EngineAssistRefusal.NotPerson });
    assert.deepEqual((await cardsSince(cardsBefore)).length, 0, "no card asked for either");
    // A local plugin's agent tool asks Genex's own card; approving it is not approving the task.
    const unasked = await core.plugins.tool(`${TOY_PLUGIN_ID}__assist-unasked`, {}, binding);
    assert.deepEqual(unasked, { started: false, reason: EngineAssistRefusal.NotPerson });
    assert.equal(posted.length, before, "nothing was posted");
  });
});

describe("a plugin that came with Genex starts its setup from its own tool, through a real core", () => {
  let lite: CoreLite;
  let binding: PluginBinding;
  let threadId: string;
  const posted: string[] = [];

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
        if (payload.state === "pending")
          void Promise.resolve().then(() => lite.core.resolveConsent(payload.consentId, true));
      },
    });
    const { core } = lite;
    await core.plugins.installLocal(await toyWithAssist(), PluginSourceKind.Bundled, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    const dir = (await core.games.scaffold("orchard")).dir;
    threadId = await core.threadForGame("orchard");
    binding = { project: "orchard", directory: dir, threadId };
    core.sendUserMessage = async (text) => {
      posted.push(text);
    };
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("an agent tool with no card of its own starts the task; only computer control's own card asks", async () => {
    const { core } = lite;
    const answer = await core.plugins.tool(`${TOY_PLUGIN_ID}__assist-unasked`, {}, binding);
    assert.deepEqual(answer, { started: true });
    const cards = (await core.store.listEvents(threadId))
      .filter((event) => event.data.type === "custom" && event.data.event_type === "plugin_consent")
      .map((event) => (event.data as { payload: { pluginId: string; state: string } }).payload.pluginId);
    assert.deepEqual(cards, [StudioConsentSource.ComputerSetting, StudioConsentSource.ComputerSetting]);
    assert.deepEqual(posted, ["Toy Engine asks: Turn on the toy editor's server: Toy › Settings › Server"]);
  });

  it("a Genex moment's step is still never one: nothing happens", async () => {
    const { core } = lite;
    const hooked = await core.plugins.tool(
      `${TOY_PLUGIN_ID}__assist-quietly`,
      {},
      { ...binding, hook: { on: HookEvent.TurnStart } },
      undefined,
      PluginToolAudience.Harness,
    );
    assert.deepEqual(hooked, { started: false, reason: EngineAssistRefusal.NotPerson });
    assert.equal(posted.length, 1);
  });
});

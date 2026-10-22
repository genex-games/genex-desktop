/**
 * The steps card an engine plugin offers in a game's chat ("Steps for Unreal"): the newest offer in
 * the chat shows until the person hides it, and a later offer (the agent's show-steps) shows it
 * again. Its rows come from the plugin, read live, so anything malformed is dropped, not drawn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import {
  finishedSays,
  parseSteps,
  runStep,
  type StepsCard,
  stepsCardFor,
  stepsOffer,
  stepsShown,
  stuckSays,
  watchSteps,
} from "../../src/renderer/chat/engine-steps.ts";
import type { PollTimers } from "../../src/renderer/status-poll.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const offer = (id: number, payload: Record<string, unknown> = { pluginId: "unreal", project: "valley" }) =>
  event(id, { type: "custom", event_type: "engine_steps", payload });
const said = (id: number) =>
  event(id, { type: "messages", messages: [{ role: "assistant", content: "hi" }] } as EventData);

describe("the steps card's offer", () => {
  it("is the newest offer in the chat, by the plugin and game it names", () => {
    assert.equal(stepsOffer([said(1)]), null);
    assert.deepEqual(stepsOffer([offer(1), said(2), offer(3)]), {
      id: "000003",
      pluginId: "unreal",
      project: "valley",
    });
    assert.equal(stepsOffer([offer(1, { project: "valley" })]), null, "no plugin: nothing to ask");
  });

  it("shows until Hide, and a later offer shows again", () => {
    const first = stepsOffer([offer(1)]);
    assert.equal(stepsShown(first, null), true);
    assert.equal(stepsShown(first, "000001"), false, "Hide on this offer");
    const again = stepsOffer([offer(1), offer(5)]);
    assert.equal(stepsShown(again, "000001"), true, "the agent showed it again");
    assert.equal(stepsShown(null, null), false);
  });
});

describe("the plugin's steps", () => {
  const good = {
    title: "Steps for Unreal",
    intro: "Two steps from you make the agent's Unreal work better.",
    open: true,
    steps: [
      { id: "set-up", label: "Unreal 5.8 is set up for Valley", detail: "", done: true },
      {
        id: "install-xcode",
        label: "Install Xcode",
        detail: "Recommended.",
        done: false,
        action: { name: "get-xcode", args: { step: "install" }, label: "Get Xcode" },
      },
      { id: "select-xcode", label: "Use Xcode", detail: "Run this:", done: false, command: "sudo xcode-select -s X" },
    ],
  };

  it("keeps a well-formed answer as it is", () => {
    assert.deepEqual(parseSteps(good), good);
  });

  it("drops what isn't a step, and a card with no open step is not shown", () => {
    const messy = {
      ...good,
      steps: [
        ...good.steps,
        null,
        { id: 7 },
        { id: "x", label: "L", detail: "", done: "no" },
        { ...good.steps[1], action: { name: 3 } },
      ],
    };
    const parsed = parseSteps(messy);
    assert.equal(parsed?.steps.length, 4);
    assert.equal(parsed?.steps[3]?.action, undefined, "a malformed button is dropped, the row kept");
    assert.equal(parseSteps({ ...good, open: false })?.open, false);
    for (const bad of [null, "steps", [], { title: 1 }, { ...good, steps: "x" }]) assert.equal(parseSteps(bad), null);
  });

  it("keeps a step that needs the person, the card's own button and what the agent hears when it's done", () => {
    const setup = {
      title: "Unity setup",
      intro: "Two steps before the agent can build in Unity.",
      open: true,
      steps: [
        { id: "sign-in", label: "Sign in to Unity", detail: "Only you type your password.", done: false, you: true },
        { id: "install", label: "Install Unity 6", detail: "", done: false, you: "yes", working: true },
      ],
      primary: { name: "set-up", args: {}, label: "Do it for me" },
      doneSays: "Unity 6 is ready.",
    };
    const parsed = parseSteps(setup);
    assert.equal(parsed?.steps[0]?.you, true);
    assert.equal(parsed?.steps[1]?.you, undefined, "only true marks a step as the person's");
    assert.equal(parsed?.steps[1]?.working, true, "a step Genex is doing now");
    assert.equal(parsed?.steps[0]?.working, undefined);
    assert.deepEqual(parsed?.primary, setup.primary);
    assert.equal(parsed?.doneSays, "Unity 6 is ready.");
    const skip = { name: "skip", args: {}, label: "Don't use Unity" };
    assert.deepEqual(
      parseSteps({ ...setup, secondary: skip })?.secondary,
      skip,
      "the plugin's own way out, in Hide's place",
    );
    const plain = parseSteps({ ...setup, primary: { name: 1 }, doneSays: 5, secondary: { label: 2 } });
    assert.equal(plain?.secondary, undefined);
    assert.equal(plain?.primary, undefined, "a malformed card button is dropped");
    assert.equal(plain?.doneSays, undefined);
  });
});

describe("a setup card that finishes", () => {
  const card = (open: boolean, doneSays?: string) =>
    parseSteps({ title: "Unity setup", intro: "", open, steps: [], ...(doneSays ? { doneSays } : {}) });

  it("tells the agent once, when the card it showed has nothing left open", () => {
    assert.equal(finishedSays(card(true), card(false, "Unity 6 is ready.")), "Unity 6 is ready.");
    assert.equal(finishedSays(card(true), card(true, "Unity 6 is ready.")), null, "still a step open");
    assert.equal(finishedSays(card(false), card(false, "Unity 6 is ready.")), null, "it was never shown open");
    assert.equal(finishedSays(null, card(false, "Unity 6 is ready.")), null, "nothing was read before");
    assert.equal(finishedSays(card(true), card(false)), null, "a plugin that says nothing: the chat stays quiet");
    assert.equal(finishedSays(card(true), null), null, "a failed read is no finish");
  });
});

describe("a setup card whose step stops", () => {
  const card = (stuck?: string) =>
    parseSteps({ title: "Unity setup", intro: "", open: true, steps: [], ...(stuck ? { stuckSays: stuck } : {}) });

  it("tells the agent once what stopped, so it can finish the step another way", () => {
    assert.equal(parseSteps({ title: "T", intro: "", open: true, steps: [], stuckSays: 3 })?.stuckSays, undefined);
    assert.equal(stuckSays(card(), card("Unity's install stopped.")), "Unity's install stopped.");
    assert.equal(
      stuckSays(null, card("Unity's install stopped.")),
      null,
      "a stop from before the chat opened was told then",
    );
    assert.equal(stuckSays(card("Unity's install stopped."), card("Unity's install stopped.")), null, "said once");
    assert.equal(
      stuckSays(card("Hub stopped."), card("Unity's install stopped.")),
      "Unity's install stopped.",
      "a new stop",
    );
    assert.equal(stuckSays(card("Unity's install stopped."), card()), null, "nothing stopped now");
    assert.equal(stuckSays(card(), null), null);
  });
});

describe("a step's button", () => {
  const offer = { id: "000001", pluginId: "toy-engine", project: "valley" };
  const confirmed = { name: "do-it-for-me", label: "Do it for me", confirmation: "Let the chat click it for you?" };
  const plain = { name: "open-editor", label: "Open the editor" };
  const plugin = { manifest: { id: "toy-engine", actions: [confirmed, plain] } } as unknown as PluginInfo;
  const row = (action: { name: string; label: string }) => ({
    id: "switch",
    label: "Turn on the server",
    detail: "",
    done: false,
    action: { name: action.name, args: { step: "switch" }, label: action.label },
  });

  /** Main's two channels as the card meets them: a confirmed action runs only with its review's ticket. */
  function studioWith(reached: string[]) {
    return {
      pluginReview: async (id: string, name: string) => {
        reached.push(`review ${id} ${name}`);
        return { ticket: "ticket-1" };
      },
      pluginAction: async (id: string, name: string, args: unknown, project: string, ticket?: string) => {
        const needsTicket = name === confirmed.name;
        if (needsTicket && ticket !== "ticket-1") throw new Error("Review this action in Studio before approving");
        reached.push(`action ${id} ${name} ${JSON.stringify(args)} ${project}${ticket ? ` ${ticket}` : ""}`);
        return { started: true };
      },
    };
  }

  it("runs an action that declares a confirmation through its review, then the action with the ticket", async () => {
    const reached: string[] = [];
    Object.assign(globalThis, { window: { studio: studioWith(reached) } });
    assert.deepEqual(await runStep(plugin, offer, row(confirmed)), { started: true });
    assert.deepEqual(reached, [
      "review toy-engine do-it-for-me",
      'action toy-engine do-it-for-me {"step":"switch"} valley ticket-1',
    ]);
  });

  it("runs an action with no confirmation straight away, and nothing for a row without a button", async () => {
    const reached: string[] = [];
    Object.assign(globalThis, { window: { studio: studioWith(reached) } });
    await runStep(plugin, offer, row(plain));
    await runStep(plugin, offer, { id: "x", label: "Done", detail: "", done: true });
    assert.deepEqual(reached, ['action toy-engine open-editor {"step":"switch"} valley']);
  });

  it("refuses a button whose plugin is not installed, calling nothing", async () => {
    const reached: string[] = [];
    Object.assign(globalThis, { window: { studio: studioWith(reached) } });
    await assert.rejects(runStep(null, offer, row(confirmed)), /isn't installed/);
    assert.deepEqual(reached, []);
  });
});

/** Intervals that run only when the test ticks them. */
function manualIntervals(): PollTimers & { tick(): void; running(): number } {
  const runs = new Map<number, () => void>();
  let next = 0;
  return {
    setInterval: (run) => {
      runs.set(++next, run);
      return next;
    },
    clearInterval: (handle) => void runs.delete(handle as number),
    tick: () => {
      for (const run of [...runs.values()]) run();
    },
    running: () => runs.size,
  };
}

/** A plugin whose every `steps` answer the test gives by hand, in the order it was asked. */
function handAnswered() {
  const waiting: Array<(card: StepsCard | null) => void> = [];
  return {
    ask: () => new Promise<StepsCard | null>((resolve) => waiting.push(resolve)),
    asked: () => waiting.length,
    answer: async (index: number, card: StepsCard | null) => {
      waiting[index]?.(card);
      await settle();
    },
  };
}

describe("the setup card's asking", () => {
  const card = (open: boolean, doneSays?: string) =>
    parseSteps({ title: "Unity setup", intro: "", open, steps: [], ...(doneSays ? { doneSays } : {}) });

  it("asks one at a time, and stops asking once nothing is left open, telling the agent once", async () => {
    const timers = manualIntervals();
    const plugin = handAnswered();
    const shown: Array<boolean | null> = [];
    const told: string[] = [];
    watchSteps({
      ask: plugin.ask,
      onCard: (next) => shown.push(next?.open ?? null),
      onFinished: (says) => told.push(says),
      everyMs: 5_000,
      timers,
    });
    assert.equal(plugin.asked(), 1, "asked as the card shows");
    timers.tick();
    assert.equal(plugin.asked(), 1, "never asked again while an answer is out");
    await plugin.answer(0, card(true));
    timers.tick();
    assert.equal(plugin.asked(), 2);
    await plugin.answer(1, card(false, "Unity 6 is ready."));
    for (let i = 0; i < 3; i++) timers.tick();
    assert.equal(plugin.asked(), 2, "a card with nothing open is not asked again");
    assert.equal(timers.running(), 0);
    assert.deepEqual(shown, [true, false]);
    assert.deepEqual(told, ["Unity 6 is ready."]);
  });

  it("keeps asking after a failed read, which shows nothing", async () => {
    const timers = manualIntervals();
    const plugin = handAnswered();
    const shown: Array<boolean | null> = [];
    const onCard = (next: StepsCard | null) => shown.push(next?.open ?? null);
    watchSteps({ ask: plugin.ask, onCard, onFinished: () => {}, everyMs: 5_000, timers });
    await plugin.answer(0, null);
    timers.tick();
    assert.equal(plugin.asked(), 2);
    assert.deepEqual(shown, [null]);
  });

  it("drops an answer that lands after the card stopped, and asks nothing more", async () => {
    const timers = manualIntervals();
    const plugin = handAnswered();
    const shown: unknown[] = [];
    const told: string[] = [];
    const stop = watchSteps({
      ask: plugin.ask,
      onCard: (next) => shown.push(next),
      onFinished: (says) => told.push(says),
      everyMs: 5_000,
      timers,
    });
    stop();
    await plugin.answer(0, card(false, "Unity 6 is ready."));
    timers.tick();
    assert.equal(plugin.asked(), 1);
    assert.deepEqual(shown, []);
    assert.deepEqual(told, []);
  });

  it("shows a card only in the chat of the game and engine it was read for", () => {
    const valley = { id: "000003", pluginId: "unity", project: "valley" };
    const read = card(true);
    const kept = { offer: valley, card: read };
    assert.equal(stepsCardFor(kept, valley), read);
    assert.equal(stepsCardFor(kept, { ...valley, id: "000009" }), read, "offered again in the same game");
    assert.equal(stepsCardFor(kept, { ...valley, project: "harbor" }), null, "another game's chat");
    assert.equal(stepsCardFor(kept, { ...valley, pluginId: "unreal" }), null, "another engine's card");
    assert.equal(stepsCardFor(null, valley), null);
    assert.equal(stepsCardFor(kept, null), null);
  });
});

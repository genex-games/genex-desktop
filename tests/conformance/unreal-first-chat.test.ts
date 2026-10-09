/**
 * A new game's first Unreal chat. The turn that makes the game's Unreal project ends while Unreal
 * still opens it (a first start prepares shaders for minutes); a chat once went quiet there for
 * most of an hour, the builder's "I'll start as soon as the editor is ready" kept by nobody. Now
 * the chat waits on Genex's `health` moment, which the game's plugins answer: it says once why it
 * waits, and the same session goes on by itself once nothing is pending. Before the engine
 * question, each kind on offer carries its plugin's readiness (`kinds[].ready`, `note`), so Unreal
 * is offered honestly; the harness names no plugin's tool for either.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { servedFactsOf } from "../../src/harness-seed/loop/folder-facts.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { HookEvent, READY_POLL_MS, READY_WAIT_MS, READY_WORDS } from "../../src/harness-seed/loop/hooks.ts";
import { factsReadyPrompt } from "../../src/harness-seed/loop/project-prompts.ts";
import { EngineReadiness } from "../../src/plugins/unreal/editor-wait.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const CLAUDE = "claude-code";
const NAME = "lantern-run";
const UPROJECT = "/Users/me/AI Games/lantern-run/unreal/Lantern.uproject";
const TURN = {
  threadId: "thread-1",
  turnId: "turn-1",
  text: "Unreal Engine",
  engine: CLAUDE,
  engineLabel: "Claude Code",
};
const FIRST = "Made the Unreal project; next I'll lay out the first street.";
const AFTER = "Laid out the first street in the editor.";
const OPENING = "Unreal is opening Lantern; a first start can take several minutes.";
const NOT_OPENED = "Unreal didn't finish opening Lantern. Open it from the Unreal button above the game.";

/** What the host lists a game linked to its Unreal project as holding: the link's project, in `unreal/`. */
const LINKED_FACTS = [{ id: "unreal-project", path: "unreal", source: "link" }];
/** What it lists the web game it was before as holding. */
const WEB_FACTS = [{ id: "web-game", path: ".", source: "core" }];
/** The moments the Unreal plugin hooks for a linked game. */
const UNREAL_MOMENTS = [HookEvent.CheckpointBefore, HookEvent.CheckpointAfter, HookEvent.Health, HookEvent.Crash];

/** A descriptor as `game.list` answers it, linked to Unreal or not, with the facts and moments the host lists. */
function game(unreal: boolean, extra: Record<string, unknown> = {}, legacy = false) {
  return {
    name: NAME,
    title: NAME,
    dir: `/games/${NAME}`,
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: false,
    ...(unreal ? { engine: { kind: GameEngine.Unreal, project: UPROJECT, linkedAt: "" } } : {}),
    ...(legacy ? {} : { facts: unreal ? LINKED_FACTS : WEB_FACTS }),
    ...(unreal ? { hookEvents: UNREAL_MOMENTS } : {}),
    ...extra,
  };
}

/** The game once it is linked to another Unreal project, outside its folder. */
function relinked(project: string) {
  const folder = project.slice(0, project.lastIndexOf("/"));
  return game(true, {
    engine: { kind: GameEngine.Unreal, project, linkedAt: "" },
    facts: [{ id: "unreal-project", path: folder, source: "link" }],
  });
}

/** How one `health` moment answers: ready, pending (still opening) or blocked (it stopped opening). */
const Health = { Ok: "ok", Pending: "pending", Blocked: "blocked" } as const;
type Health = (typeof Health)[keyof typeof Health];

/** A `hooks.fire` answer for one health reading. */
function healthReport(health: Health) {
  return {
    blocked: health === Health.Blocked ? { plugin: "unreal", tool: "editor-state", reason: NOT_OPENED } : null,
    pending: health === Health.Pending ? { plugin: "unreal", reason: OPENING } : null,
    notes: [],
    images: [],
    ran: ["unreal__editor-state"],
  };
}

/**
 * One turn on the game. It is linked to Unreal `before` the builder runs and `after` it; each
 * `health` moment answers the next of `healths` (the last one repeats); `stopOnHealth` raises Stop
 * on that call; `onHealth` runs at each, as a clock moving on while Unreal starts.
 */
async function turnOn(options: {
  before?: boolean;
  after?: boolean;
  healths?: Health[];
  turn?: Record<string, unknown>;
  stopOnHealth?: number;
  onHealth?: () => void;
  legacy?: boolean;
  relinkTo?: string;
  /** Facts the turn adds to the linked game it ends on (a web page beside its Unreal project). */
  gains?: unknown[];
  /** The test's mocked timers: a poll's sleep passes as soon as it is set, never waiting for real. */
  timers?: { tick: (ms: number) => void };
}) {
  let built = false;
  const healths = [...(options.healths ?? [Health.Pending, Health.Ok])];
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: TURN.text }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [gameNow(built, options)],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [] }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "checkpoint.take": () => ({ skipped: "nothing_unsaved", reason: "Nothing was unsaved in Unreal." }),
      "engine.delegate": (p) => {
        const first = !built;
        built = true;
        return {
          ok: true,
          engine: CLAUDE,
          turns: 1,
          usage: {},
          sessionId: first ? "s1" : String(p.resume ?? "s2"),
          summary: first ? FIRST : AFTER,
        };
      },
      "hooks.fire": (p) => {
        if (p.on !== HookEvent.Health) return healthReport(Health.Ok);
        options.onHealth?.();
        const health = (healths.length > 1 ? healths.shift() : healths[0]) ?? Health.Ok;
        // A pending answer is followed by the poll's sleep, on the test's clock: it passes as soon as
        // it is set (a turn Stop ended sets none, and the test may be over by then).
        if (options.timers && health === Health.Pending) setImmediate(() => tickQuietly(options.timers, READY_POLL_MS));
        return healthReport(health);
      },
    },
  });
  if (options.stopOnHealth !== undefined) recorder.cancelAfter("hooks.fire", options.stopOnHealth);
  const outcome = await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME, ...options.turn } as never);
  const delegated = recorder.paramsOf("engine.delegate");
  const healthCalls = recorder.paramsOf("hooks.fire").filter((p) => p.on === HookEvent.Health);
  const said = recorder.notifications
    .filter((n) => n.type === "chat.message")
    .map((n) => String((n.payload as { content?: unknown }).content));
  return {
    outcome,
    delegated,
    healthCalls,
    plugin: recorder.paramsOf("plugins.invoke"),
    said,
    statuses: recorder.statuses,
  };
}

/** The game as `game.list` lists it before the builder ran and after. */
function gameNow(built: boolean, options: Parameters<typeof turnOn>[0]) {
  if (built && options.relinkTo) return relinked(options.relinkTo);
  if (built && options.gains) return game(true, { facts: [...LINKED_FACTS, ...options.gains] });
  return game(built ? options.after !== false : options.before === true, {}, options.legacy);
}

/** Moves the test's clock on, unless the test already ended and took its mocked timers with it. */
function tickQuietly(timers: { tick: (ms: number) => void } | undefined, ms: number): void {
  try {
    timers?.tick(ms);
  } catch {
    // The test is over: nothing waits on this clock any more.
  }
}

/** The prompt the same session goes on with: the game's new kind. */
const goOnPrompt = (descriptor: ReturnType<typeof game>) => factsReadyPrompt(servedFactsOf(descriptor as never));

describe("the turn that makes a game's Unreal project", () => {
  it("after a turn made the game's Unreal project, the chat waits while health is pending, says why once, then the same session goes on", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const turn = await turnOn({ healths: [Health.Pending, Health.Pending, Health.Ok], timers: t.mock.timers });
    assert.equal(turn.delegated.length, 2, "one build, then one continuation");
    assert.deepEqual([turn.delegated[1]?.resume, turn.delegated[1]?.prompt], ["s1", goOnPrompt(game(true))]);
    assert.equal(turn.said.filter((line) => line === OPENING).length, 1, "it says why it waits, once");
    assert.ok(
      turn.statuses.some((status) => status.includes(OPENING)),
      "the status line says it too",
    );
    assert.ok(turn.said.some((line) => line.includes(FIRST)) && turn.said.some((line) => line.includes(AFTER)));
    assert.equal(turn.healthCalls.length, 3, "it asked until nothing was pending");
    assert.ok(
      turn.healthCalls.every((p) => p.project === NAME && p.threadId === TURN.threadId),
      "only this game's moments, for this chat",
    );
    assert.deepEqual(turn.plugin, [], "no plugin tool is called by name");
  });

  it("a turn that switches a linked game to another Unreal project waits for that project too", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const moved = await turnOn({
      before: true,
      relinkTo: "/Users/me/Unreal Projects/Moth/Moth.uproject",
      timers: t.mock.timers,
    });
    assert.equal(moved.delegated.length, 2, "one build, then one continuation");
    assert.ok(moved.healthCalls.length >= 1, "it waited for health");
    const unchanged = await turnOn({ before: true, after: true });
    assert.equal(unchanged.delegated.length, 1, "a turn on the same link ends as it did");
    assert.equal(unchanged.healthCalls.length, 0);
  });

  it("goes on the same way for a host that lists no facts, by the game's link and its moments", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const legacy = await turnOn({ legacy: true, timers: t.mock.timers });
    assert.equal(legacy.delegated.length, 2);
    assert.equal(legacy.delegated[1]?.resume, "s1");
    assert.ok(legacy.healthCalls.length >= 1, "it waited on the game's moments");
  });

  it("goes on at once when nothing is pending, saying nothing about waiting", async () => {
    const ready = await turnOn({ healths: [Health.Ok] });
    assert.equal(ready.delegated.length, 2);
    assert.ok(!ready.said.includes(OPENING));
    assert.equal(ready.healthCalls.length, 1);
  });

  it("says plainly why when a step blocks, and doesn't go on", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const healths of [[Health.Blocked], [Health.Pending, Health.Pending, Health.Blocked]]) {
      const blocked = await turnOn({ healths, timers: t.mock.timers });
      assert.equal(blocked.delegated.length, 1, healths.join(","));
      assert.ok(blocked.said.includes(NOT_OPENED), healths.join(","));
    }
  });

  it("says it is still pending when the wait's cap passes, never that it didn't open", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const waited = await turnOn({
      healths: [Health.Pending],
      onHealth: () => t.mock.timers.tick(READY_WAIT_MS),
      timers: t.mock.timers,
    });
    assert.equal(waited.delegated.length, 1, "nothing goes on while it's pending");
    assert.ok(waited.said.includes(READY_WORDS.timedOut(OPENING)), waited.said.join(" | "));
    assert.ok(!waited.said.includes(NOT_OPENED));
  });

  it("Stop during the wait ends it: nothing goes on, and the chat says how to pick up", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stopped = await turnOn({ healths: [Health.Pending], stopOnHealth: 2, timers: t.mock.timers });
    assert.equal(stopped.delegated.length, 1);
    assert.ok(stopped.said.includes(READY_WORDS.stopped));
  });

  it("never waits for a game that was Unreal before the turn, stays a web game, or a run's turn", async () => {
    const cases: Record<string, Parameters<typeof turnOn>[0]> = {
      "linked before the turn": { before: true, after: true },
      "still a web game": { before: false, after: false },
      "a run's turn": { turn: { runId: "run-1" } },
    };
    for (const [label, options] of Object.entries(cases)) {
      const turn = await turnOn(options);
      assert.equal(turn.delegated.length, 1, label);
      assert.equal(turn.healthCalls.length, 0, label);
      assert.ok(!turn.said.includes(OPENING), label);
    }
  });

  it("a linked game with Unreal closed that gains a web page goes on in the same session, never held by health", async () => {
    const gained = await turnOn({ before: true, gains: WEB_FACTS, healths: [Health.Blocked] });
    assert.equal(gained.delegated.length, 2, "one build, then one continuation");
    assert.equal(gained.delegated[1]?.resume, "s1");
    assert.equal(gained.healthCalls.length, 0, "the link stayed: nothing waits on Unreal");
    assert.ok(!gained.said.includes(NOT_OPENED), gained.said.join(" | "));
  });
});

const UNREAL_KIND = { plugin: "unreal", name: "Unreal Editor", tool: "unreal__new-game", makes: ["unreal-project"] };
const LINK_KIND = { plugin: "unreal", name: "Unreal Editor", tool: "unreal__use-project", makes: ["unreal-project"] };

/** A new game's first turn with kinds on offer, as the host lists them (with or without readiness). */
async function engineQuestion(kinds: unknown[]) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: "make a lantern-lit city game" }],
      "game.contentStamp": () => ({ all: null, source: null }),
      "game.list": () => [],
      // A game Genex just made has no kind yet.
      "game.scaffold": (p) => game(false, { name: String(p.name), facts: [] }),
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({ ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: "ok" }),
    },
  });
  await runDelegatedTurn(
    recorder.ctx as never,
    { ...TURN, text: "make a lantern-lit city game", newProject: true } as never,
  );
  const [delegated] = recorder.paramsOf("engine.delegate");
  return { prompt: String(delegated?.prompt ?? ""), plugin: recorder.paramsOf("plugins.invoke") };
}

describe("the engine question, told how each kind stands", () => {
  it("the card offers each kind with its plugin's readiness note, and sends a kind that isn't ready to its plugin's button", async () => {
    const readyNote = 'Offer "Unreal Engine: plays in the Unreal editor on this computer"; call unreal__new-game.';
    const ready = await engineQuestion([LINK_KIND, { ...UNREAL_KIND, ready: true, note: readyNote }]);
    assert.ok(ready.prompt.includes(readyNote), "a ready kind is offered in its plugin's words");
    assert.doesNotMatch(ready.prompt, /finish its setup/);
    assert.match(
      ready.prompt,
      /When it is the web, call [^ ]*start_web_game first/,
      "the web answer starts the web starter",
    );
    assert.deepEqual(ready.plugin, [], "the harness asks no plugin itself");

    const notReadyNote = "Unreal Engine isn't installed on this computer yet.";
    const missing = await engineQuestion([{ ...UNREAL_KIND, ready: false, note: notReadyNote }]);
    assert.ok(missing.prompt.includes(notReadyNote));
    assert.match(
      missing.prompt,
      /don't call mcp__studio__unreal__new-game: tell them to finish its setup from the Unreal Editor button/,
    );

    const unknown = await engineQuestion([UNREAL_KIND]);
    assert.match(
      unknown.prompt,
      /When the answer \(or the request\) is Unreal Editor, call mcp__studio__unreal__new-game/,
    );
  });

  it("a host that lists no kinds offers no Unreal kind", async () => {
    const none = await engineQuestion([]);
    assert.doesNotMatch(none.prompt, /FIRST, THE ENGINE|unreal__new-game/);
  });
});

describe("engine-status, in the words the card shows (the Unreal plugin)", () => {
  it("engine-status says whether a new Unreal game can be made here, in the words the card shows", async () => {
    const { readinessAnswer } = await import("../../src/plugins/unreal/hook-answers.ts");
    const ready = readinessAnswer({ engine: EngineReadiness.Ready, version: "5.8" });
    assert.equal(ready.ready, true);
    assert.match(ready.note, /plays in the Unreal editor on this computer/);
    assert.match(ready.note, /call unreal__new-game with a template and a name/);

    const none = readinessAnswer({ engine: EngineReadiness.None, version: null });
    assert.equal(none.ready, false);
    assert.match(
      none.note,
      /offer it as "Unreal Engine" with the description "Plays in Epic's free editor on this computer; needs a 45 GB install first"/,
    );
    assert.match(none.note, /don't call unreal__new-game/);
    assert.match(none.note, /Unreal button/);

    const newer = readinessAnswer({ engine: EngineReadiness.NewerOnly, version: "5.9" });
    assert.equal(newer.ready, false);
    assert.match(
      newer.note,
      /"Unreal Engine 5\.8" with the description "Needs 5\.8 installed beside your 5\.9, about 45 GB"/,
    );
    assert.match(newer.note, /install 5\.8 beside 5\.9 in the Epic Games Launcher/);

    const older = readinessAnswer({ engine: EngineReadiness.OlderOnly, version: "5.4" });
    assert.equal(older.ready, false);
    assert.match(older.note, /Unreal 5\.4, older than the 5\.8/);
    assert.doesNotMatch(older.note, /isn't installed/);
  });
});

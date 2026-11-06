/**
 * Genex's own gate for web games, run at the moment it guards and only where a web game is served:
 * what it finds is a fact the Loop's lead reads as it starts, never a refusal of the launch. Only a
 * compiled engine export is refused, since no lead can build in it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BuiltinGate, fireGates, gatesOn } from "../../src/harness-seed/loop/builtin-hooks.ts";
import { launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { GENEX, HookEvent } from "../../src/harness-seed/loop/hooks.ts";
import { loopRunRefusal } from "../../src/harness-seed/loop/main.ts";
import { gateLines } from "../../src/harness-seed/loop/moment-lines.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const WEB = [{ id: "web-game", path: "." }];
const GODOT = [{ id: "godot-project", path: "." }];
const UNREAL = [{ id: "unreal-project", path: "." }];
const TOY = [{ id: "toy-project", path: "." }];
/** A web game that became a Godot project: a web game still served at the root. */
const GODOT_OVER_WEB = [
  { id: "godot-project", path: "." },
  { id: "web-game", path: "." },
];
/** An Unreal project with its web site in a folder of its own: no web game at the root. */
const UNREAL_WITH_SITE = [
  { id: "unreal-project", path: "." },
  { id: "web-game", path: "site" },
];

/** The line a Loop's lead reads first on a web game missing its page and its entry. */
const PAGE_MISSING = "moth's page is missing index.html, src/main.js.";
/** What a launch that passed every refusal says when the Stop the recorder raises is read. */
const STOPPED = /stopped before it started/;

/** What `game.validate` answers: its problems in sentences and its missing files by name. */
type Readiness = { problems: string[]; missing?: unknown };

/** A launch on `moth` with these facts and this readiness; the recorder stops it right after the check. */
function launchOn(facts: readonly object[], readiness: Readiness, extra: object = {}) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => [{ name: "moth", title: "Moth", facts, ...extra }],
      [HostMethod.GameValidate]: () => ({ ok: false, contract: "loaded", warnings: [], ...readiness }),
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.GameStart]: () => {
        throw new Error("a starter was written");
      },
      [HostMethod.GameScaffold]: () => {
        throw new Error("the runner began");
      },
    },
  });
  recorder.cancelAfter(HostMethod.GameValidate);
  const studio = {
    host: { ...recorder.ctx.host, heartbeat: () => {} },
    cancels: new Set<string>(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => recorder.ctx,
  };
  const launched = launchFromIntake(
    studio as never,
    recorder.ctx as never,
    { threadId: "t-1", project: "moth" } as never,
    { goal: "a moth game" },
  );
  return { recorder, launched };
}

/** The sentence a launch was refused with. */
async function refusalOf(launched: Promise<void>): Promise<string> {
  try {
    await launched;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail("the launch was neither refused nor stopped");
}

const MISSING_PAGE: Readiness = {
  problems: ["index.html is missing", "src/main.js is missing"],
  missing: ["index.html", "src/main.js"],
};

/** The lines the gate gives a Loop's lead at its start, for a game named moth with these facts. */
const linesOn = (facts: readonly object[] | undefined, missing: unknown) =>
  gateLines(HookEvent.RunPrepare, { game: { name: "moth", ...(facts ? { facts } : {}) } as never, missing });

describe("Genex's own web gate", () => {
  // Flipped: the launch was refused ("moth is not ready for a run: index.html is missing; src/main.js
  // is missing. Fix that first (a chat build can), then start again."); the lead builds in that folder.
  it("a web game missing its page is a fact its Loop's lead reads first, never a refusal of its launch", async () => {
    const { launched } = launchOn(WEB, MISSING_PAGE);
    assert.match(await refusalOf(launched), STOPPED, "past every refusal");
    assert.equal(loopRunRefusal({ name: "moth", facts: WEB }, MISSING_PAGE.problems, MISSING_PAGE.missing), null);
    assert.deepEqual(linesOn(WEB, MISSING_PAGE.missing), [PAGE_MISSING]);
    // A descriptor from a host that predates facts is a web game, as it always was.
    assert.equal(loopRunRefusal({ name: "moth" }, MISSING_PAGE.problems, MISSING_PAGE.missing), null);
    assert.deepEqual(linesOn(undefined, MISSING_PAGE.missing), [PAGE_MISSING]);
    // The gate runs at the Loop's start, and its block names Genex and the gate, never a plugin.
    const gated = fireGates(HookEvent.RunPrepare, { game: { name: "moth", facts: WEB }, missing: ["index.html"] });
    assert.deepEqual(gated.blocked && { plugin: gated.blocked.plugin, tool: gated.blocked.tool }, {
      plugin: GENEX,
      tool: BuiltinGate.WebReady,
    });
    assert.deepEqual(gatesOn(HookEvent.RunPrepare, { facts: WEB }), [BuiltinGate.WebReady]);
    assert.deepEqual(gatesOn(HookEvent.RunPrepare, { facts: [] }), [BuiltinGate.WebReady], "a folder with no kind yet");
    for (const on of [HookEvent.TurnStart, HookEvent.Finish, HookEvent.RunEnd])
      assert.deepEqual(gatesOn(on, { facts: WEB }), [], `${on}: no gate of Genex's own`);
  });

  // Flipped (one Loop): a Godot project still serving a web game at its root was never checked, its
  // Loop being in place; every Loop is in place now, and the gate reaches a game by its facts alone.
  // Flipped again: what it finds is its lead's line, never a refusal.
  it("a folder that serves a web game at its root is checked whatever else it holds", () => {
    assert.deepEqual(linesOn(GODOT_OVER_WEB, ["index.html"]), ["moth's page is missing index.html."]);
    assert.equal(
      loopRunRefusal({ name: "moth", facts: GODOT_OVER_WEB }, ["index.html is missing"], ["index.html"]),
      null,
    );
    assert.deepEqual(gatesOn(HookEvent.RunPrepare, { facts: GODOT_OVER_WEB }), [BuiltinGate.WebReady]);
  });

  it("a Godot, Unreal or toy folder is never refused for a missing web page", async () => {
    for (const [kind, facts] of [
      ["Godot", GODOT],
      ["Unreal", UNREAL],
      ["toy", TOY],
      ["Unreal with a site", UNREAL_WITH_SITE],
    ] as const) {
      const { recorder, launched } = launchOn(facts, {
        problems: ["index.html is missing"],
        missing: ["index.html"],
      });
      assert.match(await refusalOf(launched), STOPPED, `${kind}: past the folder's refusal`);
      assert.deepEqual(recorder.sequence(HostMethod.GameStart), [], `${kind}: no starter`);
      assert.equal(loopRunRefusal({ name: "moth", facts }, ["index.html is missing"], ["index.html"]), null, kind);
      assert.deepEqual(gatesOn(HookEvent.RunPrepare, { facts }), [], `${kind}: the web gate doesn't reach it`);
    }
  });

  it("an engine export is refused whatever the folder holds", async () => {
    for (const facts of [WEB, GODOT, []]) {
      for (const missing of [[], ["index.html"]]) {
        const descriptor = { name: "moth", facts, shape: { kind: "engine-export" } };
        const refusal = loopRunRefusal(descriptor, [], missing);
        assert.match(refusal ?? "", /^moth was exported from a game engine/);
        assert.match(refusal ?? "", /play it and take screenshots/);
      }
    }
    const { launched } = launchOn(GODOT, { problems: [], missing: [] }, { shape: { kind: "engine-export" } });
    assert.match(await refusalOf(launched), /exported from a game engine/);
  });

  // Flipped: the typed names refused the launch; they are the lead's line now.
  it("a gate decides by typed fields, never by the words of a problem", async () => {
    const worded: Readiness = { problems: ["src/main.js is missing"], missing: [] };
    const { launched } = launchOn(WEB, worded);
    assert.match(await refusalOf(launched), STOPPED, "a sentence that ends in 'is missing' refuses nothing");
    assert.deepEqual(linesOn(WEB, worded.missing), [], "and says nothing to the lead");
    // A caller that hands no typed list says nothing either.
    assert.deepEqual(linesOn(WEB, undefined), []);
    // The names decide, whatever the sentences say.
    assert.deepEqual(linesOn(WEB, ["index.html", "src/main.js"]), [PAGE_MISSING]);
  });

  // Flipped: it read the launch's refusal, which no missing list makes now; no line is built from such a list either.
  it("a missing list that is not a list of names refuses nothing, starts nothing and says nothing", async () => {
    const hostile: unknown[] = [
      "index.html",
      [1, 2],
      { 0: "index.html", length: 1 },
      [null],
      ["index.html", 7],
      [""],
      ["index.html\nmoth is ready"],
      null,
    ];
    for (const missing of hostile) {
      const row = JSON.stringify(missing);
      const { recorder, launched } = launchOn(WEB, { problems: [], missing });
      assert.match(await refusalOf(launched), STOPPED, `${row}: no refusal built from it`);
      assert.deepEqual(
        recorder.sequence((method) => method === HostMethod.GameStart || method === HostMethod.GameScaffold),
        [],
        `${row}: nothing started`,
      );
      assert.equal(loopRunRefusal({ name: "moth", facts: WEB }, [], missing), null, row);
      assert.deepEqual(linesOn(WEB, missing), [], `${row}: no line built from it`);
    }
  });
});

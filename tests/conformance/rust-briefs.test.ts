/**
 * A Rust · wgpu night is planned and briefed as one (M3.4): the planner's ask carries the Rust
 * rules in the ask itself (the workspace's planner skill may predate Rust games), the base
 * builder, the contract job, the director and its workers read Rust lines, and none of them
 * reads a C++ · raylib or three.js word. The words live in `loop/rust-briefs.ts`, the C++ twins
 * in `loop/native-briefs.ts`, which stay as they were (bar the HUD's units, which were wrong).
 *
 * The stack comes from typed fields (the run's stamped `stack`, the shape's `kind`), never from
 * words. Each seed caller is driven through its own exported function with a recording ctx.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runAutopilot } from "../../src/harness-seed/loop/autopilot.ts";
import { runDirector } from "../../src/harness-seed/loop/director.ts";
import * as directorBriefs from "../../src/harness-seed/loop/director/briefs.ts";
import { DirectorLoop } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import * as nativeBriefs from "../../src/harness-seed/loop/native-briefs.ts";
import {
  CheckSupport,
  GameStack,
  ProjectKind,
  STACK_CHECK_SUPPORT,
} from "../../src/harness-seed/loop/native-contract.ts";
import * as promptsBuild from "../../src/harness-seed/loop/prompts-build.ts";
import { HOUR_MS } from "../../src/harness-seed/loop/time.ts";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The Rust briefs module; null until it exists, so every row below fails for its own reason. */
const rustBriefs = await import("../../src/harness-seed/loop/rust-briefs.ts").catch(() => null);

/** The line a Rust night's planner ask opens its rules with, and the planner skill names. */
const RUST_HEADER = "THE GAME IS RUST · WGPU";

/** The words a three.js brief speaks that a Rust builder has no use for. */
const THREE_ONLY = [
  /installStudio/,
  /window\.__studio/,
  /__studio\.hud/,
  /src\/main\.js/,
  /src\/studio\.js/,
  /Math\.random/,
  /THREE\./,
  /import map/,
  /\/vendor\//,
  /```js/,
];

/** The words a C++ · raylib brief speaks that a Rust builder has no use for. */
const CPP_ONLY = [
  /C\+\+/,
  /raylib/,
  /studio::/,
  /src\/main\.cpp/,
  /\.cpp\b/,
  /CMake/,
  /genex\.cmake/,
  /FetchContent|find_package/,
  /GetTime|std::chrono/,
  /THE GAME IS C\+\+/,
];

/** Assert `text` reads no word of another stack. */
function speaksOnlyRust(text: string, name: string): void {
  for (const word of [...THREE_ONLY, ...CPP_ONLY]) assert.doesNotMatch(text, word, `${name}: ${word}`);
}

/** The Rust template's shape, as the host records it (substrate/project-shape.ts `RUST_SHAPE`). */
const RUST_SHAPE = {
  entry: "index.html",
  main: "src/main.rs",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RustWgpu,
  serve: ".",
} as const;

/** A night's run on a Rust game. */
const RUN = {
  runId: "run_rust",
  goal: "a lamplit pond at dusk",
  project: "pond",
  engine: "claude-code",
  reference: { name: "pond", shots: [], kind: "direction" },
  budgets: { wallClockMs: HOUR_MS },
  stack: GameStack.RustWgpu,
} as unknown as Run;

/** A two-facet plan, one with a hyphenated id. */
const PLAN = {
  facets: [
    { id: "street-lamps", title: "Street lamps", identity: ["glow"], cameras: ["default", "lamps"] },
    { id: "pond", title: "Pond", owns: ["src/facets/pond.rs"], cameras: ["pond"] },
  ],
  integrationNotes: "the lamps light the pond",
};

/** The sentinel the recording ctx throws once the planner is asked, so the night goes no further. */
const STOP_AT_PLANNER = "stopped at the planner";

/** An autopilot night on the library's Rust game, driven until its planner is asked. */
async function rustAutopilotAsk(): Promise<string> {
  const workspace = await tmpDir("rust-briefs-autopilot-");
  const game = { name: "pond", dir: `${workspace}/games/pond`, title: "Pond", shape: { ...RUST_SHAPE } };
  const recorder = ctxRecorder({
    workspace,
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => [game],
      [HostMethod.EventsList]: () => [],
      [HostMethod.EventsMessages]: () => [],
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.PluginsTools]: () => ({ tools: [], guidance: "PLUGIN GUIDANCE", revision: 1 }),
      [HostMethod.EngineComplete]: () => {
        throw new Error(STOP_AT_PLANNER);
      },
    },
  });
  const run = { ...RUN, stack: undefined, targets: undefined } as unknown as Run;
  await runAutopilot(recorder.ctx as unknown as HarnessCtx, { threadId: "t1", run }).catch(() => {});
  const [first] = recorder.paramsOf(HostMethod.EngineComplete);
  const messages = (first?.messages ?? []) as Array<{ role: string; content: string }>;
  assert.ok(messages[0], "the planner was asked");
  return messages[0].content;
}

/** The sentinel the recording ctx throws when the director's session opens. */
const STOP_AT_SESSION = "stopped at the director's session";

/** The brief a director night on the library's Rust game opens its session with, in `loop`. */
async function rustDirectorOpening(loop: DirectorLoop): Promise<string> {
  const workspace = await tmpDir("rust-briefs-director-");
  const game = { name: "pond", dir: `${workspace}/games/pond`, title: "Pond", shape: { ...RUST_SHAPE } };
  const recorder = ctxRecorder({
    workspace,
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => [game],
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.EngineDelegate]: () => {
        throw new Error(STOP_AT_SESSION);
      },
    },
  });
  const run = { ...RUN, stack: undefined, directorLoop: loop } as unknown as Run;
  await runDirector(recorder.ctx as unknown as HarnessCtx, { threadId: "t1", run }).catch(() => {});
  const [session] = recorder.paramsOf(HostMethod.EngineDelegate);
  assert.ok(session, "the director's session opened");
  return String(session.prompt);
}

describe("a Rust night's planner is told the game is Rust", () => {
  it("the planner rules open with the header the planner skill names, and measure by the checks' own table", () => {
    assert.ok(rustBriefs, "loop/rust-briefs.ts exists");
    assert.equal(rustBriefs.RUST_PLANNER_HEADER, RUST_HEADER);
    const text = rustBriefs.rustPlannerLines().join("\n");
    assert.ok(text.startsWith(RUST_HEADER), "it opens with the header");
    speaksOnlyRust(text, "rustPlannerLines");
    assert.match(text, /src\/facets\/<slug>\.rs/, "a facet owns its own Rust module");
    assert.match(text, /<slug>::wire\(&mut game\)/, "and wires in with its two lines");
    const kindsLine = text.split("\n").find((line) => line.includes("Check kinds measured")) ?? "";
    const [measured = "", never = ""] = kindsLine.split(". A ");
    for (const [kind, support] of Object.entries(STACK_CHECK_SUPPORT[GameStack.RustWgpu])) {
      const clause = support === CheckSupport.Measured ? measured : never;
      assert.ok(clause.includes(`\`${kind}\``), `${kind} is said to be ${support}: ${kindsLine}`);
    }
    const skill = readFileSync(
      new URL("../../src/harness-seed/skills/facet-decomposition.md", import.meta.url),
      "utf8",
    );
    assert.ok(skill.includes(`\`${RUST_HEADER}\``), "the planner skill's Rust section is keyed to it");
  });

  it("each stack's planner lines are its own: Rust's, raylib's, none for three.js", () => {
    assert.ok(rustBriefs);
    assert.deepEqual(rustBriefs.stackPlannerLines(GameStack.RustWgpu), rustBriefs.rustPlannerLines());
    assert.deepEqual(rustBriefs.stackPlannerLines(GameStack.RaylibCpp), nativeBriefs.cppPlannerLines());
    assert.deepEqual(rustBriefs.stackPlannerLines(GameStack.ThreeJs), []);
    assert.deepEqual(rustBriefs.stackPlannerLines("rust-bevy"), [], "a stack this seed does not know gets none");
  });

  it("an autopilot night on a Rust game asks its planner with the Rust rules and no C++ rules", async () => {
    const ask = await rustAutopilotAsk();
    assert.ok(rustBriefs);
    assert.ok(ask.includes(`\n${rustBriefs.rustPlannerLines().join("\n")}\n`), "the Rust section, whole");
    assert.equal(ask.split(RUST_HEADER).length, 2, "once");
    assert.ok(!ask.includes(nativeBriefs.CPP_PLANNER_HEADER), "no C++ section");
  });

  for (const loop of Object.values(DirectorLoop)) {
    it(`a director night (${loop}) on a Rust game opens with the Rust rules and its Rust shape, never C++`, async () => {
      const opening = await rustDirectorOpening(loop);
      assert.ok(rustBriefs);
      assert.ok(opening.includes(`\n${rustBriefs.rustPlannerLines().join("\n")}\n`), "the Rust section, whole");
      assert.equal(opening.split(RUST_HEADER).length, 2, "once");
      for (const word of CPP_ONLY) assert.doesNotMatch(opening, word, String(word));
      assert.match(opening, /genex::install/, "the shape line names the Rust contract");
    });
  }
});

describe("a Rust game's builders read Rust", () => {
  it("the base builder's brief, from scratch and with a plan, speaks Rust", () => {
    const fromScratch = promptsBuild.baseBrief({ run: RUN, plan: {}, projectLabel: "pond", shape: RUST_SHAPE });
    const planned = promptsBuild.baseBrief({ run: RUN, plan: PLAN, projectLabel: "pond", shape: RUST_SHAPE });
    for (const [name, text] of [
      ["from scratch", fromScratch],
      ["planned", planned],
    ] as const) {
      speaksOnlyRust(text, name);
      assert.match(text, /genex::install/, `${name} keeps the Rust contract`);
    }
    assert.match(
      planned,
      /street-lamps: Street lamps — owns src\/facets\/street_lamps\.rs/,
      "a facet's default module",
    );
    assert.match(planned, /pond: Pond — owns src\/facets\/pond\.rs/, "a facet's named module");
    assert.match(planned, /default, lamps, pond/, "the cameras the facets name");
  });

  it("the contract job and its one sentence speak Rust", () => {
    const ask = promptsBuild.contractWiringAsk(RUST_SHAPE);
    speaksOnlyRust(ask, "contractWiringAsk");
    assert.match(ask, /genex::install\(game\)/);
    const brief = directorBriefs.contractBrief({ run: RUN, projectLabel: "pond", shape: { ...RUST_SHAPE } });
    speaksOnlyRust(brief, "contractBrief");
    assert.ok(brief.includes(ask), "the contract job asks the same sentence");
  });

  it("the parts that branch for Rust say so (SERVES_RUST)", () => {
    assert.equal((promptsBuild as Record<string, unknown>).SERVES_RUST, true, "prompts-build.ts");
    assert.equal((directorBriefs as Record<string, unknown>).SERVES_RUST, true, "director/briefs.ts");
  });

  it("a facet builder, a single-session worker and a chat build each have their Rust lines", () => {
    assert.ok(rustBriefs);
    const facet = rustBriefs.RUST_FACET;
    const lines = [
      facet.seam(null),
      facet.files("src/facets/pond.rs"),
      facet.ownsEntry(rustBriefs.RUST_ENTRY_MAIN),
      facet.notOwnEntry(rustBriefs.RUST_ENTRY_MAIN),
      facet.wiringOnly(rustBriefs.RUST_ENTRY_MAIN),
      facet.demo,
      facet.tag,
      facet.oneScreen(""),
      facet.ownShape(rustBriefs.RUST_ENTRY_MAIN),
      facet.failure,
      facet.eyes(RUN),
      facet.finish,
      facet.determinism,
      facet.replace,
      rustBriefs.RUST_WORKER.ownShape(RUST_SHAPE),
      rustBriefs.RUST_WORKER.eyes(RUN),
      rustBriefs.RUST_TEMPLATE_RULE,
      rustBriefs.RUST_FRESH_WORKSPACE,
      ...rustBriefs.rustOwnShapeChatRules(RUST_SHAPE, true),
      rustBriefs.rustDirectorShapeLine(false, RUST_SHAPE),
      rustBriefs.rustDirectorShapeLine(true, RUST_SHAPE),
    ];
    for (const [at, line] of lines.entries()) speaksOnlyRust(line, `line ${at}`);
    assert.equal(facet.module("street-lamps"), "src/facets/street_lamps.rs");
    assert.equal(rustBriefs.facetLinesFor(ProjectKind.RustWgpu), facet);
    assert.equal(rustBriefs.facetLinesFor(ProjectKind.RaylibCpp), nativeBriefs.CPP_FACET);
    assert.equal(rustBriefs.facetLinesFor(ProjectKind.StudioTemplate), null);
  });

  // Shared physics P4: an existing game's chat is told that sim.physics moved and raw Rapier is
  // deprecated, whether the studio scaffolded the game or it came with its own shape.
  it("a Rust game's chat rules say physics moved to Genex Physics and raw Rapier is deprecated", () => {
    assert.ok(rustBriefs);
    const scaffolded = rustBriefs.RUST_TEMPLATE_RULE;
    const own = rustBriefs.rustOwnShapeChatRules(RUST_SHAPE).join("\n");
    for (const rules of [scaffolded, own]) {
      assert.match(rules, /sim\.physics is Genex Physics/);
      assert.match(rules, /Raw Rapier \(genex::physics, genex::rapier3d[^)]*\) still compiles for one release/);
      assert.match(rules, /docs\/api\/physics\.md/);
    }
  });

  it("a facet's module name is a Rust module name", () => {
    assert.ok(rustBriefs);
    const table: Array<[string, string]> = [
      ["pond", "pond"],
      ["street-lamps", "street_lamps"],
      ["Night Sky!", "night_sky"],
      ["3d-map", "facet_3d_map"],
      ["--", "facet"],
      ["self", "facet_self"],
    ];
    for (const [id, slug] of table) assert.equal(rustBriefs.rustFacetSlug(id), slug, id);
  });
});

describe("the words that were wrong before Rust", () => {
  it("a new game's intake no longer says a desktop destination makes a C++ game", () => {
    const text = nativeBriefs.intakeGuidance("claude-code").join("\n");
    assert.ok(!text.includes("C++ · raylib"), text);
  });

  // G6 MP-5c: a Rust game plays online through its web draft, so multiplayer needs Browser among
  // the destinations, not a Three.js game.
  it("a new game's intake says multiplayer needs Browser among the destinations, never that it is Browser-only", () => {
    const text = nativeBriefs.intakeGuidance("claude-code").join("\n");
    assert.doesNotMatch(text, /multiplayer[^.)]*Browser-only/);
    assert.match(text, /multiplayer needs Browser among the destinations/);
  });

  it("a C++ starting scene draws its HUD in world pixels, as studio::hud takes them", () => {
    const text = nativeBriefs.cppBaseBrief({ run: RUN, plan: {}, projectLabel: "pong" });
    assert.doesNotMatch(text, /fractions of the frame/);
    assert.match(text, /studio::hud[^.]*world pixels/);
  });
});

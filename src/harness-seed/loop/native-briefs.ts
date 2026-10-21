/**
 * What a C++ · raylib game's agents read: the base builder's brief, the contract-wiring ask, the
 * chat build's rules, the code reviewer's words and the facet, director and spike lines, each the
 * C++ twin of a Three.js text that stays as it was. It also holds the intake guidance a new
 * game's chat reads before its first build: where people will play it, which decides the stack.
 * A Rust · wgpu game's twins, and the per-stack selectors over both, are in `rust-briefs.ts`.
 *
 * A new module on purpose: a seed upgrade keeps any older module the agent edited, so every name
 * the C++ briefs need lives here, and this file imports only names its neighbours have always had
 * (`tests/fixtures/seed-exports-pre-native.json`). The briefs that branch here carry
 * `SERVES_NATIVE`, so a raylib night never runs on a kept copy that only speaks JavaScript.
 */
import { askUser } from "./interview-question.ts";
import { roleEngine, RoleKey, toolCall } from "./model-roles.ts";
import { BuildTarget, CheckSupport, GameStack, ProjectKind, RAYLIB_CHECK_SUPPORT } from "./native-contract.ts";
// Type-only, erased at runtime: this module keeps importing only names its neighbours always had.
import type { CompiledFacetLines } from "./rust-briefs.ts";
import { CLIP_BRIEF } from "./text.ts";
import type { AnyRecord, Run } from "../types/harness.d.ts";

// ── which stack a brief is for ─────────────────────────────────────────────────────────────

/** A game's shape as a brief reads it: its entry, its page, its build and what kind of folder it is. */
export interface NativeBriefShape {
  main?: string;
  entry?: string;
  build?: string | null;
  kind?: string;
}

/** The entry module of a C++ game the studio scaffolded. */
export const CPP_ENTRY_MAIN = "src/main.cpp";

/** Is this shape a C++ · raylib game? The files decide (`kind`), never a file name. */
export function isNativeShape(shape: { kind?: unknown } | null | undefined): boolean {
  return shape?.kind === ProjectKind.RaylibCpp;
}

/** Is `stack` the C++ · raylib stack? Anything else, absent included, is a Three.js game. */
export function isNativeStack(stack: unknown): boolean {
  return stack === GameStack.RaylibCpp;
}
// ── the intake: where people will play ─────────────────────────────────────────────────────

/** The words that point at a desktop destination (plan §7.1): the model weighs them, no code matches them. */
export const DESKTOP_WORDS = ["Mac", "Windows", "Linux", "desktop", "app", "Steam", "offline", "C++"] as const;
/** The words that point at Browser, a Three.js game: the model weighs them too. */
export const BROWSER_WORDS = ["browser", "link", "multiplayer", "login", "AI characters"] as const;

/** Quoted, comma-separated, with "or" before the last: `"a", "b" or "c"`. */
function quotedList(words: readonly string[]): string {
  const quoted = words.map((word) => `"${word}"`);
  return `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
}

/**
 * What a new game's chat is told before its first build: propose where people will play it from
 * the user's own words, ask once, and launch with the destinations chosen. Browser alone keeps a
 * Three.js game; any desktop destination makes it a compiled game the studio builds for each
 * destination, and the stack never changes after.
 */
export function intakeGuidance(engine: string | undefined): string[] {
  const ask = toolCall(engine, askUser.name);
  const targets = Object.values(BuildTarget).join(", ");
  return [
    "WHERE PEOPLE WILL PLAY (a new game): before its first build, propose where people will play it, from the user's own words:",
    `- ${quotedList(DESKTOP_WORDS)}: a desktop destination (this computer's own system first). Any desktop destination makes it a compiled game, which the studio builds for each destination it names; Browser can be ticked beside it.`,
    `- ${quotedList(BROWSER_WORDS)}: Browser, a Three.js game (login and AI characters are Browser-only; multiplayer needs Browser among the destinations, because it is played on the game's Genex draft, so a desktop game with Browser ticked beside it has it too).`,
    "- Unclear, or none of these: Browser.",
    `Ask once, with ${ask}: your proposal first, the other choice second (the one question before a build may cover this beside the look). After the answer, never ask about it again. When you launch, pass the chosen destinations as targets (any of ${targets}). Destinations can be added later; the stack never changes.`,
  ];
}

// ── the contract wiring ────────────────────────────────────────────────────────────────────

/**
 * The one job that makes somebody's own C++ game buildable and judgeable: CMake through the
 * studio's genex.cmake, and `studio::install` at the end of `main()`. The C++ twin of
 * `contractWiringAsk`, said in the same words wherever it is asked.
 */
export function cppContractWiringAsk(shape: { main?: string } | null | undefined): string {
  const entryMain = shape?.main ?? CPP_ENTRY_MAIN;
  return `Make CMakeLists.txt reach \`include("\${GENEX_CMAKE}")\` and \`genex_add_game(SOURCES …)\` — the studio's genex.cmake brings the toolchain, raylib 6.0 and the flags for every destination, so no find_package(raylib), FetchContent or second raylib — and end main() in ${entryMain} with \`studio::install(std::move(game))\` over a \`studio::Game\` whose update, draw and camera are this game's own (\`#include "studio.h"\`). That is the whole ask: the runtime owns the window, the loop, the clock and the verbs the studio steps, inspects and captures through; this game's update, draw and camera are the parts it cannot guess.`;
}

// ── the base builder ───────────────────────────────────────────────────────────────────────

/** What the base builder is told about the plan: its facets and the shared base they fork from. */
export interface NativeBasePlan {
  base?: { files?: Array<{ path: string; purpose?: string }>; notes?: string } | null;
  facets?: Array<{ id: string; title?: string; owns?: string[]; identity?: string[]; cameras?: string[] }>;
  integrationNotes?: string;
}

/** The run as the base brief reads it. */
type BriefRun = Pick<Run, "goal" | "reference" | "engine" | "builderEngine"> & { runId?: string };
type BriefFacets = NonNullable<NativeBasePlan["facets"]>;
/** The run as a tool sentence reads it: whichever engine plays the builder. */
type RoleRun = Parameters<typeof roleEngine>[0];

/** The default module a C++ facet owns. */
function facetModule(id: string): string {
  return `src/${id.replace(/[^a-z0-9-]/g, "")}.cpp`;
}

/** `capture` and `computer` as the base builder of a C++ game reads them. */
function eyesLine(run: BriefRun): string {
  const engine = roleEngine(run, RoleKey.Builder);
  return `YOU HAVE EYES: ${toolCall(engine, "capture")} builds this folder through the studio's C++ lane for the game's judging destination and takes every registered camera at once; a failed build answers with its first error, which is the one to fix. When Browser is one of the game's destinations, ${toolCall(engine, "computer")} drives that web build live in its own window. Look before you finish: a base nobody can see is a base nobody can build on.`;
}

/** The base builder's brief for a C++ · raylib game: `baseBrief` in C++ terms, the same roll call and rules. */
export function cppBaseBrief({
  run,
  plan,
  projectLabel,
  shape = null,
  ownShape = false,
  setup = null,
}: {
  run: BriefRun;
  plan: NativeBasePlan;
  projectLabel: string;
  shape?: NativeBriefShape | null;
  ownShape?: boolean;
  setup?: AnyRecord | null;
}): string {
  const facets = plan.facets ?? [];
  if (!ownShape && facets.length === 0) return cppStartingScene(run, projectLabel, setup);
  return [
    ...baseHeader(run, plan, projectLabel),
    ``,
    `ALWAYS, whatever the notes say:`,
    ...(ownShape ? cppOwnShapeRules(shape) : cppTemplateRules(facets)),
    `- probes() reports what the facets will need (player position, counts per group), as one json::Value leaf per mechanic.`,
    cameraRule(facets),
    ownShape
      ? `- The game already exists and works. Add only the contract wiring and the shared structure the facets need; do not remove, restyle or "clean up" what is there.`
      : `- The new project is empty. Add only shared structure required by this specific game. Do not add a demo scene, generic player model, pickups, grid, score or HUD. Empty facet hooks and empty frames are valid at this stage; the build, the verbs and camera placement must still work. Each facet draws its own visible content from the brief.`,
    `- The game must still build for every destination in studio.json and studio::install must keep answering. Do not build facet content — scaffolding only. Do not commit; the studio commits. Never run build/… yourself.`,
    ``,
    eyesLine(run),
    ...(setup ? [requestedStateLine(setup)] : []),
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

/** A director's night from scratch on a C++ game: one visible, working first version. */
function cppStartingScene(run: BriefRun, projectLabel: string, setup: AnyRecord | null): string {
  const engine = roleEngine(run, RoleKey.Builder);
  return [
    `You are building the starting scene for "${projectLabel}". Goal: ${run.goal}`,
    run.reference?.name ? `Direction: ${run.reference.name}.` : "",
    `Complete one visible, working first version now. Preserve the user's intended scene/game; later workers can enrich detail. Include the goal's main subject, a suitable setting, lighting and a camera that frames it. Do not spend this stage designing a large framework.`,
    `This is a C++20 game built with raylib 6.0. Read ${CPP_ENTRY_MAIN} first, then edit it. Read docs/CONTRACT.md only for a specific unanswered API question. src/studio.h and the runtime files beside it (studio.cpp, platform.cpp, hud.cpp and the rest) are the studio's: use their API; do not study or rewrite them. CMakeLists.txt already includes the studio's genex.cmake and compiles every src/*.cpp, new files included.`,
    `Integration guide: build a studio::Game in ${CPP_ENTRY_MAIN} and keep studio::install(std::move(game)) at the end of main(). Load textures and models once the window exists (in reset, guarded as the starter does). Tag what you draw with studio::tag("name") just before drawing it through studio::drawModel or studio::drawModelEx. game.camera returns the framing view; register named views in game.cameras. Keep the FACET WIRING markers for later edits.`,
    `Input/UI API when the goal needs it: update(dt, ctx) is one fixed 1/60 s tick and reads input only from ctx — ctx.keys by DOM code ("KeyW", "Space", "ArrowUp"), ctx.look, ctx.wheel, ctx.pointer, ctx.pads. Draw text with studio::hud, placed in world pixels (y down), never raw DrawText over it. Randomness only from ctx.rng or the seed reset(seed) receives; time only from dt — never rand, GetTime, GetFrameTime or std::chrono. For a scene without gameplay, omit input and HUD.`,
    `Do not invent helpers or controls you have not implemented. Make the requested subject visible with raylib meshes and models first, textured: a flat colour with no texture is a defect (models and textures from assets/ through studio::asset(), or procedural images). Use Blender only when needed for the goal; preserve the requested final quality as work for later stages.`,
    `After writing, call ${toolCall(engine, "capture")}: it builds this folder for its destination through the studio's own lane and photographs it. Fix a failed build's first error, then fix what you see. Never run build/… yourself. The host commits and validates your changes. No git commit is needed.`,
    setup ? `Requested inspection state: ${JSON.stringify(setup)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Who the base builder is, the goal and direction, the facets that fork from it, and the plan's notes. */
function baseHeader(run: BriefRun, plan: NativeBasePlan, projectLabel: string): string[] {
  const facets = plan.facets ?? [];
  const files = plan.base?.files ?? [];
  const who = run.runId ? `run ${run.runId}` : "this run";
  const many = facets.length > 0;
  const count = many ? `${facets.length} facets are` : "Builders are";
  const fork = many ? "be built in parallel, each in" : "work on this game, each with";
  const seams = many ? "facets" : "them";
  const notes = run.reference?.notes ? ` — ${run.reference.notes}` : "";
  return [
    `You are the BASE BUILDER for ${who} on the game "${projectLabel}". ${count} about to ${fork} its own copy of this folder. Before they fork, create the shared base they all build on — so the seams between ${seams} are code, not prose. This is a C++20 game built with raylib 6.0.`,
    ``,
    `GAME GOAL: ${run.goal}`,
    run.reference?.name ? `REFERENCE / DIRECTION: ${run.reference.name}${notes}` : "",
    ``,
    many ? `FACETS THAT WILL FORK FROM YOUR WORK:` : "",
    ...facets.map(
      (f) =>
        `- ${f.id}: ${f.title} — owns ${f.owns?.length ? f.owns.join(", ") : facetModule(f.id)}; identity: ${f.identity?.join(", ") || "n/a"}`,
    ),
    ``,
    plan.integrationNotes ? `INTEGRATION NOTES (the shared contract): ${plan.integrationNotes}` : "",
    plan.base?.notes ? `BASE NOTES: ${plan.base.notes}` : "",
    files.length ? `FILES TO CREATE:\n${files.map((f) => `- ${f.path} — ${f.purpose}`).join("\n")}` : "",
  ];
}

/** The rules for a C++ game that came with its own shape: keep it, wire the contract in, let the studio build it. */
function cppOwnShapeRules(shape: NativeBriefShape | null | undefined): string[] {
  const entryMain = shape?.main ?? CPP_ENTRY_MAIN;
  return [
    `- THIS GAME HAS ITS OWN SHAPE — it is not the studio's template. Its entry is ${entryMain} and the studio builds it with CMake for the destinations in studio.json. Keep that: no second entry, no second build system, do not rewrite it in another language, keep its UI and input handling.`,
    `- ${cppContractWiringAsk(shape)} Register the cameras the facets name through game.cameras, in the same studio::Game.`,
    `- Do NOT impose the studio template's structure on this game: no marker block in the entry for builders to add lines to, no empty per-builder hook added to its loop, no shared header invented to hold them. Builders here are given a seam in the code this game already has — a file, a folder or a glob — and they wire their work in the way this game already wires things.`,
    `- The studio builds the game before every preview: capture shows you that build, and a failed one answers with its first error. Fix every error it reports before you finish — a build that fails is a black screen for every critic.`,
  ];
}

/** The rules for the studio's C++ template: the wiring block, a hook per facet, and a shared palette. */
function cppTemplateRules(facets: BriefFacets): string[] {
  const wiring = `keeps the FACET WIRING block (one declaration and one call per builder: \`void wire_<id>(studio::Game&); wire_<id>(game);\` — the studio union-merges that block, so it is where parallel work meets)`;
  return [
    facets.length
      ? `- ${CPP_ENTRY_MAIN} builds the studio::Game, ${wiring}, and ends with studio::install(std::move(game)). src/world.h gives each facet a hook its wire_<id> registers — its update, its draw and its tag ("<facet id>") — which the game's update and draw run in order.`
      : `- ${CPP_ENTRY_MAIN} builds the studio::Game, ${wiring}, and ends with studio::install(std::move(game)). src/world.h gives each part the goal names a hook — its update, its draw and its tag ("<part>") — which the game's update and draw run in order.`,
    `- src/palette.h holds the named colours, scale constants and the player spawn point every facet must share.`,
  ];
}

/** Which camera views the base registers: the facets' own, or a default plus one per part. */
function cameraRule(facets: BriefFacets): string {
  if (facets.length)
    return `- Register distinct, working camera views in game.cameras for the cameras the facets name: ${[...new Set(facets.flatMap((f) => f.cameras ?? []))].join(", ")}.`;
  return `- Register distinct, working camera views: game.camera framing the game as a player sees it, plus one in game.cameras per part the goal names. Every judge and every check looks through them.`;
}

/** The state the run is about, which the base's cameras must be registered against. */
function requestedStateLine(setup: AnyRecord): string {
  const how = setup.note ?? (setup.demo ? `demo "${setup.demo}"` : `${(setup.actions ?? []).length} input action(s)`);
  const equals = setup.verify && "equals" in setup.verify ? ` == ${JSON.stringify(setup.verify.equals)}` : "";
  const verified = setup.verify ? `, verified by ${setup.verify.path}${equals}` : "";
  return `THE REQUESTED STATE: this run is about a state the game does not boot into — the studio replays a setup script after every load (${how})${verified}. Register the facets' cameras against THAT state (the map, the mode, the scene the goal names), and keep the way a player reaches it working — do not change what the game boots into.`;
}

// ── the chat build ─────────────────────────────────────────────────────────────────────────

/** The chat build's first rule for a C++ game the studio scaffolded: the C++ twin of `TEMPLATE_RULE`. */
export const CPP_TEMPLATE_RULE =
  "Follow CLAUDE.md in the workspace root: keep studio::install(...) in src/main.cpp and every verb in src/studio.h answering, keep gameplay deterministic (randomness only from ctx.rng or the seed reset(seed) receives, time only from dt; never rand, GetTime or std::chrono), and let the studio build: capture builds this folder for its destination through the studio's own lane and answers with the first compiler error when a build fails. Never run build/… yourself. Models, textures and sounds come from assets/ through studio::asset(), procedural code, or the currently enabled plugin tools. Follow the selected tool’s returned file paths and verification guidance.";

/** What a chat build of a fresh C++ workspace is told about where it starts. */
export const CPP_FRESH_WORKSPACE = "This is a fresh workspace scaffolded from the studio's C++ · raylib template.";

/** The rules for a C++ game that came with its own shape, as a chat build reads them. */
export function cppOwnShapeChatRules(shape: NativeBriefShape | null | undefined, contractMissing = false): string[] {
  const main = shape?.main ?? CPP_ENTRY_MAIN;
  return [
    ...(contractMissing
      ? [
          `FIRST, BEFORE THE ASK: ${main} never reaches studio::install, so the studio cannot build-check, step, inspect or capture this game — not you, not a night's judges. ${cppContractWiringAsk(shape)} Change nothing else about the game while you do it. Then do what was asked.`,
        ]
      : []),
    `This game came with its own shape — the studio did not write it. Its entry is ${main}; the studio builds it with CMake through its own genex.cmake for the destinations in studio.json, and capture shows that build. Follow CLAUDE.md in the workspace root. Keep its structure, its screen and its input handling as they are: its UI is its own (no studio::hud overlays, no second input path), and whatever it already loads keeps loading. Keep studio::install(...) where its entry calls it and CMakeLists.txt reaching include("\${GENEX_CMAKE}") and genex_add_game(...). Do not replace this game's randomness or its clock with the template's — this is the user's own code, not the studio's scaffold.`,
    "A failed build answers capture with its first error: fix that first. Never run build/… yourself.",
  ];
}

// ── the code reviewer ──────────────────────────────────────────────────────────────────────

/** The C++ reviewer's rubric when `judge/code-review-cpp.md` is missing from the workspace. */
export const CPP_REVIEW_FALLBACK = [
  "Review ONE diff of a C++ · raylib game for studio-contract violations only (rand / std::random_device / wall clock in simulation, raw IsKey*/GetMouse* in game code, SetTargetFPS / WaitTime, lying probes, removing studio::install or a verb, untagged new draws, FetchContent / find_package / -sUSE_ / -ffast-math, a shader #version line, edits outside the facet's files). No style comments.",
  'Set "gaming": true only on a finding where a check is made to pass without the work — a probe, flag or value forced to what the check wants — and name that check\'s id in "what".',
  'Reply with JSON only: {"violations":[{"file":"…","line":0,"what":"…","fix":"…","gaming":false}],"summary":"…"}',
].join("\n");

/** What the C++ reviewer is told about a game the studio did not scaffold. */
export const CPP_REVIEW_OWN_SHAPE =
  "THIS GAME IS NOT THE STUDIO'S TEMPLATE — it is the user's own C++ code. Three of the rules above DO NOT APPLY here and must not be raised: raw raylib input calls and the game's own UI (its controls and screen are its own), untagged draws in code the facet did not write, and the FACET WIRING block (there is none). Randomness and the clock still matter: two builds must run alike on one seed. Judge the seam and the studio contract only.";

// ── the facet builder ──────────────────────────────────────────────────────────────────────

/** The studio's C++ runtime, as a facet's ownership rules name it. */
const CPP_RUNTIME = "the studio runtime (src/studio.*)";
/** The demo a behavioural C++ facet exposes. */
const CPP_DEMO_ASK =
  "If this facet is behavioural (an interaction, a move, a beat), expose a deterministic demo of it via the studio contract (a game.demos entry handed to studio::install) — demo checks run it and photograph its end frame.";
/** A non-owner's one line in the FACET WIRING block of a C++ entry. */
const CPP_WIRING_LINE = "`void wire_<id>(studio::Game&); wire_<id>(game);`";

/**
 * The facet builder's lines for a C++ · raylib game: the C++ twins of the Three.js lines in
 * `facet/prompt.ts`, which stay as they are. Each takes what its twin takes.
 */
export const CPP_FACET = {
  /** A facet's own source when the plan names none. */
  module: facetModule,
  /** Where a worker's own work goes in a game the user brought. */
  seam: (owned: string | null) =>
    `- YOUR SEAM: ${owned ?? `every file of this game except its entry, ${CPP_RUNTIME} and CMakeLists.txt`}. It is the user's own code — read what is around your seam before you change anything, follow the conventions the game already has, and do not rename, restyle or reformat a file you did not have to change.`,
  /** Where a facet's work goes in the studio's C++ template. */
  files: (owned: string) =>
    `- YOUR FILES: put this facet's work in its own source — ${owned} (split further under src/ if it grows; every src/*.cpp is compiled).`,
  /** The entry and the runtime are this worker's. */
  ownsEntry: (entryMain: string) =>
    `- This worker OWNS ${entryMain} and ${CPP_RUNTIME} — you may restructure them, and you wire in other workers' sources when they appear.`,
  /** The entry of a game the user brought is not this worker's. */
  notOwnEntry: (entryMain: string) =>
    `- This worker does NOT own ${entryMain}, ${CPP_RUNTIME} or CMakeLists.txt. If your work needs a change in one of them, say so in your summary and leave it: the director makes that edit, or gives it to whoever owns the entry.`,
  /** The template's entry is not this facet's, bar its one wiring line. */
  wiringOnly: (entryMain: string) =>
    `- This facet does NOT own ${entryMain} or ${CPP_RUNTIME}. Touch ${entryMain} ONLY to add your single wiring line inside the "FACET WIRING" marker block (${CPP_WIRING_LINE}; add the marker block if it is missing); never reformat or reorganise anything else in either file.`,
  /** The demo a behavioural facet exposes, as a sentence and as a rule. */
  demoAsk: CPP_DEMO_ASK,
  demo: `- ${CPP_DEMO_ASK}`,
  /** How what a facet draws becomes visible to the checks. */
  tag: `- Tag every draw you add (studio::tag("<tag>") just before it) with the tag names the checks use. Untagged draws do not exist to the checks.`,
  /** The one-screen, one-input-path rule, with the harness-owned checks that enforce it. */
  oneScreen: (enforced: string) =>
    `- ONE SCREEN, ONE INPUT PATH: all UI through studio::hud (drawn into the frame; no second HUD); all input from ctx.keys / ctx.look / ctx.wheel / ctx.pointer / ctx.pads inside update(dt, ctx) (the runtime owns the window, the cursor and the clock).${enforced}`,
  /** A game the user brought: keep its screen, its input and the contract. */
  ownShape: (entryMain: string) =>
    `- THIS GAME HAS ITS OWN SHAPE: its entry is ${entryMain} and the studio builds it with CMake for the destinations in studio.json. Keep its UI and input handling as they are — no studio::hud overlays, no second input path. Keep studio::install answering in ${entryMain}. Capture builds it: fix a failed build's first error before anything else.`,
  /** The last build never reached verification. */
  failure:
    "That is a failure report, not a design verdict. Fix that cause first — the same cause twice ends this facet. Deliver a build that compiles for its destination and keeps studio::install answering.",
  /** The builder's eyes on its own worktree. */
  eyes: (run: RoleRun) => {
    const engine = roleEngine(run, RoleKey.Builder);
    return `YOU HAVE EYES — USE THEM: ${toolCall(engine, "capture")} builds YOUR worktree (uncommitted edits included) through the studio's C++ lane and takes every registered camera in one go; a build that fails answers with its first error instead. When Browser is one of the game's destinations, ${toolCall(engine, "computer")} drives that web build live in its own window. Look after every meaningful change and fix what you SEE before finishing; do not finish without at least one frame that shows your change working from the primary camera.`;
  },
  /** The last thing checked before finishing. */
  finish:
    "- Make sure the game still builds and studio::install still answers (state, cameras, capture) — a build that cannot be verified counts as a loss.",
  /** Where randomness and time come from, so the same seed replays the same run. */
  determinism:
    "- Determinism: randomness only from ctx.rng or the seed reset(seed) receives, time only from dt — never rand, GetTime or std::chrono.",
  /** THE FIX's last sentence: replace the mechanism. */
  replace:
    "Replace the mechanism, do not tune it: if it is a shape, rebuild the shape; if it is a material, change the material kind.",
} as const satisfies CompiledFacetLines;

// ── the director ───────────────────────────────────────────────────────────────────────────

/** The director's shape line for a C++ · raylib game: the studio's C++ template, or a game of its own. */
export function cppDirectorShapeLine(ownShape: boolean, shape: NativeBriefShape | null | undefined): string {
  if (!ownShape)
    return `THIS GAME IS ON THE STUDIO'S C++ · RAYLIB TEMPLATE: CMakeLists.txt → ${CPP_ENTRY_MAIN}, src/studio.h is the contract (studio::install, cameras, demos, probes, the FACET WIRING block in main.cpp). Every src/*.cpp is compiled, and the studio builds it for the destinations in studio.json: capture and every judge see that build.`;
  return `THIS GAME HAS ITS OWN SHAPE: entry ${shape?.main ?? CPP_ENTRY_MAIN}, a C++ · raylib game the studio builds with CMake through its own genex.cmake before every look. Keep its entry, its UI and its input handling; studio::install must stay wired so every window, judge and check can see it.\nTHIS IS THE USER'S OWN CODE, NOT THE STUDIO'S TEMPLATE: there is no FACET WIRING block in its entry and no source-per-worker convention to fall back on. Every worker you start here gets a SEAM — owns= with files, folders or a quoted glob — in the structure the game already has; a worker with no seam may edit anything but the entry, the studio runtime and CMakeLists.txt, so start one of those only when nobody else is running, and never two owners of the entry at once.`;
}

/** The session that makes somebody's own C++ game buildable and judgeable: `contractBrief` in C++ terms. */
export function cppContractBrief({
  run,
  projectLabel,
  shape = null,
}: {
  run: BriefRun;
  projectLabel: string;
  shape?: NativeBriefShape | null;
}): string {
  const entryMain = shape?.main ?? CPP_ENTRY_MAIN;
  return [
    `You are making the game "${projectLabel}" judgeable for run ${run.runId}, in an isolated copy of it (this folder). This is your only job: nothing in this game can be looked at, checked or compared until the studio can build it and its entry installs the studio contract.`,
    ``,
    `GAME GOAL (context — not tonight's work): ${run.goal}`,
    ``,
    `THIS GAME HAS ITS OWN SHAPE — it is not the studio's template. It is C++ with raylib; its entry is ${entryMain}. Keep all of it: no second entry, no second build system, do not rewrite the game, do not restyle or "clean up" anything.`,
    ``,
    `DO EXACTLY THIS:`,
    `- ${cppContractWiringAsk(shape)}`,
    `- Capture builds the game through the studio's C++ lane: fix every error the build reports, starting with the first. A build that fails is a black screen for every judge. Never run build/… yourself.`,
    `- Change nothing else. No features, no content, no refactors — the run's builders do that next, and they fork from what you leave here.`,
    `- Do not commit; the studio commits.`,
    ``,
    `YOU HAVE EYES: ${toolCall(roleEngine(run, RoleKey.Builder), "capture")} builds this folder and photographs it. Look before you finish: state() must answer through studio::install, and the game must still look and play exactly as it did.`,
  ].join("\n");
}

/** A single-session worker's lines for a C++ game: its own shape's rule and its eyes. */
export const CPP_WORKER = {
  ownShape: (shape: NativeBriefShape | null | undefined) =>
    `THIS GAME HAS ITS OWN SHAPE: entry ${shape?.main ?? CPP_ENTRY_MAIN}, a C++ · raylib game the studio builds with CMake — capture builds it, so fix what a failed build reports before you finish; keep its entry, UI and input handling; keep studio::install wired. This game is the user's own code: follow the conventions it already has, and do not rename, restyle or reformat anything you did not have to change.`,
  eyes: (run: RoleRun) => {
    const engine = roleEngine(run, RoleKey.Builder);
    return `YOU HAVE EYES: ${toolCall(engine, "capture")} builds this folder through the studio's C++ lane and takes every registered camera at once; a failed build answers with its first error. When Browser is one of the game's destinations, ${toolCall(engine, "computer")} drives that web build live in its own window. Look at what you made before you say it is done; the director will.`;
  },
} as const;

// ── the planner ────────────────────────────────────────────────────────────────────────────

/** The line a raylib night's planner ask opens its C++ rules with; the planner skill's C++ section names it. */
export const CPP_PLANNER_HEADER = "THE GAME IS C++ · RAYLIB";

/** The check kinds whose support on a raylib game is `support` (`RAYLIB_CHECK_SUPPORT`), in the table's order. */
function kindsWith(support: CheckSupport): string[] {
  return Object.entries(RAYLIB_CHECK_SUPPORT)
    .filter(([, value]) => value === support)
    .map(([kind]) => kind);
}

/**
 * What a raylib night's planner is told in the ask itself. The planner's skill is the workspace's
 * own copy and may predate C++ games (SkillOpt edits it, and a seed upgrade keeps an edited copy),
 * so the rules a C++ plan cannot be written without ride here, as the probe grammar does. The
 * measured kinds come from `RAYLIB_CHECK_SUPPORT`, the table the checks themselves obey.
 */
export function cppPlannerLines(): string[] {
  const measured = kindsWith(CheckSupport.Measured).map((kind) => `\`${kind}\``);
  const unmeasured = kindsWith(CheckSupport.Unmeasured).map((kind) => `\`${kind}\``);
  return [
    `${CPP_PLANNER_HEADER} (C++20, raylib 6.0): plan it in C++ terms, whatever JavaScript paths the plan format's example shows.`,
    `- Each facet owns src/<slug>.cpp (and its .h when it shares types). mainOwner alone may restructure ${CPP_ENTRY_MAIN} and ${CPP_RUNTIME}; every other facet adds exactly one line inside the FACET WIRING block of ${CPP_ENTRY_MAIN}: ${CPP_WIRING_LINE}.`,
    "- base.files are the headers every facet shares (src/palette.h, src/world.h), never .js modules.",
    `- Check kinds measured on a raylib game: ${measured.join(", ")}. A ${unmeasured.join(" or ")} check is never measured here: say the same thing with a probe over a probes() leaf (\`houses >= 6\`), milestones included.`,
    '- Tags come from studio::tag("<tag>") just before a draw, the HUD from studio::hud, input from ctx.keys / ctx.look / ctx.wheel / ctx.pointer / ctx.pads, and a demo is an entry in the studio::Game\'s demos.',
  ];
}

// ── the spike ──────────────────────────────────────────────────────────────────────────────

/** Where the spike runner keeps a spike (spike.ts `spikeLocation`): its folder and the recipe file it harvests. */
export interface CppSpikeLocation {
  dir: string;
  recipeFile: string;
}

/**
 * A C++ spike's own CMake project, inside the folder the runner gives the spike (so the spike's
 * ownership covers it) and beside the recipe file the runner harvests: never part of the game's build.
 */
export function cppSpikeLayout(
  location: CppSpikeLocation,
  id: string,
): { dir: string; source: string; cmake: string; recipeFile: string; runtime: string } {
  const dir = `${location.dir}/${id.replace(/[^a-z0-9-]/g, "")}`;
  const runtime = `${"../".repeat(dir.split("/").length)}src`;
  return { dir, source: `${dir}/main.cpp`, cmake: `${dir}/CMakeLists.txt`, recipeFile: location.recipeFile, runtime };
}

/** What a C++ spike's brief is built from: the spike brief's own facts, in C++ terms. */
export interface CppSpikeFacts {
  run: BriefRun;
  spec: { title: string; intent: string };
  /** The one check, already rendered (`renderChecks([check])`). */
  check: string;
  /** The check's camera, when it names one other than the default. */
  camera?: string | null;
  tried: string[];
  recipes: Array<{ recipe: { id: string; title: string; intent: string; sketch?: string } }>;
  id: string;
  /** Where the runner keeps this spike. */
  location: CppSpikeLocation;
}

/**
 * A spike for a C++ · raylib game: a throwaway CMake project in the spike's own folder that proves
 * one technique against one check. It opens with the sentence the census counts a spike by. The
 * runner does not build one yet (spike.ts refuses a raylib spike), so no session reads this today.
 */
export function cppSpikeBrief({
  run,
  spec,
  check,
  camera = null,
  tried,
  recipes,
  id,
  location,
}: CppSpikeFacts): string {
  const layout = cppSpikeLayout(location, id);
  const cameras = `{ default${camera && camera !== "default" ? `, ${camera}` : ""} }`;
  const recipeText = recipes
    .map(
      ({ recipe }) =>
        `### ${recipe.title} (${recipe.id})\n${recipe.intent}${recipe.sketch ? `\n\`\`\`cpp\n${recipe.sketch.trim()}\n\`\`\`` : ""}`,
    )
    .join("\n\n");
  return [
    `You are building a SPIKE inside Autopilot run ${run.runId} — a throwaway mini-scene that proves ONE technique against ONE check, in isolation from the game. Nothing you write here ships; the technique does. This game is C++ with raylib 6.0.`,
    ``,
    `GAME GOAL (context only): ${run.goal}`,
    `FACET (context only): ${spec.title} — ${spec.intent.slice(0, CLIP_BRIEF)}`,
    ``,
    `THE ONE CHECK TO MAKE PASS:`,
    check,
    ``,
    `BUILD EXACTLY THIS:`,
    `- ${layout.cmake}: a CMake project of its own — \`include("\${GENEX_CMAKE}")\` and \`genex_add_game(SOURCES main.cpp)\` — that the game's own CMakeLists.txt never adds (no add_subdirectory). The studio's genex.cmake brings raylib and the flags; nothing is fetched.`,
    `- ${layout.source}: builds ONLY the subsystem the check is about, as a studio::Game handed to studio::install(std::move(game)) — draws tagged with studio::tag, cameras ${cameras} registered in game.cameras — reusing the game's runtime sources by relative path (${layout.runtime}/studio.cpp and the units beside it). Same rules as the game: randomness only from ctx.rng, time only from dt, shaders without a #version line.`,
    `- Do NOT edit src/, CMakeLists.txt or any other file of the game. The spike lives in ${layout.dir}/ only, plus ${layout.recipeFile} and spike/VERDICT.md.`,
    tried.length ? `` : "",
    tried.length
      ? `TECHNIQUES ALREADY TRIED IN THE FACET AND KNOWN TO FAIL THIS CHECK — do not repeat them:\n${tried.map((t) => `- ${t}`).join("\n")}`
      : "",
    recipes.length ? `` : "",
    recipes.length ? `RECIPES THAT MAY APPLY:\n${recipeText}` : "",
    ``,
    `WHEN THE CHECK PASSES, write ${layout.recipeFile} with exactly these sections:`,
    `# <one-line title of the technique>`,
    `## Intent`,
    `<2–5 sentences: what the technique does and why the naive approach fails, with the numbers>`,
    `## Sketch`,
    "```cpp\n<the core of the technique, 10–40 lines, plain raylib>\n```",
    `## Port`,
    `<how to apply it in the facet's own sources: which file, what to tag, what to expose>`,
    ``,
    `WHEN YOU FINISH, write spike/VERDICT.md with ONE line: \`passes\` if the check passes on the spike, or \`unsatisfiable: <why>\` if the check cannot pass as written (a camera that cannot frame the subject, a probe the check misreads, a threshold no scene can hit). The harness reads that file: an honest "unsatisfiable" gets the check re-pointed by the planner; a silent failure costs the facet another iteration.`,
    `Finish with the check passing. If you genuinely cannot make it pass, say so in VERDICT.md and in one line, and stop.`,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

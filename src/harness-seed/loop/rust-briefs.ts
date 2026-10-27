/**
 * What a Rust · wgpu game's agents read: the planner's rules, the base builder's brief, the
 * contract-wiring ask, the chat build's rules and the facet, director and worker lines, each the
 * Rust twin of a C++ text in `native-briefs.ts` and a Three.js text that stay as they were. The
 * facade's API ships read-only in the game folder as `docs/GENEX_API.md`; these lines name only
 * what a plan or a brief cannot be written without.
 *
 * A new module on purpose: a seed upgrade keeps any older module the agent edited, so every name
 * the Rust briefs need lives here, the per-stack selectors (`stackPlannerLines`, `facetLinesFor`)
 * included, and this file imports only names its neighbours had before Rust games
 * (`tests/fixtures/seed-exports-pre-rust.json`) plus the contract's own tables. The parts that
 * branch on it carry `SERVES_RUST`, so a Rust night never runs on a kept copy that speaks only
 * JavaScript or C++.
 */
import { roleEngine, RoleKey, toolCall } from "./model-roles.ts";
import { CPP_FACET, cppPlannerLines } from "./native-briefs.ts";
import { CheckSupport, GameStack, ProjectKind, STACK_CHECK_SUPPORT } from "./native-contract.ts";
import type { AnyRecord, Run } from "../types/harness.d.ts";

// ── which stack a brief is for ─────────────────────────────────────────────────────────────

/** A game's shape as a brief reads it: its entry and what kind of folder it is. */
export interface RustBriefShape {
  main?: string;
  entry?: string;
  build?: string | null;
  kind?: string;
}

/** The entry module of a Rust game the studio scaffolded. */
export const RUST_ENTRY_MAIN = "src/main.rs";
/** The facade's reference in every Rust game folder: read-only to every agent. */
export const RUST_API_DOC = "docs/GENEX_API.md";

/** Is this shape a Rust · wgpu game? The files decide (`kind`), never a file name. */
export function isRustShape(shape: { kind?: unknown } | null | undefined): boolean {
  return shape?.kind === ProjectKind.RustWgpu;
}

/** Is `stack` the Rust · wgpu stack? */
export function isRustStack(stack: unknown): boolean {
  return stack === GameStack.RustWgpu;
}

/** What a Rust game is, in the one sentence every brief opens its Rust rules with. */
const RUST_GAME =
  "This is a Rust game on the studio's genex runtime (wgpu on WebGPU core, Genex Physics, egui for UI), one source for desktop, phones and the web.";

/**
 * The seed upgrade's physics note (shared physics P4): `sim.physics` is Genex Physics now, and raw
 * Rapier still compiles for one release, so a game written before it moves when its physics next
 * changes.
 */
const RUST_PHYSICS_MOVE =
  "Physics moved: sim.physics is Genex Physics (genex::phys, keyed bodies, docs/api/physics.md). Raw Rapier (genex::physics, genex::rapier3d, handles, RigidBodyBuilder) still compiles for one release only: write no new code on it, and when you change an older game's physics, move that game's bodies to sim.physics.spawn and its saves to export_row.";

/** Where a Rust game's build comes from: genex.toml, the studio's lane, never cargo files of its own. */
const RUST_BUILD =
  "There is no Cargo.toml: genex.toml names the game and any extra crate from the reviewed list, and the studio writes the manifest and lock, vendors every crate and builds offline. Never add Cargo.toml, Cargo.lock, build.rs, .cargo/ or `unsafe`.";

// ── facets' module names ───────────────────────────────────────────────────────────────────

/** Names a facet's module may not take: Rust's keywords, and the template's own `game` module. */
const RESERVED_MODULES: ReadonlySet<string> = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "game",
  "gen",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "try",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "yield",
]);

/** A facet id as a Rust module name: lower case, words joined by `_`, never a keyword or a leading digit. */
export function rustFacetSlug(id: string): string {
  const words = id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("_");
  if (!words) return "facet";
  const clashes = /^[0-9]/.test(words) || RESERVED_MODULES.has(words);
  return clashes ? `facet_${words}` : words;
}

/** The module a Rust facet owns when the plan names none. */
function facetModule(id: string): string {
  return `src/facets/${rustFacetSlug(id)}.rs`;
}

/** A non-owner's two lines in the FACET WIRING block of a Rust entry. */
const RUST_WIRING_LINES = '`#[path = "facets/<slug>.rs"] mod <slug>;` and `<slug>::wire(&mut game);`';

// ── the planner ────────────────────────────────────────────────────────────────────────────

/** The line a Rust night's planner ask opens its rules with; the planner skill's Rust section names it. */
export const RUST_PLANNER_HEADER = "THE GAME IS RUST · WGPU";

/** The check kinds whose support on a Rust game is `support` (`STACK_CHECK_SUPPORT`), in the table's order. */
function kindsWith(support: CheckSupport): string[] {
  return Object.entries(STACK_CHECK_SUPPORT[GameStack.RustWgpu])
    .filter(([, value]) => value === support)
    .map(([kind]) => `\`${kind}\``);
}

/**
 * What a Rust night's planner is told in the ask itself. The planner's skill is the workspace's
 * own copy and may predate Rust games (SkillOpt edits it, and a seed upgrade keeps an edited copy),
 * so the rules a Rust plan cannot be written without ride here. The measured kinds come from
 * `STACK_CHECK_SUPPORT`, the table the checks themselves obey.
 */
export function rustPlannerLines(): string[] {
  const measured = kindsWith(CheckSupport.Measured);
  const unmeasured = kindsWith(CheckSupport.Unmeasured);
  return [
    `${RUST_PLANNER_HEADER} (Rust 2024 on the studio's genex runtime: wgpu, Genex Physics, egui): plan it in Rust terms, whatever JavaScript paths the plan format's example shows.`,
    `- Each facet owns src/facets/<slug>.rs (a Rust module name: lower case, words joined by _) with \`pub fn wire(game: &mut Game<super::World>)\` and its own state through game.facet_state::<T>(). mainOwner alone may restructure ${RUST_ENTRY_MAIN}, src/game.rs and genex.toml; every other facet adds exactly two lines inside the FACET WIRING block of ${RUST_ENTRY_MAIN}: ${RUST_WIRING_LINES}.`,
    `- base.files are the Rust modules every facet shares (the World type in src/game.rs, named colours and constants beside it), never .js modules. ${RUST_API_DOC} is read-only.`,
    `- Check kinds measured on a Rust game: ${measured.join(", ")}. A ${unmeasured.join(" or ")} check is never measured here: say the same thing with a probe over a game.probe leaf (\`houses >= 6\`), milestones included.`,
    '- Tags come from frame.tag("<tag>") before a draw in on_draw, the HUD from egui in on_ui (checks find a widget by its label), input from ctx.keys / ctx.touches / ctx.pointer / ctx.look / ctx.pads, and a demo is a game.demo entry. Touch is first-class: every action a player needs is reachable without a keyboard.',
  ];
}

// ── the contract wiring ────────────────────────────────────────────────────────────────────

/**
 * The one job that makes a Rust game buildable and judgeable: `genex::install(game)` at the end of
 * `main()` over a `Game` whose hooks are this game's own. The Rust twin of `contractWiringAsk`.
 */
export function rustContractWiringAsk(shape: { main?: string } | null | undefined): string {
  const entryMain = shape?.main ?? RUST_ENTRY_MAIN;
  return `End main() in ${entryMain} with \`genex::install(game)\` over a \`Game::new(World::default())\` whose on_update, on_draw and camera are this game's own (\`use genex::prelude::*;\`), and keep genex.toml naming the game. ${RUST_BUILD} That is the whole ask: the runtime owns the window, the loop, the clock, the GPU and the verbs the studio steps, inspects and captures through; this game's update, draw and camera are the parts it cannot guess.`;
}

// ── the base builder ───────────────────────────────────────────────────────────────────────

/** What the base builder is told about the plan: its facets and the shared base they fork from. */
export interface RustBasePlan {
  base?: { files?: Array<{ path: string; purpose?: string }>; notes?: string } | null;
  facets?: Array<{ id: string; title?: string; owns?: string[]; identity?: string[]; cameras?: string[] }>;
  integrationNotes?: string;
}

/** The run as a brief reads it. */
type BriefRun = Pick<Run, "goal" | "reference" | "engine" | "builderEngine"> & { runId?: string };
type BriefFacets = NonNullable<RustBasePlan["facets"]>;
/** The run as a tool sentence reads it: whichever engine plays the builder. */
type RoleRun = Parameters<typeof roleEngine>[0];

/** `capture` and `computer` as a Rust game's builders read them. */
function eyesSentence(run: RoleRun, what: string): string {
  const engine = roleEngine(run, RoleKey.Builder);
  return `${toolCall(engine, "capture")} builds ${what} through the studio's Rust lane for the game's judging destination and takes every registered camera at once; a failed build answers with its first compiler error, which is the one to fix. When Browser is one of the game's destinations, ${toolCall(engine, "computer")} drives that web build live in its own window.`;
}

/** The base builder's brief for a Rust · wgpu game: `baseBrief` in Rust terms, the same roll call and rules. */
export function rustBaseBrief({
  run,
  plan,
  projectLabel,
  shape = null,
  ownShape = false,
  setup = null,
}: {
  run: BriefRun;
  plan: RustBasePlan;
  projectLabel: string;
  shape?: RustBriefShape | null;
  ownShape?: boolean;
  setup?: AnyRecord | null;
}): string {
  const facets = plan.facets ?? [];
  if (!ownShape && facets.length === 0) return rustStartingScene(run, projectLabel, setup);
  return [
    ...baseHeader(run, plan, projectLabel),
    ``,
    `ALWAYS, whatever the notes say:`,
    ...(ownShape ? rustOwnShapeRules(shape) : rustTemplateRules(facets)),
    `- game.probe(name, |sim| json!(…)) reports what the facets will need (player position, counts per group), one small JSON leaf per mechanic.`,
    cameraRule(facets),
    ownShape
      ? `- The game already exists and works. Add only the contract wiring and the shared structure the facets need; do not remove, restyle or "clean up" what is there.`
      : `- The new project is empty. Add only shared structure required by this specific game. Do not add a demo scene, generic player model, pickups, grid, score or HUD. Empty facet hooks and empty frames are valid at this stage; the build, the verbs and camera placement must still work. Each facet draws its own visible content from the brief.`,
    `- The game must still build for every destination in studio.json and genex::install must keep answering. Do not build facet content — scaffolding only. Do not commit; the studio commits.`,
    ``,
    `YOU HAVE EYES: ${eyesSentence(run, "this folder")} Look before you finish: a base nobody can see is a base nobody can build on.`,
    ...(setup ? [requestedStateLine(setup)] : []),
  ].join("\n");
}

/** A director's night from scratch on a Rust game: one visible, working first version. */
function rustStartingScene(run: BriefRun, projectLabel: string, setup: AnyRecord | null): string {
  const engine = roleEngine(run, RoleKey.Builder);
  return [
    `You are building the starting scene for "${projectLabel}". Goal: ${run.goal}`,
    run.reference?.name ? `Direction: ${run.reference.name}.` : "",
    `Complete one visible, working first version now. Preserve the user's intended scene/game; later workers can enrich detail. Include the goal's main subject, a suitable setting, lighting and a camera that frames it. Do not spend this stage designing a large framework.`,
    `${RUST_GAME} Read ${RUST_ENTRY_MAIN} and src/game.rs first, then edit them. ${RUST_API_DOC} is the whole API the game is written against: read it for a specific question, never edit it. ${RUST_BUILD}`,
    `Integration guide: build the Game in ${RUST_ENTRY_MAIN} and keep genex::install(game) at the end of main(). Load models once in on_reset through gfx.assets().model("…") from assets/. Name what you draw with frame.tag("name") just before drawing it in on_draw. game.camera returns the framing view; register named views with game.named_camera. Keep the FACET WIRING markers for later edits.`,
    `Input/UI API when the goal needs it: on_update(sim, ctx) is one fixed 1/60 s tick and reads input only from ctx — ctx.keys by DOM code (Key::KeyW, Key::Space, Key::ArrowUp), ctx.touches (the mouse's first button arrives as touch 0, so one touch path serves desktop and phone), ctx.pointer, ctx.look, ctx.pads. Draw all UI with egui in on_ui: one egui point is one world pixel, y down, and a widget's label is how checks find it. Randomness only from ctx.rng or the reset rng; time only from ctx.tick and ctx.dt; transcendental math from genex::math; genex::Map and genex::Set instead of HashMap and HashSet — never std::time, threads or thread_rng. For a scene without gameplay, omit input and UI.`,
    `Do not invent helpers or controls you have not implemented. Make the requested subject visible with frame.cube, frame.sphere and frame.model first, lit and coloured: a flat grey placeholder is a defect (models from assets/ through gfx.assets().model(..), or procedural shapes).`,
    `After writing, call ${toolCall(engine, "capture")}: it builds this folder for its destination through the studio's Rust lane and photographs it. Fix a failed build's first error, then fix what you see. The host commits and validates your changes. No git commit is needed.`,
    setup ? `Requested inspection state: ${JSON.stringify(setup)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Who the base builder is, the goal and direction, the facets that fork from it, and the plan's notes. */
function baseHeader(run: BriefRun, plan: RustBasePlan, projectLabel: string): string[] {
  const facets = plan.facets ?? [];
  const files = plan.base?.files ?? [];
  const who = run.runId ? `run ${run.runId}` : "this run";
  const many = facets.length > 0;
  const count = many ? `${facets.length} facets are` : "Builders are";
  const fork = many ? "be built in parallel, each in" : "work on this game, each with";
  const seams = many ? "facets" : "them";
  const notes = run.reference?.notes ? ` — ${run.reference.notes}` : "";
  const header = `You are the BASE BUILDER for ${who} on the game "${projectLabel}". ${count} about to ${fork} its own copy of this folder. Before they fork, create the shared base they all build on — so the seams between ${seams} are code, not prose. ${RUST_GAME}`;
  return [
    header,
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

/** The rules for a Rust game that came with its own shape: keep it, keep the contract, let the studio build it. */
function rustOwnShapeRules(shape: RustBriefShape | null | undefined): string[] {
  const entryMain = shape?.main ?? RUST_ENTRY_MAIN;
  return [
    `- THIS GAME HAS ITS OWN SHAPE — it is not the studio's template. Its entry is ${entryMain} and the studio builds it from genex.toml for the destinations in studio.json. Keep that: no second entry, no cargo files, do not rewrite it in another language, keep its UI and input handling.`,
    `- ${rustContractWiringAsk(shape)} Register the cameras the facets name with game.named_camera, on the same Game.`,
    `- Do NOT impose the studio template's structure on this game: no marker block in the entry for builders to add lines to, no empty per-builder hook added to its hooks, no shared module invented to hold them. Builders here are given a seam in the code this game already has — a file, a folder or a glob — and they wire their work in the way this game already wires things.`,
    `- The studio builds the game before every preview: capture shows you that build, and a failed one answers with its first error. Fix every error it reports before you finish — a build that fails is a black screen for every critic.`,
  ];
}

/** The rules for the studio's Rust template: the wiring block, a module per facet, a shared world. */
function rustTemplateRules(facets: BriefFacets): string[] {
  const wiring = `keeps the FACET WIRING block (two lines per builder: ${RUST_WIRING_LINES} — the studio union-merges that block, so it is where parallel work meets)`;
  const parts = facets.length ? "Each facet" : "Each part the goal names";
  const tag = facets.length ? "<facet id>" : "<part>";
  return [
    `- ${RUST_ENTRY_MAIN} builds the Game, ${wiring}, and ends with genex::install(game). ${parts} gets a module in src/facets/ whose wire(game) registers its hooks — its on_update, its on_draw under frame.tag("${tag}"), its probes — which run in registration order.`,
    `- src/game.rs holds the World type every facet reads as super::World, with the named colours, scale constants and the player spawn point every facet must share.`,
  ];
}

/** Which camera views the base registers: the facets' own, or a default plus one per part. */
function cameraRule(facets: BriefFacets): string {
  if (facets.length)
    return `- Register distinct, working camera views with game.named_camera for the cameras the facets name: ${[...new Set(facets.flatMap((f) => f.cameras ?? []))].join(", ")}.`;
  return `- Register distinct, working camera views: game.camera framing the game as a player sees it, plus one game.named_camera per part the goal names. Every judge and every check looks through them.`;
}

/** The state the run is about, which the base's cameras must be registered against. */
function requestedStateLine(setup: AnyRecord): string {
  const how = setup.note ?? (setup.demo ? `demo "${setup.demo}"` : `${(setup.actions ?? []).length} input action(s)`);
  const equals = setup.verify && "equals" in setup.verify ? ` == ${JSON.stringify(setup.verify.equals)}` : "";
  const verified = setup.verify ? `, verified by ${setup.verify.path}${equals}` : "";
  return `THE REQUESTED STATE: this run is about a state the game does not boot into — the studio replays a setup script after every load (${how})${verified}. Register the facets' cameras against THAT state (the map, the mode, the scene the goal names), and keep the way a player reaches it working — do not change what the game boots into.`;
}

// ── the chat build ─────────────────────────────────────────────────────────────────────────

/** The determinism rule every Rust builder reads, in the words the studio's build enforces. */
const RUST_DETERMINISM =
  "randomness only from ctx.rng or the reset rng, time only from ctx.tick and ctx.dt, transcendental math from genex::math, genex::Map and genex::Set instead of HashMap and HashSet; never std::time, threads or thread_rng";

/** The chat build's first rule for a Rust game the studio scaffolded: the Rust twin of `TEMPLATE_RULE`. */
export const RUST_TEMPLATE_RULE = `Follow CLAUDE.md in the workspace root: keep genex::install(game) at the end of main in ${RUST_ENTRY_MAIN} and its FACET WIRING block, write only against ${RUST_API_DOC} (read-only), keep gameplay deterministic (${RUST_DETERMINISM}), and let the studio build: ${RUST_BUILD} Capture builds this folder for its destination through the studio's own lane and answers with the first compiler error when a build fails. Models come from assets/ through gfx.assets().model(..), procedural code, or the currently enabled plugin tools. Follow the selected tool's returned file paths and verification guidance. ${RUST_PHYSICS_MOVE}`;

/** What a chat build of a fresh Rust workspace is told about where it starts. */
export const RUST_FRESH_WORKSPACE = "This is a fresh workspace scaffolded from the studio's Rust · wgpu template.";

/** The rules for a Rust game that came with its own shape, as a chat build reads them. */
export function rustOwnShapeChatRules(shape: RustBriefShape | null | undefined, contractMissing = false): string[] {
  const main = shape?.main ?? RUST_ENTRY_MAIN;
  return [
    ...(contractMissing
      ? [
          `FIRST, BEFORE THE ASK: ${main} never reaches genex::install, so the studio cannot build-check, step, inspect or capture this game — not you, not a night's judges. ${rustContractWiringAsk(shape)} Change nothing else about the game while you do it. Then do what was asked.`,
        ]
      : []),
    `This game came with its own shape — the studio did not write it. Its entry is ${main}; the studio builds it from genex.toml for the destinations in studio.json, and capture shows that build. Follow CLAUDE.md in the workspace root. Keep its structure, its screen and its input handling as they are, and keep genex::install(game) where its entry calls it. Do not replace this game's randomness or its clock with the template's — this is the user's own code, not the studio's scaffold.`,
    "A failed build answers capture with its first error: fix that first.",
    RUST_PHYSICS_MOVE,
  ];
}

// ── the facet builder ──────────────────────────────────────────────────────────────────────

/** The lines a compiled game's facet builder reads: the C++ and Rust twins of `facet/prompt.ts`'s Three.js lines. */
export interface CompiledFacetLines {
  /** A facet's own source when the plan names none. */
  module: (id: string) => string;
  /** Where a worker's own work goes in a game the user brought. */
  seam: (owned: string | null) => string;
  /** Where a facet's work goes in the studio's template. */
  files: (owned: string) => string;
  /** The entry and the runtime are this worker's. */
  ownsEntry: (entryMain: string) => string;
  /** The entry of a game the user brought is not this worker's. */
  notOwnEntry: (entryMain: string) => string;
  /** The template's entry is not this facet's, bar its wiring lines. */
  wiringOnly: (entryMain: string) => string;
  /** The demo a behavioural facet exposes, as a sentence and as a rule. */
  demoAsk: string;
  demo: string;
  /** How what a facet draws becomes visible to the checks. */
  tag: string;
  /** The one-screen, one-input-path rule, with the harness-owned checks that enforce it. */
  oneScreen: (enforced: string) => string;
  /** A game the user brought: keep its screen, its input and the contract. */
  ownShape: (entryMain: string) => string;
  /** The last build never reached verification. */
  failure: string;
  /** The builder's eyes on its own worktree. */
  eyes: (run: RoleRun) => string;
  /** The last thing checked before finishing. */
  finish: string;
  /** Where randomness and time come from, so the same seed replays the same run. */
  determinism: string;
  /** THE FIX's last sentence: replace the mechanism. */
  replace: string;
  /** How far past the facade a facet may reach (the extension ladder); a stack without one has none. */
  ladder?: string;
}

/** The files of a Rust game no facet edits: the entry's surroundings and the facade's reference. */
const RUST_HOST_FILES = `genex.toml and ${RUST_API_DOC}`;
/** The demo a behavioural Rust facet exposes. */
const RUST_DEMO_ASK =
  "If this facet is behavioural (an interaction, a move, a beat), expose a deterministic demo of it via the studio contract (a game.demo entry registered in its wire) — demo checks run it and photograph its end frame.";

/** The facet builder's lines for a Rust · wgpu game: the Rust twins of `CPP_FACET`. */
export const RUST_FACET = {
  module: facetModule,
  seam: (owned: string | null) =>
    `- YOUR SEAM: ${owned ?? `every file of this game except its entry, ${RUST_HOST_FILES}`}. It is the user's own code — read what is around your seam before you change anything, follow the conventions the game already has, and do not rename, restyle or reformat a file you did not have to change.`,
  files: (owned: string) =>
    `- YOUR FILES: put this facet's work in its own module — ${owned}, with \`pub fn wire(game: &mut Game<super::World>)\` and its own state through game.facet_state::<T>() (split further into private items of that module if it grows).`,
  ownsEntry: (entryMain: string) =>
    `- This worker OWNS ${entryMain}, src/game.rs and genex.toml — you may restructure them, and you wire in other workers' modules when they appear. ${RUST_API_DOC} stays read-only.`,
  notOwnEntry: (entryMain: string) =>
    `- This worker does NOT own ${entryMain} or ${RUST_HOST_FILES}. If your work needs a change in one of them, say so in your summary and leave it: the director makes that edit, or gives it to whoever owns the entry.`,
  wiringOnly: (entryMain: string) =>
    `- This facet does NOT own ${entryMain}, src/game.rs or ${RUST_HOST_FILES}. Touch ${entryMain} ONLY to add your two wiring lines inside the "FACET WIRING" marker block (${RUST_WIRING_LINES}; add the marker block if it is missing); never reformat or reorganise anything else.`,
  demoAsk: RUST_DEMO_ASK,
  demo: `- ${RUST_DEMO_ASK}`,
  tag: `- Tag every draw you add (frame.tag("<tag>") just before it) with the tag names the checks use. Untagged draws do not exist to the checks.`,
  oneScreen: (enforced: string) =>
    `- ONE SCREEN, ONE INPUT PATH: all UI with egui in on_ui (one egui point is one world pixel; give every widget its visible label, which is how checks find it); all input from ctx.keys / ctx.touches / ctx.pointer / ctx.look / ctx.pads inside on_update (the runtime owns the window, the cursor and the clock). Touch is first-class: the mouse's first button is touch 0, so write one touch path, keep tap targets large and give every action a way to reach it without a keyboard.${enforced}`,
  ownShape: (entryMain: string) =>
    `- THIS GAME HAS ITS OWN SHAPE: its entry is ${entryMain} and the studio builds it from genex.toml for the destinations in studio.json. Keep its UI and input handling as they are — no second UI path, no second input path. Keep genex::install answering in ${entryMain}. Capture builds it: fix a failed build's first error before anything else.`,
  failure:
    "That is a failure report, not a design verdict. Fix that cause first — the same cause twice ends this facet. Deliver a build that compiles for its destination and keeps genex::install answering.",
  eyes: (run: RoleRun) =>
    `YOU HAVE EYES — USE THEM: ${eyesSentence(run, "YOUR worktree (uncommitted edits included)")} Look after every meaningful change and fix what you SEE before finishing; do not finish without at least one frame that shows your change working from the primary camera.`,
  finish:
    "- Make sure the game still builds and genex::install still answers (state, cameras, capture) — a build that cannot be verified counts as a loss.",
  determinism: `- Determinism: ${RUST_DETERMINISM}. The studio's build refuses them.`,
  replace:
    "Replace the mechanism, do not tune it: if it is a shape, rebuild the shape; if it is a material, change the material kind.",
  ladder:
    "- MORE THAN THE FACADE: climb the extension ladder in CLAUDE.md one level at a time (your own modules, WGSL, custom GPU passes, then request_crate) and stop at the lowest that works. Never add `unsafe` or a build script; only the person ejects the engine or trusts a game. In an ejected game, run check_conformance after every engine/ change.",
} as const satisfies CompiledFacetLines;

// ── the director ───────────────────────────────────────────────────────────────────────────

/** The director's shape line for a Rust · wgpu game: the studio's Rust template, or a game of its own. */
export function rustDirectorShapeLine(ownShape: boolean, shape: RustBriefShape | null | undefined): string {
  if (!ownShape)
    return `THIS GAME IS ON THE STUDIO'S RUST · WGPU TEMPLATE: genex.toml → ${RUST_ENTRY_MAIN}, ${RUST_API_DOC} is the contract (genex::install, cameras, demos, probes, the FACET WIRING block in main.rs, a module per facet in src/facets/). The studio builds it for the destinations in studio.json: capture and every judge see that build.`;
  return `THIS GAME HAS ITS OWN SHAPE: entry ${shape?.main ?? RUST_ENTRY_MAIN}, a Rust · wgpu game the studio builds from genex.toml before every look. Keep its entry, its UI and its input handling; genex::install must stay wired so every window, judge and check can see it.\nTHIS IS THE USER'S OWN CODE, NOT THE STUDIO'S TEMPLATE: there is no FACET WIRING block in its entry and no module-per-worker convention to fall back on. Every worker you start here gets a SEAM — owns= with files, folders or a quoted glob — in the structure the game already has; a worker with no seam may edit anything but the entry and ${RUST_HOST_FILES}, so start one of those only when nobody else is running, and never two owners of the entry at once.`;
}

/** The session that makes somebody's own Rust game buildable and judgeable: `contractBrief` in Rust terms. */
export function rustContractBrief({
  run,
  projectLabel,
  shape = null,
}: {
  run: BriefRun;
  projectLabel: string;
  shape?: RustBriefShape | null;
}): string {
  const entryMain = shape?.main ?? RUST_ENTRY_MAIN;
  return [
    `You are making the game "${projectLabel}" judgeable for run ${run.runId}, in an isolated copy of it (this folder). This is your only job: nothing in this game can be looked at, checked or compared until the studio can build it and its entry installs the studio contract.`,
    ``,
    `GAME GOAL (context — not tonight's work): ${run.goal}`,
    ``,
    `THIS GAME HAS ITS OWN SHAPE — it is not the studio's template. It is Rust on the studio's genex runtime; its entry is ${entryMain}. Keep all of it: no second entry, no cargo files, do not rewrite the game, do not restyle or "clean up" anything.`,
    ``,
    `DO EXACTLY THIS:`,
    `- ${rustContractWiringAsk(shape)}`,
    `- Capture builds the game through the studio's Rust lane: fix every error the build reports, starting with the first. A build that fails is a black screen for every judge.`,
    `- Change nothing else. No features, no content, no refactors — the run's builders do that next, and they fork from what you leave here.`,
    `- Do not commit; the studio commits.`,
    ``,
    `YOU HAVE EYES: ${toolCall(roleEngine(run, RoleKey.Builder), "capture")} builds this folder and photographs it. Look before you finish: state() must answer through genex::install, and the game must still look and play exactly as it did.`,
  ].join("\n");
}

/** A single-session worker's lines for a Rust game: its own shape's rule and its eyes. */
export const RUST_WORKER = {
  ownShape: (shape: RustBriefShape | null | undefined) =>
    `THIS GAME HAS ITS OWN SHAPE: entry ${shape?.main ?? RUST_ENTRY_MAIN}, a Rust · wgpu game the studio builds from genex.toml — capture builds it, so fix what a failed build reports before you finish; keep its entry, UI and input handling; keep genex::install wired. This game is the user's own code: follow the conventions it already has, and do not rename, restyle or reformat anything you did not have to change.`,
  eyes: (run: RoleRun) =>
    `YOU HAVE EYES: ${eyesSentence(run, "this folder")} Look at what you made before you say it is done; the director will.`,
} as const;

// ── per stack ──────────────────────────────────────────────────────────────────────────────

/** Each compiled kind's facet lines: raylib's and Rust's; a Three.js game reads `facet/prompt.ts`'s own. */
const FACET_LINES_OF_KIND: Readonly<Record<string, CompiledFacetLines>> = {
  [ProjectKind.RaylibCpp]: CPP_FACET,
  [ProjectKind.RustWgpu]: RUST_FACET,
};

/** The facet lines a game of this kind reads, or null for a Three.js game (or a kind this seed does not know). */
export function facetLinesFor(kind: unknown): CompiledFacetLines | null {
  if (typeof kind !== "string" || !Object.hasOwn(FACET_LINES_OF_KIND, kind)) return null;
  return FACET_LINES_OF_KIND[kind] ?? null;
}

/** Each stack's planner rules, carried in the ask: none for a Three.js game, whose skill is its own. */
const PLANNER_LINES_OF_STACK = {
  [GameStack.ThreeJs]: () => [],
  [GameStack.RaylibCpp]: cppPlannerLines,
  [GameStack.RustWgpu]: rustPlannerLines,
} as const satisfies Record<GameStack, () => string[]>;

/** Is `stack` one this seed knows? */
function isKnownStack(stack: unknown): stack is GameStack {
  return Object.values<unknown>(GameStack).includes(stack);
}

/**
 * The planner rules a night on `stack` carries in its ask (director.ts `playbookFor`, autopilot.ts's
 * planner ask): Rust's for a Rust · wgpu night, C++'s for a raylib night, none otherwise.
 */
export function stackPlannerLines(stack: unknown): string[] {
  return isKnownStack(stack) ? PLANNER_LINES_OF_STACK[stack]() : [];
}

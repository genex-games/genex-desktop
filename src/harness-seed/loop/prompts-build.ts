/**
 * Briefs more than one mode builds from: the base builder's (the classic pipeline's shared base,
 * and the starting point a director's run from scratch builds first) and the one sentence that
 * makes somebody's own game judgeable (the base builder's own-shape bullet, and the director's
 * `installContract`). They lived in autopilot.ts, so the director imported the whole classic
 * pipeline to reach them; autopilot.ts still exports both, for harness files that import them
 * from there.
 */
import { roleEngine, RoleKey, toolCall } from "./model-roles.ts";
import { scopeLines } from "./scope-prompts.ts";
import type { AnyRecord, Run } from "../types/harness.d.ts";

/**
 * The one job that makes somebody's own game judgeable: its entry loads the studio contract, so
 * every window, judge and check can see the game at all. The base builder's own-shape bullet is
 * this sentence, and so is the step a director's run takes first when the game arrived without
 * it (director.ts `contractBrief`) — one wording, because the two are the same task.
 */
export function contractWiringAsk(shape: { main?: string } | null | undefined): string {
  const entryMain = shape?.main ?? "src/main.js";
  return `Add the two lines to ${entryMain} (or a module it imports): \`import { installStudio } from "./studio.js"\` — the contract module the studio keeps in src/, with its types in src/studio.d.ts beside it — and \`installStudio({ renderer, player })\` with this game's real renderer and a player() locator, once the renderer exists. Two lines is the whole ask: the studio's own code is already on the page and finds the scene, the camera and the frames from what the game draws; the renderer and the player are the two it cannot guess.`;
}

/**
 * The base builder's brief. The classic pipeline knows its facets by name here; a director's
 * run does not — it plans as it goes — so a plan with no facets asks for the same starting
 * point in the same words, minus the roll call.
 */
/** What the base builder is told about the plan: its facets and the shared base they fork from. */
export interface BasePlan {
  base?: { files?: Array<{ path: string; purpose?: string }>; notes?: string } | null;
  facets?: Array<{ id: string; title?: string; owns?: string[]; identity?: string[]; cameras?: string[] }>;
  integrationNotes?: string;
}

/** What the base builder is told about the game's shape: its entry, its page and its build. */
type BriefShape = { main?: string; entry?: string; build?: string | null } | null;
/** The run as the base brief reads it. */
type BriefRun = Pick<Run, "goal" | "reference" | "engine" | "builderEngine"> & { runId?: string; scope?: unknown };
/** The base plan's facets. */
type BriefFacets = NonNullable<BasePlan["facets"]>;

export function baseBrief({
  run,
  plan,
  projectLabel,
  shape = null,
  ownShape = false,
  setup = null,
}: {
  run: BriefRun;
  plan: BasePlan;
  projectLabel: string;
  shape?: BriefShape;
  ownShape?: boolean;
  setup?: AnyRecord | null;
}): string {
  const facets = plan.facets ?? [];
  if (!ownShape && facets.length === 0) return startingSceneBrief(run, projectLabel, setup);
  return [
    ...baseHeader(run, plan, projectLabel),
    ``,
    `ALWAYS, whatever the notes say:`,
    ...(ownShape ? ownShapeRules(shape) : templateRules(facets)),
    `- probes() reports what the facets will need (player position, counts per group).`,
    cameraRule(facets),
    ownShape
      ? `- The game already exists and works. Add only the contract wiring and the shared structure the facets need; do not remove, restyle or "clean up" what is there.`
      : `- The new project is empty. Add only shared structure required by this specific game. Do not add a demo scene, generic player mesh, pickups, grid, score or HUD. Empty facet groups and empty renders are valid at this stage; runtime, inspection, and camera placement must still work. Each facet creates its own visible content from the brief.`,
    `- The game must still load and window.__studio must work. Do not build facet content — scaffolding only. Do not commit; the studio commits.`,
    ``,
    `YOU HAVE HANDS AND EYES: ${toolCall(roleEngine(run, RoleKey.Builder), "computer")} runs this folder's build live in its own window (its own description lists every action), and ${toolCall(roleEngine(run, RoleKey.Builder), "capture")} takes every registered camera at once. Look before you finish: a base nobody can see is a base nobody can build on.`,
    ...(setup ? [requestedStateLine(setup)] : []),
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

/**
 * A director's run from scratch: a crude playable skeleton of what the user asked for, and no roll
 * call. It reads the user's scope, so the skeleton has the shape the user asked for (a circuit,
 * not a straight sprint, for a race of laps).
 */
function startingSceneBrief(run: BriefRun, projectLabel: string, setup: AnyRecord | null): string {
  return [
    `You are building the starting scene for "${projectLabel}". Goal: ${run.goal}`,
    scopeLines({ scope: run.scope }),
    run.reference?.name ? `Direction: ${run.reference.name}.` : "",
    `Build one visible, working first version now — a crude playable skeleton, not a finished level: the shape the user asked for (SCOPE, when it is above) at its scale, the goal's main subject, a suitable setting, lighting and a camera that frames it. Preserve the user's intended scene/game; later workers own each part's real content. Do not spend this stage designing a large framework.`,
    `Read src/main.js first, then edit it. Read docs/CONTRACT.md only for a specific unanswered API question. src/studio.js is existing host instrumentation: use its public API; do not study or rewrite its implementation. index.html already supplies the Three.js import map.`,
    `Integration guide: keep import { installStudio } from "./studio.js" and the existing renderer resize handler. Add your THREE objects to scene; tag important objects with obj.userData.tag. Set camera.position and camera.lookAt to frame visible objects. Define cameras.default() with that same framing; it is called by reset.`,
    `Keep installStudio({canvas:renderer.domElement, scene, renderer, camera, input:{pointerLock:false}, reset(){cameras.default()}, update(dt){/* optional animation */}, render(){renderer.render(scene,camera)}, probes(){return {phase:"scene",drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles}}, cameras}). Studio drives update/render: no separate animation loop. Keep the FACET WIRING markers for later edits.`,
    `Input/UI API when the goal needs it: update(dtSeconds, ctx) receives ctx.keys (Set of KeyboardEvent.code strings such as "Space" and "KeyW"), ctx.look and ctx.wheel. const api = installStudio(config) returns synchronously; AFTER that call, api.hud.text("title", "Your title", {x:0.05,y:0.05,size:24,color:"#ffffff"}) draws text in the captured canvas. HUD x/y are fractions of the frame. Update a score with the same text id. The HUD also draws arcs for gauges, rounded panels, SVG paths, images and bundled fonts — api.hud.arc("speed", {anchor:"bottom-right", x:0.03, y:0.05, r:0.08, fraction:0.4}) — anchored to a frame corner, with lengths in fractions of the frame's height; keep the middle of the view for the scene. Declare state and renderStats before installStudio, and never call HUD functions before installation. For a scene without gameplay, omit score/input/UI.`,
    `Do not invent helpers or controls you have not implemented. Make the requested subject visible using Three.js geometry and materials first. Use Blender only when needed for the goal; preserve the requested final quality as work for later stages.`,
    `After writing, use computer to reload and inspect the actual scene, fix console errors or bad framing, then finish with what you observed. The host commits and validates your changes. No git commit is needed.`,
    setup ? `Requested inspection state: ${JSON.stringify(setup)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Who the base builder is, the goal and direction, the facets that fork from it, and the plan's notes. */
function baseHeader(run: BriefRun, plan: BasePlan, projectLabel: string): string[] {
  const facets = plan.facets ?? [];
  const files = plan.base?.files ?? [];
  const who = run.runId ? `run ${run.runId}` : "this run";
  const many = facets.length > 0;
  const count = many ? `${facets.length} facets are` : "Builders are";
  const fork = many ? "be built in parallel, each in" : "work on this game, each with";
  const seams = many ? "facets" : "them";
  const notes = run.reference?.notes ? ` — ${run.reference.notes}` : "";
  return [
    `You are the BASE BUILDER for ${who} on the game "${projectLabel}". ${count} about to ${fork} its own copy of this folder. Before they fork, create the shared base they all build on — so the seams between ${seams} are code, not prose.`,
    ``,
    `GAME GOAL: ${run.goal}`,
    run.reference?.name ? `REFERENCE / DIRECTION: ${run.reference.name}${notes}` : "",
    ``,
    many ? `FACETS THAT WILL FORK FROM YOUR WORK:` : "",
    ...facets.map(
      (f) =>
        `- ${f.id}: ${f.title} — owns ${f.owns?.length ? f.owns.join(", ") : `src/${f.id}.js`}; identity: ${f.identity?.join(", ") || "n/a"}`,
    ),
    ``,
    plan.integrationNotes ? `INTEGRATION NOTES (the shared contract): ${plan.integrationNotes}` : "",
    plan.base?.notes ? `BASE NOTES: ${plan.base.notes}` : "",
    files.length ? `FILES TO CREATE:\n${files.map((f) => `- ${f.path} — ${f.purpose}`).join("\n")}` : "",
  ];
}

/** The rules for a game that came with its own shape: keep it, wire the contract in, run its build. */
function ownShapeRules(shape: BriefShape): string[] {
  const entryMain = shape?.main ?? "src/main.js";
  const builtWith = shape?.build ? `, its page is built with \`${shape.build}\`` : "";
  return [
    `- THIS GAME HAS ITS OWN SHAPE — it is not the studio's template. Its entry is ${entryMain}${builtWith} and the studio serves ${shape?.entry ?? "index.html"}. Keep that: no second entry, do not replace index.html, do not rewrite the game in plain JS, keep its UI and input handling.`,
    `- ${contractWiringAsk(shape)} Register the cameras the facets name through config.cameras, in the same call.`,
    // Said as a prohibition, because the template's answer to "where do parallel builders
    // meet" is a marker block and a group per facet, and imposing either on a game that
    // already has its own structure is how a run rewrites somebody's architecture.
    `- Do NOT impose the studio template's structure on this game: no marker block in the entry for builders to add import lines to, no empty per-builder container added to the scene, no shared module invented to hold them. Builders here are given a seam in the code this game already has — a file, a folder or a glob — and they wire their work in the way this game already wires things.`,
    ...(shape?.build
      ? [
          `- Run \`${shape.build}\` yourself before you finish and fix every error it reports — the studio runs the same build before every preview, and a build that fails is a black screen for every critic.`,
        ]
      : []),
  ];
}

/** The rules for the studio's template: the wiring block, a group per facet, and a shared palette. */
function templateRules(facets: BriefFacets): string[] {
  return [
    facets.length
      ? `- src/main.js passes scene, renderer and camera to installStudio (plus an actual player() locator if this game needs one), keeps the FACET WIRING block, and creates one empty tagged THREE.Group per facet (group.userData.tag = "<facet id>") added to the scene, exported from src/world.js so each facet fills its own group.`
      : `- src/main.js passes scene, renderer and camera to installStudio (plus an actual player() locator if this game needs one), keeps the FACET WIRING block (one import + one init line per builder — the studio union-merges that block, so it is where parallel work meets), and exports from src/world.js one empty tagged THREE.Group per part the goal names (group.userData.tag = "<part>"), added to the scene.`,
    `- src/palette.js exports the named colours, scale constants and the player spawn point every facet must share.`,
  ];
}

/** Which camera views the base registers: the facets' own, or a default plus one per part. */
function cameraRule(facets: BriefFacets): string {
  if (facets.length)
    return `- Register distinct, working camera views for the cameras the facets name: ${[...new Set(facets.flatMap((f) => f.cameras ?? []))].join(", ")}.`;
  return `- Register distinct, working camera views through config.cameras: "default" framing the game as a player sees it, plus one per part the goal names. Every judge and every check looks through them.`;
}

/** How the setup script names the state it replays: its note, its demo, or its input actions. */
function setupLabel(setup: AnyRecord): string {
  return setup.note ?? replayedSteps(setup);
}

/** A setup script without a note: the demo it runs, or how many input actions it replays. */
function replayedSteps(setup: AnyRecord): string {
  if (setup.demo) return `demo "${setup.demo}"`;
  return `${(setup.actions ?? []).length} input action(s)`;
}

/** The state the run is about, which the base's cameras must be registered against. */
function requestedStateLine(setup: AnyRecord): string {
  const equals = setup.verify && "equals" in setup.verify ? ` == ${JSON.stringify(setup.verify.equals)}` : "";
  const verified = setup.verify ? `, verified by ${setup.verify.path}${equals}` : "";
  return `THE REQUESTED STATE: this run is about a state the game does not boot into — the studio replays a setup script after every load (${setupLabel(setup)})${verified}. Register the facets' cameras against THAT state (the map, the mode, the scene the goal names), and keep the way a player reaches it working — do not change what the game boots into.`;
}

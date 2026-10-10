/**
 * Named developer fixtures: what a `studio:dev` fixture profile holds before its window opens
 * ({@link prepareFixture}) and what it adds once the window is up ({@link activateChatFixture}).
 * Each fixture's seed lives in its own `fixture-*.ts` module; this one picks them. The one seed
 * the core must find already there, the plugin-updates fixture's older plugins, is re-exported.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { COVER_FAMILIES, pickCoverLook } from "../../shared/cover-recipe.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind, SnapshotScope } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import type { StudioCore } from "../studio-core.ts";
import { seedLargeBuildGraph } from "./fixture-large-graph.ts";
import { seedBuildGraph } from "./fixture-build-graph.ts";
import { activateLiveChat, activatePlanReviews, seedChatFeedback, seedChatHistory } from "./fixture-chat.ts";
import { hasLandedLoopRun, seedFirstLoopRun, seedLandedLoopRun } from "./fixture-history.ts";
import {
  appendSuggestion,
  FIXTURE_MODEL,
  FIXTURE_VERSION,
  FixtureName,
  fixtureRun,
  isChatFixture,
  isFixtureName,
} from "./fixture-kit.ts";
import { NOTIFICATIONS_START_MS, notificationArrivals, seedNotificationGames } from "./fixture-notifications.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { StopReason } from "../../shared/engine-requests.ts";

/** Why a fixture cannot be seeded. */
const MESSAGE = {
  unknownFixture: (id: string) => `unknown fixture ${id}`,
} as const;

export { FIRST_LAUNCH_STATUS, fixtureEngines } from "./fixture-engines.ts";
export { installOlderPlugins } from "./fixture-plugin-updates.ts";
export {
  DevProviders,
  FIXTURE_NAMES,
  FIXTURE_SANDBOX_PROBLEM,
  FIXTURE_UPDATE_RELEASE,
  FIXTURE_VERSION,
  FixtureName,
  isChatFixture,
} from "./fixture-kit.ts";

/** Fixtures whose game carries a build history. */
const HISTORY_FIXTURES: ReadonlySet<string> = new Set([
  FixtureName.BuildHistory,
  FixtureName.RunControls,
  FixtureName.Sentinel,
  FixtureName.StudioActivity,
]);
/** Events that push prior runs out of the renderer's bootstrap tail. */
const NOISE_EVENTS = 650;
/** How long a scripted improvement pass takes, so its progress can be seen. */
const IMPROVEMENT_PASS_MS = 1500;

/** The fixture game's page: a canvas that counts clicks, on the studio's own import map. */
const FIXTURE_PAGE = `<!doctype html><html><body style="margin:0;background:#14233b;color:white"><canvas width="800" height="500"></canvas>
<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
<script>
const c=document.querySelector('canvas'),x=c.getContext('2d');let clicks=0;
function draw(){x.fillStyle='#14233b';x.fillRect(0,0,800,500);x.fillStyle='#43ddaa';x.fillRect(80+clicks*10,80,160,160);x.fillStyle='white';x.font='28px sans-serif';x.fillText('AG-933 deterministic game',70,340)}
window.__studio={state:()=>({fixture:1,clicks,phase:'playing'}),inspect:()=>({fixture:1}),capture:()=>c.toDataURL('image/png')};window.addEventListener('pointerdown',()=>{clicks++;draw()});draw();</script></body></html>`;

/** What a prepared fixture opens on. */
export interface PreparedFixture {
  project: string;
  threadId: string;
  fixture: string;
  version: number;
}

/** The fixture game and its thread; `existing` when a reused profile already had it. */
interface FixtureGame {
  core: StudioCore;
  id: FixtureName;
  project: { name: string; dir: string };
  threadId: string;
  existing: boolean;
}

export async function prepareFixture(core: StudioCore, id: string): Promise<PreparedFixture> {
  if (!isFixtureName(id)) throw new Error(MESSAGE.unknownFixture(id));
  // First launch keeps the library empty: no game, no chat, nothing remembered.
  if (id === FixtureName.FirstLaunch)
    return { project: "", threadId: core.mainThread, fixture: id, version: FIXTURE_VERSION };
  // Reuse never resets a project's files or append-only history.
  const found = (await core.games.list()).find((p) => p.name === "fixture-game");
  const project = found ?? (await core.games.scaffold("fixture-game", { title: "Fixture Game" }));
  const game: FixtureGame = {
    core,
    id,
    project,
    threadId: await core.threadForGame(project.name),
    existing: Boolean(found),
  };
  if (!game.existing) await writeFixtureGame(game);
  await seedHistory(game);
  await seedForFixture(game);
  return { project: project.name, threadId: game.threadId, fixture: id, version: FIXTURE_VERSION };
}

/**
 * The fixture stands in for a game on the studio's own shape, so its page keeps the studio
 * import map: shape detection reads that map (with studio.json's contractVersion) as the one
 * proof a folder is the template's rather than somebody's own game.
 */
async function writeFixtureGame(game: FixtureGame): Promise<void> {
  await fs.writeFile(path.join(game.project.dir, "index.html"), FIXTURE_PAGE);
  if (HISTORY_FIXTURES.has(game.id)) await seedFirstLoopRun(game.core, game.project.name, game.threadId);
}

/**
 * A lead's run that landed its build. It is seeded per run, not per project: a profile made
 * before this run existed is reused (and restarted) as often as it is made, and must still
 * show the card.
 */
async function seedHistory(game: FixtureGame): Promise<void> {
  if (!HISTORY_FIXTURES.has(game.id)) return;
  if (await hasLandedLoopRun(game.core, game.threadId)) return;
  await seedLandedLoopRun(game.core, game.project.name, game.threadId);
}

/** The seed of each fixture that has one of its own. */
async function seedForFixture(game: FixtureGame): Promise<void> {
  const { core, id, existing, threadId } = game;
  if (id === FixtureName.BuildGraph) return seedGraphOnce(game);
  if (id === FixtureName.LargeBuildGraph) return seedLargeBuildGraph(core, game.project.name, threadId);
  if (id === FixtureName.Sidebar) return seedSidebar(core, game.project.name);
  // The rest seed a fresh profile only; a reused one keeps what it has.
  if (existing) return;
  if (id === FixtureName.StudioActivity) return seedStudioActivity(core, threadId);
  if (id === FixtureName.Notifications) return seedNotificationGames(core);
  if (isChatFixture(id)) return seedChatHistory(core, game.project, threadId);
  if (id === FixtureName.ChatFeedback) return seedChatFeedback(core, game.project.name, threadId);
}

async function seedGraphOnce(game: FixtureGame): Promise<void> {
  const seeded = (await game.core.store.listEvents(game.threadId)).some(
    (e) => e.data.type === EventKind.Custom && (e.data.payload as { runId?: string })?.runId === "fixture-graph-run",
  );
  if (!seeded) await seedBuildGraph(game.core, game.project.name, game.threadId);
}

/** Another game with a long goal, enough noise to age the history, and SkillOpt's record. */
async function seedStudioActivity(core: StudioCore, threadId: string): Promise<void> {
  const other = await core.games.scaffold("fixture-ashlands", { title: "Ashlands walk" });
  const otherThread = await core.threadForGame(other.name);
  const goal =
    "Build a first-person walkable volcanic landscape with towering mushroom trees, a carved stone shrine, drifting ash and hazy blue-green distance fog. ".repeat(
      9,
    );
  const run = fixtureRun({ runId: "fixture-long-run", project: other.name });
  await core.append(
    [
      run(CustomEvent.RunStarted, { engine: EngineId.ClaudeCode, model: FIXTURE_MODEL, goal }),
      run(CustomEvent.RunFinished, { goal, landed: false, stoppedBecause: StopReason.Deadline, durationMs: 600000 }),
    ],
    otherThread,
  );
  await core.append(
    Array.from({ length: NOISE_EVENTS }, () =>
      customEventData(CustomEvent.FixtureNoise, { note: "Makes prior runs older than the bootstrap tail" }),
    ),
    threadId,
  );
  await core.append([
    customEventData(CustomEvent.SkilloptAccepted, {
      skill: "facet-decomposition",
      approvedBy: "auto",
      rationale: "Keep ownership boundaries explicit when splitting a game into parallel tasks.",
      gate: { reason: "Instruction comparison passed. Future builds have not been evaluated." },
    }),
    customEventData(CustomEvent.SkilloptPass, { tasks: 8, accepted: 1, staged: 1, rejected: 2 }),
    {
      type: EventKind.WorkspaceRestored,
      scope: SnapshotScope.Harness,
      snapshot_id: "fixture-recovery",
      reason: "Fixture recovery after a missed heartbeat; this record does not restore any files.",
    },
  ]);
  await stageSuggestions(core);
}

/** Two staged suggestions waiting in Activity. */
async function stageSuggestions(core: StudioCore): Promise<void> {
  const currentText = await fs.readFile(path.join(core.layout.harnessWs, "skills/facet-decomposition.md"), "utf8");
  const directorText = await fs.readFile(path.join(core.layout.harnessWs, "skills/director.md"), "utf8");
  const gate = (votes: string) => ({
    accept: true,
    votes,
    reason: "Synthetic instruction comparison for UI acceptance.",
  });
  await core.store.writeArtifact(core.mainThread, "skillopt_staged", [
    {
      ...appendSuggestion(
        "facet-decomposition",
        currentText,
        // One long line, as real suggestions are: the exact edit must wrap it, never scroll sideways.
        "Fixture review: judge on-screen markers from eye:here as well as from the default camera, and when a request says something vague like slightly thicker or a bit brighter, turn it into a measured target in the check before the facet starts.",
      ),
      rationale: "The trajectories repeat overlay markers judged only from the default camera.",
      title: "Check the player’s view before finishing a scene",
      summary: [
        "Checks on-screen markers from the player’s own eyes, not just the overview camera.",
        "Turns vague requests like “slightly thicker” into a measured target.",
      ],
      gate: gate("3/3 for the candidate"),
      at: new Date().toISOString(),
    },
    {
      ...appendSuggestion("director", directorText, "Fixture review: preserve ownership boundaries."),
      rationale: "Make each task’s ownership explicit before work starts.",
      gate: gate("2/3 for the candidate"),
      at: new Date(Date.now() + 1).toISOString(),
    },
  ]);
}

const SIDEBAR_TITLES = [
  "Lunar garden",
  "Neon drift",
  "A quiet fishing village",
  "Snowbound temple",
  "Desert kingdom",
  "Orbit racer",
  "Glass cathedral",
  "Midnight arcade",
  "Forest courier",
  "Blue horizon",
  "Ruins in the clouds",
  "A very long game name that should truncate without hiding its actions",
  "Лунный лес",
  "Coastal road",
  "After the rain",
  "Copper valley",
  "Paper moon",
  "Last train",
];

/** Two legacy custom GLSL covers, compiled through the real host compiler (rows 1 and 2). */
const SIDEBAR_SHADERS: Record<number, string> = {
  1: "float bend=sin(p.x*2.0+time*0.42)*0.7+sin(p.y*1.7-time*0.5)*0.35; float wave=sin(p.y*2.7-p.x*1.4+bend+time*0.6); vec3 color=mix(vec3(0.15,0.06,0.31),vec3(0.52,0.39,0.76),smoothstep(-0.7,0.5,wave)); return mix(color,vec3(0.8,0.76,0.94),smoothstep(0.5,1.0,wave)*0.85);",
  2: "vec2 center=vec2(sin(time*0.45)*0.38,cos(time*0.55)*0.32); float heat=1.0-smoothstep(0.05,1.3,length(p.xy-center)); float sweep=sin(p.y*1.8+p.x*1.5-time*0.55)*0.5+0.5; vec3 color=mix(vec3(0.30,0.10,0.28),vec3(0.92,0.40,0.36),heat); return mix(color,vec3(1.0,0.78,0.47),heat*heat*sweep);",
};

/** A long library for the sidebar: every cover family once, one pinned game, two custom shaders. */
async function seedSidebar(core: StudioCore, project: string): Promise<void> {
  for (let n = 0; n < SIDEBAR_TITLES.length; n++) {
    const name = `sidebar-${n}`;
    if ((await core.games.list()).some((game) => game.name === name)) continue;
    await core.games.scaffold(name, { title: SIDEBAR_TITLES[n] });
    await core.threadForGame(name);
    // Every family appears once, in its first look; two rows keep legacy custom GLSL covers through
    // the real host compiler.
    const family = COVER_FAMILIES[n % COVER_FAMILIES.length];
    if (!family) continue;
    const look = pickCoverLook([], { family }, () => 0);
    await core.games.update(name, {
      cover: { kind: "recipe", ...look, seed: (n * 97) % 997, placeholder: true },
      pinned: n === 0,
    });
    const shader = SIDEBAR_SHADERS[n];
    if (shader && core.options.renderGameCover)
      await core.api()["game.setCoverShader"]({ project: name, surface: shader });
  }
  await core.games.touch(project);
}

export async function activateChatFixture(
  core: StudioCore,
  fixture: { fixture: string; threadId: string; project: string },
) {
  if (fixture.fixture === FixtureName.Notifications) {
    // After the window has read its first feed, so these arrive as news: one every half second.
    setTimeout(
      () => void notificationArrivals(core).catch((error) => console.error("Notification fixture failed", error)),
      NOTIFICATIONS_START_MS,
    );
    return;
  }
  if (fixture.fixture === FixtureName.ChatFeedback) {
    await activatePlanReviews(core);
    return;
  }
  if (isChatFixture(fixture.fixture)) await activateLiveChat(core, fixture);
}

/** Fixture sessions park real improvement passes; a manual check in Studio still shows its whole result. */
export async function fixtureImprovementPass(core: StudioCore): Promise<void> {
  await sleep(IMPROVEMENT_PASS_MS);
  const currentText = await fs.readFile(path.join(core.layout.harnessWs, "skills/facet-decomposition.md"), "utf8");
  const staged = ((await core.store.readArtifact(core.mainThread, "skillopt_staged")) ?? []) as unknown[];
  staged.push({
    ...appendSuggestion(
      "facet-decomposition",
      currentText,
      "Fixture review: keep the last fifth of a run for playing and tuning difficulty.",
    ),
    rationale: "Balance tuning was repeatedly left to the final unplaytested minutes.",
    title: "Leave time to tune difficulty",
    summary: ["Keeps the last part of each run for playing and tuning, instead of rushing it at the end."],
    gate: {
      accept: true,
      votes: "3/3 for the candidate",
      reason: "Synthetic instruction comparison for UI acceptance.",
    },
    at: new Date().toISOString(),
  });
  await core.store.writeArtifact(core.mainThread, "skillopt_staged", staged);
  await core.append([customEventData(CustomEvent.SkilloptPass, { tasks: 6, staged: 1, accepted: 0, rejected: 1 })]);
}

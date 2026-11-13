/**
 * The design-board fixture: a game whose agent laid its design out on the Design tab, and the chat
 * that asked for it, with the block of the artboard the agent showed. The board is the kind an
 * agent makes: a pitch page at its top, a World section of large pictures with a map page, a
 * Systems section with the core loop, and a picture the person dropped (`from-you`). The pages are
 * HTML and CSS only, built with Genex's own variables; the pictures are the app's own backdrops.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { DESIGN_DROPS, DESIGN_FOLDER } from "../../shared/design-board.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import type { StudioCore } from "../studio-core.ts";

const ASK = "A dark action game with a lantern. Show me the design before you build anything.";
const REPLY =
  "The pitch, the first places and the core loop are on Design. Tell me what to change, or say build and I'll start.";

/** Where the built app keeps its own pictures, beside the bundle this runs from. */
const APP_MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "media");

/** The board's pictures: each file below the design folder, and the app picture it is a copy of. */
const PICTURES: Readonly<Record<string, string>> = {
  "world/01-hollowmere.jpg": "home-backdrop-realm.jpg",
  "world/02-the-high-fires.jpg": "home-backdrop-campfire.jpg",
  "world/03-the-cloud-sea.jpg": "home-backdrop-clouds.jpg",
  [`${DESIGN_DROPS}/neon-street.jpg`]: "home-backdrop-city.jpg",
};

/** What every page of the fixture's board shares: its sheet and its small parts, in Genex's variables. */
const PAGE_STYLE = `
  * { box-sizing: border-box; margin: 0; }
  body { padding: 64px 72px; display: flex; flex-direction: column; gap: 40px; }
  header { display: flex; align-items: baseline; justify-content: space-between; }
  h1 { font-size: 44px; line-height: 52px; font-weight: 600; letter-spacing: -0.02em; }
  h2 { font-size: 20px; line-height: 28px; font-weight: 600; }
  time, .label { font: 13px var(--genex-mono); color: var(--genex-ink-3); }
  p, li { color: var(--genex-ink-2); }
  .card { padding: 24px; border-radius: var(--genex-radius); background: var(--genex-inset); }
`;

const PITCH = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lanternfall: the pitch</title>
<style>${PAGE_STYLE}
  .lead { font-size: 28px; line-height: 38px; color: var(--genex-ink); max-width: 880px; }
  .pillars { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .pillars p { margin-top: 6px; font-size: 16px; line-height: 24px; }
  footer { display: flex; gap: 10px; }
  .quiet { background: var(--genex-inset); color: var(--genex-ink); }
</style>
</head>
<body>
<header><h1>Lanternfall</h1><time>13 Nov 2026</time></header>
<p class="lead">You carry the last lantern through a drowned kingdom. Its light is your health, and it is running out.</p>
<section class="pillars">
  <div class="card"><h2>Light is life</h2><p>Every swing costs a little of it.</p></div>
  <div class="card"><h2>Fires are a bargain</h2><p>They heal you, and wake what you killed.</p></div>
  <div class="card"><h2>One road</h2><p>No map screen. The town is the map.</p></div>
</section>
</body>
</html>
`;

const MAP = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hollowmere: the map</title>
<style>${PAGE_STYLE}
  .map { position: relative; }
  .map img { display: block; width: 100%; height: 520px; object-fit: cover; }
  .pin { position: absolute; width: 36px; height: 36px; border-radius: 18px; background: var(--genex-accent); color: #fff;
    font: 15px/36px var(--genex-mono); text-align: center; }
  ol { list-style: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  li b { display: block; color: var(--genex-ink); font-weight: 600; }
</style>
</head>
<body>
<header><h1>Hollowmere</h1><span class="label">The first ten minutes</span></header>
<div class="map">
  <img src="01-hollowmere.jpg" alt="A swordsman stands in a misty village square">
  <span class="pin" style="left: 6%; top: 62%">1</span>
  <span class="pin" style="left: 47%; top: 70%">2</span>
  <span class="pin" style="left: 52%; top: 16%">3</span>
</div>
<ol>
  <li class="card"><b>1 · The gate</b>Where you wake. Two minutes of quiet.</li>
  <li class="card"><b>2 · The well</b>Your first fire, and your first choice.</li>
  <li class="card"><b>3 · The tower</b>The boss door. Reached by minute ten.</li>
</ol>
</body>
</html>
`;

const CORE_LOOP = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The core loop</title>
<style>${PAGE_STYLE}
  ol { list-style: none; display: grid; gap: 12px; max-width: 760px; }
  li { display: flex; align-items: center; gap: 20px; font-size: 22px; line-height: 30px; color: var(--genex-ink); }
  li i { flex: none; width: 40px; height: 40px; border-radius: 20px; background: var(--genex-bg);
    font: normal 16px/40px var(--genex-mono); text-align: center; color: var(--genex-ink-2); }
  li span { margin-left: auto; font: 15px var(--genex-mono); color: var(--genex-ink-3); }
</style>
</head>
<body>
<header><h1>The core loop</h1><span class="label">About three minutes</span></header>
<ol>
  <li class="card"><i>1</i>Explore a street<span>2 min</span></li>
  <li class="card"><i>2</i>Fight what the light wakes<span>40 s</span></li>
  <li class="card"><i>3</i>Rest at a fire<span>20 s</span></li>
  <li class="card"><i>4</i>Choose the next street<span>10 s</span></li>
</ol>
<p>A run is eight loops.</p>
</body>
</html>
`;

/** The fixture's pages: each file below the game's design folder. */
const PAGES: Readonly<Record<string, string>> = {
  "01-pitch.html": PITCH,
  "world/04-map.html": MAP,
  "systems/01-core-loop.html": CORE_LOOP,
};

/** A message of the fixture's chat. */
const said = (role: "user" | "assistant", content: string): EventData => ({
  type: EventKind.Messages,
  messages: [{ role, content }],
});

/**
 * The fixture game's board in its folder, and the chat that made it: the ask, the block of the
 * artboard the agent showed and its reply. A picture the app's own media folder lacks is left out.
 */
export async function seedDesignBoard(
  core: StudioCore,
  game: { name: string; dir: string },
  threadId: string,
): Promise<void> {
  const board = path.join(game.dir, ...DESIGN_FOLDER.split("/"));
  for (const [below, text] of Object.entries(PAGES)) {
    const file = path.join(board, ...below.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  for (const [below, source] of Object.entries(PICTURES)) {
    const file = path.join(board, ...below.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(path.join(APP_MEDIA, source), file).catch(() => {});
  }
  const shown = { project: game.name, file: `${DESIGN_FOLDER}/01-pitch.html`, title: "Lanternfall: the pitch" };
  await core.append(
    [
      said("user", ASK),
      customEventData(CustomEvent.DesignShown, { ...shown, note: "The pitch, three places and the loop" }),
      said("assistant", REPLY),
    ],
    threadId,
  );
}

/**
 * The fixture game's agent at work on the board, once the window is up, through the same calls
 * `show_design` makes: it offers the three places to pick among, says it is making a fourth place
 * and a character's model, and points at a spot of the first place with what it changed there.
 */
export async function designAgentArrivals(core: StudioCore, project: string): Promise<void> {
  const world = (name: string): string => `${DESIGN_FOLDER}/world/${name}`;
  await core.design.offer(project, ["01-hollowmere.jpg", "02-the-high-fires.jpg", "03-the-cloud-sea.jpg"].map(world));
  core.design.making(project, [world("05-the-drowned-gate.jpg"), `${DESIGN_FOLDER}/characters/the-keeper.glb`]);
  await core.design.show(project, world("01-hollowmere.jpg"), {
    note: "Moved the well next to the gate",
    spot: "38,72",
  });
}

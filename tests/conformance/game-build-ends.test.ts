/**
 * What the game list says about a game's builds and its multiplayer: New game's game waits for its
 * first build until an answer in one of its chats ends with the game made, and stays built after;
 * a game turns multiplayer on through Genex's package, in its package.json or its page's import map.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { type EventData, EventKind } from "../../src/shared/event-log.ts";
import { GENEX_GAME_PACKAGES } from "../../src/shared/genex.ts";
import { withGenexSdkImport } from "../../src/shared/genex-page.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { ProjectStarter } from "../../src/shared/project-facts.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const MULTIPLAYER = "@genex-ai/multiplayer";

let lite: CoreLite;
/** The games the core told the game list changed, in order. */
const changed: string[] = [];
/** Who waits on what the game list is told: woken by each change it hears of. */
const listening = new Set<() => void>();
/** How long a test waits at most for the game list to be told, in real time. */
const TOLD_WITHIN_MS = 10_000;
before(async () => {
  lite = await coreLite({
    onUiEvent: (event) => {
      if (event.type !== UiEvent.GameChanged) return;
      changed.push(String((event.payload as { project?: unknown }).project));
      for (const wake of [...listening]) wake();
    },
  });
});
after(() => lite.close());

const listed = async (name: string): Promise<GameProject> => {
  const game = (await lite.core.games.list()).find((row) => row.name === name);
  assert.ok(game, `${name} is listed`);
  return game;
};

/** A sent message answered by a turn of its own, as the chat's queue writes it. */
const answered = (messageId: string): EventData[] => [
  { type: EventKind.Messages, messages: [{ role: "user", content: "make a kite racing game" }] },
  customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
  { type: EventKind.Messages, messages: [{ role: "assistant", content: "Here it is." }] },
  customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
];

/** Waits until `seen` holds, woken by what the game list is told, never by a count of ticks; at most `TOLD_WITHIN_MS`. */
async function untilTold(seen: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + TOLD_WITHIN_MS;
  for (;;) {
    // A change told while `seen` was reading is not waited for again: it is looked at once more.
    const told = changed.length;
    if ((await seen()) || Date.now() >= deadline) break;
    if (changed.length !== told) continue;
    // Each wait's own timer goes once it is woken, so no timer outlives the test.
    const woken = new AbortController();
    let wake = (): void => {};
    const next = new Promise<void>((resolve) => {
      wake = resolve;
    });
    listening.add(wake);
    const late = delay(deadline - Date.now(), undefined, { signal: woken.signal }).catch(() => {});
    await Promise.race([next, late]);
    woken.abort();
    listening.delete(wake);
  }
  return seen();
}

/** Waits for the game list to say `name`'s first build is in, or fails. */
async function builtSoon(name: string): Promise<GameProject> {
  await untilTold(async () => !(await listed(name)).awaitingFirstBuild);
  return listed(name);
}

describe("a game's first build", () => {
  it("New game's game waits for its first build; a game from a folder never does", async () => {
    const made = await lite.core.createGame("Kite Waiting");
    assert.equal((await listed(made.name)).awaitingFirstBuild, true);
    const scaffolded = await lite.core.games.scaffold("kite-folder");
    assert.equal((await listed(scaffolded.name)).awaitingFirstBuild, undefined, "a folder's own game was built");
  });

  it("an answer that left the game with no kind yet is no build", async () => {
    const game = await lite.core.createGame("Kite Talk");
    const threadId = await lite.core.threadForGame(game.name);
    await lite.core.append(answered("first-build-talk"), threadId);
    await nextTurn();
    assert.equal((await listed(game.name)).awaitingFirstBuild, true, "a question answered built nothing");
  });

  it("an answer that ended with the game made is its first build, told to the game list and kept after", async () => {
    const game = await lite.core.createGame("Kite Built");
    const threadId = await lite.core.threadForGame(game.name);
    await lite.core.games.start(game.name, ProjectStarter.Web);
    await writeFile(path.join(game.dir, "src", "main.js"), "// the first build\n");
    changed.length = 0;
    await lite.core.append(answered("first-build-made"), threadId);
    assert.equal((await builtSoon(game.name)).awaitingFirstBuild, undefined);
    assert.ok(changed.includes(game.name), "the game list is told");
    await writeFile(path.join(game.dir, "src", "main.js"), "");
    await lite.core.append(answered("first-build-again"), threadId);
    await nextTurn();
    assert.equal((await listed(game.name)).awaitingFirstBuild, undefined, "built once stays built");
  });

  it("an answer in another chat of the game counts too", async () => {
    const game = await lite.core.createGame("Kite Elsewhere");
    await lite.core.games.start(game.name, ProjectStarter.Web);
    const other = await lite.core.store.createThread({ title: "Second chat" });
    await lite.core.bindThreadToProject(other, game.name);
    await lite.core.append(answered("first-build-other"), other);
    assert.equal((await builtSoon(game.name)).awaitingFirstBuild, undefined);
  });
});

describe("a game that is already multiplayer", () => {
  it("a game's package.json naming Genex's multiplayer makes it multiplayer", async () => {
    const game = await lite.core.games.scaffold("kite-package");
    assert.equal((await listed(game.name)).multiplayer, undefined, "a template game starts single-player");
    const pkg = { name: "kite", dependencies: { [MULTIPLAYER]: GENEX_GAME_PACKAGES[MULTIPLAYER] } };
    await writeFile(path.join(game.dir, "package.json"), JSON.stringify(pkg));
    assert.equal((await listed(game.name)).multiplayer, true);
  });

  it("a template page mapping Studio's multiplayer makes it multiplayer; player identity alone does not", async () => {
    const game = await lite.core.games.scaffold("kite-page");
    const page = path.join(game.dir, "index.html");
    const html = await readFile(page, "utf8");
    const identity = withGenexSdkImport(html, "@genex-ai/embed-sdk");
    assert.ok(identity);
    await writeFile(page, identity);
    assert.equal((await listed(game.name)).multiplayer, undefined, "sign-in is not multiplayer");
    const multiplayer = withGenexSdkImport(html, MULTIPLAYER);
    assert.ok(multiplayer);
    await writeFile(page, multiplayer);
    assert.equal((await listed(game.name)).multiplayer, true);
  });

  it("an answer that made the game multiplayer tells the game list, and one that changed nothing does not", async () => {
    const game = await lite.core.createGame("Kite Together");
    const threadId = await lite.core.threadForGame(game.name);
    await lite.core.games.start(game.name, ProjectStarter.Web);
    await writeFile(path.join(game.dir, "src", "main.js"), "// the first build\n");
    await lite.core.append(answered("together-built"), threadId);
    await builtSoon(game.name);
    const page = path.join(game.dir, "index.html");
    const multiplayer = withGenexSdkImport(await readFile(page, "utf8"), MULTIPLAYER);
    assert.ok(multiplayer);
    await writeFile(page, multiplayer);
    changed.length = 0;
    await lite.core.append(answered("together-made"), threadId);
    assert.ok(await untilTold(() => changed.includes(game.name)), "the game list is told it is multiplayer now");
    changed.length = 0;
    await lite.core.append(answered("together-again"), threadId);
    for (let tries = 0; tries < 20; tries++) await nextTurn();
    assert.equal(changed.includes(game.name), false, "nothing changed, nothing told");
  });
});

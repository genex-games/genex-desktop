/**
 * The native-review fixture (mockups C1, C2, C5): a library of five games on Genex, each where Genex's
 * review left it, and the news of it arriving once the window is up.
 *
 * - The fixture game is Midnight Asphalt, its Mac app live; a moderator takes the whole game down for
 *   three things to fix (it waits in the bell, the Dock counts it, its Publish carries a red dot).
 * - Skate Dog's Windows app is with a person at Genex, who reviews it because the creator asked.
 * - Stick & Steel's Mac app goes live; Lost Cathedral, a web game, is public again after a takedown a
 *   person lifted (the toast while Midnight Asphalt is open).
 * - The Long Silence's Mac app is being checked, sent a few minutes before.
 *
 * Each game's publish record, the apps it sent and Genex's review are laid down in the Genex plugin's
 * storage as the plugin keeps them, and what the host already told is kept with them, so the sidebar's
 * lines read them as a real profile does (`core/genex-review-lines.ts`). The chats hold what was told
 * before; the changes arrive as `genex_review` records after the window read its first feed
 * (`NOTIFICATIONS_START_MS`), so the bell rings, the Dock counts, a toast shows and macOS is told while
 * Studio is in the background. A fixture profile asks Genex nothing (`genexReviewReads: false`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ALL_COVER_LOOKS } from "../../shared/cover-recipe.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import { GENEX_PLUGIN_ID, GenexBuildReview, GenexHostedStatus } from "../../shared/genex.ts";
import {
  GenexAppReview,
  GenexDecider,
  GenexHumanReview,
  type GenexReviewApp,
  GenexReviewChange,
  type GenexReviewPayload,
  type GenexReviewRecord,
  type GenexTakedown,
  gameReviewOf,
  reviewFingerprint,
  reviewKeys,
} from "../../shared/genex-review.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { StudioCore } from "../studio-core.ts";

/** One change every this long once the news starts: each can be watched arriving. */
const ARRIVAL_GAP_MS = 1500;
const SHA = "3f9a21c0".padEnd(64, "0");
const THINGS = [
  {
    text: "The “Get 5,000 coins” button opens an outside payment page",
    where: "Garage → Get coins",
    rule: "Off-platform payment",
  },
  { text: "Loads code from another website (unpkg.com)", where: "src/main.js:3", rule: "Unreviewable remote code" },
  { text: "Sets a cookie before the player agrees", where: "index.html · on load", rule: "Privacy" },
];

/** A game of the fixture: its name in the library, its title, its link on Genex. */
interface ReviewGame {
  name: string;
  title: string;
  slug: string;
}

/**
 * The fixture's other games on Genex; the fixture game itself is Midnight Asphalt. Each link is the
 * one the Play fixture lists the game under, so a live card's Open lands on the game's page in Play.
 */
const SKATE: ReviewGame = { name: "review-skate", title: "Skate Dog", slug: "skate-dog" };
const STICK: ReviewGame = { name: "review-stick", title: "Stick & Steel", slug: "stick-steel" };
const CATHEDRAL: ReviewGame = { name: "review-cathedral", title: "Lost Cathedral", slug: "lost-cathedral" };
const SILENCE: ReviewGame = { name: "review-silence", title: "The Long Silence", slug: "the-long-silence" };

/** An app as Genex's review holds it. */
function appOf(platform: string, state: GenexAppReview, at: string, more: Partial<GenexReviewApp> = {}) {
  const decided = state === GenexAppReview.Live ? { decidedAt: at, decidedBy: GenexDecider.Check } : {};
  return {
    platform,
    arch: platform === "mac" ? "universal" : "x64",
    state,
    version: "1.2.0",
    sha256: SHA,
    sentAt: at,
    ...decided,
    things: [],
    humanReview: { state: GenexHumanReview.None, canRequest: false },
    ...more,
  };
}

const recordOf = (apps: GenexReviewApp[], takedown: GenexTakedown | null = null): GenexReviewRecord => ({
  state: gameReviewOf(apps, takedown),
  apps,
  takedown,
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** What a game keeps in the Genex plugin's storage: its publish record, the apps it sent, Genex's review. */
async function layDown(
  core: StudioCore,
  game: ReviewGame,
  record: GenexReviewRecord,
  status: GenexHostedStatus,
): Promise<void> {
  const dir = path.join(core.pluginServices.root(GENEX_PLUGIN_ID), "publish", game.name);
  await mkdir(path.join(dir, ".genex"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, ".genex", "project.json"), json({ id: `fixture-${game.slug}`, slug: game.slug }));
  const publish = { version: 1, project: game.name, connected: true, slug: game.slug, title: game.title, status };
  await writeFile(path.join(dir, "publish.json"), json(publish));
  const sent = record.apps.map((app) => ({
    platform: app.platform,
    arch: app.arch,
    version: app.version,
    sizeBytes: 1,
    sha256: app.sha256,
    publishedAt: app.sentAt,
    review: app.state === GenexAppReview.Live ? GenexBuildReview.Approved : GenexBuildReview.Pending,
  }));
  if (sent.length > 0) await writeFile(path.join(dir, "native.json"), json({ jobId: "fixture-job", sent, failed: [] }));
  const told = { fingerprint: reviewFingerprint(record), keys: reviewKeys(record) };
  const checkedAt = new Date().toISOString();
  const kept = { checkedAt, source: "review", record, fingerprint: told.fingerprint, told, failures: 0 };
  await writeFile(path.join(dir, "review.json"), json({ ...kept, signedOut: false }));
}

/** A library game of the fixture, with a cover and its chat. */
async function scaffold(core: StudioCore, game: ReviewGame, n: number): Promise<void> {
  await core.games.scaffold(game.name, { title: game.title });
  await core.threadForGame(game.name);
  const look = ALL_COVER_LOOKS[(n * 11 + 3) % ALL_COVER_LOOKS.length];
  if (look)
    await core.games.update(game.name, {
      cover: { kind: "recipe", ...look, seed: (n * 173) % 997, placeholder: true },
    });
}

/** A `genex_review` record of a game. */
const told = (game: ReviewGame, change: GenexReviewChange, at: string, more: Partial<GenexReviewPayload> = {}) =>
  customEventData(CustomEvent.GenexReview, {
    project: game.name,
    slug: game.slug,
    title: game.title,
    change,
    ...more,
    at,
  });

/** The five games where Genex's review left them, their chats holding what was told before. */
export async function seedNativeReview(core: StudioCore, project: string, threadId: string): Promise<void> {
  const now = Date.now();
  const iso = (ago: number) => new Date(now - ago).toISOString();
  const asphalt: ReviewGame = { name: project, title: "Midnight Asphalt", slug: "midnight-asphalt" };
  await core.games.update(project, { title: asphalt.title });
  const mac = { platform: "mac", arch: "universal", version: "1.2.0" };
  const takedown = {
    at: iso(0),
    rule: "Off-platform payment",
    things: THINGS,
    appealable: true,
    humanReview: { state: GenexHumanReview.None, canRequest: true },
  };
  await layDown(
    core,
    asphalt,
    recordOf([appOf("mac", GenexAppReview.Live, iso(48 * HOUR_MS))], takedown),
    GenexHostedStatus.Published,
  );
  await core.append([told(asphalt, GenexReviewChange.Live, iso(48 * HOUR_MS), { app: mac })], threadId);
  for (const [n, game] of [SKATE, STICK, CATHEDRAL, SILENCE].entries()) await scaffold(core, game, n);
  const requested = { state: GenexHumanReview.Requested, canRequest: false, requestedAt: iso(20 * MINUTE_MS) };
  const skate = appOf("windows", GenexAppReview.WithPerson, iso(2 * HOUR_MS), { humanReview: requested });
  await layDown(core, SKATE, recordOf([skate]), GenexHostedStatus.Published);
  await layDown(core, STICK, recordOf([appOf("mac", GenexAppReview.Live, iso(0))]), GenexHostedStatus.Published);
  await layDown(core, CATHEDRAL, recordOf([]), GenexHostedStatus.Published);
  await layDown(
    core,
    SILENCE,
    recordOf([appOf("mac", GenexAppReview.Checking, iso(3 * MINUTE_MS))]),
    GenexHostedStatus.Draft,
  );
  const notApproved = { things: [THINGS[1]!], count: 1, decidedBy: GenexDecider.Check };
  const windows = { platform: "windows", arch: "x64", version: "1.2.0" };
  await core.append(
    [told(SKATE, GenexReviewChange.NotApproved, iso(3 * HOUR_MS), { app: windows, ...notApproved })],
    await core.threadForGame(SKATE.name),
  );
  await core.append(
    [told(CATHEDRAL, GenexReviewChange.TakenDown, iso(26 * HOUR_MS), { things: [THINGS[2]!], count: 1 })],
    await core.threadForGame(CATHEDRAL.name),
  );
  await core.games.touch(project);
}

/** The news, one change at a time, after the window has read its first feed. */
export async function nativeReviewArrivals(core: StudioCore, project: string, gapMs = ARRIVAL_GAP_MS): Promise<void> {
  const asphalt: ReviewGame = { name: project, title: "Midnight Asphalt", slug: "midnight-asphalt" };
  const at = () => new Date().toISOString();
  const say = async (game: ReviewGame, record: ReturnType<typeof told>) => {
    await core.append([record], await core.threadForGame(game.name));
    core.emit(UiEvent.GenexReviewChanged, { project: game.name });
    await sleep(gapMs);
  };
  await say(
    SILENCE,
    told(SILENCE, GenexReviewChange.Sent, at(), { app: { platform: "mac", arch: "universal", version: "1.2.0" } }),
  );
  await say(CATHEDRAL, told(CATHEDRAL, GenexReviewChange.Restored, at(), { requested: true }));
  await say(SKATE, told(SKATE, GenexReviewChange.WithPerson, at(), { requested: true }));
  await say(
    STICK,
    told(STICK, GenexReviewChange.Live, at(), { app: { platform: "mac", arch: "universal", version: "1.2.0" } }),
  );
  await say(asphalt, told(asphalt, GenexReviewChange.TakenDown, at(), { things: THINGS, count: THINGS.length }));
}

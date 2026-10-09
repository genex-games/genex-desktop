/**
 * Numeric facts a judge reads beside the frames — what the build measured about itself and a
 * picture cannot state exactly.
 *
 * The first is the HUD's: a HUD that covered a third of the frame once passed every judge, because
 * nothing told them how much it covered. The template's HUD (`src/hud.js`, generation 2) measures
 * the share of the frame its items cover and the items that run into each other, and `state().hud`
 * carries both. A build whose HUD did not measure (an older HUD, a game with its own UI) gets no
 * line: a judge is never handed a number nobody measured.
 *
 * Then the drive's: where the corner frame is (a move about corners is judged on it), whether the
 * game's racing line steered the drive (a car the drive held against a wall is not the handling's
 * fault), and how a bot holding only the throttle placed in the race. Each line is only there when
 * the evidence pass measured it (evidence.ts `corner`, `drive`, `challenge`).
 */
import { isRecord } from "./json.ts";
import { CORNER_CAMERA } from "./pass-frames.ts";
import { MINUTE_MS, SECOND_MS } from "./time.ts";

/** How a race time's seconds are written: `ss.s`, zero-padded. */
const RACE_SECONDS_WIDTH = 4;

/** How many overlapping pairs the line names before it says how many more there are. */
const HUD_FACT_PAIRS = 4;
/** How much of one item id the line keeps: ids are the build's own words. */
const HUD_FACT_ID_CHARS = 32;

/** An item id as the line shows it: one line, clipped. */
function shownId(value: unknown): string {
  const flat = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > HUD_FACT_ID_CHARS ? `${flat.slice(0, HUD_FACT_ID_CHARS)}…` : flat;
}

/** The pairs of items that run into each other, as `a/b`, or `none`. */
function overlapWords(overlaps: unknown): string {
  const pairs = Array.isArray(overlaps) ? overlaps.filter((pair) => Array.isArray(pair) && pair.length >= 2) : [];
  if (pairs.length === 0) return "none";
  const named = pairs.slice(0, HUD_FACT_PAIRS).map((pair) => `${shownId(pair[0])}/${shownId(pair[1])}`);
  const more = pairs.length > HUD_FACT_PAIRS ? ` (+${pairs.length - HUD_FACT_PAIRS} more)` : "";
  return `${named.join(", ")}${more}`;
}

/** How many items the HUD holds: its own count, or the ids it listed when it gave none. */
function itemCount(hud: Record<string, unknown>): number {
  if (typeof hud.count === "number" && Number.isFinite(hud.count)) return hud.count;
  return Array.isArray(hud.items) ? hud.items.length : 0;
}

/**
 * The judge's HUD line from a build's `state().hud`: "HUD: covers N% of the frame (budget M%),
 * K items, overlaps: a/b". No line when the coverage is not a measured number. `budget` is the
 * share the game's kind allows the HUD; without one the line names none.
 */
export function hudFactLines(hud: unknown, budget: number | null = null): string[] {
  if (!isRecord(hud)) return [];
  const coverage = hud.coverage;
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) return [];
  const allowed = typeof budget === "number" && Number.isFinite(budget) ? ` (budget ${Math.round(budget * 100)}%)` : "";
  return [
    `HUD: covers ${Math.round(coverage * 100)}% of the frame${allowed}, ${itemCount(hud)} items, overlaps: ${overlapWords(hud.overlaps)}`,
  ];
}

/** A finite number, or null. */
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The judge's corner line from what the drive saw (evidence.ts `corner`): the frame of the turn-in
 * and when it was taken, or that the drive reached no corner, or that nothing told it where one
 * was. No line for a game the drive did not watch.
 */
export function cornerFactLines(corner: unknown): string[] {
  if (!isRecord(corner) || typeof corner.seen !== "boolean") return [];
  if (corner.unreadable === true)
    return ["CORNER: no corner frame — the game reports no heading (player.yaw) the drive could watch"];
  const turn = Math.round(finite(corner.turnDegPerSecond) ?? 0);
  if (!corner.seen)
    return [
      `CORNER: the drive reached no corner (the heading turned at most ${turn}°/s) — no frame shows one, so nothing seen in a corner can be judged from these frames`,
    ];
  const seconds = ((finite(corner.atMs) ?? 0) / SECOND_MS).toFixed(1);
  return [
    `CORNER: ${CORNER_CAMERA} is the drive's turn-in, ${seconds} s into the drive (heading turning ${turn}°/s) — judge what a player sees in a corner (warnings, braking, the line) on it`,
  ];
}

/**
 * The judge's drive line (evidence.ts `drive`): whether the game's own racing line steered the
 * held throttle. Without one the car goes where the throttle takes it — into the first wall — and
 * a judge must not read that as the handling.
 */
export function driveFactLines(drive: unknown): string[] {
  if (!isRecord(drive) || typeof drive.steered !== "boolean") return [];
  return drive.steered
    ? ["DRIVE: the throttle was held through the drive and the game's own racing line (config.steer) steered it"]
    : [
        "DRIVE: the throttle was held through the drive and nothing steered (the game has no config.steer) — a car against a wall can be the drive's doing, not the handling's",
      ];
}

/** A race time as `m:ss.s`. */
function raceTime(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  const seconds = ((ms % MINUTE_MS) / SECOND_MS).toFixed(1).padStart(RACE_SECONDS_WIDTH, "0");
  return `${minutes}:${seconds}`;
}

/**
 * The judge's challenge line (evidence.ts `challenge`, the race `throttle-bot-loses` reads): where a
 * bot that only holds the throttle placed, and after how much racing. No line when it did not race.
 */
export function challengeFactLines(challenge: unknown): string[] {
  if (!isRecord(challenge) || challenge.ran !== true) return [];
  const position = finite(challenge.position);
  if (position === null) return [];
  const how =
    challenge.steered === true ? "steered by the game's racing line, never braking" : "nothing steering, never braking";
  const time = raceTime(finite(challenge.simulatedMs) ?? 0);
  const placed = botPlace(position, challenge.finished === true);
  const verdict = position === 1 ? "the race is no challenge" : "the field beats a driver who never brakes";
  return [`CHALLENGE: a bot that only holds the throttle (${how}) ${placed} after ${time} of racing — ${verdict}`];
}

/** Every line the drive of one evidence pass owes its judge: how it was steered, its corner, the bot's race. */
export function drivenFactLines(evidence: unknown): string[] {
  if (!isRecord(evidence)) return [];
  return [
    ...driveFactLines(evidence.drive),
    ...cornerFactLines(evidence.corner),
    ...challengeFactLines(evidence.challenge),
  ];
}

/** Where the bot stood: the place it finished in, or where it was when its race was cut short. */
function botPlace(position: number, finished: boolean): string {
  if (finished) return `finished P${position}`;
  return position === 1 ? "was leading" : `was P${position}`;
}

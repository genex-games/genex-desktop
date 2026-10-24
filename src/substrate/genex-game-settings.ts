/**
 * The Genex settings an engine plugin's multiplayer setup writes for a game, whatever its engine:
 * its Genex project (a slug, checked as Genex names one) and its matchmaking, kept in the game's
 * `genex.json` beside its other Genex settings, which a publish sends to Genex
 * (`genex-game-manifest.ts`). An argument is checked before anything is written, and nothing is
 * written through a link.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readJsonForUpdate, writeFileNoFollow } from "./fsx.ts";
import { TEMPLATE_GENEX_SETTINGS } from "./genex-game-manifest.ts";

/** Genex's API, where a native player signs in, unless the game names another. */
export const GENEX_API_URL = "https://api.genex.games";
/** A Genex project's slug as Genex names one. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** Whether `value` is a Genex project's slug as Genex names one. */
export const isGenexSlug = (value: string): boolean => SLUG.test(value);
/** The matchmaking a publish sends, as the Genex SDK documents it. */
const MATCHMAKING_PRESETS: ReadonlySet<string> = new Set(["open", "duel", "arena", "teams", "private"]);
const WIN_CONDITIONS: ReadonlySet<string> = new Set([
  "lastStanding",
  "firstToScore",
  "highScoreInTime",
  "firstToFinish",
]);
const MAX_MATCHMAKING_KNOBS = 16;
const KNOB_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

const MESSAGE = {
  BadSlug: (slug: string) => `"${slug}" isn't a Genex project's slug: lowercase letters, digits and dashes.`,
  BadPreset: (preset: string) => `matchmaking.preset is one of open, duel, arena, teams or private, not "${preset}".`,
  BadWin: (win: string) =>
    `matchmaking.winCondition is lastStanding, firstToScore, highScoreInTime or firstToFinish, not "${win}".`,
  BadKnobs: `matchmaking.config holds at most ${MAX_MATCHMAKING_KNOBS} numbers, by name (maxPlayers, minPlayers, …).`,
  BadMatchmaking: "matchmaking is an object: {preset, winCondition?, config?}.",
  Link: (file: string) => `${file} is a link, so Genex won't write through it.`,
} as const;

/** Why a game's Genex settings were refused. */
export class GenexSettingsError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A slug as given, checked; undefined when none was. */
export function slugArg(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  const slug = typeof value === "string" ? value.trim() : "";
  if (!SLUG.test(slug)) throw new GenexSettingsError(MESSAGE.BadSlug(String(value)));
  return slug;
}

/** The numeric knobs of a matchmaking block, checked. */
function knobsOf(config: unknown): Record<string, number> | undefined {
  if (config === undefined) return undefined;
  if (!isRecord(config)) throw new GenexSettingsError(MESSAGE.BadKnobs);
  const entries = Object.entries(config);
  const valid = (name: string, value: unknown) => KNOB_NAME.test(name) && Number.isFinite(value);
  if (entries.length > MAX_MATCHMAKING_KNOBS || !entries.every(([name, value]) => valid(name, value)))
    throw new GenexSettingsError(MESSAGE.BadKnobs);
  return Object.fromEntries(entries) as Record<string, number>;
}

/** A matchmaking block as given, checked and rebuilt from its known fields; undefined when none was. */
export function matchmakingArg(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new GenexSettingsError(MESSAGE.BadMatchmaking);
  const preset = String(value.preset ?? "");
  if (!MATCHMAKING_PRESETS.has(preset)) throw new GenexSettingsError(MESSAGE.BadPreset(preset));
  const win = value.winCondition;
  if (win !== undefined && !WIN_CONDITIONS.has(String(win))) throw new GenexSettingsError(MESSAGE.BadWin(String(win)));
  const config = knobsOf(value.config);
  return { preset, ...(win === undefined ? {} : { winCondition: win }), ...(config ? { config } : {}) };
}

/** The game's matchmaking into its `genex.json`; every other key stays. */
export async function writeMatchmaking(gameDir: string, matchmaking: Record<string, unknown>): Promise<void> {
  const file = path.join(gameDir, TEMPLATE_GENEX_SETTINGS);
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new GenexSettingsError(MESSAGE.Link(file));
  const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
  await writeFileNoFollow(file, `${JSON.stringify({ ...current, matchmaking }, null, 2)}\n`);
}

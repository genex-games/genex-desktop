/**
 * Places that make sense. Body-cam-6 spent three hours on one hallway and two rooms with no way
 * in or out: nothing asked for a level before building, and nothing measured whether its zones
 * connected. A game the player moves through is planned in `docs/LEVEL.md` first (zones, how they
 * connect, the exits, the spawns, the play loop and the world's boundary), in its kind's own terms,
 * and the game's own reachability report (`state().__level`, from its colliders or navmesh) is held
 * to that plan.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { LookBlocker } from "./look-bar.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** Where the level plan lives in a game folder. */
export const LEVEL_PLAN = "docs/LEVEL.md";
/** The camera a game registers over its whole level, for every whole-game look. */
export const MAP_CAMERA = "map:top";

/** The level plan's sections, by their heading in `docs/LEVEL.md`. Never rename a value. */
export const LevelSection = {
  Zones: "Zones",
  Connections: "Connections",
  Exits: "Exits",
  Spawns: "Spawns",
  PlayLoop: "Play loop",
  Boundary: "Boundary",
} as const;
export type LevelSection = (typeof LevelSection)[keyof typeof LevelSection];

/** What each section means for a kind of game the player moves through (kinds.ts keys). */
const PLACE_TERMS: Record<string, string> = {
  "first-person": "zones are rooms, halls, yards and streets; connections are doors, stairs, ladders and paths",
  "third-person": "zones are rooms, halls, yards and streets; connections are doors, stairs, ladders and paths",
  "top-down": "zones are rooms, clearings and districts; connections are doors, bridges and roads",
  "side-2d": "zones are the level's sections; connections are jumps, ladders, pipes and doors; the exit is the goal",
  racing:
    "zones are the course's sections; connections are the course's order and its shortcuts; exits are the finish; spawns are the grid; the play loop is the laps; the boundary is barriers and run-off",
  flight:
    "zones are regions of airspace and ground; connections are the routes between them; exits are the landing or goal; the boundary is the map's edge (terrain, weather, a wall)",
};

/** Does this kind of game have a place the player moves through, and so a level plan. */
export function hasPlace(kind: unknown): boolean {
  return typeof kind === "string" && Object.hasOwn(PLACE_TERMS, kind);
}

/** The kind a run declared, when it declared one. */
export const kindOfRun = (run: AnyRecord | null | undefined): string | null => {
  const kind = (run?.game as AnyRecord | undefined)?.kind;
  return typeof kind === "string" ? kind : null;
};

/** What the blockout part is asked to do, in its kind's terms. */
export function levelPlanBrief(kind: string): string {
  const sections = Object.values(LevelSection)
    .map((section) => `## ${section}`)
    .join(", ");
  return `LEVEL FIRST: before any art, write ${LEVEL_PLAN} with ${sections} (one "- <zone>: what it is" line per zone, "- <zone> -> <zone>: door|stairs|path" per connection, the zones that hold an exit, where the player and every enemy spawn, what the player does from spawn to exit, and what keeps the player in the world). Here ${PLACE_TERMS[kind] ?? PLACE_TERMS["first-person"]}. Then block out the WHOLE level in greybox, every zone connected and playable from spawn to exit, report state().__level (zones reachable from spawn, exits, dead ends, bounded) and register the ${MAP_CAMERA} camera over the whole level. Art passes come after, zone by zone.`;
}

/** Other headings a plan may use for a section (the template docs' shorter words), lower-cased. */
const SECTION_ALIASES: Record<string, LevelSection> = {
  links: LevelSection.Connections,
  spawn: LevelSection.Spawns,
  loop: LevelSection.PlayLoop,
};

/**
 * A parsed level plan: the zones it names, the zones holding an exit, the zones whose edge the
 * boundary closes (where a dead end is planned), and the sections it leaves empty.
 */
export interface LevelPlan {
  zones: string[];
  exits: string[];
  bounded: string[];
  missing: LevelSection[];
}

/** The section a heading opens, by its name or an alias, lower-cased. */
const sectionKey = (heading: string): string => {
  const key = heading.toLowerCase();
  return (SECTION_ALIASES[key] ?? key).toLowerCase();
};

/** The first word of a `- <zone>: …` or `- <zone> -> …` line, as the zone's id. */
const zoneOf = (line: string): string | null =>
  /^\s*[-*]\s*`?([A-Za-z0-9_.-]+)`?/.exec(line)?.[1]?.toLowerCase() ?? null;

/** The level plan in a `docs/LEVEL.md` text, or null when there is none. */
export function parseLevelPlan(text: string | null | undefined): LevelPlan | null {
  if (!text?.trim()) return null;
  const bodies = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading) {
      current = sectionKey(heading);
      if (!bodies.has(current)) bodies.set(current, []);
    } else if (current && line.trim()) bodies.get(current)?.push(line);
  }
  const linesOf = (section: LevelSection): string[] => bodies.get(section.toLowerCase()) ?? [];
  const missing = Object.values(LevelSection).filter((section) => linesOf(section).length === 0);
  const ids = (section: LevelSection): string[] =>
    [...new Set(linesOf(section).map(zoneOf))].filter((zone): zone is string => Boolean(zone));
  return {
    zones: ids(LevelSection.Zones),
    exits: ids(LevelSection.Exits),
    bounded: ids(LevelSection.Boundary),
    missing,
  };
}

/** A place finding: keyed by what it is about, so a round is blamed only for what it changed. */
export interface PlaceFinding {
  key: string;
  text: string;
  severity: number;
}

const finding = (blocker: LookBlocker, subject: string, what: string): PlaceFinding => ({
  key: `[${blocker}] ${subject}`,
  text: `[${blocker}] ${subject}: ${what} — the game's __level report against ${LEVEL_PLAN}`,
  severity: 1,
});

/** The zones a `__level` report says the player reaches from spawn. */
function reachedZones(report: AnyRecord): Set<string> {
  const zones = (report.zones ?? {}) as Record<string, AnyRecord>;
  return new Set(
    Object.entries(zones)
      .filter(([, zone]) => zone?.reachable === true)
      .map(([id]) => id.toLowerCase()),
  );
}

/**
 * What a game's reachability report (`state().__level`, version 1) says is wrong with the place
 * against its plan. A game that reports nothing, or a plan with no zones, gets nothing.
 */
export function placeFindings(state: AnyRecord | null | undefined, plan: LevelPlan | null): PlaceFinding[] {
  const report = state?.__level as AnyRecord | undefined;
  if (!report || typeof report !== "object" || !plan) return [];
  const reached = reachedZones(report);
  const out = plan.zones
    .filter((zone) => !reached.has(zone))
    .map((zone) => finding(LookBlocker.UnreachableZone, zone, "planned, but not reachable from spawn"));
  const exits = Array.isArray(report.exits) ? report.exits : [];
  if (plan.exits.length && !exits.length)
    out.push(
      finding(LookBlocker.NoExit, "level", `the plan names an exit in ${plan.exits.join(", ")}; the game has none`),
    );
  // The engine reports every dead end; one in a zone the plan closes or leaves by is planned.
  const planned = new Set([...plan.bounded, ...plan.exits]);
  const deadEnds = Array.isArray(report.deadEnds) ? (report.deadEnds as AnyRecord[]) : [];
  for (const end of deadEnds) {
    const zone = String(end?.zone ?? "level").toLowerCase();
    if (!planned.has(zone))
      out.push(finding(LookBlocker.DeadEnd, zone, "a way that ends where the plan planned no end"));
  }
  if (report.bounded === false) out.push(finding(LookBlocker.Unbounded, "level", "the player can leave the world"));
  return out;
}

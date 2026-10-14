/**
 * `npm run report:extension-escapes -- --profile <name> [--json]`: the extension-ladder escapes an
 * owned `studio:dev` profile recorded (`EXTENSION_ESCAPE_EVENTS` in `shared/game-conformance.ts`): every crate an agent asked for
 * (`crate_request`), every ejected engine (`engine_ejected`) and every trust-flag change
 * (`game_trust`), counted across games. A crate or an eject that keeps coming back is a feature
 * the genex facade lacks: the quarterly lane reads this report to add it there instead.
 *
 * It reads `.studio-dev/profiles/<name>/core/exoharness` through the app's own `EventStore`
 * without opening it for writing (the constructor, never `open()`), or any other event log named
 * with `--log <dir>` (a fixture's). It never reads the normal profile by default and writes nothing.
 *
 * Exit status: 0 with a report, 2 for a usage error or a profile with no event log.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crateRequestOf } from "../src/shared/crate-requests.ts";
import type { EventEnvelope } from "../src/shared/event-log.ts";
import { engineEjectedOf, gameTrustOf } from "../src/shared/game-conformance.ts";
import { EventStore } from "../src/substrate/event-store.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PROFILES = path.join(REPO, ".studio-dev", "profiles");
/** The event store's agent id for the studio's log. */
const STUDIO_AGENT = "studio";
/** How many games must ask for the same crate before it is called recurring. */
export const RECURRING_GAMES = 2;
const ExitCode = { Report: 0, Usage: 2 } as const;
const USAGE =
  "usage: npm run report:extension-escapes -- (--profile <studio:dev profile> | --log <exoharness dir>) [--json]";

const MESSAGE = {
  badProfile: (name: string) => `--profile ${name}: a profile folder name under .studio-dev/profiles`,
  noLog: (dir: string) => `${dir}: no event log there`,
  heading: (events: number) => `extension-ladder escapes (${events} recorded events)`,
  crates: "crates asked for (level 4):",
  crate: (name: string, games: number, asks: number, recurring: boolean) =>
    `  ${name.padEnd(24)} ${games} game${games === 1 ? "" : "s"}, ${asks} ask${asks === 1 ? "" : "s"}${recurring ? "  recurring: a genex feature candidate" : ""}`,
  ejected: "ejected engines (level 5):",
  eject: (project: string, from: string | null, ejected: boolean) =>
    `  ${project.padEnd(24)} ${ejected ? `ejected from ${from ?? "?"}` : "given back to Studio's engine"}`,
  trusted: "trusted games (level 5):",
  trust: (project: string, trusted: boolean) => `  ${project.padEnd(24)} ${trusted ? "trusted" : "not trusted"}`,
  none: "  none",
} as const;

/** One crate as games asked for it: by name, the games, how many asks and the versions. */
export interface CrateEscape {
  name: string;
  games: string[];
  asks: number;
  versions: string[];
  /** Asked for by at least {@link RECURRING_GAMES} games: a feature the facade could carry. */
  recurring: boolean;
}

/** A game's engine as its last `engine_ejected` event left it. */
export interface EjectEscape {
  project: string;
  ejected: boolean;
  ejectedFrom: string | null;
}

/** A game's trust flag as its last `game_trust` event left it. */
export interface TrustEscape {
  project: string;
  trusted: boolean;
}

/** The report: every escape the log holds, grouped for the quarterly lane. */
export interface ExtensionEscapes {
  events: number;
  crates: CrateEscape[];
  ejected: EjectEscape[];
  trusted: TrustEscape[];
}

/** Adds one crate ask to `crates`. */
function countCrate(crates: Map<string, CrateEscape>, name: string, project: string, version: string | null): void {
  const crate = crates.get(name) ?? { name, games: [], asks: 0, versions: [], recurring: false };
  crate.asks += 1;
  if (!crate.games.includes(project)) crate.games.push(project);
  if (version && !crate.versions.includes(version)) crate.versions.push(version);
  crates.set(name, crate);
}

/** The escapes `events` record, oldest first in, each game's latest state out. */
export function summarizeEscapes(events: readonly EventEnvelope[]): ExtensionEscapes {
  const crates = new Map<string, CrateEscape>();
  const ejected = new Map<string, EjectEscape>();
  const trusted = new Map<string, TrustEscape>();
  let counted = 0;
  for (const { data } of events) {
    const asked = crateRequestOf(data);
    const eject = engineEjectedOf(data);
    const trust = gameTrustOf(data);
    if (asked || eject || trust) counted += 1;
    if (asked?.name && asked.project) countCrate(crates, asked.name, asked.project, asked.version ?? null);
    if (eject?.project) {
      const state = {
        project: eject.project,
        ejected: eject.ejected !== false,
        ejectedFrom: eject.ejectedFrom ?? null,
      };
      ejected.set(eject.project, state);
    }
    if (trust?.project) trusted.set(trust.project, { project: trust.project, trusted: trust.trusted === true });
  }
  const crateList = [...crates.values()]
    .map((crate) => ({ ...crate, recurring: crate.games.length >= RECURRING_GAMES }))
    .sort((a, b) => b.games.length - a.games.length || b.asks - a.asks || a.name.localeCompare(b.name));
  const byProject = <T extends { project: string }>(a: T, b: T) => a.project.localeCompare(b.project);
  return {
    events: counted,
    crates: crateList,
    ejected: [...ejected.values()].sort(byProject),
    trusted: [...trusted.values()].sort(byProject),
  };
}

/** Every event of every thread in the log at `dir`, read without writing. */
export async function readEscapeLog(dir: string): Promise<EventEnvelope[]> {
  const store = new EventStore(dir, STUDIO_AGENT, { warn: () => {} });
  const events: EventEnvelope[] = [];
  for (const thread of await store.listThreads()) events.push(...(await store.listEvents(thread.id)));
  return events.sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
}

/** The report as lines for a terminal. */
export function escapeLines(report: ExtensionEscapes): string[] {
  const section = <T>(heading: string, rows: readonly T[], line: (row: T) => string) => [
    heading,
    ...(rows.length > 0 ? rows.map(line) : [MESSAGE.none]),
  ];
  return [
    MESSAGE.heading(report.events),
    ...section(MESSAGE.crates, report.crates, (c) => MESSAGE.crate(c.name, c.games.length, c.asks, c.recurring)),
    ...section(MESSAGE.ejected, report.ejected, (e) => MESSAGE.eject(e.project, e.ejectedFrom, e.ejected)),
    ...section(MESSAGE.trusted, report.trusted, (t) => MESSAGE.trust(t.project, t.trusted)),
  ];
}

/** The event log the flags name: an owned profile's, or `--log`'s; null for a usage error. */
function logDirOf(values: { profile?: string; log?: string }): string | null {
  if (values.log) return path.resolve(values.log);
  const name = values.profile ?? "";
  const plain = /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
  if (!plain) {
    console.error(name ? MESSAGE.badProfile(name) : USAGE);
    return null;
  }
  return path.join(PROFILES, name, "core", "exoharness");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { profile: { type: "string" }, log: { type: "string" }, json: { type: "boolean", default: false } },
    allowPositionals: false,
  });
  const dir = logDirOf(values);
  if (!dir) return ExitCode.Usage;
  if (!existsSync(dir)) {
    console.error(MESSAGE.noLog(dir));
    return ExitCode.Usage;
  }
  const report = summarizeEscapes(await readEscapeLog(dir));
  console.log(values.json ? JSON.stringify(report, null, 2) : escapeLines(report).join("\n"));
  return ExitCode.Report;
}

// Run as a script only: the tests import the summary.
if (import.meta.main) process.exitCode = await main();

/**
 * What the boot tells the reborn agent (and the morning report) about a seed upgrade. Pure, so the
 * record StudioCore appends is the record the two renderers are tested against
 * (tests/conformance/seed-upgrade.test.ts).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVED_ARTIFACTS_FOLDER, LEARNED_ARTIFACTS } from "../substrate/seed-archive.ts";
import { type SeedMoveNotice, type SeedUpgradeReport, SeedUpgradeMode } from "../substrate/seed-upgrade.ts";

export type SeedUpgradedPayload = Pick<SeedUpgradeReport, "added" | "updated" | "kept" | "retired"> & {
  moved?: SeedMoveNotice[];
};

/**
 * The `seed_upgraded` payload, or null when the boot changed nothing worth saying. Four outcomes,
 * not three (M4.8a): a seed file the studio no longer ships is RETIRED — backed up, taken out of
 * the install — and the morning report says which of its own pages the app took away, not only
 * which it added. `moved` is there only when a kept file was split from its callers.
 */
export function seedUpgradedPayload(report: SeedUpgradeReport | null): SeedUpgradedPayload | null {
  if (report?.mode !== SeedUpgradeMode.Upgraded) return null;
  const { added, updated, kept, retired, moved } = report;
  return { added, updated, kept, retired, ...(moved?.length ? { moved } : {}) };
}

/**
 * Memory keys the boot owns: one per kept file an upgrade split from its callers. The agent's
 * memory is in every prompt it builds (loop/prompt.ts), which no log event of the Studio thread
 * is, so this is where it learns that an edit it made no longer reaches every caller.
 */
export const SEED_MOVE_MEMORY_PREFIX = "app update moved code out of ";

/** The memory policy's limit on one value (harness-seed/memory/policy.ts `MAX_VALUE_CHARS`). */
const MAX_NOTE_CHARS = 300;

/** Memory keys the boot owns: one per kept file that still calls the host the older way (SEED_CALL_CHANGES). */
export const SEED_CALL_MEMORY_PREFIX = "app update changed host calls in ";

/** The note the agent reads about a kept file, and the error for a note about nothing. */
const MESSAGE = {
  noMoves: "seedMoveNote needs at least one move",
  callNote: (file: string) =>
    `Your edited ${file} was kept, but it calls the host the older way. Compare its host calls with the shipped copy and carry the new ones over.`,
  moveNote: (from: string, where: readonly string[]) =>
    `Your edited ${from} was kept, but other harness files now import some of its code from a new home, so your edits to that code run only inside it. Carry them over to reach the rest. Moved: ${where.join("; ")}.`,
} as const;

/**
 * The note to the agent about one kept file, within the memory policy's limit: what to do first,
 * then where the code went (the callers are in the upgrade record, which has room for them).
 */
export function seedMoveNote(moves: readonly SeedMoveNotice[]): string {
  const [first] = moves;
  if (!first) throw new TypeError(MESSAGE.noMoves);
  const where = moves.map((move) => `${movedNames(move)} → ${move.to}`);
  const text = MESSAGE.moveNote(first.from, where);
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS - 1)}…` : text;
}

/** The first name a move carried, and how many more went with it. */
function movedNames(move: SeedMoveNotice): string {
  const others = move.names.length - 1;
  return others > 0 ? `${move.names[0]} +${others}` : `${move.names[0]}`;
}

/**
 * The agent's memory with the boot's notes brought in step with `moved`: a note per kept file
 * that is split from its callers, and none for a file that no longer is. Every other entry is
 * the agent's and is returned as it was.
 */
export function seedMoveMemory(
  memory: Record<string, unknown>,
  moved: readonly SeedMoveNotice[],
): Record<string, unknown> {
  const next = Object.fromEntries(Object.entries(memory).filter(([key]) => !key.startsWith(SEED_MOVE_MEMORY_PREFIX)));
  const byFile = new Map<string, SeedMoveNotice[]>();
  for (const move of moved) byFile.set(move.from, [...(byFile.get(move.from) ?? []), move]);
  for (const [from, moves] of byFile) next[`${SEED_MOVE_MEMORY_PREFIX}${from}`] = seedMoveNote(moves);
  return next;
}

/**
 * The agent's memory with the boot's notes brought in step with `outdated`: a note per kept file
 * that still calls the host the older way, and none for a file that no longer does. Every other
 * entry is returned as it was.
 */
export function seedCallMemory(memory: Record<string, unknown>, outdated: readonly string[]): Record<string, unknown> {
  const next = Object.fromEntries(Object.entries(memory).filter(([key]) => !key.startsWith(SEED_CALL_MEMORY_PREFIX)));
  for (const file of outdated) next[`${SEED_CALL_MEMORY_PREFIX}${file}`] = MESSAGE.callNote(file);
  return next;
}

/** What an archived artifact is cleared to: an empty record of its own shape. */
const CLEARED_ARTIFACT: Readonly<Record<string, unknown>> = { memory: {}, skillopt_staged: [] };

/** How the boot reaches the app's artifacts (the Studio thread's) to archive them. */
export interface ArtifactPorts {
  read(id: string): Promise<unknown>;
  write(id: string, value: unknown): Promise<unknown>;
}

/**
 * The learned artifacts (seed-archive.ts `LEARNED_ARTIFACTS`), on the upgrade into the archive
 * epoch: each one that holds anything is written whole to `<archive>/artifacts/<id>.json` and
 * cleared, so no prompt carries it again. Answers the ones archived.
 */
export async function archiveArtifacts(ports: ArtifactPorts, archiveDir: string): Promise<string[]> {
  const archived: string[] = [];
  for (const id of LEARNED_ARTIFACTS) {
    const value = await ports.read(id);
    if (!holdsAnything(value)) continue;
    const folder = path.join(archiveDir, ARCHIVED_ARTIFACTS_FOLDER);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
    await ports.write(id, CLEARED_ARTIFACT[id] ?? null);
    archived.push(id);
  }
  return archived;
}

/** Whether an artifact's value holds anything worth archiving. */
function holdsAnything(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

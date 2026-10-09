/**
 * The roles the composer remembers, and the one migration they have had.
 *
 * A model pick is a *preset*: it fills all three jobs from the policy table in
 * `harness-seed/loop/model-roles.ts`. The picks are then kept per engine in `localStorage`, and
 * a record written by an older build outlives the table that wrote it: a saved record whose
 * preset made one model do everything would win over today's table, and the dearest model in the
 * catalogue would answer every yes/no crop question. So a stored record may be migrated once, even
 * though that overrides a saved preference, and the run card names the judge model so the same
 * mistake cannot be silent.
 *
 * The migration is deliberately blunt. An old record cannot be told apart from a deliberate
 * split — three equal slots is what both look like — so a record from any other version is
 * dropped and the current preset is stamped in its place. Everything a user picks from the roles
 * page after that is written at this version and kept.
 *
 * Pure on purpose: this module reads and writes strings, never `localStorage`, so the rule can be
 * tested (tests/conformance/engines.test.ts) without a browser.
 */
import type { RoleRecord } from "./ui/ModelMenu.tsx";
import { storageKeyFor } from "./storage.ts";

/** Bump this whenever the preset table changes what a pick means. */
export const STORED_ROLES_VERSION = 2;

/** The key a record is kept under, per engine — a pick means nothing on another engine. */
export function storedRolesKey(engineId: string): string {
  return storageKeyFor.roles(engineId);
}

/**
 * What a remembered record means today: the roles it holds, or `null` when it was written by a
 * build with a different preset table (or by no build at all). A `null` is the caller's cue to
 * fall back to the preset for the current pick — and to write that preset back, so the migration
 * happens once rather than on every render.
 */
export function migrateStoredRoles(raw: string | null | undefined): RoleRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { v?: unknown; roles?: unknown };
  // A bare `{planner, builder, judge}` with no version is the shape the stale judge came from.
  if (record.v !== STORED_ROLES_VERSION) return null;
  if (!record.roles || typeof record.roles !== "object") return null;
  return record.roles as RoleRecord;
}

/** The string form of a record, stamped with the version that understands it. */
export function packStoredRoles(roles: RoleRecord): string {
  return JSON.stringify({ v: STORED_ROLES_VERSION, roles });
}

/**
 * A record whose crossed jobs (cross-provider roles) all name a subscription that is signed
 * in now. A job remembered on one that is not falls back to this engine's own default for
 * that job — the model in the slot was that other engine's, so it goes too — instead of a
 * run that dies on a login prompt at 3am. A record with nothing crossed is returned as is.
 */
export function withAvailableEngines(roles: RoleRecord, available: string[]): RoleRecord {
  if (!roles.engines) return roles;
  const next: RoleRecord = { ...roles };
  const engines: { builder?: string; judge?: string } = {};
  for (const key of ["builder", "judge"] as const) {
    const engine = roles.engines[key];
    if (!engine) continue;
    if (available.includes(engine)) engines[key] = engine;
    else {
      next[key] = undefined;
      if (next.efforts) next.efforts = { ...next.efforts, [key]: undefined };
    }
  }
  if (Object.keys(engines).length) next.engines = engines;
  else delete next.engines;
  return next;
}

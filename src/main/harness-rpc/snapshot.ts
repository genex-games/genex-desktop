/** Harness RPC: snapshots of the harness and the games, and the guardian's self-restart and self-edit gate. */
import path from "node:path";
import { rm } from "node:fs/promises";
import { ensureDir } from "../../substrate/fsx.ts";
import { EventKind, SnapshotScope } from "../../shared/event-log.ts";
import { HostMethod, type HarnessHostHandlers, type HarnessParams } from "../../shared/harness-api.ts";
import { assertWorktreePath, resolveCommit, HARNESS_WORKSPACE } from "../../substrate/snapshots.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { isBelow } from "../../substrate/paths.ts";

/** Why a snapshot or worktree call from the harness is refused. */
const MESSAGE = {
  notPlainSlug: "worktree name/runId must be a plain slug",
  unknownSnapshot: (snapshotId: string) => `unknown snapshot: ${snapshotId}`,
  outsideScratch: (worktree: string) => `worktree path is outside scratch: ${worktree}`,
} as const;

/** A facet worktree's name: a plain slug. */
const WORKTREE_NAME = /^[a-z0-9][a-z0-9-_]*$/i;
/** The run a facet worktree is filed under: a plain slug, dots allowed. */
const WORKTREE_RUN_ID = /^[a-z0-9][a-z0-9-_.]*$/i;
/** The run a facet worktree is filed under when the caller names none. */
const SHARED_RUN = "shared";
/** Why a restore happened, when the harness gives no reason. */
const DEFAULT_RESTORE_REASON = "agent request";

/** Where a facet worktree lives under scratch, refused unless its name and run id are plain slugs. */
function worktreeDir(scratch: string, p: HarnessParams<typeof HostMethod.SnapshotWorktree>): string {
  const name = String(p.name ?? "");
  const runId = String(p.runId ?? SHARED_RUN);
  const plainSlugs = WORKTREE_NAME.test(name) && WORKTREE_RUN_ID.test(runId);
  if (!plainSlugs) throw new Error(MESSAGE.notPlainSlug);
  const target = path.join(scratch, "autopilot", runId, name);
  assertWorktreePath(target);
  return target;
}

/** The commit a worktree is detached at: the one named (resolved as a commit), or the live HEAD. */
async function worktreeCommit(core: StudioCore, project: string, named: unknown): Promise<string> {
  // H1: a named revision is a commit of this game, never something git reads as an option.
  if (named === undefined || named === null) return core.snapshots.currentCommit(project);
  return resolveCommit(core.games.dirFor(project), String(named));
}

/**
 * Remove whatever worktree is at `dir` and clear the folder, checking for a planted link before
 * and after each slow step so neither the git removal nor the rm can leave scratch.
 */
async function clearWorktree(core: StudioCore, x: CoreInternals, project: string, scratch: string, dir: string) {
  // H2: the old worktree is removed host-side and a new one made in its place; a link
  // planted under scratch (`autopilot/<runId> -> ~`) would carry both out of it.
  await x.assertNoLinkBelow(scratch, dir);
  await core.snapshots.removeWorktree(project, dir);
  core.builds.forget(dir);
  await x.assertNoLinkBelow(scratch, dir);
  await rm(dir, { recursive: true, force: true });
}

export function snapshotRpc(core: StudioCore, x: CoreInternals) {
  return {
    // — snapshots —
    [HostMethod.SnapshotCreate]: async (p) => {
      // PH-5: the harness may not name its own rewind target. A harness snapshot it calls
      // healthy is healthy only if it differs from the last known-good self in files that never
      // run; code becomes healthy once it has booted (#applySelfRestart, #vouchForBootedSelf),
      // and a boot in a validation fork counts for code exactly as the fork booted it
      // (guardian.validate_edit).
      // R2: a "both" snapshot (a won round) is healthy at once for its game half, and for its
      // harness half only by the same rule.
      const scope = p.scope ?? SnapshotScope.Both;
      const vouched = scope !== SnapshotScope.Game && p.healthy === true;
      const wonRound = scope === SnapshotScope.Both;
      const record = await core.snapshot(
        scope,
        p.reason,
        p.project,
        vouched ? wonRound : p.healthy,
        vouched && wonRound ? { harnessHealthy: false } : {},
      );
      if (vouched) await x.recovery.inheritHealth(record);
      if (vouched && scope === SnapshotScope.Harness)
        await x.selfEditGate.vouchIfValidated(core.snapshotIndex.get(record.snapshot_id) ?? record);
      return core.snapshotIndex.get(record.snapshot_id) ?? record;
    },
    [HostMethod.SnapshotRestore]: async (p) => {
      const record = core.snapshotIndex.get(p.snapshotId);
      if (!record) throw new Error(MESSAGE.unknownSnapshot(p.snapshotId));
      const scope = p.scope ?? record.scope;
      // A refusal (SnapshotRefusedError) reaches the harness with its typed `code`.
      const rescue = await core.snapshots.restore(record, {
        ...(p.project ? { gameWorkspace: p.project } : {}),
        ...(p.scope ? { scope: p.scope } : {}),
      });
      // The harness came back from the past: files the app once wrote now differ from the
      // manifest, and unrepaired that difference reads as agent edits at the next boot.
      if (scope !== SnapshotScope.Game) await core.reconcileSeedManifest();
      await core.append([
        ...(rescue ? [x.recovery.snapshotCreated(rescue)] : []),
        {
          type: EventKind.WorkspaceRestored,
          snapshot_id: p.snapshotId,
          reason: p.reason ?? DEFAULT_RESTORE_REASON,
          scope,
          ...(rescue ? { rescue_snapshot_id: rescue.snapshot_id } : {}),
        },
      ]);
      return true;
    },
    [HostMethod.SnapshotList]: async () => core.snapshotIndex.all(),
    [HostMethod.SnapshotMarkHealthy]: async (p) => {
      const record = core.snapshotIndex.get(p.snapshotId);
      // Same rule as snapshot.create: a harness version is vouched for only by its non-code diff.
      if (record?.git.harness) await x.recovery.inheritHealth(record);
      else x.recovery.markHealthy(p.snapshotId);
      return core.snapshotIndex.get(p.snapshotId)?.healthy === true;
    },
    [HostMethod.SnapshotDiff]: async (p) =>
      core.snapshots.diff(p.workspace ?? HARNESS_WORKSPACE, p.from, p.to ?? "HEAD"),
    // Facet worktrees: a detached, playable, sandbox-writable fork
    // of a game under scratch. Detached at the given commit — the incumbent snapshot — or at
    // the live HEAD when none is named.
    [HostMethod.SnapshotWorktree]: async (p) => {
      const scratch = path.resolve(core.layout.scratch);
      const dir = worktreeDir(scratch, p);
      const gameDir = core.games.dirFor(p.project);
      await core.assertProjectAllowed(gameDir);
      core.snapshots.register({ name: p.project, dir: gameDir });
      const commit = await worktreeCommit(core, p.project, p.commit);
      await clearWorktree(core, x, p.project, scratch, dir);
      await ensureDir(path.dirname(dir));
      await x.assertNoLinkBelow(scratch, dir);
      await core.snapshots.worktreeAt(p.project, commit, dir, await x.previews.nestedPolicy(gameDir));
      return { path: dir, commit };
    },
    [HostMethod.SnapshotRemoveWorktree]: async (p) => {
      const scratch = path.resolve(core.layout.scratch);
      const target = path.resolve(String(p.path ?? ""));
      // The jail: this is a host-side rm — it must never reach outside scratch, whatever the
      // (agent-editable) caller asks for.
      if (!isBelow(scratch, target)) {
        throw new Error(MESSAGE.outsideScratch(p.path));
      }
      // Lexically inside is not enough: scratch is sandbox-writable, so a link planted in it
      // would carry the rm anywhere. Checked again right before the rm, after git's slow part.
      await x.assertNoLinkBelow(scratch, target);
      await core.snapshots.removeWorktree(p.project, target);
      core.builds.forget(target);
      await x.assertNoLinkBelow(scratch, target);
      await rm(target, { recursive: true, force: true });
      return true;
    },
    // — guardian —
    [HostMethod.GuardianRebuildAndRestart]: async (p) => core.requestSelfRestart(p.reason),
    [HostMethod.GuardianValidateEdit]: async (p) => x.selfEditGate.validateEdit(p.files),
    [HostMethod.GuardianWriteSelf]: async (p) => x.selfEditGate.writeSelf(p),
  } satisfies Partial<HarnessHostHandlers>;
}

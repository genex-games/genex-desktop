/**
 * The harness's changes to its own files, listed and undone: what the in-app agent wrote into its
 * own workspace (`write_own_file`, `write_skill`, `install_tool`), each with its diff, and its undo,
 * one at a time. Composed by `StudioCore`; its state stays in the core.
 */
import { undoneSelfChanges } from "../../shared/run-review.ts";
import { changeRecords } from "../self-changes.ts";
import type { SnapshotRecord } from "../../substrate/snapshots.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { t } from "../../shared/i18n.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { BootReason } from "../../shared/protocol.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { SnapshotScope } from "../../shared/event-log.ts";

/** The longest diff Activity shows for one change, in characters. */
const CHANGE_DIFF_MAX_CHARS = 400_000;
/** How many change diffs the core keeps cached. */
const CHANGE_DIFFS_KEPT = 32;

/** Words the user reads when an undo cannot go ahead. */
const MESSAGE = {
  changeNotFound: () => t("Harness couldn’t find this change."),
  changeAlreadyUndone: () => t("This change was already undone."),
  changeBaseGone: () => t("Harness no longer has the version from before this change, so it can’t undo it."),
  undoWhileBuilding: () => t("Harness is building right now. Undo this change when the build finishes."),
  undoConflict: () => t("A later change edited the same part of Harness’s instructions. Undo that change first."),
  changeAlreadyGone: () => t("This change no longer differs from what Harness has now."),
} as const;

/** The harness's own changes: their list, their diffs, and their undo. */
export class SelfImprovementService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /** Restart the harness on a changed self; the caller checks it answers. */
  async #restartForSelfChange(detail: string): Promise<void> {
    await this.#x.recovery.endHarnessForRestart();
    await this.#x.recovery.bootPlanned({ reason: BootReason.SelfUpdate, detail });
  }

  /** Run `work` after every change to the harness's own files already under way: one at a time. */
  selfChangeTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#x.applyChain.then(work);
    this.#x.applyChain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  /** A run, a contractor or a user turn in flight: restarting the harness now would cut it off. */
  workInFlight(): boolean {
    return this.#x.activeRunIds.size > 0 || this.#x.activeDelegations.size > 0 || this.#core.budget.userInFlight > 0;
  }

  async undoSelfChange(snapshotId: string): Promise<{ file: string }> {
    const events = await this.#core.activityEvents();
    const change = changeRecords(events).find((record) => record.snapshotId === snapshotId);
    if (!change) throw new Error(MESSAGE.changeNotFound());
    if (undoneSelfChanges(events).has(snapshotId)) throw new Error(MESSAGE.changeAlreadyUndone());
    const before = this.#core.snapshotIndex.get(snapshotId)?.git.harness;
    if (!before) throw new Error(MESSAGE.changeBaseGone());
    const code = change.file.startsWith("loop/");
    if (code && this.workInFlight()) throw new Error(MESSAGE.undoWhileBuilding());
    const after = (
      (change.postSnapshotId ? this.#core.snapshotIndex.get(change.postSnapshotId) : undefined) ??
      this.nextHarnessSnapshot(snapshotId)
    )?.git.harness;
    let reverted: boolean;
    try {
      reverted = await this.#core.snapshots.revert("harness", before, after, [change.file]);
    } catch {
      throw new Error(MESSAGE.undoConflict());
    }
    if (!reverted) throw new Error(MESSAGE.changeAlreadyGone());
    const undo = await this.#core.snapshot(SnapshotScope.Harness, `after undo: ${change.file}`);
    await this.#x.recovery.inheritHealth(undo);
    await this.#core.append([
      customEventData(CustomEvent.SelfChangeUndone, {
        snapshot_id: snapshotId,
        undo_snapshot_id: undo.snapshot_id,
        file: change.file,
        by: "human",
      }),
    ]);
    this.#core.emit(UiEvent.SelfchangeUndone, { snapshotId, file: change.file });
    if (code) {
      await this.#restartForSelfChange(`undo: ${change.file}`);
      if (!(await this.#core.host.healthcheck()))
        await this.#core.recover(`undoing ${change.file} failed its live healthcheck`);
    }
    return { file: change.file };
  }

  /**
   * For a change that recorded no after-snapshot: the first later snapshot that carries the
   * harness. Undefined means only the working tree holds the change.
   */
  nextHarnessSnapshot(snapshotId: string): SnapshotRecord | undefined {
    const records = this.#core.snapshotIndex.all();
    const at = records.findIndex((record) => record.snapshot_id === snapshotId);
    return at < 0 ? undefined : records.slice(at + 1).find((record) => record.git.harness);
  }

  /**
   * The changes Activity lists, each with its own diff: between the snapshots around it, and only
   * in the file it wrote. Pairing a change with whatever snapshot came next showed an app
   * update's code as part of the change. The harness's own guardian restarts
   * are Studio maintaining itself, not something it learned, and are not listed.
   */
  async selfChangeList(
    limit = 30,
  ): Promise<
    Array<{ from: string; to: string; reason: string; file: string; at: string; healthy: boolean; diff: string }>
  > {
    const out: Array<{
      from: string;
      to: string;
      reason: string;
      file: string;
      at: string;
      healthy: boolean;
      diff: string;
    }> = [];
    for (const change of changeRecords(await this.#core.activityEvents()).reverse()) {
      if (out.length >= limit) break;
      const before = this.#core.snapshotIndex.get(change.snapshotId);
      if (!before?.git.harness) continue;
      const after =
        (change.postSnapshotId ? this.#core.snapshotIndex.get(change.postSnapshotId) : undefined) ??
        this.nextHarnessSnapshot(change.snapshotId);
      out.push({
        from: change.snapshotId,
        to: after?.snapshot_id ?? "current",
        reason: before.reason,
        file: change.file,
        at: before.created_at,
        healthy: before.healthy,
        diff: await this.changeDiff(before.git.harness, after?.git.harness, [change.file]),
      });
    }
    return out;
  }

  async changeDiff(from: string, to: string | undefined, paths: string[]): Promise<string> {
    const key = `${from}..${to ?? ""}:${paths.join(",")}`;
    const cached = this.#x.changeDiffs.get(key);
    if (cached !== undefined) {
      this.#x.changeDiffs.delete(key);
      this.#x.changeDiffs.set(key, cached);
      return cached;
    }
    const diff = (
      await this.#core.snapshots.patch("harness", from, to, paths, { binary: false }).catch(() => "")
    ).slice(0, CHANGE_DIFF_MAX_CHARS);
    // Two commits never change; a diff out to the working tree does.
    if (to) {
      this.#x.changeDiffs.set(key, diff);
      while (this.#x.changeDiffs.size > CHANGE_DIFFS_KEPT) {
        const oldest = this.#x.changeDiffs.keys().next().value;
        if (oldest !== undefined) this.#x.changeDiffs.delete(oldest);
      }
    }
    return diff;
  }
}

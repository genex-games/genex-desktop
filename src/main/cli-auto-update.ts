/**
 * Keeping Codex current without asking: the Codex that OpenAI's installer put on this computer (the
 * one Genex's Install button runs) moves to the latest stable release in the background, so new
 * models that need a newer Codex arrive by themselves. Nothing else is touched: an npm or Homebrew
 * copy belongs to its package manager and an app's copy to that app, and each keeps its manual
 * Update. An update never starts over work under way, and a failed one leaves the old Codex working
 * and its row in Settings saying why.
 */
import { CliInstallOperation, CliInstallPhase, type CliInstallJob } from "../shared/cli-install.ts";
import { HOUR_MS, MINUTE_MS } from "../shared/duration.ts";
import { EngineId } from "../shared/providers.ts";
import { meetsMinimumVersion } from "../substrate/engines/codex-dynamic-tools.ts";

/** How long after launch the first check waits: the window and the engine checks come first. */
export const AUTO_UPDATE_FIRST_CHECK_MS = 2 * MINUTE_MS;
/** How often a running app asks again. */
export const AUTO_UPDATE_EVERY_MS = 6 * HOUR_MS;

/** How a background check ended; the log's word for it. Never rename a value. */
export const CliAutoUpdateOutcome = {
  /** No working Codex is installed. */
  NoCli: "no-cli",
  /** The Codex in use is not the installer's own: its owner updates it. */
  NotOwned: "not-owned",
  /** Its version, or the latest one, could not be read. */
  Unknown: "unknown",
  /** Already the latest stable release, or newer. */
  Current: "current",
  /** Work is under way; the next check tries again. */
  Busy: "busy",
  Updated: "updated",
  Failed: "failed",
} as const;
export type CliAutoUpdateOutcome = (typeof CliAutoUpdateOutcome)[keyof typeof CliAutoUpdateOutcome];

/** What a background check needs from the app. */
export interface CliAutoUpdateDeps {
  /** The Codex Genex runs now: its file and reported version; null when none works. */
  selected(): Promise<{ path: string; version?: string } | null>;
  /** Whether that file is the installer's own Codex. */
  owned(executable: string): Promise<boolean>;
  /** The latest stable version, or null when it cannot be read. */
  latest(): Promise<string | null>;
  /** A run, a reply, a sign-in or another install is under way. */
  busy(): boolean;
  /** Start the update as the Update button does and wait for its end; throws when refused. */
  update(
    provider: typeof EngineId.Codex,
    operation: typeof CliInstallOperation.Update,
  ): Promise<CliInstallJob | undefined>;
  log(line: string): void;
}

const MESSAGE = {
  ended: (outcome: CliAutoUpdateOutcome, detail: string) => `codex auto-update: ${outcome}${detail}`,
} as const;

/** One background check: update the installer's own Codex when a newer stable release exists. */
export async function autoUpdateCodex(deps: CliAutoUpdateDeps): Promise<CliAutoUpdateOutcome> {
  const outcome = await check(deps).catch((error: unknown) => {
    deps.log(MESSAGE.ended(CliAutoUpdateOutcome.Failed, ` (${String(error)})`));
    return null;
  });
  if (outcome === null) return CliAutoUpdateOutcome.Failed;
  if (outcome.said) deps.log(MESSAGE.ended(outcome.code, outcome.said));
  return outcome.code;
}

async function check(deps: CliAutoUpdateDeps): Promise<{ code: CliAutoUpdateOutcome; said?: string }> {
  if (deps.busy()) return { code: CliAutoUpdateOutcome.Busy };
  const selected = await deps.selected();
  if (!selected) return { code: CliAutoUpdateOutcome.NoCli };
  if (!(await deps.owned(selected.path))) return { code: CliAutoUpdateOutcome.NotOwned };
  const latest = await deps.latest();
  if (!selected.version || !latest) return { code: CliAutoUpdateOutcome.Unknown };
  if (meetsMinimumVersion(selected.version, latest)) return { code: CliAutoUpdateOutcome.Current };
  // The answers took a moment: work may have started meanwhile.
  if (deps.busy()) return { code: CliAutoUpdateOutcome.Busy };
  const job = await deps.update(EngineId.Codex, CliInstallOperation.Update);
  const said = ` (${selected.version} to ${latest})`;
  if (job?.phase === CliInstallPhase.Installed) return { code: CliAutoUpdateOutcome.Updated, said };
  return { code: CliAutoUpdateOutcome.Failed, said };
}

/** Check soon after launch, then on a slow clock; the returned call stops it. */
export function scheduleCliAutoUpdate<Timer>(
  run: () => Promise<unknown>,
  timers: {
    setTimeout: (fn: () => void, ms: number) => Timer;
    setInterval: (fn: () => void, ms: number) => Timer;
    clear: (timer: Timer) => void;
  },
): () => void {
  const tick = (): void => void run().catch(() => {});
  const first = timers.setTimeout(tick, AUTO_UPDATE_FIRST_CHECK_MS);
  const every = timers.setInterval(tick, AUTO_UPDATE_EVERY_MS);
  return () => {
    timers.clear(first);
    timers.clear(every);
  };
}

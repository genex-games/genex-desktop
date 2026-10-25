/**
 * The subscriptions' plan limits, kept in one place and pushed to the renderer as they change, so
 * the composer's panel, the picker and Settings show the same answer. Each subscription is read on
 * its own (a slow Claude read never holds Codex back), a reading always belongs to the account in
 * use, and a fresh read of the same account keeps the last numbers on screen until it lands.
 */
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { type ProviderUsage, type ProviderUsageReport, UsageState } from "../../shared/provider-usage.ts";

/** What this needs of a subscription engine: its status, its limits and the account it runs on. */
export interface UsageSource {
  status(): Promise<{ code: string }>;
  /** The plan's limits; null when the provider shares none; a throw when they could not be read. */
  readUsage?(): Promise<ProviderUsage | null>;
  /** The account in use, or null when the engine names none. */
  account(): Promise<string | null>;
}

export interface ProviderUsageDeps {
  /** The subscription engines, in the order the panel lists them. */
  engines: readonly string[];
  source(id: string): UsageSource | null;
  push(reports: ProviderUsageReport[]): void;
}

/** How many reads an account change mid-read may start, so a flapping choice cannot spin. */
const MAX_SWITCH_READS = 3;

/** A read under way, joined by every refresh that arrives meanwhile. */
interface Reading {
  done: Promise<void>;
  /** Another refresh arrived during the read: read once more when it ends. */
  again: boolean;
}

export interface ProviderUsageService {
  /** Every subscription's limits as they stand now, in panel order. */
  snapshot(): ProviderUsageReport[];
  /** Read the named subscriptions (all by default), joining reads under way; each pushes its own answer. */
  refresh(ids?: readonly string[]): Promise<void>;
  /**
   * Read again the subscriptions already shown: a sign-in, switch or recheck may have changed them,
   * so a read under way is followed by one more.
   */
  refreshShown(): Promise<void>;
}

/** Engine troubles that pass: a shown plan stays, as a read that failed. */
const PASSING_TROUBLE: ReadonlySet<string> = new Set([EngineStatusCode.Error, EngineStatusCode.NotRunning]);

/**
 * A subscription that is not ready. One that was shown and signed out stays, asking for its
 * sign-in, and one whose engine has a passing trouble stays as failed; one never signed in (or not
 * installed) is not a plan of this person's.
 */
function notReady(previous: ProviderUsageReport | null, code: string | undefined): ProviderUsageReport | null {
  if (!previous || !code) return null;
  if (code === EngineStatusCode.NeedsLogin) return { ...previous, state: UsageState.SignedOut, usage: null };
  return PASSING_TROUBLE.has(code) ? { ...previous, state: UsageState.Failed } : null;
}

export function createProviderUsage({ engines, source, push }: ProviderUsageDeps): ProviderUsageService {
  const reports = new Map<string, ProviderUsageReport>();
  const readings = new Map<string, Reading>();
  const snapshot = (): ProviderUsageReport[] =>
    engines.flatMap((id) => {
      const report = reports.get(id);
      return report ? [report] : [];
    });
  const set = (id: string, report: ProviderUsageReport | null): void => {
    if (report) reports.set(id, report);
    else if (!reports.delete(id)) return;
    push(snapshot());
  };

  /**
   * One read of one subscription: status, account, then its limits. True when the account changed
   * during the read: its numbers are dropped and the new account is read at once, unless this was
   * the `last` read in a row, which then ends as failed (Try again) rather than checking for good.
   */
  async function read(id: string, last: boolean): Promise<boolean> {
    const engine = source(id);
    // A status that cannot be read is a passing trouble, not a plan gone.
    const status = await engine?.status().catch(() => ({ code: EngineStatusCode.Error }));
    const previous = reports.get(id) ?? null;
    if (!engine || status?.code !== EngineStatusCode.Ready) {
      set(id, notReady(previous, status?.code));
      return false;
    }
    return readLimits(id, engine, previous, last);
  }

  /** A ready subscription's limits for the account in use; true when that account changed meanwhile. */
  async function readLimits(
    id: string,
    engine: UsageSource,
    previous: ProviderUsageReport | null,
    last: boolean,
  ): Promise<boolean> {
    const account = await engine.account().catch(() => null);
    const kept = previous?.account === account ? (previous?.usage ?? null) : null;
    set(id, { engine: id, state: UsageState.Checking, account, usage: kept });
    try {
      const usage = (await engine.readUsage?.()) ?? null;
      // A second look that fails says nothing about a change: the reading stands.
      const now = await engine.account().catch(() => account);
      if (now !== account) {
        set(id, { engine: id, state: last ? UsageState.Failed : UsageState.Checking, account: now, usage: null });
        return !last;
      }
      set(id, { engine: id, state: usage ? UsageState.Ready : UsageState.NotShared, account, usage });
    } catch {
      set(id, { engine: id, state: UsageState.Failed, account, usage: kept });
    }
    return false;
  }

  /** Read `id`, joining a read under way; `again` reads once more after it (the answer may be stale). */
  function refreshOne(id: string, again = false): Promise<void> {
    const under = readings.get(id);
    if (under) {
      under.again ||= again;
      return under.done;
    }
    const reading: Reading = { done: Promise.resolve(), again: false };
    reading.done = (async () => {
      try {
        // Reads an account change starts are capped; reads a sign-in or switch asked for are not.
        let switches = 0;
        do {
          reading.again = false;
          if (await read(id, switches + 1 >= MAX_SWITCH_READS)) {
            switches += 1;
            reading.again = true;
          }
        } while (reading.again);
      } finally {
        readings.delete(id);
      }
    })();
    readings.set(id, reading);
    return reading.done;
  }

  return {
    snapshot,
    refresh: async (ids = engines) => {
      await Promise.all(ids.filter((id) => engines.includes(id)).map((id) => refreshOne(id)));
      // The answer even when nothing changed (no subscription at all): the panel stops waiting.
      push(snapshot());
    },
    refreshShown: async () => {
      await Promise.all(engines.filter((id) => reports.has(id)).map((id) => refreshOne(id, true)));
    },
  };
}

/** A subscription engine as a usage source: its own status and limits, and its accounts' choice. */
export function engineUsageSource(
  engine: Pick<UsageSource, "status" | "readUsage">,
  accounts: { list(): Promise<Array<{ id: string; active: boolean }>> } | null,
): UsageSource {
  return {
    status: () => engine.status(),
    ...(engine.readUsage ? { readUsage: () => engine.readUsage?.() ?? Promise.resolve(null) } : {}),
    account: async () => (await accounts?.list())?.find((entry) => entry.active)?.id ?? null,
  };
}

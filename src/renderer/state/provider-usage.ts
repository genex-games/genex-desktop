/**
 * The subscriptions' plan limits as main keeps them (`main/core/provider-usage.ts`): the one copy
 * the composer's panel and Settings read. Main pushes every change (`provider.usage`); asking only
 * starts a fresh read, at most once in `USAGE_FRESH_MS` unless forced.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { SECOND_MS } from "../../shared/duration.ts";
import type { ProviderUsageReport } from "../../shared/provider-usage.ts";
import type { StudioApi } from "../../shared/studio-api.ts";

/** A reading asked for this recently is not asked for again on hover. */
const USAGE_FRESH_MS = 30 * SECOND_MS;

export interface ProviderUsageState {
  /** Every subscription's limits as main last sent them; null until main first answers. */
  reports: ProviderUsageReport[] | null;
  /** Main could not be asked, and there is no earlier answer to show. */
  failed: boolean;
}

/** Main's answer replaces what was shown. */
export function usageReported(state: ProviderUsageState, reports: ProviderUsageReport[]): ProviderUsageState {
  return { ...state, reports, failed: false };
}

/**
 * The list a read hands back at once. Before main has read anything it is empty while reads are
 * on their way, so it never stands for "no plans": the pushes that follow settle that.
 */
export function usageAnswered(state: ProviderUsageState, reports: ProviderUsageReport[]): ProviderUsageState {
  if (!reports.length && state.reports === null) return state;
  return usageReported(state, reports);
}

/** Main could not be asked: say so only when there is nothing to show instead. */
export function usageUnreachable(state: ProviderUsageState): ProviderUsageState {
  return state.reports === null ? { ...state, failed: true } : state;
}

export interface ProviderUsageStore extends StoreApi<ProviderUsageState> {
  /** Ask main for a fresh read; `force` asks even when one was asked for just now (Try again). */
  refresh(force?: boolean): void;
}

export function createProviderUsageStore(
  api: Pick<StudioApi, "providerUsage">,
  now: () => number = Date.now,
): ProviderUsageStore {
  const store = createStore<ProviderUsageState>()(() => ({ reports: null, failed: false }));
  let askedAt = Number.NEGATIVE_INFINITY;
  const refresh = (force = false): void => {
    if (!force && now() - askedAt < USAGE_FRESH_MS) return;
    askedAt = now();
    void api
      .providerUsage()
      .then((reports) => store.setState((state) => usageAnswered(state, reports), true))
      .catch(() => store.setState(usageUnreachable, true));
  };
  return Object.assign(store, { refresh });
}

/**
 * Whether the open studio's agents started. Main keeps why they would not on its boot state
 * (`BootState.failure` while the studio is Ready), read at each bootstrap, and announces it
 * (`UiEvent.HarnessStartFailed`); a studio that started (`UiEvent.StudioReady`) has them. The
 * sidebar's line offers Try again, which is the boot gate's retry (`retrySandboxSetup`), and a
 * report, which goes as the start screen's does (`reportSandboxSetup`).
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { BootPhase, type BootState } from "../../shared/boot.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { SetupReport } from "./boot.ts";

export interface AgentsStartState {
  /** Why the agents would not start, or null while they did (or have not been asked yet). */
  failure: string | null;
  /** A Try again is running. */
  retrying: boolean;
  /** The report of this failure. */
  report: SetupReport;
}

export const initialAgentsStart = (): AgentsStartState => ({
  failure: null,
  retrying: false,
  report: SetupReport.Idle,
});

/** The agents would not start, for `failure`; a new failure gets a report of its own. */
export function agentsFailed(state: AgentsStartState, failure: string): AgentsStartState {
  if (state.failure === failure && !state.retrying) return state;
  const report = state.failure === failure ? state.report : SetupReport.Idle;
  return { ...state, failure, retrying: false, report };
}

/** The agents started: nothing to say any more. */
export function agentsStarted(state: AgentsStartState): AgentsStartState {
  return state.failure === null && !state.retrying ? state : initialAgentsStart();
}

/** Main's boot state, read or answered: the studio's agents failed while it is Ready with a failure. */
export function agentsStartRead(state: AgentsStartState, boot: BootState): AgentsStartState {
  const failure = boot.phase === BootPhase.Ready ? boot.failure : undefined;
  return failure === undefined ? agentsStarted(state) : agentsFailed(state, failure);
}

export function agentsRetryStarted(state: AgentsStartState): AgentsStartState {
  return { ...state, retrying: true };
}

export function agentsReportChanged(state: AgentsStartState, report: SetupReport): AgentsStartState {
  return { ...state, report };
}

export interface AgentsStartStore extends StoreApi<AgentsStartState> {
  /** Read main's boot state again; a read that fails keeps what the store says. */
  refresh(): Promise<void>;
  /** Start the agents again; presses while one runs share it. */
  retry(): Promise<void>;
  /** Send the team this failure with the app's log; presses while one sends share it. */
  report(): Promise<void>;
}

/** One run at a time of `run`: calls while it runs share it. */
function shared(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}

export function createAgentsStartStore(
  api: Pick<StudioApi, "bootState" | "retrySandboxSetup" | "reportSandboxSetup">,
): AgentsStartStore {
  const store = createStore<AgentsStartState>()(() => initialAgentsStart());
  const answered = (boot: BootState): void => store.setState((state) => agentsStartRead(state, boot), true);
  const refresh = async (): Promise<void> => {
    const boot = await api.bootState().catch(() => null);
    if (boot) answered(boot);
  };
  const retry = async (): Promise<void> => {
    if (store.getState().failure === null) return;
    store.setState(agentsRetryStarted, true);
    try {
      answered(await api.retrySandboxSetup());
    } catch (error) {
      store.setState((state) => agentsFailed(state, errorMessage(error)), true);
    }
  };
  const report = async (): Promise<void> => {
    const { failure } = store.getState();
    if (failure === null) return;
    store.setState((state) => agentsReportChanged(state, SetupReport.Sending), true);
    const sent = await api.reportSandboxSetup(failure).then(
      () => SetupReport.Sent,
      () => SetupReport.Failed,
    );
    // A Try again that failed meanwhile has a new failure, with a report of its own.
    if (store.getState().failure !== failure) return;
    store.setState((state) => agentsReportChanged(state, sent), true);
  };
  return Object.assign(store, { refresh, retry: shared(retry), report: shared(report) });
}

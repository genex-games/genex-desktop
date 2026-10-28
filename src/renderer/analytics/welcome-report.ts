/**
 * What the welcome's and the providers' surfaces call when a person presses, waits or leaves: one
 * line at each call site. Each report builds its properties with the pure decisions beside it
 * (`welcome-flow.ts`, `welcome-providers.ts`), writes the press into the window's memory so main's
 * streams can be credited to it, and hands the event to `track`. None of them throws or waits.
 */
import { useEffect, useRef } from "react";
import type { CliInstallOperation } from "../../shared/cli-install.ts";
import type { CodingCliState } from "../../shared/coding-cli.ts";
import type { EngineDescriptor, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import type { StudioErrorCode } from "../../shared/error-codes.ts";
import { errorCode } from "../../shared/errors.ts";
import type { FoundLocalServer, LocalServerConnectResult } from "../../shared/local-server.ts";
import type { HardwareReport, StudioApi } from "../../shared/studio-api.ts";
import type { PromoAccount } from "../genex-promo.ts";
import type { WelcomeScreen } from "../onboarding/state.ts";
import type { Room } from "../state/threads.ts";
import { readText, removeKey, STORAGE_KEYS, writeText } from "../storage.ts";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { track } from "./client.ts";
import { AnalyticsEvent } from "./events.ts";
import type { SignInProblem } from "./events/welcome.ts";
import { elapsedMs } from "./properties.ts";
import {
  connectModelClicked,
  type FilmSeen,
  journeyMoved,
  promoClosed,
  promoConnectFinished,
  promoShown,
  startJourney,
  type WelcomeEnd,
  type WelcomeJourney,
  welcomeFinished,
  welcomeNext,
  welcomeShown,
} from "./welcome-flow.ts";
import {
  cliInstallRefused,
  type DownloadStart,
  downloadFinished,
  downloadStarted,
  downloadsLeft,
  hardwareChecked,
  type LoginPhase,
  localServerConnected,
  localServersFound,
  notStartingShown,
  ollamaLookedUp,
  providerMemory,
  providerPressed,
  recheckOnReturn,
  rowViewed,
  signedInNotStarting,
  signInHelperUsed,
  signInSettled,
  signInStarted,
  terminalSignInCancelled,
} from "./welcome-providers.ts";
import {
  type AccountAction,
  engineRef,
  type ProviderAction,
  type ProviderRowFace,
  type ProviderSurface,
  type SignInHelper,
  type SignInOutcome,
} from "./welcome-vocabulary.ts";

/** The clock every report reads; durations measured at a call site start from it too. */
export const reportClock = (): number => Date.now();

/** Run `work`, then say whether it went through, and how it failed; its answer and its error still reach the caller. */
export async function settled<T>(work: () => Promise<T>, done: (ok: boolean, error?: unknown) => void): Promise<T> {
  try {
    const value = await work();
    done(true);
    return value;
  } catch (err) {
    done(false, err);
    throw err;
  }
}

/** A provider's button was pressed. */
export function reportProviderPress(engine: string, action: ProviderAction, surface: ProviderSurface): void {
  track(
    AnalyticsEvent.ProviderActionClicked,
    providerPressed(providerMemory, { engine, action, surface }, reportClock()),
  );
}

/** A provider's button was refused at once, by the failure's code when it had one. */
export function reportProviderActionFailed(
  engine: string,
  action: ProviderAction,
  surface: ProviderSurface,
  error: unknown,
): void {
  track(AnalyticsEvent.ProviderActionFailed, { engine: engineRef(engine), action, surface, code: errorCode(error) });
}

/** A sign-in was asked for, and whether it started. */
export function reportSignInStarted(engine: string, started: boolean, missingCli = false): void {
  track(
    AnalyticsEvent.ProviderSignInStarted,
    signInStarted(providerMemory, { engine, started, missingCli }, reportClock()),
  );
}

/** A sign-in that settles in one call (OpenRouter's browser sign-in) ended; a failure may say why. */
export function reportSignInSettled(
  engine: string,
  outcome: SignInOutcome,
  problem: SignInProblem | null = null,
): void {
  track(
    AnalyticsEvent.ProviderSignInFinished,
    signInSettled(providerMemory, { engine, outcome, problem }, reportClock()),
  );
}

/** A help beside a sign-in was used; `accepted` for a submitted code. */
export function reportSignInHelper(
  engine: string,
  helper: SignInHelper,
  extra: { surface?: ProviderSurface; accepted?: boolean; phase?: LoginPhase; code?: StudioErrorCode | null } = {},
): void {
  track(
    AnalyticsEvent.ProviderSignInHelperUsed,
    signInHelperUsed(providerMemory, { engine, helper, ...extra }, reportClock()),
  );
}

/** Cancel pressed on a CLI's own terminal sign-in. */
export function reportTerminalSignInCancelled(engine: string): void {
  terminalSignInCancelled(providerMemory, engine);
}

/** An install or update refused before it started, with what refused it. */
export function reportCliInstallRefused(provider: string, operation: CliInstallOperation, error: unknown): void {
  track(
    AnalyticsEvent.CliInstallRefused,
    cliInstallRefused(providerMemory, { provider, operation, error }, reportClock()),
  );
}

/** A missing CLI looked for again on coming back to the window: the next engines list answers it. */
export function reportRecheckOnReturn(engine: string, before: CodingCliState | null, surface: ProviderSurface): void {
  recheckOnReturn(providerMemory, { engine, before, surface });
}

/** A pasted key was checked; `result` null when checking it failed. */
export function reportKeyChecked(
  engine: string,
  surface: ProviderSurface,
  result: EngineStatusCode | null,
  startedAt: number,
): void {
  track(AnalyticsEvent.ProviderKeyChecked, {
    engine: engineRef(engine),
    result,
    duration_ms: elapsedMs(startedAt, reportClock()),
    surface,
  });
}

/** An account was switched, added or signed out, or a key removed. */
export function reportAccountChanged(engine: string, action: AccountAction, ok: boolean): void {
  track(AnalyticsEvent.ProviderAccountChanged, { engine: engineRef(engine), action, ok });
}

/** A free OpenCode model was picked on the welcome. */
export function reportFreeModelPicked(isDefault: boolean, optionsCount: number): void {
  track(AnalyticsEvent.OpencodeFreeModelPicked, { is_default: isDefault, options_count: optionsCount });
}

/** This Mac was examined for local models; `report` null when that failed. */
export function reportHardwareChecked(
  surface: ProviderSurface,
  report: HardwareReport | null,
  startedAt: number,
): void {
  track(AnalyticsEvent.LocalHardwareChecked, hardwareChecked(surface, report, elapsedMs(startedAt, reportClock())));
}

/** A local model's download was pressed. */
export function reportDownloadStarted(start: DownloadStart): void {
  track(AnalyticsEvent.LocalModelDownloadStarted, downloadStarted(providerMemory, start, reportClock()));
}

/** A local model's download settled; nothing for one this window never saw start. */
export function reportDownloadFinished(
  model: string,
  ok: boolean,
  ollama: Pick<EngineDescriptor, "status"> | undefined,
  error?: unknown,
): void {
  const finished = downloadFinished(providerMemory, { model, ok, ollama, error }, reportClock());
  if (finished) track(AnalyticsEvent.LocalModelDownloadFinished, finished);
}

/** Run a download's press and report how it settled; its answer and error still reach the caller. */
export function downloadReported<T>(
  model: string,
  ollama: () => Pick<EngineDescriptor, "status"> | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return settled(work, (ok, error) => reportDownloadFinished(model, ok, ollama(), error));
}

/** The screen downloads started on closed while they ran. */
export function reportDownloadsLeft(surface: ProviderSurface): void {
  downloadsLeft(providerMemory, surface);
}

/** Install Ollama pressed. */
export function reportOllamaInstall(surface: ProviderSurface): void {
  track(AnalyticsEvent.OllamaInstallClicked, { surface });
}

/** Add from Ollama answered; `lookup` null when the call failed. */
export function reportOllamaLookup(lookup: Awaited<ReturnType<StudioApi["lookupModel"]>> | null): void {
  track(AnalyticsEvent.OllamaModelLookedUp, ollamaLookedUp(lookup));
}

/** A downloaded model was deleted, or deleting it failed. */
export function reportModelDeleted(engine: string, ok: boolean): void {
  track(AnalyticsEvent.LocalModelDeleted, { engine: engineRef(engine), ok });
}

/** The servers running on this computer were found. */
export function reportLocalServersFound(servers: readonly FoundLocalServer[]): void {
  track(AnalyticsEvent.LocalServerFound, localServersFound(servers));
}

/** A local server's Connect settled; `result` null when the call failed. */
export function reportLocalServerConnect(
  attempt: Parameters<typeof localServerConnected>[0],
  result: LocalServerConnectResult | null,
  startedAt: number,
): void {
  track(
    AnalyticsEvent.LocalServerConnectFinished,
    localServerConnected(attempt, result, elapsedMs(startedAt, reportClock())),
  );
}

/** Connect AI model pressed in a composer. */
export function reportConnectModel(nudged: boolean, room: Room): void {
  track(AnalyticsEvent.ConnectModelClicked, connectModelClicked(nudged, room));
}

/** The Genex promo card rose. */
export function reportPromoShown(atHome: boolean, account: PromoAccount): void {
  const card = { atHome, account, welcomeEndedAt: providerMemory.welcomeEndedAt };
  track(AnalyticsEvent.GenexPromoShown, promoShown(card, reportClock()));
}

/** The promo card's own sign-in settled. */
export function reportPromoConnectFinished(attempt: Parameters<typeof promoConnectFinished>[0]): void {
  track(AnalyticsEvent.GenexPromoConnectFinished, promoConnectFinished(attempt, reportClock()));
}

/** The promo card went away. */
export function reportPromoClosed(card: Parameters<typeof promoClosed>[0]): void {
  track(AnalyticsEvent.GenexPromoClosed, promoClosed(card, reportClock()));
}

/** The latest `value`, for an effect that must not run again when it changes. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Send once per mount for each key that appears; null sends nothing. */
export function useReportOnce(key: string | null, send: () => void): void {
  const sent = useRef(new Set<string>());
  const latest = useLatest(send);
  useEffect(() => {
    if (key === null || sent.current.has(key)) return;
    sent.current.add(key);
    latest.current();
  }, [key, latest]);
}

/** Each face a provider row shows, once per visit. */
export function useRowViewed(
  engine: string,
  face: ProviderRowFace | undefined,
  surface: ProviderSurface,
  cliState: CodingCliState | null | undefined,
): void {
  useReportOnce(face ?? null, () => {
    if (face) track(AnalyticsEvent.ProviderRowViewed, rowViewed({ engine, face, surface, cliState }));
  });
}

/** `useRowViewed` for a row that decides its face after an early return: it renders nothing. */
export function RowViewed(row: {
  engine: string;
  face: ProviderRowFace | undefined;
  surface: ProviderSurface;
  cliState: CodingCliState | null | undefined;
}): null {
  useRowViewed(row.engine, row.face, row.surface, row.cliState);
  return null;
}

/** A signed-in CLI that Genex could not start, once per visit while it shows. */
export function useNotStartingShown(engine: EngineDescriptor | undefined, surface: ProviderSurface): void {
  const shown = engine && signedInNotStarting(engine) ? engine : null;
  useReportOnce(shown?.id ?? null, () => {
    if (shown) track(AnalyticsEvent.ProviderSignedInNotStarting, notStartingShown(shown, surface));
  });
}

/**
 * The welcome's journey: shown once nothing waits above it, each screen as it opens, Next on the
 * film, and the end. The clock starts when the welcome is let go, not while a question covers it.
 */
export function useWelcomeJourney(held: boolean, screen: { id: WelcomeScreen; back: boolean }) {
  const journey = useRef<WelcomeJourney | null>(null);
  useEffect(() => {
    if (held || journey.current) return;
    journey.current = startJourney(reportClock());
    // A screen kept from before says an earlier welcome was left unfinished, and where.
    track(
      AnalyticsEvent.WelcomeShown,
      welcomeShown(prefersReducedMotion(), readText(STORAGE_KEYS.analyticsWelcomeScreen)),
    );
    writeText(STORAGE_KEYS.analyticsWelcomeScreen, journey.current.screen);
  }, [held]);
  useEffect(() => {
    if (!journey.current) return;
    const moved = journeyMoved(journey.current, { to: screen.id, back: screen.back }, reportClock());
    journey.current = moved.journey;
    writeText(STORAGE_KEYS.analyticsWelcomeScreen, moved.journey.screen);
    if (moved.viewed) track(AnalyticsEvent.WelcomeScreenViewed, moved.viewed);
  }, [screen.id, screen.back]);
  return {
    next: (film: FilmSeen): void => {
      if (journey.current) track(AnalyticsEvent.WelcomeNextClicked, welcomeNext(journey.current, film, reportClock()));
    },
    finished: (end: WelcomeEnd): void => {
      providerMemory.welcomeEndedAt = reportClock();
      removeKey(STORAGE_KEYS.analyticsWelcomeScreen);
      if (journey.current) track(AnalyticsEvent.WelcomeFinished, welcomeFinished(journey.current, end, reportClock()));
    },
  };
}

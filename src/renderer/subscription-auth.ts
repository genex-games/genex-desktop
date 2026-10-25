/**
 * Sign-in state for a subscription engine — Claude Code or Codex, the same six answers either
 * way. Codex reports native login progress from the in-app console; Claude uses a piped or embedded terminal
 * sign-in and status polling. This hook only receives display state, never provider tokens.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineDescriptor } from "./types.ts";
import { type ClaudeLoginState, isClaudeLoginActive } from "../shared/claude-login.ts";
import { isCodexLoginActive } from "../shared/codex-login.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { EngineStatusCode, needsSignIn } from "../shared/engine-descriptor.ts";
import { t } from "../shared/i18n.ts";
import { EngineId, loginKind, PROVIDERS, providerInfo } from "../shared/providers.ts";
import { useAsyncEffect } from "./use-async-effect.ts";

/** The subscriptions the composer and the Models room show, in order: the provider table's. */
export { SUBSCRIPTION_ENGINES, type SubscriptionId } from "../shared/providers.ts";

/** Human words for a subscription that has nothing to do with the model behind it. */
export const SUBSCRIPTION_LABELS: Record<string, { card: string; account: string; install: string }> =
  Object.fromEntries(
    PROVIDERS.flatMap(({ id, signIn }) =>
      signIn ? [[id, { card: signIn.card, account: signIn.account, install: signIn.install }]] : [],
    ),
  );

/**
 * What the sign-in card names and links for an engine; a neutral card for one the table does not
 * list, whose install link is empty (the card disables it) rather than another vendor's.
 */
export function signInVendor(engine: string): {
  name: string;
  url: string;
  get: string;
  useLine: string;
  signInLine: string;
} {
  const provider = providerInfo(engine);
  const copy = provider?.signIn;
  if (!provider || !copy)
    return {
      name: engine,
      url: "",
      get: t("Install it"),
      useLine: t("Use your subscription to build games."),
      signInLine: t(
        "Your subscription expired or isn't signed in. The studio never sees your password — the provider handles that part.",
      ),
    };
  return {
    name: provider.label,
    url: copy.installUrl,
    get: copy.get,
    useLine: copy.useLine,
    signInLine: copy.signInLine,
  };
}

/** How often a sign-in in flight is re-checked through the engine status. */
const SIGN_IN_POLL_MS = 2 * SECOND_MS;

type SignInSetters = {
  setWaiting: (waiting: boolean) => void;
  setError: (error: string | null) => void;
  setMissingCli: (missing: boolean) => void;
};

/** A console sign-in (Codex) reports its own progress: follow it, newest revision wins. */
function useConsoleLogin(consoleLogin: boolean, { setWaiting, setError, setMissingCli }: SignInSetters): void {
  useEffect(() => {
    if (!consoleLogin) return;
    let live = true;
    let revision = -1;
    const update = (state: Awaited<ReturnType<typeof window.studio.codexLoginState>>): void => {
      if (!live || state.revision < revision) return;
      revision = state.revision;
      setWaiting(isCodexLoginActive(state));
      setError(state.error ?? null);
      setMissingCli(false);
    };
    const unsubscribe = window.studio.onCodexLogin(update);
    void window.studio
      .codexLoginState()
      .then(update)
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [consoleLogin, setWaiting, setError, setMissingCli]);
}

/** The Claude sign-in's display state, followed from main; null for a provider that signs in elsewhere. */
export function useClaudeLogin(engine: string): ClaudeLoginState | null {
  const [state, setState] = useState<ClaudeLoginState | null>(null);
  useAsyncEffect(
    (alive) => {
      // Another subscription's card is not this one's: a Claude sign-in left waiting for its code
      // must not put its code box, its phase or its trouble on the ChatGPT card.
      setState(null);
      if (loginKind(engine) !== "terminal") return;
      let revision = -1;
      const update = (next: ClaudeLoginState): void => {
        if (!alive() || next.revision < revision) return;
        revision = next.revision;
        setState(next);
      };
      const unsubscribe = window.studio.onClaudeLogin(update);
      void window.studio
        .claudeLoginState()
        .then(update)
        .catch(() => {});
      return unsubscribe;
    },
    [engine],
  );
  return state;
}

/**
 * When to re-check a sign-in through the engine status. Probe when the user comes back from the
 * browser, but only while a sign-in is in flight or still required: a handshake on every focus
 * would spawn a CLI just for switching apps. Poll only while the sign-in is under way; one that
 * failed, was cancelled or ended leaves `waiting` set, and polling it would recheck forever.
 */
export function signInPolling(state: {
  consoleLogin: boolean;
  waiting: boolean;
  needsLogin: boolean;
  login: ClaudeLoginState | null;
}): { probeOnFocus: boolean; poll: boolean } {
  if (state.consoleLogin) return { probeOnFocus: false, poll: false };
  const underWay = state.login === null || isClaudeLoginActive(state.login);
  return { probeOnFocus: state.waiting || state.needsLogin, poll: state.waiting && underWay };
}

/** Re-check on focus and on the poll; a tick that finds the last re-check still running skips. */
function usePolledSignIn(when: { probeOnFocus: boolean; poll: boolean }, refresh: () => Promise<void>): void {
  const { probeOnFocus, poll } = when;
  const checking = useRef(false);
  useEffect(() => {
    if (!probeOnFocus) return;
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [probeOnFocus, refresh]);

  useEffect(() => {
    if (!poll) return;
    const id = window.setInterval(() => {
      if (checking.current) return;
      checking.current = true;
      void refresh().finally(() => {
        checking.current = false;
      });
    }, SIGN_IN_POLL_MS);
    return () => window.clearInterval(id);
  }, [poll, refresh]);
}

export interface SubscriptionAuth {
  engine: EngineDescriptor | undefined;
  waiting: boolean;
  error: string | null;
  missingCli: boolean;
  signIn: (opts?: { separate?: boolean; account?: string }) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSubscriptionAuth(
  engines: EngineDescriptor[],
  onRefresh: () => void,
  engineId: string = EngineId.ClaudeCode,
): SubscriptionAuth {
  const engine = engines.find((candidate) => candidate.id === engineId);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingCli, setMissingCli] = useState(false);
  const needsLogin = engine !== undefined && needsSignIn(engine);
  // A console sign-in reports its own progress; any other is polled through the engine status.
  const consoleLogin = loginKind(engineId) === "console";
  useConsoleLogin(consoleLogin, { setWaiting, setError, setMissingCli });

  const refresh = useCallback(async (): Promise<void> => {
    await window.studio.recheckEngines(engineId).catch(() => {});
    onRefresh();
  }, [onRefresh, engineId]);

  useEffect(() => {
    if (!consoleLogin && engine?.status.code === EngineStatusCode.Ready) {
      setWaiting(false);
      setError(null);
      setMissingCli(false);
    }
  }, [engine?.status.code, consoleLogin]);

  const login = useClaudeLogin(engineId);
  usePolledSignIn(signInPolling({ consoleLogin, waiting, needsLogin, login }), refresh);

  // Claude can request a separate profile. Codex always creates an app-specific login; the
  // user can sign into their existing subscription without changing their terminal's login.
  const signIn = async (opts?: { separate?: boolean; account?: string }): Promise<void> => {
    setError(null);
    const result = await window.studio
      .subscriptionSignIn({ engine: engineId, ...(opts ?? {}) })
      .catch((err: Error) => ({ started: false as const, missingCli: false, error: err.message }));
    if (!result.started) {
      setMissingCli(Boolean(result.missingCli));
      setError(result.error ?? t("Couldn't start sign-in"));
      return;
    }
    if (!consoleLogin) {
      setWaiting(true);
      void refresh();
    }
  };

  return { engine, waiting, error, missingCli, signIn, refresh };
}

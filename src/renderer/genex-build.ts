/**
 * Building with Genex in the chat (owner, 2026-10-28): what a Genex model still needs before a
 * message can go (a sign-in and Pro or credits on genex.games, its setup on this computer, more
 * credits), read from the Genex engine's status (`substrate/engines/genex.ts`), the blue notice's
 * words for each, and the steps behind its buttons (`useGenexBuild`). The notice is
 * `ui/GenexNotice.tsx`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CodingCliState } from "../shared/coding-cli.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { type EngineDescriptor, EngineStatusCode, EngineStatusReason } from "../shared/engine-descriptor.ts";
import { t } from "../shared/i18n.ts";
import { EngineId, type SubscriptionId } from "../shared/providers.ts";
import { useCliInstall } from "./cli-install.ts";
import { useGetCredits } from "./play/use-get-credits.ts";
import { problemWords } from "./words.ts";

/** How often Genex is asked again while the person is on genex.games, and for how long. */
const BROWSER_POLL_MS = 3 * SECOND_MS;
const BROWSER_POLL_FOR_MS = 15 * MINUTE_MS;

/** What a Genex model still needs before a message can go. */
export const GenexNeed = {
  /** A sign-in on genex.games, then Pro or a credit pack. */
  SignIn: "sign_in",
  /** Signed in: Pro or a credit pack. */
  Plan: "plan",
  VerifyEmail: "verify_email",
  OutOfCredits: "out_of_credits",
  Paused: "paused",
  /** Claude Code, which Genex runs, is not on this computer yet (or too old to run). */
  Setup: "setup",
  /** genex.games did not answer. */
  Unreachable: "unreachable",
} as const;
export type GenexNeed = (typeof GenexNeed)[keyof typeof GenexNeed];

const NEED_OF_REASON: Partial<Record<EngineStatusReason, GenexNeed>> = {
  [EngineStatusReason.NotSignedIn]: GenexNeed.SignIn,
  [EngineStatusReason.NeedsPlan]: GenexNeed.Plan,
  [EngineStatusReason.VerifyEmail]: GenexNeed.VerifyEmail,
  [EngineStatusReason.OutOfCredits]: GenexNeed.OutOfCredits,
  [EngineStatusReason.Paused]: GenexNeed.Paused,
};

/** What the Genex engine needs before a send; null when it is ready, is not Genex, or is not offered. */
export function genexNeed(engine: Pick<EngineDescriptor, "id" | "status"> | undefined): GenexNeed | null {
  if (engine?.id !== EngineId.Genex) return null;
  const { code, reason } = engine.status;
  if (code === EngineStatusCode.Ready || reason === EngineStatusReason.NotOffered) return null;
  if (code === EngineStatusCode.NotInstalled) return GenexNeed.Setup;
  const named = reason ? NEED_OF_REASON[reason] : undefined;
  if (named) return named;
  return code === EngineStatusCode.NeedsLogin ? GenexNeed.SignIn : GenexNeed.Unreachable;
}

/** The needs genex.games's build page answers: a sign-in, a plan or credits, a verified email. */
const IN_BROWSER: ReadonlySet<GenexNeed> = new Set([GenexNeed.SignIn, GenexNeed.Plan, GenexNeed.VerifyEmail]);
/** The needs that stop a chat already under way: its work so far is kept. */
const STOPPED: ReadonlySet<GenexNeed> = new Set([GenexNeed.OutOfCredits, GenexNeed.Paused]);

/** Where the notice stands besides its need. */
export interface GenexNoticeState {
  /** A game's first message waits above the notice. */
  held: boolean;
  /** The person went on to genex.games in the browser: the notice waits for them. */
  waiting: boolean;
  /** Claude Code is being set up for Genex. */
  installing: boolean;
}

const LEAD: Record<GenexNeed, (state: GenexNoticeState) => string> = {
  [GenexNeed.SignIn]: () => t("Sign in to Genex and pick Pro or a credit pack to start building."),
  [GenexNeed.Plan]: () => t("Pick Pro or a credit pack on genex.games to start building."),
  [GenexNeed.VerifyEmail]: () => t("Verify your email on genex.games to start building."),
  [GenexNeed.OutOfCredits]: () => t("You’re out of Genex credits."),
  [GenexNeed.Paused]: () => t("Building with Genex is paused for now."),
  [GenexNeed.Setup]: (state) =>
    state.installing
      ? t("Getting Genex ready on this computer. This takes a minute.")
      : t("Genex needs a minute to get ready on this computer."),
  [GenexNeed.Unreachable]: () => t("genex.games couldn’t be reached."),
};

const PRIMARY: Record<GenexNeed, ((state: GenexNoticeState) => string | null) | null> = {
  [GenexNeed.SignIn]: () => t("Continue in browser"),
  [GenexNeed.Plan]: () => t("Continue in browser"),
  [GenexNeed.VerifyEmail]: () => t("Continue in browser"),
  [GenexNeed.OutOfCredits]: () => t("Get credits"),
  [GenexNeed.Paused]: null,
  [GenexNeed.Setup]: (state) => (state.installing ? null : t("Set up")),
  [GenexNeed.Unreachable]: () => t("Try again"),
};

/** The words after the lead: the waiting message is kept, or the chat's work so far is. */
function tail(need: GenexNeed, held: boolean): string | null {
  if (held) return t("Your idea waits here.");
  return STOPPED.has(need) ? t("Everything so far is saved.") : null;
}

/** The notice's line and its main button's label (null: nothing to press now). */
export function genexNoticeWords(need: GenexNeed, state: GenexNoticeState): { line: string; primary: string | null } {
  const lead = state.waiting && IN_BROWSER.has(need) ? t("Finish on genex.games in your browser.") : LEAD[need](state);
  const after = tail(need, state.held);
  return { line: after ? `${lead} ${after}` : lead, primary: PRIMARY[need]?.(state) ?? null };
}

/** One of the person's own plans, and whether it is connected now. */
export interface OwnPlan {
  engine: SubscriptionId;
  ready: boolean;
}

/** A button that moves the chat onto one of the person's own plans. */
export interface PlanAction {
  engine: SubscriptionId;
  label: string;
}

const PLAN_WORDS: Record<SubscriptionId, (ready: boolean) => string> = {
  [EngineId.ClaudeCode]: (ready) => (ready ? t("Continue on Claude plan") : t("Connect Claude Code")),
  [EngineId.Codex]: (ready) => (ready ? t("Continue on ChatGPT plan") : t("Connect Codex")),
};

/**
 * The person's own plans the notice offers. Out of credits or paused, a connected plan is the
 * tinted button beside Get credits; otherwise each plan is a quiet link, named by its agent.
 */
export function planActions(
  need: GenexNeed,
  plans: readonly OwnPlan[],
): { tint: PlanAction | null; links: PlanAction[] } {
  const actions = plans.map((plan) => ({ engine: plan.engine, label: PLAN_WORDS[plan.engine](plan.ready) }));
  const ready = plans.find((plan) => plan.ready);
  const tint = STOPPED.has(need) && ready ? (actions.find((action) => action.engine === ready.engine) ?? null) : null;
  return { tint, links: tint ? [] : actions };
}

/** What `useGenexBuild` tells the notice, and its main step. */
export interface GenexBuild {
  need: GenexNeed | null;
  waiting: boolean;
  installing: boolean;
  problem: string | null;
  /** The notice's main step: the build page (with the waiting message), more credits, the setup, or a recheck. */
  primary(idea?: string): Promise<void>;
}

/** Ask again on a timer while `since` is set, for a while; a tick that finds the last ask still running skips. */
function usePollFrom(since: number | null, recheck: () => Promise<void>): void {
  const asking = useRef(false);
  useEffect(() => {
    if (since === null) return;
    const id = window.setInterval(() => {
      if (Date.now() - since > BROWSER_POLL_FOR_MS) {
        window.clearInterval(id);
        return;
      }
      if (asking.current) return;
      asking.current = true;
      void recheck().finally(() => {
        asking.current = false;
      });
    }, BROWSER_POLL_MS);
    return () => window.clearInterval(id);
  }, [since, recheck]);
}

/**
 * The selected Genex model's way to building: what it needs, the browser step and its wait (the
 * engine is asked again every few seconds until it is ready), more credits, and Claude Code's setup.
 */
export function useGenexBuild(engine: EngineDescriptor | undefined, onEnginesRefresh: () => void): GenexBuild {
  const need = genexNeed(engine);
  const [since, setSince] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const install = useCliInstall(EngineId.ClaudeCode);
  const getCredits = useGetCredits();
  const recheck = useCallback(async (): Promise<void> => {
    await window.studio.recheckEngines(EngineId.Genex).catch(() => {});
    onEnginesRefresh();
  }, [onEnginesRefresh]);
  usePollFrom(need === null ? null : since, recheck);
  useEffect(() => {
    if (need !== null) return;
    setSince(null);
    setProblem(null);
  }, [need]);
  // A finished setup is read at once: Genex runs the Claude Code it put on this computer.
  const wasInstalling = useRef(install.installing);
  useEffect(() => {
    if (wasInstalling.current && !install.installing) void recheck();
    wasInstalling.current = install.installing;
  }, [install.installing, recheck]);

  const step = async (idea: string | undefined): Promise<void> => {
    if (need !== null && IN_BROWSER.has(need)) {
      await window.studio.genexBuild(idea);
      setSince(Date.now());
    } else if (need === GenexNeed.OutOfCredits) {
      getCredits();
      setSince(Date.now());
    } else if (need === GenexNeed.Setup) {
      const outdated = engine?.account?.cli.state === CodingCliState.Incompatible;
      await (outdated ? install.update() : install.install());
    } else await recheck();
  };
  const primary = async (idea?: string): Promise<void> => {
    setProblem(null);
    await step(idea).catch((err: unknown) => setProblem(problemWords(err)));
  };
  return {
    need,
    waiting: since !== null,
    installing: install.installing,
    problem: problem ?? install.problem,
    primary,
  };
}

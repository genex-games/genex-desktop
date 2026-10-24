/**
 * A game started from home sends its first message from its own chat, once that chat is open and
 * loaded: as if it had been typed there, so a plan to review, a Loop and pictures take the chat's
 * own routes. Until it can go, the message stays in its chat as the person's bubble, held: while
 * the models are still being read it waits, a signed-out subscription asks for its sign-in and
 * sends once it is back, and a send that failed offers Try again. It never vanishes, and never
 * shows or sends in another chat.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { useLaunch } from "../state/hooks.ts";
import { LaunchPhase } from "../state/launch.ts";
import { studio } from "../state/studio.ts";
import type { ComposerExtras, PromptBarHandle } from "../ui/PromptBar.tsx";
import type { SendAnswered } from "./use-submit.ts";

/** Where a held first message stands. */
export const HeldState = {
  /** The models and sign-ins are still being read: it sends once they are. */
  Waiting: "waiting",
  /** The chosen subscription is signed out: it sends once the sign-in is back. */
  SignedOut: "signed_out",
  /** The send failed: Try again sends it once more. */
  Failed: "failed",
} as const;
export type HeldState = (typeof HeldState)[keyof typeof HeldState];

/** What the chat knows about whether a send can go now. */
export interface HandoverReadiness {
  /** The engines have been read at least once. */
  enginesRead: boolean;
  /** The chat has a model to send with (a pick, or the one it falls back to). */
  hasModel: boolean;
  /** The chosen subscription is signed out (or its CLI is missing): a send would start a sign-in. */
  needsSignIn: boolean;
}

/** What a held first message does next. */
export const HandoverStep = {
  Wait: "wait",
  SignIn: "sign_in",
  Send: "send",
  /** No model at all: the words go to the composer, which offers Connect AI model. */
  ToComposer: "to_composer",
} as const;
export type HandoverStep = (typeof HandoverStep)[keyof typeof HandoverStep];

/** The next step for a held message in `state`, given what the chat knows now. */
export function handoverStep(state: HeldState, ready: HandoverReadiness): HandoverStep {
  if (state === HeldState.Failed || !ready.enginesRead) return HandoverStep.Wait;
  if (!ready.hasModel) return HandoverStep.ToComposer;
  if (ready.needsSignIn) return HandoverStep.SignIn;
  return HandoverStep.Send;
}

/** The first message while it is held, as the chat draws it. */
export interface HeldFirstSend {
  text: string;
  frames?: ReferenceFrame[];
  state: HeldState;
}

interface Held extends HeldFirstSend {
  extras: ComposerExtras | undefined;
}

/** How a held message's send ended: sent, not sent (a sign-in came first, or nothing to send with), or failed. */
export const SendOutcome = { Sent: "sent", NotSent: "not_sent", Failed: "failed" } as const;
export type SendOutcome = (typeof SendOutcome)[keyof typeof SendOutcome];

/**
 * Where a held message stands after its send ended. `here` says its chat is still the one on
 * screen: only then may the words go to the composer or the chat's sign-in state decide. A chat
 * left meanwhile keeps its message waiting, read again when the person comes back to it.
 */
export function heldAfterSend(
  outcome: SendOutcome,
  chat: { here: boolean; needsSignIn: boolean },
): HeldState | "composer" | null {
  if (outcome === SendOutcome.Sent) return null;
  if (outcome === SendOutcome.Failed) return HeldState.Failed;
  if (!chat.here) return HeldState.Waiting;
  return chat.needsSignIn ? HeldState.SignedOut : "composer";
}

export interface LaunchHandover {
  held: HeldFirstSend | null;
  /** The held block's one action: Sign in again, or Try again. */
  act(): void;
}

/**
 * The held messages by chat: each stays with the chat its game opened, shown and sent only there,
 * so leaving the chat and coming back finds it where it was.
 */
function useHeldByChat(threadId: string | undefined) {
  const [byChat, setByChat] = useState<Readonly<Record<string, Held>>>({});
  const put = (chat: string, held: Held | null): void =>
    setByChat((all) => {
      const { [chat]: _gone, ...rest } = all;
      return held ? { ...rest, [chat]: held } : rest;
    });
  return { held: threadId ? (byChat[threadId] ?? null) : null, put };
}

export function useLaunchHandover({
  threadId,
  loading,
  send,
  composer,
  ready,
  signIn,
}: {
  threadId: string | undefined;
  loading: boolean;
  send: SendAnswered;
  composer: RefObject<PromptBarHandle | null>;
  ready: HandoverReadiness;
  signIn: () => Promise<void>;
}): LaunchHandover {
  const launch = useLaunch((s) => s.launch);
  const handing = useRef<string | null>(null);
  const { held, put } = useHeldByChat(threadId);
  const latest = useRef({ send, composer, ready, threadId });
  latest.current = { send, composer, ready, threadId };

  // The launch's message becomes its chat's held message, and home fades onto it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `put` only writes state
  useEffect(() => {
    const opened = launch?.phase === LaunchPhase.Opened && launch.threadId === threadId && !loading;
    if (!launch || !opened || !threadId || handing.current === launch.id) return;
    handing.current = launch.id;
    const frames = launch.extras?.frames;
    put(threadId, {
      text: launch.text,
      ...(frames?.length ? { frames } : {}),
      extras: launch.extras,
      state: HeldState.Waiting,
    });
    studio().launchHanded(launch.id);
  }, [launch, threadId, loading]);

  const step = held ? handoverStep(held.state, ready) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: acts when the step or the chat changes, with the held words then
  useEffect(() => {
    // A chat still loading has no build or sign-in state to send by yet: it decides once loaded.
    if (!held || !step || !threadId || loading) return;
    const chat = threadId;
    if (step === HandoverStep.SignIn) {
      if (held.state !== HeldState.SignedOut) put(chat, { ...held, state: HeldState.SignedOut });
      return;
    }
    if (step === HandoverStep.ToComposer) {
      put(chat, null);
      latest.current.composer.current?.compose(held.text);
      return;
    }
    if (step !== HandoverStep.Send) return;
    // The send's own bubble takes over from the held one while it goes.
    put(chat, null);
    const settle = (outcome: SendOutcome): void => {
      const here = latest.current.threadId === chat;
      const next = heldAfterSend(outcome, { here, needsSignIn: latest.current.ready.needsSignIn });
      if (next === "composer") latest.current.composer.current?.compose(held.text);
      else if (next) put(chat, { ...held, state: next });
    };
    latest.current
      .send(held.text, held.extras)
      .then((sent) => settle(sent ? SendOutcome.Sent : SendOutcome.NotSent))
      .catch(() => settle(SendOutcome.Failed));
  }, [step, threadId, loading]);

  const act = (): void => {
    if (!held || !threadId) return;
    if (held.state === HeldState.Failed) put(threadId, { ...held, state: HeldState.Waiting });
    else if (held.state === HeldState.SignedOut) void signIn().catch(() => {});
  };
  const shown = held ? { text: held.text, ...(held.frames ? { frames: held.frames } : {}), state: held.state } : null;
  return { held: shown, act };
}

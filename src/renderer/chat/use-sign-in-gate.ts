/**
 * The composer's sign-in gate: a send on a subscription that is signed out (or whose CLI is
 * missing) becomes a sign-in instead, and the composer shows the sign-in card. When the harness
 * itself asked for a sign-in mid-turn, the card can also finish the turn on a local model.
 */
import type { ComponentProps } from "react";
import type { ComposerSendOptions } from "../../shared/composer.ts";
import { CustomEvent, customEvent } from "../../shared/custom-events.ts";
import {
  type EngineDescriptor,
  EngineKind,
  EngineStatusCode,
  isDelegatedEngine,
  isEngineReady,
  needsSignIn,
} from "../../shared/engine-descriptor.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import { EngineId, isMetered } from "../../shared/providers.ts";
import { modelKey, parseModelKey } from "../model-key.ts";
import { useSubscriptionAuth } from "../subscription-auth.ts";
import type { SignInCard } from "../ui/SignInCard.tsx";
import { CHAT_WORDS } from "../words.ts";

type EngineModel = EngineDescriptor["models"][number];

/** Is this subscription signed out, or its CLI never installed? Either way a send cannot start. */
const cannotSend = (engine: EngineDescriptor): boolean =>
  needsSignIn(engine) || engine.status.code === EngineStatusCode.NotInstalled;

/** Does the selected subscription block a send: it is the one the composer uses, and cannot send? */
export function subscriptionBlocksSend(
  selected: EngineDescriptor | undefined,
  subscription: EngineDescriptor | undefined,
): boolean {
  if (!selected || !isDelegatedEngine(selected)) return false;
  if (!subscription || subscription.id !== selected.id) return false;
  return cannotSend(subscription);
}

/** The first ready local engine with a model that can call tools, and that model. Never a metered one. */
export function localToolModel(
  engines: readonly EngineDescriptor[],
): { engine: EngineDescriptor; model: EngineModel } | null {
  for (const engine of engines) {
    const local = engine.kind === EngineKind.Direct && !isMetered(engine.id);
    if (!local || !isEngineReady(engine)) continue;
    const model = engine.models.find((candidate) => candidate.supportsTools);
    if (model) return { engine, model };
  }
  return null;
}

/** Did the harness ask for a sign-in in this chat (a turn stopped on a signed-out subscription)? */
export const signInRequested = (threadEvents: readonly EventEnvelope[]): boolean =>
  threadEvents.some((event) => customEvent(event, CustomEvent.NeedsSignin) !== null);

export interface SignInGate {
  /** A send would start a sign-in instead. */
  needsSignIn: boolean;
  signIn(): Promise<void>;
  /** The composer's sign-in card, or null while no sign-in is needed. */
  card: ComponentProps<typeof SignInCard> | null;
}

export function useSignInGate({
  engines,
  selected,
  selectedEngine,
  threadEvents,
  onEnginesRefresh,
  setModelKey,
  onSend,
}: {
  engines: EngineDescriptor[];
  /** The composer's model key. */
  selected: string | null;
  selectedEngine: EngineDescriptor | undefined;
  threadEvents: readonly EventEnvelope[];
  onEnginesRefresh: () => void;
  setModelKey: (key: string | null) => void;
  onSend: (text: string, options: ComposerSendOptions) => Promise<void>;
}): SignInGate {
  // The composer's sign-in card follows whichever subscription is selected — the studio has
  // two, and a Codex pick must not be met with a Claude sign-in prompt.
  const auth = useSubscriptionAuth(engines, onEnginesRefresh, parseModelKey(selected).engine || EngineId.ClaudeCode);
  const blocked = subscriptionBlocksSend(selectedEngine, auth.engine);
  const signIn = (): Promise<void> => auth.signIn();
  if (!blocked) return { needsSignIn: false, signIn, card: null };
  const local = signInRequested(threadEvents) ? localToolModel(engines) : null;
  const continueLocal = (target: { engine: EngineDescriptor; model: EngineModel }): void => {
    setModelKey(modelKey(target.engine.id, target.model.id));
    // Don't go through submit() — it still thinks Claude is selected and
    // would start sign-in again instead of sending.
    // A failed send lands durably in the thread from main — nothing to add here.
    void onSend(CHAT_WORDS.keepGoing, { engine: target.engine.id, model: target.model.id }).catch(() => {});
  };
  return {
    needsSignIn: true,
    signIn,
    card: {
      engine: selectedEngine?.id ?? EngineId.ClaudeCode,
      waiting: auth.waiting,
      error: auth.error,
      // A CLI that was never installed is the same conversation as a stale login, and the
      // card offers the install link instead of a sign-in that cannot start.
      missingCli: auth.missingCli || selectedEngine?.status.code === EngineStatusCode.NotInstalled,
      allowLocal: local !== null,
      onSignIn: () => void signIn(),
      onRecheck: () => void window.studio.recheckEngines(selectedEngine?.id).then(onEnginesRefresh),
      onContinueLocal: local ? () => continueLocal(local) : undefined,
    },
  };
}

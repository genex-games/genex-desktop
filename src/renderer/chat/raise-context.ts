/**
 * Raise context to 16K, the press: Ollama makes the copy, the engines' list is read again so the
 * copy is in it before the chat picks it (a pick missing from a ready list reads as dropped), and
 * `context_raise_finished` says how it went. The copy's model key is the answer; a refusal throws.
 */
import { track } from "../analytics/client.ts";
import { ChatEvent } from "../analytics/events/chat.ts";
import { ContextRaiseOutcome } from "../analytics/chat-vocabulary.ts";
import { modelKey } from "../model-key.ts";
import { EngineId } from "../../shared/providers.ts";

/** What a press needs: the IPC call, the engines' re-read, analytics and a clock. */
export interface RaiseContextDeps {
  raise(model: string): Promise<string>;
  refreshEngines(): Promise<void>;
  track(event: typeof ChatEvent.ContextRaiseFinished, properties: RaiseFinished): void;
  now(): number;
}

/** `context_raise_finished`'s properties. */
type RaiseFinished = { outcome: ContextRaiseOutcome; duration_ms: number };

/** The app's own: main makes the copy, the studio's engines store reads the list again. */
export function appRaiseContextDeps(refreshEngines: () => Promise<void>): RaiseContextDeps {
  return {
    raise: (model) => window.studio.raiseModelContext(model),
    refreshEngines,
    track: (event, properties) => track(event, properties),
    now: Date.now,
  };
}

/** Copy `model` to run with a 16K context and answer the copy's key, once the list names it. */
export async function raiseContext(model: string, deps: RaiseContextDeps): Promise<string> {
  const startedAt = deps.now();
  const finished = (outcome: ContextRaiseOutcome): void =>
    deps.track(ChatEvent.ContextRaiseFinished, { outcome, duration_ms: Math.max(0, deps.now() - startedAt) });
  let copy: string;
  try {
    copy = await deps.raise(model);
  } catch (error) {
    finished(ContextRaiseOutcome.Failed);
    throw error;
  }
  finished(ContextRaiseOutcome.Raised);
  // A list that cannot be read now still names the copy at its next read: the switch goes ahead.
  await deps.refreshEngines().catch(() => undefined);
  return modelKey(EngineId.Ollama, copy);
}

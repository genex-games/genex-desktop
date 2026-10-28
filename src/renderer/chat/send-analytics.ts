/**
 * The chat's sends as usage analytics hears them (`analytics/events/chat.ts`): the facts a send
 * has in hand, gathered here so `use-submit.ts` stays a send. Only kinds, counts and buckets leave;
 * the words are measured and compared, never sent.
 */
import { chatMemory, takeComposedFiles } from "../analytics/chat-memory.ts";
import { forgetSend, noteMessageSent, type SendFacts, sendBlockedProperties } from "../analytics/chat-properties.ts";
import {
  ComposerRoom,
  type SendBlock,
  SendFailStage,
  type SendRoute,
  SendSource,
} from "../analytics/chat-vocabulary.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { elapsedMs } from "../analytics/properties.ts";
import { SendFailure } from "../../shared/composer.ts";
import { errorCodeIn } from "../../shared/errors.ts";
import { loopCommissions } from "../loop-setting.ts";
import { parseModelKey } from "../model-key.ts";
import type { ComposerExtras } from "../ui/PromptBar.tsx";
import type { ChatPanelProps } from "./chat-panel-props.ts";
import type { SendPlacement } from "./pending-sends.ts";
import type { ChatComposerState } from "./use-chat-composer.ts";
import type { ChatThread } from "./use-chat-thread.ts";
import type { ChatWorkView } from "./use-chat-work.ts";
import { sendBlockOf } from "./use-composer-model.ts";

/** What a send's analytics reads from the chat's parts. */
export interface SendParts {
  props: ChatPanelProps;
  chat: ChatThread;
  composer: ChatComposerState;
  /** The chat's work, when the sender has it (a report the chat sends itself may not). */
  work?: ChatWorkView;
}

/** One send, as its hook routed it. */
export interface RoutedSend {
  text: string;
  extras: ComposerExtras | undefined;
  key: string | null;
  source: SendSource;
  route: SendRoute;
  placement?: SendPlacement | undefined;
  clientId?: string | undefined;
}

/** Who a send came from when its caller does not say: Keep building's own, else the composer. */
export const sourceOf = (extras: ComposerExtras | undefined): SendSource =>
  extras?.autopilot?.keepBuilding ? SendSource.KeepBuilding : SendSource.Composer;

/** The room a chat's composer sits in. */
export const chatRoom = (chat: Pick<ChatThread, "isStudioThread">): ComposerRoom =>
  chat.isStudioThread ? ComposerRoom.Studio : ComposerRoom.Game;

/** The pictures a send carries: the composer's, else the Loop's mood board. */
function pictures(extras: ComposerExtras | undefined): number {
  return extras?.frames?.length || extras?.autopilot?.frames.length || 0;
}

/** What `message_sent` is built from. */
export function sendFacts(parts: SendParts, send: RoutedSend): SendFacts | null {
  const { chat, composer, props, work } = parts;
  const thread = chat.threadId;
  if (!thread) return null;
  const engine = parseModelKey(send.key).engine;
  const autopilot = send.extras?.autopilot;
  return {
    thread,
    clientId: send.clientId,
    room: chatRoom(chat),
    route: send.route,
    placement: send.placement,
    source: send.source,
    permissionMode: composer.permissions.bar?.mode,
    key: send.key,
    engineKind: props.engines.find((candidate) => candidate.id === engine)?.kind,
    effort: composer.model.plannerEffort,
    loop: { on: Boolean(autopilot), hours: autopilot?.hours ?? null },
    planReview: Boolean(send.extras?.reviewPlan || autopilot?.reviewPlan),
    pictures: pictures(send.extras),
    files: takeComposedFiles(chatMemory, thread),
    mentions: send.extras?.mentions?.length ?? 0,
    text: send.text,
    events: chat.threadEvents,
    chatWorking: work ? work.line.chatWorking : chat.working,
  };
}

/** Send went nowhere: why, in which chat, and on which engine. */
export function trackSendBlocked(parts: Pick<SendParts, "chat">, reason: SendBlock, key: string | null): void {
  track(
    AnalyticsEvent.MessageSendBlocked,
    sendBlockedProperties(chatMemory, { reason, room: chatRoom(parts.chat), key }),
  );
}

/** What a send reports once it is known how it went; a failure with what it threw. */
export interface SendTracking {
  sent(): void;
  failed(error: unknown): void;
}

const UNTRACKED: SendTracking = { sent: () => undefined, failed: () => undefined };

/**
 * A send about to go: kept so its queue wait and reply pair with it. Once it went, `message_sent`;
 * if it did not, a model the send could not use is a dead Send, anything else a failed one.
 */
export function sendTracking(parts: SendParts, send: RoutedSend): SendTracking {
  try {
    return tracking(parts, send);
  } catch {
    // Analytics never stands in a send's way: a send whose facts cannot be read sends no event.
    return UNTRACKED;
  }
}

function tracking(parts: SendParts, send: RoutedSend): SendTracking {
  const facts = sendFacts(parts, send);
  if (!facts) return UNTRACKED;
  const at = Date.now();
  const properties = noteMessageSent(chatMemory, facts, at);
  return {
    sent: () => track(AnalyticsEvent.MessageSent, properties),
    failed: (error) => {
      forgetSend(chatMemory, facts.thread, send.clientId);
      const input = { autopilot: loopCommissions(parts.chat.run), ...(send.extras ? { extras: send.extras } : {}) };
      const block = sendBlockOf(parts.composer.model, send.key, input);
      if (block) {
        trackSendBlocked(parts, block, send.key);
        return;
      }
      track(AnalyticsEvent.MessageSendFailed, {
        stage: SendFailStage.Rejected,
        code: errorCodeIn(SendFailure, error),
        route: send.route,
        ack_ms: elapsedMs(at, Date.now()),
        pictures: facts.pictures,
        mentions: facts.mentions,
      });
    },
  };
}

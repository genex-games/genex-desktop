/**
 * How a steered message reached the session answering the chat (`coordinator_message_delivered`
 * `how`, and the host's `engine.steer` answer): in the prompt the session was about to read, read
 * mid-turn by an engine that takes input, or by interrupting the session and resuming it with the
 * message in front — or, sent while a run's lead works, handed to that lead (`lead`: `into` is
 * its run; live-chat.ts). The app's copy is `SteerDelivery` in `shared/message-queue.ts`; logs keep
 * the values: never rename one.
 *
 * A module of its own: the queue (message-queue.ts) and the turn's runner (chat-steer.ts) both
 * read it, and a seed upgrade keeps an older message-queue.ts the agent edited, which never
 * exported it.
 */
export const SteerDelivery = {
  Prompt: "prompt",
  Native: "native",
  Interrupt: "interrupt",
  Lead: "lead",
} as const;
export type SteerDelivery = (typeof SteerDelivery)[keyof typeof SteerDelivery];

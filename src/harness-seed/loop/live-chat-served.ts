/**
 * Does this harness hand the chat's messages to a run's lead (live chat)? main.ts says which
 * queue it wired, and a waking run's start says its lead takes the chat only then. A module of
 * its own: main.ts and director.ts read it, and a seed upgrade keeps an older copy of live-chat.ts
 * the agent edited, which never exported these names.
 */

/** Whether the chat's queue main.ts wired hands messages to a run's lead (`serveLiveChat`). */
let queueServesLiveChat = false;

/**
 * main.ts says which queue it wired: one that hands messages to a run's lead exports
 * `SERVES_LIVE_CHAT`, which a kept copy from before live chat lacks. A kept main.ts from before it
 * says nothing, and nothing is served.
 */
export function serveLiveChat(queue: Readonly<Record<string, unknown>>): void {
  queueServesLiveChat = queue.SERVES_LIVE_CHAT === true;
}

/** Does this harness hand the chat's messages to a run's lead: a waking run's start says so only then. */
export function servesLiveChat(): boolean {
  return queueServesLiveChat;
}

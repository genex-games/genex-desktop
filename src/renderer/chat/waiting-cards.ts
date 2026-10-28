/**
 * The cards waiting on the user above the composer (Claude's and plugins' permission requests,
 * the plan to approve, the intake's questions) show one at a time, so they never stack into a
 * scroll of their own. The card on show stays until it is answered; a card that cannot be
 * answered right now never hides one that can.
 */

/** A card waiting on the user: its key, and whether it cannot be answered right now. */
export interface WaitingCard {
  key: string;
  blocked: boolean;
}

/**
 * The composer while a card waits: what it invites, and where its words go — the card's own answer
 * (words for Claude instead of the request), or the chat as ever when `send` is absent (an agent's
 * question takes the next message as its answer).
 */
export interface OwnAnswer {
  placeholder: string;
  send?: (text: string) => Promise<void>;
  /** The words answer an agent's question, sent to the chat as the person's message. */
  answersQuestion?: boolean;
}

/**
 * The card to show: the one on show before while it still waits (unless it is blocked and
 * another is not), else the first that can be answered, else the first.
 */
export function waitingHead(cards: readonly WaitingCard[], shown: string | null): string | null {
  const answerable = cards.find((card) => !card.blocked);
  const current = cards.find((card) => card.key === shown);
  if (current && (!current.blocked || !answerable)) return current.key;
  return (answerable ?? cards[0])?.key ?? null;
}

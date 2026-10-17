/**
 * A reasoning model behind a server that does not separate its thinking (no `reasoning_content`)
 * writes it into the answer between `<think>` and `</think>`; some chat templates open the block in
 * the prompt, so the reply starts mid-thought and only closes it. The chat must show the answer,
 * not the thought: the stream is held back while it thinks, and the finished reply is split into
 * the two.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/** A finished reply's thinking and its answer. */
export interface SplitReply {
  thinking: string;
  answer: string;
}

/**
 * Split a finished reply at its inline thinking: a leading `<think>…</think>`, a block left open
 * (the reply ended while thinking), or a close with no open (the template opened it). A reply with
 * none is all answer.
 */
export function splitInlineThinking(text: string): SplitReply {
  const leading = text.trimStart();
  if (leading.startsWith(OPEN)) {
    const close = leading.indexOf(CLOSE);
    if (close < 0) return { thinking: leading.slice(OPEN.length).trim(), answer: "" };
    return {
      thinking: leading.slice(OPEN.length, close).trim(),
      answer: leading.slice(close + CLOSE.length).trimStart(),
    };
  }
  const close = text.indexOf(CLOSE);
  if (close >= 0 && !text.slice(0, close).includes(OPEN))
    return { thinking: text.slice(0, close).trim(), answer: text.slice(close + CLOSE.length).trimStart() };
  return { thinking: "", answer: text };
}

/** Where a streamed reply is: not yet known to think, thinking, just done thinking, or answering. */
const Phase = { Opening: "opening", Thinking: "thinking", Thought: "thought", Answering: "answering" } as const;
type Phase = (typeof Phase)[keyof typeof Phase];

/**
 * Pass a streamed reply's answer on to `onDelta`, holding back a leading `<think>` block and the
 * blank lines after it. Tags may arrive split across deltas, so the start of the reply and the
 * tail of a thought are kept until they can be told apart.
 */
export function answerDeltas(onDelta: ((delta: string) => void) | undefined): (delta: string) => void {
  let phase: Phase = Phase.Opening;
  let held = "";
  const answer = (text: string): void => {
    if (text) onDelta?.(text);
  };
  /** The reply's start: a thought opening, a start too short to tell, or the answer. */
  const opening = (): void => {
    const leading = held.trimStart();
    if (leading.startsWith(OPEN)) {
      phase = Phase.Thinking;
      held = leading.slice(OPEN.length);
      thinking();
    } else if (!OPEN.startsWith(leading)) {
      phase = Phase.Answering;
      answer(held);
      held = "";
    }
  };
  /** Inside the thought: wait for its close, keeping only what could be a split close tag. */
  const thinking = (): void => {
    const close = held.indexOf(CLOSE);
    if (close < 0) {
      held = held.slice(-(CLOSE.length - 1));
      return;
    }
    phase = Phase.Thought;
    held = held.slice(close + CLOSE.length);
    thought();
  };
  /** Just past the thought: the blank lines before the answer are dropped. */
  const thought = (): void => {
    held = held.trimStart();
    if (!held) return;
    phase = Phase.Answering;
    answer(held);
    held = "";
  };
  const step: Record<Phase, () => void> = {
    [Phase.Opening]: opening,
    [Phase.Thinking]: thinking,
    [Phase.Thought]: thought,
    [Phase.Answering]: () => {
      answer(held);
      held = "";
    },
  };
  return (delta) => {
    held += delta;
    step[phase]();
  };
}

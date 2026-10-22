/**
 * What a Loop that ended without the reviewer's yes left: a short checklist of what is done and
 * what is still to fix, in the person's words, with Keep building and the card's other actions.
 * The chat's result card and the Builds card show the same list.
 */
import { type JSX, type ReactNode, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { STILL_TO_FIX_WORDS } from "../words.ts";

export interface StillToFixProps {
  done: readonly string[];
  notDone: readonly string[];
  /** Start the chat's Loop again on what is left; the button goes once that went out. None where no chat can take it. */
  onKeepBuilding?: (() => Promise<boolean>) | null;
  /** The title over the list; none inside a card that has its own. */
  title?: string | null;
  /** Why the Loop stopped, one line under the title (`stopWhyLine`). */
  why?: string | null;
  /** Actions after Keep building (Play). */
  children?: ReactNode;
}

/** One line of the checklist: a mark the eye reads and words a screen reader hears. */
function Item({ text, left }: { text: string; left: boolean }): JSX.Element {
  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-1.5">
      {left ? (
        <span aria-hidden className="mt-[0.3em] size-[11px] justify-self-center rounded-full border-2 border-orange" />
      ) : (
        <span aria-hidden className="justify-self-center font-medium text-ink">
          ✓
        </span>
      )}
      <span className={`[overflow-wrap:anywhere] ${left ? "text-ink" : "text-ink-2"}`}>
        <span className="sr-only">{left ? STILL_TO_FIX_WORDS.left : STILL_TO_FIX_WORDS.done}: </span>
        {text}
      </span>
    </li>
  );
}

export function StillToFix({
  done,
  notDone,
  onKeepBuilding = null,
  title = STILL_TO_FIX_WORDS.title,
  why = null,
  children,
}: StillToFixProps): JSX.Element {
  const [tap, setTap] = useState<"idle" | "sending" | "sent">("idle");
  const keep =
    onKeepBuilding && tap !== "sent"
      ? () => {
          setTap("sending");
          void onKeepBuilding().then((sent) => setTap(sent ? "sent" : "idle"));
        }
      : null;
  const hasActions = Boolean(keep || children);
  return (
    <div data-still-to-fix className="flex min-w-0 flex-col gap-2.5">
      {title || why ? (
        <div className="flex flex-col gap-0.5">
          {title ? <span className="text-chat font-medium text-ink">{title}</span> : null}
          {why ? <span className="text-chat-sub text-ink-3">{why}</span> : null}
        </div>
      ) : null}
      {done.length || notDone.length ? (
        <ul className="flex flex-col gap-1.5 text-chat-sub">
          {done.map((item) => (
            <Item key={`done:${item}`} text={item} left={false} />
          ))}
          {notDone.map((item) => (
            <Item key={`left:${item}`} text={item} left />
          ))}
        </ul>
      ) : null}
      {hasActions ? (
        <div className="flex flex-wrap gap-1.5">
          {keep ? (
            <Button variant="play-fill" size="sm" data-keep-building disabled={tap === "sending"} onClick={keep}>
              {STILL_TO_FIX_WORDS.keepBuilding}
            </Button>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** The chat's card around the list. */
export function StillToFixCard(props: StillToFixProps): JSX.Element {
  return (
    <div className="build-card flex min-w-0 flex-col rounded-card bg-composer px-4 py-3.5">
      <StillToFix {...props} />
    </div>
  );
}

import { type JSX, useId } from "react";
import { t } from "../../shared/i18n.ts";
import { EngineId } from "../../shared/providers.ts";
import { CLAUDE_CODE_MARK, CODEX_MARK, type ProviderMark } from "../ui/provider-marks.ts";
import { HeldState, type HeldFirstSend } from "./use-launch-handover.ts";
import { UserMessage } from "./UserMessage.tsx";

/** The subscriptions' own marks, drawn beside their name in the held block. */
const MARKS: Readonly<Record<string, ProviderMark>> = {
  [EngineId.ClaudeCode]: CLAUDE_CODE_MARK,
  [EngineId.Codex]: CODEX_MARK,
};

function MarkGlyph({ mark }: { mark: ProviderMark }): JSX.Element {
  const gradient = useId();
  const blend = mark.colors.length > 1;
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="held-send-mark">
      {blend && (
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            {mark.colors.map((color, i) => (
              <stop key={color} offset={i / (mark.colors.length - 1)} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
      )}
      <path fillRule="evenodd" d={mark.path} fill={blend ? `url(#${gradient})` : mark.colors[0]} />
    </svg>
  );
}

/** The block's title, its one line and its one action, by where the message stands. */
function heldWords(state: HeldState, brand: string): { title: string; line: string; action: string } | null {
  if (state === HeldState.SignedOut)
    return {
      title: t("{brand} is signed out", { brand }),
      line: t("Your message sends as soon as you’re back."),
      action: t("Sign in again"),
    };
  if (state === HeldState.Failed)
    return { title: t("Couldn’t reach {brand}", { brand }), line: t("Your message is safe."), action: t("Try again") };
  return null;
}

/**
 * A game's first message from home while it cannot go yet: the person's bubble, then what it waits
 * for. While the models are read it says so softly; signed out or failed, a card with the
 * provider's mark and one action.
 */
export function HeldFirstMessage({
  held,
  engine,
  brand,
  onAct,
}: {
  held: HeldFirstSend;
  engine: string | undefined;
  brand: string;
  onAct: () => void;
}): JSX.Element {
  const words = heldWords(held.state, brand);
  const mark = engine ? MARKS[engine] : undefined;
  return (
    <div data-held-send={held.state} className="flex min-w-0 flex-col gap-4">
      <div className="flow-root min-w-0">
        <UserMessage text={held.text} frames={held.frames} />
      </div>
      {words ? (
        <div className="held-send-card" role="status">
          {mark && <MarkGlyph mark={mark} />}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="held-send-title truncate">{words.title}</span>
            <span className="held-send-line">{words.line}</span>
          </div>
          <button
            type="button"
            className="held-send-action"
            data-held-action={held.state === HeldState.SignedOut ? "sign-in" : "retry"}
            data-primary={held.state === HeldState.SignedOut || undefined}
            onClick={onAct}
          >
            {words.action}
          </button>
        </div>
      ) : (
        <p role="status" className="chat-status-shimmer m-0 text-[13px] leading-[18px]">
          {brand ? t("Checking your {brand} account…", { brand }) : t("Getting your models ready…")}
        </p>
      )}
    </div>
  );
}

/**
 * Get Genex credits (`V3-TopUp`): the packs genex.games sells, each at its one checkout price
 * (D13), auto top-up's line with its switch, and Genex Pro. Checkout opens in the browser; Studio
 * never takes a card. Dollars show only here, at checkout.
 */
import { type JSX, useEffect, useState } from "react";
import {
  AI_AUTO_TOPUP_ADD_CREDITS,
  AI_AUTO_TOPUP_UNDER_CREDITS,
  type AiAutoTopUp,
  type AiCreditPack,
  AiCreditProductKind,
  type GameAiSettingsPatch,
} from "../../../shared/game-ai-views.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { Switch } from "../../ui/switch.tsx";
import { checkoutPriceWords, countWords, GET_CREDITS_WORDS, problemWords } from "../../words.ts";

const WORDS = GET_CREDITS_WORDS;

/** The pack a dialog opens on: the middle of what is sold, as the canvas draws it. */
const startPack = (packs: readonly AiCreditPack[]): string | null => packs[Math.floor(packs.length / 2)]?.id ?? null;

/** The packs, read once; null while reading, and why a read failed. */
function usePacks() {
  const [packs, setPacks] = useState<AiCreditPack[] | null>(null);
  const [failed, setFailed] = useState(false);
  const read = () => {
    setFailed(false);
    window.studio
      .gameAiCredits()
      .then((sold) => setPacks([...sold].sort((a, b) => a.credits - b.credits)))
      .catch(() => setFailed(true));
  };
  useEffect(read, []);
  return { packs, failed, read };
}

/** Get credits, over whatever opened it. */
export function GetCreditsDialog({
  topUp,
  onTopUp,
  onDismiss,
}: {
  /** Auto top-up as genex.games holds it; null when it could not be read (the line is left out). */
  topUp: AiAutoTopUp | null;
  onTopUp: (patch: GameAiSettingsPatch) => void;
  onDismiss: () => void;
}): JSX.Element {
  const { packs, failed, read } = usePacks();
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const pick = chosen ?? (packs ? startPack(packs) : null);
  const pack = packs?.find((candidate) => candidate.id === pick) ?? null;
  const checkout = async (product: Parameters<typeof window.studio.gameAiCheckout>[0]) => {
    setOpening(true);
    setError(null);
    try {
      await window.studio.gameAiCheckout(product);
      onDismiss();
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setOpening(false);
    }
  };
  const line = topUp ?? { on: false, underCredits: AI_AUTO_TOPUP_UNDER_CREDITS, addCredits: AI_AUTO_TOPUP_ADD_CREDITS };
  return (
    <DialogSurface title={WORDS.title} description={WORDS.intro} onDismiss={onDismiss} size="md" testId="get-credits">
      <div className="play-ai-credits" data-get-credits>
        {!packs && !failed && (
          <p role="status" className="text-ink-3">
            {WORDS.loading}
          </p>
        )}
        {failed && (
          <p role="alert" className="text-ink-2">
            {WORDS.unread}{" "}
            <Button onClick={read} data-get-credits-retry>
              {WORDS.retry}
            </Button>
          </p>
        )}
        {packs && (
          <div role="radiogroup" aria-label={WORDS.packs} className="play-ai-packs">
            {packs.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="radio"
                aria-checked={candidate.id === pick}
                data-credit-pack={candidate.id}
                className="play-ai-pack"
                onClick={() => setChosen(candidate.id)}
              >
                <span className="play-ai-pack-credits">{countWords(candidate.credits)}</span>
                <span className="play-ai-pack-price">{checkoutPriceWords(candidate.priceCents)}</span>
              </button>
            ))}
          </div>
        )}
        {topUp && (
          <label className="play-ai-credits-line" data-get-credits-top-up>
            <span>{WORDS.topUpLine(line.addCredits, line.underCredits)}</span>
            <Switch checked={line.on} onCheckedChange={(on) => onTopUp({ autoTopUp: { ...line, on } })} />
          </label>
        )}
        {error && (
          <p role="alert" className="text-red">
            {error}
          </p>
        )}
        <div className="play-ai-dialog-presses">
          <Button onClick={onDismiss}>{WORDS.cancel}</Button>
          <Button
            variant="default"
            disabled={!pack || opening}
            busy={opening}
            data-get-credits-buy
            onClick={() => pack && void checkout({ kind: AiCreditProductKind.Pack, packId: pack.id })}
          >
            {pack ? WORDS.buy(pack.credits) : WORDS.packs}
          </Button>
        </div>
        <p className="text-ink-3">{WORDS.checkout}</p>
        <div className="play-ai-credits-line" data-get-credits-pro>
          <span className="flex min-w-0 flex-col">
            <span className="text-ink">{WORDS.pro}</span>
            <span className="text-ink-3">{WORDS.proWhat}</span>
          </span>
          <Button
            aria-label={WORDS.proLabel}
            disabled={opening}
            onClick={() => void checkout({ kind: AiCreditProductKind.Pro })}
          >
            {WORDS.proButton}
          </Button>
        </div>
      </div>
    </DialogSurface>
  );
}

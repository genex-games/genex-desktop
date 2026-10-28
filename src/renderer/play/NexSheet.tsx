/**
 * The Nex sheet: what Nex is, wherever the app shows it (the coin beside the account's name in
 * Play, the account menu's Nex, Items › Selling's strip). Nex is the money of games on Genex:
 * players buy it, spend it on items in any game, and creators earn it from what their games sell.
 * It shows the account's own Nex once read, what Selling holds back while a hold lasts, and Get
 * Nex, which opens genex.games' Nex page in the browser. Credits are a different balance.
 */
import type { JSX } from "react";
import { useEffect } from "react";
import { useItems, usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { ITEMS_WORDS, NEX_WORDS } from "../words.ts";
import { CoinMark } from "./CoinMark.tsx";
import { coinNumber, coinText } from "./purchase-model.ts";

const WORDS = NEX_WORDS;

/** Get Nex: genex.games' Nex page in the browser; nothing to do when main cannot open it. */
export const getNex = (): void =>
  void studio()
    .api.storeGetCoin()
    .catch(() => undefined);

/** One amount of Nex with its label; a held one is quieter. */
function Figure({ label, coins, held = false }: { label: string; coins: number; held?: boolean }): JSX.Element {
  return (
    <div className="nex-figure" data-nex-held={held || undefined}>
      <span className="nex-figure-label">{label}</span>
      <span className="nex-figure-amount">
        <CoinMark size={18} />
        <span aria-hidden="true">{coinNumber(coins)}</span>
        <span className="sr-only">{coinText(coins)}</span>
      </span>
    </div>
  );
}

/** One way Nex moves: got, spent or earned. */
function Way({ icon, title, body }: { icon: IconName; title: string; body: string }): JSX.Element {
  return (
    <li className="nex-way">
      <span className="nex-way-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="nex-way-words">
        <span className="nex-way-title">{title}</span>
        <span className="nex-way-body">{body}</span>
      </span>
    </li>
  );
}

/** The sheet itself; `onDismiss` closes it. */
export function NexSheet({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const coins = usePeople((s) => s.coins);
  const selling = useItems((s) => s.selling.selling);
  // Create reads no Nex of its own: the sheet reads the account's as it opens, wherever that is.
  useEffect(() => void studio().people.loadCoins(), []);
  const held = selling && selling.holdDays > 0 && selling.earnedHeld > 0 ? selling : null;
  return (
    <DialogSurface
      title={WORDS.title}
      titleIcon={<CoinMark size={22} />}
      description={WORDS.lead}
      onDismiss={onDismiss}
      size="lg"
      testId="nex-sheet"
    >
      <div className="nex-sheet" data-nex-sheet>
        {coins !== null && (
          <div className="nex-figures">
            <Figure label={WORDS.yours} coins={coins} />
            {held && <Figure label={ITEMS_WORDS.onHold(held.holdDays)} coins={held.earnedHeld} held />}
          </div>
        )}
        <ul className="nex-ways">
          <Way icon="plus" title={WORDS.get} body={WORDS.getBody} />
          <Way icon="box" title={WORDS.spend} body={WORDS.spendBody} />
          <Way icon="graph" title={WORDS.earn} body={WORDS.earnBody} />
        </ul>
        <p className="nex-credits">{WORDS.credits}</p>
        <div className="nex-foot">
          <Button variant="default" data-nex-get onClick={getNex}>
            {WORDS.getNex}
          </Button>
        </div>
      </div>
    </DialogSurface>
  );
}

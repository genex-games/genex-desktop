/**
 * The composer usage panel's Genex block, the one place "used in this game" belongs: the balance
 * every game shares beside Genex's mark, and this game's spend under it. Read when the panel opens,
 * only while Genex is on and connected; otherwise the block is not there.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GENEX_PLUGIN_ID, GenexAction, type GenexStatus } from "../../../../shared/genex.ts";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { CreditsShard } from "../../../play/CreditsShard.tsx";
import { GenexMark } from "../../../ui/GenexLogo.tsx";
import { GENEX_WORDS } from "../../../words.ts";
import { CreditsKind, creditsOf, isGenexStatus, spentOf } from "./genex-view.ts";

const WORDS = GENEX_WORDS.usage;
/** Credits read with the reader's own digit grouping. */
const NUMBER = new Intl.NumberFormat();

/** Genex's status for the open game, read each time the panel opens; null while off, signed out or unread. */
function useGameStatus(project: string | null | undefined, open: boolean): GenexStatus | null {
  const [status, setStatus] = useState<GenexStatus | null>(null);
  useAsyncEffect(
    (alive) => {
      if (!open || !project) return;
      window.studio.pluginAction(GENEX_PLUGIN_ID, GenexAction.Status, {}, project).then(
        (next) => alive() && setStatus(isGenexStatus(next) && next.connected ? next : null),
        () => alive() && setStatus(null),
      );
    },
    [project, open],
  );
  return status;
}

/** The block: Genex's mark, name and balance, then this game's spend. */
export function GenexCredits({
  project,
  open,
}: {
  project: string | null | undefined;
  open: boolean;
}): JSX.Element | null {
  const status = useGameStatus(project, open);
  if (!status) return null;
  const credits = creditsOf(status);
  const spent = spentOf(status.allowance);
  const left = credits.kind === CreditsKind.Count ? NUMBER.format(credits.count) : null;
  const balance = credits.kind === CreditsKind.Unlimited ? WORDS.unlimited : left;
  if (spent === null && balance === null) return null;
  return (
    <section className="usage-plan" aria-label={WORDS.title} data-usage-genex="">
      <dl className="usage-credits">
        <dt className="usage-credits-name">
          <GenexMark />
          <span className="truncate">{WORDS.title}</span>
        </dt>
        <dd>
          {left !== null && <CreditsShard size={12} />}
          {balance}
        </dd>
        {spent !== null && (
          <>
            <dt className="text-ink-3">{WORDS.thisGame}</dt>
            <dd>
              <CreditsShard size={12} />
              {NUMBER.format(spent)}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

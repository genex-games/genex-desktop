import type { JSX } from "react";
import type { SubscriptionId } from "../../shared/providers.ts";
import { type GenexNeed, genexNoticeWords, type OwnPlan, planActions } from "../genex-build.ts";
import { Button } from "./Button.tsx";
import { GenexMark } from "./GenexLogo.tsx";

/** What the notice shows and does; the chat's sign-in gate builds it (`chat/use-sign-in-gate.ts`). */
export interface GenexNoticeProps {
  need: GenexNeed;
  /** The person went on to genex.games in the browser. */
  waiting: boolean;
  installing: boolean;
  problem: string | null;
  /** The person's own plans, and whether each is connected now. */
  plans: readonly OwnPlan[];
  /** The main button: the build page, more credits, the setup or a recheck. */
  onPrimary(): void;
  /** Move the chat onto one of the person's own plans. */
  onUse(engine: SubscriptionId): void;
}

/**
 * The blue notice a Genex model shows while it cannot build yet: Genex's G, one line saying what
 * is missing, its one main step, and the person's own Claude and ChatGPT plans as the other way.
 * Over a game's first message (`held`) it says the message waits; it is sent once Genex is ready.
 */
export function GenexNotice({ held = false, ...props }: GenexNoticeProps & { held?: boolean }): JSX.Element {
  const words = genexNoticeWords(props.need, { held, waiting: props.waiting, installing: props.installing });
  const { tint, links } = planActions(props.need, props.plans);
  return (
    <div className="genex-notice" role="status" data-genex-notice={props.need}>
      <div className="genex-notice-body">
        <GenexMark size={13} />
        <p className="genex-notice-line">{words.line}</p>
      </div>
      {props.problem ? (
        <p role="alert" className="genex-notice-problem">
          {props.problem}
        </p>
      ) : null}
      <div className="genex-notice-actions">
        {words.primary ? (
          <Button variant="default" data-genex-action="primary" onClick={props.onPrimary}>
            {words.primary}
          </Button>
        ) : null}
        {tint ? (
          <Button variant="accent-tint" data-genex-action={tint.engine} onClick={() => props.onUse(tint.engine)}>
            {tint.label}
          </Button>
        ) : null}
        {links.map((link) => (
          <button
            key={link.engine}
            type="button"
            className="genex-notice-link"
            data-genex-action={link.engine}
            onClick={() => props.onUse(link.engine)}
          >
            {link.label}
          </button>
        ))}
      </div>
    </div>
  );
}

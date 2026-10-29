/**
 * A game's coin purchase: Studio's own sheet over the dimmed game, in the bar's layer, as main draws
 * it (`PlayBarState.purchase`). Main reads the purchase, decides every step and pays or cancels only
 * the purchase it holds; the page draws the step and answers naming the sheet on screen, so a press
 * meant for an earlier step is dropped. Each step mounts afresh: the keyboard starts on Cancel (Back
 * once the purchase is over), then the page tells main the step is shown, and main arms Pay from
 * there. Esc, ✕ and a click outside cancel a purchase still open, go back from one that is over,
 * and do nothing while paying. A game writes the item's name and description: they reach the page
 * whole, without the characters that turn text around.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { JSX, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { type PlayPurchaseSheet, PurchaseAnswer, type PurchaseItem, PurchaseStep } from "../../shared/play-purchase.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useMoreBelow } from "../ui/scroll-fade.ts";
import { PLAY_WORDS } from "../words.ts";
import { CoinMark } from "./CoinMark.tsx";
import type { BarApi } from "./PlayBarPage.tsx";
import {
  BalanceLine,
  type BalanceView,
  balanceView,
  coinNumber,
  coinText,
  gameText,
  noticeWords,
  purchaseEscape,
  quantityText,
  type SheetButton,
  SheetLayout,
  sheetActions,
  sheetFocus,
  sheetLayout,
  sheetNote,
  usdText,
} from "./purchase-model.ts";

const WORDS = PLAY_WORDS.purchase;
/** A sheet with no line of news under its title says what it is through its rows instead. */
const NOT_DESCRIBED = { "aria-describedby": undefined };

/** Answer the sheet on screen. */
type Answer = (answer: PurchaseAnswer) => void;
type Price = NonNullable<PlayPurchaseSheet["price"]>;

/**
 * The game's small cover, as Play's rows draw it (`PlayThumb`, whose module brings the studio's
 * stores, which the bar's layer does not have).
 */
function GameThumb({ src }: { src: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="play-thumb play-thumb-blank" aria-hidden="true" />;
  return (
    <img
      className="play-thumb"
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** The item's picture, or a plain tile with a box while it has none or it fails to load; a check once paid. */
function ItemPicture({ item, compact, paid }: { item: PurchaseItem; compact: boolean; paid: boolean }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : item.imageUrl;
  return (
    <span className="play-purchase-picture" data-compact={compact || undefined}>
      {src ? (
        <img src={src} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="play-purchase-placeholder" aria-hidden="true">
          <Icon name="box" size={compact ? 18 : 28} strokeWidth={1.5} />
        </span>
      )}
      {paid && (
        <span className="play-purchase-badge" aria-hidden="true">
          <Icon name="check" size={14} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}

/** The item's name as a game wrote it, and how many beside it. */
function ItemName({ item }: { item: PurchaseItem }): JSX.Element {
  const quantity = quantityText(item.quantity);
  return (
    <>
      <span className="play-purchase-name" dir="auto">
        {gameText(item.name)}
      </span>
      {quantity && <span className="play-purchase-quantity">{quantity}</span>}
    </>
  );
}

/** The terms a game wrote, whole: they scroll inside the sheet, so the price and the buttons stay in view. */
function ItemDescription({ text }: { text: string }): JSX.Element {
  const fade = useMoreBelow<HTMLDivElement>();
  return (
    <div ref={fade} className="play-purchase-description scroll-fade" dir="auto">
      {gameText(text)}
    </div>
  );
}

/** The price in coin with the coin mark, and in dollars under it when genex.games gives them. */
function Amount({ price, dollars = true }: { price: Price; dollars?: boolean }): JSX.Element {
  return (
    <span className="play-purchase-amount">
      <span className="play-purchase-coins">
        <CoinMark />
        {coinText(price.coins)}
      </span>
      {dollars && price.usdCents !== null && <span className="play-purchase-usd">{usdText(price.usdCents)}</span>}
    </span>
  );
}

/** The balance: what it comes to after paying, what is missing, or what is left. */
function BalanceFigures({ view }: { view: BalanceView }): JSX.Element {
  if (view.line === BalanceLine.Short)
    return (
      <span className="play-purchase-amount">
        <span className="play-purchase-figures">{coinText(view.now)}</span>
        <span className="play-purchase-short">{WORDS.moreNeeded(coinNumber(view.more))}</span>
      </span>
    );
  if (view.line === BalanceLine.Left) return <span className="play-purchase-figures">{coinText(view.now)}</span>;
  return (
    <span className="play-purchase-figures">
      <span className="play-purchase-was">{coinNumber(view.now)}</span>
      <span className="play-purchase-was" aria-hidden="true">
        →
      </span>
      <span className="sr-only">{WORDS.afterPaying}</span>
      <span>{coinText(view.after)}</span>
    </span>
  );
}

/** The price box, or the receipt once paid: the price, then the balance. */
function PriceBox({ sheet, price }: { sheet: PlayPurchaseSheet; price: Price }): JSX.Element {
  const paid = sheet.step === PurchaseStep.Paid;
  const balance = balanceView(sheet);
  return (
    <dl className="play-purchase-price" data-paid={paid || undefined} role={paid ? "status" : undefined}>
      <div className="play-purchase-row">
        <dt className={paid ? "play-purchase-paid" : undefined}>
          {paid && <Icon name="check" size={16} />}
          {paid ? WORDS.paid : WORDS.price}
        </dt>
        <dd>
          <Amount price={price} />
        </dd>
      </div>
      {balance && (
        <div className="play-purchase-row">
          <dt>{WORDS.balance}</dt>
          <dd>
            <BalanceFigures view={balance} />
          </dd>
        </div>
      )}
    </dl>
  );
}

/** The item in full: its picture, its name, then its description, or the receipt line once paid. */
function ItemHead({ sheet }: { sheet: PlayPurchaseSheet }): JSX.Element {
  const { item } = sheet;
  const paid = sheet.step === PurchaseStep.Paid;
  // Ask always has its item; a dialog without one still needs a title, so the game's stands in.
  if (!item) return <Dialog.Title className="play-purchase-title">{gameText(sheet.game.title)}</Dialog.Title>;
  return (
    <div className="play-purchase-item">
      <ItemPicture item={item} compact={false} paid={paid} />
      <div className="play-purchase-item-text">
        <Dialog.Title className="play-purchase-title">
          <ItemName item={item} />
        </Dialog.Title>
        {paid && (
          <Dialog.Description className="play-purchase-body">
            {WORDS.receipt(gameText(sheet.game.title))}
          </Dialog.Description>
        )}
        {!paid && item.description && <ItemDescription text={item.description} />}
      </div>
    </div>
  );
}

/** The item in short under a notice: picture, name and price, dimmed once the purchase failed. */
function CompactItem({ sheet, item }: { sheet: PlayPurchaseSheet; item: PurchaseItem }): JSX.Element {
  const failed = sheet.step === PurchaseStep.Failed;
  return (
    <div className="play-purchase-compact" data-dimmed={failed || undefined}>
      <ItemPicture item={item} compact paid={false} />
      <span className="play-purchase-compact-name">
        <ItemName item={item} />
      </span>
      {sheet.price && <Amount price={sheet.price} dollars={sheet.step === PurchaseStep.SignedOut} />}
    </div>
  );
}

/** A title and a line of news: Signed out, Pending, Failed; then the item in short when it was read. */
function Notice({ sheet }: { sheet: PlayPurchaseSheet }): JSX.Element {
  const words = noticeWords(sheet);
  return (
    <>
      <div className="play-purchase-notice">
        <Dialog.Title className="play-purchase-title">
          {sheet.step === PurchaseStep.Pending && <Icon name="clock" size={18} className="play-purchase-clock" />}
          {words?.title}
        </Dialog.Title>
        <Dialog.Description className="play-purchase-body">{words?.body}</Dialog.Description>
      </div>
      {sheet.item && <CompactItem sheet={sheet} item={sheet.item} />}
    </>
  );
}

/** One of the sheet's buttons. */
function ActionButton({
  action,
  answer,
  start,
  primary,
}: {
  action: SheetButton;
  answer: Answer;
  start: RefObject<HTMLButtonElement | null> | undefined;
  primary: boolean;
}): JSX.Element {
  return (
    <Button
      ref={start}
      variant={primary ? "play-fill" : "secondary"}
      className="play-purchase-action"
      disabled={action.disabled}
      busy={action.busy}
      data-play-purchase-action={action.answer}
      onClick={() => answer(action.answer)}
    >
      {action.label}
      {action.outside && <Icon name="arrow-up-right" className="size-3.5" />}
    </Button>
  );
}

/**
 * What the sheet shows for one step: its game, the purchase as the step lays it out, and its buttons.
 * Keyed by the sheet's number: once on screen the keyboard starts on its first button (Cancel when
 * there is one, never Pay), and main hears the step is shown, from which it arms Pay.
 */
export function PurchaseFace({ sheet, answer }: { sheet: PlayPurchaseSheet; answer: Answer }): JSX.Element {
  const actions = sheetActions(sheet);
  const focus = sheetFocus(actions);
  const start = useRef<HTMLButtonElement>(null);
  const said = useRef(answer);
  said.current = answer;
  const told = useRef(false);
  useEffect(() => {
    start.current?.focus();
    // Once per sheet, StrictMode's replay included: each Shown starts Pay's wait again.
    if (told.current) return;
    told.current = true;
    said.current(PurchaseAnswer.Shown);
  }, []);
  const leave = purchaseEscape(sheet);
  const layout = sheetLayout(sheet);
  const note = sheetNote(sheet);
  const refFor = (action: SheetButton) => (action === focus ? start : undefined);
  return (
    <>
      <button
        type="button"
        className="play-purchase-close"
        aria-label={WORDS.close}
        data-play-purchase-close
        disabled={leave === null}
        onClick={() => leave && answer(leave)}
      >
        <Icon name="close" size={16} />
      </button>
      <div className="play-purchase-game">
        <GameThumb src={sheet.game.coverUrl} />
        <span className="play-purchase-game-title" dir="auto">
          {gameText(sheet.game.title)}
        </span>
      </div>
      {layout === SheetLayout.Notice ? <Notice sheet={sheet} /> : <ItemHead sheet={sheet} />}
      {layout !== SheetLayout.Notice && sheet.price && <PriceBox sheet={sheet} price={sheet.price} />}
      <div className="play-purchase-foot">
        <div className="play-purchase-actions">
          {actions.quiet && (
            <ActionButton action={actions.quiet} answer={answer} start={refFor(actions.quiet)} primary={false} />
          )}
          <ActionButton action={actions.primary} answer={answer} start={refFor(actions.primary)} primary />
        </div>
        {note && <p className="play-purchase-note">{note}</p>}
      </div>
    </>
  );
}

/** The sheet over the dimmed game for `sheet`, answering main through `api`. */
export function PlayPurchase({ api, sheet }: { api: BarApi; sheet: PlayPurchaseSheet }): JSX.Element {
  // The viewer may have closed under the press: nothing is left for it to do.
  const answer: Answer = (said) => void api.playPurchase(sheet.sheet, said).catch(() => undefined);
  const leave = purchaseEscape(sheet);
  const dismiss = (): void => {
    if (leave) answer(leave);
  };
  const failed = sheet.step === PurchaseStep.Failed;
  const described = sheetLayout(sheet) !== SheetLayout.Item;
  return (
    // Main opens and closes the sheet: Radix never closes it by itself.
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="play-purchase-scrim" />
        <Dialog.Content
          className="play-purchase"
          role={failed ? "alertdialog" : "dialog"}
          aria-busy={sheet.step === PurchaseStep.Paying || undefined}
          data-play-purchase={sheet.step}
          data-play-purchase-problem={sheet.problem ?? undefined}
          data-play-purchase-recovery={sheet.recovery ?? undefined}
          {...(described ? {} : NOT_DESCRIBED)}
          // The face puts the keyboard on its first button; nothing returns it to the bar's controls.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            // A held Esc that moved the keyboard here keeps repeating: only a fresh press answers.
            if (!event.repeat) dismiss();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            // A right click (or Control-click) outside opens no menu here and answers nothing, as in Radix.
            const { button, ctrlKey } = event.detail.originalEvent;
            if (button === 0 && !ctrlKey) dismiss();
          }}
          onFocusOutside={(event) => event.preventDefault()}
        >
          <PurchaseFace key={sheet.sheet} sheet={sheet} answer={answer} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

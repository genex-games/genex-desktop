/**
 * An item's sheet on a game's Play page (marketplace P7, screens 03–05), over the dimmed page. It
 * opens at once with the item: its render ("Drag to turn" once a model draws), name, description,
 * "Works in N games" with the games' covers, and the price. Pay starts the purchase: main reads it
 * and runs Play's own purchase sheet for it (`storeBuy`, `onStoreSheet`), and this draws each step
 * main shows in the item's layout and answers it naming the sheet on screen (`storeAnswer`): Pay
 * counts only once main armed it, the keyboard never starts on Pay, and ✕, Esc and a click outside
 * cancel a purchase still open and close one that is over. Not enough coin offers Get Nex, which
 * opens genex.games, and Review once the coin lands. A Free item's Get claims it here; an item the
 * player has shows as theirs. The ⋯ menu reports the item (P22). Main pays or cancels only the
 * purchase it started.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { JSX, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PlayPurchaseSheet, PurchaseAnswer, PurchaseProblem, PurchaseStep } from "../../shared/play-purchase.ts";
import {
  ITEM_REPORT_MESSAGE_MAX,
  type ItemGames,
  ItemReportReason,
  type PlayerItem,
  StoreRefusal,
  type StoreSheet,
} from "../../shared/store-items.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { PLAY_STORE_WORDS, PLAY_WORDS } from "../words.ts";
import { CoinMark } from "./CoinMark.tsx";
import { ItemRender } from "./ItemRender.tsx";
import {
  coinNumber,
  coinText,
  gameText,
  purchaseEscape,
  type SheetButton,
  StoreFocus,
  type StoreNotice,
  storeBalanceLine,
  storeHeldLine,
  storeNotice,
  storePayLabel,
  storeSheetAction,
  storeSheetFocus,
  storeSheetNote,
  usdText,
} from "./purchase-model.ts";
import { afterBuy, afterClaim, type ItemOffer, type SheetNext, SheetPhase, sheetOpens } from "./store-model.ts";
import { useGenexSignIn } from "./use-genex-sign-in.ts";

const WORDS = PLAY_STORE_WORDS;
const PURCHASE = PLAY_WORDS.purchase;
/** The covers "Works in N games" stacks beside its words. */
const COVERS_SHOWN = 4;
/** A sheet with no line of news under its title says what it is through its rows instead. */
const NOT_DESCRIBED = { "aria-describedby": undefined };

/** The item a card's press chose, and what it offers. */
export interface ChosenItem {
  item: PlayerItem;
  offer: ItemOffer;
}

/** The sheet's one button as a face draws it. */
interface FaceAction {
  label: string;
  disabled: boolean;
  busy: boolean;
  outside: boolean;
  hook: string;
  press(): void;
}

/** What a face puts between the item's name and its button. */
interface FaceParts {
  /** Said in place of the description (paid, claimed, signed out, failed); null shows the description. */
  notice: StoreNotice | null;
  worksIn: boolean;
  /** The price and the line under it, while it can still be paid; null shows none. */
  /** `held`: the line under a short balance about earned coin still on hold, when there is some. */
  price: { coins: number; usdCents: number | null; line: string | null; short: boolean; held: string | null } | null;
  /** The row that stands for the price once it is the player's (Paid, Owned) or cannot be had here. */
  status: { text: string; tone: "done" | "quiet"; right: string | null } | null;
  action: FaceAction;
  note: string | null;
  /** The check over the render: the item is the player's now. */
  yours: boolean;
  /** Where the keyboard starts: ✕, the button, or nowhere while it works. */
  focus: StoreFocus | null;
}

const buttonAction = (button: SheetButton, answer: (said: PurchaseAnswer) => void): FaceAction => ({
  label: button.label,
  disabled: button.disabled,
  busy: button.busy,
  outside: button.outside,
  hook: button.answer,
  press: () => answer(button.answer),
});

/** A step main shows, in the item's layout. */
function mainParts(sheet: PlayPurchaseSheet, answer: (said: PurchaseAnswer) => void): FaceParts {
  const notice = storeNotice(sheet);
  const paid = sheet.step === PurchaseStep.Paid;
  const line = storeBalanceLine(sheet);
  const payable = notice === null && sheet.price !== null;
  return {
    notice,
    worksIn: notice === null,
    price:
      payable && sheet.price
        ? {
            ...sheet.price,
            line,
            short: sheet.step === PurchaseStep.NotEnough && line !== null,
            held: storeHeldLine(sheet),
          }
        : null,
    status: paid ? { text: PURCHASE.paid, tone: "done", right: line } : null,
    action: buttonAction(storeSheetAction(sheet), answer),
    note: storeSheetNote(sheet),
    yours: paid,
    focus: storeSheetFocus(sheet),
  };
}

/** The item's own price, while main has not read the purchase (or for a Free item). */
const itemPrice = (item: PlayerItem): FaceParts["price"] => ({
  coins: item.priceCoins,
  usdCents: item.priceCoins > 0 ? item.priceDisplayUsdCents : null,
  line: null,
  short: false,
  held: null,
});

/** What the local phases' buttons do. */
interface LocalPresses {
  claim(): void;
  close(): void;
  signIn: { busy: boolean; signIn(): void };
}

/** A phase of the sheet before (or instead of) main's purchase sheet, in the item's layout. */
function localParts(phase: SheetPhase, item: PlayerItem, presses: LocalPresses): FaceParts {
  const done = (label: string, hook: string): FaceAction => ({
    label,
    disabled: false,
    busy: false,
    outside: false,
    hook,
    press: presses.close,
  });
  const base: FaceParts = {
    notice: null,
    worksIn: true,
    price: null,
    status: null,
    action: done(WORDS.done, "done"),
    note: null,
    yours: false,
    focus: StoreFocus.Action,
  };
  switch (phase) {
    case SheetPhase.Opening:
      return {
        ...base,
        price: itemPrice(item),
        action: { ...done(storePayLabel(item.priceCoins), PurchaseAnswer.Pay), disabled: true, busy: true },
        focus: null,
      };
    case SheetPhase.Get:
    case SheetPhase.Claiming: {
      const claiming = phase === SheetPhase.Claiming;
      const get = { ...done(WORDS.get, "get"), press: presses.claim, busy: claiming, disabled: claiming };
      return { ...base, price: itemPrice(item), action: get, focus: claiming ? null : StoreFocus.Action };
    }
    case SheetPhase.Done:
      return { ...base, notice: { title: null, body: WORDS.yours }, worksIn: false, yours: true };
    case SheetPhase.Owned:
      return { ...base, status: { text: WORDS.owned, tone: "done", right: null } };
    case SheetPhase.NotHere:
      return { ...base, status: { text: WORDS.notHere, tone: "quiet", right: null } };
    case SheetPhase.SignIn: {
      const { busy, signIn } = presses.signIn;
      const action = { ...done(PURCHASE.signIn, PurchaseAnswer.SignIn), press: signIn, busy, disabled: busy };
      const notice = { title: PURCHASE.signedOutTitle, body: PURCHASE.signedOutBody };
      return { ...base, notice, worksIn: false, action, note: PURCHASE.signInNote };
    }
    case SheetPhase.Gone:
      return {
        ...base,
        notice: { title: WORDS.goneTitle, body: WORDS.goneBody },
        worksIn: false,
        action: done(WORDS.close, "close"),
      };
    default: {
      const failed = PURCHASE.failed[PurchaseProblem.Refused];
      const notice = { title: failed.title, body: WORDS.failedBody[PurchaseProblem.Refused] };
      return { ...base, notice, worksIn: false, action: done(WORDS.close, "close") };
    }
  }
}

/** "Works in N games": the first games' covers stacked, and the games named once opened. */
function WorksIn({ total, games }: { total: number; games: ItemGames | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = games?.games ?? [];
  return (
    <div className="item-sheet-works">
      <button
        type="button"
        className="item-sheet-works-row"
        aria-expanded={open}
        disabled={shown.length === 0}
        data-item-works-in={total}
        onClick={() => setOpen((was) => !was)}
      >
        {shown.length > 0 && (
          <span className="item-sheet-covers" aria-hidden="true">
            {shown
              .slice(0, COVERS_SHOWN)
              .map((game) =>
                game.coverUrl ? (
                  <img key={game.slug} src={game.coverUrl} alt="" draggable={false} decoding="async" />
                ) : (
                  <span key={game.slug} className="item-sheet-cover-blank" />
                ),
              )}
          </span>
        )}
        <span>{WORDS.worksIn(games?.total ?? total)}</span>
        {shown.length > 0 && <Icon name="chevron-right" size={14} className="item-sheet-works-chevron" />}
      </button>
      {open && (
        <ul className="item-sheet-games">
          {shown.map((game) => (
            <li key={game.slug} dir="auto">
              {gameText(game.title)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The price, in coin with its mark and in dollars beside it, and the balance line under it. */
function PriceRows({ price }: { price: NonNullable<FaceParts["price"]> }): JSX.Element {
  const free = price.coins === 0;
  return (
    <dl className="item-sheet-price">
      <div className="item-sheet-row">
        <dt>{WORDS.price}</dt>
        <dd className="item-sheet-amount">
          {free ? (
            <span className="item-sheet-free">{WORDS.free}</span>
          ) : (
            <>
              <span className="item-sheet-coins">
                <CoinMark />
                <span aria-hidden="true">{coinNumber(price.coins)}</span>
                <span className="sr-only">{coinText(price.coins)}</span>
              </span>
              {price.usdCents !== null && <span className="item-sheet-usd">{usdText(price.usdCents)}</span>}
            </>
          )}
        </dd>
      </div>
      {price.line && (
        <p className="item-sheet-balance" data-short={price.short || undefined}>
          {price.line}
        </p>
      )}
      {price.held && (
        <p className="item-sheet-held" data-item-sheet-held>
          {price.held}
        </p>
      )}
    </dl>
  );
}

/** The row standing for the price: Paid with the balance left, Owned, or Not in this game. */
function StatusRow({ status }: { status: NonNullable<FaceParts["status"]> }): JSX.Element {
  return (
    <div className="item-sheet-status" data-tone={status.tone} role="status">
      <span className="item-sheet-status-text">
        {status.tone === "done" && <Icon name="check" size={15} />}
        {status.text}
      </span>
      {status.right && <span className="item-sheet-balance">{status.right}</span>}
    </div>
  );
}

/** The ⋯ menu over the render: Report item. */
function MoreMenu({ onReport }: { onReport: () => void }): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="item-sheet-corner-button" aria-label={WORDS.more} data-item-sheet-more>
          <Icon name="more" size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="item-sheet-menu">
        <DropdownMenuItem data-item-report onSelect={onReport}>
          {WORDS.reportItem}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The item's report: why, an optional message, then Send report; Back returns to the sheet. */
function ReportForm({ item, onBack }: { item: PlayerItem; onBack: () => void }): JSX.Element {
  const [reason, setReason] = useState<ItemReportReason | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const send = async (): Promise<void> => {
    if (!reason) return;
    setSending(true);
    setError(null);
    try {
      const sent = await studio().api.storeReport(item.id, reason, message.trim() || null);
      if (sent === true) {
        studio().notify(WORDS.reportSent, ToastTone.Ok);
        onBack();
        return;
      }
      setError(sent.refused === StoreRefusal.TooManyRequests ? WORDS.reportLimited : WORDS.reportFailed);
    } catch {
      setError(WORDS.reportFailed);
    }
    setSending(false);
  };
  return (
    <div className="item-sheet-report" data-item-report-form>
      <Dialog.Title className="item-sheet-name">{WORDS.reportTitle}</Dialog.Title>
      <p className="item-sheet-report-item" dir="auto">
        {gameText(item.name)}
      </p>
      <fieldset className="item-sheet-reasons">
        <legend className="sr-only">{WORDS.reasonsLabel}</legend>
        {Object.values(ItemReportReason).map((value, index) => (
          <label key={value} className="item-sheet-reason" data-item-report-reason={value}>
            <input
              ref={index === 0 ? first : undefined}
              type="radio"
              name="item-report-reason"
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
            />
            {WORDS.reasons[value]}
          </label>
        ))}
      </fieldset>
      <Textarea
        className="item-sheet-report-message"
        placeholder={WORDS.reportMessage}
        aria-label={WORDS.reportMessage}
        maxLength={ITEM_REPORT_MESSAGE_MAX}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      {error && (
        <p className="item-sheet-report-error" role="alert">
          {error}
        </p>
      )}
      <div className="item-sheet-report-actions">
        <Button variant="secondary" onClick={onBack} disabled={sending}>
          {WORDS.back}
        </Button>
        <Button
          variant="play-fill"
          disabled={!reason || sending}
          busy={sending}
          data-item-report-send
          onClick={() => void send()}
        >
          {WORDS.sendReport}
        </Button>
      </div>
    </div>
  );
}

/** The sheet's face: the render with ⋯ and ✕, the item's words, its price or status, and its one button. */
function Face({
  item,
  parts,
  games,
  close,
  closable,
  onReport,
}: {
  item: PlayerItem;
  parts: FaceParts;
  games: ItemGames | null;
  close: () => void;
  closable: boolean;
  onReport: (() => void) | null;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  // Keyed by the step: each one mounts afresh and puts the keyboard where it starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the face's first draw places the keyboard.
  useEffect(() => {
    const starts: Record<StoreFocus, RefObject<HTMLButtonElement | null>> = {
      [StoreFocus.Close]: closeRef,
      [StoreFocus.Action]: actionRef,
    };
    if (parts.focus) starts[parts.focus].current?.focus();
  }, []);
  const { notice, action } = parts;
  const badge = parts.yours ? (
    <span className="item-sheet-yours" aria-hidden="true">
      <Icon name="check" size={15} strokeWidth={2.5} />
    </span>
  ) : null;
  return (
    <>
      <div className="item-sheet-stage">
        <ItemRender item={item} turnable badge={badge} className="item-sheet-render" />
        <div className="item-sheet-corner">
          {onReport && <MoreMenu onReport={onReport} />}
          <button
            ref={closeRef}
            type="button"
            className="item-sheet-corner-button"
            aria-label={WORDS.close}
            data-item-sheet-close
            disabled={!closable}
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
      <div className="item-sheet-words">
        <Dialog.Title className="item-sheet-name" dir="auto">
          {gameText(item.name)}
        </Dialog.Title>
        {notice?.title && <p className="item-sheet-news-title">{notice.title}</p>}
        {notice ? (
          <Dialog.Description className="item-sheet-text">{notice.body}</Dialog.Description>
        ) : (
          item.description && (
            <p className="item-sheet-text" dir="auto">
              {gameText(item.description)}
            </p>
          )
        )}
        {parts.worksIn && item.gamesCount > 1 && <WorksIn total={item.gamesCount} games={games} />}
      </div>
      {parts.price && <PriceRows price={parts.price} />}
      {parts.status && <StatusRow status={parts.status} />}
      <Button
        ref={actionRef}
        variant="play-fill"
        className="item-sheet-action"
        disabled={action.disabled}
        busy={action.busy}
        data-item-sheet-action={action.hook}
        onClick={action.press}
      >
        {action.label}
        {action.outside && <Icon name="arrow-up-right" className="size-3.5" />}
      </Button>
      {parts.note && <p className="item-sheet-note">{parts.note}</p>}
    </>
  );
}

/** Main's sheet for this item, while it is on screen, and whether one was ever shown. */
function useMainSheet(itemId: string, slug: string): { sheet: StoreSheet | null; seen: boolean } {
  const [state, setState] = useState<{ sheet: StoreSheet | null; seen: boolean }>({ sheet: null, seen: false });
  useEffect(
    () =>
      studio().api.onStoreSheet((sheet) => {
        if (sheet && (sheet.itemId !== itemId || sheet.slug !== slug)) return;
        setState((was) => ({ sheet, seen: was.seen || sheet !== null }));
      }),
    [itemId, slug],
  );
  return state;
}

/** Answer main's sheet on screen; the page may have gone under the press, which leaves nothing to do. */
const answerMain = (sheet: StoreSheet, said: PurchaseAnswer): void =>
  void studio()
    .api.storeAnswer(sheet.sheet, said)
    .catch(() => undefined);

/** Tells main once that this step of its sheet is drawn, from which it arms Pay. */
function useShown(sheet: StoreSheet | null): void {
  const told = useRef(0);
  useEffect(() => {
    if (!sheet || told.current === sheet.sheet) return;
    told.current = sheet.sheet;
    answerMain(sheet, PurchaseAnswer.Shown);
  }, [sheet]);
}

/** The purchase main starts for a Buy, once per attempt: how it ended moves the sheet on. */
function useBuy(
  phase: SheetPhase,
  attempt: number,
  chosen: ChosenItem,
  slug: string,
  moveOn: (next: SheetNext) => void,
): void {
  const started = useRef(-1);
  const go = useRef(moveOn);
  go.current = moveOn;
  useEffect(() => {
    if (phase !== SheetPhase.Opening || started.current === attempt) return;
    started.current = attempt;
    studio()
      .api.storeBuy(chosen.item.id, slug)
      .then(
        (result) => go.current(afterBuy(result)),
        () => go.current({ phase: SheetPhase.Failed, reread: false }),
      );
  }, [phase, attempt, chosen.item.id, slug]);
}

/** "Works in N games" for an item in more than one, read once the sheet opens. */
function useItemGames(item: PlayerItem): ItemGames | null {
  const [games, setGames] = useState<ItemGames | null>(null);
  useEffect(() => {
    if (item.gamesCount <= 1) return undefined;
    let live = true;
    void studio()
      .api.storeItemGames(item.id)
      .then((read) => live && setGames(read))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [item.id, item.gamesCount]);
  return games;
}

/** The phases in which the sheet is busy and cannot be closed. */
const BUSY: ReadonlySet<SheetPhase> = new Set([SheetPhase.Opening, SheetPhase.Claiming]);

/** The sheet's own phase, and Get's claim: a Buy starts main's purchase, and signing in starts the offer again. */
function useSheetPhase(
  chosen: ChosenItem,
  slug: string,
  account: string | null,
  ends: { onClose: () => void; onReread: () => void },
): { phase: SheetPhase; claim: () => void } {
  const [phase, setPhase] = useState<SheetPhase>(() => sheetOpens(chosen.offer));
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const said = useRef(ends);
  said.current = ends;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const moveOn = useCallback((next: SheetNext) => {
    if (!live.current) return;
    if (next.reread) said.current.onReread();
    if (next.phase === null) said.current.onClose();
    else setPhase(next.phase);
  }, []);
  useBuy(phase, attempt, chosen, slug, moveOn);
  // Signed in from the sheet: what it offered starts again (a Buy asks main anew).
  const before = useRef(account);
  useEffect(() => {
    const was = before.current;
    before.current = account;
    if (account === null || account === was || phase !== SheetPhase.SignIn) return;
    setPhase(sheetOpens(chosen.offer));
    setAttempt((tries) => tries + 1);
  }, [account, phase, chosen.offer]);
  const claim = useCallback(() => {
    setPhase(SheetPhase.Claiming);
    studio()
      .api.storeClaim(chosen.item.id, slug)
      .then(
        (result) => moveOn(afterClaim(result)),
        () => moveOn({ phase: SheetPhase.Failed, reread: false }),
      );
  }, [chosen.item.id, slug, moveOn]);
  return { phase, claim };
}

/** The page went from under a sheet main still shows: main closes it as ✕ would. */
function useLeaveOnUnmount(sheet: StoreSheet | null): void {
  const shown = useRef(sheet);
  shown.current = sheet;
  useEffect(
    () => () => {
      const left = shown.current;
      const leave = left && purchaseEscape(left);
      if (left && leave) answerMain(left, leave);
    },
    [],
  );
}

/** The item's sheet over the page of the game `slug`; `onReread` reads the store again after it changed. */
export function ItemSheet({
  chosen,
  slug,
  account,
  onClose,
  onReread,
}: {
  chosen: ChosenItem;
  slug: string;
  /** The Genex account's id, or null signed out: signing in from the sheet starts its offer again. */
  account: string | null;
  onClose: () => void;
  onReread: () => void;
}): JSX.Element | null {
  const { item } = chosen;
  const [reporting, setReporting] = useState(false);
  const main = useMainSheet(item.id, slug);
  const games = useItemGames(item);
  const signIn = useGenexSignIn();
  const { phase, claim } = useSheetPhase(chosen, slug, account, { onClose, onReread });
  useShown(main.sheet);
  useLeaveOnUnmount(main.sheet);
  // Main's sheet closed and the buy is answering: nothing is left to draw.
  if (!main.sheet && main.seen && phase === SheetPhase.Opening) return null;
  const mainSheet = main.sheet;
  const leaveMain = mainSheet ? purchaseEscape(mainSheet) : null;
  const closable = mainSheet ? leaveMain !== null : !BUSY.has(phase);
  const close = (): void => {
    if (reporting) setReporting(false);
    else if (mainSheet && leaveMain) answerMain(mainSheet, leaveMain);
    else if (!mainSheet && closable) onClose();
  };
  const parts = mainSheet
    ? mainParts(mainSheet, (said) => answerMain(mainSheet, said))
    : localParts(phase, item, { claim, close: onClose, signIn });
  const busy = mainSheet ? mainSheet.step === PurchaseStep.Paying : BUSY.has(phase);
  return (
    <SheetDialog
      hook={mainSheet ? mainSheet.step : phase}
      busy={busy}
      described={parts.notice !== null && !reporting}
      onDismiss={close}
    >
      {reporting ? (
        <ReportForm item={item} onBack={() => setReporting(false)} />
      ) : (
        <Face
          key={mainSheet ? `main-${mainSheet.sheet}` : `local-${phase}`}
          item={item}
          parts={parts}
          games={games}
          close={close}
          closable={closable}
          onReport={busy ? null : () => setReporting(true)}
        />
      )}
    </SheetDialog>
  );
}

/** The dialog over the dimmed page: Radix never closes it by itself; Esc and a click outside ask `onDismiss`. */
function SheetDialog({
  hook,
  busy,
  described,
  onDismiss,
  children,
}: {
  hook: string;
  busy: boolean;
  described: boolean;
  onDismiss: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="play-purchase-scrim item-sheet-scrim" />
        <Dialog.Content
          className="item-sheet"
          aria-busy={busy || undefined}
          data-item-sheet={hook}
          {...(described ? {} : NOT_DESCRIBED)}
          // The face puts the keyboard where it starts; nothing returns it to the card.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            // A held Esc keeps repeating: only a fresh press answers.
            if (!event.repeat) onDismiss();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            const { button, ctrlKey } = event.detail.originalEvent;
            if (button === 0 && !ctrlKey) onDismiss();
          }}
          onFocusOutside={(event) => event.preventDefault()}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

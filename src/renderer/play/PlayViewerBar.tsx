/**
 * The viewer's bar: the app's own 48px strip of glass over the game's top edge, drawn in the bar's
 * layer above the game's view (`PlayBarPage.tsx`). Back and the game's name with its facts (players
 * now, plays, maker) on the left; Like, Comments (its count, or the icon alone), Share (its icon
 * alone), Invite a friend in a multiplayer game, Remix and Exit on the right, as 32px buttons with 9px
 * corners, every one with a visible background. A note is worn by the button it is about, in place of its label
 * ("Link copied" on Share), and the button turns back when main drops it; a like of the player's own
 * bursts. Main keeps what it shows (`PlayViewerEvent.bar`), says when it is up, and acts on what it
 * asks (`studio:play.control`). An Esc held in the game puts the keyboard here (Esc gives it back).
 * A signed-out guest is offered a Genex account here until its ×. A game in voice chat gets the mic
 * switch beside its name, with a menu of microphones. Offline, the facts say so in place of the
 * players, and Like and Remix wait for the connection.
 */
import { sizeWords } from "../../shared/byte-size.ts";
import { NativeAppOffer, type PlayBarNative } from "../../shared/play-native.ts";
import type { CSSProperties, FocusEvent, JSX, PointerEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { type PlayBarState, type PlayMicBar, PlayControl, type PlayPoint } from "../../shared/play.ts";
import { Icon, type IconName } from "../ui/icons.tsx";
import { useOnline } from "../ui/use-online.ts";
import { NATIVE_WORDS, PLAY_WORDS } from "../words.ts";
import type { BarView } from "./bar-model.ts";
import { formatCount, justLiked, noteOn } from "./play-model.ts";

const WORDS = PLAY_WORDS.bar;
/** The sparks a like throws, as angles around the heart. */
const SPARKS = [0, 45, 90, 135, 180, 225, 270, 315];
/** The Genex G, as About and the plugin's tool icon draw it. */
const G_MARK =
  "M526.479 314.98H239.981V266.964H683V397.295C683 397.295 648.57 532.96 347.968 532.96C347.968 532.96 0 542.868 0 252.483C0 -16.5617 376.426 0.205967 376.426 0.205967C666.184 0.205967 683 141.207 683 141.207L607.973 153.401C607.973 153.401 584.689 45.1737 371.252 45.1737C371.252 45.1737 85.375 34.5034 85.375 257.818C85.375 257.818 78.9072 480.37 351.849 486.467C566.58 493.327 597.625 379.002 600.212 359.186C607.973 334.034 574.341 314.98 526.479 314.98Z";

/** Ask main for one of the bar's controls (a menu opens at `at`). */
export type SendControl = (control: PlayControl, at?: PlayPoint) => void;

/**
 * Players now, plays so far and the maker, in one muted line; nothing until main has read them.
 * Offline, Offline leads in place of the players (whose count would be stale), facts or none.
 */
function Facts({
  bar,
  online,
  send,
}: {
  bar: PlayBarState | null;
  online: boolean;
  send: SendControl;
}): JSX.Element | null {
  const facts = bar?.facts;
  if (!facts && online) return null;
  const parts = facts ? [WORDS.plays(formatCount(facts.plays))] : [];
  const players = online && facts?.online ? facts.online : 0;
  return (
    <span className="play-viewer-bar-facts">
      {!online && (
        <>
          <span className="play-viewer-bar-online" data-offline aria-hidden="true" />
          {PLAY_WORDS.offline.chip}
          {parts.length > 0 && " · "}
        </>
      )}
      {players > 0 && (
        <>
          <span className="play-viewer-bar-online" aria-hidden="true" />
          {WORDS.playing(players)} ·{" "}
        </>
      )}
      <span>
        {parts.join(" · ")}
        {facts?.author && (
          <>
            {" · "}
            <Maker name={facts.author} known={facts.authorId !== null} send={send} />
          </>
        )}
      </span>
    </span>
  );
}

/** The maker's name; with their account known, it leaves the game for their profile. */
function Maker({ name, known, send }: { name: string; known: boolean; send: SendControl }): JSX.Element {
  if (!known) return <>{name}</>;
  return (
    <button type="button" className="play-viewer-bar-maker" data-play-maker onClick={() => send(PlayControl.Maker)}>
      {name}
    </button>
  );
}

/** The Genex G, alone, in ink. */
function GenexMark(): JSX.Element {
  return (
    <svg
      className="play-genex-mark"
      width="16"
      height="12"
      viewBox="0 0 683 533"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={G_MARK} />
    </svg>
  );
}

/**
 * The guest's offer of a Genex account: a strip in Play's blue secondary wipes in around the G, one
 * line and Sign in, its × just outside it. It stays until that × or the game closes.
 */
function GuestOffer({ send }: { send: SendControl }): JSX.Element {
  return (
    <div className="play-viewer-bar-guest" role="status">
      <div className="play-viewer-bar-guest-strip">
        <GenexMark />
        <span className="play-viewer-bar-guest-text">{WORDS.guest}</span>
        <button type="button" className="play-viewer-bar-install" onClick={() => send(PlayControl.Install)}>
          {WORDS.install}
        </button>
      </div>
      <button
        type="button"
        className="play-viewer-bar-dismiss"
        aria-label={WORDS.dismissGuest}
        onClick={() => send(PlayControl.DismissCard)}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

/** Where a menu opens for `button`: under its left edge, on the window's page. */
function under(button: HTMLElement): PlayPoint {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

/** What the mic says in place of nothing: a note about it, else that the game waits for it. */
function micSays(bar: PlayBarState, mic: PlayMicBar): string | null {
  const worn = noteOn(bar, PlayControl.Mic);
  if (worn) return WORDS.notes[worn.note];
  return mic.waiting ? WORDS.micWaiting : null;
}

/**
 * The game's voice chat, once it is in it: the mic switch (the person's microphone feeds the game,
 * or not) and, joined to it, the menu of microphones (a native menu: the game's view covers anything
 * drawn under the header). While the game waits for the switch the switch says so, and a note about
 * the microphone ("No microphone") is worn the same way.
 */
function MicControl({ bar, mic, send }: { bar: PlayBarState; mic: PlayMicBar; send: SendControl }): JSX.Element {
  const says = micSays(bar, mic);
  const said = useLastNote(says);
  return (
    <div
      className="play-viewer-bar-mic"
      data-play-mic
      data-on={mic.on ? true : undefined}
      data-live={mic.live ? true : undefined}
      data-waiting={mic.waiting ? true : undefined}
    >
      <button
        type="button"
        className="play-viewer-bar-pill play-mic-switch"
        aria-pressed={mic.on}
        aria-label={says ?? (mic.on ? WORDS.micOn : WORDS.micOff)}
        data-play-bar={PlayControl.Mic}
        data-note={noteOn(bar, PlayControl.Mic)?.look}
        onClick={() => send(PlayControl.Mic)}
      >
        <span className="play-bar-icon">
          <Icon name={mic.on ? "mic" : "mic-off"} size={16} />
        </span>
        <span className="play-bar-label" data-shown={says ? true : undefined} aria-hidden={!says}>
          <span>{said}</span>
        </span>
      </button>
      <button
        type="button"
        className="play-viewer-bar-pill play-mic-menu"
        aria-label={WORDS.micDevices}
        aria-haspopup="menu"
        data-play-bar={PlayControl.MicDevices}
        onClick={(event) => send(PlayControl.MicDevices, under(event.currentTarget))}
      >
        <Icon name="chevron-down" size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

/** The last note a button wore, kept while it folds away so its words leave with it. */
function useLastNote(note: string | null): string {
  const last = useRef("");
  if (note) last.current = note;
  return last.current;
}

/**
 * One of the header's buttons. While main has a note about it the button wears the note in place of
 * its label (a done note with a check in place of its icon, tinted); the two labels fold into each
 * other, so the button changes width smoothly, and it turns back when the note goes.
 */
function BarButton({
  control,
  icon,
  label,
  bar,
  send,
  className = "",
  ariaLabel,
  ariaPressed,
  disabled,
  glyph,
}: {
  control: PlayControl;
  icon: IconName;
  /** None for a button that is its icon alone (Share): a note still unfolds beside it. */
  label?: ReactNode;
  bar: PlayBarState | null;
  send: SendControl;
  className?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  disabled?: boolean;
  /** The icon as drawn, when it is more than the glyph (the like's heart and its sparks). */
  glyph?: ReactNode;
}): JSX.Element {
  const worn = noteOn(bar, control);
  const said = useLastNote(worn ? WORDS.notes[worn.note] : null);
  return (
    <button
      type="button"
      className={`play-viewer-bar-pill ${className}`}
      aria-label={worn ? said : ariaLabel}
      aria-pressed={ariaPressed}
      data-play-bar={control}
      data-note={worn?.look}
      data-icon-only={label === undefined && !worn ? true : undefined}
      disabled={disabled}
      onClick={() => send(control)}
    >
      <span className="play-bar-icon">
        {glyph ?? <Icon name={icon} size={16} />}
        <Icon name="check" size={16} className="play-bar-check" />
      </span>
      {label !== undefined && (
        <span className="play-bar-label" data-shown={worn ? undefined : true}>
          <span>{label}</span>
        </span>
      )}
      <span className="play-bar-label" data-shown={worn ? true : undefined} aria-hidden={!worn}>
        <span>{said}</span>
      </span>
    </button>
  );
}

/**
 * The heart, popping and throwing sparks each time the player's own like turns it on; a like taken
 * back at once (signed out) stops them where they are.
 */
function Heart({ bursts, liked }: { bursts: number; liked: boolean }): JSX.Element {
  const lit = bursts > 0 && liked;
  return (
    <span key={bursts} className="play-like-heart" data-burst={lit ? true : undefined}>
      <Icon name="heart" size={16} />
      {lit && (
        <span className="play-like-sparks" aria-hidden="true">
          {SPARKS.map((angle) => (
            <i key={angle} style={{ "--angle": `${angle}deg` } as CSSProperties} />
          ))}
        </span>
      )}
    </span>
  );
}

/** How many times the player's own like has turned the heart on since the header first drew. */
function useLikeBursts(bar: PlayBarState | null): number {
  const before = useRef(bar);
  const [bursts, setBursts] = useState(0);
  useEffect(() => {
    if (justLiked(before.current, bar)) setBursts((count) => count + 1);
    before.current = bar;
  }, [bar]);
  return bursts;
}

/** Comments, after Like: its icon with the count, or the icon alone while there are none (or none counted yet). */
function CommentsButton({ count, onOpen }: { count: number | null; onOpen: () => void }): JSX.Element {
  const shown = count ? formatCount(count) : null;
  return (
    <button
      type="button"
      className="play-viewer-bar-pill"
      aria-label={shown ? WORDS.commentsCount(shown) : WORDS.comments}
      aria-haspopup="dialog"
      data-play-comments
      data-icon-only={shown ? undefined : true}
      onClick={onOpen}
    >
      <span className="play-bar-icon">
        <Icon name="chat" size={16} />
      </span>
      {shown && (
        <span className="play-bar-label" data-shown>
          <span>{shown}</span>
        </span>
      )}
    </button>
  );
}

/**
 * The game's actions: Like with its count, Comments, Share, Invite a friend in a multiplayer game,
 * Remix when it may be remixed, Exit.
 */
function Actions({
  bar,
  actions,
  online,
  send,
  onComments,
}: {
  bar: PlayBarState | null;
  actions: RefObject<HTMLDivElement | null>;
  online: boolean;
  send: SendControl;
  onComments: () => void;
}): JSX.Element {
  // Like and Remix need genex.games; Share and Invite copy a link, which works offline. One remix at a time.
  const remixWaits = bar?.remixing === true || !online;
  const likes = formatCount(bar?.likes ?? 0);
  const bursts = useLikeBursts(bar);
  return (
    <div ref={actions} className="play-viewer-bar-actions">
      {bar?.nativeApp && <NativeAppButton app={bar.nativeApp} send={send} />}
      <BarButton
        control={PlayControl.Like}
        icon="heart"
        glyph={<Heart bursts={bursts} liked={bar?.liked === true} />}
        label={
          <span key={likes} className="play-like-count" data-rolled={bursts > 0 ? true : undefined}>
            {likes}
          </span>
        }
        bar={bar}
        send={send}
        ariaLabel={WORDS.likes(likes)}
        ariaPressed={bar?.liked === true}
        disabled={!online}
      />
      <CommentsButton count={bar?.comments ?? null} onOpen={onComments} />
      <BarButton control={PlayControl.Share} icon="export" ariaLabel={WORDS.share} bar={bar} send={send} />
      {bar?.multiplayer && (
        <BarButton control={PlayControl.Invite} icon="users" label={WORDS.invite} bar={bar} send={send} />
      )}
      {bar?.remixable && (
        <BarButton
          control={PlayControl.Remix}
          icon="remix"
          label={WORDS.remix}
          bar={bar}
          send={send}
          className="play-viewer-bar-remix"
          disabled={remixWaits}
        />
      )}
      <button
        type="button"
        className="play-viewer-bar-pill play-viewer-bar-exit"
        aria-label={WORDS.exit}
        data-play-bar={PlayControl.Exit}
        onClick={() => send(PlayControl.Exit)}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/** The game's native app beside Like: install it, its install's progress as a ring, or play it. */
function NativeAppButton({ app, send }: { app: PlayBarNative; send: SendControl }): JSX.Element {
  const platform = NATIVE_WORDS.platform[app.platform];
  const size = sizeWords(app.bytes);
  const installing = app.offer === NativeAppOffer.Installing;
  const label = (() => {
    if (installing) return NATIVE_WORDS.appInstalling(platform, app.percent);
    if (app.offer === NativeAppOffer.Ready) return NATIVE_WORDS.playApp(platform);
    return NATIVE_WORDS.app(platform);
  })();
  return (
    <button
      type="button"
      className="play-viewer-bar-pill play-viewer-bar-native"
      aria-label={app.offer === NativeAppOffer.Install ? NATIVE_WORDS.installAppLabel(platform, size) : label}
      data-play-bar={PlayControl.NativeApp}
      data-native-offer={app.offer}
      aria-disabled={installing || undefined}
      onClick={() => send(PlayControl.NativeApp)}
    >
      <span className="play-bar-icon">
        {installing ? (
          <span
            className="play-bar-ring"
            aria-hidden="true"
            style={{ background: `conic-gradient(currentColor ${app.percent * 3.6}deg, transparent 0)` }}
          />
        ) : (
          <Icon name={app.offer === NativeAppOffer.Ready ? "play" : "download"} size={16} />
        )}
      </span>
      <span className="play-bar-label" data-shown>
        <span>
          {label}
          {app.offer === NativeAppOffer.Install && <span className="play-bar-size"> {size}</span>}
        </span>
      </span>
    </button>
  );
}

/** What holds the bar up, as the layer tracks it: the pointer over it, or the keyboard in it. */
export interface BarHolds {
  pointer(over: boolean): void;
  keyboard(inside: boolean): void;
}

/** The bar over the game `view` shows; it fades up and out while main says it is down. */
export function PlayViewerBar({
  view,
  send,
  holds,
  onComments,
}: {
  view: BarView;
  send: SendControl;
  holds: BarHolds;
  onComments: () => void;
}): JSX.Element {
  const { bar } = view;
  const title = bar?.title ?? "";
  const actions = useRef<HTMLDivElement>(null);
  const online = useOnline();
  // An Esc held in the game asked for the keyboard: it lands on the first action that can act (Like,
  // unless it waits for the connection).
  useEffect(() => {
    if (view.focusAsks) actions.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [view.focusAsks]);
  // Only the keyboard's own focus holds the bar up; a button a click focused does not.
  const entered = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.target.matches(":focus-visible")) holds.keyboard(true);
  };
  const left = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) holds.keyboard(false);
  };
  // A press with the pointer leaves the keyboard with the game; a control that opens something keeps it.
  const pressed = (event: PointerEvent<HTMLDivElement>): void => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (button && !button.hasAttribute("aria-haspopup")) send(PlayControl.Resume);
  };
  return (
    <div
      role="group"
      className="play-viewer-bar"
      aria-label={WORDS.label(title)}
      data-play-viewer-bar
      data-down={bar?.shown === false ? true : undefined}
      onPointerEnter={() => holds.pointer(true)}
      onPointerMove={() => holds.pointer(true)}
      onPointerLeave={() => holds.pointer(false)}
      onPointerUp={pressed}
      onFocus={entered}
      onBlur={left}
    >
      <button
        type="button"
        className="play-viewer-bar-back"
        aria-label={WORDS.back}
        data-play-bar={PlayControl.Back}
        onClick={() => send(PlayControl.Back)}
      >
        <Icon name="chevron-left" size={16} />
      </button>
      <div className="play-viewer-bar-name">
        <span className="play-viewer-bar-title">{title}</span>
        <Facts bar={bar} online={online} send={send} />
      </div>
      {bar?.mic && <MicControl bar={bar} mic={bar.mic} send={send} />}
      {bar?.guestCard && <GuestOffer send={send} />}
      <span className="play-viewer-bar-gap" />
      {/* The note is worn by its button; this says it to a screen reader. */}
      <span className="sr-only" role="status">
        {bar?.note ? WORDS.notes[bar.note] : null}
      </span>
      <Actions bar={bar} actions={actions} online={online} send={send} onComments={onComments} />
    </div>
  );
}

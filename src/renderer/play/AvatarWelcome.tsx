/**
 * An account meets its generated avatar: a beam scans up over a wireframe sphere and builds it,
 * then the mix it was made of (body, eyes, how block eyes look, gear), Regenerate (another avatar,
 * built again under the beam; a refusal is said here, with Try again) and Continue, which waits
 * while a regenerated avatar is being saved. The avatar is already the account's, in the app and on
 * genex.games; Settings is where it changes later. Once
 * genex.games knows nicknames, the welcome also asks for one (prefilled with the account's handle):
 * once for an account that has not chosen it, here or on genex.games, and Continue waits until the
 * nickname may be had. Before that, it is shown once per account on this Mac. Never over the first
 * launch's welcome.
 */
import type { JSX, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { handleBaseFromName } from "../../shared/handle.ts";
import { GenexPromoState, storedGenexPromo } from "../genex-promo.ts";
import { avatarRecipe } from "../../shared/avatar-recipe.ts";
import { AvatarStyle, type PlayMe } from "../../shared/play-people.ts";
import { AvatarMotion, GeneratedAvatar } from "../avatars/GeneratedAvatar.tsx";
import { usePeople, usePlay } from "../state/hooks.ts";
import { readText, storageKeyFor, writeText } from "../storage.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { Icon } from "../ui/icons.tsx";
import { useOnline } from "../ui/use-online.ts";
import { ACCOUNT_WORDS, AVATAR_WORDS, NICKNAME_WORDS } from "../words.ts";
import { mixOf } from "./avatar-mix.ts";
import { HandleField, useNicknameEdit } from "./HandleField.tsx";
import { HandleHint, WelcomeKind, type WelcomesSeen, welcomeFor } from "./nickname-model.ts";
import { regenerateAvatar } from "./use-regenerate-avatar.ts";

const WORDS = AVATAR_WORDS;
/** The nickname field's id in the welcome. */
const NICKNAME_FIELD = "avatar-welcome-nickname";
/** The avatar's stage, and where its body sits on it (`avatar-painter.ts`'s geometry with gear). */
const STAGE = 240;
const BODY = { cx: STAGE / 2, cy: STAGE * 0.55, r: STAGE * 0.4 } as const;
/** The wireframe's latitude rings: how far from the middle each sits, and how wide it is, as shares of the radius. */
const LATITUDES = [
  [0, 1],
  [-0.38, 0.88],
  [0.38, 0.88],
  [-0.7, 0.58],
  [0.7, 0.58],
] as const;
const LONGITUDES = [0.3, 0.66] as const;
/** How often a waiting welcome looks again whether the Genex promo card has settled. */
const PROMO_CHECK_MS = 2 * SECOND_MS;

/**
 * Whether the Genex promo card is still out (connecting, or saying it connected): the welcome waits
 * for it. Looked at again whenever the welcome could show, since the card may come after the app
 * started (the first launch's welcome queues it), and every little while until it settles.
 */
function usePromoOut(active: boolean): boolean {
  const [out, setOut] = useState(() => storedGenexPromo() === GenexPromoState.Pending);
  useEffect(() => {
    if (!active) return;
    const look = (): void => setOut(storedGenexPromo() === GenexPromoState.Pending);
    look();
    const timer = window.setInterval(look, PROMO_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return out;
}

/** The sphere's wireframe the beam builds the avatar over. */
function Wireframe(): JSX.Element {
  const { cx, cy, r } = BODY;
  return (
    <svg className="avatar-welcome-wire" viewBox={`0 0 ${STAGE} ${STAGE}`} fill="none" aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} />
      {LATITUDES.map(([at, width]) => (
        <ellipse key={at} cx={cx} cy={cy + at * r} rx={r * width} ry={r * width * 0.3} />
      ))}
      {LONGITUDES.map((width) => (
        <ellipse key={width} cx={cx} cy={cy} rx={r * width} ry={r} />
      ))}
    </svg>
  );
}

/** What this Mac remembers of an account's welcomes. */
const seenOnThisMac = (accountId: string): WelcomesSeen => ({
  avatar: readText(storageKeyFor.avatarWelcomed(accountId)) === "1",
  nickname: readText(storageKeyFor.nicknameWelcomed(accountId)) === "1",
});

/** The avatar being built under the beam, over its wireframe; a regenerated one is built again. */
function BuiltAvatar({ me }: { me: PlayMe }): JSX.Element {
  const recipe = useMemo(() => avatarRecipe(me.id, me.avatarVariant), [me.id, me.avatarVariant]);
  return (
    <>
      <div className="avatar-welcome-stage" key={me.avatarVariant}>
        <Wireframe />
        <div className="avatar-welcome-built">
          <GeneratedAvatar recipe={recipe} size={STAGE} full={false} motion={AvatarMotion.Live} />
        </div>
        <span className="avatar-welcome-beam" aria-hidden="true" />
      </div>
      <div className="avatar-welcome-copy">
        <h2 className="avatar-welcome-title">{WORDS.welcomeTitle}</h2>
        <p className="avatar-welcome-text">{WORDS.welcomeText}</p>
      </div>
      <ul className="avatar-welcome-mix" aria-label={WORDS.mixLabel}>
        {mixOf(recipe).map((part) => (
          <li key={part}>{part}</li>
        ))}
      </ul>
    </>
  );
}

/** Continue, which waits (`disabled`) while the nickname may not be had or is being saved. */
function ContinueButton({
  button,
  disabled = false,
  busy = false,
  onClick,
}: {
  button: RefObject<HTMLButtonElement | null>;
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      ref={button}
      type={onClick ? "button" : "submit"}
      className="people-button avatar-welcome-continue"
      data-tone="primary"
      data-avatar-welcome-continue
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {WORDS.continue}
    </button>
  );
}

/** Regenerate in the welcome: whether it shows, whether it waits, a refusal, and the presses. */
interface WelcomeRegenerate {
  shown: boolean;
  /** Offline, or a save runs: a press waits. */
  waits: boolean;
  saving: boolean;
  failed: boolean;
  button: RefObject<HTMLButtonElement | null>;
  regenerate: () => void;
  /** Try again after a refusal: as Regenerate, with the focus on Regenerate as the line goes. */
  retry: () => void;
}

/**
 * Regenerate as the welcome has it: shown while the generated avatar is the account's and
 * genex.games keeps a regenerated one (as Settings shows it). A refusal is said in the welcome, not
 * in a toast the dialog would cover; `saving` holds while any press's save runs.
 */
function useWelcomeRegenerate(me: PlayMe): WelcomeRegenerate {
  const saving = usePeople((s) => s.avatarSaving);
  const online = useOnline();
  const [failed, setFailed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const waits = !online || saving;
  const regenerate = (): void => {
    if (waits) return;
    setFailed(false);
    regenerateAvatar(me).catch(() => setFailed(true));
  };
  const retry = (): void => {
    button.current?.focus();
    regenerate();
  };
  const shown = me.avatarVariantKept && me.avatarStyle !== AvatarStyle.Photo;
  return { shown, waits, saving, failed, button, regenerate, retry };
}

/** Another generated avatar, at once; it waits for the connection and for the save before it. */
function RegenerateButton({ regen }: { regen: WelcomeRegenerate }): JSX.Element | null {
  if (!regen.shown) return null;
  return (
    <button
      ref={regen.button}
      type="button"
      className="people-button avatar-welcome-regenerate"
      data-avatar-welcome-regenerate
      aria-disabled={regen.waits || undefined}
      aria-busy={regen.saving || undefined}
      onClick={regen.regenerate}
    >
      <Icon name="dice" />
      {ACCOUNT_WORDS.regenerate}
    </button>
  );
}

/** Under the buttons: the note, or, after a refused Regenerate, why and Try again. */
function WelcomeFoot({ regen, note }: { regen: WelcomeRegenerate; note: string }): JSX.Element {
  if (!regen.failed) return <span className="avatar-welcome-note">{note}</span>;
  return (
    <p className="avatar-welcome-error" role="alert" data-avatar-welcome-error>
      {ACCOUNT_WORDS.regenerateFailed}
      <button
        type="button"
        className="avatar-welcome-retry"
        aria-disabled={regen.waits || undefined}
        onClick={regen.retry}
      >
        {WORDS.tryAgain}
      </button>
    </p>
  );
}

/** The welcome as it was before nicknames: the avatar alone, Regenerate and Continue; it stays while a save runs. */
function AvatarOnly({ me, onDone }: { me: PlayMe; onDone: () => void }): JSX.Element {
  const button = useRef<HTMLButtonElement>(null);
  const regen = useWelcomeRegenerate(me);
  return (
    <DialogSurface
      title={WORDS.welcomeTitle}
      headerHidden
      size="sm"
      testId="avatar-welcome"
      className="avatar-welcome"
      initialFocus={button}
      dismissible={!regen.saving}
      onDismiss={onDone}
    >
      <div className="avatar-welcome-body" data-avatar-welcome>
        <BuiltAvatar me={me} />
        <div className="avatar-welcome-actions">
          <RegenerateButton regen={regen} />
          <ContinueButton button={button} disabled={regen.saving} busy={regen.saving} onClick={onDone} />
        </div>
        <WelcomeFoot regen={regen} note={WORDS.welcomeNote} />
      </div>
    </DialogSurface>
  );
}

/** Whether the field's line says genex.games could not be reached: a check or a save that failed. */
const unreachable = (hint: HandleHint): boolean => hint === HandleHint.CheckFailed || hint === HandleHint.SaveFailed;

/**
 * The welcome with the nickname: the account's handle prefilled (else one from its name), and
 * Continue, which saves it, waiting until it may be had. Closing it without Continue asks no more
 * on this Mac (`onDone`) — unless genex.games could not be reached, when Continue could not have
 * worked: then it is put off for this launch only (`onLater`).
 */
function AvatarAndNickname({
  me,
  onDone,
  onLater,
}: {
  me: PlayMe;
  onDone: () => void;
  onLater: () => void;
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const nickname = useNicknameEdit(me.handle, me.handle ?? handleBaseFromName(me.name));
  const regen = useWelcomeRegenerate(me);
  const busy = nickname.saving || regen.saving;
  const keep = async (): Promise<void> => {
    if (await nickname.save()) onDone();
  };
  return (
    <DialogSurface
      title={WORDS.welcomeTitle}
      headerHidden
      size="md"
      testId="avatar-welcome"
      className="avatar-welcome"
      initialFocus={input}
      dismissible={!regen.saving}
      onDismiss={unreachable(nickname.view.hint) ? onLater : onDone}
    >
      <form
        className="avatar-welcome-body"
        data-avatar-welcome="nickname"
        onSubmit={(event) => {
          event.preventDefault();
          void keep();
        }}
      >
        <BuiltAvatar me={me} />
        <HandleField
          id={NICKNAME_FIELD}
          label={NICKNAME_WORDS.label}
          value={nickname.value}
          view={nickname.view}
          inputRef={input}
          onChange={nickname.setValue}
        />
        <div className="avatar-welcome-actions">
          <RegenerateButton regen={regen} />
          <ContinueButton button={button} disabled={!nickname.view.keepable || busy} busy={busy} />
        </div>
        <WelcomeFoot regen={regen} note={WORDS.welcomeNoteBoth} />
      </form>
    </DialogSurface>
  );
}

/**
 * Shows the welcome an account gets (`welcomeFor`), when nothing else is in front: not over the
 * first launch's welcome, a game playing in Play, or the Genex promo card.
 */
export function AvatarWelcome({ blocked }: { blocked: boolean }): JSX.Element | null {
  const me = usePeople((s) => s.me);
  const playing = usePlay((s) => s.viewer !== null);
  const [done, setDone] = useState<string | null>(null);
  const kind = me && done !== me.id ? welcomeFor(me, seenOnThisMac(me.id)) : WelcomeKind.None;
  const waiting = blocked || playing;
  const promoOut = usePromoOut(kind !== WelcomeKind.None && !waiting);
  if (!me || kind === WelcomeKind.None || waiting || promoOut) return null;
  const finish = () => {
    writeText(storageKeyFor.avatarWelcomed(me.id), "1");
    if (kind === WelcomeKind.Nickname) writeText(storageKeyFor.nicknameWelcomed(me.id), "1");
    setDone(me.id);
  };
  const later = () => setDone(me.id);
  if (kind === WelcomeKind.Nickname) return <AvatarAndNickname me={me} onDone={finish} onLater={later} />;
  return <AvatarOnly me={me} onDone={finish} />;
}

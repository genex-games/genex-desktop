/**
 * Settings → Genex account. Signed in: the account's avatar, Generated (made from its id, every
 * account has one, and Regenerate gives it another) or Photo (one it uploaded), its name, its
 * nickname (once genex.games knows nicknames; Edit opens the welcome's field) and its credits with
 * what they pay for. Each change applies everywhere at once, in the app and on
 * genex.games; offline, changes wait for the connection. Sign out sits beside the title
 * (`AccountSignOut`). Signed out: the account card drawn as Assets draws what is being made, one
 * line and Sign in in browser. The account is the app's: the Genex plugin being off changes nothing.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { avatarRecipe } from "../../shared/avatar-recipe.ts";
import { GenexAccountStatus } from "../../shared/genex-account.ts";
import { creditsPlansUrl } from "../../shared/play-credits.ts";
import { handleBaseFromName } from "../../shared/handle.ts";
import { AvatarStyle, PLAY_NAME_LENGTH, type PlayMe, playName } from "../../shared/play-people.ts";
import { AvatarMotion, GeneratedAvatar } from "../avatars/GeneratedAvatar.tsx";
import { MakingDrawing } from "../making-art.ts";
import { GenexTab, openGenexPage } from "./plugins/genex/genex-tab.ts";
import { avatarWebp } from "../play/avatar-image.ts";
import { CreditsShard } from "../play/CreditsShard.tsx";
import { HandleField, useNicknameEdit } from "../play/HandleField.tsx";
import { SignOutDialog } from "../play/SignOutDialog.tsx";
import { cancelGenexSignIn, useGenexSignIn } from "../play/use-genex-sign-in.ts";
import { useRegenerateAvatar } from "../play/use-regenerate-avatar.ts";
import { usePeople, usePlayWeb } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useOnline } from "../ui/use-online.ts";
import { ACCOUNT_WORDS, NICKNAME_WORDS, PLAY_WORDS } from "../words.ts";
import { MakingArt } from "./MakingArt.tsx";

const WORDS = ACCOUNT_WORDS;
/** The two choices' pictures. */
const CHOICE_AVATAR = 72;

/** The style the account shows: the one it chose, else the generated one. */
const shownStyle = (me: PlayMe): AvatarStyle => me.avatarStyle ?? AvatarStyle.Generated;

/** One of the two choices: its picture over its name. */
function Choice({
  style,
  me,
  disabled,
  onChoose,
}: {
  style: AvatarStyle;
  me: PlayMe;
  disabled: boolean;
  onChoose: (style: AvatarStyle) => void;
}): JSX.Element {
  const recipe = useMemo(() => avatarRecipe(me.id, me.avatarVariant), [me.id, me.avatarVariant]);
  const on = shownStyle(me) === style;
  const generated = style === AvatarStyle.Generated;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className="account-choice"
      data-avatar-choice={style}
      data-avatar-host
      disabled={disabled}
      onClick={() => onChoose(style)}
    >
      {generated && <GeneratedAvatar recipe={recipe} size={CHOICE_AVATAR} full motion={AvatarMotion.Live} />}
      {!generated && me.photoUrl && (
        <span className="person-avatar" style={{ width: CHOICE_AVATAR, height: CHOICE_AVATAR }}>
          <img src={me.photoUrl} alt="" draggable={false} />
        </span>
      )}
      {!generated && !me.photoUrl && (
        <span className="account-choice-empty" aria-hidden="true">
          <Icon name="camera" size={22} />
        </span>
      )}
      {generated ? WORDS.generated : WORDS.photo}
    </button>
  );
}

/** What the upload button says: busy, replacing a photo, or uploading the first. */
function uploadWords(busy: boolean, hasPhoto: boolean): string {
  if (busy) return WORDS.uploading;
  return hasPhoto ? WORDS.replacePhoto : WORDS.uploadPhoto;
}

/** What picking a photo needs: the hidden file field, the press that opens it, and whether it is uploading. */
interface PhotoUpload {
  field: JSX.Element;
  pick(): void;
  busy: boolean;
}

/** The file field behind Upload and an empty Photo: a picked picture becomes the account's photo, shown everywhere. */
function usePhotoUpload(): PhotoUpload {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const picked = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      await studio().people.setAvatar(await avatarWebp(file));
    } catch {
      studio().notify(PLAY_WORDS.people.pictureFailed, ToastTone.Error);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const field = (
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={(event) => void picked(event.target.files?.[0])}
    />
  );
  return { field, pick: () => input.current?.click(), busy };
}

/** Upload a photo, or another one while the photo shows. */
function UploadButton({
  upload,
  hasPhoto,
  online,
}: {
  upload: PhotoUpload;
  hasPhoto: boolean;
  online: boolean;
}): JSX.Element {
  return (
    <Button className="account-upload" busy={upload.busy} disabled={!online} data-avatar-upload onClick={upload.pick}>
      <Icon name="camera" />
      {uploadWords(upload.busy, hasPhoto)}
    </Button>
  );
}

/** Another generated avatar for the account, at once; waits until genex.games keeps one, and the connection. */
function RegenerateButton({ me, online }: { me: PlayMe; online: boolean }): JSX.Element {
  const { available, regenerate } = useRegenerateAvatar(me);
  return (
    <Button className="account-upload" disabled={!available || !online} data-avatar-regenerate onClick={regenerate}>
      <Icon name="dice" />
      {WORDS.regenerate}
    </Button>
  );
}

/**
 * The avatar row: Generated or Photo. Under them, Regenerate while the generated avatar shows, and
 * Upload while there is no photo yet or the photo shows; an empty Photo opens the picker too, and the
 * photo it uploads is then the one shown.
 */
function AvatarRow({ me, online }: { me: PlayMe; online: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const upload = usePhotoUpload();
  const known = me.avatarStyle !== null;
  const generated = shownStyle(me) === AvatarStyle.Generated;
  const choose = async (style: AvatarStyle): Promise<void> => {
    if (style === AvatarStyle.Photo && !me.photoUrl) {
      upload.pick();
      return;
    }
    if (style === shownStyle(me)) return;
    setBusy(true);
    try {
      await studio().people.setAvatarStyle(style);
    } catch {
      studio().notify(WORDS.styleFailed, ToastTone.Error);
    } finally {
      setBusy(false);
    }
  };
  const uploadShown = known && (!generated || !me.photoUrl);
  return (
    <div className="account-row" data-account-avatar>
      <span className="account-row-label">{WORDS.avatar}</span>
      <div className="account-row-body">
        <div className="account-choices" role="radiogroup" aria-label={WORDS.avatarLabel}>
          <Choice
            style={AvatarStyle.Generated}
            me={me}
            disabled={busy || !online}
            onChoose={(style) => void choose(style)}
          />
          <Choice
            style={AvatarStyle.Photo}
            me={me}
            disabled={busy || upload.busy || !known || !online}
            onChoose={(style) => void choose(style)}
          />
        </div>
        <div className="account-actions">
          {generated && <RegenerateButton me={me} online={online} />}
          {uploadShown && <UploadButton upload={upload} hasPhoto={me.photoUrl !== null} online={online} />}
        </div>
        {upload.field}
        {known && <span className="account-note">{online ? WORDS.everywhere : WORDS.offline}</span>}
      </div>
    </div>
  );
}

/** The name row: the field, Save when it changed (and the Mac is online). */
function NameRow({ me, online }: { me: PlayMe; online: boolean }): JSX.Element {
  const [draft, setDraft] = useState(me.name);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(me.name), [me.name]);
  const name = playName(draft);
  const changed = name !== null && name !== me.name;
  const save = async (): Promise<void> => {
    if (!name || !changed || saving) return;
    setSaving(true);
    try {
      await studio().people.rename(name);
    } catch {
      studio().notify(PLAY_WORDS.people.renameFailed, ToastTone.Error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="account-row"
      data-account-name
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor="account-name" className="account-row-label">
        {WORDS.name}
      </label>
      <div className="account-row-body">
        <span className="account-name-line">
          <input
            id="account-name"
            className="account-name-field"
            value={draft}
            maxLength={PLAY_NAME_LENGTH.max + 10}
            aria-describedby="account-name-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && changed) {
                event.preventDefault();
                event.stopPropagation();
                setDraft(me.name);
              }
            }}
          />
          {changed && (
            <Button type="submit" variant="default" busy={saving} disabled={!online}>
              {saving ? PLAY_WORDS.people.saving : PLAY_WORDS.people.save}
            </Button>
          )}
        </span>
        <span id="account-name-hint" className="account-note">
          {name === null ? PLAY_WORDS.people.nameRule : PLAY_WORDS.people.nameHint}
        </span>
      </div>
    </form>
  );
}

/** The nickname row's label id: the field inside it is named by it. */
const NICKNAME_LABEL = "account-nickname-label";

/** Editing the nickname: the welcome's field with Save beside it and Cancel; Escape cancels too. */
function NicknameEditor({ me, online, onClose }: { me: PlayMe; online: boolean; onClose: () => void }) {
  const nickname = useNicknameEdit(me.handle, me.handle ?? handleBaseFromName(me.name));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const save = async (): Promise<void> => {
    if (await nickname.save()) onClose();
  };
  const presses = (
    <>
      <Button
        type="submit"
        variant="default"
        busy={nickname.saving}
        disabled={!online || !nickname.view.keepable}
        data-account-nickname-save
      >
        {nickname.saving ? PLAY_WORDS.people.saving : PLAY_WORDS.people.save}
      </Button>
      <button type="button" className="people-button" data-tone="quiet" onClick={onClose}>
        {PLAY_WORDS.people.cancel}
      </button>
    </>
  );
  return (
    <form
      className="account-nickname-editor"
      // Escape here cancels the edit (HandleField's onEscape); it must not close Settings first.
      data-keeps-escape
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <HandleField
        id="account-nickname"
        value={nickname.value}
        view={nickname.view}
        labelledBy={NICKNAME_LABEL}
        inputRef={input}
        onChange={nickname.setValue}
        onEscape={onClose}
        aside={presses}
      />
    </form>
  );
}

/** The nickname row: `@handle` and Edit, or the field while it is being edited. Offline, Edit waits. */
function NicknameRow({ me, online }: { me: PlayMe; online: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const edit = useRef<HTMLButtonElement>(null);
  // The field goes away when the edit ends: the keyboard goes back to Edit.
  const close = (): void => {
    setEditing(false);
    requestAnimationFrame(() => edit.current?.focus());
  };
  return (
    <div className="account-row" data-account-nickname data-editing={editing || undefined}>
      <span id={NICKNAME_LABEL} className="account-row-label">
        {NICKNAME_WORDS.row}
      </span>
      <div className="account-row-body">
        {editing ? (
          <NicknameEditor me={me} online={online} onClose={close} />
        ) : (
          <span className="account-nickname-line">
            <span className="account-handle" data-account-handle data-none={!me.handle || undefined}>
              {me.handle ? `@${me.handle}` : NICKNAME_WORDS.none}
            </span>
            <button
              ref={edit}
              type="button"
              className="people-button"
              data-tone="quiet"
              aria-label={NICKNAME_WORDS.editLabel}
              disabled={!online}
              data-account-nickname-edit
              onClick={() => setEditing(true)}
            >
              {NICKNAME_WORDS.edit}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** "1,700 credits": the balance as last read, or nothing before it was. */
function creditsWords(credits: { balance: number | null; unlimited: boolean } | null): string | null {
  if (credits?.unlimited) return WORDS.creditsUnlimited;
  return credits?.balance == null ? null : WORDS.creditsCount(new Intl.NumberFormat().format(credits.balance));
}

/**
 * The credits row: the balance (the last one read while offline), Buy credits on genex.games, and
 * what credits pay for, the Genex plugin's name opening its page.
 */
function CreditsRow(): JSX.Element {
  const amount = creditsWords(usePeople((s) => s.credits));
  const web = usePlayWeb();
  useEffect(() => {
    void studio().people.loadCredits();
  }, []);
  const buy = (): void => {
    void studio()
      .api.openUrl(creditsPlansUrl(web))
      .catch(() => undefined);
  };
  const note = WORDS.creditsNote;
  return (
    <div className="account-row" data-account-credits>
      <span className="account-row-label">{WORDS.credits}</span>
      <div className="account-row-body">
        <div className="account-credits">
          <CreditsShard size={16} />
          {amount !== null && <span>{amount}</span>}
          <button type="button" className="people-button" aria-label={WORDS.buyCreditsLabel} onClick={buy}>
            {WORDS.buyCredits}
            <Icon name="arrow-up-right" size={14} />
          </button>
        </div>
        <span className="account-note">
          {note.before}
          <button
            type="button"
            className="account-note-link"
            aria-label={WORDS.creditsPluginLabel}
            onClick={() => openGenexPage(GenexTab.Tools)}
          >
            {note.plugin}
          </button>
          {note.after}
        </span>
      </div>
    </div>
  );
}

/** Sign out, beside the section's title while signed in; it asks first. */
export function AccountSignOut(): JSX.Element {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        type="button"
        className="people-button account-sign-out"
        data-tone="quiet"
        data-account-sign-out
        onClick={() => setAsking(true)}
      >
        <Icon name="sign-out" size={14} />
        {WORDS.signOut}
      </button>
      {asking && <SignOutDialog onDismiss={() => setAsking(false)} />}
    </>
  );
}

/**
 * Signed out: the account card, one line and Sign in in browser, nothing under it. While the
 * browser has the sign-in: the code it should show, Cancel, and the press waiting.
 */
function SignInStage(): JSX.Element {
  const waiting = usePeople((s) => s.account === GenexAccountStatus.SigningIn);
  const code = usePeople((s) => s.signInCode);
  const { busy, signIn } = useGenexSignIn();
  return (
    <div className="account-sign-in" data-account-sign-in>
      <MakingArt drawing={MakingDrawing.Account} still={false} offset={0} className="account-sign-in-art" />
      <p>{WORDS.signInText}</p>
      {waiting ? (
        <>
          <div className="account-sign-in-presses">
            <button type="button" className="people-button" data-tone="quiet" onClick={() => void cancelGenexSignIn()}>
              {WORDS.cancel}
            </button>
            <Button variant="default" busy className="account-sign-in-wait">
              {WORDS.waiting}
            </Button>
          </div>
          {code && (
            <p className="account-note" role="status">
              {WORDS.browserShows} <code className="account-code">{code}</code>
            </p>
          )}
        </>
      ) : (
        <button
          type="button"
          className="people-button account-sign-in-button"
          data-tone="primary"
          aria-label={WORDS.signInLabel}
          aria-busy={busy || undefined}
          disabled={busy}
          data-genex-sign-in
          onClick={signIn}
        >
          {WORDS.signIn}
          <Icon name="arrow-up-right" size={14} />
        </button>
      )}
    </div>
  );
}

/** The Genex account's settings; while signed out, the way to sign in. */
export function AccountSection(): JSX.Element {
  const me = usePeople((s) => s.me);
  const online = useOnline();
  if (!me) return <SignInStage />;
  return (
    <div className="account-section" data-account-section>
      <AvatarRow me={me} online={online} />
      <NameRow me={me} online={online} />
      {me.handleChosen !== null && <NicknameRow me={me} online={online} />}
      <CreditsRow />
    </div>
  );
}

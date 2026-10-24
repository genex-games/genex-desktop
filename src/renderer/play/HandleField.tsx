/**
 * The nickname field, in the welcome and in Settings → Genex account: the profile's address fixed
 * in the box (`genex.games/@`), what is typed after it, the state on the right (Free in green, Taken
 * or what is wrong in red) and a line under it, with handles to try as buttons that fill the field.
 * A shape problem and the account's own handle are known at once; anything else is asked of
 * genex.games a moment after the last key, and an answer for an older value lands nowhere.
 */
import type { JSX, ReactNode, Ref } from "react";
import { useEffect, useMemo, useState } from "react";
import { HANDLE_LENGTH, type HandleCheck, HandleSaveOutcome, localHandleCheck } from "../../shared/handle.ts";
import { linkWithoutScheme } from "../../shared/play-share.ts";
import { usePlayWeb } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Icon } from "../ui/icons.tsx";
import { NICKNAME_WORDS } from "../words.ts";
import {
  HandleCheckStatus,
  type HandleFieldCheck,
  type HandleFieldView,
  HandleHint,
  HandleNote,
  HandleTone,
  handleFieldView,
} from "./nickname-model.ts";

const WORDS = NICKNAME_WORDS;
/** A check waits this long after the last key before it asks genex.games. */
const HANDLE_CHECK_DEBOUNCE_MS = 300;
/** Room past the longest handle, so Too long can show what was typed. */
const TYPED_ROOM = 10;

/**
 * What `value` is: known at once for a shape problem or the account's own handle (`own`), else
 * genex.games' answer once it comes; while it is on its way, Checking. A check that could not reach
 * genex.games is asked again when the Mac is back online, so the field does not wait for a key.
 */
export function useHandleCheck(value: string, own: string | null): HandleFieldCheck {
  const local = useMemo(() => localHandleCheck(value, own), [value, own]);
  const [asked, setAsked] = useState<{ value: string; field: HandleFieldCheck } | null>(null);
  const [online, setOnline] = useState(0);
  useEffect(() => {
    const again = () => setOnline((times) => times + 1);
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `online` is the reason to ask again
  useEffect(() => {
    if (local) return;
    let current = true;
    const timer = window.setTimeout(() => {
      studio()
        .api.playHandleCheck(value)
        .then(
          (check) => current && setAsked({ value, field: { status: HandleCheckStatus.Known, check } }),
          () => current && setAsked({ value, field: { status: HandleCheckStatus.Failed } }),
        );
    }, HANDLE_CHECK_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [value, local, online]);
  if (local) return { status: HandleCheckStatus.Known, check: local };
  return asked?.value === value ? asked.field : { status: HandleCheckStatus.Checking };
}

/** A nickname being typed and saved: the field's view of it, and the save. */
export interface NicknameEdit {
  value: string;
  setValue(value: string): void;
  view: HandleFieldView;
  saving: boolean;
  /** Save what is typed when it may be kept; true once it is the account's. A refusal shows in the field. */
  save(): Promise<boolean>;
}

/**
 * Type and save a nickname, starting from `initial`; `own` is the account's handle now. A refusal
 * (taken, its shape) shows in the field as a check would, and a note (too many changes, a failed
 * save) under it, each until the value changes.
 */
export function useNicknameEdit(own: string | null, initial: string): NicknameEdit {
  const [value, setValue] = useState(initial);
  const [refusal, setRefusal] = useState<{ value: string; check: HandleCheck } | null>(null);
  const [note, setNote] = useState<{ value: string; note: HandleNote } | null>(null);
  const [saving, setSaving] = useState(false);
  const checked = useHandleCheck(value, own);
  const field: HandleFieldCheck =
    refusal?.value === value ? { status: HandleCheckStatus.Known, check: refusal.check } : checked;
  const view = handleFieldView(field, note?.value === value ? note.note : null);
  const save = async (): Promise<boolean> => {
    if (!view.keepable || saving) return false;
    setSaving(true);
    try {
      const saved = await studio().people.setHandle(value);
      if (saved.outcome === HandleSaveOutcome.Saved) return true;
      if (saved.outcome === HandleSaveOutcome.Refused) setRefusal({ value, check: saved.check });
      else setNote({ value, note: HandleNote.TooManyChanges });
      return false;
    } catch {
      setNote({ value, note: HandleNote.SaveFailed });
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { value, setValue, view, saving, save };
}

/**
 * The state's words beside the box. Always in the page, empty while there is nothing to say, so
 * it can be a live region: a screen reader hears Free or Taken as the check comes back.
 */
function StateWord({ id, view }: { id: string; view: HandleFieldView }): JSX.Element {
  const said = view.label && view.tone ? view.label : null;
  return (
    <span
      id={id}
      className="handle-box-state"
      data-tone={said ? (view.tone ?? undefined) : undefined}
      data-handle-state={said ?? undefined}
      aria-live="polite"
    >
      {said && view.tone === HandleTone.Ok && <Icon name="check" size={13} />}
      {said && WORDS.states[said]}
    </span>
  );
}

/** The handles to try, each a button that fills the field. */
function Suggestions({ handles, onPick }: { handles: string[]; onPick: (handle: string) => void }) {
  return handles.map((handle) => (
    <button
      key={handle}
      type="button"
      className="handle-suggestion"
      aria-label={WORDS.tryLabel(handle)}
      data-handle-suggestion={handle}
      onClick={() => onPick(handle)}
    >
      {handle}
    </button>
  ));
}

/** The line under the field. `linkInLabel`: the label already says it is the profile link. */
function HintLine({
  view,
  onPick,
  linkInLabel,
}: {
  view: HandleFieldView;
  onPick: (handle: string) => void;
  linkInLabel: boolean;
}): JSX.Element {
  const offers = view.suggestions.length > 0;
  const said: Record<HandleHint, string | null> = {
    [HandleHint.None]: null,
    [HandleHint.ProfileLink]: linkInLabel ? null : WORDS.profileLink,
    [HandleHint.Try]: null,
    [HandleHint.Length]: WORDS.length,
    [HandleHint.Letters]: WORDS.letters,
    [HandleHint.CheckFailed]: WORDS.checkFailed,
    [HandleHint.TooManyChanges]: WORDS.tooManyChanges,
    [HandleHint.SaveFailed]: WORDS.saveFailed,
  };
  return (
    <>
      {said[view.hint]}
      {offers && <span className="handle-hint-try">{WORDS.try}</span>}
      {offers && <Suggestions handles={view.suggestions} onPick={onPick} />}
    </>
  );
}

/**
 * The field itself. `label` titles it (the welcome, whose label also names the profile link, so
 * nothing under the box repeats it); without one, `labelledBy` names the element that does (a
 * Settings row's label). `inputRef` lets a dialog put its first focus in the box.
 */
export function HandleField({
  id,
  value,
  view,
  onChange,
  label,
  labelledBy,
  inputRef,
  onEscape,
  aside,
}: {
  id: string;
  value: string;
  view: HandleFieldView;
  onChange: (value: string) => void;
  label?: string;
  labelledBy?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Escape in the box, when it means something here (Settings' Cancel). */
  onEscape?: () => void;
  /** What sits beside the box, on its line (Settings' Save and Cancel). */
  aside?: ReactNode;
}): JSX.Element {
  const prefix = `${linkWithoutScheme(usePlayWeb())}/@`;
  const hintId = `${id}-hint`;
  const stateId = `${id}-state`;
  // A suggestion's button goes away once its handle is in the box: the keyboard goes back to the box.
  const pick = (handle: string): void => {
    onChange(handle);
    document.getElementById(id)?.focus();
  };
  return (
    <div className="handle-field" data-handle-field>
      {label && (
        <label htmlFor={id} className="handle-field-label">
          {label}
        </label>
      )}
      <div className="handle-field-line">
        <div className="handle-box" data-tone={view.tone ?? undefined}>
          <span className="handle-box-prefix" aria-hidden="true">
            {prefix}
          </span>
          <input
            ref={inputRef}
            id={id}
            className="handle-box-input"
            value={value}
            maxLength={HANDLE_LENGTH.max + TYPED_ROOM}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-labelledby={label ? undefined : labelledBy}
            aria-describedby={`${stateId} ${hintId}`}
            aria-invalid={view.tone === HandleTone.Bad || undefined}
            data-handle-input
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !onEscape) return;
              event.preventDefault();
              event.stopPropagation();
              onEscape();
            }}
          />
          <StateWord id={stateId} view={view} />
        </div>
        {aside}
      </div>
      <div id={hintId} className="handle-hint" data-handle-hint={view.hint} aria-live="polite">
        <HintLine view={view} onPick={pick} linkInLabel={label !== undefined} />
      </div>
    </div>
  );
}

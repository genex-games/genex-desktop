/**
 * The nickname in the renderer, as pure rules: which welcome an account gets (the avatar alone
 * while genex.games knows no handles, the avatar with the nickname field once it does), and what
 * the nickname field shows for a typed handle: the state beside the box, the line under it and
 * whether Continue (or Save) may go ahead.
 */
import { type HandleCheck, HandleState, handleKept } from "../../shared/handle.ts";
import type { PlayMe } from "../../shared/play-people.ts";

/** Which welcome an account gets now. */
export const WelcomeKind = {
  None: "none",
  /** The avatar alone, once per account on this Mac: genex.games knows no handles yet. */
  Avatar: "avatar",
  /** The avatar with the nickname field, once, until the account has chosen its nickname. */
  Nickname: "nickname",
} as const;
export type WelcomeKind = (typeof WelcomeKind)[keyof typeof WelcomeKind];

/** What this Mac remembers the account has seen. */
export interface WelcomesSeen {
  avatar: boolean;
  nickname: boolean;
}

/**
 * The welcome `me` gets. While genex.games knows no handles it is the avatar alone, once per account
 * on this Mac. Once it does, its flag is the truth: an account that has not chosen its nickname gets
 * the nickname welcome once on this Mac (even one this Mac welcomed before), and one that chose it,
 * here or on genex.games, gets none.
 */
export function welcomeFor(me: PlayMe | null, seen: WelcomesSeen): WelcomeKind {
  if (!me) return WelcomeKind.None;
  if (me.handleChosen === null) return seen.avatar ? WelcomeKind.None : WelcomeKind.Avatar;
  if (me.handleChosen || seen.nickname) return WelcomeKind.None;
  return WelcomeKind.Nickname;
}

/** Where the field's check of the typed handle stands. */
export const HandleCheckStatus = {
  /** genex.games is being asked. */
  Checking: "checking",
  Known: "known",
  /** genex.games could not be asked (offline, or it failed). */
  Failed: "failed",
} as const;
export type HandleCheckStatus = (typeof HandleCheckStatus)[keyof typeof HandleCheckStatus];

/** The field's check of what is typed. */
export type HandleFieldCheck =
  | { status: typeof HandleCheckStatus.Checking | typeof HandleCheckStatus.Failed }
  | { status: typeof HandleCheckStatus.Known; check: HandleCheck };

/** What the last save said, shown under the field until the handle changes. */
export const HandleNote = {
  TooManyChanges: "too-many-changes",
  SaveFailed: "save-failed",
} as const;
export type HandleNote = (typeof HandleNote)[keyof typeof HandleNote];

/** The state's colour beside the box. */
export const HandleTone = { Ok: "ok", Bad: "bad" } as const;
export type HandleTone = (typeof HandleTone)[keyof typeof HandleTone];

/** The line under the field. */
export const HandleHint = {
  None: "none",
  /** "Your profile link." */
  ProfileLink: "profile-link",
  /** "Try" and the handles to try. */
  Try: "try",
  /** "3 to 20 characters." */
  Length: "length",
  /** "Letters a–z, digits and dashes.", and a Latin handle to try when there is one. */
  Letters: "letters",
  CheckFailed: "check-failed",
  TooManyChanges: "too-many-changes",
  SaveFailed: "save-failed",
} as const;
export type HandleHint = (typeof HandleHint)[keyof typeof HandleHint];

/** The states the field names: a reserved handle reads as Taken, the account's own as Free. */
export type HandleLabel = Exclude<HandleState, typeof HandleState.Yours | typeof HandleState.Reserved>;

/** What the field shows. */
export interface HandleFieldView {
  /** The state's word beside the box, or null while nothing is known. */
  label: HandleLabel | null;
  tone: HandleTone | null;
  hint: HandleHint;
  /** Handles to try, as buttons that fill the field. */
  suggestions: string[];
  /** Continue or Save may go ahead with what is typed. */
  keepable: boolean;
}

/** The line under the field for a known state. */
function hintFor(check: HandleCheck): HandleHint {
  switch (check.state) {
    case HandleState.Free:
    case HandleState.Yours:
      return HandleHint.ProfileLink;
    case HandleState.Taken:
    case HandleState.Reserved:
      return check.suggestions.length > 0 ? HandleHint.Try : HandleHint.None;
    case HandleState.TooShort:
    case HandleState.TooLong:
      return HandleHint.Length;
    default:
      return HandleHint.Letters;
  }
}

/** The word a state shows as: Taken for a reserved handle, Free for the account's own. */
function labelFor(state: HandleState): HandleLabel {
  if (state === HandleState.Taken || state === HandleState.Reserved) return HandleState.Taken;
  return state === HandleState.Yours ? HandleState.Free : state;
}

/** What the field shows for its check, with the last save's `note` (if any) under it. */
export function handleFieldView(field: HandleFieldCheck, note: HandleNote | null): HandleFieldView {
  const view = knownView(field);
  return note ? { ...view, hint: note } : view;
}

function knownView(field: HandleFieldCheck): HandleFieldView {
  if (field.status !== HandleCheckStatus.Known) {
    // Nothing is known yet: no state beside the box, and nothing to go ahead with.
    const hint = field.status === HandleCheckStatus.Failed ? HandleHint.CheckFailed : HandleHint.ProfileLink;
    return { label: null, tone: null, hint, suggestions: [], keepable: false };
  }
  const { check } = field;
  const keepable = handleKept(check.state);
  const hint = hintFor(check);
  const offers = hint === HandleHint.Try || hint === HandleHint.Letters;
  return {
    label: labelFor(check.state),
    tone: keepable ? HandleTone.Ok : HandleTone.Bad,
    hint,
    suggestions: offers ? check.suggestions : [],
    keepable,
  };
}

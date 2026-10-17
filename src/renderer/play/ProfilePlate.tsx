/**
 * The Genex account at the foot of the sidebar, in Play and in Create, always in the same place.
 * Signed in: its avatar, its name (and Pro), and beside it the credits, which open Credits (the
 * friends are listed under the games). The name opens a menu: Profile, Friends, Credits, Account
 * settings and Sign out. Offline it shows the account as last time, the Offline mark where the
 * credits were. Signed out it signs in in the browser; while that waits it says so,
 * with a way to cancel; and once genex.games ends a sign-in it shows the account dimmed, to sign in
 * again. The account is the app's: the Genex plugin being on or off changes nothing here.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { PlayMe } from "../../shared/play-people.ts";
import { GenexTab, openGenexPage } from "../panels/plugins/genex/genex-tab.ts";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { usePeople } from "../state/hooks.ts";
import { waitingRequests } from "../state/people.ts";
import { PlayPage } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { useOnline } from "../ui/use-online.ts";
import { PLAY_WORDS } from "../words.ts";
import { CreditsShard, ScrambleNumber } from "./CreditsShard.tsx";
import { formatCount, PlateState, plateState } from "./play-model.ts";
import { avatarRecipe } from "../../shared/avatar-recipe.ts";
import { GeneratedAvatar } from "../avatars/GeneratedAvatar.tsx";
import { PersonAvatar } from "./PersonAvatar.tsx";
import { OfflineMark } from "./PlayOffline.tsx";
import { SignOutDialog } from "./SignOutDialog.tsx";
import { cancelGenexSignIn, useGenexSignIn } from "./use-genex-sign-in.ts";

const WORDS = PLAY_WORDS.people;
/** The size of the plate's own face. */
const PLATE_FACE = 28;
/** The signed-out plate's own face: the Galaxy generated avatar, quiet (faint eyes, dim stars), the same one every time. */
const SIGNED_OUT_FACE = avatarRecipe("sign-in");

/** "July 2026": when an account was made, as a profile says it. */
export const joinedWhen = (iso: string | null): string | null =>
  iso ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(iso)) : null;

/** Settings › Genex account, where the account's avatar, name and balance are. */
const openAccountSettings = (): void => openSettings(SettingsSection.Account);

/** The credits as the menu shows them: the last balance read, or nothing before one was. */
function creditsWords(credits: { balance: number | null; unlimited: boolean } | null): string | null {
  if (credits?.unlimited) return WORDS.creditsUnlimited;
  return credits?.balance == null ? null : formatCount(credits.balance);
}

/** The account's credits, as last read; they open the Genex plugin's Credits tab, where credits are spent. */
function Credits(): JSX.Element {
  const amount = creditsWords(usePeople((s) => s.credits));
  return (
    <DropdownMenuItem data-profile-menu="credits" onSelect={() => openGenexPage(GenexTab.Credits)}>
      <CreditsShard size={16} />
      <span className="flex-1">{WORDS.credits}</span>
      {amount !== null && <span className="profile-menu-value">{amount}</span>}
    </DropdownMenuItem>
  );
}

/** The menu the name opens. */
function PlateMenu({
  me,
  waiting,
  onOpen,
  onSignOut,
}: {
  me: PlayMe;
  waiting: number;
  onOpen: (page: typeof PlayPage.Profile | typeof PlayPage.Friends) => void;
  onSignOut: () => void;
}): JSX.Element {
  const joined = joinedWhen(me.joinedAt);
  return (
    <DropdownMenuContent side="top" align="start" sideOffset={8} className="profile-menu" aria-label={WORDS.menuLabel}>
      <div className="profile-menu-head">
        <PersonAvatar person={me} size={36} />
        <div className="min-w-0">
          <div className="truncate">{me.name}</div>
          <div className="profile-menu-sub">
            {[me.pro ? WORDS.pro : null, joined ? WORDS.joined(joined) : null].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem data-profile-menu="profile" onSelect={() => onOpen(PlayPage.Profile)}>
        <Icon name="character" />
        {WORDS.profile}
      </DropdownMenuItem>
      <DropdownMenuItem data-profile-menu="friends" onSelect={() => onOpen(PlayPage.Friends)}>
        <Icon name="users" />
        <span className="flex-1">{WORDS.friends}</span>
        {waiting > 0 && <span className="sidebar-badge">{waiting}</span>}
      </DropdownMenuItem>
      <Credits />
      <DropdownMenuSeparator />
      <DropdownMenuItem data-profile-menu="account" onSelect={openAccountSettings}>
        <Icon name="settings" />
        {WORDS.accountSettings}
      </DropdownMenuItem>
      <DropdownMenuItem data-profile-menu="sign-out" onSelect={onSignOut}>
        <Icon name="sign-out" />
        {WORDS.signOut}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

/** The credits beside the name, as last read; they open the Genex plugin's Credits tab, as the menu's Credits does. */
function PlateCredits(): JSX.Element | null {
  const amount = creditsWords(usePeople((s) => s.credits));
  if (amount === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="plate-end plate-credits"
          data-profile-credits
          aria-label={WORDS.creditsLabel(amount)}
          onClick={() => openGenexPage(GenexTab.Credits)}
        >
          <CreditsShard size={12} />
          <ScrambleNumber text={amount} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{WORDS.credits}</TooltipContent>
    </Tooltip>
  );
}

/** Offline, in the credits' place: the balance and friends' games are not current, so the Offline signal stands there. */
function OfflineSlot(): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="plate-end plate-offline" role="img" aria-label={WORDS.offlineFriends} tabIndex={0}>
          <OfflineMark />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{WORDS.offlineFriends}</TooltipContent>
    </Tooltip>
  );
}

/** Where a face goes while nobody is signed in: a generated face; `waiting` rings it while the browser has the sign-in. */
function FaceSlot({ waiting = false }: { waiting?: boolean }): JSX.Element {
  return (
    <span className="plate-slot" aria-hidden="true">
      <GeneratedAvatar recipe={SIGNED_OUT_FACE} size={PLATE_FACE} full quiet />
      {waiting && <span className="plate-slot-spin" />}
    </span>
  );
}

/** Signed in (or offline, as last time): the account, its menu, and the friends or the Offline mark. */
function AccountPlate({
  me,
  offline,
  onPlayMode,
}: {
  me: PlayMe;
  offline: boolean;
  onPlayMode: (play: boolean) => void;
}): JSX.Element {
  const waiting = usePeople(waitingRequests);
  const [signingOut, setSigningOut] = useState(false);
  // The balance beside the name reads with the account, and again whenever the menu opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another account reads its own balance
  useEffect(() => {
    void studio().people.loadCredits();
  }, [me.id]);
  const open = (page: typeof PlayPage.Profile | typeof PlayPage.Friends): void => {
    onPlayMode(true);
    if (page === PlayPage.Friends) studio().play.showFriends();
    else studio().play.showProfile(me.id);
  };
  return (
    <>
      <DropdownMenu
        onOpenChange={(opened) => {
          if (opened) void studio().people.loadCredits();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button type="button" className="profile-plate-main" aria-label={WORDS.plateLabel(me.name)} data-avatar-host>
            <PersonAvatar person={me} size={PLATE_FACE} />
            <span className="profile-plate-name">
              <span className="profile-plate-name-text">{me.name}</span>
              {me.pro && <span className="profile-plate-plan"> · {WORDS.pro}</span>}
            </span>
            <Icon name="chevrons" size={14} className="profile-plate-chevrons" />
          </button>
        </DropdownMenuTrigger>
        <PlateMenu me={me} waiting={waiting} onOpen={open} onSignOut={() => setSigningOut(true)} />
      </DropdownMenu>
      {offline ? <OfflineSlot /> : <PlateCredits />}
      {signingOut && <SignOutDialog onDismiss={() => setSigningOut(false)} />}
    </>
  );
}

/** Signed out: one press opens genex.games in the browser to sign in or make an account. */
function SignInPlate(): JSX.Element {
  const { busy, signIn } = useGenexSignIn();
  return (
    <button
      type="button"
      className="profile-plate-main"
      aria-label={WORDS.signInLabel}
      aria-busy={busy || undefined}
      data-genex-sign-in
      data-avatar-host
      onClick={signIn}
    >
      <FaceSlot waiting={busy} />
      <span className="profile-plate-name">
        <span className="profile-plate-name-text">{WORDS.signIn}</span>
      </span>
      <Icon name="arrow-up-right" size={14} className="profile-plate-chevrons" />
    </button>
  );
}

/** While the browser has the sign-in: a press opens its page again, and × stops it. */
function SigningInPlate(): JSX.Element {
  const { signIn } = useGenexSignIn();
  return (
    <>
      <button
        type="button"
        className="profile-plate-main"
        aria-label={WORDS.finishInBrowserLabel}
        data-genex-sign-in
        data-avatar-host
        onClick={signIn}
      >
        <FaceSlot waiting />
        <span className="profile-plate-name" role="status">
          <span className="profile-plate-name-text">{WORDS.finishInBrowser}</span>
        </span>
      </button>
      <button
        type="button"
        className="people-button people-button-icon"
        aria-label={WORDS.cancelSignIn}
        data-genex-cancel-sign-in
        onClick={() => void cancelGenexSignIn()}
      >
        <Icon name="close" size={16} />
      </button>
    </>
  );
}

/** genex.games ended the sign-in: the account dimmed, and one press to sign in again. */
function EndedPlate(): JSX.Element {
  const ended = usePeople((s) => s.ended);
  const { busy, signIn } = useGenexSignIn();
  return (
    <button
      type="button"
      className="profile-plate-main"
      aria-label={WORDS.signInAgainLabel(ended?.name ?? null)}
      aria-busy={busy || undefined}
      data-genex-sign-in
      data-avatar-host
      onClick={signIn}
    >
      <span className="plate-ended-face" aria-hidden="true">
        {ended ? <PersonAvatar person={ended} size={PLATE_FACE} /> : <FaceSlot />}
      </span>
      <span className="profile-plate-name">
        <span className="profile-plate-name-text">{WORDS.signInAgain}</span>
      </span>
      <Icon name="arrow-up-right" size={14} className="profile-plate-chevrons" />
    </button>
  );
}

/** The plate for where the account stands; nothing until the account is known or remembered. */
export function ProfilePlate({ onPlayMode }: { onPlayMode: (play: boolean) => void }): JSX.Element | null {
  const me = usePeople((s) => s.me);
  const account = usePeople((s) => s.account);
  const online = useOnline();
  const state = plateState({ me, account }, online);
  if (state === PlateState.Hidden) return null;
  return (
    <div className="profile-plate" data-profile-plate={state}>
      {state === PlateState.SignedOut && <SignInPlate />}
      {state === PlateState.SigningIn && <SigningInPlate />}
      {state === PlateState.Ended && <EndedPlate />}
      {me && (state === PlateState.SignedIn || state === PlateState.Offline) && (
        <AccountPlate me={me} offline={state === PlateState.Offline} onPlayMode={onPlayMode} />
      )}
    </div>
  );
}

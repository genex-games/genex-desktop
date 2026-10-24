/**
 * Share, beside the pencil on the account's own profile: a popover titled Share your profile with
 * the picture people see when the link is shared (genex.games' link preview, drawn here with the
 * app's own avatar — its body flat, as the preview draws it — chips and covers, so it shows offline
 * too), the profile link with Copy, then
 * Post on X and Share…. Escape or a press outside closes it, and the keyboard goes back to Share.
 */
import type { JSX } from "react";
import { useRef } from "react";
import type { PlayGame } from "../../shared/play.ts";
import type { PlayMe, PlayProfile } from "../../shared/play-people.ts";
import { linkWithoutScheme, profileUrl } from "../../shared/play-share.ts";
import { AvatarMotion } from "../avatars/GeneratedAvatar.tsx";
import { usePlayWeb } from "../state/hooks.ts";
import { Icon } from "../ui/icons.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { PLAY_WORDS } from "../words.ts";
import { PersonAvatar } from "./PersonAvatar.tsx";
import { formatCount } from "./play-model.ts";
import { LinkCopy, ShareRow } from "./ShareLinks.tsx";

const WORDS = PLAY_WORDS.people;
/** The link preview's avatar, on its 600 × 315 picture. */
const PREVIEW_AVATAR = 190;
/** How many covers the preview shows. */
const PREVIEW_COVERS = 3;
/** The wordmark the preview's corner carries, as genex.games draws it. */
const WORDMARK = "GENEX";

/** One of the preview's covers: the game's picture, or its plain tile when it has none. */
function PreviewCover({ game }: { game: PlayGame }): JSX.Element {
  const style = game.coverUrl ? { backgroundImage: `url("${game.coverUrl}")` } : undefined;
  return <span className="share-card-cover" style={style} data-plain={!game.coverUrl || undefined} />;
}

/** The preview's chips, as the profile's: games, then players (plays while genex.games counts no players). */
function previewChips(profile: PlayProfile): Array<{ value: number; noun: string }> {
  const games = profile.games.length;
  if (games === 0) return [];
  const plays = profile.games.reduce((sum, game) => sum + game.plays, 0);
  const people =
    profile.players === null
      ? { value: plays, noun: WORDS.chipPlays(plays) }
      : { value: profile.players, noun: WORDS.chipPlayers(profile.players) };
  return [{ value: games, noun: WORDS.chipGames(games) }, people];
}

/**
 * The picture a shared profile link shows (genex.games' link preview): the wordmark and the link
 * at the top, the avatar on the left, then the name with PRO, the handle, the chips and three
 * covers. Drawn at the preview's own size and scaled into the popover.
 */
function SharePreview({ me, profile, link }: { me: PlayMe; profile: PlayProfile; link: string }): JSX.Element {
  const covers = profile.games.slice(0, PREVIEW_COVERS);
  return (
    <div className="share-preview" role="img" aria-label={WORDS.sharePreviewLabel} data-share-preview>
      <div className="share-card" aria-hidden="true">
        <span className="share-card-word">{WORDMARK}</span>
        <span className="share-card-url">{linkWithoutScheme(link)}</span>
        <div className="share-card-body">
          <PersonAvatar person={me} size={PREVIEW_AVATAR} gear flat motion={AvatarMotion.Still} />
          <div className="share-card-who">
            <span className="share-card-name">
              {me.name}
              {me.pro && <span className="profile-pro">{WORDS.proTag}</span>}
            </span>
            {me.handle && <span className="profile-handle">@{me.handle}</span>}
            <span className="share-card-chips">
              {previewChips(profile).map((chip) => (
                <span key={chip.noun} className="profile-chip">
                  <b>{formatCount(chip.value)}</b>
                  {chip.noun}
                </span>
              ))}
            </span>
            {covers.length > 0 && (
              <span className="share-card-covers">
                {covers.map((game) => (
                  <PreviewCover key={game.id} game={game} />
                ))}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Share and its popover, for the account's own profile. */
export function ShareProfile({ me, profile }: { me: PlayMe; profile: PlayProfile }): JSX.Element {
  const link = profileUrl(usePlayWeb(), me);
  // Copy, the likeliest press, takes the first focus: the link box would select its text on opening.
  const copy = useRef<HTMLButtonElement>(null);
  return (
    <Popover>
      <PopoverTrigger
        render={<button type="button" />}
        className="profile-chip profile-edit"
        aria-label={WORDS.shareProfile}
        title={WORDS.shareProfile}
        data-profile-share
      >
        <Icon name="export" size={15} />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={10}
        className="share-popover"
        aria-label={WORDS.shareProfileTitle}
        initialFocus={copy}
        data-share-popover
      >
        <h2 className="share-popover-title">{WORDS.shareProfileTitle}</h2>
        <SharePreview me={me} profile={profile} link={link} />
        <LinkCopy link={link} label={WORDS.shareProfileLink} copyHook={{ "data-copy-profile": "" }} copyRef={copy} />
        <ShareRow link={link} xText={WORDS.profileXText} />
      </PopoverContent>
    </Popover>
  );
}

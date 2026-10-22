/**
 * A native game's own page (canvas board "GamePage"): its media and About on the left; on the right
 * its title, maker and facts, one primary block that carries the whole life of the game on this
 * computer (install, installing, play, playing, update, elsewhere, failed), Like, Comments and
 * Share, and four one-line tiles. Installing goes on when the page is left (its card shows it); a
 * game installed while the page stays open starts by itself. Every action is main's; the page only
 * reads what main says (`UiEvent.PlayInstalls`, `UiEvent.PlaySessions`).
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { sizeWords } from "../../shared/byte-size.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { intlLocale, t } from "../../shared/i18n.ts";
import { type PlayGameDetail, PlayNote, playPageUrl, PlayShelf } from "../../shared/play.ts";
import {
  InstallFailure,
  InstallPhase,
  NativeArch,
  NativePlatform,
  NativeSessionPhase,
  platformsOf,
} from "../../shared/play-native.ts";
import { usePlay, usePlayWeb } from "../state/hooks.ts";
import { FeedStatus } from "./play-model.ts";
import { PlayPage, type PlayView } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { richText } from "../rich-text.tsx";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { NATIVE_WORDS, nativeHereWords, notHereWords, PLAY_CARD_MENU_WORDS, PLAY_WORDS } from "../words.ts";
import { formatCount } from "./play-model.ts";
import { GamePhase, type GameStanding, gameStanding, installPercent, minutesSince } from "./native-model.ts";
import { PlayPageFrame } from "./PlayPageFrame.tsx";
import { PlatformMarks, platformNames } from "./NativeBadge.tsx";

const WORDS = NATIVE_WORDS;
/** How often the minutes played are counted again. */
const PLAYED_TICK_MS = 30 * SECOND_MS;
/** "2 days ago": how long ago a game changed, in the reader's own words. */
const AGO = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
const AGO_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60],
  ["month", 30 * 24 * 60],
  ["week", 7 * 24 * 60],
  ["day", 24 * 60],
  ["hour", 60],
  ["minute", 1],
];

/** How long ago `at` was, in the largest unit it reaches. */
function agoWords(at: string | null, now: number): string | null {
  if (!at) return null;
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / MINUTE_MS));
  const [unit, size] = AGO_STEPS.find(([, step]) => minutes >= step) ?? ["minute", 1];
  return AGO.format(-Math.floor(minutes / size), unit);
}

/** What Back says: the page it returns to. */
function backLabel(back: PlayView | null): string {
  if (back?.page === PlayPage.Friends) return PLAY_WORDS.people.friends;
  if (back?.page === PlayPage.Shelf) return PLAY_WORDS.shelves[PlayShelf.Games];
  return PLAY_WORDS.people.back;
}

/** The minutes a game has been played, counted again every half minute. */
function usePlayedMinutes(startedAt: string | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), PLAYED_TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt ? minutesSince(startedAt, now) : 0;
}

/** The progress bar that is the button while a game installs, with Cancel inside it. */
function Installing({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element {
  const progress = standing.progress;
  const percent = progress ? installPercent(progress) : 0;
  const label = (() => {
    if (progress?.phase === InstallPhase.Queued) return WORDS.waiting;
    if (progress?.phase === InstallPhase.Downloading) return WORDS.installing(percent);
    return WORDS.checking;
  })();
  return (
    <div
      className="game-installing"
      role="progressbar"
      aria-label={WORDS.installingLabel(game.title)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-game-installing={progress?.phase}
    >
      <span className="game-installing-fill" style={{ width: `${percent}%` }} />
      <span className="game-installing-row">
        <span>{label}</span>
        <button
          type="button"
          className="game-installing-cancel"
          data-game-action="cancel"
          onClick={() => void studio().play.cancelInstall(game.slug)}
        >
          {WORDS.cancel}
        </button>
      </span>
    </div>
  );
}

/** Playing: Show game and Quit, and how long it has been played. */
function Playing({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element {
  const session = standing.session;
  const running = session?.phase === NativeSessionPhase.Running;
  const minutes = usePlayedMinutes(running ? (session?.startedAt ?? null) : null);
  return (
    <>
      <div className="game-primary-row">
        <Button
          variant="play-tint"
          className="game-primary game-primary-wide"
          data-game-action="show"
          onClick={() => void studio().play.showWindow(game.slug)}
        >
          <Icon name="window" />
          {WORDS.showGame}
        </Button>
        <Button
          variant="secondary"
          className="game-primary"
          data-game-action="quit"
          onClick={() => void studio().play.quitGame(game.slug)}
        >
          {WORDS.quit}
        </Button>
      </div>
      <p className="game-primary-note" data-game-note="playing">
        <span className="game-live-dot" aria-hidden="true" />
        {running ? WORDS.playingFor(minutes) : WORDS.opening}
      </p>
    </>
  );
}

/** A failure: Try again, and one orange line naming the cause. */
function Failed({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element {
  const failure = standing.failure;
  const needed = (standing.build?.sizeBytes ?? 0) + (standing.build?.installedBytes ?? 0);
  const here = nativeHereWords(standing.here);
  const line = (() => {
    if (!failure) return WORDS.installFailed[InstallFailure.Failed]("", here);
    if ("launch" in failure) return WORDS.launchFailed[failure.launch](here);
    return WORDS.installFailed[failure.install](sizeWords(needed), here);
  })();
  const retry = () => {
    if (failure && "launch" in failure && standing.installed) void studio().play.launch(game.slug);
    else void studio().play.install(game.slug);
  };
  return (
    <>
      <Button variant="play-fill" className="game-primary" data-game-action="retry" onClick={retry}>
        {WORDS.tryAgain}
      </Button>
      <p className="game-primary-note game-primary-failed" data-game-note="failed" role="status">
        {line}
      </p>
    </>
  );
}

/** No build installs on this computer: in place of Install, why not, in one title and one line. */
function Elsewhere({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element | null {
  if (!standing.notHere) return null;
  const { title, line } = notHereWords(standing.notHere, platformsOf(game), standing.here);
  return (
    <div className="game-elsewhere" data-game-note="elsewhere" role="status">
      <span className="game-elsewhere-title">{title}</span>
      <span className="game-elsewhere-line">{line}</span>
    </div>
  );
}

/** The one block that carries the game's life on this computer. */
function PrimaryBlock({
  game,
  standing,
  onPlayWhenReady,
}: {
  game: PlayGameDetail;
  standing: GameStanding;
  /** Install pressed: play once it is installed, while the page is still open. */
  onPlayWhenReady: () => void;
}): JSX.Element {
  const { build, installed } = standing;
  const install = () => {
    onPlayWhenReady();
    void studio().play.install(game.slug);
  };
  switch (standing.phase) {
    case GamePhase.Installing:
      return <Installing game={game} standing={standing} />;
    case GamePhase.Playing:
      return <Playing game={game} standing={standing} />;
    case GamePhase.Failed:
      return <Failed game={game} standing={standing} />;
    case GamePhase.Elsewhere:
      return <Elsewhere game={game} standing={standing} />;
    case GamePhase.Ready:
      return (
        <>
          <Button
            variant="play-fill"
            className="game-primary"
            aria-label={WORDS.playLabel(game.title)}
            data-game-action="play"
            onClick={() => void studio().play.launch(game.slug)}
          >
            <Icon name="play" size={14} />
            {WORDS.play}
          </Button>
          <p className="game-primary-note" data-game-note="ready">
            <Icon name="check" size={13} className="game-check" />
            {nativeHereWords(standing.here).readyHere(sizeWords(installed?.bytes ?? 0))}
          </p>
        </>
      );
    case GamePhase.Update:
      return (
        <>
          <Button variant="play-fill" className="game-primary" data-game-action="update" onClick={install}>
            <Icon name="update" />
            {WORDS.updateAndPlay}
            <span className="game-primary-size">{sizeWords(build?.sizeBytes ?? 0)}</span>
          </Button>
          {installed && (
            <button
              type="button"
              className="game-text-button"
              data-game-action="play-installed"
              onClick={() => void studio().play.launch(game.slug)}
            >
              {WORDS.playVersion(installed.version)}
            </button>
          )}
        </>
      );
    default:
      return (
        <Button
          variant="play-fill"
          className="game-primary"
          aria-label={WORDS.installLabel(game.title, sizeWords(build?.installedBytes ?? 0))}
          data-game-action="install"
          onClick={install}
        >
          <Icon name="download" />
          {WORDS.install}
          <span className="game-primary-size">{sizeWords(build?.installedBytes ?? 0)}</span>
        </Button>
      );
  }
}

/** Like, Comments (genex.games' page, where they live) and Share. */
function Pills({ game }: { game: PlayGameDetail }): JSX.Element {
  const web = usePlayWeb();
  const [like, setLike] = useState({ liked: game.liked, likes: game.likes });
  const toggle = async () => {
    try {
      setLike(await studio().api.playLike(game.slug, !like.liked));
    } catch {
      studio().notify(PLAY_WORDS.bar.notes[PlayNote.LikeFailed], ToastTone.Error);
    }
  };
  const share = () =>
    void navigator.clipboard.writeText(playPageUrl(web, game.slug)).then(
      () => studio().notify(PLAY_CARD_MENU_WORDS.linkCopied, ToastTone.Ok),
      () => studio().notify(PLAY_CARD_MENU_WORDS.copyFailed, ToastTone.Error),
    );
  return (
    <div className="game-pills">
      <button
        type="button"
        className="game-pill"
        aria-pressed={like.liked}
        aria-label={PLAY_WORDS.bar.likes(formatCount(like.likes))}
        data-game-action="like"
        onClick={() => void toggle()}
      >
        <Icon name="heart" />
        {formatCount(like.likes)}
      </button>
      <button
        type="button"
        className="game-pill"
        aria-label={PLAY_WORDS.bar.commentsCount(formatCount(game.comments))}
        data-game-action="comments"
        onClick={() => void studio().api.openUrl(playPageUrl(web, game.slug))}
      >
        <Icon name="chat" />
        {formatCount(game.comments)}
      </button>
      <button
        type="button"
        className="game-pill game-pill-icon"
        aria-label={PLAY_WORDS.bar.share}
        data-game-action="share"
        onClick={share}
      >
        <Icon name="export" />
      </button>
    </div>
  );
}

/** One tile: its mark and one line, never a second; `label` names a mark that says more than the line. */
function Tile({
  mark,
  text,
  hook,
  label,
}: {
  mark: JSX.Element;
  text: string;
  hook: string;
  label?: string;
}): JSX.Element {
  const named = label ? { role: "img", "aria-label": label } : {};
  return (
    <div className="game-tile" data-game-tile={hook} title={label}>
      <span className="game-tile-mark" {...named}>
        {mark}
      </span>
      <span className="game-tile-text">{text}</span>
    </div>
  );
}

/** The four tiles: systems, size, players, engine. */
function Tiles({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element {
  const platforms = platformsOf(game);
  const bytes = standing.installed?.bytes ?? standing.build?.installedBytes ?? 0;
  const engine = game.native?.engine ?? null;
  const appleSilicon = standing.build?.platform === NativePlatform.Mac && standing.build.arch === NativeArch.Arm64;
  const armOnly = appleSilicon ? ` · ${WORDS.appleSiliconOnly}` : "";
  return (
    <div className="game-tiles">
      <Tile
        hook="platforms"
        mark={<PlatformMarks platforms={platforms} />}
        text={WORDS.platformsTile}
        label={`${platformNames(platforms)}${armOnly}`}
      />
      {bytes > 0 && <Tile hook="size" mark={<Icon name="drive" />} text={sizeWords(bytes)} />}
      <Tile
        hook="players"
        mark={<Icon name={game.multiplayer ? "users" : "character"} />}
        text={game.multiplayer ? WORDS.multiplayer : WORDS.singlePlayer}
      />
      {engine && (
        <Tile hook="engine" mark={<Icon name="box" />} text={WORDS.madeWith(WORDS.engine[engine] ?? engine)} />
      )}
    </div>
  );
}

/** The media: the shot picked (the cover first), and up to four shots under it to pick from. */
function Media({ game }: { game: PlayGameDetail }): JSX.Element {
  const shots = [game.coverUrl, ...game.shots].filter((shot): shot is string => shot !== null).slice(0, 4);
  const [picked, setPicked] = useState(0);
  const shown = shots[picked] ?? null;
  return (
    <div className="game-media">
      <div className="game-media-main">{shown && <img src={shown} alt="" draggable={false} />}</div>
      {shots.length > 1 && (
        <div className="game-shots">
          {shots.map((shot, at) => (
            <button
              key={shot}
              type="button"
              className="game-shot"
              aria-pressed={at === picked}
              aria-label={t("{game} {number}", { game: game.title, number: at + 1 })}
              onClick={() => setPicked(at)}
            >
              <img src={shot} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {game.description && (
        <section className="game-about">
          <h2>{WORDS.about}</h2>
          <p>{game.description}</p>
        </section>
      )}
    </div>
  );
}

/** "By" and the maker's name; with their account known, the name opens their profile. */
function MadeBy({ name, authorId }: { name: string; authorId: string | null }): JSX.Element {
  const maker = authorId ? (
    <button type="button" className="game-by-link" onClick={() => studio().play.showProfile(authorId)}>
      {name}
    </button>
  ) : (
    name
  );
  // The name is someone else's words: the tag draws it from the game, never from the parsed sentence.
  return <p className="game-by">{richText(t("By <maker>{name}</maker>"), { maker: () => maker })}</p>;
}

/** The right column: title, maker, facts, the primary block, the pills and the tiles. */
function Side({ game }: { game: PlayGameDetail }): JSX.Element {
  const installs = usePlay((s) => s.installs);
  const sessions = usePlay((s) => s.sessions);
  const standing = gameStanding(game, installs, sessions);
  const [playWhenReady, setPlayWhenReady] = useState(false);
  // Installed while the page is open: it starts by itself (leaving the page forgets the wish).
  useEffect(() => {
    if (!playWhenReady) return;
    if (standing.phase === GamePhase.Ready) {
      setPlayWhenReady(false);
      void studio().play.launch(game.slug);
    }
    if (standing.phase === GamePhase.Failed) setPlayWhenReady(false);
  }, [playWhenReady, standing.phase, game.slug]);
  const stats = WORDS.stats(formatCount(game.plays), formatCount(game.likes), agoWords(game.updatedAt, Date.now()));
  return (
    <div className="game-side" data-game-phase={standing.phase}>
      <div className="game-head">
        <h1 className="game-title">{game.title}</h1>
        {game.author.name && <MadeBy name={game.author.name} authorId={game.author.id} />}
        <p className="game-stats">{stats}</p>
      </div>
      <div className="game-primary-block">
        <PrimaryBlock game={game} standing={standing} onPlayWhenReady={() => setPlayWhenReady(true)} />
      </div>
      <Pills game={game} />
      <Tiles game={game} standing={standing} />
    </div>
  );
}

/** A native game's own page. */
export function GamePage({
  slug,
  sidebarHidden,
  onToggleSidebar,
}: {
  slug: string;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}): JSX.Element {
  const entry = usePlay((s) => s.games[slug]);
  const back = usePlay((s) => (s.view.page === PlayPage.Game ? s.view.back : null));
  useEffect(() => {
    void studio().play.loadGame(slug);
    void studio().play.loadNative();
  }, [slug]);
  const game = entry?.game ?? null;
  return (
    <PlayPageFrame
      label={game?.title ?? PLAY_WORDS.shelves[PlayShelf.Games]}
      sidebarHidden={sidebarHidden}
      onToggleSidebar={onToggleSidebar}
      onBack={() => studio().play.back()}
      backLabel={backLabel(back)}
    >
      {game && (
        <div className="game-page" data-game-page={slug}>
          <Media game={game} />
          <Side game={game} />
        </div>
      )}
      {!game && entry?.status === FeedStatus.Failed && (
        <div className="people-note">
          {WORDS.failedToLoad}
          <Button variant="secondary" onClick={() => void studio().play.loadGame(slug)}>
            {PLAY_WORDS.retry}
          </Button>
        </div>
      )}
    </PlayPageFrame>
  );
}

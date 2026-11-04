/**
 * A game's own page (canvas "Bodycam game page", round 2, A): the top (`GameHero.tsx`) runs the
 * game's clip or pictures to the window's edge, with its title, maker and counts, one primary block
 * that carries the whole life of the game on this computer (install, installing, play, playing,
 * update, elsewhere, failed), and Like, Comments and Share over them; under it four facts (the
 * systems it runs on, its size, its players, which its owner sets for an app-only game, its engine), its shots once it has two pictures or
 * more, About, and the game's Store (`GameStore.tsx`), once it sells something. A native game opens
 * here from its card; any game opens here from a link or the profile's item shelf, and one with a
 * web build that is not installed here plays in the viewer, as its card does. Installing goes on
 * when the page is left (its card shows it); a game installed while the page stays open starts by
 * itself. Every action is main's; the page only reads what main says (`UiEvent.PlayInstalls`,
 * `UiEvent.PlaySessions`).
 */
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { sizeWords } from "../../shared/byte-size.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { intlLocale, t } from "../../shared/i18n.ts";
import { type PlayGameDetail, PlayNote, playPageUrl, PlayShelf } from "../../shared/play.ts";
import {
  hasWebBuild,
  InstallFailure,
  InstallPhase,
  NativeArch,
  NativeEngine,
  NativePlatform,
  NativeSessionPhase,
  platformsOf,
} from "../../shared/play-native.ts";
import { usePlay, usePlayWeb } from "../state/hooks.ts";
import { CardMenu } from "./card-menu/CardMenu.tsx";
import { useCardMenu } from "./PlayCard.tsx";
import { FeedStatus } from "./play-model.ts";
import { PlayPage, type PlayView } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { richText } from "../rich-text.tsx";
import { ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { NATIVE_WORDS, nativeHereWords, notHereWords, PLAY_CARD_MENU_WORDS, PLAY_WORDS } from "../words.ts";
import { formatCount, type LikeShown, likeFlipped } from "./play-model.ts";
import { GamePhase, type GameStanding, gameStanding, installPercent, minutesSince } from "./native-model.ts";
import { PlayPageFrame } from "./PlayPageFrame.tsx";
import { PlayersValue } from "./PlayersFact.tsx";
import { PlatformMarks, platformNames } from "./NativeBadge.tsx";
import { GameStore } from "./GameStore.tsx";
import { GameHero, HeroPause, useHeroMoves, useReducedMotion, useSlideshow } from "./GameHero.tsx";
import { HeroArt, type HeroFrame, heroArt, heroFrames, runsSlideshow } from "./game-hero.ts";
import { setClipsCovered, useClipsPaused } from "./clip-playback.ts";
import { nativeViewsUp } from "./play-model.ts";
import { usePictureUnderControls } from "../window-controls.ts";

const WORDS = NATIVE_WORDS;
/** How often the minutes played are counted again. */
const PLAYED_TICK_MS = 30 * SECOND_MS;
/** How long Share shows its check once the link is copied. */
const COPIED_MS = 1.6 * SECOND_MS;
/** A title this long or longer is set a step smaller, so it keeps to two lines. */
const LONG_TITLE_CHARS = 26;
/** Each engine's own mark; any other engine is a box. */
const ENGINE_MARK: Readonly<Record<string, IconName>> = {
  [NativeEngine.Unreal]: "unreal",
  [NativeEngine.Unity]: "unity",
  [NativeEngine.Godot]: "godot",
} satisfies Record<NativeEngine, IconName>;
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
    <div className="game-elsewhere" data-game-note="elsewhere" role="status" title={`${title}. ${line}`}>
      <span className="game-elsewhere-title">{title}</span>
      <span className="game-elsewhere-line">{line}</span>
    </div>
  );
}

/**
 * Whether the page plays the game in the viewer: it has a web build, and nothing of it is installed,
 * installing, running or failed here, so Play does what its card does.
 */
const playsInViewer = (game: PlayGameDetail, standing: GameStanding): boolean =>
  hasWebBuild(game) && (standing.phase === GamePhase.Install || standing.phase === GamePhase.Elsewhere);

/** Play for a game with a web build: the viewer opens over the page, as the game's card opens it. */
function PlayInViewer({ game }: { game: PlayGameDetail }): JSX.Element {
  return (
    <Button
      variant="play-fill"
      className="game-primary"
      aria-label={WORDS.playLabel(game.title)}
      data-game-action="play-web"
      onClick={() => void studio().play.open({ slug: game.slug, title: game.title, coverUrl: game.coverUrl })}
    >
      <Icon name="play" size={14} />
      {WORDS.play}
    </Button>
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
  if (playsInViewer(game, standing)) return <PlayInViewer game={game} />;
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

/** Share: copies the game's genex.games page, and its icon turns into a check that draws itself for a moment. */
function ShareButton({ game }: { game: PlayGameDetail }): JSX.Element {
  const web = usePlayWeb();
  const [copied, setCopied] = useState(false);
  const [everCopied, setEverCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const share = () =>
    void navigator.clipboard.writeText(playPageUrl(web, game.slug)).then(
      () => {
        window.clearTimeout(timer.current);
        setCopied(true);
        setEverCopied(true);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => studio().notify(PLAY_CARD_MENU_WORDS.copyFailed, ToastTone.Error),
    );
  return (
    <button
      type="button"
      className="game-pill game-pill-icon"
      aria-label={PLAY_WORDS.bar.share}
      data-game-action="share"
      data-copied={copied || undefined}
      onClick={share}
    >
      {/* Keyed by what it shows, so each swap pops in; the first share icon stays still. */}
      <span key={copied ? "copied" : "share"} className="game-share-mark" data-pop={everCopied || undefined}>
        <Icon name={copied ? "check" : "export"} size={copied ? 20 : 18} strokeWidth={copied ? 2 : 1.75} />
      </span>
      <span className="sr-only" role="status">
        {copied ? PLAY_CARD_MENU_WORDS.linkCopied : ""}
      </span>
    </button>
  );
}

/** Like, Comments (genex.games' page, where they live) and Share. */
function Pills({ game }: { game: PlayGameDetail }): JSX.Element {
  const web = usePlayWeb();
  const [like, setLike] = useState<LikeShown>({ liked: game.liked, likes: game.likes });
  // The heart turns at the press; genex.games' answer then sets the count, and a failure puts it back.
  const toggle = async () => {
    const before = like;
    setLike(likeFlipped(before));
    try {
      setLike(await studio().api.playLike(game.slug, !before.liked));
    } catch {
      setLike(before);
      studio().notify(PLAY_WORDS.bar.notes[PlayNote.LikeFailed], ToastTone.Error);
    }
  };
  return (
    <>
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
      <ShareButton game={game} />
      <PageMenu game={game} />
    </>
  );
}

/**
 * The page's ⋯ after Share: the card's menu (`CardMenu`), so an installed game is shown in its
 * folder or removed from this computer here too, and its owner gets their items. With nothing in
 * it, there is no ⋯.
 */
function PageMenu({ game }: { game: PlayGameDetail }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const menu = useCardMenu(game);
  const installed = usePlay((s) => s.installs.installed.find((one) => one.slug === game.slug) ?? null);
  if (!menu && !installed) return null;
  return (
    <CardMenu
      game={game}
      menu={menu}
      installed={installed}
      open={open}
      onOpenChange={setOpen}
      triggerClassName="game-pill game-pill-icon game-menu"
    />
  );
}

/** One fact under the top: its mark, a small label and its value. */
function Fact({
  mark,
  label,
  value,
  hook,
}: {
  mark: JSX.Element;
  label: string;
  /** Its words, or a value that draws itself (the owner's Players menu). */
  value: string | JSX.Element;
  hook: string;
}): JSX.Element {
  return (
    <div className="game-fact" data-game-tile={hook}>
      <span className="game-fact-mark">{mark}</span>
      <span className="game-fact-words">
        <span className="game-fact-label">{label}</span>
        {typeof value === "string" ? <span className="game-fact-value">{value}</span> : value}
      </span>
    </div>
  );
}

/** The four facts: the systems it runs on, its size, its players, its engine; each only when known. */
function Facts({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element {
  const facts = WORDS.facts;
  const platforms = platformsOf(game);
  const bytes = standing.installed?.bytes ?? standing.build?.installedBytes ?? 0;
  const engine = game.native?.engine ?? null;
  const appleSilicon = standing.build?.platform === NativePlatform.Mac && standing.build.arch === NativeArch.Arm64;
  const armOnly = appleSilicon ? ` · ${WORDS.appleSiliconOnly}` : "";
  return (
    <div className="game-facts">
      {platforms.length > 0 && (
        <Fact
          hook="platforms"
          mark={<PlatformMarks platforms={platforms} size={24} />}
          label={facts.runsOn}
          value={`${platformNames(platforms)}${armOnly}`}
        />
      )}
      {bytes > 0 && (
        <Fact hook="size" mark={<Icon name="drive" size={24} />} label={facts.size} value={sizeWords(bytes)} />
      )}
      <Fact
        hook="players"
        mark={<Icon name={game.multiplayer ? "users" : "character"} size={24} />}
        label={facts.players}
        value={<PlayersValue game={game} />}
      />
      {engine && (
        <Fact
          hook="engine"
          mark={<Icon name={ENGINE_MARK[engine] ?? "box"} size={24} />}
          label={facts.madeWith}
          value={WORDS.engine[engine] ?? engine}
        />
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

/** The words over the top: title, maker and counts, then the primary block with Like, Comments and Share. */
function Head({ game, standing }: { game: PlayGameDetail; standing: GameStanding }): JSX.Element {
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
  const stats = WORDS.stats(
    { n: game.plays, shown: formatCount(game.plays) },
    { n: game.likes, shown: formatCount(game.likes) },
    agoWords(game.updatedAt, Date.now()),
  );
  return (
    <div className="game-side" data-game-phase={standing.phase}>
      <div className="game-head">
        <h1 className="game-title" data-long={game.title.length >= LONG_TITLE_CHARS || undefined}>
          {game.title}
        </h1>
        <div className="game-by-row">
          {game.author.name && <MadeBy name={game.author.name} authorId={game.author.id} />}
          <p className="game-stats">{stats}</p>
        </div>
      </div>
      <div className="game-actions">
        <div className="game-primary-block">
          <PrimaryBlock game={game} standing={standing} onPlayWhenReady={() => setPlayWhenReady(true)} />
        </div>
        <Pills game={game} />
      </div>
    </div>
  );
}

/** The shots under the facts: each shows on the top when pressed. */
function Shots({
  title,
  shots,
  onPick,
}: {
  title: string;
  /** Each shot with its place in the top's run. */
  shots: ReadonlyArray<{ src: string; at: number }>;
  onPick: (at: number) => void;
}): JSX.Element {
  return (
    <section className="game-shots-section" aria-label={WORDS.shots}>
      <h2 className="game-section-title">{WORDS.shots}</h2>
      <div className="game-shots">
        {shots.map((shot) => (
          <button
            key={shot.src}
            type="button"
            className="game-shot"
            aria-label={t("{game} {number}", { game: title, number: shot.at + 1 })}
            onClick={() => onPick(shot.at)}
          >
            <img src={shot.src} alt="" draggable={false} decoding="async" />
          </button>
        ))}
      </div>
    </section>
  );
}

/** The page under the top's art: facts, shots, About and the Store. */
function GameBody({
  game,
  standing,
  shots,
  onPick,
}: {
  game: PlayGameDetail;
  standing: GameStanding;
  shots: ReadonlyArray<{ src: string; at: number }>;
  onPick: (at: number) => void;
}): JSX.Element {
  return (
    <div className="game-body">
      <Facts game={game} standing={standing} />
      {shots.length > 0 && <Shots title={game.title} shots={shots} onPick={onPick} />}
      {game.description && (
        <section className="game-about">
          <h2 className="game-section-title">{WORDS.about}</h2>
          <p>{game.description}</p>
        </section>
      )}
      <GameStore slug={game.slug} />
    </div>
  );
}

/** The page's one game: the top, run through its pictures, and the page under it. */
function GameSheet({
  game,
  frames,
  onFailed,
}: {
  game: PlayGameDetail;
  /** The pictures the top runs through (`heroFrames`). */
  frames: readonly HeroFrame[];
  onFailed: (src: string) => void;
}): JSX.Element {
  const installs = usePlay((s) => s.installs);
  const sessions = usePlay((s) => s.sessions);
  const viewerUp = usePlay((s) => nativeViewsUp(s.viewer));
  const standing = gameStanding(game, installs, sessions);
  const paused = useClipsPaused();
  const reduced = useReducedMotion();
  const { at, pick } = useSlideshow(frames.length, !paused && !reduced);
  const top = useRef<HTMLDivElement>(null);
  // A game's picture lies under the window's own controls (Windows draws them over it, unboxed).
  usePictureUnderControls(heroArt(frames) !== HeroArt.None && !viewerUp);
  const shots = runsSlideshow(frames)
    ? frames.map((frame, index) => ({ src: frame.src, at: index })).filter((shot) => shot.src !== game.coverUrl)
    : [];
  const show = (index: number) => {
    pick(index);
    top.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };
  return (
    <div ref={top} className="game-page" data-game-page={game.slug}>
      <GameHero title={game.title} frames={frames} at={at} onPick={pick} onFailed={onFailed}>
        <Head game={game} standing={standing} />
      </GameHero>
      <GameBody game={game} standing={standing} shots={shots} onPick={show} />
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
  // The viewer over the page holds the clip: nobody sees it play.
  const covered = usePlay((s) => s.viewer !== null);
  useEffect(() => {
    setClipsCovered(covered);
    // A page that goes away while the viewer is open must not leave clips held.
    return () => setClipsCovered(false);
  }, [covered]);
  useEffect(() => {
    void studio().play.loadGame(slug);
    void studio().play.loadNative();
  }, [slug]);
  const game = entry?.game ?? null;
  // Pictures that failed to load leave the top's run; a new page (keyed by slug) starts afresh.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const frames = useMemo(() => (game ? heroFrames(game, failed) : []), [game, failed]);
  const moves = useHeroMoves(frames);
  return (
    <PlayPageFrame
      label={game?.title ?? PLAY_WORDS.shelves[PlayShelf.Games]}
      sidebarHidden={sidebarHidden}
      onToggleSidebar={onToggleSidebar}
      onBack={() => studio().play.back()}
      backLabel={backLabel(back)}
      bleed={game !== null}
      actions={moves && <HeroPause />}
    >
      {game && (
        <GameSheet game={game} frames={frames} onFailed={(src) => setFailed((current) => new Set(current).add(src))} />
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

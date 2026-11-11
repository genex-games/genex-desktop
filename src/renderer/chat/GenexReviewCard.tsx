/**
 * Genex's review in the game's chat (mockups A2, C2, C3, C4, D2). The game's newest review record or
 * fix press is its live card, drawn from Genex's word now (so "Checking your fixes" turns into "is
 * public again" in place); a live game's card is the Publish window's banner in small (canvas "Live
 * card in chat", D, and round 2, version 4): the cover with "Live" and "{name} is live!" on it, and
 * under it the game's link with Copy link and Open, which shows the game's page in Play. It says
 * nothing else. Every older one settles into one line, "{label} · {when} ›", which opens to what its
 * record says, read only.
 */
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { gameCoverUrl } from "../../shared/game-cover.ts";
import { GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { intlLocale } from "../../shared/i18n.ts";
import { playPageSlug } from "../../shared/play.ts";
import { publishesAsWebGame } from "../../shared/project-workspace.ts";
import type { GenexReviewEntry } from "../chat-entries.ts";
import { readGenexShot } from "../panels/plugins/genex/genex-cover-shot.ts";
import { LinkTarget } from "../panels/plugins/genex/genex-publish-view.ts";
import { ReviewCard } from "../panels/plugins/genex/ReviewCard.tsx";
import {
  fixHistoryLabel,
  historyLabel,
  ReviewPlace,
  type ReviewCardView,
  reviewCardView,
  type SettledCardView,
  settledCardView,
} from "../panels/plugins/genex/review-card-view.ts";
import { useGenexPublishState } from "../panels/plugins/genex/use-genex-publishing.ts";
import { useGenexFix, useGenexReview } from "../panels/plugins/genex/use-genex-review.ts";
import { openPlayGame } from "../play/open-play.ts";
import { runPluginAction } from "../plugin-actions.ts";
import { useLibrary, usePlayWeb, usePlugins } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useAsyncEffect } from "../use-async-effect.ts";
import { useCopy } from "../use-copy.ts";
import { GENEX_WORDS, REVIEW_WORDS } from "../words.ts";

/** The longest edge the live card's picture is read at. */
const CARD_PICTURE_PX = 960;

/** A record's time as a history line says it: "Oct 27, 14:06". */
const when = (iso: string): string =>
  Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

/** What a settled card said then, read only: its title, lines, a person's words and its things, no press. */
function SettledCard({ card }: { card: SettledCardView }): JSX.Element {
  return (
    <section className="genex-review-card genex-review-settled" data-tone="quiet" data-genex-review-settled>
      <p className="genex-review-title">
        <span>{card.title}</span>
      </p>
      {card.lines.map((line) => (
        <p key={line} className="genex-review-line">
          {line}
        </p>
      ))}
      {card.quote && (
        <blockquote className="genex-review-quote" data-analytics-mask>
          “{card.quote}”
        </blockquote>
      )}
      {card.things.length > 0 && (
        <ul className="genex-review-things" data-analytics-mask>
          {card.things.map((thing) => (
            <li key={thing.text}>{thing.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** An older record, settled into one line, "{label} · {when} ›", that opens to what it said then. */
function HistoryLine({ entry, title }: { entry: GenexReviewEntry; title: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const label = entry.fix ? fixHistoryLabel(entry.fix.count ?? 0) : historyLabel(entry.review ?? {});
  if (!label) return null;
  const card = open ? settledCardView(entry, title) : null;
  return (
    <div className="genex-review-history" data-genex-review-history={entry.review?.change ?? "fix"}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="genex-review-history-line">
        <span className="genex-review-history-ring" aria-hidden />
        <span>{label}</span>
        <span className="genex-review-history-when">· {when(entry.review?.at ?? entry.fix?.at ?? entry.at)}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {card && <SettledCard card={card} />}
    </div>
  );
}

/** The live card's picture: the game's kept Genex cover, else its own cover in Studio, which the banner blurs. */
function useLiveCover(project: string): { src: string; shot: boolean } {
  const [shot, setShot] = useState<string | null>(null);
  const cover = useLibrary((s) => s.games.find((one) => one.name === project)?.cover);
  const fallback = useMemo(() => gameCoverUrl(cover, project), [cover, project]);
  useAsyncEffect(
    (alive) => {
      void readGenexShot(project, CARD_PICTURE_PX).then((read) => {
        if (alive()) setShot(read);
      });
      return undefined;
    },
    [project],
  );
  return { src: shot ?? fallback, shot: shot !== null };
}

/**
 * What the live game's Open does: the game's page in Play, inside the app (`inApp`), for a game Play
 * can show; a game on another Genex goes to the browser, through the plugin's checked link.
 */
function useOpenLive(project: string, link: string): { inApp: boolean; run: () => void } {
  const slug = playPageSlug(usePlayWeb(), link);
  const plugin = usePlugins((s) => s.list.find((one) => one.manifest.id === GENEX_PLUGIN_ID));
  const run = () => {
    if (slug !== null) {
      openPlayGame(slug);
      return;
    }
    if (plugin)
      void runPluginAction({
        plugin,
        name: GenexAction.PublishOpen,
        args: { target: LinkTarget.Gallery },
        project,
        review: () => {},
      });
  };
  return { inApp: slug !== null, run };
}

/** The live game's link: its address, Copy link, and Open ({@link useOpenLive}). */
function LiveLink({ project, link }: { project: string; link: string }): JSX.Element {
  const [copied, copy] = useCopy();
  const open = useOpenLive(project, link);
  return (
    <div className="genex-review-live-link">
      <span className="genex-review-live-address" data-genex-review-address data-analytics-mask title={link}>
        <Icon name="link" size={15} />
        <span>{link.replace(/^https:\/\//, "")}</span>
      </span>
      {/* The two presses stay together: in a narrow chat they go under the address, which is never cut for them. */}
      <span className="genex-review-live-presses">
        <Button variant="play-tint" data-genex-review-copy onClick={() => copy(link)}>
          <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "text-green" : undefined} />
          {REVIEW_WORDS.press.copyLink}
        </Button>
        {/* Heard by assistive tech: the press keeps its words, and only its icon turns into a check.
            Not a `status` role, which smoke runners count as a toast. */}
        <span className="sr-only" aria-live="polite">
          {copied ? GENEX_WORDS.publish.copied : ""}
        </span>
        <Button
          variant="play-tint"
          data-genex-review-open
          aria-label={GENEX_WORDS.publish.openGameLabel}
          onClick={open.run}
        >
          {GENEX_WORDS.publish.openGame}
          <Icon name={open.inApp ? "chevron-right" : "arrow-up-right"} size={14} />
        </Button>
      </span>
    </div>
  );
}

/** The live game's card: its cover as a banner that says it is live, and its link with Copy link and Open. */
function LiveCard({ project, view }: { project: string; view: ReviewCardView }): JSX.Element {
  const cover = useLiveCover(project);
  const link = useGenexPublishState(project, true).state?.galleryUrl;
  return (
    <section
      className="genex-review-live"
      data-genex-review={view.kind}
      data-tone="done"
      aria-label={REVIEW_WORDS.label}
    >
      <div className="genex-publish-banner" data-shot={cover.shot || undefined}>
        <img src={cover.src} alt={GENEX_WORDS.publish.coverCardAlt} draggable={false} />
        <span className="genex-publish-banner-shade" aria-hidden />
        <span className="genex-publish-chip" data-tone="live">
          {GENEX_WORDS.publish.chipLiveUndated}
        </span>
        <div className="genex-publish-banner-foot">
          <p className="genex-publish-banner-line genex-review-title">
            <span>{view.title}</span>
          </p>
        </div>
      </div>
      {link && <LiveLink project={project} link={link} />}
    </section>
  );
}

/** The game's live card: Genex's word now and the newest fix press, as the dialog's card draws them. */
function LiveReview({ project }: { project: string }): JSX.Element | null {
  const status = useGenexReview(project);
  const { fix, latest } = useGenexFix(project);
  const game = useLibrary((s) => s.games.find((one) => one.name === project));
  const title = game?.title || project;
  const web = game ? publishesAsWebGame(game) : false;
  const view = reviewCardView({ status, fix, latest, title, web, place: ReviewPlace.Chat });
  if (!view) return null;
  if (view.live) return <LiveCard project={project} view={view} />;
  return (
    <ReviewCard
      project={project}
      view={view}
      record={status?.record ?? null}
      place={ReviewPlace.Chat}
      fixId={fix?.fixId}
    />
  );
}

export function GenexReviewCard({ entry, project }: { entry: GenexReviewEntry; project: string | null }) {
  const game = entry.project ?? project;
  const named = useLibrary((s) => s.games.find((one) => one.name === game)?.title);
  if (!game) return null;
  const title = named || entry.review?.title || game;
  return entry.latest ? <LiveReview project={game} /> : <HistoryLine entry={entry} title={title} />;
}

/**
 * Publish to the web, drawn by Studio over the game's stage in the app's own type and buttons.
 * Publish belongs to the person's Genex account, not to the Genex plugin: with the plugin off it
 * works the same, and the one thing it asks for first is an account (signing in from here brings
 * back a Genex that was removed). Then it shows one dialog with one main button: the game and the
 * name players will see, Publish, its progress in that same button and under it, and the link once the game is live.
 * A failed attempt is said calmly, with the raw detail kept for support. The Publish press is the
 * consent to the files it uploads (listed on request beside it); nothing asks again. While the
 * game has no Genex cover to send, one quiet line says it goes out without a picture.
 */
import type { JSX, ReactNode, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import type { FeedbackDraft } from "../../../../shared/feedback.ts";
import { gameCoverUrl } from "../../../../shared/game-cover.ts";
import {
  cleanGenexTitle,
  GENEX_PLUGIN_ID,
  GENEX_SLUG_MAX_CHARS,
  GENEX_TITLE_MAX_CHARS,
  genexSlug,
  GenexAction,
  GenexBuildReview,
  type GenexNativeRecord,
  type GenexPublishJob,
  GenexPublishJobState,
  type GenexPublishState,
} from "../../../../shared/genex.ts";
import { playPageSlug } from "../../../../shared/play.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { GenexAccountStatus } from "../../../../shared/genex-account.ts";
import { MakingDrawing } from "../../../making-art.ts";
import { prefersReducedMotion } from "../../../ui/media-queries.ts";
import { openPlayGame } from "../../../play/open-play.ts";
import { cancelGenexSignIn, signInToGenex, useGenexSignIn } from "../../../play/use-genex-sign-in.ts";
import { useLibrary, usePeople, usePlayWeb } from "../../../state/hooks.ts";
import { studio } from "../../../state/studio.ts";
import { Button } from "../../../ui/Button.tsx";
import { OPEN_PLUGINS_EVENT } from "../../../ui/ComposerAddMenu.tsx";
import { DialogSurface } from "../../../ui/dialog.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { Pending } from "../../../ui/Pending.tsx";
import { StatusOrb } from "../../../ui/StatusOrb.tsx";
import { StepBar } from "../../../ui/StepBar.tsx";
import { SendProgress } from "./SendProgress.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { useCopy } from "../../../use-copy.ts";
import { richText } from "../../../rich-text.tsx";
import { ACCOUNT_WORDS, GENEX_WORDS, problemWords, REVIEW_WORDS } from "../../../words.ts";
import { MakingArt } from "../../MakingArt.tsx";
import { PluginApproval } from "../../PluginApproval.tsx";
import { readGenexShot } from "./genex-cover-shot.ts";
import { GenexAccountKind, genexAccountView } from "./genex-view.ts";
import {
  clock,
  GenexSetup,
  genexSetup,
  heldApps,
  justPublished,
  LinkTarget,
  offeredTitle,
  PublishGate,
  PublishStage,
  type PublishView,
  publishGate,
  publishReport,
  publishView,
  type StepView,
  type WentLive,
  wentLive,
  withAppsReview,
} from "./genex-publish-view.ts";
import type { GenexReviewApp, GenexReviewRecord, GenexReviewStatus } from "../../../../shared/genex-review.ts";
import { publishesAsWebGame } from "../../../../shared/project-workspace.ts";
import { ReviewCard } from "./ReviewCard.tsx";
import {
  elapsedWords,
  ReviewCardKind,
  type ReviewCardView,
  ReviewPlace,
  ReviewPress,
  reviewCardView,
} from "./review-card-view.ts";
import { useGenexFix, useGenexReview } from "./use-genex-review.ts";
import { drawRocket, ROCKET_FPS, ROCKET_FRAMES, ROCKET_GRID, rocketScene } from "./publish-rocket.ts";
import { useGenexStatus } from "./use-genex-status.ts";
import { CoverControls, CoverMedia, CoverTool } from "./PublishCover.tsx";
import { RemixChoice, RemixRights, remixAllowedNow } from "./PublishRemix.tsx";
import { CoverKind } from "./cover-asks.ts";
import { type PublishCover, useElapsed, usePublishCover } from "./use-publish-cover.ts";
import { Pressing, usePublishRecord } from "./use-publish-record.ts";
import { PublishPlatforms, usePublishPlatforms } from "./PublishPlatforms.tsx";
import { EngineCardRows, PublishCardPress } from "./PublishCard.tsx";
import { usePublishCard } from "./use-publish-card.ts";
import {
  appsLabel,
  appsInReview,
  appsTurnedDown,
  appsUpToDate,
  gateByPlugin,
  makesApps,
  nothingToPublish,
  onlyApps,
  replacesAppsPage,
} from "./publish-platforms-view.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { Skeleton } from "../../../ui/Skeleton.tsx";

const WORDS = GENEX_WORDS.publish;
const ACCOUNT = GENEX_WORDS.account;
/** The celebration's canvas: 4 px a cell, drawn at half that on screen for sharp pixels. */
const ROCKET_CANVAS_PX = 128;
/** How long the link's pencil shows a ✓ once the link moved. */
const LINK_SAVED_MS = 1.5 * SECOND_MS;
/** The longest edge the banner's picture is read at: twice the dialog's width, for sharp pixels. */
const BANNER_PICTURE_PX = 960;

/** A cancelled review or approval is the person's choice, not an error to show. */
const CANCELLED = /Cancelled/;
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The running attempt's steps as one bar with their names; amber while it takes longer than usual. */
function Progress({ view }: { view: PublishView }): JSX.Element {
  const slow = view.slow || view.check?.slow === true;
  return (
    <div className="genex-publish-progress" data-slow={slow || undefined}>
      <StepBar
        steps={view.steps.map((step: StepView) => ({ key: step.step, label: step.label, state: step.state }))}
        label={WORDS.progress}
        valueText={view.phase}
      />
      {view.check && !view.check.person && <CheckRow since={view.check.since} slow={view.check.slow} />}
    </div>
  );
}

/** Genex's check of the apps under the steps: its clock from when they were sent, and what it is. */
function CheckRow({ since, slow }: { since: string; slow: boolean }): JSX.Element {
  useElapsed(since);
  return (
    <div className="genex-publish-check" data-genex-publish-check data-slow={slow || undefined}>
      <p className="genex-publish-check-row" role="status">
        <StatusOrb />
        <span>{REVIEW_WORDS.dialog.checking(elapsedWords(since, Date.now()))}</span>
      </p>
      <p className="genex-publish-hint">{slow ? REVIEW_WORDS.dialog.slow : REVIEW_WORDS.dialog.checkingLine}</p>
    </div>
  );
}

/** The celebration's canvas: plays once as it mounts and again on a press; still under reduced motion. */
function PublishRocket(): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [run, setRun] = useState(0);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!canvas.current || !ctx) return;
    const cell = canvas.current.width / ROCKET_GRID;
    const color = getComputedStyle(canvas.current).color;
    const scene = rocketScene();
    if (prefersReducedMotion()) {
      drawRocket(ctx, cell, 1, scene, color);
      return;
    }
    let frameId = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const frame = Math.min(ROCKET_FRAMES - 1, Math.floor((now - start) / (SECOND_MS / ROCKET_FPS)));
      drawRocket(ctx, cell, frame / (ROCKET_FRAMES - 1), scene, color);
      if (frame < ROCKET_FRAMES - 1) frameId = requestAnimationFrame(loop);
    };
    loop(start);
    return () => cancelAnimationFrame(frameId);
  }, [run]);
  return (
    <button type="button" className="genex-publish-rocket" aria-label={WORDS.replay} onClick={() => setRun(run + 1)}>
      <canvas ref={canvas} width={ROCKET_CANVAS_PX} height={ROCKET_CANVAS_PX} aria-hidden />
    </button>
  );
}

/** The game's kept Genex cover shot for the banner: null until read, or when it has none. */
function useBannerShot(project: string, again: unknown): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useAsyncEffect(
    (alive) => {
      void readGenexShot(project, BANNER_PICTURE_PX).then((read) => {
        if (alive()) setSrc(read);
      });
      return undefined;
    },
    [project, again],
  );
  return src;
}

/** The banner's line: the name, and the one moment it went live, the sentence "<name> is live!" around it. */
function BannerLine({ name, live }: { name: JSX.Element; live: boolean }): JSX.Element {
  return (
    <span className="genex-publish-banner-line">
      {live
        ? richText(WORDS.isLive, {
            name: () => name,
            live: (words) => <span className="genex-publish-banner-live">{words}</span>,
          })
        : name}
    </span>
  );
}

/**
 * The name on the banner: a press to rename it, its field while renaming, plain words while publishing.
 * Enter or leaving the field saves the name; Escape puts the saved one back.
 */
function BannerName({
  title,
  onTitle,
  onDone,
  editable,
  live,
}: {
  title: string;
  onTitle: (title: string) => void;
  /** The field closed: `save` when Enter or leaving it, not after Escape. */
  onDone: (save: boolean) => void;
  editable: boolean;
  /** It just went live: the banner says "<name> is live!". */
  live: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  // Enter closes the field, which can blur it as it goes: the name is saved once.
  const open = useRef(false);
  const start = () => {
    open.current = true;
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (!open.current) return;
    open.current = false;
    setEditing(false);
    onDone(save);
  };
  if (!editable)
    return (
      <BannerLine
        live={live}
        name={
          <span className="genex-publish-banner-name" title={title}>
            <span>{title}</span>
          </span>
        }
      />
    );
  if (editing)
    return (
      <input
        className="genex-publish-banner-input"
        aria-label={WORDS.name}
        value={title}
        maxLength={GENEX_TITLE_MAX_CHARS}
        spellCheck={false}
        // biome-ignore lint/a11y/noAutofocus: the field replaces the name the person just pressed.
        autoFocus
        onChange={(e) => onTitle(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") {
            // Escape puts the name back; it does not close the dialog around it.
            e.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  return (
    <BannerLine
      live={live}
      name={
        <button
          type="button"
          className="genex-publish-banner-name"
          title={title}
          aria-label={WORDS.rename}
          onClick={start}
        >
          <span>{title}</span>
          <Icon name="rename" size={14} />
        </button>
      }
    />
  );
}

/**
 * The game's banner across the dialog's top: its Genex cover (else its sphere's picture, blurred),
 * where it is on Genex in the corner, its name at the foot, and the rocket once it just went live.
 */
function Banner({
  project,
  title,
  onTitle,
  onTitleDone,
  view,
  publishing,
  celebrate,
  cover,
  shotKey,
  clipKey,
  onAsked,
}: {
  project: string;
  title: string;
  onTitle: (title: string) => void;
  /** The name's field closed: save the typed name, or put the saved one back. */
  onTitleDone: (save: boolean) => void;
  view: PublishView;
  publishing: boolean;
  celebrate: boolean;
  cover: PublishCover;
  /** The kept shot's hash: a new one is read again. */
  shotKey: string | null;
  /** The kept clip's hash, or null while the game has none. */
  clipKey: string | null;
  /** Another cover went to the chat: the dialog closes there. */
  onAsked: () => void;
}): JSX.Element {
  const game = useLibrary((s) => s.games.find((g) => g.name === project));
  const shot = useBannerShot(project, `${view.outcome}:${shotKey ?? ""}`);
  const fallback = useMemo(() => gameCoverUrl(game?.cover, project), [game?.cover, project]);
  const [asking, setAsking] = useState(false);
  const [chosen, setShow] = useState<CoverKind>(CoverKind.Clip);
  const show = clipKey ? chosen : CoverKind.Picture;
  const quiet = publishing || celebrate;
  return (
    <div className="genex-publish-banner" data-shot={shot ? true : undefined} data-asking={asking || undefined}>
      <img src={shot ?? fallback} alt="" aria-hidden draggable={false} />
      <CoverMedia project={project} cover={cover} show={show} clipKey={clipKey} />
      <span className="genex-publish-banner-shade" aria-hidden />
      {view.chip && !publishing && (
        <span className="genex-publish-chip" data-tone={view.chip.tone}>
          {view.chip.text}
        </span>
      )}
      {!quiet && (
        <CoverControls cover={cover} show={show} onShow={setShow} hasClip={Boolean(clipKey)} asking={asking} />
      )}
      {celebrate && <PublishRocket />}
      <div className="genex-publish-banner-foot">
        {!asking && (
          <BannerName title={title} onTitle={onTitle} onDone={onTitleDone} editable={!publishing} live={celebrate} />
        )}
        <CoverTool
          cover={cover}
          show={show}
          disabled={publishing || !view.canAskCover}
          asking={asking}
          onAsking={setAsking}
          onAsked={onAsked}
        />
      </div>
    </div>
  );
}

/** How the public link's pencil changes it: the changes left (null: no limit) and the move itself. */
interface LinkChange {
  left: number | null | undefined;
  /** Move the game to `link`: why Genex refused, or null once it moved. */
  save: (link: string) => Promise<string | null>;
}

/**
 * The link anyone can play, labelled beside the globe, with Copy and Open. Open stays in the app for
 * a game Play can show (`inApp`: its page in Play, and no arrow out); any other goes to the browser.
 * With `change`, the link and its pencil are one press that opens its field, like the name's on the
 * banner; the pencil turns into a ✓ for a moment once the link moved. A game out of link changes
 * shows no pencil.
 */
function LinkField({
  link,
  onOpen,
  opening,
  inApp,
  change,
}: {
  link: string;
  onOpen: () => void;
  opening: boolean;
  inApp: boolean;
  change?: LinkChange;
}): JSX.Element {
  const [copied, copy] = useCopy();
  const [editing, setEditing] = useState(false);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (!moved) return;
    const timer = window.setTimeout(() => setMoved(false), LINK_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [moved]);
  if (editing && change)
    return (
      <LinkEditor
        link={link}
        change={change}
        onDone={(done) => {
          setEditing(false);
          setMoved(done);
        }}
      />
    );
  const shown = link.replace(/^https?:\/\//, "");
  const changeable = change !== undefined && change.left !== 0;
  return (
    <div className="genex-publish-link-field" data-public>
      {changeable ? (
        <span className="genex-publish-link-address">
          <button
            type="button"
            className="genex-publish-link-edit"
            title={link}
            aria-label={WORDS.changeLink}
            onClick={() => setEditing(true)}
          >
            <Icon name="link" size={14} className="genex-publish-link-mark" />
            <span>{shown}</span>
            <Icon name={moved ? "check" : "rename"} size={14} />
          </button>
        </span>
      ) : (
        <span className="genex-publish-link-plain" title={link}>
          <Icon name="link" size={14} className="genex-publish-link-mark" />
          <span>{shown}</span>
        </span>
      )}
      <Button aria-label={WORDS.copyLinkLabel} onClick={() => copy(link)}>
        <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "text-green" : undefined} />
        {copied ? WORDS.copied : WORDS.copyLink}
      </Button>
      <Button aria-label={WORDS.openGameLabel} busy={opening} data-genex-publish-open onClick={onOpen}>
        {WORDS.openGame}
        <Icon name={inApp ? "chevron-right" : "arrow-up-right"} size={14} />
      </Button>
    </div>
  );
}

/**
 * The public link's field: the site fixed before it, the game's part typed as Genex spells links,
 * Save inside it once it differs, and one line under it, the old link's promise and the changes
 * left, or why Genex refused. Enter saves; Escape, or leaving it unchanged, closes it.
 */
function LinkEditor({
  link,
  change,
  onDone,
}: {
  link: string;
  change: LinkChange;
  onDone: (moved: boolean) => void;
}): JSX.Element {
  const base = link.slice(0, link.lastIndexOf("/") + 1);
  const current = link.slice(base.length);
  const [value, setValue] = useState(current);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = genexSlug(value);
  const changed = slug !== "" && slug !== current;
  const save = async () => {
    if (busy) return;
    if (!changed) return onDone(false);
    setBusy(true);
    const why = await change.save(slug);
    setBusy(false);
    if (why) return setRefused(why);
    onDone(true);
  };
  const left = typeof change.left === "number" ? ` · ${WORDS.changesLeft(change.left)}` : "";
  return (
    <div className="genex-publish-link-change">
      <div className="genex-publish-link-field" data-public data-editing data-refused={refused ? true : undefined}>
        <Icon name="globe" size={15} />
        <label htmlFor="genex-publish-new-link" className="genex-publish-link-base">
          {base.replace(/^https?:\/\//, "")}
        </label>
        <input
          id="genex-publish-new-link"
          className="genex-publish-link-input"
          aria-label={WORDS.newLink}
          value={value}
          maxLength={GENEX_SLUG_MAX_CHARS}
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the field replaces the link the person just pressed.
          autoFocus
          onChange={(e) => {
            setValue(linkTyped(e.target.value));
            setRefused(null);
          }}
          onBlur={() => {
            if (!changed && !busy) onDone(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") {
              // Escape closes the field; it does not close the dialog around it.
              e.stopPropagation();
              onDone(false);
            }
          }}
        />
        {changed && (
          <Button variant="default" aria-label={WORDS.saveLink} busy={busy} onClick={() => void save()}>
            {WORDS.saveLink}
          </Button>
        )}
      </div>
      <p className={refused ? "genex-publish-link-refused" : "genex-publish-hint"} role={refused ? "alert" : undefined}>
        {refused ?? `${WORDS.oldLinkWorks}${left}`}
      </p>
    </div>
  );
}

/** What the link's field shows as it is typed: lower case, a dash for anything a link can't hold. */
const linkTyped = (value: string): string => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/**
 * The tested draft players do not have yet, read-only with Copy, and one line under it: who can play
 * it, and for a multiplayer game how to be a second player alone. Display only: Publish is untouched.
 */
function TestLinkField({
  link,
  listed,
  multiplayer,
}: {
  link: string;
  listed: boolean;
  multiplayer: boolean;
}): JSX.Element {
  const [copied, copy] = useCopy();
  const note = listed ? WORDS.testChanges : WORDS.testBefore;
  return (
    <div className="genex-publish-test">
      <div className="genex-publish-link-field" data-test>
        <span className="genex-publish-link-label">{WORDS.testLink}</span>
        <span title={link}>{link.replace(/^https?:\/\//, "")}</span>
        <Button aria-label={WORDS.copyTestLinkLabel} onClick={() => copy(link)}>
          <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "text-green" : undefined} />
          {copied ? WORDS.copied : WORDS.copyLink}
        </Button>
      </div>
      <p className="genex-publish-hint">{multiplayer ? `${note} ${WORDS.testSecondPlayer}` : note}</p>
    </div>
  );
}

/** A quiet text press inside a line. */
function TextButton({ children, ...props }: { children: ReactNode } & JSX.IntrinsicElements["button"]): JSX.Element {
  return (
    <button type="button" className="genex-publish-text-button" {...props}>
      {children}
    </button>
  );
}

/** Send report: posts the failed attempt and the app's logs to the team, then says it went. */
function SendReport({ report }: { report: () => FeedbackDraft }): JSX.Element {
  const [sent, setSent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.studio.sendFeedback(report());
      setSent(true);
    } catch {
      setSent(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="default"
      aria-label={WORDS.sendReportLabel}
      busy={busy}
      disabled={sent === true}
      data-genex-publish-report={sent === true || undefined}
      onClick={() => void send()}
    >
      {sent === true && <Icon name="check" size={14} className="text-green" />}
      {(sent === true && WORDS.reportSent) || (sent === false && WORDS.reportFailed) || WORDS.sendReport}
    </Button>
  );
}

/**
 * The dialog's frame: one title, the words for where the game is, and, once the record is read,
 * where it is on Genex for smoke checks, whatever the dialog asks for first.
 */
function PublishFrame({
  intro,
  state = null,
  onClose,
  returnFocus,
  heading = { title: WORDS.title, icon: "globe", testId: "genex-publish" },
  children,
}: {
  intro: string;
  state?: GenexPublishState | null;
  onClose: () => void;
  /** Where focus goes as the dialog closes, when not back to the press that opened it. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** The dialog's title, its icon and its smoke-check id: Publish's unless another press opened it. */
  heading?: { title: string; icon: IconName; testId: string };
  children: ReactNode;
}): JSX.Element {
  return (
    <DialogSurface
      title={heading.title}
      titleIcon={<Icon name={heading.icon} size={20} className="text-ink-3" />}
      description={intro}
      onDismiss={onClose}
      size="lg"
      testId={heading.testId}
    >
      <div
        className="genex-publish-body"
        data-genex-publish-status={state ? publishView(state).stage : undefined}
        data-connected={state?.connected}
      >
        {children}
      </div>
    </DialogSurface>
  );
}

/** What a step of setting up asks: a line saying what is missing, and the presses that fix it. */
function Ask({ children, actions }: { children: ReactNode; actions: ReactNode }): JSX.Element {
  return (
    <>
      <div className="genex-publish-ask genex-publish-step">{children}</div>
      <div className="genex-publish-actions">
        <div className="genex-publish-presses">{actions}</div>
      </div>
    </>
  );
}

/**
 * Sign in to Genex from the Publish dialog: Sign in in browser, then finishing in the browser with
 * the code to check, then the terms, until the account is connected and `onConnected` re-reads the
 * record. The sign-in is the app's own, the one the sidebar's plate and Settings start.
 */
function ConnectGenex({
  plugin,
  project,
  onConnected,
}: {
  plugin: PluginInfo;
  project: string | null;
  onConnected: () => void;
}): JSX.Element {
  const live = useGenexStatus(plugin, project);
  const view = genexAccountView(live.status);
  const connected = view.kind === GenexAccountKind.Connected;
  useEffect(() => {
    if (connected) onConnected();
  }, [connected, onConnected]);
  return (
    <>
      <ConnectStep view={view} live={live} />
      {live.error && (
        <p role="alert" className="genex-publish-problem">
          {live.error}
        </p>
      )}
      {live.review && <PluginApproval review={live.review} onClose={live.closeReview} />}
    </>
  );
}

/**
 * Publish with no account: the account card (as Settings draws it), why, and Sign in in browser,
 * which opens genex.games and brings back a Genex that was removed. A saved sign-in that couldn't
 * be opened on this Mac says so.
 */
function SignInToPublish({ retry = false }: { retry?: boolean }): JSX.Element {
  const { busy, signIn } = useGenexSignIn();
  return (
    <div className="genex-publish-sign-in" data-genex-publish-sign-in>
      <MakingArt drawing={MakingDrawing.Account} still={false} offset={0} className="genex-publish-sign-in-art" />
      <p>{retry ? ACCOUNT.retryText : WORDS.signInText}</p>
      <button
        type="button"
        className="people-button genex-publish-sign-in-button"
        data-tone="primary"
        aria-label={ACCOUNT_WORDS.signInLabel}
        aria-busy={busy || undefined}
        disabled={busy}
        data-genex-sign-in
        onClick={signIn}
      >
        {ACCOUNT_WORDS.signIn}
        <Icon name="arrow-up-right" size={14} />
      </button>
    </div>
  );
}

/** While the browser has the sign-in: the code it should show, the page again, Cancel, and the wait. */
function FinishSignIn({ code }: { code: string | null }): JSX.Element {
  return (
    <Ask
      actions={
        <>
          <Button size="default" onClick={() => void cancelGenexSignIn()}>
            {ACCOUNT.cancel}
          </Button>
          <Button variant="default" size="default" busy>
            {ACCOUNT.waitingBrowser}
          </Button>
        </>
      }
    >
      {code && (
        <div className="genex-publish-code">
          <span>{ACCOUNT.browserShows}</span>
          <code>{code}</code>
        </div>
      )}
      <TextButton onClick={() => void signInToGenex()}>
        {ACCOUNT.reopen}
        <Icon name="arrow-up-right" size={12} />
      </TextButton>
    </Ask>
  );
}

/**
 * Publish while no Genex is installed (an older build let the person remove it): sign in, which
 * brings Genex back; its own Publish then takes over the dialog.
 */
export function PublishSignInDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const waiting = usePeople((s) => s.account === GenexAccountStatus.SigningIn);
  const code = usePeople((s) => s.signInCode);
  return (
    <PublishFrame intro={WORDS.intro} onClose={onClose}>
      {waiting ? <FinishSignIn code={code} /> : <SignInToPublish />}
    </PublishFrame>
  );
}

/** The account step the person is on, with only the presses it needs, each showing it is working. */
function ConnectStep({
  view,
  live,
}: {
  view: ReturnType<typeof genexAccountView>;
  live: ReturnType<typeof useGenexStatus>;
}): JSX.Element {
  const busy = live.running !== null;
  switch (view.kind) {
    case GenexAccountKind.SignedOut:
      return <SignInToPublish retry={view.retry} />;
    case GenexAccountKind.SigningIn:
      return <FinishSignIn code={view.code} />;
    case GenexAccountKind.Terms:
      return (
        <Ask
          actions={
            <Button
              variant="default"
              size="default"
              busy={live.running === GenexAction.Terms}
              disabled={busy}
              onClick={() => void live.act(GenexAction.Terms)}
            >
              {ACCOUNT.terms}
              <Icon name="arrow-up-right" size={14} />
            </Button>
          }
        >
          <p>{WORDS.termsNote}</p>
        </Ask>
      );
    case GenexAccountKind.Attention:
      return (
        <Ask
          actions={
            <Button size="default" onClick={() => void live.refresh()}>
              {ACCOUNT.tryAgain}
            </Button>
          }
        >
          <p>{view.error}</p>
        </Ask>
      );
    default:
      return <PublishSkeleton />;
  }
}

/** Publish's shape while the account is checked: the cover, the name field and the button. */
function PublishSkeleton(): JSX.Element {
  return (
    <Pending label={ACCOUNT.checking} className="flex flex-col gap-3.5">
      <Skeleton height={108} radius={12} />
      <Skeleton height={30} radius={8} />
      <Skeleton width={96} height={30} radius={8} className="self-end" />
    </Pending>
  );
}

/** The Genex plugin's name as a link to its page in Plugins; the dialog closes on the way. */
function PluginLink({ onLeave, children }: { onLeave: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      className="genex-publish-plugin"
      aria-label={WORDS.pluginPage}
      onClick={() => {
        onLeave();
        window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin: GENEX_PLUGIN_ID } }));
      }}
    >
      {children}
    </button>
  );
}

const MULTIPLAYER = GENEX_WORDS.multiplayer;

/** What Multiplayer brings, each with its glyph: why the plugin is worth installing. */
const MULTIPLAYER_POINTS: ReadonlyArray<{ icon: IconName; text: string }> = [
  { icon: "globe", text: MULTIPLAYER.rooms },
  { icon: "mic", text: MULTIPLAYER.voice },
  { icon: "coin", text: MULTIPLAYER.economy },
];

/** Multiplayer's dialog frame: its own title and glyph. */
const MULTIPLAYER_HEADING = { title: MULTIPLAYER.title, icon: "users", testId: "genex-multiplayer" } as const;

/**
 * Multiplayer while the Genex plugin is off or not installed, laid out as Publish's sign-in: a room
 * drawn as the account card's sibling, what Genex brings in one row, one line saying why it needs
 * the plugin (its name opens the plugin's page), and the one press that brings it back, busy while
 * it works. Publish never asks this: it is the account's, and the plugin may be off.
 */
export function GenexSetupDialog({
  genex,
  onClose,
}: {
  genex: PluginInfo | undefined;
  onClose: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const install = genexSetup(genex) === GenexSetup.Install;
  const press = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      if (install) await window.studio.pluginInstall(GENEX_PLUGIN_ID);
      else await window.studio.pluginEnable(GENEX_PLUGIN_ID, true);
    } catch (e) {
      if (!CANCELLED.test(words(e))) setError(problemWords(e));
    } finally {
      setBusy(false);
    }
  };
  const label = install ? WORDS.install : WORDS.turnOn;
  const working = install ? WORDS.installing : WORDS.turningOn;
  return (
    <PublishFrame intro={MULTIPLAYER.intro} onClose={onClose} heading={MULTIPLAYER_HEADING}>
      <div className="genex-publish-sign-in" data-genex-multiplayer-setup>
        <MakingArt drawing={MakingDrawing.Multiplayer} still={false} offset={0} className="genex-publish-sign-in-art" />
        <ul className="genex-setup-points">
          {MULTIPLAYER_POINTS.map((point) => (
            <li key={point.text}>
              <Icon name={point.icon} size={15} />
              <span>{point.text}</span>
            </li>
          ))}
        </ul>
        <p>
          {richText(install ? MULTIPLAYER.installLine : MULTIPLAYER.turnOnLine, {
            plugin: (name) => <PluginLink onLeave={onClose}>{name}</PluginLink>,
          })}
        </p>
        {error && (
          <p role="alert" className="genex-publish-problem">
            {error}
          </p>
        )}
        <button
          type="button"
          className="people-button genex-publish-sign-in-button"
          data-tone="primary"
          aria-label={label}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => void press()}
        >
          {busy ? working : label}
        </button>
      </div>
    </PublishFrame>
  );
}

/** The dialog over the stage, the Genex plugin on or off. */
export function GenexPublishDialog({
  plugin,
  project,
  onClose,
}: {
  plugin: PluginInfo;
  project: string | null;
  onClose: () => void;
}): JSX.Element {
  const record = usePublishRecord(plugin, project);
  const { state } = record;
  const cover = usePublishCover({ plugin, project: project ?? "", state, refresh: record.refresh });
  if (state && publishGate(plugin, state.connected) === PublishGate.SignIn)
    return (
      <PublishFrame intro={WORDS.intro} state={state} onClose={onClose}>
        <ConnectGenex plugin={plugin} project={project} onConnected={record.refresh} />
      </PublishFrame>
    );
  const view = state ? publishView(state) : null;
  if (!view)
    return (
      <PublishFrame intro={WORDS.intro} state={state} onClose={onClose}>
        {record.readError ? (
          <p role="alert" className="genex-publish-problem">
            {record.readError}
          </p>
        ) : (
          <PublishSkeleton />
        )}
      </PublishFrame>
    );
  return (
    <DialogSurface
      title={WORDS.title}
      description={WORDS.intro}
      onDismiss={onClose}
      size="lg"
      testId="genex-publish"
      headerHidden
      className="genex-publish-dialog"
    >
      <PublishOrRights view={view} record={record} project={project ?? ""} cover={cover} onClose={onClose} />
      {record.review && <PluginApproval review={record.review} onClose={record.closeReview} />}
    </DialogSurface>
  );
}

/** The game folder's platforms, and the main press's words when the game has only apps ("Publish Mac app"). */
function useAppsPublish(
  project: string,
  native: GenexNativeRecord | undefined,
  hostedWeb: boolean | undefined,
  /** The agent builds an app the Publish card asked for: the folder is read again until it lands. */
  watch = false,
): {
  platforms: PublishPlatform[] | null;
  apps: string | null;
  waiting: boolean;
  /** Every app Publish would send is on Genex already: the press has nothing new to do. */
  upToDate: boolean;
  /** Its apps wait for Genex's review: nothing reached players yet. */
  inReview: boolean;
  /** The line above the press says this web build takes the place of the apps' page: the press agrees to it. */
  replacesApps: boolean;
} {
  const read = usePublishPlatforms(project, watch);
  const platforms = read ? gateByPlugin(read, native) : null;
  return {
    platforms,
    apps: platforms && onlyApps(platforms) ? appsLabel(platforms) : null,
    // A game made in an engine with nothing to send yet: the rows say why, and the press waits.
    waiting: platforms !== null && nothingToPublish(platforms),
    upToDate: platforms !== null && appsUpToDate(platforms, native),
    inReview: platforms !== null && appsInReview(platforms, native),
    replacesApps: platforms !== null && replacesAppsPage(platforms, native, hostedWeb),
  };
}

/**
 * The cards of an app Genex turned down whose Fix with agent takes the dialog's press's place while
 * the very build it turned down is what Publish would send: the plain turn-downs, and a fix on its way
 * that Studio publishes by itself. A takedown, a fixed web game, a resend a person waits for and an
 * automatic step taken back all keep the press: publishing is their way forward.
 */
const HOLDS_PRESS: ReadonlySet<string> = new Set([
  ReviewCardKind.NotApproved,
  ReviewCardKind.Update,
  ReviewCardKind.Still,
  ReviewCardKind.PersonKept,
  ReviewCardKind.PersonDecided,
  ReviewCardKind.Repeated,
  ReviewCardKind.Requested,
  ReviewCardKind.FixSent,
]);

/** Whether the card takes the press's place: a game with only apps, a plain turn-down, of the very build Publish sends. */
const cardHoldsPress = (card: ReviewCardView | null, sendsTurnedDown: boolean, appsOnly: boolean): boolean =>
  appsOnly && sendsTurnedDown && card !== null && HOLDS_PRESS.has(card.kind);

/** Whether a review card's way forward is publishing again: it offers Publish, or a person waits for the app sent again. */
const publishesNext = (card: ReviewCardView): boolean =>
  card.kind === ReviewCardKind.ResendOwed || card.presses.some((one) => one.press === ReviewPress.Publish);

/** Whether a publish of the game runs now, or its apps are going: Genex's word on them changes once it ends. */
const publishRuns = (state: GenexPublishState | null): boolean => {
  const job: GenexPublishJob | undefined = state?.job;
  const running = job?.state === GenexPublishJobState.Running || job?.state === GenexPublishJobState.Unresolved;
  return running || state?.native?.sending === true;
};

/** A game with apps, as Genex reviews them: the review, the dialog's card, and the record a celebration reads. */
function useAppsReview(
  plain: PublishView,
  project: string,
  state: GenexPublishState | null,
  platforms: PublishPlatform[] | null,
  appsOnly: boolean,
) {
  const native = state?.native;
  const sent = native?.sent ?? [];
  const apps = sent.length > 0 || (platforms?.some((row) => row.uploads && row.target !== PublishTarget.Web) ?? false);
  // Genex is read again once a publish of the apps ends, and while a sent app waits for its word.
  const status: GenexReviewStatus | null = useGenexReview(project, {
    poll: true,
    busy: apps && publishRuns(state),
    held: sent.some((one) => one.review === GenexBuildReview.Pending),
  });
  const { fix, latest } = useGenexFix(project);
  const game = useLibrary((s) => s.games.find((one) => one.name === project));
  const record = status?.record ?? null;
  // Only a game with apps has a review card to word.
  const web = apps && game ? publishesAsWebGame(game) : !appsOnly;
  const card = apps
    ? reviewCardView({ status, fix, latest, title: "", sending: native?.sending, web, place: ReviewPlace.Dialog })
    : null;
  // An admin's apps go live at once: they come back with no review, so the dialog has no Check for them.
  const admin = sent.length > 0 && sent.every((one) => one.review === undefined);
  const input = { apps, appsOnly, admin, record, job: state?.job };
  const sendsTurnedDown = platforms !== null && appsTurnedDown(platforms, native);
  return {
    status,
    view: withAppsReview(plain, input),
    input,
    // The dialog's own press is the card's Publish: the card leaves it out.
    card: state && card ? { ...card, presses: card.presses.filter((one) => one.press !== ReviewPress.Publish) } : null,
    /** The card's way forward is publishing again (a resend a person waits for, a fixed game): the dialog's Publish does it. */
    wantsPublish: Boolean(state && card && publishesNext(card)),
    holdsPress: cardHoldsPress(card, sendsTurnedDown, appsOnly),
    fixId: fix?.fixId,
    record,
  };
}

/**
 * The apps' progress through Genex's check and the review card under the rows; nothing while it
 * celebrates. A running publish's steps are left out when the Publish card's web row says them (`onRow`).
 */
function AppsReview({
  view,
  review,
  project,
  quiet,
  onRow,
}: {
  view: PublishView;
  review: ReturnType<typeof useAppsReview>;
  project: string;
  quiet: boolean;
  onRow: boolean;
}): JSX.Element | null {
  if (quiet) return null;
  return (
    <>
      {((view.running && !onRow) || view.check) && <Progress view={view} />}
      {review.card && !view.running && (
        <ReviewCard
          project={project}
          view={review.card}
          record={review.status?.record ?? null}
          place={ReviewPlace.Dialog}
          fixId={review.fixId}
        />
      )}
    </>
  );
}

/**
 * The foot line of a game with only apps: that Studio tells when Genex's check ends, that players get
 * nothing before Genex checked what the press sends (unless a send came back with no review, an
 * admin's), or, live, that a takedown is heard of.
 */
function appsHint(
  view: PublishView,
  review: ReturnType<typeof useAppsReview>,
  moment: { publishing: boolean; celebrate: boolean; appsOnly: boolean; pressed: boolean },
): string | null {
  if (!review.input.apps) return null;
  if (moment.celebrate) return REVIEW_WORDS.dialog.liveFooter;
  if (!moment.appsOnly) return null;
  if (view.check) return REVIEW_WORDS.dialog.closeHint;
  const beforePress = moment.pressed && !moment.publishing && !review.card;
  return beforePress && !review.input.admin ? REVIEW_WORDS.dialog.hint : null;
}

/** Whether Allow remixing shows under the press: only while there is a publish to press that would carry it. */
const remixLineShown = (pressShown: boolean, publishing: boolean, view: PublishView, waiting: boolean): boolean =>
  pressShown && !publishing && !view.terms && !waiting;

/**
 * Whether the dialog celebrates: an attempt it watched just went live, or an app Genex held when the
 * dialog read it is live now; a new press ends it. A game whose apps Genex still reviews has not
 * reached players, and an app already live when the dialog opened is no news: neither is celebrated.
 * With it, the app that went live, when Genex's check of it ended while the dialog watched.
 */
function useCelebration(
  view: PublishView,
  publishing: boolean,
  inReview: boolean,
  record: GenexReviewRecord | null,
): { celebrate: boolean; went: WentLive | null } {
  const before = useRef<PublishView | null>(null);
  const held = useRef<Map<string, GenexReviewApp>>(new Map());
  const [celebrate, setCelebrate] = useState(false);
  const [went, setWent] = useState<WentLive | null>(null);
  useEffect(() => {
    if (justPublished(before.current, view) && !inReview) setCelebrate(true);
    before.current = view;
  }, [view, inReview]);
  useEffect(() => {
    const live = wentLive(held.current, record);
    if (live) {
      setWent(live);
      setCelebrate(true);
    }
    held.current = heldApps(record);
  }, [record]);
  useEffect(() => {
    if (!publishing) return;
    setCelebrate(false);
    setWent(null);
  }, [publishing]);
  return { celebrate, went };
}

/** The line an update's celebration adds: the version players of that system get now. */
function LiveUpdateLine({ went }: { went: WentLive | null }): JSX.Element | null {
  if (!went?.update) return null;
  return (
    <p className="genex-publish-live-update" data-genex-publish-live-update>
      {REVIEW_WORDS.dialog.liveUpdate(went.app.version, went.app.platform)}
    </p>
  );
}

/** What the dialog shows the publish with: its record, the game, its cover, and the way to close it. */
interface PublishBodyProps {
  view: PublishView;
  record: ReturnType<typeof usePublishRecord>;
  project: string;
  cover: PublishCover;
  onClose: () => void;
}

/**
 * The publish, or the page on what remixers can do while Rights has it open. The person's tick of
 * Allow remixing lives here, so it outlasts a look at that page.
 */
function PublishOrRights(props: PublishBodyProps): JSX.Element {
  const [ticked, setTicked] = useState<boolean | null>(null);
  const [rights, setRights] = useState(false);
  const game = useLibrary((s) => s.games.find((g) => g.name === props.project));
  if (rights)
    return (
      <RemixRights title={offeredTitle(props.record.state, game, props.project)} onBack={() => setRights(false)} />
    );
  const remix = {
    allowed: remixAllowedNow(props.record.state?.remix, ticked),
    onAllowed: setTicked,
    onRights: () => setRights(true),
  };
  return <PublishBody {...props} remix={remix} />;
}

/**
 * The banner's name: the one being typed until it is saved (or put back), then the record's again.
 * Saved, the record names it and so does Studio; refused, the old name returns and the failure line
 * says why.
 */
function useBannerTitle(
  record: ReturnType<typeof usePublishRecord>,
  project: string,
  saved: string,
): { name: string; setTitle: (title: string) => void; onTitleDone: (save: boolean) => void } {
  const [title, setTitle] = useState<string | null>(null);
  const onTitleDone = (save: boolean) => {
    const typed = title?.trim() ?? "";
    if (!save || typed === "" || typed === saved) {
      setTitle(null);
      return;
    }
    void record.rename(typed).then(async (renamed) => {
      // Studio names the game as Genex now does, so the library, the chat and the next Publish agree.
      // The name as Genex took it, cleaned of line breaks and controls, which Studio would refuse.
      if (renamed)
        await studio()
          .saveGame(project, { title: cleanGenexTitle(typed) ?? typed })
          .catch(() => undefined);
      setTitle(null);
    });
  };
  return { name: title ?? saved, setTitle, onTitleDone };
}

/**
 * The game's platforms and, for a game made in an engine, its Publish card: the folder is read again
 * while the agent builds an app the card asked for, so its row sees the build land.
 */
function usePlatformsAndCard(
  project: string,
  record: ReturnType<typeof usePublishRecord>,
  name: string,
  remix: boolean,
) {
  const engine = useLibrary((s) => s.games.find((g) => g.name === project)?.engine);
  const facts = useLibrary((s) => s.games.find((g) => g.name === project)?.facts);
  const [watchFolder, setWatchFolder] = useState(false);
  const apps = useAppsPublish(project, record.state?.native, record.state?.hostedWeb, watchFolder);
  const card = usePublishCard({
    project,
    record,
    platforms: apps.platforms,
    name,
    remix,
    replacesApps: apps.replacesApps,
  });
  useEffect(() => setWatchFolder(card.building), [card.building]);
  return { ...apps, card, engineGame: Boolean(engine) || makesApps(facts ?? []) };
}

/**
 * Which press a game's dialog shows: the Publish card's own for a game made in an engine (while nothing
 * waits for Genex's terms or a review card's fix; a publish under way is on its row, and a
 * celebration leaves the card as it is), else the dialog's Publish, which the card keeps for Genex's
 * terms, a review card whose way forward is publishing again (`republish`) and what they leave
 * running; and whether the card leaves the foot line out (all but a slow publish's way out).
 */
function cardMoment(
  engineGame: boolean,
  moment: { publishing: boolean; view: PublishView; held: boolean; republish: boolean },
): { press: boolean; dialogPress: boolean; quiet: boolean } {
  if (!engineGame) return { press: false, dialogPress: true, quiet: false };
  const { publishing, view, held, republish } = moment;
  const press = !view.terms && !held && !republish;
  const dialogPress = !press && (publishing || view.terms !== null || republish);
  return { press, dialogPress, quiet: !(publishing && view.slow) };
}

/**
 * What stays on screen while the dialog celebrates: a game made in an engine keeps its rows and its
 * button under the banner, since its other platforms go on (`pressShown`), and the celebration's foot
 * line stands only when that button has nothing to say (`footShown`).
 */
function underCelebration(
  engineGame: boolean,
  celebrate: boolean,
  card: Pick<ReturnType<typeof usePublishCard>, "plan" | "bar">,
): { pressShown: boolean; footShown: boolean } {
  const cardPresses = card.plan !== null || card.bar !== null;
  return { pressShown: engineGame || !celebrate, footShown: celebrate && !cardPresses };
}

/** The game's platforms: the Publish card's rows for a game made in an engine, else the list a web game with apps keeps. */
function PlatformsSection({
  engineGame,
  shown,
  project,
  card,
  platforms,
  record,
  replacesApps,
  reviewed,
}: {
  engineGame: boolean;
  shown: boolean;
  project: string;
  card: ReturnType<typeof usePublishCard>;
  platforms: PublishPlatform[] | null;
  record: ReturnType<typeof usePublishRecord>;
  replacesApps: boolean;
  reviewed: boolean;
}): JSX.Element | null {
  if (!engineGame)
    return (
      <PublishPlatforms
        project={project}
        platforms={platforms}
        shown={shown}
        native={record.state?.native}
        onGenex={Boolean(record.state?.slug)}
        hostedWeb={record.state?.hostedWeb}
        onRemoveWeb={() => void record.act(GenexAction.PublishRemoveWeb)}
        reviewed={reviewed}
      />
    );
  if (!shown) return null;
  return (
    <EngineCardRows
      card={card}
      platforms={platforms}
      native={record.state?.native}
      reviewed={reviewed}
      replacesApps={replacesApps}
    />
  );
}

/** The press: the Publish card's own, or the dialog's Publish (`moment`, from {@link cardMoment}). */
function PressSection({
  moment,
  parts,
  shown,
  ...presses
}: {
  moment: ReturnType<typeof cardMoment>;
  parts: ReturnType<typeof usePlatformsAndCard>;
  /** The dialog's Publish has something to do. */
  shown: boolean;
} & Pick<
  Parameters<typeof Presses>[0],
  "view" | "record" | "name" | "remix" | "publishing" | "project"
>): JSX.Element | null {
  const { card } = parts;
  if (moment.press)
    return (
      <PublishCardPress
        plan={card.plan}
        bar={card.bar}
        acting={card.acting}
        onPress={(plan) => void card.press(plan)}
      />
    );
  if (!moment.dialogPress || !shown) return null;
  const apps = parts.apps !== null;
  return (
    <Presses
      {...presses}
      label={parts.apps ?? undefined}
      apps={apps}
      waiting={parts.waiting}
      replacesApps={parts.replacesApps}
    />
  );
}

/**
 * The read record: the banner with the game's name and where it is, then what the moment needs:
 * the platforms a game with an app is built for, the running attempt's progress, the celebration
 * and link once it just went live, the link of a live game, or a failed attempt's line, and the presses.
 * The celebration of a game made in an engine is the banner's alone: its rows and button stay under it.
 */
function PublishBody({
  view: plain,
  record,
  project,
  cover,
  onClose,
  remix,
}: PublishBodyProps & {
  /** Allow remixing: whether this publish sends the game's project, and the presses that change it. */
  remix: { allowed: boolean; onAllowed: (allowed: boolean) => void; onRights: () => void };
}): JSX.Element {
  const game = useLibrary((s) => s.games.find((g) => g.name === project));
  const { name, setTitle, onTitleDone } = useBannerTitle(record, project, offeredTitle(record.state, game, project));
  const parts = usePlatformsAndCard(project, record, name, remix.allowed);
  const { platforms, apps, upToDate, inReview, replacesApps, card, engineGame } = parts;
  const review = useAppsReview(plain, project, record.state, platforms, apps !== null);
  const view = review.view;
  const publishing = record.pressing === Pressing.Publish || view.running;
  const { celebrate, went } = useCelebration(view, publishing, inReview, review.record);
  const failure = record.error ? { text: record.error, details: record.error } : view.failure;
  const { pressShown, footShown } = underCelebration(engineGame, celebrate, card);
  const playSlug = playPageSlug(usePlayWeb(), view.link);
  const pressNeeded = pressHasWork(pressShown, view, publishing, { upToDate, inReview }) && !review.holdsPress;
  const card$ = cardMoment(engineGame, {
    publishing,
    view,
    held: review.holdsPress,
    republish: review.wantsPublish,
  });
  return (
    <div
      className="genex-publish-body"
      data-genex-publish-status={view.stage}
      data-connected={record.state?.connected}
      data-celebrating={celebrate || undefined}
    >
      <Banner
        project={project}
        title={name}
        onTitle={setTitle}
        onTitleDone={onTitleDone}
        view={view}
        publishing={publishing}
        celebrate={celebrate}
        cover={cover}
        shotKey={record.state?.cover?.shot?.sha256 ?? null}
        clipKey={record.state?.cover?.clip?.sha256 ?? null}
        onAsked={onClose}
      />
      <div className="genex-publish-content">
        {view.problems.map((problem) => (
          <p key={problem} role="alert" className="genex-publish-problem">
            {problem}
          </p>
        ))}
        <PlatformsSection
          engineGame={engineGame}
          shown={pressShown}
          project={project}
          card={card}
          platforms={platforms}
          record={record}
          replacesApps={replacesApps}
          reviewed={review.card !== null || view.check !== null}
        />
        <AppsReview view={view} review={review} project={project} quiet={celebrate} onRow={card$.press} />
        {celebrate && <LiveUpdateLine went={went} />}
        {failure && !publishing && <p className="genex-publish-failure">{failure.text}</p>}
        <WhoPlays
          project={project}
          shown={pressShown && saysWhoPlays(view, publishing, Boolean(cover.making), Boolean(view.testLink))}
        />
        {!publishing && <Links view={view} project={project} {...linksOf(record, playSlug, onClose)} />}
        <PressSection
          moment={card$}
          parts={parts}
          shown={pressNeeded}
          view={view}
          record={record}
          name={name}
          remix={remix.allowed}
          publishing={publishing}
          project={project}
        />
        {remixLineShown(pressShown, publishing, view, card$.press ? card.plan === null : parts.waiting) && (
          <RemixChoice
            record={record.state?.remix}
            allowed={remix.allowed}
            onAllowed={remix.onAllowed}
            onRights={remix.onRights}
          />
        )}
        <Hint
          view={view}
          publishing={publishing}
          making={Boolean(cover.making)}
          taking={Boolean(cover.taking)}
          record={record}
          name={name}
          appsLine={appsHint(view, review, { publishing, celebrate, appsOnly: apps !== null, pressed: pressNeeded })}
          quiet={card$.quiet && !footShown}
        />
      </div>
    </div>
  );
}

/**
 * Whether the press shows and has anything to do: not on a live game whose apps are all on Genex already,
 * where its link takes the press's place. A new name never needs it: the name saves itself.
 */
const pressHasWork = (
  shown: boolean,
  view: PublishView,
  publishing: boolean,
  { upToDate, inReview }: { upToDate: boolean; inReview: boolean },
): boolean => shown && (!upToDate || !settled(view, publishing, inReview));

/**
 * Whether what went is where it stays for now: live, or with Genex for review, with nothing going on
 * (no publish runs, nothing failed, no terms to accept). Sending the same apps again changes nothing.
 */
const settled = (view: PublishView, publishing: boolean, inReview: boolean): boolean =>
  (view.stage === PublishStage.Public || inReview) && !publishing && !view.failure && !view.terms;

/**
 * The public link's Open and its pencil, from the record: what `Links` takes besides the view. Open
 * closes the dialog onto the game's page in Play for a game Play can show (`playSlug`); a game on
 * another Genex goes to the browser, through the plugin's checked link.
 */
const linksOf = (record: ReturnType<typeof usePublishRecord>, playSlug: string | null, onClose: () => void) => ({
  onOpen: () => {
    if (playSlug === null) {
      void record.act(GenexAction.PublishOpen, { target: LinkTarget.Gallery });
      return;
    }
    onClose();
    openPlayGame(playSlug);
  },
  opening: record.pressing === Pressing.Action,
  inApp: playSlug !== null,
  change: { left: record.state?.renamesLeft, save: record.changeLink },
});

/** The public link, then the tested draft players do not have yet: shown together, right above the press. */
function Links({
  view,
  project,
  onOpen,
  opening,
  inApp,
  change,
}: {
  view: PublishView;
  project: string;
  onOpen: () => void;
  opening: boolean;
  /** Open shows the game's page in Play, inside the app. */
  inApp: boolean;
  /** The public link's pencil, for a game on Genex while nothing runs. */
  change?: LinkChange;
}): JSX.Element {
  const multiplayer = useLibrary((s) => s.games.find((g) => g.name === project)?.multiplayer === true);
  return (
    <>
      {view.link && <LinkField link={view.link} onOpen={onOpen} opening={opening} inApp={inApp} change={change} />}
      {view.testLink && (
        <TestLinkField link={view.testLink} listed={view.stage === PublishStage.Public} multiplayer={multiplayer} />
      )}
    </>
  );
}

/** Whether the dialog says nothing of who can play it: a publish runs, a cover is on its way, it is live, it failed, or the test link speaks. */
const saysWhoPlays = (view: PublishView, publishing: boolean, making: boolean, testShown: boolean): boolean =>
  !publishing && !making && view.stage !== PublishStage.Public && !view.failure && !testShown;

/**
 * Who can play it, one centred line above the press, for a web game: a game made in an engine says
 * it under its platform rows instead, so the dialog never has two.
 */
function WhoPlays({ project, shown }: { project: string; shown: boolean }): JSX.Element | null {
  const facts = useLibrary((s) => s.games.find((g) => g.name === project)?.facts);
  const engine = useLibrary((s) => Boolean(s.games.find((g) => g.name === project)?.engine));
  if (!shown || engine || makesApps(facts ?? [])) return null;
  return <p className="genex-publish-hint">{WORDS.intro}</p>;
}

/** The quiet line at the foot: that closing does not stop it, the way out of a slow test, that a cover is coming, or that there is none. */
function Hint({
  view,
  publishing,
  making,
  taking,
  record,
  name,
  appsLine,
  quiet = false,
}: {
  view: PublishView;
  publishing: boolean;
  /** Another cover is on its way: the line says where it shows. */
  making: boolean;
  /** Studio is taking the first cover now: whether the game has one is not known yet. */
  taking: boolean;
  record: ReturnType<typeof usePublishRecord>;
  name: string;
  /** A game with apps: what Genex does with them, in place of the line a web game gets. */
  appsLine?: string | null;
  /** The Publish card of a game made in an engine says what it needs on its rows and button: no line. */
  quiet?: boolean;
}): JSX.Element | null {
  const again = view.again;
  if (quiet) return null;
  if (appsLine) return <p className="genex-publish-hint">{appsLine}</p>;
  if (publishing && view.slow)
    return (
      <p className="genex-publish-hint">
        {WORDS.slow}{" "}
        {again && (
          <TextButton aria-label={again.ariaLabel} onClick={() => void record.publishAgain(again, name)}>
            {again.label}
          </TextButton>
        )}
      </p>
    );
  // A send that says how far it is reads better than the standing line: it shows the wait is moving.
  if (publishing && view.progress)
    return (
      <p className="genex-publish-hint" data-publish-progress>
        <SendProgress progress={view.progress} />
      </p>
    );
  if (publishing) return <p className="genex-publish-hint">{WORDS.keepsGoing}</p>;
  if (making) return <p className="genex-publish-hint">{WORDS.coverMakingSoon}</p>;
  if (view.withoutCover && !taking) return <p className="genex-publish-hint">{WORDS.withoutCover}</p>;
  return null;
}

/** The busy button's words: the step at work and the attempt's clock. */
function BusyLabel({ view }: { view: PublishView }): JSX.Element {
  const elapsed = useElapsed(view.startedAt);
  return (
    <>
      {view.phase || WORDS.publishing}
      {elapsed !== null && <span className="genex-publish-clock">· {clock(elapsed)}</span>}
    </>
  );
}

/**
 * The presses: one main button (Publish, Publish update, Try again; while it publishes, the step
 * and its clock), Review Genex terms while they wait, and Send report beside Try again.
 */
function Presses({
  view,
  record,
  name,
  publishing,
  project,
  label,
  apps = false,
  waiting = false,
  remix,
  replacesApps = false,
}: {
  view: PublishView;
  record: ReturnType<typeof usePublishRecord>;
  name: string;
  publishing: boolean;
  project: string;
  /** Whether the press sends the game's project too, so others can remix it (Allow remixing). */
  remix: boolean;
  /** The main press's words in place of the view's (a game with only apps names them). */
  label?: string;
  /** The game has only apps: the press publishes them instead of a web build. */
  apps?: boolean;
  /** Nothing to send yet (a game made in an engine with no app it can send): the press waits. */
  waiting?: boolean;
  /** The dialog said this web build replaces a page that shows only the game's apps (`replacesAppsPage`). */
  replacesApps?: boolean;
}): JSX.Element {
  if (view.terms) {
    const terms = view.terms;
    return (
      <Button
        variant="default"
        size="default"
        className="genex-publish-primary"
        aria-label={terms.ariaLabel}
        busy={record.pressing === Pressing.Action}
        onClick={() => void record.act(terms.action)}
      >
        {terms.label}
        <Icon name="arrow-up-right" size={14} />
      </Button>
    );
  }
  const publish = (
    <Button
      variant={publishing ? "secondary" : "default"}
      size="default"
      className="genex-publish-primary"
      aria-label={apps && label ? label : view.primary.ariaLabel}
      aria-busy={publishing || undefined}
      disabled={publishing || waiting || !view.canPublish || record.pressing !== Pressing.None}
      onClick={() => void (apps ? record.publishApps(name, remix) : record.publish(name, remix, replacesApps))}
    >
      {publishing ? <BusyLabel view={view} /> : (label ?? view.primary.label)}
    </Button>
  );
  if (!view.failure || publishing) return publish;
  return (
    <div className="genex-publish-pair">
      <SendReport report={() => publishReport(project, name, view)} />
      {publish}
    </div>
  );
}

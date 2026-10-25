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
  GENEX_PLUGIN_ID,
  GENEX_TITLE_MAX_CHARS,
  GenexAction,
  type GenexNativeRecord,
  type GenexPublishState,
} from "../../../../shared/genex.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { GenexAccountStatus } from "../../../../shared/genex-account.ts";
import { MakingDrawing } from "../../../making-art.ts";
import { prefersReducedMotion } from "../../../ui/media-queries.ts";
import { cancelGenexSignIn, signInToGenex, useGenexSignIn } from "../../../play/use-genex-sign-in.ts";
import { useLibrary, usePeople } from "../../../state/hooks.ts";
import { Button } from "../../../ui/Button.tsx";
import { OPEN_PLUGINS_EVENT } from "../../../ui/ComposerAddMenu.tsx";
import { DialogSurface } from "../../../ui/dialog.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { Pending } from "../../../ui/Pending.tsx";
import { StepBar } from "../../../ui/StepBar.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { useCopy } from "../../../use-copy.ts";
import { richText } from "../../../rich-text.tsx";
import { ACCOUNT_WORDS, GENEX_WORDS, problemWords } from "../../../words.ts";
import { MakingArt } from "../../MakingArt.tsx";
import { PluginApproval } from "../../PluginApproval.tsx";
import { readGenexShot } from "./genex-cover-shot.ts";
import { GenexAccountKind, genexAccountView } from "./genex-view.ts";
import {
  clock,
  GenexSetup,
  genexSetup,
  justPublished,
  offeredTitle,
  PublishGate,
  PublishStage,
  type PublishView,
  publishGate,
  publishReport,
  publishView,
  type StepView,
} from "./genex-publish-view.ts";
import { drawRocket, ROCKET_FPS, ROCKET_FRAMES, ROCKET_GRID, rocketScene } from "./publish-rocket.ts";
import { useGenexStatus } from "./use-genex-status.ts";
import { CoverControls, CoverMedia, CoverTool } from "./PublishCover.tsx";
import { RemixChoice, RemixRights, remixAllowedNow } from "./PublishRemix.tsx";
import { CoverKind } from "./cover-asks.ts";
import { type PublishCover, useElapsed, usePublishCover } from "./use-publish-cover.ts";
import { Pressing, usePublishRecord } from "./use-publish-record.ts";
import { PublishPlatforms, usePublishPlatforms } from "./PublishPlatforms.tsx";
import {
  appsLabel,
  appsInReview,
  appsUpToDate,
  gateByPlugin,
  makesApps,
  nothingToPublish,
  onlyApps,
} from "./publish-platforms-view.ts";
import type { PublishPlatform } from "../../../../shared/publish-platforms.ts";
import { PublishShareLine } from "./PublishShare.tsx";
import { useShareWhenLive } from "./use-publish-share.ts";
import { Skeleton } from "../../../ui/Skeleton.tsx";

const WORDS = GENEX_WORDS.publish;
const ACCOUNT = GENEX_WORDS.account;
/** Where the publish-open action sends the browser (the plugin's `PublishLinkTarget`). */
const LinkTarget = { Gallery: "gallery" } as const;
/** The celebration's canvas: 4 px a cell, drawn at half that on screen for sharp pixels. */
const ROCKET_CANVAS_PX = 128;
/** The longest edge the banner's picture is read at: twice the dialog's width, for sharp pixels. */
const BANNER_PICTURE_PX = 960;

/** A cancelled review or approval is the person's choice, not an error to show. */
const CANCELLED = /Cancelled/;
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The running attempt's steps as one bar with their names; amber while it takes longer than usual. */
function Progress({ view }: { view: PublishView }): JSX.Element {
  return (
    <div className="genex-publish-progress" data-slow={view.slow || undefined}>
      <StepBar
        steps={view.steps.map((step: StepView) => ({ key: step.step, label: step.label, state: step.state }))}
        label={WORDS.progress}
        valueText={view.phase}
      />
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

/** The name on the banner: a press to rename it, its field while renaming, plain words while publishing. */
function BannerName({
  title,
  onTitle,
  editable,
  live,
}: {
  title: string;
  onTitle: (title: string) => void;
  editable: boolean;
  /** It just went live: the banner says "<name> is live!". */
  live: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
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
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") setEditing(false);
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
          onClick={() => setEditing(true)}
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
        {!asking && <BannerName title={title} onTitle={onTitle} editable={!publishing} live={celebrate} />}
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

/** The link anyone can play, labelled beside the globe, with Copy and Open. */
function LinkField({ link, onOpen, opening }: { link: string; onOpen: () => void; opening: boolean }): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <div className="genex-publish-link-field" data-public>
      <Icon name="globe" size={15} />
      <span className="genex-publish-link-label">{WORDS.publicLink}</span>
      <span title={link}>{link.replace(/^https?:\/\//, "")}</span>
      <Button aria-label={WORDS.copyLinkLabel} onClick={() => copy(link)}>
        <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "text-green" : undefined} />
        {copied ? WORDS.copied : WORDS.copyLink}
      </Button>
      <Button aria-label={WORDS.openGameLabel} busy={opening} onClick={onOpen}>
        {WORDS.openGame}
        <Icon name="arrow-up-right" size={14} />
      </Button>
    </div>
  );
}

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
): {
  platforms: PublishPlatform[] | null;
  behind: boolean;
  apps: string | null;
  waiting: boolean;
  /** Every app Publish would send is on Genex already: the press has nothing new to do. */
  upToDate: boolean;
  /** Its apps wait for Genex's review: nothing reached players yet. */
  inReview: boolean;
} {
  const read = usePublishPlatforms(project);
  // An app goes only through a Genex plugin that can send it: an older one is updated first.
  const { platforms, behind } = read ? gateByPlugin(read, native) : { platforms: null, behind: false };
  return {
    platforms,
    behind,
    apps: platforms && onlyApps(platforms) ? appsLabel(platforms) : null,
    // A game made in an engine with nothing to send yet: the rows say why, and the press waits.
    waiting: platforms !== null && nothingToPublish(platforms),
    upToDate: platforms !== null && appsUpToDate(platforms, native),
    inReview: platforms !== null && appsInReview(platforms, native),
  };
}

/** Whether Allow remixing shows under the press: only while there is a publish to press that would carry it. */
const remixLineShown = (pressShown: boolean, publishing: boolean, view: PublishView, waiting: boolean): boolean =>
  pressShown && !publishing && !view.terms && !waiting;

/** The main press's own words: Save name while it celebrates, a game's apps, else the view's. */
const pressLabel = (celebrate: boolean, apps: string | null): string | undefined =>
  celebrate ? WORDS.saveName : (apps ?? undefined);

/**
 * Whether the dialog celebrates: an attempt it watched just went live; a new press ends it. A game
 * whose apps Genex still reviews has not reached players, so it is not celebrated.
 */
function useCelebration(view: PublishView, publishing: boolean, inReview: boolean): boolean {
  const before = useRef<PublishView | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (justPublished(before.current, view) && !inReview) setCelebrate(true);
    before.current = view;
  }, [view, inReview]);
  useEffect(() => {
    if (publishing) setCelebrate(false);
  }, [publishing]);
  return celebrate;
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
  const gameTitle = useLibrary((s) => s.games.find((g) => g.name === props.project)?.title);
  if (rights)
    return (
      <RemixRights title={offeredTitle(props.record.state, gameTitle, props.project)} onBack={() => setRights(false)} />
    );
  const remix = {
    allowed: remixAllowedNow(props.record.state?.remix, ticked),
    onAllowed: setTicked,
    onRights: () => setRights(true),
  };
  return <PublishBody {...props} remix={remix} />;
}

/**
 * The read record: the banner with the game's name and where it is, then what the moment needs:
 * the platforms a game with an app is built for, the running attempt's progress, the celebration
 * and link once it just went live, the link of a live game, or a failed attempt's line, and the presses.
 */
function PublishBody({
  view,
  record,
  project,
  cover,
  onClose,
  remix,
}: PublishBodyProps & {
  /** Allow remixing: whether this publish sends the game's project, and the presses that change it. */
  remix: { allowed: boolean; onAllowed: (allowed: boolean) => void; onRights: () => void };
}): JSX.Element {
  const gameTitle = useLibrary((s) => s.games.find((g) => g.name === project)?.title);
  const [title, setTitle] = useState<string | null>(null);
  const name = title ?? offeredTitle(record.state, gameTitle, project);
  const publishing = record.pressing === Pressing.Publish || view.running;
  const { platforms, behind, apps, waiting, upToDate, inReview } = useAppsPublish(project, record.state?.native);
  const celebrate = useCelebration(view, publishing, inReview);
  const share = useShareWhenLive(project, celebrate);
  // A name changed after it went live is listed again by Publish update ("Save name" while celebrating).
  const renamed = title !== null && title.trim() !== (record.state?.title ?? "") && view.stage === PublishStage.Public;
  const failure = record.error ? { text: record.error, details: record.error } : view.failure;
  const open = () => void record.act(GenexAction.PublishOpen, { target: LinkTarget.Gallery });
  const opening = record.pressing === Pressing.Action;
  const pressShown = !celebrate || renamed;
  const pressNeeded = pressHasWork(pressShown, view, publishing, { upToDate, renamed, inReview });
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
        <PublishPlatforms
          project={project}
          platforms={platforms}
          behind={behind}
          shown={!celebrate}
          native={record.state?.native}
        />
        {view.running && <Progress view={view} />}
        {failure && !publishing && <p className="genex-publish-failure">{failure.text}</p>}
        <PublishShareLine share={share} celebrate={celebrate} />
        <WhoPlays
          project={project}
          shown={pressShown && saysWhoPlays(view, publishing, Boolean(cover.making), Boolean(view.testLink))}
        />
        {!publishing && <Links view={view} project={project} onOpen={open} opening={opening} />}
        {pressNeeded && (
          <Presses
            view={view}
            record={record}
            name={name}
            publishing={publishing}
            project={project}
            label={pressLabel(celebrate, apps)}
            apps={apps !== null}
            waiting={waiting}
            remix={remix.allowed}
          />
        )}
        {remixLineShown(pressShown, publishing, view, waiting) && (
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
        />
      </div>
    </div>
  );
}

/**
 * Whether the press shows and has anything to do: not on a live game whose apps are all on Genex already,
 * where its link takes the press's place, unless a new name waits to be saved.
 */
const pressHasWork = (
  shown: boolean,
  view: PublishView,
  publishing: boolean,
  { upToDate, renamed, inReview }: { upToDate: boolean; renamed: boolean; inReview: boolean },
): boolean => shown && (renamed || !upToDate || !settled(view, publishing, inReview));

/**
 * Whether what went is where it stays for now: live, or with Genex for review, with nothing going on
 * (no publish runs, nothing failed, no terms to accept). Sending the same apps again changes nothing.
 */
const settled = (view: PublishView, publishing: boolean, inReview: boolean): boolean =>
  (view.stage === PublishStage.Public || inReview) && !publishing && !view.failure && !view.terms;

/** The public link, then the tested draft players do not have yet: shown together, right above the press. */
function Links({
  view,
  project,
  onOpen,
  opening,
}: {
  view: PublishView;
  project: string;
  onOpen: () => void;
  opening: boolean;
}): JSX.Element {
  const multiplayer = useLibrary((s) => s.games.find((g) => g.name === project)?.multiplayer === true);
  return (
    <>
      {view.link && <LinkField link={view.link} onOpen={onOpen} opening={opening} />}
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
}: {
  view: PublishView;
  publishing: boolean;
  /** Another cover is on its way: the line says where it shows. */
  making: boolean;
  /** Studio is taking the first cover now: whether the game has one is not known yet. */
  taking: boolean;
  record: ReturnType<typeof usePublishRecord>;
  name: string;
}): JSX.Element | null {
  const again = view.again;
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
}: {
  view: PublishView;
  record: ReturnType<typeof usePublishRecord>;
  name: string;
  publishing: boolean;
  project: string;
  /** Whether the press sends the game's project too, so others can remix it (Allow remixing). */
  remix: boolean;
  /** The main press's words in place of the view's (Save name, for a rename right after it went live). */
  label?: string;
  /** The game has only apps: the press publishes them instead of a web build. */
  apps?: boolean;
  /** Nothing to send yet (a game made in an engine with no app it can send): the press waits. */
  waiting?: boolean;
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
      onClick={() => void (apps ? record.publishApps(name, remix) : record.publish(name, remix))}
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

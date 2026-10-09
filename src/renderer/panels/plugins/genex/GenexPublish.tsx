/**
 * Publish to the web, drawn by Studio over the game's stage in the app's own type and buttons. It
 * asks first for what publishing needs and the person lacks (Genex Tools installed and on, then a
 * Genex account), then shows one dialog with one main button: the game and the name players will
 * see, Publish, its progress in that same button and under it, and the link once the game is live.
 * A failed attempt is said calmly, with the raw detail kept for support. The Publish press is the
 * consent to the files it uploads (listed on request beside it); nothing asks again.
 */
import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import {
  GENEX_PLUGIN_ID,
  GENEX_TITLE_MAX_CHARS,
  GenexAction,
  type GenexPublishState,
} from "../../../../shared/genex.ts";
import type { ExportReview, PluginInfo } from "../../../../shared/plugins.ts";
import { useLibrary } from "../../../state/hooks.ts";
import { Button } from "../../../ui/Button.tsx";
import { OPEN_PLUGINS_EVENT } from "../../../ui/ComposerAddMenu.tsx";
import { DialogSurface } from "../../../ui/dialog.tsx";
import { GameAvatar } from "../../../ui/GameAvatar.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { Pending } from "../../../ui/Pending.tsx";
import { GENEX_WORDS, problemWords } from "../../../words.ts";
import { PluginApproval } from "../../PluginApproval.tsx";
import { GenexAccountKind, genexAccountView } from "./genex-view.ts";
import {
  offeredTitle,
  PublishGate,
  PublishOutcome,
  PublishStage,
  type PublishView,
  publishGate,
  publishView,
  StepState,
  type StepView,
} from "./genex-publish-view.ts";
import { useGenexStatus } from "./use-genex-status.ts";
import { Pressing, usePublishRecord } from "./use-publish-record.ts";

const WORDS = GENEX_WORDS.publish;
const ACCOUNT = GENEX_WORDS.account;
/** Where the publish-open action sends the browser (the plugin's `PublishLinkTarget`). */
const LinkTarget = { Gallery: "gallery" } as const;
/** How long Copy reads "Copied". */
const COPIED_MS = 1600;

/** A cancelled review or approval is the person's choice, not an error to show. */
const CANCELLED = /Cancelled/;
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Seconds since an attempt started, ticking while it runs. */
function useElapsed(startedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / SECOND_MS));
}

/** A press that reads "Copied" for a moment after it copied `text`. */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  return [copied, copy];
}

/** The running attempt: what it is doing, for how long, and its steps as one bar with their names. */
function Progress({ view }: { view: PublishView }): JSX.Element {
  const elapsed = useElapsed(view.startedAt);
  const at = view.steps.findIndex((s) => s.state === StepState.Current);
  return (
    <div className="genex-publish-progress" aria-live="polite">
      <div className="genex-publish-phase">
        <span>{view.phase}</span>
        {elapsed ? <span className="genex-publish-elapsed">{WORDS.seconds(elapsed)}</span> : null}
      </div>
      <div
        className="genex-publish-bar"
        role="progressbar"
        aria-label={WORDS.progress}
        aria-valuemin={0}
        aria-valuemax={view.steps.length}
        aria-valuenow={Math.max(at, 0)}
        aria-valuetext={view.phase}
      >
        {view.steps.map((step: StepView) => (
          <span key={step.step} data-state={step.state} />
        ))}
      </div>
      <div className="genex-publish-steps" aria-hidden>
        {view.steps.map((step: StepView) => (
          <span key={step.step} data-state={step.state}>
            {step.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The game: its cover, and while nothing runs the name players will see, editable; while it
 * publishes, that name as text. Under it, where the game is.
 */
function GameLine({
  project,
  title,
  onTitle,
  view,
  publishing,
}: {
  project: string;
  title: string;
  onTitle: (title: string) => void;
  view: PublishView;
  publishing: boolean;
}): JSX.Element {
  const game = useLibrary((s) => s.games.find((g) => g.name === project));
  const live = view.stage === PublishStage.Public && !publishing;
  return (
    <div className="genex-publish-game">
      <GameAvatar cover={game?.cover} gameKey={project} className="genex-publish-cover" />
      <div className="genex-publish-game-text">
        {publishing ? (
          <span className="genex-publish-title">{title}</span>
        ) : (
          <label className="genex-publish-name">
            <span>{WORDS.name}</span>
            <input
              value={title}
              maxLength={GENEX_TITLE_MAX_CHARS}
              spellCheck={false}
              onChange={(e) => onTitle(e.target.value)}
            />
          </label>
        )}
        <span className="genex-publish-status" data-live={live || undefined}>
          {publishing ? WORDS.statusPublishing : view.status}
        </span>
      </div>
    </div>
  );
}

/** The link anyone can play, with the press that copies it. */
function LinkField({ link }: { link: string }): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <div className="genex-publish-link-field">
      <span title={link}>{link.replace(/^https?:\/\//, "")}</span>
      <Button aria-label={WORDS.copyLinkLabel} onClick={() => copy(link)}>
        <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "text-green" : undefined} />
        {copied ? WORDS.copied : WORDS.copyLink}
      </Button>
    </div>
  );
}

/** A failed or unknown attempt, calmly: what happened and what to do. */
function Failure({ title, text }: { title: string; text: string }): JSX.Element {
  return (
    <div role="status" className="genex-publish-failure">
      <p className="genex-publish-failure-title">{title}</p>
      <p>{text}</p>
    </div>
  );
}

/** The exact files a Publish press uploads, and how many the export leaves out. */
function FileList({ files }: { files: ExportReview }): JSX.Element {
  return (
    <div className="genex-publish-files" data-export-review>
      <ul aria-label={WORDS.filesLabel}>
        {files.included.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      {files.excluded.length > 0 && <p>{WORDS.filesLeftOut(files.excluded.length)}</p>}
    </div>
  );
}

/** A quiet text press at the footer's leading edge. */
function TextButton({ children, ...props }: { children: ReactNode } & JSX.IntrinsicElements["button"]): JSX.Element {
  return (
    <button type="button" className="genex-publish-text-button" {...props}>
      {children}
    </button>
  );
}

/** Copy the attempt's raw detail for support; reads "Details copied" for a moment. */
function CopyDetails({ details }: { details: string }): JSX.Element {
  const [copied, copy] = useCopy();
  return <TextButton onClick={() => copy(details)}>{copied ? WORDS.detailsCopied : WORDS.copyDetails}</TextButton>;
}

/**
 * The dialog's frame: one title, the words for where the game is, and, once the record is read,
 * where it is on Genex for smoke checks, whatever the dialog asks for first.
 */
function PublishFrame({
  intro,
  state = null,
  onClose,
  children,
}: {
  intro: string;
  state?: GenexPublishState | null;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <DialogSurface
      title={WORDS.title}
      titleIcon={<Icon name="globe" size={20} className="text-ink-3" />}
      description={intro}
      onDismiss={onClose}
      size="lg"
      testId="genex-publish"
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
 * Connect a Genex account from the Publish dialog: Connect, then finishing in the browser with the
 * code to check, then the terms, until the account is connected and `onConnected` re-reads the record.
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

/** The account step the person is on, with only the presses it needs, each showing it is working. */
function ConnectStep({
  view,
  live,
}: {
  view: ReturnType<typeof genexAccountView>;
  live: ReturnType<typeof useGenexStatus>;
}): JSX.Element {
  const busy = live.running !== null;
  const connecting = live.running === GenexAction.Connect;
  const connect = () => void live.act(GenexAction.Connect);
  switch (view.kind) {
    case GenexAccountKind.SignedOut:
      return (
        <Ask
          actions={
            <Button variant="default" size="default" busy={connecting} disabled={busy && !connecting} onClick={connect}>
              {(connecting && ACCOUNT.connecting) || (view.retry ? ACCOUNT.retry : ACCOUNT.connect)}
            </Button>
          }
        >
          <p>{view.retry ? ACCOUNT.retryText : WORDS.connectText}</p>
        </Ask>
      );
    case GenexAccountKind.SigningIn:
      return (
        <Ask
          actions={
            <>
              <Button size="default" disabled={busy} onClick={() => void live.act(GenexAction.CancelConnect)}>
                {ACCOUNT.cancel}
              </Button>
              <Button variant="default" size="default" busy>
                {ACCOUNT.waitingBrowser}
              </Button>
            </>
          }
        >
          <div className="genex-publish-code">
            <span>{ACCOUNT.browserShows}</span>
            <code>{view.code}</code>
          </div>
          <TextButton disabled={busy} onClick={connect}>
            {ACCOUNT.reopen}
            <Icon name="arrow-up-right" size={12} />
          </TextButton>
        </Ask>
      );
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
      return <Pending label={ACCOUNT.checking} className="genex-checking" />;
  }
}

/** The Genex plugin's name as a link to its page in Plugins; the dialog closes on the way. */
function PluginLink({ onLeave }: { onLeave: () => void }): JSX.Element {
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
      {WORDS.plugin}
    </button>
  );
}

/**
 * Publish while Genex Tools is off or not installed: one line naming what publishing uses (its
 * name opens the plugin's page), and the one press that brings it back, busy while it works.
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
  const install = publishGate(genex, undefined) === PublishGate.Install;
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
    <PublishFrame intro={WORDS.intro} onClose={onClose}>
      <p className="genex-publish-ask">
        {WORDS.through} <PluginLink onLeave={onClose} />
        {install ? WORDS.installEnd : WORDS.throughEnd}
      </p>
      {error && (
        <p role="alert" className="genex-publish-problem">
          {error}
        </p>
      )}
      <div className="genex-publish-actions">
        <div className="genex-publish-lead" />
        <div className="genex-publish-presses">
          <Button variant="default" size="default" busy={busy} aria-label={label} onClick={() => void press()}>
            {busy ? working : label}
          </Button>
        </div>
      </div>
    </PublishFrame>
  );
}

/** The footer's leading edge: the files to upload, that closing does not stop it, or the details for support. */
function Lead({
  view,
  publishing,
  failure,
  filesOpen,
  onFiles,
  listing,
  fileCount,
}: {
  view: PublishView;
  publishing: boolean;
  failure: { details: string } | null;
  filesOpen: boolean;
  onFiles: () => void;
  listing: boolean;
  fileCount: number | null;
}): JSX.Element | null {
  if (publishing) return <span className="genex-publish-note">{WORDS.keepsGoing}</span>;
  if (failure?.details) return <CopyDetails details={failure.details} />;
  if (view.stage === PublishStage.Public) return null;
  const label = (listing && WORDS.filesLoading) || (fileCount === null ? WORDS.filesShow : WORDS.files(fileCount));
  return (
    <TextButton aria-expanded={filesOpen} aria-busy={listing || undefined} onClick={onFiles}>
      {label}
      <Icon name="chevron-down" size={12} className={filesOpen ? "rotate-180" : undefined} />
    </TextButton>
  );
}

/** The dialog over the stage, while Genex Tools is on. */
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
  if (state && publishGate(plugin, state.connected) === PublishGate.Connect)
    return (
      <PublishFrame intro={WORDS.intro} state={state} onClose={onClose}>
        <ConnectGenex plugin={plugin} project={project} onConnected={record.refresh} />
      </PublishFrame>
    );
  const view = state ? publishView(state) : null;
  return (
    <PublishFrame intro={view?.intro ?? WORDS.intro} state={state} onClose={onClose}>
      {!view && record.readError && (
        <p role="alert" className="genex-publish-problem">
          {record.readError}
        </p>
      )}
      {view && <PublishBody view={view} record={record} project={project ?? ""} />}
      {record.review && <PluginApproval review={record.review} onClose={record.closeReview} />}
    </PublishFrame>
  );
}

/**
 * The read record: the game and its name, the running attempt's progress, the live link or what
 * went wrong, the files on request, and the footer's presses.
 */
function PublishBody({
  view,
  record,
  project,
}: {
  view: PublishView;
  record: ReturnType<typeof usePublishRecord>;
  project: string;
}): JSX.Element {
  const gameTitle = useLibrary((s) => s.games.find((g) => g.name === project)?.title);
  const [title, setTitle] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const name = title ?? offeredTitle(record.state, gameTitle, project);
  const publishing = record.pressing === Pressing.Publish || view.running;
  const failure = record.error ? { title: WORDS.failedTitle, text: record.error, details: record.error } : view.failure;
  const toggleFiles = () => {
    if (!filesOpen && !record.files) void record.listFiles();
    setFilesOpen(!filesOpen);
  };
  return (
    <>
      {view.problems.map((problem) => (
        <p key={problem} role="alert" className="genex-publish-problem">
          {problem}
        </p>
      ))}
      <GameLine project={project} title={name} onTitle={setTitle} view={view} publishing={publishing} />
      {view.running && <Progress view={view} />}
      {view.link && !publishing && <LinkField link={view.link} />}
      {failure && !publishing && <Failure title={failure.title} text={failure.text} />}
      {filesOpen && !publishing && record.files && <FileList files={record.files} />}
      <div className="genex-publish-actions">
        <div className="genex-publish-lead">
          <Lead
            view={view}
            publishing={publishing}
            failure={failure}
            filesOpen={filesOpen}
            onFiles={toggleFiles}
            listing={record.pressing === Pressing.Files}
            fileCount={record.files?.included.length ?? null}
          />
        </div>
        <div className="genex-publish-presses">
          <Presses view={view} record={record} name={name} publishing={publishing} />
        </div>
      </div>
    </>
  );
}

/**
 * The presses on the footer's trailing edge. One main button: Publish (busy while it publishes),
 * Try again after a failure, Open game once live with Publish update beside it, or, while an
 * upload's outcome is unknown, Check again and the person's own word.
 */
function Presses({
  view,
  record,
  name,
  publishing,
}: {
  view: PublishView;
  record: ReturnType<typeof usePublishRecord>;
  name: string;
  publishing: boolean;
}): JSX.Element {
  const acting = record.pressing === Pressing.Action;
  if (view.terms) {
    const terms = view.terms;
    return (
      <Button
        variant="default"
        size="default"
        className="genex-publish-primary"
        aria-label={terms.ariaLabel}
        busy={acting}
        onClick={() => void record.act(terms.action)}
      >
        {terms.label}
        <Icon name="arrow-up-right" size={14} />
      </Button>
    );
  }
  if (view.outcome === PublishOutcome.Unresolved)
    return (
      <>
        {view.extra.map((button, index) => (
          <Button
            key={button.label}
            size="default"
            variant={index === 0 ? "default" : "secondary"}
            aria-label={button.ariaLabel}
            busy={acting && index === 0}
            disabled={acting && index !== 0}
            onClick={() => void record.act(button.action, button.args ?? {})}
          >
            {button.label}
          </Button>
        ))}
      </>
    );
  const publish = (
    <Button
      variant={view.link && !publishing ? "secondary" : "default"}
      size="default"
      className={view.link && !publishing ? undefined : "genex-publish-primary"}
      aria-label={view.primary.ariaLabel}
      busy={publishing}
      disabled={!publishing && (!view.canPublish || record.pressing !== Pressing.None)}
      onClick={() => void record.publish(name)}
    >
      {publishing ? WORDS.publishing : view.primary.label}
    </Button>
  );
  if (!view.link || publishing || view.outcome === PublishOutcome.Failed) return publish;
  return (
    <>
      {publish}
      <Button
        variant="default"
        size="default"
        className="genex-publish-primary"
        busy={acting}
        onClick={() => void record.act(GenexAction.PublishOpen, { target: LinkTarget.Gallery })}
      >
        {WORDS.openGame}
        <Icon name="arrow-up-right" size={14} />
      </Button>
    </>
  );
}

/**
 * The first-run Toolchain sheet prepares every destination this host can build for the game's
 * stack (C++ · raylib unless said), independently of a game's selected destinations. A Rust · wgpu
 * game's sheet reads its own components under its own lock, lists Apple's Command Line Tools and
 * Xcode as separate rows, and offers to re-take the harness parts a Rust night refuses; this
 * version downloads no Rust tools from it, and it never says C++. It lists the downloads and OS prerequisites with a
 * disk preflight, installs on the person's press, shows progress, retry and cancel, and closes
 * with whether everything is ready. The install job is the host's: closing the sheet leaves it
 * running, and reopening it picks the job up from the status and the `toolchain.install` events.
 * A part Genex has pinned but not published says why it is not available; a destination whose
 * tools are in but whose first build must be prepared again offers Set up again. The moment it is
 * Ready it says so to its opener once (`onReady`), so Live builds again without waiting for Close.
 * A Rust sheet also lists each phone's setup (`PhoneSetup.tsx`), Android's SDK licence among it.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { type BuildTarget, type CompiledStack, GameStack } from "../../shared/game-project.ts";
import { SetupPrerequisite, setupTargets as stackSetupTargets } from "../../shared/stack-setup.ts";
import {
  CLT_TARGETS,
  isInstallRunning,
  type PrewarmState,
  ToolchainInstallPhase,
  type ToolchainInstallJob,
  ToolchainProblem,
  type ToolchainStatus,
} from "../../shared/toolchain.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { t } from "../../shared/i18n.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Pending } from "../ui/Pending.tsx";
import { DESTINATION_WORDS, problemWords, TOOLCHAIN_WORDS } from "../words.ts";
import { CrateRequests } from "./CrateRequests.tsx";
import { PhoneSetup } from "./PhoneSetup.tsx";
import { SeedRetake } from "./SeedRetake.tsx";
import {
  type DiskFacts,
  liveRetryDue,
  type PrerequisiteRow,
  prerequisiteRows,
  prerequisiteWords,
  rustSheetLines,
  type SheetRow,
  type SheetView,
  sheetView,
  sheetWords,
  sizeWords,
} from "./toolchain-view.ts";

/** The sheet's own words. */
const MESSAGE = {
  loading: t("Checking what is installed…"),
  progress: t("Install progress"),
} as const;

/** How often the sheet asks again whether Apple's install has finished, once the person started it. */
const CLT_RECHECK_MS = 5 * SECOND_MS;

/**
 * The store's status and its install job: read once, followed by the host's `toolchain.install`
 * events, and read again whenever a job ends. `reload` reads it again on demand. `error` is why
 * the last read failed, and clears once a read succeeds.
 */
export function useToolchainStatus(active: boolean) {
  const [status, setStatus] = useState<ToolchainStatus | null>(null);
  const [job, setJob] = useState<ToolchainInstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const reload = useCallback(async (): Promise<void> => {
    try {
      const next: ToolchainStatus = await window.studio.toolchainStatus();
      if (!alive.current) return;
      setStatus(next);
      setError(null);
      // The host's job is the truth when it has one; an event may have told of a newer one already.
      setJob((current) => next.job ?? current);
    } catch (cause) {
      if (alive.current) setError(problemWords(cause));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    alive.current = true;
    void reload();
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type !== UiEvent.ToolchainInstall) return;
      setJob(event.payload);
      if (!isInstallRunning(event.payload)) void reload();
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [active, reload]);
  return { status, job, error, reload };
}

/** A running job's share done, 0–100; an unsized phase reads 0. */
function percentOf(job: ToolchainInstallJob): number {
  return job.total > 0 ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0;
}

/** What the Command Line Tools row says: installed, waiting on Apple's installer, or needed. */
function cltDetail(clt: ToolchainStatus["clt"], asked: boolean): string {
  const words = TOOLCHAIN_WORDS.clt;
  if (clt.present) return words.present(clt.version);
  return asked ? words.installing : words.missing;
}

/** Apple's Command Line Tools: installed (with its version), or the button that opens Apple's installer. */
function CltRow({
  clt,
  asked,
  onInstall,
}: {
  clt: ToolchainStatus["clt"];
  asked: boolean;
  onInstall: () => void;
}): JSX.Element {
  const words = TOOLCHAIN_WORDS.clt;
  const detail = cltDetail(clt, asked);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body-sm font-medium text-ink">{words.name}</span>
        <span className="text-xs leading-snug text-ink-3">{detail}</span>
      </span>
      {!clt.present && (
        <Button data-toolchain-clt variant="secondary" disabled={asked} onClick={onInstall}>
          {words.install}
        </Button>
      )}
    </div>
  );
}

/**
 * Apple's prerequisites for a game whose stack lists more than the Command Line Tools (a Rust game):
 * each row says it is installed, inside Xcode, or why it is needed. The Command Line Tools row keeps
 * its button to Apple's installer; Xcode comes from the App Store, so its row has none.
 */
function PrerequisiteRows({
  rows,
  stack,
  asked,
  divided,
  onInstallClt,
}: {
  rows: readonly PrerequisiteRow[];
  stack: CompiledStack;
  asked: boolean;
  /** Rows follow below: a line sets Apple's apart from them. */
  divided: boolean;
  onInstallClt: () => void;
}): JSX.Element {
  return (
    <ul className={`m-0 flex list-none flex-col p-0 ${divided ? "border-b border-line" : ""}`}>
      {rows.map((row) => {
        const words = prerequisiteWords(row, stack);
        const cltButton = row.prerequisite === SetupPrerequisite.Clt && !row.present;
        return (
          <li
            key={row.prerequisite}
            data-toolchain-prerequisite={row.prerequisite}
            data-toolchain-present={row.present ? "" : undefined}
            className="flex items-center justify-between gap-4 py-2"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-body-sm font-medium text-ink">{words.name}</span>
              <span className="text-xs leading-snug text-pretty text-ink-3">
                {cltButton && asked ? TOOLCHAIN_WORDS.clt.installing : words.detail}
              </span>
            </span>
            {cltButton && (
              <Button data-toolchain-clt variant="secondary" disabled={asked} onClick={onInstallClt}>
                {TOOLCHAIN_WORDS.clt.install}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One component still to install: its version and size, or that it is not available yet (and, when Genex has not published it, why). */
function DownloadRow({ row, installsHere }: { row: SheetRow; installsHere: boolean }): JSX.Element {
  const { id, download, unhosted } = row;
  return (
    <li
      data-toolchain-download={id}
      data-toolchain-unavailable={download ? undefined : ""}
      data-toolchain-unhosted={unhosted ?? undefined}
      className="flex items-baseline justify-between gap-4 py-1.5"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-body-sm text-ink">{TOOLCHAIN_WORDS.component[id]}</span>
          {download && <span className="font-mono text-xs text-ink-3">{download.version}</span>}
        </span>
        {unhosted && <span className="text-xs leading-snug text-ink-3">{TOOLCHAIN_WORDS.unhosted[unhosted]}</span>}
      </span>
      <span className="shrink-0 font-mono text-xs text-ink-3 tabular-nums">
        {installsHere ? sizeWords(download) : TOOLCHAIN_WORDS.notInstalled}
      </span>
    </li>
  );
}

/**
 * The components still to download, each with its pinned version and size; one with no download
 * for this computer yet says it is not available. A part Genex has not published says why on its
 * row; for parts with no pin at all, one line under the list says why. The destinations those parts
 * keep out are named once, unless the job's own line already says so.
 */
function DownloadRows({
  rows,
  unpinned,
  notYet,
  installsHere,
}: {
  rows: readonly SheetRow[];
  unpinned: number;
  notYet: readonly BuildTarget[];
  installsHere: boolean;
}): JSX.Element {
  return (
    <>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row) => (
          <DownloadRow key={row.id} row={row} installsHere={installsHere} />
        ))}
      </ul>
      {unpinned > 0 && (
        <p className="mt-1 text-xs leading-snug text-ink-3">{TOOLCHAIN_WORDS.unavailableNote(unpinned)}</p>
      )}
      {notYet.length > 0 && (
        <p data-toolchain-not-yet={notYet.join(" ")} className="mt-1 text-xs leading-snug text-ink-3">
          {TOOLCHAIN_WORDS.notYet(notYet)}
        </p>
      )}
    </>
  );
}

/** Destinations whose tools are in but whose first build must be prepared again: Set up again does it. */
function PrewarmRows({ rows }: { rows: ReadonlyArray<{ target: BuildTarget; state: PrewarmState }> }): JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map(({ target, state }) => (
        <li key={target} data-toolchain-prewarm={state} className="flex flex-col gap-0.5 py-1.5">
          <span className="text-body-sm text-ink">{DESTINATION_WORDS.label[target]}</span>
          <span className="text-xs leading-snug text-pretty text-ink-3">{TOOLCHAIN_WORDS.prewarm[state]}</span>
        </li>
      ))}
    </ul>
  );
}

/** The install button's words: Try again after a failure, Set up again when nothing is downloaded. */
function installWords(view: SheetView): string {
  if (view.retry) return TOOLCHAIN_WORDS.retry;
  return view.setUpAgain ? TOOLCHAIN_WORDS.setUpAgain : TOOLCHAIN_WORDS.install;
}

/** The disk preflight: the space the install needs (unpacked, with its reserve) against what is free. */
function DiskLine({ disk }: { disk: DiskFacts }): JSX.Element {
  const { need, free } = disk;
  return (
    <p data-toolchain-disk className={`mt-2 font-mono text-xs ${free < need ? "text-red" : "text-ink-3"}`}>
      {TOOLCHAIN_WORDS.disk(free, need)}
    </p>
  );
}

/** Where the install stands: its phase and progress while it runs, or how it ended. */
function JobLine({ job, onCancel }: { job: ToolchainInstallJob; onCancel: () => void }): JSX.Element {
  if (isInstallRunning(job)) {
    const percent = percentOf(job);
    return (
      <div role="status" data-toolchain-phase={job.phase} className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-xs text-ink-2">
            {TOOLCHAIN_WORDS.phase[job.phase]}
            {job.entry ? ` · ${TOOLCHAIN_WORDS.component[job.entry]}` : ""}
          </span>
          <span
            role="progressbar"
            aria-label={MESSAGE.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1 overflow-hidden rounded-full bg-hover"
          >
            <span
              className="block h-full bg-accent-primary transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </span>
        </span>
        <Button data-toolchain-cancel onClick={onCancel}>
          {TOOLCHAIN_WORDS.cancel}
        </Button>
      </div>
    );
  }
  if (job.phase === ToolchainInstallPhase.Failed)
    return (
      <p role="alert" data-toolchain-phase={job.phase} className="text-xs leading-relaxed text-red">
        {job.problem ? TOOLCHAIN_WORDS.problem[job.problem] : TOOLCHAIN_WORDS.phase[job.phase]}
        {job.entry ? ` (${TOOLCHAIN_WORDS.component[job.entry]})` : ""}
      </p>
    );
  return (
    <p role="status" data-toolchain-phase={job.phase} className="text-xs text-ink-3">
      {TOOLCHAIN_WORDS.phase[job.phase]}
      {job.unavailable?.length ? ` · ${TOOLCHAIN_WORDS.notYet(job.unavailable)}` : ""}
    </p>
  );
}

/** The sheet's rows: the Command Line Tools, the downloads with the disk line, the job, and any error. */
/** Apple's prerequisites: a C++ game's Command Line Tools row as it always was, or a Rust game's two rows. */
function AppleRows({
  status,
  view,
  needsClt,
  cltAsked,
  onInstallClt,
}: {
  status: ToolchainStatus;
  view: SheetView;
  needsClt: boolean;
  cltAsked: boolean;
  onInstallClt: () => void;
}): JSX.Element | null {
  if (view.stack === GameStack.RaylibCpp)
    return needsClt ? <CltRow clt={status.clt} asked={cltAsked} onInstall={onInstallClt} /> : null;
  const rows = prerequisiteRows(status, view.stack);
  if (rows.length === 0) return null;
  return (
    <PrerequisiteRows
      rows={rows}
      stack={view.stack}
      asked={cltAsked}
      divided={view.components.length > 0}
      onInstallClt={onInstallClt}
    />
  );
}

/** A Rust sheet's notes under its rows and the harness parts a Rust night refuses, each with its re-take. */
function RustNotes({ view, onRetaken }: { view: SheetView; onRetaken: () => void }): JSX.Element | null {
  if (view.installsHere) return null;
  const words = TOOLCHAIN_WORDS.rust;
  const showsInstallNote = rustSheetLines(view).includes(words.notInstalledHere);
  return (
    <>
      {showsInstallNote && (
        <p data-toolchain-not-installed-here className="text-xs leading-snug text-pretty text-ink-3">
          {words.notInstalledHere}
        </p>
      )}
      <SeedRetake title={words.keptTitle} intro={words.keptIntro} modules={view.keptPreRust} onRetaken={onRetaken} />
    </>
  );
}

function SheetBody({
  status,
  job,
  error,
  view,
  needsClt,
  cltAsked,
  onInstallClt,
  onCancel,
  onRetaken,
}: {
  status: ToolchainStatus | null;
  job: ToolchainInstallJob | null;
  error: string | null;
  view: SheetView;
  needsClt: boolean;
  cltAsked: boolean;
  onInstallClt: () => void;
  onCancel: () => void;
  onRetaken: () => void;
}): JSX.Element {
  return (
    <div data-toolchain-sheet data-toolchain-stack={view.stack} className="flex min-h-0 flex-col gap-3">
      {!status && !error && <Pending label={MESSAGE.loading} className="text-xs text-ink-3" />}
      {status?.host === null && (
        <p role="alert" className="text-xs leading-relaxed text-red">
          {view.stack === GameStack.RaylibCpp
            ? TOOLCHAIN_WORDS.problem[ToolchainProblem.UnsupportedHost]
            : sheetWords(view.stack).unsupportedHost}
        </p>
      )}
      {status && (
        <AppleRows status={status} view={view} needsClt={needsClt} cltAsked={cltAsked} onInstallClt={onInstallClt} />
      )}
      {view.components.length > 0 && (
        <div>
          <DownloadRows
            rows={view.rows}
            unpinned={view.unpinned}
            notYet={job?.unavailable?.length ? [] : view.notYet}
            installsHere={view.installsHere}
          />
          {view.disk && <DiskLine disk={view.disk} />}
        </div>
      )}
      {view.prewarm.length > 0 && <PrewarmRows rows={view.prewarm} />}
      <RustNotes view={view} onRetaken={onRetaken} />
      {status && view.stack === GameStack.RustWgpu && <PhoneSetup status={status} job={job} onChanged={onRetaken} />}
      {view.stack === GameStack.RustWgpu && <CrateRequests />}
      {view.installsHere && job && <JobLine job={job} onCancel={onCancel} />}
      {error && (
        <p role="alert" className="text-xs leading-relaxed text-red">
          {error}
        </p>
      )}
    </div>
  );
}

/** Calls `onReady` once per opening, the first time the sheet's view is Ready. */
function useReadyOnce(open: boolean, view: SheetView, onReady: (() => void) | undefined): void {
  const told = useRef(false);
  const due = open && liveRetryDue(view, told.current);
  useEffect(() => {
    if (!open) told.current = false;
  }, [open]);
  useEffect(() => {
    if (!due) return;
    told.current = true;
    onReady?.();
  }, [due, onReady]);
}

/**
 * The Toolchain sheet prepares the host's complete set for `stack` (C++ · raylib unless said);
 * `onClose(true)` when that set is ready, and `onReady` the moment everything `readyTargets` need
 * is (all of `targets` unless given), while it is still open: Live waits for its own build's tools,
 * while setup includes the other destinations.
 */
export function ToolchainSheet({
  open,
  targets,
  readyTargets = targets,
  stack = GameStack.RaylibCpp,
  onClose,
  onReady,
}: {
  open: boolean;
  targets: readonly BuildTarget[];
  readyTargets?: readonly BuildTarget[];
  stack?: CompiledStack;
  onClose: (ready: boolean) => void;
  onReady?: () => void;
}): JSX.Element | null {
  const { status, job, error: loadError, reload } = useToolchainStatus(open);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cltAsked, setCltAsked] = useState(false);
  const setupTargets = status ? stackSetupTargets(stack, status.host) : targets;
  const view = sheetView(status, job, setupTargets, stack);
  const words = sheetWords(stack);
  useReadyOnce(open, sheetView(status, job, readyTargets, stack), onReady);
  const waitingOnApple = open && cltAsked && view.cltMissing;
  // Once Apple's installer is open, ask again now and then until the tools are there.
  useEffect(() => {
    if (!waitingOnApple) return;
    const timer = setInterval(() => void reload(), CLT_RECHECK_MS);
    return () => clearInterval(timer);
  }, [waitingOnApple, reload]);
  if (!open) return null;

  /** Runs one of the sheet's actions; its failure shows until the next action starts. */
  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(problemWords(cause));
    }
  };
  const install = () => act(() => window.studio.toolchainInstall([...setupTargets]));
  const cancel = () => act(() => window.studio.toolchainCancel());
  const installClt = () => act(async () => setCltAsked(await window.studio.toolchainInstallClt()));
  return (
    <DialogSurface
      title={words.title}
      description={words.intro}
      size="lg"
      testId="toolchain-sheet"
      layer="nested"
      onDismiss={() => onClose(view.ready)}
    >
      <SheetBody
        status={status}
        job={job}
        error={actionError ?? loadError}
        view={view}
        needsClt={setupTargets.some((target) => CLT_TARGETS.includes(target))}
        cltAsked={cltAsked}
        onInstallClt={() => void installClt()}
        onCancel={() => void cancel()}
        onRetaken={() => void reload()}
      />
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button variant={view.ready || !view.installsHere ? "default" : "ghost"} onClick={() => onClose(view.ready)}>
          {TOOLCHAIN_WORDS.close}
        </Button>
        {!view.ready && view.installsHere && (
          <Button data-toolchain-install variant="default" disabled={!view.canInstall} onClick={() => void install()}>
            {installWords(view)}
          </Button>
        )}
      </div>
    </DialogSurface>
  );
}

/**
 * The native run card: what a C++ game's own window is doing (the Mac's, or on Windows and Linux
 * the host's own, named per destination by `native-card.ts`), above the stage like the build
 * strip (above, not inside: Live's game view paints over this window). Running offers Bring to
 * front and Stop; an ended run says how it ended and offers Restart; a refused run says why and
 * offers Try again, and a failed Mac build says it in the build strip's words, with its
 * diagnostics and Details, and Install tools (Set up again, Set up) when its tools need it. Every button is the card's own
 * (`data-stage-native-action`), never the build strip's, so Live's strip and the card never share
 * a selector. `native-card.ts` decides what it says; this only draws it.
 */
import type { JSX } from "react";
import { nativeCommands, useNativeRun } from "../../state/hooks.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { NATIVE_WORDS, TOOLCHAIN_WORDS } from "../../words.ts";
import { TroubleDetails } from "./build-problem.tsx";
import { NativeCardAction, type NativeCardView, nativeCardView } from "./native-card.ts";

/** How many of the window's last stderr lines Details shows. */
const LOG_LINES_SHOWN = 20;

/** The card's own words. */
const MESSAGE = {
  /** Install tools, as the build strip says it. */
  installTools: "Install tools",
} as const;

/** The buttons that open the Toolchain sheet instead of asking the registry for something. */
const SHEET_ACTIONS: ReadonlySet<NativeCardAction> = new Set([
  NativeCardAction.InstallTools,
  NativeCardAction.SetUpTools,
  NativeCardAction.FinishSetUp,
]);

/** The buttons that open the Toolchain sheet. */
type SheetAction =
  | typeof NativeCardAction.InstallTools
  | typeof NativeCardAction.SetUpTools
  | typeof NativeCardAction.FinishSetUp;

/** The buttons that ask the registry for something. */
type RunAction = Exclude<NativeCardAction, SheetAction>;

/** Each button's words. */
const ACTION_WORDS: Record<NativeCardAction, string> = {
  [NativeCardAction.Stop]: NATIVE_WORDS.stop,
  [NativeCardAction.Restart]: NATIVE_WORDS.restart,
  [NativeCardAction.Front]: NATIVE_WORDS.front,
  [NativeCardAction.InstallTools]: MESSAGE.installTools,
  [NativeCardAction.SetUpTools]: TOOLCHAIN_WORDS.setUpAgain,
  [NativeCardAction.FinishSetUp]: TOOLCHAIN_WORDS.setUp,
  [NativeCardAction.TryAgain]: NATIVE_WORDS.tryAgain,
};

/** What each button asks of the registry: Restart and Try again are Play on Mac again. */
const COMMANDS: Record<RunAction, (project: string) => Promise<unknown>> = {
  [NativeCardAction.Stop]: (project) => nativeCommands().stop(project),
  [NativeCardAction.Restart]: (project) => nativeCommands().play(project),
  [NativeCardAction.TryAgain]: (project) => nativeCommands().play(project),
  [NativeCardAction.Front]: (project) => nativeCommands().front(project),
};

/** Whether `action` opens the Toolchain sheet. */
const opensSheet = (action: NativeCardAction): action is SheetAction => SHEET_ACTIONS.has(action);

/**
 * The card's buttons for a state, each running its command and saying what went wrong. One group,
 * at the row's end: on a narrow stage they move under the words together, never one by one.
 */
function CardButtons({
  view,
  onAction,
}: {
  view: NativeCardView;
  onAction: (action: NativeCardAction) => void;
}): JSX.Element | null {
  if (view.actions.length === 0) return null;
  return (
    <span className="ms-auto flex shrink-0 items-center gap-2">
      {view.actions.map((action) => (
        <Button key={action} data-stage-native-action={action} onClick={() => onAction(action)}>
          {ACTION_WORDS[action]}
        </Button>
      ))}
    </span>
  );
}

/** What the game wrote to stderr before it ended, behind Details. */
function LogDetails({ lines }: { lines: readonly string[] }): JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <details className="text-xs text-ink-3">
      <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">{NATIVE_WORDS.details}</summary>
      <pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-ink-2">
        {lines.slice(-LOG_LINES_SHOWN).join("\n")}
      </pre>
    </details>
  );
}

/** The card for `project`'s window run, or nothing while it has none. */
export function NativeRunCard({
  project,
  onNotice,
  onInstallTools,
}: {
  project: string;
  onNotice: Notify;
  /** Open the Toolchain sheet for the Mac: its build could not start for want of tools, or of their set-up. */
  onInstallTools: () => void;
}): JSX.Element | null {
  const { status, log } = useNativeRun(project);
  const view = nativeCardView(status);
  if (!view) return null;
  const run = (action: NativeCardAction): void => {
    if (opensSheet(action)) {
      onInstallTools();
      return;
    }
    // A refusal (Bring to front in a fixture profile, say) is said in words; the card stays as it was.
    void COMMANDS[action](project).catch(notifyProblem(onNotice));
  };
  return (
    <div
      data-stage-native-card={view.state}
      className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm font-medium text-ink">{view.heading}</span>
        <span role="status" className="min-w-32 flex-1 text-xs leading-relaxed text-pretty text-ink-3">
          <span className={view.busy ? "chat-status-shimmer" : undefined}>{view.title}</span>
          {view.detail ? <span className="text-ink-2">{` · ${view.detail}`}</span> : null}
        </span>
        <CardButtons view={view} onAction={run} />
      </div>
      {view.problem ? <TroubleDetails problem={view.problem} installLines={null} /> : null}
      {view.log ? <LogDetails lines={log} /> : null}
    </div>
  );
}

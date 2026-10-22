/**
 * What sits on and under an Assets card besides its picture: the Saved or Shared tag, the circle
 * that selects it among several, and the one line its share leaves (the steps, ✓ On Play, or why
 * it missed with what to do about it).
 */
import type { JSX } from "react";
import { useState } from "react";
import { FEEDBACK_TEXT_MAX_CHARS, FeedbackScreen } from "../../../shared/feedback.ts";
import {
  CardTag,
  type LineStep,
  MissAction,
  SHARE_STEPS,
  type ShareLine,
  ShareLineKind,
  type ShareProgress,
  ShareStep,
  shareLineOf,
  stepMark,
} from "../../asset-library-view.ts";
import { studio } from "../../state/studio.ts";
import { Icon } from "../../ui/icons.tsx";
import { ASSET_LIBRARY_WORDS as WORDS } from "../../words.ts";
import { LIVE_SHOWN_MS } from "../../state/sharing.ts";

/** Each step's word on the line. */
const STEP_WORDS: Record<LineStep, string> = {
  [ShareStep.Send]: WORDS.steps.send,
  [ShareStep.Check]: WORDS.steps.check,
  [ShareStep.Live]: WORDS.steps.live,
};

/** A card's tag over its picture's top left: Saved with a filled bookmark, Shared with a globe. */
export function CardTagMark({ tag }: { tag: CardTag }): JSX.Element {
  const saved = tag === CardTag.Saved;
  return (
    <span data-asset-tag={tag} className="asset-tag asset-glass">
      <Icon name={saved ? "bookmark" : "globe"} size={12} strokeWidth={2} className={saved ? "gi-filled" : ""} />
      {saved ? WORDS.saved : WORDS.shared}
    </span>
  );
}

/** The circle over a card's top right while several are being picked: filled with a check when picked. */
export function PickCircle({
  picked,
  name,
  onToggle,
}: {
  picked: boolean;
  name: string;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-asset-pick={picked || undefined}
      aria-pressed={picked}
      aria-label={picked ? WORDS.deselect(name) : WORDS.select(name)}
      className="asset-pick"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {picked && <Icon name="check" size={12} strokeWidth={3} />}
    </button>
  );
}

/** Send · Check · Live, the current step bright; "Checking" while genex.games still checks it. */
function StepLine({ line }: { line: Extract<ShareLine, { kind: typeof ShareLineKind.Steps }> }): JSX.Element {
  return (
    <span className="asset-steps" role="status" aria-label={WORDS.stepsLabel} data-share-step={line.current}>
      {SHARE_STEPS.map((step, index) => (
        <span key={step} className="contents">
          {index > 0 && <span aria-hidden>·</span>}
          <span data-mark={stepMark(step, line.current)}>
            {line.checking && step === line.current ? WORDS.checking : STEP_WORDS[step]}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Send a report: the refusal and the app's logs go to the Genex team, then the line says so. */
function ReportButton({
  project,
  file,
  progress,
}: {
  project: string;
  file: string;
  progress: ShareProgress;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const send = (): void => {
    setBusy(true);
    const text = WORDS.reportText(progress.name, project, progress.detail ?? "").slice(0, FEEDBACK_TEXT_MAX_CHARS);
    void studio()
      .api.sendFeedback({ text, screen: FeedbackScreen.Chat, appLogs: true, chatId: null })
      .then(() => studio().sharing.reported(project, file))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      data-share-report
      aria-label={WORDS.sendReportLabel}
      disabled={busy}
      className="asset-line-button"
      onClick={send}
    >
      {WORDS.sendReport}
    </button>
  );
}

/** The one line a share leaves under its card. */
export function ShareLineMark({
  project,
  file,
  progress,
}: {
  project: string;
  file: string;
  progress: ShareProgress;
}): JSX.Element {
  const line = shareLineOf(progress);
  if (line.kind === ShareLineKind.Steps)
    return (
      <div className="asset-line">
        <StepLine line={line} />
      </div>
    );
  if (line.kind === ShareLineKind.Live)
    return (
      <div className="asset-line asset-line-live" data-share-live style={{ animationDuration: `${LIVE_SHOWN_MS}ms` }}>
        <Icon name="check" size={14} strokeWidth={2} />
        {WORDS.onPlay}
      </div>
    );
  const retry = (): void => void studio().sharing.share(project, [{ file, name: progress.name }]);
  return (
    <div className="asset-line asset-line-missed" role="alert" data-share-missed={line.miss}>
      <span className="truncate">{WORDS.missed[line.miss]}</span>
      {line.action === MissAction.Retry && (
        <button type="button" data-share-retry className="asset-line-button" onClick={retry}>
          {WORDS.tryAgain}
        </button>
      )}
      {line.action === MissAction.Report && <ReportButton project={project} file={file} progress={progress} />}
      {line.action === MissAction.Reported && (
        <span className="asset-line-done">
          <Icon name="check" size={12} strokeWidth={2} />
          {WORDS.reportSent}
        </span>
      )}
    </div>
  );
}

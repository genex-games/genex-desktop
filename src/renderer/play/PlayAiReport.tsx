/**
 * Report what the AI wrote (`Report-v2`): a dialog over the dimmed game that says what a Report sends
 * (this session's AI moments, a replay of the game, never the account) and to whom, shows exactly
 * that on "See what's sent" as plain, bounded text, takes a reason and an optional note, and sends it
 * to Genex and the game's maker. A send that fails says why, and Send becomes Try again. No sign-in
 * is needed; once sent, the pill wears "Report sent".
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { JSX, KeyboardEvent } from "react";
import { useState } from "react";
import type { AiGameKey } from "../../shared/game-ai.ts";
import { AI_REPORT_NOTE_MAX_CHARS, AiReportFailure, AiReportReason } from "../../shared/game-ai-report.ts";
import { RovingAxis, rovingTarget } from "../ui/roving-focus.ts";
import { PLAY_AI_WORDS } from "../words.ts";
import { AiLoad, type ReportExtras, type ReportMoment, reportExtras, reportMoments } from "./ai-model.ts";
import type { BarApi } from "./PlayBarPage.tsx";

const WORDS = PLAY_AI_WORDS.report;
const REASONS = Object.values(AiReportReason);

/** What "See what's sent" shows. */
type Preview =
  | { status: typeof AiLoad.Loading }
  | { status: typeof AiLoad.Failed }
  | { status: typeof AiLoad.Ready; moments: ReportMoment[]; extras: ReportExtras };

/** The redacted Report main would send, read once on "See what's sent" (again after it failed). */
function usePreview(api: BarApi, game: AiGameKey) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const read = (): void => {
    setPreview({ status: AiLoad.Loading });
    api.gameAiReportPreview(game).then(
      (bundle) => setPreview({ status: AiLoad.Ready, moments: reportMoments(bundle), extras: reportExtras(bundle) }),
      () => setPreview({ status: AiLoad.Failed }),
    );
  };
  return { preview, read };
}

/** "See what's sent": the moments as plain text, newest last, and what else goes with them. */
function WhatsSent({ preview, retry }: { preview: Preview; retry: () => void }): JSX.Element {
  const words = WORDS.preview;
  if (preview.status === AiLoad.Loading)
    return (
      <p className="play-ai-card-small" aria-busy="true">
        {words.loading}
      </p>
    );
  if (preview.status === AiLoad.Failed)
    return (
      <div className="play-ai-problem" role="alert">
        <span>{words.failed}</span>{" "}
        <button type="button" className="play-ai-link" onClick={retry}>
          {PLAY_AI_WORDS.menu.retry}
        </button>
      </div>
    );
  const { moments, extras } = preview;
  return (
    <section className="play-ai-sent" aria-label={words.label} data-ai-report-preview>
      {moments.length === 0 && <p className="play-ai-card-small">{words.none}</p>}
      {moments.map((moment, at) => (
        <div key={at} className="play-ai-moment">
          <span className="play-ai-moment-site">
            {moment.site}
            {moment.model ? ` · ${moment.model}` : ""}
          </span>
          {moment.said !== null && (
            <p>
              <b>{words.you}</b> {moment.said}
            </p>
          )}
          {moment.wrote !== null && (
            <p>
              <b>{words.ai}</b> {moment.wrote}
            </p>
          )}
        </div>
      ))}
      <p className="play-ai-card-small">{words.extras(extras.inputs, extras.frame, extras.consoleErrors)}</p>
    </section>
  );
}

/** The reasons, as a radio group: arrows move the choice. */
function Reasons({
  reason,
  onReason,
}: {
  reason: AiReportReason | null;
  onReason: (reason: AiReportReason) => void;
}): JSX.Element {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = rovingTarget(event.key, reason ? REASONS.indexOf(reason) : -1, REASONS.length, RovingAxis.Vertical);
    const chosen = next === null ? undefined : REASONS[next];
    if (!chosen) return;
    event.preventDefault();
    onReason(chosen);
    event.currentTarget.querySelector<HTMLElement>(`[data-ai-reason="${chosen}"]`)?.focus();
  };
  return (
    <div className="play-ai-reasons" role="radiogroup" aria-label={WORDS.reasonLabel} onKeyDown={move}>
      {REASONS.map((value, at) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={reason === value}
          tabIndex={reason === value || (reason === null && at === 0) ? 0 : -1}
          className="play-ai-reason"
          data-ai-reason={value}
          onClick={() => onReason(value)}
        >
          <span className="play-ai-reason-mark" aria-hidden="true" />
          {WORDS.reasons[value]}
        </button>
      ))}
    </div>
  );
}

/** Sending the Report: once at a time, and why it failed. */
function useSend(api: BarApi, game: AiGameKey, onSent: () => void) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<AiReportFailure | null>(null);
  const send = (reason: AiReportReason, note: string): void => {
    if (sending) return;
    setSending(true);
    setFailure(null);
    api
      .gameAiReport({ game, reason, note: note.trim() ? note : null })
      .then(
        (outcome) => (outcome.ok ? onSent() : setFailure(outcome.failure)),
        () => setFailure(AiReportFailure.Refused),
      )
      .finally(() => setSending(false));
  };
  return { sending, failure, send };
}

/** The Report dialog for `game`. */
export function PlayAiReport({
  api,
  game,
  onClose,
}: {
  api: BarApi;
  game: AiGameKey;
  onClose: () => void;
}): JSX.Element {
  const [reason, setReason] = useState<AiReportReason | null>(null);
  const [note, setNote] = useState("");
  const { preview, read } = usePreview(api, game);
  const [shown, setShown] = useState(false);
  const { sending, failure, send } = useSend(api, game, onClose);
  const toggle = (): void => {
    if (!shown && preview?.status !== AiLoad.Ready) read();
    setShown(!shown);
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="play-ai-scrim" />
        <Dialog.Content className="play-ai-report" aria-describedby="play-ai-report-about" data-play-ai-report>
          <Dialog.Title className="play-ai-report-title">{WORDS.title}</Dialog.Title>
          <p id="play-ai-report-about" className="play-ai-card-small">
            {WORDS.about}
          </p>
          <button type="button" className="play-ai-link" aria-expanded={shown} data-ai-see-sent onClick={toggle}>
            {shown ? WORDS.hideWhat : WORDS.seeWhat}
          </button>
          {shown && preview && <WhatsSent preview={preview} retry={read} />}
          <Reasons reason={reason} onReason={setReason} />
          <label className="play-ai-note">
            <span>{WORDS.note}</span>
            <textarea
              value={note}
              maxLength={AI_REPORT_NOTE_MAX_CHARS}
              rows={2}
              onChange={(event) => setNote(event.target.value)}
              data-ai-report-note
            />
          </label>
          {failure && (
            <p className="play-ai-problem" role="alert">
              {WORDS.failed[failure]}
            </p>
          )}
          <div className="play-ai-report-foot">
            <Dialog.Close className="play-ai-button" data-ghost>
              {WORDS.cancel}
            </Dialog.Close>
            <button
              type="button"
              className="play-ai-button"
              data-primary
              disabled={!reason || sending}
              data-ai-report-send
              onClick={() => reason && send(reason, note)}
            >
              {failure ? WORDS.tryAgain : WORDS.send}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

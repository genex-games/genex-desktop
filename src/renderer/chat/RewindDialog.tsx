import { type JSX, type RefObject, useEffect, useId, useRef, useState } from "react";
import type { RewindFiles, RewindResult } from "../../shared/chat-rewind.ts";
import { t } from "../../shared/i18n.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";
import { problemWords } from "../words.ts";
import { REWIND_WORDS, restoresByDefault, rewindBusyLabel, rewindFilesWords } from "./rewind-words.ts";
import { REWIND_CANCELLED, rewindConfirmedProperties, rewindPreviewProperties } from "../analytics/chat-properties.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";

/** What the dialog says about the game files: checking, refused, or what they will do, and what an engine project keeps. */
function RewindFilesBody({
  files,
  refused,
  restore,
  busy,
  engineNote,
  onRestore,
}: {
  files: RewindFiles | null;
  refused: string;
  restore: boolean;
  busy: boolean;
  engineNote: string | null;
  onRestore: (restore: boolean) => void;
}): JSX.Element {
  const switchId = useId();
  if (refused)
    return (
      <p role="alert" className="text-dialog-body text-red">
        {refused}
      </p>
    );
  if (!files)
    return (
      <p role="status" className="text-dialog-body text-ink-3">
        {REWIND_WORDS.checking}
      </p>
    );
  const words = rewindFilesWords(files);
  return (
    <div className="flex flex-col gap-2 text-dialog-body">
      {files.state === "restore" ? (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={switchId} className="flex min-w-0 flex-col">
            <span className="text-ink">{REWIND_WORDS.restoreFiles}</span>
            <span className="text-ink-3">{words.line}</span>
            {words.outside && (
              <span data-analytics-mask className="text-ink-3 [overflow-wrap:anywhere]">
                {words.outside}
              </span>
            )}
          </label>
          <Switch id={switchId} checked={restore} disabled={busy} onCheckedChange={onRestore} />
        </div>
      ) : (
        words.line && (
          <p data-rewind-chat-only className="text-ink-3">
            {words.line}
          </p>
        )
      )}
      {words.nested && <p className="text-ink-3">{words.nested}</p>}
      {engineNote && (
        <p data-rewind-engine-note className="text-ink-3">
          {engineNote}
        </p>
      )}
    </div>
  );
}

/**
 * Confirms rewinding a chat to before one of its messages. Files come back only when the
 * checkpoint taken before that message still applies. The switch starts on, because undoing
 * what the answers did is why people rewind, unless something outside this chat changed files
 * too: then putting those back is a choice the person makes knowingly. When the files cannot
 * come back there is no switch: one line says why only the conversation rewinds, and a running
 * build is stopped first.
 */
export function RewindDialog({
  threadId,
  eventId,
  messageId,
  engineNote = null,
  returnFocus,
  onRewound,
  onDismiss,
}: {
  threadId: string;
  eventId: string;
  messageId: string;
  /** What Rewind can't undo in the game's engine project (`engine-game.ts` `engineRewindNote`); none for a web game. */
  engineNote?: string | null;
  /** Focus on close (the composer after a rewind); the opener when it holds nothing. */
  returnFocus?: RefObject<HTMLElement | null>;
  onRewound: (result: RewindResult) => void;
  onDismiss: () => void;
}) {
  const [files, setFiles] = useState<RewindFiles | null>(null);
  const [stopsBuild, setStopsBuild] = useState(false);
  const [restore, setRestore] = useState(true);
  const [refused, setRefused] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let current = true;
    void window.studio
      .rewindPreview(threadId, eventId, messageId)
      .then((preview) => {
        if (!current) return;
        setFiles(preview.files);
        setStopsBuild(preview.stopsBuild === true);
        if (!restoresByDefault(preview.files)) setRestore(false);
        track(AnalyticsEvent.RewindPreviewed, rewindPreviewProperties(preview));
      })
      .catch((err) => {
        if (!current) return;
        setRefused(problemWords(err));
        track(AnalyticsEvent.RewindPreviewed, rewindPreviewProperties(null, err));
      });
    return () => {
      current = false;
    };
  }, [threadId, eventId, messageId]);
  const decided = (failed: boolean, failure: unknown = null): void => {
    const choice = { restore, restoresByDefault: Boolean(files && restoresByDefault(files)), failed };
    track(AnalyticsEvent.RewindDecided, rewindConfirmedProperties(files, choice, failure));
  };
  const confirm = (): void => {
    setBusy(true);
    setError("");
    void window.studio
      .rewindChat(threadId, eventId, messageId, files?.state === "restore" && restore)
      .then((result) => {
        decided(false);
        onRewound(result);
        onDismiss();
      })
      .catch((err) => {
        decided(true, err);
        setError(problemWords(err));
        setBusy(false);
      });
  };
  // Cancel and every other way out of the dialog; a rewind that went closes it through `onDismiss`.
  const dismiss = (): void => {
    track(AnalyticsEvent.RewindDecided, REWIND_CANCELLED);
    onDismiss();
  };
  return (
    <DialogSurface
      testId="rewind-dialog"
      dismissible={!busy}
      initialFocus={cancel}
      returnFocus={returnFocus}
      title={t("Rewind to before this message?")}
      description={t(
        "This message and everything after it leave the chat. The message goes back in the composer so you can change it.",
      )}
      onDismiss={() => {
        if (!busy) dismiss();
      }}
    >
      <RewindFilesBody
        files={files}
        refused={refused}
        restore={restore}
        busy={busy}
        engineNote={engineNote}
        onRestore={setRestore}
      />
      {error && (
        <p role="alert" className="text-xs text-red">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button ref={cancel} variant="ghost" disabled={busy} onClick={dismiss}>
          {t("Cancel")}
        </Button>
        <Button
          data-rewind-confirm
          variant="destructive"
          disabled={busy || !files || Boolean(refused)}
          onClick={confirm}
        >
          {busy ? rewindBusyLabel(stopsBuild) : REWIND_WORDS.rewind}
        </Button>
      </div>
    </DialogSurface>
  );
}

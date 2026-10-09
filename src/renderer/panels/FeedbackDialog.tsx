/**
 * Send feedback, from the bug button at the top of the sidebar: the person's words and, only when
 * they switch them on, the app's logs and the open chat, each on its own, so a bug elsewhere can
 * carry the app's logs without an unrelated chat. Main posts the report anonymously to
 * genex.games (`main/feedback.ts`); a failure keeps the words to try again.
 */
import { type JSX, type KeyboardEvent, useId, useRef, useState } from "react";
import { FEEDBACK_TEXT_MAX_CHARS } from "../../shared/feedback.ts";
import type { FeedbackAbout } from "../feedback-about.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";
import { FEEDBACK_WORDS } from "../words.ts";

/** ⌘↵ (Ctrl+↵ off the Mac) sends from the text field, as Send does. */
const isSendKey = (event: KeyboardEvent): boolean => event.key === "Enter" && (event.metaKey || event.ctrlKey);

/** One attachment switch, with the line that says what it adds. */
function AttachSwitch({
  label,
  detail,
  checked,
  disabled,
  onChange,
  ...data
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
} & Record<`data-${string}`, boolean>): JSX.Element {
  const switchId = useId();
  return (
    <div className="flex items-center justify-between gap-3 text-dialog-body">
      <label htmlFor={switchId} className="flex min-w-0 flex-col">
        <span className="text-ink">{label}</span>
        <span className="text-ink-3 [overflow-wrap:anywhere]">{detail}</span>
      </label>
      <Switch id={switchId} checked={checked} disabled={disabled} onCheckedChange={onChange} {...data} />
    </div>
  );
}

export function FeedbackDialog({
  about,
  onSent,
  onDismiss,
}: {
  about: FeedbackAbout;
  onSent: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [appLogs, setAppLogs] = useState(false);
  const [attachChat, setAttachChat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0 && !busy;
  const send = (): void => {
    if (!canSend) return;
    setBusy(true);
    setFailed(false);
    void window.studio
      .sendFeedback({ text, screen: about.screen, appLogs, chatId: attachChat ? (about.chat?.id ?? null) : null })
      .then(() => {
        onSent();
        onDismiss();
      })
      .catch(() => {
        setFailed(true);
        setBusy(false);
      });
  };
  return (
    <DialogSurface
      testId="feedback-dialog"
      size="lg"
      title={FEEDBACK_WORDS.title}
      initialFocus={field}
      dismissible={!busy}
      onDismiss={onDismiss}
    >
      <textarea
        ref={field}
        data-feedback-text
        aria-label={FEEDBACK_WORDS.field}
        placeholder={FEEDBACK_WORDS.placeholder}
        maxLength={FEEDBACK_TEXT_MAX_CHARS}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (!isSendKey(event)) return;
          event.preventDefault();
          send();
        }}
        className="game-text-input field-sizing-content max-h-72 min-h-32 resize-none"
      />
      <div className="flex flex-col gap-3">
        <AttachSwitch
          data-feedback-app-logs
          label={FEEDBACK_WORDS.appLogs}
          detail={FEEDBACK_WORDS.appLogsDetail}
          checked={appLogs}
          disabled={busy}
          onChange={setAppLogs}
        />
        {about.chat && (
          <AttachSwitch
            data-feedback-chat
            label={FEEDBACK_WORDS.chat}
            detail={FEEDBACK_WORDS.chatDetail(about.chat.title)}
            checked={attachChat}
            disabled={busy}
            onChange={setAttachChat}
          />
        )}
      </div>
      {failed && (
        <p role="alert" className="text-xs text-red">
          {FEEDBACK_WORDS.failed}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onDismiss}>
          Cancel
        </Button>
        <Button
          data-feedback-send
          variant="default"
          disabled={!canSend}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onClick={send}
        >
          {busy ? FEEDBACK_WORDS.sending : FEEDBACK_WORDS.send}
        </Button>
      </div>
    </DialogSurface>
  );
}

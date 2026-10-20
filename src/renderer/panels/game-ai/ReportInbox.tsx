/**
 * The Player report inbox of the creator's own published game (owner decision D9): each report
 * players sent about what the AI wrote, and the automatic ones for replies that didn't fit the
 * game. Fix with agent saves a report's replay as one of the game's playtests and asks the game's
 * chat to replay it with `ai.replay`, find the cause and check its fix against the same playtest.
 * The player's note is shown to the creator here and never handed to the agent.
 */
import { type JSX, useCallback, useEffect, useState } from "react";
import { type AiReportFailure, type AiReportInboxItem, AiReportKind } from "../../../shared/game-ai-report.ts";
import { relativeTime } from "../../chat-labels.ts";
import { composeInChat } from "../../compose-in-chat.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { Icon } from "../../ui/icons.tsx";
import { REPORT_INBOX_WORDS } from "../../words.ts";

const WORDS = REPORT_INBOX_WORDS;

/** Where one report's Fix with agent stands. */
type FixState = { busy: true } | { sent: true } | { failure: AiReportFailure } | { problem: string };

/** What a report is about: the player's reason, or a reply that didn't fit. */
const reasonWords = (item: AiReportInboxItem): string =>
  item.kind === AiReportKind.Automatic || item.reason === null ? WORDS.automatic : WORDS.reasons[item.reason];

/** The inbox, read on open; null while reading. */
function useInbox(project: string) {
  const [items, setItems] = useState<AiReportInboxItem[] | null>(null);
  const [unread, setUnread] = useState(false);
  const read = useCallback(async () => {
    setUnread(false);
    try {
      setItems(await window.studio.gameAiInbox(project));
    } catch {
      setUnread(true);
    }
  }, [project]);
  useEffect(() => {
    void read();
  }, [read]);
  return { items, unread, read };
}

/** One report: why, when, the note, its AI moments, and Fix with agent. */
function ReportRow({
  item,
  fix,
  onFix,
}: {
  item: AiReportInboxItem;
  fix: FixState | undefined;
  onFix: () => void;
}): JSX.Element {
  const when = relativeTime(item.createdAt);
  const sent = fix && "sent" in fix;
  let line: string | null = null;
  if (fix && "failure" in fix) line = WORDS.failure[fix.failure];
  if (fix && "problem" in fix) line = fix.problem;
  return (
    <li className="ai-inbox-report" data-ai-report={item.id} data-ai-report-kind={item.kind}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ink">{reasonWords(item)}</span>
          <span className="shrink-0 text-micro text-ink-3">{when}</span>
        </span>
        {item.note && <span className="play-ai-report-note">{item.note}</span>}
        <span className="text-ink-3">
          {WORDS.moments(item.calls, item.invalid)}
          {item.model ? ` · ${WORDS.model(item.model)}` : ""}
        </span>
        {line && (
          <span role="alert" className="text-orange" data-ai-report-failure>
            {line}
          </span>
        )}
      </div>
      <Button
        aria-label={WORDS.fixLabel(reasonWords(item), when)}
        busy={fix !== undefined && "busy" in fix}
        disabled={sent}
        data-ai-report-fix={sent ? "sent" : ""}
        onClick={onFix}
      >
        {sent && <Icon name="check" size={14} className="text-green" />}
        {(sent && WORDS.sent) || (item.tape ? WORDS.fixAgain : WORDS.fix)}
      </Button>
    </li>
  );
}

/** Player reports for a game, over Create. */
export function ReportInbox({
  project,
  title,
  onClose,
}: {
  project: string;
  title: string;
  onClose: () => void;
}): JSX.Element {
  const { items, unread, read } = useInbox(project);
  const [fixes, setFixes] = useState<Record<string, FixState>>({});
  const fix = async (item: AiReportInboxItem) => {
    setFixes((all) => ({ ...all, [item.id]: { busy: true } }));
    try {
      const outcome = await window.studio.gameAiInboxFix(project, item.id);
      if (!outcome.ok) {
        setFixes((all) => ({ ...all, [item.id]: { failure: outcome.failure } }));
        return;
      }
      composeInChat({ project, text: WORDS.fixPrompt(outcome.tape, reasonWords(item), item.invalid), send: true });
      setFixes((all) => ({ ...all, [item.id]: { sent: true } }));
    } catch {
      setFixes((all) => ({ ...all, [item.id]: { problem: WORDS.unread } }));
    }
  };
  return (
    <DialogSurface
      title={WORDS.title(title)}
      description={WORDS.intro}
      onDismiss={onClose}
      size="lg"
      testId="report-inbox"
    >
      <div className="play-ai-inbox" data-report-inbox={items === null ? "loading" : items.length}>
        {items === null && !unread && (
          <p role="status" className="text-ink-3">
            {WORDS.loading}
          </p>
        )}
        {unread && (
          <p role="alert" className="text-ink-2">
            {WORDS.unread}{" "}
            <Button onClick={() => void read()} data-report-inbox-retry>
              {WORDS.retry}
            </Button>
          </p>
        )}
        {items?.length === 0 && <p className="text-ink-3">{WORDS.empty}</p>}
        {items && items.length > 0 && (
          <ul className="play-ai-reports">
            {items.map((item) => (
              <ReportRow key={item.id} item={item} fix={fixes[item.id]} onFix={() => void fix(item)} />
            ))}
          </ul>
        )}
        <div className="play-ai-dialog-presses">
          <Button variant="default" onClick={onClose}>
            {WORDS.close}
          </Button>
        </div>
      </div>
    </DialogSurface>
  );
}

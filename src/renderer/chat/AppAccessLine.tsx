/** Genex can't see app windows yet: one quiet line naming what to allow, with a button per missing pane. */
import type { JSX } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import type { AppLookAccessKind } from "../../shared/jobs.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { ResultButton } from "../ui/ResultButton.tsx";
import { openPaneSettings, privacySettingsTitle, TRANSCRIPT_WORDS } from "../words.ts";

/**
 * "Genex can't see app windows yet: allow Screen Recording for Genex in System Settings." with
 * Open Privacy settings, which opens macOS System Settings at that pane. With two panes missing,
 * each button names its pane.
 */
export function AppAccessLine({
  entry,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.Action }>;
  onNotice: Notify;
}): JSX.Element {
  const panes = entry.appAccess ?? [];
  const open = (pane: AppLookAccessKind) => () => {
    void window.studio.openPrivacySettings(pane).catch(notifyProblem(onNotice));
  };
  return (
    <div data-app-access className="min-w-0 text-chat text-ink-3 [overflow-wrap:anywhere]">
      <span>{entry.text}</span>
      {/* A space before each button, not a margin: at a line break it collapses, so a wrapped button starts flush. */}
      {panes.map((pane) => (
        <span key={pane}>
          {" "}
          <ResultButton type="button" className="align-middle" title={privacySettingsTitle(pane)} onClick={open(pane)}>
            {panes.length > 1 ? openPaneSettings(pane) : TRANSCRIPT_WORDS.openPrivacySettings}
          </ResultButton>
        </span>
      ))}
    </div>
  );
}

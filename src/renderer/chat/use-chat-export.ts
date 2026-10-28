/**
 * The chat header's export: copy a game's public files out, one export at a time, and say what
 * was included.
 */
import { useRef, useState } from "react";
import type { ExportResult } from "../../shared/game-project.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { gameRef } from "../analytics/game-ref.ts";
import { exportFinishedProperties } from "../analytics/workspace-properties.ts";
import { type Notify, notifyProblem, ToastTone } from "../state/toasts.ts";
import { exportedWords } from "../words.ts";

export interface ChatExport {
  /** An export is running. */
  exporting: boolean;
  /** The header's handler for a game's export; a second click while one runs does nothing. */
  exportGame(project: string): () => void;
}

export function useChatExport(onNotice: Notify): ChatExport {
  const [exporting, setExporting] = useState(false);
  // A ref as well as the state: two clicks in one frame both see the state before it changes.
  const pending = useRef(false);
  const exportGame = (project: string) => () => {
    if (pending.current) return;
    pending.current = true;
    setExporting(true);
    const startedAt = Date.now();
    // How it ended, as counts and a duration (never the files it names or where it wrote them).
    const finished = (result: ExportResult | null, failure: unknown = null): void =>
      track(
        AnalyticsEvent.GameExportFinished,
        exportFinishedProperties(result, { startedAt, at: Date.now(), ref: gameRef(project) }, failure),
      );
    void window.studio
      .exportGame(project)
      .then((result) => {
        finished(result);
        onNotice(exportedWords(result), ToastTone.Ok);
      })
      .catch((error: unknown) => {
        finished(null, error);
        notifyProblem(onNotice)(error);
      })
      .finally(() => {
        pending.current = false;
        setExporting(false);
      });
  };
  return { exporting, exportGame };
}

/** An agent went ahead of the person in an app they were using: one quiet line, with that plugin's settings. */
import type { JSX } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { openPluginSetup } from "../plugin-setup.ts";
import { ResultButton } from "../ui/ResultButton.tsx";
import { TRANSCRIPT_WORDS } from "../words.ts";

/**
 * "An agent used Unity while you were playing." with Unity settings, which opens the plugin's panel
 * where the person chooses whether agents may use it while they play.
 */
export function WentAheadLine({ entry }: { entry: Extract<Entry, { kind: typeof EntryKind.Action }> }): JSX.Element {
  const ahead = entry.wentAhead;
  return (
    <div data-went-ahead className="min-w-0 text-chat text-ink-3 [overflow-wrap:anywhere]">
      <span>{entry.text}</span>
      {/* A space, not a margin: at a line break it collapses, so a wrapped button starts flush. */}
      {ahead ? " " : null}
      {ahead ? (
        <ResultButton
          type="button"
          className="align-middle"
          title={TRANSCRIPT_WORDS.wentAheadSettingsTitle(ahead.label)}
          onClick={() => openPluginSetup(ahead.pluginId)}
        >
          {TRANSCRIPT_WORDS.wentAheadSettings(ahead.label)}
        </ResultButton>
      ) : null}
    </div>
  );
}

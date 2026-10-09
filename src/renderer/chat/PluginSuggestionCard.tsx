/**
 * The turn-it-on card a session showed in the chat for a Genex plugin (`plugins_suggest`): the
 * plugin, why the agent suggests it, and one button from the live plugin list (Turn on, Install…,
 * or On once it is). Built like the engine steps card; only this click turns a plugin on.
 */
import { type JSX, useState } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { usePlugins } from "../state/hooks.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { PLUGIN_SUGGESTION_WORDS } from "../words.ts";
import { SuggestionState, suggestionFolders, suggestionShown, suggestionState } from "./plugin-suggestion.ts";

/** The card's one button, or the word On once the plugin is on. */
function SuggestionButton({ pluginId, onNotice }: { pluginId: string; onNotice: Notify }): JSX.Element {
  const state = usePlugins((s) => suggestionState(s.list, pluginId));
  const [busy, setBusy] = useState(false);
  if (state === SuggestionState.On)
    return <span className="text-chat-sub text-ink-3">{PLUGIN_SUGGESTION_WORDS.on}</span>;
  const press = () => {
    if (busy) return;
    setBusy(true);
    // Install asks the person to review the plugin first, in Genex's own dialog.
    const act =
      state === SuggestionState.TurnOn
        ? window.studio.pluginEnable(pluginId, true)
        : window.studio.pluginInstall(pluginId);
    void act.catch(notifyProblem(onNotice)).finally(() => setBusy(false));
  };
  return (
    <Button size="sm" variant="secondary" disabled={busy} onClick={press}>
      {state === SuggestionState.TurnOn ? PLUGIN_SUGGESTION_WORDS.turnOn : PLUGIN_SUGGESTION_WORDS.install}
    </Button>
  );
}

/** A session's suggestion of a Genex plugin, in the transcript. */
export function PluginSuggestionCard({
  entry,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.PluginSuggestion }>;
  onNotice: Notify;
}): JSX.Element {
  const { suggestion } = entry;
  // Two string reads: a selector answering a new object each time would never settle.
  const name = usePlugins((s) => suggestionShown(s.list, suggestion).name);
  const description = usePlugins((s) => suggestionShown(s.list, suggestion).description);
  const folders = usePlugins((s) => suggestionFolders(s.list, suggestion.pluginId));
  const titleId = `plugin-suggestion-${entry.id}`;
  return (
    <section data-plugin-suggestion={suggestion.pluginId} aria-labelledby={titleId} className="chat-question">
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <h3 id={titleId} className="text-chat font-medium">
          {PLUGIN_SUGGESTION_WORDS.title(name)}
        </h3>
        {suggestion.reason ? <p className="mt-0.5 text-chat text-ink-2">{suggestion.reason}</p> : null}
        {description ? <p className="mt-0.5 text-chat-sub text-ink-3">{description}</p> : null}
        {folders ? <p className="mt-0.5 text-chat-sub text-ink-3">{folders}</p> : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-chat-sub text-ink-3">{PLUGIN_SUGGESTION_WORDS.onlyYou}</span>
          <SuggestionButton pluginId={suggestion.pluginId} onNotice={onNotice} />
        </div>
      </div>
    </section>
  );
}

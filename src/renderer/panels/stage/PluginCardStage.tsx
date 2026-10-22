/**
 * Live for a game a plugin's engine plays (`ObserverLive.Card`), drawn as the Unreal card is: the
 * latest play shot, the game's name, where it stands and one step. Where it stands is the plugin's
 * own answer to the status action its observer names, asked every few seconds while the card shows
 * and read through `stageCardFrom`, so a plugin says only a line, a hint and one of its declared
 * actions (or its panel). Before the first answer, or with the plugin off, the card names the game
 * and the engine it plays in.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { isUserCancelled } from "../../../shared/errors.ts";
import { type PluginStageButton, type PluginStageCard, stageCardFrom } from "../../../shared/plugin-stage-card.ts";
import type { PluginInfo } from "../../../shared/plugins.ts";
import { runPluginAction } from "../../plugin-actions.ts";
import { openPluginSetup } from "../../plugin-setup.ts";
import { type StatusPoll, startStatusPoll } from "../../status-poll.ts";
import { type Notify, ToastTone } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { PLUGIN_CARD_WORDS, problemWords } from "../../words.ts";

/** How often the card asks the plugin where the game stands; the Unreal card asks as often. */
const STATUS_POLL_MS = 3 * SECOND_MS;

/** The plugin drawing an observer's card and the action it answers its status with; null when it is not on. */
function cardSource(plugins: readonly PluginInfo[], observer: string | null) {
  const [pluginId, observerId] = observer?.split("/") ?? [];
  const plugin = plugins.find((p) => p.manifest.id === pluginId) ?? null;
  const status = plugin?.manifest.observers?.find((o) => o.id === observerId)?.status;
  if (!plugin?.enabled || !status) return null;
  return { plugin, status, actions: new Set(plugin.manifest.actions.map((a) => a.name)) };
}

type CardSource = NonNullable<ReturnType<typeof cardSource>>;

/**
 * The plugin's card for this game, asked every few seconds while it shows, one ask at a time; null
 * before its first answer. A new game restarts the asking and drops the last game's answers; a new
 * plugin list restarts it only when the plugin, its status action or its actions changed.
 */
function usePluginCard(source: CardSource | null, game: string) {
  const [card, setCard] = useState<{ game: string; card: PluginStageCard | null }>({ game, card: null });
  const poll = useRef<StatusPoll | null>(null);
  const pluginId = source?.plugin.manifest.id;
  const status = source?.status;
  const actions = source ? [...source.actions].join("\n") : "";
  useEffect(() => {
    if (!pluginId || !status) return;
    const declared = new Set(actions.split("\n"));
    const ask = () => window.studio.pluginAction(pluginId, status, {}, game).catch(() => null);
    const read = startStatusPoll(
      ask,
      (answer) => setCard({ game, card: stageCardFrom(answer, declared) }),
      STATUS_POLL_MS,
    );
    poll.current = read;
    return () => {
      read.stop();
      if (poll.current === read) poll.current = null;
    };
  }, [pluginId, status, actions, game]);
  const refresh = useCallback(() => poll.current?.refresh() ?? Promise.resolve(), []);
  return { card: card.game === game ? card.card : null, refresh };
}

/** Runs the card's step: the plugin's panel, or its action for this game (a confirmed one asks natively first). */
async function press(source: CardSource, button: PluginStageButton, game: string): Promise<void> {
  if ("panel" in button) {
    openPluginSetup(source.plugin.manifest.id);
    return;
  }
  const review = ({ resolve }: { resolve: (yes: boolean) => void }) => resolve(false);
  await runPluginAction({ plugin: source.plugin, name: button.action, args: {}, project: game, review });
}

/** Live's card for a game a plugin's engine plays: its latest shot, its name, the plugin's line and one step. */
export function PluginCardStage({
  game,
  observer,
  plugins,
  shot,
  onNotice,
}: {
  game: { name: string; title: string };
  /** The card's observer key, `<plugin>/<observer>`. */
  observer: string | null;
  plugins: PluginInfo[];
  /** The latest play shot's URL; none until a run keeps one. */
  shot: string | null;
  onNotice: Notify;
}): JSX.Element {
  // The plugin list is a new array on each change, so the source is too; the poll keys on what it asks.
  const source = useMemo(() => cardSource(plugins, observer), [plugins, observer]);
  const { card, refresh } = usePluginCard(source, game.name);
  const [busy, setBusy] = useState(false);
  const pluginName = plugins.find((p) => p.manifest.id === observer?.split("/")[0])?.manifest.name ?? "";
  const button = card?.button;
  const run = async (step: PluginStageButton) => {
    if (!source) return;
    setBusy(true);
    try {
      await press(source, step, game.name);
    } catch (err) {
      if (!isUserCancelled(err)) onNotice(problemWords(err), ToastTone.Error);
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  return (
    <div
      data-stage-plugin-card={observer ?? ""}
      className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8"
    >
      <div className="flex w-full max-w-[560px] flex-col items-center text-center">
        {shot ? (
          <img
            data-plugin-card-shot=""
            src={shot}
            alt={PLUGIN_CARD_WORDS.playShot(game.title)}
            className="aspect-video w-full rounded-lg border border-line object-cover"
          />
        ) : null}
        <h2 className="empty-state-title max-w-full" title={game.title}>
          {game.title}
        </h2>
        {/* One line tall even before the first answer, so the line arriving moves nothing. */}
        <p className="empty-state-subtitle min-h-lh max-w-full" role="status">
          {card?.line ?? (pluginName ? PLUGIN_CARD_WORDS.waiting(pluginName) : "")}
        </p>
        {card?.hint ? <p className="empty-state-subtitle max-w-full">{card.hint}</p> : null}
        {button ? (
          <div className="empty-state-slot">
            <Button data-plugin-card-button="" variant="default" disabled={busy} onClick={() => void run(button)}>
              {button.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

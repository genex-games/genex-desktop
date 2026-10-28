/**
 * The buttons plugins contribute at the end of the stage strip, dressed as the app's own
 * buttons, and Studio's own Multiplayer and Publish for every web game. Genex's Publish stays while
 * Genex is off: it belongs to the account, not to the agent's tools. Which buttons exist is the manifest's (`toolbarItems`); what they say is the plugin's status action or a `plugin.event` of kind
 * `toolbar`, both sanitized before they reach the DOM. A panel target opens its own dialog over
 * the stage (and says so, so the native game view gets out of the way); an action target runs
 * the same review → ticket → native approval sequence as the Plugins dialog. While Studio bundles
 * a newer version of the plugin, its buttons say Update instead and open Plugins at it.
 */
import type { Dispatch, JSX, SetStateAction } from "react";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SECOND_MS } from "../../shared/duration.ts";
import { GENEX_PLUGIN_ID, GENEX_PUBLISH_PANEL } from "../../shared/genex.ts";
import { t } from "../../shared/i18n.ts";
import type { FactRef, FolderHolds, GameKind } from "../../shared/project-facts.ts";
import {
  type PluginToolbarEntry,
  shownToolbarStatus,
  toolbarReaction,
  toolbarStatusFrom,
  MultiplayerPress,
  multiplayerPress,
  showsMultiplayer,
  takesEngineMultiplayer,
  ToolbarPlace,
  toolbarPlace,
  toolbarTip,
  toolbarUpdateStatus,
  visibleToolbarEntries,
} from "../../shared/plugin-toolbar.ts";
import {
  isToolbarIconName,
  type PluginInfo,
  type PluginPanelDocument,
  type PluginToolbarStatus,
} from "../../shared/plugins.ts";
import {
  ActionOutcome,
  actionOutcome,
  isPluginsOpenedFrom,
  notePluginsOpening,
  PluginAction,
  PluginsOpenedFrom,
  PluginSurface,
  reportPluginAction,
} from "../analytics/plugins-page.ts";
import { composeInChat } from "../compose-in-chat.ts";
import { type PluginReviewRequest, runPluginAction } from "../plugin-actions.ts";
import { PLUGIN_SETUP_EVENT } from "../plugin-setup.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import { createRefresher } from "../state/refresher.ts";
import { Button } from "../ui/Button.tsx";
import { cn } from "../ui/cn.ts";
import { openPluginsAt } from "../ui/ComposerAddMenu.tsx";
import { Icon } from "../ui/icons.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { GENEX_WORDS, PLUGIN_TOOLBAR_WORDS, problemWords } from "../words.ts";
import { GenexPublishDialog, GenexSetupDialog, PublishSignInDialog } from "./plugins/genex/GenexPublish.tsx";
import { webFolderOf } from "../../shared/project-workspace.ts";
import { isGenexPublish, publishesWeb, stripEntries, studioPublishButton } from "./plugins/genex/genex-publish-view.ts";
import { PublishTarget } from "../../shared/publish-platforms.ts";
import { RobloxPublish } from "./plugins/roblox/RobloxPublish.tsx";
import { robloxPublishShown } from "./plugins/roblox/roblox-publish-view.ts";
import { makesApps } from "./plugins/genex/publish-platforms-view.ts";
import { useAsyncEffect } from "../use-async-effect.ts";
import { useCoverAfterTurns } from "./plugins/genex/use-cover-after-turns.ts";
import { PluginApproval } from "./PluginApproval.tsx";
import { PluginPanelDialog } from "./PluginPanelDialog.tsx";
import { useEngineSlot } from "./engine-slot.ts";
import { errorCode, isUserCancelled } from "../../shared/errors.ts";

/** Status refreshes coalesce: a burst of change events wakes each plugin's process once. */
const STATUS_DEBOUNCE_MS = SECOND_MS;
/** And while a project is open the badge is re-asked on its own, without any event. */
const STATUS_TICK_MS = 30 * SECOND_MS;
/** Each tone's badge colour. Info, the quiet word, uses the second ink, which reads at 4.5:1 on the pill in every theme. */
const TONE_CLASS: Record<NonNullable<PluginToolbarStatus["tone"]>, string> = {
  ok: "text-green",
  warn: "text-orange",
  err: "text-red",
  info: "text-ink-2",
};
/** Each tone's dot, for a badge drawn as one: green, amber, red, and the third ink for the quiet grey. */
const DOT_CLASS: Record<NonNullable<PluginToolbarStatus["tone"]>, string> = {
  ok: "bg-green",
  warn: "bg-orange",
  err: "bg-red",
  info: "bg-ink-3",
};

interface Props {
  plugins: PluginInfo[];
  project: string | null;
  /** What the open game's folder holds: only a game served as a web game gets Publish (`stripEntries`). */
  facts: readonly FactRef[];
  /** With no facts, what the folder holds: one of a kind Genex can't name gets no Publish. */
  holds?: FolderHolds | undefined;
  /** The game has nothing in it yet: no button's action can be due, so none takes the accent. */
  emptyGame: boolean;
  /** What Multiplayer needs to know of the game: built at least once, and multiplayer already. */
  game: GameMultiplayer;
  onNotice: Notify;
  /** A panel dialog is on screen — the stage zeroes the native view while it is. */
  onOpenChange: (open: boolean) => void;
}

/** A panel open over the stage: the plugin's own document in its frame, or (`drawn`) one Studio draws itself. */
type ToolbarPanel = {
  key: string;
  plugin: PluginInfo;
  title: string;
  document: PluginPanelDocument | null;
  drawn?: boolean;
};

/** Genex's Publish panel, which Studio draws in its own type and buttons instead of the plugin's frame. */
const drawnByStudio = (plugin: PluginInfo, panelId: string): boolean =>
  plugin.manifest.id === GENEX_PLUGIN_ID && panelId === GENEX_PUBLISH_PANEL;

/**
 * Each button's status — badge, tone, title, disabled — asked of its plugin after a quiet
 * moment, again every so often while a game is open, whenever a plugin says it changed, and when
 * the open game's own record changes (a status may follow its engine link).
 */
function useToolbarStatus(entriesRef: { current: PluginToolbarEntry[] }, membership: string, project: string | null) {
  const [status, setStatus] = useState<Record<string, PluginToolbarStatus>>({});
  const refreshRef = useRef<() => void>(() => {});
  const projectRef = useRef(project);
  projectRef.current = project;
  // A status belongs to the game it was asked for: another game's word is never left standing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching games is the trigger
  useEffect(() => setStatus((current) => (Object.keys(current).length > 0 ? {} : current)), [project]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: membership stands for the entries, read through their ref
  useEffect(() => {
    const watcher = watchToolbarStatus(entriesRef, project, (results) => {
      setStatus((current) => {
        const next: Record<string, PluginToolbarStatus> = {};
        for (const [key, value] of results) next[key] = value ?? current[key] ?? {};
        return next;
      });
    });
    refreshRef.current = watcher.refresh;
    return () => {
      watcher.stop();
      refreshRef.current = () => {};
    };
  }, [membership, project]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribed once; entries and the refresh are read through refs
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        const change = toolbarReaction(event, entriesRef.current, projectRef.current);
        if (change === "refresh") refreshRef.current();
        else if (change)
          setStatus((current) => ({ ...current, [change.key]: { ...current[change.key], ...change.update } }));
      }),
    [],
  );
  return { status, refreshRef };
}

/** Keep the toolbar's statuses fresh until its game or plugin membership changes, or it unmounts. */
export function watchToolbarStatus(
  entriesRef: { current: PluginToolbarEntry[] },
  project: string | null,
  received: (results: Array<readonly [string, PluginToolbarStatus | null]>) => void,
) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reader = createRefresher(() => {
    const wanted = entriesRef.current.flatMap((e) => (e.item.status ? [{ entry: e, action: e.item.status }] : []));
    return Promise.all(
      wanted.map(
        async ({ entry, action }) =>
          [
            entry.key,
            toolbarStatusFrom(
              await window.studio
                .pluginAction(entry.plugin.manifest.id, action, {}, project ?? undefined)
                .catch(() => null),
            ),
          ] as const,
      ),
    );
  }, received);
  const schedule = () => {
    if (cancelled || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void reader.request();
    }, STATUS_DEBOUNCE_MS);
  };
  schedule();
  const tick = project ? setInterval(schedule, STATUS_TICK_MS) : null;
  return {
    refresh: schedule,
    stop() {
      cancelled = true;
      reader.reset();
      if (timer) clearTimeout(timer);
      if (tick) clearInterval(tick);
    },
  };
}

/** What a finished action says: its own message when it returned one, else that it is done. */
function actionMessage(result: unknown, label: string): string {
  const message = result && typeof result === "object" ? (result as { message?: unknown }).message : undefined;
  return typeof message === "string" ? message : t("{action}: done", { action: label });
}

/** A button's glyph: one of the app's icons, the plugin's own character, or none. */
function ToolbarIcon({ icon }: { icon: string | undefined }): JSX.Element | null {
  if (isToolbarIconName(icon)) return <Icon name={icon} />;
  return icon ? <span aria-hidden="true">{icon}</span> : null;
}

/**
 * A button's badge: the update mark while its plugin is behind, else its status's word in its tone,
 * or (`dot`) a dot in that tone whose word only screen readers hear. In the chat header a word also
 * carries its dot, which stands in for it while the header folds the button to its icon (theme.css).
 */
function ToolbarBadge({
  id,
  update,
  status,
  place,
}: {
  id: string;
  update: boolean;
  status: PluginToolbarStatus | undefined;
  place: ToolbarPlace;
}): JSX.Element | null {
  if (update) return <UpdateMark id={id} word={PLUGIN_TOOLBAR_WORDS.update.badge} />;
  if (!status?.badge) return null;
  const tone = status.tone ?? "info";
  if (status.dot) {
    return (
      <span id={id} data-plugin-badge data-dot={tone} className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])}>
        <span className="sr-only">{status.badge}</span>
      </span>
    );
  }
  return (
    <>
      <span
        id={id}
        data-plugin-badge
        className={cn("text-micro", status.tone ? TONE_CLASS[status.tone] : "text-ink-2")}
      >
        {status.badge}
      </span>
      {place === ToolbarPlace.Header ? (
        <span data-fold-dot={tone} aria-hidden className={cn("hidden size-1.5 rounded-full", DOT_CLASS[tone])} />
      ) : null}
    </>
  );
}

/** How a strip button is dressed: Publish in Play's blue, filled once due; any other in the quiet pill, the accent once due. */
function toolbarLook(publish: boolean, due: boolean) {
  if (publish) return due ? "play-fill" : "play-tint";
  return due ? "default" : "pill";
}

/**
 * A toolbar button with its tooltip: on the strip beside it rather than below (a tooltip under the
 * strip would sit behind the native game view), in the chat header below it, over the chat.
 */
function ToolbarTip({
  lines,
  tip,
  place,
  children,
}: {
  lines: string[];
  tip?: string;
  place: ToolbarPlace;
  children: JSX.Element;
}): JSX.Element {
  const [heading, ...rest] = lines;
  if (!heading) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={place === ToolbarPlace.Header ? "bottom" : "left"}
        sideOffset={6}
        data-plugin-toolbar-tip={tip}
      >
        {heading}
        {rest.map((line) => (
          <span key={line} className="block max-w-72 opacity-75">
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** An engine's button in the chat header: the strip's button a step smaller, its name folding away when the header is narrow. */
const HEADER_BUTTON = "relative px-2.5 text-body-sm has-[>svg]:px-2.5";

/**
 * A plugin's button: the accent while its status says its action is due, the quiet pill otherwise;
 * Publish wears its tint instead, filled while there is something to publish (`toolbarLook`).
 * While its plugin is behind the bundled version it wears the Update badge instead, and then it
 * opens Plugins at the plugin, game or not. Its title, and a dot's word, show in its own tooltip.
 * An engine's button stands in the chat header (`place`), the rest on the strip.
 */
function ToolbarButton({
  entry,
  status: own,
  project,
  busy,
  due,
  place,
  onPress,
}: {
  entry: PluginToolbarEntry;
  status: PluginToolbarStatus | undefined;
  project: string | null;
  busy: boolean;
  due: boolean;
  place: ToolbarPlace;
  onPress: () => void;
}): JSX.Element {
  const badgeId = useId();
  const update = toolbarUpdateStatus(entry.plugin, PLUGIN_TOOLBAR_WORDS.update);
  const status = shownToolbarStatus(own, update);
  const needsGame = entry.item.requiresProject !== false && !project;
  // Updating needs no game and isn't the plugin's own action, so nothing the plugin says holds it back.
  const blocked = update ? false : Boolean(status?.disabled) || needsGame;
  const disabled = blocked || busy;
  const press = update ? () => openPluginsFromToolbar(entry.plugin.manifest.id) : onPress;
  return (
    <ToolbarTip lines={toolbarTip(status)} tip={entry.key} place={place}>
      <Button
        variant={toolbarLook(isGenexPublish(entry), due)}
        data-due={due ? "" : undefined}
        data-plugin-toolbar={entry.key}
        // Labels and status come from the plugin and can quote the person's work.
        data-analytics-mask
        aria-label={entry.item.ariaLabel}
        // The label names the button; the badge, its state, is read after it ("Unreal Editor, Ready").
        aria-describedby={status?.badge ? badgeId : undefined}
        disabled={disabled}
        onClick={press}
        className={place === ToolbarPlace.Header ? HEADER_BUTTON : undefined}
      >
        <ToolbarIcon icon={entry.item.icon} />
        <span data-toolbar-label>{entry.item.label}</span>
        <ToolbarBadge id={badgeId} update={Boolean(update)} status={status} place={place} />
      </Button>
    </ToolbarTip>
  );
}

/** What a press reaches: the open project, the toast channel, and the toolbar's own state. */
interface PressDeps {
  project: string | null;
  onNotice: Notify;
  refreshRef: { current: () => void };
  setPanel: (panel: ToolbarPanel) => void;
  setReview: (review: PluginReviewRequest) => void;
  setBusy: Dispatch<SetStateAction<string | null>>;
}

/** Open a button's panel over the stage (Genex's Publish is Studio's own dialog); a panel that fails to open is toasted. */
async function openToolbarPanel(entry: PluginToolbarEntry, panelId: string, deps: PressDeps): Promise<void> {
  const { plugin } = entry;
  if (drawnByStudio(plugin, panelId)) {
    deps.setPanel({ key: entry.key, plugin, title: GENEX_WORDS.publish.title, document: null, drawn: true });
    return;
  }
  const press = { action: PluginAction.PanelOpened, plugin, surface: PluginSurface.Toolbar };
  const started = performance.now();
  try {
    const doc = await window.studio.pluginPanel(plugin.manifest.id, panelId);
    deps.setPanel({ key: entry.key, plugin, title: doc.title, document: doc });
    reportPluginAction(press, ActionOutcome.Ok, started, performance.now());
  } catch (err) {
    deps.onNotice(problemWords(err), ToastTone.Error, errorCode(err));
    reportPluginAction(press, ActionOutcome.Failed, started, performance.now(), err);
  }
}

/** Run a button's action through review and approval: what it did is toasted, a no in either says nothing. */
async function runToolbarAction(
  entry: PluginToolbarEntry,
  action: { name: string; args?: unknown },
  deps: PressDeps,
): Promise<void> {
  const { plugin, item } = entry;
  deps.setBusy(entry.key);
  const press = { action: PluginAction.ToolbarAction, plugin, surface: PluginSurface.Toolbar };
  const started = performance.now();
  // Whether the person turned the pictures down in Studio's own review, before any native dialog.
  let reviewDeclined = false;
  const review = (request: PluginReviewRequest): void =>
    deps.setReview({
      ...request,
      resolve: (yes) => {
        reviewDeclined = !yes;
        request.resolve(yes);
      },
    });
  try {
    const result = await runPluginAction({
      plugin,
      name: action.name,
      args: action.args ?? {},
      project: deps.project,
      review,
    });
    deps.onNotice(actionMessage(result, item.label), ToastTone.Ok);
    deps.refreshRef.current();
    reportPluginAction(press, ActionOutcome.Ok, started, performance.now());
  } catch (err) {
    // The person's no, in Studio's review or the native dialog, says nothing.
    if (!isUserCancelled(err)) deps.onNotice(problemWords(err), ToastTone.Error, errorCode(err));
    const outcome = reviewDeclined ? ActionOutcome.DeclinedReview : actionOutcome(err, true);
    reportPluginAction(press, outcome, started, performance.now(), err);
  } finally {
    deps.setBusy((current) => (current === entry.key ? null : current));
  }
}

/** Press a button: open its panel over the stage, or run its action through review and approval. */
function usePress({ project, onNotice, refreshRef, setPanel, setReview, setBusy }: PressDeps) {
  return useCallback(
    async (entry: PluginToolbarEntry) => {
      const deps = { project, onNotice, refreshRef, setPanel, setReview, setBusy };
      const { target } = entry.item;
      if (target.kind === "panel") await openToolbarPanel(entry, target.id, deps);
      else await runToolbarAction(entry, target, deps);
    },
    [project, onNotice, refreshRef, setPanel, setReview, setBusy],
  );
}

/**
 * Publish for every open web game: while no Genex is installed, Studio's own button opens a dialog
 * that signs in (which brings Genex back), and once Genex's own Publish is there it takes over.
 */
function useStudioPublish(
  plugins: PluginInfo[],
  project: string | null,
  { facts, holds, apps }: { facts: readonly FactRef[]; holds: FolderHolds | undefined; apps: boolean },
  genexPublish: PluginToolbarEntry | undefined,
) {
  const [setup, setSetup] = useState(false);
  const shown = studioPublishButton(plugins, project, facts, holds, apps);
  useEffect(() => {
    if (setup && !project) setSetup(false);
  }, [setup, project]);
  const open = useCallback(() => setSetup(true), []);
  const close = useCallback(() => setSetup(false), []);
  // Genex came back while its dialog was up: Genex's own Publish is what to open now.
  const handOff = setup && genexPublish ? genexPublish : null;
  return { shown, setup: setup && shown, open, close, handOff };
}

/**
 * Multiplayer, left of Publish on every game that gets Publish. With Genex on, one press asks the
 * game's chat to make it multiplayer; without it, the setup dialog brings Genex in first, and the
 * ask goes out the moment Genex is on. While Studio bundles a newer Genex, the press opens Plugins
 * at Genex first, as Publish's does: an older Genex's instructions refuse a game made from the template.
 */
/** A second Multiplayer press within this long is the same press. */
const REPEAT_PRESS_MS = 1.5 * SECOND_MS;

/** A button's Update: Plugins opens at the plugin, and usage analytics hears it came from the toolbar. */
function openPluginsFromToolbar(id: string): void {
  notePluginsOpening(PluginsOpenedFrom.ToolbarUpdate);
  openPluginsAt(id);
}

function useMultiplayer(project: string | null, shown: boolean, genex: PluginToolbarEntry | undefined) {
  const genexOn = Boolean(genex);
  const behind = genex ? toolbarUpdateStatus(genex.plugin, PLUGIN_TOOLBAR_WORDS.update) : null;
  const pressed = multiplayerPress(genex?.plugin);
  const [setup, setSetup] = useState(false);
  const asked = useRef(Number.NEGATIVE_INFINITY);
  const ask = useCallback(() => {
    // A double click is one press: the chat gets the request once.
    if (!project || performance.now() - asked.current < REPEAT_PRESS_MS) return;
    asked.current = performance.now();
    composeInChat({ project, text: GENEX_WORDS.multiplayer.prompt, send: true });
  }, [project]);
  const press = useCallback(() => {
    if (pressed === MultiplayerPress.Update) openPluginsFromToolbar(GENEX_PLUGIN_ID);
    else if (pressed === MultiplayerPress.Ask) ask();
    else setSetup(true);
  }, [pressed, ask]);
  const close = useCallback(() => setSetup(false), []);
  // Genex came on while its dialog was up: the press goes on as it would now, Update first for an older Genex.
  useEffect(() => {
    if (!setup || !genexOn) return;
    setSetup(false);
    press();
  }, [setup, genexOn, press]);
  useEffect(() => {
    if (setup && !shown) setSetup(false);
  }, [setup, shown]);
  return { press, setup: setup && shown, close, behind };
}

/**
 * A plugin behind the version Studio bundles: a small rising arrow in the button's own ink, the word
 * ("Update") read by assistive tech and the button's title saying what pressing does.
 */
function UpdateMark({ id, word }: { id: string; word: string }): JSX.Element {
  return (
    <span id={id} data-plugin-badge data-plugin-update role="img" aria-label={word} className="inline-flex opacity-80">
      <Icon name="update" size={14} />
    </span>
  );
}

/** Multiplayer: quiet like Publish beside it, since neither is the game's next step until asked. */
function MultiplayerButton({
  onPress,
  behind = null,
}: {
  onPress: () => void;
  /** Genex is older than the one Studio bundles: the button says Update, as Genex's own buttons do. */
  behind?: PluginToolbarStatus | null;
}): JSX.Element {
  const badgeId = useId();
  const label = GENEX_WORDS.multiplayer.button;
  return (
    <Button
      variant="pill"
      data-genex-multiplayer
      aria-label={GENEX_WORDS.multiplayer.buttonLabel}
      aria-describedby={behind ? badgeId : undefined}
      title={behind?.title}
      onClick={onPress}
    >
      <Icon name="users" />
      <span>{label}</span>
      {behind ? <UpdateMark id={badgeId} word={PLUGIN_TOOLBAR_WORDS.update.badge} /> : null}
    </Button>
  );
}

/** Studio's own Publish, dressed as Genex's: Play's blue tint, since nobody has published from this Mac yet. */
function StudioPublishButton({ onPress }: { onPress: () => void }): JSX.Element {
  return (
    <Button variant="play-tint" data-studio-publish aria-label={GENEX_WORDS.publish.buttonLabel} onClick={onPress}>
      <Icon name="globe" />
      <span>{GENEX_WORDS.publish.button}</span>
    </Button>
  );
}

/**
 * Whether a game that is not a web game has an app Publish can send (a Unity or Unreal game built for
 * the Mac), read from its folder once per game; a web game never asks.
 */
function useReadyApps(project: string | null, web: boolean): boolean {
  const [apps, setApps] = useState(false);
  useAsyncEffect(
    (alive) => {
      setApps(false);
      if (!project || web) return undefined;
      void window.studio
        .genexPublishPlatforms(project)
        .then((rows) => {
          if (alive()) setApps(rows.some((row) => row.target !== PublishTarget.Web && row.uploads));
        })
        .catch(() => {});
      return undefined;
    },
    [project, web],
  );
  return apps;
}

/**
 * Publish for a Roblox game, where no other Publish stands: its card hands the publish to the game's
 * agent. `card` is the game the card is open for.
 */
function useRobloxPublish(plugins: PluginInfo[], project: string | null, facts: readonly FactRef[], other: boolean) {
  const [opened, setOpened] = useState(false);
  const shown = !other && robloxPublishShown(plugins, project, facts);
  const open = useCallback(() => setOpened(true), []);
  const close = useCallback(() => setOpened(false), []);
  return { shown, card: opened && shown ? project : null, open, close };
}

/** The strip's plugin buttons, with whether the game publishes as a web game or has ready apps to publish. */
function useStripEntries(
  plugins: PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
) {
  const web = publishesWeb(facts, holds);
  // A Unity, Godot or Unreal game gets Publish for its apps: its dialog says what it needs first.
  const engine = !web && makesApps(facts);
  const ready = useReadyApps(project, web || engine);
  const apps = engine || ready;
  const entries = useMemo(
    () => stripEntries(plugins, project, facts, holds, apps),
    [plugins, project, facts, holds, apps],
  );
  return { entries, web, apps };
}

/** What Multiplayer needs to know of the open game (`GameProject.awaitingFirstBuild`, `.multiplayer`). */
export interface GameMultiplayer {
  builtOnce: boolean;
  multiplayer: boolean;
}

/**
 * Whether Multiplayer stands on the strip for this game (`showsMultiplayer`): on an engine's web
 * export only when its engine's project takes Genex's multiplayer (a Godot game).
 */
const multiplayerOn = (publish: boolean, emptyGame: boolean, game: GameMultiplayer, kind: GameKind): boolean =>
  showsMultiplayer({
    publish,
    emptyGame,
    ...game,
    webExport: webFolderOf(kind) !== null,
    engineMultiplayer: takesEngineMultiplayer(kind),
  });

/** A chat card or a stage card asks for a plugin's setup (`openPluginSetup`): its panel opens here, or Plugins at it when it has no button. */
function usePluginSetupEvent(entries: readonly PluginToolbarEntry[], press: (entry: PluginToolbarEntry) => unknown) {
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const id = detail?.id;
      const entry = entries.find((e) => e.plugin.manifest.id === id && e.item.target.kind === "panel");
      if (entry) void press(entry);
      else if (typeof id === "string") {
        notePluginsOpening(isPluginsOpenedFrom(detail?.from) ? detail.from : PluginsOpenedFrom.SetupRequest);
        openPluginsAt(id);
      }
    };
    window.addEventListener(PLUGIN_SETUP_EVENT, open);
    return () => window.removeEventListener(PLUGIN_SETUP_EVENT, open);
  }, [entries, press]);
}

/** What every button reads: each one's status, the one being pressed, whether the game is empty, and the press. */
interface ButtonsState {
  status: Readonly<Record<string, PluginToolbarStatus>>;
  busy: string | null;
  project: string | null;
  emptyGame: boolean;
  press: (entry: PluginToolbarEntry) => Promise<void>;
}

/**
 * The plugin buttons. An engine's stands in the chat header while the header offers its place
 * (`engine-slot.ts`), drawn there through a portal so it keeps this toolbar's status, panels and
 * approvals; the rest stand on the strip, Multiplayer (while `shown`) left of Genex's Publish (`before`).
 */
function ToolbarButtons({
  visible,
  state,
  multiplayer,
}: {
  visible: readonly PluginToolbarEntry[];
  state: ButtonsState;
  multiplayer: {
    shown: boolean;
    before: PluginToolbarEntry | undefined;
    press: () => void;
    behind: PluginToolbarStatus | null;
  };
}): JSX.Element {
  const slot = useEngineSlot();
  const placeOf = (entry: PluginToolbarEntry): ToolbarPlace => (slot ? toolbarPlace(entry) : ToolbarPlace.Strip);
  const { status, busy, project, emptyGame, press } = state;
  const button = (entry: PluginToolbarEntry, place: ToolbarPlace) => (
    <ToolbarButton
      key={entry.key}
      entry={entry}
      status={status[entry.key]}
      project={project}
      busy={busy === entry.key}
      due={Boolean(status[entry.key]?.attention) && !emptyGame}
      place={place}
      onPress={() => void press(entry)}
    />
  );
  const inHeader = visible.filter((entry) => placeOf(entry) === ToolbarPlace.Header);
  return (
    <>
      {visible
        .filter((entry) => placeOf(entry) === ToolbarPlace.Strip)
        .map((entry) => (
          <Fragment key={entry.key}>
            {multiplayer.shown && entry === multiplayer.before && (
              <MultiplayerButton onPress={multiplayer.press} behind={multiplayer.behind} />
            )}
            {button(entry, ToolbarPlace.Strip)}
          </Fragment>
        ))}
      {slot && inHeader.length > 0
        ? createPortal(
            inHeader.map((entry) => button(entry, ToolbarPlace.Header)),
            slot,
          )
        : null}
    </>
  );
}

export function PluginToolbar({
  plugins,
  project,
  facts,
  holds,
  emptyGame,
  game,
  onNotice,
  onOpenChange,
}: Props): JSX.Element {
  const { entries, web, apps } = useStripEntries(plugins, project, facts, holds);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // Membership, not identity: the list is re-fetched every few seconds while the Plugins dialog
  // is open, and a status poll per fetch would be a process wake per fetch.
  const membership = entries.map((e) => `${e.key}@${e.plugin.manifest.version}`).join("|");
  const { status, refreshRef } = useToolbarStatus(entriesRef, membership, project);
  // A button scoped to other games' facts is asked for its status but drawn only while it says `shown`.
  const visible = useMemo(() => visibleToolbarEntries(entries, status), [entries, status]);
  const [panel, setPanel] = useState<ToolbarPanel | null>(null);
  const [review, setReview] = useState<PluginReviewRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // A plugin disabled or removed while its panel is up takes the panel with it.
  useEffect(() => {
    if (panel && !entries.some((e) => e.key === panel.key)) setPanel(null);
  }, [entries, panel]);
  const genexPublish = entries.find(isGenexPublish);
  useCoverAfterTurns(project, Boolean(genexPublish?.plugin.enabled) && !emptyGame);
  const studioPublish = useStudioPublish(plugins, project, { facts, holds, apps }, genexPublish);
  const publish = Boolean(genexPublish) || studioPublish.shown;
  const roblox = useRobloxPublish(plugins, project, facts, publish);
  const robloxCard = roblox.card;
  // A game published only as its apps runs no Genex web SDK: Multiplayer is for web games.
  const multiplayerShown = multiplayerOn(publish && web, emptyGame, game, { facts, holds });
  // Multiplayer is the plugin's: its Publish shows while it is off, but only an on Genex makes a game multiplayer.
  const multiplayer = useMultiplayer(
    project,
    multiplayerShown,
    genexPublish?.plugin.enabled ? genexPublish : undefined,
  );
  useEffect(() => {
    onOpenChange(Boolean(panel) || studioPublish.setup || multiplayer.setup || Boolean(robloxCard));
    return () => onOpenChange(false);
  }, [panel, studioPublish.setup, multiplayer.setup, robloxCard, onOpenChange]);
  useEffect(
    () => () =>
      setReview((r) => {
        r?.resolve(false);
        return null;
      }),
    [],
  );

  const press = usePress({ project, onNotice, refreshRef, setPanel, setReview, setBusy });
  // Genex turned on or installed from Studio's Publish: its own Publish dialog takes over.
  const { handOff, close: closeSetup } = studioPublish;
  useEffect(() => {
    if (!handOff) return;
    closeSetup();
    void press(handOff);
  }, [handOff, closeSetup, press]);

  usePluginSetupEvent(entries, press);

  const genexPlugin = plugins.find((p) => p.manifest.id === GENEX_PLUGIN_ID);
  const livePanelPlugin = panel
    ? (plugins.find((p) => p.manifest.id === panel.plugin.manifest.id) ?? panel.plugin)
    : null;
  return (
    <>
      <ToolbarButtons
        visible={visible}
        state={{ status, busy, project, emptyGame, press }}
        multiplayer={{ shown: multiplayerShown, before: genexPublish, ...multiplayer }}
      />
      {studioPublish.shown && multiplayerShown && <MultiplayerButton onPress={multiplayer.press} />}
      {studioPublish.shown && <StudioPublishButton onPress={studioPublish.open} />}
      <RobloxPublish {...roblox} />
      {studioPublish.setup && <PublishSignInDialog onClose={studioPublish.close} />}
      {multiplayer.setup && <GenexSetupDialog genex={genexPlugin} onClose={multiplayer.close} />}
      {panel?.drawn && livePanelPlugin ? (
        <GenexPublishDialog plugin={livePanelPlugin} project={project} onClose={() => setPanel(null)} />
      ) : null}
      {panel?.document && livePanelPlugin ? (
        <PluginPanelDialog
          plugin={livePanelPlugin}
          document={panel.document}
          title={panel.title}
          project={project}
          onDismiss={() => {
            setPanel(null);
            // What the panel just did (a setup, an Open) shows on the button now, not at the next tick.
            refreshRef.current();
          }}
        />
      ) : null}
      {review ? <PluginApproval review={review} onClose={() => setReview(null)} /> : null}
    </>
  );
}

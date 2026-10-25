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
 * or (`dot`) a dot in that tone whose word only screen readers hear.
 */
function ToolbarBadge({
  id,
  update,
  status,
}: {
  id: string;
  update: boolean;
  status: PluginToolbarStatus | undefined;
}): JSX.Element | null {
  if (update) return <UpdateMark id={id} word={PLUGIN_TOOLBAR_WORDS.update.badge} />;
  if (!status?.badge) return null;
  if (status.dot) {
    const tone = status.tone ?? "info";
    return (
      <span id={id} data-plugin-badge data-dot={tone} className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])}>
        <span className="sr-only">{status.badge}</span>
      </span>
    );
  }
  return (
    <span id={id} data-plugin-badge className={cn("text-micro", status.tone ? TONE_CLASS[status.tone] : "text-ink-2")}>
      {status.badge}
    </span>
  );
}

/** How a strip button is dressed: Publish in Play's blue, filled once due; any other in the quiet pill, the accent once due. */
function toolbarLook(publish: boolean, due: boolean) {
  if (publish) return due ? "play-fill" : "play-tint";
  return due ? "default" : "pill";
}

/** A strip button with its tooltip, beside it rather than below (a tooltip under the strip would sit behind the native game view). */
function StripTip({ lines, tip, children }: { lines: string[]; tip?: string; children: JSX.Element }): JSX.Element {
  const [heading, ...rest] = lines;
  if (!heading) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="left" sideOffset={6} data-plugin-toolbar-tip={tip}>
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

/**
 * A plugin's button: the accent while its status says its action is due, the quiet pill otherwise;
 * Publish wears Play's blue instead, filled while there is something to publish (`toolbarLook`).
 * While its plugin is behind the bundled version it wears the Update badge instead, and then it
 * opens Plugins at the plugin, game or not. Its title, and a dot's word, show in the strip's own
 * tooltip.
 */
function ToolbarButton({
  entry,
  status: own,
  project,
  busy,
  due,
  onPress,
}: {
  entry: PluginToolbarEntry;
  status: PluginToolbarStatus | undefined;
  project: string | null;
  busy: boolean;
  due: boolean;
  onPress: () => void;
}): JSX.Element {
  const badgeId = useId();
  const update = toolbarUpdateStatus(entry.plugin, PLUGIN_TOOLBAR_WORDS.update);
  const status = shownToolbarStatus(own, update);
  const needsGame = entry.item.requiresProject !== false && !project;
  // Updating needs no game and isn't the plugin's own action, so nothing the plugin says holds it back.
  const blocked = update ? false : Boolean(status?.disabled) || needsGame;
  const disabled = blocked || busy;
  const press = update ? () => openPluginsAt(entry.plugin.manifest.id) : onPress;
  return (
    <StripTip lines={toolbarTip(status)} tip={entry.key}>
      <Button
        variant={toolbarLook(isGenexPublish(entry), due)}
        data-due={due ? "" : undefined}
        data-plugin-toolbar={entry.key}
        aria-label={entry.item.ariaLabel}
        // The label names the button; the badge, its state, is read after it ("Unreal Editor, Ready").
        aria-describedby={status?.badge ? badgeId : undefined}
        disabled={disabled}
        onClick={press}
      >
        <ToolbarIcon icon={entry.item.icon} />
        <span>{entry.item.label}</span>
        <ToolbarBadge id={badgeId} update={Boolean(update)} status={status} />
      </Button>
    </StripTip>
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

/** The user turned the action down, in Studio's review or the native dialog: nothing to report. */
const declined = (err: unknown): boolean => /Cancelled/.test(String(err));

/** Press a button: open its panel over the stage, or run its action through review and approval. */
function usePress({ project, onNotice, refreshRef, setPanel, setReview, setBusy }: PressDeps) {
  return useCallback(
    async (entry: PluginToolbarEntry) => {
      const { plugin, item } = entry;
      if (item.target.kind === "panel") {
        if (drawnByStudio(plugin, item.target.id)) {
          setPanel({ key: entry.key, plugin, title: GENEX_WORDS.publish.title, document: null, drawn: true });
          return;
        }
        try {
          const doc = await window.studio.pluginPanel(plugin.manifest.id, item.target.id);
          setPanel({ key: entry.key, plugin, title: doc.title, document: doc });
        } catch (err) {
          onNotice(problemWords(err), ToastTone.Error);
        }
        return;
      }
      setBusy(entry.key);
      try {
        const result = await runPluginAction({
          plugin,
          name: item.target.name,
          args: item.target.args ?? {},
          project,
          review: setReview,
        });
        onNotice(actionMessage(result, item.label), ToastTone.Ok);
        refreshRef.current();
      } catch (err) {
        if (!declined(err)) onNotice(problemWords(err), ToastTone.Error);
      } finally {
        setBusy((current) => (current === entry.key ? null : current));
      }
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
    if (pressed === MultiplayerPress.Update) openPluginsAt(GENEX_PLUGIN_ID);
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

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent).detail?.id;
      const entry = entries.find((e) => e.plugin.manifest.id === id && e.item.target.kind === "panel");
      if (entry) void press(entry);
      else if (typeof id === "string") openPluginsAt(id);
    };
    window.addEventListener(PLUGIN_SETUP_EVENT, open);
    return () => window.removeEventListener(PLUGIN_SETUP_EVENT, open);
  }, [entries, press]);

  const genexPlugin = plugins.find((p) => p.manifest.id === GENEX_PLUGIN_ID);
  const livePanelPlugin = panel
    ? (plugins.find((p) => p.manifest.id === panel.plugin.manifest.id) ?? panel.plugin)
    : null;
  return (
    <>
      {visible.map((entry) => (
        <Fragment key={entry.key}>
          {entry === genexPublish && multiplayerShown && (
            <MultiplayerButton onPress={multiplayer.press} behind={multiplayer.behind} />
          )}
          <ToolbarButton
            entry={entry}
            status={status[entry.key]}
            project={project}
            busy={busy === entry.key}
            due={Boolean(status[entry.key]?.attention) && !emptyGame}
            onPress={() => void press(entry)}
          />
        </Fragment>
      ))}
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

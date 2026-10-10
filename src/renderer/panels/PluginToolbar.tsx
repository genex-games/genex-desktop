/**
 * The buttons plugins contribute at the end of the stage strip, dressed as the app's own
 * buttons. Which buttons exist is the manifest's (`toolbarItems`); what they say is the plugin's status action or a `plugin.event` of kind
 * `toolbar`, both sanitized before they reach the DOM. A panel target opens its own dialog over
 * the stage (and says so, so the native game view gets out of the way); an action target runs
 * the same review → ticket → native approval sequence as the Plugins dialog.
 */
import type { Dispatch, JSX, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { GENEX_PLUGIN_ID, GENEX_PUBLISH_PANEL } from "../../shared/genex.ts";
import {
  isToolbarEvent,
  type PluginToolbarEntry,
  toolbarItems,
  toolbarStatusFrom,
} from "../../shared/plugin-toolbar.ts";
import {
  isToolbarIconName,
  type PluginInfo,
  type PluginPanelDocument,
  type PluginToolbarStatus,
} from "../../shared/plugins.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { type PluginReviewRequest, runPluginAction } from "../plugin-actions.ts";
import { PLUGIN_SETUP_EVENT } from "../plugin-setup.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { OPEN_PLUGINS_EVENT } from "../ui/ComposerAddMenu.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Icon } from "../ui/icons.tsx";
import { GENEX_WORDS, problemWords } from "../words.ts";
import { GenexPublishDialog, GenexSetupDialog } from "./plugins/genex/GenexPublish.tsx";
import { isGenexPublish, studioPublishButton } from "./plugins/genex/genex-publish-view.ts";
import { PluginApproval } from "./PluginApproval.tsx";
import { PluginPanelHost } from "./PluginPanelHost.tsx";

/** Status refreshes coalesce: a burst of change events wakes each plugin's process once. */
const STATUS_DEBOUNCE_MS = SECOND_MS;
/** And while a project is open the badge is re-asked on its own, without any event. */
const STATUS_TICK_MS = 30 * SECOND_MS;
const TONE_CLASS: Record<NonNullable<PluginToolbarStatus["tone"]>, string> = {
  ok: "text-green",
  warn: "text-orange",
  err: "text-red",
  info: "text-ink-3",
};

interface Props {
  plugins: PluginInfo[];
  project: string | null;
  /** The game has nothing in it yet: no button's action can be due, so none takes the accent. */
  emptyGame: boolean;
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
 * What a plugin's `toolbar` event changes: one button's status in place, or — when it names no
 * button of this toolbar or carries no status — a refresh of them all. Null for anything else.
 */
function toolbarChange(
  payload: { id: string; event: unknown } | undefined,
  entries: PluginToolbarEntry[],
): { key: string; update: PluginToolbarStatus } | "refresh" | null {
  const raw = payload?.event;
  if (!payload || typeof payload.id !== "string") return null;
  if (!isToolbarEvent(raw)) return null;
  const mine = entries.filter((e) => e.plugin.manifest.id === payload.id);
  if (mine.length === 0) return null;
  const target = typeof raw.item === "string" ? mine.find((e) => e.item.id === raw.item) : undefined;
  const update = toolbarStatusFrom(raw);
  return target && update ? { key: target.key, update } : "refresh";
}

/**
 * Each button's status — badge, tone, title, disabled — asked of its plugin after a quiet
 * moment, again every so often while a game is open, and whenever a plugin says it changed.
 */
function useToolbarStatus(entriesRef: { current: PluginToolbarEntry[] }, membership: string, project: string | null) {
  const [status, setStatus] = useState<Record<string, PluginToolbarStatus>>({});
  const refreshRef = useRef<() => void>(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: membership stands for the entries, read through their ref
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      timer = null;
      const wanted = entriesRef.current.flatMap((e) => (e.item.status ? [{ entry: e, action: e.item.status }] : []));
      const results = await Promise.all(
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
      if (cancelled) return;
      setStatus((current) => {
        const next: Record<string, PluginToolbarStatus> = {};
        for (const [key, value] of results) next[key] = value ?? current[key] ?? {};
        return next;
      });
    };
    const schedule = () => {
      if (cancelled || timer) return;
      timer = setTimeout(() => void run(), STATUS_DEBOUNCE_MS);
    };
    refreshRef.current = schedule;
    schedule();
    const tick = project ? setInterval(schedule, STATUS_TICK_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (tick) clearInterval(tick);
      refreshRef.current = () => {};
    };
  }, [membership, project]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribed once; entries and the refresh are read through refs
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        if (event.type === UiEvent.PluginsChanged) {
          refreshRef.current();
          return;
        }
        if (event.type !== UiEvent.PluginEvent) return;
        const change = toolbarChange(event.payload, entriesRef.current);
        if (change === "refresh") refreshRef.current();
        else if (change)
          setStatus((current) => ({ ...current, [change.key]: { ...current[change.key], ...change.update } }));
      }),
    [],
  );
  return { status, refreshRef };
}

/** What a finished action says: its own message when it returned one, else that it is done. */
function actionMessage(result: unknown, label: string): string {
  const message = result && typeof result === "object" ? (result as { message?: unknown }).message : undefined;
  return typeof message === "string" ? message : `${label}: done`;
}

/** A button's glyph: one of the app's icons, the plugin's own character, or none. */
function ToolbarIcon({ icon }: { icon: string | undefined }): JSX.Element | null {
  if (isToolbarIconName(icon)) return <Icon name={icon} />;
  return icon ? <span aria-hidden="true">{icon}</span> : null;
}

/**
 * A plugin's button: the accent while its status says its action is due (Publish with something
 * to publish), the quiet pill otherwise — two looks only.
 */
function ToolbarButton({
  entry,
  status,
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
  const needsGame = entry.item.requiresProject !== false && !project;
  const disabled = Boolean(status?.disabled) || needsGame || busy;
  return (
    <Button
      variant={due ? "default" : "pill"}
      data-due={due ? "" : undefined}
      data-plugin-toolbar={entry.key}
      aria-label={entry.item.ariaLabel}
      title={status?.title}
      disabled={disabled}
      onClick={onPress}
    >
      <ToolbarIcon icon={entry.item.icon} />
      <span>{entry.item.label}</span>
      {status?.badge ? (
        <span data-plugin-badge className={`text-micro ${status.tone ? TONE_CLASS[status.tone] : "text-ink-3"}`}>
          {status.badge}
        </span>
      ) : null}
    </Button>
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
 * Publish for every open game: while Genex is off or not installed, Studio's own button opens a
 * dialog that brings Genex back, and once Genex's own Publish is there it takes over the dialog.
 */
function useStudioPublish(plugins: PluginInfo[], project: string | null, genexPublish: PluginToolbarEntry | undefined) {
  const [setup, setSetup] = useState(false);
  const shown = studioPublishButton(plugins, project);
  useEffect(() => {
    if (setup && !project) setSetup(false);
  }, [setup, project]);
  const open = useCallback(() => setSetup(true), []);
  const close = useCallback(() => setSetup(false), []);
  // Genex came back while its dialog was up: Genex's own Publish is what to open now.
  const handOff = setup && genexPublish ? genexPublish : null;
  return { shown, setup: setup && shown, open, close, handOff };
}

/** Studio's own Publish, dressed as Genex's: quiet, since whoever turned Genex off is not publishing yet. */
function StudioPublishButton({ onPress }: { onPress: () => void }): JSX.Element {
  return (
    <Button variant="pill" data-studio-publish aria-label={GENEX_WORDS.publish.buttonLabel} onClick={onPress}>
      <Icon name="globe" />
      <span>{GENEX_WORDS.publish.button}</span>
    </Button>
  );
}

export function PluginToolbar({ plugins, project, emptyGame, onNotice, onOpenChange }: Props): JSX.Element {
  const entries = useMemo(() => toolbarItems(plugins, project), [plugins, project]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // Membership, not identity: the list is re-fetched every few seconds while the Plugins dialog
  // is open, and a status poll per fetch would be a process wake per fetch.
  const membership = entries.map((e) => `${e.key}@${e.plugin.manifest.version}`).join("|");
  const { status, refreshRef } = useToolbarStatus(entriesRef, membership, project);
  const [panel, setPanel] = useState<ToolbarPanel | null>(null);
  const [review, setReview] = useState<PluginReviewRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // A plugin disabled or removed while its panel is up takes the panel with it.
  useEffect(() => {
    if (panel && !entries.some((e) => e.key === panel.key)) setPanel(null);
  }, [entries, panel]);
  const studioPublish = useStudioPublish(plugins, project, entries.find(isGenexPublish));
  useEffect(() => {
    onOpenChange(Boolean(panel) || studioPublish.setup);
    return () => onOpenChange(false);
  }, [panel, studioPublish.setup, onOpenChange]);
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
      else if (typeof id === "string")
        window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin: id } }));
    };
    window.addEventListener(PLUGIN_SETUP_EVENT, open);
    return () => window.removeEventListener(PLUGIN_SETUP_EVENT, open);
  }, [entries, press]);

  const livePanelPlugin = panel
    ? (plugins.find((p) => p.manifest.id === panel.plugin.manifest.id) ?? panel.plugin)
    : null;
  return (
    <>
      {entries.map((entry) => (
        <ToolbarButton
          key={entry.key}
          entry={entry}
          status={status[entry.key]}
          project={project}
          busy={busy === entry.key}
          due={Boolean(status[entry.key]?.attention) && !emptyGame}
          onPress={() => void press(entry)}
        />
      ))}
      {studioPublish.shown && <StudioPublishButton onPress={studioPublish.open} />}
      {studioPublish.setup && (
        <GenexSetupDialog
          genex={plugins.find((p) => p.manifest.id === GENEX_PLUGIN_ID)}
          onClose={studioPublish.close}
        />
      )}
      {panel?.drawn && livePanelPlugin ? (
        <GenexPublishDialog plugin={livePanelPlugin} project={project} onClose={() => setPanel(null)} />
      ) : null}
      {panel?.document && livePanelPlugin ? (
        <DialogSurface
          title={panel.title}
          size="2xl"
          className="h-[min(680px,calc(100dvh-2rem))] grid-rows-[auto_1fr]"
          onDismiss={() => setPanel(null)}
        >
          <PluginPanelHost
            plugin={livePanelPlugin}
            document={panel.document}
            project={project}
            className="h-full min-h-0 w-full rounded-control border-0"
          />
        </DialogSurface>
      ) : null}
      {review ? <PluginApproval review={review} onClose={() => setReview(null)} /> : null}
    </>
  );
}

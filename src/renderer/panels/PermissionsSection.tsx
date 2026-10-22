/**
 * Settings → Permissions: the mode new chats start in, whether agents may ask to control the
 * person's computer, then what Claude does without asking, by action: one row per saved "always
 * allow" rule, however many games hold it, opening to those games. A view of what the host keeps;
 * each chat still picks its own mode in the composer.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import {
  permissionModeWords,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionSettingsView,
  STEADY_PERMISSION_MODES,
} from "../../shared/permissions.ts";
import { type AllowedAction, allowedActions } from "../permission-actions.ts";
import { useLibrary } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { Icon } from "../ui/icons.tsx";
import { Pending } from "../ui/Pending.tsx";
import { Switch } from "../ui/switch.tsx";
import { hostPlatform } from "../platform.ts";
import { computerControlOffered } from "../../shared/computer-control.ts";
import { useComputerControl } from "../use-computer-control.ts";
import { usePermissionSettings } from "../use-permission-settings.ts";
import { COMPUTER_CONTROL_SETTING_WORDS, computerControlDetail, permissionRuleWords, problemWords } from "../words.ts";

/** The section's own words. */
const WORDS = {
  loading: t("Loading…"),
  everyGame: t("In every game"),
  startsIn: t("New chats start in"),
  allowed: t("Always allowed"),
  about: t("What Claude does without asking. Choosing Always allow in a chat adds an action here, for that game."),
  none: t("Nothing yet. Choosing Always allow in a chat adds an action here."),
  count: (actions: number, games: number) =>
    t("{actions, plural, one {# action} other {# actions}} · {games, plural, one {# game} other {# games}}", {
      actions,
      games,
    }),
  where: (action: AllowedAction) =>
    action.games.length === 1
      ? (action.games[0]?.title ?? "")
      : t("{count, plural, one {# game} other {# games}}", { count: action.games.length }),
  stop: (action: AllowedAction, words: string) =>
    t("{count, plural, =1 {Stop allowing: {action}} other {Stop allowing in all # games: {action}}}", {
      count: action.games.length,
      action: words,
    }),
  stopIn: (title: string) => t("Stop allowing in {game}", { game: title }),
} as const;

/** The modes a new chat may start in, in the composer's order. */
const STARTING_MODES = PERMISSION_MODES.filter((mode) => STEADY_PERMISSION_MODES.has(mode));

/** "In every game": the mode new chats start in, picked from a short menu. */
function StartingMode({
  mode,
  busy,
  onPick,
}: {
  mode: PermissionMode;
  busy: boolean;
  onPick: (mode: PermissionMode) => void;
}): JSX.Element {
  return (
    <section aria-label={WORDS.everyGame} className="settings-card">
      <h3 className="settings-card-title">{WORDS.everyGame}</h3>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-ink-3">{WORDS.startsIn}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-default-mode disabled={busy} className="h-9 gap-2 ps-3.5 pe-3 text-sm">
              {permissionModeWords()[mode].label}
              <Icon name="chevron-down" size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-64">
            <DropdownMenuRadioGroup value={mode}>
              {STARTING_MODES.map((option) => (
                <DropdownMenuRadioItem key={option} value={option} onSelect={() => onPick(option)}>
                  <span className="flex min-w-0 flex-col">
                    <span>{permissionModeWords()[option].label}</span>
                    <span className="text-xs text-muted-foreground">{permissionModeWords()[option].description}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </section>
  );
}

/** "Let agents control your computer": off by default, and offered only where a desktop driver runs (macOS, Windows). */
function ComputerControl(): JSX.Element | null {
  const { on, busy, error, change } = useComputerControl();
  if (on === null && !error) return null;
  const platform = hostPlatform();
  const offered = computerControlOffered(platform);
  return (
    <section aria-label={COMPUTER_CONTROL_SETTING_WORDS.section} data-computer-control className="settings-card">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="permissions-computer-control" className="flex min-w-0 flex-col gap-0.5">
          <span className="settings-card-title">{COMPUTER_CONTROL_SETTING_WORDS.label}</span>
          <span className="max-w-[460px] text-ink-3">{computerControlDetail(platform)}</span>
        </label>
        <Switch
          id="permissions-computer-control"
          checked={on === true}
          disabled={busy || on === null || !offered}
          onCheckedChange={change}
        />
      </div>
      {error && (
        <p role="alert" className="mt-2 text-red">
          {error}
        </p>
      )}
    </section>
  );
}

/** One allowed action: its words and raw rule, where it is allowed, and Stop allowing there or everywhere. */
function ActionRow({
  action,
  busy,
  onForget,
}: {
  action: AllowedAction;
  busy: boolean;
  onForget: (rule: string, projects: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const covers = useLibrary((s) => s.games);
  const words = permissionRuleWords(action.rule);
  const stopAll = WORDS.stop(action, words);
  return (
    <li className="settings-list-group">
      <div className="flex items-center gap-1 pe-1">
        <button
          type="button"
          data-allowed-action
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="settings-list-row flex min-h-13 min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left hover:bg-foreground/5"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-ink">{words}</span>
            <code className="truncate font-mono text-micro text-ink-3">{action.rule}</code>
          </span>
          <span className="shrink-0 font-mono text-xs text-ink-3">{WORDS.where(action)}</span>
          <Icon
            name="chevron-right"
            size={14}
            className={`chat-chevron shrink-0 text-ink-3 ${open ? "rotate-90" : ""}`}
          />
        </button>
        <Button
          data-forget-rule
          variant="ghost"
          size="icon-sm"
          aria-label={stopAll}
          title={stopAll}
          disabled={busy}
          onClick={() =>
            onForget(
              action.rule,
              action.games.map((game) => game.project),
            )
          }
        >
          <Icon name="trash" />
        </Button>
      </div>
      {open && (
        <ul className="ps-6 pe-1 pb-1.5">
          {action.games.map((game) => (
            <li key={game.project} className="flex min-h-9 items-center gap-2.5 border-t border-line">
              <GameAvatar
                cover={covers.find((known) => known.name === game.project)?.cover}
                gameKey={game.project}
                className="size-4"
              />
              <span className="min-w-0 flex-1 truncate text-ink-2">{game.title}</span>
              <Button
                data-forget-rule-game
                variant="ghost"
                size="icon-sm"
                aria-label={WORDS.stopIn(game.title)}
                title={WORDS.stopIn(game.title)}
                disabled={busy}
                onClick={() => onForget(action.rule, [game.project])}
              >
                <Icon name="trash" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** "Always allowed", by action, the most shared first. */
function AllowedActions({
  settings,
  busy,
  onForget,
}: {
  settings: PermissionSettingsView;
  busy: boolean;
  onForget: (rule: string, projects: string[]) => void;
}): JSX.Element {
  const actions = allowedActions(settings.rules);
  const games = settings.rules.filter((game) => game.rules.length > 0).length;
  return (
    <>
      <div className="mt-2 flex flex-col gap-1">
        <h3 className="settings-subtitle">{WORDS.allowed}</h3>
        <div className="flex items-baseline justify-between gap-3">
          <p className="max-w-[460px] text-ink-3">{actions.length ? WORDS.about : WORDS.none}</p>
          {actions.length > 0 && (
            <span className="shrink-0 font-mono text-micro text-ink-3">{WORDS.count(actions.length, games)}</span>
          )}
        </div>
      </div>
      {actions.length > 0 && (
        <ul data-list className="settings-card">
          {actions.map((action) => (
            <ActionRow key={action.rule} action={action} busy={busy} onForget={onForget} />
          ))}
        </ul>
      )}
    </>
  );
}

export function PermissionsSection(): JSX.Element {
  const { settings, setSettings, error } = usePermissionSettings();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Focus stays in the list after a removal: on the action that took its place, else the panel.
  const refocus = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves once the removal's answer is drawn
  useEffect(() => {
    if (busy || refocus.current === null) return;
    const left = root.current?.querySelectorAll<HTMLElement>("[data-forget-rule]");
    const next = left?.[Math.min(refocus.current, left.length - 1)];
    (next ?? root.current?.closest<HTMLElement>('[role="tabpanel"]'))?.focus();
    refocus.current = null;
  }, [busy, settings]);
  /** Run one change to the host's settings, showing its answer, or why it failed. */
  const change = async (work: () => Promise<PermissionSettingsView | null>, focusAt: number | null) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const view = await work();
      if (view) setSettings(view);
      refocus.current = focusAt;
    } catch (cause) {
      setFailure(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  // One game at a time: each answer is the whole view, so the last is the one that holds.
  const forget = (rule: string, projects: string[]) => {
    const at = allowedActions(settings?.rules ?? []).findIndex((action) => action.rule === rule);
    void change(
      async () => {
        let view: PermissionSettingsView | null = null;
        for (const project of projects) view = await window.studio.forgetPermission(project, rule);
        return view;
      },
      Math.max(0, at),
    );
  };
  const pickMode = (mode: PermissionMode) => void change(() => window.studio.setPermissionMode(null, mode), null);
  if (!settings)
    return (
      <div data-permission-settings className="appearance-section">
        {error ? (
          <p role="alert" className="text-red">
            {error}
          </p>
        ) : (
          <Pending label={WORDS.loading} />
        )}
      </div>
    );
  return (
    <div ref={root} data-permission-settings className="appearance-section flex flex-col gap-3">
      <StartingMode mode={settings.defaultMode} busy={busy} onPick={pickMode} />
      <ComputerControl />
      <AllowedActions settings={settings} busy={busy} onForget={forget} />
      {failure && (
        <p role="alert" className="text-red">
          {failure}
        </p>
      )}
    </div>
  );
}

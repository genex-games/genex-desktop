import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { PickerLabel, PickerSeparator, pickerRow } from "./PickerPanel.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";
import { Icon } from "./icons.tsx";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { findChoice, roleChoices } from "../model-choices.ts";
import { modelKey as keyOf, parseModelKey } from "../model-key.ts";
import { RovingAxis, rovingTarget } from "./roving-focus.ts";
import type { RunRoles } from "../../shared/protocol.ts";
import type { ModelCapabilities } from "../../shared/model-preferences.ts";

import type { RoleKey, RoleRow } from "../../shared/model-roles.ts";
export type { RoleKey, RoleRow };
export type RoleRecord = RunRoles;
export interface RoleGroup {
  engine: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}
export interface ModelChoice extends ModelCapabilities {
  key: string;
  name: string;
  tag?: string;
  detail?: string;
  group?: string;
  disabled?: boolean;
  title?: string;
  efforts?: string[];
  defaultEffort?: string;
  supportsSessions?: boolean;
  /** Whether the model takes images; only local rows say, since only a local engine refuses them. */
  supportsVision?: boolean;
  /** Other ids the provider resolves to this model, such as a family alias. */
  aliases?: string[];
  /** Left out of the list unless picked: an older model, or one turned off in Settings. */
  hidden?: boolean;
  /** The model the provider runs when nobody picks one; an unset pick resolves to it. */
  providerDefault?: boolean;
  /** The provider's id for the model this row runs, so a pick saved under another id still finds it. */
  resolvedModel?: string;
}
/** The composer's way to open the menu (a plan that failed on its model offers "Choose model"). */
export interface ModelMenuHandle {
  open(): void;
}
export function effortLabel(effort: string | null): string {
  return (
    (
      {
        none: "None",
        minimal: "Minimal",
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "xHigh",
        max: "Max",
        ultra: "Ultra",
      } as Record<string, string>
    )[effort ?? ""] ??
    effort ??
    "Auto"
  );
}
export function shortModelName(name: string): string {
  return name.replace(/-mlx$/i, "").replace(/:latest$/i, "");
}
export const contextLabel = (tokens: number) =>
  tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`;

const ROLE_NAMES: Record<RoleKey, string> = { planner: "Main agent", builder: "Workers", judge: "Reviewers" };
const ROLE_INFO: Partial<Record<RoleKey, string>> = {
  builder: "Workers build the parts of the plan, several at once.",
  judge: "Reviewers test every result and decide when the game is done.",
};

/** Up/Down/Home/End move focus between the rows of one panel, like a menu. */
function moveFocus(event: KeyboardEvent<HTMLElement>, selector: string): boolean {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(
    (row) => !(row as HTMLButtonElement).disabled,
  );
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows.length ? rovingTarget(event.key, index, rows.length, RovingAxis.Vertical) : null;
  if (next === null) return false;
  event.preventDefault();
  rows[next]?.focus();
  return true;
}

/** The label local models are grouped under; they list after the subscriptions' makers. */
const LOCAL_GROUP = "Local models";
const groupOf = (choice: ModelChoice): string => choice.group ?? "Models";

/**
 * What each job runs on: the orchestrator is the chat's own pick, workers and judge their saved
 * picks on this engine or another subscription. Picking a model for a job saves it the same way.
 */
function useRolePicks({
  choices,
  modelKey,
  roles,
  onModel,
  onRoles,
}: {
  choices: ModelChoice[];
  modelKey: string | null;
  roles?: RoleRecord | null;
  onModel: (key: string) => void;
  onRoles?: (roles: RoleRecord) => void;
}) {
  const selected = choices.find((c) => c.key === modelKey) ?? choices.find((c) => !c.disabled);
  const engine = selected ? parseModelKey(selected.key).engine : undefined;
  const roleChoice = (role: RoleKey) => {
    if (role === "planner") return selected;
    const picked = roles?.[role] === "default" ? "" : (roles?.[role] ?? "");
    return findChoice(choices, keyOf(`${roles?.engines?.[role] ?? engine}`, picked));
  };
  const choose = (role: RoleKey, choice: ModelChoice) => {
    if (role === "planner") {
      onModel(choice.key);
      return;
    }
    const { engine: provider, model } = parseModelKey(choice.key);
    onRoles?.({
      ...roles,
      [role]: model || "default",
      engines: { ...roles?.engines, [role]: provider === engine ? undefined : provider },
    });
  };
  return {
    selected,
    roleChoice,
    roleName: (role: RoleKey) => shortModelName(roleChoice(role)?.name ?? "Choose model"),
    modelsFor: (role: RoleKey) => roleChoices(choices, role, selected),
    choose,
  };
}

type RolePicks = ReturnType<typeof useRolePicks>;

/** A job's model list, grouped by maker with local models last, then "Add more models". */
function ModelList({
  role,
  picks,
  listFocus,
  onPicked,
  onAddModels,
}: {
  role: RoleKey;
  picks: RolePicks;
  listFocus: Ref<HTMLButtonElement>;
  onPicked: () => void;
  onAddModels: () => void;
}): JSX.Element {
  const current = picks.roleChoice(role)?.key;
  // A hidden model stays listed while this job runs on it.
  const models = picks.modelsFor(role).filter((choice) => !choice.hidden || choice.key === current);
  // Subscription makers first, local models last.
  const groups = Array.from(new Set(models.map(groupOf))).sort(
    (a, b) => Number(a === LOCAL_GROUP) - Number(b === LOCAL_GROUP),
  );
  return (
    <div
      data-model-list={role}
      onKeyDown={(event) => {
        moveFocus(event, "[data-list-row]");
      }}
    >
      {groups.map((group, index) => (
        <div key={group} role="group" aria-label={group}>
          <PickerLabel first={index === 0}>{group}</PickerLabel>
          {models
            .filter((c) => groupOf(c) === group)
            .map((choice) => (
              <button
                type="button"
                key={choice.key}
                data-list-row
                data-model-choice={choice.key}
                ref={current === choice.key ? listFocus : undefined}
                disabled={choice.disabled}
                title={choice.title ?? choice.name}
                className={pickerRow}
                aria-pressed={current === choice.key}
                onClick={() => {
                  picks.choose(role, choice);
                  onPicked();
                }}
              >
                <span className="flex min-w-0 flex-col text-left">
                  <span className="truncate">{shortModelName(choice.name)}</span>
                  {choice.detail && <span className="truncate text-micro text-muted-foreground">{choice.detail}</span>}
                </span>
                {current === choice.key && <Icon name="check" className="ml-auto" />}
              </button>
            ))}
        </div>
      ))}
      <PickerSeparator />
      <button type="button" data-list-row className={`${pickerRow} text-ink-2`} onClick={onAddModels}>
        <Icon name="plus" />
        Add more models
      </button>
    </div>
  );
}

/**
 * A job's row: its name, what it does, and the model it runs on; it opens that job's list. Workers
 * and Reviewers read quieter than the main agent, in Auto and in Loop alike.
 */
function JobRow({
  role,
  name,
  expanded,
  onToggle,
  onOpen,
}: {
  role: RoleKey;
  name: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}): JSX.Element {
  const info = ROLE_INFO[role];
  return (
    <button
      type="button"
      data-role={role}
      data-role-row
      className={`${pickerRow} picker-role`}
      data-quiet={role !== "planner" || undefined}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`${ROLE_NAMES[role]}: ${name}`}
      {...(info ? { "aria-description": info } : {})}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="picker-role-name">{ROLE_NAMES[role]}</span>
      {info && (
        <Tooltip disableHoverableContent>
          <TooltipTrigger asChild>
            <span className="picker-role-info" aria-hidden>
              <Icon name="info" size={14} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="max-w-[240px]">
            {info}
          </TooltipContent>
        </Tooltip>
      )}
      <span className="picker-role-model">{name}</span>
      <Icon name="chevron-right" size={14} className="text-muted-foreground" />
    </button>
  );
}

/** The three jobs, each always choosable. */
function RolesView({
  picks,
  listRole,
  onListRole,
}: {
  picks: RolePicks;
  listRole: RoleKey | null;
  onListRole: (role: RoleKey | null) => void;
}): JSX.Element {
  const row = (role: RoleKey) => (
    <JobRow
      key={role}
      role={role}
      name={picks.roleName(role)}
      expanded={listRole === role}
      onToggle={() => onListRole(listRole === role ? null : role)}
      onOpen={() => onListRole(role)}
    />
  );
  return (
    <div data-model-view="roles">
      {row("planner")}
      {row("builder")}
      {row("judge")}
    </div>
  );
}

/**
 * A job's model list beside the panel: to its right, else its left, else above. Over a running
 * game, the game steps aside while the list is open (native-bounds.ts). Escape is the menu's
 * one-step escape; Left goes back to the jobs.
 */
function JobList({
  role,
  panel,
  listFocus,
  onEscape,
  onBack,
  onDismiss,
  children,
}: {
  role: RoleKey | null;
  panel: HTMLDivElement | null;
  listFocus: RefObject<HTMLButtonElement | null>;
  onEscape: (event: Event) => void;
  onBack: () => void;
  onDismiss: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Popover
      open={role !== null}
      onOpenChange={(next, details) => {
        if (next) return;
        if (details.reason === "escape-key") {
          onEscape(details.event);
          return;
        }
        onDismiss();
      }}
    >
      <PopoverContent
        anchor={panel}
        side="right"
        align="end"
        sideOffset={8}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "start" }}
        className="picker-panel w-[240px] max-w-(--available-width) max-h-(--available-height) overflow-y-auto p-1.5"
        aria-label={role ? `${ROLE_NAMES[role]} model` : "Models"}
        initialFocus={listFocus}
        finalFocus={false}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onEscape(event.nativeEvent);
            return;
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onBack();
          }
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Where the menu stands: open or not, which job's list is out, and the steps back. Returning from
 * a list puts focus on the job it came from; one Escape is one step.
 */
function useMenuSteps(withRoles: boolean, onClosed?: () => void) {
  const [open, setOpen] = useState(false);
  const [listRole, setListRole] = useState<RoleKey | null>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const focusRole = useRef<RoleKey | null>(null);

  // Returning from a model list puts focus back on the job it was opened from.
  useLayoutEffect(() => {
    const role = focusRole.current;
    focusRole.current = null;
    const backFromList = open && !listRole;
    if (backFromList && role) panel?.querySelector<HTMLElement>(`[data-role="${role}"]`)?.focus();
  }, [listRole, open, panel]);

  const close = () => {
    setOpen(false);
    setListRole(null);
    onClosed?.();
  };
  const closeList = () => {
    focusRole.current = listRole;
    setListRole(null);
  };
  // One Escape is one step: the model list first, then the panel. The panel's own key handler and
  // the popover's dismissal can both see the same press; whichever runs first acts on it.
  const handledEscape = useRef<Event | null>(null);
  const escape = (event: Event) => {
    if (handledEscape.current === event) return;
    handledEscape.current = event;
    if (listRole && withRoles) closeList();
    else close();
  };
  return { open, setOpen, listRole, setListRole, panel, setPanel, close, closeList, escape };
}

/**
 * The model button. With roles it opens the three jobs (main agent, workers, reviewers), each
 * naming its model; a job opens its model list to the right of the panel. Without roles the button opens that list directly. Effort lives in its own
 * control; everything opens on click, never on hover.
 */
export function ModelMenu({
  choices,
  modelKey,
  onModel,
  roles,
  onRoles,
  disabled = false,
  onClosed,
  ref,
}: {
  choices: ModelChoice[];
  modelKey: string | null;
  onModel: (key: string) => void;
  roles?: RoleRecord | null;
  onRoles?: (roles: RoleRecord) => void;
  disabled?: boolean;
  onClosed?: () => void;
  ref?: Ref<ModelMenuHandle>;
}): JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null);
  const listFocus = useRef<HTMLButtonElement>(null);
  // Opening is its own button's click, so the popover opens exactly as a press would open it.
  useImperativeHandle(ref, () => ({ open: () => trigger.current?.click() }), []);
  const picks = useRolePicks({ choices, modelKey, roles, onModel, onRoles });
  const { selected } = picks;
  const withRoles = Boolean(onRoles);
  const { open, setOpen, listRole, setListRole, panel, setPanel, close, closeList, escape } = useMenuSteps(
    withRoles,
    onClosed,
  );
  const modelList = (role: RoleKey) => (
    <ModelList
      role={role}
      picks={picks}
      listFocus={listFocus}
      onPicked={withRoles ? closeList : close}
      onAddModels={() => {
        close();
        openSettings(SettingsSection.Providers, trigger.current);
      }}
    />
  );

  return (
    <div data-model-menu className="flex min-w-0 shrink items-center">
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          if (!next && details.reason === "escape-key") {
            escape(details.event);
            return;
          }
          if (next) setListRole(null);
          setOpen(next);
          if (!next) {
            setListRole(null);
            onClosed?.();
          }
        }}
      >
        <PopoverTrigger
          ref={trigger}
          render={<button type="button" />}
          disabled={disabled}
          aria-label="Model settings"
          title={selected?.name ?? "Choose model"}
          className="composer-model composer-text-button min-w-0"
        >
          <span data-fit className="truncate">
            {shortModelName(selected?.name ?? "Choose model")}
          </span>
        </PopoverTrigger>
        <PopoverContent
          ref={setPanel}
          side="top"
          align="end"
          sideOffset={8}
          className={`picker-panel ${withRoles ? "w-[300px]" : "w-[260px]"} max-w-(--available-width) max-h-(--available-height) overflow-y-auto p-1.5`}
          aria-label="Model options"
          initialFocus={() =>
            panel?.querySelector<HTMLElement>(withRoles ? '[data-role="planner"]' : '[aria-pressed="true"]') ?? true
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              escape(event.nativeEvent);
              return;
            }
            if (withRoles && !listRole) moveFocus(event, "[data-role-row]");
          }}
        >
          {withRoles ? (
            <RolesView picks={picks} listRole={listRole} onListRole={setListRole} />
          ) : (
            <div data-model-view="list">{modelList("planner")}</div>
          )}
          {withRoles && (
            <JobList
              role={listRole}
              panel={panel}
              listFocus={listFocus}
              onEscape={escape}
              onBack={closeList}
              onDismiss={() => setListRole(null)}
            >
              {listRole && modelList(listRole)}
            </JobList>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The AI pill's model menu (`V3-Menu`): the chat's model menu (`ui/ModelMenu.tsx`), hung under the
 * pill's right edge. Its head names the game and says what its AI costs in the words of how it is
 * paid (with Get credits on credits). Then the Genex group (Genex credits with the balance, the
 * maker's pick), the person's models by maker with local models last, one tag per row and a check
 * on the model in use, the models that may struggle folded under one row, and Turn off AI, Report
 * and Add more models. Up and Down move between rows; Esc or a click outside closes it.
 */
import type { JSX, KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useState } from "react";
import type { AiGameKey, AiModelRef } from "../../shared/game-ai.ts";
import { AiFunding } from "../../shared/game-ai.ts";
import type { AiMenuGroup, AiMenuRow, AiModelMenu } from "../../shared/game-ai-views.ts";
import { Icon, type IconName } from "../ui/icons.tsx";
import { PickerLabel, PickerSeparator, pickerRow } from "../ui/PickerPanel.tsx";
import { Popover, PopoverContent } from "../ui/popover.tsx";
import { RovingAxis, rovingTarget } from "../ui/roving-focus.ts";
import { PLAY_AI_WORDS } from "../words.ts";
import { AiLoad, GenexRowAction, genexRow, menuGroups, sameModel } from "./ai-model.ts";
import type { BarApi } from "./PlayBarPage.tsx";

const WORDS = PLAY_AI_WORDS.menu;
/** The rows Up and Down move between. */
const ROW_SELECTOR = "[data-ai-row]:not(:disabled)";

/** What the menu's rows ask of the bar. */
export interface AiMenuActions {
  pick(model: AiModelRef): void;
  signIn(): void;
  enable(on: boolean): void;
  report(): void;
  credits(): void;
  addModels(): void;
}

/** The game's menu, read when it opens, again when main says its AI changed, and on Try again. */
function useMenu(api: BarApi, game: AiGameKey, changed: number) {
  const [menu, setMenu] = useState<AiModelMenu | null>(null);
  const [status, setStatus] = useState<AiLoad>(AiLoad.Loading);
  const [reads, setReads] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change main announced, or Try again, reads it again.
  useEffect(() => {
    let live = true;
    api.gameAiMenu(game).then(
      (read) => {
        if (!live) return;
        setMenu(read);
        setStatus(AiLoad.Ready);
      },
      () => {
        if (live) setStatus((shown) => (shown === AiLoad.Ready ? shown : AiLoad.Failed));
      },
    );
    return () => {
      live = false;
    };
  }, [api, game, changed, reads]);
  return { menu, status, retry: () => setReads((count) => count + 1) };
}

/** Up/Down/Home/End move between the menu's rows. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows.length ? rovingTarget(event.key, index, rows.length, RovingAxis.Vertical) : null;
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}

/** A row's one tag. */
function Tag({ row }: { row: AiMenuRow }): JSX.Element | null {
  if (!row.tag) return null;
  return (
    <span className="play-ai-tag" data-tag={row.tag}>
      {WORDS.tags[row.tag]}
    </span>
  );
}

/** One model: its name, its tag, a check when the game uses it. */
function ModelRow({ row, current, onPick }: { row: AiMenuRow; current: boolean; onPick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={current}
      data-ai-row
      data-ai-model={`${row.model.door}:${row.model.engine}:${row.model.model}`}
      className={pickerRow}
      disabled={!row.ready}
      title={row.ready ? row.label : WORDS.notReady}
      onClick={onPick}
    >
      <span className="play-ai-row-name">
        <span className="truncate">{row.label}</span>
        {!row.ready && <small>{WORDS.notReady}</small>}
      </span>
      <span className="play-ai-row-end">
        <Tag row={row} />
        {current && <Icon name="check" size={15} />}
      </span>
    </button>
  );
}

/** The Genex group: Genex credits, the maker's pick, with the balance. */
function GenexGroup({ menu, actions }: { menu: AiModelMenu; actions: AiMenuActions }): JSX.Element {
  const row = genexRow(menu);
  const about = {
    [GenexRowAction.Pick]: WORDS.makersPick,
    [GenexRowAction.SignIn]: WORDS.signInToUse,
    [GenexRowAction.None]: WORDS.notOffered,
  }[row.action];
  const balance = menu.genex.balanceCredits;
  const press = (): void => {
    if (row.action === GenexRowAction.Pick) actions.pick(row.model);
    if (row.action === GenexRowAction.SignIn) actions.signIn();
  };
  return (
    <div role="group" aria-label={WORDS.genex}>
      <PickerLabel first>{WORDS.genex}</PickerLabel>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={row.current}
        data-ai-row
        data-ai-genex={row.action}
        className={pickerRow}
        disabled={row.action === GenexRowAction.None}
        onClick={press}
      >
        <span className="play-ai-row-name">
          <span className="truncate">{WORDS.genexCredits}</span>
          <small>{about}</small>
        </span>
        <span className="play-ai-row-end">
          {balance !== null && <span className="play-ai-tag">{PLAY_AI_WORDS.credits(balance)}</span>}
          {row.current && <Icon name="check" size={15} />}
        </span>
      </button>
    </div>
  );
}

/** One maker's models, "your plan" beside a subscription's. */
function MakerGroup({
  group,
  current,
  onPick,
}: {
  group: AiMenuGroup;
  current: AiModelRef | null;
  onPick: (model: AiModelRef) => void;
}): JSX.Element {
  const name = WORDS.makers[group.maker];
  return (
    <div role="group" aria-label={name}>
      <PickerLabel end={group.funding === AiFunding.Plan ? WORDS.yourPlan : undefined}>{name}</PickerLabel>
      {group.rows.map((row) => (
        <ModelRow
          key={`${row.model.door}:${row.model.engine}:${row.model.model}`}
          row={row}
          current={sameModel(row.model, current)}
          onPick={() => onPick(row.model)}
        />
      ))}
    </div>
  );
}

/** The models the check marked weak here, folded under one row until it opens. */
function Struggling({ menu, onPick }: { menu: AiModelMenu; onPick: (model: AiModelRef) => void }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (menu.struggling.length === 0) return null;
  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-expanded={open}
        data-ai-row
        data-ai-struggling
        className={`${pickerRow} text-ink-3`}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="play-ai-row-name">{WORDS.struggle(menu.struggling.length)}</span>
        <span className="play-ai-row-end">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={15} />
        </span>
      </button>
      {open &&
        menu.struggling.map((row) => (
          <ModelRow
            key={`${row.model.door}:${row.model.engine}:${row.model.model}`}
            row={row}
            current={sameModel(row.model, menu.current)}
            onPick={() => onPick(row.model)}
          />
        ))}
    </>
  );
}

/** One of the menu's actions under its models. */
function ActionRow({
  icon,
  quiet,
  onPress,
  children,
}: {
  icon: IconName;
  quiet?: boolean;
  onPress: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      data-ai-row
      className={`${pickerRow}${quiet ? " text-ink-3" : ""}`}
      onClick={onPress}
    >
      <Icon name={icon} size={15} className="text-ink-3" />
      <span className="play-ai-row-name">{children}</span>
    </button>
  );
}

/** The menu's head: the game, and what its AI costs. */
function MenuHead({
  menu,
  platform,
  onCredits,
}: {
  menu: AiModelMenu;
  platform: string;
  onCredits: () => void;
}): JSX.Element {
  const usage = menu.usage;
  return (
    <div className="play-ai-menu-head">
      <b>{menu.title}</b>
      {usage && (
        <small data-ai-usage={usage.funding}>
          {WORDS.usage(usage, menu.current, platform)}
          {usage.funding === AiFunding.Credits && (
            <>
              {" · "}
              <button type="button" className="play-ai-link" data-ai-get-credits onClick={onCredits}>
                {WORDS.getCredits}
              </button>
            </>
          )}
        </small>
      )}
    </div>
  );
}

/** The menu's rows, once read. */
function MenuBody({
  menu,
  platform,
  actions,
}: {
  menu: AiModelMenu;
  platform: string;
  actions: AiMenuActions;
}): JSX.Element {
  return (
    <>
      <MenuHead menu={menu} platform={platform} onCredits={actions.credits} />
      <GenexGroup menu={menu} actions={actions} />
      {menuGroups(menu).map((group) => (
        <MakerGroup key={group.maker} group={group} current={menu.current} onPick={actions.pick} />
      ))}
      <Struggling menu={menu} onPick={actions.pick} />
      <PickerSeparator />
      <ActionRow icon="power" onPress={() => actions.enable(menu.off)}>
        {menu.off ? WORDS.turnOn : WORDS.turnOff}
      </ActionRow>
      <ActionRow icon="flag" onPress={actions.report}>
        {WORDS.report}
      </ActionRow>
      <ActionRow icon="plus" quiet onPress={actions.addModels}>
        {WORDS.addModels}
      </ActionRow>
    </>
  );
}

/** What the menu shows while it reads, or when it could not. */
function MenuState({ status, retry }: { status: AiLoad; retry: () => void }): JSX.Element {
  if (status === AiLoad.Failed)
    return (
      <div className="play-ai-menu-state" role="alert">
        <span>{WORDS.failed}</span>
        <button type="button" data-ai-row className="play-ai-link" onClick={retry}>
          {WORDS.retry}
        </button>
      </div>
    );
  return (
    <p className="play-ai-menu-state" aria-busy="true">
      {WORDS.loading}
    </p>
  );
}

/** The model menu for `game`, under `pill`; `problem` says why a pick did nothing. */
export function PlayAiMenu({
  api,
  game,
  changed,
  pill,
  platform,
  problem,
  actions,
  onClose,
}: {
  api: BarApi;
  game: AiGameKey;
  changed: number;
  pill: RefObject<HTMLButtonElement | null>;
  platform: string;
  problem: string | null;
  actions: AiMenuActions;
  onClose: () => void;
}): JSX.Element {
  const { menu, status, retry } = useMenu(api, game, changed);
  return (
    <Popover
      open
      onOpenChange={(next, details) => {
        // A press on the pill itself closes the menu by its own click.
        const target = details.event?.target;
        if (!next && !(target instanceof Node && pill.current?.contains(target))) onClose();
      }}
    >
      <PopoverContent
        anchor={pill}
        side="bottom"
        align="end"
        sideOffset={6}
        collisionAvoidance={{ side: "shift", align: "shift" }}
        className="picker-panel play-ai-menu w-[288px] max-w-(--available-width) max-h-(--available-height) overflow-y-auto p-1.5"
        initialFocus={() => document.querySelector<HTMLElement>('.play-ai-menu [aria-checked="true"]') ?? true}
        onKeyDown={moveFocus}
      >
        <div role="menu" aria-label={WORDS.label} data-play-ai-menu>
          {menu ? (
            <MenuBody menu={menu} platform={platform} actions={actions} />
          ) : (
            <MenuState status={status} retry={retry} />
          )}
          {problem && (
            <p className="play-ai-problem" role="alert">
              {problem}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

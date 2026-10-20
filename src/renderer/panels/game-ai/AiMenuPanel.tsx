/**
 * The AI pill's model menu for a game in Create (`V3-Menu`), in the chat model menu's own rows
 * (`ui/ModelMenu.tsx`, `ui/PickerPanel.tsx`): what the game's AI costs on top, the Genex group,
 * the person's models grouped by maker with one tag each, the models the check marked weak folded
 * under "N more may struggle", then Turn off AI, Check models, Player reports and Add more models.
 * A pick that would first use a plan or money comes back as its one-sentence card (`V3-First`).
 */
import { type JSX, type KeyboardEvent, useState } from "react";
import { sizeWords } from "../../../shared/byte-size.ts";
import { AiDoor, AiFunding, type AiModelRef } from "../../../shared/game-ai.ts";
import { sameModel } from "../../../shared/game-ai-check.ts";
import {
  AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT,
  type AiConsentTicket,
  AiConsentKind,
  type AiMenuRow,
  type AiModelMenu,
  type AiStopReason,
} from "../../../shared/game-ai-views.ts";
import { hostPlatform } from "../../platform.ts";
import { Icon } from "../../ui/icons.tsx";
import { PickerLabel, PickerSeparator, pickerRow } from "../../ui/PickerPanel.tsx";
import { RovingAxis, rovingTarget } from "../../ui/roving-focus.ts";
import { AI_WORDS, countWords, CREATE_AI_WORDS, thisMachine, yourPlanWords } from "../../words.ts";
import type { StopAction } from "../../play/ai-model.ts";
import { makerOf, modelLabel, type StopCardView, tagWords, usageWords } from "./play-ai-view.ts";

const WORDS = CREATE_AI_WORDS;
/** The engine that names a model run on Genex credits (`AiModelRef.engine` for the platform doors). */
const GENEX_ENGINE = "genex";

/** The model the Genex row picks: the maker's pick, run on the person's Genex credits. */
export const creditsModel = (menu: AiModelMenu): AiModelRef | null =>
  menu.genex.recommended
    ? { door: AiDoor.GenexCredits, engine: GENEX_ENGINE, model: menu.genex.recommended.model }
    : null;

/** Up/Down/Home/End move between the menu's rows. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-ai-menu-row]")].filter(
    (row) => !row.disabled,
  );
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = rows.length ? rovingTarget(event.key, index, rows.length, RovingAxis.Vertical) : null;
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}

/** One model row: its name, its one tag, a check when it is the game's model. */
function ModelRow({
  row,
  current,
  onPick,
}: {
  row: AiMenuRow;
  current: AiModelRef | null;
  onPick: (model: AiModelRef) => void;
}): JSX.Element {
  const on = current !== null && sameModel(current, row.model);
  const tag = tagWords(row);
  return (
    <button
      type="button"
      data-ai-menu-row
      data-ai-model={`${row.model.door}/${row.model.engine}/${row.model.model}`}
      className={pickerRow}
      aria-pressed={on}
      disabled={!row.ready}
      title={row.ready ? row.label : WORDS.notReady}
      onClick={() => onPick(row.model)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{row.label}</span>
        {tag && (
          <span className="model-free-tag" data-ai-tag={row.tag}>
            {tag}
          </span>
        )}
      </span>
      {on && <Icon name="check" className="ml-auto" />}
    </button>
  );
}

/** The Genex group: Genex credits with the balance, or the way to sign in. */
function GenexRow({
  menu,
  onPick,
  onSignIn,
}: {
  menu: AiModelMenu;
  onPick: (model: AiModelRef) => void;
  onSignIn: () => void;
}): JSX.Element {
  const model = creditsModel(menu);
  const on = menu.current?.door === AiDoor.GenexCredits;
  if (!menu.genex.signedIn)
    return (
      <button type="button" data-ai-menu-row className={`${pickerRow} text-ink-2`} onClick={onSignIn}>
        {WORDS.signInForCredits}
        <Icon name="arrow-up-right" size={14} className="ml-auto" />
      </button>
    );
  return (
    <button
      type="button"
      data-ai-menu-row
      data-ai-genex-row
      className={pickerRow}
      aria-pressed={on}
      disabled={!model}
      onClick={() => model && onPick(model)}
    >
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate">{WORDS.genexRow}</span>
        <span className="truncate text-micro text-muted-foreground">
          {WORDS.genexRowWhat(menu.genex.recommendedLabel)}
        </span>
      </span>
      {menu.genex.balanceCredits !== null && (
        <span className="ml-auto font-mono text-micro text-ink-2">{countWords(menu.genex.balanceCredits)}</span>
      )}
    </button>
  );
}

/** What the menu offers beyond models. */
export interface AiMenuActions {
  onPick: (model: AiModelRef) => void;
  onEnable: (enabled: boolean) => void;
  onCheck: () => void;
  onReports: () => void;
  onAddModels: () => void;
  onSignIn: () => void;
}

/** The menu itself, for one game. */
export function AiMenuPanel({ menu, actions }: { menu: AiModelMenu; actions: AiMenuActions }): JSX.Element {
  const [folded, setFolded] = useState(true);
  const usage = usageWords(menu, hostPlatform());
  return (
    <div data-ai-menu={menu.game} onKeyDown={moveFocus}>
      <div className="play-ai-menu-top" data-ai-menu-usage>
        <span className="text-ink">{menu.title}</span>
        {usage && <span className="text-ink-3">{usage}</span>}
      </div>
      <PickerLabel first>{WORDS.genex}</PickerLabel>
      <GenexRow menu={menu} onPick={actions.onPick} onSignIn={actions.onSignIn} />
      {menu.groups.map((group) => (
        <div key={group.maker} role="group" aria-label={AI_WORDS.makers[group.maker]}>
          <PickerLabel>
            {AI_WORDS.makers[group.maker]}
            {group.funding === AiFunding.Plan && <span className="play-ai-menu-note">{AI_WORDS.yourPlan}</span>}
          </PickerLabel>
          {group.rows.map((row) => (
            <ModelRow
              key={`${row.model.door}/${row.model.model}`}
              row={row}
              current={menu.current}
              onPick={actions.onPick}
            />
          ))}
        </div>
      ))}
      {menu.struggling.length > 0 && (
        <>
          <button
            type="button"
            data-ai-menu-row
            className={`${pickerRow} text-ink-2`}
            aria-expanded={!folded}
            onClick={() => setFolded(!folded)}
          >
            {WORDS.struggling(menu.struggling.length)}
            <Icon name={folded ? "chevron-right" : "chevron-down"} size={14} className="ml-auto" />
          </button>
          {!folded &&
            menu.struggling.map((row) => (
              <ModelRow
                key={`${row.model.door}/${row.model.model}`}
                row={row}
                current={menu.current}
                onPick={actions.onPick}
              />
            ))}
        </>
      )}
      <PickerSeparator />
      <button
        type="button"
        data-ai-menu-row
        data-ai-menu-enable={menu.off ? "on" : "off"}
        className={`${pickerRow} text-ink-2`}
        onClick={() => actions.onEnable(menu.off)}
      >
        <Icon name="sparkle" />
        {menu.off ? WORDS.turnOn : WORDS.turnOff}
      </button>
      <button
        type="button"
        data-ai-menu-row
        data-ai-menu-check
        className={`${pickerRow} text-ink-2`}
        onClick={actions.onCheck}
      >
        <Icon name="check" />
        {WORDS.checkModels}
      </button>
      <button
        type="button"
        data-ai-menu-row
        data-ai-menu-reports
        className={`${pickerRow} text-ink-2`}
        onClick={actions.onReports}
      >
        <Icon name="info" />
        {WORDS.reports}
      </button>
      <button type="button" data-ai-menu-row className={`${pickerRow} text-ink-2`} onClick={actions.onAddModels}>
        <Icon name="plus" />
        {WORDS.addModels}
      </button>
    </div>
  );
}

/** Kinds whose second press opens the model menu, so it wears the menu's chevron. */
const changesModel = (kind: AiConsentKind): boolean =>
  kind === AiConsentKind.Plan || kind === AiConsentKind.Credits || kind === AiConsentKind.Key;

/** A card's sentence: the words around the one strong part. */
function Sentence({ before, strong, after }: { before: string; strong: string; after: string }): JSX.Element {
  return (
    <p className="text-ink">
      {before}
      <b className="font-medium">{strong}</b>
      {after}
    </p>
  );
}

/** What a card says, its fine print, and the words of its two presses. */
function cardWords(ticket: AiConsentTicket, menu: AiModelMenu | null) {
  const platform = hostPlatform();
  const consent = WORDS.consent;
  const model = ticket.modelLabel ?? (ticket.model ? modelLabel(menu, ticket.model) : "");
  switch (ticket.kind) {
    case AiConsentKind.Plan: {
      const sentence = consent.plan(ticket.title);
      const plan = yourPlanWords(menu && ticket.model ? makerOf(menu, ticket.model) : null);
      const small = consent.planSmall(ticket.keepForBuildingPercent ?? AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT);
      return {
        before: sentence.before,
        strong: model,
        after: sentence.after(plan),
        small,
        yes: consent.play,
        no: consent.change,
      };
    }
    case AiConsentKind.Credits: {
      const sentence = consent.credits(ticket.title);
      return { ...sentence, small: consent.creditsSmall(ticket.balanceCredits), yes: consent.play, no: consent.change };
    }
    case AiConsentKind.Key: {
      const sentence = consent.key(ticket.title);
      return {
        before: sentence.before,
        strong: model,
        after: sentence.after,
        small: consent.keySmall,
        yes: consent.play,
        no: consent.change,
      };
    }
    case AiConsentKind.Leaderboard: {
      const sentence = consent.leaderboard(ticket.title);
      const small = consent.leaderboardSmall(ticket.balanceCredits);
      return { ...sentence, small, yes: consent.onCredits, no: consent.unranked };
    }
    case AiConsentKind.SetUp: {
      const download = ticket.localDownloadBytes === null ? null : sizeWords(ticket.localDownloadBytes);
      const small = consent.setUpSmall(thisMachine(platform), download);
      return {
        before: consent.setUp(ticket.title),
        strong: "",
        after: "",
        small,
        yes: consent.setUpFree(thisMachine(platform)),
        no: AI_WORDS.signIn,
      };
    }
    default: {
      const sentence = consent.confirm(ticket.title);
      const strong = consent.confirmStrong(ticket.maxCredits ?? 0);
      return {
        before: sentence.before,
        strong,
        after: sentence.after,
        small: consent.confirmSmall,
        yes: consent.allow,
        no: consent.notNow,
      };
    }
  }
}

/**
 * A first-use card (`V3-First`): one sentence with its model in bold, the fine print, and two
 * presses. Play is never the focused default; the second press changes the model, plays
 * unranked, signs in or says not now, by the card's kind.
 */
export function ConsentCard({
  ticket,
  menu,
  busy,
  onAnswer,
  onChange,
  onSignIn,
}: {
  ticket: AiConsentTicket;
  menu: AiModelMenu | null;
  busy: boolean;
  onAnswer: (approve: boolean, unranked: boolean) => void;
  onChange: () => void;
  onSignIn: () => void;
}): JSX.Element {
  const words = cardWords(ticket, menu);
  const second = () => {
    if (ticket.kind === AiConsentKind.Leaderboard) onAnswer(true, true);
    else if (ticket.kind === AiConsentKind.SetUp) onSignIn();
    else if (ticket.kind === AiConsentKind.GenexConfirm) onAnswer(false, false);
    else onChange();
  };
  return (
    <div className="stage-ai-card" data-ai-consent={ticket.kind} role="group" aria-label={ticket.title}>
      <Sentence before={words.before} strong={words.strong} after={words.after} />
      <p className="text-ink-3">{words.small}</p>
      <div className="play-ai-card-presses">
        <button
          type="button"
          className="people-button"
          data-tone="primary"
          data-ai-consent-yes
          disabled={busy}
          onClick={() => onAnswer(true, false)}
        >
          {words.yes}
        </button>
        <button type="button" className="people-button" data-ai-consent-other disabled={busy} onClick={second}>
          {words.no}
          {changesModel(ticket.kind) && <Icon name="chevron-down" size={12} />}
        </button>
      </div>
    </div>
  );
}

/**
 * A stop card main pushed for a Create playtest (`V3-Stops`): one line, its fine print and the ways
 * on it offers, the same as Play's. Its presses wait out {@link busy} (the 600 ms gate).
 */
export function StopCard({
  view,
  reason,
  title,
  busy,
  onPress,
}: {
  view: StopCardView;
  reason: AiStopReason;
  title: string;
  busy: boolean;
  onPress: (action: StopAction) => void;
}): JSX.Element {
  return (
    <div className="stage-ai-card" data-ai-stop={reason} role="group" aria-label={title}>
      <p className="text-ink">{view.line}</p>
      <p className="text-ink-3">{view.small}</p>
      <div className="play-ai-card-presses">
        {view.presses.map((press, at) => (
          <button
            key={press.action}
            type="button"
            className="people-button"
            data-tone={at === 0 ? "primary" : undefined}
            data-ai-stop-action={press.action}
            disabled={busy}
            onClick={() => onPress(press.action)}
          >
            {press.label}
          </button>
        ))}
      </div>
    </div>
  );
}

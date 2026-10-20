/**
 * Settings → Play-time AI (`V3-Settings`): how games pick a model and where the models come from,
 * the person's Genex credits with Get credits and auto top-up (off by default, held by genex.games
 * to at most once a day and three times a month), the optional limits, every game that used AI with
 * Turn off, and, for game makers, the Create Live route, the plan in playtests and counts-only fit.
 */
import { type JSX, type ReactNode, useCallback, useEffect, useState } from "react";
import {
  AI_AUTO_TOPUP_ADD_CREDITS,
  AI_AUTO_TOPUP_MAX_PER_DAY,
  AI_AUTO_TOPUP_MAX_PER_MONTH,
  AI_AUTO_TOPUP_UNDER_CREDITS,
  AI_DEFAULT_DAILY_ALERT_CREDITS,
  type AiActivity,
  type AiAutoTopUp,
  type AiGameRow,
  AiPickPolicy,
  type GameAiSettingsPatch,
  type GameAiSettingsView,
} from "../../../shared/game-ai-views.ts";
import { useGenexSignIn } from "../../play/use-genex-sign-in.ts";
import { Button } from "../../ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { Switch } from "../../ui/switch.tsx";
import { AI_SETTINGS_WORDS, AI_WORDS, countWords, creditsWords, dollarLimitWords, problemWords } from "../../words.ts";
import { GetCreditsDialog } from "./GetCreditsDialog.tsx";
import { gameLine } from "./play-ai-view.ts";
import { useGameAiNotices } from "./use-game-ai.ts";

const WORDS = AI_SETTINGS_WORDS;
/** USD micros in a dollar. */
const MICROS_PER_DOLLAR = 1_000_000;

/** What each limit's menu offers. A value already saved that is not listed shows as itself. */
const UNDER_OPTIONS = [AI_AUTO_TOPUP_UNDER_CREDITS, 250, 500] as const;
const ADD_OPTIONS = [500, AI_AUTO_TOPUP_ADD_CREDITS, 2_500, 5_000] as const;
const ALERT_OPTIONS = [100, 250, AI_DEFAULT_DAILY_ALERT_CREDITS, 1_000, 2_500] as const;
const KEEP_OPTIONS = [25, 50, 75] as const;
const OPENROUTER_DOLLAR_OPTIONS = [5, 10, 25, 50, 100] as const;
/** The menu value that means "no limit" or "no alert". */
const NONE = "none";

/** One option of a settings menu. */
interface ChoiceOption {
  value: string;
  label: string;
}

/** Options with the saved value in them, sorted as numbers, the unset choice first. */
function withSaved(options: readonly ChoiceOption[], saved: ChoiceOption): ChoiceOption[] {
  const all = options.some((option) => option.value === saved.value) ? [...options] : [...options, saved];
  return all.sort((a, b) => (a.value === NONE ? -1 : Number(a.value) - Number(b.value)));
}

/** A setting's menu: its value on the button, a radio list under it. */
function SettingChoice({
  label,
  value,
  options,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  options: readonly ChoiceOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  testId: string;
}): JSX.Element {
  const shown = options.find((option) => option.value === value)?.label ?? value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="secondary" className="play-ai-choice" aria-label={label} data-play-ai-choice={testId}>
          <span className="min-w-0 flex-1 truncate text-left">{shown}</span>
          <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="appearance-menu">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="py-2">
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One row: what it is and why on the left, its controls on the right. */
function Row({
  title,
  what,
  children,
  testId,
}: {
  title: ReactNode;
  what?: ReactNode;
  children?: ReactNode;
  testId: string;
}): JSX.Element {
  return (
    <div className="appearance-row" data-play-ai-row={testId}>
      <span className="flex min-w-0 flex-col">
        <span className="text-ink">{title}</span>
        {what && <span className="text-ink-3">{what}</span>}
      </span>
      {children && <span className="play-ai-controls">{children}</span>}
    </div>
  );
}

/** A group's label above its card, with an optional quiet note beside it. */
function Group({ label, note, children }: { label: string; note?: string; children: ReactNode }): JSX.Element {
  return (
    <section aria-label={label} className="play-ai-group">
      <h3 className="play-ai-group-label">
        {label}
        {note && <span>{note}</span>}
      </h3>
      <div className="appearance-theme settings-rows">{children}</div>
    </section>
  );
}

/** Models: how games pick, and where the list of models comes from. */
function ModelsGroup({
  view,
  save,
  onOpenProviders,
}: {
  view: GameAiSettingsView;
  save: (patch: GameAiSettingsPatch) => void;
  onOpenProviders: () => void;
}): JSX.Element {
  const options = Object.values(AiPickPolicy).map((pick) => ({ value: pick, label: WORDS.pickOptions[pick] }));
  return (
    <Group label={WORDS.models}>
      <Row title={WORDS.pick} what={WORDS.pickWhat[view.pick]} testId="pick">
        <SettingChoice
          label={WORDS.pick}
          value={view.pick}
          options={options}
          testId="pick"
          onChange={(value) => {
            const pick = Object.values(AiPickPolicy).find((policy) => policy === value);
            if (pick) save({ pick });
          }}
        />
      </Row>
      <Row title={WORDS.modelsCanUse} what={WORDS.modelsCanUseWhat} testId="models">
        <Button onClick={onOpenProviders} data-play-ai-providers>
          {WORDS.openProviders}
          <Icon name="chevron-right" size={14} />
        </Button>
      </Row>
    </Group>
  );
}

/** Auto top-up's threshold, amount and switch; changing either amount keeps the switch as it is. */
function TopUpRow({ topUp, save }: { topUp: AiAutoTopUp | null; save: (patch: GameAiSettingsPatch) => void }) {
  const current = topUp ?? {
    on: false,
    underCredits: AI_AUTO_TOPUP_UNDER_CREDITS,
    addCredits: AI_AUTO_TOPUP_ADD_CREDITS,
  };
  const under = withSaved(
    UNDER_OPTIONS.map((credits) => ({ value: String(credits), label: WORDS.topUpUnder(credits) })),
    { value: String(current.underCredits), label: WORDS.topUpUnder(current.underCredits) },
  );
  const add = withSaved(
    ADD_OPTIONS.map((credits) => ({ value: String(credits), label: WORDS.topUpAdd(credits) })),
    { value: String(current.addCredits), label: WORDS.topUpAdd(current.addCredits) },
  );
  const unread = topUp === null;
  return (
    <Row
      title={WORDS.topUp}
      what={WORDS.topUpWhat(AI_AUTO_TOPUP_MAX_PER_DAY, AI_AUTO_TOPUP_MAX_PER_MONTH)}
      testId="top-up"
    >
      <SettingChoice
        label={WORDS.topUpUnderLabel}
        value={String(current.underCredits)}
        options={under}
        disabled={unread}
        testId="top-up-under"
        onChange={(value) => save({ autoTopUp: { ...current, underCredits: Number(value) } })}
      />
      <SettingChoice
        label={WORDS.topUpAddLabel}
        value={String(current.addCredits)}
        options={add}
        disabled={unread}
        testId="top-up-add"
        onChange={(value) => save({ autoTopUp: { ...current, addCredits: Number(value) } })}
      />
      <Switch
        aria-label={WORDS.topUp}
        checked={current.on}
        disabled={unread}
        data-play-ai-top-up=""
        onCheckedChange={(on) => save({ autoTopUp: { ...current, on } })}
      />
    </Row>
  );
}

/** Genex credits: the balance and Get credits, then auto top-up; signed out, the way to sign in. */
function CreditsGroup({
  view,
  save,
  onGetCredits,
}: {
  view: GameAiSettingsView;
  save: (patch: GameAiSettingsPatch) => void;
  onGetCredits: () => void;
}): JSX.Element {
  const { busy, signIn } = useGenexSignIn();
  if (!view.signedIn)
    return (
      <Group label={WORDS.credits}>
        <Row title={WORDS.signedOut} testId="signed-out">
          <Button variant="default" busy={busy} onClick={signIn} data-genex-sign-in>
            {AI_WORDS.signIn}
            <Icon name="arrow-up-right" size={14} />
          </Button>
        </Row>
      </Group>
    );
  const balance = view.balanceCredits === null ? WORDS.creditsUnread : creditsWords(view.balanceCredits);
  return (
    <Group label={WORDS.credits}>
      <Row title={<span data-play-ai-balance>{balance}</span>} what={WORDS.creditsWhat} testId="balance">
        <Button variant="default" onClick={onGetCredits} data-play-ai-get-credits>
          {AI_WORDS.getCredits}
        </Button>
      </Row>
      <TopUpRow topUp={view.autoTopUp} save={save} />
    </Group>
  );
}

/** The optional limits: a daily alert per game, the share of a plan kept for building, the key's month. */
function LimitsGroup({
  view,
  save,
}: {
  view: GameAiSettingsView;
  save: (patch: GameAiSettingsPatch) => void;
}): JSX.Element {
  const alertLabel = (credits: number) => countWords(credits);
  const alert = withSaved(
    [{ value: NONE, label: WORDS.alertOff }, ...ALERT_OPTIONS.map((c) => ({ value: String(c), label: alertLabel(c) }))],
    view.dailyAlertCredits === null
      ? { value: NONE, label: WORDS.alertOff }
      : { value: String(view.dailyAlertCredits), label: alertLabel(view.dailyAlertCredits) },
  );
  const keep = withSaved(
    KEEP_OPTIONS.map((percent) => ({ value: String(percent), label: WORDS.percent(percent) })),
    { value: String(view.keepForBuildingPercent), label: WORDS.percent(view.keepForBuildingPercent) },
  );
  const monthly = view.openRouterMonthlyMicros;
  const openRouter = withSaved(
    [
      { value: NONE, label: WORDS.openRouterNone },
      ...OPENROUTER_DOLLAR_OPTIONS.map((dollars) => ({
        value: String(dollars * MICROS_PER_DOLLAR),
        label: dollarLimitWords(dollars * MICROS_PER_DOLLAR),
      })),
    ],
    monthly === null
      ? { value: NONE, label: WORDS.openRouterNone }
      : { value: String(monthly), label: dollarLimitWords(monthly) },
  );
  return (
    <Group label={WORDS.limits} note={WORDS.limitsNote}>
      <Row title={WORDS.alert} what={WORDS.alertWhat} testId="alert">
        <SettingChoice
          label={WORDS.alert}
          value={view.dailyAlertCredits === null ? NONE : String(view.dailyAlertCredits)}
          options={alert}
          testId="alert"
          onChange={(value) => save({ dailyAlertCredits: value === NONE ? null : Number(value) })}
        />
      </Row>
      <Row title={WORDS.keep} what={WORDS.keepWhat} testId="keep">
        <SettingChoice
          label={WORDS.keep}
          value={String(view.keepForBuildingPercent)}
          options={keep}
          testId="keep"
          onChange={(value) => save({ keepForBuildingPercent: Number(value) })}
        />
      </Row>
      <Row title={WORDS.openRouter} testId="openrouter">
        <SettingChoice
          label={WORDS.openRouter}
          value={monthly === null ? NONE : String(monthly)}
          options={openRouter}
          testId="openrouter"
          onChange={(value) => save({ openRouterMonthlyMicros: value === NONE ? null : Number(value) })}
        />
      </Row>
    </Group>
  );
}

/** Every game that used AI, with how it runs and Turn off / Turn on. */
function GamesGroup({
  games,
  busy,
  onEnable,
}: {
  games: readonly AiGameRow[];
  busy: string | null;
  onEnable: (row: AiGameRow) => void;
}): JSX.Element {
  return (
    <Group label={WORDS.games}>
      {games.length === 0 && (
        <Row title={<span className="text-ink-3">{WORDS.gamesEmpty}</span>} testId="games-empty" />
      )}
      {games.map((row) => (
        <Row key={row.game} title={row.title} what={gameLine(row)} testId={`game:${row.game}`}>
          <Button
            aria-label={row.on ? WORDS.turnOffLabel(row.title) : WORDS.turnOnLabel(row.title)}
            busy={busy === row.game}
            disabled={busy !== null}
            data-play-ai-game={row.game}
            onClick={() => onEnable(row)}
          >
            {row.on ? WORDS.turnOff : WORDS.turnOn}
          </Button>
        </Row>
      ))}
    </Group>
  );
}

/** For game makers: AI in Create's own playtests, the plan there, and counts-only fit. */
function MakersGroup({
  view,
  save,
}: {
  view: GameAiSettingsView;
  save: (patch: GameAiSettingsPatch) => void;
}): JSX.Element {
  const rows = [
    { key: "createRouteEnabled", title: WORDS.createRoute, what: WORDS.createRouteWhat, on: view.createRouteEnabled },
    { key: "allowPlan", title: WORDS.allowPlan, what: WORDS.allowPlanWhat, on: view.allowPlan },
    { key: "shareFitCounts", title: WORDS.shareFit, what: WORDS.shareFitWhat, on: view.shareFitCounts },
  ] as const;
  return (
    <Group label={WORDS.makers}>
      {rows.map((row) => (
        <Row key={row.key} title={row.title} what={row.what} testId={row.key}>
          <Switch
            aria-label={row.title}
            checked={row.on}
            data-play-ai-switch={row.key}
            onCheckedChange={(on) => save({ [row.key]: on })}
          />
        </Row>
      ))}
    </Group>
  );
}

/** Settings and the Games list, read on open and again when main says a game's AI changed. */
function usePlayAiSettings() {
  const [view, setView] = useState<GameAiSettingsView | null>(null);
  const [activity, setActivity] = useState<AiActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const read = useCallback(async () => {
    try {
      const [settings, games] = await Promise.all([window.studio.gameAiSettings(), window.studio.gameAiActivity()]);
      setView(settings);
      setActivity(games);
    } catch (cause) {
      setError(problemWords(cause));
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read]);
  useGameAiNotices(useCallback(() => void read(), [read]));
  const save = (patch: GameAiSettingsPatch) => {
    setError(null);
    window.studio
      .gameAiSettingsSave(patch)
      .then(setView)
      .catch((cause) => setError(problemWords(cause)));
  };
  const enable = async (row: AiGameRow) => {
    setBusy(row.game);
    setError(null);
    try {
      await window.studio.gameAiEnable(row.game, !row.on);
      setActivity(await window.studio.gameAiActivity());
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setBusy(null);
    }
  };
  return { view, activity, error, busy, save, enable };
}

/** Settings → Play-time AI. */
export function PlayAiSection({ onOpenProviders }: { onOpenProviders: () => void }): JSX.Element {
  const { view, activity, error, busy, save, enable } = usePlayAiSettings();
  const [buying, setBuying] = useState(false);
  const alert = error && (
    <p role="alert" className="mt-2 text-red">
      {error}
    </p>
  );
  if (!view || !activity)
    return (
      <div data-play-ai-settings className="appearance-section">
        {alert || (
          <p role="status" className="text-ink-3">
            {WORDS.loading}
          </p>
        )}
      </div>
    );
  return (
    <div data-play-ai-settings className="appearance-section play-ai-section">
      <ModelsGroup view={view} save={save} onOpenProviders={onOpenProviders} />
      <CreditsGroup view={view} save={save} onGetCredits={() => setBuying(true)} />
      <LimitsGroup view={view} save={save} />
      <GamesGroup games={activity.games} busy={busy} onEnable={(row) => void enable(row)} />
      <MakersGroup view={view} save={save} />
      {alert}
      {buying && <GetCreditsDialog topUp={view.autoTopUp} onTopUp={save} onDismiss={() => setBuying(false)} />}
    </div>
  );
}

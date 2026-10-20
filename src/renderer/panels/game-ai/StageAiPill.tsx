/**
 * Create's AI control for one game (`V3-Create-States`), in two dresses. On the stage strip it is
 * the same pill as Play's, the chat's model button for the game's play-time AI: it names the model
 * ("Claude Haiku 4.5", "Qwen3 8B · Free", "Credits · 1,240", "AI off", "AI · Saved playtest") and
 * opens the model menu. On an engine's Live card (Unreal, Godot, Unity, Rust + wgpu) it is one dot
 * and one quiet line, with Choose when a model is due; it never takes the engine's own button.
 * A pick or a playtest that would first use a plan or credits shows its one-sentence card in the
 * same place; playtests follow the same rules as Play. The menu also opens the optional model
 * check and the game's Player reports.
 */
import { type JSX, type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { type AiGameKey, type AiModelRef, createGameKey } from "../../../shared/game-ai.ts";
import {
  type AiConsentTicket,
  AiConsentRefusal,
  type AiModelMenu,
  AiPause,
  type AiStopCard,
} from "../../../shared/game-ai-views.ts";
import { StopAction } from "../../play/ai-model.ts";
import { useGenexSignIn } from "../../play/use-genex-sign-in.ts";
import { hostPlatform } from "../../platform.ts";
import { openSettings, SettingsSection } from "../../settings-navigation.ts";
import { cn } from "../../ui/cn.ts";
import { Icon } from "../../ui/icons.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover.tsx";
import { CREATE_AI_WORDS, ENGINE_AI_WORDS, problemWords } from "../../words.ts";
import { type AiMenuActions, AiMenuPanel, ConsentCard, StopCard } from "./AiMenuPanel.tsx";
import { ModelCheckDialog } from "./ModelCheckDialog.tsx";
import { engineAiLine, type EngineAiLineView, PillState, pillView, stopCardView, usesAi } from "./play-ai-view.ts";
import { ReportInbox } from "./ReportInbox.tsx";
import { useAiMenu, useAiPending } from "./use-game-ai.ts";

const WORDS = CREATE_AI_WORDS;
/** A card's commit presses wait this long after it shows, so a click meant for the game never answers it. */
const CARD_COMMIT_GATE_MS = 600;
/** The dialogs the menu opens. */
const AiDialog = { None: "none", Check: "check", Reports: "reports" } as const;
type AiDialog = (typeof AiDialog)[keyof typeof AiDialog];
/** How the control is dressed: the strip's pill, or the engine card's line. */
export const AiControlDress = { Pill: "pill", Line: "line" } as const;
export type AiControlDress = (typeof AiControlDress)[keyof typeof AiControlDress];

/** Whether a card's commit presses are open yet: false for its first {@link CARD_COMMIT_GATE_MS}. */
function useCommitGate(ticket: string | null): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    if (!ticket) return;
    const timer = window.setTimeout(() => setOpen(true), CARD_COMMIT_GATE_MS);
    return () => window.clearTimeout(timer);
  }, [ticket]);
  return open;
}

/** The card on show, from a pick or pushed by main, and its answer. */
function useConsent(game: AiGameKey, refresh: () => Promise<void>) {
  const pending = useAiPending(game);
  const [picked, setPicked] = useState<AiConsentTicket | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = picked ?? pending.consent;
  const gateOpen = useCommitGate(ticket?.ticket ?? null);
  const close = () => {
    setPicked(null);
    setChanging(false);
    pending.clearConsent();
  };
  const answer = async (approve: boolean, unranked: boolean, model: AiModelRef | null = null): Promise<boolean> => {
    if (!ticket || !gateOpen) return false;
    setError(null);
    try {
      const result = await window.studio.gameAiAnswer({ ticket: ticket.ticket, approve, model, unranked });
      if (!result.ok && result.code === AiConsentRefusal.TooSoon) return false;
      if (!result.ok && result.code === AiConsentRefusal.Unavailable) {
        setChanging(true);
        return false;
      }
      close();
      await refresh();
      return true;
    } catch (cause) {
      setError(problemWords(cause));
      return false;
    }
  };
  return {
    ticket,
    stop: pending.stop,
    clearStop: pending.clearStop,
    picked: setPicked,
    changing,
    setChanging,
    answer,
    gateOpen,
    error,
    setError,
  };
}

/** What a stop card's press does in Create: every one settles the card, then goes its way on. */
function useStopActions(
  game: AiGameKey,
  consent: ReturnType<typeof useConsent>,
  ways: {
    pick: (model: AiModelRef) => Promise<void>;
    enable: (on: boolean) => Promise<void>;
    refresh: () => Promise<void>;
  },
  show: (open: boolean) => void,
) {
  const resume = async (pause: AiPause) => {
    try {
      await window.studio.gameAiResume(game, pause);
      consent.clearStop();
      await ways.refresh();
      show(false);
    } catch (cause) {
      consent.setError(problemWords(cause));
    }
  };
  const leave = () => {
    consent.clearStop();
    show(false);
  };
  return (action: StopAction, card: AiStopCard): void => {
    const run: Record<StopAction, () => void> = {
      [StopAction.GetCredits]: () => {
        leave();
        openSettings(SettingsSection.PlayAi, null);
      },
      [StopAction.UseAlternative]: () => {
        consent.clearStop();
        if (card.alternative) void ways.pick(card.alternative);
      },
      [StopAction.Change]: () => consent.clearStop(),
      [StopAction.UseAnother]: () => consent.clearStop(),
      [StopAction.KeepPlaying]: () => void resume(AiPause.DailyAlert),
      [StopAction.Resume]: () => void resume(AiPause.AutoTopUp),
      [StopAction.TurnOn]: () => {
        consent.clearStop();
        void ways.enable(true);
      },
      [StopAction.Ok]: leave,
      [StopAction.Keep]: leave,
      [StopAction.StopToday]: leave,
      [StopAction.BackToPlay]: leave,
    };
    run[action]();
  };
}

/** The pill's face: a sparkle, the model's name and its one tag. */
function PillFace({ view }: { view: ReturnType<typeof pillView> }): JSX.Element {
  return (
    <>
      <Icon name="sparkle" size={14} />
      <span className="truncate">{view.label}</span>
      {view.tag && (
        <span className="play-ai-pill-tag" data-low={view.low || undefined}>
          {view.tag}
        </span>
      )}
    </>
  );
}

/** The engine card's line: a dot in its tone and the words. */
function LineFace({ line }: { line: EngineAiLineView }): JSX.Element {
  return (
    <span className="play-ai-line-text" role="status">
      <span className="play-ai-dot" data-tone={line.tone} aria-hidden />
      <span className="truncate">{line.text}</span>
    </span>
  );
}

/** What picking a model, turning AI on or off and the dialogs do for one game. */
function useControlActions(
  game: AiGameKey,
  refresh: () => Promise<void>,
  consent: ReturnType<typeof useConsent>,
  show: (open: boolean) => void,
) {
  const [dialog, setDialog] = useState<AiDialog>(AiDialog.None);
  const pick = async (model: AiModelRef) => {
    consent.setError(null);
    try {
      if (consent.ticket && consent.changing) {
        if (await consent.answer(true, false, model)) show(false);
        return;
      }
      const result = await window.studio.gameAiPick(game, model);
      if (!result.ok) {
        consent.picked(result.consent);
        return;
      }
      await refresh();
      show(false);
    } catch (cause) {
      consent.setError(problemWords(cause));
    }
  };
  const enable = async (enabled: boolean) => {
    try {
      await window.studio.gameAiEnable(game, enabled);
      await refresh();
    } catch (cause) {
      consent.setError(problemWords(cause));
    }
  };
  const openDialog = (next: AiDialog) => {
    show(false);
    setDialog(next);
  };
  return { dialog, setDialog, pick, enable, openDialog };
}

/** Enter or Space held down never answers a card or picks a model twice. */
const ignoreRepeat = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
};

/** What the open control shows: the card waiting on the person, else a stop main pushed, else the model menu. */
function ControlPanel({
  menu,
  consent,
  actions,
  stopGateOpen,
  onStop,
  onDone,
  onSignIn,
}: {
  menu: AiModelMenu | null;
  consent: ReturnType<typeof useConsent>;
  actions: AiMenuActions;
  stopGateOpen: boolean;
  onStop: (action: StopAction, card: AiStopCard) => void;
  onDone: () => void;
  onSignIn: () => void;
}): JSX.Element | null {
  const asking = consent.ticket !== null && !consent.changing;
  const { stop } = consent;
  if (!asking && stop)
    return (
      <StopCard
        view={stopCardView(stop, hostPlatform())}
        reason={stop.reason}
        title={stop.title}
        busy={!stopGateOpen}
        onPress={(action) => onStop(action, stop)}
      />
    );
  if (asking && consent.ticket)
    return (
      <ConsentCard
        ticket={consent.ticket}
        menu={menu}
        busy={!consent.gateOpen}
        onAnswer={(approve, unranked) => void consent.answer(approve, unranked).then((done) => done && onDone())}
        onChange={() => consent.setChanging(true)}
        onSignIn={onSignIn}
      />
    );
  return menu ? <AiMenuPanel menu={menu} actions={actions} /> : null;
}

/** The press that opens the control: the strip's pill, or the engine line's Choose. */
function ControlTrigger({
  pill,
  view,
  asking,
  trigger,
}: {
  pill: boolean;
  view: ReturnType<typeof pillView>;
  asking: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  return (
    <PopoverTrigger
      ref={trigger}
      render={<button type="button" />}
      aria-label={pill ? WORDS.pillLabel(view.label) : ENGINE_AI_WORDS.choose}
      aria-busy={view.state === PillState.Loading || undefined}
      data-stage-ai={pill ? view.state : undefined}
      data-engine-ai-choose={pill ? undefined : ""}
      data-asking={asking || undefined}
      className={cn(pill ? "stage-ai-pill no-drag" : "play-ai-line-choose", asking && "play-ai-pill-asking")}
    >
      {pill ? <PillFace view={view} /> : ENGINE_AI_WORDS.choose}
    </PopoverTrigger>
  );
}

/** The dialogs the menu opens: the model check and Player reports. */
function ControlDialogs({
  dialog,
  project,
  title,
  onPlayNow,
  onClose,
}: {
  dialog: AiDialog;
  project: string;
  title: string;
  onPlayNow: () => void;
  onClose: () => void;
}): JSX.Element | null {
  if (dialog === AiDialog.Check)
    return (
      <ModelCheckDialog
        project={project}
        title={title}
        onPlayNow={() => {
          onClose();
          onPlayNow();
        }}
        onClose={onClose}
      />
    );
  if (dialog === AiDialog.Reports) return <ReportInbox project={project} title={title} onClose={onClose} />;
  return null;
}

/** The control's open state, told to the stage so the native game view steps aside while it is open. */
function useOpen(onOpenChange: (open: boolean) => void) {
  const [open, setOpen] = useState(false);
  const show = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  return { open, show };
}

/** The game's AI as one control, its menu, its cards and the dialogs it opens. */
export function AiModelControl({
  project,
  title,
  dress,
  onOpenChange,
  onPlayNow,
}: {
  project: string;
  title: string;
  dress: AiControlDress;
  /** The menu opened or closed: the native game view steps aside while it is open. */
  onOpenChange: (open: boolean) => void;
  /** Start the game's Live playtest (the check's empty state). */
  onPlayNow: () => void;
}): JSX.Element | null {
  const game = createGameKey(project);
  const { menu, refresh } = useAiMenu(game);
  const consent = useConsent(game, refresh);
  const { signIn } = useGenexSignIn();
  const trigger = useRef<HTMLButtonElement>(null);
  const { open, show } = useOpen(onOpenChange);
  const { dialog, setDialog, pick, enable, openDialog } = useControlActions(game, refresh, consent, show);
  const onStop = useStopActions(game, consent, { pick, enable, refresh }, show);
  const stopGateOpen = useCommitGate(consent.stop ? `${consent.stop.reason} ${consent.stop.game}` : null);
  const view = pillView(menu);
  const line = engineAiLine(menu, { stop: consent.stop, consent: consent.ticket !== null }, hostPlatform());
  const pill = dress === AiControlDress.Pill;
  // A card or a stop main pushes for this game opens the control where it is (playtests follow Play's rules).
  useEffect(() => {
    if (consent.ticket || consent.stop) show(true);
  }, [consent.ticket, consent.stop, show]);
  // A game that never used AI keeps the strip and the card as they were; its first card brings the control.
  const hidden = pill ? !usesAi(menu) && !consent.ticket && !consent.stop : line === null;
  if (hidden && dialog === AiDialog.None) return null;
  const actions: AiMenuActions = {
    onPick: (model) => void pick(model),
    onEnable: (enabled) => void enable(enabled),
    onCheck: () => openDialog(AiDialog.Check),
    onReports: () => openDialog(AiDialog.Reports),
    onAddModels: () => {
      show(false);
      openSettings(SettingsSection.Providers, trigger.current);
    },
    onSignIn: signIn,
  };
  const triggered = pill || line?.choose === true || consent.ticket !== null || consent.stop !== null;
  const waiting = (consent.ticket !== null && !consent.changing) || consent.stop !== null;
  return (
    <>
      <Popover open={open} onOpenChange={(next) => show(next)}>
        {!pill && line && (
          <span className="play-ai-line" data-engine-ai={line.tone}>
            <LineFace line={line} />
          </span>
        )}
        {triggered && <ControlTrigger pill={pill} view={view} asking={waiting} trigger={trigger} />}
        <PopoverContent
          side={pill ? "bottom" : "top"}
          align="end"
          sideOffset={8}
          className="picker-panel w-[300px] max-w-(--available-width) max-h-(--available-height) overflow-y-auto p-1.5"
          aria-label={WORDS.menuLabel}
          onKeyDown={ignoreRepeat}
        >
          <ControlPanel
            menu={menu}
            consent={consent}
            actions={actions}
            stopGateOpen={stopGateOpen}
            onStop={onStop}
            onDone={() => show(false)}
            onSignIn={signIn}
          />
          {consent.error && (
            <p role="alert" className="px-2 py-1 text-red">
              {consent.error}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <ControlDialogs
        dialog={dialog}
        project={project}
        title={title}
        onPlayNow={onPlayNow}
        onClose={() => setDialog(AiDialog.None)}
      />
    </>
  );
}

/** Create's AI pill on the stage strip. */
export function StageAiPill(props: {
  project: string;
  title: string;
  onOpenChange: (open: boolean) => void;
  onPlayNow: () => void;
}): JSX.Element | null {
  return <AiModelControl {...props} dress={AiControlDress.Pill} />;
}

/** Nothing to do when an engine card's menu opens: the card is no native view. */
const NO_VIEW = () => {};

/** The engine Live card's AI line (Unreal and plugin engines): one dot, one line, Choose when a model is due. */
export function EngineAiLine({ project, title }: { project: string; title: string }): JSX.Element {
  return (
    <div className="play-ai-engine" data-engine-ai-line>
      <AiModelControl
        project={project}
        title={title}
        dress={AiControlDress.Line}
        onOpenChange={NO_VIEW}
        onPlayNow={NO_VIEW}
      />
    </div>
  );
}

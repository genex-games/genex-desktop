/**
 * The person's eject of a Rust game's engine (extension ladder level 5, `studio:engine.eject` and
 * `studio:engine.uneject`): above the stage like the trust row. Ejecting copies the engine the
 * game builds with into its `engine/` folder, where it becomes the game's own code: engine updates
 * stop, and Live and export wait for a passing conformance run of each new build. Giving the
 * engine back takes a snapshot of the game first. Both ask before they act. No agent can press
 * either: an agent can only suggest them in chat.
 */
import { type JSX, useState } from "react";
import { type EngineEjectAnswer, ExtensionRefusal } from "../../../shared/game-conformance.ts";
import { type GameProject, GameStack, stackOf } from "../../../shared/game-project.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { t } from "../../../shared/i18n.ts";

/** Where the row stands: the engine the game builds with, or the question before a change. */
const EjectStep = {
  Store: "store",
  AskingEject: "asking-eject",
  Ejected: "ejected",
  AskingGiveBack: "asking-give-back",
} as const;
type EjectStep = (typeof EjectStep)[keyof typeof EjectStep];

/** The row's own words. */
const MESSAGE = {
  heading: t("Game engine"),
  store: t("Genex’s engine: it updates with Genex."),
  ejected: (version: string | null) =>
    version
      ? t(
          "This game’s own copy of engine {version}, in its engine folder. It no longer updates; Live and export need a passing conformance run of each build.",
          { version },
        )
      : t(
          "This game’s own copy, in its engine folder. It no longer updates; Live and export need a passing conformance run of each build.",
        ),
  askEject: t(
    "Copy the engine into this game’s engine folder? The game stops getting engine updates, and Live and export wait until each new build passes the conformance checks.",
  ),
  askGiveBack: t(
    "Go back to Genex’s engine? Genex saves a snapshot of the game first, then removes its engine folder and every change in it.",
  ),
  eject: t("Eject engine"),
  confirmEject: t("Eject"),
  giveBack: t("Use Genex’s engine"),
  confirmGiveBack: t("Remove the engine folder"),
  cancel: t("Cancel"),
  refusal: {
    [ExtensionRefusal.EjectTargetExists]: t(
      "This game already has an engine folder, so nothing was copied. Remove it or use Genex’s engine first.",
    ),
    [ExtensionRefusal.EjectSourceTampered]: t(
      "Genex’s copy of the engine doesn’t match its checksums, so nothing was copied. Reinstall the Rust setup and try again.",
    ),
    [ExtensionRefusal.EjectLockMissing]: t(
      "The engine this game was built with is no longer installed, so nothing was copied. Build the game once, then try again.",
    ),
    [ExtensionRefusal.EjectNeedsMac]: t(
      "Ejecting needs a Mac, with macOS among this game’s destinations: the conformance checks run on its Mac build. Nothing was copied.",
    ),
    [ExtensionRefusal.Unavailable]: t("This version of Genex can’t eject an engine."),
  } as Partial<Record<ExtensionRefusal, string>>,
  refused: t("The engine didn’t change."),
} as const;

/** What the row says for `step`, or the last answer's refusal. */
function statusWords(step: EjectStep, version: string | null, refusal: ExtensionRefusal | null): string {
  if (refusal) return MESSAGE.refusal[refusal] ?? MESSAGE.refused;
  if (step === EjectStep.AskingEject) return MESSAGE.askEject;
  if (step === EjectStep.AskingGiveBack) return MESSAGE.askGiveBack;
  return step === EjectStep.Ejected ? MESSAGE.ejected(version) : MESSAGE.store;
}

/** A question is open: its words are an alert, its buttons the confirm and cancel. */
const isAsking = (step: EjectStep): boolean => step === EjectStep.AskingEject || step === EjectStep.AskingGiveBack;

/**
 * The engine row for a Rust game, or nothing for any other stack. `ejectedFrom` is the release the
 * game's `engine/` was copied from (null: Genex's engine); the row then follows its own answers.
 */
export function EngineEject({
  game,
  ejectedFrom = null,
  onNotice,
}: {
  game: GameProject;
  ejectedFrom?: string | null;
  onNotice: Notify;
}): JSX.Element | null {
  const [step, setStep] = useState<EjectStep>(ejectedFrom ? EjectStep.Ejected : EjectStep.Store);
  const [version, setVersion] = useState<string | null>(ejectedFrom);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ExtensionRefusal | null>(null);
  if (stackOf(game.shape) !== GameStack.RustWgpu) return null;
  const settled = (before: EjectStep) => (answer: EngineEjectAnswer) => {
    setRefusal(answer.ok ? null : answer.refusal);
    if (!answer.ok) return setStep(before);
    setVersion(answer.ejectedFrom);
    setStep(answer.ejectedFrom ? EjectStep.Ejected : EjectStep.Store);
  };
  const run = (call: () => Promise<EngineEjectAnswer>, before: EjectStep): void => {
    setBusy(true);
    call()
      .then(settled(before), (error: unknown) => {
        setStep(before);
        notifyProblem(onNotice)(error);
      })
      .finally(() => setBusy(false));
  };
  const ask = (next: EjectStep): void => {
    setRefusal(null);
    setStep(next);
  };
  const confirm = (): void => {
    if (step === EjectStep.AskingEject) run(() => window.studio.engineEject(game.name), EjectStep.Store);
    else run(() => window.studio.engineUneject(game.name), EjectStep.Ejected);
  };
  const cancel = (): void => setStep(step === EjectStep.AskingEject ? EjectStep.Store : EjectStep.Ejected);
  return (
    <div
      data-stage-engine-eject={step}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2.5"
    >
      <span className="text-body-sm font-medium text-ink">{MESSAGE.heading}</span>
      <span
        role={isAsking(step) ? "alert" : "status"}
        className="min-w-32 flex-1 text-xs leading-relaxed text-pretty text-ink-3"
      >
        {statusWords(step, version, refusal)}
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-2">
        {step === EjectStep.Store && (
          <Button data-stage-engine-eject-action="eject" disabled={busy} onClick={() => ask(EjectStep.AskingEject)}>
            {MESSAGE.eject}
          </Button>
        )}
        {step === EjectStep.Ejected && (
          <Button
            data-stage-engine-eject-action="give-back"
            disabled={busy}
            onClick={() => ask(EjectStep.AskingGiveBack)}
          >
            {MESSAGE.giveBack}
          </Button>
        )}
        {isAsking(step) && (
          <>
            <Button data-stage-engine-eject-action="cancel" variant="ghost" disabled={busy} onClick={cancel}>
              {MESSAGE.cancel}
            </Button>
            <Button data-stage-engine-eject-action="confirm" variant="destructive" disabled={busy} onClick={confirm}>
              {step === EjectStep.AskingEject ? MESSAGE.confirmEject : MESSAGE.confirmGiveBack}
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

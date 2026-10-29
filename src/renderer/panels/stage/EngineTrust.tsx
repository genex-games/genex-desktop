/**
 * The person's trust flag for a Rust game's own code (extension ladder level 5,
 * `studio:engine.setTrust`): above the stage like the device launch row. Turning it on lets the
 * game's `unsafe` code and build scripts build; it never loosens the sandbox the build and the
 * game run in. Turning it on asks first, with the warning; turning it off is immediate. No agent
 * can press it: an agent can only suggest it in chat.
 */
import { type JSX, useState } from "react";
import { type EngineTrustAnswer, ExtensionRefusal } from "../../../shared/game-conformance.ts";
import { type GameProject, GameStack, stackOf } from "../../../shared/game-project.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { t } from "../../../shared/i18n.ts";

/** Where the row stands: the flag, or the warning before it is turned on. */
const TrustStep = {
  Off: "off",
  Asking: "asking",
  On: "on",
} as const;
type TrustStep = (typeof TrustStep)[keyof typeof TrustStep];

/** The row's own words. */
const MESSAGE = {
  heading: t("Trust this game’s code"),
  off: t("Off: unsafe code and build scripts in this game don’t build."),
  on: t("On: this game’s unsafe code and its own build script build. The sandbox is unchanged."),
  warning: t(
    "Only trust code you’ve read. Unsafe code can crash the game or corrupt its memory, and a build script runs on this Mac at every build. Both stay inside the sandbox: no network, and writes only to the build folder.",
  ),
  trust: t("Trust"),
  confirm: t("Trust this game"),
  cancel: t("Cancel"),
  untrust: t("Stop trusting"),
  refusal: {
    [ExtensionRefusal.Unavailable]: t("This version of Genex can’t trust a game’s code."),
    [ExtensionRefusal.TrustPersonOnly]: t("Only you can trust a game, here in Genex."),
  } as Partial<Record<ExtensionRefusal, string>>,
  refused: t("The trust setting didn’t change."),
} as const;

/** What the row says for `step`, or the last answer's refusal. */
function statusWords(step: TrustStep, refusal: ExtensionRefusal | null): string {
  if (refusal) return MESSAGE.refusal[refusal] ?? MESSAGE.refused;
  if (step === TrustStep.Asking) return MESSAGE.warning;
  return step === TrustStep.On ? MESSAGE.on : MESSAGE.off;
}

/**
 * The trust row for a Rust game, or nothing for any other stack. `trusted` is the flag as the
 * profile holds it (default off); the row then follows the answers of its own changes.
 */
export function EngineTrust({
  game,
  trusted = false,
  onNotice,
}: {
  game: GameProject;
  trusted?: boolean;
  onNotice: Notify;
}): JSX.Element | null {
  const [step, setStep] = useState<TrustStep>(trusted ? TrustStep.On : TrustStep.Off);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ExtensionRefusal | null>(null);
  if (stackOf(game.shape) !== GameStack.RustWgpu) return null;
  const answered = (answer: EngineTrustAnswer): void => {
    setRefusal(answer.ok ? null : answer.refusal);
    setStep(answer.trusted ? TrustStep.On : TrustStep.Off);
  };
  const set = (next: boolean): void => {
    setBusy(true);
    window.studio
      .engineSetTrust(game.name, next)
      .then(answered, notifyProblem(onNotice))
      .finally(() => setBusy(false));
  };
  const ask = (): void => {
    setRefusal(null);
    setStep(TrustStep.Asking);
  };
  return (
    <div
      data-stage-engine-trust={step}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2.5"
    >
      <span className="text-body-sm font-medium text-ink">{MESSAGE.heading}</span>
      <span
        role={step === TrustStep.Asking ? "alert" : "status"}
        className="min-w-32 flex-1 text-xs leading-relaxed text-pretty text-ink-3"
      >
        {statusWords(step, refusal)}
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-2">
        {step === TrustStep.Off && (
          <Button data-stage-engine-trust-action="trust" disabled={busy} onClick={ask}>
            {MESSAGE.trust}
          </Button>
        )}
        {step === TrustStep.Asking && (
          <>
            <Button
              data-stage-engine-trust-action="cancel"
              variant="ghost"
              disabled={busy}
              onClick={() => setStep(TrustStep.Off)}
            >
              {MESSAGE.cancel}
            </Button>
            <Button
              data-stage-engine-trust-action="confirm"
              variant="destructive"
              disabled={busy}
              onClick={() => set(true)}
            >
              {MESSAGE.confirm}
            </Button>
          </>
        )}
        {step === TrustStep.On && (
          <Button data-stage-engine-trust-action="untrust" disabled={busy} onClick={() => set(false)}>
            {MESSAGE.untrust}
          </Button>
        )}
      </span>
    </div>
  );
}

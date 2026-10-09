/**
 * Settings → Harness: how many builders a run may use, whether suggestions apply on their own, whether
 * paused builds resume on their own, and Copy diagnostics.
 */
import { useEffect, useState, type JSX } from "react";
import type { StudioSettingsView } from "../../shared/studio-api.ts";
import { DEFAULT_BUILDERS, MAX_BUILDERS } from "../../shared/builders.ts";
import { Button } from "../ui/Button.tsx";
import { Switch } from "../ui/switch.tsx";
import { DiagnosticsRow } from "./DiagnosticsRow.tsx";
import { AUTO_RESUME_SETTING_WORDS, problemWords } from "../words.ts";
import { Pending } from "../ui/Pending.tsx";

/** What the auto-apply switch means, given whether the harness learns at all. */
function applyWords(learning: boolean, selfImproving: boolean): string {
  if (!learning) return "Self-improvement is off in Harness, so there is nothing to apply.";
  return selfImproving
    ? "Suggestions that pass testing apply without asking. You can undo any of them in Harness."
    : "Harness asks before changing how it builds. You can undo any change in Harness.";
}

export function HarnessSection(): JSX.Element {
  const [settings, setSettings] = useState<StudioSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.studio
      .settings()
      .then(setSettings)
      .catch((cause) => setError(problemWords(cause)));
  }, []);
  const change = async (patch: { selfImproving?: boolean; buildersMax?: number; autoResume?: boolean }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await window.studio.setSettings(patch));
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!settings)
    return (
      <div data-harness-settings className="appearance-section">
        {error ? (
          <p role="alert" className="text-red">
            {error}
          </p>
        ) : (
          <Pending label="Loading…" />
        )}
      </div>
    );
  const builders = settings.buildersMax ?? DEFAULT_BUILDERS;
  const { learning, selfImproving } = settings;
  const autoResume = settings.autoResume !== false;
  return (
    <div data-harness-settings className="appearance-section">
      <section className="appearance-theme settings-rows">
        <div className="appearance-row">
          <label htmlFor="harness-self-improving" className="flex min-w-0 flex-col">
            <span className="text-ink">Apply suggestions automatically</span>
            <span className="text-ink-3">{applyWords(learning, selfImproving)}</span>
          </label>
          <Switch
            id="harness-self-improving"
            checked={selfImproving}
            disabled={busy || !learning}
            onCheckedChange={(next) => void change({ selfImproving: next })}
          />
        </div>
        <div className="appearance-row">
          <span className="flex min-w-0 flex-col">
            <span id="harness-builders" className="text-ink">
              Maximum concurrent workers
            </span>
            <span className="text-ink-3">Harness can run up to this many workers at the same time.</span>
          </span>
          <div role="group" aria-labelledby="harness-builders" className="appearance-value">
            <Button
              aria-label="Fewer workers"
              disabled={busy || builders <= 1}
              onClick={() => void change({ buildersMax: builders - 1 })}
            >
              −
            </Button>
            <output aria-live="polite" className="w-6 text-center">
              {builders}
            </output>
            <Button
              aria-label="More workers"
              disabled={busy || builders >= MAX_BUILDERS}
              onClick={() => void change({ buildersMax: builders + 1 })}
            >
              +
            </Button>
          </div>
        </div>
        <div className="appearance-row">
          <label htmlFor="harness-auto-resume" className="flex min-w-0 flex-col">
            <span className="text-ink">{AUTO_RESUME_SETTING_WORDS.label}</span>
            <span className="text-ink-3">{AUTO_RESUME_SETTING_WORDS.detail}</span>
          </label>
          <Switch
            id="harness-auto-resume"
            data-harness-auto-resume
            checked={autoResume}
            disabled={busy}
            onCheckedChange={(next) => void change({ autoResume: next })}
          />
        </div>
        <div className="appearance-row">
          <span className="flex min-w-0 flex-col">
            <span className="text-ink">How suggestions are tested</span>
            <span className="text-ink-3">
              An independent reviewer compares the current and suggested instructions on your past requests. It doesn’t
              rebuild your games, so an applied change isn’t proof of better results.
            </span>
          </span>
        </div>
        <DiagnosticsRow />
      </section>
      {error && (
        <p role="alert" className="mt-2 text-red">
          {error}
        </p>
      )}
    </div>
  );
}

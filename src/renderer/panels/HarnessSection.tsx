/**
 * Settings → Harness: how many builders a run may use, whether suggestions apply on their own, whether
 * paused builds resume on their own, and Copy diagnostics.
 */
import { useEffect, useState, type JSX } from "react";
import { trackSettingChanged } from "../analytics/workspace-track.ts";
import { SettingKey } from "../analytics/workspace-vocabulary.ts";
import type { StudioSettingsView } from "../../shared/studio-api.ts";
import { DEFAULT_BUILDERS, MAX_BUILDERS } from "../../shared/builders.ts";
import { Button } from "../ui/Button.tsx";
import { Switch } from "../ui/switch.tsx";
import { DiagnosticsRow } from "./DiagnosticsRow.tsx";
import { AUTO_RESUME_SETTING_WORDS, problemWords } from "../words.ts";
import { Pending } from "../ui/Pending.tsx";
import { t } from "../../shared/i18n.ts";
import { SkeletonRows } from "../ui/Skeleton.tsx";

/** One of the section's settings, as its patch names it. */
type HarnessPatch = { buildersMax?: number; autoResume?: boolean };

/** Count a change of the section's settings (usage analytics): each key it changed, with its new value. */
function trackHarnessChange(patch: HarnessPatch, failed: boolean): void {
  if (patch.buildersMax !== undefined) trackSettingChanged(SettingKey.BuildersMax, patch.buildersMax, failed);
  if (patch.autoResume !== undefined) trackSettingChanged(SettingKey.AutoResume, patch.autoResume, failed);
}

/** Maximum concurrent workers' stepper: one fewer down to one, one more up to the most Settings offers. */
export function WorkersStepper({
  value,
  busy,
  onChange,
}: {
  value: number;
  busy: boolean;
  onChange: (next: number) => void;
}): JSX.Element {
  return (
    <div role="group" aria-labelledby="harness-builders" className="appearance-value">
      <Button aria-label={t("Fewer workers")} disabled={busy || value <= 1} onClick={() => onChange(value - 1)}>
        −
      </Button>
      <output aria-live="polite" className="w-6 text-center">
        {value}
      </output>
      <Button
        aria-label={t("More workers")}
        disabled={busy || value >= MAX_BUILDERS}
        onClick={() => onChange(value + 1)}
      >
        +
      </Button>
    </div>
  );
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
  const change = async (patch: HarnessPatch) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await window.studio.setSettings(patch));
      trackHarnessChange(patch, false);
    } catch (cause) {
      trackHarnessChange(patch, true);
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
          <Pending label={t("Loading…")}>
            <SkeletonRows count={4} />
          </Pending>
        )}
      </div>
    );
  const builders = settings.buildersMax ?? DEFAULT_BUILDERS;
  const autoResume = settings.autoResume !== false;
  return (
    <div data-harness-settings className="appearance-section">
      <section className="appearance-theme settings-rows">
        <div className="appearance-row">
          <span className="flex min-w-0 flex-col">
            <span id="harness-builders" className="text-ink">
              {t("Maximum concurrent workers")}
            </span>
            <span className="text-ink-3">{t("Harness can run up to this many workers at the same time.")}</span>
          </span>
          <WorkersStepper value={builders} busy={busy} onChange={(buildersMax) => void change({ buildersMax })} />
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
            <span className="text-ink">{t("How suggestions are tested")}</span>
            <span className="text-ink-3">
              {t(
                "An independent reviewer compares the current and suggested instructions on your past requests. It doesn’t rebuild your games, so an applied change isn’t proof of better results.",
              )}
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

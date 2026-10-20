/**
 * Settings → Permissions' "Let agents control your computer": the studio setting that lets an
 * agent ask for the person's computer (`computerControl`, off by default). Main owns it; this is a
 * view that loads it once, follows `settings.changed`, and changes only this one setting. Where it
 * is offered is `computerControlOffered` (`shared/computer-control.ts`).
 */
import { useEffect, useState } from "react";
import type { StudioApi, StudioSettingsView } from "../shared/studio-api.ts";
import { UiEvent } from "../shared/ui-events.ts";
import { problemWords } from "./words.ts";

/** Whether the host's settings have computer control on; off until they say so. */
export function computerControlOn(view: StudioSettingsView | null): boolean {
  return view?.computerControl === true;
}

/** Turn computer control on or off; the answer is the host's saved settings. */
export function setComputerControl(api: Pick<StudioApi, "setSettings">, on: boolean): Promise<StudioSettingsView> {
  return api.setSettings({ computerControl: on });
}

export interface ComputerControlSetting {
  /** The saved setting, or null before it loads. */
  on: boolean | null;
  busy: boolean;
  error: string | null;
  change: (on: boolean) => void;
}

/** The setting as Settings → Permissions shows it, kept in step with changes made elsewhere. */
export function useComputerControl(): ComputerControlSetting {
  const [view, setView] = useState<StudioSettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void window.studio
      .settings()
      .then((loaded) => {
        if (current) setView(loaded);
      })
      .catch((cause) => {
        if (current) setError(problemWords(cause));
      });
    const off = window.studio.onEvent((event) => {
      if (event.type === UiEvent.SettingsChanged) setView(event.payload);
    });
    return () => {
      current = false;
      off();
    };
  }, []);
  const change = (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void setComputerControl(window.studio, on)
      .then(setView)
      .catch((cause) => setError(problemWords(cause)))
      .finally(() => setBusy(false));
  };
  return { on: view ? computerControlOn(view) : null, busy, error, change };
}

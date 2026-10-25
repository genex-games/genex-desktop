/**
 * The model's place in a game composer before any AI model is connected: one accent button that
 * opens Settings → Model Providers. A send tried meanwhile does not go anywhere; it lights the
 * button up with its reason for a moment (`useModelNudge`), and the prompt stays as written.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

/** How long a blocked send keeps the button lit and its tooltip up. */
const NUDGE_MS = 2.8 * SECOND_MS;
/** The bump's two names: each send replays it by switching to the other one. */
const NUDGE_BEATS = ["a", "b"] as const;

const MESSAGE = {
  label: t("Connect AI model"),
  title: t("Connect an AI model to send"),
  text: t("Claude Code, Codex or a local model. Your prompt stays here."),
} as const;

/** A blocked send's nudge: `nudge()` lights the button for a moment; another send replays it. */
export function useModelNudge(): { beat: number | null; nudge: () => void } {
  const [beat, setBeat] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const nudge = (): void => {
    window.clearTimeout(timer.current);
    setBeat((current) => (current ?? 0) + 1);
    timer.current = window.setTimeout(() => setBeat(null), NUDGE_MS);
  };
  return { beat, nudge };
}

/** Connect AI model: its tooltip shows on hover, and on its own while a blocked send lights it. */
export function ConnectModelButton({ beat }: { beat: number | null }): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const lit = beat !== null;
  return (
    <>
      <Tooltip open={lit || hovered} onOpenChange={setHovered}>
        <TooltipTrigger asChild>
          <button
            ref={trigger}
            type="button"
            data-connect-model
            data-nudge={lit ? NUDGE_BEATS[beat % NUDGE_BEATS.length] : undefined}
            onClick={() => openSettings(SettingsSection.Providers, trigger.current)}
            className="composer-text-button composer-connect-model"
          >
            {MESSAGE.label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" sideOffset={6} className="max-w-[260px] text-left">
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{MESSAGE.title}</span>
            <span className="opacity-75">{MESSAGE.text}</span>
          </span>
        </TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {lit ? MESSAGE.title : ""}
      </span>
    </>
  );
}

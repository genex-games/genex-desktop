/**
 * Play / Create beside the wordmark: two small tabs on one track, the accent pill sliding to the one
 * that is on. Play is the genex.games catalog; Create is everything else the app does. Arrow keys switch.
 */
import type { JSX, KeyboardEvent } from "react";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.modes;

/** The two sides of the switch. Values are `data-play-mode` selectors: never rename one. */
export const ShellMode = { Play: "play", Create: "create" } as const;
export type ShellMode = (typeof ShellMode)[keyof typeof ShellMode];

/** The Play / Create tabs beside the wordmark. */
export function PlaySwitch({
  playing,
  onChange,
}: {
  playing: boolean;
  onChange: (play: boolean) => void;
}): JSX.Element {
  const keys = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const play = event.key === "ArrowLeft" || event.key === "Home";
    onChange(play);
    const target = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
      `[data-play-mode="${play ? ShellMode.Play : ShellMode.Create}"]`,
    );
    target?.focus();
  };
  const tab = (mode: ShellMode, label: string) => {
    const on = (mode === ShellMode.Play) === playing;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={on}
        tabIndex={on ? 0 : -1}
        data-play-mode={mode}
        className="play-switch-tab"
        onClick={() => onChange(mode === ShellMode.Play)}
        onKeyDown={keys}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      role="tablist"
      aria-label={WORDS.label}
      className="play-switch"
      data-mode={playing ? ShellMode.Play : ShellMode.Create}
    >
      <span className="play-switch-pill" aria-hidden="true" />
      {tab(ShellMode.Play, WORDS.play)}
      {tab(ShellMode.Create, WORDS.create)}
    </div>
  );
}

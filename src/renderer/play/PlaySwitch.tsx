/**
 * Play / Create beside the wordmark: two small tabs on one track, the accent pill sliding to the one
 * that is on. Play is the genex.games catalog; Create is everything else the app does. Arrow keys switch.
 */
import { type JSX, type KeyboardEvent, useCallback } from "react";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.modes;

/** The two sides of the switch. Values are `data-play-mode` selectors: never rename one. */
export const ShellMode = { Play: "play", Create: "create" } as const;
export type ShellMode = (typeof ShellMode)[keyof typeof ShellMode];

/**
 * Keep the tabs' widths on the track as `--play-switch-play` and `--play-switch-create`, so the pill
 * fits a label of any language's length; without ResizeObserver the stylesheet's English widths stay.
 */
function measureTabs(track: HTMLDivElement | null): (() => void) | undefined {
  if (!track || typeof ResizeObserver === "undefined") return undefined;
  const observer = new ResizeObserver(() => {
    for (const tab of track.querySelectorAll<HTMLElement>("[data-play-mode]"))
      track.style.setProperty(`--play-switch-${tab.dataset.playMode}`, `${tab.offsetWidth}px`);
  });
  for (const tab of track.querySelectorAll("[data-play-mode]")) observer.observe(tab);
  return () => observer.disconnect();
}

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
  const track = useCallback(measureTabs, []);
  return (
    <div
      ref={track}
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

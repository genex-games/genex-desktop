/**
 * When the user hears the Live game, kept free of Electron so the rule is tested as a table.
 * Agents' windows are never heard: `GamePreview`'s `muted` option silences them when they are made.
 * A C++ game's own Play window counts as in front for that game only: focusing it blurs Genex, so
 * its rule is "Genex or the game window is focused", except that while Live is heard playing the
 * same game the window is heard only when it has the focus: one copy of a game is heard at a time.
 * A focus event is the game's own claim, and one from a headless or embedded run is ignored.
 */
import { isSoundShortcut, type SoundKey } from "../shared/game-sound.ts";
import { NativeRunMode } from "../shared/native-contract.ts";

/** Everything the Live game's sound depends on. */
export interface LiveSound {
  /** The user's switch: the stage strip's speaker, or ⌥⌘M. */
  on: boolean;
  /** The Live tab has the stage: its view has a rectangle on screen. */
  shown: boolean;
  /** Genex is the app in front. */
  foreground: boolean;
  /** An agent's session is looking through the user's own window (a build with no hidden ones). */
  lent: boolean;
  /** That game's own Play window has the OS focus: in front for that game only. */
  gameWindowFocused?: boolean;
}

/** Audible only while the user can see their own game, in front (Genex, or the game's own window), with the switch on. */
export function liveAudible(sound: LiveSound): boolean {
  if (!sound.on || sound.lent) return false;
  return sound.shown && (sound.foreground || sound.gameWindowFocused === true);
}

/** A native run's focus, as the native registry reports it. */
export interface GameWindowFocus {
  project: string;
  mode: NativeRunMode;
  focused: boolean;
}

/** Whether `project`'s own Play window has the focus: only that game's window run counts. */
export function gameWindowFocused(project: string, focus: readonly GameWindowFocus[]): boolean {
  return focus.some((seen) => seen.project === project && seen.mode === NativeRunMode.Window && seen.focused);
}

/**
 * A Play window's sound: Live's rule, with the window itself on screen and its focus counting as in
 * front. `liveHeard` is Live being heard playing this same game: then Genex in front is Live's, and
 * the window is heard only while it has the focus itself.
 */
export function gameWindowAudible(
  sound: Pick<LiveSound, "on" | "foreground">,
  focused: boolean,
  liveHeard = false,
): boolean {
  return liveAudible({
    on: sound.on,
    foreground: sound.foreground && !liveHeard,
    shown: true,
    lent: false,
    gameWindowFocused: focused,
  });
}

/** The part of Electron's `before-input-event` input the shortcut reads. */
interface KeyInput extends SoundKey {
  type: string;
  isAutoRepeat: boolean;
}

/** A page's contents as far as the shortcut listens to them: Electron's `WebContents`. */
interface KeyedContents {
  on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: KeyInput) => void): unknown;
}

/** ⌥⌘M pressed while `contents` has the keyboard: the page never sees it, and `toggle` runs once a press. */
export function onSoundShortcut(contents: KeyedContents, toggle: () => void): void {
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || !isSoundShortcut(input)) return;
    event.preventDefault();
    toggle();
  });
}

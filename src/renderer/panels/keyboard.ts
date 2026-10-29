/** Keyboard rules the stage's canvases share. */

/** Whether a key press landed in a field that owns its own keys: an input, a text area or editable text. */
export function typingIn(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}

/**
 * Whether a canvas's window-wide keys should leave a press alone: it was typed into a field, or what
 * had focus already handled it (an open menu prevents its Escape, which still bubbles to the window).
 */
export function keyTakenElsewhere(event: Pick<KeyboardEvent, "defaultPrevented" | "target">): boolean {
  return event.defaultPrevented || typingIn(event.target);
}

import { type JSX, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_LIMITS, type TerminalSession } from "../../shared/terminal.ts";
import { useAppearance } from "../appearance/store.ts";
import { isTerminalChord, TOGGLE_TERMINAL_EVENT } from "./terminal-events.ts";

/** The terminal's type: its size, its line height, and the contrast xterm keeps text above (WCAG AA). */
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.15;
const MIN_CONTRAST = 4.5;
/** The grid sizes the host accepts; a fitted size outside them is clamped before it is sent. */
const COLS = { min: 2, max: 500 };
const ROWS = { min: 1, max: 300 };

/** The terminal's colours, read from the app's current theme. */
function terminalTheme(style: CSSStyleDeclaration) {
  const color = (token: string) => style.getPropertyValue(token).trim();
  return {
    background: color("--background"),
    foreground: color("--foreground"),
    cursor: color("--foreground"),
    selectionBackground: color("--secondary"),
    // The slider matches the app's own scrollbars.
    scrollbarSliderBackground: color("--line"),
    scrollbarSliderHoverBackground: color("--line-strong"),
    scrollbarSliderActiveBackground: color("--line-strong"),
  };
}

const clamp = (value: number, range: { min: number; max: number }): number =>
  Math.max(range.min, Math.min(range.max, value));

/** A terminal in the app's theme whose output can never open a URL or write to the clipboard by escape sequence. */
function createTerminal(style: CSSStyleDeclaration, report: { current: (error: string) => void }): Terminal {
  return new Terminal({
    fontFamily: style.getPropertyValue("--font-family-code"),
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    scrollback: TERMINAL_LIMITS.scrollback,
    cursorBlink: false,
    screenReaderMode: false,
    minimumContrastRatio: MIN_CONTRAST,
    theme: terminalTheme(style),
    // Output must never open a URL or write to the clipboard by escape sequence.
    linkHandler: {
      activate: (_event, text) => {
        try {
          if (["http:", "https:"].includes(new URL(text).protocol))
            void window.studio.openUrl(text).catch(() => report.current("Could not open this link."));
        } catch {}
      },
    },
  });
}

/** The keys the dock takes from the terminal: Shift+Escape leaves it, Cmd/Ctrl+` toggles it, Ctrl+Shift+C copies. */
function dockKeys(terminal: Terminal, node: HTMLElement, report: { current: (error: string) => void }) {
  const leave = (event: KeyboardEvent): false => {
    event.preventDefault();
    // Let xterm receive keyup before moving focus; otherwise its IME key state stays down.
    if (event.type === "keyup")
      node.closest("[data-terminal-dock]")?.querySelector<HTMLButtonElement>('[aria-label="Hide terminal"]')?.focus();
    return false;
  };
  const toggle = (event: KeyboardEvent): false => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "keyup") window.dispatchEvent(new Event(TOGGLE_TERMINAL_EVENT));
    return false;
  };
  const copy = (event: KeyboardEvent): false => {
    event.preventDefault();
    if (terminal.hasSelection())
      void navigator.clipboard
        .writeText(terminal.getSelection())
        .catch(() => report.current("Could not copy the selection."));
    return false;
  };
  return (event: KeyboardEvent): boolean => {
    if (event.shiftKey && event.key === "Escape") return leave(event);
    if (isTerminalChord(event)) return toggle(event);
    const copying = event.type === "keydown" && event.ctrlKey && event.shiftKey && event.code === "KeyC";
    if (copying) return copy(event);
    return true;
  };
}

/** Fit the terminal to its box on the next frame, and tell the host the new grid when it changed. */
function fitter(terminal: Terminal, addon: FitAddon, node: HTMLElement, sessionId: string, disposed: () => boolean) {
  let frame = 0;
  let previous = "";
  const fit = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const hidden = !node.clientWidth || !node.clientHeight;
      if (disposed() || hidden) return;
      addon.fit();
      const size = `${terminal.cols}:${terminal.rows}`;
      if (size === previous) return;
      previous = size;
      void window.studio
        .terminalResize(sessionId, clamp(terminal.cols, COLS), clamp(terminal.rows, ROWS))
        .catch(() => {});
    });
  };
  return { fit, cancel: () => cancelAnimationFrame(frame) };
}

/** Wire the terminal to its session: keystrokes out, output in (acknowledged once drawn), and screen-reader mode. */
function connect(
  terminal: Terminal,
  sessionId: string,
  report: { current: (error: string) => void },
  disposed: () => boolean,
): () => void {
  const input = terminal.onData((data) => {
    void window.studio.terminalInput(sessionId, data).catch((error) => report.current(error.message));
  });
  const unsubscribe = window.studio.onTerminal((event) => {
    if (event.type === "accessibility") terminal.options.screenReaderMode = event.enabled;
    if (event.type === "data" && event.id === sessionId)
      terminal.write(event.data, () => {
        if (!disposed()) void window.studio.terminalAcknowledge(sessionId, event.data.length).catch(() => {});
      });
  });
  void window.studio
    .terminalAccessibility()
    .then((enabled) => {
      if (!disposed()) terminal.options.screenReaderMode = enabled;
    })
    .catch(() => {});
  void window.studio.terminalAttach(sessionId).catch((error) => report.current(error.message));
  return () => {
    unsubscribe();
    input.dispose();
  };
}

/** Imperative terminal buffer: streaming output never enters React or chat state. */
export default function TerminalView({
  session,
  visible,
  onError,
}: {
  session: TerminalSession;
  visible: boolean;
  onError: (error: string) => void;
}): JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const { appearance, scheme } = useAppearance();
  const runtime = useRef<{ terminal: Terminal; fit: () => void } | null>(null);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const style = getComputedStyle(document.documentElement);
    const terminal = createTerminal(style, report);
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(node);
    let disposed = false;
    const isDisposed = () => disposed;
    const { fit, cancel } = fitter(terminal, addon, node, session.id, isDisposed);
    runtime.current = { terminal, fit };
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    terminal.attachCustomKeyEventHandler(dockKeys(terminal, node, report));
    const disconnect = connect(terminal, session.id, report, isDisposed);
    void document.fonts.ready.then(() => {
      if (!disposed) fit();
    });
    return () => {
      disposed = true;
      cancel();
      observer.disconnect();
      disconnect();
      terminal.dispose();
      runtime.current = null;
    };
  }, [session.id]);
  useEffect(() => {
    if (!visible) return;
    runtime.current?.fit();
    // Give a dismissed Settings dialog time to restore its opener before claiming terminal focus.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => runtime.current?.terminal.focus());
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  useEffect(() => {
    if (runtime.current) runtime.current.terminal.options.disableStdin = session.phase !== "running";
  }, [session.phase]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new appearance or scheme is the reason to re-read the theme
  useEffect(() => {
    if (!runtime.current) return;
    const style = getComputedStyle(document.documentElement);
    runtime.current.terminal.options.theme = terminalTheme(style);
    runtime.current.terminal.options.fontFamily = style.getPropertyValue("--font-family-code");
    runtime.current.fit();
  }, [appearance, scheme]);
  return (
    <div
      ref={element}
      className="h-full min-h-0 min-w-0 px-3 pb-2"
      data-terminal-view={session.id}
      aria-label={`${session.title} terminal`}
      onKeyDown={(event) => {
        if (!isTerminalChord(event)) event.stopPropagation();
      }}
    />
  );
}

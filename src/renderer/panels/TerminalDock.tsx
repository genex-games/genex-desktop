import { type JSX, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ClaudeLoginState } from "../../shared/claude-login.ts";
import { errorMessage } from "../../shared/errors.ts";
import { EngineId } from "../../shared/providers.ts";
import { inDock, TerminalKind, type TerminalSession } from "../../shared/terminal.ts";
import { readText, STORAGE_KEYS, writeText } from "../storage.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useClaudeLogin } from "../subscription-auth.ts";
import {
  isTerminalChord,
  OPEN_TERMINAL_EVENT,
  SHOW_TERMINAL_EVENT,
  shownSession,
  TOGGLE_TERMINAL_EVENT,
} from "./terminal-events.ts";
import { Pending } from "../ui/Pending.tsx";

const TerminalView = lazy(() => import("./TerminalView.tsx"));

/** The dock's height: never below this, at most this share of the window, and where it starts. */
const DOCK_MIN_PX = 120;
const DOCK_MAX_SHARE = 0.5;
const DOCK_START_MAX_PX = 420;
const DOCK_DEFAULT_PX = 240;
/** The window height assumed before the dock has one to measure. */
const FALLBACK_WINDOW_PX = 800;
/** One arrow key's change to the dock's height. */
const DOCK_KEY_STEP_PX = 20;
/** The exit code of a process stopped with Ctrl+C. */
const SIGINT_EXIT = 130;

/** The dock's saved height, kept within its bounds. */
const savedHeight = (): number =>
  Math.max(DOCK_MIN_PX, Math.min(DOCK_START_MAX_PX, Number(readText(STORAGE_KEYS.terminalHeight)) || DOCK_DEFAULT_PX));

/** What a session is doing, in one line: its error, how it ended, that it is starting, or where it is. */
function sessionStatus(current: TerminalSession): string {
  if (current.error !== undefined) return current.error;
  if (current.phase === "exited") {
    if (current.exitCode === 0) return "Process finished";
    return current.exitCode === SIGINT_EXIT ? "Process stopped" : `Process exited (${current.exitCode})`;
  }
  if (current.phase === "starting") return "Starting…";
  return current.kind === TerminalKind.ClaudeLogin ? "Finish sign-in here or in your browser." : current.title;
}

/** The dock's name for its one session: a sign-in, a command a reply offered, or the terminal. */
function dockLabel(current: TerminalSession | undefined): string {
  if (current?.kind === TerminalKind.ClaudeLogin) return "Claude Code sign-in";
  if (current?.kind === TerminalKind.OpenCodeLogin) return "OpenCode sign-in";
  return current?.kind === TerminalKind.Command ? "Command" : "Terminal";
}

/** What the dock needs from its latest render when a window event or a key arrives. */
type DockControls = {
  open: () => Promise<void>;
  hide: () => void;
  visible: boolean;
  sessions: TerminalSession[];
};

/**
 * The host's terminal sessions as they come and go, the first list read once, and the window's
 * ways to show, toggle or open the dock (its events and Cmd/Ctrl+`).
 */
function useTerminalSessions(
  controls: { current: DockControls },
  reveal: { current: () => void },
  on: { select: (id: string) => void; show: (visible: boolean) => void; setError: (error: string | null) => void },
) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribed once; the latest controls are read through refs
  useEffect(() => {
    let live = true;
    const seen = new Set<string>();
    const shown = (event?: Event): void => {
      const sessionId = event && shownSession(event);
      if (sessionId) on.select(sessionId);
      on.show(true);
      reveal.current();
    };
    const unsubscribe = window.studio.onTerminal((event) => {
      if (event.type === "session") {
        seen.add(event.session.id);
        if (!inDock(event.session)) return;
        setSessions((old) => [...old.filter((session) => session.id !== event.session.id), event.session]);
        if (!event.reveal) return;
        on.select(event.session.id);
        on.show(true);
        on.setError(null);
        reveal.current();
      } else if (event.type === "removed") {
        seen.add(event.id);
        setSessions((old) => old.filter((session) => session.id !== event.id));
      }
    });
    void window.studio
      .terminalList()
      .then((list) => {
        const docked = list.filter((session) => inDock(session) && !seen.has(session.id));
        if (live) setSessions((old) => [...old, ...docked]);
      })
      .catch(() => {});
    const toggle = () => {
      const c = controls.current;
      if (c.visible) c.hide();
      else if (c.sessions.length) shown();
      else void c.open();
    };
    const newSession = () => {
      void controls.current.open();
    };
    const key = (event: KeyboardEvent) => {
      if (isTerminalChord(event) && !event.altKey) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener(TOGGLE_TERMINAL_EVENT, toggle);
    window.addEventListener(SHOW_TERMINAL_EVENT, shown);
    window.addEventListener(OPEN_TERMINAL_EVENT, newSession);
    window.addEventListener("keydown", key);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener(TOGGLE_TERMINAL_EVENT, toggle);
      window.removeEventListener(SHOW_TERMINAL_EVENT, shown);
      window.removeEventListener(OPEN_TERMINAL_EVENT, newSession);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return sessions;
}

/** The dock's top edge: drag it, or use the arrow keys, to change the dock's height. */
function ResizeHandle({
  root,
  height,
  onHeight,
}: {
  root: { current: HTMLElement | null };
  height: number;
  onHeight: (height: number) => void;
}): JSX.Element {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const available = (): number => root.current?.parentElement?.clientHeight ?? FALLBACK_WINDOW_PX;
  const resize = (value: number) => onHeight(Math.max(DOCK_MIN_PX, Math.min(available() * DOCK_MAX_SHARE, value)));
  return (
    <div
      role="separator"
      aria-label="Terminal height"
      aria-orientation="horizontal"
      tabIndex={0}
      aria-valuemin={DOCK_MIN_PX}
      aria-valuemax={Math.floor(available() * DOCK_MAX_SHARE)}
      aria-valuenow={Math.round(height)}
      className="absolute -top-1 z-20 h-2 w-full cursor-row-resize hover:bg-line-strong focus-visible:bg-line-strong"
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        resize(height + (event.key === "ArrowUp" ? DOCK_KEY_STEP_PX : -DOCK_KEY_STEP_PX));
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, height };
      }}
      onPointerMove={(event) => {
        if (drag.current) resize(drag.current.height + drag.current.y - event.clientY);
      }}
      onPointerUp={() => {
        drag.current = null;
        writeText(STORAGE_KEYS.terminalHeight, String(height));
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
}

/** The session picker (or the session's name), New, Stop or Close, and Hide. */
function DockBar({
  sessions,
  current,
  project,
  opening,
  onSelect,
  onOpen,
  onAct,
  onHide,
}: {
  sessions: TerminalSession[];
  current: TerminalSession | undefined;
  project: string | null;
  opening: boolean;
  onSelect: (id: string) => void;
  onOpen: () => void;
  onAct: (action: () => Promise<unknown>) => void;
  onHide: () => void;
}): JSX.Element {
  const stop = (session: TerminalSession) =>
    session.kind === TerminalKind.ClaudeLogin
      ? window.studio.claudeLoginCancel()
      : window.studio.terminalStop(session.id);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 py-1.5">
      <div className="min-w-0 flex-1 px-1 font-mono text-xs text-ink-2">
        {sessions.length > 1 ? (
          <select
            aria-label="Terminal session"
            value={current?.id ?? ""}
            onChange={(event) => onSelect(event.target.value)}
            className="w-full min-w-0 cursor-pointer rounded-control bg-field py-1 text-ink"
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
                {session.phase === "exited" ? " · ended" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="block truncate">{dockLabel(current)}</span>
        )}
      </div>
      {project && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open project terminal"
          title="Open project terminal"
          disabled={opening}
          onClick={onOpen}
        >
          <Icon name="plus" />
        </Button>
      )}
      {current && current.phase !== "exited" && (
        <Button
          variant="ghost"
          className="px-2"
          disabled={current.phase === "stopping"}
          onClick={() => onAct(() => stop(current))}
        >
          {current.phase === "stopping" ? "Stopping…" : "Stop"}
        </Button>
      )}
      {current?.phase === "exited" && (
        <Button variant="ghost" className="px-2" onClick={() => onAct(() => window.studio.terminalRemove(current.id))}>
          Close session
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Hide terminal"
        title="Hide terminal · keeps running"
        onClick={onHide}
      >
        <Icon name="close" />
      </Button>
    </div>
  );
}

/** A Claude Code sign-in's own lines: its sign-in page, and whether it connected or failed. */
function SignInNotes({
  login,
  onAct,
}: {
  login: ClaudeLoginState | null;
  onAct: (action: () => Promise<unknown>) => void;
}): JSX.Element {
  const finished = login?.phase === "failed" || login?.phase === "connected";
  return (
    <>
      {login?.hasBrowserUrl && (
        <div className="px-3 pb-2">
          <Button variant="secondary" onClick={() => onAct(() => window.studio.claudeLoginOpenBrowser())}>
            Open the sign-in page
          </Button>
        </div>
      )}
      {finished && (
        <p role="status" className="px-3 pb-1 text-xs text-ink-2">
          {login.phase === "connected" ? "Signed in to Claude Code." : login.error}
        </p>
      )}
    </>
  );
}

/** A shell session that has not exited. */
const isLiveShell = (session: TerminalSession): boolean =>
  session.kind === TerminalKind.Shell && session.phase !== "exited";

/** The game's shell that is still running, if it has one. */
const liveShellOf = (sessions: TerminalSession[], project: string | null): TerminalSession | undefined =>
  sessions.find((session) => isLiveShell(session) && session.project === project);

export function TerminalDock({ project, onReveal }: { project: string | null; onReveal: () => void }): JSX.Element {
  const [selected, select] = useState<string | null>(null);
  const [visible, show] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useClaudeLogin(EngineId.ClaudeCode);
  const [height, setHeight] = useState(savedHeight);
  const root = useRef<HTMLElement>(null);
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  const controls = useRef<DockControls>({ open: async () => {}, hide: () => {}, visible, sessions: [] });
  const sessions = useTerminalSessions(controls, reveal, { select, show, setError });
  const current = sessions.find((session) => session.id === selected) ?? sessions.at(-1);
  const hide = () => {
    show(false);
    document.querySelector<HTMLButtonElement>("[data-terminal-toggle]")?.focus();
  };
  const open = async () => {
    show(true);
    reveal.current();
    setError(null);
    const existing = liveShellOf(sessions, project);
    if (existing) {
      select(existing.id);
      return;
    }
    if (!project || opening) {
      if (!project && !sessions.length) setError("Open a game to start a terminal.");
      return;
    }
    setOpening(true);
    try {
      const session = await window.studio.terminalOpen(project);
      select(session.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setOpening(false);
    }
  };
  controls.current = { open, hide, visible, sessions };
  const act = (action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((error) => setError(error.message));
  };
  return (
    <section
      ref={root}
      data-terminal-dock
      aria-label="Terminal"
      hidden={!visible}
      className="terminal-dock relative min-h-0 shrink-0 border-t border-line bg-base"
      style={{ height, maxHeight: "50%" }}
    >
      <ResizeHandle root={root} height={height} onHeight={setHeight} />
      <DockBar
        sessions={sessions}
        current={current}
        project={project}
        opening={opening}
        onSelect={select}
        onOpen={() => void open()}
        onAct={act}
        onHide={hide}
      />
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-orange">
          {error}
        </p>
      )}
      {current?.kind === TerminalKind.ClaudeLogin && <SignInNotes login={login} onAct={act} />}
      {current && (
        <p role="status" className="px-3 pb-1 font-mono text-micro text-ink-3">
          {sessionStatus(current)}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {sessions.map((session) => (
          <div key={session.id} hidden={session.id !== current?.id} className="h-full min-h-0">
            <Suspense fallback={<Pending label="Loading terminal…" className="px-3 text-xs" />}>
              <TerminalView session={session} visible={visible && session.id === current?.id} onError={setError} />
            </Suspense>
          </div>
        ))}
      </div>
    </section>
  );
}

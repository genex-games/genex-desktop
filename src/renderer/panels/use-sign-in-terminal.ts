/**
 * The sign-in terminal a Settings row shows while it runs (OpenCode's `auth login`). The row reads it
 * from the host's own list, so closing and reopening Settings mid-sign-in finds it again.
 */
import { useEffect, useState } from "react";
import { liveSignIn, type TerminalKind, type TerminalSession } from "../../shared/terminal.ts";

/** The open sign-in session of this kind, kept current from the host's terminal events. */
export function useSignInTerminal(kind: TerminalKind): TerminalSession | undefined {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  useEffect(() => {
    let live = true;
    const seen = new Set<string>();
    const unsubscribe = window.studio.onTerminal((event) => {
      if (event.type === "session" && event.session.kind === kind) {
        seen.add(event.session.id);
        setSessions((old) => [...old.filter((session) => session.id !== event.session.id), event.session]);
      } else if (event.type === "removed") {
        seen.add(event.id);
        setSessions((old) => old.filter((session) => session.id !== event.id));
      }
    });
    void window.studio
      .terminalList()
      .then((list) => {
        const mine = list.filter((session) => session.kind === kind && !seen.has(session.id));
        if (live) setSessions((old) => [...old, ...mine]);
      })
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [kind]);
  return liveSignIn(sessions, kind);
}

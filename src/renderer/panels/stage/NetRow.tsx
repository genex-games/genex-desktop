/**
 * Live's net row above the stage (game-systems MP-7): for a Rust game built with `[net]`, one line
 * saying which room its seat plays in, where the seat stands, why it is offline, and the players.
 * It reads the game's `__net` from Live's web page (`net-row.ts`) only while that page is on the
 * stage; a game with no `__net`, and Live's Mac canvas, show no row.
 */
import { type JSX, useEffect, useState } from "react";
import { type GameProject, GameStack, stackOf } from "../../../shared/game-project.ts";
import type { NetView } from "../../../shared/game-net.ts";
import type { NativeTimers } from "../../../shared/native-contract.ts";
import { studio } from "../../state/studio.ts";
import { NET_WORDS } from "../../words.ts";
import { netRowView, startNetPoll } from "./net-row.ts";

/** The renderer's clock. */
const WINDOW_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (typeof handle === "number") window.clearTimeout(handle);
  },
};

/** `project`'s net view while `polling`, else null; leaving the game or the page stops the poll. */
function useNetView(project: string, polling: boolean): NetView | null {
  const [view, setView] = useState<NetView | null>(null);
  useEffect(() => {
    setView(null);
    if (!polling) return;
    const poll = startNetPoll(studio().api, WINDOW_TIMERS, project, setView);
    return () => poll.stop();
  }, [project, polling]);
  return view;
}

/** The row for `game`, or nothing for a game with no net view or while Live shows no web page. */
export function NetRow({ game, webPage }: { game: GameProject; webPage: boolean }): JSX.Element | null {
  const rust = stackOf(game.shape) === GameStack.RustWgpu;
  const row = netRowView(useNetView(game.name, rust && webPage));
  if (!row) return null;
  const facts = [row.mode, row.title, row.players].filter((fact) => fact !== null).join(" · ");
  return (
    <div
      data-stage-net={row.status}
      className="flex shrink-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line bg-surface px-3 py-2.5"
    >
      <span className="text-body-sm font-medium text-ink">{NET_WORDS.heading}</span>
      <span role="status" className="min-w-0 flex-1 text-xs leading-relaxed text-pretty text-ink-3">
        {facts}
        {row.reason ? <span className="text-ink-2">{` · ${row.reason}`}</span> : null}
      </span>
    </div>
  );
}

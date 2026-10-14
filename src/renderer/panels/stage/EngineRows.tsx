/**
 * A Rust game's engine rows above the stage (extension ladder level 5): the eject row and the
 * trust row, opened from the stage strip's engine button and closed again with it. They start from
 * the game's engine as Studio holds it (`studio:engine.state`): ejected or Studio's, and its trust
 * flag. Only the person presses them; an agent can only suggest them in chat.
 */
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import type { EngineState } from "../../../shared/game-conformance.ts";
import { type GameProject, GameStack, stackOf } from "../../../shared/game-project.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { EngineEject } from "./EngineEject.tsx";
import { EngineTrust } from "./EngineTrust.tsx";

/** The strip's engine button: whether the rows are open, and the switch. */
export interface EngineRowsToggle {
  open: boolean;
  toggle: () => void;
}

/** The engine button's state for the game on the stage: null (no button) for anything but a Rust game; closed on every new game. */
export function useEngineRows(loaded: GameProject | null): EngineRowsToggle | null {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const name = loaded?.name ?? null;
  const rust = loaded !== null && stackOf(loaded.shape) === GameStack.RustWgpu;
  const toggle = useCallback(() => setOpenFor((current) => (current === name ? null : name)), [name]);
  if (!rust) return null;
  return { open: openFor === name, toggle };
}

/** The two rows for `game`, once its engine state is read; nothing until then. */
export function EngineRows({ game, onNotice }: { game: GameProject; onNotice: Notify }): JSX.Element | null {
  const [state, setState] = useState<EngineState | null>(null);
  // The notice sink may be a new function each render; the read runs once per game.
  const notice = useRef(onNotice);
  notice.current = onNotice;
  useEffect(() => {
    let current = true;
    setState(null);
    window.studio.engineState(game.name).then(
      (read) => {
        if (current) setState(read);
      },
      (error: unknown) => {
        if (current) notifyProblem(notice.current)(error);
      },
    );
    return () => {
      current = false;
    };
  }, [game.name]);
  if (!state || state.project !== game.name) return null;
  return (
    <div data-stage-engine-rows="">
      <EngineEject game={game} ejectedFrom={state.ejectedFrom} onNotice={onNotice} />
      <EngineTrust game={game} trusted={state.trusted} onNotice={onNotice} />
    </div>
  );
}

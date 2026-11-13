/**
 * What the person did on one game's board, for the canvas that shows it: read when the tab opens,
 * then changed in place. A change shows at once and is saved after it; nothing can be changed
 * before the first read has answered, so a slow read never loses what the file held. The artboards
 * the agent offers to pick among arrive on their own, as it offers them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type DesignMarks, EMPTY_MARKS } from "../../../shared/design-marks.ts";
import { UiEvent } from "../../../shared/ui-events.ts";

/** One change: the marks as they are now, to the marks with the thing done. */
export type MarksChange = (now: DesignMarks) => DesignMarks;

export function useBoardMarks(project: string): { marks: DesignMarks; change: (update: MarksChange) => void } {
  const [marks, setMarks] = useState<DesignMarks>(EMPTY_MARKS);
  const latest = useRef<DesignMarks | null>(null);
  useEffect(() => {
    let current = true;
    latest.current = null;
    setMarks(EMPTY_MARKS);
    void window.studio
      .designMarks(project)
      .catch(() => EMPTY_MARKS)
      .then((read) => {
        if (!current) return;
        latest.current = read;
        setMarks(read);
      });
    return () => {
      current = false;
    };
  }, [project]);
  // The agent offers artboards to pick among: main has kept them with the marks already.
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        if (event.type !== UiEvent.DesignChoices || event.payload.project !== project || !latest.current) return;
        latest.current = { ...latest.current, choices: event.payload.files };
        setMarks(latest.current);
      }),
    [project],
  );
  const change = useCallback(
    (update: MarksChange): void => {
      if (!latest.current) return;
      const next = update(latest.current);
      latest.current = next;
      setMarks(next);
      void window.studio.saveDesignMarks(project, next).catch(() => false);
    },
    [project],
  );
  return { marks, change };
}

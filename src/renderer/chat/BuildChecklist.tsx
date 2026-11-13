/**
 * The Building card's steps, opened under it (`BuildStatus.tsx`): each step with its mark and where
 * it stands. Its rows are `build-checklist.ts`'s; their time left moves on while the list is open.
 * A long list shows its latest rows under one row that counts the earlier ones and opens them.
 * Pressing a step opens its row on Builds.
 */
import { type JSX, useState } from "react";
import { Icon } from "../ui/icons.tsx";
import { BUILD_CHECKLIST_WORDS as WORDS } from "../words.ts";
import { type BuildChecklist as Checklist, type ChecklistRow, foldChecklist, PartMark } from "./build-checklist.ts";
import { StepMark } from "./StepMark.tsx";

/** A row's mark, name and where it stands. */
function RowWords({ row }: { row: ChecklistRow }): JSX.Element {
  return (
    <>
      <StepMark done={row.mark === PartMark.Added} working={row.mark === PartMark.Working} clear />
      <span className={`line-clamp-2 min-w-0 flex-1 ${row.mark === PartMark.Next ? "text-ink-3" : "text-ink"}`}>
        {row.title}
      </span>
      <span className="shrink-0 ps-2 text-ink-3">{row.status}</span>
    </>
  );
}

const ROW_CLASS = "flex w-full min-w-0 items-start gap-2.5 rounded-[8px] px-1 py-1 text-left text-chat-sub";

/** The open list: one row a step (a press opens it on Builds), the earlier ones of a long list folded. */
export function BuildChecklist({
  id,
  list,
  onOpenStep,
}: {
  id: string;
  list: Checklist;
  /** Open one step's row on Builds, by the row's id; absent where Builds cannot be opened. */
  onOpenStep?: (stepId: string) => void;
}): JSX.Element {
  const [opened, setOpened] = useState(false);
  const { rows, hidden } = foldChecklist(list.rows, opened);
  return (
    <div id={id} data-build-checklist className="relative z-[1] flex min-w-0 flex-col px-1 pt-[3px] pb-1">
      <ul aria-label={WORDS.list} className="m-0 flex min-w-0 list-none flex-col p-0">
        {hidden ? (
          <li>
            <button
              type="button"
              data-build-earlier
              onClick={() => setOpened(true)}
              className={`${ROW_CLASS} cursor-pointer items-center text-ink-3 hover:bg-control-hover hover:text-control-text-hover`}
            >
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <Icon name="more" size={14} />
              </span>
              {WORDS.earlier(hidden)}
            </button>
          </li>
        ) : null}
        {rows.map((row) => (
          <li key={row.id} data-part-row={row.mark}>
            {onOpenStep ? (
              <button
                type="button"
                data-open-build
                onClick={() => onOpenStep(row.id)}
                className={`${ROW_CLASS} cursor-pointer hover:bg-control-hover`}
              >
                <RowWords row={row} />
              </button>
            ) : (
              <div className={ROW_CLASS}>
                <RowWords row={row} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

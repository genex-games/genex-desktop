import { type JSX, useId, useMemo, useState } from "react";
import type { AgentScreenFrame } from "../../shared/agent-screen.ts";
import { useNow } from "../panels/run-graph/use-builds-model.ts";
import { capWords } from "../run-steps.ts";
import { Elapsed, useStartedAt } from "../ui/LoadingState.tsx";
import { Presence } from "../ui/Presence.tsx";
import { BUILD_CHECKLIST_WORDS } from "../words.ts";
import { type BuildParts, buildChecklist } from "./build-checklist.ts";
import { BuildCard } from "./BuildCard.tsx";
import { BuildChecklist } from "./BuildChecklist.tsx";

/**
 * A build running while the chat itself is free — the only thing the chat shows for it. Its one
 * line is where it stands: its parts counted once it has some, else what is happening now; the
 * picture is the lead's own view of the game, small, once there is something in it to see. Its
 * clock sits on the right: how long it has run, and under it the most it was given ("up to 10h"),
 * a cap the build may finish well inside. With parts, the card opens to their list (each added,
 * working or still to come) and Open in Builds; without, the whole card opens Builds.
 */
export function BuildStatus({
  since,
  budgetMs,
  caption,
  frame,
  parts,
  onOpenBuilds,
}: {
  since?: number;
  /** the time the build was given, when it was given one */
  budgetMs?: number | null;
  caption: string;
  frame?: AgentScreenFrame;
  /** what the card's list is read from, once the build has a plan or a worker */
  parts?: BuildParts | null;
  onOpenBuilds?: () => void;
}): JSX.Element {
  // Ticks every second without re-rendering the card.
  const startedAt = useStartedAt(since);
  // A first picture arriving while the card is on show slides in; one already there is simply there.
  const [arrives] = useState(!frame);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  // The rows' time left moves on only while they are on show.
  const now = useNow(expanded);
  const list = useMemo(() => (parts ? buildChecklist({ ...parts, now }) : null), [parts, now]);
  return (
    <section data-build-status aria-label="Build running" className="min-w-0">
      <BuildCard
        title="Building"
        {...(frame
          ? {
              picture: (
                <img
                  src={`data:image/jpeg;base64,${frame.jpeg}`}
                  alt=""
                  draggable={false}
                  className={`h-[55px] w-[88px] shrink-0 rounded-[10px] bg-inset object-cover ${arrives ? "build-picture-in" : ""}`}
                />
              ),
            }
          : {})}
        {...(list
          ? {
              toggle: {
                expanded,
                controls: listId,
                label: BUILD_CHECKLIST_WORDS.toggle,
                onToggle: () => setExpanded((open) => !open),
              },
            }
          : {})}
        {...(!list && onOpenBuilds ? { open: { onClick: onOpenBuilds } } : {})}
        line={
          <p role="status" title={caption} className="m-0 truncate text-chat-sub text-ink-3">
            {caption}
          </p>
        }
        aside={
          <p className="m-0 shrink-0 pe-2 text-end text-chat-sub">
            <span className="block min-h-[1lh] text-ink">
              <Elapsed since={startedAt} />
            </span>
            {budgetMs ? <span className="block text-ink-3">{capWords(budgetMs)}</span> : null}
          </p>
        }
        below={
          <Presence>
            {list && expanded
              ? [
                  {
                    key: "parts",
                    node: <BuildChecklist id={listId} list={list} {...(onOpenBuilds ? { onOpenBuilds } : {})} />,
                  },
                ]
              : []}
          </Presence>
        }
      />
    </section>
  );
}

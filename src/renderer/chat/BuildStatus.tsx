import { type JSX, useId, useMemo, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { openBuildStep } from "../open-build.ts";
import { useNow } from "../panels/run-graph/use-builds-model.ts";
import { Elapsed, useStartedAt } from "../ui/LoadingState.tsx";
import { Presence } from "../ui/Presence.tsx";
import { BUILD_CHECKLIST_WORDS } from "../words.ts";
import type { RunSummary } from "../../shared/run-summary.ts";
import { buildChecklist } from "./build-checklist.ts";
import { BuildCard } from "./BuildCard.tsx";
import { BuildChecklist } from "./BuildChecklist.tsx";

/**
 * A build running while the chat itself is free — the only thing the chat shows for it. Its one
 * line is where it stands: its steps counted once it has some, else what is happening now. Its
 * clock sits on the right: how long it has run. With steps, the card opens to their list (the
 * lead's save points, its workers' parts added, working or not added), each opening its row on
 * Builds; without, the whole card opens Builds.
 */
export function BuildStatus({
  since,
  caption,
  summary,
  onOpenBuilds,
}: {
  since?: number;
  caption: string;
  /** the build's summary its card lists its steps from, once the build has a save point or a worker */
  summary?: RunSummary | null;
  onOpenBuilds?: () => void;
}): JSX.Element {
  // Ticks every second without re-rendering the card.
  const startedAt = useStartedAt(since);
  // Open from the start: the parts are what a running build has to show.
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  // The rows' time left moves on only while they are on show.
  const now = useNow(expanded);
  const list = useMemo(() => (summary ? buildChecklist(summary, now) : null), [summary, now]);
  return (
    <section data-build-status aria-label={t("Build running")} className="min-w-0">
      <BuildCard
        title={t("Building")}
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
          // The lead's own words about what it does on its screen.
          <p role="status" title={caption} data-analytics-mask className="m-0 truncate text-status text-ink-3">
            {caption}
          </p>
        }
        aside={
          <p className="m-0 shrink-0 pe-2 text-end text-chat-sub">
            <span className="block min-h-[1lh]">
              <span className="chat-status-shimmer inline-block">
                <Elapsed since={startedAt} />
              </span>
            </span>
          </p>
        }
        below={
          <Presence>
            {list && expanded
              ? [
                  {
                    key: "parts",
                    node: (
                      <BuildChecklist
                        id={listId}
                        list={list}
                        {...(onOpenBuilds
                          ? {
                              onOpenStep: (stepId: string) => {
                                openBuildStep(stepId);
                                onOpenBuilds();
                              },
                            }
                          : {})}
                      />
                    ),
                  },
                ]
              : []}
          </Presence>
        }
      />
    </section>
  );
}

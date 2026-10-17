/**
 * The line below the transcript that says what is happening: the chat's own work (with the work
 * log folded in), else a running build's status, else Studio quietly learning, else nothing.
 */
import { type JSX, type Key, useMemo } from "react";
import type { AgentScreenFrame } from "../../shared/agent-screen.ts";
import { leadFrameOf } from "../state/agent-screens.ts";
import { useAgentScreens } from "../state/hooks.ts";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Presence, type PresenceChild } from "../ui/Presence.tsx";
import type { BuildParts } from "./build-checklist.ts";
import { BuildStatus } from "./BuildStatus.tsx";
import type { ActivityItem } from "./conversation-entries.ts";
import { WorkLogContent } from "./WorkLog.tsx";
import { makingCalls } from "./making-calls.ts";
import { MakingTiles } from "./MakingTiles.tsx";
import type { Notify } from "../state/toasts.ts";

export interface ChatWorkProps {
  /** The chat's own work is under way. */
  chatWorking: boolean;
  learning: boolean;
  activeRunId: string | null;
  /** Remounts the busy line when the work it times changes (a plan, a run, the chat). */
  workKey: Key | null | undefined;
  /** What the busy line says (`busyLabel`). */
  label: string;
  /** The running build's one line: its parts counted (`checklistCaption`), else what is happening now (`buildCaption`). */
  caption: string;
  /** What the running build's card lists its parts from (`build-checklist.ts`), once it has a plan or a worker. */
  parts: BuildParts | null;
  /** The busy line waits on the user rather than working. */
  waiting: boolean;
  busySince: number | null;
  details: ActivityItem[] | null;
  /** The learning pass's own status line. */
  learningLine: string;
  runStarted: number | undefined;
  /** The time the running build was given, when it was given one. */
  budgetMs: number | null;
  /** The chat's game, whose running build's lead screen the build status shows. */
  project: string | null;
  onShowBuilds?: () => void;
  /** The chat is loading: the line it opens with is simply there. */
  still?: boolean;
  /** Where an approval from a card of what the work is making reports a problem. */
  onNotice?: Notify;
}

/** What the line is: the chat's own work, a running build or Studio learning. A change of kind swaps it. */
const WorkKind = {
  Work: "work",
  Build: "build",
  Learning: "learning",
} as const;

/**
 * The line reads the lead's screen itself (a frame of the store's), so a new frame from any worker
 * re-renders at most this line, never the chat around it. A running build is one card: one line
 * counting its parts, and the card opens to their list — added, working, still to come — in place
 * of a line for each worker in the transcript; every detail of a part lives on Builds. The line
 * opens and closes in place, and a work line becoming the build card (or back) closes one as the
 * other opens.
 */
export function ChatWork(props: ChatWorkProps): JSX.Element {
  const { activeRunId, project } = props;
  const leadFrame = useAgentScreens((s) => (activeRunId ? leadFrameOf(s, project, activeRunId) : undefined));
  return (
    <Presence still={props.still} className="chat-work">
      {workLine(props, leadFrame)}
    </Presence>
  );
}

const NO_NOTICE: Notify = () => {};

/** What the chat's work is still making, under its line, as the Assets canvas shows it. */
function WorkMaking({ props }: { props: ChatWorkProps }): JSX.Element | null {
  const calls = useMemo(() => makingCalls(props.details ?? []), [props.details]);
  if (!props.project || !calls.length) return null;
  return (
    <div className="mt-1">
      <MakingTiles project={props.project} calls={calls} onNotice={props.onNotice ?? NO_NOTICE} />
    </div>
  );
}

/** The line on show, keyed by its kind, or nothing. */
function workLine(props: ChatWorkProps, leadFrame: AgentScreenFrame | undefined): PresenceChild[] {
  if (props.chatWorking)
    return [
      {
        key: WorkKind.Work,
        node: (
          <div className="flex min-w-0 flex-col gap-1">
            <LoadingState
              key={props.workKey}
              details={props.details ? <WorkLogContent items={props.details} /> : undefined}
              label={props.label}
              waiting={props.waiting}
              {...(props.busySince ? { since: props.busySince } : {})}
            />
            <WorkMaking props={props} />
          </div>
        ),
      },
    ];
  if (props.activeRunId)
    return [
      {
        key: WorkKind.Build,
        node: (
          <div className="flex min-w-0 flex-col gap-2">
            <BuildStatus
              {...(props.runStarted !== undefined ? { since: props.runStarted } : {})}
              budgetMs={props.budgetMs}
              {...(leadFrame ? { frame: leadFrame } : {})}
              {...(props.onShowBuilds ? { onOpenBuilds: props.onShowBuilds } : {})}
              parts={props.parts}
              caption={props.caption}
            />
          </div>
        ),
      },
    ];
  if (props.learning) return [{ key: WorkKind.Learning, node: <LoadingState label={props.learningLine} waiting /> }];
  return [];
}

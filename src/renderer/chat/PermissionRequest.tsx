/**
 * Claude asking before it acts, answered in the chat instead of a terminal: the waiting card
 * (`PermissionRequest`, docked above the composer) and the settled one-line row in the
 * conversation (`PermissionOutcome`). Only the host settles a request; the caller keys a card by request id.
 */
import type { JSX } from "react";
import {
  isPlanRequest,
  PermissionDecision,
  PermissionMode,
  type SteadyPermissionMode,
  type ToolPermissionAnswer,
  type ToolPermissionEvent,
  ToolPermissionState,
} from "../../shared/permissions.ts";
import { FileText } from "../ui/FileText.tsx";
import { Icon } from "../ui/icons.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { useMoreBelow } from "../ui/scroll-fade.ts";
import { SyntaxCode } from "../ui/SyntaxCode.tsx";
import {
  alwaysWords,
  permissionCommandWords,
  permissionInsteadWords,
  permissionLineWords,
  permissionPath,
  permissionTitleWords,
} from "../words.ts";
import { ChatDisclosure } from "./ChatDisclosure.tsx";
import { type ChatChoice, ChatQuestion } from "./ChatQuestion.tsx";

/** The card's own words. */
const WORDS = {
  allow: "Allow",
  allowOnce: "Just this once.",
  deny: "Deny",
  keepPlanningPlaceholder: "Keep planning: what should change?",
  reviewRequest: "Review permission request",
  reviewPlan: "Review plan",
  details: "Request details",
  plan: "Plan",
} as const;

/** The tools whose one subject is a file or a folder, shown as its link. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep"]);
/** The shell tool, whose command is shown once, in full. */
const SHELL_TOOL = "Bash";

/** The modes a plan approval continues in, as the card offers them. */
const PLAN_CHOICES: ReadonlyArray<ChatChoice & { id: SteadyPermissionMode }> = [
  { id: PermissionMode.Auto, label: "Yes, in Auto mode" },
  { id: PermissionMode.AcceptEdits, label: "Yes, and accept edits" },
  { id: PermissionMode.Manual, label: "Yes, and ask before changes" },
];

/** The command a shell request runs, when it names one. */
function commandOf(event: ToolPermissionEvent): string {
  if (event.tool !== SHELL_TOOL) return "";
  return event.subject || (typeof event.input?.command === "string" ? event.input.command : "");
}

/** The one thing to decide on, as itself: a command in mono, a file as its link. */
function RequestSubject({ event }: { event: ToolPermissionEvent }): JSX.Element | null {
  const command = commandOf(event);
  if (command)
    return (
      <pre data-permission-command className="chat-tool-code mt-2">
        <SyntaxCode text={command} language="bash" />
      </pre>
    );
  const path = FILE_TOOLS.has(event.tool) ? permissionPath(event) : undefined;
  if (!path) return null;
  return (
    <p className="mt-1 text-chat-sub text-ink-2 [overflow-wrap:anywhere]">
      <FileText text={path} />
    </p>
  );
}

/** Everything else Claude Code sent: why it asks (when not already said) and the tool's input. */
function RequestDetails({ event, reason }: { event: ToolPermissionEvent; reason?: string }): JSX.Element | null {
  const input = Object.keys(event.input ?? {}).length ? JSON.stringify(event.input, null, 2) : "";
  const plan = isPlanRequest(event) ? event.plan : undefined;
  if (!input && !reason && !plan) return null;
  return (
    <details className="group/request mt-1">
      <summary className="chat-disclosure">
        {WORDS.details}
        <Icon name="chevron-right" size={14} className="chat-chevron group-open/request:rotate-90" />
      </summary>
      {reason && (
        <p className="mt-1 text-chat-sub text-ink-3 [overflow-wrap:anywhere]">
          <FileText text={reason} />
        </p>
      )}
      {plan ? (
        <div className="mt-1">
          <Markdown text={plan} />
        </div>
      ) : (
        input && (
          <pre className="chat-tool-code mt-1">
            <SyntaxCode text={input} language="json" />
          </pre>
        )
      )}
    </details>
  );
}

/** A plan from Plan mode, approved into the mode work continues in, or sent back with words. */
function PlanRequest({
  event,
  onAnswer,
  planModes,
}: {
  event: ToolPermissionEvent;
  onAnswer: (answer: ToolPermissionAnswer) => Promise<void>;
  planModes: readonly PermissionMode[];
}): JSX.Element {
  // A mode the engine does not honour, or an Auto this model cannot use, is no choice: the work
  // would go on in another mode anyway.
  const choices = PLAN_CHOICES.filter((choice) => planModes.includes(choice.id));
  return (
    <ChatQuestion
      title={permissionTitleWords(event)}
      choices={choices}
      reopenLabel={WORDS.reviewPlan}
      answerPlaceholder={WORDS.keepPlanningPlaceholder}
      onConfirm={(id) => {
        const choice = PLAN_CHOICES.find((option) => option.id === id);
        return choice ? onAnswer({ decision: PermissionDecision.ApprovePlan, mode: choice.id }) : undefined;
      }}
      onAnswerText={(message) => onAnswer({ decision: PermissionDecision.Deny, message })}
    >
      {event.plan && <PlanPreview plan={event.plan} />}
    </ChatQuestion>
  );
}

/** The plan, in a region that scrolls on its own and fades its last line while more lies below. */
function PlanPreview({ plan }: { plan: string }): JSX.Element {
  const ref = useMoreBelow<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-permission-plan
      tabIndex={0}
      role="region"
      aria-label={WORDS.plan}
      className="scroll-fade mt-2 max-h-[max(5rem,calc(45vh-19rem))] overflow-y-auto"
    >
      <Markdown text={plan} />
    </div>
  );
}

/** The answer a picked row stands for. */
function choiceAnswer(id: string): ToolPermissionAnswer {
  if (id === PermissionDecision.Allow) return { decision: PermissionDecision.Allow };
  if (id === PermissionDecision.Always) return { decision: PermissionDecision.Always };
  return { decision: PermissionDecision.Deny };
}

/**
 * Claude asking before it acts: Allow once, the standing permission Claude Code offers (every grant
 * named), or Deny, with words for Claude typed in the card. A plan from Plan mode is approved the
 * same way, choosing the mode work continues in.
 */
export function PermissionRequest({
  event,
  onAnswer,
  planModes = PLAN_CHOICES.map((choice) => choice.id),
}: {
  event: ToolPermissionEvent;
  onAnswer: (answer: ToolPermissionAnswer) => Promise<void>;
  /** The modes a plan card offers to continue in (all three unless the chat's engine or model rules some out). */
  planModes?: readonly PermissionMode[];
}): JSX.Element {
  if (isPlanRequest(event)) return <PlanRequest event={event} onAnswer={onAnswer} planModes={planModes} />;
  // The command is on the card in full, so the question does not repeat it.
  const question = commandOf(event) ? permissionCommandWords(event) : permissionTitleWords(event);
  const description = event.description || event.reason;
  const choices: ChatChoice[] = [
    { id: PermissionDecision.Allow, label: WORDS.allow, description: WORDS.allowOnce },
    ...(event.always?.length ? [{ id: PermissionDecision.Always, label: alwaysWords(event.always) }] : []),
    { id: PermissionDecision.Deny, label: WORDS.deny },
  ];
  return (
    <ChatQuestion
      title={question}
      description={description}
      choices={choices}
      reopenLabel={WORDS.reviewRequest}
      answerPlaceholder={permissionInsteadWords(event)}
      onConfirm={(id) => onAnswer(choiceAnswer(id))}
      onAnswerText={(message) => onAnswer({ decision: PermissionDecision.Deny, message })}
    >
      <RequestSubject event={event} />
      <RequestDetails event={event} reason={event.description && event.reason ? event.reason : undefined} />
    </ChatQuestion>
  );
}

/** What an answered request opens to: the question as asked, its subject, the answer's words, why it was asked. */
function SettledRequest({ event }: { event: ToolPermissionEvent }): JSX.Element {
  const command = commandOf(event);
  const path = FILE_TOOLS.has(event.tool) ? permissionPath(event) : undefined;
  const plan = isPlanRequest(event) ? event.plan : undefined;
  const input = Object.keys(event.input ?? {}).length ? JSON.stringify(event.input, null, 2) : "";
  const message = event.state === ToolPermissionState.Allowed ? "" : (event.message?.trim() ?? "");
  return (
    <div className="chat-tool-detail flex flex-col gap-2 text-ink-2">
      <p className="m-0">{permissionTitleWords(event)}</p>
      {command && (
        <pre data-permission-command className="chat-tool-code">
          <SyntaxCode text={command} language="bash" />
        </pre>
      )}
      {path && (
        <p className="m-0 [overflow-wrap:anywhere]">
          <FileText text={path} />
        </p>
      )}
      {message && <p className="m-0 text-ink-3 [overflow-wrap:anywhere]">{message}</p>}
      {event.reason && (
        <p className="m-0 text-ink-3 [overflow-wrap:anywhere]">
          <FileText text={event.reason} />
        </p>
      )}
      {plan && <Markdown text={plan} />}
      {!plan && !command && !path && input && (
        <pre className="chat-tool-code">
          <SyntaxCode text={input} language="json" />
        </pre>
      )}
    </div>
  );
}

/** A settled request in the conversation, one line ("Allowed · npm install three") that opens to the request. */
export function PermissionOutcome({ event }: { event: ToolPermissionEvent }): JSX.Element {
  return (
    <ChatDisclosure
      data-permission-outcome
      lead={<Icon name="shield" size={14} className="shrink-0" />}
      label={permissionLineWords(event)}
    >
      <SettledRequest event={event} />
    </ChatDisclosure>
  );
}

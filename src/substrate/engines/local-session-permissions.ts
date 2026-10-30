/**
 * A local session's chat mode (`local-session.ts`): which of its tool calls wait for the person
 * and how their answer reads to the model. Only a game chat's own session the person answers has a
 * mode (`DelegateRequest.permissions`); unattended work never asks. The studio runs these tools
 * itself, so it asks before each change as Claude Code does: Manual before every edit and command,
 * Accept edits before every command; Plan refuses every change until the plan is approved (the host
 * asks for that once the turn ends: `main/core/plan-approval.ts`). Auto asks nobody about an edit, and
 * has each command checked first by the session's own model in a call of its own (auto-approver.ts),
 * as Claude Code's Auto has its classifier: allowed, it runs; refused, the model reads why; unsure,
 * the person is asked. The commands of a session engine (Bonsai, OpenRouter) always run in the
 * studio's sandbox, so it honours no Bypass (`permissionModesFor`).
 *
 * A worker of the chat's lead runs on a local session as on any engine that keeps sessions: in the
 * chat's mode its seat names (`DelegateRequest.worker`), asking through its seat (`seatAsks`), its
 * files and commands held to its write roots and never-touch list (local-session.ts).
 */
import path from "node:path";
import { engineMode, PermissionDecision, PermissionMode } from "../../shared/permissions.ts";
import { providerInfo } from "../../shared/providers.ts";
import { t } from "../../shared/i18n.ts";
import type { ToolCall } from "../types.ts";
import { LocalTool } from "./local-session-tools.ts";
import { deniedWithWords, LOCAL_NOTE } from "./local-session-prompts.ts";
import { type AutoApproval, AutoVerdict } from "./auto-approver.ts";
import { AUTO_REFUSED } from "./auto-approver-prompts.ts";
import type { DelegatePermissions, DelegateRequest, PermissionAsk, PermissionReply } from "./types.ts";

/** The Auto check of one action (auto-approver.ts `autoApprove`, bound to the session's own model). */
export type AutoCheck = (ask: PermissionAsk, signal: AbortSignal) => Promise<AutoApproval>;

/** What a change tool does, as the modes tell them apart. */
const ChangeKind = { Edit: "edit", Command: "command" } as const;
type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

/** The local tools that change something, by what they change. Every other tool only looks or is the studio's own. */
const CHANGE_TOOLS: Readonly<Record<string, ChangeKind>> = {
  [LocalTool.EditFile]: ChangeKind.Edit,
  [LocalTool.WriteFile]: ChangeKind.Edit,
  [LocalTool.RunCommand]: ChangeKind.Command,
};

/** What each mode asks the person about before it runs. */
const ASKS: Record<PermissionMode, ReadonlySet<ChangeKind>> = {
  [PermissionMode.Auto]: new Set(),
  [PermissionMode.Manual]: new Set([ChangeKind.Edit, ChangeKind.Command]),
  [PermissionMode.AcceptEdits]: new Set([ChangeKind.Command]),
  [PermissionMode.Plan]: new Set(),
  [PermissionMode.Bypass]: new Set(),
};

/** Claude Code's tool names, which the card (`PermissionRequest`) reads a request by. Vendor names. */
const CardTool = { Shell: "Bash", Edit: "Edit", Write: "Write" } as const;

/**
 * The card's own sentence, as Claude Code words its questions, in the name of the engine that asks:
 * the person reads it on the card, in their language.
 */
const ASK_TITLE = {
  command: (who: string) => t("{who} wants to run a command", { who }),
  edit: (who: string, file: string) => t("{who} wants to edit {file}", { who, file: path.basename(file) }),
  write: (who: string, file: string) => t("{who} wants to write {file}", { who, file: path.basename(file) }),
} as const;

/** The engine's name as a person says it ("Bonsai", "OpenRouter"), or its id when the table has none. */
const engineName = (engine: string): string => providerInfo(engine)?.label ?? engine;

/** A chat's mode as the session's engine honours it: Bypass, which none has, runs as Auto. */
export function sessionMode(engine: string, mode: PermissionMode): PermissionMode {
  return engineMode(engine, mode);
}

/** The mode a chat session the person answers runs in, as its engine honours it; null for unattended work. */
export function localMode(engine: string, permissions: DelegatePermissions | undefined): PermissionMode | null {
  return permissions ? sessionMode(engine, permissions.mode) : null;
}

/** How a session asks, and in which mode: the person's own session's permissions, or a worker's seat. */
export interface SessionAsks {
  mode: PermissionMode | null;
  asks: Pick<DelegatePermissions, "ask"> | undefined;
}

/**
 * The mode and the way to ask of a session: the chat's own session (or a lead) by its permissions; a
 * worker by its seat — the chat's mode as this engine honours it, asking through the seat, or, with
 * no way to ask, in its mode with nobody to ask (Plan still refuses each change). Unattended work
 * has neither.
 */
export function seatAsks(engine: string, request: Pick<DelegateRequest, "permissions" | "worker">): SessionAsks {
  const seat = request.worker;
  if (!seat) return { mode: localMode(engine, request.permissions), asks: request.permissions };
  return { mode: sessionMode(engine, seat.mode), asks: seat.asks };
}

/** Whether a tool changes something, so Plan withholds it from the model. */
export function changesSomething(name: string): boolean {
  return Object.hasOwn(CHANGE_TOOLS, name);
}

/** A string argument, or none. */
function text(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The question for one call, in Claude Code's tool names so the card reads as Claude's do: a
 * command as `Bash`, an edit as `Edit`, a whole file as `Write`. Null for arguments that are not an
 * object: the tool refuses those itself without running.
 */
export function localAsk(call: ToolCall, cwd: string, engine: string): PermissionAsk | null {
  const args = call.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const input = args as Record<string, unknown>;
  const base = { toolUseId: call.id, always: [] };
  const who = engineName(engine);
  if (call.name === LocalTool.RunCommand)
    return {
      ...base,
      tool: CardTool.Shell,
      title: ASK_TITLE.command(who),
      input: { command: text(input, "command") ?? "" },
    };
  const file = path.resolve(cwd, text(input, "path") ?? "");
  if (call.name === LocalTool.WriteFile)
    return {
      ...base,
      tool: CardTool.Write,
      title: ASK_TITLE.write(who, file),
      input: { file_path: file, content: text(input, "content") ?? "" },
    };
  return {
    ...base,
    tool: CardTool.Edit,
    title: ASK_TITLE.edit(who, file),
    input: { file_path: file, old_string: text(input, "oldText") ?? "", new_string: text(input, "newText") ?? "" },
  };
}

/** The person's answer as the model reads it: null to go ahead, else why the call did not run. */
function refusal(reply: PermissionReply): string | null {
  if (reply.decision !== PermissionDecision.Deny) return null;
  if ("withdrawn" in reply) return reply.message;
  const words = reply.message?.trim();
  return words ? deniedWithWords(words) : LOCAL_NOTE.denied;
}

/**
 * Whether a call may run in the session's mode now: null to run it, else the words the model reads
 * instead of its result. A change in Plan is refused without asking, whoever could be asked; one the
 * mode asks about waits for the person's answer (or the work ending around it), and runs where there
 * is nobody to ask (a worker's seat that cannot ask). A command in Auto goes to the Auto check first
 * (`autoCheck`), when the session has one.
 */
export async function permitCall(input: {
  engine: string;
  mode: PermissionMode | null;
  call: ToolCall;
  cwd: string;
  permissions: Pick<DelegatePermissions, "ask"> | undefined;
  signal: AbortSignal;
  autoCheck?: AutoCheck;
}): Promise<string | null> {
  const { mode, call, permissions } = input;
  if (!changesSomething(call.name) || mode === null) return null;
  if (mode === PermissionMode.Plan) return LOCAL_NOTE.planModeRefused;
  const kind = CHANGE_TOOLS[call.name];
  const check = mode === PermissionMode.Auto && kind === ChangeKind.Command ? input.autoCheck : undefined;
  if (!check && (!permissions || !ASKS[mode].has(kind))) return null;
  const ask = localAsk(call, input.cwd, input.engine);
  if (!ask) return null;
  if (check) return checkedInAuto(check, ask, permissions, input.signal);
  return permissions ? refusal(await permissions.ask(ask, input.signal)) : null;
}

/**
 * A command in Auto, as the Auto check decides it: allowed, it runs; refused, the model reads why;
 * unsure, the person is asked (with the check's reason), or — nobody to ask — it does not run.
 */
async function checkedInAuto(
  check: AutoCheck,
  ask: PermissionAsk,
  permissions: Pick<DelegatePermissions, "ask"> | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  const approval = await check(ask, signal);
  if (approval.verdict === AutoVerdict.Allow) return null;
  if (approval.verdict === AutoVerdict.Deny || !permissions) return AUTO_REFUSED(approval.reason);
  return refusal(await permissions.ask({ ...ask, reason: approval.reason }, signal));
}

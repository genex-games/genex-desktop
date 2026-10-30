/**
 * Auto for an engine with no auto-approval classifier of its own: the same engine and model,
 * asked in a call of its own with a clean context (no session history, no tools), whether one risky
 * action may run. Claude Code keeps its own Auto; a local model's session (Bonsai, OpenRouter, a
 * local server) asks this check before each command it runs in Auto (local-session-permissions.ts).
 * The check never allows by default: an answer it cannot read, a failed call or a timeout asks the
 * person instead, as Manual would.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { AUTO_APPROVER_SYSTEM, autoApproverAsk } from "./auto-approver-prompts.ts";
import type { CompleteRequest, CompleteResponse, PermissionAsk } from "./types.ts";

/** How long the check may take before the person is asked instead. */
const AUTO_CHECK_TIMEOUT_MS = 60 * SECOND_MS;
/** The check answers one short line. */
const AUTO_CHECK_TOKENS = 200;
/** At most this much of the action's input is shown to the check. */
const ACTION_INPUT_CHARS = 4_000;

/** What the check decided. Wire-free: read only here and by the session that asked. */
export const AutoVerdict = { Allow: "allow", Deny: "deny", Ask: "ask" } as const;
export type AutoVerdict = (typeof AutoVerdict)[keyof typeof AutoVerdict];

/** The check's answer: its verdict, and why. */
export interface AutoApproval {
  verdict: AutoVerdict;
  reason: string;
}

/** What the check is asked with: the session's own engine's completion and model, the action, where. */
export interface AutoApprovalAsk {
  complete: (request: CompleteRequest) => Promise<CompleteResponse>;
  model: string;
  cwd: string;
  ask: PermissionAsk;
  signal: AbortSignal;
}

/** The person decides: what an answer the check could not give means. */
const ASK_PERSON = (reason: string): AutoApproval => ({ verdict: AutoVerdict.Ask, reason });

/** The check's one line read as a verdict, or the person's to decide when it is not one. */
export function readVerdict(content: string): AutoApproval {
  const line = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(line) as { decision?: unknown; reason?: unknown };
    const verdict = Object.values(AutoVerdict).find((value) => value === parsed.decision);
    if (!verdict) return ASK_PERSON("the Auto check gave no decision");
    return { verdict, reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "" };
  } catch {
    return ASK_PERSON("the Auto check's answer could not be read");
  }
}

/** The action's input as the check reads it: its command, or its file and content, clipped. */
function inputOf(ask: PermissionAsk): string {
  const text = typeof ask.input.command === "string" ? ask.input.command : JSON.stringify(ask.input);
  return text.slice(0, ACTION_INPUT_CHARS);
}

/** Ask the session's own model, with a clean context, whether this one action may run in Auto. */
export async function autoApprove({ complete, model, cwd, ask, signal }: AutoApprovalAsk): Promise<AutoApproval> {
  const action = { title: ask.title ?? ask.tool, tool: ask.tool, input: inputOf(ask), cwd };
  try {
    const answer = await complete({
      model,
      systemPrompt: AUTO_APPROVER_SYSTEM,
      messages: [{ role: "user", content: autoApproverAsk(action) }],
      maxTokens: AUTO_CHECK_TOKENS,
      temperature: 0,
      timeoutMs: AUTO_CHECK_TIMEOUT_MS,
      signal,
    });
    return readVerdict(String(answer.message?.content ?? ""));
  } catch (err) {
    signal.throwIfAborted();
    return ASK_PERSON(`the Auto check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

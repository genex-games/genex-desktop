/** What the lead reads when it writes a plan for the user to review (`plan-drafts.ts`). Model-facing. */

/** The instruction for the one tool-free completion that writes a reviewable plan. */
export const PLAN_SYSTEM_PROMPT =
  "Write a concise implementation plan for the requested game or change in the existing conversation. Preserve the previous plan, decisions and completed work; revise only what the latest request changes. This is a planning-only step before explicit user approval. Do not execute work or call tools. Write a concise plan the person can approve or change. Do not claim to have inspected files. Return only the plan.";

/** The pieces a plan request is written from, each already cut to size. */
export interface PlanContextParts {
  /** The builders' plugins, accounts and connectors (`planning-capabilities.ts`). */
  capabilities: string;
  originalRequest: string;
  /** The conversation's last messages, one `role: text` line each. */
  recentConversation: string;
  /** The plan this request revises, when there is one. */
  previous?: { plan: string; approved: boolean };
  /** The current run's state and its saved plan, as JSON, when the game has a run. */
  build?: { state: string; savedPlan: string };
  latestRequest: string;
}

/** The one user message a plan is written from. */
export function planContext(parts: PlanContextParts): string {
  const previous = parts.previous
    ? [`Previous ${parts.previous.approved ? "approved" : "proposed"} plan:\n${parts.previous.plan}`]
    : [];
  const build = parts.build ? [`Build state:\n${parts.build.state}`, `Saved plan:\n${parts.build.savedPlan}`] : [];
  return [
    parts.capabilities,
    `Original request: ${parts.originalRequest}`,
    `Recent conversation:\n${parts.recentConversation}`,
    ...previous,
    ...build,
    `Latest request:\n${parts.latestRequest}`,
  ].join("\n\n");
}

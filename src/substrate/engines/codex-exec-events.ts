/**
 * The vocabulary of `codex exec --json`, the JSONL stream a Codex turn is read from. The exec path
 * reads it from the CLI; the app-server path (`codex-turns.ts`) writes the same events from the
 * app server's notifications, so one translation (`translateEvent` in `codex.ts`) serves both.
 */

/** `codex exec --json` event types, as the CLI spells them. Vendor wire values. */
export const CodexEvent = {
  ThreadStarted: "thread.started",
  TurnCompleted: "turn.completed",
  TurnFailed: "turn.failed",
  Error: "error",
  ItemStarted: "item.started",
  ItemUpdated: "item.updated",
  ItemCompleted: "item.completed",
} as const;
export type CodexEvent = (typeof CodexEvent)[keyof typeof CodexEvent];

/** The item types inside a Codex `item.*` event. */
export const CodexItem = {
  AgentMessage: "agent_message",
  Reasoning: "reasoning",
  CommandExecution: "command_execution",
  FileChange: "file_change",
  McpToolCall: "mcp_tool_call",
  WebSearch: "web_search",
  Error: "error",
  /**
   * A studio tool Codex called as a dynamic tool on the app server. `codex exec` has no such item;
   * this spelling is the studio's own, for the app server's `dynamicToolCall`.
   */
  DynamicToolCall: "dynamic_tool_call",
} as const;
export type CodexItem = (typeof CodexItem)[keyof typeof CodexItem];

/** Where a Codex item stands (`item.status`), as the CLI spells it. */
export const CodexItemStatus = {
  InProgress: "in_progress",
  Completed: "completed",
  Failed: "failed",
} as const;
export type CodexItemStatus = (typeof CodexItemStatus)[keyof typeof CodexItemStatus];

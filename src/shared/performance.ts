/** Fixed journey names accepted by the fixture diagnostics channel. */
export const PerformanceMarkName = {
  FirstCommit: "first-commit",
  EventBatch: "event-batch",
  GraphCommit: "graph-commit",
  Delta: "delta",
  TextPaint: "text-paint",
  Keydown: "keydown",
  ComposerCommit: "composer-commit",
} as const;
export type PerformanceMarkName = (typeof PerformanceMarkName)[keyof typeof PerformanceMarkName];
/** A renderer-clock journey sample; never carries application content. */
export interface PerformanceMark {
  name: PerformanceMarkName;
  at: number;
}
/** Fixed Profiler identities aggregate all graph nodes without retaining their IDs. */
export const PerformanceComponent = {
  App: "App",
  ChatConversation: "ChatConversation",
  /** Every row of the chat's transcript: how often rows are drawn, never which. */
  TranscriptRow: "TranscriptRow",
  RunGraph: "RunGraph",
  StepNode: "StepNode",
} as const;
export type PerformanceComponent = (typeof PerformanceComponent)[keyof typeof PerformanceComponent];

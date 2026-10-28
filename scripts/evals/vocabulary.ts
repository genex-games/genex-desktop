/**
 * The eval harness's vocabularies: every closed set of names a row, a report or a lane compares or
 * writes, spelled once here (`as const`, values in their exact wire spelling) and read everywhere
 * else through the object. The codes the app shares (`EndedHow`, `LaunchPath`, `ToolCategory`,
 * `TokenRole`, `LaneModeServed`, `AnswerPolicy`, `QuestionKind`) live in `src/shared/eval-lane.ts`
 * and are re-exported here so `scripts/evals` has one import. Persisted in ledger rows: never
 * rename a value.
 */

export {
  AnswerPolicy,
  EndedHow,
  EvalLaneErrorCode,
  EvalLaunchRefusal,
  LaneModeServed,
  LaunchPath,
  QuestionKind,
  TokenRole,
  ToolCategory,
} from "../../src/shared/eval-lane.ts";
export { CompletionPolicy } from "../../src/shared/run-state.ts";
export { ContributionKind, FieldPlatform, RunSharingAsk } from "../../src/shared/run-sharing.ts";

/** How `aaa grade` gets its taste verdict. */
export const AaaTasteMode = {
  /** No judge: taste is unmeasured, so no prompt can reach AA+. */
  Off: "off",
  /** The pinned families through the eval homes' engines (needs `--live`). */
  Live: "live",
} as const;
export type AaaTasteMode = (typeof AaaTasteMode)[keyof typeof AaaTasteMode];

/** Which agent a lane runs: the Genex app, or a raw coding CLI with no Genex. */
export const EvalAgent = {
  GenexApp: "genex-app",
  ClaudeCli: "claude-cli",
  CodexCli: "codex-cli",
} as const;
export type EvalAgent = (typeof EvalAgent)[keyof typeof EvalAgent];

/** A guard tripped (§5.5): the row is excluded from n and the rep is replaced. */
export const HarnessFailure = {
  AuthExpired: "auth-expired",
  RateLimited: "rate-limited",
  QuotaExhausted: "quota-exhausted",
  CliMissing: "cli-missing",
  CliChanged: "cli-changed",
  EmptyStream: "empty-stream",
  ZeroFiles: "zero-files",
  Contamination: "contamination",
  ServedModelMismatch: "served-model-mismatch",
  TokenMismatch: "token-mismatch",
  ContainmentUnavailable: "containment-unavailable",
  /** A Genex lane's engine was not ready (signed out, or its CLI missing), so no prompt was sent. */
  EngineNotReady: "engine-not-ready",
  /** A Genex launch failed inside the app's lane runner (refused, thread failed, no report), not the agent. */
  AppFailed: "app-failed",
} as const;
export type HarnessFailure = (typeof HarnessFailure)[keyof typeof HarnessFailure];

/**
 * The failures that say the provider account or its CLI is unavailable, not that this run went
 * wrong: every later run on that account would fail the same way, so the campaign stops cleanly and
 * resumes after a sign-in, a reset or an install, instead of replacing reps.
 */
const PROVIDER_FAILURES: ReadonlySet<HarnessFailure> = new Set([
  HarnessFailure.AuthExpired,
  HarnessFailure.QuotaExhausted,
  HarnessFailure.RateLimited,
  HarnessFailure.CliMissing,
  HarnessFailure.EngineNotReady,
]);

/** Whether a harness failure is the provider's (`PROVIDER_FAILURES`) rather than the run's own. */
export function isProviderFailure(failure: HarnessFailure | null): boolean {
  return failure !== null && PROVIDER_FAILURES.has(failure);
}

/** Why the stop-time snapshot holds nothing to grade (Rule 22): typed, never inferred from the live folder later. */
export const NoBuild = {
  TemplateUntouched: "template-untouched",
  NoEntry: "no-entry",
  BuildFailed: "build-failed",
  NoDist: "no-dist",
} as const;
export type NoBuild = (typeof NoBuild)[keyof typeof NoBuild];

/** A three-valued check: `unknown` is never a pass and never a fail. */
export const CheckResult = {
  Pass: "pass",
  Fail: "fail",
  Unknown: "unknown",
} as const;
export type CheckResult = (typeof CheckResult)[keyof typeof CheckResult];

/** Why a pin or a metric is unavailable (Rule 2). `Pinned.reason` is always one of these, never free text. */
export const UnavailableReason = {
  /** A quota window reset inside the run, so its delta means nothing. */
  WindowReset: "window-reset",
  /** The source never wrote it. */
  NotRecorded: "not-recorded",
  ParseFailure: "parse-failure",
  /** The stream or transcript ends before the run did. */
  Truncated: "truncated",
  /** The CLI does not report this value. */
  CliUnreported: "cli-unreported",
  /** A dirty trace: judgement metrics unknown, timing metrics contaminated (Rule 3). */
  TraceDirty: "trace-dirty",
  /** The first-playable scan ran out of its budget. */
  ScanBudget: "scan-budget",
  /** A snapshot could not be rebuilt for serving. */
  RebuildFailed: "rebuild-failed",
  /** No price for this model in `evals/prices.json`. */
  PriceUnknown: "price-unknown",
  /** The grader saw too little evidence. */
  JudgeSkipped: "judge-skipped",
  /** The probe was not run (no build, or the lock was never taken). */
  ProbeSkipped: "probe-skipped",
} as const;
export type UnavailableReason = (typeof UnavailableReason)[keyof typeof UnavailableReason];

/** How complete a metric section's measurement is; a null value comes with one of these. */
export const Coverage = {
  Full: "full",
  /** A/D judge tokens are missing until M4.5; such rows leave token and cost comparisons. */
  PartialJudges: "partial-judges",
  /** Stream totals only, with no transcript to deduplicate against. */
  StreamOnly: "stream-only",
  /** The first-playable scan hit its budget. */
  ScanBudget: "scan-budget",
  TraceDirty: "trace-dirty",
  Unmeasured: "unmeasured",
} as const;
export type Coverage = (typeof Coverage)[keyof typeof Coverage];

/** Notes a row carries (`notes: NoteCode[]`): typed remarks, never sentences. */
export const NoteCode = {
  AnsweredQuestion: "answered-question",
  /** Another lane ran on the other provider account at the same time. */
  CoRun: "co-run",
  Resumed: "resumed",
  /** This rep replaced a harness-failure row. */
  ReplacementRep: "replacement-rep",
  QuickGrade: "quick-grade",
  SoftwareRenderer: "software-renderer",
  /** Stream and transcript totals disagreed by more than the tolerance but the run was kept by hand. */
  TokenCrossCheckOff: "token-cross-check-off",
  /** A raw lane: it was told the deliverable shape the template gives Genex (the stated asymmetry). */
  RawDeliverableText: "raw-deliverable-text",
  /** The raw lane ran with the stricter contractor sandbox instead of the main agent's mode. */
  ContainmentContractor: "containment-contractor",
  EffortUnreported: "effort-unreported",
  CampaignVoid: "campaign-void",
} as const;
export type NoteCode = (typeof NoteCode)[keyof typeof NoteCode];

/** Whether the harness seed was tuned on this case's runs (§6.1). */
export const CaseExposure = {
  None: "none",
  DevTuned: "dev-tuned",
} as const;
export type CaseExposure = (typeof CaseExposure)[keyof typeof CaseExposure];

/** Public cases live in `evals/cases.md`; holdouts stay in `$GENEX_EVALS_HOME/cases-private.md` and never enter Git. */
export const CaseVisibility = {
  Public: "public",
  Holdout: "holdout",
} as const;
export type CaseVisibility = (typeof CaseVisibility)[keyof typeof CaseVisibility];

/** How a case is exercised: one build, an edit of a committed fixture game, a multi-turn follow-up, or a long Loop. */
export const CaseMode = {
  Build: "build",
  EditExisting: "edit-existing",
  FollowUp: "follow-up",
  LongHorizon: "long-horizon",
} as const;
export type CaseMode = (typeof CaseMode)[keyof typeof CaseMode];

/** What a run row records: a case build, a canary, or a calibration fixture. */
export const RowKind = {
  Build: "build",
  Canary: "canary",
  Calibration: "calibration",
} as const;
export type RowKind = (typeof RowKind)[keyof typeof RowKind];

/** Why a whole campaign is void. */
export const CampaignVoidReason = {
  OpeningCanary: "opening-canary",
  ClosingCanary: "closing-canary",
  CliChanged: "cli-changed",
} as const;
export type CampaignVoidReason = (typeof CampaignVoidReason)[keyof typeof CampaignVoidReason];

/** The sequential states `eval check` ends in (§10.3), with the exit code each one maps to. */
export const CheckState = {
  Clear: "clear",
  Flaky: "flaky",
  Probable: "probable",
  Regression: "regression",
} as const;
export type CheckState = (typeof CheckState)[keyof typeof CheckState];

/** The process exit code for each check state; `flaky` must be explained in the PR. */
export const CHECK_EXIT_CODE: Record<CheckState, number> = {
  [CheckState.Clear]: 0,
  [CheckState.Regression]: 2,
  [CheckState.Probable]: 3,
  [CheckState.Flaky]: 4,
};

/** One judge's pick in one blinded order; an unparseable reply is `invalid`, never a tie. */
export const PairPick = {
  Left: "left",
  Right: "right",
  Tie: "tie",
  Invalid: "invalid",
} as const;
export type PairPick = (typeof PairPick)[keyof typeof PairPick];

/** A pair's outcome over both orders: a win only when both orders agree. */
export const PairOutcome = {
  First: "first",
  Second: "second",
  Tie: "tie",
  PositionInconsistent: "position-inconsistent",
  Invalid: "invalid",
} as const;
export type PairOutcome = (typeof PairOutcome)[keyof typeof PairOutcome];

/** Which side a pairwise judge saw first: the pair's first lane on the left, or on the right. */
export const PairOrder = {
  FirstLeft: "first-left",
  FirstRight: "first-right",
} as const;
export type PairOrder = (typeof PairOrder)[keyof typeof PairOrder];

/** The facets a pairwise judge answers besides the overall pick; facets are descriptive only. */
export const PairFacet = {
  Overall: "overall",
  Works: "works",
  Visuals: "visuals",
  Feel: "feel",
  Play: "play",
} as const;
export type PairFacet = (typeof PairFacet)[keyof typeof PairFacet];

/** A human reviewer's pick (§8.6). */
export const HumanPick = {
  A: "a",
  B: "b",
  Tie: "tie",
  Insufficient: "insufficient",
} as const;
export type HumanPick = (typeof HumanPick)[keyof typeof HumanPick];

/** The decisive defect a human reviewer names. */
export const DefectCode = {
  None: "none",
  DoesNotBoot: "does-not-boot",
  NotPlayable: "not-playable",
  BriefUnmet: "brief-unmet",
  Broken: "broken",
  Illegible: "illegible",
  Regressed: "regressed",
  Other: "other",
} as const;
export type DefectCode = (typeof DefectCode)[keyof typeof DefectCode];

/** A grader's model family (Rule 19): votes are never summed across families. */
export const GraderFamily = {
  Claude: "claude",
  Gpt: "gpt",
  /** A third family through an API key with a spend cap (D4b), to de-confound the model axis. */
  Neutral: "neutral",
} as const;
export type GraderFamily = (typeof GraderFamily)[keyof typeof GraderFamily];

/** One checklist vote as a grader gives it. */
export const ChecklistVote = {
  Yes: "yes",
  No: "no",
  Invalid: "invalid",
} as const;
export type ChecklistVote = (typeof ChecklistVote)[keyof typeof ChecklistVote];

/** A checklist item's verdict, per family or combined (§8.4: both pass → pass, both fail → fail, else inconclusive). */
export const ItemVerdict = {
  Pass: "pass",
  Fail: "fail",
  Inconclusive: "inconclusive",
} as const;
export type ItemVerdict = (typeof ItemVerdict)[keyof typeof ItemVerdict];

/** Why a run's whole grade is void. */
export const GraderVoid = {
  /** The absurd control item passed. */
  ControlPassed: "control-passed",
} as const;
export type GraderVoid = (typeof GraderVoid)[keyof typeof GraderVoid];

/** The role a served model played in a run (`model.served[].role`). */
export const ServedModelRole = {
  Main: "main",
  Worker: "worker",
  Judge: "judge",
  Subagent: "subagent",
  Auxiliary: "auxiliary",
} as const;
export type ServedModelRole = (typeof ServedModelRole)[keyof typeof ServedModelRole];

/** The comparison axes (§7.1); each one changes one variable. */
export const Axis = {
  ProductDefault: "product-default",
  ProductHarness: "product-harness",
  ModelStack: "model-stack",
  Version: "version",
  /** Epoch against epoch after a CLI or model change. */
  Cli: "cli",
} as const;
export type Axis = (typeof Axis)[keyof typeof Axis];

/** Labels a result prints beside itself when its inference is limited. */
export const ResultLabel = {
  GraderFamilyConfounded: "grader-family-confounded",
  InstrumentConfounded: "instrument-confounded",
  Longitudinal: "longitudinal-drift-exposed",
  Descriptive: "descriptive",
  Observation: "observation",
} as const;
export type ResultLabel = (typeof ResultLabel)[keyof typeof ResultLabel];

/** How a snapshot was served for probing (§8.3); `rebuild-failed` is unknown, not "not playable". */
export const ServedVia = {
  AsIs: "as-is",
  Rebuilt: "rebuilt",
  RebuildFailed: "rebuild-failed",
} as const;
export type ServedVia = (typeof ServedVia)[keyof typeof ServedVia];

/** Which renderer headless Chromium ran on (S5); software makes fps and ack rows non-gating. */
export const RendererMode = {
  Gpu: "gpu",
  Software: "software",
} as const;
export type RendererMode = (typeof RendererMode)[keyof typeof RendererMode];

/** Whether the studio shim is injected when serving a snapshot (S3): for no lane, or for every lane. */
export const ShimMode = {
  None: "none",
  InjectForAll: "inject-for-all",
} as const;
export type ShimMode = (typeof ShimMode)[keyof typeof ShimMode];

/** The lane's mode as registered: the evaluated build's default, Loop off, or a raw CLI. */
export const LaneMode = {
  ProductDefault: "product-default",
  Auto: "auto",
  RawCli: "raw-cli",
} as const;
export type LaneMode = (typeof LaneMode)[keyof typeof LaneMode];

/** The network pin per lane (D2). */
export const NetworkPin = {
  /** Genex lanes: the app's contractor network policy, unchanged. */
  ContractorOff: "contractor-off",
  /** Raw Claude: not sandboxed; auto mode's classifier decides. */
  AutoClassifier: "auto-classifier",
  /** Raw Codex: `network_access=true`, recorded. */
  On: "on",
  Off: "off",
} as const;
export type NetworkPin = (typeof NetworkPin)[keyof typeof NetworkPin];

/** The browser pin per lane (D10). */
export const BrowserPin = {
  Studio: "studio",
  LookAtPage: "look-at-page",
  None: "none",
} as const;
export type BrowserPin = (typeof BrowserPin)[keyof typeof BrowserPin];

/** Which containment a raw lane ran under; Genex lanes are the app's own. */
export const ContainmentPin = {
  MainAgent: "main-agent",
  Contractor: "contractor",
  App: "app",
  Fixture: "fixture",
} as const;
export type ContainmentPin = (typeof ContainmentPin)[keyof typeof ContainmentPin];

/** The instruction set a lane receives: the Genex template's, the raw deliverable text, or a fixture replay. */
export const InstructionSet = {
  Genex: "genex",
  Raw: "raw",
  Fixture: "fixture",
} as const;
export type InstructionSet = (typeof InstructionSet)[keyof typeof InstructionSet];

/** A lane's place in the registry: a primary lane, an M3 lane, a hermetic fixture lane, or a future one. */
export const LaneStatus = {
  Primary: "primary",
  Harness: "harness",
  Fixture: "fixture",
  Future: "future",
} as const;
export type LaneStatus = (typeof LaneStatus)[keyof typeof LaneStatus];

/** Effort levels the lanes pin; the exact spelling each CLI takes. */
export const Effort = {
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  Xhigh: "xhigh",
  Max: "max",
} as const;
export type Effort = (typeof Effort)[keyof typeof Effort];

/** The hardware class a run was recorded on (never compared). */
export const HardwareClass = {
  AppleSilicon: "apple-silicon",
  IntelMac: "intel-mac",
  LinuxX64: "linux-x64",
  WindowsX64: "windows-x64",
  Unknown: "unknown",
} as const;
export type HardwareClass = (typeof HardwareClass)[keyof typeof HardwareClass];

/** How runs were scheduled (Rule 21). */
export const Concurrency = {
  OnePerProvider: "1-per-provider",
  Serial: "serial",
} as const;
export type Concurrency = (typeof Concurrency)[keyof typeof Concurrency];

/** Whether the operator attested that nobody else drew on the accounts during the run. */
export const AccountExclusive = {
  Attested: "attested",
  Unattested: "unattested",
} as const;
export type AccountExclusive = (typeof AccountExclusive)[keyof typeof AccountExclusive];

/**
 * The prober's rows (§8.2), spelled as genex-demo's prober spells them. Quick rows come in M2; the
 * rest in M3. Audio is five rows, never one boolean: a file loaded, a context running, a graph
 * reaching the destination, audible output, a media element playing.
 */
export const ProbeRow = {
  L1BuildsAndBoots: "l1.builds_and_boots",
  L1NoErrors60s: "l1.no_errors_60s",
  L1AssetsArrived: "l1.assets_arrived",
  L1StayedOnGame: "l1.stayed_on_game",
  L1Survives5min: "l1.survives_5min",
  L1FrameRateFloor: "l1.frame_rate_floor",
  L2Enterable: "l2.enterable",
  L2InputChangesState: "l2.input_changes_state",
  L2ActionAcknowledged200ms: "l2.action_acknowledged_200ms",
  L2NoSoftLock5min: "l2.no_soft_lock_5min",
  L2DirectionsMatchLabels: "l2.directions_match_labels",
  L2InteractAcknowledged: "l2.interact_acknowledged",
  L3VisuallyLegible: "l3.visually_legible",
  L3RendererDrew: "l3.renderer_drew",
  L3DarkPhase: "l3.dark_phase",
  L3SpatiallyLegible: "l3.spatially_legible",
  L3AssetsUsable: "l3.assets_usable",
  L3PhoneViewport: "l3.phone_viewport",
  L3AudioNetwork: "l3.audio.network",
  L3AudioContextState: "l3.audio.context_state",
  L3AudioGraphEdges: "l3.audio.graph_edges",
  L3AudioOutputRms: "l3.audio.output_rms",
  L3AudioElementState: "l3.audio.element_state",
} as const;
export type ProbeRow = (typeof ProbeRow)[keyof typeof ProbeRow];

/** The rows the M2 quick probe answers; the full prober answers all of `ProbeRow`. */
export const QUICK_PROBE_ROWS: readonly ProbeRow[] = [
  ProbeRow.L1BuildsAndBoots,
  ProbeRow.L1NoErrors60s,
  ProbeRow.L1AssetsArrived,
  ProbeRow.L1StayedOnGame,
  ProbeRow.L2Enterable,
  ProbeRow.L2InputChangesState,
  ProbeRow.L3VisuallyLegible,
  ProbeRow.L3RendererDrew,
];

/** The prober's phases, which every witnessed frame is stamped with (Rule 18). */
export const ProbePhase = {
  Boot: "boot",
  IdleBaseline: "idle-baseline",
  Entrance: "entrance",
  InputBurst: "input-burst",
  Directions: "directions",
  Ack: "ack",
  Interact: "interact",
  Look: "look",
  Soak: "soak",
  Mobile: "mobile",
  Audio: "audio",
  DarkPhase: "dark-phase",
} as const;
export type ProbePhase = (typeof ProbePhase)[keyof typeof ProbePhase];

/** How the quick probe got past the title screen: never a pixel diff. */
export const EntranceVia = {
  StartControl: "start-control",
  PressAnyKey: "press-any-key",
  PointerLock: "pointer-lock",
  CameraMoved: "camera-moved",
  None: "none",
} as const;
export type EntranceVia = (typeof EntranceVia)[keyof typeof EntranceVia];

/** The hand-made calibration fixtures under `tests/fixtures/evals/calibration/` (§6.2). */
export const CalibrationFixture = {
  EmptyCanvas: "empty-canvas",
  PlaceholderOnly: "placeholder-only",
  BrokenBuild: "broken-build",
  TemplateUntouched: "template-untouched",
  KnownGoodMiniGolf: "known-good-mini-golf",
} as const;
export type CalibrationFixture = (typeof CalibrationFixture)[keyof typeof CalibrationFixture];

/** A snapshot's kind (§8.3): a change-driven clone during the run, or the read-only final clone at stop. */
export const SnapshotKind = {
  Periodic: "periodic",
  Final: "final",
} as const;
export type SnapshotKind = (typeof SnapshotKind)[keyof typeof SnapshotKind];

/** Where an observation's facts came from. */
export const ObservationSource = {
  Stream: "stream",
  Transcript: "transcript",
  EventLog: "event-log",
  LaneReport: "lane-report",
  Snapshot: "snapshot",
} as const;
export type ObservationSource = (typeof ObservationSource)[keyof typeof ObservationSource];

/** The kinds of timeline event a `RunObservation` holds. */
export const ObservationEventKind = {
  Lifecycle: "lifecycle",
  ModelCall: "model-call",
  ToolCall: "tool-call",
  ContextSample: "context-sample",
  Compaction: "compaction",
  PreviewSignal: "preview-signal",
  BuildSpan: "build-span",
  Question: "question",
  Answer: "answer",
  Error: "error",
  Retry: "retry",
} as const;
export type ObservationEventKind = (typeof ObservationEventKind)[keyof typeof ObservationEventKind];

/** A run's lifecycle marks. */
export const LifecyclePhase = {
  PromptSubmitted: "prompt-submitted",
  Idle: "idle",
  Exited: "exited",
  RailSigterm: "rail-sigterm",
  RailSigkill: "rail-sigkill",
  Stopped: "stopped",
} as const;
export type LifecyclePhase = (typeof LifecyclePhase)[keyof typeof LifecyclePhase];

/** A lane-native "the user could see it" signal (`time.firstPreviewMs`). */
export const PreviewSignal = {
  Checkpoint: "checkpoint",
  StudioCapture: "studio-capture",
  LookAtPage: "look-at-page",
  /** The persisted first-preview event (M4.4). */
  PreviewReady: "preview-ready",
} as const;
export type PreviewSignal = (typeof PreviewSignal)[keyof typeof PreviewSignal];

/** A build span's kind (`builds[]`): a chat delegation or a facet build. */
export const BuildSpanKind = {
  ChatDelegation: "chat-delegation",
  Facet: "facet",
} as const;
export type BuildSpanKind = (typeof BuildSpanKind)[keyof typeof BuildSpanKind];

/** An error a stream or transcript reported, by kind. */
export const ObservedErrorKind = {
  ApiError: "api-error",
  RateLimited: "rate-limited",
  AuthExpired: "auth-expired",
  ToolError: "tool-error",
  Crash: "crash",
  Fallback: "fallback",
} as const;
export type ObservedErrorKind = (typeof ObservedErrorKind)[keyof typeof ObservedErrorKind];

/** The eval CLI's commands (§12), as `npm run eval -- <command>` spells them. */
export const EvalCommand = {
  Doctor: "doctor",
  Cases: "cases",
  CampaignPlan: "campaign plan",
  CampaignRun: "campaign run",
  Grade: "grade",
  Regrade: "regrade",
  Report: "report",
  Compare: "compare",
  Check: "check",
  BaselinePromote: "baseline promote",
  LedgerExport: "ledger export",
  LedgerPublish: "ledger publish",
  LedgerShare: "ledger share",
  LedgerUnshare: "ledger unshare",
  Calibrate: "calibrate",
  Review: "review",
  Gc: "gc",
  ValidateLedger: "validate-ledger",
  Diagnostics: "diagnostics",
  AaaSuite: "aaa suite",
  AaaCollect: "aaa collect",
  AaaGrade: "aaa grade",
  AaaCompare: "aaa compare",
  AaaReferences: "aaa references",
} as const;
export type EvalCommand = (typeof EvalCommand)[keyof typeof EvalCommand];

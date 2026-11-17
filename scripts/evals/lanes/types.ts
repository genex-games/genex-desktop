/**
 * The lane contract: a registry row (`evals/lanes.json`), what a lane runner is asked to run, the
 * artifacts it leaves behind and what it reports. Every lane runner (raw CLI or Genex app) takes a
 * `LaneRunRequest` and returns a `LaneRunResult`; the collector reads the artifacts. Adding a model
 * or a lane is a registry row, never a code change (§5.1).
 */
import type { AnswerPolicy, EndedHow, EvalCliHomes } from "../../../src/shared/eval-lane.ts";
import type { EngineId } from "../../../src/shared/providers.ts";
import type { ProviderUsage } from "../../../src/shared/provider-usage.ts";
import type { EvalCase } from "../case-types.ts";
import type {
  BrowserPin,
  ContainmentPin,
  EvalAgent,
  HarnessFailure,
  InstructionSet,
  LaneMode,
  LaneStatus,
  NetworkPin,
  NoBuild,
} from "../vocabulary.ts";

/** One row of `evals/lanes.json`. Lane ids are data and are never exactly an engine id. */
export interface LaneRegistryRow {
  id: string;
  agent: EvalAgent;
  engine: EngineId;
  model: string;
  effort: string;
  mode: LaneMode;
  network: NetworkPin;
  browser: BrowserPin;
  containment: ContainmentPin;
  instructionSet: InstructionSet;
  /** sha256[:12] of the lane's argv builder and instruction text, or `unpinned` until the lane exists. */
  flagsDigest: string;
  status: LaneStatus;
  /** A hermetic lane: scripted engines or stub executables, never a provider. */
  fixture: boolean;
  /** Genex lanes only: plugin ids the app turns off before the chat exists (absent: the profile's defaults). */
  disabledPlugins?: string[];
}

/** The registry file's shape. */
export interface LaneRegistry {
  schema: typeof LANE_REGISTRY_SCHEMA;
  lanes: LaneRegistryRow[];
}

/** The registry's schema id. */
export const LANE_REGISTRY_SCHEMA = "genex-evals/lanes/1";

/** An eval-owned app build (Genex lanes): the SHA it was built from and where it sits. */
export interface AppBuild {
  sha: string;
  dir: string;
  dirty: boolean;
}

/** What a lane runner is asked to run. */
export interface LaneRunRequest {
  runId: string;
  campaignId: string;
  lane: LaneRegistryRow;
  evalCase: EvalCase;
  rep: number;
  /** The run's own folder under `$GENEX_EVALS_HOME/work/<runId>/`, outside any Git repo: its bookkeeping. */
  workRoot: string;
  /**
   * Where the agent works: a fresh folder outside the evals home (`createLaneRoot`), or `workRoot`
   * itself for a lane run on its own. Its project, games and profile go here; the scheduler moves
   * them into `workRoot` when the run ends.
   */
  laneRoot: string;
  homes: EvalCliHomes;
  /** The eval-owned app build, Genex lanes only. */
  appBuild: AppBuild | null;
  deadlineMs: number;
  graceMs: number;
  /** The shared instruction suffix, identical across lanes. */
  suffix: string;
  /** The deliverable text raw lanes get (the stated asymmetry); null for Genex lanes. */
  deliverable: string | null;
  answerPolicy: AnswerPolicy;
  maxAnswers: number;
  /** `false` is a dry run: nothing is spawned. */
  live: boolean;
  interleaveSeed: string;
  coRunLane: string | null;
  /** The seeded template's digest, so `template-untouched` can be detected at stop. */
  templateDigest: string | null;
  /**
   * The real folder an edit case starts from (`resolveStartFrom`): the agent begins in a copy of
   * it. Null for a case built from nothing.
   */
  startDir: string | null;
}

/** Where a lane left its artifacts: inside the run's `workRoot`, or its `laneRoot` until the scheduler moves them. */
export interface LaneRunArtifacts {
  workRoot: string;
  /** The folder the agent ran in; its transcripts record working folders below it. */
  laneRoot: string;
  projectDir: string;
  /** The stream as received, one JSON line per event with a `receivedAt` field added on receipt. */
  streamPath: string | null;
  stdoutPath: string;
  stderrPath: string;
  /** The eval homes' transcript folders the run wrote into. */
  transcriptHomes: EvalCliHomes;
  /** Change-driven snapshots, one folder per clone. */
  snapshotDir: string;
  /** The read-only final clone at stop. */
  finalSnapshotDir: string | null;
  /** The eval profile's event log folder, Genex lanes only. */
  eventLogDir: string | null;
  /** The `EvalLaneReport` JSON, Genex lanes only. */
  reportPath: string | null;
  /** The spec the app launch read, Genex lanes only. */
  specPath: string | null;
}

/** What a lane runner reports when the run is over. */
export interface LaneRunResult {
  runId: string;
  artifacts: LaneRunArtifacts;
  startedAt: string;
  endedAt: string;
  endedHow: EndedHow;
  harnessFailure: HarnessFailure | null;
  noBuild: NoBuild | null;
  exitCode: number | null;
  signal: string | null;
  cliVersion: string | null;
  questionsAsked: number;
  answersGiven: number;
  quotaBefore: ProviderUsage | null;
  quotaAfter: ProviderUsage | null;
  /** Whether the lane's contamination asserts all held (§5.5). */
  contaminationClean: boolean;
}

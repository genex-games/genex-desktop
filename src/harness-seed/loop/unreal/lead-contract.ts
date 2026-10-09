/**
 * The shapes the Unreal Loop's lead shares across its modules: ONE lead session builds the whole
 * game in the user's visible Unreal editor, judges its own captures, saves when it has looked, and
 * starts workers (Genex's one worker model, `loop/workers/`): typed ones (Blender, Genex, sound,
 * texture, C++, the worker types the plugins declare) that work in copies of the game and deliver
 * files with a manifest, and generic ones from the run's shared pool; a fresh-eyes critic advises
 * and never gates. This module holds no
 * behavior: the run tools' names (their arguments are their specs, `lead-tools.ts` `LEAD_TOOLS`),
 * the sub-agents' kinds, states, tool allowlists and delivery manifest, the save points, the
 * critic's advice, the journal a run resumes from and the records the Builds graph reads. The
 * runner (`lead.ts` and its siblings) imports it; `seed-contracts.test.ts` holds its plugin tool
 * names to the bundled plugins'.
 */
import type { Run } from "../../types/harness.d.ts";
import type { LeadSeat } from "../director/lead-session.ts";
import { MAX_WAIT_S } from "../director/budgets.ts";
import { DirectorTool } from "../director/tool-specs.ts";
import type { Side } from "../judge.ts";
import type { WorkerMode, WorkerState } from "../outcomes.ts";
import type { JournalPhase } from "../run-events.ts";
import { MINUTE_MS } from "../time.ts";
import { WorkerTool, WorkerVerdict } from "../workers/contract.ts";
import { UnrealLoopTool } from "./live-contract.ts";

// ── the lead's run tools ─────────────────────────────────────────────────────────────────────

/**
 * The run tools the lead's session calls, by the names its engine sends; `run_status` and `note`
 * are the director's own. The studio forwards them as they are: never rename a value.
 */
export const LeadTool = {
  RunStatus: DirectorTool.RunStatus,
  SavePoint: "save_point",
  Rewind: "rewind",
  Milestone: "milestone",
  WorkerStart: WorkerTool.Start,
  WorkerStatus: WorkerTool.Status,
  WorkerWait: WorkerTool.Wait,
  WorkerSteer: WorkerTool.Steer,
  WorkerStop: WorkerTool.Stop,
  WorkerMark: WorkerTool.Mark,
  Critic: "critic",
  RebuildUnreal: "rebuild_unreal",
  Note: DirectorTool.Note,
} as const;
export type LeadTool = (typeof LeadTool)[keyof typeof LeadTool];

/** The longest `worker_wait`, in seconds: the director's own cap. */
export const MAX_AGENT_WAIT_S = MAX_WAIT_S;

// ── sub-agents ──────────────────────────────────────────────────────────────────────────────

/**
 * The kinds of typed worker the lead may start: the worker types the bundled plugins declare
 * (`workerTypes`), each run as one delivering agent. Journals, the graph and the lead's tool keep
 * them: never rename a value.
 */
export const AgentKind = {
  /** A new hard-surface model or kit pieces in Local Blender. */
  BlenderModel: "blender_model",
  /** Weld, decimate, scale, pivot, join or LODs on given inputs, in Local Blender. */
  BlenderPrep: "blender_prep",
  /** A Genex character or creature with its catalog clips. */
  GenexCast: "genex_cast",
  /** Genex sound effects or music, delivered as WAV. */
  Sound: "sound",
  /** A Genex texture or image, or a Blender bake. */
  Texture: "texture",
  /** C++ written in a copy and checked by the Unreal plugin's sandboxed build. */
  Cpp: "cpp",
} as const;
export type AgentKind = (typeof AgentKind)[keyof typeof AgentKind];

/** Where a sub-agent stands. Journals keep it: never rename a value. */
export const AgentState = {
  Running: "running",
  /** Delivered: its files are landed in the game folder. */
  Done: "done",
  Failed: "failed",
  /** Aborted by the run's end or a pause; what it delivered is kept. */
  Stopped: "stopped",
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];

/** The lead's word on a delivered worker (`worker_mark`): the digest stops repeating it. Genex's one verdict. */
export const AgentVerdict = WorkerVerdict;
export type AgentVerdict = WorkerVerdict;

/**
 * The plugin tools a sub-agent may be offered (the delegation's `toolAllow`), by agent name or
 * name prefix: never the editor connector, publishing or a paid CLI.
 */
export const AgentPluginTool = {
  /** Every Local Blender tool. */
  Blender: "blender__",
  /** Genex Tools' asset tool: characters, creatures, images, textures and sound. */
  GenexAsset: "genex__asset",
  /** The Unreal plugin's sandboxed C++ check, which never touches the editor. */
  CppCheck: UnrealLoopTool.CheckPart,
} as const;
export type AgentPluginTool = (typeof AgentPluginTool)[keyof typeof AgentPluginTool];

/** Each kind's `toolAllow`: a tool is offered when its agent name starts with one of these. */
export const AGENT_TOOL_ALLOW = {
  [AgentKind.BlenderModel]: [AgentPluginTool.Blender],
  [AgentKind.BlenderPrep]: [AgentPluginTool.Blender],
  [AgentKind.GenexCast]: [AgentPluginTool.GenexAsset, AgentPluginTool.Blender],
  [AgentKind.Sound]: [AgentPluginTool.GenexAsset],
  [AgentKind.Texture]: [AgentPluginTool.GenexAsset, AgentPluginTool.Blender],
  [AgentKind.Cpp]: [AgentPluginTool.CppCheck],
} as const satisfies Record<AgentKind, readonly AgentPluginTool[]>;

/** The tools a kind cannot work without (any one of them): the rest of its allowlist only helps. */
export const AGENT_MAIN_TOOLS = {
  [AgentKind.BlenderModel]: [AgentPluginTool.Blender],
  [AgentKind.BlenderPrep]: [AgentPluginTool.Blender],
  [AgentKind.GenexCast]: [AgentPluginTool.GenexAsset],
  [AgentKind.Sound]: [AgentPluginTool.GenexAsset],
  [AgentKind.Texture]: [AgentPluginTool.GenexAsset, AgentPluginTool.Blender],
  [AgentKind.Cpp]: [AgentPluginTool.CppCheck],
} as const satisfies Record<AgentKind, readonly AgentPluginTool[]>;

/**
 * The plugin tools a run's typed workers may be offered now (Local Blender's, and Genex Tools' asset
 * tool), and the worker types the plugins that are on declare (`plugins.workerTypes`; absent when
 * the host could not list them).
 */
export type AgentOffers = { blender: boolean; genex: boolean; types?: readonly string[] };

/** Whether a plugin tool is on: Local Blender's and Genex's by the offers, the Unreal plugin's always. */
function toolOn(tool: AgentPluginTool, offers: AgentOffers): boolean {
  if (tool === AgentPluginTool.Blender) return offers.blender;
  if (tool === AgentPluginTool.GenexAsset) return offers.genex;
  return true;
}

/**
 * Whether a kind is on offer: a plugin that is on declares it as a worker type, and a C++ worker also
 * needs a game that can take C++. When the host could not list the types, the kind's own tools decide.
 */
export function kindOffered(kind: AgentKind, offers: AgentOffers, cpp: boolean): boolean {
  if (kind === AgentKind.Cpp && !cpp) return false;
  if (offers.types) return offers.types.includes(kind);
  return kind === AgentKind.Cpp || AGENT_MAIN_TOOLS[kind].some((tool) => toolOn(tool, offers));
}

/** At most this many sub-agents work at once: Blender shares the Mac's CPU with Unreal. */
export const MAX_RUNNING_AGENTS = 2;
/** A sub-agent's turn. */
export const AGENT_MS = 25 * MINUTE_MS;
/** A cast's turn: generation, rigging and clips take longer. */
export const CAST_AGENT_MS = 40 * MINUTE_MS;
/** Each kind's turn. */
export const AGENT_TURN_MS = {
  [AgentKind.BlenderModel]: AGENT_MS,
  [AgentKind.BlenderPrep]: AGENT_MS,
  [AgentKind.GenexCast]: CAST_AGENT_MS,
  [AgentKind.Sound]: AGENT_MS,
  [AgentKind.Texture]: AGENT_MS,
  [AgentKind.Cpp]: AGENT_MS,
} as const satisfies Record<AgentKind, number>;

/** What the lead asks of a typed worker (`worker_start`): its kind, a title for the graph, its whole brief and its inputs. */
export type AgentRequest = {
  kind: AgentKind;
  title: string;
  brief: string;
  /** Game-folder paths it may read (models to prep, references), relative to the game folder. */
  inputs: string[];
};

/** Where every sub-agent delivers, in its copy and then in the game folder: `<root>/<id>/`. */
export const AGENT_DELIVERY_ROOT = "assets/agents";
/** The delivery's manifest, in the agent's own folder. */
export const AGENT_MANIFEST_FILE = "manifest.json";

/** What a delivered file is, as the lead imports it. Manifests keep it: never rename a value. */
export const AgentFileRole = {
  Mesh: "mesh",
  Skeletal: "skeletal",
  Animation: "animation",
  Texture: "texture",
  Sound: "sound",
  Render: "render",
} as const;
export type AgentFileRole = (typeof AgentFileRole)[keyof typeof AgentFileRole];

/** One delivered file: its game-folder path inside the agent's folder, its role, and what was measured. */
export type AgentManifestFile = {
  path: string;
  role: AgentFileRole;
  triangles?: number;
  /** Its bounds in centimetres, x, y, z. */
  sizeCm?: [number, number, number];
  /** Where its pivot sits, in words ("base centre", "grip"). */
  pivot?: string;
  materials?: string[];
  /** How many mesh objects the file holds: one, unless its brief asked for several (`meshesAsked`). */
  meshes?: number;
  meshesAsked?: boolean;
};

/**
 * A sub-agent's delivery (`assets/agents/<id>/manifest.json`): its files, its lit renders (paths),
 * the exact `genex_build` calls that import them, and what the lead must know.
 */
export type AgentManifest = {
  kind: AgentKind;
  title: string;
  files: AgentManifestFile[];
  renders: string[];
  importCalls: string[];
  notes: string;
  /** The Genex credits its jobs spent, as their answers said (`creditsCharged`); 0 when it ran none. */
  credits: number;
};

/** The lead's mark on a delivered sub-agent. */
export type AgentMark = { verdict: AgentVerdict; note: string | null; at: number };

/**
 * One sub-agent of the run: what it was asked, in which milestone, where its copy is (null once it
 * is removed), how it ended, the commit its delivery was landed from, what landed, what of it
 * stayed out and why, what waits to land, its manifest, the lead's mark, the save point a used
 * delivery merged into, and the Genex credits it spent.
 */
export type AgentRecord = AgentRequest & {
  id: string;
  milestoneId: string;
  state: AgentState;
  startedAt: number;
  endedAt: number | null;
  worktree: string | null;
  error: string | null;
  commit: string | null;
  landed: string[];
  refused: string[];
  /**
   * A delivery git couldn't check out into the game folder yet (its commit holds it): the files that
   * passed its checks, landed between turns or at the close. Absent in an older journal.
   */
  pending?: string[];
  manifest: AgentManifest | null;
  mark: AgentMark | null;
  mergedInto: string | null;
  credits: number;
  /** The critic's look at a delivered model's renders against its brief; absent when it had none to look at. */
  look?: AssetLook;
};

// ── save points, captures and the critic ───────────────────────────────────────────────────

/** Hero cameras are the level's CameraActors named with this prefix; a save point captures up to {@link MAX_HERO_SHOTS}. */
export const HERO_CAMERA_PREFIX = "GX_Shot_";
/** The most hero cameras a save point captures. */
export const MAX_HERO_SHOTS = 6;

/** A capture's tone numbers, each 0 to 1, as the Unreal plugin's bridge measures them (its `Tone`). */
export type ShotTone = {
  /** The 2nd luminance percentile: the black point. */
  p2: number;
  /** The 98th luminance percentile: the white point. */
  p98: number;
  mean: number;
  /** The luminance standard deviation: the contrast. */
  std: number;
  /** The lower third's luminance std (the near ground) and the upper middle band's (the distance): aerial perspective. */
  nearStd: number;
  farStd: number;
  /** The mean saturation. */
  saturation: number;
  /** The share of pixels at full white. */
  clipped: number;
};

/** One thumbnail of a save point: its camera, its capture file and its tone numbers when measured. */
export type SavePointShot = { camera: string; path: string; tone: ShotTone | null };

/**
 * One save point: its label, its snapshot, when, what it holds, its thumbnails, the milestone it is
 * a round of and its round number there, whether the harness made it (an autosave), and what the
 * plugins' steps at its checkpoint noted (`notes`, the log's new errors among them). An older save
 * point kept the Unreal log errors new since the one before (`logErrors`) instead.
 */
export type SavePoint = {
  label: string;
  snapshotId: string;
  at: number;
  summary: string;
  thumbnails: SavePointShot[];
  milestoneId: string;
  round: number;
  auto: boolean;
  notes?: string[];
  logErrors?: string[];
};

/** The most defects one critic answer carries. */
export const MAX_CRITIC_DEFECTS = 5;

/** The whole frame, as the host's `preview.crop` cuts it: a capture re-encoded as it is. */
export const WHOLE_FRAME: [number, number, number, number] = [0, 0, 1, 1];

/** One defect the critic saw, with its fix. */
export type CriticDefect = { defect: string; fix: string };

/** The critic's yes or no on a delivered model: ready to go into the game as it is, or not. Never rename a value. */
export const AssetVerdict = { Ready: "ready", NotReady: "not-ready" } as const;
export type AssetVerdict = (typeof AssetVerdict)[keyof typeof AssetVerdict];

/** The critic's look at a delivered model's renders against the brief it was made from, or why it couldn't look. */
export type AssetLook = { verdict: AssetVerdict; defects: CriticDefect[] } | { error: string };

/**
 * The critic's advice: what it looked at, the round it reviewed (null before the first save
 * point), at most {@link MAX_CRITIC_DEFECTS} defects with fixes, one bold move, and (`gates`) its
 * yes or no to its own art checks, one line each, which are not the brief's Gate 0–2. `required`
 * holds the open items of its last look it still saw in this one: a defect seen in two looks in a
 * row, which the lead fixes before anything new (absent in an older journal). It changes nothing.
 */
export type CriticAdvice = {
  at: number;
  shots: string[];
  question: string | null;
  milestoneId: string;
  round: number | null;
  defects: CriticDefect[];
  boldMove: string;
  gates: string[];
  required?: CriticDefect[];
};

// ── the journal ─────────────────────────────────────────────────────────────────────────────

/** What a lead run's journal is (`kind`), beside the other modes' journals under the same artifact id. */
export const LEAD_JOURNAL_KIND = "unreal-lead";

/** The lead's part before it names a milestone: its first column on the graph. */
export const LEAD_PART = "lead";

/** A milestone the lead named (`milestone`): its graph column, when it began and how many rounds it has. */
export type LeadMilestone = { id: string; title: string; startedAt: number; rounds: number };

/** Unreal went away under the run: when, whether it reopened in place, and the save point it was restored to (null when none). */
export type LeadCrash = { at: number; reopened: boolean; restoredTo: string | null };

/**
 * What the next digest owes the lead and what it has had: the owner's messages it was given (by
 * their words: the run's inbox hands them over as text), the failed or stopped agents whose news
 * it heard once, how many critic answers it saw, the words carried from between turns, the job
 * ends no steer reached, and when the last digest went out.
 */
export type LeadDigestState = {
  heardOwner: string[];
  toldAgents: string[];
  toldCritiques: number;
  carried: string[];
  /** The run's job ends read while no turn could take them: the next digest says them. */
  jobs: string[];
  lastAt: number | null;
};

/** Genex credits the run's sub-agents spent, and the run's cap (null when it has none). */
export type LeadCredits = { spent: number; cap: number | null };

/** The engines' cost so far: the sum of each turn's own cost, as the engine reports a delegation's share. */
export type LeadCost = { spent: number };

/** What waits for the end of the lead's turn: a rewind to a save point's label, a C++ rebuild. */
export type LeadBetween = { rewind: string | null; rebuild: boolean };

/** Why a lead run stopped working. Journals and the report keep it: never rename a value. */
export const LeadEndReason = {
  TimeUp: "time-up",
  Stopped: "stopped",
  /** The owner asked the run to finish. */
  Finished: "finished",
  /** An engine usage limit paused it; a Resume picks it up. */
  Limit: "limit",
  /** Unreal could not be reopened. */
  Halted: "halted",
  Failed: "failed",
  /** The lead ended several turns in a row within minutes: it had nothing more to build. */
  Idle: "idle",
} as const;
export type LeadEndReason = (typeof LeadEndReason)[keyof typeof LeadEndReason];

/** One time the run stopped working: why, when, and the owner's words for it. */
export type LeadEnd = { reason: LeadEndReason; at: number; words: string };

/**
 * The journal a lead run resumes from, saved under the run's shared journal artifact
 * (run-journal.ts `journalId`, keyed by `run.runId`): the app's Resume, its boot repair and
 * `resumeRun` find a run there by `run` and `phase`. `workedMs` is what `loopRunClock` reads.
 * `ends` lists each time the run stopped working, oldest first: pauses a Resume took up, then the
 * last end. `logOffset` is where Unreal's log ended at the last save point (or the run's start),
 * so a save point names only the errors new since the one before.
 */
export type LeadJournal = {
  kind: typeof LEAD_JOURNAL_KIND;
  phase: JournalPhase;
  run: Run;
  seat: LeadSeat;
  sessionId: string | null;
  briefed: boolean;
  handovers: number;
  turns: number;
  milestones: LeadMilestone[];
  savePoints: SavePoint[];
  agents: AgentRecord[];
  critiques: CriticAdvice[];
  crashes: LeadCrash[];
  digest: LeadDigestState;
  credits: LeadCredits;
  cost: LeadCost;
  between: LeadBetween;
  builtStamp: string | null;
  logOffset: number | null;
  ends: LeadEnd[];
  /** The end number of the run's last job end the lead has had (`jobs.list`): a resume reads on from here. */
  jobsCursor: number;
  workedMs: number;
  savedAt: string;
};

// ── the Builds graph ────────────────────────────────────────────────────────────────────────

/** A sub-agent's part on the graph is this prefix and its id. */
export const AGENT_PART_PREFIX = "agent-";

/** Where a save point's work was merged, as its `integration_merge` says: the editor took it into the game. */
export const MergeStage = { Editor: "editor" } as const;
export type MergeStage = (typeof MergeStage)[keyof typeof MergeStage];

/** A part as `autopilot_started` lists it. */
export type LeadPart = { id: string; title: string };

/** `autopilot_started` for a lead run: a director's run whose parts are the lead's own and its milestones. */
export type LeadStartedPayload = {
  project: string;
  director: true;
  maxParallel: number;
  facets: LeadPart[];
};

/** `director_worker` for a milestone or a sub-agent: its part, title, mode and state, with why when it stopped. */
export type LeadWorkerPayload = {
  workerId: string;
  title: string;
  mode: WorkerMode;
  state: WorkerState;
  stoppedBecause?: string;
  /** A sub-agent's files are in the game folder and wait for the lead to use them (the graph's `delivered`). */
  delivered?: true;
};

/**
 * The verdict source a save point's round carries: `verdict.ts`'s `VerdictSource.Lead`, spelled here
 * too because a `verdict.ts` the agent kept from before has no `Lead` (`seed-contracts.test.ts` holds
 * the two equal).
 */
export const LEAD_VERDICT_SOURCE = "lead";

/** `facet_iteration` for a save point: a round of its milestone that the lead kept by saving it. */
export type SavePointRoundPayload = {
  facetId: string;
  facetTitle: string;
  iteration: number;
  winner: typeof Side.Challenger;
  verdictSource: typeof LEAD_VERDICT_SOURCE;
  reason: string;
  satisfied: false;
  summary: string;
  label: string;
  snapshot: string;
  shots: SavePointShot[];
  logErrors: string[];
  auto: boolean;
};

/** `integration_merge` for a save point in the game, or a used sub-agent's delivery merged into one. */
export type LeadMergePayload = {
  project: string;
  facetId: string;
  round: number;
  iteration: number;
  snapshot: string;
  conflict: false;
  stage: MergeStage;
};

/** The critic's advice on the round it reviewed, as the graph shows it: advice, never a verdict. */
export type CriticAdvicePayload = {
  advice: true;
  facetId: string;
  iteration: number | null;
  at: string;
  defects: CriticDefect[];
  boldMove: string;
  gates: string[];
  shots: string[];
};

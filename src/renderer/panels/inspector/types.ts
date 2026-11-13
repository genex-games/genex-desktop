/** The props every inspector panel shares, and the lightbox's picture. */
import type { KeepBuildingTap } from "../../keep-building.ts";
import type { RunSummary } from "../../../shared/run-summary.ts";
import type {
  AssetInfo,
  AssetsNode,
  BaseNode,
  BlenderNode,
  RunGraph as RunGraphModel,
  RunNode,
} from "../../run-graph.ts";
import type { NoteTarget } from "../../reply-about.ts";
import type { PartRow, Step } from "../../run-steps.ts";
import type { BuildTimeline } from "../../run-graph-builds.ts";
import type { Notify } from "../../state/toasts.ts";

export type { NoteTarget } from "../../reply-about.ts";

/**
 * What a reply from a card is about: the chip's name, the prompt's hint and where the note goes
 * (a part, one of its tries and the camera it looked through; none of it means the whole build).
 */
export interface Reply {
  label: string;
  placeholder: string;
  target?: NoteTarget;
}

/** The lightbox's one picture: a run-folder still by path, or a data URL already in hand. */
export interface LightItem {
  path: string | null;
  src: string | null;
  title: string;
  caption: string;
}

export interface InspectorProps {
  selection: string;
  graph: RunGraphModel;
  outcome: RunSummary | null;
  rows: PartRow[];
  run: RunNode;
  base: BaseNode | null;
  blender: BlenderNode | null;
  assets: AssetsNode | null;
  project: string | null;
  baseSrc: string | null;
  resultSrc: string | null;
  resultPath: string | null;
  /** the result's picture is a part's, lent while the new build is being tried */
  resultBorrowed: boolean;
  /** a Loop's build history, when the run has one */
  timeline: BuildTimeline | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onLight: (items: LightItem[], index: number) => void;
  onOpenJob: (job: AssetInfo) => void;
  /** Put a chip naming this node in the chat's composer; null when there is no chat to reply in. */
  onReply: ((reply: Reply) => void) | null;
  /** Keep building on what the run left, in the chat that owns it; null when there is no chat. */
  onKeepBuilding: KeepBuildingTap | null;
  onNotice: Notify;
  onPlay: (() => Promise<void> | void) | null;
}

/** The props of a panel that describes one step of a part. */
export type StepPanelProps = InspectorProps & { row: PartRow; step: Step };

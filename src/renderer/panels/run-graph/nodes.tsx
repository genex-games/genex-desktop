import { memo } from "react";
import { PerformanceBoundary } from "../../performance.tsx";
import { PerformanceComponent } from "../../../shared/performance.ts";
/**
 * The Builds graph's nodes: what you asked, the assets tile, every step, the optimization tile,
 * your build and the lead — in a tree for the whole run, with its background tile and the finish
 * check; otherwise while it has the run between parts. Every picture node is one size:
 * its picture fills it and its words sit on the picture, so no state changes its height. A node at
 * work is its agent's screen: the window's newest frame, the agent's cursor, what it is doing.
 */
import type { CSSProperties, JSX, ReactNode } from "react";
import type { AgentScreenFrame } from "../../../shared/agent-screen.ts";
import { JobState } from "../../../shared/jobs.ts";
import type {
  AssetInfo,
  AssetsNode,
  BaseNode,
  BlenderNode,
  FinishCheckNode as FinishCheckModel,
  OptimizationNode,
  Rect,
  RunNode,
} from "../../run-graph.ts";
import { FinishCheckState, runIdOf, thumbShot, truncate } from "../../run-graph.ts";
import type { JobInfo } from "../../run-graph-workers.ts";
import { AssetCardState, BLENDER_SOURCE } from "../../run-graph-assets.ts";
import {
  askedRest,
  isLiveStep,
  type ResultStatus,
  STATE_TONE,
  type Step,
  StepState,
  stepWord,
  Tone,
} from "../../run-steps.ts";
import { jobsTileStatus, LeadFace } from "../../run-tree.ts";
import { useStill } from "../../stills.ts";
import { Icon } from "../../ui/icons.tsx";
import { ASSET_THUMB_PX, blenderRender, firstImage, isMaking } from "../inspector/asset-jobs.ts";
import { optimizationStatus } from "../inspector/OptimizationPanel.tsx";
import { IMAGE_OUTLINE } from "../inspector/pictures.tsx";
import { GraphSelection } from "../inspector/selection.ts";
import { NodeCursor, ScreenWords, useFrameSrc, usePartFrame } from "../inspector/screen.tsx";
import { StateGlyph, TONE } from "../inspector/tone.tsx";
import { sameStepNode, type StepNodeProps } from "./step-props.ts";
import { useRoundStill } from "../run-stills.ts";
import { FINISH_CHECK_WORDS, JOBS_EYEBROW, LEAD_WORDS } from "../../words.ts";
import { useNow } from "./use-builds-model.ts";

/** How much of the prompt the start node shows. */
const GOAL_CHARS = 48;
/** How many asset pictures the assets tile shows before it counts the rest. */
const ASSETS_SHOWN = 3;

/** How a node's frame looks: settled, a ghost of what is not there yet, at work right now, or your build. */
const Variant = {
  Normal: "normal",
  Ghost: "ghost",
  Working: "working",
  Result: "result",
} as const;
type Variant = (typeof Variant)[keyof typeof Variant];

/**
 * A node's edge is a ring drawn outside it, never a border: it is the same size in every state.
 * A blue ring means something is happening here now; the result wears a second, quiet ring.
 */
const RING: Record<Variant, string> = {
  [Variant.Normal]: IMAGE_OUTLINE,
  [Variant.Ghost]: "none",
  [Variant.Working]: "0 0 0 1.5px var(--accent), 0 0 0 6px var(--accent-tint)",
  [Variant.Result]: `${IMAGE_OUTLINE}, 0 0 0 5px var(--canvas), 0 0 0 6px var(--line-strong)`,
};
const SELECTED_RING = "0 0 0 2px var(--accent), 0 0 0 6px var(--accent-tint)";

/** A node's frame: a button at its rect, ringed by its variant; a ghost adds a dashed edge inside. */
function NodeFrame({
  id,
  rect,
  variant = Variant.Normal,
  selected,
  label,
  screen = null,
  onSelect,
  children,
}: {
  id: string;
  rect: Rect;
  variant?: Variant;
  selected: boolean;
  label: string;
  /** The window whose screen the node shows, while it shows one. */
  screen?: string | null;
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  const style: CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    boxShadow: selected ? SELECTED_RING : RING[variant],
  };
  return (
    <button
      type="button"
      data-graph-node={id}
      data-working={variant === Variant.Working && !selected ? "true" : undefined}
      data-agent-screen={screen ?? undefined}
      aria-label={label}
      aria-pressed={selected}
      className="absolute block cursor-pointer overflow-hidden rounded-[14px] bg-surface p-0 text-left transition-[box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {children}
      {variant === Variant.Ghost && !selected ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[14px] border border-dashed"
          style={{ borderColor: "color-mix(in oklab, var(--ink-3) 35%, var(--line-strong))" }}
        />
      ) : null}
    </button>
  );
}

/** Words on a picture sit on a dark fade whatever the theme, so their state colours are the light ones. */
const ON_PICTURE = {
  "--green": "#8fdca4",
  "--accent": "#a8c3f5",
  "--red": "#f6a0a4",
  "--orange": "#f3cd8a",
  "--ink-3": "rgb(255 255 255 / 72%)",
} as CSSProperties;

/** The caption's backdrop: a dark fade over a picture, the plain surface without one. */
const PICTURED_CAPTION: CSSProperties = {
  ...ON_PICTURE,
  background: "linear-gradient(to top, rgb(14 14 16 / 94%) 0%, rgb(14 14 16 / 70%) 50%, rgb(14 14 16 / 0%) 100%)",
};
const PLAIN_CAPTION: CSSProperties = { background: "linear-gradient(to top, var(--surface) 55%, transparent)" };

/** How a node's picture looks: as it is, `dim` (not in the build), or `soft` (borrowed until its own exists). */
const Look = { Plain: "plain", Dim: "dim", Soft: "soft" } as const;
type Look = (typeof Look)[keyof typeof Look];
const LOOK_STYLE: Record<Look, CSSProperties | undefined> = {
  [Look.Plain]: undefined,
  [Look.Dim]: { opacity: 0.45 },
  [Look.Soft]: { opacity: 0.6 },
};

/** What a node shows while it has no picture: a shimmer while work is in hand, a flat inset, or the hatch. */
const Fill = { Hatch: "hatch", Shimmer: "shimmer", Flat: "flat" } as const;
type Fill = (typeof Fill)[keyof typeof Fill];
const FILL_CLASS: Record<Fill, string> = {
  [Fill.Hatch]: "hatch",
  [Fill.Shimmer]: "graph-shimmer",
  [Fill.Flat]: "bg-inset",
};

/** The status glyph alone, grown, at the bottom right: all that is left of a node zoomed far out. */
function FarGlyph({ glyph }: { glyph: ReactNode }): JSX.Element | null {
  if (!glyph) return null;
  return (
    <span
      aria-hidden="true"
      className="absolute right-2.5 bottom-2.5 hidden size-5 origin-bottom-right scale-[1.8] place-items-center rounded-full bg-surface group-data-[zoom=far]/canvas:grid"
    >
      {glyph}
    </span>
  );
}

/**
 * A node's face: its picture fills it, its name and status sit at the bottom — on a dark fade
 * over a picture, on the plain surface without one — and a count or a label goes in a chip at the
 * top right. Zoomed far out only the picture and the status glyph are left.
 */
function NodeFace({
  src,
  look = Look.Plain,
  fill = Fill.Hatch,
  over = null,
  chip = null,
  name,
  word,
  tone,
  glyph,
  asked = null,
}: {
  src: string | null;
  look?: Look;
  fill?: Fill;
  /** Drawn on the picture, under the words: an agent's cursor. */
  over?: ReactNode;
  chip?: string | null;
  name: string;
  word: ReactNode;
  tone: Tone;
  glyph: ReactNode;
  asked?: string | null;
}): JSX.Element {
  const pictured = Boolean(src);
  return (
    <>
      {src ? (
        <img
          src={src}
          decoding="async"
          alt=""
          draggable={false}
          className="absolute inset-0 block h-full w-full object-cover"
          style={LOOK_STYLE[look]}
        />
      ) : (
        <span aria-hidden="true" className={`absolute inset-0 ${FILL_CLASS[fill]}`} />
      )}
      {over}
      {chip ? (
        <span
          className="absolute top-2 right-2 rounded-[7px] px-1.5 text-[11px] leading-4 text-white group-data-[zoom=far]/canvas:hidden"
          style={{ background: "rgb(14 14 16 / 72%)" }}
        >
          {chip}
        </span>
      ) : null}
      <span
        data-node-caption
        className="absolute inset-x-0 bottom-0 flex min-w-0 flex-col gap-px px-3 pt-7 pb-2.5 group-data-[zoom=far]/canvas:hidden"
        style={pictured ? PICTURED_CAPTION : PLAIN_CAPTION}
      >
        <span className={`truncate text-[13.5px] leading-[18px] font-semibold ${pictured ? "text-white" : "text-ink"}`}>
          {name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4" style={{ color: TONE[tone] }}>
          {glyph}
          <span className="truncate">{word}</span>
        </span>
        {asked ? (
          <span className="hidden truncate text-[11px] leading-[14px] text-ink-3 group-data-[zoom=near]/canvas:block">
            {asked}
          </span>
        ) : null}
      </span>
      <FarGlyph glyph={glyph} />
    </>
  );
}

/**
 * A tile's name and status in the flow of its card — the assets tile and the background tile,
 * which have no one picture — under an optional first line that says what the tile is.
 */
function TileText({
  eyebrow = null,
  name,
  word,
  glyph,
  color = "var(--ink-3)",
}: {
  eyebrow?: string | null;
  name: string;
  word: string;
  glyph: ReactNode;
  color?: string;
}): JSX.Element {
  return (
    <>
      <span className="flex min-w-0 flex-col gap-px px-1 group-data-[zoom=far]/canvas:hidden">
        {eyebrow ? <span className="truncate text-[11px] leading-[14px] text-ink-3">{eyebrow}</span> : null}
        <span className="truncate text-[13.5px] leading-[18px] font-semibold text-ink">{name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4" style={{ color }}>
          {glyph}
          <span className="truncate">{word}</span>
        </span>
      </span>
      <FarGlyph glyph={glyph} />
    </>
  );
}

function stepVariant(working: boolean, ghost: boolean): Variant {
  if (working) return Variant.Working;
  return ghost ? Variant.Ghost : Variant.Normal;
}

/** The chip on a step that folds several tries: which try is in hand, or how many it took. */
function triesChip(tries: number, working: boolean): string | null {
  if (tries <= 1) return null;
  return working ? `Try ${tries}` : `${tries} tries`;
}

/** One step of a part: its shown try's picture (its agent's screen while it works), its state, and how many tries it took. */
export const StepNode = memo(function StepNode({
  project,
  runId,
  active,
  step,
  rect,
  ghost,
  selected,
  onSelect,
}: StepNodeProps): JSX.Element | null {
  const working = isLiveStep(step);
  const shown = step.shown;
  const shot = shown ? thumbShot(shown) : null;
  const src = useRoundStill({ runId }, step.facetId, shown?.iteration ?? 1, shot?.path ?? null, working && active);
  const frame = usePartFrame(project, runIdOf({ runId }), step.facetId, working && active);
  const screen = useFrameSrc(frame);
  const word = stepWord(step, active);
  const tries = step.tries.length;
  if (!rect) return null;
  return (
    <PerformanceBoundary id={PerformanceComponent.StepNode}>
      <NodeFrame
        id={step.id}
        rect={rect}
        variant={stepVariant(working, ghost)}
        selected={selected}
        label={`${step.name}: ${[word, tries > 1 ? `${tries} tries` : null].filter(Boolean).join(", ")}`}
        screen={frame?.handle ?? null}
        onSelect={() => onSelect(step.id)}
      >
        <NodeFace
          src={screen ?? src}
          look={ghost ? Look.Dim : Look.Plain}
          fill={working ? Fill.Shimmer : Fill.Hatch}
          over={frame ? <NodeCursor frame={frame} box={rect} /> : null}
          chip={triesChip(tries, working)}
          name={step.name}
          word={frame ? <ScreenWords frame={frame} state={checkingWord(step, word)} /> : word}
          tone={STATE_TONE[step.state]}
          glyph={<StateGlyph state={step.state} />}
          asked={askedRest(step)}
        />
      </NodeFrame>
    </PerformanceBoundary>
  );
}, sameStepNode);

/** A step being checked says so before its checker's action; a step being built says only the action. */
const checkingWord = (step: Step, word: string): string | null => (step.state === StepState.Judging ? word : null);

/** The start node's face: building its starting point, failed to, or the prompt itself. */
function StartFace({
  src,
  building,
  failed,
  goal,
}: {
  src: string | null;
  building: boolean;
  failed: boolean;
  goal: string;
}): JSX.Element {
  if (building)
    return (
      <NodeFace
        src={src}
        fill={Fill.Shimmer}
        name="You asked"
        word="Starting point…"
        tone={Tone.Accent}
        glyph={<StateGlyph state={StepState.Building} />}
      />
    );
  if (failed)
    return (
      <NodeFace
        src={src}
        fill={Fill.Flat}
        name="You asked"
        word="Start failed"
        tone={Tone.Red}
        glyph={<StateGlyph state={StepState.Undone} />}
      />
    );
  return <NodeFace src={src} fill={Fill.Flat} name="You asked" word={`“${goal}”`} tone={Tone.Muted} glyph={null} />;
}

/** What you asked: the game's starting still and the prompt. */
export function StartNode({
  run,
  base,
  rect,
  src,
  active,
  selected,
  onSelect,
}: {
  run: RunNode;
  base: BaseNode | null;
  rect: Rect | undefined;
  src: string | null;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element | null {
  if (!rect) return null;
  const building = active && base !== null && !base.done;
  const goal = run.goal ? truncate(run.goal, GOAL_CHARS) : "No prompt recorded";
  return (
    <NodeFrame
      id={GraphSelection.Start}
      rect={rect}
      variant={building ? Variant.Working : Variant.Normal}
      selected={selected}
      label={`You asked: ${goal}`}
      onSelect={onSelect}
    >
      <StartFace src={src} building={building} failed={base?.ok === false} goal={goal} />
    </NodeFrame>
  );
}

/** Where the run's assets have got to, in one line: failures first, then work in hand, then the game. */
export function assetsStatus(jobs: AssetInfo[]): { text: string; tone: Tone } {
  const made = jobs.filter((job) => job.state === AssetCardState.Delivered);
  const failed = jobs.filter((job) => job.state === AssetCardState.Failed).length;
  const making = jobs.length - made.length - failed;
  const inGame = made.filter((job) => job.inGame).length;
  const known = made.filter((job) => job.inGame !== undefined).length;
  if (failed) return { text: `${failed} failed`, tone: Tone.Red };
  if (making) return { text: `Making ${making}`, tone: Tone.Accent };
  if (!known) return { text: `${made.length} delivered`, tone: Tone.Muted };
  if (inGame === made.length) return { text: `${inGame} in game`, tone: Tone.Green };
  if (inGame) return { text: `${inGame} of ${made.length} in game`, tone: Tone.Orange };
  return { text: "Not in game yet", tone: Tone.Orange };
}

/** The glyph the assets tile wears for each tone of its status; the other tones wear none. */
const ASSETS_GLYPH: Partial<Record<Tone, StepState>> = {
  [Tone.Red]: StepState.Undone,
  [Tone.Accent]: StepState.Building,
  [Tone.Green]: StepState.InBuild,
};

/** The assets tile's status when no plugin was asked: what the modeller made, or nothing yet. */
function modelledStatus(modelled: number, active: boolean): { text: string; tone: Tone } {
  if (modelled) return { text: `${modelled} modelled`, tone: Tone.Muted };
  return { text: active ? "None yet" : "None made", tone: Tone.Muted };
}

function AssetTile({ item, project }: { item: AssetInfo; project: string | null }): JSX.Element {
  const render = useStill(blenderRender(item));
  const picture = item.source !== BLENDER_SOURCE && item.state === AssetCardState.Delivered ? firstImage(item) : null;
  const still = useStill(project && picture ? { project, asset: picture, maxPx: ASSET_THUMB_PX } : null);
  const src = render ?? still;
  if (isMaking(item)) return <span className="graph-shimmer block h-full flex-1 rounded-[8px]" />;
  return (
    <span
      className="grid h-full flex-1 place-items-center overflow-hidden rounded-[8px] bg-inset text-ink-3"
      style={{ boxShadow: IMAGE_OUTLINE }}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : (
        <Icon name="box" size={14} />
      )}
    </span>
  );
}

/** The run's assets: the first delivered pictures and where the jobs have got to. */
export function AssetsTile({
  blender,
  assets,
  project,
  rect,
  active,
  selected,
  onSelect,
}: {
  blender: BlenderNode | null;
  assets: AssetsNode | null;
  project: string | null;
  rect: Rect;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const modelled = (blender?.assets ?? []).filter((asset) => asset.ok);
  const jobs = assets?.jobs ?? [];
  const all = [...modelled, ...jobs];
  const shown = [...jobs.filter((job) => job.state !== AssetCardState.Failed), ...modelled].slice(0, ASSETS_SHOWN);
  const status = jobs.length ? assetsStatus(jobs) : modelledStatus(modelled.length, active);
  const glyphState = ASSETS_GLYPH[status.tone];
  return (
    <NodeFrame
      id={GraphSelection.Assets}
      rect={rect}
      selected={selected}
      label={`Assets: ${status.text}`}
      onSelect={onSelect}
    >
      <span className="absolute inset-0 flex flex-col gap-2 p-2">
        <span className="flex min-h-0 flex-1 gap-1.5">
          {shown.length ? (
            shown.map((item) => (
              <AssetTile key={`${item.callId ?? item.jobId ?? item.name}:${item.at}`} item={item} project={project} />
            ))
          ) : (
            <span className="hatch block h-full flex-1 rounded-[8px]" />
          )}
        </span>
        <TileText
          name={all.length > ASSETS_SHOWN ? `Assets · ${all.length}` : "Assets"}
          word={status.text}
          glyph={glyphState ? <StateGlyph state={glyphState} /> : null}
          color={TONE[status.tone]}
        />
      </span>
    </NodeFrame>
  );
}

/** The Optimization stage, after the parts and before your build. */
export function OptimizationTile({
  node,
  rect,
  selected,
  onSelect,
}: {
  node: OptimizationNode;
  rect: Rect;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <NodeFrame
      id={GraphSelection.Optimization}
      rect={rect}
      selected={selected}
      label="Optimization stage details"
      onSelect={onSelect}
    >
      <NodeFace
        src={null}
        fill={Fill.Flat}
        name="Optimization"
        word={optimizationStatus(node)}
        tone={Tone.Muted}
        glyph={null}
      />
    </NodeFrame>
  );
}

/**
 * Your build: its picture and what `resultStatus` says of it — the same words its card uses. A
 * build still being tried wears a borrowed picture, softened, and the working ring.
 */
export function ResultNode({
  active,
  status,
  rect,
  src,
  borrowed,
  selected,
  onSelect,
}: {
  active: boolean;
  status: ResultStatus;
  rect: Rect | undefined;
  src: string | null;
  borrowed: boolean;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element | null {
  if (!rect) return null;
  const name = active ? "Latest build" : "Your build";
  const checking = status.state === StepState.Judging;
  return (
    <NodeFrame
      id={GraphSelection.Final}
      rect={rect}
      variant={checking ? Variant.Working : Variant.Result}
      selected={selected}
      label={`${name}: ${status.word}`}
      onSelect={onSelect}
    >
      <NodeFace
        src={src}
        look={borrowed ? Look.Soft : Look.Plain}
        fill={checking ? Fill.Shimmer : Fill.Hatch}
        name={name}
        word={status.word}
        tone={status.tone}
        glyph={<StateGlyph state={status.state} />}
      />
    </NodeFrame>
  );
}

/** How each of the lead's faces looks: its frame, what it shows without a picture, and its glyph. */
const LEAD_LOOK: Record<LeadFace, { variant: Variant; fill: Fill; glyph: StepState }> = {
  [LeadFace.Working]: { variant: Variant.Working, fill: Fill.Shimmer, glyph: StepState.Building },
  [LeadFace.Waiting]: { variant: Variant.Working, fill: Fill.Shimmer, glyph: StepState.Building },
  [LeadFace.Paused]: { variant: Variant.Normal, fill: Fill.Flat, glyph: StepState.NotInBuild },
  [LeadFace.Stopped]: { variant: Variant.Normal, fill: Fill.Flat, glyph: StepState.NotInBuild },
  [LeadFace.Done]: { variant: Variant.Normal, fill: Fill.Flat, glyph: StepState.InBuild },
};

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The lead: while it works itself, its own screen when it has shown one. In a tree it stands for
 * the whole run and says what it is doing: waiting for a worker, paused, done or stopped.
 */
export function LeadNode({
  rect,
  frame,
  face = LeadFace.Working,
  selected,
  onSelect,
}: {
  rect: Rect;
  frame: AgentScreenFrame | null;
  face?: LeadFace;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  // Only the lead at work shows its screen; waiting, it is the workers' screens that move.
  const shown = face === LeadFace.Working ? frame : null;
  const src = useFrameSrc(shown);
  const look = LEAD_LOOK[face];
  const word = LEAD_WORDS.face[face];
  return (
    <NodeFrame
      id={GraphSelection.Lead}
      rect={rect}
      variant={look.variant}
      selected={selected}
      label={`${LEAD_WORDS.name}: ${lowerFirst(word)}`}
      screen={shown?.handle ?? null}
      onSelect={onSelect}
    >
      <NodeFace
        src={src}
        fill={look.fill}
        over={shown ? <NodeCursor frame={shown} box={rect} /> : null}
        name={LEAD_WORDS.name}
        word={shown ? <ScreenWords frame={shown} /> : word}
        tone={STATE_TONE[look.glyph]}
        glyph={<StateGlyph state={look.glyph} />}
      />
    </NodeFrame>
  );
}

/** The glyph the background tile wears: work in hand while a job runs, none once all ended. */
const JOBS_GLYPH: Partial<Record<Tone, StepState>> = { [Tone.Accent]: StepState.Building };

/** The lead's background work, under it in a tree: the newest running job by name, the rest counted. */
export function JobsTile({
  jobs,
  rect,
  selected,
  onSelect,
}: {
  jobs: JobInfo[];
  rect: Rect;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const now = useNow(jobs.some((job) => job.state === JobState.Running));
  const status = jobsTileStatus(jobs, now);
  const glyphState = JOBS_GLYPH[status.tone];
  return (
    <NodeFrame
      id={GraphSelection.Jobs}
      rect={rect}
      selected={selected}
      label={`${JOBS_EYEBROW}: ${status.title}, ${status.status}`}
      onSelect={onSelect}
    >
      <span className="absolute inset-0 flex flex-col justify-end p-2">
        <TileText
          eyebrow={JOBS_EYEBROW}
          name={status.title}
          word={status.status}
          glyph={glyphState ? <StateGlyph state={glyphState} /> : null}
          color={TONE[status.tone]}
        />
      </span>
    </NodeFrame>
  );
}

/** How the finish check looks in each state: a ghost until it runs, at work while it checks. */
const FINISH_LOOK: Record<FinishCheckState, { variant: Variant; glyph: StepState | null }> = {
  [FinishCheckState.NotYet]: { variant: Variant.Ghost, glyph: null },
  [FinishCheckState.Checking]: { variant: Variant.Working, glyph: StepState.Judging },
  [FinishCheckState.Done]: { variant: Variant.Normal, glyph: StepState.InBuild },
  [FinishCheckState.Stopped]: { variant: Variant.Normal, glyph: StepState.Undone },
};

/** The finish check, the last node of a run's tree: the reviewer's check that the run is done. */
export function FinishCheckNode({
  node,
  rect,
  selected,
  onSelect,
}: {
  node: FinishCheckModel;
  rect: Rect;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const look = FINISH_LOOK[node.state];
  const state = FINISH_CHECK_WORDS.state[node.state];
  const word = node.state === FinishCheckState.NotYet ? `${state} · ${FINISH_CHECK_WORDS.placeholder}` : state;
  return (
    <NodeFrame
      id={GraphSelection.FinishCheck}
      rect={rect}
      variant={look.variant}
      selected={selected}
      label={`${FINISH_CHECK_WORDS.name}: ${word}`}
      onSelect={onSelect}
    >
      <NodeFace
        src={null}
        fill={look.variant === Variant.Working ? Fill.Shimmer : Fill.Hatch}
        name={FINISH_CHECK_WORDS.name}
        word={word}
        tone={look.glyph ? STATE_TONE[look.glyph] : Tone.Muted}
        glyph={look.glyph ? <StateGlyph state={look.glyph} /> : null}
      />
    </NodeFrame>
  );
}

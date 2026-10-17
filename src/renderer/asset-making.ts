/**
 * What a job still making an asset says, wherever it is shown (an Assets card, a chat row): the
 * kind of asset (its name and the drawing that stands in for it), the tool making it, where the
 * job is, and how long it has run. Pure: it reads the shared words of `shared/asset-making.ts`
 * that main and the chat fill in, and knows no plugin but by its id, name and picture.
 *
 * A Genex job names the tool its lane is routed to (`GenexTool`, the marks of `routed-tools.ts`);
 * one with no one tool is shown as Genex itself. Blender's jobs are Blender's. Any other plugin's
 * are shown by the outside tool it names, else by the plugin, with the plugin's own picture.
 */
import { GenexTool, MakingKind, type MakingJob, MakingPhase } from "../shared/asset-making.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { Source, sourceLabel } from "./assets-layout.ts";
import { MakingDrawing } from "./making-art.ts";
import { toolMark, toolShortName } from "./panels/plugins/genex/routed-tools.ts";
import type { IconName } from "./ui/icons.tsx";
import { MAKING_WORDS } from "./words.ts";

/** How each kind is drawn, and the glyph it wears in a list. */
const KIND_LOOK: Record<MakingKind, { drawing: MakingDrawing; icon: IconName }> = {
  [MakingKind.Character]: { drawing: MakingDrawing.Character, icon: "character" },
  [MakingKind.Creature]: { drawing: MakingDrawing.Character, icon: "character" },
  [MakingKind.Model]: { drawing: MakingDrawing.Model, icon: "box" },
  [MakingKind.RiggedModel]: { drawing: MakingDrawing.Model, icon: "character" },
  [MakingKind.Animation]: { drawing: MakingDrawing.Character, icon: "character" },
  [MakingKind.Image]: { drawing: MakingDrawing.Image, icon: "image" },
  [MakingKind.Texture]: { drawing: MakingDrawing.Texture, icon: "image" },
  [MakingKind.Video]: { drawing: MakingDrawing.Video, icon: "image" },
  [MakingKind.SoundEffect]: { drawing: MakingDrawing.Sound, icon: "sound" },
  [MakingKind.Music]: { drawing: MakingDrawing.Sound, icon: "sound" },
  [MakingKind.Voice]: { drawing: MakingDrawing.Sound, icon: "sound" },
};
/** A kind the plugin did not say: an asset, drawn as a model. */
const UNKNOWN_LOOK = { drawing: MakingDrawing.Model, icon: "box" } as const satisfies (typeof KIND_LOOK)[MakingKind];

/** A kind as it is named, drawn and listed; an unnamed asset for one the plugin did not say. */
export function kindLook(kind: MakingKind | null | undefined): {
  label: string;
  drawing: MakingDrawing;
  icon: IconName;
} {
  if (!kind || !Object.hasOwn(KIND_LOOK, kind)) return { label: MAKING_WORDS.kind.asset, ...UNKNOWN_LOOK };
  return { label: MAKING_WORDS.kind[kind], ...KIND_LOOK[kind] };
}

/** The tool on a card: its name, and its mark when there is a picture of it. */
export interface MakingTool {
  name: string;
  mark: string | null;
}

/** The plugin a job came from, as the person knows it: its name and its own picture. */
export interface MakingSource {
  name: string;
  icon?: string;
}

const isGenexTool = (tool: string | undefined): tool is GenexTool =>
  tool !== undefined && (Object.values(GenexTool) as string[]).includes(tool);
const routed = (tool: GenexTool): MakingTool => ({ name: toolShortName(tool), mark: toolMark(tool) });

/** Who is making it: the routed tool Genex names, Blender, else the tool or plugin a plugin names. */
export function makingTool(job: Pick<MakingJob, "source" | "tool">, plugin?: MakingSource): MakingTool {
  if (job.source === Source.Genex) return routed(isGenexTool(job.tool) ? job.tool : GenexTool.Publishing);
  if (job.source === Source.Blender) return routed(GenexTool.Blender);
  const name = job.tool?.trim() || plugin?.name || sourceLabel(job.source);
  return { name, mark: plugin?.icon ?? null };
}

/** Everything one job says while its asset is being made. */
export interface MakingView {
  phase: MakingPhase;
  drawing: MakingDrawing;
  /** The kind of asset, or, once the job stopped short, what happened to it. */
  title: string;
  prompt: string | null;
  tool: MakingTool;
  /** When the job started, in milliseconds, or null when it did not say. */
  startedAt: number | null;
  /** What a screen reader hears. */
  label: string;
}

/** The title a stopped-short job shows in place of its kind. */
const STOPPED_TITLE: Partial<Record<MakingPhase, string>> = {
  [MakingPhase.Failed]: MAKING_WORDS.failed,
  [MakingPhase.Stopped]: MAKING_WORDS.stopped,
  [MakingPhase.Unsure]: MAKING_WORDS.unsure,
  [MakingPhase.NotFetched]: MAKING_WORDS.notFetched,
  [MakingPhase.NotInGame]: MAKING_WORDS.notInGame,
};

/** What a job that stopped short is called (Didn’t finish, Not confirmed…), or null for one still on its way. */
export const stoppedTitle = (phase: MakingPhase): string | null => STOPPED_TITLE[phase] ?? null;

/** What a screen reader hears: the kind, where it is and with which tool, then the prompt. */
function spoken(phase: MakingPhase, kindName: string, title: string, tool: string, prompt: string | null): string {
  const words = MAKING_WORDS.spoken;
  const SAID: Partial<Record<MakingPhase, string>> = {
    [MakingPhase.Making]: words.making(kindName, tool),
    [MakingPhase.Queued]: words.queued(kindName, tool),
    [MakingPhase.Review]: words.review(kindName, tool),
  };
  const said = SAID[phase] ?? words.ended(kindName, tool, title);
  return prompt ? words.withPrompt(said, prompt) : said;
}

const startOf = (at: string | null | undefined): number | null => {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** A job as it is shown: what it makes, who makes it, where it is. */
export function makingView(
  job: Pick<MakingJob, "source" | "kind" | "phase" | "tool" | "prompt" | "at">,
  plugin?: MakingSource,
): MakingView {
  const look = kindLook(job.kind);
  const tool = makingTool(job, plugin);
  const prompt = job.prompt?.trim() || null;
  const title = STOPPED_TITLE[job.phase] ?? look.label;
  return {
    phase: job.phase,
    drawing: look.drawing,
    title,
    prompt,
    tool,
    startedAt: startOf(job.at),
    label: spoken(job.phase, look.label, title, tool.name, prompt),
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** The longest run the clock spells out; past it the card says the hours have run over. */
const CLOCK_MAX_H = 99;

/** How long a job has run, as a clock: 0:42, 12:05, 1:02:03; null when it did not say when it started. */
export function elapsedWords(startedAt: number | null, now: number): string | null {
  if (startedAt === null || !Number.isFinite(now)) return null;
  const seconds = Math.max(0, Math.floor((now - startedAt) / SECOND_MS));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > CLOCK_MAX_H) return MAKING_WORDS.overHours(CLOCK_MAX_H);
  if (!hours) return `${minutes}:${pad(seconds % 60)}`;
  return `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}

/** How often a clock moves on. */
export const CLOCK_TICK_MS = SECOND_MS;

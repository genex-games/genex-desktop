/**
 * The lead's save points: Genex's checkpoint of the game (`checkpoint.take`) under the lead's label.
 * The plugins that are on run their steps around Genex's snapshot (the Unreal plugin saves the
 * editor's work and reads its log's new errors before, and captures the hero cameras after), and
 * the save point keeps the snapshot, the steps' notes and their pictures as thumbnails; the graph
 * gets a round. Never two at once. A step that blocks (a play session the agent started, an editor
 * that can't say whether one runs, a save that failed), the person using the editor, or the chat's
 * Plan mode stops it: no snapshot, no save point, and the lead hears why. Between turns, a turn that
 * left unsaved work and no save point gets an autosave from the harness: the same checkpoint, asked
 * only when something is unsaved.
 */
import type { CheckpointAnswer, HookImage } from "../../types/host-api.d.ts";
import { CheckpointSkip, type HookHeldBy, notesText, runScope, takeCheckpoint } from "../hooks.ts";
import { HostMethod } from "../host-methods.ts";
import { isPlainRecord } from "../json.ts";
import { minutes, SECOND_MS } from "../time.ts";
import { MAX_HERO_SHOTS, type SavePoint, type SavePointShot, type ShotTone, WHOLE_FRAME } from "./lead-contract.ts";
import { savePointRound } from "./lead-graph.ts";
import { type Lead, milestoneNow, oneGitWrite, requiredNow, saveLead } from "./lead-journal.ts";
import { SAVE_POINT_WORDS } from "./lead-prompts.ts";

/** How long a save point once took at most. Kept for an older copy of a module that imports it. */
export const SAVE_POINT_MS = 90 * SECOND_MS;
/** The tone numbers a capture carries, by their names in the plugin's answer. */
const TONE_FIELDS = ["p2", "p98", "mean", "std", "nearStd", "farStd", "saturation", "clipped"] as const;

/**
 * The Unreal plugin's harness tools a save point once asked for by name. Kept for an older copy of
 * a module that imports it: no current module calls them, since the plugin's own steps run at
 * Genex's checkpoint. Never rename a value.
 */
export const LeadPluginTool = {
  EditorActivity: "unreal__editor-activity",
  HeroShots: "unreal__hero-shots",
} as const;
export type LeadPluginTool = (typeof LeadPluginTool)[keyof typeof LeadPluginTool];

const MESSAGE = {
  Autosave: "Autosave",
  AutosaveSummary: "Saved by Genex: the lead's turn ended with unsaved work.",
} as const;

/** What the editor once answered it was doing, as an older copy of a module reads `editorActivity`. */
type EditorActivity = { playing: boolean; dirty: number };

/** What a save point is asked for: its label and summary, and whether the harness asked (an autosave). */
export type SavePointAsk = { label: string; summary: string; auto: boolean };

/**
 * The harness's autosave: the save point it made, why it saved nothing (with Genex's own hold, when it
 * was Genex's, for the person's words), or null when nothing needed saving.
 */
export type Autosaved = { point: SavePoint } | ({ skipped: string } & HookHeldBy) | null;

/** Why no save point was made, and Genex's own hold when it held the checkpoint back. */
type Refusal = { refused: string } & HookHeldBy;

/** A save point made, or why none was. */
type Made = { point: SavePoint } | Refusal;

/**
 * Kept for an older copy of a module that imports it: the editor's activity is what the editor
 * lock's probe answers Genex now, so this answers that it can't say.
 */
export async function editorActivity(_lead: Lead): Promise<EditorActivity | null> {
  return null;
}

/** Kept for an older copy of a module that imports it: the plugin marks its log at Genex's run start now. */
export async function markLog(_lead: Lead): Promise<void> {}

/** A picture's numbers as a shot's tone when it carries all of them, else null. */
function toneOf(value: unknown): ShotTone | null {
  if (!isPlainRecord(value)) return null;
  const numbers = TONE_FIELDS.map((field) => value[field]);
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return Object.fromEntries(TONE_FIELDS.map((field) => [field, value[field]])) as ShotTone;
}

/** One picture as a JPEG run artefact: the PNG saved in the run's folder, then re-encoded whole; its path. */
async function jpegOf(lead: Lead, image: HookImage, label: string): Promise<string | null> {
  const { ctx, run } = lead;
  const png = await ctx
    .call(HostMethod.RunArtifact, { runId: run.runId, name: `${label}.png`, base64: image.data })
    .catch(() => null);
  if (typeof png !== "string") return null;
  const crop = await ctx
    .call(HostMethod.PreviewCrop, { runId: run.runId, path: png, crop: WHOLE_FRAME, label })
    .catch(() => null);
  return crop?.path ? crop.path : null;
}

/** The save point's thumbnails: the checkpoint's pictures, as JPEG run artefacts with their tone numbers. */
async function thumbnailsOf(lead: Lead, round: number, images: readonly HookImage[]): Promise<SavePointShot[]> {
  const made: SavePointShot[] = [];
  for (const image of images.slice(0, MAX_HERO_SHOTS)) {
    const label = `unreal/save-${round}/${image.name.replace(/[^a-z0-9-]+/gi, "-")}`;
    const path = await jpegOf(lead, image, label);
    if (path) made.push({ camera: image.name, path, tone: toneOf(image.measures) });
  }
  return made;
}

/** Genex's checkpoint under the label, after every git write queued before it for this run. */
function checkpointOf(lead: Lead, label: string, onlyIfUnsaved: boolean): Promise<CheckpointAnswer> {
  const ask = { ...runScope(lead), label, ...(onlyIfUnsaved ? { onlyIfUnsaved: true } : {}) };
  return oneGitWrite(lead, () => takeCheckpoint(lead.ctx, ask));
}

/** The save point a taken checkpoint makes: the journal's record, its round on the graph. */
async function recordPoint(lead: Lead, ask: SavePointAsk, taken: Extract<CheckpointAnswer, { snapshot: unknown }>) {
  const milestone = milestoneNow(lead.journal);
  const round = milestone.rounds + 1;
  const thumbnails = await thumbnailsOf(lead, lead.journal.savePoints.length + 1, taken.images ?? []);
  const point: SavePoint = {
    label: ask.label,
    snapshotId: taken.snapshot.snapshot_id,
    at: lead.clock.now(),
    summary: ask.summary,
    thumbnails,
    milestoneId: milestone.id,
    round,
    auto: ask.auto,
    notes: notesText(taken),
  };
  milestone.rounds = round;
  lead.journal.savePoints.push(point);
  await savePointRound(lead, point).catch(() => {});
  await saveLead(lead);
  return point;
}

/** One save point, start to record: Genex's checkpoint, then the journal and the graph; or why none was made. */
async function makeSavePoint(lead: Lead, ask: SavePointAsk, onlyIfUnsaved: boolean): Promise<Made | CheckpointSkipped> {
  const taken = await checkpointOf(lead, ask.label, onlyIfUnsaved);
  if ("blocked" in taken) return { refused: taken.blocked, hold: taken.hold, label: taken.label };
  if ("skipped" in taken) return { skipped: taken.skipped, reason: taken.reason };
  return { point: await recordPoint(lead, ask, taken) };
}

/** A checkpoint asked only when something is unsaved, skipped: nothing was, or Genex couldn't tell. */
type CheckpointSkipped = { skipped: CheckpointSkip; reason: string };

/** One save point at a time: another asked while one is under way is refused. */
async function savingOnce(lead: Lead, ask: SavePointAsk, onlyIfUnsaved = false): Promise<Made | CheckpointSkipped> {
  if (lead.saving) return { refused: SAVE_POINT_WORDS.Busy };
  const running = makeSavePoint(lead, ask, onlyIfUnsaved);
  lead.saving = running;
  try {
    return await running;
  } finally {
    lead.saving = null;
  }
}

/**
 * One save point, as `save_point` answers it: its snapshot id, the plugins' notes (the log's new
 * errors among them) and the thumbnails' tone numbers, or why none was made.
 */
export async function savePoint(lead: Lead, ask: SavePointAsk): Promise<string> {
  const made = await savingOnce(lead, ask);
  if ("refused" in made) return SAVE_POINT_WORDS.Refused(made.refused);
  if (!("point" in made)) return SAVE_POINT_WORDS.Refused(made.reason);
  const left = minutes(Math.max(0, lead.softDeadline - lead.clock.now()));
  return SAVE_POINT_WORDS.Answer(made.point, left, requiredNow(lead.journal));
}

/**
 * The harness's save point when the game holds unsaved work (between turns, at the close): null
 * when nothing is unsaved, and skipped with why when Genex couldn't tell, or a step, the person or
 * the chat's Plan mode stopped it.
 */
export async function autosave(lead: Lead): Promise<Autosaved> {
  const made = await savingOnce(lead, { label: MESSAGE.Autosave, summary: MESSAGE.AutosaveSummary, auto: true }, true);
  if ("point" in made) return made;
  if ("refused" in made) return { skipped: made.refused, hold: made.hold, label: made.label };
  return made.skipped === CheckpointSkip.NothingUnsaved ? null : { skipped: made.reason };
}

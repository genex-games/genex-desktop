/**
 * The lead's critic: fresh eyes on the lead's own captures. `critic` sends the named captures (each
 * by realpath inside the project's `Saved/Genex/captures/`) and the game's `references/` stills to a
 * fresh vision call that answers the lead's question: at most five defects, each with its fix when
 * one is clear. It is a second opinion: it changes nothing in the game or the run, and the graph
 * shows it on the round it reviewed.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { MessageImage } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { isPlainRecord } from "../json.ts";
import { CompletionRole, readJudgeJson } from "../judge-provenance.ts";
import { modelOn, RoleKey, roleEffort, roleEngine } from "../model-roles.ts";
import { boundedEffort } from "../effort-cap.ts";
import { CLIP_DETAIL, CLIP_REASON, clip, hasText } from "../text.ts";
import { MINUTE_MS } from "../time.ts";
import { adviceWords, CRITIC_SYSTEM, CRITIC_WORDS, criticAsk } from "./critic-prompts.ts";
import { pathShapeProblem, realInside } from "./game-paths.ts";
import { type CriticAdvice, type CriticDefect, MAX_CRITIC_DEFECTS, WHOLE_FRAME } from "./lead-contract.ts";
import { criticAdvice } from "./lead-graph.ts";
import { type Lead, milestoneNow, saveLead } from "./lead-journal.ts";

/** The critic thinks hard (a lower effort the person chose holds): it is asked rarely, and its eyes are the lead's check on itself. */
const CRITIC_EFFORT = "high";
/** One critic call takes at most this long. */
const CRITIC_MS = 5 * MINUTE_MS;
/** Where the Unreal project keeps its captures, from the game folder. */
export const CAPTURES_FOLDER = "unreal/Saved/Genex/captures";
/** The project-relative spelling of the same folder, which a lead may copy from a capture's answer. */
const PROJECT_CAPTURES = "Saved/Genex/captures";
/** At most this many captures, and this many reference stills, in one look. */
export const MAX_CRITIC_SHOTS = 6;
const MAX_REFERENCES = 3;
/** A reference still is scaled to this many pixels on its longest side. */
const REFERENCE_PX = 1024;
/** A capture is read when it is at most this large, and sent as it is when it is at most this large (else as a JPEG). */
const MAX_SHOT_BYTES = 40 * 1024 * 1024;
const MAX_RAW_SHOT_BYTES = 3 * 1024 * 1024;

/** The first bytes of the two image formats a capture may be in. */
const MAGIC: ReadonlyArray<{ mimeType: string; bytes: readonly number[] }> = [
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
];

/** A capture as the critic is shown it, or why it is not. */
type ShotRead = { image: MessageImage } | { refused: string };

/** The image format the bytes say, or null for anything else. */
function sniff(bytes: Buffer): string | null {
  return MAGIC.find((magic) => magic.bytes.every((byte, i) => bytes[i] === byte))?.mimeType ?? null;
}

/** A capture name the lead gave, as a path inside the captures folder (its folder prefix taken off). */
function captureName(raw: string): string {
  const name = raw.trim();
  for (const prefix of [`${CAPTURES_FOLDER}/`, `${PROJECT_CAPTURES}/`])
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}

/** The captures folder's real path, when it is a folder inside the game folder. */
async function capturesRoot(lead: Lead): Promise<string | null> {
  const found = await realInside(lead.game.dir, CAPTURES_FOLDER);
  return "real" in found ? found.real : null;
}

/** A big capture as a JPEG run artefact (the same re-encode the run's own stills get), or null when it can't be made. */
async function asJpeg(lead: Lead, bytes: Buffer, label: string): Promise<MessageImage | null> {
  const { ctx, run } = lead;
  const name = `unreal/critic/${label}`;
  const saved = await ctx.call(HostMethod.RunArtifact, { runId: run.runId, name, base64: bytes.toString("base64") });
  if (typeof saved !== "string") return null;
  const crop = await ctx.call(HostMethod.PreviewCrop, {
    runId: run.runId,
    path: saved,
    crop: WHOLE_FRAME,
    label: name,
  });
  return crop?.base64 ? { mimeType: "image/jpeg", data: crop.base64, label } : null;
}

/**
 * One picture, read by realpath inside `root` (the captures folder, or a sub-agent's folder for its
 * renders): a PNG or JPEG, sent whole or re-encoded. `name` is its path inside `root`; `outside`
 * says why one that leads elsewhere is refused.
 */
async function readShot(
  lead: Lead,
  root: string,
  raw: string,
  where: { name: string; outside: string },
): Promise<ShotRead> {
  const { name } = where;
  if (pathShapeProblem(name)) return { refused: CRITIC_WORDS.NotCapture(raw, CRITIC_WORDS.BadName) };
  const found = await realInside(root, name);
  if ("problem" in found) return { refused: CRITIC_WORDS.NotCapture(raw, where.outside) };
  const size = (await stat(found.real).catch(() => null))?.size ?? 0;
  if (size > MAX_SHOT_BYTES) return { refused: CRITIC_WORDS.NotCapture(raw, CRITIC_WORDS.TooLarge) };
  const bytes = await readFile(found.real).catch(() => null);
  const mimeType = bytes ? sniff(bytes) : null;
  if (!bytes || !mimeType) return { refused: CRITIC_WORDS.NotCapture(raw, CRITIC_WORDS.NotImage) };
  const label = path.basename(name);
  if (bytes.length <= MAX_RAW_SHOT_BYTES) return { image: { mimeType, data: bytes.toString("base64"), label } };
  const jpeg = await asJpeg(lead, bytes, label).catch(() => null);
  return jpeg ? { image: jpeg } : { refused: CRITIC_WORDS.NotCapture(raw, CRITIC_WORDS.TooLarge) };
}

/** The captures the lead named, read in order; what could not be shown, with why. */
async function readShots(lead: Lead, raw: unknown): Promise<{ images: MessageImage[]; left: string[] }> {
  const named = String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const left = named.length > MAX_CRITIC_SHOTS ? [CRITIC_WORDS.TooMany(MAX_CRITIC_SHOTS)] : [];
  const root = await capturesRoot(lead);
  if (!root)
    return { images: [], left: named.map((shot) => CRITIC_WORDS.NotCapture(shot, CRITIC_WORDS.NotInCaptures)) };
  const images: MessageImage[] = [];
  for (const shot of named.slice(0, MAX_CRITIC_SHOTS)) {
    const read = await readShot(lead, root, shot, { name: captureName(shot), outside: CRITIC_WORDS.NotInCaptures });
    if ("image" in read) images.push(read.image);
    else left.push(read.refused);
  }
  return { images, left };
}

/** The game's reference stills, scaled down; none when it has none or the host can't read them. */
async function referenceImages(lead: Lead): Promise<MessageImage[]> {
  const params = { project: lead.run.project, max: MAX_REFERENCES, maxPx: REFERENCE_PX };
  const found = await lead.ctx.call(HostMethod.GameReferences, params).catch(() => null);
  return (found?.frames ?? []).map((frame) => ({ mimeType: frame.mimeType, data: frame.data, label: frame.label }));
}

/** The open items of the critic's last look: its required items first, then its new defects (none before a first look). */
export function openItems(lead: Lead): CriticDefect[] {
  const last = lead.journal.critiques.at(-1);
  return last ? [...(last.required ?? []), ...last.defects] : [];
}

/** The items of `open` the critic named still open by their numbers (from 1), each once, at most MAX_CRITIC_DEFECTS. */
function stillOpen(raw: unknown, open: readonly CriticDefect[]): CriticDefect[] {
  const numbers = Array.isArray(raw) ? raw : [];
  const named = numbers.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= open.length);
  return [...new Set(named)]
    .map((n) => open[n - 1])
    .filter((item): item is CriticDefect => item !== undefined)
    .slice(0, MAX_CRITIC_DEFECTS);
}

/** The critic's answer as advice, or null when it is no list of defects (an empty list is an answer: it sees nothing wrong). */
function adviceOf(
  answer: AnyRecord | null,
  lead: Lead,
  look: { shots: string[]; question: string | null; open: readonly CriticDefect[] },
): CriticAdvice | null {
  const { shots, question } = look;
  if (!answer) return null;
  if (!Array.isArray(answer.defects)) return null;
  const defects = defectsOf(answer);
  const required = stillOpen(answer.stillOpen, look.open);
  const milestone = milestoneNow(lead.journal);
  const lastSave = lead.journal.savePoints.filter((point) => point.milestoneId === milestone.id).at(-1);
  return {
    at: lead.clock.now(),
    shots,
    question,
    milestoneId: milestone.id,
    round: lastSave?.round ?? null,
    defects,
    required,
  };
}

/** One fresh vision call on the judges' engine, at high effort, under `systemPrompt`: the critic's reply, as JSON when it is. */
async function lookOnce(
  lead: Lead,
  look: { systemPrompt: string; content: string; images: MessageImage[] },
): Promise<AnyRecord | null> {
  const { systemPrompt, content, images } = look;
  const { ctx, run, threadId } = lead;
  const engine = roleEngine(run, RoleKey.Judge);
  const model = modelOn(run, engine);
  const response = await ctx.call(HostMethod.EngineComplete, {
    engine,
    ...(model ? { model } : {}),
    systemPrompt,
    stream: false,
    effort: boundedEffort(CRITIC_EFFORT, roleEffort(run, RoleKey.Judge)),
    timeoutMs: CRITIC_MS,
    threadId,
    provenance: { role: CompletionRole.Judge, runId: run.runId },
    messages: [{ role: "user", content, images }],
  });
  return readJudgeJson(String(response?.message?.content ?? ""));
}

/** Asks the critic from `critic`'s arguments; answers its advice in words, or why it could not look. */
export async function askCritic(lead: Lead, args: AnyRecord): Promise<string> {
  if (!hasText(args.shots)) return CRITIC_WORDS.NoShots;
  const shots = await readShots(lead, args.shots);
  if (!shots.images.length) return CRITIC_WORDS.CouldNotLook(shots.left);
  const references = await referenceImages(lead);
  const question = hasText(args.question) ? clip(args.question.trim(), CLIP_REASON) : null;
  const names = shots.images.map((image) => image.label ?? "");
  const open = openItems(lead);
  const content = criticAsk({
    goal: lead.run.goal ?? "",
    question,
    shots: names,
    references: references.length,
    open,
  });
  let answer: AnyRecord | null;
  try {
    answer = await lookOnce(lead, { systemPrompt: CRITIC_SYSTEM, content, images: [...shots.images, ...references] });
  } catch (err) {
    return CRITIC_WORDS.Failed(clip(String((err as Error)?.message ?? err), CLIP_DETAIL));
  }
  const advice = adviceOf(answer, lead, { shots: names, question, open });
  if (!advice) return CRITIC_WORDS.Unreadable;
  lead.journal.critiques.push(advice);
  await criticAdvice(lead, advice);
  await saveLead(lead);
  return adviceWords(advice, { references: references.length, left: shots.left });
}

/** The critic's defects in an answer, at most MAX_CRITIC_DEFECTS, each with its fix. */
function defectsOf(answer: AnyRecord): CriticDefect[] {
  return (Array.isArray(answer.defects) ? answer.defects : [])
    .filter(isPlainRecord)
    .filter((row) => hasText(row.defect))
    .slice(0, MAX_CRITIC_DEFECTS)
    .map((row) => ({
      defect: clip(String(row.defect).trim(), CLIP_REASON),
      fix: clip(String(row.fix ?? "").trim(), CLIP_REASON),
    }));
}

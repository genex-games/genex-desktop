/**
 * A second opinion, and only when a Loop's lead asks for one (`judge`): a model that did none of the
 * work looks at the pictures the lead hands it and answers the lead's own question. It decides
 * nothing — no merge, finish, landing or close waits on it — and the lead reads its answer and
 * decides. The judge role's engine and model answer (the run's own when none is set).
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { HostMethod } from "./host-methods.ts";
import { CompletionRole } from "./judge-provenance.ts";
import { EngineId, RoleKey, roleEffort } from "./model-roles.ts";
import { isProviderLoss, noteProviderLoss } from "./provider-loss.ts";
import { CLIP_DETAIL, clip, hasText } from "./text.ts";
import type { HarnessCtx, Run } from "../types/harness.d.ts";
import type { LiveToolSpec, MessageImage } from "../types/host-api.d.ts";

/** The tool's name, as every Loop lead's engine sends it. Never rename. */
export const SECOND_OPINION_TOOL = "judge";
/** The most pictures one question carries. */
const MAX_PICTURES = 6;
/** The largest picture file a question carries. */
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
/** The longest question. */
const MAX_QUESTION_CHARS = 1_000;
/** The longest answer the lead is handed. */
const MAX_ANSWER_CHARS = 4_000;
/** The picture files a judge can read, by extension. */
const PICTURE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** What the judge is told about its part. Model-facing. */
const SYSTEM_PROMPT =
  "You give a second opinion on a project someone else is building; you did none of the work. Look at the pictures you are given and answer the question you are asked, honestly and briefly. Open with yes, no or unsure when the question allows it, then say what you see that makes you think so.";

/** The tool's words. */
export const SECOND_OPINION_WORDS = {
  description:
    "Ask a second opinion: a model that did none of the work looks at the pictures you name and answers your question. It decides nothing; you read its answer and decide.",
  question: "Your question, e.g. 'Does the menu react to a click?'.",
  pictures: "Comma-separated PNG or JPEG files in the project's folder (screenshots you took).",
  noQuestion: "judge needs a question.",
  noPictures: "judge needs at least one picture: name PNG or JPEG files in the project's folder.",
  badPicture: (rel: string, why: string) => `${JSON.stringify(rel)} is not a picture judge can read (${why}).`,
  failed: (why: string) => `No second opinion came back: ${why}.`,
  answer: (text: string) => `Second opinion: ${text}`,
} as const;

/** `judge` as a lead's engine sees it; `pictures` optional when the caller takes one itself (a web game's build). */
export function secondOpinionSpec({ picturesOptional = false }: { picturesOptional?: boolean } = {}): LiveToolSpec {
  return {
    name: SECOND_OPINION_TOOL,
    description: SECOND_OPINION_WORDS.description,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: SECOND_OPINION_WORDS.question },
        pictures: {
          type: "string",
          description: picturesOptional
            ? `${SECOND_OPINION_WORDS.pictures} Without any, Genex takes a screenshot of the build.`
            : SECOND_OPINION_WORDS.pictures,
        },
      },
      required: ["question"],
    },
  };
}

/** The pictures a lead names, comma-separated, read from inside `root`; or why one cannot be read. */
export async function picturesIn(
  root: string,
  named: unknown,
): Promise<{ images: MessageImage[] } | { refused: string }> {
  const list = hasText(named)
    ? named
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const images: MessageImage[] = [];
  const top = await realpath(root).catch(() => path.resolve(root));
  for (const rel of list.slice(0, MAX_PICTURES)) {
    const read = await pictureAt(top, rel);
    if ("refused" in read) return read;
    images.push(read.image);
  }
  return { images };
}

/** One picture inside `top`, by its path there. */
async function pictureAt(top: string, rel: string): Promise<{ image: MessageImage } | { refused: string }> {
  const mimeType = PICTURE_TYPES[path.extname(rel).toLowerCase()];
  if (!mimeType) return { refused: SECOND_OPINION_WORDS.badPicture(rel, "not a PNG or JPEG") };
  const full = await realpath(path.resolve(top, rel)).catch(() => null);
  const inside = full !== null && (full === top || full.startsWith(`${top}${path.sep}`));
  if (!full || !inside) return { refused: SECOND_OPINION_WORDS.badPicture(rel, "not a file in the project's folder") };
  const bytes = await readFile(full).catch(() => null);
  if (!bytes) return { refused: SECOND_OPINION_WORDS.badPicture(rel, "it could not be read") };
  if (bytes.length > MAX_PICTURE_BYTES) return { refused: SECOND_OPINION_WORDS.badPicture(rel, "too large") };
  return { image: { mimeType, data: bytes.toString("base64"), label: rel } };
}

/** A picture Genex itself took (a health check's screenshot), by its absolute path; null when it cannot be read. */
export async function pictureFile(file: string): Promise<MessageImage | null> {
  // The folder by its real path, as `pictureAt` reads the file by its own (macOS's /tmp is /private/tmp).
  const dir = await realpath(path.dirname(file)).catch(() => path.dirname(file));
  const read = await pictureAt(dir, path.basename(file));
  return "image" in read ? read.image : null;
}

/** What the lead asked: the question and the pictures. */
export interface SecondOpinionAsk {
  run: Run;
  question: string;
  images: readonly MessageImage[];
}

/** Ask the judge role once; its words, or why none came. A lost provider is noted for the run, as every caller's is. */
export async function askSecondOpinion(ctx: HarnessCtx, ask: SecondOpinionAsk): Promise<string> {
  const question = clip(ask.question.trim(), MAX_QUESTION_CHARS);
  if (!question) return SECOND_OPINION_WORDS.noQuestion;
  if (!ask.images.length) return SECOND_OPINION_WORDS.noPictures;
  const { run } = ask;
  const engine = run.judgeEngine ?? run.engine ?? EngineId.Ollama;
  try {
    const response = await ctx.call(HostMethod.EngineComplete, {
      engine,
      ...(run.judgeModel ? { model: run.judgeModel } : {}),
      systemPrompt: SYSTEM_PROMPT,
      stream: false,
      effort: roleEffort(run, RoleKey.Judge),
      provenance: { role: CompletionRole.Judge, ...(run.runId ? { runId: run.runId } : {}) },
      messages: [{ role: "user", content: question, images: [...ask.images] }],
    });
    const text = String(response?.message?.content ?? "").trim();
    return text
      ? SECOND_OPINION_WORDS.answer(clip(text, MAX_ANSWER_CHARS))
      : SECOND_OPINION_WORDS.failed("an empty answer");
  } catch (err) {
    const kind = (err as { kind?: unknown })?.kind;
    if (run.runId && isProviderLoss(kind)) noteProviderLoss(run.runId, engine, err);
    return SECOND_OPINION_WORDS.failed(clip(String((err as Error)?.message ?? err), CLIP_DETAIL));
  }
}

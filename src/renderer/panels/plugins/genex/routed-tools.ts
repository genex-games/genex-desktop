/**
 * The tools Genex routes, as its plugin page lists them and its picture plays them: the mark each
 * is shown with (bundled under `media/tools`), and the order of both. Their ids are the shared
 * `GenexTool` (`shared/asset-making.ts`), which a making job names. The names and
 * what each one does are user copy, in `GENEX_WORDS.router.tools`.
 */
import { GenexTool } from "../../../../shared/asset-making.ts";
import { GENEX_WORDS } from "../../../words.ts";

/** Each tool's mark, a file the app ships; light marks drawn for a dark tile. */
const MARK: Record<GenexTool, string> = {
  [GenexTool.Tripo]: "media/tools/tripo.png",
  [GenexTool.Meshy]: "media/tools/meshy.svg",
  [GenexTool.Uthana]: "media/tools/uthana.png",
  [GenexTool.GptImage]: "media/tools/openai.svg",
  [GenexTool.NanoBanana]: "media/tools/gemini.svg",
  [GenexTool.MiniMax]: "media/tools/minimax.svg",
  [GenexTool.Blender]: "media/tools/blender.svg",
  [GenexTool.ElevenLabs]: "media/tools/elevenlabs.svg",
  [GenexTool.Publishing]: "media/tools/genex.svg",
};

/** The tools in the order the page lists them, each with its mark. */
export const ROUTED_TOOLS: ReadonlyArray<{ id: GenexTool; mark: string }> = Object.values(GenexTool).map((id) => ({
  id,
  mark: MARK[id],
}));

/** The eight tools the router's picture plays, in the order they first fill and then join the board. */
export const ICON_TOOLS: readonly GenexTool[] = [
  GenexTool.Tripo,
  GenexTool.Meshy,
  GenexTool.ElevenLabs,
  GenexTool.GptImage,
  GenexTool.Uthana,
  GenexTool.NanoBanana,
  GenexTool.MiniMax,
  GenexTool.Blender,
];

/** A tool's mark. */
export const toolMark = (id: GenexTool): string => MARK[id];

/** The marks drawn light for a dark tile; a light theme shows them dark (`data-light-mark`). */
const LIGHT_MARKS: ReadonlySet<GenexTool> = new Set([
  GenexTool.GptImage,
  GenexTool.ElevenLabs,
  GenexTool.Uthana,
  GenexTool.Publishing,
]);

/** Whether a tool's mark is drawn light, for a dark tile. */
export const markIsLight = (id: GenexTool): boolean => LIGHT_MARKS.has(id);

/** Every tool's name, the short name a small chip uses, and what it does, checked to cover each tool. */
const COPY: Record<GenexTool, { name: string; short: string; line: string }> = GENEX_WORDS.router.tools;

/** A tool's name and what it does, as the page lists it. */
export const toolCopy = (id: GenexTool): { name: string; line: string } => COPY[id];

/** A tool's name without its version, for a small chip: "GPT Image", not "GPT Image 2.5". */
export const toolShortName = (id: GenexTool): string => COPY[id].short;

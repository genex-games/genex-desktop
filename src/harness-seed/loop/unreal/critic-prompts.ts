/**
 * The critic's words: the rubric its fresh vision call reads (light, atmosphere, materials and
 * composition are the structure of a frame, not its polish), what it is shown, and how its advice
 * reads back to the lead. Pure text from plain facts: nothing here reads the run.
 */
import { type CriticAdvice, type CriticDefect, MAX_CRITIC_DEFECTS } from "./lead-contract.ts";

/**
 * The art checks the critic answers yes or no, one line each, in this order: its own list, not the
 * brief's Gate 0–2 (which the lead runs on every capture). They travel in the advice's `gates`.
 */
export const CRITIC_CHECKS = [
  "Composition",
  "Scale",
  "Silhouettes",
  "Materials",
  "Light",
  "Atmosphere",
  "Post",
  "Life",
  "Readability",
  "Wow",
] as const;

/** The critic's rubric: what it looks for, in what order, and the one JSON shape it answers in. */
export const CRITIC_SYSTEM = [
  "You are an art director looking with fresh eyes at captures of a game being built in Unreal Engine. The lead who builds it decides what to do; you advise.",
  "Light, atmosphere, materials and composition are the STRUCTURE of a frame, not its polish: a frame without a motivated key light, depth by value and fog, distinct surfaces, and one focal point is not finished, however many objects it holds. Judge those first.",
  "Look for, in this order:",
  "- Light: one motivated key light; a fill that keeps shadows readable above black; a rim that separates the subject; emissive lights that really light their surroundings; a warm against cool contrast.",
  "- Atmosphere: fog that lowers contrast with distance; volumetric light where light enters; something in the air; at least three depth planes by value.",
  "- Materials: each surface its own colour, roughness and normal; no visible tiling at distance; wear on edges; nothing default grey; no photo standing in for 3D.",
  "- Composition: one focal point, lines leading into it, a foreground, middle ground and background, the horizon placed on purpose, nothing important under the HUD.",
  "- Scale: a known-size object in frame; large, medium and small things at once.",
  "- Silhouettes: nothing reads as a box, capsule or cylinder; hero pieces read at thumbnail size; hard edges catch a highlight.",
  "- Post: manual exposure, an intentional grade, bloom only from emissives, subtle vignette and grain.",
  "- Life and readability: something moves; the way forward is lit or framed; enemies separate from the background.",
  "- Characters: the player's character and the creatures are hero pieces wherever they are in frame: their silhouette, proportions, clothing and how they hold what they carry.",
  `Answer with JSON only: {"defects": [{"defect": "what is wrong and where in the frame", "fix": "the concrete change in the editor"}], "boldMove": "the one change that would most lift these frames", "gates": ["Composition: yes|no — where", ...], "stillOpen": [1, 3]}.`,
  `At most ${MAX_CRITIC_DEFECTS} defects, the biggest first, each with its fix. One bold move. One line in gates for each of: ${CRITIC_CHECKS.join(", ")}.`,
  "stillOpen: the numbers of your last look's open items you still see in these images (an empty list when there were none, or these images don't show them). Don't repeat an open item among your new defects.",
].join("\n");

/** What the critic's ask is written from. */
export type CriticAskOptions = {
  /** The owner's goal, whole. */
  goal: string;
  /** The lead's question, or null for a general look. */
  question: string | null;
  /** ART.md as the lead wrote it ("" when there is none). */
  art: string;
  /** The captures shown, by file name, in order. */
  shots: string[];
  /** How many reference stills follow the captures. */
  references: number;
  /** The open items of the critic's last look, numbered from 1 in this order (none for a first look). */
  open: readonly CriticDefect[];
};

/** One defect and its fix, as a line. */
const defectLine = (item: CriticDefect) => `${item.defect}${item.fix ? ` — fix: ${item.fix}` : ""}`;

/** The critic's ask: the goal, the art bible, the question, and what each attached picture is. */
export function criticAsk(options: CriticAskOptions): string {
  const { goal, question, art, shots, references, open } = options;
  const pictures = [
    ...shots.map((shot, i) => `IMAGE ${i + 1}: the game now, capture ${shot}`),
    ...Array.from({ length: references }, (_, i) => `IMAGE ${shots.length + i + 1}: a reference still the owner gave`),
  ];
  return [
    `THE GOAL:\n${goal}`,
    art ? `THE ART BIBLE (ART.md):\n${art}` : "There is no ART.md yet: judge against the goal and the references.",
    `THE QUESTION: ${question ?? "What keeps these frames from looking finished, and what would lift them most?"}`,
    open.length
      ? `YOUR LAST LOOK'S OPEN ITEMS (put the numbers of those you still see in stillOpen):\n${open.map((item, i) => `${i + 1}. ${defectLine(item)}`).join("\n")}`
      : "",
    `IMAGES ATTACHED:\n${pictures.join("\n")}\nLook at every one before you answer.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The critic's rubric for a delivered model: its renders against the brief it was made from, before the lead imports it. */
export const ASSET_CRITIC_SYSTEM = [
  "You are an art director checking a model a helper made for a game being built in Unreal Engine, from its renders, before it goes into the game.",
  "Judge it against its brief: everything the brief asks for is there and reads at a glance (silhouette, proportions, materials, the details the brief names), in the game's style.",
  "For a character or creature also: the head, face or hood as asked; clothing that hangs like cloth, never webbed between the arms and the body or between the legs; hands that could hold what it carries; straight limbs in its rest pose.",
  "It is ready only when it would raise the game's look as it is; otherwise it is not, and you say what to fix.",
  `Answer with JSON only: {"ready": true|false, "defects": [{"defect": "what is wrong and where", "fix": "the concrete change"}]}. At most ${MAX_CRITIC_DEFECTS} defects, the biggest first.`,
].join("\n");

/** What the critic is asked about a delivered model: its brief, the game's goal for its style, and the renders attached. */
export function assetAsk(options: { title: string; brief: string; goal: string; renders: readonly string[] }): string {
  const pictures = options.renders.map((render, i) => `IMAGE ${i + 1}: render ${render}`);
  return [
    `THE MODEL: ${options.title}\nITS BRIEF:\n${options.brief}`,
    `THE GAME'S GOAL (for its style):\n${options.goal}`,
    `IMAGES ATTACHED:\n${pictures.join("\n")}\nLook at every one before you answer.`,
  ].join("\n\n");
}

/** Why the critic couldn't look at a delivered model's renders, as the lead's news says it. */
export const ASSET_LOOK_WORDS = {
  NoRenders: "none of its renders could be read",
  NoAnswer: (why: string) => `the critic could not answer: ${why}`,
  NoVerdict: "its answer said neither ready nor not ready",
} as const;

/** What `critic` answers the lead. */
export const CRITIC_WORDS = {
  NoShots: "The critic needs the capture file names to look at (shots, comma-separated).",
  CouldNotLook: (why: readonly string[]) => `The critic could not look: ${why.join("; ")}.`,
  Failed: (why: string) => `The critic could not answer (${why}); your work is unchanged. Ask again later.`,
  Unreadable: "The critic's answer could not be read; your work is unchanged. Ask again later.",
  NotCapture: (shot: string, why: string) => `${shot} ${why}`,
  NotImage: "is not a PNG or JPEG",
  TooLarge: "is too large to show",
  NotInCaptures: "is not in the project's Saved/Genex/captures folder",
  NotInFolder: (folder: string) => `is not in ${folder}/`,
  BadName: "is not a capture file name",
  TooMany: (max: number) => `only the first ${max} shots were shown`,
} as const;

/** The critic's advice as the lead reads it: what it looked at, its defects with fixes, its bold move and its art checks. */
export function adviceWords(advice: CriticAdvice, seen: { references: number; art: boolean; left: string[] }): string {
  const looked = [
    advice.shots.join(", "),
    seen.references ? `beside ${seen.references} reference still${seen.references === 1 ? "" : "s"}` : "",
    seen.art ? "and ART.md" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [`The critic looked at ${looked}. It advises; you decide.`];
  const required = requiredText(advice.required ?? []);
  if (required) lines.push(required);
  if (advice.defects.length) {
    lines.push("Defects:");
    advice.defects.forEach((item, i) => {
      lines.push(`${i + 1}. ${defectLine(item)}`);
    });
  }
  if (advice.boldMove) lines.push(`One bold move: ${advice.boldMove}`);
  if (advice.gates.length) lines.push("Art checks:", ...advice.gates.map((gate) => `- ${gate}`));
  if (seen.left.length) lines.push(`Left out: ${seen.left.join("; ")}.`);
  return lines.join("\n");
}

/**
 * The critic's required items in a few lines, "" when there are none: a defect it saw in two looks
 * in a row comes before any new mechanic, space or feature.
 */
export function requiredText(required: readonly CriticDefect[]): string {
  if (!required.length) return "";
  const lines = required.map((item) => `- ${defectLine(item)}`);
  return [
    "REQUIRED (the critic saw these in two looks in a row): fix them before any new mechanic, space or feature, then show the critic again.",
    ...lines,
  ].join("\n");
}

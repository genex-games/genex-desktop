/**
 * The critic's words: what its vision call is asked (the lead's own question about its captures),
 * what it is shown, and how its advice reads back to the lead. A second opinion: it decides nothing. Pure text from plain facts: nothing here reads the run.
 */
import { type CriticAdvice, type CriticDefect, MAX_CRITIC_DEFECTS } from "./lead-contract.ts";

/**
 * How many check lines an answer may carry back (`gates`), the critic's own words: no list of checks is asked of it.
 */
export const CRITIC_CHECKS = ["Answer"] as const;

/** The critic's rubric: what it looks for, in what order, and the one JSON shape it answers in. */
export const CRITIC_SYSTEM = [
  "You give a second opinion on captures of a game being built in Unreal Engine. The lead who builds it decides what to do; you advise.",
  "Answer the lead's question about what the pictures show. Name only what you can see.",
  `Answer with JSON only: {"defects": [{"defect": "what you see that answers the question, and where in the frame", "fix": "a concrete change, when one is clear"}], "boldMove": "the change you would make first, or empty", "gates": [], "stillOpen": [1, 3]}.`,
  `At most ${MAX_CRITIC_DEFECTS} items, the biggest first.`,
  "stillOpen: the numbers of your last look's open items you still see in these images (an empty list when there were none, or these images don't show them).",
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
    art ? `THE LEAD'S NOTES (ART.md):\n${art}` : "",
    `THE QUESTION: ${question ?? "What do you see in these frames?"}`,
    open.length
      ? `YOUR LAST LOOK'S OPEN ITEMS (put the numbers of those you still see in stillOpen):\n${open.map((item, i) => `${i + 1}. ${defectLine(item)}`).join("\n")}`
      : "",
    `IMAGES ATTACHED:\n${pictures.join("\n")}\nLook at every one before you answer.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

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

/** The critic's advice as the lead reads it: what it looked at, its defects with fixes, what it still sees from its last look, and the change it would make first. */
export function adviceWords(advice: CriticAdvice, seen: { references: number; art: boolean; left: string[] }): string {
  const looked = [
    advice.shots.join(", "),
    seen.references ? `beside ${seen.references} reference still${seen.references === 1 ? "" : "s"}` : "",
    seen.art ? "and ART.md" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [`The critic looked at ${looked}. It advises; you decide.`];
  if (advice.defects.length) {
    lines.push("Defects:");
    advice.defects.forEach((item, i) => {
      lines.push(`${i + 1}. ${defectLine(item)}`);
    });
  }
  if (advice.required?.length)
    lines.push("Still there since its last look:", ...advice.required.map((item) => `- ${defectLine(item)}`));
  if (advice.boldMove) lines.push(`First change it would make: ${advice.boldMove}`);
  if (seen.left.length) lines.push(`Left out: ${seen.left.join("; ")}.`);
  return lines.join("\n");
}

/**
 * The only code that writes the model's reading and reply into the game: the intent and topic must be
 * known words, an item changes hands only on a trade, only if Mira carries it and only while she
 * trusts the player, and trust moves one step at a time.
 */
import { FACTS, ITEMS } from "./character.js";
import { INTENTS, MOODS, NOTHING } from "./schema.js";

const MAX_LINE = 200;
const MAX_TRUST = 5;

/** Text a model wrote, safe to draw. */
export function cleanText(value, max) {
  return Array.from(
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim(),
  )
    .slice(0, max)
    .join("");
}

/** What the player meant, as the game reads it. */
export const readIntent = (intent) => ({
  intent: INTENTS.includes(intent?.intent) ? intent.intent : "greet",
  topic: FACTS.some((fact) => fact.id === intent?.topic) ? intent.topic : NOTHING,
});

/** The fallback reading: a greeting about nothing. */
export const plainIntent = () => ({ intent: "greet", topic: NOTHING });

/** How trust moves with what the player meant. */
const TRUST_STEP = { greet: 1, ask: 0, trade: 0, threaten: -2, farewell: 0 };

/** Apply a reply: the line, the mood, trust, and the one item that may change hands. */
export function applyReply(npc, heard, reply) {
  npc.trust = Math.min(MAX_TRUST, Math.max(0, npc.trust + (TRUST_STEP[heard.intent] ?? 0)));
  npc.mood = MOODS.includes(reply?.mood) ? reply.mood : "wary";
  npc.line = cleanText(reply?.line, MAX_LINE) || plainReply(heard).line;
  const give = reply?.give;
  const fair = heard.intent === "trade" && npc.trust >= 2 && npc.mood !== "cold";
  if (fair && ITEMS.includes(give) && npc.carried.includes(give)) {
    npc.carried = npc.carried.filter((item) => item !== give);
    npc.given.push(give);
  }
}

/** The fallback reply: Mira nods and goes back to her anvil. */
export const plainReply = (heard) => ({
  line: heard.intent === "farewell" ? "Mira nods you off." : "Mira looks up from the anvil and nods.",
  mood: "wary",
  give: NOTHING,
});

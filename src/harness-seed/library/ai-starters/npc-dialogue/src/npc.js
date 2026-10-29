/**
 * A character the player talks to in their own words: the model reads what they meant, then answers
 * in character, and may hand over an item she really carries. Local-first: both calls are fast-tier,
 * so a small model on this Mac plays it. Engine-free: the game draws `state()`.
 *
 *   const ai = createAi({ sites: NPC_SITES, requires: "optional" });
 *   const npc = createNpc({ ai, seed });
 *   input.onkeydown = (e) => e.key === "Enter" && npc.say(input.value); // a gesture
 *   // in update(): npc.update(); in the HUD: hud.text(npc.disclosure().text)
 */
import { ITEMS } from "../ai/character.js";
import { Intent, Reply } from "../ai/schema.js";
import { characterSheet, intentPrompt, replyPrompt } from "../ai/prompts.js";
import { applyReply, plainIntent, plainReply, readIntent } from "../ai/applier.js";

export const NPC_SITES = ["npc.intent", "npc.reply"];
const MAX_SAID_CHARS = 240;
/** The lines of conversation the character remembers. */
const RECENT_LINES = 6;

/** The character, voiced by the model through `ai` (genex-ai's createAi). */
export function createNpc({ ai, seed = 1 }) {
  const npc = { trust: 1, mood: "wary", line: "", carried: [...ITEMS], given: [], blink: seed % 7 };
  const recent = [];
  let said = null;
  /** What the player meant by the line Mira is answering. */
  let lastHeard = plainIntent();
  let asked = false;
  let disclosed = false;

  const remember = (who, line) => {
    recent.push(`${who}: ${line}`);
    recent.splice(0, Math.max(0, recent.length - RECENT_LINES));
  };

  /** What the player meant (or the fallback reading), then the reply call. */
  function onIntent(result) {
    const heard = readIntent(result.value ?? plainIntent());
    ai.ask({
      site: "npc.reply",
      system: characterSheet(),
      prompt: replyPrompt(heard, npc.carried, npc.trust),
      untrusted: { said: said ?? "", recent: recent.join("\n") },
      schema: Reply,
      tier: "fast",
      maxOutputTokens: 120,
      fallback: () => plainReply(heard),
    });
    lastHeard = heard;
  }

  /** The reply (or the fallback) applied, and remembered. */
  function onReply(result) {
    applyReply(npc, lastHeard, result.value ?? plainReply(lastHeard));
    remember("mira", npc.line);
    said = null;
  }

  const handlers = { "npc.intent": onIntent, "npc.reply": onReply };

  return {
    /** From the chat box (a gesture): what the player says to Mira. */
    async say(words) {
      if (said !== null) return false;
      said = String(words ?? "").slice(0, MAX_SAID_CHARS);
      if (!asked) {
        asked = true;
        await ai.requestBudget();
      }
      remember("player", said);
      ai.ask({
        site: "npc.intent",
        system: characterSheet(),
        prompt: intentPrompt(),
        untrusted: { said },
        schema: Intent,
        tier: "fast",
        maxOutputTokens: 40,
        fallback: plainIntent,
      });
      return true;
    },
    update() {
      for (const result of ai.drain()) handlers[result.site]?.(result);
    },
    busy: () => said !== null || ai.status().pending > 0,
    disclosure() {
      disclosed = true;
      return ai.disclosure();
    },
    state: () => ({
      npc: { trust: npc.trust, mood: npc.mood, line: npc.line, carried: [...npc.carried], given: [...npc.given] },
      ai: { pending: ai.status().pending, disclosed },
    }),
  };
}

/**
 * The only code that turns a model's program into a bot: unknown words become the safe default,
 * power is clamped, rules past the cap are dropped and a program with no catch-all gets one. The
 * engine then runs it the same way every time.
 */
import { CONDITIONS, MAX_RULES, MOVES } from "./schema.js";

const MAX_NAME = 24;
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const clampPower = (value) => Math.min(3, Math.max(1, Math.trunc(Number(value) || 1)));

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

/** A program made legal: at most MAX_RULES known rules, ending in a catch-all. */
export function applyProgram(program, corner) {
  const raw = Array.isArray(program?.rules) ? program.rules.slice(0, MAX_RULES) : [];
  const rules = raw.map((rule) => ({
    when: pick(rule?.when, CONDITIONS, "always"),
    act: pick(rule?.act, MOVES, "guard"),
    power: clampPower(rule?.power),
  }));
  if (!rules.some((rule) => rule.when === "always")) rules.push({ when: "always", act: "guard", power: 1 });
  return { name: cleanText(program?.name, MAX_NAME) || `${corner} bot`, rules };
}

/** The fallback: a careful bot, so a match still happens with no AI. */
export const steadyProgram = (corner) => ({
  name: `${corner} sentinel`,
  rules: [
    { when: "hurt", act: "retreat", power: 1 },
    { when: "enemy-near", act: "strike", power: 2 },
    { when: "always", act: "advance", power: 1 },
  ],
});

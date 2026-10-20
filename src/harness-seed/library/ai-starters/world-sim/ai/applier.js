/**
 * The referee: the only code that writes a model's answer into the world. "The model proposes, the
 * engine disposes" — every number is clamped, every id checked, every move the rules forbid dropped,
 * and troops are conserved, whatever the model said. Pure; the checks feed it the worst answers a
 * schema allows.
 */
import { sharesBorder } from "./nations.js";

const MAX_STANCE = 5;
const MAX_TROOP_SHIFT = 500;
const MAX_STABILITY = 5;
const MAX_HEADLINE = 160;
const MAX_LINE = 200;
const MAX_CHRONICLE = 12;

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(value) || 0)));

/** Text a model wrote, made safe to draw: no control characters, trimmed, at most `max` characters. */
export function cleanText(value, max) {
  return Array.from(
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim(),
  )
    .slice(0, max)
    .join("");
}

/** One reaction, applied under the rules; null when the rules drop it. */
function applyReaction(world, reaction) {
  const nation = world.nations.find((entry) => entry.id === reaction?.nation);
  const target = world.nations.find((entry) => entry.id === reaction?.target);
  if (!nation || !target || nation === target) return null;
  nation.stance = clamp(nation.stance + clamp(reaction.stance, -3, 3), -MAX_STANCE, MAX_STANCE);
  if (reaction.action === "war" && !sharesBorder(nation.id, target.id)) return null;
  const moved = clamp(Math.abs(Number(reaction.troops) || 0), 0, Math.min(nation.troops, MAX_TROOP_SHIFT));
  nation.troops -= moved;
  const front = `${nation.id}>${target.id}`;
  world.fronts[front] = (world.fronts[front] ?? 0) + moved;
  return { nation: nation.id, target: target.id, action: reaction.action, troops: moved };
}

/** Apply a turn's proposal: unknown ids, illegal wars and overflows are dropped; troops are conserved. */
export function applyTurn(world, delta) {
  const reactions = Array.isArray(delta?.reactions) ? delta.reactions : [];
  const applied = reactions.map((reaction) => applyReaction(world, reaction)).filter(Boolean);
  const headline = cleanText(delta?.headline, MAX_HEADLINE) || quietTurn(world).headline;
  world.turn += 1;
  world.headline = headline;
  world.chronicle = [...world.chronicle, { turn: world.turn, headline, applied: applied.length }].slice(-MAX_CHRONICLE);
  return applied;
}

/** The fallback turn: the world keeps turning with no AI at all. */
export const quietTurn = (world) => ({
  reactions: [],
  headline: `Turn ${world.turn + 1}: an uneasy quiet settles over the continent.`,
});

/** The dispatch line, cleaned; the headline itself when the model gave nothing usable. */
export const applyDispatch = (world, dispatch) => {
  world.dispatch = cleanText(dispatch?.line, MAX_LINE) || world.headline;
};

/** The background drift, clamped to the stability scale. */
export function applyDrift(world, drift) {
  for (const change of Array.isArray(drift?.drifts) ? drift.drifts : []) {
    const nation = world.nations.find((entry) => entry.id === change?.nation);
    if (nation) nation.stability = clamp(nation.stability + clamp(change.stability, -2, 2), 0, MAX_STABILITY);
  }
}

/**
 * A delegation's tool allowlist (`HarnessDelegateParams.toolAllow`): the plugin tools and
 * connectors a run's sub-agent may be offered, by agent name or name prefix (`blender__`,
 * `genex__asset`). It only ever narrows: absent, every tool is offered as before.
 *
 * The harness that sends it is agent-editable, so a shape it should never send fails closed. A
 * value that is not a list offers nothing, and an entry that is not a name (an empty string, a
 * number) allows nothing, never everything.
 */

/** Whether a session may be offered the tool an agent calls by `name`. */
export type ToolOffered = (name: string) => boolean;

/** The rule an allowlist sets, or null when the delegation sent none and every tool is offered. */
export function toolAllowRule(allow: unknown): ToolOffered | null {
  if (allow === undefined) return null;
  if (!Array.isArray(allow)) return () => false;
  const prefixes = allow.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return (name) => prefixes.some((prefix) => name.startsWith(prefix));
}

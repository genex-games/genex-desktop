import type { ConnectionSnapshot } from "../shared/connections.ts";
import { t } from "../shared/i18n.ts";
import { McpHealth } from "../shared/mcp.ts";

type Source = ConnectionSnapshot["sources"][number];
/** Configuration is not authentication, runtime readiness, or permission to spend. */
export function connectionReadiness(source: Source): "disabled" | "needs attention" | "not checked" | "connected" {
  if (!source.enabled) return "disabled";
  if (needsAttention(source)) return "needs attention";
  const serving = source.kind === "mcp" && source.health === McpHealth.Ready && source.tools > 0;
  return serving ? "connected" : "not checked";
}

/** A reason on record, an account that is not unlocked, or a connection that failed or waits on sign-in. */
function needsAttention(source: Source): boolean {
  const accountBlocked = Boolean(source.account) && source.account !== "unlocked";
  const unhealthy = source.health === McpHealth.Failed || source.health === "authorizing";
  return Boolean(source.reason) || accountBlocked || unhealthy;
}
export function connectionHeadline(sources: Source[]): string {
  const enabled = sources.filter((s) => s.enabled);
  const attention = enabled.filter((s) => connectionReadiness(s) === "needs attention").length;
  const count = enabled.length;
  return attention
    ? t(
        "{count, plural, one {# tool source} other {# tool sources}} enabled · {attention, plural, one {# needs attention} other {# need attention}}",
        { count, attention },
      )
    : t("{count, plural, one {# tool source} other {# tool sources}} enabled · permissions checked when used", {
        count,
      });
}

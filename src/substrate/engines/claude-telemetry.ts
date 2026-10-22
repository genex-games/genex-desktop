import { CatalogError } from "./model-catalog.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { z } from "zod";
import { normalizeClaudeUsage, type ProviderUsage } from "../../shared/provider-usage.ts";
import { type EngineModel, ModelContextSource } from "./types.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";

/** How long a running session's telemetry waits on each optional control before it gives up. */
const TELEMETRY_DEADLINE_MS = 1.5 * SECOND_MS;
/** How long the idle session opened only to ask waits for the plan's usage. */
const USAGE_DEADLINE_MS = 10 * SECOND_MS;

export interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

/** Provider request identities and names take precedence over cached display metadata. */
export function withClaudeModelCapabilities(fallback: EngineModel[], models: ClaudeModelInfo[]): EngineModel[] {
  const seen = new Set<string>();
  return models
    .filter((model) => {
      if (seen.has(model.value)) return false;
      seen.add(model.value);
      return true;
    })
    .map((model) => {
      const previous = fallback.find((row) => row.id === model.value && row.resolvedModel === model.resolvedModel);
      return {
        id: model.value,
        label: model.displayName?.trim() || model.value,
        resolvedModel: model.resolvedModel,
        note: model.description,
        contextWindow: previous?.contextWindow ?? 0,
        contextSource: previous?.contextSource ?? ModelContextSource.Unknown,
        maxTokens: 64_000,
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true,
        efforts: model.supportedEffortLevels ?? [],
        supportsFast: model.supportsFastMode === true,
      };
    });
}
/** Claude Code's own summary of how full a session's context is. */
type ClaudeContextSummary = { totalTokens: number; maxTokens: number; percentage: number; model: string };
/** A context summary checked and restated as Studio's reading. */
type ContextReading = { promptTokens: number; contextWindow: number; percent: number; model: string };
type TelemetryQuery = {
  getContextUsage?: (options: { detail: "summary" }) => Promise<ClaudeContextSummary>;
  supportedModels?: () => Promise<ClaudeModelInfo[]>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
};
async function bounded<T>(read: () => Promise<T> | undefined, deadlineMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), deadlineMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
/** Plan limits alone, from a session opened only to ask: nothing is sent, so no turn is spent. */
export async function readClaudeUsage(stream: unknown, deadlineMs = USAGE_DEADLINE_MS): Promise<ProviderUsage | null> {
  const query = stream as TelemetryQuery;
  return normalizeClaudeUsage(
    await bounded(() => query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.(), deadlineMs),
  );
}

/** What a running session's telemetry reading waits for and asks for. */
export type TelemetryOptions = {
  deadlineMs?: number;
  /** False for a caller with nowhere to report a context reading: the request is then never sent. */
  readContext?: boolean;
};

/**
 * A running session's models and context, never its plan usage. The CLI answers control requests
 * one at a time, and plan usage can scan the account's recent transcripts for seconds: every
 * request behind it, the agent's own included, would wait past this deadline. `readClaudeUsage`
 * reads plan usage from a session opened only to ask.
 */
export async function readClaudeTelemetry(
  stream: unknown,
  { deadlineMs = TELEMETRY_DEADLINE_MS, readContext = true }: TelemetryOptions = {},
): Promise<{ models?: ClaudeModelInfo[]; context?: ContextReading }> {
  const query = stream as TelemetryQuery;
  const [models, summary] = await Promise.all([
    bounded(() => query.supportedModels?.(), deadlineMs),
    readContext ? bounded(() => query.getContextUsage?.({ detail: "summary" }), deadlineMs) : undefined,
  ]);
  const context = contextReading(summary);
  return { ...(context ? { context } : {}), ...(Array.isArray(models) ? { models } : {}) };
}

/** Claude's context summary as a reading, or undefined when its numbers cannot be a measurement. */
function contextReading(summary: ClaudeContextSummary | undefined): ContextReading | undefined {
  if (!summary || typeof summary.model !== "string") return undefined;
  const { totalTokens, maxTokens } = summary;
  const measured = Number.isFinite(totalTokens) && totalTokens >= 0 && Number.isFinite(maxTokens) && maxTokens > 0;
  if (!measured) return undefined;
  return {
    promptTokens: totalTokens,
    contextWindow: maxTokens,
    percent: Math.min(100, Math.max(0, (totalTokens / maxTokens) * 100)),
    model: summary.model,
  };
}

const claudeModels = z
  .array(
    z.object({
      value: z.string().min(1),
      displayName: z.string(),
      resolvedModel: z.string().optional(),
      description: z.string().optional(),
      supportedEffortLevels: z.array(z.string()).optional(),
      supportsFastMode: z.boolean().optional(),
    }),
  )
  .max(2000);
/** Validate initialization metadata before it can replace a good catalog. */
export function validateClaudeModels(value: unknown): ClaudeModelInfo[] {
  const result = claudeModels.safeParse(value);
  if (!result.success)
    throw new CatalogError(ModelCatalogProblemCode.Malformed, t("Claude returned an invalid model list."));
  return result.data;
}

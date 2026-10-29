import { z } from "zod";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { CatalogError, CATALOG_DEADLINE_MS } from "./model-catalog.ts";
import { ModelContextSource, type EngineModel } from "./types.ts";
import { codexControl } from "./codex-control.ts";
import { t } from "../../shared/i18n.ts";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const OUTPUT_POLICY_TOKENS = 64_000;
const Method = { Models: "model/list" } as const;
const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().optional(),
      isDefault: z.boolean().optional(),
      model: z.string().min(1),
      displayName: z.string(),
      hidden: z.boolean().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
      defaultReasoningEffort: z.string().nullish(),
      inputModalities: z.array(z.string()).optional(),
    }),
  ),
  nextCursor: z.string().nullish(),
});
const malformed = () =>
  new CatalogError(ModelCatalogProblemCode.Malformed, t("The CLI returned an invalid model list."));
/** Validate a complete provider page without guessing model versions. */
export function codexModelPage(value: unknown): { models: EngineModel[]; cursor: string | null } {
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success) throw malformed();
  return {
    cursor: parsed.data.nextCursor ?? null,
    models: parsed.data.data
      .filter((row) => !row.hidden)
      .map((row) => ({
        id: row.model,
        providerId: row.id,
        providerDefault: row.isDefault,
        label: row.displayName,
        contextWindow: 0,
        contextSource: ModelContextSource.Unknown,
        maxTokens: OUTPUT_POLICY_TOKENS,
        supportsTools: true,
        supportsVision: row.inputModalities === undefined || row.inputModalities.includes("image"),
        supportsThinking: row.supportedReasoningEfforts.length > 0,
        efforts: row.supportedReasoningEfforts.map((value) => value.reasoningEffort),
        defaultEffort: row.defaultReasoningEffort ?? undefined,
      })),
  };
}
/** A bounded control-only app-server conversation: no thread or turn is started. */
export async function readCodexModels(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = CATALOG_DEADLINE_MS,
): Promise<EngineModel[]> {
  const control = codexControl(binary, args, env, timeoutMs);
  const models = new Map<string, EngineModel>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  try {
    await control.initialize();
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const page = codexModelPage(
        await control.request(Method.Models, { includeHidden: false, limit: PAGE_SIZE, cursor }),
      );
      for (const model of page.models) if (!models.has(model.id)) models.set(model.id, model);
      cursor = page.cursor;
      if (cursor === null) return [...models.values()];
      if (cursors.has(cursor)) throw malformed();
      cursors.add(cursor);
    }
    throw malformed();
  } finally {
    await control.close();
  }
}

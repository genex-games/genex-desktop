/**
 * What the studio reads from the `pi` CLI outside a session: the models `pi --list-models`
 * prints, and the hosts those providers answer on (for the sandbox). The studio never reads Pi's
 * credentials; a listing is how it knows a sign-in can run.
 */
import { CatalogError } from "./model-catalog.ts";
import type { EngineModel } from "./types.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";

/** A model whose context the listing does not give is assumed to have this much. */
const DEFAULT_CONTEXT_TOKENS = 32_768;
/** A reply may use this many tokens when the listing gives no output limit. */
const DEFAULT_REPLY_TOKENS = 8_192;
/** Thinking levels Pi accepts when a model thinks. */
const THINKING_EFFORTS: readonly string[] = [
  ReasoningEffort.Minimal,
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
  ReasoningEffort.Xhigh,
  ReasoningEffort.Max,
];
/**
 * Where a built-in provider answers. A provider missing here reaches only hosts the listing named.
 */
const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  anthropic: ["api.anthropic.com"],
  google: ["generativelanguage.googleapis.com"],
  groq: ["api.groq.com"],
  xai: ["api.x.ai"],
  mistral: ["api.mistral.ai"],
  togetherai: ["api.together.xyz"],
  cerebras: ["api.cerebras.ai"],
  cursor: ["api2.cursor.sh", "www.cursor.com"],
  openrouter: ["openrouter.ai"],
};

const MESSAGE = {
  Malformed: "Pi's model list could not be read.",
} as const;

/** A model Pi can run, and the host its provider answers on (for the sandbox's network). */
export interface PiModel {
  row: EngineModel;
  hosts: string[];
}

const HEADER = /provider\s+model\s+context/i;
const ROW = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(yes|no)\s+(yes|no)\s*$/i;

/** Parse `200K`, `1M`, `16.4K` as a token count. */
export function parseTokenCount(value: string): number | undefined {
  const match = /^([\d.]+)([KMB])?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = (match[2] ?? "").toUpperCase();
  if (unit === "K") return Math.round(amount * 1_000);
  if (unit === "M") return Math.round(amount * 1_000_000);
  if (unit === "B") return Math.round(amount * 1_000_000_000);
  return Math.round(amount);
}

/** `pi --list-models`: a table of provider, model, context, max-out, thinking and images. */
export function parsePiModels(stdout: string): PiModel[] {
  const text = stdout.trim();
  if (!text) return [];
  if (/^error\b/i.test(text)) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed);
  const lines = stdout.split(/\r?\n/);
  const header = lines.findIndex((line) => HEADER.test(line));
  if (header < 0) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed);
  const models: PiModel[] = [];
  for (const line of lines.slice(header + 1)) {
    const row = ROW.exec(line.trim());
    if (!row) continue;
    const [, provider, model, context, maxOut, thinking, images] = row;
    if (!provider || !model) continue;
    const thinks = thinking.toLowerCase() === "yes";
    models.push({
      row: {
        id: `${provider}/${model}`,
        label: model,
        contextWindow: parseTokenCount(context) ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: parseTokenCount(maxOut) ?? DEFAULT_REPLY_TOKENS,
        supportsTools: true,
        supportsVision: images.toLowerCase() === "yes",
        supportsThinking: thinks,
        ...(thinks ? { efforts: [...THINKING_EFFORTS], defaultEffort: ReasoningEffort.Medium } : {}),
        note: provider,
      },
      hosts: [...(PROVIDER_HOSTS[provider] ?? [])],
    });
  }
  return models;
}

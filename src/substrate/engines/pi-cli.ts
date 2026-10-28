/**
 * What the studio reads from the `pi` CLI outside a session: the models `pi --list-models`
 * prints, and the hosts those providers answer on (for the sandbox). The studio never reads Pi's
 * credentials; a listing is how it knows a sign-in can run.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
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
 * Where a built-in provider answers: Pi's bundled catalog (`@earendil-works/pi-ai` 1.4.0,
 * `dist/providers/data/*.json` `baseUrl`, plus each provider's sign-in hosts). An unknown id reaches
 * only the https host in its `models.json` / `models-store.json` `baseUrl` — never every known host.
 */
const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  anthropic: ["api.anthropic.com"],
  google: ["generativelanguage.googleapis.com"],
  "google-vertex": ["*.googleapis.com"],
  "google-vertex-anthropic": ["*.googleapis.com"],
  "amazon-bedrock": ["*.amazonaws.com"],
  azure: ["*.openai.azure.com", "*.cognitiveservices.azure.com"],
  "azure-cognitive-services": ["*.cognitiveservices.azure.com"],
  // The token names its own API host: api.individual / api.business / api.enterprise.githubcopilot.com.
  "github-copilot": ["api.github.com", "*.githubcopilot.com"],
  // ChatGPT sign-in (Pi's legacy id for it).
  "openai-codex": ["chatgpt.com", "auth.openai.com"],
  cerebras: ["api.cerebras.ai"],
  cohere: ["api.cohere.com"],
  deepinfra: ["api.deepinfra.com"],
  groq: ["api.groq.com"],
  mistral: ["api.mistral.ai"],
  perplexity: ["api.perplexity.ai"],
  togetherai: ["api.together.xyz"],
  xai: ["api.x.ai"],
  vercel: ["ai-gateway.vercel.sh"],
  cursor: ["api2.cursor.sh", "www.cursor.com"],
  openrouter: ["openrouter.ai"],
  "ant-ling": ["api.ant-ling.com"],
  baseten: ["inference.baseten.co"],
  "cloudflare-ai-gateway": ["gateway.ai.cloudflare.com"],
  "cloudflare-workers-ai": ["api.cloudflare.com"],
  deepseek: ["api.deepseek.com"],
  fireworks: ["api.fireworks.ai"],
  huggingface: ["router.huggingface.co"],
  "kimi-coding": ["api.kimi.com"],
  meta: ["api.meta.ai"],
  minimax: ["api.minimax.io"],
  "minimax-cn": ["api.minimaxi.com"],
  moonshotai: ["api.moonshot.ai"],
  "moonshotai-cn": ["api.moonshot.cn"],
  nvidia: ["integrate.api.nvidia.com"],
  opencode: ["opencode.ai"],
  "opencode-go": ["opencode.ai"],
  "qwen-token-plan": ["token-plan.ap-southeast-1.maas.aliyuncs.com"],
  "qwen-token-plan-individual": ["token-plan.ap-southeast-1.maas.aliyuncs.com"],
  "qwen-token-plan-cn": ["token-plan.cn-beijing.maas.aliyuncs.com"],
  radius: ["radius.pi.dev"],
  together: ["api.together.ai"],
  typesafe: ["api.typesafe.ai"],
  "vercel-ai-gateway": ["ai-gateway.vercel.sh"],
  xiaomi: ["api.xiaomimimo.com"],
  "xiaomi-token-plan-ams": ["token-plan-ams.xiaomimimo.com"],
  "xiaomi-token-plan-cn": ["token-plan-cn.xiaomimimo.com"],
  "xiaomi-token-plan-sgp": ["token-plan-sgp.xiaomimimo.com"],
  zai: ["api.z.ai"],
  "zai-coding-cn": ["open.bigmodel.cn"],
};

/** List-models and `/login`: no extensions, no automatic catalog/package fetch. */
export const PI_DISCOVERY_ARGS = ["--no-extensions", "--offline"] as const;
/** `pi --list-models` as the studio runs it. */
export const PI_LIST_MODELS_ARGS = ["--list-models", ...PI_DISCOVERY_ARGS] as const;

function hostsFor(provider: string, extra: readonly string[] | undefined): string[] {
  const known = PROVIDER_HOSTS[provider];
  const listed = extra ?? [];
  if (known) return [...new Set([...known, ...listed])];
  if (listed.length) return [...listed];
  if (provider.includes(".")) return [provider];
  return [];
}

/** https hostnames from Pi's `models.json` or models store. Never follows `!command` keys. */
export function hostsFromPiModelsJson(text: string): Record<string, string[]> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  // `models.json` keeps its providers under `providers`; `models-store.json` is keyed by provider.
  const nested = (data as Record<string, unknown>).providers;
  const providers = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : data;
  const out: Record<string, string[]> = {};
  for (const [provider, entry] of Object.entries(providers)) {
    if (provider.startsWith("$")) continue;
    const hosts = new Set<string>();
    collectHttpsHosts(entry, hosts);
    if (hosts.size) out[provider] = [...hosts];
  }
  return out;
}

function collectHttpsHosts(value: unknown, hosts: Set<string>): void {
  if (typeof value === "string") {
    const host = httpsHost(value);
    if (host) hosts.add(host);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectHttpsHosts(item, hosts);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("!")) continue;
    collectHttpsHosts(item, hosts);
  }
}

function httpsHost(value: string): string | null {
  if (!value.startsWith("https://")) return null;
  try {
    const host = new URL(value).hostname;
    return host || null;
  } catch {
    return null;
  }
}

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
export function parsePiModels(stdout: string, extraHosts?: Record<string, readonly string[]>): PiModel[] {
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
      hosts: hostsFor(provider, extraHosts?.[provider]),
    });
  }
  return models;
}

const STORE_FILES = ["models-store.json", "models.json"] as const;

/** Hosts named in Pi's own model store. Never reads `auth.json`. */
export async function readPiProviderHosts(home: string): Promise<Record<string, string[]>> {
  const agent = path.join(home, ".pi", "agent");
  const merged: Record<string, string[]> = {};
  for (const file of STORE_FILES) {
    const text = await readFile(path.join(agent, file), "utf8").catch(() => "");
    if (!text) continue;
    for (const [provider, hosts] of Object.entries(hostsFromPiModelsJson(text))) {
      merged[provider] = [...new Set([...(merged[provider] ?? []), ...hosts])];
    }
  }
  return merged;
}

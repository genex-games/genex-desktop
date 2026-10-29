/**
 * The AI vendors a game may not call directly (owner decision D5): `genex-ai` is the only supported
 * way for a game to use a model. One table of each vendor's API hosts and key shapes serves three
 * places — desktop Play's game view refuses requests to the hosts (`ai_direct_blocked`), Publish's
 * export scan refuses the key shapes and warns about the hosts, and genex.games sends the same
 * hosts as a `connect-src` CSP on game origins — so all three name the same vendors.
 *
 * A host matches exactly, as a subdomain or with a regional prefix where its row says so; a near miss
 * (`openai.com.evil.io`, `notopenai.com`, `api.openai.co`) never matches. A key shape matches on a word boundary with its
 * vendor's own body length; prose that mentions a prefix does not. Browser-safe; pure.
 */

/** The vendors. Wire values: never rename one (the CSP list and the scan report name them). */
export const AiVendor = {
  OpenAi: "openai",
  Anthropic: "anthropic",
  Google: "google",
  OpenRouter: "openrouter",
  Mistral: "mistral",
  Groq: "groq",
  Together: "together",
  Fireworks: "fireworks",
  DeepSeek: "deepseek",
  Xai: "xai",
  Cohere: "cohere",
  Perplexity: "perplexity",
  Replicate: "replicate",
  Fal: "fal",
} as const;
export type AiVendor = (typeof AiVendor)[keyof typeof AiVendor];

/** How a row's host matches. Wire values: never rename one. */
export const AiHostMatch = {
  /** The host itself only. */
  Exact: "exact",
  /** The host and any subdomain of it. */
  Subdomains: "subdomains",
  /** The host and any one-label regional prefix joined by a dash (`us-central1-aiplatform…`). */
  Regional: "regional",
} as const;
export type AiHostMatch = (typeof AiHostMatch)[keyof typeof AiHostMatch];

/** One API host and how it matches. */
export interface AiVendorHost {
  vendor: AiVendor;
  host: string;
  match: AiHostMatch;
}

/** Every vendor API host a game is refused. A shared CDN of a vendor's (an image bucket) is not listed. */
export const AI_VENDOR_HOSTS: readonly AiVendorHost[] = [
  { vendor: AiVendor.OpenAi, host: "openai.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.OpenAi, host: "openai.azure.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Anthropic, host: "anthropic.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Anthropic, host: "claude.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Google, host: "generativelanguage.googleapis.com", match: AiHostMatch.Exact },
  { vendor: AiVendor.Google, host: "aiplatform.googleapis.com", match: AiHostMatch.Regional },
  { vendor: AiVendor.OpenRouter, host: "openrouter.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Mistral, host: "mistral.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Groq, host: "groq.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Together, host: "together.xyz", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Together, host: "together.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Fireworks, host: "fireworks.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.DeepSeek, host: "deepseek.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Xai, host: "x.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Cohere, host: "cohere.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Cohere, host: "cohere.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Perplexity, host: "perplexity.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Replicate, host: "replicate.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Fal, host: "fal.run", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Fal, host: "fal.ai", match: AiHostMatch.Subdomains },
];

/** A hostname as compared: lowercase, without a trailing root dot. */
function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/** The host of a URL or a bare hostname (with or without a port), or null when there is none. */
function hostOf(target: string): string | null {
  const text = target.trim();
  if (!text) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return url.hostname ? canonicalHost(url.hostname) : null;
  } catch {
    return null;
  }
}

/** One DNS label: what a regional prefix may be. */
const LABEL = /^[a-z0-9-]+$/;

/** Whether a host is a row's host, or one the row's match takes. */
function matchesRow(host: string, row: AiVendorHost): boolean {
  if (host === row.host) return true;
  if (row.match === AiHostMatch.Subdomains) return host.endsWith(`.${row.host}`);
  if (row.match !== AiHostMatch.Regional || !host.endsWith(`-${row.host}`)) return false;
  return LABEL.test(host.slice(0, -row.host.length - 1));
}

/** The vendor whose API a URL or hostname reaches, or null. Never throws. */
export function aiVendorOfHost(target: string): AiVendor | null {
  const host = hostOf(target);
  if (!host) return null;
  return AI_VENDOR_HOSTS.find((row) => matchesRow(host, row))?.vendor ?? null;
}

/** One vendor key shape. */
export interface AiKeyShape {
  vendor: AiVendor;
  /** A pattern with the `g` flag that matches a whole key and nothing shorter. */
  pattern: RegExp;
}

/**
 * Vendor key shapes the export scan refuses. Most specific first, so an Anthropic, OpenRouter or
 * project key is named as that vendor's, not as a generic `sk-` key.
 */
export const AI_KEY_SHAPES: readonly AiKeyShape[] = [
  { vendor: AiVendor.Anthropic, pattern: /(?<![\w-])sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}(?![\w-])/g },
  { vendor: AiVendor.OpenRouter, pattern: /(?<![\w-])sk-or-v1-[a-f0-9]{64}(?![\w-])/g },
  { vendor: AiVendor.OpenAi, pattern: /(?<![\w-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}(?![\w-])/g },
  { vendor: AiVendor.OpenAi, pattern: /(?<![\w-])sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}(?![\w-])/g },
  { vendor: AiVendor.Google, pattern: /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/g },
  { vendor: AiVendor.Groq, pattern: /(?<![\w-])gsk_[A-Za-z0-9]{52}(?![\w-])/g },
  { vendor: AiVendor.Xai, pattern: /(?<![\w-])xai-[A-Za-z0-9]{80}(?![\w-])/g },
  { vendor: AiVendor.Perplexity, pattern: /(?<![\w-])pplx-[A-Za-z0-9]{48}(?![\w-])/g },
  { vendor: AiVendor.Replicate, pattern: /(?<![\w-])r8_[A-Za-z0-9]{37}(?![\w-])/g },
  { vendor: AiVendor.Fireworks, pattern: /(?<![\w-])fw_[A-Za-z0-9]{24}(?![\w-])/g },
  { vendor: AiVendor.DeepSeek, pattern: /(?<![\w-])sk-[a-f0-9]{32}(?![\w-])/g },
];

/** A key the scan found: whose shape, and where. The key itself is never kept. */
export interface AiKeyHit {
  vendor: AiVendor;
  /** Offset of its first character in the scanned text. */
  index: number;
}

/** Every vendor key in `text`, in order, each reported once by the most specific shape that matches it. */
export function findAiKeys(text: string): AiKeyHit[] {
  const hits: Array<AiKeyHit & { end: number }> = [];
  for (const shape of AI_KEY_SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      const index = match.index;
      const end = index + match[0].length;
      if (hits.some((hit) => index < hit.end && end > hit.index)) continue;
      hits.push({ vendor: shape.vendor, index, end });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map(({ vendor, index }) => ({ vendor, index }));
}

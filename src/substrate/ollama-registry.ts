/**
 * "Add from Ollama": ask the public Ollama registry how big one exact tag is before pulling it.
 * ollama.com has no search API, but every tag's manifest lists its layer sizes, so the studio can
 * check the fit rule first instead of discovering a 70 GB model does not fit after the download.
 */

import { SECOND_MS } from "../shared/duration.ts";
import { t } from "../shared/i18n.ts";

export const OLLAMA_REGISTRY = "https://registry.ollama.ai";

/** Why a lookup found no size. Sent to the renderer: never rename a value. */
export const OllamaLookupFailure = {
  Invalid: "invalid",
  NotFound: "not_found",
  Unavailable: "unavailable",
} as const;
export type OllamaLookupFailure = (typeof OllamaLookupFailure)[keyof typeof OllamaLookupFailure];

/** The longest reference the parser reads; anything longer is refused. */
const MAX_REFERENCE_CHARS = 200;
/** How long the registry has to answer a manifest request. */
const LOOKUP_TIMEOUT_MS = 8 * SECOND_MS;
/** Bytes per tenth of a decimal GB: sizes are shown to one decimal, like ollama.com. */
const BYTES_PER_TENTH_GB = 1e8;
/** The namespace a bare `name` belongs to, which `ollama pull` leaves out of the id. */
const DEFAULT_NAMESPACE = "library";
const DEFAULT_TAG = "latest";
const HTTP_NOT_FOUND = 404;
const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";

/** Why a lookup failed, as the Local models page shows it; functions, as main sets its language after this loads. */
const MESSAGE = {
  Answered: (status: number) => t("The Ollama library answered {status}.", { status }),
  UnreadableManifest: () => t("The Ollama library returned an unreadable manifest."),
  TimedOut: () => t("The Ollama library did not answer in time."),
  Unreachable: () => t("Could not reach the Ollama library."),
} as const;

export interface OllamaReference {
  namespace: string;
  name: string;
  tag: string;
  /** What `ollama pull` should receive and what the installed model is called. */
  id: string;
}

export type OllamaLookup =
  | { ok: true; id: string; sizeGb: number }
  | { ok: false; reason: OllamaLookupFailure; id?: string; error?: string };

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * `name`, `name:tag`, `namespace/name` or `namespace/name:tag`, as `ollama pull` accepts them.
 * Anything else — a URL, a host, spaces, a path — is refused before a request is built.
 */
export function parseOllamaReference(input: string): OllamaReference | null {
  const text = input.trim();
  if (!text || text.length > MAX_REFERENCE_CHARS) return null;
  const colon = text.lastIndexOf(":");
  const path = (colon >= 0 ? text.slice(0, colon) : text).toLowerCase();
  const tag = colon >= 0 ? text.slice(colon + 1) : DEFAULT_TAG;
  const parts = path.split("/");
  const wellFormed = parts.length <= 2 && TAG.test(tag) && parts.every((part) => SEGMENT.test(part));
  if (!wellFormed) return null;
  const [first = "", second] = parts;
  const [namespace, name] = second === undefined ? [DEFAULT_NAMESPACE, first] : [first, second];
  const prefix = namespace === DEFAULT_NAMESPACE ? "" : `${namespace}/`;
  return { namespace, name, tag, id: `${prefix}${name}:${tag}` };
}

export function manifestUrl(reference: OllamaReference): string {
  return `${OLLAMA_REGISTRY}/v2/${reference.namespace}/${reference.name}/manifests/${reference.tag}`;
}

/** Download size of a manifest: every layer plus the config blob, in decimal GB like ollama.com. */
export function manifestSizeGb(manifest: unknown): number | null {
  if (!manifest || typeof manifest !== "object") return null;
  const { layers, config } = manifest as { layers?: unknown; config?: { size?: unknown } };
  if (!Array.isArray(layers) || layers.length === 0) return null;
  let bytes = typeof config?.size === "number" ? config.size : 0;
  for (const layer of layers) {
    const size = (layer as { size?: unknown } | null)?.size;
    const validSize = typeof size === "number" && Number.isFinite(size) && size >= 0;
    if (!validSize) return null;
    bytes += size;
  }
  return Math.round(bytes / BYTES_PER_TENTH_GB) / 10;
}

export async function lookupOllamaModel(
  input: string,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OllamaLookup> {
  const reference = parseOllamaReference(input);
  if (!reference) return { ok: false, reason: OllamaLookupFailure.Invalid };
  const { id } = reference;
  const unavailable = (error: string): OllamaLookup => ({
    ok: false,
    reason: OllamaLookupFailure.Unavailable,
    id,
    error,
  });
  try {
    const response = await (deps.fetch ?? fetch)(manifestUrl(reference), {
      headers: { Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(deps.timeoutMs ?? LOOKUP_TIMEOUT_MS),
    });
    if (response.status === HTTP_NOT_FOUND) return { ok: false, reason: OllamaLookupFailure.NotFound, id };
    if (!response.ok) return unavailable(MESSAGE.Answered(response.status));
    const sizeGb = manifestSizeGb(await response.json());
    if (sizeGb === null) return unavailable(MESSAGE.UnreadableManifest());
    return { ok: true, id, sizeGb };
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return unavailable(timedOut ? MESSAGE.TimedOut() : MESSAGE.Unreachable());
  }
}

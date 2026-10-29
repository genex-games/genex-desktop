/**
 * The CC0 library's network: JSON from the sources' APIs and bytes from their download servers and
 * the curated packs' hosts, each on an allowlisted https host, every request naming Genex in its
 * User-Agent (Poly Haven's API terms ask every client to). The plugin's `network.hosts` declares
 * exactly these hosts.
 */
import { Cc0Error, Cc0Refusal } from "../../substrate/cc0-fetch.ts";

/** The plugin's version, as its `plugin.json` names it (a test holds the two equal). */
export const CC0_PLUGIN_VERSION = "1.2.0";
/** What every request names itself as. */
export const CC0_USER_AGENT = `Genex-CC0/${CC0_PLUGIN_VERSION} (+https://github.com/genex-games/genex-desktop)`;

/** The hosts whose JSON APIs list and describe assets. */
export const API_HOSTS: ReadonlySet<string> = new Set(["api.polyhaven.com", "ambientcg.com"]);
/** The hosts an API answer (or a curated row) may name as a download. */
export const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(["dl.polyhaven.org", "ambientcg.com"]);
/**
 * Hosts only a curated pack's pinned row may name, never an API answer: OpenGameArt's file store,
 * where Quaternius publishes the Universal Animation Library as CC0 (owner call AN-21). It also
 * hosts other licences, so only a hand-reviewed, sha256-pinned row reaches it.
 */
export const CURATED_HOSTS: ReadonlySet<string> = new Set(["opengameart.org"]);
/** Every host a download may start on, so every host a curated row may name. */
export const FETCH_HOSTS: ReadonlySet<string> = new Set([...DOWNLOAD_HOSTS, ...CURATED_HOSTS]);
/** Hosts reached only as the one redirect a download host answers (ambientCG's `get` names its file server). */
export const REDIRECT_HOSTS: ReadonlySet<string> = new Set(["acg-download.struffelproductions.com"]);

/** The most bytes one API answer may hold (Poly Haven's whole model list is about 1 MiB). */
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** What the plugin reaches the network through; tests pass a stub. */
export interface Cc0Net {
  json(url: URL): Promise<unknown>;
  download(url: URL, maxBytes: number): Promise<Uint8Array>;
}

/** `url` when it is plain https on one of `hosts` (no credentials, no port), else a `host-not-allowed` refusal. */
export function checkedHost(url: string | URL, hosts: ReadonlySet<string>): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Cc0Error(Cc0Refusal.ManifestInvalid, `not a URL: ${String(url)}`);
  }
  const plain = parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.port === "";
  if (!plain || !hosts.has(parsed.hostname)) throw new Cc0Error(Cc0Refusal.HostNotAllowed, parsed.href);
  return parsed;
}

function failed(url: URL, detail: string): Cc0Error {
  return new Cc0Error(Cc0Refusal.DownloadFailed, `${url.href}: ${detail}`);
}

/** `response`'s body, refusing one longer than `maxBytes` (declared or streamed) before reading past it. */
async function cappedBody(response: Response, url: URL, maxBytes: number): Promise<Uint8Array> {
  const tooLong = (bytes: number) =>
    new Cc0Error(Cc0Refusal.SizeMismatch, `${url.href}: ${bytes} bytes, at most ${maxBytes}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw tooLong(declared);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > maxBytes) throw tooLong(total);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/** The network the plugin uses, over `fetch` (a test passes its own). */
export function createCc0Net(options: { fetch?: typeof fetch } = {}): Cc0Net {
  const get = options.fetch ?? fetch;
  const request = async (url: URL): Promise<Response> => {
    try {
      return await get(url, { redirect: "manual", headers: { "user-agent": CC0_USER_AGENT } });
    } catch (error) {
      throw failed(url, error instanceof Error ? error.message : String(error));
    }
  };
  /** A download or curated host's answer, after at most one redirect to a redirect host. */
  const answer = async (url: URL): Promise<{ response: Response; at: URL }> => {
    const first = await request(checkedHost(url, FETCH_HOSTS));
    if (!REDIRECT_STATUSES.has(first.status)) return { response: first, at: url };
    await first.body?.cancel();
    const target = checkedHost(new URL(first.headers.get("location") ?? "", url), REDIRECT_HOSTS);
    const second = await request(target);
    if (REDIRECT_STATUSES.has(second.status)) {
      await second.body?.cancel();
      throw failed(target, "a second redirect");
    }
    return { response: second, at: target };
  };
  return {
    async json(url) {
      const response = await request(checkedHost(url, API_HOSTS));
      if (!response.ok) {
        await response.body?.cancel();
        throw failed(url, `HTTP ${response.status}`);
      }
      const text = new TextDecoder().decode(await cappedBody(response, url, MAX_JSON_BYTES));
      try {
        return JSON.parse(text);
      } catch {
        throw failed(url, "not JSON");
      }
    },
    async download(url, maxBytes) {
      const { response, at } = await answer(url);
      if (!response.ok) {
        await response.body?.cancel();
        throw failed(at, `HTTP ${response.status}`);
      }
      return cappedBody(response, at, maxBytes);
    },
  };
}

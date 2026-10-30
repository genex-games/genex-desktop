/**
 * The Genex Library's network: a published pack file's bytes, from an allowlisted https host only
 * (a GitHub release answers with redirects to its file servers, each held to the same list), the
 * body capped at the size the catalog pins before it is read past it. The plugin's
 * `network.hosts` declares exactly these hosts.
 */
import { LibraryError, LibraryRefusal } from "../../shared/genex-library.ts";
import { LIBRARY_HOSTS, type LibraryNet } from "./install.ts";

/** The plugin's version, as its `plugin.json` names it. */
export const LIBRARY_PLUGIN_VERSION = "1.0.0";
const USER_AGENT = `Genex-Library/${LIBRARY_PLUGIN_VERSION} (+https://github.com/genex-games/genex-desktop)`;
/** Redirects one download may follow (GitHub: release page → file server). */
const REDIRECTS_MAX = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const MESSAGE = {
  Failed: (url: URL, detail: string) => `${url.href}: ${detail}`,
  Host: (url: URL) => `${url.href}: not https on a library host`,
  TooLong: (url: URL, bytes: number, cap: number) => `${url.href}: ${bytes} bytes, at most ${cap}`,
} as const;

function allowed(url: URL): URL {
  const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
  if (!plain || !LIBRARY_HOSTS.has(url.hostname))
    throw new LibraryError(LibraryRefusal.DownloadFailed, MESSAGE.Host(url));
  return url;
}

async function cappedBody(response: Response, url: URL, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new LibraryError(LibraryRefusal.SizeMismatch, MESSAGE.TooLong(url, declared, maxBytes));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new LibraryError(LibraryRefusal.SizeMismatch, MESSAGE.TooLong(url, total, maxBytes));
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/** The network the plugin uses, over `fetch` (a test passes its own). */
export function createLibraryNet(options: { fetch?: typeof fetch } = {}): LibraryNet {
  const get = options.fetch ?? fetch;
  const request = async (url: URL): Promise<Response> => {
    try {
      return await get(allowed(url), { redirect: "manual", headers: { "user-agent": USER_AGENT } });
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      throw new LibraryError(
        LibraryRefusal.DownloadFailed,
        MESSAGE.Failed(url, error instanceof Error ? error.message : String(error)),
      );
    }
  };
  return {
    async download(url, maxBytes) {
      let at = url;
      let response = await request(at);
      for (let hop = 0; REDIRECT_STATUSES.has(response.status); hop++) {
        await response.body?.cancel();
        if (hop >= REDIRECTS_MAX)
          throw new LibraryError(LibraryRefusal.DownloadFailed, MESSAGE.Failed(at, "too many redirects"));
        const location = response.headers.get("location");
        // Resolving "" against `at` would ask the same URL again until the hop limit.
        if (!location)
          throw new LibraryError(LibraryRefusal.DownloadFailed, MESSAGE.Failed(at, "a redirect with no Location"));
        at = new URL(location, at);
        response = await request(at);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new LibraryError(LibraryRefusal.DownloadFailed, MESSAGE.Failed(at, `HTTP ${response.status}`));
      }
      return cappedBody(response, at, maxBytes);
    },
  };
}

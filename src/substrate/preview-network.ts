/**
 * The well-known public CDNs that serve libraries and fonts, read only (GET/HEAD over https on the
 * default port), exact host names. The Live preview's network is open like a normal web page's
 * (main/page-serve.ts `gameRequestAllowed`); this list is the eval prober's pinned network policy
 * (scripts/evals/prober/network-policy.ts), whose digest names the grading runs it took part in.
 */
export const PREVIEW_CDN_HOSTS: ReadonlySet<string> = new Set([
  "cdn.jsdelivr.net",
  "unpkg.com",
  "esm.sh",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

const READS = new Set(["GET", "HEAD"]);

export function isPreviewCdnHost(host: string): boolean {
  return PREVIEW_CDN_HOSTS.has(host.toLowerCase());
}

/** A request the preview may send to a public CDN: an https read of an allowlisted host, default port. */
export function isPreviewCdnRead(url: URL, method = "GET"): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    isPreviewCdnHost(url.hostname) &&
    READS.has(method.toUpperCase())
  );
}

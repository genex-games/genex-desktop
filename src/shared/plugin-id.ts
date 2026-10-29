/**
 * A plugin's id: lowercase, starting with a letter, letters, digits and dashes, at most 48
 * characters. The manifest, the marketplace, the installer and the asset namespaces a plugin
 * writes under all take the same rule from here.
 */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,47}$/;

export function isPluginId(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_ID.test(value);
}

/** A GitHub `owner/repo`'s owner, lowercased the way plugin ids are. */
const repoOwner = (repo: string): string => (repo.split("/")[0] ?? "").toLowerCase();

/**
 * Whether a community plugin's id is its publisher's own: the GitHub owner of its source
 * repository, alone or before a dash (`arklanq` or `arklanq-elevenlabs` from `arklanq/…`). A
 * vendor's bare name then belongs to the vendor, or to an official reservation. The catalog's
 * validator (`marketplace/template/scripts/check-catalog.mjs`) applies the same rule.
 */
export function isPublisherOwnedId(id: string, repo: string): boolean {
  const owner = repoOwner(repo);
  return id === owner || id.startsWith(`${owner}-`);
}

/** The id prefix a community plugin from this repository takes: its owner, lowercased, and a dash. */
export function publisherIdPrefix(repo: string): string {
  return `${repoOwner(repo)}-`;
}

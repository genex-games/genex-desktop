/**
 * A card's thumbnail across sessions (`panels/AssetThumbnail.tsx`): the picture Studio kept earlier
 * is shown as it is, and one made now is handed over to be kept. The store is a convenience: a read
 * or a write that fails never costs the card its picture.
 */

/** What stands between a data URL's type and its base64 bytes. */
const BASE64_MARK = ";base64,";

/** A kept picture as the store answers it. */
export interface KeptPicture {
  mimeType: string;
  data: string;
}

/** The base64 bytes a data URL holds, or null when it holds none. */
export function pictureOfDataUrl(url: string): string | null {
  const at = url.startsWith("data:") ? url.indexOf(BASE64_MARK) : -1;
  if (at < 0) return null;
  return url.slice(at + BASE64_MARK.length) || null;
}

/** A kept picture as the data URL a card draws. */
export const dataUrlOf = (picture: KeptPicture): string => `data:${picture.mimeType}${BASE64_MARK}${picture.data}`;

/**
 * The card's picture as a data URL: the kept one when `read` has it, else `make`'s, handed to
 * `keep` without waiting for it. Rejects only as `make` does.
 */
export async function keptOrMade(store: {
  read: () => Promise<KeptPicture | null>;
  make: () => Promise<string>;
  keep: (data: string) => Promise<unknown>;
}): Promise<string> {
  // A store call that throws before it returns a promise is a failure like any other.
  const kept = await Promise.resolve()
    .then(store.read)
    .catch(() => null);
  if (kept) return dataUrlOf(kept);
  const made = await store.make();
  const data = pictureOfDataUrl(made);
  if (data)
    void Promise.resolve()
      .then(() => store.keep(data))
      .catch(() => {});
  return made;
}

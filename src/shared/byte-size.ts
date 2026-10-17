/** A file's or a folder's size as people read it, the same in the host's words and the app's. */

/** The units a size is said in, largest first. */
const SIZE_UNITS = [
  ["GB", 1024 ** 3],
  ["MB", 1024 ** 2],
  ["KB", 1024],
] as const;

/** A size in the largest unit it reaches, to one decimal (`6.1 GB`, `2 GB`, `80 KB`, `12 bytes`). */
export function sizeWords(bytes: number): string {
  const unit = SIZE_UNITS.find(([, size]) => bytes >= size);
  if (!unit) return `${bytes} bytes`;
  return `${Number((bytes / unit[1]).toFixed(1))} ${unit[0]}`;
}

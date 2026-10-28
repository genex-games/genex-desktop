/** A file's or a folder's size as people read it, the same in the host's words and the app's. */
import { intlLocale, t } from "./i18n.ts";

/** The units a size is said in, largest first: the English symbol a model reads, and a person's words. */
const SIZE_UNITS = [
  { symbol: "GB", bytes: 1024 ** 3, words: (size: string) => t("{size} GB", { size }) },
  { symbol: "MB", bytes: 1024 ** 2, words: (size: string) => t("{size} MB", { size }) },
  { symbol: "KB", bytes: 1024, words: (size: string) => t("{size} KB", { size }) },
] as const;

/** A size in the largest unit it reaches, to one decimal (`6.1 GB`, `2 GB`, `80 KB`, `12 bytes`), in the app's language. */
export function sizeWords(bytes: number): string {
  const unit = SIZE_UNITS.find((each) => bytes >= each.bytes);
  if (!unit) return t("{count, plural, other {# bytes}}", { count: bytes });
  return unit.words(oneDecimal(bytes / unit.bytes));
}

/** {@link sizeWords} always in English, for text a model reads. */
export function sizeWordsInEnglish(bytes: number): string {
  const unit = SIZE_UNITS.find((each) => bytes >= each.bytes);
  if (!unit) return `${bytes} bytes`;
  return `${Number((bytes / unit.bytes).toFixed(1))} ${unit.symbol}`;
}

/** A number to at most one decimal, written as the app's language writes it (`6.1`, `6,1`). */
function oneDecimal(value: number): string {
  const locale = intlLocale();
  if (!locale) return String(Number(value.toFixed(1)));
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

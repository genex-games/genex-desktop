/**
 * POSIX shell quoting, on its own so modules that `spawn.ts` itself imports (and the packaging
 * config, which loads no app code) can quote without an import cycle. `spawn.ts` re-exports it.
 */

/** Single-quote a value for POSIX shells. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

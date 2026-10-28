import path from "node:path";

/** A recorded file time above this is not a real measurement. */
const MAX_FILE_DURATION_MS = 6 * 60 * 60 * 1000;

/**
 * Reads per-file test times as the durations reporter writes them, refusing anything else.
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
export function parseDurations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid test durations");
  /** @type {Record<string, number>} */
  const durations = {};
  for (const [file, ms] of Object.entries(value)) {
    const validName = /^tests\/.+\.test\.ts$/.test(file) && path.posix.normalize(file) === file;
    const validTime = Number.isFinite(ms) && ms >= 0 && ms <= MAX_FILE_DURATION_MS;
    if (!validName || !validTime) throw new Error(`Invalid test duration: ${file}`);
    durations[file] = ms;
  }
  return durations;
}

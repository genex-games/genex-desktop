/**
 * The mark of a test file that starts real games on this machine's GPU (a Rust · wgpu game's
 * ready, step and capture on Metal). The runners (`scripts/affected-tests.mjs --run`,
 * `scripts/test.mjs --group fast`) run every file whose imports reach this module one at a time,
 * after the parallel files: such files share the GPU, the Metal compiler service and the cargo
 * target's game binaries, and each start is held to the real ready deadline, which a dozen of
 * them compiling their first frames side by side would starve.
 */

/** `GENEX_REQUIRE_METAL=1`: a GPU (or toolchain) the row needs being absent fails the row instead of skipping it. */
export function metalRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENEX_REQUIRE_METAL === "1";
}

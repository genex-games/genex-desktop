// The `rust-game` fixture's stand-in for a dev-flavour Rust · wgpu game (the facade's `studio`
// feature): the program the stub cargo (`src/main/dev/fixture-rust.ts`) admits for a native build
// whose manifest asks for the studio. It speaks contract v2 on fd 3 (NDJSON both ways) the way
// `genex-studio` does, every host verb but Live's ring, and passes the game conformance suite:
// the conforming fd-3 double of `rust-nonconforming/studio-double.mjs`, started with no defect.
// It draws a checkerboard: no GPU, no compiler, nothing fetched.
import { serveStudioGame } from "./rust-nonconforming/studio-double.mjs";

serveStudioGame();

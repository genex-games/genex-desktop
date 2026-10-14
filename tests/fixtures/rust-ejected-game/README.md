# rust-ejected-game

A Rust · wgpu game, the template's `src/` with its title filled in, as it stands just before the
person ejects its engine (extension ladder level 5). `tests/conformance/rust-eject.test.ts` copies
it and ejects the copy through the real eject (`src/main/rust-eject.ts`): from a small vendored set
it writes for the hostile rows, and, on an Apple silicon Mac with the release's vendored crates,
from the real set, then builds the fork offline with the real lane and runs the game conformance
suite on the build. The folder itself holds no `engine/` and no `[engine]` row: only an eject
writes them.

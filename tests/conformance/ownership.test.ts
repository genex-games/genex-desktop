/**
 * File ownership per template (M3.14). The rule exists twice on purpose: the edit-time hook and the
 * Codex locks read `substrate/ownership.ts`, the seed's reviewer reads `loop/review.ts` with the
 * compiled stacks' owner lists from `loop/native-review.ts`. Every row below runs through both, so a
 * file one copy lets a facet write is never one the other reverts.
 *
 * A Rust · wgpu template: the entry owner holds `src/main.rs`, `genex.toml` and the read-only
 * `docs/GENEX_API.md`; every other facet owns `src/facets/<slug>.rs` and adds its two FACET WIRING
 * lines to `src/main.rs`. The C++ and three.js rows are characterization: they read as they did
 * before the Rust row existed.
 */
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { type ReviewSpec, allowedFile as reviewAllowedFile } from "../../src/harness-seed/loop/review.ts";
import { RUST_OWNER_FILES as SEED_RUST_OWNER_FILES } from "../../src/harness-seed/loop/native-review.ts";
import {
  allowedFile as hookAllowedFile,
  type Ownership,
  ownershipReason,
  RUST_OWNER_FILES,
} from "../../src/substrate/ownership.ts";
import { lockUnowned, releaseLocks } from "../../src/substrate/engines/ownership-locks.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" ? "not run: write bits are POSIX modes" : false;

/** A facet's spec, as both copies of the rule read it. */
type OwnershipSpec = ReviewSpec;

/** One row: a file, the facet's spec, whether it owns the entry, and what both copies must answer. */
type Row = readonly [file: string, spec: OwnershipSpec, ownsMain: boolean, allowed: boolean, why: string];

/** Both copies answer `allowed` for this row. */
function agree([file, spec, ownsMain, allowed, why]: Row): void {
  assert.equal(hookAllowedFile(file, spec, ownsMain), allowed, `hook: ${file} — ${why}`);
  assert.equal(reviewAllowedFile(file, spec, ownsMain), allowed, `review: ${file} — ${why}`);
}

/** A Rust facet as a director worker on the template carries it: its own module, no entry named. */
const fish: OwnershipSpec = { id: "fish", owns: ["src/facets/fish.rs"] };
/** The worker that owns the Rust entry. */
const world: OwnershipSpec = { id: "world", owns: ["src/game.rs"] };
/** A Rust facet with no seam. */
const loose: OwnershipSpec = { id: "loose" };

describe("a Rust · wgpu template's ownership", () => {
  it("refuses genex.toml and the API page to a facet: they are the entry owner's", () => {
    const rows: Row[] = [
      ["genex.toml", fish, false, false, "the game's build input is the entry owner's"],
      ["docs/GENEX_API.md", fish, false, false, "the read-only API page is the entry owner's"],
      ["genex.toml", loose, false, false, "a facet with no seam does not get it either"],
      ["docs/GENEX_API.md", loose, false, false, "nor the API page"],
      ["genex.toml", world, true, true, "the entry owner's own"],
      ["docs/GENEX_API.md", world, true, true, "the entry owner's own"],
      ["src/main.rs", world, true, true, "the entry owner's own"],
    ];
    for (const row of rows) agree(row);
  });

  it("lets every facet add its FACET WIRING lines to src/main.rs and keep to src/facets/<slug>.rs", () => {
    const rows: Row[] = [
      ["src/main.rs", fish, false, true, "the wiring block is every facet's (reviewed by content)"],
      ["src/main.rs", loose, false, true, "a facet with no seam wires in the same block"],
      ["src/facets/fish.rs", fish, false, true, "its own module"],
      ["src/facets/shop.rs", fish, false, false, "another facet's module"],
      ["src/game.rs", fish, false, false, "the entry owner's world"],
      ["src/facets/loose.rs", loose, false, true, "a facet with no seam writes under src/"],
      ["docs/notes/NOTES.fish.md", fish, false, true, "its notes"],
      ["src/main.rs", { ...fish, main: "src/main.rs" }, false, true, "an entry named by the shape is the same"],
    ];
    for (const row of rows) agree(row);
  });

  it("gives a facet in the user's own Rust game no wiring pass-through on the entry", () => {
    const own: OwnershipSpec = { id: "fish", owns: ["src/fishing/**"], main: "src/main.rs", template: false };
    agree(["src/main.rs", own, false, false, "no FACET WIRING block in the user's own entry"]);
    agree(["src/fishing/rod.rs", own, false, true, "its seam"]);
  });

  it("names the entry owner when it refuses one of its files", () => {
    const ownership: Ownership = { facetId: "fish", owns: ["src/facets/fish.rs"], ownsMain: false };
    for (const file of ["genex.toml", "docs/GENEX_API.md"]) {
      const reason = ownershipReason(file, ownership);
      assert.match(reason, new RegExp(`${file.replace(".", "\\.")} belongs to the facet that owns the entry`), reason);
    }
    assert.match(ownershipReason("src/facets/shop.rs", ownership), /src\/main\.rs in a Rust game/);
  });

  it("holds the host's owner list equal to the seed reviewer's", () => {
    assert.deepEqual([...RUST_OWNER_FILES].sort(), [...SEED_RUST_OWNER_FILES].sort());
    // Every file on either list is the entry owner's in both copies, and only the entry itself is
    // open to a facet that does not own it (for its wiring lines).
    for (const file of new Set([...RUST_OWNER_FILES, ...SEED_RUST_OWNER_FILES])) {
      agree([file, world, true, true, "the entry owner's"]);
      agree([file, fish, false, file === "src/main.rs", "a facet's only for the wiring block"]);
    }
  });

  it("leaves a Codex facet its module and the wiring block writable, and locks the entry owner's files", {
    skip: POSIX_ONLY,
  }, async () => {
    const game = await tmpDir("studio-rust-ownership-");
    const recovery = await tmpDir("studio-rust-ownership-recovery-");
    const files = ["src/main.rs", "src/game.rs", "src/facets/fish.rs", "src/facets/shop.rs", ...RUST_OWNER_FILES];
    for (const file of files) {
      await mkdir(path.dirname(path.join(game, file)), { recursive: true });
      await writeFile(path.join(game, file), "// a file\n", { mode: 0o644 });
    }
    const ownership: Ownership = { facetId: "fish", owns: ["src/facets/fish.rs"], ownsMain: false };
    const record = await lockUnowned(game, ownership, recovery);
    try {
      const writable = async (file: string): Promise<boolean> =>
        ((await stat(path.join(game, file))).mode & 0o200) !== 0;
      for (const file of ["src/main.rs", "src/facets/fish.rs"]) assert.equal(await writable(file), true, file);
      for (const file of ["genex.toml", "docs/GENEX_API.md", "src/game.rs", "src/facets/shop.rs"])
        assert.equal(await writable(file), false, file);
    } finally {
      await releaseLocks(game, record, recovery);
    }
  });
});

describe("the C++ and three.js rows (characterization)", () => {
  it("reads a raylib template as it always has", () => {
    const dash: OwnershipSpec = { id: "dash", owns: ["src/dash.cpp"] };
    const rows: Row[] = [
      ["src/main.cpp", dash, false, true, "the C++ wiring block is every facet's"],
      ["src/main.cpp", { ...dash, main: "src/main.cpp" }, false, true, "named or not"],
      ["CMakeLists.txt", dash, false, false, "the build file is the entry owner's"],
      ["src/studio.cpp", dash, false, false, "the runtime is the entry owner's"],
      ["CMakeLists.txt", dash, true, true, "the entry owner's own"],
      ["src/studio.h", dash, true, true, "the entry owner's own"],
      ["src/dash.cpp", dash, false, true, "its own source"],
      ["src/jump.cpp", dash, false, false, "another facet's"],
      ["src/jump.cpp", { id: "loose" }, false, true, "no seam: src/"],
      ["CMakeLists.txt", { id: "loose" }, false, false, "no seam still leaves the build file alone"],
    ];
    for (const row of rows) agree(row);
  });

  it("reads a three.js template and a user's own game as they always have", () => {
    const plaza: OwnershipSpec = { id: "plaza", owns: ["src/plaza.js"] };
    const rows: Row[] = [
      ["src/main.js", plaza, false, true, "the wiring block"],
      ["src/studio.js", plaza, false, false, "the contract is the entry owner's"],
      ["index.html", plaza, false, false, "the page is the entry owner's"],
      ["tsconfig.json", plaza, true, true, "the compiler config is the entry owner's"],
      ["src/plaza.js", plaza, false, true, "its own module"],
      ["src/plaza/sky.js", plaza, false, true, "under its own module's name"],
      ["src/hud.js", plaza, false, false, "the contract's HUD"],
      ["src/main.ts", { ...plaza, main: "src/main.ts", template: false }, false, false, "no wiring block"],
      ["app/hud.tsx", { id: "hud", template: false }, false, true, "a user's game: everything but the entry"],
    ];
    for (const row of rows) agree(row);
  });
});

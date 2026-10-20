# Toolchain scripts

Developer and CI scripts for the C++ · raylib and Rust · wgpu lanes. The C++ scripts read the
pinned toolchains under `$GENEX_DEV_TOOLCHAINS` (default `.studio-dev/toolchains`); the Rust ones
read the spike toolchain `scripts/spike/rust-wgpu/setup-toolchain.sh` installs under
`.studio-dev/spike-toolchain`. Only `crate-policy.ts refresh` downloads anything. Run the `.ts`
scripts with Node 24.

- `dev-store.ts` builds this worktree's lock in `$GENEX_DEV_TOOLCHAINS/dev-store/`, the store every
  real-build test row uses, through the product's own install and prewarm code
  (`src/substrate/toolchain-store/`): CMake, Ninja, emsdk, raylib's tag archive and zig from
  `downloads/` (digests checked against `SHA256SUMS` and the manifest); ANGLE for the Mac, Windows
  and Linux and the Linux headers' sysroot from their folders through the dev-only local-artifact
  seam (checked file by file against each pinned `manifest.json`, then copied); then the web, Mac,
  Windows and Linux prewarm under the real sandbox with the network off (the Mac needs the
  Command Line Tools). Worktrees share the store's components and keep their lock folders side by
  side: the lock goes to `--lock-file`, else `GENEX_DEV_STORE_LOCK`, else the worktree's
  `.studio-dev/dev-store-lock.json` (what `tests/helpers/dev-toolchains.ts` reads), never the
  store's `current-lock.json`, and a lock whose digest is that file's is refused. `--check` verifies
  the worktree's lock without writing, `--verify-archives` lists every cached archive with the
  store's own readers, `--targets web,macos,windows,linux` narrows the destinations and
  `--evidence <dir>` is where the logs go. Nothing is ever deleted from the shared store.
- `prebuild-raylib.ts --out <dir>/raylib-<variant> [--target web|macos|windows|linux] [--variant <name>]`
  prebuilds one raylib variant (`web-es3`, `macos-es3-angle`, `macos-es3-angle-headless`,
  `windows-x64-es3-angle`, `linux-x64-es3-angle`) from the worktree's lock with the store's one
  recipe (`recipe.json`, and zig's toolchain file for Windows and Linux), under the sandbox, for CI
  artifacts or a manual rebuild. It writes only `--out` and its own `<out>.work/`, and refuses an
  `--out` holding anything but an earlier prebuild.
- `linux-sysroot.ts` builds the Linux headers' sysroot local artifact from the AlmaLinux 8 headers
  and GLFW's Wayland protocol code; `--check` derives and verifies its manifest. `--archive <file>`
  writes a sorted tar.gz with zero timestamps/uid/gid and normalized modes. Its archive digest
  and size are pinned by `native/linux-sysroot/bundle-lock.json`. The checked-in archive is verified
  and bundled by `scripts/bundle-linux-sysroot.mjs`; installation verifies its manifest and every
  file before swapping. Fresh setups use the bundled copy without a download URL. Developer
  stores can still use the local artifact.
- `compile-check.sh` compile-checks the C++ game template against the real raylib headers
  (host clang, emsdk and zig cross-targets, and a Linux run in Docker).
- `rust-env.ts -- cargo <args>` runs cargo (and cargo-deny, cargo-vet, cargo-zigbuild) for the
  Rust · wgpu workspace `native/genex-rust` with the pinned spike toolchain only
  (`scripts/spike/rust-wgpu/pins.md`): its own `CARGO_HOME` and sysroot, `--manifest-path` added
  for the workspace (after cargo-vet's own command), and a typed refusal for any other manifest,
  configuration, rustup toolchain or unpinned target. Inherited compiler flags (`RUSTFLAGS` and
  kin) and `CARGO_*` variables other than the target folder and terminal output are dropped.
- `rust-destinations.ts [--crates a,b] [--out <dir>] [--list]` (`npm run check:rust-destinations`) is
  the six-destination compile check: `cargo check --offline --locked` through `rust-env.ts` of the
  engine crates for seven rows (the Mac, wasm32, iOS device and simulator, Android, Windows
  gnullvm, Linux), adding each family's platform crate (`-ios`, `-android`, `-web`, `-desktop`
  with `genex-studio`). The Linux row reads the store's Linux sysroot through target-scoped
  pkg-config, as the Linux build lane does, and is `not-run` without one. It refuses `disk` below
  5 GiB free (typed line, exit 78, nothing runs) and writes `<triple>.json`, `<triple>.log` and
  `summary.json` under `.studio-dev/rust-destinations/`; the exit code is 0 only when all rows pass.
- `rust-vendor.ts check | inventory | archive --out <dir>` guards the vendored crate set: `check`
  refuses any build script, proc macro or non-source file not listed in `rust-inventory.json`, any
  stale entry (the workspace's own crates' entries, such as a `genex-*` golden, are left to
  `rust-release.ts cut`), GL backend crate or link; `inventory` rewrites the list for review; `archive`
  re-vendors offline and writes the reproducible release inputs (vendored archive, `genex`
  sources, sysroot manifest, `release-inputs.json`). The `rust-toolchain.yml` workflow runs it with
  cargo-deny and cargo-vet; publishing the inputs is an owner step. `rust-gate-workflow.ts` reads
  that workflow's steps so a test can hold that nothing compiling the vendored crates runs once
  the inventory or cargo-deny failed.
- `rust-release.ts bump <version> | inventory | cut --out <dir> | pin --from <dir> | tree --out <dir>`
  cuts a `genex` release: `bump` moves the workspace version and its lock; `inventory` rebuilds the
  release's vendored tree (the allowlist re-vendored offline plus the workspace's crates as
  `cargo package` makes them from a git-ignored copy, so no crate records the commit and the
  digest does not move with HEAD) and records its digest and genex version in `rust-inventory.json`
  (`release`) for review; `cut` refuses any tree, version or URL that is not the reviewed one and
  writes the byte-reproducible `rust-vendor.tar.gz`, `release.json`, each host's
  `current-lock.rust-wgpu.json` and the release-manifest inputs. Publishing the archive under
  `genex-<version>` is an owner step; `pin` then adds it to `rust-recipe.json`. Until a release is
  pinned, dev builds resolve genex from the workspace (`resolveGenex`; `dev-store.ts --stack rust-wgpu`).
- `dev-store.ts --stack rust-wgpu [--check]` builds the Rust stack's dev store in the same store
  and keeps its lock beside the C++ one (`--lock-file`, else `GENEX_DEV_STORE_RUST_LOCK`, else
  `.studio-dev/dev-store-rust-lock.json`, what the real Rust rows read): the pinned archives from
  `$GENEX_RUST_TOOLCHAIN_DIR/downloads/` (default `.studio-dev/spike-toolchain`), a dev vendored
  set cut from this checkout's genex crates, then the base and the Mac and web prewarms under the
  real sandbox. `--check` holds the receipts to the pins. `--release <dir>` takes the vendored set
  from a local cut (`rust-release.ts cut --out <dir>`; `readCutVendor` holds its archive to
  `release.json` before the store's own install checks it and its tree). An owned live `studio:dev`
  profile seeds its own Rust stack from this store and lock at startup (`ToolchainService.seedRust`).
- `crate-policy.ts refresh [--commit <sha>] [--audits] | check` keeps the crate policy's RustSec
  snapshot one pin (`native/genex-rust/crate-policy.json`, the recipe's `rustsec-advisory-db`
  entry, the `pins.md` row and `CRATE_POLICY_SHA256`): `refresh` downloads one advisory-db
  commit's archive (HEAD unless named) into `$GENEX_RUST_TOOLCHAIN_DIR/downloads/`, checks it holds
  RustSec's tree and rewrites the four pins; `--audits` also pins each trusted source's audit list
  at its repository's HEAD. `check` downloads nothing and fails on any drift.
- `swiftshader-split.ts --angle <folder> --out <folder> [--check-lock]` splits the software Vulkan
  a Rust Linux game ships (loader, SwiftShader, ICD, licences) out of a Linux ANGLE build and prints
  the pin `native/angle/bundle-lock.json` records; `--check-lock` fails unless the split is the pin.
- `make-wasm-fixture.sh` builds the small real Emscripten output in `tests/fixtures/raylib-wasm/`
  that the export tests use; `--check` rebuilds it and compares digests.
  `make-rust-wasm-fixture.sh` does the same for the Rust web lane's output
  (`tests/fixtures/rust-wasm/`: wasm-bindgen output beside the template's `web/shell.html`);
  `--check` fails when the template shell changed since it was built.

Windows executables use a stripped COFF build with `/Brepro`, prefix maps and no CodeView command
line. Two full raylib/template builds in different folders gave identical executable and raylib
archive bytes. Zig 0.16's driver refuses PDB path override flags; unstripped probe PDBs and
executables differ. Stripped builds emit no PDB: `cross-build-smoke.ts --repro
--allow-pdb-difference` records that limit, never reports PDB equality. Exported games carry no PDB.

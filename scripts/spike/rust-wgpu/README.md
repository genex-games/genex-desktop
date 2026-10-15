# Rust · wgpu spike scripts (spike only)

The M0a spike's scripts, landed with the `genex` workspace (`native/genex-rust`) in M1.12. They
are developer and CI tools, not product code: the app never runs or imports them, and each
script's header names the work package that replaces it.

- `setup-toolchain.sh` installs the archives pinned in `pins.md` into the project-local
  `.studio-dev/spike-toolchain/` and vendors the crates `vendor-allowlist.toml` lists at exactly
  the versions the committed `vendor-allowlist.lock` pins (`--relock` is the only path that
  changes it; `native/genex-rust/Cargo.lock` must agree with it). The toolchain store's Rust
  payload replaces it from M2.3.
- Cargo runs through `scripts/toolchains/rust-env.ts`, not through `rust-env.sh` here, which stays
  only for the spike scripts that source it.
- `cross-*.sh`, `export-standalone.sh`, `web.sh`, `ios-app.sh` and `android-apk.sh` are the
  spike's builds and packaging; M2.13 reuses the packaging scripts until the iOS and Android lanes
  (M5.1, M5.2) replace them. They never launch a simulator, an emulator or a device.
- `parity.sh`, `measure.ts`, `seatbelt-measure.*` and `authoring-trial.ts` are the spike's
  measurements; their evidence stays under `.studio-dev/`.
- `rebuild-bench.ts` times the template's warm rebuild through the app's own Rust lane (real
  Seatbelt sandbox, receipt steps and wall time as p50/p95), the K6 budget's measurement.
- `render-perf.ts` is the renderer follow-up's perf gate: it drives the showcase crate's perf matrix
  (`examples/showcase/tests/perf_matrix.rs`, scenes x profiles x sizes, GPU-timestamp p50/p95), records
  `perf/baseline.json` under the renderer evidence folder (a developer's quick check), runs the
  interleaved A/B against saved executables (`--ab`, `--save-bin`) and prints feature costs against the
  plan's budgets. The gate is the A/B: `off` p95 within 1.10x of the saved `rq0-head` executable on the
  bench and stress scenes, judged on the median of 5 interleaved runs (Lakeside rows informational). Its
  rows, including the real-GPU gate under `GENEX_REQUIRE_METAL=1`, are
  `tests/conformance/render-perf-gate.test.ts`.
- `web-showcase.sh` packages Lakeside for the web as a web export is built (the lane's size
  profile, `wasm-bindgen`, `wasm-opt -Oz`), so its gzip size is the export's;
  `web-cold-start.ts` times a packaged web build's first lit frame in headless Chromium, cold
  (`--cold-shaders`: no shader cache answers) and with its pipelines pre-warmed asynchronously.

`rustfmt` is not pinned: no check formats Rust yet. It joins the pins with the store's Rust
components when a formatting gate needs it.

# Netcode scripts

## Rust driver conformance (`rust-conformance.ts`)

genex-demo's netcode bench (`packages/netcode-bench`) holds the relay protocol's conformance
fixtures and feel gates. It drives any client through a stdio driver (DRIVER.md, contract 1).
`rust-conformance.ts` runs the bench's `test/conformance.test.ts` with
`GENEX_CONFORMANCE_DRIVERS=rust` twice:

1. With the vendored crate's own driver, `crates/genex-multiplayer/examples/driver.rs`. This run
   tests the relay client.
2. With the facade driver, `examples/net-driver`. This run tests the facade's wiring over it: the
   cut, the journal, the write queue and the relay mapping.

Each run covers every fixture alone, in mixed rooms with the bench's TypeScript driver in both role
orders, and the four feel gates. A local relay serves them behind the bench's impairment proxy.

```sh
# A checkout of genex-demo at the vendored crate's pin, with its own packages installed.
git clone --no-checkout <genex-demo> .studio-dev/genex-demo-8cd1477a2
git -C .studio-dev/genex-demo-8cd1477a2 checkout --detach 8cd1477a2a120937a1c79fc1c98b99cef3fcc145
(cd .studio-dev/genex-demo-8cd1477a2 && pnpm install --frozen-lockfile --ignore-scripts \
  --filter "@genex/netcode-bench..." --filter "@genex/colyseus...")

GENEX_DEMO_DIR=$PWD/.studio-dev/genex-demo-8cd1477a2 node scripts/netcode/rust-conformance.ts --build
```

- `--build` builds both drivers through `scripts/toolchains/rust-env.ts` first. Without it, the
  runner uses the debug builds in the cargo target folder (`CARGO_TARGET_DIR`, by default
  `.studio-dev/cargo-target`). `GENEX_NET_CRATE_DRIVER` and `GENEX_NET_FACADE_DRIVER` name other
  builds.
- `--out <dir>` picks the evidence folder. By default it is
  `.studio-dev/evidence/netcode-conformance/<stamp>/`. The folder holds each driver's TAP and
  stderr, and a `summary.json` with the commit, each driver's sha256, counts and failures, and
  the owner rows.
- Exit 0 means both drivers are green: every test passed, with no skip. The bench treats a skip as
  a failure too. Exit 1 means a run was red.

### What it refuses

A refusal is one line on stderr (`genex-netcode-conformance-refusal: {"code":…}`) with exit 78. It
runs and writes nothing.

| Code | When |
| --- | --- |
| `demo-unset`, `demo-not-checkout` | `GENEX_DEMO_DIR` is unset or is not the top of a git checkout |
| `demo-wrong-commit` | The checkout is not at the commit in `crates/genex-multiplayer/PROVENANCE.toml` |
| `demo-dirty` | The bench, the relay, the TypeScript SDK or `sdks/rust` have local changes |
| `demo-not-installed` | `@colyseus/core` or `@genex-ai/multiplayer` would resolve outside the checkout. This happens when the checkout has no `node_modules` of its own: Node would load an enclosing folder's packages |
| `driver-missing`, `driver-not-executable` | A driver is not a built executable file |
| `driver-outside` | A driver, with its links resolved, is outside this repository and the cargo target folder |
| `driver-unquotable` | A driver path has a blank or a quote, which the bench's command splitting would break |

### Owner rows

These rows need what this command does not run. The summary records them as `not-measured`:

- `live-relay`: both drivers against the hosted protocol-3 relay, on two machines.
- `impaired-network`: the bench's `impair.ts` profiles (loss, jitter, reorder) on both drivers.
- `live-feel-gates`: the feel gates as sender and observer on the live relay.

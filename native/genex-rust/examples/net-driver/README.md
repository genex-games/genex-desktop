# net-driver

The netcode bench's driver (genex-demo `packages/netcode-bench/DRIVER.md`, contract 1) over
`genex::net` (multiplayer MP-6b). The vendored crate has its own driver
(`crates/genex-multiplayer/examples/driver.rs`), which tests the relay client. This one tests the
facade's wiring on top of it: a headless `Runtime` whose net runs on the facade's `RelayBackend`,
with the cut, the journal, the write queue and the relay mapping in the path.

It is host tooling, not a game: it reads the wall clock and runs a stdin reader thread
(`clippy.toml` says so). The bench names the endpoint, game id, name and token, so `connect`
installs a `RelayBackend` over a `BenchConnector` in place of the export's baked guest door.

## Build and run

```sh
node scripts/toolchains/rust-env.ts -- cargo build -p genex-multiplayer --example driver --offline
node scripts/toolchains/rust-env.ts -- cargo build -p net-driver --offline
node scripts/toolchains/rust-env.ts -- cargo test -p net-driver --offline --test parity
node scripts/toolchains/rust-env.ts -- cargo test -p net-driver --offline --test online
```

- `tests/parity.rs` runs both drivers as subprocesses and compares their frames.
  `fixtures/offline.jsonl` needs no relay and always runs. `fixtures/bench.json` is two clients
  on a localhost netcode-bench relay. It runs only with `GENEX_NET_BENCH=1` and
  `GENEX_NET_BENCH_ENDPOINT=ws://127.0.0.1:<port>` (owner machine); otherwise it prints NOT
  MEASURED.
- `tests/online.rs` drives the facade's real `RelayBackend` with a scripted session (no socket).
  It covers the join, control results, local refusals, game events, host changes, reconnects and
  closes.
- `scripts/netcode/rust-conformance.ts` runs genex-demo's bench conformance with this driver and
  the crate's own driver (see `scripts/netcode/README.md`).

## What the facade does not show

A game cannot read these, so the driver answers `null` for them. It never reaches around the
facade to fill them in:

| Field | DRIVER.md | Why `null` |
| --- | --- | --- |
| `players[].uid`, `players[].team` | snapshot | `NetPlayer` carries no uid or team |
| `objects[].seq` | snapshot | `NetObject` carries no seq (DRIVER.md allows `null`) |
| `sequence` | control result | `NetEvent::Control` carries no sequence |
| `requestId` | control result | the facade's ticket (`t<n>`), not the wire id |
| `code` | `reconnecting` event | `NetEvent::Reconnecting` carries no close code |
| `id`, `at` | `chat` event | `NetEvent::Chat` carries neither |

There are three other differences from the crate's driver:

- `retryAfterMs` is rounded up to whole ticks (`retry_at_tick`).
- `setShared` from a guest answers `net-not-host`. The facade lets only the host write shared keys.
- A release or destroy of an object this client does not own, and a host claim from a guest, are
  refused by the facade before they leave. They answer as the relay would (`missing`,
  `not-owner`, `not-host`) with `requestId: null`.

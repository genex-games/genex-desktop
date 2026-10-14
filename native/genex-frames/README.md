# genex-frames (macOS)

`genex-frames.node` is the only native addon in Electron main. It lets a sandboxed native game
show its frames inside Live (M5a). The game renders into a ring of three IOSurfaces and sends one
mach message per finished frame. The addon receives the message, validates it, looks the surface
up and hands JavaScript the handle that `sharedTexture.importSharedTexture` expects.

The addon only receives. It never locks, maps or reads pixels. It opens no files or sockets and
loads no other code. `build.sh` audits the import table for these symbols and fails if it finds
any. Pixels are untrusted content that the compositor draws. The game's metadata is checked
before anything reaches Electron.

## Layout

| Path | What |
| --- | --- |
| `include/gxf_wire.h` | Wire format shared by both sides: service prefix, message id, payload, limits |
| `src/gxf_validate.{h,c}` | Pure parser and validator: typed refusal codes, ring state, slot ownership, rate cap (no syscalls) |
| `src/gxf_channel.{h,cc}` | Receive core: `bootstrap_check_in`, port set with a wake port, `mach_msg`, `IOSurfaceLookupFromMachPort`, retained surfaces |
| `src/gxf_addon.cc` | N-API 8 binding: one receive thread per run, events through a thread-safe function |
| `sender/gxf_sender.{h,c}` | Game-side library: create the ring, look up the per-run name, send frames |
| `sender/gxf_angle_render.{h,c}` | Game-side GPU path: the ring as EGL pbuffers through Metal-only ANGLE (`EGL_ANGLE_iosurface_client_buffer`) |
| `sender/gxf_test_sender.c` | Test game: a JSON-lines stand-in for the fd-3 protocol, a checkable pattern and hostile modes |
| `tests/` | `test_validate` (hostile-message table), `test_fuzz` (deterministic fuzz loop), `test_channel` (real kernel) |

## Build and test

```sh
native/genex-frames/build.sh          # addon, sender library, test sender
native/genex-frames/build.sh test     # plus the ASan+UBSan tests, run
```

The tools are Apple clang (`xcrun`) and Node's `node_api.h`. Only the ABI-stable N-API headers
are used, so any Node 18 or later works. The addon is a `-bundle` linked with
`-undefined dynamic_lookup`, so the host (Node or Electron) provides the N-API symbols. It
targets macOS 12. The build uses no JIT and no `dlopen`, which keeps it compatible with the
hardened runtime.

Environment variables:

- `OUT`: output directory. Default: `.studio-dev/build/genex-frames`.
- `ARCH`: `arm64` (default) or `x86_64`.
- `NODE_API_INCLUDE`: directory with `node_api.h`.
- `FUZZ_ITERATIONS`: fuzz iterations. Default: 100000.
- `ANGLE_DIR`: a Metal-only ANGLE store entry. When set, the script also builds
  `gxf_test_sender_angle` with the ANGLE dylibs beside it.

## Wire format

Each frame is one complex mach message to `games.genex.frames.<runId>`.

- `msgh_id` is `'GXF1'`.
- The message carries exactly one port descriptor that moves a send right to the slot's
  IOSurface.
- The payload is `{magic 'GENX', version 1, slot, generation, width, height, pixel_format 'BGRA', seq, ts_us}`.
- There is no reply port and no voucher. The total size is exactly 80 bytes.

The receiver asks for the audit trailer, and the sender's pid must equal the game's pid.

## JavaScript API

```js
const frames = require(".../genex-frames.node");  // abiVersion 1, wireVersion 1, maxSlots 3, errorCodes {code: fatal}
const ch = frames.open(runId, onEvent, { maxFps: 240, burst: 16, pid });  // throws invalid-run-id | check-in-failed
ch.serviceName;                        // "games.genex.frames.<runId>": the game profile's one extra mach-lookup
ch.setPeer(pid);                       // the only sender accepted; others are dropped (foreign-sender)
ch.expectRing({ generation, width, height, slots });  // before the surface op; throws invalid-* | too-many-held
ch.release(generation, slot, seq);     // after allReferencesReleased; false unless that frame holds the slot
ch.stats();                            // {received, accepted, refused, dropped, released, generation, heldMask, retiredHeld, peer, open, fault}
ch.close();                            // idempotent; launchd forgets the name; safe with imports in flight
```

`onEvent` receives one of two shapes:

- `{type:"frame", generation, slot, seq, ts, receivedAt, width, height, pixelFormat:"bgra", surfaceId, ioSurface}`.
  `ioSurface` is an 8-byte Buffer that holds the `IOSurfaceRef` pointer value, which is what
  `handle.ioSurface` expects. It stays valid until `release(generation, slot, seq)` or
  `close()`. Each queued event also holds its own reference until its callback returns.
- `{type:"error", code, fatal:true, generation?, slot?}`, sent at most once per run. Nothing is
  delivered after it, and the host kills the game.

Refusal codes:

- Message shape: `oversize`, `truncated`, `wrong-size`, `wrong-msg-id`, `bad-header`,
  `missing-port`, `bad-descriptor`, `bad-disposition`, `bad-trailer`, `bad-magic`.
- Ring and sequence: `no-ring`, `bad-generation`, `unknown-slot`, `bad-seq`, `rate`.
- Surface: `size-mismatch`, `format-mismatch`, `alloc-mismatch`, `not-iosurface`.
- Slot ownership: `slot-busy`, `ring-overflow` (a 4th surface), `duplicate-surface`.
- Host side: `queue-overflow`, `receive-failed`.

Two cases are dropped and counted rather than refused: `foreign-sender` and `stale-generation`.
A stale generation is an old ring's frame that was still in flight during a resize.

Limits:

- At most 3 slots.
- Each side 1 to 8192 pixels, and at most 32 Mpx per surface.
- Rows between `width*4` and the system row alignment.
- Allocation between `rows*height` and that rounded up to 64 KiB.
- Strictly increasing `seq` below 2^53.
- Rate: token bucket, 240 fps with a burst of 16 by default.

## The Rust sender

A Rust · wgpu game sends through `native/genex-rust/crates/genex-frames`, which speaks this wire
unchanged (its `wire.rs` reproduces `gxf_wire.h` with const-asserted sizes). wgpu draws each
frame on Metal into a slot's IOSurface, adopted through `create_texture_from_hal`. The sender
waits for the GPU and only then sends the 80-byte message, so the addon cannot tell it from the C
sender. `gxf-rust-test-sender` is the Rust counterpart of `gxf_test_sender`, and
`tests/conformance/rust-frames-real.test.ts` drives it against this addon. When the GPU device is
lost, the game re-creates it, drops the ring made on the old device and sends a `device-restored`
event on fd 3. The host then announces a new generation (`expectRing`, then the `surface` op), so
frames still in flight from the old ring arrive as a stale generation and are dropped. A step or
capture that misses its deadline is taken for a GPU hang: the host kills the game's group with
`gpu-hang`, and the addon's channel closes with the run.

## Follow-ups

- **libFuzzer.** Apple clang ships no libFuzzer. A coverage-guided target over `gxf_parse` and
  the validator belongs in CI with LLVM clang. LeakSanitizer is also unsupported here. The tests
  count port names instead and assert that none leak.
- **Signed build (owner).** With Genex's identity and the hardened runtime, the addon must load
  without `disable-library-validation`, and `bootstrap_check_in` must still work.

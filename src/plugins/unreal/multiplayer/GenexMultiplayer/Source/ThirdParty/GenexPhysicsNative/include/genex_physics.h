/*
 * genex_physics.h: the C ABI of Genex Physics (contract 1.0 and the 1.1 draft).
 *
 * Hand-written; it changes together with crates/genex-physics-capi/src/lib.rs, and
 * scripts/physics-capi.ts --test compiles a C file against both (every symbol both ways,
 * static_assert sizes) and replays the conformance vectors through it. The contract is
 * crates/genex-physics/CONTRACT.md; section numbers below are its own.
 *
 * Calls
 *   Every function but gxph_abi_version returns a gxph_result. GXPH_OK means the core ran and every
 *   out-argument was written; a contract refusal is then inside the JSON reply ({"ok":false,
 *   "code":...}), byte for byte what the WASM package's wire gives for the same call. Any other
 *   result is a refusal at the boundary: nothing changed and no out-argument was written.
 *
 * Inputs
 *   Text is UTF-8 with an explicit length (no terminator needed); arrays are a pointer and an
 *   element count. A zero length needs no pointer. Otherwise the pointer must not be NULL, must be
 *   aligned for its element type, and the argument must span at most GXPH_ARG_BYTES_MAX bytes.
 *
 * Replies
 *   Every reply is a gxph_bytes the library owns until gxph_buf_free gives it back. An out
 *   gxph_bytes must be empty (GXPH_BYTES_EMPTY) on entry. Freeing a buffer the library does not hold
 *   (twice, or a foreign pointer) is GXPH_ERR_NOT_OURS and frees nothing; a freed one is zeroed.
 *
 * Worlds
 *   A gxph_world* is a handle, never dereferenced. Handles are never reused: a freed one names no
 *   world, calls with a reply answer {"ok":false,"code":"internal",...}, calls without one give the
 *   empty form (0, an empty buffer), and a second gxph_world_free is GXPH_ERR_NO_WORLD.
 *
 * Threads and failure
 *   One registry per loaded library behind one lock: any thread may call, one call runs at a time.
 *   No panic unwinds into C: a panic inside the library answers GXPH_ERR_PANIC and poisons it, so
 *   every later call answers GXPH_ERR_PANIC too (unload and reload it, or end the process).
 */
#ifndef GENEX_PHYSICS_H
#define GENEX_PHYSICS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The version of this header; gxph_abi_version() must return the same. */
#define GXPH_ABI_VERSION 1u

/* A call's status. */
typedef int32_t gxph_result;
#define GXPH_OK 0                /* the core ran; every out-argument holds its reply */
#define GXPH_ERR_NULL 1          /* a required pointer or the handle was NULL */
#define GXPH_ERR_LENGTH 2        /* over GXPH_ARG_BYTES_MAX bytes, or past the address space */
#define GXPH_ERR_ALIGN 3         /* a pointer not aligned for its element type */
#define GXPH_ERR_UTF8 4          /* text that is not UTF-8 */
#define GXPH_ERR_OUT_IN_USE 5    /* an out gxph_bytes that still holds a buffer */
#define GXPH_ERR_NO_WORLD 6      /* gxph_world_free of a handle that names no live world */
#define GXPH_ERR_NOT_OURS 7      /* gxph_buf_free of a buffer the library does not hold */
#define GXPH_ERR_PANIC 8         /* the library panicked (now or earlier) and is poisoned */
#define GXPH_ERR_ARG 9           /* a mode or flag out of range, or two outs that are one pointer */

/* gxph_world_apply's modes (§7.1). */
#define GXPH_APPLY_EACH 0u
#define GXPH_APPLY_ATOMIC 1u

/* The most bytes one input argument may span (1 GiB). */
#define GXPH_ARG_BYTES_MAX ((size_t)1 << 30)

/* An opaque world handle. */
typedef struct gxph_world gxph_world;

/* A buffer the library hands out: len bytes at ptr, {NULL, 0} when empty. */
typedef struct gxph_bytes {
  uint8_t *ptr;
  size_t len;
} gxph_bytes;

#define GXPH_BYTES_EMPTY {NULL, 0}

/* The ABI version the library was built with (GXPH_ABI_VERSION). */
uint32_t gxph_abi_version(void);
/* This build's identity (§2), e.g. "genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+aarch64-apple-darwin". */
gxph_result gxph_build_id(gxph_bytes *out);
/* Gives a reply back and zeroes *buffer; freeing the empty buffer is a no-op. */
gxph_result gxph_buf_free(gxph_bytes *buffer);
/* How many worlds the library holds. */
gxph_result gxph_live_worlds(uint32_t *out);

/* Makes a world from its JSON WorldDesc (§4): reply {"ok":true,"id":n} or a failure, *world the
 * new handle or NULL when refused. */
gxph_result gxph_world_create(const char *desc, size_t desc_len, gxph_world **world, gxph_bytes *reply);
/* Frees a world and its memory. */
gxph_result gxph_world_free(gxph_world *world);
/* {"ok":true}, or internal when the world failed earlier or is gone. */
gxph_result gxph_world_check(const gxph_world *world, gxph_bytes *reply);
/* The resolved description as JSON (§4), or null. */
gxph_result gxph_world_desc(const gxph_world *world, gxph_bytes *reply);
/* The tick counter (0 for no world). */
gxph_result gxph_world_tick(const gxph_world *world, uint64_t *out);

/* One command in its JSON form (§7.3). */
gxph_result gxph_world_command(const gxph_world *world, const char *command, size_t command_len, gxph_bytes *reply);
/* A JSON array of commands (§7.1): GXPH_APPLY_EACH gives {"ok":true,"results":[...]},
 * GXPH_APPLY_ATOMIC {"ok":true} or the first failure with its index. */
gxph_result gxph_world_apply(const gxph_world *world, const char *commands, size_t commands_len, uint32_t mode,
                             gxph_bytes *reply);
/* §17.7's static world (§6.5) in its flat form: each list's row lengths, then its values row after row. */
gxph_result gxph_world_add_static(const gxph_world *world, const uint32_t *box_lengths, size_t box_lengths_len,
                                  const double *boxes, size_t boxes_len, const uint32_t *ramp_lengths,
                                  size_t ramp_lengths_len, const double *ramps, size_t ramps_len, gxph_bytes *reply);

/* Steps once (§8): {"ok":true,"tick",...,"events":[...],"escaped":[...],...} or a failure. */
gxph_result gxph_world_step(const gxph_world *world, gxph_bytes *reply);
/* Records the wall time the host measured around the last step (§11.4). */
gxph_result gxph_world_record_step_ms(const gxph_world *world, double ms, gxph_bytes *reply);
/* One room tick in one call: the binary tick request in, the binary reply out (the binding's
 * tick.rs); a request that does not decode gives the empty reply. */
gxph_result gxph_world_tick_frame(const gxph_world *world, const uint8_t *request, size_t request_len,
                                  gxph_bytes *reply);

/* One body's state as JSON, or null (§9.1). */
gxph_result gxph_world_body(const gxph_world *world, const char *key, size_t key_len, gxph_bytes *reply);
/* The bodies a filter selects (§9.1) as a JSON array. kinds: a JSON array of strings, or NULL with
 * length 0 for none; awake_only: 0 or 1; changed_since: a tick, or negative for none. */
gxph_result gxph_world_bodies(const gxph_world *world, const char *kinds, size_t kinds_len, uint32_t awake_only,
                              double changed_since, gxph_bytes *reply);
/* The bodies changed after tick since (§9.1): keys a JSON array, data 14 floats per key in
 * exportChanged's layout (native byte order, 4-byte aligned, len in bytes). keys != data. */
gxph_result gxph_world_export_changed(const gxph_world *world, double since, gxph_bytes *keys, gxph_bytes *data);
/* The same with the sleep timer (§20.3): 15 floats per key, every awake body listed too. */
gxph_result gxph_world_export_changed_rest(const gxph_world *world, double since, gxph_bytes *keys,
                                           gxph_bytes *data);
/* A body's replicated fields as JSON (§9.2), or null; _rest adds the sleep timer (§20.3). */
gxph_result gxph_world_export_body_state(const gxph_world *world, const char *key, size_t key_len,
                                         gxph_bytes *reply);
gxph_result gxph_world_export_body_state_rest(const gxph_world *world, const char *key, size_t key_len,
                                              gxph_bytes *reply);
/* Sets a body's replicated fields from their JSON form (§9.2). */
gxph_result gxph_world_import_body_state(const gxph_world *world, const char *key, size_t key_len,
                                         const char *state, size_t state_len, gxph_bytes *reply);
/* Bulk imports, all or none (a refusal names its index). keys: a JSON array of strings; data:
 * data_len floats, 14 per key (§19.1), 15 with the sleep timer (§20.3), 15 per wire row (§20.2). */
gxph_result gxph_world_import_states(const gxph_world *world, const char *keys, size_t keys_len, const float *data,
                                     size_t data_len, gxph_bytes *reply);
gxph_result gxph_world_import_states_rest(const gxph_world *world, const char *keys, size_t keys_len,
                                          const float *data, size_t data_len, gxph_bytes *reply);
gxph_result gxph_world_import_wire(const gxph_world *world, const char *keys, size_t keys_len, const float *data,
                                   size_t data_len, gxph_bytes *reply);

/* Contract 1.1 draft (§20): the canonical state (options: JSON {"quantize"?: bool}) and the
 * canonical forms of a body or joint descriptor ({"ok":true,"desc":"..."} or spawn's/addJoint's refusal). */
gxph_result gxph_world_canonicalize(const gxph_world *world, const char *options, size_t options_len,
                                    gxph_bytes *reply);
gxph_result gxph_world_body_desc_canonical(const gxph_world *world, const char *desc, size_t desc_len,
                                           gxph_bytes *reply);
gxph_result gxph_world_joint_desc_canonical(const gxph_world *world, const char *desc, size_t desc_len,
                                            gxph_bytes *reply);

/* One query in its JSON form (§13): {"ok":true,"hit":...}, {"ok":true,"keys":[...]} or a failure. */
gxph_result gxph_world_query(const gxph_world *world, const char *query, size_t query_len, gxph_bytes *reply);
/* A JSON array of queries (§19.2): {"ok":true,"results":[...]} or one failure. */
gxph_result gxph_world_query_many(const gxph_world *world, const char *queries, size_t queries_len,
                                  gxph_bytes *reply);

/* The snapshot (§9.4), or the empty buffer when the world failed or is gone. */
gxph_result gxph_world_snapshot(const gxph_world *world, gxph_bytes *snapshot);
/* Replaces the world from a snapshot (§9.4). */
gxph_result gxph_world_restore(const gxph_world *world, const uint8_t *bytes, size_t bytes_len, gxph_bytes *reply);
/* stateHash (§10.1) and physicsHash (§10.2): 16 hex digits, or the empty buffer for no world. */
gxph_result gxph_world_state_hash(const gxph_world *world, gxph_bytes *hash);
gxph_result gxph_world_physics_hash(const gxph_world *world, gxph_bytes *hash);
/* The counters (§11) as JSON, or null. */
gxph_result gxph_world_stats(const gxph_world *world, gxph_bytes *reply);
/* stats().memoryBytes (§11.1) as a number; 0 for no world. */
gxph_result gxph_world_memory_bytes(const gxph_world *world, uint64_t *out);
/* 1 when the library measures this world's memory (§11.1), else 0. */
gxph_result gxph_world_memory_is_measured(const gxph_world *world, uint32_t *out);

#ifdef __cplusplus
}
#endif

#endif /* GENEX_PHYSICS_H */

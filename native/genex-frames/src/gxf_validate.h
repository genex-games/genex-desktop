/*
 * Pure parser and validator for frame messages. No system calls: the channel feeds it received
 * bytes, the clock and the IOSurface metadata it queried, so every refusal is testable and
 * fuzzable without the kernel.
 */
#ifndef GXF_VALIDATE_H
#define GXF_VALIDATE_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#include "gxf_wire.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Typed refusal codes. Names (gxf_code_name) are the wire spelling JavaScript sees. */
typedef enum gxf_code {
  GXF_OK = 0,
  GXF_E_OVERSIZE,          /* "oversize": larger than a frame message (the kernel dropped it) */
  GXF_E_TRUNCATED,         /* "truncated": msgh_size beyond the received bytes */
  GXF_E_WRONG_SIZE,        /* "wrong-size": msgh_size is not exactly a frame message */
  GXF_E_WRONG_MSG_ID,      /* "wrong-msg-id" */
  GXF_E_BAD_HEADER,        /* "bad-header": a reply or voucher port, or unknown header bits */
  GXF_E_MISSING_PORT,      /* "missing-port": not complex, no descriptor, or a null/dead name */
  GXF_E_BAD_DESCRIPTOR,    /* "bad-descriptor": not exactly one port descriptor */
  GXF_E_BAD_DISPOSITION,   /* "bad-disposition": not a plain send right */
  GXF_E_BAD_TRAILER,       /* "bad-trailer": no audit trailer */
  GXF_E_BAD_MAGIC,         /* "bad-magic": magic or wire version */
  GXF_E_FOREIGN_SENDER,    /* "foreign-sender": not the game's pid (dropped, not fatal) */
  GXF_E_NO_RING,           /* "no-ring": a frame before the host announced a ring */
  GXF_E_STALE_GENERATION,  /* "stale-generation": an older ring after a resize (dropped) */
  GXF_E_BAD_GENERATION,    /* "bad-generation": zero or a generation the host never chose */
  GXF_E_UNKNOWN_SLOT,      /* "unknown-slot": slot >= the ring's slot count */
  GXF_E_BAD_SEQ,           /* "bad-seq": not strictly increasing, or >= 2^53 */
  GXF_E_RATE,              /* "rate": over the frame-rate cap */
  GXF_E_SIZE_MISMATCH,     /* "size-mismatch": width or height differ from the ring */
  GXF_E_FORMAT_MISMATCH,   /* "format-mismatch": not one-plane BGRA8 */
  GXF_E_ALLOC_MISMATCH,    /* "alloc-mismatch": row bytes or allocation outside the bounds */
  GXF_E_NOT_IOSURFACE,     /* "not-iosurface": the port names no IOSurface */
  GXF_E_SLOT_BUSY,         /* "slot-busy": a frame for a slot Genex still holds */
  GXF_E_RING_OVERFLOW,     /* "ring-overflow": a new surface for a bound slot (a 4th surface) */
  GXF_E_DUPLICATE_SURFACE, /* "duplicate-surface": one surface bound to two slots */
  GXF_E_QUEUE_OVERFLOW,    /* "queue-overflow": JavaScript stopped draining events */
  GXF_E_RECEIVE_FAILED,    /* "receive-failed": mach_msg failed for another reason */
  GXF_E_COUNT
} gxf_code;

/** The wire spelling of a code ("unknown" outside the table). */
const char* gxf_code_name(gxf_code code);
/** Whether the host must kill the game for this code. Only foreign senders and stale generations
 * are dropped without killing it. */
int gxf_code_is_fatal(gxf_code code);

/** What a structurally valid frame message says. */
typedef struct gxf_frame_meta {
  mach_port_name_t port;
  pid_t sender_pid;
  uint16_t slot;
  uint32_t generation;
  uint32_t width;
  uint32_t height;
  uint32_t pixel_format;
  uint64_t seq;
  uint64_t ts_us;
} gxf_frame_meta;

/** The receive buffer: one frame message plus the audit trailer the channel asks for. Anything
 * larger fails with MACH_RCV_TOO_LARGE. */
typedef struct gxf_receive_buffer {
  gxf_frame_msg msg;
  mach_msg_audit_trailer_t trailer;
} gxf_receive_buffer;

/** Parses `len` received bytes (the receive buffer's size). Checks size, id, header bits, the one
 * send-right descriptor, the audit trailer and the payload magic; fills `out` on GXF_OK. */
gxf_code gxf_parse(const void* buf, size_t len, gxf_frame_meta* out);

/** The ring the host announced in the `surface` op. */
typedef struct gxf_ring_expect {
  uint32_t generation;
  uint32_t width;
  uint32_t height;
  uint32_t slots;
  uint64_t min_bytes_per_row;
  uint64_t max_bytes_per_row;
  uint64_t max_alloc;
} gxf_ring_expect;

/** Ring announcement refusals (thrown to JavaScript; the game is not involved yet). */
typedef enum gxf_ring_error {
  GXF_RING_OK = 0,
  GXF_RING_BAD_SIZE,       /* "invalid-ring-size" */
  GXF_RING_BAD_SLOTS,      /* "invalid-slot-count" */
  GXF_RING_BAD_GENERATION, /* "invalid-generation": zero or not above the last one */
  GXF_RING_TOO_MANY_HELD,  /* "too-many-held": older rings still hold too many slots */
} gxf_ring_error;

/** The wire spelling of a ring error. */
const char* gxf_ring_error_name(gxf_ring_error error);

/** Fills a ring expectation. `aligned_bytes_per_row` is the system's row alignment of width*4
 * (IOSurfaceAlignProperty), passed in so this stays pure. */
gxf_ring_error gxf_ring_expect_init(gxf_ring_expect* ring, uint32_t generation, uint32_t width, uint32_t height,
                                    uint32_t slots, uint64_t aligned_bytes_per_row);

/** IOSurface metadata the channel queried (never pixels). */
typedef struct gxf_surface_info {
  uint32_t surface_id;
  uint32_t width;
  uint32_t height;
  uint32_t pixel_format;
  uint32_t plane_count;
  uint32_t bytes_per_element;
  uint32_t element_width;
  uint32_t element_height;
  uint64_t bytes_per_row;
  uint64_t alloc_size;
} gxf_surface_info;

/** Token bucket in micro-tokens, so integer math is exact. */
typedef struct gxf_rate {
  uint64_t per_sec;
  uint64_t burst;
  uint64_t tokens;
  uint64_t last_us;
  int started;
} gxf_rate;

/** Takes one token at `now_us`; 0 when the bucket is empty. */
int gxf_rate_take(gxf_rate* rate, uint64_t now_us);

typedef struct gxf_slot {
  uint64_t held_seq; /* the frame that holds the slot */
  uint32_t surface_id;
  uint8_t bound;
  uint8_t held;
} gxf_slot;

typedef struct gxf_counters {
  uint64_t received;
  uint64_t accepted;
  uint64_t refused;
  uint64_t dropped;
  uint64_t released;
} gxf_counters;

/** Per-run validator state: the current ring, slot ownership, sequence, peer and rate. */
typedef struct gxf_state {
  int has_ring;
  gxf_ring_expect ring;
  gxf_slot slots[GXF_MAX_SLOTS];
  uint32_t last_generation;
  int has_seq;
  uint64_t last_seq;
  pid_t peer_pid;
  gxf_rate rate;
  gxf_code fault;
  gxf_counters counters;
} gxf_state;

/** Default rate cap: frames per second and burst. The burst covers a ring's worth of releases
 * arriving together after a stall, with room to spare; the cap is against floods, not pacing. */
#define GXF_DEFAULT_MAX_FPS 240u
#define GXF_DEFAULT_BURST 16u
/** Allocation slack above max row bytes * height (IOSurface rounds to 16 KiB pages). */
#define GXF_ALLOC_SLACK 65536u

void gxf_state_init(gxf_state* state, uint32_t max_fps, uint32_t burst);
/** Announces a new ring generation; the old ring's slots are forgotten (the channel keeps any
 * still-held surfaces until they are released). */
gxf_ring_error gxf_state_set_ring(gxf_state* state, const gxf_ring_expect* ring);
/** Checks a parsed frame against peer, rate, ring, generation, slot, payload, sequence and slot
 * ownership. Returns the sticky fault once the state is faulted. */
gxf_code gxf_check_frame(gxf_state* state, const gxf_frame_meta* meta, uint64_t now_us);
/** Checks the looked-up IOSurface's metadata against the ring and the slot binding. */
gxf_code gxf_check_surface(const gxf_state* state, const gxf_frame_meta* meta, const gxf_surface_info* info);
/** Accepts a checked frame: binds the slot to the surface, holds it, advances the sequence. */
void gxf_commit_frame(gxf_state* state, const gxf_frame_meta* meta, const gxf_surface_info* info);
/** Returns a slot of the current generation held by frame `seq`; 1 when it was. Naming the frame
 * means a stale or repeated release can never free a newer frame's slot. */
int gxf_state_release(gxf_state* state, uint32_t generation, uint16_t slot, uint64_t seq);
/** Records a refusal; a fatal code makes the state faulted for good. */
void gxf_state_refuse(gxf_state* state, gxf_code code);

#ifdef __cplusplus
}
#endif

#endif

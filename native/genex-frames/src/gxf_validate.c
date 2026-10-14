#include "gxf_validate.h"

#include <bsm/libbsm.h>
#include <string.h>

#define MICRO_TOKENS 1000000ull
#define MAX_FPS_CEILING 10000u
#define MAX_BURST 64u

static const char* const CODE_NAMES[GXF_E_COUNT] = {
    [GXF_OK] = "ok",
    [GXF_E_OVERSIZE] = "oversize",
    [GXF_E_TRUNCATED] = "truncated",
    [GXF_E_WRONG_SIZE] = "wrong-size",
    [GXF_E_WRONG_MSG_ID] = "wrong-msg-id",
    [GXF_E_BAD_HEADER] = "bad-header",
    [GXF_E_MISSING_PORT] = "missing-port",
    [GXF_E_BAD_DESCRIPTOR] = "bad-descriptor",
    [GXF_E_BAD_DISPOSITION] = "bad-disposition",
    [GXF_E_BAD_TRAILER] = "bad-trailer",
    [GXF_E_BAD_MAGIC] = "bad-magic",
    [GXF_E_FOREIGN_SENDER] = "foreign-sender",
    [GXF_E_NO_RING] = "no-ring",
    [GXF_E_STALE_GENERATION] = "stale-generation",
    [GXF_E_BAD_GENERATION] = "bad-generation",
    [GXF_E_UNKNOWN_SLOT] = "unknown-slot",
    [GXF_E_BAD_SEQ] = "bad-seq",
    [GXF_E_RATE] = "rate",
    [GXF_E_SIZE_MISMATCH] = "size-mismatch",
    [GXF_E_FORMAT_MISMATCH] = "format-mismatch",
    [GXF_E_ALLOC_MISMATCH] = "alloc-mismatch",
    [GXF_E_NOT_IOSURFACE] = "not-iosurface",
    [GXF_E_SLOT_BUSY] = "slot-busy",
    [GXF_E_RING_OVERFLOW] = "ring-overflow",
    [GXF_E_DUPLICATE_SURFACE] = "duplicate-surface",
    [GXF_E_QUEUE_OVERFLOW] = "queue-overflow",
    [GXF_E_RECEIVE_FAILED] = "receive-failed",
};

const char* gxf_code_name(gxf_code code) {
  if ((unsigned)code >= GXF_E_COUNT) return "unknown";
  return CODE_NAMES[code];
}

int gxf_code_is_fatal(gxf_code code) {
  return code != GXF_OK && code != GXF_E_FOREIGN_SENDER && code != GXF_E_STALE_GENERATION;
}

const char* gxf_ring_error_name(gxf_ring_error error) {
  switch (error) {
    case GXF_RING_OK:
      return "ok";
    case GXF_RING_BAD_SIZE:
      return "invalid-ring-size";
    case GXF_RING_BAD_SLOTS:
      return "invalid-slot-count";
    case GXF_RING_BAD_GENERATION:
      return "invalid-generation";
    case GXF_RING_TOO_MANY_HELD:
      return "too-many-held";
  }
  return "unknown";
}

/* A received header: no reply or voucher right, complex. The local (destination) bits are the
 * kernel's and are not checked. */
static gxf_code check_header(const mach_msg_header_t* h) {
  if (MACH_MSGH_BITS_REMOTE(h->msgh_bits) != 0 || h->msgh_remote_port != MACH_PORT_NULL) return GXF_E_BAD_HEADER;
  if (MACH_MSGH_BITS_VOUCHER(h->msgh_bits) != 0 || h->msgh_voucher_port != MACH_PORT_NULL) return GXF_E_BAD_HEADER;
  if (!(h->msgh_bits & MACH_MSGH_BITS_COMPLEX)) return GXF_E_MISSING_PORT;
  return GXF_OK;
}

static gxf_code check_descriptor(const gxf_frame_msg* m) {
  if (m->body.msgh_descriptor_count == 0) return GXF_E_MISSING_PORT;
  if (m->body.msgh_descriptor_count != 1) return GXF_E_BAD_DESCRIPTOR;
  if (m->surface.type != MACH_MSG_PORT_DESCRIPTOR) return GXF_E_BAD_DESCRIPTOR;
  if (m->surface.disposition != MACH_MSG_TYPE_PORT_SEND) return GXF_E_BAD_DISPOSITION;
  if (!MACH_PORT_VALID(m->surface.name)) return GXF_E_MISSING_PORT;
  return GXF_OK;
}

static gxf_code check_trailer(const unsigned char* bytes, size_t len, size_t msg_size, pid_t* pid) {
  size_t at = round_msg(msg_size);
  if (at > len || len - at < sizeof(mach_msg_audit_trailer_t)) return GXF_E_BAD_TRAILER;
  mach_msg_audit_trailer_t t;
  memcpy(&t, bytes + at, sizeof t);
  if (t.msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0) return GXF_E_BAD_TRAILER;
  if (t.msgh_trailer_size < sizeof(mach_msg_audit_trailer_t)) return GXF_E_BAD_TRAILER;
  *pid = audit_token_to_pid(t.msgh_audit);
  return GXF_OK;
}

gxf_code gxf_parse(const void* buf, size_t len, gxf_frame_meta* out) {
  const unsigned char* bytes = (const unsigned char*)buf;
  mach_msg_header_t h;
  if (buf == NULL || len < sizeof h) return GXF_E_TRUNCATED;
  memcpy(&h, bytes, sizeof h);
  if (h.msgh_size > len) return GXF_E_TRUNCATED;
  if (h.msgh_size < sizeof h) return GXF_E_WRONG_SIZE;
  if (h.msgh_id != GXF_MSG_ID_FRAME) return GXF_E_WRONG_MSG_ID;
  gxf_code code = check_header(&h);
  if (code != GXF_OK) return code;
  if (h.msgh_size != sizeof(gxf_frame_msg)) return GXF_E_WRONG_SIZE;
  gxf_frame_msg m;
  memcpy(&m, bytes, sizeof m);
  code = check_descriptor(&m);
  if (code != GXF_OK) return code;
  pid_t pid = 0;
  code = check_trailer(bytes, len, h.msgh_size, &pid);
  if (code != GXF_OK) return code;
  if (m.payload.magic != GXF_MAGIC || m.payload.version != GXF_WIRE_VERSION) return GXF_E_BAD_MAGIC;
  out->port = m.surface.name;
  out->sender_pid = pid;
  out->slot = m.payload.slot;
  out->generation = m.payload.generation;
  out->width = m.payload.width;
  out->height = m.payload.height;
  out->pixel_format = m.payload.pixel_format;
  out->seq = m.payload.seq;
  out->ts_us = m.payload.ts_us;
  return GXF_OK;
}

static uint64_t round_up(uint64_t value, uint64_t to) { return (value + to - 1) / to * to; }

gxf_ring_error gxf_ring_expect_init(gxf_ring_expect* ring, uint32_t generation, uint32_t width, uint32_t height,
                                    uint32_t slots, uint64_t aligned_bytes_per_row) {
  if (generation == 0) return GXF_RING_BAD_GENERATION;
  if (width == 0 || height == 0 || width > GXF_MAX_SIDE || height > GXF_MAX_SIDE) return GXF_RING_BAD_SIZE;
  if ((uint64_t)width * height > GXF_MAX_PIXELS) return GXF_RING_BAD_SIZE;
  if (slots == 0 || slots > GXF_MAX_SLOTS) return GXF_RING_BAD_SLOTS;
  uint64_t min_row = (uint64_t)width * GXF_BYTES_PER_PIXEL;
  uint64_t max_row = aligned_bytes_per_row > min_row ? aligned_bytes_per_row : min_row;
  /* The system alignment is small (128 B here); refuse a nonsense value instead of trusting it. */
  if (max_row > min_row + 4096) return GXF_RING_BAD_SIZE;
  ring->generation = generation;
  ring->width = width;
  ring->height = height;
  ring->slots = slots;
  ring->min_bytes_per_row = min_row;
  ring->max_bytes_per_row = max_row;
  ring->max_alloc = round_up(max_row * height, GXF_ALLOC_SLACK);
  return GXF_RING_OK;
}

int gxf_rate_take(gxf_rate* rate, uint64_t now_us) {
  uint64_t cap = rate->burst * MICRO_TOKENS;
  if (!rate->started) {
    rate->started = 1;
    rate->tokens = cap;
    rate->last_us = now_us;
  } else if (now_us > rate->last_us) {
    uint64_t elapsed = now_us - rate->last_us;
    if (elapsed >= cap / rate->per_sec + 1) {
      rate->tokens = cap;
    } else {
      rate->tokens += elapsed * rate->per_sec;
      if (rate->tokens > cap) rate->tokens = cap;
    }
    rate->last_us = now_us;
  }
  if (rate->tokens < MICRO_TOKENS) return 0;
  rate->tokens -= MICRO_TOKENS;
  return 1;
}

void gxf_state_init(gxf_state* state, uint32_t max_fps, uint32_t burst) {
  memset(state, 0, sizeof *state);
  if (max_fps == 0) max_fps = GXF_DEFAULT_MAX_FPS;
  if (max_fps > MAX_FPS_CEILING) max_fps = MAX_FPS_CEILING;
  if (burst == 0) burst = GXF_DEFAULT_BURST;
  if (burst > MAX_BURST) burst = MAX_BURST;
  state->rate.per_sec = max_fps;
  state->rate.burst = burst;
  state->fault = GXF_OK;
}

gxf_ring_error gxf_state_set_ring(gxf_state* state, const gxf_ring_expect* ring) {
  if (ring->generation <= state->last_generation) return GXF_RING_BAD_GENERATION;
  if (ring->slots == 0 || ring->slots > GXF_MAX_SLOTS) return GXF_RING_BAD_SLOTS;
  state->ring = *ring;
  state->has_ring = 1;
  state->last_generation = ring->generation;
  memset(state->slots, 0, sizeof state->slots);
  return GXF_RING_OK;
}

static gxf_code check_generation(const gxf_state* state, uint32_t generation) {
  if (!state->has_ring) return GXF_E_NO_RING;
  if (generation == 0 || generation > state->ring.generation) return GXF_E_BAD_GENERATION;
  if (generation < state->ring.generation) return GXF_E_STALE_GENERATION;
  return GXF_OK;
}

static gxf_code check_payload(const gxf_state* state, const gxf_frame_meta* meta) {
  if (meta->slot >= state->ring.slots) return GXF_E_UNKNOWN_SLOT;
  if (meta->width != state->ring.width || meta->height != state->ring.height) return GXF_E_SIZE_MISMATCH;
  if (meta->pixel_format != GXF_PIXEL_FORMAT_BGRA) return GXF_E_FORMAT_MISMATCH;
  if (meta->seq > GXF_MAX_SEQ) return GXF_E_BAD_SEQ;
  if (state->has_seq && meta->seq <= state->last_seq) return GXF_E_BAD_SEQ;
  if (state->slots[meta->slot].held) return GXF_E_SLOT_BUSY;
  return GXF_OK;
}

gxf_code gxf_check_frame(gxf_state* state, const gxf_frame_meta* meta, uint64_t now_us) {
  if (state->fault != GXF_OK) return state->fault;
  if (state->peer_pid == 0 || meta->sender_pid != state->peer_pid) return GXF_E_FOREIGN_SENDER;
  if (!gxf_rate_take(&state->rate, now_us)) return GXF_E_RATE;
  gxf_code code = check_generation(state, meta->generation);
  if (code != GXF_OK) return code;
  return check_payload(state, meta);
}

static gxf_code check_layout(const gxf_ring_expect* ring, const gxf_surface_info* info) {
  if (info->bytes_per_row < ring->min_bytes_per_row || info->bytes_per_row > ring->max_bytes_per_row)
    return GXF_E_ALLOC_MISMATCH;
  if (info->alloc_size < info->bytes_per_row * ring->height || info->alloc_size > ring->max_alloc)
    return GXF_E_ALLOC_MISMATCH;
  return GXF_OK;
}

static int is_one_plane_bgra8(const gxf_surface_info* info) {
  return info->pixel_format == GXF_PIXEL_FORMAT_BGRA && info->plane_count == 0 &&
         info->bytes_per_element == GXF_BYTES_PER_PIXEL && info->element_width == 1 && info->element_height == 1;
}

static gxf_code check_binding(const gxf_state* state, uint16_t slot, uint32_t surface_id) {
  const gxf_slot* own = &state->slots[slot];
  if (own->bound && own->surface_id != surface_id) return GXF_E_RING_OVERFLOW;
  for (uint32_t i = 0; i < state->ring.slots; i++) {
    if (i != slot && state->slots[i].bound && state->slots[i].surface_id == surface_id) return GXF_E_DUPLICATE_SURFACE;
  }
  return GXF_OK;
}

gxf_code gxf_check_surface(const gxf_state* state, const gxf_frame_meta* meta, const gxf_surface_info* info) {
  if (state->fault != GXF_OK) return state->fault;
  if (!state->has_ring) return GXF_E_NO_RING;
  if (meta->slot >= state->ring.slots) return GXF_E_UNKNOWN_SLOT;
  if (info->width != state->ring.width || info->height != state->ring.height) return GXF_E_SIZE_MISMATCH;
  if (!is_one_plane_bgra8(info)) return GXF_E_FORMAT_MISMATCH;
  gxf_code code = check_layout(&state->ring, info);
  if (code != GXF_OK) return code;
  return check_binding(state, meta->slot, info->surface_id);
}

void gxf_commit_frame(gxf_state* state, const gxf_frame_meta* meta, const gxf_surface_info* info) {
  gxf_slot* slot = &state->slots[meta->slot];
  slot->bound = 1;
  slot->surface_id = info->surface_id;
  slot->held = 1;
  slot->held_seq = meta->seq;
  state->has_seq = 1;
  state->last_seq = meta->seq;
  state->counters.accepted++;
}

int gxf_state_release(gxf_state* state, uint32_t generation, uint16_t slot, uint64_t seq) {
  if (!state->has_ring || generation != state->ring.generation || slot >= state->ring.slots) return 0;
  if (!state->slots[slot].held || state->slots[slot].held_seq != seq) return 0;
  state->slots[slot].held = 0;
  state->counters.released++;
  return 1;
}

void gxf_state_refuse(gxf_state* state, gxf_code code) {
  if (code == GXF_OK) return;
  if (!gxf_code_is_fatal(code)) {
    state->counters.dropped++;
    return;
  }
  state->counters.refused++;
  if (state->fault == GXF_OK) state->fault = code;
}

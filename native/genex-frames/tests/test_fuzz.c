/* Deterministic randomized fuzz of the parser and validator (fixed seed, 100k iterations by
 * default; argv[1] overrides). Built with ASan and UBSan: any out-of-bounds read or undefined
 * behavior aborts. Apple clang has no libFuzzer; a coverage-guided libFuzzer target over
 * gxf_parse is a CI follow-up (LLVM clang on the macOS runner). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gxf_validate.h"

#define PEER 777
#define W 640u
#define H 360u

static uint64_t rng_state = 0x9E3779B97F4A7C15ull;

static uint64_t next(void) {
  uint64_t x = rng_state;
  x ^= x << 13;
  x ^= x >> 7;
  x ^= x << 17;
  rng_state = x;
  return x;
}

static uint32_t below(uint32_t n) { return n == 0 ? 0 : (uint32_t)(next() % n); }

static void make_valid(gxf_receive_buffer* b, uint16_t slot, uint32_t generation, uint64_t seq) {
  memset(b, 0, sizeof *b);
  b->msg.header.msgh_bits = MACH_MSGH_BITS_SET(0, MACH_MSG_TYPE_PORT_SEND, 0, MACH_MSGH_BITS_COMPLEX);
  b->msg.header.msgh_size = sizeof(gxf_frame_msg);
  b->msg.header.msgh_id = GXF_MSG_ID_FRAME;
  b->msg.body.msgh_descriptor_count = 1;
  b->msg.surface.name = 0x1203;
  b->msg.surface.disposition = MACH_MSG_TYPE_PORT_SEND;
  b->msg.surface.type = MACH_MSG_PORT_DESCRIPTOR;
  b->msg.payload.magic = GXF_MAGIC;
  b->msg.payload.version = GXF_WIRE_VERSION;
  b->msg.payload.slot = slot;
  b->msg.payload.generation = generation;
  b->msg.payload.width = W;
  b->msg.payload.height = H;
  b->msg.payload.pixel_format = GXF_PIXEL_FORMAT_BGRA;
  b->msg.payload.seq = seq;
  b->trailer.msgh_trailer_type = MACH_MSG_TRAILER_FORMAT_0;
  b->trailer.msgh_trailer_size = sizeof(mach_msg_audit_trailer_t);
  b->trailer.msgh_audit.val[5] = PEER;
}

static gxf_surface_info random_info(void) {
  gxf_surface_info info = {0};
  int sane = below(4) != 0;
  info.surface_id = 1 + below(5);
  info.width = sane ? W : (uint32_t)next();
  info.height = sane && below(8) ? H : (uint32_t)next();
  info.pixel_format = below(6) ? GXF_PIXEL_FORMAT_BGRA : (uint32_t)next();
  info.plane_count = below(6) ? 0 : below(4);
  info.bytes_per_element = below(6) ? 4 : below(9);
  info.element_width = below(8) ? 1 : below(3);
  info.element_height = below(8) ? 1 : below(3);
  info.bytes_per_row = below(4) ? W * 4 : next() % (1u << 20);
  info.alloc_size = below(4) ? (uint64_t)W * 4 * H : next();
  return info;
}

/* Structure-aware mutation: flip bytes, overwrite fields with edge values, change msgh_size. */
static void mutate(unsigned char* bytes, size_t len) {
  uint32_t n = 1 + below(4);
  for (uint32_t i = 0; i < n; i++) {
    switch (below(5)) {
      case 0:
        bytes[below((uint32_t)len)] ^= (unsigned char)(1u << below(8));
        break;
      case 1:
        bytes[below((uint32_t)len)] = (unsigned char)next();
        break;
      case 2: {
        static const uint32_t EDGE[] = {0, 1, 3, 4, 0x7FFFFFFF, 0x80000000u, 0xFFFFFFFFu, 80, 132, 24, 28};
        uint32_t at = below((uint32_t)(len >= 4 ? len - 3 : 1)) & ~3u;
        if (at + 4 <= len) memcpy(bytes + at, &EDGE[below(sizeof EDGE / sizeof EDGE[0])], 4);
        break;
      }
      case 3: {
        uint32_t size = below(2) ? (uint32_t)next() : below(200);
        if (len >= 8) memcpy(bytes + 4, &size, 4); /* msgh_size */
        break;
      }
      default: {
        uint16_t slot = (uint16_t)below(6);
        size_t at = offsetof(gxf_frame_msg, payload) + offsetof(gxf_frame_payload, slot);
        if (at + 2 <= len) memcpy(bytes + at, &slot, 2);
        break;
      }
    }
  }
}

int main(int argc, char** argv) {
  long iterations = argc > 1 ? strtol(argv[1], NULL, 10) : 100000;
  long accepted = 0, refused = 0, parsed = 0;
  long by_code[GXF_E_COUNT] = {0};
  gxf_state st;
  gxf_state_init(&st, GXF_DEFAULT_MAX_FPS, GXF_DEFAULT_BURST);
  st.peer_pid = PEER;
  gxf_ring_expect ring;
  gxf_ring_expect_init(&ring, 1, W, H, 3, W * 4);
  gxf_state_set_ring(&st, &ring);
  uint32_t generation = 1;
  uint64_t seq = 0, now = 0;

  for (long it = 0; it < iterations; it++) {
    /* Mostly a game-like clock; every 1000 iterations a 50-iteration burst at one instant. */
    const int burst = (it / 50) % 20 == 0;
    if (!burst) now += below(4) ? below(20000) : 0;
    /* Sometimes reset (with or without a ring), resize or release so the state keeps moving. */
    if (st.fault != GXF_OK || below(64) == 0) {
      gxf_state_init(&st, GXF_DEFAULT_MAX_FPS, GXF_DEFAULT_BURST);
      st.peer_pid = PEER;
      generation = 1;
      gxf_ring_expect_init(&ring, generation, W, H, 1 + below(3), W * 4);
      if (below(16)) gxf_state_set_ring(&st, &ring);
    } else if (below(32) == 0 && st.has_ring) {
      gxf_ring_expect_init(&ring, ++generation, W, H, 1 + below(3), W * 4);
      gxf_state_set_ring(&st, &ring);
    }
    if (below(2)) {
      const uint16_t s = (uint16_t)below(4);
      const uint64_t held = s < GXF_MAX_SLOTS ? st.slots[s].held_seq : 0;
      gxf_state_release(&st, generation - below(2), s, below(4) ? held : next());
    }
    if (burst) {
      for (uint16_t s = 0; s < GXF_MAX_SLOTS; s++) gxf_state_release(&st, generation, s, st.slots[s].held_seq);
    }

    gxf_receive_buffer b;
    size_t len;
    if (below(5) == 0 && !burst) {
      len = below(sizeof b + 16);
      for (size_t i = 0; i < sizeof b; i++) ((unsigned char*)&b)[i] = (unsigned char)next();
    } else {
      make_valid(&b, (uint16_t)below(3), generation - (below(16) == 0), ++seq);
      len = below(8) || burst ? sizeof b : below(sizeof b + 1);
      if (below(4) && !burst) mutate((unsigned char*)&b, sizeof b);
    }
    unsigned char* exact = malloc(len == 0 ? 1 : len);
    memcpy(exact, &b, len < sizeof b ? len : sizeof b);

    gxf_frame_meta m = {0};
    gxf_code c = gxf_parse(exact, len, &m);
    if (c == GXF_OK) {
      parsed++;
      c = gxf_check_frame(&st, &m, now);
    }
    gxf_surface_info info = random_info();
    if (burst) {
      info.width = W, info.height = H, info.pixel_format = GXF_PIXEL_FORMAT_BGRA, info.plane_count = 0;
      info.bytes_per_element = 4, info.element_width = info.element_height = 1;
      info.bytes_per_row = W * 4, info.alloc_size = (uint64_t)W * 4 * H, info.surface_id = 100 + m.slot;
    }
    if (c == GXF_OK) c = gxf_check_surface(&st, &m, &info);
    if (c == GXF_OK) {
      /* Invariants of an accepted frame. */
      if (!st.has_ring || m.slot >= st.ring.slots || info.width != W || info.height != H ||
          m.generation != st.ring.generation || info.pixel_format != GXF_PIXEL_FORMAT_BGRA ||
          info.alloc_size > st.ring.max_alloc || st.slots[m.slot].held) {
        fprintf(stderr, "invariant broken at iteration %ld\n", it);
        return 1;
      }
      gxf_commit_frame(&st, &m, &info);
      accepted++;
    } else {
      if ((unsigned)c >= GXF_E_COUNT) {
        fprintf(stderr, "code out of range at iteration %ld\n", it);
        return 1;
      }
      by_code[c]++;
      gxf_state_refuse(&st, c);
      refused++;
    }
    free(exact);

    uint32_t held = 0, bound_ids[GXF_MAX_SLOTS] = {0}, bound = 0;
    for (uint32_t s = 0; s < GXF_MAX_SLOTS; s++) {
      held += st.slots[s].held;
      if (st.slots[s].bound) {
        for (uint32_t k = 0; k < bound; k++) {
          if (bound_ids[k] == st.slots[s].surface_id) {
            fprintf(stderr, "one surface in two slots at iteration %ld\n", it);
            return 1;
          }
        }
        bound_ids[bound++] = st.slots[s].surface_id;
      }
      if (s >= st.ring.slots && (st.slots[s].held || st.slots[s].bound)) {
        fprintf(stderr, "slot outside the ring in use at iteration %ld\n", it);
        return 1;
      }
    }
    if (held > st.ring.slots) {
      fprintf(stderr, "more held slots than the ring at iteration %ld\n", it);
      return 1;
    }
  }
  printf("test_fuzz: %ld iterations (seed 0x9E3779B97F4A7C15): %ld parsed, %ld accepted, %ld refused\n", iterations,
         parsed, accepted, refused);
  printf("  refusals:");
  for (int c = 1; c < GXF_E_COUNT; c++) {
    if (by_code[c]) printf(" %s=%ld", gxf_code_name((gxf_code)c), by_code[c]);
  }
  printf("\n");
  return 0;
}

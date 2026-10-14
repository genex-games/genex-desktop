/* Hostile-message table for the frame parser and validator (pure: no kernel). Each row starts
 * from a valid frame, changes one thing and names the typed refusal the host must give. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gxf_validate.h"

#define PEER 4242
#define W 1280u
#define H 720u
#define GOOD_PORT 0x2203u

static int failures = 0;
static int checks = 0;

#define EXPECT_CODE(got, want, label)                                                                    \
  do {                                                                                                   \
    checks++;                                                                                            \
    gxf_code got_ = (got), want_ = (want);                                                               \
    if (got_ != want_) {                                                                                 \
      failures++;                                                                                        \
      fprintf(stderr, "FAIL %s: got %s, want %s\n", (label), gxf_code_name(got_), gxf_code_name(want_)); \
    }                                                                                                    \
  } while (0)

#define EXPECT_TRUE(cond, label)                      \
  do {                                                \
    checks++;                                         \
    if (!(cond)) {                                    \
      failures++;                                     \
      fprintf(stderr, "FAIL %s: %s\n", label, #cond); \
    }                                                 \
  } while (0)

static uint64_t round_up(uint64_t v, uint64_t to) { return (v + to - 1) / to * to; }

static void make_valid(gxf_receive_buffer* b, uint16_t slot, uint32_t generation, uint64_t seq) {
  memset(b, 0, sizeof *b);
  b->msg.header.msgh_bits = MACH_MSGH_BITS_SET(0, MACH_MSG_TYPE_PORT_SEND, 0, MACH_MSGH_BITS_COMPLEX);
  b->msg.header.msgh_size = sizeof(gxf_frame_msg);
  b->msg.header.msgh_local_port = 0x1103;
  b->msg.header.msgh_id = GXF_MSG_ID_FRAME;
  b->msg.body.msgh_descriptor_count = 1;
  b->msg.surface.name = GOOD_PORT;
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
  b->msg.payload.ts_us = 1;
  b->trailer.msgh_trailer_type = MACH_MSG_TRAILER_FORMAT_0;
  b->trailer.msgh_trailer_size = sizeof(mach_msg_audit_trailer_t);
  b->trailer.msgh_audit.val[5] = PEER;
}

static gxf_surface_info good_info(uint32_t surface_id) {
  gxf_surface_info info;
  memset(&info, 0, sizeof info);
  info.surface_id = surface_id;
  info.width = W;
  info.height = H;
  info.pixel_format = GXF_PIXEL_FORMAT_BGRA;
  info.plane_count = 0;
  info.bytes_per_element = 4;
  info.element_width = 1;
  info.element_height = 1;
  info.bytes_per_row = W * 4;
  info.alloc_size = round_up((uint64_t)W * 4 * H, 16384);
  return info;
}

static void fresh_state(gxf_state* st, uint32_t slots) {
  gxf_state_init(st, 240, 6);
  st->peer_pid = PEER;
  gxf_ring_expect ring;
  gxf_ring_error e = gxf_ring_expect_init(&ring, 1, W, H, slots, W * 4);
  if (e != GXF_RING_OK || gxf_state_set_ring(st, &ring) != GXF_RING_OK) {
    fprintf(stderr, "setup failed\n");
    exit(2);
  }
}

/* parse -> check_frame -> check_surface -> commit; the first refusal (recorded in the state). */
static gxf_code run_one(gxf_state* st, const gxf_receive_buffer* b, size_t len, const gxf_surface_info* info,
                        uint64_t now) {
  gxf_frame_meta m;
  gxf_code c = gxf_parse(b, len, &m);
  if (c == GXF_OK) c = gxf_check_frame(st, &m, now);
  if (c == GXF_OK) c = gxf_check_surface(st, &m, info);
  if (c == GXF_OK) {
    gxf_commit_frame(st, &m, info);
    return GXF_OK;
  }
  gxf_state_refuse(st, c);
  return c;
}

/* ---- message-level rows: one mutation of a valid message ---- */
typedef struct msg_case {
  const char* name;
  void (*mutate)(gxf_receive_buffer*);
  size_t len; /* 0 = the whole receive buffer */
  gxf_code want;
} msg_case;

static void m_none(gxf_receive_buffer* b) { (void)b; }
static void m_size_beyond(gxf_receive_buffer* b) { b->msg.header.msgh_size = sizeof *b + 4; }
static void m_size_below_header(gxf_receive_buffer* b) { b->msg.header.msgh_size = 8; }
static void m_size_header_only(gxf_receive_buffer* b) { b->msg.header.msgh_size = sizeof(mach_msg_header_t); }
static void m_size_plus4(gxf_receive_buffer* b) { b->msg.header.msgh_size += 4; }
static void m_size_minus4(gxf_receive_buffer* b) { b->msg.header.msgh_size -= 4; }
static void m_size_huge(gxf_receive_buffer* b) { b->msg.header.msgh_size = 0xFFFFFFF0u; }
static void m_msg_id(gxf_receive_buffer* b) { b->msg.header.msgh_id = GXF_MSG_ID_FRAME + 1; }
static void m_msg_id_zero(gxf_receive_buffer* b) { b->msg.header.msgh_id = 0; }
static void m_reply_port(gxf_receive_buffer* b) {
  b->msg.header.msgh_bits =
      MACH_MSGH_BITS_SET(MACH_MSG_TYPE_PORT_SEND_ONCE, MACH_MSG_TYPE_PORT_SEND, 0, MACH_MSGH_BITS_COMPLEX);
  b->msg.header.msgh_remote_port = 0x3303;
}
static void m_reply_name_only(gxf_receive_buffer* b) { b->msg.header.msgh_remote_port = 0x3303; }
static void m_voucher(gxf_receive_buffer* b) {
  b->msg.header.msgh_bits =
      MACH_MSGH_BITS_SET(0, MACH_MSG_TYPE_PORT_SEND, MACH_MSG_TYPE_MOVE_SEND, MACH_MSGH_BITS_COMPLEX);
  b->msg.header.msgh_voucher_port = 0x4403;
}
static void m_not_complex(gxf_receive_buffer* b) { b->msg.header.msgh_bits &= ~MACH_MSGH_BITS_COMPLEX; }
static void m_zero_descriptors(gxf_receive_buffer* b) { b->msg.body.msgh_descriptor_count = 0; }
static void m_two_descriptors(gxf_receive_buffer* b) { b->msg.body.msgh_descriptor_count = 2; }
static void m_huge_descriptors(gxf_receive_buffer* b) { b->msg.body.msgh_descriptor_count = 0xFFFFFFFFu; }
static void m_ool(gxf_receive_buffer* b) { b->msg.surface.type = MACH_MSG_OOL_DESCRIPTOR; }
static void m_ool_ports(gxf_receive_buffer* b) { b->msg.surface.type = MACH_MSG_OOL_PORTS_DESCRIPTOR; }
static void m_send_once(gxf_receive_buffer* b) { b->msg.surface.disposition = MACH_MSG_TYPE_PORT_SEND_ONCE; }
static void m_receive_right(gxf_receive_buffer* b) { b->msg.surface.disposition = MACH_MSG_TYPE_PORT_RECEIVE; }
static void m_null_port(gxf_receive_buffer* b) { b->msg.surface.name = MACH_PORT_NULL; }
static void m_dead_port(gxf_receive_buffer* b) { b->msg.surface.name = MACH_PORT_DEAD; }
static void m_trailer_type(gxf_receive_buffer* b) { b->trailer.msgh_trailer_type = 7; }
static void m_trailer_short(gxf_receive_buffer* b) { b->trailer.msgh_trailer_size = 8; }
static void m_magic(gxf_receive_buffer* b) { b->msg.payload.magic ^= 1u; }
static void m_version(gxf_receive_buffer* b) { b->msg.payload.version = 2; }

static const msg_case MSG_CASES[] = {
    {"valid", m_none, 0, GXF_OK},
    {"buffer shorter than a header", m_none, 10, GXF_E_TRUNCATED},
    {"empty buffer", m_none, 0x7FFFFFFF, GXF_OK}, /* replaced below: len 0 */
    {"msgh_size beyond the buffer", m_size_beyond, 0, GXF_E_TRUNCATED},
    {"msgh_size huge", m_size_huge, 0, GXF_E_TRUNCATED},
    {"msgh_size below a header", m_size_below_header, 0, GXF_E_WRONG_SIZE},
    {"header-only message", m_size_header_only, 0, GXF_E_WRONG_SIZE},
    {"msgh_size + 4", m_size_plus4, 0, GXF_E_WRONG_SIZE},
    {"msgh_size - 4", m_size_minus4, 0, GXF_E_WRONG_SIZE},
    {"wrong msgh_id", m_msg_id, 0, GXF_E_WRONG_MSG_ID},
    {"msgh_id zero", m_msg_id_zero, 0, GXF_E_WRONG_MSG_ID},
    {"reply port", m_reply_port, 0, GXF_E_BAD_HEADER},
    {"reply port name without bits", m_reply_name_only, 0, GXF_E_BAD_HEADER},
    {"voucher", m_voucher, 0, GXF_E_BAD_HEADER},
    {"simple message (missing port)", m_not_complex, 0, GXF_E_MISSING_PORT},
    {"complex with no descriptor", m_zero_descriptors, 0, GXF_E_MISSING_PORT},
    {"two descriptors", m_two_descriptors, 0, GXF_E_BAD_DESCRIPTOR},
    {"descriptor count 2^32-1", m_huge_descriptors, 0, GXF_E_BAD_DESCRIPTOR},
    {"out-of-line memory descriptor", m_ool, 0, GXF_E_BAD_DESCRIPTOR},
    {"out-of-line ports descriptor", m_ool_ports, 0, GXF_E_BAD_DESCRIPTOR},
    {"send-once right", m_send_once, 0, GXF_E_BAD_DISPOSITION},
    {"receive right", m_receive_right, 0, GXF_E_BAD_DISPOSITION},
    {"null port name", m_null_port, 0, GXF_E_MISSING_PORT},
    {"dead port name", m_dead_port, 0, GXF_E_MISSING_PORT},
    {"wrong trailer type", m_trailer_type, 0, GXF_E_BAD_TRAILER},
    {"short trailer", m_trailer_short, 0, GXF_E_BAD_TRAILER},
    {"no room for the trailer", m_none, sizeof(gxf_frame_msg) + 8, GXF_E_BAD_TRAILER},
    {"bad magic", m_magic, 0, GXF_E_BAD_MAGIC},
    {"wire version 2", m_version, 0, GXF_E_BAD_MAGIC},
};

static void test_message_table(void) {
  for (size_t i = 0; i < sizeof MSG_CASES / sizeof MSG_CASES[0]; i++) {
    const msg_case* c = &MSG_CASES[i];
    gxf_receive_buffer b;
    make_valid(&b, 0, 1, 1);
    c->mutate(&b);
    size_t len = c->len == 0 ? sizeof b : c->len;
    gxf_code want = c->want;
    if (c->len == 0x7FFFFFFF) {
      len = 0;
      want = GXF_E_TRUNCATED;
    }
    /* Copy into an exact-size heap block so ASan sees any read past `len`. */
    unsigned char* exact = malloc(len == 0 ? 1 : len);
    memcpy(exact, &b, len < sizeof b ? len : sizeof b);
    gxf_frame_meta m;
    EXPECT_CODE(gxf_parse(exact, len, &m), want, c->name);
    free(exact);
  }
  gxf_frame_meta m;
  EXPECT_CODE(gxf_parse(NULL, 100, &m), GXF_E_TRUNCATED, "null buffer");
}

/* ---- frame-level rows: one change to the message or to the surface metadata ---- */
typedef struct frame_case {
  const char* name;
  void (*mutate_msg)(gxf_receive_buffer*);
  void (*mutate_info)(gxf_surface_info*);
  void (*mutate_state)(gxf_state*);
  gxf_code want;
} frame_case;

static void s_no_peer(gxf_state* st) { st->peer_pid = 0; }
static void s_no_ring(gxf_state* st) {
  gxf_state_init(st, 240, 6);
  st->peer_pid = PEER;
}
static void s_two_slots(gxf_state* st) { st->ring.slots = 2; }
static void s_generation_2(gxf_state* st) {
  gxf_ring_expect ring;
  gxf_ring_expect_init(&ring, 2, W, H, 3, W * 4);
  gxf_state_set_ring(st, &ring);
}
static void f_foreign(gxf_receive_buffer* b) { b->trailer.msgh_audit.val[5] = 999; }
static void f_gen0(gxf_receive_buffer* b) { b->msg.payload.generation = 0; }
static void f_gen_future(gxf_receive_buffer* b) { b->msg.payload.generation = 2; }
static void f_slot3(gxf_receive_buffer* b) { b->msg.payload.slot = 3; }
static void f_slot_max(gxf_receive_buffer* b) { b->msg.payload.slot = 0xFFFF; }
static void f_slot2(gxf_receive_buffer* b) { b->msg.payload.slot = 2; }
static void f_width(gxf_receive_buffer* b) { b->msg.payload.width = W + 1; }
static void f_height(gxf_receive_buffer* b) { b->msg.payload.height = 4096; }
static void f_format(gxf_receive_buffer* b) { b->msg.payload.pixel_format = 0x52474241u; /* 'RGBA' */ }
static void f_seq_max(gxf_receive_buffer* b) { b->msg.payload.seq = GXF_MAX_SEQ + 1; }
static void i_narrow(gxf_surface_info* i) { i->width = W - 1; }
static void i_tall(gxf_surface_info* i) { i->height = H + 1; }
static void i_rgba(gxf_surface_info* i) { i->pixel_format = 0x52474241u; }
static void i_planar(gxf_surface_info* i) { i->plane_count = 2; }
static void i_bpe2(gxf_surface_info* i) { i->bytes_per_element = 2; }
static void i_element(gxf_surface_info* i) { i->element_width = 2; }
static void i_row_short(gxf_surface_info* i) { i->bytes_per_row = W * 4 - 4; }
static void i_row_padded(gxf_surface_info* i) { i->bytes_per_row = W * 4 + 4096; }
static void i_alloc_short(gxf_surface_info* i) { i->alloc_size = (uint64_t)W * 4 * H - 1; }
static void i_alloc_huge(gxf_surface_info* i) { i->alloc_size = 1ull << 30; }
static void i_alloc_over_slack(gxf_surface_info* i) {
  i->alloc_size = round_up((uint64_t)W * 4 * H, GXF_ALLOC_SLACK) + 1;
}
static void i_alloc_at_slack(gxf_surface_info* i) { i->alloc_size = round_up((uint64_t)W * 4 * H, GXF_ALLOC_SLACK); }

static const frame_case FRAME_CASES[] = {
    {"valid frame", NULL, NULL, NULL, GXF_OK},
    {"foreign sender pid", f_foreign, NULL, NULL, GXF_E_FOREIGN_SENDER},
    {"no peer set", NULL, NULL, s_no_peer, GXF_E_FOREIGN_SENDER},
    {"frame before any ring", NULL, NULL, s_no_ring, GXF_E_NO_RING},
    {"generation 0", f_gen0, NULL, NULL, GXF_E_BAD_GENERATION},
    {"generation the host never chose", f_gen_future, NULL, NULL, GXF_E_BAD_GENERATION},
    {"stale generation after a resize", NULL, NULL, s_generation_2, GXF_E_STALE_GENERATION},
    {"slot 3 (a 4th slot)", f_slot3, NULL, NULL, GXF_E_UNKNOWN_SLOT},
    {"slot 65535", f_slot_max, NULL, NULL, GXF_E_UNKNOWN_SLOT},
    {"slot 2 of a 2-slot ring", f_slot2, NULL, s_two_slots, GXF_E_UNKNOWN_SLOT},
    {"payload width", f_width, NULL, NULL, GXF_E_SIZE_MISMATCH},
    {"payload height", f_height, NULL, NULL, GXF_E_SIZE_MISMATCH},
    {"payload format RGBA", f_format, NULL, NULL, GXF_E_FORMAT_MISMATCH},
    {"seq 2^53", f_seq_max, NULL, NULL, GXF_E_BAD_SEQ},
    {"surface narrower than announced", NULL, i_narrow, NULL, GXF_E_SIZE_MISMATCH},
    {"surface taller than announced", NULL, i_tall, NULL, GXF_E_SIZE_MISMATCH},
    {"surface format RGBA", NULL, i_rgba, NULL, GXF_E_FORMAT_MISMATCH},
    {"planar surface", NULL, i_planar, NULL, GXF_E_FORMAT_MISMATCH},
    {"2 bytes per element", NULL, i_bpe2, NULL, GXF_E_FORMAT_MISMATCH},
    {"2x1 elements", NULL, i_element, NULL, GXF_E_FORMAT_MISMATCH},
    {"row bytes short", NULL, i_row_short, NULL, GXF_E_ALLOC_MISMATCH},
    {"row bytes padded", NULL, i_row_padded, NULL, GXF_E_ALLOC_MISMATCH},
    {"allocation short", NULL, i_alloc_short, NULL, GXF_E_ALLOC_MISMATCH},
    {"allocation 1 GiB (oversize)", NULL, i_alloc_huge, NULL, GXF_E_ALLOC_MISMATCH},
    {"allocation one byte over the slack", NULL, i_alloc_over_slack, NULL, GXF_E_ALLOC_MISMATCH},
    {"allocation at the slack bound", NULL, i_alloc_at_slack, NULL, GXF_OK},
};

static void test_frame_table(void) {
  for (size_t i = 0; i < sizeof FRAME_CASES / sizeof FRAME_CASES[0]; i++) {
    const frame_case* c = &FRAME_CASES[i];
    gxf_state st;
    fresh_state(&st, 3);
    if (c->mutate_state) c->mutate_state(&st);
    gxf_receive_buffer b;
    make_valid(&b, 0, 1, 1);
    if (c->mutate_msg) c->mutate_msg(&b);
    gxf_surface_info info = good_info(10);
    if (c->mutate_info) c->mutate_info(&info);
    gxf_code got = run_one(&st, &b, sizeof b, &info, 1000);
    EXPECT_CODE(got, c->want, c->name);
    if (c->want != GXF_OK) {
      const int fatal = gxf_code_is_fatal(c->want);
      char label[160];
      snprintf(label, sizeof label, "%s: fault recorded only when fatal", c->name);
      EXPECT_TRUE((st.fault != GXF_OK) == fatal, label);
      snprintf(label, sizeof label, "%s: no slot held", c->name);
      EXPECT_TRUE(!st.slots[0].held && st.counters.accepted == 0, label);
    }
  }
}

/* ---- sequences ---- */
static void test_sequences(void) {
  gxf_state st;
  gxf_receive_buffer b;
  gxf_surface_info i10 = good_info(10), i11 = good_info(11), i12 = good_info(12), i13 = good_info(13);

  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 1);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_OK, "busy: first frame");
  make_valid(&b, 0, 1, 2);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_E_SLOT_BUSY, "busy: same slot before release");

  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 5);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_OK, "seq: 5");
  make_valid(&b, 1, 1, 5);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i11, 0), GXF_E_BAD_SEQ, "seq: repeated");
  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 5);
  run_one(&st, &b, sizeof b, &i10, 0);
  make_valid(&b, 1, 1, 4);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i11, 0), GXF_E_BAD_SEQ, "seq: decreasing");

  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 1);
  run_one(&st, &b, sizeof b, &i10, 0);
  make_valid(&b, 1, 1, 2);
  run_one(&st, &b, sizeof b, &i11, 0);
  make_valid(&b, 2, 1, 3);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i12, 0), GXF_OK, "ring: third surface");
  EXPECT_TRUE(gxf_state_release(&st, 1, 0, 1) == 1, "ring: release slot 0");
  make_valid(&b, 0, 1, 4);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i13, 0), GXF_E_RING_OVERFLOW, "ring: a 4th surface in slot 0");

  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 1);
  run_one(&st, &b, sizeof b, &i10, 0);
  make_valid(&b, 1, 1, 2);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_E_DUPLICATE_SURFACE, "ring: one surface in two slots");

  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 1);
  run_one(&st, &b, sizeof b, &i10, 0);
  EXPECT_TRUE(gxf_state_release(&st, 1, 0, 1) == 1, "reuse: release");
  make_valid(&b, 0, 1, 2);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_OK, "reuse: same surface, same slot");

  /* A resize: the new ring rebinds slots; the old generation's frames are stale. */
  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 1);
  run_one(&st, &b, sizeof b, &i10, 0);
  gxf_ring_expect ring2;
  gxf_ring_expect_init(&ring2, 2, W, H, 3, W * 4);
  EXPECT_TRUE(gxf_state_set_ring(&st, &ring2) == GXF_RING_OK, "resize: new ring");
  make_valid(&b, 0, 2, 2);
  gxf_surface_info i20 = good_info(20);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i20, 0), GXF_OK, "resize: new surface in slot 0");
  make_valid(&b, 1, 1, 3);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i11, 0), GXF_E_STALE_GENERATION, "resize: old frame is stale");
  EXPECT_TRUE(st.fault == GXF_OK && st.counters.dropped == 1, "resize: stale frames do not fault");

  /* Faults are sticky: after a fatal refusal nothing is accepted. */
  fresh_state(&st, 3);
  make_valid(&b, 3, 1, 1);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_E_UNKNOWN_SLOT, "sticky: fatal");
  make_valid(&b, 0, 1, 2);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_E_UNKNOWN_SLOT, "sticky: a valid frame after it");
  EXPECT_TRUE(st.counters.accepted == 0, "sticky: nothing accepted");

  /* Non-fatal refusals do not fault. */
  fresh_state(&st, 3);
  make_valid(&b, 0, 1, 1);
  b.trailer.msgh_audit.val[5] = 999;
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_E_FOREIGN_SENDER, "foreign: dropped");
  make_valid(&b, 0, 1, 1);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &i10, 0), GXF_OK, "foreign: the game still sends");
}

static void test_rate(void) {
  gxf_state st;
  gxf_state_init(&st, 60, 3);
  st.peer_pid = PEER;
  gxf_ring_expect ring;
  gxf_ring_expect_init(&ring, 1, W, H, 3, W * 4);
  gxf_state_set_ring(&st, &ring);
  gxf_receive_buffer b;
  gxf_surface_info info = good_info(10);
  for (uint64_t seq = 1; seq <= 3; seq++) {
    make_valid(&b, 0, 1, seq);
    EXPECT_CODE(run_one(&st, &b, sizeof b, &info, 0), GXF_OK, "rate: within the burst");
    gxf_state_release(&st, 1, 0, seq);
  }
  make_valid(&b, 0, 1, 4);
  EXPECT_CODE(run_one(&st, &b, sizeof b, &info, 10), GXF_E_RATE, "rate: a burst over the cap");
  EXPECT_TRUE(st.fault == GXF_E_RATE, "rate: fatal");

  gxf_rate r = {60, 3, 0, 0, 0};
  EXPECT_TRUE(gxf_rate_take(&r, 0) && gxf_rate_take(&r, 0) && gxf_rate_take(&r, 0), "bucket: burst of 3");
  EXPECT_TRUE(!gxf_rate_take(&r, 0), "bucket: empty");
  EXPECT_TRUE(!gxf_rate_take(&r, 16666), "bucket: not yet refilled at 16.666 ms");
  EXPECT_TRUE(gxf_rate_take(&r, 16667 + 16666), "bucket: one token per 1/60 s");
  EXPECT_TRUE(!gxf_rate_take(&r, 16667 + 16666), "bucket: and only one");
  EXPECT_TRUE(gxf_rate_take(&r, 10000000) && gxf_rate_take(&r, 10000000) && gxf_rate_take(&r, 10000000) &&
                  !gxf_rate_take(&r, 10000000),
              "bucket: idle refills to the burst, not more");
  EXPECT_TRUE(!gxf_rate_take(&r, 5), "bucket: a clock going backwards adds nothing");
  gxf_rate big = {10000, 64, 0, 0, 0};
  gxf_rate_take(&big, 0);
  EXPECT_TRUE(gxf_rate_take(&big, UINT64_MAX), "bucket: no overflow at the end of time");
}

static void test_release(void) {
  gxf_state st;
  gxf_receive_buffer b;
  gxf_surface_info info = good_info(10);
  fresh_state(&st, 3);
  EXPECT_TRUE(gxf_state_release(&st, 1, 0, 0) == 0, "release: not held");
  make_valid(&b, 1, 1, 5);
  run_one(&st, &b, sizeof b, &info, 0);
  EXPECT_TRUE(gxf_state_release(&st, 2, 1, 5) == 0, "release: wrong generation");
  EXPECT_TRUE(gxf_state_release(&st, 1, 7, 5) == 0, "release: unknown slot");
  EXPECT_TRUE(gxf_state_release(&st, 1, 1, 4) == 0, "release: another frame's seq");
  EXPECT_TRUE(gxf_state_release(&st, 1, 1, 5) == 1, "release: held by this frame");
  EXPECT_TRUE(gxf_state_release(&st, 1, 1, 5) == 0, "release: twice");
  /* A stale release (frame 5) must not free the slot when frame 6 holds it again. */
  make_valid(&b, 1, 1, 6);
  run_one(&st, &b, sizeof b, &info, 0);
  EXPECT_TRUE(gxf_state_release(&st, 1, 1, 5) == 0 && st.slots[1].held,
              "release: a stale release keeps the newer frame");
  EXPECT_TRUE(st.counters.released == 1, "release: counted once");
}

static void test_ring_announcements(void) {
  gxf_ring_expect r;
  EXPECT_TRUE(gxf_ring_expect_init(&r, 0, W, H, 3, W * 4) == GXF_RING_BAD_GENERATION, "ring: generation 0");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, 0, H, 3, 0) == GXF_RING_BAD_SIZE, "ring: width 0");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, W, 0, 3, W * 4) == GXF_RING_BAD_SIZE, "ring: height 0");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, 8193, 10, 3, 8193 * 4) == GXF_RING_BAD_SIZE, "ring: width 8193");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, 8192, 8192, 3, 8192 * 4) == GXF_RING_BAD_SIZE, "ring: 64 Mpx");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, W, H, 0, W * 4) == GXF_RING_BAD_SLOTS, "ring: 0 slots");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, W, H, 4, W * 4) == GXF_RING_BAD_SLOTS, "ring: 4 slots");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, W, H, 3, W * 4 + 8192) == GXF_RING_BAD_SIZE, "ring: absurd alignment");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, 1, 1, 1, 128) == GXF_RING_OK, "ring: 1x1");
  EXPECT_TRUE(r.max_alloc == GXF_ALLOC_SLACK, "ring: 1x1 allocation bound");
  EXPECT_TRUE(gxf_ring_expect_init(&r, 1, 8192, 4096, 3, 8192 * 4) == GXF_RING_OK, "ring: 32 Mpx");
  gxf_state st;
  fresh_state(&st, 3);
  gxf_ring_expect_init(&r, 1, W, H, 3, W * 4);
  EXPECT_TRUE(gxf_state_set_ring(&st, &r) == GXF_RING_BAD_GENERATION, "ring: generation not increasing");
}

static void test_code_names(void) {
  int non_fatal = 0;
  for (int i = 1; i < GXF_E_COUNT; i++) {
    const char* name = gxf_code_name((gxf_code)i);
    EXPECT_TRUE(name != NULL && strcmp(name, "unknown") != 0, "codes: named");
    for (int j = 1; j < i; j++) EXPECT_TRUE(strcmp(name, gxf_code_name((gxf_code)j)) != 0, "codes: distinct");
    if (!gxf_code_is_fatal((gxf_code)i)) non_fatal++;
  }
  EXPECT_TRUE(non_fatal == 2, "codes: only foreign-sender and stale-generation are not fatal");
  EXPECT_TRUE(strcmp(gxf_code_name((gxf_code)999), "unknown") == 0, "codes: out of range");
}

int main(void) {
  test_message_table();
  test_frame_table();
  test_sequences();
  test_rate();
  test_release();
  test_ring_announcements();
  test_code_names();
  printf("test_validate: %d checks, %d failures (%zu message rows, %zu frame rows)\n", checks, failures,
         sizeof MSG_CASES / sizeof MSG_CASES[0], sizeof FRAME_CASES / sizeof FRAME_CASES[0]);
  return failures == 0 ? 0 : 1;
}

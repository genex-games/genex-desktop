/*
 * Genex frames wire format (macOS): one mach message per finished frame, sent by the game to the
 * per-run service `games.genex.frames.<runId>` that Genex main checked in. The message moves one
 * send right to the frame's IOSurface; the payload repeats what the host announced for the ring
 * so both sides are checked. Shared by the game-side sender library and the host addon.
 */
#ifndef GXF_WIRE_H
#define GXF_WIRE_H

#include <mach/message.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Service-name prefix; the run id follows (charset [A-Za-z0-9-], 8 to 64 characters). */
#define GXF_SERVICE_PREFIX "games.genex.frames."
#define GXF_RUN_ID_MIN 8
#define GXF_RUN_ID_MAX 64

/** `msgh_id` of a frame message ('GXF1'). */
#define GXF_MSG_ID_FRAME 0x47584631
/** Payload magic ('GENX') and wire version. */
#define GXF_MAGIC 0x47454e58u
#define GXF_WIRE_VERSION 1u

/** The ring never has more than three slots. */
#define GXF_MAX_SLOTS 3u
/** The only pixel format: 'BGRA' (kCVPixelFormatType_32BGRA), 4 bytes per pixel, one plane. */
#define GXF_PIXEL_FORMAT_BGRA 0x42475241u
#define GXF_BYTES_PER_PIXEL 4u

/** Ring size ceilings the host enforces (a side and the whole surface). */
#define GXF_MAX_SIDE 8192u
#define GXF_MAX_PIXELS 33554432u /* 32 Mpx: 128 MiB per slot */

/** Sequence numbers stay below 2^53 so JavaScript numbers carry them exactly. */
#define GXF_MAX_SEQ 9007199254740991ull

#pragma pack(push, 4)
/** What the game says about the frame. Every field is checked; none is trusted. */
typedef struct gxf_frame_payload {
  uint32_t magic;        /* GXF_MAGIC */
  uint16_t version;      /* GXF_WIRE_VERSION */
  uint16_t slot;         /* 0 .. slots-1 of the announced ring */
  uint32_t generation;   /* the ring generation the host chose in the `surface` op */
  uint32_t width;        /* the announced ring width */
  uint32_t height;       /* the announced ring height */
  uint32_t pixel_format; /* GXF_PIXEL_FORMAT_BGRA */
  uint64_t seq;          /* strictly increasing per run, below GXF_MAX_SEQ */
  uint64_t ts_us;        /* game clock (CLOCK_REALTIME microseconds); a diagnostic only */
} gxf_frame_payload;

/** The complete frame message as sent: header, one port descriptor, payload. */
typedef struct gxf_frame_msg {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  gxf_frame_payload payload;
} gxf_frame_msg;
#pragma pack(pop)

#ifdef __cplusplus
static_assert(sizeof(gxf_frame_payload) == 40, "payload layout");
static_assert(sizeof(gxf_frame_msg) == 80, "message layout");
#else
_Static_assert(sizeof(gxf_frame_payload) == 40, "payload layout");
_Static_assert(sizeof(gxf_frame_msg) == 80, "message layout");
#endif

#ifdef __cplusplus
}
#endif

#endif

/*
 * Game-side frames sender (macOS). The headless raylib platform uses it the way the test sender
 * does: create the ring the host asked for in the `surface` op, render into a free slot, send it,
 * wait for the host's `release` before drawing into that slot again. It never needs anything the
 * headless+frames game profile does not grant: IOSurfaceRootUserClient and one mach-lookup.
 */
#ifndef GXF_SENDER_H
#define GXF_SENDER_H

#include <IOSurface/IOSurfaceRef.h>
#include <mach/mach.h>
#include <stdint.h>

#include "gxf_wire.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct gxf_sender {
  mach_port_t service;
} gxf_sender;

typedef struct gxf_ring {
  uint32_t generation;
  uint32_t width;
  uint32_t height;
  uint32_t slots;
  IOSurfaceRef surfaces[GXF_MAX_SLOTS];
} gxf_ring;

/** Looks up the per-run service; BOOTSTRAP_UNKNOWN_SERVICE (1102) or a sandbox denial (1100)
 * when the name is not this run's. */
kern_return_t gxf_sender_connect(gxf_sender* sender, const char* service_name);
void gxf_sender_disconnect(gxf_sender* sender);

/** Creates `slots` one-plane BGRA8 IOSurfaces of width x height. 0 on success, -1 for bad
 * arguments, -2 when IOSurfaceCreate fails. */
int gxf_ring_create(gxf_ring* ring, uint32_t generation, uint32_t width, uint32_t height, uint32_t slots);
void gxf_ring_destroy(gxf_ring* ring);

/** Sends `slot` as frame `seq`. The slot belongs to Genex until it is released. */
kern_return_t gxf_send_frame(const gxf_sender* sender, const gxf_ring* ring, uint32_t slot, uint64_t seq,
                             uint64_t ts_us, mach_msg_timeout_t timeout_ms);

/** Sends one frame message with an explicit surface and payload (tests and hostile modes). */
kern_return_t gxf_send_surface(const gxf_sender* sender, IOSurfaceRef surface, const gxf_frame_payload* payload,
                               mach_msg_timeout_t timeout_ms);

/** Fills a payload for `ring`. */
void gxf_payload_for(gxf_frame_payload* payload, const gxf_ring* ring, uint32_t slot, uint64_t seq, uint64_t ts_us);

/** CLOCK_REALTIME in microseconds (comparable with the host's receivedAt). */
uint64_t gxf_realtime_us(void);

#ifdef __cplusplus
}
#endif

#endif

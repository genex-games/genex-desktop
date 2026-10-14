#include "gxf_sender.h"

#include <CoreFoundation/CoreFoundation.h>
#include <servers/bootstrap.h>
#include <string.h>
#include <time.h>

uint64_t gxf_realtime_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u;
}

kern_return_t gxf_sender_connect(gxf_sender* sender, const char* service_name) {
  sender->service = MACH_PORT_NULL;
  return bootstrap_look_up(bootstrap_port, service_name, &sender->service);
}

void gxf_sender_disconnect(gxf_sender* sender) {
  if (sender->service != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), sender->service);
  sender->service = MACH_PORT_NULL;
}

static void set_number(CFMutableDictionaryRef dict, CFStringRef key, int32_t value) {
  CFNumberRef number = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &value);
  CFDictionarySetValue(dict, key, number);
  CFRelease(number);
}

static IOSurfaceRef create_surface(uint32_t width, uint32_t height) {
  CFMutableDictionaryRef props = CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
                                                           &kCFTypeDictionaryValueCallBacks);
  if (props == NULL) return NULL;
  set_number(props, kIOSurfaceWidth, (int32_t)width);
  set_number(props, kIOSurfaceHeight, (int32_t)height);
  set_number(props, kIOSurfaceBytesPerElement, (int32_t)GXF_BYTES_PER_PIXEL);
  set_number(props, kIOSurfacePixelFormat, (int32_t)GXF_PIXEL_FORMAT_BGRA);
  IOSurfaceRef surface = IOSurfaceCreate(props);
  CFRelease(props);
  return surface;
}

int gxf_ring_create(gxf_ring* ring, uint32_t generation, uint32_t width, uint32_t height, uint32_t slots) {
  memset(ring, 0, sizeof *ring);
  if (generation == 0 || slots == 0 || slots > GXF_MAX_SLOTS) return -1;
  if (width == 0 || height == 0 || width > GXF_MAX_SIDE || height > GXF_MAX_SIDE) return -1;
  if ((uint64_t)width * height > GXF_MAX_PIXELS) return -1;
  ring->generation = generation;
  ring->width = width;
  ring->height = height;
  ring->slots = slots;
  for (uint32_t i = 0; i < slots; i++) {
    ring->surfaces[i] = create_surface(width, height);
    if (ring->surfaces[i] == NULL) {
      gxf_ring_destroy(ring);
      return -2;
    }
  }
  return 0;
}

void gxf_ring_destroy(gxf_ring* ring) {
  for (uint32_t i = 0; i < GXF_MAX_SLOTS; i++) {
    if (ring->surfaces[i] != NULL) CFRelease(ring->surfaces[i]);
    ring->surfaces[i] = NULL;
  }
  ring->slots = 0;
}

void gxf_payload_for(gxf_frame_payload* payload, const gxf_ring* ring, uint32_t slot, uint64_t seq, uint64_t ts_us) {
  memset(payload, 0, sizeof *payload);
  payload->magic = GXF_MAGIC;
  payload->version = GXF_WIRE_VERSION;
  payload->slot = (uint16_t)slot;
  payload->generation = ring->generation;
  payload->width = ring->width;
  payload->height = ring->height;
  payload->pixel_format = GXF_PIXEL_FORMAT_BGRA;
  payload->seq = seq;
  payload->ts_us = ts_us;
}

kern_return_t gxf_send_surface(const gxf_sender* sender, IOSurfaceRef surface, const gxf_frame_payload* payload,
                               mach_msg_timeout_t timeout_ms) {
  mach_port_t port = IOSurfaceCreateMachPort(surface);
  if (port == MACH_PORT_NULL) return KERN_RESOURCE_SHORTAGE;
  gxf_frame_msg msg;
  memset(&msg, 0, sizeof msg);
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
  msg.header.msgh_size = sizeof msg;
  msg.header.msgh_remote_port = sender->service;
  msg.header.msgh_id = GXF_MSG_ID_FRAME;
  msg.body.msgh_descriptor_count = 1;
  msg.surface.name = port;
  msg.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
  msg.surface.type = MACH_MSG_PORT_DESCRIPTOR;
  msg.payload = *payload;
  kern_return_t kr = mach_msg(&msg.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof msg, 0, MACH_PORT_NULL, timeout_ms,
                              MACH_PORT_NULL);
  if (kr == MACH_SEND_TIMED_OUT || kr == MACH_SEND_INTERRUPTED) {
    // Pseudo-received: the kernel copied the rights back out into `msg` (the surface right under
    // a possibly new name, plus the extra destination right), so destroy the message itself.
    mach_msg_destroy(&msg.header);
  } else if (kr != MACH_MSG_SUCCESS) {
    // Never copied in: the right is still under its original name.
    mach_port_deallocate(mach_task_self(), port);
  }
  return kr;
}

kern_return_t gxf_send_frame(const gxf_sender* sender, const gxf_ring* ring, uint32_t slot, uint64_t seq,
                             uint64_t ts_us, mach_msg_timeout_t timeout_ms) {
  if (slot >= ring->slots || ring->surfaces[slot] == NULL) return KERN_INVALID_ARGUMENT;
  gxf_frame_payload payload;
  gxf_payload_for(&payload, ring, slot, seq, ts_us);
  return gxf_send_surface(sender, ring->surfaces[slot], &payload, timeout_ms);
}

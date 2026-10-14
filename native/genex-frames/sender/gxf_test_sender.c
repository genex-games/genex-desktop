/*
 * Test sender: a stand-in for the headless raylib game in embedded play. It speaks a JSON-lines
 * subset of the fd-3 protocol and sends frames through the sender library:
 *
 *   host -> game  {"id":1,"op":"surface","arg":{"w":1280,"h":720,"generation":1,"slots":3}}
 *                 {"id":2,"op":"start","arg":{"frames":600,"fps":60}}      fps 0 = unpaced
 *                 {"id":3,"op":"release","arg":{"generation":1,"slot":0}}
 *                 {"id":4,"op":"quit"}
 *   game -> host  {"op":"ready","pid":N,"lookup":0}
 *                 {"id":1,"ok":true,"op":"surface","result":{"ring":[{"slot":0,"surfaceId":N},...]}}
 *                 {"op":"frame","seq":N,"slot":N,"ts":N,"kr":0}
 *                 {"op":"done","frames":N,"releases":N,"elapsedMs":N}
 *                 {"op":"error","step":"...","kr":N}
 *
 * Frames carry a pattern the receiver can check (pattern_pixel), stored bottom-up like ANGLE's
 * IOSurface (row 0 of memory is the bottom of the image) unless --top-down.
 *
 * Usage: gxf_test_sender --service NAME [--fd 3] [--top-down] [--hostile MODE]
 *                       [--render cpu|angle] [--sync finish|flush]
 * --render angle (only in builds with GXF_WITH_ANGLE) draws the same pattern on the GPU through
 * Metal-only ANGLE into the IOSurfaces, like the headless raylib platform; --sync picks glFinish
 * (default) or glFlush before the frame is sent.
 * Hostile modes (applied to the first frame unless noted): slot3 rgba small padded not-iosurface
 * no-port oversize wrong-id busy (slot 0 twice) fourth (a new surface for slot 0 after its first
 * release) seq (a repeated seq) generation (an unannounced generation).
 */
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "gxf_sender.h"
#ifdef GXF_WITH_ANGLE
#include "gxf_angle_render.h"
static gxf_angle* g_angle = NULL;
static gxf_angle_sync g_sync = GXF_ANGLE_SYNC_FINISH;
#endif

#define IDLE_TIMEOUT_MS 10000
#define LINE_MAX_BYTES 1024
#define SEND_TIMEOUT_MS 200

static int g_fd = 3;
static int g_top_down = 0;
static const char* g_hostile = "";
static gxf_sender g_sender;
static gxf_ring g_ring;
static int g_has_ring = 0;
static int g_held[GXF_MAX_SLOTS];
static uint64_t g_seq = 0;
static uint32_t g_target = 0, g_sent = 0, g_releases = 0, g_fps = 0;
static int g_running = 0;
static uint64_t g_started_ns = 0, g_next_ns = 0;
static IOSurfaceRef g_fourth = NULL;
static int g_slot0_uses = 0;

static uint64_t now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static void emit(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void emit(const char* fmt, ...) {
  char line[LINE_MAX_BYTES];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(line, sizeof line - 1, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if ((size_t)n > sizeof line - 2) n = (int)sizeof line - 2;
  line[n++] = '\n';
  for (int off = 0; off < n;) {
    ssize_t w = write(g_fd, line + off, (size_t)(n - off));
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) exit(5);
    off += (int)w;
  }
}

static int has_op(const char* line, const char* op) {
  char needle[64];
  snprintf(needle, sizeof needle, "\"op\":\"%s\"", op);
  return strstr(line, needle) != NULL;
}

static uint64_t number(const char* line, const char* key, uint64_t fallback) {
  char needle[64];
  snprintf(needle, sizeof needle, "\"%s\":", key);
  const char* at = strstr(line, needle);
  if (at == NULL) return fallback;
  return strtoull(at + strlen(needle), NULL, 10);
}

/* The pattern for image pixel (x, y) (y = 0 is the top) of frame `seq`, as a little-endian BGRA
 * word: bytes B, G, R, A. */
static uint32_t pattern_pixel(uint32_t x, uint32_t y, uint64_t seq) {
  uint32_t r = (x + 3u * (uint32_t)seq) & 255u;
  uint32_t g = (y + 5u * (uint32_t)seq) & 255u;
  uint32_t b = ((x >> 8) * 64u + (y >> 8) * 16u + 7u * (uint32_t)seq) & 255u;
  return (255u << 24) | (r << 16) | (g << 8) | b;
}

static void draw(IOSurfaceRef surface, uint64_t seq) {
  IOSurfaceLock(surface, 0, NULL);
  unsigned char* base = IOSurfaceGetBaseAddress(surface);
  size_t row_bytes = IOSurfaceGetBytesPerRow(surface);
  uint32_t w = (uint32_t)IOSurfaceGetWidth(surface), h = (uint32_t)IOSurfaceGetHeight(surface);
  for (uint32_t y = 0; y < h; y++) {
    uint32_t memory_row = g_top_down ? y : h - 1 - y;
    uint32_t* row = (uint32_t*)(base + (size_t)memory_row * row_bytes);
    for (uint32_t x = 0; x < w; x++) row[x] = pattern_pixel(x, y, seq);
  }
  IOSurfaceUnlock(surface, 0, NULL);
}

static IOSurfaceRef create_surface(uint32_t width, uint32_t height, uint32_t format, uint32_t row_bytes) {
  CFMutableDictionaryRef props =
      CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  int32_t values[5] = {(int32_t)width, (int32_t)height, 4, (int32_t)format, (int32_t)row_bytes};
  CFStringRef keys[5] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat,
                         kIOSurfaceBytesPerRow};
  for (int i = 0; i < (row_bytes ? 5 : 4); i++) {
    CFNumberRef n = CFNumberCreate(NULL, kCFNumberSInt32Type, &values[i]);
    CFDictionarySetValue(props, keys[i], n);
    CFRelease(n);
  }
  IOSurfaceRef s = IOSurfaceCreate(props);
  CFRelease(props);
  return s;
}

/* Hostile ring variants replace slot surfaces with wrong ones. */
static void apply_hostile_ring(void) {
  IOSurfaceRef replacement = NULL;
  if (!strcmp(g_hostile, "rgba")) replacement = create_surface(g_ring.width, g_ring.height, 0x52474241u, 0);
  if (!strcmp(g_hostile, "small"))
    replacement = create_surface(g_ring.width / 2, g_ring.height, GXF_PIXEL_FORMAT_BGRA, 0);
  if (!strcmp(g_hostile, "padded"))
    replacement = create_surface(g_ring.width, g_ring.height, GXF_PIXEL_FORMAT_BGRA, g_ring.width * 8);
  if (replacement != NULL) {
    CFRelease(g_ring.surfaces[0]);
    g_ring.surfaces[0] = replacement;
  }
  if (!strcmp(g_hostile, "fourth")) g_fourth = create_surface(g_ring.width, g_ring.height, GXF_PIXEL_FORMAT_BGRA, 0);
}

static void handle_surface(const char* line) {
  uint32_t w = (uint32_t)number(line, "w", 0), h = (uint32_t)number(line, "h", 0);
  uint32_t generation = (uint32_t)number(line, "generation", 0), slots = (uint32_t)number(line, "slots", 3);
  uint64_t id = number(line, "id", 0);
  if (g_has_ring) gxf_ring_destroy(&g_ring);
  memset(g_held, 0, sizeof g_held);
  int rc = gxf_ring_create(&g_ring, generation, w, h, slots);
  g_has_ring = rc == 0;
  if (rc != 0) {
    emit("{\"id\":%llu,\"ok\":false,\"op\":\"surface\",\"error\":\"ring %d\"}", (unsigned long long)id, rc);
    return;
  }
  apply_hostile_ring();
#ifdef GXF_WITH_ANGLE
  if (g_angle != NULL && gxf_angle_bind_ring(g_angle, &g_ring) != 0) {
    emit("{\"id\":%llu,\"ok\":false,\"op\":\"surface\",\"error\":\"angle bind\"}", (unsigned long long)id);
    return;
  }
#endif
  char ring[256] = "";
  size_t used = 0;
  for (uint32_t i = 0; i < slots; i++) {
    used += (size_t)snprintf(ring + used, sizeof ring - used, "%s{\"slot\":%u,\"surfaceId\":%u}", i ? "," : "", i,
                             IOSurfaceGetID(g_ring.surfaces[i]));
  }
  emit("{\"id\":%llu,\"ok\":true,\"op\":\"surface\",\"result\":{\"ring\":[%s]}}", (unsigned long long)id, ring);
}

static kern_return_t send_raw_header(mach_msg_header_t* h, mach_msg_size_t size) {
  h->msgh_remote_port = g_sender.service;
  h->msgh_size = size;
  return mach_msg(h, MACH_SEND_MSG | MACH_SEND_TIMEOUT, size, 0, MACH_PORT_NULL, SEND_TIMEOUT_MS, MACH_PORT_NULL);
}

/* Hostile message shapes that the sender library would never build. Returns 1 when handled. */
static int send_hostile_message(uint32_t slot, uint64_t seq, uint64_t ts, kern_return_t* kr) {
  gxf_frame_payload payload;
  gxf_payload_for(&payload, &g_ring, slot, seq, ts);
  if (!strcmp(g_hostile, "no-port")) {
    gxf_frame_msg m;
    memset(&m, 0, sizeof m);
    m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
    m.header.msgh_id = GXF_MSG_ID_FRAME;
    m.payload = payload;
    *kr = send_raw_header(&m.header, sizeof m);
    return 1;
  }
  if (!strcmp(g_hostile, "not-iosurface") || !strcmp(g_hostile, "wrong-id") || !strcmp(g_hostile, "oversize")) {
    struct {
      gxf_frame_msg m;
      unsigned char extra[4096];
    } big;
    memset(&big, 0, sizeof big);
    big.m.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
    big.m.header.msgh_id = !strcmp(g_hostile, "wrong-id") ? 0x1234 : GXF_MSG_ID_FRAME;
    big.m.body.msgh_descriptor_count = 1;
    big.m.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    big.m.payload = payload;
    if (!strcmp(g_hostile, "not-iosurface")) {
      mach_port_t plain = MACH_PORT_NULL;
      mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &plain);
      big.m.surface.name = plain;
      big.m.surface.disposition = MACH_MSG_TYPE_MAKE_SEND;
    } else {
      big.m.surface.name = IOSurfaceCreateMachPort(g_ring.surfaces[slot]);
      big.m.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    }
    *kr = send_raw_header(&big.m.header, !strcmp(g_hostile, "oversize") ? sizeof big : sizeof big.m);
    return 1;
  }
  return 0;
}

static int free_slot(void) {
  for (uint32_t i = 0; i < g_ring.slots; i++) {
    uint32_t slot = (uint32_t)((g_sent + i) % g_ring.slots);
    if (!g_held[slot]) return (int)slot;
  }
  return -1;
}

static void send_next(void) {
  int slot = free_slot();
  if (slot < 0) return;
  uint64_t seq = ++g_seq;
  int first = g_sent == 0;
  IOSurfaceRef surface = g_ring.surfaces[slot];
  if (slot == 0 && g_fourth != NULL && ++g_slot0_uses == 2) surface = g_fourth;
#ifdef GXF_WITH_ANGLE
  if (g_angle != NULL) {
    if (gxf_angle_draw(g_angle, (uint32_t)slot, seq, g_sync) != 0)
      emit("{\"op\":\"error\",\"step\":\"angle draw\",\"kr\":0}");
  } else {
    draw(surface, seq);
  }
#else
  draw(surface, seq);
#endif
  uint64_t ts = gxf_realtime_us();
  kern_return_t kr = KERN_SUCCESS;
  gxf_frame_payload payload;
  gxf_payload_for(&payload, &g_ring, (uint32_t)slot, seq, ts);
  if (first && !strcmp(g_hostile, "slot3")) payload.slot = 3;
  if (first && !strcmp(g_hostile, "generation")) payload.generation = g_ring.generation + 1;
  if (!strcmp(g_hostile, "seq") && g_sent == 1) payload.seq = seq - 1;
  if (!(first && send_hostile_message((uint32_t)slot, seq, ts, &kr))) {
    kr = gxf_send_surface(&g_sender, surface, &payload, SEND_TIMEOUT_MS);
    if (first && !strcmp(g_hostile, "busy")) {
      payload.seq = ++g_seq; /* a fresh seq, so only the slot ownership is wrong */
      gxf_send_surface(&g_sender, surface, &payload, SEND_TIMEOUT_MS);
    }
  }
  g_held[slot] = 1;
  g_sent++;
  emit("{\"op\":\"frame\",\"seq\":%llu,\"slot\":%d,\"ts\":%llu,\"kr\":%d}", (unsigned long long)seq, slot,
       (unsigned long long)ts, kr);
  if (g_fps > 0) {
    /* Pace like raylib's SetTargetFPS: after a stall, do not send a burst to catch up. */
    const uint64_t now = now_ns();
    g_next_ns += 1000000000ull / g_fps;
    if (g_next_ns < now) g_next_ns = now;
  }
}

static int all_released(void) {
  for (uint32_t i = 0; i < GXF_MAX_SLOTS; i++) {
    if (g_held[i]) return 0;
  }
  return 1;
}

static void handle_line(const char* line) {
  if (has_op(line, "surface")) {
    handle_surface(line);
  } else if (has_op(line, "start")) {
    g_target = (uint32_t)number(line, "frames", 1);
    g_fps = (uint32_t)number(line, "fps", 0);
    g_running = g_has_ring;
    g_started_ns = g_next_ns = now_ns();
    emit("{\"id\":%llu,\"ok\":%s,\"op\":\"start\",\"result\":{}}", (unsigned long long)number(line, "id", 0),
         g_has_ring ? "true" : "false");
  } else if (has_op(line, "release")) {
    uint32_t generation = (uint32_t)number(line, "generation", 0), slot = (uint32_t)number(line, "slot", 99);
    if (g_has_ring && generation == g_ring.generation && slot < GXF_MAX_SLOTS && g_held[slot]) {
      g_held[slot] = 0;
      g_releases++;
    }
  } else if (has_op(line, "quit")) {
    exit(0);
  }
}

/* Reads whatever is available and handles complete lines; 0 on EOF. */
static int pump(int timeout_ms) {
  static char buffer[64 * 1024];
  static size_t used = 0;
  struct pollfd p = {g_fd, POLLIN, 0};
  int r = poll(&p, 1, timeout_ms);
  if (r <= 0) return r == 0 ? 1 : (errno == EINTR);
  ssize_t n = read(g_fd, buffer + used, sizeof buffer - 1 - used);
  if (n <= 0) return n < 0 && errno == EINTR;
  used += (size_t)n;
  buffer[used] = '\0';
  char *start = buffer, *nl;
  while ((nl = strchr(start, '\n')) != NULL) {
    *nl = '\0';
    handle_line(start);
    start = nl + 1;
  }
  used = (size_t)(buffer + used - start);
  memmove(buffer, start, used);
  if (used == sizeof buffer - 1) used = 0; /* an absurd line: drop it */
  return 1;
}

int main(int argc, char** argv) {
  const char* service = NULL;
  const char* render = "cpu";
  const char* sync = "finish";
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--service") && i + 1 < argc)
      service = argv[++i];
    else if (!strcmp(argv[i], "--fd") && i + 1 < argc)
      g_fd = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--top-down"))
      g_top_down = 1;
    else if (!strcmp(argv[i], "--hostile") && i + 1 < argc)
      g_hostile = argv[++i];
    else if (!strcmp(argv[i], "--render") && i + 1 < argc)
      render = argv[++i];
    else if (!strcmp(argv[i], "--sync") && i + 1 < argc)
      sync = argv[++i];
  }
  if (service == NULL) {
    fprintf(stderr, "usage: gxf_test_sender --service NAME [--fd 3] [--top-down] [--hostile MODE]\n");
    return 64;
  }
  const char* renderer = "cpu";
  if (!strcmp(render, "angle")) {
#ifdef GXF_WITH_ANGLE
    int egl_error = 0;
    g_angle = gxf_angle_create(&egl_error);
    g_sync = !strcmp(sync, "flush") ? GXF_ANGLE_SYNC_FLUSH : GXF_ANGLE_SYNC_FINISH;
    if (g_angle == NULL) {
      emit("{\"op\":\"error\",\"step\":\"angle\",\"kr\":%d}", egl_error);
      return 4;
    }
    renderer = gxf_angle_renderer(g_angle);
#else
    emit("{\"op\":\"error\",\"step\":\"built without ANGLE\",\"kr\":0}");
    return 4;
#endif
  }
  kern_return_t kr = gxf_sender_connect(&g_sender, service);
  emit("{\"op\":\"ready\",\"pid\":%d,\"lookup\":%d,\"renderer\":\"%s\",\"sync\":\"%s\"}", getpid(), kr, renderer, sync);
  if (kr != KERN_SUCCESS) return 2;
  uint64_t idle_since = now_ns();
  for (;;) {
    int timeout = IDLE_TIMEOUT_MS;
    int can_send = g_running && g_sent < g_target && free_slot() >= 0;
    if (can_send) {
      uint64_t now = now_ns();
      timeout = g_fps == 0 || now >= g_next_ns ? 0 : (int)((g_next_ns - now) / 1000000u);
    }
    if (!pump(timeout)) return 0; /* the host closed the control channel */
    if (can_send && (g_fps == 0 || now_ns() >= g_next_ns)) {
      send_next();
      idle_since = now_ns();
    }
    if (g_running && g_sent == g_target && all_released()) {
      emit("{\"op\":\"done\",\"frames\":%u,\"releases\":%u,\"elapsedMs\":%.3f}", g_sent, g_releases,
           (double)(now_ns() - g_started_ns) / 1e6);
      g_running = 0;
    }
    if (now_ns() - idle_since > (uint64_t)IDLE_TIMEOUT_MS * 1000000u * 3) {
      emit("{\"op\":\"error\",\"step\":\"idle\",\"kr\":0}");
      return 3;
    }
  }
}

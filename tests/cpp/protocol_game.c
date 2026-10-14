// A minimal native game for the real-run rows (tests/conformance/native-real.test.ts): it speaks
// the host's fd-3 protocol (NDJSON both ways) the way a C++ · raylib game does, with nothing of
// raylib. It answers `ready` with GENEX_STUDIO_NONCE, `state`, a 2×2 BGRA `capture` written to
// GENEX_STATE_DIR/captures/<seq>.bgra with its FNV-1a 64 digest, and `quit` by exiting 0. Built
// with -DSTUBBORN it answers `quit` but never exits and ignores SIGTERM, for the stop escalation.
// It links the ANGLE libraries (and calls nothing in them) so bundle admission sees a Mac game.
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// ANGLE's EGL entry point, referenced so the link keeps the import admission requires.
extern void *eglGetProcAddress(const char *name);
void *volatile keep_egl_import = (void *)&eglGetProcAddress;

enum { LINE_MAX_BYTES = 64 * 1024, CAPTURE_SIDE = 2 };

static int studio_fd = 3;
static const char *state_dir = ".";
static unsigned capture_seq = 0;
static unsigned long ticks = 0;

static void send_line(const char *line) {
  size_t length = strlen(line);
  while (length > 0) {
    ssize_t written = write(studio_fd, line, length);
    if (written <= 0) exit(1);
    line += written;
    length -= (size_t)written;
  }
  if (write(studio_fd, "\n", 1) != 1) exit(1);
}

// FNV-1a 64, as studio::fnv1a64 in the template and the host's port compute it.
static uint64_t fnv1a64(const unsigned char *bytes, size_t size) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  for (size_t i = 0; i < size; ++i) {
    hash ^= bytes[i];
    hash *= 0x100000001b3ULL;
  }
  return hash;
}

// The value of "key": in a request line, as a number (or -1) or a string copied into `out`.
static long number_field(const char *line, const char *key) {
  const char *at = strstr(line, key);
  return at ? strtol(at + strlen(key), NULL, 10) : -1;
}

static void string_field(const char *line, const char *key, char *out, size_t size) {
  out[0] = '\0';
  const char *at = strstr(line, key);
  if (!at) return;
  at += strlen(key);
  size_t length = 0;
  while (at[length] && at[length] != '"' && length + 1 < size) ++length;
  memcpy(out, at, length);
  out[length] = '\0';
}

static void answer_capture(long id) {
  // Top-down BGRA: red, green / blue, white.
  const unsigned char pixels[CAPTURE_SIDE * CAPTURE_SIDE * 4] = {0,   0,   255, 255, 0,   255, 0,   255,
                                                                  255, 0,   0,   255, 255, 255, 255, 255};
  char path[4096];
  ++capture_seq;
  snprintf(path, sizeof path, "%s/captures/%u.bgra", state_dir, capture_seq);
  FILE *file = fopen(path, "wb");
  if (!file || fwrite(pixels, 1, sizeof pixels, file) != sizeof pixels) exit(2);
  fclose(file);
  char line[512];
  snprintf(line, sizeof line,
           "{\"id\":%ld,\"ok\":true,\"op\":\"capture\",\"result\":{\"seq\":%u,\"width\":%d,\"height\":%d,"
           "\"format\":\"bgra8\",\"digest\":\"%016llx\"}}",
           id, capture_seq, CAPTURE_SIDE, CAPTURE_SIDE, (unsigned long long)fnv1a64(pixels, sizeof pixels));
  send_line(line);
}

static void answer(const char *request) {
  char op[64];
  char line[512];
  long id = number_field(request, "\"id\":");
  string_field(request, "\"op\":\"", op, sizeof op);
  if (strcmp(op, "state") == 0) {
    snprintf(line, sizeof line, "{\"id\":%ld,\"ok\":true,\"op\":\"state\",\"result\":{\"tick\":%lu}}", id, ++ticks);
  } else if (strcmp(op, "capture") == 0) {
    answer_capture(id);
    return;
  } else if (strcmp(op, "front") == 0) {
    snprintf(line, sizeof line, "{\"id\":%ld,\"ok\":true,\"op\":\"front\",\"result\":{\"fronted\":false}}", id);
  } else if (strcmp(op, "quit") == 0) {
    snprintf(line, sizeof line, "{\"id\":%ld,\"ok\":true,\"op\":\"quit\",\"result\":{\"quitting\":true}}", id);
    send_line(line);
#ifndef STUBBORN
    exit(0);
#endif
    return;
  } else {
    snprintf(line, sizeof line, "{\"id\":%ld,\"ok\":false,\"op\":\"%s\",\"error\":\"unknown op\"}", id, op);
  }
  send_line(line);
}

int main(void) {
  const char *fd = getenv("GENEX_STUDIO_FD");
  const char *nonce = getenv("GENEX_STUDIO_NONCE");
  const char *state = getenv("GENEX_STATE_DIR");
  if (!fd || !nonce || !state) return 3;
  studio_fd = atoi(fd);
  state_dir = state;
#ifdef STUBBORN
  signal(SIGTERM, SIG_IGN);
#endif
  char ready[512];
  snprintf(ready, sizeof ready,
           "{\"event\":\"ready\",\"nonce\":\"%s\",\"protocol\":1,\"contractVersion\":1,\"build\":\"protocol-game\","
           "\"backend\":{\"api\":\"unknown\",\"device\":null},\"size\":{\"width\":2,\"height\":2},\"seed\":0}",
           nonce);
  send_line(ready);
  static char buffer[LINE_MAX_BYTES];
  size_t used = 0;
  for (;;) {
    ssize_t got = read(studio_fd, buffer + used, sizeof buffer - 1 - used);
    if (got <= 0) break;
    used += (size_t)got;
    buffer[used] = '\0';
    for (char *end = strchr(buffer, '\n'); end; end = strchr(buffer, '\n')) {
      *end = '\0';
      answer(buffer);
      size_t rest = used - (size_t)(end + 1 - buffer);
      memmove(buffer, end + 1, rest);
      used = rest;
      buffer[used] = '\0';
    }
    if (used >= sizeof buffer - 1) used = 0;
  }
#ifdef STUBBORN
  for (;;) pause();
#endif
  return 0;
}

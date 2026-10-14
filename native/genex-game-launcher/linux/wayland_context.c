/*
 * genex-wayland-context: the Linux game box's Wayland helper (plan M4.3).
 *
 * A boxed game never sees the session's own compositor socket: on wlroots compositors that socket
 * offers every client privileged globals (virtual keyboard and pointer, screencopy, data control).
 * This helper asks the compositor, through `wp_security_context_manager_v1` (staging protocol
 * security-context-v1), for a listening socket of the run's own whose clients the compositor
 * treats as sandboxed (sandbox engine "genex"), so those globals are hidden from the game.
 *
 *   genex-wayland-context --socket <abs path> --app-id <id> --instance-id <run id>
 *
 * `WAYLAND_DISPLAY` names the compositor: an absolute socket path (the host passes one), or a name
 * under `XDG_RUNTIME_DIR`. The helper creates and listens on `--socket` (its folder is the host's,
 * fresh and private), hands that socket and the read end of a pipe to the compositor, commits the
 * context, and prints one line on stdout:
 *   ready          the compositor accepts sandboxed clients on --socket until this helper exits
 *   unrestricted   the compositor offers no wp_security_context_manager_v1 (exit 3)
 *   failed <step>  anything else (exit 2 usage, 4 compositor error, 5 connect, 6 socket setup)
 * After `ready` it waits for stdin to close (or for a signal), then closes the pipe's write end,
 * which makes the compositor stop accepting on the socket, removes the socket and exits 0.
 *
 * It speaks the Wayland wire protocol itself (no libwayland-client), so it builds with nothing but
 * a C library: `zig cc -target x86_64-linux-gnu.2.28` from a Mac, or `cc` on Linux. The wire code
 * is portable POSIX, so the conformance suite also builds it with the Mac's `cc` and drives it
 * against a stand-in compositor (`tests/conformance/linux-game-box.test.ts`).
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define MANAGER_INTERFACE "wp_security_context_manager_v1"
#define SANDBOX_ENGINE "genex"
#define MANAGER_VERSION 1u
/* Client object ids, allocated in order as the server requires. */
#define ID_DISPLAY 1u
#define ID_REGISTRY 2u
#define ID_FIRST_SYNC 3u
#define ID_MANAGER 4u
#define ID_CONTEXT 5u
#define ID_SECOND_SYNC 6u
/* Request opcodes. */
#define DISPLAY_SYNC 0u
#define DISPLAY_GET_REGISTRY 1u
#define REGISTRY_BIND 0u
#define MANAGER_DESTROY 0u
#define MANAGER_CREATE_LISTENER 1u
#define CONTEXT_DESTROY 0u
#define CONTEXT_SET_SANDBOX_ENGINE 1u
#define CONTEXT_SET_APP_ID 2u
#define CONTEXT_SET_INSTANCE_ID 3u
#define CONTEXT_COMMIT 4u
/* Event opcodes. */
#define DISPLAY_ERROR 0u
#define REGISTRY_GLOBAL 0u
#define CALLBACK_DONE 0u

#define HEADER_BYTES 8u
#define MESSAGE_MAX 4096u
#define VALUE_MAX 256u

#define EXIT_READY 0
#define EXIT_USAGE 2
#define EXIT_UNRESTRICTED 3
#define EXIT_COMPOSITOR 4
#define EXIT_CONNECT 5
#define EXIT_SOCKET 6

/* One outgoing message under construction. */
struct message {
  uint8_t bytes[MESSAGE_MAX];
  uint32_t size;
};

/* Bytes read from the compositor and not yet parsed. */
struct inbox {
  uint8_t bytes[MESSAGE_MAX * 2];
  uint32_t size;
};

static int fail(const char *step, int code) {
  printf("failed %s\n", step);
  fflush(stdout);
  return code;
}

static int cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  return flags < 0 ? -1 : fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static void begin(struct message *m, uint32_t object) {
  memcpy(m->bytes, &object, 4);
  m->size = HEADER_BYTES;
}

static int put_u32(struct message *m, uint32_t value) {
  if (m->size + 4 > MESSAGE_MAX) return -1;
  memcpy(m->bytes + m->size, &value, 4);
  m->size += 4;
  return 0;
}

/* A string argument: its length with the NUL, the bytes, padded to 4. */
static int put_string(struct message *m, const char *value) {
  uint32_t length = (uint32_t)strlen(value) + 1;
  uint32_t padded = (length + 3u) & ~3u;
  if (put_u32(m, length) != 0 || m->size + padded > MESSAGE_MAX) return -1;
  memset(m->bytes + m->size, 0, padded);
  memcpy(m->bytes + m->size, value, length - 1);
  m->size += padded;
  return 0;
}

static void finish(struct message *m, uint32_t opcode) {
  uint32_t word = (m->size << 16) | opcode;
  memcpy(m->bytes + 4, &word, 4);
}

/* Sends one message, with `count` descriptors (0 to 2) attached as SCM_RIGHTS. */
static int send_message(int wl, struct message *m, uint32_t opcode, const int *fds, int count) {
  finish(m, opcode);
  struct iovec iov = {.iov_base = m->bytes, .iov_len = m->size};
  struct msghdr msg;
  memset(&msg, 0, sizeof msg);
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  union {
    struct cmsghdr align;
    char buffer[CMSG_SPACE(sizeof(int) * 2)];
  } control;
  if (count > 0) {
    memset(&control, 0, sizeof control);
    msg.msg_control = control.buffer;
    msg.msg_controllen = CMSG_SPACE(sizeof(int) * (size_t)count);
    struct cmsghdr *header = CMSG_FIRSTHDR(&msg);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int) * (size_t)count);
    memcpy(CMSG_DATA(header), fds, sizeof(int) * (size_t)count);
  }
  ssize_t sent;
  do sent = sendmsg(wl, &msg, 0);
  while (sent < 0 && errno == EINTR);
  return sent == (ssize_t)m->size ? 0 : -1;
}

/* A request whose only argument is a new object id. */
static int send_new_id(int wl, uint32_t object, uint32_t opcode, uint32_t id) {
  struct message m;
  begin(&m, object);
  put_u32(&m, id);
  return send_message(wl, &m, opcode, NULL, 0);
}

static int send_plain(int wl, uint32_t object, uint32_t opcode) {
  struct message m;
  begin(&m, object);
  return send_message(wl, &m, opcode, NULL, 0);
}

static int send_text(int wl, uint32_t object, uint32_t opcode, const char *value) {
  struct message m;
  begin(&m, object);
  if (put_string(&m, value) != 0) return -1;
  return send_message(wl, &m, opcode, NULL, 0);
}

static uint32_t word_at(const uint8_t *bytes, uint32_t offset) {
  uint32_t value;
  memcpy(&value, bytes + offset, 4);
  return value;
}

/* Reads a string argument at `offset` of a message of `size` bytes; null when malformed. */
static const char *string_at(const uint8_t *body, uint32_t offset, uint32_t size, uint32_t *next) {
  if (offset + 4 > size) return NULL;
  uint32_t length = word_at(body, offset);
  uint32_t padded = (length + 3u) & ~3u;
  if (length == 0 || offset + 4 + padded > size || body[offset + 4 + length - 1] != 0) return NULL;
  *next = offset + 4 + padded;
  return (const char *)(body + offset + 4);
}

/* What reading up to a sync's `done` found. */
struct roundtrip {
  uint32_t manager_name;
  int manager_found;
  int error;
};

/* Handles one event; returns 1 when it is `done` on `callback`, 0 to go on, -1 when malformed. */
static int handle_event(const uint8_t *message, uint32_t size, uint32_t callback, struct roundtrip *seen) {
  uint32_t object = word_at(message, 0);
  uint32_t opcode = word_at(message, 4) & 0xffffu;
  if (object == ID_DISPLAY && opcode == DISPLAY_ERROR) {
    seen->error = 1;
    return 1;
  }
  if (object == callback && opcode == CALLBACK_DONE) return 1;
  if (object != ID_REGISTRY || opcode != REGISTRY_GLOBAL) return 0;
  if (size < HEADER_BYTES + 4) return -1;
  uint32_t next = 0;
  const char *interface = string_at(message, HEADER_BYTES + 4, size, &next);
  if (!interface || next + 4 > size) return -1;
  if (strcmp(interface, MANAGER_INTERFACE) == 0 && word_at(message, next) >= MANAGER_VERSION) {
    seen->manager_name = word_at(message, HEADER_BYTES);
    seen->manager_found = 1;
  }
  return 0;
}

/* Reads events until `callback` is done (or the display reports an error); -1 on a broken stream. */
static int read_until_done(int wl, struct inbox *in, uint32_t callback, struct roundtrip *seen) {
  for (;;) {
    while (in->size >= HEADER_BYTES) {
      uint32_t size = word_at(in->bytes, 4) >> 16;
      if (size < HEADER_BYTES || size > MESSAGE_MAX) return -1;
      if (in->size < size) break;
      int handled = handle_event(in->bytes, size, callback, seen);
      memmove(in->bytes, in->bytes + size, in->size - size);
      in->size -= size;
      if (handled != 0) return handled < 0 ? -1 : 0;
    }
    ssize_t got = recv(wl, in->bytes + in->size, sizeof in->bytes - in->size, 0);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) return -1;
    in->size += (uint32_t)got;
  }
}

static int fill_address(struct sockaddr_un *address, const char *path) {
  memset(address, 0, sizeof *address);
  address->sun_family = AF_UNIX;
  if (strlen(path) >= sizeof address->sun_path) return -1;
  memcpy(address->sun_path, path, strlen(path));
  return 0;
}

/* The compositor's socket path from WAYLAND_DISPLAY (absolute, or a name in XDG_RUNTIME_DIR). */
static int compositor_path(char *out, size_t capacity) {
  const char *display = getenv("WAYLAND_DISPLAY");
  if (!display || !*display || strchr(display, '\n')) return -1;
  if (display[0] == '/') return snprintf(out, capacity, "%s", display) < (int)capacity ? 0 : -1;
  const char *runtime = getenv("XDG_RUNTIME_DIR");
  if (!runtime || runtime[0] != '/' || strchr(display, '/')) return -1;
  return snprintf(out, capacity, "%s/%s", runtime, display) < (int)capacity ? 0 : -1;
}

static int connect_compositor(void) {
  char path[VALUE_MAX];
  struct sockaddr_un address;
  if (compositor_path(path, sizeof path) != 0 || fill_address(&address, path) != 0) return -1;
  int wl = socket(AF_UNIX, SOCK_STREAM, 0);
  if (wl < 0) return -1;
  if (cloexec(wl) != 0 || connect(wl, (struct sockaddr *)&address, sizeof address) != 0) {
    close(wl);
    return -1;
  }
  return wl;
}

/* The run's listening socket at `path`, which must not exist yet. */
static int listen_at(const char *path) {
  struct sockaddr_un address;
  if (fill_address(&address, path) != 0) return -1;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (cloexec(fd) != 0 || bind(fd, (struct sockaddr *)&address, sizeof address) != 0 || listen(fd, 16) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

/* Binds the manager and commits a context listening on `listen_fd` until `close_fd` hangs up. */
static int commit_context(int wl, uint32_t manager, int listen_fd, int close_fd, const char *app_id,
                          const char *instance_id) {
  struct message m;
  begin(&m, ID_REGISTRY);
  put_u32(&m, manager);
  put_string(&m, MANAGER_INTERFACE);
  put_u32(&m, MANAGER_VERSION);
  put_u32(&m, ID_MANAGER);
  if (send_message(wl, &m, REGISTRY_BIND, NULL, 0) != 0) return -1;
  int fds[2] = {listen_fd, close_fd};
  begin(&m, ID_MANAGER);
  put_u32(&m, ID_CONTEXT);
  if (send_message(wl, &m, MANAGER_CREATE_LISTENER, fds, 2) != 0) return -1;
  /* In this order: the context's metadata, commit, then both objects released. */
  if (send_text(wl, ID_CONTEXT, CONTEXT_SET_SANDBOX_ENGINE, SANDBOX_ENGINE) != 0) return -1;
  if (send_text(wl, ID_CONTEXT, CONTEXT_SET_APP_ID, app_id) != 0) return -1;
  if (send_text(wl, ID_CONTEXT, CONTEXT_SET_INSTANCE_ID, instance_id) != 0) return -1;
  if (send_plain(wl, ID_CONTEXT, CONTEXT_COMMIT) != 0) return -1;
  if (send_plain(wl, ID_CONTEXT, CONTEXT_DESTROY) != 0) return -1;
  if (send_plain(wl, ID_MANAGER, MANAGER_DESTROY) != 0) return -1;
  return send_new_id(wl, ID_DISPLAY, DISPLAY_SYNC, ID_SECOND_SYNC);
}

/* A plain token: letters, digits, '.', '_' and '-', 1 to 64 of them. */
static int plain_token(const char *value) {
  size_t length = strlen(value);
  if (length == 0 || length > 64) return 0;
  return strspn(value, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-") == length;
}

struct options {
  const char *socket;
  const char *app_id;
  const char *instance_id;
};

/* Every flag once, every value checked; 0 when the command line is usable. */
static int parse(int argc, char **argv, struct options *out) {
  memset(out, 0, sizeof *out);
  for (int i = 1; i + 1 < argc; i += 2) {
    const char **slot = NULL;
    if (strcmp(argv[i], "--socket") == 0) slot = &out->socket;
    if (strcmp(argv[i], "--app-id") == 0) slot = &out->app_id;
    if (strcmp(argv[i], "--instance-id") == 0) slot = &out->instance_id;
    if (!slot || *slot) return -1;
    *slot = argv[i + 1];
  }
  if (argc % 2 != 1 || !out->socket || !out->app_id || !out->instance_id) return -1;
  if (out->socket[0] != '/' || strchr(out->socket, '\n')) return -1;
  return plain_token(out->app_id) && plain_token(out->instance_id) ? 0 : -1;
}

/* Blocks until stdin reaches end of file or fails: the host's "this run is over". */
static void wait_for_host(void) {
  char buffer[64];
  for (;;) {
    ssize_t got = read(STDIN_FILENO, buffer, sizeof buffer);
    if (got == 0 || (got < 0 && errno != EINTR)) return;
  }
}

int main(int argc, char **argv) {
  struct options options;
  signal(SIGPIPE, SIG_IGN);
  if (parse(argc, argv, &options) != 0) return fail("usage", EXIT_USAGE);
  int wl = connect_compositor();
  if (wl < 0) return fail("connect", EXIT_CONNECT);
  struct inbox in = {.size = 0};
  struct roundtrip seen = {0, 0, 0};
  if (send_new_id(wl, ID_DISPLAY, DISPLAY_GET_REGISTRY, ID_REGISTRY) != 0 ||
      send_new_id(wl, ID_DISPLAY, DISPLAY_SYNC, ID_FIRST_SYNC) != 0 || read_until_done(wl, &in, ID_FIRST_SYNC, &seen) != 0)
    return fail("registry", EXIT_COMPOSITOR);
  if (seen.error) return fail("registry", EXIT_COMPOSITOR);
  if (!seen.manager_found) {
    printf("unrestricted\n");
    fflush(stdout);
    return EXIT_UNRESTRICTED;
  }
  int pipe_fds[2];
  int listen_fd = listen_at(options.socket);
  if (listen_fd < 0) return fail("socket", EXIT_SOCKET);
  if (pipe(pipe_fds) != 0 || cloexec(pipe_fds[0]) != 0 || cloexec(pipe_fds[1]) != 0) {
    unlink(options.socket);
    return fail("socket", EXIT_SOCKET);
  }
  int committed = commit_context(wl, seen.manager_name, listen_fd, pipe_fds[0], options.app_id, options.instance_id);
  if (committed != 0 || read_until_done(wl, &in, ID_SECOND_SYNC, &seen) != 0 || seen.error) {
    unlink(options.socket);
    return fail("commit", EXIT_COMPOSITOR);
  }
  /* The compositor holds its own copies now; this process keeps only the pipe's write end. */
  close(listen_fd);
  close(pipe_fds[0]);
  close(wl);
  printf("ready\n");
  fflush(stdout);
  wait_for_host();
  close(pipe_fds[1]);
  unlink(options.socket);
  return EXIT_READY;
}

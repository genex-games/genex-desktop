// The studio's side of the native protocol for the cross-build smoke (scripts/cross-build-smoke.ts),
// as one static program the smoke builds with zig for x86_64-linux-musl, so it runs in any Linux
// container or on the runner without Node. It starts the game with descriptor 3 as one end of a
// socket pair and GENEX_STUDIO_FD / GENEX_STUDIO_NONCE set (as ProcessSandbox does), waits for the
// game's `ready` event carrying the nonce, lets it run, says so (<out>/ran, <out>/state) and waits
// for the smoke's screenshot (<out>/captured), then sends `quit` and requires its answer and a
// clean exit 0. Every line the game sent and every verdict goes to <out>/protocol.
//
//   studio-probe <nonce> <run-ms> <out-dir> <game> [args...]
//
// Exits 0 only when the ready event named the nonce, quit was answered ok and the game exited 0.
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum {
  READY_MS = 30000,       // a CPU renderer's first frame is slow under emulation
  CAPTURE_WAIT_MS = 30000,
  ANSWER_MS = 10000,
  EXIT_MS = 15000,
  STEP_MS = 50,
  LINE_MAX_BYTES = 1 << 20,
  PATH_MAX_BYTES = 4096,
  LOGGED_CHARS = 300,
};

static char lines[LINE_MAX_BYTES];
static size_t filled;
/* The game once reaped, and how it ended (its exit code, or 128 + the signal). */
static int reaped;
static int exit_code;
static FILE *report;
static const char *out_dir;

static long long now_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void sleep_ms(long ms) {
  struct timespec wait = {ms / 1000, (ms % 1000) * 1000000L};
  while (nanosleep(&wait, &wait) != 0 && errno == EINTR) {
  }
}

static void out_path(char *into, const char *name) { snprintf(into, PATH_MAX_BYTES, "%s/%s", out_dir, name); }

/* Writes `text` to <out>/<name>, replacing it. */
static void write_file(const char *name, const char *text) {
  char file[PATH_MAX_BYTES];
  out_path(file, name);
  FILE *handle = fopen(file, "w");
  if (!handle) return;
  fputs(text, handle);
  fclose(handle);
}

static int exists(const char *name) {
  char file[PATH_MAX_BYTES];
  struct stat info;
  out_path(file, name);
  return stat(file, &info) == 0;
}

/*
 * Reads the game's lines until one holds `first` (and `second`, when given) or the deadline
 * passes; every line is logged. Returns 1 for a match, 0 at the deadline, -1 once the game has
 * closed its end (it is ending).
 */
static int await_line(int fd, const char *first, const char *second, long long deadline) {
  for (;;) {
    char *end;
    while ((end = memchr(lines, '\n', filled)) != NULL) {
      size_t length = (size_t)(end - lines);
      *end = '\0';
      int match = strstr(lines, first) != NULL && (second == NULL || strstr(lines, second) != NULL);
      fprintf(report, "game> %.*s\n", LOGGED_CHARS, lines);
      memmove(lines, end + 1, filled - length - 1);
      filled -= length + 1;
      if (match) return 1;
    }
    long long left = deadline - now_ms();
    if (left <= 0) return 0;
    struct pollfd ready = {fd, POLLIN, 0};
    int polled = poll(&ready, 1, (int)left);
    if (polled < 0 && errno == EINTR) continue;
    if (polled == 0) return 0;
    if (polled < 0) return -1;
    if (filled == sizeof lines) filled = 0;  // a line past the protocol's cap: dropped
    ssize_t got = read(fd, lines + filled, sizeof lines - filled);
    if (got <= 0) return -1;
    filled += (size_t)got;
  }
}

/* Whether the game has ended, waiting up to `ms`; once reaped, `exit_code` says how. */
static int reap(pid_t game, long ms) {
  long long deadline = now_ms() + ms;
  for (;;) {
    if (reaped) return 1;
    int status = 0;
    if (waitpid(game, &status, WNOHANG) == game) {
      reaped = 1;
      exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      return 1;
    }
    if (now_ms() >= deadline) return 0;
    sleep_ms(STEP_MS);
  }
}

/* Writes <out>/state as the smoke reads it: `alive`, or how the game ended (waited for when it closed its end). */
static void record_state(pid_t game, int closed) {
  char state[64];
  if (!reap(game, closed ? EXIT_MS : 0)) {
    write_file("state", "alive\n");
    return;
  }
  snprintf(state, sizeof state, "exited %d\n", exit_code);
  write_file("state", state);
}

static pid_t start_game(int channel, const char *nonce, char **argv) {
  pid_t game = fork();
  if (game != 0) return game;
  // dup2 clears close-on-exec on descriptor 3 only; the pair's other ends close at exec.
  if (dup2(channel, 3) < 0) _exit(126);
  setenv("GENEX_STUDIO_FD", "3", 1);
  setenv("GENEX_STUDIO_NONCE", nonce, 1);
  execvp(argv[0], argv);
  _exit(127);
}

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "usage: studio-probe <nonce> <run-ms> <out-dir> <game> [args...]\n");
    return 2;
  }
  const char *nonce = argv[1];
  long run_ms = strtol(argv[2], NULL, 10);
  out_dir = argv[3];
  char file[PATH_MAX_BYTES];
  out_path(file, "protocol");
  report = fopen(file, "w");
  if (!report) return 2;
  setvbuf(report, NULL, _IOLBF, 0);
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0) return 2;
  pid_t game = start_game(pair[1], nonce, argv + 4);
  close(pair[1]);
  signal(SIGPIPE, SIG_IGN);  // the probe's own writes only: the game keeps its own disposition
  char nonce_field[256];
  snprintf(nonce_field, sizeof nonce_field, "\"nonce\":\"%s\"", nonce);
  int greeted = await_line(pair[0], "\"event\":\"ready\"", nonce_field, now_ms() + READY_MS);
  int ready = greeted == 1;
  fprintf(report, ready ? "ready: the nonce matches\n" : "ready: none with the nonce\n");
  // The game runs; whatever it sends is logged. A game that closed its end is waited for.
  int closed = greeted < 0 || (ready && await_line(pair[0], "\x01", NULL, now_ms() + run_ms) < 0);
  record_state(game, closed);
  write_file("ran", "");
  for (long long until = now_ms() + CAPTURE_WAIT_MS; !exists("captured") && now_ms() < until;) sleep_ms(STEP_MS);
  static const char quit[] = "{\"id\":1,\"op\":\"quit\"}\n";
  int sent = write(pair[0], quit, sizeof quit - 1) == (ssize_t)(sizeof quit - 1);
  int answered = sent && await_line(pair[0], "\"id\":1", "\"ok\":true", now_ms() + ANSWER_MS) == 1;
  fprintf(report, answered ? "quit: answered ok\n" : "quit: no ok answer\n");
  if (!reap(game, EXIT_MS)) {
    kill(game, SIGKILL);
    waitpid(game, NULL, 0);
    fprintf(report, "exit: still running after quit, killed\n");
    return 1;
  }
  fprintf(report, "exit: %d\n", exit_code);
  return ready && answered && exit_code == 0 ? 0 : 1;
}

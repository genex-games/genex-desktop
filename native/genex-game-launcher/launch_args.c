/*
 * The launcher's command-line parser, container policy, game environment and exit reporting (see
 * launch_args.h). Portable C over wchar_t: on Windows wchar_t is UTF-16, elsewhere it is wider,
 * and every check here holds for both.
 */
#include "launch_args.h"

#include <string.h>

const gx_exit_code GX_EXIT_CODES[] = {
    {GX_EXIT_USAGE, "usage"},
    {GX_EXIT_PROTOCOL_CHANNEL, "protocol-channel"},
    {GX_EXIT_PROFILE, "profile"},
    {GX_EXIT_GRANT, "grant"},
    {GX_EXIT_PIPE, "pipe"},
    {GX_EXIT_JOB, "job"},
    {GX_EXIT_DESKTOP, "desktop"},
    {GX_EXIT_SPAWN, "spawn"},
    {GX_EXIT_PIPE_CLIENT, "pipe-client"},
    {GX_EXIT_WAIT, "wait"},
    {GX_EXIT_CLEANUP, "cleanup"},
    {GX_EXIT_STOPPED, "stopped"},
    {GX_EXIT_GAME_RESERVED, "game-reserved"},
    {0, 0},
};

/* The low label that lets a low-integrity container write in state; inherited by files and folders. */
#define LOW_LABEL_INHERITED L"S:(ML;OICI;NW;;;LW)"

const gx_folder_grant GX_FOLDER_GRANTS[] = {
    {GX_FOLDER_BUNDLE, GX_FILE_GENERIC_READ | GX_FILE_GENERIC_EXECUTE, GX_INHERIT_ALL, 0},
    {GX_FOLDER_STATE, GX_FILE_GENERIC_READ | GX_FILE_GENERIC_WRITE | GX_DELETE | GX_FILE_DELETE_CHILD, GX_INHERIT_ALL,
     LOW_LABEL_INHERITED},
    {GX_FOLDER_BUNDLE, 0, 0, 0},
};

/* No capability at all: no internetClient, no privateNetworkClientServer, no library access. */
const wchar_t *const GX_CAPABILITY_SIDS[] = {0};

unsigned int gx_reported_exit(unsigned int game_code, unsigned int ended_with) {
  int reserved = (game_code & GX_EXIT_RANGE_MASK) == GX_EXIT_BASE;
  if (!reserved || game_code == ended_with) return game_code;
  return GX_EXIT_GAME_RESERVED;
}

/* The flags, in the order gx_launch_args keeps their values. */
enum { F_RUN_ID, F_BUNDLE, F_STATE, F_EXE, F_PIPE, F_MEMORY, F_DESKTOP, F_DELETE, F_COUNT };

static const wchar_t *const FLAG_NAMES[F_COUNT] = {
    L"--run-id", L"--bundle", L"--state", L"--exe", L"--pipe", L"--memory-bytes", L"--desktop", L"--delete-profile",
};

/* The decimal digits of GX_MEMORY_MAX_BYTES: a longer number is refused before it is read. */
#define MEMORY_MAX_DIGITS 20

static int is_ascii_lower_alnum(wchar_t c) { return (c >= L'a' && c <= L'z') || (c >= L'0' && c <= L'9'); }

static int is_ascii_alnum(wchar_t c) { return is_ascii_lower_alnum(c) || (c >= L'A' && c <= L'Z'); }

static wchar_t ascii_fold(wchar_t c) { return (c >= L'A' && c <= L'Z') ? (wchar_t)(c - L'A' + L'a') : c; }

/* a and b are equal for their first n units, ignoring ASCII case (NTFS's own folding covers more). */
static int same_folded(const wchar_t *a, const wchar_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (ascii_fold(a[i]) != ascii_fold(b[i])) return 0;
  }
  return 1;
}

static int is_lower_hex(wchar_t c) { return (c >= L'a' && c <= L'f') || (c >= L'0' && c <= L'9'); }

static int valid_run_id(const wchar_t *id) {
  size_t length = wcslen(id);
  if (length < GX_RUN_ID_MIN_UNITS || length > GX_RUN_ID_MAX_UNITS) return 0;
  for (size_t i = 0; i < length; i++) {
    if (!is_lower_hex(id[i])) return 0;
  }
  return 1;
}

/* A unit no Windows path may hold: a control character, a forward slash, or a reserved symbol. */
static int forbidden_path_unit(wchar_t c) {
  if (c < 0x20 || c == 0x7f) return 1;
  return wcschr(L"/<>\"|?*:", c) != 0;
}

/* One path segment: non-empty, not "." or "..", and not ending in a dot or space (Windows strips those). */
static int valid_segment(const wchar_t *start, size_t length) {
  if (length == 0) return 0;
  if (length == 1 && start[0] == L'.') return 0;
  if (length == 2 && start[0] == L'.' && start[1] == L'.') return 0;
  wchar_t last = start[length - 1];
  return last != L'.' && last != L' ';
}

/* An absolute local folder: "X:\a\b", no UNC, no device namespace, no trailing separator. */
static int valid_folder(const wchar_t *folder) {
  size_t length = wcslen(folder);
  if (length < 4 || length > GX_PATH_MAX_UNITS) return 0;
  wchar_t drive = ascii_fold(folder[0]);
  if (drive < L'a' || drive > L'z' || folder[1] != L':' || folder[2] != L'\\') return 0;
  const wchar_t *segment = folder + 3;
  for (const wchar_t *p = segment;; p++) {
    if (*p == L'\\' || *p == 0) {
      if (!valid_segment(segment, (size_t)(p - segment))) return 0;
      if (*p == 0) return 1;
      segment = p + 1;
    } else if (forbidden_path_unit(*p)) {
      return 0;
    }
  }
}

/* The length of a folder's parent: the units before its last separator. */
static size_t parent_length(const wchar_t *folder) {
  const wchar_t *last = wcsrchr(folder, L'\\');
  return (size_t)(last - folder);
}

/* The segment of path that ends before unit end (after the separator before it) is name, ASCII case-blind. */
static int segment_is(const wchar_t *path, size_t end, const wchar_t *name) {
  size_t start = end;
  while (start > 0 && path[start - 1] != L'\\') start--;
  size_t length = wcslen(name);
  return end - start == length && same_folded(path + start, name, length);
}

/*
 * The run's own layout: bundle is "<run>\bundle" and state "<run>\state" of one run folder named
 * for the run id (ASCII case-blind, as NTFS names them). A caller that names any other folders, a
 * person's Documents or another run's state, is refused before any ACL or label changes.
 */
static int valid_layout(const wchar_t *run_id, const wchar_t *bundle, const wchar_t *state) {
  size_t parent = parent_length(bundle);
  if (parent != parent_length(state) || !same_folded(bundle, state, parent)) return 0;
  return segment_is(bundle, wcslen(bundle), GX_BUNDLE_FOLDER) && segment_is(state, wcslen(state), GX_STATE_FOLDER) &&
         segment_is(bundle, parent, run_id);
}

static int valid_exe(const wchar_t *exe, const wchar_t *bundle) {
  static const wchar_t suffix[] = L".exe";
  size_t suffix_length = wcslen(suffix);
  size_t length = wcslen(exe);
  if (length <= suffix_length || length > GX_EXE_NAME_MAX_UNITS) return 0;
  if (wcslen(bundle) + 1 + length > GX_PATH_MAX_UNITS) return 0;
  if (!is_ascii_alnum(exe[0])) return 0;
  for (size_t i = 0; i < length; i++) {
    if (!is_ascii_alnum(exe[i]) && exe[i] != L'.' && exe[i] != L'_' && exe[i] != L'-') return 0;
  }
  return same_folded(exe + length - suffix_length, suffix, suffix_length);
}

static int valid_pipe(const wchar_t *pipe, const wchar_t *run_id) {
  wchar_t expected[GX_PATH_MAX_UNITS + 1];
  if (!gx_join(expected, sizeof expected / sizeof expected[0], GX_PIPE_PREFIX, run_id)) return 0;
  return wcscmp(pipe, expected) == 0;
}

/* A plain decimal number without sign, spaces or leading zeros, within the memory bounds. */
static int parse_memory(const wchar_t *text, unsigned long long *bytes) {
  size_t length = wcslen(text);
  if (length == 0 || length > MEMORY_MAX_DIGITS || text[0] == L'0') return 0;
  unsigned long long value = 0;
  for (size_t i = 0; i < length; i++) {
    if (text[i] < L'0' || text[i] > L'9') return 0;
    unsigned long long digit = (unsigned long long)(text[i] - L'0');
    if (value > (GX_MEMORY_MAX_BYTES - digit) / 10) return 0;
    value = value * 10 + digit;
  }
  if (value < GX_MEMORY_MIN_BYTES) return 0;
  *bytes = value;
  return 1;
}

static int flag_index(const wchar_t *arg) {
  for (int i = 0; i < F_COUNT; i++) {
    if (wcscmp(arg, FLAG_NAMES[i]) == 0) return i;
  }
  return -1;
}

/* Reads argv into values[] by flag; a flag without a value is "" in values[F_DELETE]. */
static gx_arg_error collect(int argc, wchar_t **argv, const wchar_t *values[F_COUNT], const wchar_t **flag) {
  for (int i = 1; i < argc; i++) {
    int index = flag_index(argv[i]);
    *flag = argv[i];
    if (index < 0) return GX_ARG_UNKNOWN_FLAG;
    if (values[index]) return GX_ARG_DUPLICATE_FLAG;
    if (index == F_DELETE) {
      values[index] = L"";
      continue;
    }
    if (i + 1 >= argc) return GX_ARG_MISSING_VALUE;
    values[index] = argv[++i];
  }
  *flag = 0;
  return GX_ARG_OK;
}

static gx_arg_error check_delete(const wchar_t *values[F_COUNT], gx_launch_args *out, const wchar_t **flag) {
  for (int i = 0; i < F_COUNT; i++) {
    if (i == F_RUN_ID || i == F_DELETE || !values[i]) continue;
    *flag = FLAG_NAMES[i];
    return GX_ARG_EXTRA_FLAG;
  }
  out->mode = GX_MODE_DELETE_PROFILE;
  return GX_ARG_OK;
}

static gx_arg_error check_run(const wchar_t *values[F_COUNT], gx_launch_args *out, const wchar_t **flag) {
  for (int i = 0; i < F_DELETE; i++) {
    if (values[i]) continue;
    *flag = FLAG_NAMES[i];
    return GX_ARG_MISSING_FLAG;
  }
  *flag = FLAG_NAMES[F_BUNDLE];
  if (!valid_folder(values[F_BUNDLE])) return GX_ARG_BAD_FOLDER;
  *flag = FLAG_NAMES[F_STATE];
  if (!valid_folder(values[F_STATE])) return GX_ARG_BAD_FOLDER;
  if (!valid_layout(values[F_RUN_ID], values[F_BUNDLE], values[F_STATE])) return GX_ARG_FOLDER_LAYOUT;
  *flag = FLAG_NAMES[F_EXE];
  if (!valid_exe(values[F_EXE], values[F_BUNDLE])) return GX_ARG_BAD_EXE;
  *flag = FLAG_NAMES[F_PIPE];
  if (!valid_pipe(values[F_PIPE], values[F_RUN_ID])) return GX_ARG_BAD_PIPE;
  *flag = FLAG_NAMES[F_MEMORY];
  if (!parse_memory(values[F_MEMORY], &out->memory_bytes)) return GX_ARG_BAD_MEMORY;
  *flag = FLAG_NAMES[F_DESKTOP];
  if (wcscmp(values[F_DESKTOP], L"interactive") == 0) {
    out->desktop = GX_DESKTOP_INTERACTIVE;
  } else if (wcscmp(values[F_DESKTOP], L"hidden") == 0) {
    out->desktop = GX_DESKTOP_HIDDEN;
  } else {
    return GX_ARG_BAD_DESKTOP;
  }
  *flag = 0;
  out->mode = GX_MODE_RUN;
  out->bundle = values[F_BUNDLE];
  out->state = values[F_STATE];
  out->exe = values[F_EXE];
  out->pipe = values[F_PIPE];
  return GX_ARG_OK;
}

gx_arg_error gx_parse_args(int argc, wchar_t **argv, gx_launch_args *out, const wchar_t **flag) {
  const wchar_t *values[F_COUNT] = {0};
  memset(out, 0, sizeof *out);
  *flag = 0;
  gx_arg_error collected = collect(argc, argv, values, flag);
  if (collected != GX_ARG_OK) return collected;
  *flag = FLAG_NAMES[F_RUN_ID];
  if (!values[F_RUN_ID]) return GX_ARG_MISSING_FLAG;
  if (!valid_run_id(values[F_RUN_ID])) return GX_ARG_BAD_RUN_ID;
  out->run_id = values[F_RUN_ID];
  *flag = 0;
  return values[F_DELETE] ? check_delete(values, out, flag) : check_run(values, out, flag);
}

const char *gx_arg_error_name(gx_arg_error error) {
  switch (error) {
    case GX_ARG_OK:
      return "ok";
    case GX_ARG_UNKNOWN_FLAG:
      return "unknown-flag";
    case GX_ARG_MISSING_VALUE:
      return "missing-value";
    case GX_ARG_DUPLICATE_FLAG:
      return "duplicate-flag";
    case GX_ARG_MISSING_FLAG:
      return "missing-flag";
    case GX_ARG_BAD_RUN_ID:
      return "bad-run-id";
    case GX_ARG_BAD_FOLDER:
      return "bad-folder";
    case GX_ARG_FOLDER_LAYOUT:
      return "folder-layout";
    case GX_ARG_BAD_EXE:
      return "bad-exe";
    case GX_ARG_BAD_PIPE:
      return "bad-pipe";
    case GX_ARG_BAD_MEMORY:
      return "bad-memory";
    case GX_ARG_BAD_DESKTOP:
      return "bad-desktop";
    case GX_ARG_EXTRA_FLAG:
      return "extra-flag";
  }
  return "unknown";
}

const wchar_t *gx_grant_folder(const gx_launch_args *args, gx_folder folder) {
  return folder == GX_FOLDER_STATE ? args->state : args->bundle;
}

/* entry starts with prefix, ignoring ASCII case (environment names are case-blind on Windows). */
static int has_prefix(const wchar_t *entry, const wchar_t *prefix) {
  size_t length = wcslen(prefix);
  return wcslen(entry) >= length && same_folded(entry, prefix, length);
}

/* Appends "name=value" and its 0 at *used; the block's final 0 is added by gx_build_environment. */
static int add_variable(wchar_t *block, size_t capacity, size_t *used, const wchar_t *name, const wchar_t *value) {
  size_t name_length = wcslen(name);
  size_t value_length = wcslen(value);
  if (*used + name_length + value_length + 3 > capacity) return 0;
  memcpy(block + *used, name, name_length * sizeof *block);
  block[*used + name_length] = L'=';
  memcpy(block + *used + name_length + 1, value, value_length * sizeof *block);
  *used += name_length + value_length + 1;
  block[(*used)++] = 0;
  return 1;
}

/* Every GENEX_* entry of inherited except the pipe's, which the launcher names itself. */
static int forward_genex_variables(wchar_t *block, size_t capacity, size_t *used, const wchar_t *inherited) {
  for (const wchar_t *entry = inherited; *entry; entry += wcslen(entry) + 1) {
    if (!has_prefix(entry, GX_FORWARDED_ENV_PREFIX) || has_prefix(entry, GX_PIPE_ENV L"=")) continue;
    size_t length = wcslen(entry);
    if (*used + length + 2 > capacity) return 0;
    memcpy(block + *used, entry, (length + 1) * sizeof *block);
    *used += length + 1;
  }
  return 1;
}

size_t gx_build_environment(wchar_t *block, size_t capacity, const gx_launch_args *args, const wchar_t *windows_dir,
                            const wchar_t *system_dir, const wchar_t *inherited) {
  size_t used = 0;
  int fits = add_variable(block, capacity, &used, L"SystemRoot", windows_dir) &&
             add_variable(block, capacity, &used, L"windir", windows_dir) &&
             add_variable(block, capacity, &used, L"PATH", system_dir) &&
             add_variable(block, capacity, &used, L"TEMP", args->state) &&
             add_variable(block, capacity, &used, L"TMP", args->state) &&
             add_variable(block, capacity, &used, L"APPDATA", args->state) &&
             add_variable(block, capacity, &used, L"LOCALAPPDATA", args->state) &&
             add_variable(block, capacity, &used, GX_PIPE_ENV, args->pipe) &&
             forward_genex_variables(block, capacity, &used, inherited);
  if (!fits || used + 1 > capacity) return 0;
  block[used++] = 0;
  return used;
}

int gx_join(wchar_t *out, size_t capacity, const wchar_t *prefix, const wchar_t *run_id) {
  size_t prefix_length = wcslen(prefix);
  size_t id_length = wcslen(run_id);
  if (prefix_length + id_length + 1 > capacity) return 0;
  memcpy(out, prefix, prefix_length * sizeof *out);
  memcpy(out + prefix_length, run_id, (id_length + 1) * sizeof *out);
  return 1;
}

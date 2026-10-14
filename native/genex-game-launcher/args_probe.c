/*
 * A test driver, never shipped: runs the launcher's own portable code (launch_args.c) on this
 * machine.
 *
 *   args_probe --exit-codes            prints the reserved exit codes as one JSON object
 *   args_probe --exit <game> <ended>   prints the code the launcher reports for a game that exited
 *                                      with <game> after the launcher ended its job with <ended>
 *   args_probe --policy                prints the container's capabilities and folder grants
 *   args_probe --env <launcher argv>   prints the game's environment block as a JSON array, built
 *                                      from this process's own environment as the inherited one,
 *                                      with C:\Windows and C:\Windows\System32 as Windows' folders
 *   args_probe <launcher argv>         prints {"ok":true,...} with the parsed values, or
 *                                      {"ok":false,"error":"<name>","flag":"<flag>"}
 *
 * Arguments arrive as UTF-8 and are widened with mbstowcs under a UTF-8 locale. Output strings
 * are ASCII-escaped JSON, so a test reads exactly what the launcher would act on.
 */
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "launch_args.h"

/* The most arguments and units per argument the probe widens. */
#define PROBE_MAX_ARGS 64
#define PROBE_MAX_UNITS 4096
/* The inherited environment the probe widens, in units. */
#define PROBE_ENV_UNITS 65536
#define PROBE_WINDOWS_DIR L"C:\\Windows"
#define PROBE_SYSTEM_DIR L"C:\\Windows\\System32"

extern char **environ;

static void print_string(const wchar_t *text) {
  putchar('"');
  for (const wchar_t *p = text; p && *p; p++) {
    unsigned long c = (unsigned long)*p;
    if (c == '"' || c == '\\') {
      printf("\\%c", (char)c);
    } else if (c >= 0x20 && c < 0x7f) {
      putchar((char)c);
    } else if (c <= 0xffff) {
      printf("\\u%04lx", c);
    } else {
      unsigned long v = c - 0x10000;
      printf("\\u%04lx\\u%04lx", 0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  putchar('"');
}

static int print_exit_codes(void) {
  putchar('{');
  for (const gx_exit_code *entry = GX_EXIT_CODES; entry->name; entry++) {
    printf("%s\"%s\":%u", entry == GX_EXIT_CODES ? "" : ",", entry->name, entry->code);
  }
  puts("}");
  return 0;
}

static int print_exit(const char *game, const char *ended) {
  unsigned long game_code = strtoul(game, 0, 10);
  unsigned long ended_with = strtoul(ended, 0, 10);
  printf("%u\n", gx_reported_exit((unsigned int)game_code, (unsigned int)ended_with));
  return 0;
}

static int print_policy(void) {
  printf("{\"capabilities\":[");
  for (const wchar_t *const *sid = GX_CAPABILITY_SIDS; *sid; sid++) {
    if (sid != GX_CAPABILITY_SIDS) putchar(',');
    print_string(*sid);
  }
  printf("],\"grants\":[");
  for (const gx_folder_grant *grant = GX_FOLDER_GRANTS; grant->access; grant++) {
    printf("%s{\"folder\":\"%s\",\"access\":%u,\"inheritance\":%u,\"label\":", grant == GX_FOLDER_GRANTS ? "" : ",",
           grant->folder == GX_FOLDER_STATE ? "state" : "bundle", grant->access, grant->inheritance);
    if (grant->label_sddl) {
      print_string(grant->label_sddl);
    } else {
      printf("null");
    }
    putchar('}');
  }
  puts("]}");
  return 0;
}

/* This process's environment as a Windows-style block: "NAME=value" entries, each ending with 0, then an empty one. */
static int inherited_block(wchar_t *block, size_t capacity) {
  size_t used = 0;
  for (char **entry = environ; *entry; entry++) {
    size_t units = mbstowcs(block + used, *entry, capacity - used - 1);
    if (units == (size_t)-1 || used + units + 2 > capacity) return 0;
    used += units;
    block[used++] = 0;
  }
  block[used] = 0;
  return 1;
}

static int print_environment(int argc, wchar_t **argv) {
  gx_launch_args args;
  const wchar_t *flag = 0;
  if (gx_parse_args(argc, argv, &args, &flag) != GX_ARG_OK || args.mode != GX_MODE_RUN) return 5;
  static wchar_t inherited[PROBE_ENV_UNITS];
  static wchar_t block[GX_ENV_BLOCK_MAX_UNITS];
  if (!inherited_block(inherited, PROBE_ENV_UNITS)) return 6;
  size_t used =
      gx_build_environment(block, GX_ENV_BLOCK_MAX_UNITS, &args, PROBE_WINDOWS_DIR, PROBE_SYSTEM_DIR, inherited);
  if (used == 0) return 7;
  putchar('[');
  for (const wchar_t *entry = block; *entry; entry += wcslen(entry) + 1) {
    if (entry != block) putchar(',');
    print_string(entry);
  }
  puts("]");
  return 0;
}

static void print_parsed(const gx_launch_args *args) {
  printf("{\"ok\":true,\"mode\":\"%s\",\"runId\":", args->mode == GX_MODE_RUN ? "run" : "delete-profile");
  print_string(args->run_id);
  if (args->mode == GX_MODE_RUN) {
    printf(",\"bundle\":");
    print_string(args->bundle);
    printf(",\"state\":");
    print_string(args->state);
    printf(",\"exe\":");
    print_string(args->exe);
    printf(",\"pipe\":");
    print_string(args->pipe);
    printf(",\"memoryBytes\":%llu,\"desktop\":\"%s\"", args->memory_bytes,
           args->desktop == GX_DESKTOP_HIDDEN ? "hidden" : "interactive");
  }
  puts("}");
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--exit-codes") == 0) return print_exit_codes();
  if (argc == 2 && strcmp(argv[1], "--policy") == 0) return print_policy();
  if (argc == 4 && strcmp(argv[1], "--exit") == 0) return print_exit(argv[2], argv[3]);
  if (argc > PROBE_MAX_ARGS) return 2;
  if (!setlocale(LC_ALL, "C.UTF-8") && !setlocale(LC_ALL, "en_US.UTF-8")) return 3;
  static wchar_t storage[PROBE_MAX_ARGS][PROBE_MAX_UNITS];
  wchar_t *wide[PROBE_MAX_ARGS];
  for (int i = 0; i < argc; i++) {
    size_t units = mbstowcs(storage[i], argv[i], PROBE_MAX_UNITS - 1);
    if (units == (size_t)-1 || units >= PROBE_MAX_UNITS - 1) return 4;
    storage[i][units] = 0;
    wide[i] = storage[i];
  }
  /* "--env" stands in for argv[0], so the launcher's own argv follows it unchanged. */
  if (argc > 1 && strcmp(argv[1], "--env") == 0) return print_environment(argc - 1, wide + 1);
  gx_launch_args args;
  const wchar_t *flag = 0;
  gx_arg_error error = gx_parse_args(argc, wide, &args, &flag);
  if (error != GX_ARG_OK) {
    printf("{\"ok\":false,\"error\":\"%s\",\"flag\":", gx_arg_error_name(error));
    if (flag) {
      print_string(flag);
    } else {
      printf("null");
    }
    puts("}");
    return 1;
  }
  print_parsed(&args);
  return 0;
}

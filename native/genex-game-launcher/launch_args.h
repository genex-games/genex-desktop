/*
 * The launcher's command line, container policy, game environment and exit codes: portable C (no
 * Windows headers), so the same code runs inside launcher.exe and inside args_probe on the
 * developer's own machine, where a test feeds it the argv the TypeScript builder writes
 * (src/substrate/windows-game-launch.ts) and reads back what the launcher would act on.
 *
 * Every value is checked lexically here; the host has already resolved the folders by realpath.
 * The launcher is the last gate before an AppContainer is set up and folder ACLs change, so it
 * repeats the checks instead of trusting its caller: the folders must be a run's own `bundle` and
 * `state` inside a folder named for the run id.
 */
#ifndef GENEX_LAUNCH_ARGS_H
#define GENEX_LAUNCH_ARGS_H

#include <stddef.h>
#include <wchar.h>

/* The longest path the launcher accepts, in UTF-16 units (MAX_PATH minus the terminator). */
#define GX_PATH_MAX_UNITS 259
/* A run id: 12-32 lowercase hex digits, as Genex names run folders (native-bundle.ts isRunId). */
#define GX_RUN_ID_MIN_UNITS 12
#define GX_RUN_ID_MAX_UNITS 32
/* The game's file name inside the bundle folder, ".exe" included. */
#define GX_EXE_NAME_MAX_UNITS 64
/* The job's memory limit bounds, in bytes. */
#define GX_MEMORY_MIN_BYTES (256ULL * 1024 * 1024)
#define GX_MEMORY_MAX_BYTES (64ULL * 1024 * 1024 * 1024)
/* The pipe every run's protocol uses: GX_PIPE_PREFIX followed by the run id. */
#define GX_PIPE_PREFIX L"\\\\.\\pipe\\genex-game-"
/* The AppContainer profile every run gets: GX_PROFILE_PREFIX followed by the run id. */
#define GX_PROFILE_PREFIX L"genex.game."
/* The run folder's two children, as the host's run layout names them. */
#define GX_BUNDLE_FOLDER L"bundle"
#define GX_STATE_FOLDER L"state"
/* The variable that names the protocol pipe in the game's environment. */
#define GX_PIPE_ENV L"GENEX_STUDIO_PIPE"
/* The prefix of the launcher's own variables the game also gets. */
#define GX_FORWARDED_ENV_PREFIX L"GENEX_"
/* An environment block's limit, in UTF-16 units. */
#define GX_ENV_BLOCK_MAX_UNITS 32767

/*
 * Exit codes the launcher reserves for its own failures. Everything else is the game's own exit
 * status, forwarded unchanged. 0xE0000000 is the customer-defined error range of NTSTATUS-style
 * codes; 0x47 is "G". src/substrate/windows-game-launch.ts's LAUNCHER_EXIT_CODES must match: a test
 * compares it with `args_probe --exit-codes`.
 */
#define GX_EXIT_BASE 0xE0470000u
#define GX_EXIT_RANGE_MASK 0xFFFF0000u
#define GX_EXIT_USAGE (GX_EXIT_BASE | 0x01u)
#define GX_EXIT_PROTOCOL_CHANNEL (GX_EXIT_BASE | 0x02u)
#define GX_EXIT_PROFILE (GX_EXIT_BASE | 0x03u)
#define GX_EXIT_GRANT (GX_EXIT_BASE | 0x04u)
#define GX_EXIT_PIPE (GX_EXIT_BASE | 0x05u)
#define GX_EXIT_JOB (GX_EXIT_BASE | 0x06u)
#define GX_EXIT_DESKTOP (GX_EXIT_BASE | 0x07u)
#define GX_EXIT_SPAWN (GX_EXIT_BASE | 0x08u)
#define GX_EXIT_PIPE_CLIENT (GX_EXIT_BASE | 0x09u)
#define GX_EXIT_WAIT (GX_EXIT_BASE | 0x0Au)
#define GX_EXIT_CLEANUP (GX_EXIT_BASE | 0x0Bu)
/* The host ended the protocol channel, so the launcher ended the game's job. */
#define GX_EXIT_STOPPED (GX_EXIT_BASE | 0x10u)
/* The game exited with a code in this range by itself: never reported as one of the launcher's. */
#define GX_EXIT_GAME_RESERVED (GX_EXIT_BASE | 0x11u)

/* One reserved exit code and its wire name. */
typedef struct {
  unsigned int code;
  const char *name;
} gx_exit_code;

/* Every reserved exit code, ending with {0, 0}. */
extern const gx_exit_code GX_EXIT_CODES[];

/*
 * The launcher's exit code for a game that exited with game_code, when the launcher itself ended
 * the game's job with ended_with (0 when it never did): the game's own code, unless that code is
 * in the reserved range and is not the one the launcher ended the job with.
 */
unsigned int gx_reported_exit(unsigned int game_code, unsigned int ended_with);

/*
 * Windows access-mask and inheritance values the policy uses, by their winnt.h values; launcher.c
 * asserts at compile time that each equals the Windows header's own.
 */
#define GX_FILE_GENERIC_READ 0x00120089u
#define GX_FILE_GENERIC_WRITE 0x00120116u
#define GX_FILE_GENERIC_EXECUTE 0x001200A0u
#define GX_DELETE 0x00010000u
#define GX_FILE_DELETE_CHILD 0x00000040u
/* SUB_CONTAINERS_AND_OBJECTS_INHERIT: the entry reaches every file and folder below. */
#define GX_INHERIT_ALL 3u

/* Which of the run's folders a grant is for. */
typedef enum { GX_FOLDER_BUNDLE = 0, GX_FOLDER_STATE = 1 } gx_folder;

/* One folder grant to the run's AppContainer: its access, inheritance and, when set, the mandatory label (SDDL). */
typedef struct {
  gx_folder folder;
  unsigned int access;
  unsigned int inheritance;
  const wchar_t *label_sddl;
} gx_folder_grant;

/* Every folder grant a run gets, ending with access 0: the bundle read + execute, state read + write + delete. */
extern const gx_folder_grant GX_FOLDER_GRANTS[];

/* The capability SIDs (SDDL) every run's AppContainer gets, ending with 0: none (no internetClient). */
extern const wchar_t *const GX_CAPABILITY_SIDS[];
/* The most capabilities the launcher can pass. */
#define GX_CAPABILITY_MAX 8

/* What one launcher invocation asks for. */
typedef enum { GX_MODE_RUN = 0, GX_MODE_DELETE_PROFILE = 1 } gx_mode;
typedef enum { GX_DESKTOP_INTERACTIVE = 0, GX_DESKTOP_HIDDEN = 1 } gx_desktop;

/* Why a command line was refused. */
typedef enum {
  GX_ARG_OK = 0,
  GX_ARG_UNKNOWN_FLAG,
  GX_ARG_MISSING_VALUE,
  GX_ARG_DUPLICATE_FLAG,
  GX_ARG_MISSING_FLAG,
  GX_ARG_BAD_RUN_ID,
  GX_ARG_BAD_FOLDER,
  GX_ARG_FOLDER_LAYOUT,
  GX_ARG_BAD_EXE,
  GX_ARG_BAD_PIPE,
  GX_ARG_BAD_MEMORY,
  GX_ARG_BAD_DESKTOP,
  GX_ARG_EXTRA_FLAG
} gx_arg_error;

/* A parsed command line. Strings point into argv. */
typedef struct {
  gx_mode mode;
  const wchar_t *run_id;
  const wchar_t *bundle;
  const wchar_t *state;
  const wchar_t *exe;
  const wchar_t *pipe;
  unsigned long long memory_bytes;
  gx_desktop desktop;
} gx_launch_args;

/*
 * Parses argv (argv[0] is the launcher itself). Run mode:
 *   --run-id <id> --bundle <dir>\<id>\bundle --state <dir>\<id>\state --exe <name.exe>
 *   --pipe <\\.\pipe\genex-game-id> --memory-bytes <n> --desktop interactive|hidden
 * Cleanup mode: --delete-profile --run-id <id>
 * Every flag is required in its mode and given once; anything else is refused. On a refusal
 * *flag names the offending flag, or is 0.
 */
gx_arg_error gx_parse_args(int argc, wchar_t **argv, gx_launch_args *out, const wchar_t **flag);

/* The wire name of a refusal, such as "bad-run-id". */
const char *gx_arg_error_name(gx_arg_error error);

/* The folder a grant names, for parsed run-mode args. */
const wchar_t *gx_grant_folder(const gx_launch_args *args, gx_folder folder);

/*
 * Writes the game's whole environment block into block (capacity in units): SystemRoot and windir
 * (windows_dir), PATH (system_dir), TEMP, TMP, APPDATA and LOCALAPPDATA (the state folder),
 * GENEX_STUDIO_PIPE (the run's pipe), then every GENEX_* entry of inherited except the pipe's
 * (names compared ASCII case-blind, as Windows does). inherited is a block of "NAME=value" entries,
 * each ending with 0, ended by an empty one. Returns the units written, the block's final 0
 * included, or 0 when it does not fit.
 */
size_t gx_build_environment(wchar_t *block, size_t capacity, const gx_launch_args *args, const wchar_t *windows_dir,
                            const wchar_t *system_dir, const wchar_t *inherited);

/* Writes "<prefix><run id>" into out (capacity in units); 0 when it does not fit, else 1. */
int gx_join(wchar_t *out, size_t capacity, const wchar_t *prefix, const wchar_t *run_id);

#endif

/*
 * genex-game-launcher.exe: starts one Genex game run inside a per-run AppContainer (plan M7).
 *
 *   genex-game-launcher --run-id <id> --bundle <run>\bundle --state <run>\state --exe game.exe
 *     --pipe \\.\pipe\genex-game-<id> --memory-bytes <n> --desktop interactive|hidden
 *   genex-game-launcher --delete-profile --run-id <id>
 *
 * What it does, in order (README.md has the reasons):
 *  1. Reads its command line with launch_args.c and refuses anything it does not expect.
 *  2. Takes CRT fd 3 from the host as the protocol channel (Node passes it as 'overlapped').
 *  3. Creates (or, after a crash, reopens) the AppContainer profile "genex.game.<id>" with the
 *     capabilities of GX_CAPABILITY_SIDS: none at all, so no internetClient.
 *  4. Applies GX_FOLDER_GRANTS: FILE_GENERIC_READ|EXECUTE on the bundle folder and read, write and
 *     delete on the state folder (inherited by everything below), with the state folder labelled
 *     low integrity so a low-integrity container can write there. Nothing else is granted.
 *  5. Creates the named pipe <pipe> (first and only instance, local clients only) that only the
 *     container may open, and puts its name in the game's GENEX_STUDIO_PIPE.
 *  6. Creates a Job Object: kill on close, one active process, the memory limit, no clipboard,
 *     no desktop switching, no global atoms, no system parameter changes.
 *  7. For --desktop hidden, creates a desktop "genex-game-<id>" the container may draw on.
 *  8. Starts the game suspended with STARTUPINFOEX: SECURITY_CAPABILITIES (the container),
 *     an explicit inherit list (NUL stdin, the launcher's stdout and stderr), child processes
 *     refused, and image loads from remote or low-label files refused (so nothing the game writes
 *     into state can be loaded as code). It joins the job before its first instruction runs.
 *  9. Relays bytes between fd 3 and the pipe (after checking the client is the game's pid).
 *     When the host closes fd 3, the job is terminated with GX_EXIT_STOPPED, even after the
 *     game's end of the pipe has failed.
 * 10. Exits with the game's own exit status after deleting the profile; a game that exits with a
 *     reserved code by itself is reported as GX_EXIT_GAME_RESERVED (gx_reported_exit).
 *
 * Built with zig cc -target x86_64-windows-gnu (README.md); signed with Genex's Windows identity
 * by release.yml once that certificate exists. It has never run on Windows yet: spike S9.
 */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <aclapi.h>
#include <io.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <userenv.h>

#include "launch_args.h"

/* The CRT descriptor the host passes the protocol on, as on the Mac (GENEX_STUDIO_FD=3). */
#define PROTOCOL_FD 3
/* How long the game's last protocol lines may take to reach the host after it exits. */
#define DRAIN_TIMEOUT_MS 2000
/* One relay read, and the pipe's own buffers. */
#define RELAY_BUFFER_BYTES 65536
#define PIPE_BUFFER_BYTES 65536
/* The game alone: it may not start other processes. */
#define ACTIVE_PROCESS_LIMIT 1
/* SDDL strings this launcher builds around one SID. */
#define SDDL_MAX_UNITS 512
/* The attributes STARTUPINFOEX carries. */
#define ATTRIBUTE_COUNT 4
#define PROFILE_DISPLAY_NAME L"Genex game run"
#define PROFILE_DESCRIPTION L"One Genex game run; deleted when the run ends."
#define DESKTOP_PREFIX L"genex-game-"
#define WINDOW_STATION L"WinSta0\\"
/* What the container may do on its hidden desktop. */
#define DESKTOP_ACCESS                                                                                 \
  (DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU | DESKTOP_WRITEOBJECTS | DESKTOP_ENUMERATE | \
   READ_CONTROL)
/* Low integrity on one object (the pipe, the hidden desktop): a low-integrity container may write to it. */
#define LOW_LABEL L"S:(ML;;NW;;;LW)"
#define JOB_LIMITS                                                                                        \
  (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_JOB_MEMORY | \
   JOB_OBJECT_LIMIT_ACTIVE_PROCESS)
/*
 * DISPLAYSETTINGS and HANDLES stay allowed: fullscreen mode changes and the shell's own windows.
 * Open until S9 (README.md): whether a Play run on the person's own desktop can read other apps'
 * keys (GetAsyncKeyState, raw input with RIDEV_INPUTSINK), screen (BitBlt from GetDC(NULL)) or
 * window text (WM_GETTEXT). If any can, HANDLES is set or Play gets a desktop of its own.
 */
#define JOB_UI_LIMITS                                                                                 \
  (JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS |      \
   JOB_OBJECT_UILIMIT_READCLIPBOARD | JOB_OBJECT_UILIMIT_WRITECLIPBOARD | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS)
#define MITIGATIONS                                                                                        \
  (PROCESS_CREATION_MITIGATION_POLICY_EXTENSION_POINT_DISABLE_ALWAYS_ON |                                  \
   PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_NO_REMOTE_ALWAYS_ON |                                     \
   PROCESS_CREATION_MITIGATION_POLICY_IMAGE_LOAD_NO_LOW_LABEL_ALWAYS_ON)

/* The portable policy's access values are Windows' own (launch_args.h cannot include windows.h). */
_Static_assert(GX_FILE_GENERIC_READ == FILE_GENERIC_READ, "FILE_GENERIC_READ");
_Static_assert(GX_FILE_GENERIC_WRITE == FILE_GENERIC_WRITE, "FILE_GENERIC_WRITE");
_Static_assert(GX_FILE_GENERIC_EXECUTE == FILE_GENERIC_EXECUTE, "FILE_GENERIC_EXECUTE");
_Static_assert(GX_DELETE == DELETE, "DELETE");
_Static_assert(GX_FILE_DELETE_CHILD == FILE_DELETE_CHILD, "FILE_DELETE_CHILD");
_Static_assert(GX_INHERIT_ALL == SUB_CONTAINERS_AND_OBJECTS_INHERIT, "SUB_CONTAINERS_AND_OBJECTS_INHERIT");
_Static_assert(GX_ENV_BLOCK_MAX_UNITS <= 32767, "an environment block's limit");

/* One run: everything the launcher opened, so finish() can close it in one place. */
typedef struct {
  gx_launch_args args;
  wchar_t profile[GX_RUN_ID_MAX_UNITS + 16];
  wchar_t desktop_name[GX_RUN_ID_MAX_UNITS + 32];
  wchar_t exe_path[GX_PATH_MAX_UNITS + 1];
  PSID container;
  HANDLE host;
  HANDLE pipe;
  HANDLE job;
  HDESK desktop;
  HANDLE connected;
  PROCESS_INFORMATION game;
  volatile LONG pipe_client_refused;
  /* The exit code the launcher itself ended the game's job with first, or 0 when it never did. */
  volatile LONG ended_with;
} launch;

/* Ends the game's job with code, recording that the launcher did (the first code wins). */
static void end_job(launch *run, DWORD code) {
  InterlockedCompareExchange(&run->ended_with, (LONG)code, 0);
  TerminateJobObject(run->job, code);
}

static DWORD fail(const char *step, DWORD error, DWORD exit_code) {
  fprintf(stderr, "genex-game-launcher: %s failed (error %lu)\n", step, (unsigned long)error);
  fflush(stderr);
  return exit_code;
}

/* An unopened descriptor must not abort the launcher: _get_osfhandle reports it instead. */
static void ignore_invalid_parameter(const wchar_t *expression, const wchar_t *function, const wchar_t *file,
                                     unsigned int line, uintptr_t reserved) {
  (void)expression;
  (void)function;
  (void)file;
  (void)line;
  (void)reserved;
}

/* Appends part to buffer (capacity in units, length tracked in *used); 0 when it does not fit. */
static int append(wchar_t *buffer, size_t capacity, size_t *used, const wchar_t *part) {
  size_t length = wcslen(part);
  if (*used + length + 1 > capacity) return 0;
  memcpy(buffer + *used, part, (length + 1) * sizeof *buffer);
  *used += length;
  return 1;
}

static DWORD open_host_channel(launch *run) {
  intptr_t raw = _get_osfhandle(PROTOCOL_FD);
  HANDLE handle = (HANDLE)raw;
  if (raw == -1 || raw == -2 || GetFileType(handle) != FILE_TYPE_PIPE) {
    return fail("protocol fd 3", GetLastError(), GX_EXIT_PROTOCOL_CHANNEL);
  }
  run->host = handle;
  return 0;
}

static DWORD open_profile(launch *run) {
  HRESULT result =
      CreateAppContainerProfile(run->profile, PROFILE_DISPLAY_NAME, PROFILE_DESCRIPTION, NULL, 0, &run->container);
  if (result == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
    result = DeriveAppContainerSidFromAppContainerName(run->profile, &run->container);
  }
  if (FAILED(result)) return fail("AppContainer profile", (DWORD)result, GX_EXIT_PROFILE);
  return 0;
}

/*
 * Holds the folder open without FILE_SHARE_DELETE, so it cannot be renamed or replaced while its
 * ACL changes, and refuses a junction or symlink in its place.
 */
static HANDLE hold_folder(const wchar_t *folder) {
  HANDLE handle = CreateFileW(folder, READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) return NULL;
  BY_HANDLE_FILE_INFORMATION info;
  DWORD wanted = FILE_ATTRIBUTE_DIRECTORY;
  DWORD refused = FILE_ATTRIBUTE_REPARSE_POINT;
  if (!GetFileInformationByHandle(handle, &info) || !(info.dwFileAttributes & wanted) ||
      (info.dwFileAttributes & refused)) {
    CloseHandle(handle);
    SetLastError(ERROR_DIRECTORY);
    return NULL;
  }
  return handle;
}

/* Adds one allow entry for sid to the folder's DACL; SetNamedSecurityInfoW propagates an inherited one. */
static DWORD grant_folder(const wchar_t *folder, PSID sid, DWORD access, DWORD inheritance) {
  PACL current = NULL;
  PACL merged = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD status = GetNamedSecurityInfoW(folder, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &current, NULL,
                                       &descriptor);
  if (status != ERROR_SUCCESS) return status;
  EXPLICIT_ACCESS_W entry;
  ZeroMemory(&entry, sizeof entry);
  entry.grfAccessPermissions = access;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = inheritance;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = (LPWSTR)sid;
  status = SetEntriesInAclW(1, &entry, current, &merged);
  if (status == ERROR_SUCCESS) {
    status = SetNamedSecurityInfoW((LPWSTR)folder, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, merged, NULL);
  }
  LocalFree(merged);
  LocalFree(descriptor);
  return status;
}

/* Sets the mandatory label an SDDL string names on a folder (by name) or on an object (by handle). */
static DWORD set_label(const wchar_t *folder, HANDLE object, const wchar_t *label_sddl) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(label_sddl, SDDL_REVISION_1, &descriptor, NULL)) {
    return GetLastError();
  }
  PACL sacl = NULL;
  BOOL present = FALSE;
  BOOL defaulted = FALSE;
  DWORD status = ERROR_INVALID_SECURITY_DESCR;
  if (GetSecurityDescriptorSacl(descriptor, &present, &sacl, &defaulted) && present) {
    status = folder ? SetNamedSecurityInfoW((LPWSTR)folder, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, NULL, NULL,
                                            NULL, sacl)
                    : SetSecurityInfo(object, SE_WINDOW_OBJECT, LABEL_SECURITY_INFORMATION, NULL, NULL, NULL, sacl);
  }
  LocalFree(descriptor);
  return status;
}

static DWORD grant_folders(launch *run) {
  HANDLE bundle = hold_folder(run->args.bundle);
  if (!bundle) return fail("bundle folder", GetLastError(), GX_EXIT_GRANT);
  HANDLE state = hold_folder(run->args.state);
  if (!state) {
    CloseHandle(bundle);
    return fail("state folder", GetLastError(), GX_EXIT_GRANT);
  }
  DWORD status = ERROR_SUCCESS;
  for (const gx_folder_grant *grant = GX_FOLDER_GRANTS; grant->access && status == ERROR_SUCCESS; grant++) {
    const wchar_t *folder = gx_grant_folder(&run->args, grant->folder);
    status = grant_folder(folder, run->container, grant->access, grant->inheritance);
    if (status == ERROR_SUCCESS && grant->label_sddl) status = set_label(folder, NULL, grant->label_sddl);
  }
  CloseHandle(state);
  CloseHandle(bundle);
  if (status != ERROR_SUCCESS) return fail("folder grant", status, GX_EXIT_GRANT);
  return 0;
}

/* "D:P(A;;GA;;;SY)(A;;GRGW;;;<container>)" plus a low label: SYSTEM and this run's container only. */
static int pipe_sddl(PSID container, wchar_t *sddl, size_t capacity) {
  LPWSTR sid_text = NULL;
  if (!ConvertSidToStringSidW(container, &sid_text)) return 0;
  size_t used = 0;
  int fits = append(sddl, capacity, &used, L"D:P(A;;GA;;;SY)(A;;GRGW;;;") && append(sddl, capacity, &used, sid_text) &&
             append(sddl, capacity, &used, L")") && append(sddl, capacity, &used, LOW_LABEL);
  LocalFree(sid_text);
  return fits;
}

static DWORD create_pipe(launch *run) {
  wchar_t sddl[SDDL_MAX_UNITS];
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!pipe_sddl(run->container, sddl, SDDL_MAX_UNITS) ||
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL)) {
    return fail("pipe security", GetLastError(), GX_EXIT_PIPE);
  }
  SECURITY_ATTRIBUTES attributes = {sizeof attributes, descriptor, FALSE};
  DWORD open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED;
  DWORD pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
  run->pipe =
      CreateNamedPipeW(run->args.pipe, open_mode, pipe_mode, 1, PIPE_BUFFER_BYTES, PIPE_BUFFER_BYTES, 0, &attributes);
  DWORD error = GetLastError();
  LocalFree(descriptor);
  if (run->pipe == INVALID_HANDLE_VALUE) {
    run->pipe = NULL;
    return fail("named pipe", error, GX_EXIT_PIPE);
  }
  run->connected = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!run->connected) return fail("pipe event", GetLastError(), GX_EXIT_PIPE);
  return 0;
}

static DWORD create_job(launch *run) {
  run->job = CreateJobObjectW(NULL, NULL);
  if (!run->job) return fail("job object", GetLastError(), GX_EXIT_JOB);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_LIMITS;
  limits.BasicLimitInformation.ActiveProcessLimit = ACTIVE_PROCESS_LIMIT;
  limits.JobMemoryLimit = (SIZE_T)run->args.memory_bytes;
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui = {JOB_UI_LIMITS};
  if (!SetInformationJobObject(run->job, JobObjectExtendedLimitInformation, &limits, sizeof limits) ||
      !SetInformationJobObject(run->job, JobObjectBasicUIRestrictions, &ui, sizeof ui)) {
    return fail("job limits", GetLastError(), GX_EXIT_JOB);
  }
  return 0;
}

/* Adds the container's entry to the hidden desktop's DACL and labels it low integrity. */
static DWORD open_desktop_to_container(HDESK desktop, PSID container) {
  PACL current = NULL;
  PACL merged = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD status =
      GetSecurityInfo(desktop, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &current, NULL, &descriptor);
  if (status != ERROR_SUCCESS) return status;
  EXPLICIT_ACCESS_W entry;
  ZeroMemory(&entry, sizeof entry);
  entry.grfAccessPermissions = DESKTOP_ACCESS;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = (LPWSTR)container;
  status = SetEntriesInAclW(1, &entry, current, &merged);
  if (status == ERROR_SUCCESS) {
    status = SetSecurityInfo(desktop, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, merged, NULL);
  }
  if (status == ERROR_SUCCESS) status = set_label(NULL, desktop, LOW_LABEL);
  LocalFree(merged);
  LocalFree(descriptor);
  return status;
}

static DWORD create_hidden_desktop(launch *run) {
  if (run->args.desktop != GX_DESKTOP_HIDDEN) return 0;
  wchar_t name[GX_RUN_ID_MAX_UNITS + 16];
  size_t used = 0;
  if (!gx_join(name, sizeof name / sizeof name[0], DESKTOP_PREFIX, run->args.run_id) ||
      !append(run->desktop_name, sizeof run->desktop_name / sizeof run->desktop_name[0], &used, WINDOW_STATION) ||
      !append(run->desktop_name, sizeof run->desktop_name / sizeof run->desktop_name[0], &used, name)) {
    return fail("desktop name", ERROR_BUFFER_OVERFLOW, GX_EXIT_DESKTOP);
  }
  run->desktop = CreateDesktopW(name, NULL, NULL, 0, READ_CONTROL | WRITE_DAC | WRITE_OWNER | DESKTOP_CREATEWINDOW, NULL);
  if (!run->desktop) return fail("hidden desktop", GetLastError(), GX_EXIT_DESKTOP);
  DWORD status = open_desktop_to_container(run->desktop, run->container);
  if (status != ERROR_SUCCESS) return fail("hidden desktop grant", status, GX_EXIT_DESKTOP);
  return 0;
}

/* The game's whole environment (gx_build_environment): Windows' own folders, state as temp, the pipe, GENEX_*. */
static int build_environment(const launch *run, wchar_t *block) {
  wchar_t windows[MAX_PATH + 1];
  wchar_t system[MAX_PATH + 1];
  UINT windows_length = GetSystemWindowsDirectoryW(windows, MAX_PATH + 1);
  UINT system_length = GetSystemDirectoryW(system, MAX_PATH + 1);
  if (windows_length == 0 || windows_length > MAX_PATH || system_length == 0 || system_length > MAX_PATH) return 0;
  LPWCH inherited = GetEnvironmentStringsW();
  if (!inherited) return 0;
  size_t used = gx_build_environment(block, GX_ENV_BLOCK_MAX_UNITS, &run->args, windows, system, inherited);
  FreeEnvironmentStringsW(inherited);
  return used != 0;
}

/* An inheritable copy of one of the launcher's standard handles, or of NUL when it has none. */
static HANDLE inheritable_std(DWORD which, DWORD nul_access) {
  HANDLE own = GetStdHandle(which);
  HANDLE copy = NULL;
  if (own && own != INVALID_HANDLE_VALUE &&
      DuplicateHandle(GetCurrentProcess(), own, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
    return copy;
  }
  SECURITY_ATTRIBUTES inherit = {sizeof inherit, NULL, TRUE};
  copy = CreateFileW(L"NUL", nul_access, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, NULL);
  return copy == INVALID_HANDLE_VALUE ? NULL : copy;
}

/* Everything CreateProcessW needs that must outlive the call. */
typedef struct {
  SECURITY_CAPABILITIES capabilities;
  SID_AND_ATTRIBUTES capability_sids[GX_CAPABILITY_MAX];
  HANDLE inherit[3];
  DWORD child_policy;
  DWORD64 mitigations;
  LPPROC_THREAD_ATTRIBUTE_LIST list;
} spawn_attributes;

/* The container's capabilities, exactly GX_CAPABILITY_SIDS (none today); 0 when one cannot be read. */
static int prepare_capabilities(spawn_attributes *spawn, PSID container) {
  spawn->capabilities.AppContainerSid = container;
  spawn->capabilities.Capabilities = NULL;
  spawn->capabilities.CapabilityCount = 0;
  for (const wchar_t *const *sid = GX_CAPABILITY_SIDS; *sid; sid++) {
    DWORD count = spawn->capabilities.CapabilityCount;
    if (count == GX_CAPABILITY_MAX || !ConvertStringSidToSidW(*sid, &spawn->capability_sids[count].Sid)) return 0;
    spawn->capability_sids[count].Attributes = SE_GROUP_ENABLED;
    spawn->capabilities.Capabilities = spawn->capability_sids;
    spawn->capabilities.CapabilityCount = count + 1;
  }
  return 1;
}

static int prepare_attributes(spawn_attributes *spawn, PSID container) {
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, ATTRIBUTE_COUNT, 0, &size);
  spawn->list = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
  if (!spawn->list || !InitializeProcThreadAttributeList(spawn->list, ATTRIBUTE_COUNT, 0, &size)) return 0;
  if (!prepare_capabilities(spawn, container)) return 0;
  spawn->child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
  spawn->mitigations = MITIGATIONS;
  return UpdateProcThreadAttribute(spawn->list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &spawn->capabilities,
                                   sizeof spawn->capabilities, NULL, NULL) &&
         UpdateProcThreadAttribute(spawn->list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, spawn->inherit,
                                   sizeof spawn->inherit, NULL, NULL) &&
         UpdateProcThreadAttribute(spawn->list, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &spawn->child_policy,
                                   sizeof spawn->child_policy, NULL, NULL) &&
         UpdateProcThreadAttribute(spawn->list, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, &spawn->mitigations,
                                   sizeof spawn->mitigations, NULL, NULL);
}

static void release_attributes(spawn_attributes *spawn) {
  if (spawn->list) {
    DeleteProcThreadAttributeList(spawn->list);
    HeapFree(GetProcessHeap(), 0, spawn->list);
  }
  for (int i = 0; i < 3; i++) {
    if (spawn->inherit[i]) CloseHandle(spawn->inherit[i]);
  }
  for (DWORD i = 0; i < spawn->capabilities.CapabilityCount; i++) LocalFree(spawn->capability_sids[i].Sid);
}

/* Starts the game suspended, puts it in the job, then lets it run. */
static DWORD start_game(launch *run, wchar_t *environment) {
  size_t used = 0;
  size_t capacity = sizeof run->exe_path / sizeof run->exe_path[0];
  wchar_t command_line[GX_PATH_MAX_UNITS + 3];
  size_t line_used = 0;
  if (!append(run->exe_path, capacity, &used, run->args.bundle) || !append(run->exe_path, capacity, &used, L"\\") ||
      !append(run->exe_path, capacity, &used, run->args.exe) ||
      !append(command_line, GX_PATH_MAX_UNITS + 3, &line_used, L"\"") ||
      !append(command_line, GX_PATH_MAX_UNITS + 3, &line_used, run->exe_path) ||
      !append(command_line, GX_PATH_MAX_UNITS + 3, &line_used, L"\"")) {
    return fail("game path", ERROR_BUFFER_OVERFLOW, GX_EXIT_SPAWN);
  }
  spawn_attributes spawn;
  ZeroMemory(&spawn, sizeof spawn);
  spawn.inherit[0] = inheritable_std(STD_INPUT_HANDLE, GENERIC_READ);
  spawn.inherit[1] = inheritable_std(STD_OUTPUT_HANDLE, GENERIC_WRITE);
  spawn.inherit[2] = inheritable_std(STD_ERROR_HANDLE, GENERIC_WRITE);
  if (!spawn.inherit[0] || !spawn.inherit[1] || !spawn.inherit[2] || !prepare_attributes(&spawn, run->container)) {
    DWORD error = GetLastError();
    release_attributes(&spawn);
    return fail("game attributes", error, GX_EXIT_SPAWN);
  }
  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof startup);
  startup.StartupInfo.cb = sizeof startup;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = spawn.inherit[0];
  startup.StartupInfo.hStdOutput = spawn.inherit[1];
  startup.StartupInfo.hStdError = spawn.inherit[2];
  startup.StartupInfo.lpDesktop = run->desktop ? run->desktop_name : NULL;
  startup.lpAttributeList = spawn.list;
  DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
  BOOL started = CreateProcessW(run->exe_path, command_line, NULL, NULL, TRUE, flags, environment, run->args.bundle,
                                &startup.StartupInfo, &run->game);
  DWORD error = GetLastError();
  release_attributes(&spawn);
  if (!started) return fail("game start", error, GX_EXIT_SPAWN);
  if (!AssignProcessToJobObject(run->job, run->game.hProcess)) {
    error = GetLastError();
    TerminateProcess(run->game.hProcess, GX_EXIT_JOB);
    return fail("job assignment", error, GX_EXIT_JOB);
  }
  if (ResumeThread(run->game.hThread) == (DWORD)-1) {
    error = GetLastError();
    end_job(run, GX_EXIT_SPAWN);
    return fail("game resume", error, GX_EXIT_SPAWN);
  }
  return 0;
}

/* One overlapped read or write on an overlapped handle, waited for in place. */
static BOOL transfer(HANDLE handle, char *buffer, DWORD size, DWORD *moved, HANDLE event, BOOL writing) {
  OVERLAPPED overlapped;
  ZeroMemory(&overlapped, sizeof overlapped);
  overlapped.hEvent = event;
  BOOL done = writing ? WriteFile(handle, buffer, size, NULL, &overlapped)
                      : ReadFile(handle, buffer, size, NULL, &overlapped);
  if (!done && GetLastError() != ERROR_IO_PENDING) return FALSE;
  return GetOverlappedResult(handle, &overlapped, moved, TRUE);
}

static BOOL write_all(HANDLE handle, char *buffer, DWORD size, HANDLE event) {
  while (size > 0) {
    DWORD written = 0;
    if (!transfer(handle, buffer, size, &written, event, TRUE) || written == 0) return FALSE;
    buffer += written;
    size -= written;
  }
  return TRUE;
}

/* Waits for the game to open the pipe and checks it is the game; FALSE when it never does. */
static BOOL await_client(launch *run, HANDLE event) {
  OVERLAPPED overlapped;
  ZeroMemory(&overlapped, sizeof overlapped);
  overlapped.hEvent = event;
  BOOL connected = ConnectNamedPipe(run->pipe, &overlapped);
  DWORD error = GetLastError();
  if (!connected && error == ERROR_IO_PENDING) {
    HANDLE waits[2] = {event, run->game.hProcess};
    DWORD ignored = 0;
    if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) {
      CancelIoEx(run->pipe, &overlapped);
      GetOverlappedResult(run->pipe, &overlapped, &ignored, TRUE);
      return FALSE;
    }
    connected = GetOverlappedResult(run->pipe, &overlapped, &ignored, FALSE);
  } else if (!connected) {
    connected = error == ERROR_PIPE_CONNECTED;
  }
  ULONG client = 0;
  if (!connected || !GetNamedPipeClientProcessId(run->pipe, &client) || client != run->game.dwProcessId) {
    InterlockedExchange(&run->pipe_client_refused, connected ? 1 : 0);
    if (connected) end_job(run, GX_EXIT_PIPE_CLIENT);
    return FALSE;
  }
  SetEvent(run->connected);
  return TRUE;
}

/* Game → host: the game's protocol lines, byte for byte, until the game closes its end. */
static DWORD WINAPI relay_to_host(LPVOID context) {
  launch *run = (launch *)context;
  static char buffer[RELAY_BUFFER_BYTES];
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!event) {
    end_job(run, GX_EXIT_WAIT);
    return 0;
  }
  BOOL open = await_client(run, event);
  while (open) {
    DWORD got = 0;
    open = transfer(run->pipe, buffer, sizeof buffer, &got, event, FALSE) &&
           (got == 0 || write_all(run->host, buffer, got, event));
  }
  CloseHandle(event);
  return 0;
}

/*
 * Host → game; the host closing fd 3 is its Stop: the whole job ends with GX_EXIT_STOPPED. fd 3 is
 * read to its end whatever happens to the game's side: once the game's pipe fails (or the game
 * exits before opening it) the host's bytes are dropped, so the host's Stop still ends the job.
 */
static DWORD WINAPI relay_to_game(LPVOID context) {
  launch *run = (launch *)context;
  static char buffer[RELAY_BUFFER_BYTES];
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!event) {
    end_job(run, GX_EXIT_WAIT);
    return 0;
  }
  HANDLE waits[2] = {run->connected, run->game.hProcess};
  BOOL forwarding = TRUE;
  for (;;) {
    DWORD got = 0;
    if (!transfer(run->host, buffer, sizeof buffer, &got, event, FALSE)) break;
    if (got == 0 || !forwarding) continue;
    BOOL game_open = WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0;
    forwarding = game_open && write_all(run->pipe, buffer, got, event);
  }
  end_job(run, GX_EXIT_STOPPED);
  CloseHandle(event);
  return 0;
}

/* Relays until the game exits; its exit status, or the launcher's own failure code. */
static DWORD supervise(launch *run) {
  HANDLE to_host = CreateThread(NULL, 0, relay_to_host, run, 0, NULL);
  HANDLE to_game = CreateThread(NULL, 0, relay_to_game, run, 0, NULL);
  if (!to_host || !to_game) {
    end_job(run, GX_EXIT_WAIT);
    return fail("relay threads", GetLastError(), GX_EXIT_WAIT);
  }
  if (WaitForSingleObject(run->game.hProcess, INFINITE) != WAIT_OBJECT_0) {
    end_job(run, GX_EXIT_WAIT);
    return fail("game wait", GetLastError(), GX_EXIT_WAIT);
  }
  DWORD code = GX_EXIT_WAIT;
  if (!GetExitCodeProcess(run->game.hProcess, &code)) return fail("game exit status", GetLastError(), GX_EXIT_WAIT);
  WaitForSingleObject(to_host, DRAIN_TIMEOUT_MS);
  if (run->pipe_client_refused) return fail("pipe client check", ERROR_ACCESS_DENIED, GX_EXIT_PIPE_CLIENT);
  return gx_reported_exit(code, (DWORD)run->ended_with);
}

static DWORD delete_profile(const wchar_t *profile) {
  HRESULT result = DeleteAppContainerProfile(profile);
  BOOL absent = result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) || result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
  if (FAILED(result) && !absent) return fail("profile deletion", (DWORD)result, GX_EXIT_CLEANUP);
  return 0;
}

/* Closes what the run opened, ends the job and deletes the profile; the exit status stays the game's. */
static void finish(launch *run) {
  if (run->job) {
    TerminateJobObject(run->job, GX_EXIT_STOPPED);
    CloseHandle(run->job);
  }
  if (run->game.hThread) CloseHandle(run->game.hThread);
  if (run->game.hProcess) CloseHandle(run->game.hProcess);
  if (run->pipe) CloseHandle(run->pipe);
  if (run->desktop) CloseDesktop(run->desktop);
  if (run->container) {
    FreeSid(run->container);
    delete_profile(run->profile);
  }
}

static DWORD run_game(launch *run) {
  static wchar_t environment[GX_ENV_BLOCK_MAX_UNITS];
  DWORD failed = open_host_channel(run);
  if (!failed) failed = open_profile(run);
  if (!failed) failed = grant_folders(run);
  if (!failed) failed = create_pipe(run);
  if (!failed) failed = create_job(run);
  if (!failed) failed = create_hidden_desktop(run);
  if (!failed && !build_environment(run, environment)) failed = fail("environment", ERROR_BUFFER_OVERFLOW, GX_EXIT_SPAWN);
  if (!failed) failed = start_game(run, environment);
  return failed ? failed : supervise(run);
}

int wmain(int argc, wchar_t **argv) {
  static launch run;
  _set_invalid_parameter_handler(ignore_invalid_parameter);
  const wchar_t *flag = NULL;
  gx_arg_error refused = gx_parse_args(argc, argv, &run.args, &flag);
  if (refused != GX_ARG_OK) {
    fprintf(stderr, "genex-game-launcher: %s %ls\n", gx_arg_error_name(refused), flag ? flag : L"");
    ExitProcess(GX_EXIT_USAGE);
  }
  gx_join(run.profile, sizeof run.profile / sizeof run.profile[0], GX_PROFILE_PREFIX, run.args.run_id);
  if (run.args.mode == GX_MODE_DELETE_PROFILE) ExitProcess(delete_profile(run.profile));
  DWORD code = run_game(&run);
  finish(&run);
  fflush(stdout);
  fflush(stderr);
  ExitProcess(code);
}

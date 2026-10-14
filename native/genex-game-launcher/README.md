# genex-game-launcher

The Windows game box (plan M7, D19 = C): a small Genex-owned C program that starts one game run
inside a per-run AppContainer. `ProcessSandbox.spawnGame` on a Windows host starts it through
`src/substrate/windows-game-launch.ts`, which checks the run by realpath and writes its argv: as
on the Mac, the run folder must be `<native-runs>\<run id>` itself (no link), the bundle and
state its own `bundle` and `state`, the game a plain name in the bundle, and each run folder
starts once (the host creates `launch.claim` in it exclusively before it spawns).

Status: cross-compiled and its parser tested on a Mac; **never run on Windows**. Spike S9 (a
Windows runner, then a real Windows 11 PC) proves it; `release.yml` signs it with Genex's own
Windows certificate once that certificate exists. Until then no Genex build ships it.

## Files

| File | What it is |
| --- | --- |
| `launcher.c` | The Windows program (`wmain`). Windows-only. |
| `launch_args.h`, `launch_args.c` | The command line, container policy (capabilities, folder grants), game environment and exit codes, in portable C. |
| `args_probe.c` | A test driver, never shipped: runs that portable code on the build machine. |

## Command line

```
genex-game-launcher --run-id <id> --bundle <run>\bundle --state <run>\state --exe game.exe
                    --pipe \\.\pipe\genex-game-<id> --memory-bytes <n> --desktop interactive|hidden
genex-game-launcher --delete-profile --run-id <id>
```

Every flag is required in its mode and given once; an unknown flag is refused, so no argument can
add a capability. The launcher re-checks every value even though the host already has: run id
12–32 lowercase hex digits (as Genex names run folders); folders `X:\…` with no share, device
path, `.`/`..` segment, trailing dot or space, stream (`:`), or more than 259 UTF-16 units; the
bundle and state are exactly `<run>\bundle` and `<run>\state` of one run folder named for the run
id (ASCII case-blind), so a stray caller cannot relabel a person's own folders; the game is a
plain `*.exe` name in the bundle; the pipe is exactly `\\.\pipe\genex-game-<id>`; the memory
limit is 256 MiB–64 GiB.

## What a run gets

1. **Protocol.** The host passes CRT fd 3 (Node `stdio[3] = 'overlapped'`, so one thread can
   read it while another writes). The launcher relays it byte for byte to and from the named pipe.
   The host closing fd 3 is Stop: the launcher terminates the job (exit `stopped`). It keeps
   reading fd 3 after the game's end of the pipe fails, so Stop still ends the job.
2. **AppContainer** `genex.game.<id>`, created (or, after a crash, reopened) with the
   capabilities `GX_CAPABILITY_SIDS` lists: **none**, so no `internetClient`, no
   `privateNetworkClientServer`, no library access.
3. **Folders** (`GX_FOLDER_GRANTS`). The container gets `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE`
   on the bundle and `FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD` (no
   execute) on the state folder, inherited by everything below; the state folder is labelled low
   integrity so a low-integrity container may write there. Each folder is held open without
   `FILE_SHARE_DELETE` while its ACL changes, and a junction in its place is refused.
4. **Pipe.** First and only instance, local clients only, DACL `SYSTEM` + this container only,
   low-integrity label. The game opens it with `GENERIC_READ | GENERIC_WRITE` from
   `GENEX_STUDIO_PIPE`; the launcher checks the client's pid is the game's before relaying.
5. **Job Object.** Kill on job close (so killing the launcher kills the game), one active process,
   the memory limit, die on unhandled exception; no clipboard, desktop switching, global atoms,
   system-parameter changes or log-off. Display-mode changes stay allowed (exclusive fullscreen).
6. **Desktop.** `interactive` is the person's desktop (Play). `hidden` creates
   `WinSta0\genex-game-<id>`, which only the container may draw on (agent runs, embedded runs).
7. **Process.** `STARTUPINFOEX` with `SECURITY_CAPABILITIES`, an explicit inherit list (NUL
   stdin, the launcher's stdout and stderr), child processes refused, and image loads from remote
   or low-label files refused, so nothing the game writes into state can be loaded as code. It
   starts suspended and joins the job before its first instruction.
8. **Environment** (`gx_build_environment`). Exactly `SystemRoot`, `windir`, `PATH` (System32),
   `TEMP`/`TMP`/`APPDATA`/`LOCALAPPDATA` (the state folder), `GENEX_STUDIO_PIPE`, and the
   launcher's own `GENEX_*` (a `GENEX_STUDIO_PIPE` of its own is dropped).
9. **Exit.** The game's own status, after the profile is deleted. A game that exits with a code
   in the reserved range by itself is reported as `game-reserved`, never as one of the
   launcher's (`gx_reported_exit`). A killed launcher cannot delete the profile: the host runs
   `--delete-profile` afterwards (deleting an absent profile succeeds).

Reserved exit codes (`0xE047xxxx`, in `launch_args.h`; `LAUNCHER_EXIT_CODES` in the TypeScript mirrors
them and a test compares the two): `usage` 1, `protocol-channel` 2, `profile` 3, `grant` 4,
`pipe` 5, `job` 6, `desktop` 7, `spawn` 8, `pipe-client` 9, `wait` 10, `cleanup` 11, `stopped` 16,
`game-reserved` 17.

## Host side

`ProcessSandbox.spawnGame` (`src/substrate/spawn.ts`) starts it with a run's `bundle\game.exe`
only when this build ships the launcher as a regular file (else `no-game-box`,
`launcher-missing`); an agent's headless run is refused `no-headless-build`. A planning refusal
or one of the launcher's own failure codes is `no-game-box` with `box-refused`; `stopped` reads
as a clean exit and `game-reserved` as a crash. Stop sends `quit`, then closes fd 3, then ends the
launcher through its own handle (whose job ends the game; `dispose` does the same, never a
process group), and runs `--delete-profile` once after any exit the launcher did not report
itself: a kill (by handle, or by pid, which Windows reports as exit 1) or a crash.

## Build

```sh
zig cc -target x86_64-windows-gnu -municode -static -O2 -std=c11 -Wall -Wextra -Werror \
  -o genex-game-launcher.exe launcher.c launch_args.c -ladvapi32 -luserenv
```

zig 0.16.0 links the Universal CRT (`api-ms-win-crt-*`, part of Windows 10+). The PE imports
only `KERNEL32`, `ADVAPI32`, `USERENV`, `USER32` and the UCRT: no network or OpenGL DLL.

## Tests

`tests/conformance/host-game-box.test.ts` drives `spawnGame` on an injected Windows host with a
recording spawn. `tests/conformance/windows-game-launch.test.ts` builds `args_probe` with zig and feeds it the
TypeScript builder's argv and a hostile table; reads the policy (`--policy`: no capabilities,
exactly the two grants), the game's environment (`--env`) and the exit reporting (`--exit`);
cross-compiles the launcher (which asserts at compile time that the policy's access values are
Windows' own) and reads its imports with llvm-mingw's `llvm-readobj`. Each row skips when the
dev toolchains lack zig or llvm-mingw.

## Open until S9

- Whether ANGLE-D3D11 renders in the container on the interactive desktop, and on WARP on the
  hidden desktop (window-station access for a custom desktop is the open part).
- Whether `JOB_OBJECT_UILIMIT_*` or the extension-point mitigation (which also blocks legacy
  IMEs and global hooks) breaks GLFW input or text entry.
- The Job Object kill and the named-pipe relay under a real Genex host, including: the game
  closes its pipe handle, the host closes fd 3, and the launcher exits `stopped`.
- Whether the game can traverse below `state\` without `FILE_TRAVERSE` (an AppContainer token
  keeps `SeChangeNotifyPrivilege`, bypass traverse checking).
- What a Play run on the person's own desktop can see of other apps, probed from inside the
  container while another app is in front: their keys (`GetAsyncKeyState`, raw input with
  `RIDEV_INPUTSINK`), their screen (`BitBlt` from `GetDC(NULL)`) and their windows' text
  (`WM_GETTEXT`). The Linux design refuses X11 for exactly this (D19). If any probe succeeds,
  set `JOB_OBJECT_UILIMIT_HANDLES` or give windowed Play a desktop of its own, or record the
  owner's decision.

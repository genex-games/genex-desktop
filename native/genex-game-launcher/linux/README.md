# genex-wayland-context

The Linux game box's Wayland helper (plan M4.3). A boxed game's window never reaches the
session's own compositor socket: on wlroots compositors (sway, Hyprland) that socket offers every
client privileged globals (virtual keyboard and pointer, screencopy, data control). For each
windowed run the host starts this helper, which asks the compositor through
`wp_security_context_manager_v1` (staging protocol `security-context-v1`) for a listening socket of
the run's own, tagged sandbox engine `genex`, app id `games.genex.game` and the run id as instance.
The box binds only that socket (`src/substrate/linux-game-box.ts`, `openWaylandContext`).

Status: built and driven against a stand-in compositor on macOS and on Linux (Debian, arm64) by
`tests/conformance/linux-game-box.test.ts`; cross-compiles for `x86_64-linux-gnu.2.28`. Never run
against a real compositor; no package ships it yet (see "Shipping").

## Command line

```
WAYLAND_DISPLAY=<compositor socket> genex-wayland-context --socket <abs path> --app-id <token> --instance-id <token>
```

Every flag is required and given once; tokens are 1-64 of `[A-Za-z0-9._-]`. `WAYLAND_DISPLAY` is
the only variable the host passes: the compositor's socket as an absolute path (a plain name under
`XDG_RUNTIME_DIR` also works). `--socket` lies in a fresh 0700 folder the host made
(`$XDG_RUNTIME_DIR/genex-wl-<run id>`); the helper creates and listens on it.

## What it prints

One line on stdout, then:

| Line | Exit | Meaning |
| --- | --- | --- |
| `ready` | 0 after stdin closes | The compositor accepts sandboxed clients on `--socket` until the helper exits. |
| `unrestricted` | 3 | The compositor offers no `wp_security_context_manager_v1`; windowed play is refused `wayland-unrestricted`. |
| `failed usage` | 2 | A flag missing, repeated or unsafe. |
| `failed connect` | 5 | The compositor's socket did not answer. |
| `failed registry` / `failed commit` | 4 | The compositor sent an error or closed the connection. |
| `failed socket` | 6 | The run's socket or the close pipe could not be made. |

After `ready` the helper holds only the write end of the pipe whose read end the compositor got as
`close_fd`. When the host closes the helper's stdin (the run ended) or Genex dies (the pipe
closes with it), or the helper is killed, that end closes and the compositor stops accepting on
the socket; the helper also removes the socket file.

## Building

It speaks the Wayland wire protocol itself (no libwayland-client), so it needs only a C library:

```
# from a Mac, with the dev store's Zig (glibc 2.28 is the Linux floor)
zig cc -target x86_64-linux-gnu.2.28 -std=c11 -D_GNU_SOURCE -O2 -s \
  -o genex-wayland-context native/genex-game-launcher/linux/wayland_context.c
# on Linux
cc -std=c11 -D_GNU_SOURCE -O2 -s -o genex-wayland-context native/genex-game-launcher/linux/wayland_context.c
```

## Shipping

Not wired yet: the Linux package build must compile it into the app's resources, and
`ProcessSandbox` must hand `openWaylandContext` to the box (`GameBoxSeams.waylandContext`) and
close each context when its run ends. Until then a Linux build reports `wayland-helper-missing`
for windowed play.

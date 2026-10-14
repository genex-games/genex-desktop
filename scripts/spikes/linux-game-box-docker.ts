/**
 * Opt-in proof for the Linux game box (M7 spike S10, its headless half and the socket plumbing of
 * its windowed half), run in a throwaway linux/amd64 ubuntu:24.04 container with bubblewrap.
 *
 *   GENEX_SPIKE_DOCKER=1 node scripts/spikes/linux-game-box-docker.ts
 *
 * The planner in `src/substrate/linux-game-box.ts` checks the container's own file system (each
 * lstat, realpath and readlink is a `docker exec` as the container's non-root user), and the argv
 * it builds starts, through `launchLinuxGameBox`, as that user, with the seccomp program written to
 * bubblewrap's fd 4 (here: the `docker exec -i` stdin, moved to fd 4 in the container):
 *   - the store's ANGLE EGL probe (`native/angle/egl_probe.c`, built with zig for glibc 2.28)
 *     headless on SwiftShader under the headless filter, once on the default Vulkan device (the
 *     box's `VK_ICD_FILENAMES`) and once asking ANGLE for SwiftShader;
 *   - a box-check program that reports from inside the box what the box promises: fd 3, the
 *     environment, no network, no X11 socket (path or abstract) although the container serves
 *     both, only the stand-in security-context Wayland socket (never the session's) and, when the
 *     plan asks, the Pulse socket (windowed only), a read-only root and bundle, a writable state
 *     folder, no system programs, devices or sysfs, no nested user namespace, and the seccomp
 *     verdicts (sockets per mode, ptrace, keyctl, io_uring, TIOCSTI, personality, clone3, threads);
 *   - a windowed request without a security-context socket, which must be refused unspawned.
 * It writes `.studio-dev/evidence/linux-game-box/` (`result.json`, `SUMMARY.txt`, the staged bundle
 * under `work/`) and exits non-zero when an expectation fails. The container gets
 * `seccomp=unconfined`, `systempaths=unconfined` and `apparmor=unconfined`: Docker's default
 * seccomp profile refuses `unshare(CLONE_NEWUSER)` and its masked `/proc` paths refuse a fresh
 * procfs in a user namespace. Those are container settings, not what Genex's host gets. On Docker
 * Desktop for Apple silicon the amd64 container runs under Rosetta on an arm64 kernel, so the
 * kernel sees AArch64 system calls: the filter's AArch64 half is what runs there.
 *
 * S10 checklist, still open on real hosts (each needs a Linux PC; none is provable in this container):
 *   - Pulse: with `host-pulse`, a boxed client can LOAD_MODULE module-tunnel-sink, module-rtp-send
 *     or module-native-protocol-tcp and reach the network through the host's audio server, and can
 *     record the microphone. Confirm on PulseAudio and pipewire-pulse; the default stays muted.
 *   - Wayland: on sway/Hyprland (wlroots) the session socket offers zwp_virtual_keyboard_v1,
 *     wlr-virtual-pointer, wlr-screencopy and wlr-data-control; confirm a socket made through
 *     wp_security_context_manager_v1 hides them, and which desktops (GNOME, KDE) offer the manager.
 *   - GPU: a render node with only its own sysfs device folder renders through Mesa (Intel, AMD);
 *     on NVIDIA's proprietary driver the GPU is unusable in the box and VK_ADD_DRIVER_FILES must
 *     leave SwiftShader as the device.
 *   - The filter on an x86-64 kernel (this container exercises the AArch64 half), with a windowed
 *     raylib game on Wayland and audio through Pulse.
 *   - Exec: a file the game writes to /state or /tmp can still be executed (Landlock is the fix).
 */
import { type ChildProcess, execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NativeEnv, NativeRunMode } from "../../src/shared/native-contract.ts";
import {
  LinuxBoxAudio,
  type LinuxBoxChild,
  LinuxBoxEnv,
  LinuxBoxRefusal,
  type LinuxBoxRequest,
  type LinuxBoxSpawn,
  type LinuxBoxStats,
  type LinuxBoxSystem,
  launchLinuxGameBox,
  linuxGameBoxArgs,
  planLinuxGameBox,
} from "../../src/substrate/linux-game-box.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const TOOLCHAINS = process.env.GENEX_DEV_TOOLCHAINS ?? path.join(REPO, ".studio-dev/toolchains");
const ZIG = path.join(TOOLCHAINS, "zig-0.16.0/zig");
const ANGLE = path.join(TOOLCHAINS, "angle-linux-x64-vulkan/c5bf49e78850");
const PINS = path.join(TOOLCHAINS, "SHA256SUMS");
const EVIDENCE = path.join(REPO, ".studio-dev/evidence/linux-game-box");
const WORK = path.join(EVIDENCE, "work");
const IMAGE = "ubuntu:24.04";
const PLATFORM = "linux/amd64";
/** glibc 2.28 is the Linux floor; `-z norelro` because Rosetta refuses zig's RELRO padding segment. */
const ZIG_FLAGS = ["-target", "x86_64-linux-gnu.2.28", "-O2", "-Wl,-z,norelro"];
const ANGLE_LIBS = ["libEGL.so", "libGLESv2.so", "libvulkan.so.1", "libvk_swiftshader.so"] as const;
/** The SwiftShader ICD manifest ANGLE generates; its digest is checked against the store's pin. */
const SWIFTSHADER_ICD = "vk_swiftshader_icd.json";
const SWIFTSHADER_ICD_TEXT =
  '{"file_format_version": "1.0.0", "ICD": {"library_path": "./libvk_swiftshader.so", "api_version": "1.0.5"}}';
/** Inside the container: the run, the user that plays, and the session the box reads. */
const RUN = "/srv/genex/run";
const PLAYER = "ubuntu";
const RUNTIME_DIR = "/run/user/1000";
/** The stand-in for a socket made through wp_security_context_manager_v1, in its own private folder. */
const CONTEXT_DIR = `${RUNTIME_DIR}/genex-ctx`;
const CONTEXT_SOCKET = `${CONTEXT_DIR}/wl`;
const BWRAP = "/usr/bin/bwrap";
const NONCE = "spike-nonce-0001";
const SOCKET_WAIT_TRIES = 50;
const SOCKET_WAIT_MS = 200;
const RUN_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_CHARS = 4000;
const MISSING = "ENOENT";
/** What each stand-in server says first, so the box-check can tell which socket it reached. */
const Greeting = {
  ContextWayland: "ctxwl",
  SessionWayland: "rawwl",
  Pulse: "pulse",
  X11: "x11xx",
} as const;

/** A tiny C program: `serve <socket>=<greeting>...` answers on each socket; without it, reports the box. */
const BOX_CHECK_C = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

static int first = 1;
static void out(const char *key, const char *value) { printf("%s\"%s\":\"%s\"", first ? "{" : ",", key, value); first = 0; }
static const char *err(int e) {
  static char buf[32];
  switch (e) {
    case 0: return "ok"; case ENOENT: return "ENOENT"; case EROFS: return "EROFS"; case EACCES: return "EACCES";
    case EPERM: return "EPERM"; case ENOSPC: return "ENOSPC"; case ENETUNREACH: return "ENETUNREACH";
    case ECONNREFUSED: return "ECONNREFUSED"; case EINVAL: return "EINVAL"; case ENOSYS: return "ENOSYS";
    case EAFNOSUPPORT: return "EAFNOSUPPORT"; case ENOTTY: return "ENOTTY";
  }
  snprintf(buf, sizeof buf, "errno-%d", e); return buf;
}
static const char *call(long r) { return err(r < 0 ? errno : 0); }
static socklen_t address(struct sockaddr_un *a, const char *p) {
  memset(a, 0, sizeof *a); a->sun_family = AF_UNIX;
  if (p[0] == '@') { memcpy(a->sun_path + 1, p + 1, strlen(p + 1)); return offsetof(struct sockaddr_un, sun_path) + strlen(p); }
  strncpy(a->sun_path, p, sizeof a->sun_path - 1); return sizeof *a;
}
/* The greeting the server at p sends, or why there is none. */
static const char *talk(const char *p) {
  static char said[8];
  struct sockaddr_un a; socklen_t n = address(&a, p);
  int s = socket(AF_UNIX, SOCK_STREAM, 0); if (s < 0) return err(errno);
  if (connect(s, (struct sockaddr *)&a, n) != 0) { int e = errno; close(s); return err(e); }
  memset(said, 0, sizeof said); ssize_t got = read(s, said, 5); close(s);
  return got == 5 ? said : "short";
}
static int create(const char *p) { int fd = open(p, O_CREAT | O_WRONLY, 0600); if (fd < 0) return errno; close(fd); return 0; }
static int exists(const char *p) { return access(p, F_OK) == 0 ? 0 : errno; }
static int family(int f, int type) { int s = socket(f, type, 0); if (s < 0) return errno; close(s); return 0; }
static void *idle(void *arg) { return arg; }
static int serve(int argc, char **argv) {
  struct pollfd fds[8]; const char *greet[8]; int n = 0;
  for (int i = 2; i < argc && n < 8; i++) {
    char *eq = strrchr(argv[i], '='); if (!eq) return 2; *eq = 0; greet[n] = eq + 1;
    struct sockaddr_un a; socklen_t len = address(&a, argv[i]);
    if (argv[i][0] != '@') unlink(argv[i]);
    int s = socket(AF_UNIX, SOCK_STREAM, 0);
    if (s < 0 || bind(s, (struct sockaddr *)&a, len) != 0 || listen(s, 8) != 0) { perror(argv[i]); return 1; }
    fds[n].fd = s; fds[n].events = POLLIN; n++;
  }
  for (;;) {
    if (poll(fds, n, -1) < 0) return 1;
    for (int i = 0; i < n; i++) if (fds[i].revents & POLLIN) { int c = accept(fds[i].fd, 0, 0); if (c >= 0) { (void)!write(c, greet[i], 5); close(c); } }
  }
}
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "serve") == 0) return serve(argc, argv);
  extern char **environ; char names[2048] = ""; char num[32];
  for (char **e = environ; *e; e++) { strncat(names, *e, strcspn(*e, "=")); strcat(names, " "); }
  out("env", names);
  const char *nonce = getenv("GENEX_STUDIO_NONCE");
  out("fd3", err(dprintf(3, "ready %s\n", nonce ? nonce : "") > 0 ? 0 : errno));
  int s = socket(AF_INET, SOCK_STREAM, 0); struct sockaddr_in in = {0};
  in.sin_family = AF_INET; in.sin_port = htons(80); inet_pton(AF_INET, "1.1.1.1", &in.sin_addr);
  out("net", err(s < 0 ? errno : (connect(s, (struct sockaddr *)&in, sizeof in) == 0 ? 0 : errno)));
  out("netlink", err(family(AF_NETLINK, SOCK_RAW)));
  out("unixSocket", err(family(AF_UNIX, SOCK_STREAM)));
  out("x11Path", talk("/tmp/.X11-unix/X0"));
  out("x11Abstract", talk("@/tmp/.X11-unix/X0"));
  out("hostRuntime", err(exists("/run/user/1000")));
  const char *rt = getenv("XDG_RUNTIME_DIR"), *wl = getenv("WAYLAND_DISPLAY"), *pulse = getenv("PULSE_SERVER");
  char wp[256] = "none"; if (rt && wl) snprintf(wp, sizeof wp, "%s/%s", rt, wl);
  out("wayland", rt && wl ? talk(wp) : "unset");
  out("pulse", pulse && strncmp(pulse, "unix:", 5) == 0 ? talk(pulse + 5) : "unset");
  out("writeApp", err(create("/app/x"))); out("writeRoot", err(create("/x"))); out("writeUsr", err(create("/usr/x")));
  out("writeEtc", err(create("/etc/x"))); out("writeState", err(create("/state/ok")));
  out("binSh", err(exists("/bin/sh"))); out("usrBinSh", err(exists("/usr/bin/sh")));
  out("home", err(exists("/home"))); out("root", err(exists("/root"))); out("dri", err(exists("/dev/dri")));
  out("snd", err(exists("/dev/snd"))); out("sys", err(exists("/sys"))); out("x11Dir", err(exists("/tmp/.X11-unix")));
  char devs[1024] = ""; DIR *d = opendir("/dev"); struct dirent *de;
  while (d && (de = readdir(d))) if (de->d_name[0] != '.') { strcat(devs, de->d_name); strcat(devs, " "); }
  if (d) closedir(d); out("dev", devs);
  snprintf(num, sizeof num, "%d", (int)getpid()); out("pid", num);
  snprintf(num, sizeof num, "%d", (int)getuid()); out("uid", num);
  out("userns", err(unshare(CLONE_NEWUSER) == 0 ? 0 : errno));
  out("ptrace", call(syscall(SYS_ptrace, 0, 0, 0, 0)));
  out("keyctl", call(syscall(SYS_keyctl, 0, -3, 0)));
  char params[120] = {0}; out("ioUring", call(syscall(425, 1, params)));
  char ch = 'x'; out("tiocsti", call(ioctl(0, TIOCSTI, &ch)));
  out("personality", call(syscall(SYS_personality, 0xffffffffUL)));
  out("clone3", call(syscall(435, NULL, 0)));
  pthread_t t; out("thread", err(pthread_create(&t, NULL, idle, NULL) == 0 && pthread_join(t, NULL) == 0 ? 0 : EINVAL));
  char line[256], cap[64] = "?"; FILE *st = fopen("/proc/self/status", "r");
  while (st && fgets(line, sizeof line, st)) if (strncmp(line, "CapEff:", 7) == 0) { sscanf(line + 7, "%63s", cap); }
  if (st) fclose(st); out("capEff", cap);
  printf("}\n"); return 0;
}
`;

type Expectation = readonly string[];

/** What every box-check field must read in both modes. */
const COMMON_EXPECTATIONS: Record<string, Expectation> = {
  fd3: ["ok"],
  net: ["EAFNOSUPPORT"],
  netlink: ["EAFNOSUPPORT"],
  hostRuntime: ["ENOENT"],
  writeApp: ["EROFS"],
  writeRoot: ["EROFS"],
  writeUsr: ["EROFS"],
  writeEtc: ["EROFS"],
  writeState: ["ok"],
  binSh: ["ENOENT"],
  usrBinSh: ["ENOENT"],
  home: ["ENOENT"],
  root: ["ENOENT"],
  dri: ["ENOENT"],
  snd: ["ENOENT"],
  sys: ["ENOENT"],
  x11Dir: ["ENOENT"],
  userns: ["EPERM"],
  ptrace: ["EPERM"],
  keyctl: ["EPERM"],
  ioUring: ["EPERM"],
  tiocsti: ["EPERM"],
  personality: ["EPERM"],
  clone3: ["ENOSYS"],
  thread: ["ok"],
  capEff: ["0000000000000000"],
};

/** Headless: the filter refuses every socket, so nothing is reached. */
const HEADLESS_EXPECTATIONS: Record<string, Expectation> = {
  unixSocket: ["EAFNOSUPPORT"],
  x11Path: ["EAFNOSUPPORT"],
  x11Abstract: ["EAFNOSUPPORT"],
  wayland: ["unset"],
  pulse: ["unset"],
};

/** Windowed: Unix sockets, but only the security-context Wayland socket (and Pulse when asked) is there. */
function windowedExpectations(audio: LinuxBoxAudio): Record<string, Expectation> {
  return {
    unixSocket: ["ok"],
    x11Path: ["ENOENT"],
    x11Abstract: ["ECONNREFUSED"],
    wayland: [Greeting.ContextWayland],
    pulse: [audio === LinuxBoxAudio.HostPulse ? Greeting.Pulse : "unset"],
  };
}

const MESSAGE = {
  optIn:
    "Opt-in Docker proof: set GENEX_SPIKE_DOCKER=1 to run it (needs Docker with linux/amd64, zig and the Linux ANGLE in the dev toolchain folder).",
  icdDigest: (actual: string) =>
    `the reconstructed SwiftShader ICD manifest (${actual}) does not match the store's pin`,
  socketsTimeout: "the stand-in display and audio sockets did not appear in the container",
} as const;

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function docker(args: readonly string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
}

function dockerOk(args: readonly string[]): string {
  const result = docker(args);
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

/** The pinned digest of the ICD manifest in the store's `SHA256SUMS`. */
async function pinnedIcdDigest(): Promise<string | null> {
  const pins = await readFile(PINS, "utf8");
  const line = pins
    .split("\n")
    .find((entry) => entry.includes(`angle-linux-x64-vulkan/c5bf49e78850/${SWIFTSHADER_ICD}`));
  return line?.split(/\s+/)[0] ?? null;
}

/** Builds the probe and box-check with zig and stages the bundle: ANGLE, the ICD, the two programs. */
async function stage(): Promise<Record<string, string>> {
  await rm(WORK, { recursive: true, force: true });
  const bundle = path.join(WORK, "bundle");
  await mkdir(bundle, { recursive: true });
  for (const lib of ANGLE_LIBS) await copyFile(path.join(ANGLE, lib), path.join(bundle, lib));
  const pin = await pinnedIcdDigest();
  const icdDigest = sha256(SWIFTSHADER_ICD_TEXT);
  if (pin !== icdDigest) throw new Error(MESSAGE.icdDigest(icdDigest));
  await writeFile(path.join(bundle, SWIFTSHADER_ICD), SWIFTSHADER_ICD_TEXT);
  const boxCheck = path.join(WORK, "box_check.c");
  await writeFile(boxCheck, BOX_CHECK_C);
  const probe = path.join(REPO, "native/angle/egl_probe.c");
  const include = path.join(ANGLE, "include");
  execFileSync(ZIG, ["cc", ...ZIG_FLAGS, "-I", include, probe, "-o", path.join(bundle, "egl-probe"), "-ldl"]);
  execFileSync(ZIG, ["cc", ...ZIG_FLAGS, boxCheck, "-o", path.join(bundle, "box-check"), "-lpthread"]);
  await chmod(path.join(bundle, "egl-probe"), 0o755);
  await chmod(path.join(bundle, "box-check"), 0o755);
  return { icd: icdDigest, zig: execFileSync(ZIG, ["version"], { encoding: "utf8" }).trim() };
}

/**
 * On an arm64 Docker kernel (Docker Desktop on Apple silicon) the amd64 bubblewrap runs under
 * Rosetta, which refuses `prctl(PR_SET_SECCOMP)` for any filter, so the container gets Ubuntu's
 * arm64 bubblewrap from the ports archive instead: it loads the filter natively, and the amd64
 * game then runs under it through Rosetta (the kernel sees AArch64 calls).
 */
const ARM64_BWRAP = `sed -i "s/^Types: deb$/Types: deb\\nArchitectures: amd64/" /etc/apt/sources.list.d/ubuntu.sources
printf '%s\\n' 'Types: deb' 'URIs: http://ports.ubuntu.com/ubuntu-ports/' 'Suites: noble noble-updates noble-security' 'Components: main' 'Architectures: arm64' 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' > /etc/apt/sources.list.d/ports-arm64.sources
dpkg --add-architecture arm64
`;

function setupScript(arm64Kernel: boolean): string {
  const bwrap = arm64Kernel ? "bubblewrap:arm64" : "bubblewrap";
  return `set -eu
${arm64Kernel ? ARM64_BWRAP : ""}apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${bwrap} libxcb1 >/dev/null 2>&1
mkdir -p ${RUN}/state/home ${RUNTIME_DIR}/pulse ${CONTEXT_DIR} /tmp/.X11-unix
cp -a /stage/bundle ${RUN}/bundle
chown -R ${PLAYER}:${PLAYER} /srv/genex ${RUNTIME_DIR}
chmod 700 ${RUNTIME_DIR} ${RUNTIME_DIR}/pulse ${CONTEXT_DIR} /srv/genex ${RUN} ${RUN}/state
chmod 1777 /tmp/.X11-unix
dpkg-query -W -f='\${Package}:\${Architecture} \${Version}\\n' bubblewrap libxcb1 libc6 libcap2 libselinux1 libpcre2-8-0
`;
}

/** Starts the container, installs bubblewrap, copies the bundle in and serves the stand-in sockets. */
async function startContainer(name: string): Promise<Record<string, string>> {
  const security = ["seccomp=unconfined", "systempaths=unconfined", "apparmor=unconfined"].flatMap((opt) => [
    "--security-opt",
    opt,
  ]);
  dockerOk([
    "run",
    "-d",
    "--name",
    name,
    "--platform",
    PLATFORM,
    ...security,
    "-v",
    `${WORK}:/stage:ro`,
    IMAGE,
    "sleep",
    "infinity",
  ]);
  const arm64Kernel = dockerOk(["info", "--format", "{{.Architecture}}"]) === "aarch64";
  const packages = dockerOk(["exec", name, "sh", "-c", setupScript(arm64Kernel)]);
  const check = `${RUN}/bundle/box-check`;
  const sessionSockets = [
    `${RUNTIME_DIR}/wayland-0=${Greeting.SessionWayland}`,
    `${CONTEXT_SOCKET}=${Greeting.ContextWayland}`,
    `${RUNTIME_DIR}/pulse/native=${Greeting.Pulse}`,
  ];
  dockerOk(["exec", "-d", "-u", PLAYER, name, check, "serve", ...sessionSockets]);
  dockerOk([
    "exec",
    "-d",
    name,
    check,
    "serve",
    `/tmp/.X11-unix/X0=${Greeting.X11}`,
    `@/tmp/.X11-unix/X0=${Greeting.X11}`,
  ]);
  const served = [CONTEXT_SOCKET, `${RUNTIME_DIR}/pulse/native`, "/tmp/.X11-unix/X0"].map(
    (socket) => `test -S ${socket}`,
  );
  for (let attempt = 0; attempt < SOCKET_WAIT_TRIES; attempt += 1) {
    const ready = docker(["exec", name, "sh", "-c", served.join(" && ")]);
    if (ready.status === 0) {
      return {
        packages,
        bwrap: dockerOk(["exec", name, BWRAP, "--version"]),
        kernel: dockerOk(["exec", name, "uname", "-srm"]),
        dockerKernel: dockerOk(["info", "--format", "{{.Architecture}} {{.KernelVersion}}"]),
        image: dockerOk(["image", "inspect", IMAGE, "--format", "{{index .RepoDigests 0}}"]),
      };
    }
    await sleep(SOCKET_WAIT_MS);
  }
  throw new Error(MESSAGE.socketsTimeout);
}

function missing(target: string): Error {
  return Object.assign(new Error(`${MISSING}: ${target}`), { code: MISSING });
}

/** File type bits of `st_mode`. */
const S_IFMT = 0o170000;
const FileType = { Dir: 0o040000, File: 0o100000, Socket: 0o140000, Char: 0o020000, Link: 0o120000 } as const;

function statsFrom(uid: number, mode: number, major: number, minor: number): LinuxBoxStats {
  const type = mode & S_IFMT;
  return {
    uid,
    mode,
    rdev: (minor & 0xff) | ((major & 0xfff) << 8) | ((minor & ~0xff) << 12),
    isDirectory: () => type === FileType.Dir,
    isFile: () => type === FileType.File,
    isSocket: () => type === FileType.Socket,
    isCharacterDevice: () => type === FileType.Char,
    isSymbolicLink: () => type === FileType.Link,
  };
}

/** The container's file system as the player sees it: every call is one `docker exec`. */
function containerSystem(name: string, uid: number): LinuxBoxSystem {
  const run = (command: string[], target: string): string => {
    const result = docker(["exec", "-u", PLAYER, name, ...command, "--", target]);
    if (result.status !== 0) throw missing(target);
    return result.stdout.replace(/\n$/, "");
  };
  return {
    uid,
    lstat: async (target) => {
      const [owner = "", mode = "", major = "0", minor = "0"] = run(["stat", "-c", "%u %f %t %T"], target).split(" ");
      return statsFrom(
        Number(owner),
        Number.parseInt(mode, 16),
        Number.parseInt(major, 16),
        Number.parseInt(minor, 16),
      );
    },
    realpath: async (target) => run(["realpath", "-e"], target),
    readlink: async (target) => run(["readlink"], target),
  };
}

interface BoxRun {
  name: string;
  mode: NativeRunMode;
  exe: string;
  extra: string[];
  audio: LinuxBoxAudio;
  waylandContext: string | null;
  /** A run that must be refused before anything starts. */
  refusal?: LinuxBoxRefusal;
}

const RUN_DEFAULTS = { audio: LinuxBoxAudio.Muted, waylandContext: CONTEXT_SOCKET } as const;

const RUNS: readonly BoxRun[] = [
  {
    ...RUN_DEFAULTS,
    name: "probe-headless-default-device",
    mode: NativeRunMode.Headless,
    exe: "egl-probe",
    extra: ["/app", "--expect", "vulkan"],
  },
  {
    ...RUN_DEFAULTS,
    name: "probe-headless-swiftshader",
    mode: NativeRunMode.Headless,
    exe: "egl-probe",
    extra: ["/app", "--expect", "vulkan", "--swiftshader"],
  },
  { ...RUN_DEFAULTS, name: "box-check-headless", mode: NativeRunMode.Headless, exe: "box-check", extra: [] },
  { ...RUN_DEFAULTS, name: "box-check-windowed-muted", mode: NativeRunMode.Window, exe: "box-check", extra: [] },
  {
    ...RUN_DEFAULTS,
    name: "box-check-windowed-host-pulse",
    mode: NativeRunMode.Window,
    exe: "box-check",
    extra: [],
    audio: LinuxBoxAudio.HostPulse,
  },
  {
    ...RUN_DEFAULTS,
    name: "windowed-without-security-context",
    mode: NativeRunMode.Window,
    exe: "box-check",
    extra: [],
    waylandContext: null,
    refusal: LinuxBoxRefusal.WaylandUnrestricted,
  },
];

function boxRequest(run: BoxRun): LinuxBoxRequest {
  return {
    mode: run.mode,
    bundle: `${RUN}/bundle`,
    exe: `${RUN}/bundle/${run.exe}`,
    state: `${RUN}/state`,
    nonce: NONCE,
    renderNodes: [],
    softwareIcd: `${RUN}/bundle/${SWIFTSHADER_ICD}`,
    waylandContext: run.waylandContext,
    audio: run.audio,
    // A Wayland session that also has X11: the box must take Wayland and never reach X11.
    session: { XDG_RUNTIME_DIR: RUNTIME_DIR, WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
  };
}

interface Finished {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** bubblewrap in the container: fd 4 is the docker stdin the launch writes the filter to. */
interface ContainerChild extends LinuxBoxChild {
  done: Promise<Finished>;
}

function finished(child: ChildProcess): Promise<Finished> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  return new Promise((resolve) => {
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Runs bubblewrap in the container as the player: fd 3 a file the host reads back, fd 4 the filter. */
function containerSpawn(name: string, run: BoxRun, spawned: { count: number }): LinuxBoxSpawn<ContainerChild> {
  const fd3 = `${RUN}/fd3-${run.name}.txt`;
  const shell = 'out="$1"; shift; exec 3>"$out" 4<&0 0</dev/null; exec "$@"';
  return (file, args) => {
    spawned.count += 1;
    const command = ["exec", "-i", "-u", PLAYER, name, "sh", "-c", shell, "sh", fd3, file, ...args, ...run.extra];
    const child = spawn("docker", command, { stdio: ["pipe", "pipe", "pipe"] });
    return {
      stdio: [null, child.stdout, child.stderr, null, child.stdin],
      kill: (signal) => child.kill(signal),
      done: finished(child),
    };
  };
}

/** The program's report: its last output line as JSON, or an empty object when it printed none. */
function lastJsonLine(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The box-check fields only the seccomp filter decides. */
const SECCOMP_KEYS = new Set([
  "net",
  "netlink",
  "unixSocket",
  "userns",
  "ptrace",
  "keyctl",
  "ioUring",
  "tiocsti",
  "personality",
  "clone3",
]);

/**
 * A filtered run's verdict. A refused seccomp field that reads what the unfiltered control read is
 * listed as `unproven`, not passed or failed: the call never reached the kernel (Rosetta answers
 * some itself), so the interpreter rows in `linux-game-seccomp.test.ts` are its only proof.
 */
function boxVerdict(
  stdout: string,
  run: BoxRun,
  control: Record<string, string>,
): { failed: string[]; unproven: string[]; report: Record<string, string> } {
  const report = lastJsonLine(stdout) as Record<string, string>;
  const byMode = run.mode === NativeRunMode.Window ? windowedExpectations(run.audio) : HEADLESS_EXPECTATIONS;
  const expectations = { ...COMMON_EXPECTATIONS, ...byMode };
  const unproven: string[] = [];
  const failed: string[] = [];
  for (const [key, expected] of Object.entries(expectations)) {
    const value = report[key] ?? "";
    const sameAsControl = SECCOMP_KEYS.has(key) && !expected.includes("ok") && value === control[key];
    if (sameAsControl) unproven.push(`${key}:${value}`);
    else if (!expected.includes(value)) failed.push(`${key}:${value}`);
  }
  const allowed = new Set<string>([...Object.values(NativeEnv), ...Object.values(LinuxBoxEnv)]);
  const strayEnv = (report.env ?? "").split(" ").filter((env) => env && !allowed.has(env));
  if (strayEnv.length) failed.push(`env:${strayEnv.join(",")}`);
  return { failed, unproven, report };
}

/** The headless box without `--seccomp`: what each seccomp field reads with no filter at all. */
async function controlRun(name: string, uid: number): Promise<Record<string, string>> {
  const headless = RUNS.find((run) => run.name === "box-check-headless");
  if (!headless) return {};
  const planned = await planLinuxGameBox(boxRequest(headless), containerSystem(name, uid));
  if (!planned.ok) return { refusal: planned.refusal };
  const args = linuxGameBoxArgs(planned.plan);
  args.splice(args.indexOf("--seccomp"), 2);
  const result = docker(["exec", "-u", PLAYER, name, "sh", "-c", 'exec 3>/dev/null; exec "$@"', "sh", BWRAP, ...args]);
  return lastJsonLine(result.stdout) as Record<string, string>;
}

/** One run through `launchLinuxGameBox`, with its verdict. */
async function runOne(
  name: string,
  uid: number,
  run: BoxRun,
  control: Record<string, string>,
): Promise<Record<string, unknown>> {
  const spawned = { count: 0 };
  const launched = await launchLinuxGameBox(BWRAP, boxRequest(run), {
    system: containerSystem(name, uid),
    spawn: containerSpawn(name, run, spawned),
  });
  if (!launched.ok) {
    const expected = run.refusal === launched.refusal && spawned.count === 0;
    return { name: run.name, ok: expected, refusal: launched.refusal, detail: launched.detail, spawned: spawned.count };
  }
  const { status, stdout, stderr } = await launched.child.done;
  const fd3 = docker(["exec", name, "cat", `${RUN}/fd3-${run.name}.txt`]).stdout;
  const base = {
    name: run.name,
    mode: run.mode,
    args: launched.args,
    extra: run.extra,
    status,
    stdout: tail(stdout),
    stderr: tail(stderr),
    fd3,
  };
  if (run.refusal) return { ...base, ok: false, failed: [`expected refusal ${run.refusal}`] };
  if (run.exe === "egl-probe") {
    const probe = lastJsonLine(stdout) as { ok?: boolean };
    return { ...base, ok: status === 0 && probe.ok === true, probe };
  }
  const verdict = boxVerdict(stdout, run, control);
  const failed = [...verdict.failed];
  if (!fd3.includes(`ready ${NONCE}`)) failed.push("fd3-content");
  const ok = status === 0 && failed.length === 0;
  return { ...base, ok, failed, unproven: verdict.unproven, report: verdict.report };
}

/** One line per run, for `SUMMARY.txt`. */
function summaryLine(run: Record<string, unknown>): string {
  const verdict = run.ok === true ? "PASS" : "FAIL";
  if (run.refusal)
    return `  ${verdict} ${String(run.name)} refused=${String(run.refusal)} spawned=${String(run.spawned)}`;
  const probe = run.probe as { renderer?: string } | undefined;
  if (probe) return `  ${verdict} ${String(run.name)} renderer=${probe.renderer ?? "?"}`;
  const report = (run.report ?? {}) as Record<string, string>;
  const keys = [
    "net",
    "unixSocket",
    "x11Path",
    "x11Abstract",
    "wayland",
    "pulse",
    "userns",
    "ptrace",
    "clone3",
    "thread",
  ];
  const failed = (run.failed as string[] | undefined)?.length ? ` failed=${(run.failed as string[]).join(",")}` : "";
  const unproven = (run.unproven as string[] | undefined)?.length
    ? ` unproven-here=${(run.unproven as string[]).join(",")}`
    : "";
  return `  ${verdict} ${String(run.name)} ${keys.map((key) => `${key}=${report[key]}`).join(" ")}${failed}${unproven}`;
}

async function main(): Promise<number> {
  if (process.env.GENEX_SPIKE_DOCKER !== "1") {
    console.error(MESSAGE.optIn);
    return 2;
  }
  await mkdir(EVIDENCE, { recursive: true });
  const built = await stage();
  const name = `genex-linux-game-box-${process.pid}`;
  try {
    const container = await startContainer(name);
    const uid = Number(dockerOk(["exec", "-u", PLAYER, name, "id", "-u"]));
    const control = await controlRun(name, uid);
    const runs = [];
    for (const run of RUNS) runs.push(await runOne(name, uid, run, control));
    const ok = runs.every((run) => run.ok === true);
    const at = new Date().toISOString();
    const result = { ok, at, platform: PLATFORM, built, container, uid, control, runs };
    await writeFile(path.join(EVIDENCE, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const summary = [
      `Linux game box Docker proof (M7 S10 headless + socket plumbing + seccomp), ${at}`,
      `ok=${ok} image=${container.image} platform=${PLATFORM} kernel=${container.kernel} docker-kernel=${container.dockerKernel}`,
      `fetched in the throwaway container (apt, Ubuntu archive): ${container.packages?.replace(/\n/g, "; ")}`,
      `bwrap ${container.bwrap}; zig ${built.zig}; SwiftShader ICD sha256 ${built.icd} = store pin`,
      "runs (all through launchLinuxGameBox, planner reading the container fs as uid 1000):",
      `control (headless box without --seccomp): ${[...SECCOMP_KEYS].map((key) => `${key}=${control[key]}`).join(" ")}`,
      ...runs.map(summaryLine),
    ];
    await writeFile(path.join(EVIDENCE, "SUMMARY.txt"), `${summary.join("\n")}\n`);
    for (const run of runs) console.log(summaryLine(run));
    return ok ? 0 : 1;
  } finally {
    docker(["rm", "-f", name]);
  }
}

process.exitCode = await main();

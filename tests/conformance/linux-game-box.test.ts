/**
 * The bubblewrap box a C++ · raylib game runs in when Genex itself runs on Linux (M7, D19 = C).
 * These tests drive the planner against real folders and Unix sockets in a temporary directory,
 * with the Linux-only facts (render nodes and their sysfs, `/lib` links, `/usr/bin`) injected, and
 * read the argv the builder returns as bubblewrap would: mounts, namespaces, environment and the
 * command. Every hostile row asserts that nothing was spawned.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { GameStack } from "../../src/shared/game-project.ts";
import { DeviceClass } from "../../src/shared/render-quality.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import {
  GameBoxProblem,
  NativeBackend,
  NATIVE_STUDIO_AI_ON,
  NativeEnv,
  NativeGpuTier,
  NativeOp,
  NativeRunMode,
} from "../../src/shared/native-contract.ts";
import {
  LINUX_BOX_APP,
  LINUX_BOX_RUNTIME,
  LINUX_BOX_STATE,
  LINUX_BOX_STDIO,
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
  linuxGameBoxProblem,
  openWaylandContext,
  planLinuxGameBox,
  WAYLAND_CONTEXT_APP_ID,
} from "../../src/substrate/linux-game-box.ts";
import { linuxGameSeccompProgram } from "../../src/substrate/linux-game-seccomp.ts";
import { fnv1a64Hex, NativeGamePort } from "../../src/substrate/native-game-port.ts";
import type { GameChild, GameExit } from "../../src/substrate/spawn.ts";

/** Options that take arguments, and how many: the rest of the argv up to `--` are flags. */
const ARITY: Record<string, number> = {
  "--ro-bind": 2,
  "--ro-bind-try": 2,
  "--bind": 2,
  "--dev-bind": 2,
  "--symlink": 2,
  "--setenv": 2,
  "--tmpfs": 1,
  "--remount-ro": 1,
  "--dir": 1,
  "--perms": 1,
  "--proc": 1,
  "--dev": 1,
  "--chdir": 1,
  "--cap-drop": 1,
  "--seccomp": 1,
};
/** The options that put something in the box's file system. */
const MOUNT_OPS = new Set([
  "--ro-bind",
  "--ro-bind-try",
  "--bind",
  "--dev-bind",
  "--symlink",
  "--tmpfs",
  "--remount-ro",
  "--dir",
  "--proc",
  "--dev",
]);
/** The options that take a host path into the box. */
const BIND_OPS = new Set(["--ro-bind", "--ro-bind-try", "--bind", "--dev-bind"]);

interface ParsedBox {
  flags: string[];
  ops: { op: string; args: string[] }[];
  env: Record<string, string>;
  command: string[];
}

/** Reads a bubblewrap argv the way bubblewrap does. */
function parse(args: readonly string[]): ParsedBox {
  const parsed: ParsedBox = { flags: [], ops: [], env: {}, command: [] };
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      parsed.command = args.slice(index + 1);
      break;
    }
    const arity = ARITY[arg];
    if (arity === undefined) {
      assert.ok(arg.startsWith("--"), `an operand outside an option: ${arg}`);
      parsed.flags.push(arg);
      index += 1;
      continue;
    }
    const operands = args.slice(index + 1, index + 1 + arity);
    if (arg === "--setenv") parsed.env[operands[0] ?? ""] = operands[1] ?? "";
    parsed.ops.push({ op: arg, args: operands });
    index += 1 + arity;
  }
  return parsed;
}

/** Every path a mount op creates or changes inside the box. */
function destinations(parsed: ParsedBox): string[] {
  return parsed.ops.filter((entry) => MOUNT_OPS.has(entry.op)).map((entry) => entry.args.at(-1) ?? "");
}

function sourcesOf(parsed: ParsedBox, op: string): string[] {
  return parsed.ops.filter((entry) => entry.op === op).map((entry) => entry.args[0] ?? "");
}

/** Every host path the box takes in, sorted, duplicates kept. */
function hostSources(parsed: ParsedBox): string[] {
  return parsed.ops
    .filter((entry) => BIND_OPS.has(entry.op))
    .map((entry) => entry.args[0] ?? "")
    .sort();
}

/** glibc's makedev for small numbers. */
function makedev(major: number, minor: number): number {
  return (minor & 0xff) | ((major & 0xfff) << 8) | ((minor & ~0xff) << 12);
}

type FakeKind = "dir" | "file" | "socket" | "char" | "link";

function stats(kind: FakeKind, uid: number, mode = 0o700, rdev = 0): LinuxBoxStats {
  return {
    uid,
    mode,
    rdev,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSocket: () => kind === "socket",
    isCharacterDevice: () => kind === "char",
    isSymbolicLink: () => kind === "link",
  };
}

const UID = process.getuid?.() ?? 1000;
const DRM_MAJOR = 226;
const RENDER_NODE = "/dev/dri/renderD128";
const GPU_DEVICE = "/sys/devices/pci0000:00/0000:00:02.0";
const GPU_SYSFS_ENTRY = "/sys/dev/char/226:128";
const GPU_SYSFS_TARGET = `${GPU_DEVICE}/drm/renderD128`;
const RENDER_NODE_2 = "/dev/dri/renderD129";
const GPU_DEVICE_2 = "/sys/devices/pci0000:00/0000:01:00.0";

interface FakeEntry {
  stats: LinuxBoxStats;
  link?: string;
  real?: string;
}

/** A render node and its sysfs entries, as the kernel lays them out. */
function renderNode(node: string, minor: number, device: string): Record<string, FakeEntry> {
  const entry = `/sys/dev/char/${DRM_MAJOR}:${minor}`;
  return {
    [node]: { stats: stats("char", 0, 0o666, makedev(DRM_MAJOR, minor)) },
    [entry]: { stats: stats("link", 0), real: `${device}/drm/renderD${minor}` },
    [`${entry}/device`]: { stats: stats("link", 0), real: device },
  };
}

/** The system folders the fake owns: anything there it does not list is missing. */
function systemOnly(target: string): boolean {
  const prefixes = ["/usr/", "/lib", "/dev/", "/sys/"];
  return target === "/usr" || prefixes.some((prefix) => target.startsWith(prefix));
}

function fsError(code: string, target: string): Error {
  return Object.assign(new Error(`${code}: ${target}`), { code });
}

/**
 * The real file system, with the Linux system layout injected: a merged-/usr `/lib` and `/lib64`,
 * `/usr/bin` and `/usr/sbin`, and one render node with its sysfs. `overrides` adds or replaces
 * entries; null removes one.
 */
function system(overrides: Record<string, FakeEntry | null> = {}, uid = UID): LinuxBoxSystem {
  const layout: Record<string, FakeEntry | null> = {
    "/usr": { stats: stats("dir", 0, 0o755) },
    "/usr/bin": { stats: stats("dir", 0, 0o755) },
    "/usr/sbin": { stats: stats("dir", 0, 0o755) },
    "/usr/bin/bwrap": { stats: stats("file", 0, 0o755) },
    "/lib": { stats: stats("link", 0), link: "usr/lib", real: "/usr/lib" },
    "/lib64": { stats: stats("link", 0), link: "usr/lib64", real: "/usr/lib64" },
    ...renderNode(RENDER_NODE, 128, GPU_DEVICE),
    ...overrides,
  };
  const known = (target: string) => (Object.hasOwn(layout, target) ? layout[target] : undefined);
  return {
    uid,
    async lstat(target) {
      const entry = known(target);
      if (entry) return entry.stats;
      if (entry === null || systemOnly(target)) throw fsError("ENOENT", target);
      return lstat(target);
    },
    async realpath(target) {
      const entry = known(target);
      if (entry) return entry.real ?? target;
      if (entry === null || systemOnly(target)) throw fsError("ENOENT", target);
      return realpath(target);
    },
    async readlink(target) {
      const entry = known(target);
      if (entry?.link) return entry.link;
      return readlink(target);
    },
  };
}

/** `base` with one call failing with `code` for `target`. */
function failing(base: LinuxBoxSystem, call: "lstat" | "realpath", target: string, code: string): LinuxBoxSystem {
  return {
    ...base,
    [call]: async (candidate: string) => {
      if (candidate === target) throw fsError(code, candidate);
      return base[call](candidate);
    },
  };
}

let root = "";
let runtime = "";
let contextDir = "";
let context = "";
let pulse = "";
let bundle = "";
let state = "";
let exe = "";
let dotExe = "";
let icd = "";
const servers: net.Server[] = [];

async function listen(socketPath: string): Promise<void> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

before(async () => {
  // Short: a Unix socket path has a 104-byte limit on macOS.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "lgb-")));
  runtime = path.join(root, "rt");
  contextDir = path.join(root, "ctx");
  context = path.join(contextDir, "wl");
  pulse = path.join(runtime, "pulse", "native");
  bundle = path.join(root, "run", "bundle");
  state = path.join(root, "run", "state");
  await privateDir(path.join(runtime, "pulse"));
  await chmod(runtime, 0o700);
  await privateDir(contextDir);
  await mkdir(path.join(bundle, "lib"), { recursive: true });
  await mkdir(state, { recursive: true });
  exe = path.join(bundle, "game");
  dotExe = path.join(bundle, "..game");
  icd = path.join(bundle, "lib", "vk_swiftshader_icd.json");
  await writeFile(exe, "#!game\n", { mode: 0o755 });
  await writeFile(dotExe, "#!game\n", { mode: 0o755 });
  await writeFile(icd, "{}\n");
  // The session's own compositor socket: the box must never take it.
  await listen(path.join(runtime, "wayland-0"));
  await listen(context);
  await listen(pulse);
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(root, { recursive: true, force: true });
});

function request(overrides: Partial<LinuxBoxRequest> = {}): LinuxBoxRequest {
  return {
    mode: NativeRunMode.Window,
    bundle,
    exe,
    state,
    nonce: "n0nce-abcdef12",
    renderNodes: [RENDER_NODE],
    softwareIcd: icd,
    waylandContext: context,
    audio: LinuxBoxAudio.Muted,
    session: {
      XDG_RUNTIME_DIR: runtime,
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":0",
      XAUTHORITY: "/home/p/.Xauthority",
    },
    ...overrides,
  };
}

async function boxArgs(overrides: Partial<LinuxBoxRequest> = {}, sys = system()): Promise<ParsedBox> {
  const planned = await planLinuxGameBox(request(overrides), sys);
  assert.ok(planned.ok, planned.ok ? "" : `${planned.refusal}: ${planned.detail}`);
  return parse(linuxGameBoxArgs(planned.plan));
}

interface FakeChild extends LinuxBoxChild {
  stdio: unknown[];
  sent: Uint8Array[];
  killed: string[];
}

function fakeChild(withSink = true): FakeChild {
  const child: FakeChild = {
    sent: [],
    killed: [],
    stdio: [],
    kill(signal) {
      child.killed.push(signal ?? "");
      return true;
    },
  };
  const sink = {
    end: (chunk: Uint8Array) => child.sent.push(chunk),
    on: () => sink,
  };
  child.stdio = withSink ? [null, null, null, null, sink] : [null, null, null, null];
  return child;
}

function recordingSpawn(withSink = true): {
  calls: Parameters<LinuxBoxSpawn<FakeChild>>[];
  spawn: LinuxBoxSpawn<FakeChild>;
} {
  const calls: Parameters<LinuxBoxSpawn<FakeChild>>[] = [];
  return {
    calls,
    spawn: (...args) => {
      calls.push(args);
      return fakeChild(withSink);
    },
  };
}

describe("the Linux game box: namespaces and process", () => {
  it("cuts the network and gives the game its own user, pid, ipc and uts namespaces", async () => {
    for (const mode of [NativeRunMode.Window, NativeRunMode.Headless]) {
      const box = await boxArgs({ mode });
      for (const flag of ["--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-user"]) {
        assert.ok(box.flags.includes(flag), `${mode}: ${flag}`);
      }
      assert.ok(!box.flags.includes("--share-net"), mode);
    }
  });

  it("dies with Genex, starts a new session, drops capabilities and cannot nest user namespaces", async () => {
    const box = await boxArgs();
    for (const flag of ["--die-with-parent", "--new-session", "--disable-userns", "--clearenv"]) {
      assert.ok(box.flags.includes(flag), flag);
    }
    assert.deepEqual(sourcesOf(box, "--cap-drop"), ["ALL"]);
  });

  it("starts the bundle's executable from the read-only bundle, in its folder", async () => {
    const box = await boxArgs();
    assert.deepEqual(box.command, [`${LINUX_BOX_APP}/game`]);
    assert.deepEqual(
      box.ops
        .filter((entry) => entry.op === "--ro-bind" && entry.args[1] === LINUX_BOX_APP)
        .map((entry) => entry.args[0]),
      [bundle],
    );
    assert.deepEqual(sourcesOf(box, "--chdir"), [LINUX_BOX_APP]);
    assert.equal(box.env[LinuxBoxEnv.WorkingDir], LINUX_BOX_APP, "bubblewrap sets PWD to the --chdir folder");
  });

  it("starts an executable whose name begins with two dots: it is inside the bundle", async () => {
    const box = await boxArgs({ exe: dotExe });
    assert.deepEqual(box.command, [`${LINUX_BOX_APP}/..game`]);
  });

  it("passes fd 3 for the protocol and fd 4 for the seccomp program, and ignores stdin", () => {
    assert.deepEqual([...LINUX_BOX_STDIO], ["ignore", "pipe", "pipe", "pipe", "pipe"]);
  });

  it("loads the seccomp filter in both variants: --seccomp 4, and the variant's program written to fd 4", async () => {
    const sent = [];
    for (const mode of [NativeRunMode.Window, NativeRunMode.Headless]) {
      const { calls, spawn: record } = recordingSpawn();
      const children: FakeChild[] = [];
      const result = await launchLinuxGameBox(exe, request({ mode }), {
        system: system(),
        spawn: (...args) => {
          const child = record(...args);
          children.push(child);
          return child;
        },
      });
      assert.ok(result.ok, mode);
      assert.equal(calls.length, 1, mode);
      assert.deepEqual(sourcesOf(parse(result.args), "--seccomp"), ["4"], mode);
      const expected = linuxGameSeccompProgram({ unixSockets: mode === NativeRunMode.Window });
      assert.deepEqual(children[0]?.sent, [expected], mode);
      sent.push(expected);
    }
    assert.notDeepEqual(sent[0], sent[1], "windowed and headless load different filters");
  });

  it("kills bubblewrap and refuses, typed, when fd 4 cannot take the filter", async () => {
    const children: FakeChild[] = [];
    const result = await launchLinuxGameBox(exe, request(), {
      system: system(),
      spawn: () => {
        const child = fakeChild(false);
        children.push(child);
        return child;
      },
    });
    assert.equal(result.ok ? "spawned" : result.refusal, LinuxBoxRefusal.SeccompNotSent);
    assert.deepEqual(children[0]?.killed, ["SIGKILL"]);
  });

  it("takes Node's own spawn as its spawn seam", () => {
    const nodeSpawn: LinuxBoxSpawn<ChildProcess> = spawn;
    assert.equal(nodeSpawn, spawn);
  });
});

describe("the Linux game box: file system", () => {
  it("takes exactly the expected host paths into the box, and nothing else", async () => {
    const windowed = await boxArgs({ audio: LinuxBoxAudio.HostPulse });
    assert.deepEqual(
      hostSources(windowed),
      ["/etc/ld.so.cache", "/usr", GPU_DEVICE, RENDER_NODE, bundle, context, pulse, state].sort(),
    );
    const muted = await boxArgs({ renderNodes: [] });
    assert.deepEqual(hostSources(muted), ["/etc/ld.so.cache", "/usr", bundle, context, state].sort());
    const headless = await boxArgs({ mode: NativeRunMode.Headless, renderNodes: [] });
    assert.deepEqual(hostSources(headless), ["/etc/ld.so.cache", "/usr", bundle, state].sort());
  });

  it("gives the game a fresh /tmp, never the host's", async () => {
    for (const mode of [NativeRunMode.Window, NativeRunMode.Headless]) {
      const box = await boxArgs({ mode });
      const tmp = box.ops.filter((entry) => entry.args.at(-1) === "/tmp" || entry.args.at(-1)?.startsWith("/tmp/"));
      assert.deepEqual(tmp, [{ op: "--tmpfs", args: ["/tmp"] }], mode);
    }
  });

  it("makes the run's state folder the only writable bind, and the root read-only", async () => {
    for (const mode of [NativeRunMode.Window, NativeRunMode.Headless]) {
      const box = await boxArgs({ mode });
      assert.deepEqual(
        box.ops.filter((entry) => entry.op === "--bind").map((entry) => entry.args),
        [[state, LINUX_BOX_STATE]],
        mode,
      );
      assert.ok(!box.ops.some((entry) => entry.op === "--dev-bind" && !entry.args[0]?.startsWith("/dev/dri/")), mode);
      assert.ok(sourcesOf(box, "--remount-ro").includes("/"), mode);
    }
  });

  it("binds the system read-only, follows merged-/usr links, and hides the system's programs", async () => {
    const box = await boxArgs();
    assert.ok(
      box.ops.some((entry) => entry.op === "--ro-bind" && entry.args[0] === "/usr" && entry.args[1] === "/usr"),
    );
    assert.deepEqual(
      box.ops.filter((entry) => entry.op === "--symlink" && !entry.args[1]?.startsWith("/sys/")).map((e) => e.args),
      [
        ["usr/lib", "/lib"],
        ["usr/lib64", "/lib64"],
      ],
    );
    for (const dir of ["/usr/bin", "/usr/sbin"]) {
      const tmpfs = box.ops.findIndex((entry) => entry.op === "--tmpfs" && entry.args[0] === dir);
      const readOnly = box.ops.findIndex((entry) => entry.op === "--remount-ro" && entry.args[0] === dir);
      assert.ok(tmpfs >= 0 && readOnly > tmpfs, `${dir} is an empty read-only folder`);
    }
    for (const absent of ["/bin", "/sbin", "/home", "/root", "/etc", "/run/user"]) {
      assert.ok(!destinations(box).includes(absent), absent);
    }
  });

  it("binds a real (non-merged) /lib read-only instead of linking it", async () => {
    const box = await boxArgs({}, system({ "/lib": { stats: stats("dir", 0, 0o755) } }));
    assert.ok(
      box.ops.some((entry) => entry.op === "--ro-bind" && entry.args[0] === "/lib" && entry.args[1] === "/lib"),
    );
  });

  it("does not follow a /lib link that leaves /usr", async () => {
    const box = await boxArgs(
      {},
      system({ "/lib": { stats: stats("link", 0), link: "/home/p/lib", real: "/home/p/lib" } }),
    );
    assert.ok(!destinations(box).includes("/lib"));
  });

  it("limits /dev to bubblewrap's minimal /dev plus the granted render nodes", async () => {
    const box = await boxArgs();
    assert.deepEqual(sourcesOf(box, "--dev"), ["/dev"]);
    assert.deepEqual(
      box.ops.filter((entry) => entry.op === "--dev-bind").map((entry) => entry.args),
      [[RENDER_NODE, RENDER_NODE]],
    );
    assert.deepEqual(
      destinations(box).filter((dest) => dest.startsWith("/dev/")),
      [RENDER_NODE],
    );
  });

  it("shows the driver only the render node's own device in sysfs, never all of /sys", async () => {
    const box = await boxArgs();
    const sysfs = box.ops.filter((entry) => entry.args.at(-1)?.startsWith("/sys"));
    assert.deepEqual(sysfs, [
      { op: "--ro-bind", args: [GPU_DEVICE, GPU_DEVICE] },
      { op: "--symlink", args: [GPU_SYSFS_TARGET, GPU_SYSFS_ENTRY] },
    ]);
  });

  it("never binds an X11 socket, and no DISPLAY or XAUTHORITY reaches the game", async () => {
    for (const mode of [NativeRunMode.Window, NativeRunMode.Headless]) {
      const box = await boxArgs({ mode, audio: LinuxBoxAudio.HostPulse });
      const all = box.ops.flatMap((entry) => entry.args);
      assert.ok(!all.some((arg) => arg.includes(".X11-unix")), mode);
      assert.ok(!("DISPLAY" in box.env) && !("XAUTHORITY" in box.env), mode);
      // The X11 abstract socket lives in the network namespace, which the box never shares.
      assert.ok(box.flags.includes("--unshare-net"), mode);
    }
  });
});

describe("the Linux game box: display, audio and environment", () => {
  it("windowed: the run's restricted Wayland socket, never the session's, in a private runtime folder", async () => {
    const box = await boxArgs();
    const binds = box.ops.filter((entry) => entry.op === "--ro-bind").map((entry) => entry.args);
    assert.ok(binds.some(([from, to]) => from === context && to === `${LINUX_BOX_RUNTIME}/wayland-0`));
    assert.ok(!hostSources(box).some((source) => source.startsWith(runtime)), "nothing of the session's folder");
    const dir = box.ops.findIndex((entry) => entry.op === "--dir" && entry.args[0] === LINUX_BOX_RUNTIME);
    assert.deepEqual(box.ops[dir - 1], { op: "--perms", args: ["0700"] }, "the runtime folder is created 0700");
    assert.equal(box.env[LinuxBoxEnv.RuntimeDir], LINUX_BOX_RUNTIME);
    assert.equal(box.env[LinuxBoxEnv.WaylandDisplay], "wayland-0");
    assert.equal(box.env[LinuxBoxEnv.SessionType], "wayland");
  });

  it("windowed play is muted unless the plan asks for the host's Pulse socket", async () => {
    const muted = await boxArgs({ session: { WAYLAND_DISPLAY: "wayland-0" } });
    assert.ok(!(LinuxBoxEnv.PulseServer in muted.env));
    assert.ok(!destinations(muted).some((dest) => dest.includes("pulse")));
    const loud = await boxArgs({ audio: LinuxBoxAudio.HostPulse });
    assert.ok(loud.ops.some((entry) => entry.op === "--ro-bind" && entry.args[0] === pulse));
    assert.equal(loud.env[LinuxBoxEnv.PulseServer], `unix:${LINUX_BOX_RUNTIME}/pulse/native`);
  });

  it("asked for the host's Pulse socket, a session without one plays muted rather than refusing", async () => {
    const quiet = path.join(root, "rt-quiet");
    await privateDir(quiet);
    const box = await boxArgs({
      audio: LinuxBoxAudio.HostPulse,
      session: { XDG_RUNTIME_DIR: quiet, WAYLAND_DISPLAY: "wayland-1" },
    });
    assert.ok(!(LinuxBoxEnv.PulseServer in box.env));
    assert.ok(!destinations(box).some((dest) => dest.includes("pulse")));
  });

  it("headless: no display or audio socket at all, even asked for audio, and surfaceless EGL", async () => {
    const box = await boxArgs({ mode: NativeRunMode.Headless, audio: LinuxBoxAudio.HostPulse });
    assert.ok(!destinations(box).some((dest) => dest.startsWith(LINUX_BOX_RUNTIME)));
    assert.ok(!hostSources(box).some((source) => source === context || source.startsWith(runtime)));
    assert.equal(box.env[LinuxBoxEnv.EglPlatform], "surfaceless");
    for (const name of [LinuxBoxEnv.RuntimeDir, LinuxBoxEnv.WaylandDisplay, LinuxBoxEnv.PulseServer]) {
      assert.ok(!(name in box.env), name);
    }
  });

  it("headless needs no Wayland session", async () => {
    const box = await boxArgs({ mode: NativeRunMode.Headless, session: {}, waylandContext: null });
    assert.ok(box.flags.includes("--unshare-net"));
  });

  it("clears the environment and sets only the fixed allow-list", async () => {
    const allowed = new Set<string>([...Object.values(NativeEnv), ...Object.values(LinuxBoxEnv)]);
    for (const mode of [NativeRunMode.Window, NativeRunMode.Headless]) {
      const box = await boxArgs({ mode, renderNodes: [] });
      assert.ok(box.flags.includes("--clearenv"), mode);
      for (const name of Object.keys(box.env)) assert.ok(allowed.has(name), `${mode}: ${name}`);
      assert.equal(box.env[NativeEnv.StudioFd], "3");
      assert.equal(box.env[NativeEnv.Nonce], "n0nce-abcdef12");
      assert.equal(box.env[NativeEnv.StateDir], LINUX_BOX_STATE);
      assert.equal(box.env[NativeEnv.Home], `${LINUX_BOX_STATE}/home`);
      assert.equal(box.env[NativeEnv.AnglePlatform], "vulkan");
      assert.ok(!Object.keys(box.env).some((name) => name.startsWith("LD_")), mode);
    }
  });

  it("sets GENEX_STUDIO_AI=1 only when the studio answers the game's play-time AI", async () => {
    const answered = await boxArgs({ ai: true });
    assert.equal(answered.env[NativeEnv.StudioAi], NATIVE_STUDIO_AI_ON);
    for (const ai of [false, undefined]) {
      const plain = await boxArgs(ai === undefined ? {} : { ai });
      assert.ok(!(NativeEnv.StudioAi in plain.env), String(ai));
    }
  });

  it("uses only the bundled SwiftShader without a render node, and adds it beside the GPU's driver with one", async () => {
    const bundled = `${LINUX_BOX_APP}/lib/vk_swiftshader_icd.json`;
    const software = await boxArgs({ renderNodes: [] });
    assert.equal(software.env[LinuxBoxEnv.VulkanIcd], bundled);
    assert.ok(!(LinuxBoxEnv.VulkanAddIcd in software.env));
    assert.ok(!destinations(software).some((dest) => dest.startsWith("/dev/") || dest.startsWith("/sys")));
    const gpu = await boxArgs();
    assert.ok(!(LinuxBoxEnv.VulkanIcd in gpu.env), "the system's drivers stay visible");
    assert.equal(gpu.env[LinuxBoxEnv.VulkanAddIcd], bundled, "a GPU the box cannot open falls back to software");
  });

  it("deduplicates and sorts render nodes", async () => {
    const sys = system(renderNode(RENDER_NODE_2, 129, GPU_DEVICE_2));
    const box = await boxArgs({ renderNodes: [RENDER_NODE_2, RENDER_NODE, RENDER_NODE_2] }, sys);
    assert.deepEqual(sourcesOf(box, "--dev-bind"), [RENDER_NODE, RENDER_NODE_2]);
    assert.deepEqual(
      sourcesOf(box, "--ro-bind").filter((source) => source.startsWith("/sys")),
      [GPU_DEVICE, GPU_DEVICE_2],
    );
  });
});

describe("the Linux game box: refusals", () => {
  it("refuses an X11-only session for windowed play, typed", async () => {
    const planned = await planLinuxGameBox(request({ session: { DISPLAY: ":0", XDG_RUNTIME_DIR: runtime } }), system());
    assert.equal(planned.ok ? null : planned.refusal, LinuxBoxRefusal.X11Only);
  });

  it("refuses windowed play with no display session at all, typed", async () => {
    const planned = await planLinuxGameBox(request({ session: {} }), system());
    assert.equal(planned.ok ? null : planned.refusal, LinuxBoxRefusal.NoWayland);
  });

  it("refuses windowed play on the session's unrestricted Wayland socket, typed", async () => {
    const planned = await planLinuxGameBox(request({ waylandContext: null }), system());
    assert.equal(planned.ok ? null : planned.refusal, LinuxBoxRefusal.WaylandUnrestricted);
  });

  it("refuses an embedded run: the box has no frames channel", async () => {
    const planned = await planLinuxGameBox(request({ mode: NativeRunMode.Embedded }), system());
    assert.equal(planned.ok ? null : planned.refusal, LinuxBoxRefusal.ModeUnsupported);
  });
});

interface HostileRow {
  name: string;
  request: LinuxBoxRequest;
  sys?: LinuxBoxSystem;
  refusal: LinuxBoxRefusal;
}

/** Hostile socket folders and sockets, made for real under `root`. */
async function hostileFolders(): Promise<Record<string, string>> {
  const made: Record<string, string> = {};
  const folder = async (name: string, mode = 0o700) => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await chmod(dir, mode);
    made[name] = dir;
    return dir;
  };
  await symlink(context, path.join(await folder("ctx-link"), "wl"));
  await symlink(contextDir, path.join(root, "ctx-dirlink"));
  await listen(path.join(await folder("ctx-open", 0o777), "wl"));
  await writeFile(path.join(await folder("ctx-file"), "wl"), "");
  const loop = await folder("ctx-loop");
  await symlink(path.join(loop, "b"), path.join(loop, "a"));
  await symlink(path.join(loop, "a"), path.join(loop, "b"));
  const linkedPulse = await folder("rt-lpulse");
  await privateDir(path.join(linkedPulse, "pulse"));
  await symlink(pulse, path.join(linkedPulse, "pulse", "native"));
  await symlink(runtime, path.join(root, "rt-dirlink"));
  await folder("rt-open", 0o777);
  const pulseFile = await folder("rt-pfile");
  await privateDir(path.join(pulseFile, "pulse"));
  await writeFile(path.join(pulseFile, "pulse", "native"), "");
  return made;
}

/** Hostile Wayland sockets: links, loops, foreign or open folders, files, odd paths. */
async function waylandRows(): Promise<HostileRow[]> {
  const dirs = await hostileFolders();
  const at = (folder: string) => request({ waylandContext: path.join(folder, "wl") });
  const foreignSocket = system({ [context]: { stats: stats("socket", UID + 1) } });
  return [
    {
      name: "unrestricted Wayland socket",
      request: request({ waylandContext: null }),
      refusal: LinuxBoxRefusal.WaylandUnrestricted,
    },
    { name: "symlinked Wayland socket", request: at(dirs["ctx-link"] ?? ""), refusal: LinuxBoxRefusal.PathLinked },
    {
      name: "Wayland socket in a symlinked folder",
      request: at(path.join(root, "ctx-dirlink")),
      refusal: LinuxBoxRefusal.PathLinked,
    },
    {
      name: "Wayland socket through a symlink loop",
      request: request({ waylandContext: path.join(dirs["ctx-loop"] ?? "", "a") }),
      refusal: LinuxBoxRefusal.PathLinked,
    },
    {
      name: "Wayland socket in a folder others can enter",
      request: at(dirs["ctx-open"] ?? ""),
      refusal: LinuxBoxRefusal.SocketFolderNotPrivate,
    },
    {
      name: "Wayland socket folder owned by someone else",
      request: request(),
      sys: system({}, UID + 1),
      refusal: LinuxBoxRefusal.SocketFolderNotPrivate,
    },
    {
      name: "Wayland socket owned by someone else",
      request: request(),
      sys: foreignSocket,
      refusal: LinuxBoxRefusal.SocketNotOwned,
    },
    { name: "Wayland socket that is a file", request: at(dirs["ctx-file"] ?? ""), refusal: LinuxBoxRefusal.NotASocket },
    {
      name: "missing Wayland socket",
      request: request({ waylandContext: path.join(contextDir, "gone") }),
      refusal: LinuxBoxRefusal.Missing,
    },
    {
      name: "relative Wayland socket",
      request: request({ waylandContext: "ctx/wl" }),
      refusal: LinuxBoxRefusal.UnsafePath,
    },
    {
      name: "Wayland socket with a newline",
      request: request({ waylandContext: `${context}\n--bind` }),
      refusal: LinuxBoxRefusal.UnsafePath,
    },
  ];
}

/** Hostile runtime folders and Pulse sockets, when the plan asks for the host's Pulse socket. */
async function pulseRows(): Promise<HostileRow[]> {
  const loud = (session: LinuxBoxRequest["session"]) =>
    request({ audio: LinuxBoxAudio.HostPulse, session: { WAYLAND_DISPLAY: "wayland-0", ...session } });
  const runtimeAt = (name: string) => loud({ XDG_RUNTIME_DIR: path.join(root, name) });
  return [
    { name: "symlinked Pulse socket", request: runtimeAt("rt-lpulse"), refusal: LinuxBoxRefusal.PathLinked },
    { name: "symlinked runtime folder", request: runtimeAt("rt-dirlink"), refusal: LinuxBoxRefusal.PathLinked },
    {
      name: "runtime folder others can enter",
      request: runtimeAt("rt-open"),
      refusal: LinuxBoxRefusal.SocketFolderNotPrivate,
    },
    { name: "Pulse socket that is a file", request: runtimeAt("rt-pfile"), refusal: LinuxBoxRefusal.NotASocket },
    {
      name: "Pulse socket owned by someone else",
      request: loud({ XDG_RUNTIME_DIR: runtime }),
      sys: system({ [pulse]: { stats: stats("socket", UID + 1) } }),
      refusal: LinuxBoxRefusal.SocketNotOwned,
    },
    {
      name: "relative runtime folder",
      request: loud({ XDG_RUNTIME_DIR: "run/user/1000" }),
      refusal: LinuxBoxRefusal.UnsafePath,
    },
    {
      name: "runtime folder with a newline",
      request: loud({ XDG_RUNTIME_DIR: `${runtime}\n/x` }),
      refusal: LinuxBoxRefusal.UnsafePath,
    },
    { name: "missing runtime folder", request: loud({}), refusal: LinuxBoxRefusal.RuntimeDirMissing },
  ];
}

/** Hostile run paths and values. */
async function runRows(): Promise<HostileRow[]> {
  const bundleLink = path.join(root, "bundle-link");
  await symlink(bundle, bundleLink);
  const exeLink = path.join(bundle, "game-link");
  await symlink("/usr/bin/true", exeLink);
  const outside = path.join(root, "outside-game");
  await writeFile(outside, "#!x\n", { mode: 0o755 });
  const newline = path.join(root, "state\nx");
  await mkdir(newline, { recursive: true });
  return [
    { name: "state path with a newline", request: request({ state: newline }), refusal: LinuxBoxRefusal.UnsafePath },
    {
      name: "state path not normalized",
      request: request({ state: `${state}/../state` }),
      refusal: LinuxBoxRefusal.UnsafePath,
    },
    { name: "relative executable", request: request({ exe: "game" }), refusal: LinuxBoxRefusal.UnsafePath },
    {
      name: "symlinked bundle",
      request: request({
        bundle: bundleLink,
        exe: path.join(bundleLink, "game"),
        softwareIcd: path.join(bundleLink, "lib", "vk_swiftshader_icd.json"),
      }),
      refusal: LinuxBoxRefusal.PathLinked,
    },
    { name: "executable that is a link", request: request({ exe: exeLink }), refusal: LinuxBoxRefusal.PathLinked },
    {
      name: "executable below a file",
      request: request({ exe: path.join(exe, "inner") }),
      refusal: LinuxBoxRefusal.Missing,
    },
    {
      name: "executable outside the bundle",
      request: request({ exe: outside }),
      refusal: LinuxBoxRefusal.OutsideBundle,
    },
    {
      name: "executable is the bundle itself",
      request: request({ exe: bundle }),
      refusal: LinuxBoxRefusal.OutsideBundle,
    },
    {
      name: "software ICD outside the bundle",
      request: request({ softwareIcd: outside, renderNodes: [] }),
      refusal: LinuxBoxRefusal.OutsideBundle,
    },
    {
      name: "state inside the bundle",
      request: request({ state: path.join(bundle, "lib") }),
      refusal: LinuxBoxRefusal.PathsOverlap,
    },
    {
      name: "state inside the bundle, named with two dots",
      request: request({ state: path.join(bundle, "..state") }),
      refusal: LinuxBoxRefusal.PathsOverlap,
    },
    {
      name: "bundle inside the state",
      request: request({ state: path.join(root, "run") }),
      refusal: LinuxBoxRefusal.PathsOverlap,
    },
    {
      name: "state inside the Wayland socket's folder, named with two dots",
      request: request({ state: path.join(contextDir, "..s") }),
      refusal: LinuxBoxRefusal.PathsOverlap,
    },
    {
      name: "state inside the runtime folder, named with two dots",
      request: request({ audio: LinuxBoxAudio.HostPulse, state: path.join(runtime, "..s") }),
      refusal: LinuxBoxRefusal.PathsOverlap,
    },
    {
      name: "state that holds the Wayland socket",
      request: request({
        state: root,
        bundle: path.join(os.tmpdir(), "elsewhere"),
        exe: path.join(os.tmpdir(), "elsewhere", "game"),
        softwareIcd: path.join(os.tmpdir(), "elsewhere", "icd.json"),
      }),
      refusal: LinuxBoxRefusal.PathsOverlap,
    },
    { name: "bundle at the root", request: request({ bundle: "/" }), refusal: LinuxBoxRefusal.PathsOverlap },
    {
      name: "bundle owned by someone else",
      request: request({ mode: NativeRunMode.Headless }),
      sys: system({}, UID + 1),
      refusal: LinuxBoxRefusal.NotOwned,
    },
    {
      name: "state the planner may not read",
      request: request(),
      sys: failing(system(), "realpath", state, "EACCES"),
      refusal: LinuxBoxRefusal.Unreadable,
    },
    {
      name: "system library folder the planner may not read",
      request: request(),
      sys: failing(system(), "lstat", "/lib", "EACCES"),
      refusal: LinuxBoxRefusal.Unreadable,
    },
    {
      name: "nonce with a newline",
      request: request({ nonce: "abc\n--bind / /" }),
      refusal: LinuxBoxRefusal.UnsafeValue,
    },
    { name: "empty nonce", request: request({ nonce: "" }), refusal: LinuxBoxRefusal.UnsafeValue },
  ];
}

/** Hostile render nodes and sysfs layouts. */
function renderNodeRows(): HostileRow[] {
  const node = (entries: Record<string, FakeEntry | null>) => system(entries);
  const char = (rdev: number): FakeEntry => ({ stats: stats("char", 0, 0o666, rdev) });
  const sysfs = (real: string): FakeEntry => ({ stats: stats("link", 0), real });
  return [
    ...["/dev/dri/card0", "/dev/snd/pcmC0D0c", "/dev/dri/../dri/renderD128", "/dev/dri/renderD128\n"].map((bad) => ({
      name: `not a render node path: ${JSON.stringify(bad)}`,
      request: request({ renderNodes: [bad] }),
      refusal: LinuxBoxRefusal.NotARenderNode,
    })),
    ...[
      ["render node that is a link", { [RENDER_NODE]: { ...char(makedev(226, 128)), real: "/dev/dri/card0" } }],
      ["render node that is not a device", { [RENDER_NODE]: { stats: stats("file", UID, 0o644) } }],
      ["render node with another driver's major", { [RENDER_NODE]: char(makedev(29, 128)) }],
      ["render node whose minor is another node's", { [RENDER_NODE]: char(makedev(226, 129)) }],
      ["missing render node", { [RENDER_NODE]: null }],
      ["render node without sysfs", { [GPU_SYSFS_ENTRY]: null }],
      ["sysfs entry outside /sys/devices", { [GPU_SYSFS_ENTRY]: sysfs("/home/p/drm/renderD128") }],
      ["sysfs entry for another node", { [GPU_SYSFS_ENTRY]: sysfs(`${GPU_DEVICE}/drm/renderD129`) }],
      ["sysfs device that is all of /sys/devices", { [`${GPU_SYSFS_ENTRY}/device`]: sysfs("/sys/devices") }],
      [
        "sysfs device that does not hold the node",
        { [`${GPU_SYSFS_ENTRY}/device`]: sysfs("/sys/devices/pci0000:00/0000:00:03.0") },
      ],
      ["sysfs device with a newline", { [`${GPU_SYSFS_ENTRY}/device`]: sysfs("/sys/devices/pci\n0000:00") }],
    ].map(([name, entries]) => ({
      name: String(name),
      request: request(),
      sys: node(entries as Record<string, FakeEntry | null>),
      refusal: LinuxBoxRefusal.NotARenderNode,
    })),
  ];
}

async function hostileRows(): Promise<HostileRow[]> {
  return [...(await waylandRows()), ...(await pulseRows()), ...(await runRows()), ...renderNodeRows()];
}

describe("the Linux game box: hostile inputs spawn nothing", () => {
  const BWRAP = "/usr/bin/bwrap";

  it("refuses every hostile row typed, and never calls spawn", async () => {
    for (const row of await hostileRows()) {
      const { calls, spawn: record } = recordingSpawn();
      const result = await launchLinuxGameBox(BWRAP, row.request, { system: row.sys ?? system(), spawn: record });
      assert.equal(
        result.ok ? "spawned" : result.refusal,
        row.refusal,
        `${row.name}: ${result.ok ? "" : result.detail}`,
      );
      assert.equal(calls.length, 0, `${row.name}: spawned`);
    }
  });

  it("refuses a bubblewrap path that is relative, a link or has a newline, and never calls spawn", async () => {
    const { calls, spawn: record } = recordingSpawn();
    const linkedBwrap = path.join(root, "bwrap-link");
    await symlink(exe, linkedBwrap);
    const refusals = [];
    for (const bwrap of ["bwrap", linkedBwrap, `${exe}\n`]) {
      const result = await launchLinuxGameBox(bwrap, request(), { system: system(), spawn: record });
      refusals.push(result.ok ? "spawned" : result.refusal);
    }
    assert.deepEqual(refusals, [LinuxBoxRefusal.UnsafePath, LinuxBoxRefusal.PathLinked, LinuxBoxRefusal.UnsafePath]);
    assert.equal(calls.length, 0);
  });

  it("a valid request spawns bubblewrap once, detached, with an empty environment, fd 3 and fd 4", async () => {
    const { calls, spawn: record } = recordingSpawn();
    // Any real, unlinked file stands in for bubblewrap: nothing runs it.
    const result = await launchLinuxGameBox(exe, request(), { system: system(), spawn: record });
    assert.ok(result.ok);
    assert.equal(calls.length, 1);
    const [file, args, options] = calls[0] ?? [];
    assert.equal(file, exe);
    assert.deepEqual(args, result.args);
    assert.deepEqual(options, { stdio: [...LINUX_BOX_STDIO], env: {}, detached: true });
  });
});

// ── Rust · wgpu runs (M4.3): the headless box, the Vulkan loader, and the Wayland helper ─────────

/** The facts of a Linux host whose bubblewrap and user namespaces are fine. */
function hostFacts(overrides: Partial<Parameters<typeof linuxGameBoxProblem>[0]> = {}) {
  return {
    mode: NativeRunMode.Headless,
    bwrapVersion: () => "bubblewrap 0.9.0",
    usernsRestricted: () => false,
    session: {},
    securityContext: false,
    ...overrides,
  };
}

/** The system's Vulkan layer manifest folders, present under `/usr`. */
const LAYER_DIRS = [
  "/usr/share/vulkan/implicit_layer.d",
  "/usr/share/vulkan/explicit_layer.d",
  "/usr/local/share/vulkan/implicit_layer.d",
] as const;

function withLayerDirs(): LinuxBoxSystem {
  return system(Object.fromEntries(LAYER_DIRS.map((dir) => [dir, { stats: stats("dir", 0, 0o755) }])));
}

function rustRequest(overrides: Partial<LinuxBoxRequest> = {}): LinuxBoxRequest {
  return request({ stack: GameStack.RustWgpu, mode: NativeRunMode.Headless, renderNodes: [], ...overrides });
}

describe("the Linux game box: which runs a host can box", () => {
  it("characterization: a raylib game (or an unnamed stack) has no headless build on Linux", () => {
    assert.equal(linuxGameBoxProblem(hostFacts()), GameBoxProblem.NoHeadlessBuild);
    assert.equal(linuxGameBoxProblem(hostFacts({ stack: GameStack.RaylibCpp })), GameBoxProblem.NoHeadlessBuild);
    const embedded = hostFacts({ stack: GameStack.RustWgpu, mode: NativeRunMode.Embedded });
    assert.equal(linuxGameBoxProblem(embedded), GameBoxProblem.NoHeadlessBuild, "Live has no frames channel on Linux");
  });

  it("boxes a Rust game's headless run with no display session, after bubblewrap and user namespaces", () => {
    const rust = { stack: GameStack.RustWgpu };
    assert.equal(linuxGameBoxProblem(hostFacts(rust)), null);
    assert.equal(
      linuxGameBoxProblem(hostFacts({ ...rust, session: { DISPLAY: ":0" } })),
      null,
      "an X11 session does not matter",
    );
    assert.equal(
      linuxGameBoxProblem(hostFacts({ ...rust, bwrapVersion: () => null })),
      GameBoxProblem.BubblewrapMissing,
    );
    assert.equal(
      linuxGameBoxProblem(hostFacts({ ...rust, usernsRestricted: () => true })),
      GameBoxProblem.UsernsRestricted,
    );
  });

  it("a Rust game's window needs the Wayland helper like a raylib game's", () => {
    const window = { stack: GameStack.RustWgpu, mode: NativeRunMode.Window, session: { WAYLAND_DISPLAY: "wayland-0" } };
    assert.equal(linuxGameBoxProblem(hostFacts(window)), GameBoxProblem.WaylandHelperMissing);
    assert.equal(linuxGameBoxProblem(hostFacts({ ...window, securityContext: true })), null);
    assert.equal(linuxGameBoxProblem(hostFacts({ ...window, session: { DISPLAY: ":0" } })), GameBoxProblem.X11Only);
  });
});

describe("the Linux game box: a Rust · wgpu run", () => {
  it("headless: GENEX_HEADLESS=1, the bundled SwiftShader alone, no ANGLE or EGL, no display, no socket", async () => {
    const planned = await planLinuxGameBox(rustRequest(), system());
    assert.ok(planned.ok, planned.ok ? "" : planned.refusal);
    const box = parse(linuxGameBoxArgs(planned.plan));
    assert.equal(box.env[LinuxBoxEnv.Headless], "1");
    assert.equal(box.env[LinuxBoxEnv.VulkanIcd], `${LINUX_BOX_APP}/lib/vk_swiftshader_icd.json`);
    for (const name of [NativeEnv.AnglePlatform, LinuxBoxEnv.EglPlatform, LinuxBoxEnv.WaylandDisplay]) {
      assert.ok(!(name in box.env), name);
    }
    assert.ok(!destinations(box).some((dest) => dest.startsWith(LINUX_BOX_RUNTIME) || dest.startsWith("/dev/dri")));
    assert.deepEqual(planned.plan.seccomp, linuxGameSeccompProgram({ unixSockets: false }), "no socket at all");
    assert.ok(box.flags.includes("--unshare-net"));
    assert.deepEqual(box.command, [`${LINUX_BOX_APP}/game`]);
  });

  // Pass-1 gate: with SwiftShader alone a capture was drawn on the desktop-high reference profile
  // (TAA, eight settle re-renders of the high preset on a CPU rasterizer) and missed the capture
  // deadline. The host records the class a software device draws for its captures; a GPU keeps the
  // runtime's reference class.
  it("records desktop-low as the capture reference class with SwiftShader alone, and none with a GPU", async () => {
    const software = await boxArgs(rustRequest());
    assert.equal(software.env[LinuxBoxEnv.RenderReferenceClass], DeviceClass.DesktopLow);
    const gpu = await boxArgs(rustRequest({ renderNodes: [RENDER_NODE] }));
    assert.ok(!(LinuxBoxEnv.RenderReferenceClass in gpu.env), "a GPU's captures keep the runtime's reference class");
    const raylib = await boxArgs({ renderNodes: [] });
    assert.ok(!(LinuxBoxEnv.RenderReferenceClass in raylib.env), "only the Rust renderer reads it");
  });

  it("headless with a GPU: the render node and SwiftShader beside its driver", async () => {
    const box = await boxArgs(rustRequest({ renderNodes: [RENDER_NODE] }));
    assert.deepEqual(sourcesOf(box, "--dev-bind"), [RENDER_NODE]);
    assert.equal(box.env[LinuxBoxEnv.VulkanAddIcd], `${LINUX_BOX_APP}/lib/vk_swiftshader_icd.json`);
    assert.ok(!(LinuxBoxEnv.VulkanIcd in box.env));
  });

  it("windowed: the restricted Wayland socket, no GENEX_HEADLESS, and muted even when audio is asked for (Q8)", async () => {
    const box = await boxArgs(rustRequest({ mode: NativeRunMode.Window, audio: LinuxBoxAudio.HostPulse }));
    assert.ok(box.ops.some((entry) => entry.op === "--ro-bind" && entry.args[0] === context));
    assert.ok(!(LinuxBoxEnv.Headless in box.env));
    assert.ok(!(LinuxBoxEnv.PulseServer in box.env), "a Rust game plays through its device-less mixer");
    assert.ok(!hostSources(box).includes(pulse));
  });

  it("isolates the Vulkan loader from the system's layers, for every stack", async () => {
    for (const stack of [GameStack.RustWgpu, GameStack.RaylibCpp]) {
      const box = await boxArgs({ stack, mode: NativeRunMode.Headless }, withLayerDirs());
      for (const dir of LAYER_DIRS) {
        const tmpfs = box.ops.findIndex((entry) => entry.op === "--tmpfs" && entry.args[0] === dir);
        const readOnly = box.ops.findIndex((entry) => entry.op === "--remount-ro" && entry.args[0] === dir);
        assert.ok(tmpfs >= 0 && readOnly > tmpfs, `${stack}: ${dir} is an empty read-only folder`);
      }
      assert.equal(box.env[LinuxBoxEnv.VulkanLayersDisable], "~implicit~", stack);
    }
    const plain = await boxArgs(rustRequest());
    assert.ok(!plain.ops.some((entry) => entry.args[0]?.includes("layer.d")), "absent folders are not invented");
  });

  it("clears the environment and sets only the fixed allow-list", async () => {
    const allowed = new Set<string>([...Object.values(NativeEnv), ...Object.values(LinuxBoxEnv)]);
    for (const mode of [NativeRunMode.Window, NativeRunMode.Headless]) {
      const box = await boxArgs(rustRequest({ mode }));
      assert.ok(box.flags.includes("--clearenv"), mode);
      for (const name of Object.keys(box.env)) assert.ok(allowed.has(name), `${mode}: ${name}`);
    }
  });
});

describe("the Linux game box: hostile Rust headless rows spawn nothing", () => {
  const BWRAP = "/usr/bin/bwrap";

  it("never passes the session's Vulkan layer or loader variables, nor binds their paths", async () => {
    const evil = path.join(root, "evil-layers");
    await mkdir(evil, { recursive: true });
    const session = {
      VK_LAYER_PATH: evil,
      VK_ADD_LAYER_PATH: evil,
      VK_IMPLICIT_LAYER_PATH: evil,
      VK_INSTANCE_LAYERS: "VK_LAYER_evil",
      VK_LOADER_LAYERS_ENABLE: "*",
      VK_ICD_FILENAMES: `${evil}/icd.json`,
      VK_DRIVER_FILES: `${evil}/icd.json`,
      LD_PRELOAD: `${evil}/hook.so`,
      LD_LIBRARY_PATH: evil,
    };
    for (const mode of [NativeRunMode.Headless, NativeRunMode.Window]) {
      const box = await boxArgs(rustRequest({ mode, session: { ...session, WAYLAND_DISPLAY: "wayland-0" } }));
      for (const name of Object.keys(session)) {
        if (name === LinuxBoxEnv.VulkanIcd) continue;
        assert.ok(!(name in box.env), `${mode}: ${name}`);
      }
      assert.notEqual(box.env[LinuxBoxEnv.VulkanIcd], session.VK_ICD_FILENAMES, mode);
      assert.ok(!box.ops.some((entry) => entry.args.some((arg) => arg.startsWith(evil))), `${mode}: bound ${evil}`);
    }
  });

  it("refuses a render node that is a link, a card node, or another device, unspawned", async () => {
    const rows: [string, LinuxBoxRequest, LinuxBoxSystem][] = [
      [
        "/dev/dri/renderD128 a symlink to another device",
        rustRequest({ renderNodes: [RENDER_NODE] }),
        system({ [RENDER_NODE]: { stats: stats("link", 0), real: "/dev/sda" } }),
      ],
      ["a card node", rustRequest({ renderNodes: ["/dev/dri/card0"] }), system()],
      ["a path through ..", rustRequest({ renderNodes: ["/dev/dri/../sda"] }), system()],
      [
        "a render node that is not DRM",
        rustRequest({ renderNodes: [RENDER_NODE] }),
        system({ [RENDER_NODE]: { stats: stats("char", 0, 0o666, makedev(8, 128)) } }),
      ],
    ];
    for (const [name, hostile, sys] of rows) {
      const { calls, spawn: record } = recordingSpawn();
      const result = await launchLinuxGameBox(BWRAP, hostile, { system: sys, spawn: record });
      assert.equal(result.ok ? "spawned" : result.refusal, LinuxBoxRefusal.NotARenderNode, name);
      assert.equal(calls.length, 0, `${name}: spawned`);
    }
  });

  it("a software ICD outside the bundle is refused unspawned", async () => {
    const { calls, spawn: record } = recordingSpawn();
    const outside = path.join(root, "evil-layers", "icd.json");
    await writeFile(outside, "{}\n");
    const result = await launchLinuxGameBox(BWRAP, rustRequest({ softwareIcd: outside }), {
      system: system(),
      spawn: record,
    });
    assert.equal(result.ok ? "spawned" : result.refusal, LinuxBoxRefusal.OutsideBundle);
    assert.equal(calls.length, 0);
  });
});

// ── the Wayland helper (native/genex-game-launcher/linux/wayland_context.c) ──────────────────────

const HELPER_SOURCE = path.resolve(import.meta.dirname, "../../native/genex-game-launcher/linux/wayland_context.c");
const MANAGER = "wp_security_context_manager_v1";
const RUN_ID = "0123456789ab";
/**
 * The deadline the rows that expect the helper's answer give it. Those rows test the protocol, not
 * the clock: a starved machine (the parallel suite) may start the helper later than the product's
 * own deadline. The deadline itself is the silent helper's row, injected short.
 */
const ANSWER_WAIT_MS = 120 * SECOND_MS;

/** One request the stand-in compositor read. */
interface WireRequest {
  object: number;
  opcode: number;
  body: Buffer;
}

function wireMessage(object: number, opcode: number, ...args: (number | string)[]): Buffer {
  const parts = args.map((arg) => {
    if (typeof arg === "number") return Buffer.from(new Uint32Array([arg]).buffer);
    const bytes = Buffer.from(`${arg}\0`);
    const padded = Buffer.alloc(4 + Math.ceil(bytes.length / 4) * 4);
    padded.writeUInt32LE(bytes.length, 0);
    bytes.copy(padded, 4);
    return padded;
  });
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(object, 0);
  header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([header, body]);
}

function wireString(body: Buffer, offset: number): string {
  const length = body.readUInt32LE(offset);
  return body.subarray(offset + 4, offset + 4 + length - 1).toString();
}

interface CompositorOptions {
  manager: boolean;
  rejectCommit?: boolean;
}

/** The stand-in compositor's answer to one `wl_display` request: the registry's globals, or a sync's done. */
function displayAnswer(opcode: number, id: number, requests: readonly WireRequest[], options: CompositorOptions) {
  if (opcode === 1) {
    const globals = [wireMessage(id, 0, 1, "wl_compositor", 6)];
    return options.manager ? [...globals, wireMessage(id, 0, 9, MANAGER, 1)] : globals;
  }
  const committed = requests.some((seen) => seen.object === 5 && seen.opcode === 4);
  if (options.rejectCommit && committed) return [wireMessage(1, 0, 5, 1, "invalid listener")];
  return [wireMessage(id, 0, 77)];
}

/** The whole requests at the front of `pending`, and the bytes after them. */
function takeRequests(pending: Buffer): { taken: (WireRequest & { id: number })[]; rest: Buffer } {
  const taken: (WireRequest & { id: number })[] = [];
  let rest = pending;
  while (rest.length >= 8 && rest.length >= rest.readUInt32LE(4) >>> 16) {
    const size = rest.readUInt32LE(4) >>> 16;
    const id = size >= 12 ? rest.readUInt32LE(8) : 0;
    taken.push({
      object: rest.readUInt32LE(0),
      opcode: rest.readUInt32LE(4) & 0xffff,
      body: rest.subarray(8, size),
      id,
    });
    rest = rest.subarray(size);
  }
  return { taken, rest };
}

/** A compositor stand-in on a real Unix socket: offers the manager or not, and may reject the commit. */
async function fakeCompositor(socketPath: string, options: CompositorOptions) {
  const requests: WireRequest[] = [];
  const server = net.createServer((socket) => {
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const { taken, rest } = takeRequests(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const request of taken) {
        requests.push(request);
        if (request.object !== 1) continue;
        for (const answer of displayAnswer(request.opcode, request.id, requests, options)) socket.write(answer);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return requests;
}

let helper = "";
let helperRuntime = "";

async function compiledHelper(): Promise<string> {
  if (helper) return helper;
  const out = path.join(root, "helper");
  await mkdir(out, { recursive: true });
  const target = path.join(out, "genex-wayland-context");
  const built = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-o", target, HELPER_SOURCE], {
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
  helper = target;
  return helper;
}

/** A fresh private runtime folder with a stand-in compositor at `wayland-0`. */
async function compositorSession(options: CompositorOptions) {
  helperRuntime = path.join(root, `w${Math.random().toString(36).slice(2, 6)}`);
  await privateDir(helperRuntime);
  const requests = await fakeCompositor(path.join(helperRuntime, "wayland-0"), options);
  return { requests, session: { XDG_RUNTIME_DIR: helperRuntime, WAYLAND_DISPLAY: "wayland-0" } };
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

describe("the Wayland helper", () => {
  it("commits a per-run security context (engine genex, the run as instance) and prints ready", async () => {
    const program = await compiledHelper();
    const { requests, session } = await compositorSession({ manager: true });
    const opened = await openWaylandContext(program, { runId: RUN_ID, session }, { spawn, timeoutMs: ANSWER_WAIT_MS });
    assert.ok(opened.ok, opened.ok ? "" : `${opened.refusal}: ${opened.detail}`);
    const socketPath = opened.context?.socket ?? "";
    assert.equal(socketPath, path.join(helperRuntime, `genex-wl-${RUN_ID}`, "wl"));
    assert.ok((await lstat(socketPath)).isSocket(), "the helper listens on the run's socket");
    const folder = await lstat(path.dirname(socketPath));
    assert.equal(folder.mode & 0o777, 0o700);
    const bind = requests.find((entry) => entry.object === 2 && entry.opcode === 0);
    assert.equal(bind?.body.readUInt32LE(0), 9, "binds the manager's global");
    assert.equal(bind ? wireString(bind.body, 4) : "", MANAGER);
    const listener = requests.find((entry) => entry.object === 4 && entry.opcode === 1);
    assert.equal(listener?.body.readUInt32LE(0), 5, "create_listener makes the context");
    const text = (opcode: number) => {
      const found = requests.find((entry) => entry.object === 5 && entry.opcode === opcode);
      return found ? wireString(found.body, 0) : null;
    };
    assert.equal(text(1), "genex");
    assert.equal(text(2), WAYLAND_CONTEXT_APP_ID);
    assert.equal(text(3), RUN_ID);
    assert.ok(
      requests.some((entry) => entry.object === 5 && entry.opcode === 4),
      "commit",
    );
    await opened.context?.close();
    assert.equal(await exists(path.dirname(socketPath)), false, "closing removes the run's socket folder");
  });

  it("a compositor without the protocol is unrestricted: no context, nothing left behind", async () => {
    const program = await compiledHelper();
    const { session } = await compositorSession({ manager: false });
    const opened = await openWaylandContext(program, { runId: RUN_ID, session }, { spawn, timeoutMs: ANSWER_WAIT_MS });
    assert.deepEqual(opened, { ok: true, context: null });
    assert.equal(await exists(path.join(helperRuntime, `genex-wl-${RUN_ID}`)), false);
  });

  it("a compositor that rejects the commit is a typed failure, cleaned up", async () => {
    const program = await compiledHelper();
    const { session } = await compositorSession({ manager: true, rejectCommit: true });
    const opened = await openWaylandContext(program, { runId: RUN_ID, session }, { spawn, timeoutMs: ANSWER_WAIT_MS });
    assert.equal(opened.ok ? "opened" : opened.refusal, LinuxBoxRefusal.WaylandContextFailed);
    assert.equal(await exists(path.join(helperRuntime, `genex-wl-${RUN_ID}`)), false);
  });

  it("a helper that never answers is a typed failure after the injected deadline", async () => {
    const { session } = await compositorSession({ manager: true });
    const silent = path.join(root, "helper", "silent");
    await writeFile(silent, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const opened = await openWaylandContext(silent, { runId: RUN_ID, session }, { spawn, timeoutMs: 50 });
    assert.equal(opened.ok ? "opened" : opened.refusal, LinuxBoxRefusal.WaylandContextFailed);
    assert.equal(await exists(path.join(helperRuntime, `genex-wl-${RUN_ID}`)), false);
  });
});

describe("the Wayland helper: refusals", () => {
  it("the helper's own usage line: every flag once, plain tokens, an absolute socket", async () => {
    const program = await compiledHelper();
    for (const args of [
      [],
      ["--socket", "relative/wl", "--app-id", "a", "--instance-id", RUN_ID],
      ["--socket", "/tmp/x", "--app-id", "a b", "--instance-id", RUN_ID],
      ["--socket", "/tmp/x", "--app-id", "a", "--instance-id", RUN_ID, "--socket", "/tmp/y"],
      ["--socket", "/tmp/x", "--app-id", "a", "--instance-id", "../x"],
    ]) {
      const ran = spawnSync(program, args, { encoding: "utf8", env: {} });
      assert.equal(ran.status, 2, JSON.stringify(args));
      assert.equal(ran.stdout, "failed usage\n");
    }
  });

  it("refuses hostile requests typed, and never starts the helper", async () => {
    const program = await compiledHelper();
    const { session } = await compositorSession({ manager: true });
    const open = path.join(root, "w-open");
    await mkdir(open, { recursive: true });
    await chmod(open, 0o755);
    const linked = path.join(root, "w-link");
    await symlink(helperRuntime, linked);
    const planted = path.join(helperRuntime, `genex-wl-${RUN_ID}`);
    await symlink(root, planted);
    const helperLink = path.join(root, "helper", "link");
    await symlink(program, helperLink);
    const rows: [string, string, Record<string, string | undefined>, string, LinuxBoxRefusal][] = [
      ["a run id that climbs", program, session, "../x", LinuxBoxRefusal.UnsafeValue],
      [
        "an X11-only session",
        program,
        { DISPLAY: ":0", XDG_RUNTIME_DIR: helperRuntime },
        RUN_ID,
        LinuxBoxRefusal.X11Only,
      ],
      ["no runtime folder", program, { WAYLAND_DISPLAY: "wayland-0" }, RUN_ID, LinuxBoxRefusal.RuntimeDirMissing],
      ["a relative runtime folder", program, { ...session, XDG_RUNTIME_DIR: "rt" }, RUN_ID, LinuxBoxRefusal.UnsafePath],
      ["a linked runtime folder", program, { ...session, XDG_RUNTIME_DIR: linked }, RUN_ID, LinuxBoxRefusal.PathLinked],
      [
        "a runtime folder others may enter",
        program,
        { ...session, XDG_RUNTIME_DIR: open },
        RUN_ID,
        LinuxBoxRefusal.SocketFolderNotPrivate,
      ],
      [
        "a display that climbs",
        program,
        { ...session, WAYLAND_DISPLAY: "../wayland-0" },
        RUN_ID,
        LinuxBoxRefusal.UnsafeValue,
      ],
      [
        "a display with a newline",
        program,
        { ...session, WAYLAND_DISPLAY: "w\n0" },
        RUN_ID,
        LinuxBoxRefusal.UnsafeValue,
      ],
      [
        "a display that is not a socket",
        program,
        { ...session, WAYLAND_DISPLAY: "missing" },
        RUN_ID,
        LinuxBoxRefusal.Missing,
      ],
      ["a planted context folder", program, session, RUN_ID, LinuxBoxRefusal.AlreadyStarted],
      ["a linked helper", helperLink, session, "0123456789ac", LinuxBoxRefusal.PathLinked],
      ["a relative helper", "genex-wayland-context", session, "0123456789ac", LinuxBoxRefusal.UnsafePath],
    ];
    for (const [name, file, hostileSession, runId, refusal] of rows) {
      let started = 0;
      const record = (...args: Parameters<typeof spawn>) => {
        started += 1;
        return spawn(...args);
      };
      const opened = await openWaylandContext(
        file,
        { runId, session: hostileSession },
        { spawn: record as typeof spawn },
      );
      assert.equal(opened.ok ? "opened" : opened.refusal, refusal, name);
      assert.equal(started, 0, `${name}: started the helper`);
    }
    assert.ok((await lstat(planted)).isSymbolicLink(), "a planted link is left alone, never followed");
  });
});

// ── for real: a headless Rust run inside the box on a Linux host (CI's .deb row, the Linux Studio) ─

/**
 * A lane-built Linux bundle of a Rust game in the dev flavour (`game` plus the Vulkan loader,
 * SwiftShader and its ICD manifest at its top), handed in by the Linux job that built it.
 */
const RUST_LINUX_BUNDLE = process.env.GENEX_LINUX_RUST_BUNDLE ?? "";
const REAL_BWRAP = process.env.GENEX_BWRAP ?? "/usr/bin/bwrap";
const REAL_READY_WAIT_MS = 60 * SECOND_MS;
const REAL_SKIP =
  process.platform !== "linux" || !RUST_LINUX_BUNDLE
    ? "needs a Linux host with bubblewrap and GENEX_LINUX_RUST_BUNDLE (a lane-built dev-flavour Linux bundle)"
    : false;

/** The started bubblewrap as `spawnGame` holds a game: fd 3, its group killed on stop. */
function boxedChild(child: ChildProcess): GameChild {
  const { pid, stdout, stderr } = child;
  const fd3 = child.stdio[3];
  assert.ok(fd3 instanceof Duplex && pid !== undefined && stdout && stderr, "the box has its protocol pipe");
  const exited = new Promise<GameExit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const kill = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    process.kill(-pid, signal);
  };
  return { pid, fd3, stdout, stderr, exited, kill };
}

describe("for real: a headless Rust run in the Linux box", { skip: REAL_SKIP }, () => {
  it("boots on SwiftShader Vulkan (core tier) without a GPU, display or network, and captures what it drew", async () => {
    const run = await realpath(await mkdtemp(path.join(os.tmpdir(), "lgb-real-")));
    const runBundle = path.join(run, "bundle");
    const runState = path.join(run, "state");
    await cp(RUST_LINUX_BUNDLE, runBundle, { recursive: true });
    await mkdir(runState);
    const launched = await launchLinuxGameBox(
      REAL_BWRAP,
      {
        stack: GameStack.RustWgpu,
        mode: NativeRunMode.Headless,
        bundle: runBundle,
        exe: path.join(runBundle, "game"),
        state: runState,
        nonce: "n0nce-real-0001",
        renderNodes: [],
        softwareIcd: path.join(runBundle, "vk_swiftshader_icd.json"),
        waylandContext: null,
        audio: LinuxBoxAudio.Muted,
        session: {},
      },
      { spawn: (file, args, options) => spawn(file, args, options) },
    );
    assert.ok(launched.ok, launched.ok ? "" : `${launched.refusal}: ${launched.detail}`);
    const child = boxedChild(launched.child);
    const port = new NativeGamePort({
      child,
      nonce: "n0nce-real-0001",
      mode: NativeRunMode.Headless,
      stateDir: runState,
      timers: {
        now: () => Date.now(),
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      },
      encodeJpeg: async () => Buffer.from("jpeg"),
    });
    try {
      const late = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("no ready within the wait")), REAL_READY_WAIT_MS).unref();
      });
      const ready = await Promise.race([port.ready(), late]);
      assert.equal(ready.receipt?.tier, NativeGpuTier.Core);
      assert.equal(ready.receipt?.backend, NativeBackend.Vulkan);
      const shot = await port.call(NativeOp.Capture, {});
      const bytes = await readFile(path.join(runState, "captures", `${shot.seq}.bgra`));
      assert.equal(bytes.length, shot.width * shot.height * 4);
      assert.equal(fnv1a64Hex(bytes), shot.digest);
      assert.ok(new Set(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)).size > 1, "not blank");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await rm(run, { recursive: true, force: true });
    }
  });
});

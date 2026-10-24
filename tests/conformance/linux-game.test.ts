/**
 * A game from Play on Linux runs in bubblewrap: the system and its own app read-only, its saves
 * folder its home, none of the person's files, the session's display and sound by their sockets,
 * and no network but its Genex gateway's ports. Hostile values from the session (a remote display,
 * a Wayland path, a port that is not the gateway's) mount and reach nothing. On Linux the game
 * counts as on screen once it has kept running for a few seconds.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { LINUX_GAME_SETTLE_MS, linuxGameWindows } from "../../src/main/play/native-windows-linux.ts";
import {
  GAME_NET_DIR,
  type LinuxGameHost,
  linuxGameCommand,
  spawnLinuxGame,
} from "../../src/substrate/plugins/linux-game.ts";
import type { NativeGameRequest } from "../../src/substrate/plugins/native-process.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME: NativeGameRequest = {
  binary: "/games/dust/1.0/Dust/Dust.x86_64",
  app: "/games/dust/1.0",
  saves: "/games/dust/saves",
  scratch: "/games/.scratch-dust-1",
  bundleId: "games.genex.play.dust",
  bundleName: "Dust.x86_64",
  args: ["-screen-fullscreen", "1"],
  genex: {
    ports: [41000, 41001],
    env: { GENEX_API_URL: "http://127.0.0.1:41000", GENEX_EMBED_TICKET: "t".repeat(32) },
  },
};

const SESSION: LinuxGameHost = {
  bubblewrap: "/usr/bin/bwrap",
  system: ["/usr", "/etc", "/lib64", "/sys/dev"],
  devices: ["/dev/dri", "/dev/nvidia0"],
  x11: { display: ":1", socket: "/tmp/.X11-unix/X1", xauthority: "/home/kir/.Xauthority" },
  runtimeDir: "/run/user/1000",
  wayland: "wayland-0",
  sound: ["pulse/native", "pipewire-0"],
  bridge: { socat: "/usr/bin/socat", dir: "/tmp/genex-net-abc", ports: [41000, 41001] },
};

/** Every `[flag, source, destination]` mount a command names. */
function mounts(args: readonly string[]): string[][] {
  const end = args.indexOf("--");
  const found: string[][] = [];
  for (let at = 0; at < end; at++) {
    const flag = args[at] ?? "";
    if (["--ro-bind", "--bind", "--dev-bind"].includes(flag)) found.push(args.slice(at, at + 3));
  }
  return found;
}

describe("a Linux game's bubblewrap command", () => {
  it("names every mount, its own process table and network, and bridges only the gateway's ports", () => {
    const command = linuxGameCommand(GAME, SESSION);
    assert.equal(command.file, "/usr/bin/bwrap");
    for (const flag of ["--unshare-net", "--unshare-pid", "--die-with-parent"]) assert.ok(command.args.includes(flag));
    assert.deepEqual(mounts(command.args), [
      ["--ro-bind", "/usr", "/usr"],
      ["--ro-bind", "/etc", "/etc"],
      ["--ro-bind", "/lib64", "/lib64"],
      ["--ro-bind", "/sys/dev", "/sys/dev"],
      ["--dev-bind", "/dev/dri", "/dev/dri"],
      ["--dev-bind", "/dev/nvidia0", "/dev/nvidia0"],
      ["--ro-bind", "/tmp/.X11-unix/X1", "/tmp/.X11-unix/X1"],
      ["--ro-bind", "/home/kir/.Xauthority", "/run/genex-xauthority"],
      ["--ro-bind", "/run/user/1000/wayland-0", "/run/user/1000/wayland-0"],
      ["--ro-bind", "/run/user/1000/pulse/native", "/run/user/1000/pulse/native"],
      ["--ro-bind", "/run/user/1000/pipewire-0", "/run/user/1000/pipewire-0"],
      ["--ro-bind", "/tmp/genex-net-abc", GAME_NET_DIR],
      ["--ro-bind", GAME.app, GAME.app],
      ["--bind", GAME.saves, GAME.saves],
      ["--bind", GAME.scratch, GAME.scratch],
    ]);
    const game = command.args.slice(command.args.indexOf("--") + 1);
    assert.deepEqual(game.slice(0, 2), ["/bin/sh", "-c"]);
    assert.deepEqual(game.slice(3), [
      "sh",
      "/usr/bin/socat",
      "41000",
      "41001",
      "--",
      GAME.binary,
      "-screen-fullscreen",
      "1",
    ]);
    assert.deepEqual(command.env, {
      HOME: GAME.saves,
      TMPDIR: GAME.scratch,
      TMP: GAME.scratch,
      TEMP: GAME.scratch,
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DISPLAY: ":1",
      XAUTHORITY: "/run/genex-xauthority",
      WAYLAND_DISPLAY: "wayland-0",
      PULSE_SERVER: "unix:/run/user/1000/pulse/native",
      GENEX_API_URL: GAME.genex?.env.GENEX_API_URL,
      GENEX_EMBED_TICKET: GAME.genex?.env.GENEX_EMBED_TICKET,
    });
    assert.equal(command.cwd, "/games/dust/1.0/Dust");
  });

  it("mounts and reaches nothing a hostile session or request names", () => {
    const hostile: Array<[string, Partial<LinuxGameHost>, Partial<NativeGameRequest>]> = [
      ["a display on another computer", { x11: { display: "evil.example:0", socket: "/tmp/.X11-unix/X0" } }, {}],
      ["a display spelled as a path", { x11: { display: ":../../etc", socket: "/tmp/.X11-unix/X0" } }, {}],
      ["a relative X11 socket", { x11: { display: ":0", socket: "tmp/X0" } }, {}],
      [
        "a cookie with dot segments",
        { x11: { display: ":0", socket: "/tmp/.X11-unix/X0", xauthority: "/home/../etc/shadow" } },
        {},
      ],
      ["a Wayland display named by its path", { wayland: "/home/kir/.ssh/agent" }, {}],
      ["a Wayland name climbing out", { wayland: "../../../home/kir" }, {}],
      ["a relative runtime folder", { runtimeDir: "run/user/1000" }, {}],
      ["a sound socket nobody named", { sound: ["../../home/kir/.ssh/agent.sock"] }, {}],
      ["a device outside /dev", { devices: ["/home/kir"] }, {}],
      ["a system folder with dot segments", { system: ["/usr/../home/kir"] }, {}],
      [
        "a privileged port",
        { bridge: { socat: "/usr/bin/socat", dir: "/tmp/n", ports: [22] } },
        { genex: { ports: [22], env: { GENEX_API_URL: "http://127.0.0.1:22" } } },
      ],
      [
        "a port the game was not given",
        { bridge: { socat: "/usr/bin/socat", dir: "/tmp/n", ports: [5432] } },
        { genex: { ports: [41000], env: { GENEX_API_URL: "http://127.0.0.1:41000" } } },
      ],
      ["a relative socat", { bridge: { socat: "socat", dir: "/tmp/n", ports: [41000] } }, {}],
    ];
    const clean = linuxGameCommand(GAME, { bubblewrap: "/usr/bin/bwrap", system: [], devices: [], sound: [] });
    for (const [why, session, request] of hostile) {
      const command = linuxGameCommand(
        { ...GAME, ...request },
        { bubblewrap: "/usr/bin/bwrap", system: [], devices: [], sound: [], ...session },
      );
      const named = mounts(command.args).filter(
        (mount) => ![GAME.app, GAME.saves, GAME.scratch].includes(mount[1] ?? ""),
      );
      const kept = named.filter((mount) => mount[1] === "/tmp/.X11-unix/X0" && mount[2] === "/tmp/.X11-unix/X0");
      assert.deepEqual(
        named.filter((mount) => !kept.includes(mount)),
        [],
        `${why}: nothing more mounted`,
      );
      assert.equal(command.args.includes("/bin/sh"), false, `${why}: no bridge`);
      assert.equal(command.env.GENEX_API_URL, undefined, `${why}: told no gateway it can't reach`);
      assert.equal(command.env.WAYLAND_DISPLAY, undefined, `${why}: no Wayland`);
      assert.equal(command.env.PULSE_SERVER, undefined, `${why}: no sound socket`);
      if (!kept.length) assert.deepEqual(command.args, clean.args, `${why}: as if the session had none`);
    }
  });
});

describe("a Linux game's window", () => {
  it("counts as on screen once it has kept running for a few seconds, and never once it is gone", async () => {
    let now = 1_000;
    const alive = new Set([7]);
    const windows = linuxGameWindows({ alive: (pid) => alive.has(pid), now: () => now });
    assert.equal(await windows.hasWindow(7), false, "just started");
    now += LINUX_GAME_SETTLE_MS - 1;
    assert.equal(await windows.hasWindow(7), false);
    now += 1;
    assert.equal(await windows.hasWindow(7), true);
    assert.equal(await windows.hasWindow(8), false, "a process that is gone");
  });
});

/** Whether bubblewrap can make a sandbox here, with socat beside it for the bridge. */
function canSandbox(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("bwrap", [
      "--ro-bind",
      "/",
      "/",
      "--unshare-net",
      "--unshare-pid",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "true",
    ]);
    execFileSync("socat", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

const SKIP = canSandbox() ? false : "needs Linux with a working bubblewrap and socat";

/** The probe a game runs: what it can reach of the computer, a line per step. */
const PROBE = `#!/bin/bash
outside=$1; other=$2
echo "home=$HOME"
plays=$(( $(cat "$HOME/plays" 2>/dev/null || echo 0) + 1 )); echo "$plays" > "$HOME/plays" && echo "save=$plays"
touch "$(dirname "$0")/written" 2>/dev/null && echo "install=written" || echo "install=read-only"
cat "$outside" >/dev/null 2>&1 && echo "outside=read" || echo "outside=out"
reach() { (exec 3<>"/dev/tcp/$1/$2" && printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3 && tail -n 1 <&3) 2>/dev/null || echo unreached; }
port=\${GENEX_API_URL##*:}
echo "gateway=$( [ -n "$port" ] && reach 127.0.0.1 "$port" || echo unreached)"
echo "other=$(reach 127.0.0.1 "$other")"
echo "internet=$(timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>/dev/null && echo reached || echo unreached)"
echo "ticket=\${GENEX_EMBED_TICKET:+yes}"
`;

/** Run the probe as an installed game would run, with `genex` its way to Genex; its lines as a map. */
async function probe(root: string, more: { outside: string; other: number; genex?: NativeGameRequest["genex"] }) {
  const app = path.join(root, "probe", "1.0");
  const binary = path.join(app, "Probe", "probe.sh");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, PROBE);
  await chmod(binary, 0o755);
  const saves = path.join(root, "probe", "saves");
  const scratch = path.join(root, ".scratch-probe");
  await mkdir(saves, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const child = await spawnLinuxGame({
    binary,
    app,
    saves,
    scratch,
    bundleId: "games.genex.play.probe",
    bundleName: "probe.sh",
    args: [more.outside, String(more.other)],
    ...(more.genex ? { genex: more.genex } : {}),
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr.resume();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return new Map(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.split("=")[0], line.slice(line.indexOf("=") + 1)]),
  );
}

describe("the game sandbox on this Linux computer", { skip: SKIP }, () => {
  it("makes the saves folder its home, keeps its install read-only and the person's files and network out", async () => {
    const root = await realpath(await tmpDir("linux-game-"));
    const outside = path.join(await realpath(await tmpDir("linux-game-person-")), "secret.txt");
    await writeFile(outside, "the person's");
    const first = await probe(root, { outside, other: 9 });
    assert.equal(first.get("home"), path.join(root, "probe", "saves"));
    assert.equal(first.get("save"), "1");
    assert.equal(first.get("install"), "read-only");
    assert.equal(first.get("outside"), "out", "a file of the person's stays out of reach");
    assert.equal(first.get("gateway"), "unreached", "no gateway, no network");
    assert.equal(first.get("internet"), "unreached");
    const second = await probe(root, { outside, other: 9 });
    assert.equal(second.get("save"), "2", "its save is there next time");
    assert.equal(await readFile(path.join(root, "probe", "saves", "plays"), "utf8"), "2\n");
  });

  it("reaches only its Genex gateway's ports, and is told the gateway and that a ticket waits", async () => {
    const root = await realpath(await tmpDir("linux-game-genex-"));
    const listening = async (body: string) => {
      const server = http.createServer((_req, res) => res.writeHead(200).end(body));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      return { server, port: (server.address() as AddressInfo).port };
    };
    const gateway = await listening("gateway");
    const other = await listening("other");
    try {
      const lines = await probe(root, {
        outside: "/nonexistent",
        other: other.port,
        genex: {
          ports: [gateway.port],
          env: { GENEX_API_URL: `http://127.0.0.1:${gateway.port}`, GENEX_EMBED_TICKET: "t".repeat(32) },
        },
      });
      assert.equal(lines.get("gateway"), "gateway", "its gateway answers");
      assert.equal(lines.get("ticket"), "yes", "the ticket is in its environment");
      assert.equal(lines.get("other"), "unreached", "another port of this computer stays out");
      assert.equal(lines.get("internet"), "unreached", "and so does the internet");
    } finally {
      gateway.server.close();
      other.server.close();
    }
  });
});

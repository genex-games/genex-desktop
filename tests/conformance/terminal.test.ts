import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { TerminalFlow } from "../../src/main/terminal-flow.ts";
import { TerminalService, type TerminalHost } from "../../src/main/terminal-service.ts";
import { LoginTerminalOutput } from "../../src/main/terminal-login-output.ts";
import { LinkScanner } from "../../src/main/terminal-links.ts";
import {
  inDock,
  liveSignIn,
  TERMINAL_LIMITS,
  TerminalKind,
  terminalSize,
  type TerminalEvent,
  type TerminalSession,
} from "../../src/shared/terminal.ts";
import { commandShell, terminalShell } from "../../src/main/terminal-shell.ts";

describe("the shell a game's terminal opens", () => {
  const windowsEnv = {
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
  };
  it("is the account's login shell on macOS and Linux", () => {
    assert.deepEqual(terminalShell("darwin", { userShell: "/opt/homebrew/bin/fish" }), {
      file: "/opt/homebrew/bin/fish",
      args: ["-l"],
    });
    assert.deepEqual(terminalShell("darwin", {}), { file: "/bin/zsh", args: ["-l"] });
    assert.deepEqual(terminalShell("linux", {}), { file: "/bin/bash", args: ["-l"] });
  });
  it("is Git Bash on Windows when Git for Windows is installed, for the machine or the user", () => {
    const machine = "C:\\Program Files\\Git\\bin\\bash.exe";
    assert.deepEqual(terminalShell("win32", { env: windowsEnv, exists: (file) => file === machine }), {
      file: machine,
      args: ["--login", "-i"],
    });
    const user = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    assert.equal(terminalShell("win32", { env: windowsEnv, exists: (file) => file === user })?.file, user);
  });
  it("is Windows PowerShell by its full path otherwise, never a shell found on PATH", () => {
    assert.deepEqual(terminalShell("win32", { env: windowsEnv, exists: () => false }), {
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo"],
    });
  });
  it("is none on a platform Studio does not build for", () => {
    assert.equal(terminalShell("freebsd", {}), null);
  });
  it("runs one offered command as a single argument in that same shell", () => {
    const command = "brew install ffmpeg && echo done";
    assert.deepEqual(commandShell("darwin", command, { userShell: "/bin/zsh" }), {
      file: "/bin/zsh",
      args: ["-l", "-c", command],
    });
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    assert.deepEqual(commandShell("win32", command, { env: windowsEnv, exists: (file) => file === bash }), {
      file: bash,
      args: ["--login", "-c", command],
    });
    assert.deepEqual(commandShell("win32", command, { env: windowsEnv, exists: () => false })?.args, [
      "-NoLogo",
      "-Command",
      command,
    ]);
    assert.equal(commandShell("freebsd", command), null);
  });
});

describe("terminal output admission", () => {
  it("holds output until the view attaches and bounds unacknowledged traffic", () => {
    const data: string[] = [],
      pressure: boolean[] = [];
    const flow = new TerminalFlow(
      (chunk) => data.push(chunk),
      (paused) => pressure.push(paused),
    );
    flow.append("x".repeat(100_000));
    flow.flush();
    assert.equal(data.length, 0);
    assert.deepEqual(pressure, [true]);
    flow.attach();
    assert.equal(data.join("").length, TERMINAL_LIMITS.inFlight);
    flow.acknowledge(999_999);
    assert.equal(data.join("").length, TERMINAL_LIMITS.inFlight);
    for (let n = 0; n < data.length; n++) flow.acknowledge(data[n]!.length);
    assert.equal(flow.pending, 0);
    assert.equal(data.join("").length, 100_000);
    assert.deepEqual(pressure, [true, false]);
  });
  it("preserves Unicode at transport boundaries and refuses unbounded producers", () => {
    const data: string[] = [];
    const flow = new TerminalFlow(
      (chunk) => data.push(chunk),
      () => {},
    );
    const text = "x".repeat(TERMINAL_LIMITS.chunk - 1) + "🌱done";
    flow.append(text);
    flow.attach();
    assert.equal(data.join(""), text);
    assert.equal(data[0]!.length, TERMINAL_LIMITS.chunk - 1);
    assert.throws(() => flow.append("x".repeat(TERMINAL_LIMITS.queue)), /buffer limit/);
  });
});

class Host extends EventEmitter {
  messages: any[] = [];
  postMessage(message: any): void {
    this.messages.push(message);
    if (message.type === "stop") queueMicrotask(() => this.emit("message", { type: "exit", code: 0 }));
  }
  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }
}
const launch = {
  file: "/bin/sh",
  args: ["-l"],
  cwd: "/fixture/game with spaces",
  env: { PATH: "/usr/bin:/bin" },
  title: "Fixture game",
  kind: "shell" as const,
  project: "game",
};
function service() {
  const hosts: Host[] = [],
    events: TerminalEvent[] = [];
  const manager = new TerminalService(
    () => {
      const host = new Host();
      hosts.push(host);
      return host as TerminalHost;
    },
    (event) => events.push(event),
  );
  return { manager, hosts, events };
}
describe("terminal session ownership", () => {
  it("reuses the project session, validates input and resize, and stops exactly once", async () => {
    const { manager, hosts, events } = service();
    const first = manager.open(launch);
    try {
      hosts[0]!.emit("message", { type: "ready" });
      assert.deepEqual(hosts[0]!.messages[0], {
        type: "start",
        file: launch.file,
        args: ["-l"],
        cwd: launch.cwd,
        env: launch.env,
        kind: "shell",
      });
      hosts[0]!.emit("message", { type: "started" });
      assert.equal(manager.open(launch).id, first.id);
      assert.equal(hosts.length, 1);
      manager.write(first.id, "echo hello\r");
      manager.resize(first.id, 92, 25);
      assert.throws(() => manager.write(first.id, "x".repeat(TERMINAL_LIMITS.input + 1)), /too large/);
      assert.throws(() => manager.resize(first.id, NaN, 2), /size/);
      assert.throws(() => manager.write("other-session", "input"), /closed/);
      assert.throws(() => manager.remove(first.id), /Stop/);
      await Promise.all([manager.stop(first.id), manager.stop(first.id)]);
      assert.equal(hosts[0]!.messages.filter((m) => m.type === "stop").length, 1);
      assert.equal(manager.list()[0]!.exitCode, 130, "a cancelled process cannot report success");
      manager.remove(first.id);
      assert.equal(manager.list().length, 0);
      assert.equal(events.at(-1)?.type, "removed");
    } finally {
      await manager.dispose();
    }
  });
  it("bounds sessions and cleans every host on shutdown", async () => {
    const { manager, hosts } = service();
    try {
      for (let n = 0; n < TERMINAL_LIMITS.sessions; n++) manager.open({ ...launch, project: `game-${n}` });
      assert.throws(() => manager.open({ ...launch, project: "overflow" }), /Close a terminal/);
      await manager.dispose();
      assert.equal(manager.list().length, 0);
      assert.equal(
        hosts.every((host) => host.messages.some((m) => m.type === "stop")),
        true,
      );
    } finally {
      await manager.dispose();
    }
  });
  it("reports a crashed host and ignores late messages", async () => {
    const { manager, hosts, events } = service();
    const session = manager.open(launch);
    hosts[0]!.emit("exit", 1);
    assert.equal(manager.list()[0]!.phase, "exited");
    assert.match(manager.list()[0]!.error!, /unexpectedly/);
    const count = events.length;
    hosts[0]!.emit("message", { type: "data", data: "late" });
    assert.equal(events.length, count);
    manager.remove(session.id);
  });
});

describe("managed sign-in display", () => {
  it("filters URL and token words even when every character arrives separately", () => {
    const urls: string[] = [];
    const filter = new LoginTerminalOutput((url) => urls.push(url));
    const source =
      "\x1b[32mOpen https://claude.com/oauth?state=private&code_challenge=hidden\x1b[0m\r\naccess_token: secret-value\r\nPaste code > ";
    let output = "";
    for (const char of source) output += filter.write(char);
    output += filter.end();
    assert.doesNotMatch(output, /private|hidden|secret-value|https/);
    assert.match(output, /\x1b\[32mOpen/);
    assert.match(output, /Paste code > /);
    assert.deepEqual(urls, ["https://claude.com/oauth?state=private&code_challenge=hidden"]);
  });
  it("bounds malformed unfinished output and does not expose OSC links", () => {
    const filter = new LoginTerminalOutput(() => {});
    assert.equal(filter.write("x".repeat(100_000)), "");
    assert.equal(filter.write(" "), "[output omitted] ");
    assert.doesNotMatch(filter.write("\x1b]8;;https://claude.com/?state=secret\x07Sign-in\x1b]8;;\x07 "), /secret/);
    assert.throws(() => terminalSize(1, 0), /size/);
  });
});

describe("a command a chat reply offered", () => {
  const command = { ...launch, args: ["-l", "-c", "brew install ffmpeg"], kind: "command" as const };
  it("reports its last lines when it finishes", async () => {
    const { manager, hosts, events } = service();
    const session = manager.open({ ...command, command: "brew install ffmpeg" });
    try {
      assert.equal(session.command, "brew install ffmpeg");
      const opened = events.find((event) => event.type === "session");
      assert.equal(opened?.type === "session" && opened.reveal, false, "its output shows in the chat, not the dock");
      hosts[0]!.emit("message", { type: "ready" });
      hosts[0]!.emit("message", { type: "started" });
      hosts[0]!.emit("message", { type: "data", data: "\u001b[32m==> Pouring\u001b[0m\r\n" });
      hosts[0]!.emit("message", { type: "data", data: "ffmpeg 7.1 installed\r\n" });
      hosts[0]!.emit("message", { type: "exit", code: 0 });
      const finished = manager.list()[0]!;
      assert.equal(finished.exitCode, 0);
      assert.deepEqual(finished.output, ["==> Pouring", "ffmpeg 7.1 installed"]);
      const last = events.at(-1);
      assert.equal(last?.type === "session" && last.session.output?.length, 2);
    } finally {
      await manager.dispose();
    }
  });
  it("runs one at a time per game, and a shell keeps no output", async () => {
    const { manager, hosts } = service();
    try {
      manager.open({ ...command, command: "brew install ffmpeg" });
      assert.throws(() => manager.open({ ...command, command: "git lfs install" }), /already running/);
      assert.equal(hosts.length, 1);
      manager.open({ ...command, project: "other-game", command: "git lfs install" });
      const shell = manager.open(launch);
      hosts[2]!.emit("message", { type: "data", data: "hello\r\n" });
      hosts[2]!.emit("message", { type: "exit", code: 0 });
      assert.equal(manager.list().find((session) => session.id === shell.id)?.output, undefined);
    } finally {
      await manager.dispose();
    }
  });
});

describe("OpenCode's sign-in terminal", () => {
  const signIn = { ...launch, args: ["auth", "login"], kind: TerminalKind.OpenCodeLogin, project: undefined };
  it("opens in Settings, never popping up the dock, even when asked again while it runs", async () => {
    const { manager, events } = service();
    try {
      const first = manager.open(signIn);
      const again = manager.open(signIn);
      assert.equal(again.id, first.id, "one sign-in at a time");
      const shown = events.filter((event) => event.type === "session");
      assert.ok(shown.length >= 2);
      assert.ok(
        shown.every((event) => event.type === "session" && !event.reveal),
        "Settings shows it; the dock would close Settings",
      );
    } finally {
      await manager.dispose();
    }
  });

  it("is left out of the dock, and is the sign-in Settings shows while it runs", () => {
    const session = (kind: TerminalKind, phase: TerminalSession["phase"]): TerminalSession => ({
      id: `${kind}-${phase}`,
      title: kind,
      kind,
      phase,
    });
    const sessions = [
      session(TerminalKind.Shell, "running"),
      session(TerminalKind.OpenCodeLogin, "exited"),
      session(TerminalKind.OpenCodeLogin, "running"),
    ];
    assert.deepEqual(
      sessions.filter(inDock).map((each) => each.kind),
      [TerminalKind.Shell],
    );
    assert.equal(liveSignIn(sessions, TerminalKind.OpenCodeLogin)?.id, "opencode-login-running");
    assert.equal(liveSignIn(sessions.slice(0, 2), TerminalKind.OpenCodeLogin), undefined, "a finished one is over");
  });
});

describe("a sign-in page a terminal prints", () => {
  it("is noticed once whole, across chunks and colors, and never changes what shows", () => {
    const found: string[] = [];
    const scanner = new LinkScanner((url) => found.push(url));
    scanner.write("Go to: \u001b[36mhttps://auth.openai.com/oauth/auth");
    assert.deepEqual(found, [], "half an address is not one");
    scanner.write("orize?client_id=app&state=x\u001b[0m\r\n");
    scanner.write("or http://insecure.example and https://\r\n");
    assert.deepEqual(found, ["https://auth.openai.com/oauth/authorize?client_id=app&state=x"]);
    const tooLong: string[] = [];
    const endless = new LinkScanner((url) => tooLong.push(url));
    endless.write(`https://${"a".repeat(40_000)}`);
    endless.write(" https://example.com/next ");
    assert.deepEqual(
      tooLong,
      ["https://example.com/next"],
      "an address too long to hold is dropped, not half reported",
    );
  });

  it("is the session's page to open, the newest one, and the session says it has one", async () => {
    const { manager, hosts, events } = service();
    try {
      const session = manager.open({ ...launch, kind: TerminalKind.OpenCodeLogin, project: undefined });
      assert.equal(manager.link(session.id), null);
      hosts[0]!.emit("message", { type: "link", url: "https://chatgpt.com/first" });
      hosts[0]!.emit("message", { type: "link", url: "https://auth.openai.com/oauth/authorize?x=1" });
      hosts[0]!.emit("message", { type: "link", url: "javascript:alert(1)" });
      assert.equal(manager.link(session.id), "https://auth.openai.com/oauth/authorize?x=1");
      const last = events.filter((event) => event.type === "session").at(-1);
      assert.equal(last?.type === "session" && last.session.signInPage, true);
      assert.ok(
        !JSON.stringify(events).includes("oauth/authorize"),
        "the address stays in main; the page only learns there is one",
      );
      assert.throws(() => manager.link("no-such-session"), /closed/);
    } finally {
      await manager.dispose();
    }
  });
});

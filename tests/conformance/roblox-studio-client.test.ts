import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createStudioClient,
  parseStudios,
  type SpawnStudioMcp,
  StudioClientError,
  StudioClientFailure,
  type StudioClientDeps,
  studioAnswers,
  systemStudioClientDeps,
} from "../../src/plugins/roblox/studio-client.ts";
import type { LocateStat } from "../../src/plugins/roblox/studio-locate.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FAKE = path.resolve(import.meta.dirname, "../fixtures/fake-roblox-studio-mcp.mjs");
const MAC_MCP = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
const PLAIN_FILE: LocateStat = { file: true, directory: false, link: false, mtimeMs: 0 };
const PLAIN_FOLDER: LocateStat = { file: false, directory: true, link: false, mtimeMs: 0 };

type Spawned = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv; verbatim: boolean };

/** A spawn that records what the client asked for and starts the stand-in StudioMCP in its place. */
function standIn(flags: string[] = []) {
  const spawned: Spawned[] = [];
  const run: SpawnStudioMcp = (file, args, options) => {
    spawned.push({ file, args, env: options.env, verbatim: options.windowsVerbatimArguments });
    return spawn(process.execPath, [FAKE, ...flags], { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  };
  return { spawned, run };
}

/** A clock the client's waits move forward at once. */
function fakeClock() {
  const clock = { t: 0, sleeps: 0 };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps++;
      clock.t += ms;
    },
  };
}

/** A disk that knows only the given paths, by lstat and realpath. */
function disk(stats: Record<string, LocateStat>, real: Record<string, string> = {}): StudioClientDeps["fs"] {
  return {
    lstat: async (file) => stats[file],
    realpath: async (file) => {
      if (!(file in stats) && !(file in real)) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
      return real[file] ?? file;
    },
  };
}

function macDeps(run: SpawnStudioMcp, more: Partial<StudioClientDeps> = {}): StudioClientDeps {
  return {
    platform: "darwin",
    env: { PATH: process.env.PATH, HOME: "/tmp/bridge-home" },
    home: "/Users/ann",
    mcp: async () => MAC_MCP,
    fs: disk({ [MAC_MCP]: PLAIN_FILE }),
    spawn: run,
    now: Date.now,
    sleep: realSleep,
    limit: realSleep,
    ...more,
  };
}

/** A pause on the wall clock that ends early once `signal` aborts. */
const realSleep = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined);

async function logOf(file: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const failure = (code: StudioClientFailure) => (error: unknown) =>
  error instanceof StudioClientError && error.code === code;

test("a Studio that joins StudioMCP late is waited for, and found once it lists", async () => {
  const fake = standIn(["--late-studio", "300"]);
  const client = createStudioClient(macDeps(fake.run));
  try {
    assert.deepEqual(await client.studios(), [], "StudioMCP lists no Studio at first");
    const studio = await client.waitForStudio((s) => s.name === "Place1", { timeoutMs: 10_000, everyMs: 50 });
    assert.deepEqual(studio, { id: "studio-1", name: "Place1" });
  } finally {
    await client.close();
  }
});

test("the join wait ends at the injected deadline with a plain refusal", async () => {
  const fake = standIn(["--no-studio"]);
  const time = fakeClock();
  const client = createStudioClient(macDeps(fake.run, { now: time.now, sleep: time.sleep }));
  try {
    await assert.rejects(
      client.waitForStudio(() => true, { timeoutMs: 1_000, everyMs: 250 }),
      (error: unknown) => {
        assert.ok(failure(StudioClientFailure.NotListed)(error));
        assert.match((error as Error).message, /Roblox Studio/);
        return true;
      },
    );
    assert.equal(time.clock.t, 1_000, "it stops at the deadline, not past it");
    assert.equal(time.clock.sleeps, 4);
  } finally {
    await client.close();
  }
});

test("two Studios with the same place open are refused, not guessed between", async () => {
  const studios = JSON.stringify([
    { id: "a", name: "Obby.rbxl" },
    { id: "b", name: "Obby.rbxl" },
  ]);
  const fake = standIn(["--studios", studios]);
  const client = createStudioClient(macDeps(fake.run));
  try {
    await assert.rejects(
      client.waitForStudio((s) => s.name === "Obby.rbxl", { timeoutMs: 1_000, everyMs: 50 }),
      failure(StudioClientFailure.TwoStudios),
    );
  } finally {
    await client.close();
  }
});

test("a crash mid-call rejects every pending call, and the next call starts StudioMCP again", async () => {
  const dir = await tmpDir("roblox-client-");
  const log = path.join(dir, "calls.jsonl");
  const fake = standIn(["--log", log, "--crash-after", "2"]);
  const client = createStudioClient(macDeps(fake.run));
  try {
    const first = await client.callTool("get_studio_state", { studio_id: "studio-1" });
    assert.notEqual(first.isError, true);
    const pending = [
      client.callTool("get_console_output", { studio_id: "studio-1" }),
      client.callTool("get_studio_state", { studio_id: "studio-1" }),
    ];
    for (const call of pending) await assert.rejects(call, failure(StudioClientFailure.Crashed));
    const again = await client.callTool("get_studio_state", { studio_id: "studio-1" });
    assert.notEqual(again.isError, true);
    const starts = (await logOf(log)).filter((entry) => entry.start);
    assert.equal(starts.length, 2, "one restart");
    assert.equal(fake.spawned.length, 2);
  } finally {
    await client.close();
  }
});

test("StudioMCP gets the person's real home even when the bridge runs with another HOME", async (t) => {
  if (process.platform === "win32") return t.skip("HOME is the Mac's home; Windows passes LOCALAPPDATA through");
  const dir = await tmpDir("roblox-home-");
  const log = path.join(dir, "calls.jsonl");
  const fake = standIn(["--log", log]);
  const saved = process.env.HOME;
  process.env.HOME = path.join(dir, "bridge-home");
  try {
    const deps = { ...systemStudioClientDeps(async () => MAC_MCP), platform: "darwin" as const };
    const client = createStudioClient({ ...deps, fs: disk({ [MAC_MCP]: PLAIN_FILE }), spawn: fake.run });
    try {
      await client.studios();
    } finally {
      await client.close();
    }
  } finally {
    process.env.HOME = saved;
  }
  const real = os.userInfo().homedir;
  assert.notEqual(real, path.join(dir, "bridge-home"));
  assert.equal(fake.spawned[0]?.file, MAC_MCP);
  assert.deepEqual(fake.spawned[0]?.args, []);
  assert.equal((await logOf(log))[0]?.start.home, real);
});

const LOCAL = "C:\\Users\\Ann\\AppData\\Local";
const winMcp = (local: string) => `${local}\\Roblox\\mcp.bat`;
const WIN_ENV = { LOCALAPPDATA: LOCAL, SystemRoot: "C:\\Windows", PATH: process.env.PATH };

function windowsDeps(run: SpawnStudioMcp, mcp: string, fs: StudioClientDeps["fs"], env = WIN_ENV): StudioClientDeps {
  return { ...macDeps(run), platform: "win32", env, mcp: async () => mcp, fs };
}

test("on Windows, mcp.bat starts through cmd.exe from its real path, as commandLaunch builds the line", async () => {
  const fake = standIn();
  const mcp = winMcp(LOCAL);
  const fs = disk({ [mcp]: PLAIN_FILE, [`${LOCAL}\\Roblox`]: PLAIN_FOLDER });
  const client = createStudioClient(windowsDeps(fake.run, mcp, fs));
  try {
    await client.studios();
  } finally {
    await client.close();
  }
  assert.deepEqual(fake.spawned.length, 1);
  const [launch] = fake.spawned;
  assert.equal(launch?.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(launch?.args, ["/d", "/v:off", "/s", "/c", `""${mcp}""`]);
  assert.equal(launch?.verbatim, true);
  assert.equal(launch?.env.LOCALAPPDATA, LOCAL, "Studio's own folder stays the person's");
});

test("hostile StudioMCP launch paths are refused and nothing is started", async () => {
  const outside = "C:\\Users\\Ann\\Downloads\\mcp.bat";
  const roblox = `${LOCAL}\\Roblox`;
  const mcp = winMcp(LOCAL);
  const odd = (local: string) => ({
    mcp: winMcp(local),
    fs: disk({ [winMcp(local)]: PLAIN_FILE, [`${local}\\Roblox`]: PLAIN_FOLDER }),
    env: { ...WIN_ENV, LOCALAPPDATA: local },
  });
  const rows: Array<{
    name: string;
    mcp: string;
    fs: StudioClientDeps["fs"];
    env?: typeof WIN_ENV;
    platform?: NodeJS.Platform;
  }> = [
    { name: "outside LOCALAPPDATA\\Roblox", mcp: outside, fs: disk({ [outside]: PLAIN_FILE, [roblox]: PLAIN_FOLDER }) },
    { name: "a link", mcp, fs: disk({ [mcp]: { ...PLAIN_FILE, link: true }, [roblox]: PLAIN_FOLDER }) },
    {
      name: "a real path that leaves the Roblox folder",
      mcp,
      fs: disk({ [mcp]: PLAIN_FILE, [roblox]: PLAIN_FOLDER }, { [mcp]: "C:\\Temp\\evil\\mcp.bat" }),
    },
    {
      name: "a Roblox folder that is a link",
      mcp,
      fs: disk({ [mcp]: PLAIN_FILE, [roblox]: { ...PLAIN_FOLDER, link: true } }),
    },
    {
      name: "another script's name",
      mcp: `${roblox}\\run.bat`,
      fs: disk({ [`${roblox}\\run.bat`]: PLAIN_FILE, [roblox]: PLAIN_FOLDER }),
    },
    { name: "a % in the path", ...odd("C:\\Users\\A%PATH%n\\AppData\\Local") },
    { name: "a ^ in the path", ...odd("C:\\Users\\A^n\\AppData\\Local") },
    { name: "an & in the path", ...odd("C:\\Users\\A&calc\\AppData\\Local") },
    { name: 'a " in the path', ...odd('C:\\Users\\A"n\\AppData\\Local') },
    { name: "no LOCALAPPDATA", mcp, fs: disk({ [mcp]: PLAIN_FILE }), env: { ...WIN_ENV, LOCALAPPDATA: "" } },
    {
      name: "a Mac StudioMCP that is a link",
      mcp: MAC_MCP,
      fs: disk({ [MAC_MCP]: { ...PLAIN_FILE, link: true } }),
      platform: "darwin",
    },
  ];
  for (const row of rows) {
    const fake = standIn();
    const base = windowsDeps(fake.run, row.mcp, row.fs, row.env);
    const client = createStudioClient({ ...base, platform: row.platform ?? "win32" });
    try {
      await assert.rejects(client.studios(), failure(StudioClientFailure.Refused), row.name);
    } finally {
      await client.close();
    }
    assert.equal(fake.spawned.length, 0, `${row.name}: nothing started`);
  }
});

test("no StudioMCP on this computer: calls answer that Studio isn't installed and start nothing", async () => {
  const fake = standIn();
  const client = createStudioClient(macDeps(fake.run, { mcp: async () => undefined }));
  try {
    await assert.rejects(client.listTools(), failure(StudioClientFailure.NotInstalled));
  } finally {
    await client.close();
  }
  assert.equal(fake.spawned.length, 0);
});

test("close ends StudioMCP, and a restart starts a fresh one", async () => {
  const dir = await tmpDir("roblox-close-");
  const log = path.join(dir, "calls.jsonl");
  const fake = standIn(["--log", log]);
  const client = createStudioClient(macDeps(fake.run));
  await client.studios();
  await client.restart();
  await client.studios();
  await client.close();
  await assert.rejects(client.studios(), failure(StudioClientFailure.Closed));
  const starts = (await logOf(log)).filter((entry) => entry.start).map((entry) => entry.start.pid);
  assert.equal(new Set(starts).size, 2);
});

test("the backend counts Studio as answering only while StudioMCP lists one, and never throws", async () => {
  const rows: Array<{ name: string; flags: string[]; mcp?: string; answering: boolean }> = [
    { name: "a Studio listed", flags: [], answering: true },
    { name: "none listed", flags: ["--no-studio"], answering: false },
    { name: "StudioMCP crashes", flags: ["--crash-after", "1"], answering: false },
  ];
  for (const row of rows) {
    const fake = standIn(row.flags);
    const client = createStudioClient(macDeps(fake.run));
    try {
      assert.equal(await studioAnswers(client), row.answering, row.name);
    } finally {
      await client.close();
    }
  }
  const missing = createStudioClient(macDeps(standIn().run, { mcp: async () => undefined }));
  assert.equal(await studioAnswers(missing), false, "no StudioMCP");
  await missing.close();
});

test("a StudioMCP that never answers initialize is ended, not left running", async () => {
  const children: ChildProcess[] = [];
  const fake = standIn(["--no-init"]);
  const run: SpawnStudioMcp = (file, args, options) => {
    const child = fake.run(file, args, options);
    children.push(child);
    return child;
  };
  const client = createStudioClient(macDeps(run, { limit: async () => {} }));
  try {
    await assert.rejects(client.studios(), failure(StudioClientFailure.TimedOut));
    assert.equal(children.length, 1);
    const [child] = children;
    if (child && child.exitCode === null && child.signalCode === null)
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3_000)]);
    assert.ok(child?.exitCode !== null || child?.signalCode !== null, "it was ended");
  } finally {
    await client.close();
  }
});

test("a nameless Studio (a play test's server or client, or one just opening) is listed with an empty name", () => {
  const listed = (studios: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ studios }) }] });
  assert.deepEqual(
    parseStudios(
      listed([
        { id: "server-1", name: null },
        { id: "edit-1", name: "Place1" },
        { id: "client-1" },
        { id: 7, name: "not an id" },
        { id: "", name: "no id" },
        { id: "odd", name: 3 },
      ]),
    ),
    [
      { id: "server-1", name: "" },
      { id: "edit-1", name: "Place1" },
      { id: "client-1", name: "" },
    ],
  );
});

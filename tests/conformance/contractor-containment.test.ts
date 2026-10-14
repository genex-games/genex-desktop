/**
 * Contractor containment: what an adversarial contractor can plant in the one tree it may write
 * must never steer the unsandboxed studio process into touching anything outside it.
 *
 * PH-1: the studio bridge answers a Codex contractor by writing into `.studio/bridge/res/`.
 * PH-2: the ownership-lock marker (`.studio-locks.json`) tells the studio what to chmod back.
 * Both live inside the workspace, so both are hostile input. Each row asserts no side effect
 * outside the workspace.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { StudioBridge } from "../../src/substrate/engines/studio-bridge.ts";
import {
  type ChmodUnreadableIo,
  chmodUnreadable,
  LOCK_MARKER,
  lockUnowned,
  releaseLocks,
  releaseStaleLocks,
  reapplyLocks,
  type LockRecord,
} from "../../src/substrate/engines/ownership-locks.ts";
import { tmpDir } from "../helpers/tmp.ts";

const WINDOWS = process.platform === "win32";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
).toString("base64");

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

async function openBridge(cwd: string, calls: string[]) {
  return StudioBridge.open({
    cwd,
    pollMs: 10,
    tools: [{ name: "capture", description: "look", parameters: { type: "object", properties: {} } }],
    onCall: async (name) => {
      calls.push(name);
      return { text: '{"saved":1}', images: [{ mimeType: "image/png", data: PNG }] };
    },
  });
}

describe("PH-1: the bridge never writes through what the contractor planted", () => {
  it("a pre-planted symlink at the answer's temp name leaves its target untouched", async () => {
    const root = await tmpDir("bridge-tmp-link-");
    const cwd = path.join(root, "ws");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    const victim = path.join(outside, "victim-rc");
    await writeFile(victim, "# the user's shell rc\n");
    const calls: string[] = [];
    const bridge = await openBridge(cwd, calls);
    try {
      // What the contractor does inside its one writable root.
      await symlink(victim, path.join(bridge.dir, "res", "evil.json.tmp"));
      await writeFile(
        path.join(bridge.dir, "req", "evil.json"),
        JSON.stringify({ id: "evil", name: "$(touch RAN)", args: {} }),
      );
      const answered = await waitFor(async () => {
        const info = await lstat(path.join(bridge.dir, "res", "evil.json"));
        return info.isFile() ? info : undefined;
      });
      await settle();
      assert.equal(
        await readFile(victim, "utf8"),
        "# the user's shell rc\n",
        "the file outside the workspace is untouched",
      );
      assert.ok(answered, "the refusal still reaches the contractor, as a plain file beside the request");
      assert.match(await readFile(path.join(bridge.dir, "res", "evil.json"), "utf8"), /no studio tool called/);
    } finally {
      await bridge.close();
    }
  });

  it("a res/ swapped for a symlink to an outside folder gets no answer and no image written into it", async () => {
    const root = await tmpDir("bridge-res-link-");
    const cwd = path.join(root, "ws");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    const calls: string[] = [];
    const bridge = await openBridge(cwd, calls);
    try {
      await rm(path.join(bridge.dir, "res"), { recursive: true, force: true });
      await symlink(outside, path.join(bridge.dir, "res"));
      await writeFile(
        path.join(bridge.dir, "req", "one.json"),
        JSON.stringify({ id: "one", name: "capture", args: {} }),
      );
      await writeFile(path.join(bridge.dir, "req", "two.json"), JSON.stringify({ id: "two", name: "nope", args: {} }));
      await waitFor(async () => (calls.length ? true : undefined), 1_000);
      await settle();
      assert.deepEqual(await readdir(outside), [], "nothing lands outside the workspace");
    } finally {
      await bridge.close();
    }
    assert.deepEqual(await readdir(outside), [], "closing the bridge does not reach through the link either");
  });

  it("a bridge dir swapped for a symlink to an outside tree gets nothing written into that tree", async () => {
    const root = await tmpDir("bridge-dir-link-");
    const cwd = path.join(root, "ws");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(outside, "req"), { recursive: true });
    await mkdir(path.join(outside, "res"), { recursive: true });
    const calls: string[] = [];
    const bridge = await openBridge(cwd, calls);
    try {
      await rename(bridge.dir, path.join(cwd, ".studio", "moved-bridge"));
      await symlink(outside, bridge.dir);
      await writeFile(path.join(outside, "req", "one.json"), JSON.stringify({ id: "one", name: "capture", args: {} }));
      await waitFor(async () => (calls.length ? true : undefined), 1_000);
      await settle();
      assert.deepEqual(await readdir(path.join(outside, "res")), [], "no answer and no image outside the workspace");
    } finally {
      await bridge.close();
    }
    assert.deepEqual(
      (await readdir(outside)).sort(),
      ["req", "res"],
      "closing the bridge removes the link, not the tree it points at",
    );
  });

  it("a req/ swapped for a symlink to an outside folder is never read, and no request in it runs (TQ-4)", async () => {
    const root = await tmpDir("bridge-req-link-");
    const cwd = path.join(root, "ws");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    // Files outside the workspace shaped like requests: one a tool call, one that only a read would find broken.
    await writeFile(path.join(outside, "run.json"), JSON.stringify({ id: "run", name: "capture", args: {} }));
    await writeFile(path.join(outside, "broken.json"), "{ not json");
    const calls: string[] = [];
    const bridge = await openBridge(cwd, calls);
    try {
      await rm(path.join(bridge.dir, "req"), { recursive: true, force: true });
      await symlink(outside, path.join(bridge.dir, "req"));
      await settle(500);
      assert.deepEqual(calls, [], "no outside request ran as a tool call");
      assert.deepEqual(
        await readdir(path.join(bridge.dir, "res")),
        [],
        "and none was read: not even a parse error was answered",
      );
      assert.deepEqual((await readdir(outside)).sort(), ["broken.json", "run.json"], "nothing was written outside");
    } finally {
      await bridge.close();
    }
    assert.deepEqual(
      (await readdir(outside)).sort(),
      ["broken.json", "run.json"],
      "closing the bridge does not reach through the link",
    );
  });

  it("a .studio swapped for a symlink never lets open or close delete the outside folder's bridge", async () => {
    const root = await tmpDir("bridge-studio-link-");
    const cwd = path.join(root, "ws");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(outside, "bridge"), { recursive: true });
    await writeFile(path.join(outside, "bridge", "keep.txt"), "the user's");
    await symlink(outside, path.join(cwd, ".studio"));
    await assert.rejects(() => openBridge(cwd, []), /bridge/i);
    assert.equal(await readFile(path.join(outside, "bridge", "keep.txt"), "utf8"), "the user's");
  });
});

describe("PH-2: the lock marker is hostile input", () => {
  async function workspace(prefix: string) {
    const root = await tmpDir(prefix);
    const cwd = path.join(root, "ws");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    const secret = path.join(outside, "private-file");
    await writeFile(secret, "secret");
    await chmod(secret, 0o600);
    // 0o600 on POSIX; Windows keeps only a read-only flag, so the file reads 0o666 there.
    const secretMode = await modeOf(secret);
    return { root, cwd, outside, secret, secretMode };
  }
  const modeOf = async (file: string) => (await stat(file)).mode & 0o7777;

  const hostile: Array<{ name: string; entry: (ctx: { cwd: string; secret: string }) => Promise<string> }> = [
    { name: "a ../ path", entry: async () => "../outside/private-file" },
    { name: "an absolute path", entry: async ({ secret }) => secret },
    { name: "a path that climbs out through src/../..", entry: async () => "src/../../outside/private-file" },
    {
      name: "an in-workspace symlink to an outside file",
      entry: async ({ cwd, secret }) => {
        await symlink(secret, path.join(cwd, "lnk"));
        return "lnk";
      },
    },
    {
      name: "a file under an in-workspace symlinked directory",
      entry: async ({ cwd, secret }) => {
        await symlink(path.dirname(secret), path.join(cwd, "dirlink"));
        return "dirlink/private-file";
      },
    },
  ];

  for (const row of hostile) {
    it(`releaseStaleLocks leaves ${row.name} alone`, async () => {
      const ctx = await workspace("locks-hostile-");
      const file = await row.entry(ctx);
      await writeFile(
        path.join(ctx.cwd, LOCK_MARKER),
        JSON.stringify({ facetId: "x", at: "", files: [{ file, mode: 0o666 }] }),
      );
      await releaseStaleLocks(ctx.cwd);
      assert.equal(await modeOf(ctx.secret), ctx.secretMode, `${row.name}: the outside file keeps its mode`);
    });

    it(`releaseLocks and reapplyLocks leave ${row.name} alone even from an in-memory record`, async () => {
      const ctx = await workspace("locks-hostile-record-");
      const file = await row.entry(ctx);
      const record: LockRecord = { facetId: "x", at: "", files: [{ file, mode: 0o644 }] };
      await reapplyLocks(ctx.cwd, record);
      assert.equal(await modeOf(ctx.secret), ctx.secretMode, `${row.name}: re-locking does not reach outside`);
      await releaseLocks(ctx.cwd, record);
      assert.equal(await modeOf(ctx.secret), ctx.secretMode, `${row.name}: releasing does not reach outside`);
    });
  }

  it("a marker planted as a link to an outside file is never written through", async () => {
    const ctx = await workspace("locks-marker-link-");
    await writeFile(ctx.secret, "# the user's shell rc\n");
    await writeFile(path.join(ctx.cwd, "index.html"), "<!doctype html>");
    await symlink(ctx.secret, path.join(ctx.cwd, LOCK_MARKER));
    const record = await lockUnowned(ctx.cwd, { facetId: "enemies", owns: ["src/enemies.js"], ownsMain: false }).catch(
      () => null,
    );
    assert.equal(await readFile(ctx.secret, "utf8"), "# the user's shell rc\n", "the outside file keeps its contents");
    assert.equal(await modeOf(ctx.secret), ctx.secretMode);
    if (record) await releaseLocks(ctx.cwd, record);
  });

  it("gives back only the write bits the lock took, never a mode the marker invents", async () => {
    const ctx = await workspace("locks-mode-");
    const file = path.join(ctx.cwd, "index.html");
    await writeFile(file, "<!doctype html>");
    await chmod(file, 0o444);
    await writeFile(
      path.join(ctx.cwd, LOCK_MARKER),
      JSON.stringify({ facetId: "x", at: "", files: [{ file: "index.html", mode: 0o6777 }] }),
    );
    assert.equal(await releaseStaleLocks(ctx.cwd), true);
    // Flipped (L4) from 0o666, "write bits back": a marker read from disk is the contractor's
    // claim, so it gives back at most the owner's write bit, never group or world write.
    assert.equal(
      await modeOf(file),
      // Windows has no group, world or special bits: writable again reads 0o666 there.
      WINDOWS ? 0o666 : 0o644,
      "the owner's write bit back; no group/world write, exec, setuid or setgid bit appears",
    );
  });

  it("gives a write-only file its write bit back although the lock left it unreadable", {
    skip: WINDOWS && "Windows files cannot be write-only",
  }, async () => {
    const ctx = await workspace("locks-write-only-");
    const file = path.join(ctx.cwd, "index.html");
    await writeFile(file, "<!doctype html>");
    await chmod(file, 0o200);
    const record = await lockUnowned(ctx.cwd, { facetId: "enemies", owns: ["src/enemies.js"], ownsMain: false });
    assert.equal(await modeOf(file), 0o000);
    await releaseLocks(ctx.cwd, record);
    assert.equal(await modeOf(file), 0o200);
  });
});

/**
 * A file its owner cannot read is locked and released without reading it. GNU coreutils' chmod
 * (8.32 on the CI runner) has no `-h`, so on Linux the lock left a write-only file writable and the
 * release left a locked one unwritable: there the mode changes through a handle opened without
 * following links (write-only, or Linux's `O_PATH` for a mode-0 file, through `/proc/self/fd`).
 */
describe("a file its owner cannot read is locked and released on Linux without chmod -h", () => {
  /** Linux's O_PATH, which Node does not export. */
  const LINUX_O_PATH = 0o10000000;
  const lockBits = (mode: number) => mode & ~0o222;
  const releaseBits = (mode: number) => mode | 0o200;

  /** A Linux file system that records what is asked of it; `opens` answers each open in turn. */
  function linuxIo(opens: Array<{ fd: number; mode: number; file?: boolean } | { code: string }>) {
    const seen = {
      opened: [] as number[],
      handleModes: [] as number[],
      pathModes: [] as Array<{ file: string; mode: number }>,
      execs: [] as string[][],
      closed: 0,
    };
    const io: ChmodUnreadableIo & { open(file: string, flags: number): Promise<unknown> } = {
      platform: "linux",
      lstat: async () => ({ isFile: () => true, mode: 0o100200 }),
      chmod: async (file, mode) => void seen.pathModes.push({ file, mode }),
      execFile: async (file, args) => void seen.execs.push([file, ...args]),
      open: async (_file, flags) => {
        seen.opened.push(flags);
        const answer = opens.shift();
        if (!answer) throw new Error("unexpected open");
        if ("code" in answer) throw Object.assign(new Error(answer.code), { code: answer.code });
        return {
          fd: answer.fd,
          stat: async () => ({ isFile: () => answer.file ?? true, mode: answer.mode }),
          chmod: async (mode: number) => void seen.handleModes.push(mode),
          close: async () => void seen.closed++,
        };
      },
    };
    return { io, seen };
  }

  it("locks a write-only file through a write-only handle that follows no link, never chmod -h", async () => {
    const { io, seen } = linuxIo([{ fd: 7, mode: 0o100200 }]);
    await chmodUnreadable("/work/index.html", lockBits, io);
    assert.deepEqual(seen.execs, [], "no chmod -h, which GNU chmod does not have");
    assert.equal(seen.opened.length, 1);
    const [flags = 0] = seen.opened;
    for (const [name, bit] of Object.entries({
      O_WRONLY: fsConstants.O_WRONLY,
      O_NONBLOCK: fsConstants.O_NONBLOCK,
      O_NOFOLLOW: fsConstants.O_NOFOLLOW,
    }))
      if (typeof bit === "number") assert.equal(flags & bit, bit, `opened with ${name}`);
    for (const [name, bit] of Object.entries({ O_TRUNC: fsConstants.O_TRUNC, O_CREAT: fsConstants.O_CREAT }))
      assert.equal(flags & bit, 0, `never with ${name}`);
    assert.deepEqual(seen.handleModes, [0o000], "the write bit goes, through the handle");
    assert.equal(seen.closed, 1);
  });

  it("releases a mode-0 file through an O_PATH handle and /proc/self/fd, never chmod -h", async () => {
    const { io, seen } = linuxIo([{ code: "EACCES" }, { fd: 9, mode: 0o100000 }]);
    await chmodUnreadable("/work/index.html", releaseBits, io);
    assert.deepEqual(seen.execs, []);
    assert.equal(seen.opened[1], LINUX_O_PATH | fsConstants.O_NOFOLLOW, "a path handle that follows no link");
    assert.deepEqual(seen.pathModes, [{ file: "/proc/self/fd/9", mode: 0o200 }]);
    assert.equal(seen.closed, 1);
  });

  it("changes nothing that is not a regular file once opened", async () => {
    const { io, seen } = linuxIo([{ fd: 7, mode: 0o010200, file: false }]);
    await chmodUnreadable("/work/index.html", lockBits, io);
    assert.deepEqual(seen.handleModes, []);
    assert.deepEqual(seen.pathModes, []);
    assert.deepEqual(seen.execs, []);
  });

  // The first open is the real one: a link, a FIFO or a folder at the name never reaches its
  // target, never blocks, and nothing is changed or run.
  const hostile: Array<{ name: string; plant(at: string, outside: string): Promise<void> }> = [
    { name: "a link to an outside write-only file", plant: (at, outside) => symlink(outside, at) },
    {
      name: "a FIFO",
      plant: async (at) => {
        execFileSync("/usr/bin/mkfifo", [at]);
        await chmod(at, 0o200);
      },
    },
    { name: "a folder", plant: (at) => mkdir(at, { mode: 0o300 }) },
    { name: "a dangling link", plant: (at) => symlink(path.join(path.dirname(at), "gone"), at) },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name} without following it`, { skip: WINDOWS && "Windows has no write-only files" }, async () => {
      const root = await tmpDir("locks-linux-hostile-");
      const outside = path.join(root, "outside");
      await writeFile(outside, "secret");
      await chmod(outside, 0o200);
      const at = path.join(root, "work", "index.html");
      await mkdir(path.dirname(at));
      await row.plant(at, outside);
      const before = (await lstat(at)).mode;
      const execs: string[][] = [];
      const io = {
        platform: "linux" as const,
        lstat: (file: string) => lstat(file),
        chmod: (file: string, mode: number) => chmod(file, mode),
        execFile: async (file: string, args: readonly string[]) => void execs.push([file, ...args]),
        open: (file: string, flags: number) => open(file, flags),
      };
      await chmodUnreadable(at, lockBits, io).catch(() => {});
      assert.equal((await stat(outside)).mode & 0o7777, 0o200, "the outside file keeps its mode");
      assert.equal((await lstat(at)).mode, before, "the planted entry keeps its mode");
      assert.deepEqual(execs, [], "nothing was run");
      await chmod(outside, 0o600);
    });
  }
});

/** M4: a FIFO opened for reading blocks until a writer comes, and holds a threadpool thread meanwhile. */
describe("a FIFO the contractor planted never stalls the studio", { skip: WINDOWS && "Windows has no FIFOs" }, () => {
  const within = <T>(promise: Promise<T>, ms = 1_000) =>
    Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms).unref())]);
  /** Let any reader still blocked on these FIFOs go, so a red run cannot hang the file. */
  const release = (fifos: string[]) => {
    for (const fifo of fifos) {
      try {
        closeSync(openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
      } catch {
        /* no reader waiting */
      }
    }
  };

  it("the bridge answers the requests around FIFOs in req/, and refuses the FIFOs", async () => {
    const cwd = await tmpDir("bridge-fifo-");
    const calls: string[] = [];
    const bridge = await openBridge(cwd, calls);
    const fifos = ["a1", "a2", "a3", "a4", "a5", "a6"].map((name) => path.join(bridge.dir, "req", `${name}.json`));
    try {
      for (const fifo of fifos) execFileSync("/usr/bin/mkfifo", [fifo]);
      await writeFile(path.join(bridge.dir, "req", "z.json"), JSON.stringify({ id: "z", name: "capture", args: {} }));
      const answered = await within(waitFor(async () => (calls.length ? true : undefined), 1_000));
      assert.equal(answered, true, "the real request was answered within a second");
      const refusals = await within(
        waitFor(async () => {
          const names = (await readdir(path.join(bridge.dir, "res"))).filter((name) => /^a\d\.json$/.test(name));
          return names.length === fifos.length ? names : undefined;
        }, 1_000),
      );
      assert.equal(Array.isArray(refusals), true, "every FIFO got a refusal, not a hang");
    } finally {
      release(fifos);
      await bridge.close();
    }
  });

  it("releaseStaleLocks with a FIFO for a marker resolves at once, and releases nothing", async () => {
    const cwd = await tmpDir("locks-fifo-marker-");
    const marker = path.join(cwd, LOCK_MARKER);
    execFileSync("/usr/bin/mkfifo", [marker]);
    try {
      assert.equal(await within(releaseStaleLocks(cwd)), false);
    } finally {
      release([marker]);
    }
  });

  it("lockUnowned walks past a FIFO in the workspace", async () => {
    const cwd = await tmpDir("locks-fifo-file-");
    await writeFile(path.join(cwd, "index.html"), "<!doctype html>");
    const fifo = path.join(cwd, "pipe.json");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    try {
      const record = await within(lockUnowned(cwd, { facetId: "enemies", owns: ["src/enemies.js"], ownsMain: false }));
      assert.notEqual(record, "timed out");
      if (record !== "timed out") await within(releaseLocks(cwd, record));
    } finally {
      release([fifo]);
    }
  });
});

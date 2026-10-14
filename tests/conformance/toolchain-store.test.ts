/**
 * The toolchain store (`src/substrate/toolchain-store/`): pinned installs from https only, archives
 * listed and refused before anything is written, staged swaps that roll back, the prewarm's
 * sandbox overlay, pruning by lock, and locating a lock's paths. No row touches the network: a
 * fetch stub serves hand-built archives, and the "required when present" rows serve the
 * developer's cached downloads from disk (`tests/helpers/dev-toolchains.ts`).
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  link as hardLink,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { crc32, gzipSync } from "node:zlib";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  ArchiveFormat,
  type ToolchainArchive,
  type ToolchainEntry,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainLock,
  ToolchainProblem,
  ToolchainUnhosted,
} from "../../src/shared/toolchain.ts";
import { ProcessSandbox, type RunRequest, type RunResult, shellQuote } from "../../src/substrate/spawn.ts";
import {
  ArchiveEntryType,
  extractArchive,
  listArchive,
  planExtraction,
  xzTarCommand,
} from "../../src/substrate/toolchain-store/archive.ts";
import {
  type InstallDeps,
  installComponents,
  installLocalArtifact,
  pruneStore,
  ReceiptSource,
  readReceipts,
  type ToolchainReceipt,
} from "../../src/substrate/toolchain-store/install.ts";
import { crossPrewarmDigest, locateToolchain, lockOutputs } from "../../src/substrate/toolchain-store/locate.ts";
import {
  isStoreLockFile,
  LOCKS_FOLDER,
  lockOf,
  readCurrentLock,
  referencedVersions,
  writeCurrentLock,
} from "../../src/substrate/toolchain-store/lock.ts";
import {
  entryDigest,
  entrySha12,
  isDownloadable,
  isPinned,
  manifestEntry,
  TOOLCHAIN_MANIFEST,
} from "../../src/substrate/toolchain-store/manifest.ts";
import {
  PrewarmStep,
  prewarm,
  prewarmableFor,
  prewarmPolicy,
  prewarmSandboxOptions,
} from "../../src/substrate/toolchain-store/prewarm.ts";
import { layoutFor, prewarmDenyWrites, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { hostDownloadCache } from "../../src/substrate/toolchain-store/download-cache.ts";
import { canonicalJson } from "../../src/substrate/toolchain-store/genex-cmake.ts";
import {
  prewarmManifestFile,
  SeedError,
  SeedRefusal,
  seedPrewarm,
  writePrewarmManifest,
} from "../../src/substrate/toolchain-store/prewarm-seed.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX_ONLY = process.platform === "win32" ? { skip: "the store's sandbox rows are POSIX-only" } : {};
const MAC_ONLY = process.platform === "darwin" ? {} : { skip: "the cached ninja is a macOS binary" };

// ---------- hand-built archives ----------

const BLOCK = 512;

function octal(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, "0")}\0`;
}

/** One ustar header block with a correct checksum. */
function tarHeader(fields: { name: string; type: string; size?: number; linkname?: string; mode?: number }): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(fields.name, 0, 100, "utf8");
  block.write(octal(fields.mode ?? 0o644, 7), 100, "latin1");
  block.write(octal(0, 7), 108, "latin1");
  block.write(octal(0, 7), 116, "latin1");
  block.write(octal(fields.size ?? 0, 11), 124, "latin1");
  block.write(octal(0, 11), 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(fields.type, 156, "latin1");
  block.write(fields.linkname ?? "", 157, 100, "utf8");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
}

type TarPart = Buffer[];
const file = (name: string, body = "x", mode = 0o644): TarPart => {
  const data = Buffer.from(body);
  return [tarHeader({ name, type: "0", size: data.length, mode }), padded(data)];
};
const dir = (name: string): TarPart => [tarHeader({ name, type: "5", mode: 0o755 })];
const link = (name: string, target: string): TarPart => [tarHeader({ name, type: "2", linkname: target })];
const hardlink = (name: string, target: string): TarPart => [tarHeader({ name, type: "1", linkname: target })];
const special = (name: string, type: string): TarPart => [tarHeader({ name, type })];

/** A pax extended header (`x`) whose records apply to the part after it. */
function pax(records: Record<string, string>, then: TarPart): TarPart {
  const body = Object.entries(records)
    .map(([key, value]) => {
      const tail = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(tail) + 1;
      while (String(length).length + Buffer.byteLength(tail) > length) length++;
      return `${String(length)}${tail}`;
    })
    .join("");
  const data = Buffer.from(body);
  return [tarHeader({ name: "PaxHeader", type: "x", size: data.length }), padded(data), ...then];
}

/** A GNU long-name header (`L`) naming the part after it. */
function gnuLongName(name: string, then: TarPart): TarPart {
  const data = Buffer.from(`${name}\0`);
  return [tarHeader({ name: "././@LongLink", type: "L", size: data.length }), padded(data), ...then];
}

/** Zero padding after the end marker, well past any pipe's buffer. */
const PIPE_OVERFILL_BYTES = 1024 * 1024;
/** How long reading a tiny archive may take before the test calls it hung. */
const ARCHIVE_DEADLINE_MS = 10 * SECOND_MS;
const hasXz = (() => {
  try {
    execFileSync("xz", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** `data` compressed by the machine's `xz`, as a Linux `.tar.xz` download is. */
function xzCompress(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("xz", ["-zc"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    child.stdin?.end(data);
  });
}

/** `work`, or a failure once the archive deadline passes: a hang must fail, not stall the suite. */
async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      work,
      sleep(ARCHIVE_DEADLINE_MS, undefined, { signal: timer.signal }).then(() => {
        throw new Error(`archive read still running after ${ARCHIVE_DEADLINE_MS} ms`);
      }),
    ]);
  } finally {
    timer.abort();
  }
}

function tarGz(...parts: TarPart[]): Buffer {
  return gzipSync(Buffer.concat([...parts.flat(), Buffer.alloc(BLOCK * 2)]));
}

/** A stored (uncompressed) zip; `mode` lands in the Unix external attributes. */
function zip(files: Array<{ name: string; data: string; mode: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of files) {
    const name = Buffer.from(item.name);
    const data = Buffer.from(item.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((item.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

// ---------- entries, fetch and run fakes ----------

interface Served {
  url: string;
  body: Buffer;
  format?: ArchiveFormat;
  strip?: number;
  into?: string;
}

function archiveOf(served: Served): ToolchainArchive {
  return {
    url: served.url,
    bytes: served.body.length,
    sha256: sha256(served.body),
    format: served.format ?? ArchiveFormat.TarGz,
    strip: served.strip ?? 0,
    into: served.into ?? "",
  };
}

function entryOf(id: ToolchainId, version: string, ...served: Served[]): ToolchainEntry {
  return {
    id,
    version,
    host: ToolchainHost.MacArm64,
    target: null,
    archives: served.map(archiveOf),
    licence: "test",
  };
}

/** A fetch that serves `bodies` by URL and records every call. */
function servedFetch(...served: Served[]) {
  const calls: string[] = [];
  const bodies = new Map(served.map((item) => [item.url, item.body]));
  const fetch: InstallDeps["fetch"] = async (url) => {
    calls.push(url);
    const body = bodies.get(url);
    return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 });
  };
  return { fetch, calls };
}

function result(request: RunRequest, code: number | null, stdout = ""): RunResult {
  return {
    code,
    signal: code === null ? "SIGKILL" : null,
    stdout,
    stderr: code === 0 ? "" : "failed",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    sandboxed: true,
    command: request.command,
    cwd: request.cwd,
  };
}

/** A probe runner that answers each tool's `--version` with `stdout`, recording the requests. */
function probeRun(answer: (request: RunRequest) => { code: number | null; stdout: string }) {
  const requests: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    requests.push(request);
    const { code, stdout } = answer(request);
    return result(request, code, stdout);
  };
  return { run, requests };
}

function deps(overrides: Partial<InstallDeps> & Pick<InstallDeps, "fetch">): InstallDeps & { jobs: string[] } {
  const jobs: string[] = [];
  return {
    run: probeRun(() => ({ code: 0, stdout: "1.13.2\n" })).run,
    freeBytes: async () => 1024 ** 4,
    onJob: (job) => jobs.push(job.phase),
    now: () => Date.UTC(2026, 9, 1),
    ...overrides,
    jobs,
  };
}

// ---------- a store tree, snapshotted byte for byte ----------

async function snapshot(root: string): Promise<string[]> {
  if (!existsSync(root)) return ["<absent>"];
  const lines: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      const full = path.join(folder, name);
      const rel = path.relative(root, full);
      const info = await lstat(full);
      if (info.isSymbolicLink()) lines.push(`${rel} -> ${await readlink(full)}`);
      else if (info.isDirectory()) {
        lines.push(`${rel}/`);
        await walk(full);
      } else lines.push(`${rel} ${info.mode.toString(8)} ${sha256(await readFile(full))}`);
    }
  };
  await walk(root);
  return lines;
}

/** A store that already holds something: a marker and an installed component. */
async function seededStore(): Promise<{ root: string; store: string; outside: string }> {
  const root = await tmpDir("toolchain-store-");
  const store = path.join(root, "store");
  const outside = path.join(root, "outside");
  await mkdir(path.join(store, "cmake", "4.4.3-aaaaaaaaaaaa"), { recursive: true });
  await writeFile(path.join(store, "cmake", "4.4.3-aaaaaaaaaaaa", "receipt.json"), "{}\n");
  await writeFile(path.join(store, "marker.txt"), "keep me\n");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "user-file.txt"), "not the store's business\n");
  return { root, store, outside };
}

// ---------- preflight ----------

describe("installing: refused before any fetch", () => {
  it("an http:// URL is refused with not-https and nothing is written", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const body = tarGz(file("ninja", "#!/bin/sh\n", 0o755));
    const served = { url: "http://example.test/ninja.tar.gz", body };
    const { fetch, calls } = servedFetch(served);
    const job = await installComponents(store, [entryOf(ToolchainId.Ninja, "1.13.2", served)], deps({ fetch }));
    assert.equal(job.phase, ToolchainInstallPhase.Failed);
    assert.equal(job.problem, ToolchainProblem.NotHttps);
    assert.deepEqual(calls, [], "nothing was fetched");
    assert.deepEqual(await snapshot(store), before, "the store is byte-identical");
  });

  it("an unpinned entry is refused with unpinned before any fetch", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const served = { url: "https://example.test/ninja.tar.gz", body: tarGz(file("ninja")) };
    const { fetch, calls } = servedFetch(served);
    const entry = entryOf(ToolchainId.Ninja, "1.13.2", served);
    const unpinned: ToolchainEntry = { ...entry, archives: [{ ...entry.archives[0], sha256: null }] };
    const job = await installComponents(store, [unpinned], deps({ fetch }));
    assert.equal(job.problem, ToolchainProblem.Unpinned);
    assert.deepEqual(calls, [], "the fetch stub is never called");
    assert.deepEqual(await snapshot(store), before);
  });

  it("an unpinned entry anywhere in the job refuses the whole job before the pinned ones fetch", async () => {
    const { store } = await seededStore();
    const served = { url: "https://example.test/zig.tar.gz", body: tarGz(file("zig")) };
    const pinned = entryOf(ToolchainId.Zig, "0.16.0", served);
    const unpinned = TOOLCHAIN_MANIFEST.find((entry) => entry.archives.some((archive) => archive.sha256 === null));
    assert.ok(unpinned, "the manifest still carries an unpinned entry (Windows-hosted tools)");
    const { fetch, calls } = servedFetch(served);
    const job = await installComponents(store, [pinned, unpinned], deps({ fetch }));
    assert.equal(job.problem, ToolchainProblem.Unpinned);
    assert.deepEqual(calls, []);
  });

  it("too little free disk is refused with disk-space before any fetch", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const served = { url: "https://example.test/ninja.tar.gz", body: tarGz(file("ninja")) };
    const { fetch, calls } = servedFetch(served);
    const job = await installComponents(
      store,
      [entryOf(ToolchainId.Ninja, "1.13.2", served)],
      deps({ fetch, freeBytes: async () => 1024 }),
    );
    assert.equal(job.problem, ToolchainProblem.DiskSpace);
    assert.deepEqual(calls, []);
    assert.deepEqual(await snapshot(store), before);
  });
});

describe("installing: download integrity", () => {
  it("a sha256 mismatch removes the partial and reports integrity", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const pinnedBody = tarGz(file("ninja", "the pinned bytes"));
    const servedBody = tarGz(file("ninja", "different bytes!"));
    const entry = entryOf(ToolchainId.Ninja, "1.13.2", { url: "https://example.test/ninja.tar.gz", body: pinnedBody });
    const entryWithServedSize: ToolchainEntry = {
      ...entry,
      archives: [{ ...entry.archives[0], bytes: servedBody.length }],
    };
    const { fetch, calls } = servedFetch({ url: "https://example.test/ninja.tar.gz", body: servedBody });
    const job = await installComponents(store, [entryWithServedSize], deps({ fetch }));
    assert.equal(calls.length, 1);
    assert.equal(job.problem, ToolchainProblem.Integrity);
    assert.deepEqual(await snapshot(store), before, "no partial download or staging folder is left");
  });

  it("a failed HTTP answer reports download", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const entry = entryOf(ToolchainId.Ninja, "1.13.2", {
      url: "https://example.test/ninja.tar.gz",
      body: tarGz(file("ninja")),
    });
    const { fetch } = servedFetch();
    const job = await installComponents(store, [entry], deps({ fetch }));
    assert.equal(job.problem, ToolchainProblem.Download);
    assert.deepEqual(await snapshot(store), before);
  });

  it("a download that stops sending fails with download on the injected stall timer and leaves no partial", {
    timeout: 10_000,
  }, async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const served = ninja();
    const half = new Uint8Array(served.body.subarray(0, served.body.length >> 1));
    // The first half arrives, then the server keeps the connection open and sends nothing more.
    const fetch: InstallDeps["fetch"] = async () =>
      new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(half) }));
    const stalls: number[] = [];
    const schedule = (run: () => void, ms: number) => {
      stalls.push(ms);
      const timer = setImmediate(run);
      return () => clearImmediate(timer);
    };
    const job = await installComponents(
      store,
      [entryOf(ToolchainId.Ninja, "1.13.2", served)],
      deps({ fetch, schedule }),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Failed);
    assert.equal(job.problem, ToolchainProblem.Download);
    assert.ok(stalls.length >= 1 && stalls.every((ms) => ms === 60_000), `stall timers: ${stalls}`);
    assert.deepEqual(await snapshot(store), before, "no partial download or staging folder is left");
  });
});

// ---------- hostile archives ----------

const HOSTILE_TAR: Array<[string, Buffer]> = [
  ["an absolute path", tarGz(file("/tmp/genex-absolute-escape"))],
  ["a ../ path", tarGz(file("../x"))],
  ["a ../ inside the path", tarGz(dir("tool/"), file("tool/../../x"))],
  ["a symlink to /etc", tarGz(link("etc", "/etc"))],
  ["a relative symlink out of the root", tarGz(link("up", "../../../outside"))],
  ["a symlink, then an entry through it", tarGz(dir("sub/"), link("through", "sub"), file("through/x"))],
  ["a symlink out, then an entry through it", tarGz(link("esc", "../../../outside"), file("esc/pwned"))],
  ["a symlink chain that leaves through another link", tarGz(link("a", "."), link("b", "a/../../outside"))],
  ["a hard link out", tarGz(hardlink("passwd", "../../../outside/user-file.txt"))],
  ["an absolute hard link", tarGz(hardlink("passwd", "/etc/passwd"))],
  ["a hard link to a symlink", tarGz(link("l", "x"), file("x"), hardlink("h", "l"))],
  ["a char device", tarGz(special("tty", "3"))],
  ["a block device", tarGz(special("disk", "4"))],
  ["a fifo", tarGz(special("pipe", "6"))],
  ["a 2000-byte name (pax)", tarGz(pax({ path: `${"n".repeat(1999)}x` }, file("short")))],
  ["a 2000-byte name (GNU long name)", tarGz(gnuLongName("g".repeat(2000), file("short")))],
  [
    "a 2000-byte symlink target (pax linkpath) that stays inside",
    tarGz(pax({ linkpath: `${"./".repeat(1000)}x` }, link("l", "x"))),
  ],
  ["a pax path that climbs out of a harmless ustar name", tarGz(pax({ path: "../escape.txt" }, file("ok.txt")))],
  [
    "a GNU long link name out of the root",
    tarGz([
      tarHeader({ name: "././@LongLink", type: "K", size: 16 }),
      padded(Buffer.from("/etc/master.pwd\0")),
      ...link("l", "ok"),
    ]),
  ],
  ["the same path twice as a dir and a symlink", tarGz(dir("d/"), link("d", "."))],
  [
    "a corrupt header checksum",
    gzipSync(Buffer.concat([Buffer.from(file("x")[0]).fill(7, 148, 150), Buffer.alloc(BLOCK * 3)])),
  ],
];

const HOSTILE_ZIP: Array<[string, Buffer]> = [
  ["a zip with ../", zip([{ name: "../evil", data: "x", mode: 0o100644 }])],
  ["a zip with an absolute name", zip([{ name: "/tmp/genex-zip-escape", data: "x", mode: 0o100644 }])],
  ["a zip symlink entry out of the root", zip([{ name: "etc", data: "/etc", mode: 0o120777 }])],
  ["a zip fifo entry", zip([{ name: "pipe", data: "", mode: 0o010644 }])],
];

describe("installing: a hostile archive is refused with archive and writes nothing", () => {
  const cases = [
    ...HOSTILE_TAR.map(([label, body]) => ({ label, body, format: ArchiveFormat.TarGz })),
    ...HOSTILE_ZIP.map(([label, body]) => ({ label, body, format: ArchiveFormat.Zip })),
  ];
  for (const { label, body, format } of cases) {
    it(label, async () => {
      const { root, store, outside } = await seededStore();
      const before = await snapshot(store);
      const beforeOutside = await snapshot(outside);
      const served = { url: `https://example.test/hostile.${format}`, body, format };
      const { fetch } = servedFetch(served);
      const probe = probeRun(() => ({ code: 0, stdout: "1.13.2" }));
      const job = await installComponents(
        store,
        [entryOf(ToolchainId.Ninja, "1.13.2", served)],
        deps({ fetch, run: probe.run }),
      );
      assert.equal(job.phase, ToolchainInstallPhase.Failed);
      assert.equal(job.problem, ToolchainProblem.Archive);
      assert.deepEqual(probe.requests, [], "nothing from a refused archive is ever run");
      assert.deepEqual(await snapshot(store), before, "the store tree is byte-identical");
      assert.deepEqual(await snapshot(outside), beforeOutside, "nothing outside the store changed");
      assert.equal(existsSync("/tmp/genex-absolute-escape"), false);
      assert.equal(existsSync("/tmp/genex-zip-escape"), false);
      assert.equal(existsSync(path.join(root, "escape.txt")), false);
    });
  }

  it("listing a hostile archive refuses through planExtraction with a typed archive error", async () => {
    const root = await tmpDir("toolchain-plan-");
    const archive = path.join(root, "hostile.tar.gz");
    await writeFile(archive, tarGz(link("etc", "/etc")));
    const entries = await listArchive(archive, ArchiveFormat.TarGz);
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.type, entry.linkTarget]),
      [["etc", ArchiveEntryType.Symlink, "/etc"]],
    );
    assert.throws(
      () => planExtraction(entries, { strip: 0, into: "" }),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Archive,
    );
  });

  it("in-root relative symlinks, pax names and GNU long names are accepted", async () => {
    const root = await tmpDir("toolchain-plan-");
    const archive = path.join(root, "good.tar.gz");
    const long = `deep/${"d".repeat(150)}/file.txt`;
    await writeFile(
      archive,
      tarGz(
        dir("pkg/"),
        dir("pkg/Versions/"),
        dir("pkg/Versions/A/"),
        file("pkg/Versions/A/lib", "lib"),
        link("pkg/Versions/Current", "A"),
        link("pkg/lib", "Versions/Current/lib"),
        pax({ path: `pkg/${long}` }, file("placeholder")),
        gnuLongName(`pkg/gnu/${"g".repeat(120)}`, file("placeholder2")),
      ),
    );
    const entries = await listArchive(archive, ArchiveFormat.TarGz);
    const planned = planExtraction(entries, { strip: 1, into: "install" });
    assert.deepEqual(
      planned.map((item) => item.path),
      [
        "install/Versions",
        "install/Versions/A",
        "install/Versions/A/lib",
        "install/Versions/Current",
        "install/lib",
        `install/${long}`,
        `install/gnu/${"g".repeat(120)}`,
      ],
    );
  });

  it("the .tar.xz reader is platform-branched and never parses tar -tv text", () => {
    assert.deepEqual(xzTarCommand("darwin", "/a b/z.tar.xz"), {
      file: "/usr/bin/tar",
      args: ["-cf", "-", "--format", "pax", "@/a b/z.tar.xz"],
    });
    assert.deepEqual(xzTarCommand("linux", "/a b/z.tar.xz"), { file: "xz", args: ["-dc", "/a b/z.tar.xz"] });
  });

  it("Linux reads and extracts a .tar.xz whose records pad far past its end marker", {
    skip: hasXz ? false : "xz is not on PATH",
  }, async () => {
    // GNU tar pads to whole records; emsdk's archive leaves `xz -dc` writing after the marker,
    // and a reader that stops there must still end the decoder and its pipe.
    const root = await tmpDir("toolchain-xz-");
    const archive = path.join(root, "padded.tar.xz");
    const tar = Buffer.concat([...file("pkg/one.txt", "hello"), Buffer.alloc(PIPE_OVERFILL_BYTES)]);
    await writeFile(archive, await xzCompress(tar));
    const read = { platform: "linux" };
    const entries = await withinDeadline(listArchive(archive, ArchiveFormat.TarXz, read));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["pkg/one.txt"],
    );
    const dest = path.join(root, "out");
    await withinDeadline(extractArchive(archive, ArchiveFormat.TarXz, dest, { strip: 1, into: "", ...read }));
    assert.equal(await readFile(path.join(dest, "one.txt"), "utf8"), "hello");
  });
});

describe("planning: link targets", () => {
  it("a symlink target is held to the name limit before extraction, in tar as in zip", async () => {
    const root = await tmpDir("toolchain-plan-");
    const archive = path.join(root, "long-link.tar.gz");
    await writeFile(archive, tarGz(pax({ linkpath: `${"./".repeat(1000)}x` }, link("l", "x")), file("x")));
    const entries = await listArchive(archive, ArchiveFormat.TarGz);
    assert.equal(Buffer.byteLength(entries[0]?.linkTarget ?? ""), 2001, "the pax linkpath is read whole");
    assert.throws(
      () => planExtraction(entries, { strip: 0, into: "" }),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Archive,
    );
  });
});

// ---------- names one filesystem folds together ----------

/** One archive entry, written as a tar or a zip: a name ending in `/` is a folder, `link` makes a symlink. */
type FoldEntry = { name: string; link?: string };

function foldTar(entries: readonly FoldEntry[]): Buffer {
  return tarGz(
    ...entries.map((entry) => {
      if (entry.name.endsWith("/")) return dir(entry.name);
      return entry.link === undefined ? file(entry.name, "escaped\n") : link(entry.name, entry.link);
    }),
  );
}

function foldZip(entries: readonly FoldEntry[]): Buffer {
  return zip(
    entries.map((entry) => {
      if (entry.name.endsWith("/")) return { name: entry.name, data: "", mode: 0o040755 };
      if (entry.link === undefined) return { name: entry.name, data: "escaped\n", mode: 0o100644 };
      return { name: entry.name, data: entry.link, mode: 0o120777 };
    }),
  );
}

/**
 * Archives whose names differ only in case or Unicode normalization. APFS and NTFS resolve both
 * spellings to one file, so a check that compares bytes misses the link the kernel follows. The
 * extraction root is `<root>/store/.staging/x`; three `..` above it is `<root>`, beside `outside/`.
 */
const FOLDED_NAMES: Array<[string, FoldEntry[]]> = [
  [
    "a case-variant link chain that climbs above the root, and a file through it",
    [
      { name: "d/" },
      { name: "d/e/" },
      { name: "d/e/b", link: "../.." },
      { name: "c", link: "D/E/B/../../.." },
      { name: "C/outside/pwned.txt" },
    ],
  ],
  ["a case-variant name through an in-root link", [{ name: "d/" }, { name: "l", link: "d" }, { name: "L/x.txt" }]],
  [
    "an NFD spelling through an NFC link chain that climbs above the root",
    [
      { name: "é/" },
      { name: "é/e/" },
      { name: "é/e/b", link: "../.." },
      { name: "ç", link: "é/e/b/../../.." },
      { name: "ç/outside/pwned.txt" },
    ],
  ],
];

describe("extracting: names a filesystem folds together never write outside the root", () => {
  const cases = FOLDED_NAMES.flatMap(([label, entries]) => [
    { label: `${label} (tar)`, body: foldTar(entries), format: ArchiveFormat.TarGz },
    { label: `${label} (zip)`, body: foldZip(entries), format: ArchiveFormat.Zip },
  ]);

  async function foldCase(body: Buffer, format: ArchiveFormat) {
    const { root, outside } = await seededStore();
    const dest = path.join(root, "store", ".staging", "x");
    await mkdir(dest, { recursive: true });
    const archive = path.join(root, `folded.${format}`);
    await writeFile(archive, body);
    const outsideDest = async () => (await snapshot(root)).filter((line) => !line.startsWith("store/.staging/x/"));
    return { dest, archive, outside, before: await outsideDest(), outsideDest };
  }

  for (const { label, body, format } of cases) {
    it(`${label}: refused before writing where names fold (darwin, win32)`, async () => {
      const { dest, archive, before, outsideDest } = await foldCase(body, format);
      for (const platform of ["darwin", "win32"]) {
        await assert.rejects(
          () => extractArchive(archive, format, dest, { strip: 0, into: "", platform }),
          (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Archive,
          platform,
        );
        assert.deepEqual(await readdir(dest), [], `${platform}: nothing was written`);
      }
      assert.deepEqual(await outsideDest(), before);
    });

    it(`${label}: writes nothing outside the root on this computer's filesystem, folding or not`, async () => {
      const { dest, archive, outside, before, outsideDest } = await foldCase(body, format);
      const outsideBefore = await snapshot(outside);
      await extractArchive(archive, format, dest, { strip: 0, into: "", platform: "linux" }).catch((error: unknown) => {
        assert.ok(error instanceof ToolchainError && error.problem === ToolchainProblem.Archive, String(error));
      });
      assert.deepEqual(await snapshot(outside), outsideBefore, "nothing landed in outside/");
      assert.deepEqual(await outsideDest(), before, "nothing changed beside the extraction root");
    });
  }
});

// ---------- staged swap, rollback, cancel ----------

const ninja = (text = "#!/bin/sh\necho 1.13.2\n") => ({
  url: "https://example.test/ninja-mac.zip",
  body: zip([{ name: "ninja", data: text, mode: 0o100755 }]),
  format: ArchiveFormat.Zip,
});

describe("installing: staged, probed, swapped", () => {
  it("swaps the probed folder in whole and writes its receipt", async () => {
    const { store } = await seededStore();
    const served = ninja();
    const entry = entryOf(ToolchainId.Ninja, "1.13.2", served);
    const final = path.join(store, "ninja", `1.13.2-${entrySha12(entry)}`);
    const seen: boolean[] = [];
    const probe = probeRun(() => {
      seen.push(existsSync(final));
      return { code: 0, stdout: "1.13.2\n" };
    });
    const { fetch } = servedFetch(served);
    const run = deps({ fetch, run: probe.run });
    const job = await installComponents(store, [entry], run);
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    assert.deepEqual(seen, [false], "the probe ran before the folder was swapped in");
    assert.match(probe.requests[0].command, /ninja' --version$/);
    assert.equal(
      probe.requests[0].policy,
      undefined,
      "a probe gets the sandbox's own policy: no network, no extra write",
    );
    assert.equal((await stat(path.join(final, "ninja"))).mode & 0o111, 0o111, "the executable bit survives");
    const receipt = JSON.parse(await readFile(path.join(final, "receipt.json"), "utf8")) as ToolchainReceipt;
    assert.deepEqual(receipt, {
      id: ToolchainId.Ninja,
      version: "1.13.2",
      sha256: entry.archives[0].sha256,
      sha12: entrySha12(entry),
      bytes: served.body.length,
      host: ToolchainHost.MacArm64,
      target: null,
      source: ReceiptSource.Archive,
      installedAt: new Date(Date.UTC(2026, 9, 1)).toISOString(),
    });
    assert.equal(existsSync(path.join(store, ".staging")), false, "no staging is left");
    assert.deepEqual(
      run.jobs.filter((phase, index, all) => all.indexOf(phase) === index),
      [
        ToolchainInstallPhase.Preflight,
        ToolchainInstallPhase.Downloading,
        ToolchainInstallPhase.Verifying,
        ToolchainInstallPhase.Extracting,
        ToolchainInstallPhase.Probing,
        ToolchainInstallPhase.Installed,
      ],
    );
    assert.deepEqual(
      (await readReceipts(store)).map((item) => `${item.id}/${item.version}-${item.sha12}`),
      [`ninja/1.13.2-${entrySha12(entry)}`],
      "a folder without a readable receipt (the seeded cmake one) is not installed",
    );
  });
});

describe("installing: idempotence and rollback", () => {
  it("an entry already installed is not fetched again", async () => {
    const { store } = await seededStore();
    const served = ninja();
    const entry = entryOf(ToolchainId.Ninja, "1.13.2", served);
    const first = servedFetch(served);
    await installComponents(store, [entry], deps({ fetch: first.fetch }));
    const second = servedFetch(served);
    const job = await installComponents(store, [entry], deps({ fetch: second.fetch }));
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(second.calls, []);
  });

  it("a probe failure rolls the whole job back", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const zig = { url: "https://example.test/zig.tar.gz", body: tarGz(file("zig", "#!/bin/sh\n", 0o755)) };
    const served = ninja();
    const probe = probeRun((request) =>
      request.command.includes("/ninja") ? { code: 1, stdout: "" } : { code: 0, stdout: "0.16.0\n" },
    );
    const { fetch } = servedFetch(served, zig);
    const job = await installComponents(
      store,
      [entryOf(ToolchainId.Zig, "0.16.0", zig), entryOf(ToolchainId.Ninja, "1.13.2", served)],
      deps({ fetch, run: probe.run }),
    );
    assert.equal(job.problem, ToolchainProblem.Probe);
    assert.equal(probe.requests.length, 2, "zig installed, then ninja's probe failed");
    assert.deepEqual(await snapshot(store), before, "zig, installed first in the same job, is gone again");
  });

  it("a probe whose output lacks the version fails", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const served = ninja();
    const { fetch } = servedFetch(served);
    const probe = probeRun(() => ({ code: 0, stdout: "1.12.0\n" }));
    const job = await installComponents(
      store,
      [entryOf(ToolchainId.Ninja, "1.13.2", served)],
      deps({ fetch, run: probe.run }),
    );
    assert.equal(job.problem, ToolchainProblem.Probe);
    assert.deepEqual(await snapshot(store), before);
  });
});

describe("installing: cancel", () => {
  it("cancelling during the probe leaves no staging folder and the store unchanged", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const served = ninja();
    const controller = new AbortController();
    const probe = probeRun(() => {
      controller.abort();
      return { code: null, stdout: "" };
    });
    const { fetch } = servedFetch(served);
    const job = await installComponents(
      store,
      [entryOf(ToolchainId.Ninja, "1.13.2", served)],
      deps({ fetch, run: probe.run, signal: controller.signal }),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Cancelled);
    assert.equal(job.problem, undefined);
    assert.equal(existsSync(path.join(store, ".staging")), false);
    assert.deepEqual(await snapshot(store), before);
  });

  it("cancelling during the download leaves no staging folder and the store unchanged", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const served = ninja();
    const controller = new AbortController();
    const fetch: InstallDeps["fetch"] = async (_url, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return new Response(new Uint8Array(served.body));
    };
    const job = await installComponents(
      store,
      [entryOf(ToolchainId.Ninja, "1.13.2", served)],
      deps({ fetch, signal: controller.signal }),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Cancelled);
    assert.deepEqual(await snapshot(store), before);
  });
});

// ---------- managed runtimes on a Linux host ----------

function linuxRuntimes(pythonTarget = "python3.13") {
  const source = manifestEntry(ToolchainId.Emsdk, ToolchainHost.LinuxX64);
  assert.ok(source);
  const bodies = [
    tarGz(file("emsdk/emcc.py", "compiler source")),
    tarGz(file("node-v24.19.0-linux-x64/bin/node", "managed node", 0o755)),
    tarGz(file("python/bin/python3.13", "managed python", 0o755), link("python/bin/python3", pythonTarget)),
  ];
  const served = source.archives.map((archive, index) => ({
    url: archive.url,
    body: bodies[index] ?? Buffer.alloc(0),
    format: ArchiveFormat.TarGz,
    strip: archive.strip,
    into: archive.into,
  }));
  return { entry: { ...source, archives: served.map(archiveOf) }, served };
}

describe("Linux emsdk installation", () => {
  it(
    "extracts and probes both managed runtimes, preserves links, and reuses the receipt without fetching",
    POSIX_ONLY,
    async () => {
      const { store } = await seededStore();
      const { entry, served } = linuxRuntimes();
      const fetched = servedFetch(...served);
      const requests: RunRequest[] = [];
      const run = async (request: RunRequest) => {
        requests.push(request);
        const python = request.command.endsWith("/python/bin/python3' --version");
        const relative = python ? "python/bin/python3" : "node/bin/node";
        assert.equal((await stat(path.join(request.cwd, relative))).isFile(), true, relative);
        return result(request, 0, python ? "Python 3.13.3\n" : "v24.19.0\n");
      };
      const job = await installComponents(store, [entry], deps({ fetch: fetched.fetch, run }));
      assert.equal(job.phase, ToolchainInstallPhase.Installed);
      assert.deepEqual(
        requests.map((request) => path.relative(request.cwd, request.command.split("'")[1] ?? "")),
        ["python/bin/python3", "node/bin/node"],
      );
      const folder = path.join(store, entry.id, `${entry.version}-${entrySha12(entry)}`);
      assert.equal(await readlink(path.join(folder, "python/bin/python3")), "python3.13");
      assert.equal(await readFile(path.join(folder, "python/bin/python3"), "utf8"), "managed python");
      const [receipt] = await readReceipts(store);
      assert.equal(receipt?.host, ToolchainHost.LinuxX64);
      assert.equal(receipt?.source, ReceiptSource.Archive);
      assert.equal(await readFile(path.join(store, "marker.txt"), "utf8"), "keep me\n");
      const repeated = servedFetch(...served);
      assert.equal(
        (await installComponents(store, [entry], deps({ fetch: repeated.fetch, run }))).phase,
        ToolchainInstallPhase.Installed,
      );
      assert.deepEqual(repeated.calls, []);
      assert.equal(requests.length, 2, "an installed runtime is not reprobed");
    },
  );

  for (const runtime of ["python", "node"]) {
    it(`refuses the wrong ${runtime} version and leaves retained components intact`, POSIX_ONLY, async () => {
      const { store } = await seededStore();
      const retained = ninja();
      await installComponents(
        store,
        [entryOf(ToolchainId.Ninja, "1.13.2", retained)],
        deps({ fetch: servedFetch(retained).fetch }),
      );
      const before = await snapshot(store);
      const { entry, served } = linuxRuntimes();
      const probe = probeRun((request) => {
        const python = request.command.includes("/python/bin/python3");
        const current = python ? "python" : "node";
        const version = python ? "Python 3.13.3" : "v24.19.0";
        return { code: 0, stdout: current === runtime ? "wrong version" : version };
      });
      const job = await installComponents(
        store,
        [entry],
        deps({ fetch: servedFetch(...served).fetch, run: probe.run }),
      );
      assert.equal(job.problem, ToolchainProblem.Probe);
      assert.deepEqual(await snapshot(store), before);
    });
  }

  it("refuses a Python archive link outside its runtime root before any probe", POSIX_ONLY, async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const { entry, served } = linuxRuntimes("../../../outside/user-file.txt");
    const probe = probeRun(() => ({ code: 0, stdout: "Python 3.13.3" }));
    const job = await installComponents(store, [entry], deps({ fetch: servedFetch(...served).fetch, run: probe.run }));
    assert.equal(job.problem, ToolchainProblem.Archive);
    assert.deepEqual(probe.requests, []);
    assert.deepEqual(await snapshot(store), before);
  });
});

// ---------- locks and pruning ----------

describe("locks", () => {
  it("equal entries give one digest whatever their key order, and the file round-trips", async () => {
    const a = lockOf({
      cmake: { version: "4.4.3", sha12: "0c5d65251c14" },
      ninja: { version: "1.13.2", sha12: "c99048673aa7" },
    });
    const b = lockOf({
      ninja: { sha12: "c99048673aa7", version: "1.13.2" },
      cmake: { sha12: "0c5d65251c14", version: "4.4.3" },
    });
    assert.equal(a.digest, b.digest);
    assert.match(a.digest, /^[0-9a-f]{64}$/);
    const store = await tmpDir("toolchain-lock-");
    assert.equal(await readCurrentLock(store), null, "no lock before the first install");
    await writeCurrentLock(store, a);
    assert.deepEqual(await readCurrentLock(store), a);
  });

  const TAMPERED: Array<[string, unknown]> = [
    ["garbage", "not json"],
    [
      "a digest that does not match its entries",
      { version: 1, entries: { cmake: { version: "4.4.3", sha12: "0c5d65251c14" } }, digest: "0".repeat(64) },
    ],
    ["an unknown component", { ...lockOf({}), entries: { unity: { version: "6", sha12: "0c5d65251c14" } } }],
    ["a version that climbs out", lockWith({ cmake: { version: "../../etc", sha12: "0c5d65251c14" } })],
    ["a sha12 that is not hex", lockWith({ cmake: { version: "4.4.3", sha12: "../../../../" } })],
    ["schema 2", { ...lockOf({}), version: 2 }],
  ];
  for (const [label, content] of TAMPERED) {
    it(`reads ${label} as no lock`, async () => {
      const store = await tmpDir("toolchain-lock-");
      await writeFile(
        path.join(store, "current-lock.json"),
        typeof content === "string" ? content : JSON.stringify(content),
      );
      assert.equal(await readCurrentLock(store), null);
    });
  }

  it("names every component folder and lock folder a lock references", () => {
    const lock = lockOf({
      cmake: { version: "4.4.3", sha12: "0c5d65251c14" },
      emsdk: { version: "6.0.10", sha12: "abcdefabcdef" },
    });
    assert.deepEqual(
      [...referencedVersions([lock])].sort(),
      ["cmake/4.4.3-0c5d65251c14", "emsdk/6.0.10-abcdefabcdef", `locks/${lock.digest.slice(0, 12)}`].sort(),
    );
  });
});

/** A lock with a digest computed over entries lockOf would never accept, as a game's studio.json might carry. */
function lockWith(entries: Record<string, { version: string; sha12: string }>): ToolchainLock {
  const canonical = (value: unknown): string =>
    value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
  return { version: 1, entries: entries as ToolchainLock["entries"], digest: sha256(Buffer.from(canonical(entries))) };
}

describe("pruning", () => {
  it("keeps every version and lock folder a lock references and removes the rest", async () => {
    const store = await tmpDir("toolchain-prune-");
    const kept = lockOf({
      cmake: { version: "4.4.3", sha12: "aaaaaaaaaaaa" },
      ninja: { version: "1.13.2", sha12: "bbbbbbbbbbbb" },
    });
    const receipt = (id: ToolchainId, version: string, sha12: string) =>
      JSON.stringify({
        id,
        version,
        sha256: sha12.padEnd(64, "0"),
        sha12,
        bytes: 1,
        host: null,
        target: null,
        source: ReceiptSource.Archive,
        installedAt: "x",
      });
    const install = async (id: ToolchainId, version: string, sha12: string) => {
      const folder = path.join(store, id, `${version}-${sha12}`);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "receipt.json"), receipt(id, version, sha12));
      await writeFile(path.join(folder, "payload"), "x".repeat(1000));
    };
    await install(ToolchainId.Cmake, "4.4.3", "aaaaaaaaaaaa");
    await install(ToolchainId.Cmake, "4.4.2", "cccccccccccc");
    await install(ToolchainId.Ninja, "1.13.2", "bbbbbbbbbbbb");
    await mkdir(path.join(store, "locks", kept.digest.slice(0, 12)), { recursive: true });
    await mkdir(path.join(store, "locks", "dddddddddddd"), { recursive: true });
    await writeFile(path.join(store, "locks", "dddddddddddd", "prewarm.json"), "{}");
    await writeCurrentLock(store, kept);
    const removed = await pruneStore(store, referencedVersions([kept]));
    assert.equal(removed.removed, 2);
    assert.ok(removed.bytes >= 1000, `bytes freed: ${removed.bytes}`);
    assert.equal(existsSync(path.join(store, "cmake", "4.4.3-aaaaaaaaaaaa")), true);
    assert.equal(existsSync(path.join(store, "ninja", "1.13.2-bbbbbbbbbbbb")), true);
    assert.equal(existsSync(path.join(store, "locks", kept.digest.slice(0, 12))), true);
    assert.equal(existsSync(path.join(store, "cmake", "4.4.2-cccccccccccc")), false);
    assert.equal(existsSync(path.join(store, "locks", "dddddddddddd")), false);
    assert.deepEqual(await readCurrentLock(store), kept, "current-lock.json is never pruned");
  });
});

// ---------- a fake store in the product's layout, for locate and prewarm ----------

const FAKE_VERSIONS = {
  [ToolchainId.Cmake]: "4.4.3",
  [ToolchainId.Ninja]: "1.13.2",
  [ToolchainId.Emsdk]: "6.0.10",
  [ToolchainId.RaylibSource]: "6.0",
} as const;
const FAKE_FILES: Record<keyof typeof FAKE_VERSIONS, string[]> = {
  [ToolchainId.Cmake]: ["CMake.app/Contents/bin/cmake"],
  [ToolchainId.Ninja]: ["ninja"],
  [ToolchainId.Emsdk]: [
    "install/emscripten/emcc",
    "install/emscripten/cmake/Modules/Platform/Emscripten.cmake",
    "install/emscripten/cache/sysroot/include/stdio.h",
    "install/bin/clang",
    "python/python-3.13.3-0/bin/python3",
    "node/bin/node",
  ],
  [ToolchainId.RaylibSource]: ["CMakeLists.txt", "src/raylib.h", "src/rlgl.h", "src/raymath.h"],
};

async function fakeStore(): Promise<{ root: string; store: string; lock: ToolchainLock }> {
  const root = await tmpDir("toolchain-fake-store-");
  const store = path.join(root, "store");
  const entries: ToolchainLock["entries"] = {};
  for (const [id, version] of Object.entries(FAKE_VERSIONS) as Array<[keyof typeof FAKE_VERSIONS, string]>) {
    const sha12 = sha256(Buffer.from(id)).slice(0, 12);
    const folder = path.join(store, id, `${version}-${sha12}`);
    for (const rel of FAKE_FILES[id]) {
      await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
      await writeFile(path.join(folder, rel), "#!/bin/sh\n", { mode: 0o755 });
    }
    const receipt: ToolchainReceipt = {
      id,
      version,
      sha256: sha256(Buffer.from(id)),
      sha12,
      bytes: 1,
      host: id === ToolchainId.RaylibSource ? null : ToolchainHost.MacArm64,
      target: null,
      source: ReceiptSource.Archive,
      installedAt: "2026-10-01T00:00:00.000Z",
    };
    await writeFile(path.join(folder, "receipt.json"), JSON.stringify(receipt));
    entries[id] = { version, sha12 };
  }
  return { root, store, lock: lockOf(entries) };
}

/** A prewarm runner that plays each step's part in the staging folder, or fails `failAt`. */
function prewarmRun(options: { failAt?: PrewarmStep; skipOutputs?: boolean } = {}) {
  const requests: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    requests.push(request);
    if (request.label === options.failAt) return result(request, 2);
    const staging = request.policy?.allowWrite?.[0] ?? "";
    if (request.label === PrewarmStep.CloneCache)
      await mkdir(path.join(staging, "em-cache", "sysroot"), { recursive: true });
    if (request.label === PrewarmStep.RaylibInstall && !options.skipOutputs) {
      const out = path.join(staging, "raylib-web-es3");
      await mkdir(path.join(out, "lib"), { recursive: true });
      await mkdir(path.join(out, "include"), { recursive: true });
      await writeFile(path.join(out, "lib", "libraylib.a"), "!<arch>\n");
      for (const header of ["raylib.h", "rlgl.h", "raymath.h"])
        await writeFile(path.join(out, "include", header), "//");
    }
    return result(request, 0);
  };
  return { run, requests };
}

const guard = (root: string) => ({
  games: path.join(root, "games"),
  scratch: path.join(root, "scratch"),
  runs: path.join(root, "runs"),
});

/** A prewarm run request writes staging only, denies every folder it must, has no network and keeps TMPDIR in staging. */
function assertOverlay(request: RunRequest, real: string, staging: string, deny: ReturnType<typeof guard>): void {
  assert.deepEqual(request.policy?.allowWrite, [staging], `${request.label} writes staging only`);
  const denied = request.policy?.denyWrite ?? [];
  const wanted = [
    deny.games,
    deny.scratch,
    deny.runs,
    ...Object.values(ToolchainId).map((id) => path.join(real, id)),
    path.join(real, "locks"),
    path.join(real, "current-lock.json"),
  ];
  for (const folder of wanted) assert.ok(denied.includes(folder), `${request.label} denies ${folder}`);
  assert.ok(!denied.some((folder) => staging.startsWith(folder)), "nothing denied covers the staging folder");
  assert.deepEqual(request.policy?.allowedDomains ?? [], [], "no network");
  const tmp = `'${staging}/.tmp'`;
  assert.ok(request.command.startsWith(`export TMPDIR=${tmp} TMP=${tmp} TEMP=${tmp};`), request.command);
}

/** An emcc-running request carries its own cache, config and Python, no sanity check and no bytecode. */
function assertEmscriptenEnv(request: RunRequest, staging: string): void {
  assert.equal(request.env?.EM_CACHE, path.join(staging, "em-cache"));
  assert.equal(request.env?.EM_CONFIG, path.join(staging, "emscripten.config"));
  assert.equal(request.env?.EMCC_SKIP_SANITY_CHECK, "1");
  assert.equal(request.env?.PYTHONDONTWRITEBYTECODE, "1");
  assert.match(
    request.env?.EMSDK_PYTHON ?? "",
    /\/emsdk\/6\.0\.10-[0-9a-f]{12}\/python\/python-3\.13\.3-0\/bin\/python3$/,
  );
}

describe("prewarm: the sandbox overlay", () => {
  it("every run request allows writing only .staging/<lock>, denies games, scratch, runs and the store, and keeps TMPDIR inside staging", async () => {
    const { root, store, lock } = await fakeStore();
    const deny = guard(root);
    const { run, requests } = prewarmRun();
    await prewarm(store, lock, [BuildTarget.Web], { run, denyWrite: [deny.games, deny.scratch, deny.runs] });
    const real = await realpath(store);
    const staging = path.join(real, ".staging", lock.digest);
    assert.deepEqual(
      requests.map((request) => request.label),
      [
        PrewarmStep.CloneCache,
        PrewarmStep.RaylibConfigure,
        PrewarmStep.RaylibBuild,
        PrewarmStep.RaylibInstall,
        PrewarmStep.WarmCache,
      ],
    );
    for (const request of requests) assertOverlay(request, real, staging, deny);
    for (const request of requests.filter((item) => item.label !== PrewarmStep.CloneCache))
      assertEmscriptenEnv(request, staging);
    const configure = requests.find((request) => request.label === PrewarmStep.RaylibConfigure)?.command ?? "";
    const flags = [
      "-DPLATFORM=Web",
      "-DOPENGL_VERSION=ES 3.0",
      "-DBUILD_EXAMPLES=OFF",
      "-DCUSTOMIZE_BUILD=ON",
      "-DSUPPORT_FILEFORMAT_JPG=ON",
      "-DSUPPORT_SCREEN_CAPTURE=OFF",
      "-DSUPPORT_CUSTOM_FRAME_CONTROL=OFF",
      "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
    ];
    for (const flag of flags) assert.ok(configure.includes(shellQuote(flag)), `configure carries ${flag}`);
    assert.ok(configure.includes(`${shellQuote("-G")} ${shellQuote("Ninja")}`));
    assert.ok(
      !/embuilder|--use-port|-sUSE_(?!GLFW=3)/.test(requests.map((request) => request.command).join("\n")),
      "no port is ever fetched",
    );
  });
});

describe("prewarm: nothing a step started outlives it", () => {
  it("every step's run request reaps its process group once the command exits", async () => {
    const { store, lock } = await fakeStore();
    const { run, requests } = prewarmRun();
    await prewarm(store, lock, [BuildTarget.Web], { run, denyWrite: [] });
    assert.ok(requests.length > 0);
    assert.deepEqual(
      requests.map((request) => [request.label, request.reapGroup]),
      requests.map((request) => [request.label, true]),
    );
  });
});

describe("prewarm: swap and failure", () => {
  it("swaps a checked lock folder in whole, which then locates", async () => {
    const { store, lock } = await fakeStore();
    const { run } = prewarmRun();
    const record = await prewarm(store, lock, [BuildTarget.Web], {
      run,
      denyWrite: [],
      now: () => Date.UTC(2026, 9, 1),
    });
    const real = await realpath(store);
    const folder = path.join(real, "locks", lock.digest.slice(0, 12));
    assert.equal(record.lock, lock.digest);
    assert.match(record.recipe, /^[0-9a-f]{12}$/);
    assert.deepEqual(record.outputs, [
      "em-cache",
      "emscripten.config",
      "genex-web.cmake",
      "raylib-web-es3/include/raylib.h",
      "raylib-web-es3/include/raymath.h",
      "raylib-web-es3/include/rlgl.h",
      "raylib-web-es3/lib/libraylib.a",
    ]);
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, "prewarm.json"), "utf8")), record);
    assert.deepEqual((await readdir(folder)).sort(), [
      "em-cache",
      "emscripten.config",
      "genex-web.cmake",
      "prewarm.json",
      "raylib-web-es3",
    ]);
    const cmake = await readFile(path.join(folder, "genex-web.cmake"), "utf8");
    assert.ok(
      cmake.includes(path.join(folder, "raylib-web-es3", "lib", "libraylib.a")),
      "genex.cmake names the swapped-in prebuild",
    );
    assert.ok(!cmake.includes(".staging"), "and never the staging folder");
    assert.equal(existsSync(path.join(real, ".staging")), false);
    const located = await locateToolchain(store, lock, [BuildTarget.Web]);
    assert.ok(located.ok, JSON.stringify(located));
    assert.equal(located.toolchain.genexCmake[BuildTarget.Web], path.join(folder, "genex-web.cmake"));
    assert.equal(located.toolchain.emscripten?.config, path.join(folder, "emscripten.config"));
    assert.equal(located.toolchain.emscripten?.cache, path.join(folder, "em-cache"));
  });

  const FAILURES: Array<[string, Parameters<typeof prewarmRun>[0]]> = [
    ["the raylib build fails", { failAt: PrewarmStep.RaylibBuild }],
    ["the cache clone fails", { failAt: PrewarmStep.CloneCache }],
    ["the warm link fails", { failAt: PrewarmStep.WarmCache }],
    ["every step passes but the prebuild is missing", { skipOutputs: true }],
  ];
  for (const [label, options] of FAILURES) {
    it(`leaves the store unchanged when ${label}`, async () => {
      const { store, lock } = await fakeStore();
      const before = await snapshot(store);
      const { run } = prewarmRun(options);
      await assert.rejects(
        () => prewarm(store, lock, [BuildTarget.Web], { run, denyWrite: [] }),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
      );
      assert.deepEqual(await snapshot(store), before);
    });
  }
});

describe("prewarm: the policy", () => {
  it("a caller's deny that holds the store (a dev store inside the checkout) never denies the staging folder", async () => {
    const { root, store, lock } = await fakeStore();
    const staging = path.join(store, ".staging", lock.digest);
    const games = path.join(root, "games");
    const policy = prewarmPolicy(store, lock.digest, [root, games]);
    assert.deepEqual(policy.allowWrite, [staging]);
    const covering = (policy.denyWrite ?? []).filter((deny) => isInside(deny, staging));
    assert.deepEqual(covering, [], "a deny beats the staging allow beneath it");
    const denied = [
      games,
      path.join(store, LOCKS_FOLDER),
      ...Object.values(ToolchainId).map((id) => path.join(store, id)),
    ];
    for (const folder of denied) assert.ok(policy.denyWrite?.includes(folder), `${folder} is still denied`);
  });
});

describe("prewarm: the real sandbox", () => {
  it("a prewarm command under the real sandbox writes staging and nothing else", POSIX_ONLY, async () => {
    const { root, store, lock } = await fakeStore();
    const deny = guard(root);
    for (const folder of Object.values(deny)) await mkdir(folder, { recursive: true });
    const real = await realpath(store);
    const staging = path.join(real, ".staging", lock.digest);
    await mkdir(path.join(staging, ".tmp"), { recursive: true });
    const cmakeDir = path.join(real, ToolchainId.Cmake);
    const sandbox = await ProcessSandbox.create({
      writableRoots: [deny.games, deny.runs],
      scratchDir: deny.scratch,
      secretPaths: [],
    });
    after(() => sandbox.dispose());
    const policy = prewarmPolicy(real, lock.digest, [deny.games, deny.scratch, deny.runs]);
    const q = (value: string) => `'${value}'`;
    const outcome = await sandbox.run({
      command: [
        `export TMPDIR=${q(path.join(staging, ".tmp"))};`,
        `echo ok > "$TMPDIR/probe" && echo staging-ok;`,
        `echo x > ${q(path.join(cmakeDir, "evil"))} && echo store-written;`,
        `echo x > ${q(path.join(real, "current-lock.json"))} && echo lock-written;`,
        `echo x > ${q(path.join(deny.games, "evil"))} && echo games-written;`,
        `echo x > ${q(path.join(deny.scratch, "evil"))} && echo scratch-written;`,
        "true",
      ].join(" "),
      cwd: staging,
      policy,
    });
    assert.equal(outcome.sandboxed, true);
    assert.deepEqual(outcome.stdout.trim().split("\n"), ["staging-ok"], outcome.stderr);
    assert.equal(existsSync(path.join(staging, ".tmp", "probe")), true);
    for (const escaped of [
      path.join(cmakeDir, "evil"),
      path.join(real, "current-lock.json"),
      path.join(deny.games, "evil"),
      path.join(deny.scratch, "evil"),
    ])
      assert.equal(existsSync(escaped), false, `${escaped} was not written`);
  });

  it(
    "on its own sandbox, prewarm writes staging and none of the folders the core's shared sandbox may write",
    POSIX_ONLY,
    async () => {
      const { root, store, lock } = await fakeStore();
      const real = await realpath(store);
      const staging = path.join(real, ".staging", lock.digest);
      await mkdir(path.join(staging, ".tmp"), { recursive: true });
      // What the core's shared sandbox holds writable besides the games root: workspaces, exports and a game kept elsewhere.
      const shared = ["workspaces", "exports", "elsewhere-game"].map((name) => path.join(root, name));
      for (const folder of shared) await mkdir(folder, { recursive: true });
      const scratch = path.join(root, "prewarm-scratch");
      const sandbox = await ProcessSandbox.create(prewarmSandboxOptions(scratch, []));
      after(() => sandbox.dispose());
      const q = (value: string) => `'${value}'`;
      const outcome = await sandbox.run({
        command: [
          `echo ok > ${q(path.join(staging, ".tmp", "probe"))} && echo staging-ok;`,
          ...shared.map(
            (folder) => `echo x > ${q(path.join(folder, "evil"))} && echo ${path.basename(folder)}-written;`,
          ),
          `echo x > ${q(path.join(real, "evil"))} && echo store-written;`,
          "true",
        ].join(" "),
        cwd: staging,
        policy: prewarmPolicy(real, lock.digest, [scratch]),
      });
      assert.equal(outcome.sandboxed, true);
      assert.deepEqual(outcome.stdout.trim().split("\n"), ["staging-ok"], outcome.stderr);
      for (const folder of shared)
        assert.equal(existsSync(path.join(folder, "evil")), false, `${folder} was not written`);
      assert.equal(existsSync(path.join(real, "evil")), false, "the store beside staging was not written");
    },
  );
});

// ---------- locate ----------

describe("locate", () => {
  it("never throws for an absent store and reports every component missing", async () => {
    const lock = lockOf({ cmake: { version: "4.4.3", sha12: "0c5d65251c14" } });
    assert.deepEqual(await locateToolchain(path.join(await tmpDir("none-"), "absent"), lock, [BuildTarget.Web]), {
      ok: false,
      missing: [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource],
    });
  });

  it("reports missing for a component the store does not hold at the lock's version", async () => {
    const { store, lock } = await fakeStore();
    await rm(path.join(store, ToolchainId.Ninja), { recursive: true });
    const located = await locateToolchain(store, lock, [BuildTarget.Web]);
    assert.deepEqual(located, { ok: false, missing: [ToolchainId.Ninja] });
  });

  it("reports a lock that was never prewarmed as needing a prewarm", async () => {
    const { store, lock } = await fakeStore();
    const located = await locateToolchain(store, lock, [BuildTarget.Web]);
    assert.equal(located.ok, false);
    assert.equal(!located.ok && located.needsPrewarm, true);
  });

  it("answers realpath'd paths through a symlinked store", async () => {
    const { root, store, lock } = await fakeStore();
    await prewarm(store, lock, [BuildTarget.Web], { run: prewarmRun().run, denyWrite: [] });
    const alias = path.join(root, "alias");
    await symlink(store, alias);
    const located = await locateToolchain(alias, lock, [BuildTarget.Web]);
    assert.ok(located.ok);
    const real = await realpath(store);
    const cmakeSha = lock.entries.cmake?.sha12 ?? "";
    assert.equal(
      located.toolchain.cmake,
      path.join(real, "cmake", `4.4.3-${cmakeSha}`, "CMake.app", "Contents", "bin", "cmake"),
    );
    assert.ok(located.toolchain.ninja.startsWith(`${real}${path.sep}ninja${path.sep}`));
    assert.equal(
      located.toolchain.emscripten?.toolchainFile,
      path.join(
        real,
        "emsdk",
        `6.0.10-${lock.entries.emsdk?.sha12}`,
        "install",
        "emscripten",
        "cmake",
        "Modules",
        "Platform",
        "Emscripten.cmake",
      ),
    );
    assert.equal(
      located.toolchain.emscripten?.python,
      path.join(real, "emsdk", `6.0.10-${lock.entries.emsdk?.sha12}`, "python", "python-3.13.3-0", "bin", "python3"),
    );
    assert.equal(
      located.toolchain.emscripten?.node,
      path.join(real, "emsdk", `6.0.10-${lock.entries.emsdk?.sha12}`, "node", "bin", "node"),
    );
    assert.equal(located.toolchain.raylibSource, path.join(real, "raylib", `6.0-${lock.entries.raylib?.sha12}`));
  });

  const HOSTILE_LOCKS: Array<[string, ToolchainLock]> = [
    ["a version that climbs out of the store", lockWith({ cmake: { version: "../../../etc", sha12: "0c5d65251c14" } })],
    ["a sha12 with a slash", lockWith({ cmake: { version: "4.4.3", sha12: "../../passwd" } })],
    ["an absolute version", lockWith({ cmake: { version: "/etc", sha12: "0c5d65251c14" } })],
    ["a digest that climbs out", { ...lockOf({}), digest: "../../../../../../../../../../../../etc/passwd" }],
  ];
  for (const [label, lock] of HOSTILE_LOCKS) {
    it(`treats a lock with ${label} as missing, reading nothing outside`, async () => {
      const { store } = await fakeStore();
      const located = await locateToolchain(store, lock, [BuildTarget.Web]);
      assert.equal(located.ok, false);
    });
  }
});

describe("locate: a lock, its entries and its prewarm agree", () => {
  it("refuses a lock whose digest belongs to other entries, even when both halves are installed and prewarmed", async () => {
    const { store, lock } = await fakeStore();
    await prewarm(store, lock, [BuildTarget.Web], { run: prewarmRun().run, denyWrite: [] });
    // An older CMake the store still holds, which a game's studio.json may name beside the current digest.
    const older = { version: "4.4.2", sha12: "0123456789ab" };
    const olderFolder = path.join(store, ToolchainId.Cmake, `${older.version}-${older.sha12}`);
    await mkdir(path.join(olderFolder, "CMake.app", "Contents", "bin"), { recursive: true });
    await writeFile(path.join(olderFolder, "CMake.app", "Contents", "bin", "cmake"), "#!/bin/sh\n", { mode: 0o755 });
    const receipt = {
      ...JSON.parse(
        await readFile(
          path.join(store, ToolchainId.Cmake, `4.4.3-${lock.entries.cmake?.sha12}`, "receipt.json"),
          "utf8",
        ),
      ),
      ...older,
    };
    await writeFile(path.join(olderFolder, "receipt.json"), JSON.stringify(receipt));
    const mixed: ToolchainLock = { ...lock, entries: { ...lock.entries, cmake: older } };
    assert.ok(
      (await locateToolchain(store, lockOf(mixed.entries), [BuildTarget.Web])).ok === false,
      "its own lock is not prewarmed",
    );
    assert.deepEqual(await locateToolchain(store, mixed, [BuildTarget.Web]), {
      ok: false,
      missing: [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource],
    });
  });

  const STALE_PREWARM: Array<[string, (record: Record<string, unknown>) => string]> = [
    [
      "names another recipe (an app update changed recipe.json)",
      (record) => JSON.stringify({ ...record, recipe: "000000000000" }),
    ],
    ["names another lock", (record) => JSON.stringify({ ...record, lock: "0".repeat(64) })],
    ["does not parse", () => "{"],
  ];
  for (const [label, rewrite] of STALE_PREWARM) {
    it(`needs a prewarm again when the lock folder's prewarm.json ${label}`, async () => {
      const { store, lock } = await fakeStore();
      await prewarm(store, lock, [BuildTarget.Web], { run: prewarmRun().run, denyWrite: [] });
      assert.ok((await locateToolchain(store, lock, [BuildTarget.Web])).ok, "prewarmed, it locates");
      const record = path.join(store, "locks", lock.digest.slice(0, 12), "prewarm.json");
      await writeFile(record, rewrite(JSON.parse(await readFile(record, "utf8"))));
      assert.deepEqual(await locateToolchain(store, lock, [BuildTarget.Web]), {
        ok: false,
        missing: [ToolchainId.Emsdk, ToolchainId.RaylibSource],
        needsPrewarm: true,
      });
    });
  }
});

// ---------- the manifest and the developer's cached downloads (required when present) ----------

interface Sum {
  sha256: string;
  name: string;
  bytes: number;
  url: string;
}

async function readSums(file: string): Promise<Sum[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, name, bytes, url] = line.split(/\s+/);
      return { sha256: sha, name, bytes: Number(bytes), url };
    });
}

function lookup(name: Parameters<typeof devTool>[0]): string {
  const found = devTool(name);
  if ("skip" in found) throw new Error(found.skip);
  return found.path;
}

describe("the manifest", () => {
  it("an entry's sha12 is its one digest's first 12 hex, or the sha256 of its digests joined by newlines", () => {
    const ninja = manifestEntry(ToolchainId.Ninja, ToolchainHost.MacArm64);
    assert.ok(ninja);
    assert.equal(entrySha12(ninja), "c99048673aa7");
    const emsdk = manifestEntry(ToolchainId.Emsdk, ToolchainHost.MacArm64);
    assert.ok(emsdk);
    assert.deepEqual(
      emsdk.archives.map((archive) => archive.into),
      ["install", "node", "python"],
    );
    const joined = emsdk.archives.map((archive) => archive.sha256).join("\n");
    assert.equal(entrySha12(emsdk), sha256(Buffer.from(joined)).slice(0, 12));
  });

  it("raylib source and bundled artifacts are installable, and Windows-hosted tools stay unpinned", () => {
    const unpinned = (id: ToolchainId, host: ToolchainHost) =>
      manifestEntry(id, host)?.archives.some((archive) => archive.sha256 === null);
    const raylib = manifestEntry(ToolchainId.RaylibSource, ToolchainHost.MacArm64);
    assert.ok(raylib && isPinned(raylib) && isDownloadable(raylib), "raylib's source installs from its tag archive");
    assert.equal(entrySha12(raylib), "2b3ee1e2120c");
    for (const id of [
      ToolchainId.AngleMac,
      ToolchainId.AngleWindows,
      ToolchainId.AngleLinux,
      ToolchainId.LinuxSysroot,
    ]) {
      const angle = manifestEntry(id, ToolchainHost.MacArm64);
      assert.ok(angle?.local, `${id} is a pinned artifact`);
      assert.deepEqual(angle.archives, [], `${id} has no archive and so no URL`);
      assert.equal(isPinned(angle), true, `${id} is pinned by its manifest.json`);
      // ANGLE and Linux's headers are bundled, independently of any published URL.
      const bundled = true;
      assert.equal(
        isDownloadable(angle),
        bundled,
        `${id} ${bundled ? "installs" : "never installs"} from the app's resources`,
      );
      assert.equal(angle.local.reason, ToolchainUnhosted.NotPublished);
      assert.equal(entrySha12(angle), angle.local.manifestSha256.slice(0, 12));
    }
    // Flipped (decision T1): no raylib-windows-x64 or raylib-linux-x64 entry; prewarm builds those prebuilds.
    for (const entry of TOOLCHAIN_MANIFEST) assert.doesNotMatch(entry.id, /^raylib-(windows|linux)/);
    assert.equal(
      unpinned(ToolchainId.Zig, ToolchainHost.LinuxX64),
      false,
      "zig linux-x64 was downloaded and is pinned",
    );
    assert.equal(unpinned(ToolchainId.Cmake, ToolchainHost.WindowsX64), true);
    for (const entry of TOOLCHAIN_MANIFEST)
      for (const archive of entry.archives) assert.match(archive.url, /^https:\/\//, `${entry.id} ${entry.host}`);
  });

  for (const id of [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.Zig])
    it(`${id} is pinned and installable on a Linux host`, () => {
      const entry = manifestEntry(id, ToolchainHost.LinuxX64);
      assert.ok(entry);
      assert.equal(isPinned(entry), true);
      assert.equal(isDownloadable(entry), true);
      assert.match(entryDigest(entry), /^[0-9a-f]{64}$/);
    });

  it("Linux emsdk carries its own Node and Python, and refuses a missing managed part", () => {
    const linux = manifestEntry(ToolchainId.Emsdk, ToolchainHost.LinuxX64);
    assert.ok(linux);
    assert.deepEqual(linux.archives.map((archive) => archive.into).sort(), ["install", "node", "python"]);
    for (const into of ["install", "node", "python"]) {
      const incomplete: ToolchainEntry = {
        ...linux,
        archives: linux.archives.filter((archive) => archive.into !== into),
      };
      assert.equal(isPinned(incomplete), false, `no system fallback for ${into}`);
      assert.throws(
        () => entryDigest(incomplete),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Unpinned,
      );
    }
  });

  it(
    "every downloaded archive's SHA256SUMS digest equals its manifest entry",
    needsTools("sha256sums", "downloads"),
    async () => {
      // SHA256SUMS also records the files of ANGLE's CI artifacts (`angle-*/<commit>/<file>`): those
      // are not archives in downloads/. Host-specific archives need not be cached on this machine.
      const downloads = lookup("downloads");
      const sums = (await readSums(lookup("sha256sums"))).filter((sum) => existsSync(path.join(downloads, sum.name)));
      assert.ok(sums.length > 0, "the cache has recorded downloads to compare");
      const pinned = TOOLCHAIN_MANIFEST.flatMap((entry) => entry.archives).filter((archive) => archive.sha256 !== null);
      for (const sum of sums) {
        const archive = pinned.find((item) => item.url === sum.url);
        assert.ok(archive, `${sum.name} is pinned in the manifest`);
        assert.equal(archive.sha256, sum.sha256, sum.name);
        assert.equal(archive.bytes, sum.bytes, sum.name);
      }
    },
  );
});

/** A fetch backed by the developer's downloads/ folder, keyed by SHA256SUMS' URLs. */
async function cachedFetch(): Promise<InstallDeps["fetch"]> {
  const sums = await readSums(lookup("sha256sums"));
  const downloads = lookup("downloads");
  return async (url) => {
    const sum = sums.find((item) => item.url === url);
    if (!sum) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(await readFile(path.join(downloads, sum.name))));
  };
}

describe("the developer's cached archives (required when present)", () => {
  it("the real ninja zip installs from a file-backed fetch and probes under the real sandbox", {
    ...needsTools("downloads", "sha256sums"),
    ...MAC_ONLY,
  }, async () => {
    const root = await tmpDir("toolchain-real-ninja-");
    const store = path.join(root, "store");
    const sandbox = await ProcessSandbox.create({
      writableRoots: [],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
    });
    after(() => sandbox.dispose());
    const entry = manifestEntry(ToolchainId.Ninja, ToolchainHost.MacArm64);
    assert.ok(entry);
    const probes: RunResult[] = [];
    const job = await installComponents(store, [entry], {
      fetch: await cachedFetch(),
      run: async (request) => {
        const outcome = await sandbox.run(request);
        probes.push(outcome);
        return outcome;
      },
      freeBytes: async () => 1024 ** 4,
      onJob: () => {},
    });
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    assert.equal(probes[0]?.sandboxed, true);
    assert.equal(probes[0]?.stdout.trim(), "1.13.2");
    const receipts = await readReceipts(store);
    assert.deepEqual(
      receipts.map((receipt) => [receipt.id, receipt.version, receipt.sha12, receipt.source]),
      [[ToolchainId.Ninja, "1.13.2", "c99048673aa7", ReceiptSource.Archive]],
    );
  });

  const REAL: Array<[string, ToolchainId, ToolchainHost, number]> = [
    ["cmake-4.4.3-macos-universal.tar.gz", ToolchainId.Cmake, ToolchainHost.MacArm64, 0],
    ["zig-aarch64-macos-0.16.0.tar.xz", ToolchainId.Zig, ToolchainHost.MacArm64, 0],
    ["python-3.13.3-0-macos-arm64.tar.gz", ToolchainId.Emsdk, ToolchainHost.MacArm64, 2],
    ["raylib-6.0.tar.gz", ToolchainId.RaylibSource, ToolchainHost.MacArm64, 0],
  ];
  for (const [name, id, host, index] of REAL) {
    it(
      `${name} lists with the pure-TS reader, refuses nothing and counts what tar -tf counts`,
      needsTools("downloads"),
      async () => {
        const archivePath = path.join(lookup("downloads"), name);
        const archive = manifestEntry(id, host)?.archives[index];
        assert.ok(archive);
        const entries = await listArchive(archivePath, archive.format);
        const planned = planExtraction(entries, { strip: archive.strip, into: archive.into });
        const { stdout } = await execFileAsync("tar", ["-tf", archivePath], { maxBuffer: 256 * 1024 ** 2 });
        assert.equal(entries.length, stdout.split("\n").filter(Boolean).length);
        assert.ok(planned.length > 0);
        if (id === ToolchainId.Cmake) {
          const links = entries.filter((entry) => entry.type === ArchiveEntryType.Symlink);
          assert.ok(links.length > 0, "CMake.app's framework links are there");
          assert.ok(
            links.every((entry) => !entry.linkTarget?.startsWith("/")),
            "and every one is relative",
          );
        }
      },
    );
  }
});

// ---------- the Windows and Linux destinations (wave 5, decisions T1 and T2) ----------

/** What each component of a Mac-hosted store that builds Windows and Linux holds, faked. */
const CROSS_FAKE = {
  [ToolchainId.Cmake]: { version: "4.4.3", files: ["CMake.app/Contents/bin/cmake"], host: ToolchainHost.MacArm64 },
  [ToolchainId.Ninja]: { version: "1.13.2", files: ["ninja"], host: ToolchainHost.MacArm64 },
  [ToolchainId.RaylibSource]: {
    version: "6.0",
    files: ["CMakeLists.txt", "src/raylib.h", "src/rlgl.h", "src/raymath.h"],
    host: null,
  },
  [ToolchainId.Zig]: { version: "0.16.0", files: ["zig", "lib/std/std.zig"], host: ToolchainHost.MacArm64 },
  [ToolchainId.AngleWindows]: {
    version: "c5bf49e78850",
    files: ["libEGL.dll", "libGLESv2.dll", "libEGL.dll.lib", "libGLESv2.dll.lib", "include/EGL/egl.h", "manifest.json"],
    host: null,
  },
  [ToolchainId.AngleLinux]: {
    version: "c5bf49e78850",
    files: ["libEGL.so", "libGLESv2.so", "include/EGL/egl.h", "manifest.json"],
    host: null,
  },
  [ToolchainId.LinuxSysroot]: {
    version: "almalinux-8.10",
    files: ["usr/include/X11/Xlib.h", "glfw-wayland/xdg-shell-client-protocol.h", "manifest.json"],
    host: null,
  },
} as const;
type CrossFakeId = keyof typeof CROSS_FAKE;
const CROSS_IDS = Object.keys(CROSS_FAKE) as CrossFakeId[];
/** The components a user's store can never download yet: Genex built them, published nothing. */
const LOCAL_ONLY: ReadonlySet<ToolchainId> = new Set([
  ToolchainId.AngleWindows,
  ToolchainId.AngleLinux,
  ToolchainId.LinuxSysroot,
]);
const CROSS_DESTINATIONS = [BuildTarget.Windows, BuildTarget.Linux] as const;

/** The digest a fake install of `id` is pinned by. */
const fakeDigest = (id: ToolchainId) => sha256(Buffer.from(`${id} pin`));

/** A realpath'd store holding `ids` in the product's layout, and the lock that names them. */
async function fakeCrossStore(ids: readonly CrossFakeId[] = CROSS_IDS) {
  const root = await realpath(await tmpDir("toolchain-cross-store-"));
  const store = path.join(root, "store");
  const entries: ToolchainLock["entries"] = {};
  const folders = new Map<ToolchainId, string>();
  for (const id of ids) {
    const { version, files, host } = CROSS_FAKE[id];
    const sha12 = fakeDigest(id).slice(0, 12);
    const folder = path.join(store, id, `${version}-${sha12}`);
    for (const rel of files) {
      await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
      await writeFile(path.join(folder, rel), "#!/bin/sh\n", { mode: 0o755 });
    }
    const receipt: ToolchainReceipt = {
      id,
      version,
      sha256: fakeDigest(id),
      sha12,
      bytes: 1,
      host,
      target: null,
      source: LOCAL_ONLY.has(id) ? ReceiptSource.LocalArtifact : ReceiptSource.Archive,
      installedAt: "2026-10-01T00:00:00.000Z",
    };
    await writeFile(path.join(folder, "receipt.json"), JSON.stringify(receipt));
    entries[id] = { version, sha12 };
    folders.set(id, folder);
  }
  return { root, store, lock: lockOf(entries), folders };
}

/** A cross prewarm runner: an install writes its variant's library and headers into staging; a Linux configure records its scanner. */
function crossPrewarmRun(options: { failAt?: PrewarmStep } = {}) {
  const requests: RunRequest[] = [];
  const scanners: Array<{ file: string; mode: number; text: string }> = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    requests.push(request);
    if (request.label === options.failAt) return result(request, 2);
    const staging = request.policy?.allowWrite?.[0] ?? "";
    const scanner = /'-DWAYLAND_SCANNER_EXECUTABLE=([^']+)'/.exec(request.command)?.[1];
    if (request.label === PrewarmStep.RaylibConfigure && scanner)
      scanners.push({ file: scanner, mode: (await stat(scanner)).mode, text: await readFile(scanner, "utf8") });
    // Like zig, the configure's compiler checks fill the global cache with the target's libc.
    const zigGlobal = request.env?.ZIG_GLOBAL_CACHE_DIR;
    if (request.label === PrewarmStep.RaylibConfigure && zigGlobal) {
      await mkdir(path.join(zigGlobal, "o"), { recursive: true });
      await writeFile(path.join(zigGlobal, "o", "libc.a"), "!<arch>\n");
    }
    const variant =
      request.label === PrewarmStep.RaylibInstall ? /\/(raylib-[a-z0-9-]+)\/lib'/.exec(request.command) : null;
    if (variant?.[1]) {
      const out = path.join(staging, variant[1]);
      await mkdir(path.join(out, "lib"), { recursive: true });
      await mkdir(path.join(out, "include"), { recursive: true });
      await writeFile(path.join(out, "lib", "libraylib.a"), `!<arch>\n${variant[1]}\n`);
      for (const header of ["raylib.h", "rlgl.h", "raymath.h"])
        await writeFile(path.join(out, "include", header), "//");
    }
    return result(request, 0);
  };
  return { run, requests, scanners };
}

const ON_A_MAC = "darwin" as const;

describe("cross destinations: which a computer and a lock prewarm", () => {
  it("names each cross destination's prewarm outputs: its toolchain file, its module, zig's cache and its raylib prebuild", () => {
    for (const [target, variant, cross] of [
      [BuildTarget.Windows, "raylib-windows-x64-es3-angle", "windows-x64"],
      [BuildTarget.Linux, "raylib-linux-x64-es3-angle", "linux-x64"],
    ] as const)
      assert.deepEqual(lockOutputs(target), [
        `genex-${target}.cmake`,
        `${variant}/include/raylib.h`,
        `${variant}/include/raymath.h`,
        `${variant}/include/rlgl.h`,
        `${variant}/lib/libraylib.a`,
        `toolchain-${cross}.cmake`,
        `zig-cache-${cross}`,
      ]);
  });

  it("prewarms only the destinations whose every component the lock names: zig and its ANGLE make Windows, no zig makes neither", () => {
    const pin = { version: "1", sha12: "aaaaaaaaaaaa" };
    const naming = (...ids: ToolchainId[]) => lockOf(Object.fromEntries(ids.map((id) => [id, pin])));
    const base: ToolchainId[] = [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.RaylibSource];
    const all = [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux];
    assert.deepEqual(prewarmableFor(naming(...base, ToolchainId.Zig, ToolchainId.AngleWindows), all), [
      BuildTarget.Windows,
    ]);
    assert.deepEqual(prewarmableFor(naming(...base, ToolchainId.AngleWindows, ToolchainId.AngleLinux), all), []);
    assert.deepEqual(
      prewarmableFor(naming(...base, ToolchainId.Emsdk, ToolchainId.AngleMac), all),
      [BuildTarget.Web, BuildTarget.Mac],
      "a lock without zig prewarms the web and the Mac exactly as before",
    );
    const everything = naming(
      ...base,
      ToolchainId.Emsdk,
      ToolchainId.AngleMac,
      ...CROSS_IDS.filter((id) => !base.includes(id)),
    );
    assert.deepEqual(prewarmableFor(everything, all), all);
    assert.deepEqual(
      prewarmableFor(everything, [BuildTarget.Web]),
      [BuildTarget.Web],
      "never one this computer does not prewarm",
    );
  });
});

/** A fake cross store prewarmed for Windows and Linux on a Mac, with what each run asked for. */
async function prewarmedCrossStore() {
  const made = await fakeCrossStore();
  const deny = guard(made.root);
  const runner = crossPrewarmRun();
  const record = await prewarm(made.store, made.lock, CROSS_DESTINATIONS, {
    run: runner.run,
    denyWrite: [deny.games, deny.scratch, deny.runs],
    platform: ON_A_MAC,
    now: () => Date.UTC(2026, 9, 1),
  });
  const staging = path.join(made.store, ".staging", made.lock.digest);
  const folder = path.join(made.store, "locks", made.lock.digest.slice(0, 12));
  return { ...made, ...runner, deny, record, staging, folder };
}

describe("cross destinations: the prewarm", () => {
  it("builds each raylib prebuild with zig under the overlay, its caches in staging, Linux through an executable scanner", async () => {
    const { store, requests, scanners, deny, staging, folders } = await prewarmedCrossStore();
    const steps = [PrewarmStep.RaylibConfigure, PrewarmStep.RaylibBuild, PrewarmStep.RaylibInstall];
    assert.deepEqual(
      requests.map((request) => request.label),
      [...steps, ...steps],
    );
    const caches = [...Array(3).fill("windows-x64"), ...Array(3).fill("linux-x64")];
    for (const [index, request] of requests.entries()) {
      assertOverlay(request, store, staging, deny);
      assert.equal(
        request.env?.ZIG_GLOBAL_CACHE_DIR,
        path.join(staging, `zig-cache-${caches[index]}`, "global"),
        "each destination's global cache in staging, kept as a lock output",
      );
      assert.equal(request.env?.ZIG_LOCAL_CACHE_DIR, path.join(staging, ".tmp", "zig"), "the local one goes with .tmp");
    }
    const [windows, linux] = requests.filter((request) => request.label === PrewarmStep.RaylibConfigure);
    for (const [request, name] of [
      [windows, "toolchain-windows-x64.cmake"],
      [linux, "toolchain-linux-x64.cmake"],
    ] as const) {
      assert.ok(request?.command.includes(shellQuote(`-DCMAKE_TOOLCHAIN_FILE=${path.join(staging, name)}`)), name);
      const rate = shellQuote("-DCMAKE_C_FLAGS=-ffp-contract=off -DAUDIO_DEVICE_SAMPLE_RATE=48000");
      assert.ok(request?.command.includes(rate), `${name}: raylib opens audio at the mixer rate`);
    }
    const sysroot = folders.get(ToolchainId.LinuxSysroot) ?? "";
    assert.equal(scanners.length, 1, "only Linux runs GLFW's wayland-scanner");
    assert.ok(
      scanners[0]?.file.startsWith(path.join(staging, ".build")),
      "the stand-in is written into the work folder",
    );
    assert.equal((scanners[0]?.mode ?? 0) & 0o111, 0o111, "and is executable when the configure runs");
    const protocols = shellQuote(path.join(sysroot, "glfw-wayland"));
    assert.ok(scanners[0]?.text.includes(protocols), "naming the sysroot's protocol code");
  });

  it("swaps in the toolchain files, modules and prebuilds, recording the cross digest", async () => {
    const { store, record, folder, folders } = await prewarmedCrossStore();
    assert.deepEqual(record.outputs, [...lockOutputs(BuildTarget.Windows), ...lockOutputs(BuildTarget.Linux)].sort());
    assert.equal(record.cross, crossPrewarmDigest(), "the record names the cross format and sysroot pin");
    assert.equal(record.platform, null, "no Mac, no headless platform file");
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, "prewarm.json"), "utf8")), record);
    const zig = path.join(folders.get(ToolchainId.Zig) ?? "", "zig");
    const sysroot = folders.get(ToolchainId.LinuxSysroot) ?? "";
    const windowsToolchain = await readFile(path.join(folder, "toolchain-windows-x64.cmake"), "utf8");
    assert.ok(windowsToolchain.includes(`set(CMAKE_C_COMPILER [=[${zig}]=] cc -target x86_64-windows-gnu)`));
    assert.ok(windowsToolchain.includes(`set(CMAKE_FIND_ROOT_PATH [=[${folder}]=])`), "rooted in the lock folder");
    const linuxToolchain = await readFile(path.join(folder, "toolchain-linux-x64.cmake"), "utf8");
    assert.ok(linuxToolchain.includes(`set(CMAKE_FIND_ROOT_PATH [=[${folder}]=] [=[${sysroot}]=])`), "and the sysroot");
    for (const [target, variant] of [
      [BuildTarget.Windows, "raylib-windows-x64-es3-angle"],
      [BuildTarget.Linux, "raylib-linux-x64-es3-angle"],
    ] as const) {
      const module = await readFile(path.join(folder, `genex-${target}.cmake`), "utf8");
      const prebuild = path.join(folder, variant, "lib", "libraylib.a");
      assert.ok(module.includes(prebuild), `${target} names its swapped-in prebuild`);
      assert.ok(!module.includes(".staging"), `${target} never names staging`);
    }
    assert.equal(existsSync(path.join(store, ".staging")), false);
  });

  it("locates the prewarmed lock with zig, each destination's toolchain file and ANGLE, and the Linux sysroot", async () => {
    const { store, lock, folder, folders } = await prewarmedCrossStore();
    const located = await locateToolchain(store, lock, CROSS_DESTINATIONS);
    assert.ok(located.ok, JSON.stringify(located));
    assert.equal(located.toolchain.zig, path.join(folders.get(ToolchainId.Zig) ?? "", "zig"));
    const angle = (id: ToolchainId) => ({ dir: folders.get(id), manifestSha256: fakeDigest(id) });
    assert.deepEqual(located.toolchain.cross, {
      [BuildTarget.Windows]: {
        toolchainFile: path.join(folder, "toolchain-windows-x64.cmake"),
        zigCache: path.join(folder, "zig-cache-windows-x64"),
        angle: angle(ToolchainId.AngleWindows),
      },
      [BuildTarget.Linux]: {
        toolchainFile: path.join(folder, "toolchain-linux-x64.cmake"),
        zigCache: path.join(folder, "zig-cache-linux-x64"),
        angle: angle(ToolchainId.AngleLinux),
        sysroot: folders.get(ToolchainId.LinuxSysroot),
        sysrootManifestSha256: fakeDigest(ToolchainId.LinuxSysroot),
      },
    });
    assert.equal(located.toolchain.genexCmake[BuildTarget.Windows], path.join(folder, "genex-windows.cmake"));
    assert.equal(located.toolchain.genexCmake[BuildTarget.Linux], path.join(folder, "genex-linux.cmake"));
    assert.equal(located.toolchain.angle, undefined, "no Mac ANGLE is named for a cross build");
  });

  it("reads as stale for a cross destination when its record names another cross format or sysroot pin", async () => {
    const { store, lock } = await fakeCrossStore();
    await prewarm(store, lock, CROSS_DESTINATIONS, { run: crossPrewarmRun().run, denyWrite: [], platform: ON_A_MAC });
    const file = path.join(store, "locks", lock.digest.slice(0, 12), "prewarm.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    const stale = {
      ok: false,
      missing: [ToolchainId.RaylibSource, ToolchainId.Zig, ToolchainId.AngleWindows],
      needsPrewarm: true,
    };
    for (const cross of ["000000000000", null, undefined]) {
      await writeFile(file, JSON.stringify({ ...record, cross }));
      assert.deepEqual(await locateToolchain(store, lock, [BuildTarget.Windows]), stale, String(cross));
    }
  });

  it("locates what each cross destination lacks: zig, its ANGLE or the Linux sysroot, and the Mac never names zig", async () => {
    const without = async (id: CrossFakeId, target: BuildTarget) => {
      const { store, lock } = await fakeCrossStore(CROSS_IDS.filter((item) => item !== id));
      return locateToolchain(store, lock, [target]);
    };
    assert.deepEqual(await without(ToolchainId.LinuxSysroot, BuildTarget.Linux), {
      ok: false,
      missing: [ToolchainId.LinuxSysroot],
    });
    assert.deepEqual(await without(ToolchainId.Zig, BuildTarget.Windows), { ok: false, missing: [ToolchainId.Zig] });
    assert.deepEqual(await without(ToolchainId.AngleLinux, BuildTarget.Linux), {
      ok: false,
      missing: [ToolchainId.AngleLinux],
    });
    const { store, lock } = await fakeCrossStore(CROSS_IDS.filter((id) => id !== ToolchainId.Zig));
    const mac = await locateToolchain(store, lock, [BuildTarget.Mac]);
    assert.deepEqual(mac, { ok: false, missing: [ToolchainId.AngleMac] }, "the Mac needs no zig");
  });

  it("refuses a Linux prebuild on a Windows host, and a cross destination the lock has no zig for, before any step", async () => {
    const rows = [
      { ids: CROSS_IDS, targets: [BuildTarget.Linux], platform: "win32", problem: ToolchainProblem.UnsupportedHost },
      {
        ids: CROSS_IDS.filter((id) => id !== ToolchainId.Zig),
        targets: [BuildTarget.Windows],
        platform: ON_A_MAC,
        problem: ToolchainProblem.Prewarm,
      },
    ] as const;
    for (const row of rows) {
      const { store, lock } = await fakeCrossStore(row.ids);
      const before = await snapshot(store);
      const { run, requests } = crossPrewarmRun();
      await assert.rejects(
        () => prewarm(store, lock, row.targets, { run, denyWrite: [], platform: row.platform }),
        (error: unknown) => error instanceof ToolchainError && error.problem === row.problem,
      );
      assert.deepEqual(requests, [], "nothing ran");
      assert.deepEqual(await snapshot(store), before);
    }
  });

  for (const failAt of [PrewarmStep.RaylibConfigure, PrewarmStep.RaylibBuild, PrewarmStep.RaylibInstall])
    it(`leaves the store unchanged when the cross ${failAt} step fails`, async () => {
      const { store, lock } = await fakeCrossStore();
      const before = await snapshot(store);
      await assert.rejects(
        () =>
          prewarm(store, lock, CROSS_DESTINATIONS, {
            run: crossPrewarmRun({ failAt }).run,
            denyWrite: [],
            platform: ON_A_MAC,
          }),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Prewarm,
      );
      assert.deepEqual(await snapshot(store), before);
    });
});

// ---------- the cross local artifacts: ANGLE for Windows and Linux, the Linux sysroot ----------

/** Each cross local artifact's folder, faked with the files its probe names. */
const CROSS_ARTIFACTS = [
  {
    id: ToolchainId.AngleWindows,
    target: BuildTarget.Windows,
    version: "c5bf49e78850",
    files: { "libEGL.dll": "egl dll", "libGLESv2.dll": "gles dll", "include/EGL/egl.h": "/* egl */" },
  },
  {
    id: ToolchainId.AngleLinux,
    target: BuildTarget.Linux,
    version: "c5bf49e78850",
    files: { "libEGL.so": "egl so", "libGLESv2.so": "gles so", "vk_swiftshader_icd.json": "{}" },
  },
  {
    id: ToolchainId.LinuxSysroot,
    target: BuildTarget.Linux,
    version: "almalinux-8.10",
    files: {
      "usr/include/X11/Xlib.h": "/* Xlib */",
      "usr/include/wayland-client.h": "/* wayland */",
      "usr/lib64/libX11.so": "elf",
      "glfw-wayland/xdg-shell-client-protocol.h": "/* xdg */",
    },
  },
] as const;
type CrossArtifact = (typeof CROSS_ARTIFACTS)[number];

/** A manifest.json listing `files` as the CI artifacts write it. */
function crossManifest(files: Record<string, string>): string {
  const listed = Object.fromEntries(
    Object.entries(files).map(([rel, text]) => [
      rel,
      { sha256: sha256(Buffer.from(text)), size: Buffer.byteLength(text) },
    ]),
  );
  return `${JSON.stringify({ schema: 1, files: listed }, null, 2)}\n`;
}

/** A store, the artifact's folder and the entry that pins its manifest. */
async function crossArtifact(artifact: CrossArtifact) {
  const root = await realpath(await tmpDir("toolchain-cross-artifact-"));
  const folder = path.join(root, "artifact");
  const store = path.join(root, "store");
  for (const [rel, text] of Object.entries(artifact.files)) {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), text);
  }
  const manifest = crossManifest(artifact.files);
  await writeFile(path.join(folder, "manifest.json"), manifest);
  await mkdir(store);
  await writeFile(path.join(store, "marker.txt"), "keep me\n");
  const entry: ToolchainEntry = {
    id: artifact.id,
    version: artifact.version,
    host: null,
    target: artifact.target,
    archives: [],
    licence: "test",
    local: {
      manifestSha256: sha256(Buffer.from(manifest)),
      manifestBytes: Buffer.byteLength(manifest),
      files: Object.keys(artifact.files).length,
      bytes: Object.values(artifact.files).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      reason: ToolchainUnhosted.NotPublished,
    },
  };
  return { store, folder, entry };
}

/** What a hostile copy of an artifact's folder does, and the typed problem it is refused with. */
const HOSTILE_ARTIFACT: Array<{
  name: string;
  problem: ToolchainProblem;
  plant: (folder: string, first: string) => Promise<void>;
}> = [
  {
    name: "a link inside the folder in place of a listed file",
    problem: ToolchainProblem.Archive,
    plant: async (folder, first) => {
      await rm(path.join(folder, first));
      await symlink("manifest.json", path.join(folder, first));
    },
  },
  {
    name: "a file manifest.json does not list",
    problem: ToolchainProblem.Archive,
    plant: (folder) => writeFile(path.join(folder, "extra.txt"), "not listed"),
  },
  {
    name: "a listed file of another size",
    problem: ToolchainProblem.Integrity,
    plant: (folder, first) => writeFile(path.join(folder, first), "a different length altogether"),
  },
  {
    name: "a listed file of the same size and another sha256",
    problem: ToolchainProblem.Integrity,
    plant: async (folder, first) => {
      const bytes = await readFile(path.join(folder, first));
      bytes[0] = (bytes[0] ?? 0) ^ 0x20;
      await writeFile(path.join(folder, first), bytes);
    },
  },
  {
    name: "manifest.json replaced by one that lists the planted bytes",
    problem: ToolchainProblem.Integrity,
    plant: async (folder, first) => {
      await writeFile(path.join(folder, first), "planted bytes");
      const listed = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
      listed.files[first] = { sha256: sha256(Buffer.from("planted bytes")), size: Buffer.byteLength("planted bytes") };
      await writeFile(path.join(folder, "manifest.json"), `${JSON.stringify(listed, null, 2)}\n`);
    },
  },
];

describe("cross local artifacts: installed only through the file-by-file seam", () => {
  for (const artifact of CROSS_ARTIFACTS) {
    it(`${artifact.id} installs from a matching folder with a local-artifact receipt for ${artifact.target}`, async () => {
      const { store, folder, entry } = await crossArtifact(artifact);
      const installed = await installLocalArtifact(store, entry, folder, { now: () => Date.UTC(2026, 9, 1) });
      assert.equal(installed, path.join(store, artifact.id, `${artifact.version}-${entrySha12(entry)}`));
      const receipt = JSON.parse(await readFile(path.join(installed, "receipt.json"), "utf8")) as ToolchainReceipt;
      assert.deepEqual(
        [receipt.source, receipt.target, receipt.sha256],
        [ReceiptSource.LocalArtifact, artifact.target, entry.local?.manifestSha256],
      );
      for (const [rel, text] of Object.entries(artifact.files))
        assert.equal(await readFile(path.join(installed, rel), "utf8"), text, rel);
    });

    for (const row of HOSTILE_ARTIFACT)
      it(`${artifact.id}: refuses ${row.name}, with nothing installed or staged left behind`, POSIX_ONLY, async () => {
        const { store, folder, entry } = await crossArtifact(artifact);
        const [first = ""] = Object.keys(artifact.files);
        await row.plant(folder, first);
        const before = await snapshot(store);
        const source = await snapshot(folder);
        await assert.rejects(
          () => installLocalArtifact(store, entry, folder),
          (error: unknown) => error instanceof ToolchainError && error.problem === row.problem,
        );
        assert.deepEqual(await snapshot(store), before, "the store is byte-identical");
        assert.equal(existsSync(path.join(store, ".staging")), false, "no staging is left");
        assert.deepEqual(await snapshot(folder), source, "the folder it was given is untouched");
      });
  }

  it("an install of ANGLE or the Linux sysroot missing from this build is refused not-bundled before any fetch", async () => {
    for (const id of LOCAL_ONLY) {
      const { store } = await seededStore();
      const before = await snapshot(store);
      const entry = manifestEntry(id, ToolchainHost.MacArm64);
      assert.ok(entry?.local, `${id} is pinned as a local artifact`);
      const { fetch, calls } = servedFetch();
      const resources = await tmpDir("empty-bundle-resources-");
      const job = await installComponents(store, [entry], deps({ fetch, resources }));
      const problem = ToolchainProblem.NotBundled;
      assert.deepEqual([job.phase, job.problem], [ToolchainInstallPhase.Failed, problem], id);
      assert.deepEqual(calls, [], `${id}: nothing fetched`);
      assert.deepEqual(await snapshot(store), before, `${id}: the store is unchanged`);
    }
  });
});

describe("the zig probe", () => {
  const ZIG_ROWS: Array<[string, boolean]> = [
    ["0.16.0\n", true],
    ["0.16.0", true],
    ["0.16.0-dev.1234+abcdef012\n", false],
    ["0.15.1\n", false],
    ["10.16.0\n", false],
    ["zig 0.16.0 (or so)\n", false],
    ["", false],
  ];
  for (const [stdout, accepted] of ZIG_ROWS)
    it(`runs zig version under the sandbox and ${accepted ? "takes" : "refuses"} ${JSON.stringify(stdout)}`, async () => {
      const { store } = await seededStore();
      const before = await snapshot(store);
      const served = { url: "https://example.test/zig.tar.gz", body: tarGz(file("zig", "#!/bin/sh\n", 0o755)) };
      const probe = probeRun(() => ({ code: 0, stdout }));
      const { fetch } = servedFetch(served);
      const job = await installComponents(
        store,
        [entryOf(ToolchainId.Zig, "0.16.0", served)],
        deps({ fetch, run: probe.run }),
      );
      assert.match(probe.requests[0]?.command ?? "", /\/zig' version$/);
      if (accepted) assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
      else {
        assert.equal(job.problem, ToolchainProblem.Probe);
        assert.deepEqual(await snapshot(store), before);
      }
    });
});

// ---------- the store's own lock file (decision T2: one store, a lock per worktree) ----------

describe("the store's current-lock.json is never another worktree's lock file", () => {
  /** A store with a current lock, and a folder beside it. */
  async function storeWithLock() {
    const root = await realpath(await tmpDir("toolchain-lock-file-"));
    const store = path.join(root, "store");
    await mkdir(path.join(store, "locks"), { recursive: true });
    await writeFile(path.join(store, "current-lock.json"), '{"version":1}\n');
    return { root, store, current: path.join(store, "current-lock.json") };
  }

  const NAMES_IT: Array<[string, (store: string, root: string) => Promise<string>]> = [
    ["its own path", async (store) => path.join(store, "current-lock.json")],
    ["its path through ./ and ../ segments", async (store) => `${store}/./locks/../current-lock.json`],
    [
      "a link to it",
      async (store, root) => {
        await symlink(path.join(store, "current-lock.json"), path.join(root, "lock-link.json"));
        return path.join(root, "lock-link.json");
      },
    ],
    [
      "a hard link to it",
      async (store, root) => {
        await hardLink(path.join(store, "current-lock.json"), path.join(root, "lock-hard.json"));
        return path.join(root, "lock-hard.json");
      },
    ],
    [
      "its path through a linked store folder",
      async (store, root) => {
        await symlink(store, path.join(root, "store-link"));
        return path.join(root, "store-link", "current-lock.json");
      },
    ],
  ];
  for (const [label, name] of NAMES_IT)
    it(`is named by ${label}, and asking writes nothing`, async () => {
      const { root, store, current } = await storeWithLock();
      const file = await name(store, root);
      const before = { bytes: await readFile(current), mtime: (await stat(current)).mtimeMs };
      assert.equal(await isStoreLockFile(store, file), true);
      assert.deepEqual({ bytes: await readFile(current), mtime: (await stat(current)).mtimeMs }, before);
    });

  it("is named by its own path before it exists, and its name in another case on a disk that folds case", async () => {
    const { store, current } = await storeWithLock();
    const upper = path.join(store, "CURRENT-LOCK.json");
    assert.equal(await isStoreLockFile(store, upper), existsSync(upper), "only where the disk folds the name onto it");
    await rm(current);
    assert.equal(await isStoreLockFile(store, current), true, "a store with no lock yet");
  });

  it("is not a worktree's own lock file, nor another file in the store", async () => {
    const { root, store } = await storeWithLock();
    assert.equal(await isStoreLockFile(store, path.join(root, ".studio-dev", "dev-store-lock.json")), false);
    await writeFile(path.join(store, "locks", "other.json"), "{}");
    assert.equal(await isStoreLockFile(store, path.join(store, "locks", "other.json")), false);
  });
});

/** A downloadable local artifact retains the manifest pin independently of its archive pin. */
function fetchedSysroot(url: string | null, corrupt = false) {
  const files = {
    "usr/include/X11/Xlib.h": "X11 headers",
    "usr/include/wayland-client.h": "Wayland headers",
    "glfw-wayland/xdg-shell-client-protocol.h": "protocol header",
  };
  const listed = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      { sha256: sha256(Buffer.from(bytes)), size: Buffer.byteLength(bytes) },
    ]),
  );
  const manifest = JSON.stringify({ schema: 1, files: listed });
  const body = tarGz(
    file("manifest.json", manifest),
    ...Object.entries(files).map(([name, bytes]) => file(name, corrupt ? `${bytes}!` : bytes)),
  );
  const entry: ToolchainEntry = {
    id: ToolchainId.LinuxSysroot,
    version: "test",
    host: null,
    target: BuildTarget.Linux,
    archives: [],
    licence: "test",
    local: {
      manifestSha256: sha256(Buffer.from(manifest)),
      manifestBytes: Buffer.byteLength(manifest),
      bytes: Object.values(files).reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0),
      files: Object.keys(files).length,
      reason: ToolchainUnhosted.NotPublished,
      fetch: { url, sha256: sha256(body), bytes: body.length, format: ArchiveFormat.TarGz },
    },
  };
  return { body, entry };
}

describe("a sysroot fetched once and verified by both pins", () => {
  it("installs the pinned archive once, checks its manifest, and reuses the installed receipt", async () => {
    const { store } = await seededStore();
    const url = "https://example.test/sysroot.tar.gz";
    const { body, entry } = fetchedSysroot(url);
    assert.equal(isDownloadable(entry), true);
    const { fetch, calls } = servedFetch({ url, body });
    const first = await installComponents(store, [entry], deps({ fetch }));
    assert.equal(first.phase, ToolchainInstallPhase.Installed, JSON.stringify(first));
    const receipts = await readReceipts(store);
    assert.equal(receipts[0]?.sha256, entry.local?.manifestSha256);
    const second = await installComponents(store, [entry], deps({ fetch }));
    assert.equal(second.phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(calls, [url]);
  });
  it("an unpublished archive fetches nothing and changes nothing", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const { entry } = fetchedSysroot(null);
    assert.equal(isDownloadable(entry), false);
    const { fetch, calls } = servedFetch();
    const job = await installComponents(store, [entry], deps({ fetch }));
    assert.equal(job.problem, ToolchainProblem.NotHosted);
    assert.deepEqual(calls, []);
    assert.deepEqual(await snapshot(store), before);
  });
  it("a matching archive digest cannot override mismatched manifest bytes", async () => {
    const { store } = await seededStore();
    const before = await snapshot(store);
    const url = "https://example.test/sysroot.tar.gz";
    const { body, entry } = fetchedSysroot(url, true);
    const { fetch } = servedFetch({ url, body });
    const job = await installComponents(store, [entry], deps({ fetch }));
    assert.equal(job.problem, ToolchainProblem.Integrity);
    assert.deepEqual(await snapshot(store), before);
  });
});

// ---------- the host-level download cache ----------

describe("the host-level download cache", () => {
  /** A pinned ninja served at one URL, and an empty cache beside two profiles' stores. */
  async function cacheRig() {
    const root = await tmpDir("download-cache-");
    const body = tarGz(file("ninja", "#!/bin/sh\necho 1.13.2\n", 0o755));
    const served = { url: "https://example.test/ninja.tar.gz", body };
    return {
      root,
      cache: path.join(root, "host-cache"),
      body,
      served,
      entry: entryOf(ToolchainId.Ninja, "1.13.2", served),
      store: (name: string) => path.join(root, name, "toolchains"),
    };
  }

  const entriesIn = async (cache: string) => (await readdir(path.join(cache, "sha256"))).sort();

  it("two profiles installing at once share one verified entry, and both install", async () => {
    const rig = await cacheRig();
    const normal = servedFetch(rig.served);
    const dev = servedFetch(rig.served);
    const [first, second] = await Promise.all([
      installComponents(rig.store("normal"), [rig.entry], deps({ fetch: normal.fetch, downloadCache: rig.cache })),
      installComponents(rig.store("dev"), [rig.entry], deps({ fetch: dev.fetch, downloadCache: rig.cache })),
    ]);
    assert.equal(first.phase, ToolchainInstallPhase.Installed, JSON.stringify(first));
    assert.equal(second.phase, ToolchainInstallPhase.Installed, JSON.stringify(second));
    assert.deepEqual(await entriesIn(rig.cache), [sha256(rig.body)], "one cache entry, named by its sha256");
    assert.deepEqual(await readFile(path.join(rig.cache, "sha256", sha256(rig.body))), rig.body);
    assert.ok(normal.calls.length + dev.calls.length <= 2, "each profile downloads at most once");
    assert.deepEqual(await readdir(path.join(rig.cache, ".incoming")), [], "no download is left half-way");
    for (const name of ["normal", "dev"]) {
      const receipts = await readReceipts(rig.store(name));
      assert.deepEqual(
        receipts.map((receipt) => receipt.id),
        [ToolchainId.Ninja],
        `${name} holds its own install`,
      );
    }
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(rig.cache, "sha256", sha256(rig.body)))).mode & 0o777;
      assert.equal(mode, 0o444, "a cached archive is read-only");
    }
  });

  it("a later profile installs from the cache and downloads nothing", async () => {
    const rig = await cacheRig();
    const first = servedFetch(rig.served);
    await installComponents(rig.store("normal"), [rig.entry], deps({ fetch: first.fetch, downloadCache: rig.cache }));
    const later = servedFetch(rig.served);
    const job = await installComponents(
      rig.store("dev"),
      [rig.entry],
      deps({ fetch: later.fetch, downloadCache: rig.cache }),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(later.calls, [], "the verified entry served the install");
  });

  it("an entry that no longer matches its pin is downloaded again, never extracted", async () => {
    const rig = await cacheRig();
    await installComponents(
      rig.store("normal"),
      [rig.entry],
      deps({ fetch: servedFetch(rig.served).fetch, downloadCache: rig.cache }),
    );
    const cached = path.join(rig.cache, "sha256", sha256(rig.body));
    await chmod(cached, 0o644);
    const tampered = Buffer.from(rig.body);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await writeFile(cached, tampered);
    const again = servedFetch(rig.served);
    const job = await installComponents(
      rig.store("dev"),
      [rig.entry],
      deps({ fetch: again.fetch, downloadCache: rig.cache }),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    assert.deepEqual(again.calls, [rig.served.url], "the tampered entry was replaced by a download");
    assert.deepEqual(await readFile(cached), rig.body);
  });

  it("a link planted at an entry's name is removed, never followed", POSIX_ONLY, async () => {
    const rig = await cacheRig();
    const outside = path.join(rig.root, "outside.tar.gz");
    await writeFile(outside, rig.body);
    await mkdir(path.join(rig.cache, "sha256"), { recursive: true });
    await symlink(outside, path.join(rig.cache, "sha256", sha256(rig.body)));
    const fetched = servedFetch(rig.served);
    const job = await installComponents(
      rig.store("dev"),
      [rig.entry],
      deps({ fetch: fetched.fetch, downloadCache: rig.cache }),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.deepEqual(fetched.calls, [rig.served.url]);
    assert.ok((await lstat(path.join(rig.cache, "sha256", sha256(rig.body)))).isFile());
    assert.deepEqual(await readFile(outside), rig.body, "the link's target is untouched");
  });

  it("a download that fails its pin adds nothing to the cache", async () => {
    const rig = await cacheRig();
    const wrong = { url: rig.served.url, body: tarGz(file("ninja", "other bytes, other digest")) };
    const entry: ToolchainEntry = {
      ...rig.entry,
      archives: [{ ...rig.entry.archives[0], bytes: wrong.body.length } as ToolchainArchive],
    };
    const job = await installComponents(
      rig.store("dev"),
      [entry],
      deps({ fetch: servedFetch(wrong).fetch, downloadCache: rig.cache }),
    );
    assert.equal(job.problem, ToolchainProblem.Integrity);
    assert.deepEqual(await entriesIn(rig.cache), []);
    assert.deepEqual(await readdir(path.join(rig.cache, ".incoming")), []);
  });

  it("lives outside every profile, per host, and every profile's sandbox is denied writing it", () => {
    assert.equal(hostDownloadCache("darwin", "/Users/me", {}), "/Users/me/Library/Caches/Genex/toolchain-downloads");
    assert.equal(hostDownloadCache("linux", "/home/me", {}), "/home/me/.cache/genex/toolchain-downloads");
    assert.equal(
      hostDownloadCache("linux", "/home/me", { XDG_CACHE_HOME: "/var/cache/me" }),
      "/var/cache/me/genex/toolchain-downloads",
    );
    assert.equal(
      hostDownloadCache("linux", "/home/me", { XDG_CACHE_HOME: "relative/cache" }),
      "/home/me/.cache/genex/toolchain-downloads",
      "a relative XDG_CACHE_HOME is ignored",
    );
    assert.equal(
      hostDownloadCache("win32", "C:\\Users\\me", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
      "C:\\Users\\me\\AppData\\Local\\Genex\\toolchain-downloads",
    );
    const cache = "/Users/me/Library/Caches/Genex/toolchain-downloads";
    for (const userData of [
      "/Users/me/Library/Application Support/Genex",
      "/repo/.studio-dev/profiles/live-1/userData",
    ]) {
      const layout = layoutFor(userData, cache);
      assert.equal(layout.downloadCache, cache);
      assert.ok(!isInside(userData, layout.downloadCache), "the cache is no profile's own");
      assert.ok(studioBaseDenyWrites(layout, [], "darwin", () => false).includes(cache));
      assert.ok(prewarmDenyWrites(layout).includes(cache));
    }
  });
});

// ---------- seeding a developer profile's prewarm ----------

describe("seeding a developer profile's prewarm from the normal profile's", () => {
  const LOCK = lockOf({ [ToolchainId.Ninja]: { version: "1.13.2", sha12: "aaaaaaaaaaaa" } });
  const FOLDER = LOCK.digest.slice(0, 12);

  /** A normal store with one prewarmed lock folder and its manifest, and where a developer store goes. */
  async function prewarmedNormal() {
    const root = await tmpDir("prewarm-seed-");
    const normal = path.join(root, "normal", "toolchains");
    const outputs = path.join(normal, "locks", FOLDER);
    await mkdir(path.join(outputs, "raylib-web", "lib"), { recursive: true });
    await mkdir(path.join(outputs, "em-cache", "empty"), { recursive: true });
    await writeFile(path.join(outputs, "prewarm.json"), JSON.stringify({ lock: LOCK.digest }));
    await writeFile(path.join(outputs, "raylib-web", "lib", "libraylib.a"), "an archive of objects");
    await writeFile(path.join(outputs, "build-script"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFilePinned(normal);
    return { root, normal, outputs, dev: path.join(root, "dev", "toolchains") };
  }

  /** Writes the normal store's manifest, as its host does after a prewarm. */
  async function writeFilePinned(normal: string) {
    await writePrewarmManifest(normal, LOCK);
  }

  /** Rewrites the manifest with `change` applied and its digest recomputed (a self-consistent forgery). */
  async function forgeManifest(normal: string, change: (fields: Record<string, unknown>) => void) {
    const file = prewarmManifestFile(normal, LOCK);
    const { digest: _old, ...fields } = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    change(fields);
    const digest = createHash("sha256").update(canonicalJson(fields)).digest("hex");
    await writeFile(file, JSON.stringify({ ...fields, digest }));
  }

  /** The refusal `work` throws, typed. */
  async function refusal(work: Promise<unknown>): Promise<SeedRefusal> {
    try {
      await work;
    } catch (error) {
      if (error instanceof SeedError) return error.refusal;
      throw error;
    }
    assert.fail("the seed was not refused");
  }

  it("clones the lock folder into the developer store, verified file by file, and reads the normal store only", async () => {
    const rig = await prewarmedNormal();
    const before = await snapshot(rig.normal);
    const seeded = await seedPrewarm({ from: rig.normal, to: rig.dev, lock: LOCK });
    assert.equal(seeded.seeded, true);
    assert.deepEqual(await snapshot(path.join(rig.dev, "locks", FOLDER)), await snapshot(rig.outputs));
    assert.deepEqual(await snapshot(rig.normal), before, "the normal store is byte-identical");
    assert.deepEqual(await readdir(rig.dev), ["locks"], "no staging is left and no lock file is written");
  });

  it("a lock folder the developer store already holds is kept as it is", async () => {
    const rig = await prewarmedNormal();
    await mkdir(path.join(rig.dev, "locks", FOLDER), { recursive: true });
    await writeFile(path.join(rig.dev, "locks", FOLDER, "own.txt"), "the dev profile's own prewarm");
    const before = await snapshot(rig.dev);
    assert.equal((await seedPrewarm({ from: rig.normal, to: rig.dev, lock: LOCK })).seeded, false);
    assert.deepEqual(await snapshot(rig.dev), before);
  });

  const tampered: Array<{
    name: string;
    refused: SeedRefusal;
    posix?: true;
    tamper: (rig: Awaited<ReturnType<typeof prewarmedNormal>>) => Promise<void>;
  }> = [
    {
      name: "a file changed after its manifest was written",
      refused: SeedRefusal.FileDigest,
      tamper: (rig) => writeFile(path.join(rig.outputs, "raylib-web", "lib", "libraylib.a"), "an archive of evil!!"),
    },
    {
      name: "a manifest edited without its digest",
      refused: SeedRefusal.ManifestDigest,
      tamper: async (rig) => {
        const file = prewarmManifestFile(rig.normal, LOCK);
        const manifest = JSON.parse(await readFile(file, "utf8")) as { files: Record<string, unknown> };
        manifest.files["prewarm.json"] = { size: 1, sha256: "0".repeat(64) };
        await writeFile(file, JSON.stringify(manifest));
      },
    },
    {
      name: "a self-consistent manifest of another lock",
      refused: SeedRefusal.WrongLock,
      tamper: (rig) =>
        forgeManifest(rig.normal, (fields) => {
          fields.lock = "b".repeat(64);
        }),
    },
    {
      name: "a self-consistent manifest naming a path that climbs out",
      refused: SeedRefusal.ManifestShape,
      tamper: (rig) =>
        forgeManifest(rig.normal, (fields) => {
          (fields.files as Record<string, unknown>)["../../current-lock.json"] = { size: 0, sha256: "0".repeat(64) };
        }),
    },
    {
      name: "a self-consistent manifest that lists a changed file's new digest",
      refused: SeedRefusal.FileDigest,
      tamper: async (rig) => {
        const forged = Buffer.from("planted bytes");
        await forgeManifest(rig.normal, (fields) => {
          (fields.files as Record<string, unknown>)["prewarm.json"] = { size: forged.length, sha256: sha256(forged) };
        });
      },
    },
    {
      name: "a manifest that is not JSON",
      refused: SeedRefusal.ManifestShape,
      tamper: (rig) => writeFile(prewarmManifestFile(rig.normal, LOCK), "{ not json"),
    },
    {
      name: "no manifest at all",
      refused: SeedRefusal.NoManifest,
      tamper: (rig) => rm(prewarmManifestFile(rig.normal, LOCK)),
    },
    {
      name: "a file the manifest does not list",
      refused: SeedRefusal.Unlisted,
      tamper: (rig) => writeFile(path.join(rig.outputs, "planted.dylib"), "unlisted"),
    },
    {
      name: "a listed file that is missing",
      refused: SeedRefusal.Unlisted,
      tamper: (rig) => rm(path.join(rig.outputs, "build-script")),
    },
    {
      name: "a link in the outputs",
      refused: SeedRefusal.NotRegular,
      posix: true,
      tamper: (rig) => symlink("/etc/hosts", path.join(rig.outputs, "em-cache", "hosts")),
    },
    {
      name: "an output that names the normal store's own path",
      refused: SeedRefusal.NotRelocatable,
      tamper: async (rig) => {
        await writeFile(
          path.join(rig.outputs, "emscripten.config"),
          `LLVM_ROOT = "${await realpath(rig.normal)}/emsdk"`,
        );
        await writeFilePinned(rig.normal);
      },
    },
  ];
  for (const row of tampered) {
    it(`refuses ${row.name} (${row.refused}), adding nothing`, row.posix ? POSIX_ONLY : {}, async () => {
      const rig = await prewarmedNormal();
      await row.tamper(rig);
      const before = await snapshot(rig.normal);
      assert.equal(await refusal(seedPrewarm({ from: rig.normal, to: rig.dev, lock: LOCK })), row.refused);
      assert.equal(existsSync(path.join(rig.dev, "locks", FOLDER)), false, "no lock folder was added");
      assert.equal(existsSync(path.join(rig.dev, ".staging")), false, "no staging is left");
      assert.deepEqual(await snapshot(rig.normal), before, "the normal store is byte-identical");
    });
  }

  const hostileStores: Array<{
    name: string;
    refused: SeedRefusal;
    posix?: true;
    dev: (rig: Awaited<ReturnType<typeof prewarmedNormal>>) => Promise<string>;
  }> = [
    { name: "the normal store itself", refused: SeedRefusal.SameStore, dev: async (rig) => rig.normal },
    {
      name: "the normal store spelled with ..",
      refused: SeedRefusal.SameStore,
      dev: async (rig) => path.join(rig.normal, "locks", ".."),
    },
    {
      name: "a folder inside the normal store",
      refused: SeedRefusal.SameStore,
      dev: async (rig) => path.join(rig.normal, "dev-profile"),
    },
    {
      name: "a folder holding the normal store",
      refused: SeedRefusal.SameStore,
      dev: async (rig) => path.dirname(rig.normal),
    },
    {
      name: "a link to the normal store",
      refused: SeedRefusal.LinkedStore,
      posix: true,
      dev: async (rig) => {
        await mkdir(path.dirname(rig.dev), { recursive: true });
        await symlink(rig.normal, rig.dev);
        return rig.dev;
      },
    },
    {
      name: "a folder inside the normal store reached through a link",
      refused: SeedRefusal.SameStore,
      posix: true,
      dev: async (rig) => {
        await symlink(rig.normal, path.join(rig.root, "via"));
        return path.join(rig.root, "via", "nested", "toolchains");
      },
    },
    {
      name: "a store whose locks folder links into the normal store",
      refused: SeedRefusal.LinkedStore,
      posix: true,
      dev: async (rig) => {
        await mkdir(rig.dev, { recursive: true });
        await symlink(path.join(rig.normal, "locks"), path.join(rig.dev, "locks"));
        return rig.dev;
      },
    },
    {
      name: "a store whose staging links into the normal store",
      refused: SeedRefusal.LinkedStore,
      posix: true,
      dev: async (rig) => {
        await mkdir(rig.dev, { recursive: true });
        await symlink(rig.normal, path.join(rig.dev, ".staging"));
        return rig.dev;
      },
    },
  ];
  for (const row of hostileStores) {
    it(
      `a developer store that is ${row.name} is refused (${row.refused}); the normal store is untouched`,
      row.posix ? POSIX_ONLY : {},
      async () => {
        const rig = await prewarmedNormal();
        const before = await snapshot(rig.normal);
        const dev = await row.dev(rig);
        assert.equal(await refusal(seedPrewarm({ from: rig.normal, to: dev, lock: LOCK })), row.refused);
        assert.deepEqual(await snapshot(rig.normal), before, "nothing was written in the normal store");
      },
    );
  }
});

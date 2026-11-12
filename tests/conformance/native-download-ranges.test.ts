/**
 * A large native build's archive is downloaded as ranges over several connections at once, each
 * range pinned to the archive the first answer named (`If-Range`), written at its own offset and
 * recorded beside the partial file, so a stopped download asks again only for what it lacks. An
 * answer that is not exactly the range asked for is never written: the download starts over as one
 * stream, or fails as a typed install failure. A record that is off in any way is not believed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DOWNLOAD_CONNECTIONS,
  discardDownload,
  downloadArchive,
  InstallError,
  RANGE_BYTES,
  rangeRecordOf,
  verifyArchive,
} from "../../src/main/play/native-download.ts";
import type { StallClock } from "../../src/main/play/remix.ts";
import { InstallFailure, NativeArch, NativePlatform, type ZipBuild } from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOST = "builds.example.test";
const HOSTS: ReadonlySet<string> = new Set([HOST]);
/** The range size these downloads use, so a small archive is many ranges. */
const RANGE = 16;
const RANGES = 13;
/** An archive of thirteen ranges, the last one short; no byte of it is {@link MARK}. */
const ARCHIVE = Buffer.from(Array.from({ length: RANGE * (RANGES - 1) + 5 }, (_, at) => 97 + (at % 23)));
/** The byte every hostile body is made of: it must never reach the file. */
const MARK = 0x58;
const ETAG = '"v1"';
const ARCHIVE_PATH = "/dust-runners/1.0/mac.zip";

const build = (overrides: Partial<ZipBuild> = {}): ZipBuild => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version: "1.0",
  sizeBytes: ARCHIVE.length,
  installedBytes: ARCHIVE.length * 2,
  sha256: createHash("sha256").update(ARCHIVE).digest("hex"),
  url: `https://${HOST}${ARCHIVE_PATH}`,
  entry: "Dust Runners.app",
  publishedAt: "2026-10-18T00:00:00.000Z",
  ...overrides,
});

/** One request the host received: the range asked for as `[first, last]`, or null for the whole archive. */
interface Asked {
  range: [number, number] | null;
  ifRange: string | null;
}

/** What a test's host does with a request instead of answering it honestly; false answers honestly. */
type Meddle = (asked: Asked, response: ServerResponse, request: IncomingMessage) => boolean | Promise<boolean>;

const rangeOf = (header: string | undefined): [number, number] | null => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
};

/** The whole archive, as a host that knows no ranges answers. */
function sendWhole(response: ServerResponse, etag = ETAG): void {
  response.writeHead(200, { "content-length": ARCHIVE.length, etag });
  response.end(ARCHIVE);
}

/** One range, exactly as asked. */
function sendRange(response: ServerResponse, [first, last]: [number, number], etag = ETAG): void {
  const headers = { "content-range": `bytes ${first}-${last}/${ARCHIVE.length}`, "content-length": last - first + 1 };
  response.writeHead(206, { ...headers, etag });
  response.end(ARCHIVE.subarray(first, last + 1));
}

/** An honest host: ranges when asked and the archive is the one named, else the whole archive. */
function honest(asked: Asked, response: ServerResponse): void {
  const pinned = asked.ifRange === null || asked.ifRange === ETAG;
  if (asked.range && pinned) sendRange(response, asked.range);
  else sendWhole(response);
}

let server: Server;
let origin = "";
let meddle: Meddle = () => false;
let asked: Asked[] = [];
let inFlight = 0;
let mostInFlight = 0;

before(async () => {
  server = createServer((request, response) => {
    const one: Asked = {
      range: rangeOf(request.headers.range),
      ifRange: [request.headers["if-range"]].flat()[0] ?? null,
    };
    asked.push(one);
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    response.on("close", () => inFlight--);
    void Promise.resolve(meddle(one, response, request)).then((handled) => {
      if (!handled) honest(one, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

/** The network: the build host's https address answered by this test's host, other hosts never reached. */
const reached: string[] = [];
const network = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  reached.push(url.href);
  assert.equal(url.hostname, HOST, "only the build host is asked");
  return fetch(`${origin}${url.pathname}`, init);
}) as typeof fetch;

interface Run {
  partial?: Uint8Array;
  record?: string;
  dir?: string;
  signal?: AbortSignal;
  stallClock?: StallClock;
  meddle?: Meddle;
}

async function start(options: Run = {}) {
  const dir = options.dir ?? (await tmpDir("native-ranges-"));
  const partial = path.join(dir, "game.zip.part");
  if (options.partial) await writeFile(partial, options.partial);
  if (options.record !== undefined) await writeFile(rangeRecordOf(partial), options.record);
  meddle = options.meddle ?? (() => false);
  asked = [];
  reached.length = 0;
  mostInFlight = 0;
  const reports: number[] = [];
  const deps = {
    fetch: network,
    hosts: HOSTS,
    rangeBytes: RANGE,
    ...(options.stallClock ? { stallClock: options.stallClock } : {}),
  };
  const signal = options.signal ?? new AbortController().signal;
  const done = downloadArchive(deps, build(), partial, signal, (received) => reports.push(received));
  return { done, partial, reports, dir };
}

const failsWith = (failure: InstallFailure) => (error: unknown) =>
  error instanceof InstallError && error.failure === failure;
const bytesOf = (file: string) => readFile(file).catch(() => Buffer.alloc(0));
const exists = async (file: string) => (await stat(file).catch(() => null)) !== null;
const rangesAsked = () => asked.filter((one) => one.range && one.range[1] > 0).map((one) => one.range?.[0]);
const wholeAsked = () => asked.filter((one) => one.range === null).length;
const indexOf = (one: Asked) => (one.range && one.range[1] > 0 ? one.range[0] / RANGE : -1);
const rising = (values: readonly number[]) => values.every((value, at) => at === 0 || value >= (values[at - 1] ?? 0));
const until = async (met: () => boolean) => {
  while (!met()) await new Promise((resolve) => setImmediate(resolve));
};
/** A record as the download writes it, with `parts` changed. */
const record = (parts: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, sizeBytes: ARCHIVE.length, rangeBytes: RANGE, etag: ETAG, done: [], ...parts });
const everyRange = Array.from({ length: RANGES }, (_, index) => index);

describe("a large native build's download", () => {
  it("uses six connections and 32 MiB ranges", () => {
    assert.equal(DOWNLOAD_CONNECTIONS, 6);
    assert.equal(RANGE_BYTES, 32 * 1024 ** 2);
  });

  it("asks for its ranges over several connections at once and saves the archive", async () => {
    let waiting: Array<() => void> = [];
    const together: Meddle = async (one) => {
      if (indexOf(one) < 0 || indexOf(one) >= DOWNLOAD_CONNECTIONS) return false;
      // The first ranges are answered only once as many as there are connections are waiting.
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === DOWNLOAD_CONNECTIONS) for (const go of waiting) go();
      });
      return false;
    };
    const { done, partial, reports } = await start({ meddle: together });
    await done;
    waiting = [];
    assert.equal(mostInFlight, DOWNLOAD_CONNECTIONS, "as many requests at once as connections, never more");
    assert.deepEqual(
      rangesAsked().sort((a, b) => Number(a) - Number(b)),
      everyRange.map((index) => index * RANGE),
    );
    assert.equal(wholeAsked(), 0);
    assert.ok(
      asked.filter((one) => indexOf(one) >= 0).every((one) => one.ifRange === ETAG),
      "every range is pinned to the first answer's archive",
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(partial))
        .digest("hex"),
      build().sha256,
    );
    assert.equal(await verifyArchive(partial, build()), true);
    assert.ok(rising(reports), "progress never goes back");
    assert.equal(reports.at(-1), ARCHIVE.length);
    assert.equal(await exists(rangeRecordOf(partial)), false, "the record goes once the archive is whole");
  });

  it("asks again only for the ranges a stopped download lacks", async () => {
    const stop = new AbortController();
    const held = 4;
    const hang: Meddle = (one, response) => {
      if (indexOf(one) !== held) return false;
      response.writeHead(206, {
        "content-range": `bytes ${held * RANGE}-${held * RANGE + RANGE - 1}/${ARCHIVE.length}`,
        etag: ETAG,
      });
      response.write(ARCHIVE.subarray(held * RANGE, held * RANGE + 3));
      return true;
    };
    const first = await start({ signal: stop.signal, meddle: hang });
    await until(() => (first.reports.at(-1) ?? 0) >= ARCHIVE.length - RANGE + 3);
    stop.abort();
    await assert.rejects(first.done, failsWith(InstallFailure.Failed));
    const kept = JSON.parse(await readFile(rangeRecordOf(first.partial), "utf8")) as { done: number[] };
    assert.deepEqual(
      [...kept.done].sort((a, b) => a - b),
      everyRange.filter((index) => index !== held),
    );
    const second = await start({ dir: first.dir });
    await second.done;
    assert.deepEqual(rangesAsked(), [held * RANGE], "only the unfinished range");
    assert.equal(second.reports[0], ARCHIVE.length - RANGE, "it starts from the bytes it has");
    assert.ok(rising(second.reports));
    assert.equal(await verifyArchive(second.partial, build()), true);
  });

  it("counts the whole ranges a single stream saved earlier", async () => {
    const { done, partial } = await start({ partial: ARCHIVE.subarray(0, RANGE * 2 + 7) });
    await done;
    assert.deepEqual(
      rangesAsked().sort((a, b) => Number(a) - Number(b)),
      everyRange.slice(2).map((index) => index * RANGE),
    );
    assert.equal(await verifyArchive(partial, build()), true);
  });

  /** A body of marks in place of range `index`, under `headers`. */
  const marks =
    (
      index: number,
      status: number,
      headers: (first: number, last: number) => Record<string, string | number>,
      length = RANGE,
    ): Meddle =>
    (one, response) => {
      if (indexOf(one) !== index || !one.range) return false;
      response.writeHead(status, { etag: ETAG, ...headers(one.range[0], one.range[1]) });
      response.end(Buffer.alloc(length, MARK));
      return true;
    };
  const total = ARCHIVE.length;
  let changed = false;
  const HOSTILE: Array<[string, () => Meddle, "starts over" | InstallFailure]> = [
    ["the host knows no ranges", () => (_, response) => (sendWhole(response), true), "starts over"],
    ["a range answered with the whole archive", () => marks(3, 200, () => ({})), "starts over"],
    [
      "a range that starts elsewhere",
      () => marks(3, 206, (a, b) => ({ "content-range": `bytes ${a + 1}-${b + 1}/${total}` })),
      "starts over",
    ],
    [
      "a range that ends elsewhere",
      () => marks(3, 206, (a, b) => ({ "content-range": `bytes ${a}-${b - 1}/${total}` })),
      "starts over",
    ],
    [
      "a range of an archive of another size",
      () => marks(3, 206, (a, b) => ({ "content-range": `bytes ${a}-${b}/${total + 1}` })),
      "starts over",
    ],
    ["a range with no Content-Range", () => marks(3, 206, () => ({})), "starts over"],
    [
      "another archive under the same address, said by its ETag",
      () => marks(3, 206, (a, b) => ({ "content-range": `bytes ${a}-${b}/${total}`, etag: '"v2"' })),
      "starts over",
    ],
    [
      "the archive changed while it was downloaded",
      () => {
        changed = false;
        return (one, response) => {
          if (indexOf(one) === 3) changed = true;
          if (!changed || !one.range) return false;
          // As a host answers If-Range for an archive it no longer has: the whole new one.
          response.writeHead(200, { etag: '"v2"' });
          response.end(Buffer.alloc(total, MARK));
          return true;
        };
      },
      "starts over",
    ],
    [
      "a range longer than asked",
      () => (one, response) => {
        if (indexOf(one) !== 3 || !one.range) return false;
        response.writeHead(206, { etag: ETAG, "content-range": `bytes ${one.range[0]}-${one.range[1]}/${total}` });
        response.end(Buffer.alloc(RANGE * 3, MARK));
        return true;
      },
      "starts over",
    ],
    [
      "a range that says it is longer than asked",
      () =>
        marks(
          3,
          206,
          (a, b) => ({ "content-range": `bytes ${a}-${b}/${total}`, "content-length": RANGE * 2 }),
          RANGE * 2,
        ),
      "starts over",
    ],
    [
      "a range that ends early",
      () => (one, response) => {
        if (indexOf(one) !== 3 || !one.range) return false;
        response.writeHead(206, { etag: ETAG, "content-range": `bytes ${one.range[0]}-${one.range[1]}/${total}` });
        response.end(ARCHIVE.subarray(one.range[0], one.range[0] + 5));
        return true;
      },
      InstallFailure.Network,
    ],
    [
      "a range sent to another host",
      () => (one, response) => {
        if (indexOf(one) !== 3) return false;
        response.writeHead(302, { location: "https://evil.example/mac.zip" });
        response.end();
        return true;
      },
      InstallFailure.Network,
    ],
    [
      "a range sent to plain http",
      () => (one, response) => {
        if (indexOf(one) !== 3) return false;
        response.writeHead(302, { location: `http://${HOST}/mac.zip` });
        response.end();
        return true;
      },
      InstallFailure.Network,
    ],
  ];

  for (const [why, hostile, outcome] of HOSTILE) {
    it(`writes nothing it did not ask for: ${why}`, async () => {
      // With a host that has the whole archive, a download that starts over ends well.
      const kind = await start({ meddle: hostile() });
      if (outcome === "starts over") {
        await kind.done;
        assert.equal(wholeAsked(), 1, "it starts over as one stream");
        assert.deepEqual(await readFile(kind.partial), ARCHIVE);
        assert.ok(rising(kind.reports), "progress never goes back");
        assert.equal(await exists(rangeRecordOf(kind.partial)), false);
      } else {
        await assert.rejects(kind.done, failsWith(outcome));
        assert.equal(wholeAsked(), 0);
      }
      assert.ok(
        reached.every((url) => new URL(url).hostname === HOST && url.startsWith("https:")),
        "no other host asked",
      );
      // With a host that then refuses the whole archive, what is left holds no hostile byte.
      const inner = hostile();
      const refusing: Meddle = (one, response, request) => {
        if (one.range) return inner(one, response, request);
        response.writeHead(503);
        response.end();
        return true;
      };
      const bare = await start({ meddle: refusing });
      await assert.rejects(bare.done, failsWith(InstallFailure.Network));
      const left = await bytesOf(bare.partial);
      assert.equal(left.includes(MARK), false, "no hostile byte in the partial file");
      assert.equal(await verifyArchive(bare.partial, build()), false, "and it is not taken for the archive");
      const kept = (await exists(rangeRecordOf(bare.partial)))
        ? (JSON.parse(await readFile(rangeRecordOf(bare.partial), "utf8")) as { done: number[] }).done
        : [];
      assert.equal(kept.includes(3), false, "the range is not recorded as saved");
    });
  }

  const hostileFile = Buffer.alloc(ARCHIVE.length, MARK);
  const RECORDS: Array<[string, string, Uint8Array?]> = [
    ["not JSON", "{ done: [0,1"],
    ["not a record", "[0, 1, 2]"],
    ["another version", record({ version: 2, done: everyRange })],
    ["another size", record({ sizeBytes: ARCHIVE.length + RANGE, done: everyRange })],
    ["another range size", record({ rangeBytes: RANGE * 2, done: [0, 1, 2] })],
    ["another archive's ETag", record({ etag: '"v0"', done: everyRange })],
    ["no ETag", record({ etag: 7, done: everyRange })],
    ["a range past the end", record({ done: [0, RANGES] })],
    ["a range far past the end", record({ done: [Number.MAX_SAFE_INTEGER] })],
    ["a negative range", record({ done: [-1, 0] })],
    ["a range that is not whole", record({ done: [0.5] })],
    ["a range that is not a number", record({ done: ["0", null] })],
    ["the same range twice", record({ done: [0, 1, 1] })],
    [
      "more ranges than the archive has",
      record({ done: Array.from({ length: 100_000 }, (_, index) => index % RANGES) }),
    ],
    ["a record too large to be one", `${record({ done: everyRange })}${" ".repeat(2 * 1024 ** 2)}`],
    ["ranges the file is too short to hold", record({ done: everyRange }), hostileFile.subarray(0, RANGE * 2)],
    ["ranges of a file longer than the archive", record({ done: everyRange }), Buffer.alloc(ARCHIVE.length + 1, MARK)],
  ];

  for (const [why, text, file] of RECORDS) {
    it(`does not believe a record that is off: ${why}`, async () => {
      const { done, partial } = await start({ partial: file ?? hostileFile, record: text });
      await done;
      assert.deepEqual(
        rangesAsked().sort((a, b) => Number(a) - Number(b)),
        everyRange.map((index) => index * RANGE),
        "every range is asked for again",
      );
      assert.deepEqual(await readFile(partial), ARCHIVE);
    });
  }

  it("believes a record that is in order", async () => {
    const saved = Buffer.concat([ARCHIVE.subarray(0, RANGE * 3), Buffer.alloc(ARCHIVE.length - RANGE * 3)]);
    const { done, partial } = await start({ partial: saved, record: record({ done: [0, 1, 2] }) });
    await done;
    assert.equal(rangesAsked().length, RANGES - 3);
    assert.deepEqual(await readFile(partial), ARCHIVE);
  });

  it("gives up a connection that stops moving, keeping the ranges saved", async () => {
    const timers: Array<() => void> = [];
    const clock: StallClock = {
      setTimeout: (fire) => {
        timers.push(fire);
        return timers.length - 1;
      },
      clearTimeout: (handle) => {
        if (typeof handle === "number") timers[handle] = () => undefined;
      },
    };
    const silent: Meddle = (one, response) => {
      if (indexOf(one) !== 5) return false;
      response.writeHead(206, { "content-range": `bytes ${5 * RANGE}-${6 * RANGE - 1}/${ARCHIVE.length}`, etag: ETAG });
      response.write(ARCHIVE.subarray(5 * RANGE, 5 * RANGE + 2));
      return true;
    };
    const stalled = await start({ stallClock: clock, meddle: silent });
    await until(() => (stalled.reports.at(-1) ?? 0) >= ARCHIVE.length - RANGE + 2);
    for (const fire of [...timers]) fire();
    await assert.rejects(stalled.done, failsWith(InstallFailure.Stalled));
    const kept = JSON.parse(await readFile(rangeRecordOf(stalled.partial), "utf8")) as { done: number[] };
    assert.equal(kept.done.length, RANGES - 1);
  });

  it("throws a download away with its record", async () => {
    const stop = new AbortController();
    const hang: Meddle = (one, response) => {
      if (indexOf(one) !== 0) return false;
      response.writeHead(206, { "content-range": `bytes 0-${RANGE - 1}/${ARCHIVE.length}`, etag: ETAG });
      response.write(ARCHIVE.subarray(0, 1));
      return true;
    };
    const stopped = await start({ signal: stop.signal, meddle: hang });
    await until(() => (stopped.reports.at(-1) ?? 0) >= ARCHIVE.length - RANGE + 1);
    stop.abort();
    await assert.rejects(stopped.done, failsWith(InstallFailure.Failed));
    assert.equal(await exists(stopped.partial), true);
    assert.equal(await exists(rangeRecordOf(stopped.partial)), true);
    await discardDownload(stopped.partial);
    assert.equal(await exists(stopped.partial), false);
    assert.equal(await exists(rangeRecordOf(stopped.partial)), false);
  });
});

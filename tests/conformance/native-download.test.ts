/**
 * A native build's archive is downloaded to disk from a build host the app trusts and nowhere else:
 * https only, no port or credentials, every redirect checked again, never past its stated size,
 * resumed from the saved bytes when the host answers the range, given up once it stalls, and
 * trusted only once its sha256 matches. Each refused address opens no connection and saves nothing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { checkedBuildUrl, downloadArchive, InstallError, verifyArchive } from "../../src/main/play/native-download.ts";
import type { StallClock } from "../../src/main/play/remix.ts";
import { InstallFailure, NativeArch, type NativeBuild, NativePlatform } from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOST = "builds.example.test";
const HOSTS: ReadonlySet<string> = new Set([HOST]);
const ARCHIVE = Buffer.from("PK\u0003\u0004 a stand-in archive of a native game, forty-odd bytes long");

const build = (overrides: Partial<NativeBuild> = {}): NativeBuild => ({
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version: "1.0",
  sizeBytes: ARCHIVE.length,
  installedBytes: ARCHIVE.length * 2,
  sha256: createHash("sha256").update(ARCHIVE).digest("hex"),
  url: `https://${HOST}/dust-runners/1.0/mac.zip`,
  entry: "Dust Runners.app",
  publishedAt: "2026-10-18T00:00:00.000Z",
  ...overrides,
});

interface Asked {
  url: string;
  range: string | null;
  redirect: RequestRedirect | undefined;
}

/** A body that sends `chunks` and then, unless `end` is false, ends; it errors once `signal` aborts. */
function body(chunks: readonly Uint8Array[], signal: AbortSignal | null | undefined, end = true) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (end) controller.close();
      if (signal?.aborted) controller.error(signal.reason);
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
}

/** A fetch that answers each call with `answer`, keeping what it was asked. */
function fakeFetch(answer: (asked: Asked, signal: AbortSignal | null | undefined) => Response) {
  const asked: Asked[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(input), range: headers.get("range"), redirect: init?.redirect };
    asked.push(call);
    // As a real fetch does, a stopped request goes no further.
    init?.signal?.throwIfAborted();
    return answer(call, init?.signal);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

/** The whole archive, as a host answers it. */
const whole = (signal: AbortSignal | null | undefined, data: Uint8Array = ARCHIVE) =>
  new Response(body([data], signal), { status: 200, headers: { "content-length": String(data.length) } });

async function run(
  fetchImpl: typeof fetch,
  overrides: { build?: NativeBuild; partial?: Uint8Array; signal?: AbortSignal; stallClock?: StallClock } = {},
) {
  const dir = await tmpDir("native-download-");
  const partial = path.join(dir, "game.zip.part");
  if (overrides.partial) await writeFile(partial, overrides.partial);
  const reports: number[] = [];
  let firstReport = () => {};
  const reported = new Promise<void>((resolve) => {
    firstReport = resolve;
  });
  const deps = {
    fetch: fetchImpl,
    hosts: HOSTS,
    ...(overrides.stallClock ? { stallClock: overrides.stallClock } : {}),
  };
  const done = downloadArchive(
    deps,
    overrides.build ?? build(),
    partial,
    overrides.signal ?? new AbortController().signal,
    (received) => {
      reports.push(received);
      firstReport();
    },
  );
  return { done, partial, reports, reported };
}

const failsWith = (failure: InstallFailure) => (error: unknown) =>
  error instanceof InstallError && error.failure === failure;

const saved = async (file: string) => (await stat(file).catch(() => null))?.size ?? 0;

describe("a native build's download", () => {
  it("saves the archive from its host, reporting its bytes, and checks it", async () => {
    const { fetchImpl, asked } = fakeFetch((_, signal) => whole(signal));
    const { done, partial, reports } = await run(fetchImpl);
    await done;
    assert.deepEqual(await readFile(partial), ARCHIVE);
    assert.equal(reports.at(-1), ARCHIVE.length);
    assert.equal(asked[0]?.redirect, "manual", "redirects are followed by hand, each one checked");
    assert.equal(await verifyArchive(partial, build()), true);
    assert.equal(await verifyArchive(partial, build({ sha256: "0".repeat(64) })), false, "another checksum");
  });

  it("refuses each address it may not reach without asking it anything", async () => {
    const hostile: Array<[string, string]> = [
      ["plain http", `http://${HOST}/a.zip`],
      ["another host", "https://evil.example/a.zip"],
      ["a port", `https://${HOST}:8443/a.zip`],
      ["credentials", `https://user:secret@${HOST}/a.zip`],
      ["not an address", "dust runners"],
    ];
    for (const [why, url] of hostile) {
      const { fetchImpl, asked } = fakeFetch((_, signal) => whole(signal));
      const { done, partial } = await run(fetchImpl, { build: build({ url }) });
      await assert.rejects(done, failsWith(InstallFailure.Network), why);
      assert.equal(asked.length, 0, `${why}: nothing asked`);
      assert.equal(await saved(partial), 0, `${why}: nothing saved`);
    }
  });

  it("follows a redirect on its build hosts and refuses one anywhere else", async () => {
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
    const moved = fakeFetch((call, signal) =>
      call.url === build().url ? redirect(`https://${HOST}/cdn/game.zip`) : whole(signal),
    );
    await (await run(moved.fetchImpl)).done;
    assert.deepEqual(
      moved.asked.map((call) => call.url),
      [build().url, `https://${HOST}/cdn/game.zip`],
    );
    for (const location of ["https://evil.example/mac.zip", `http://${HOST}/mac.zip`, `https://${HOST}:444/mac.zip`]) {
      const away = fakeFetch((call, signal) => (call.url === build().url ? redirect(location) : whole(signal)));
      const { done, partial } = await run(away.fetchImpl);
      await assert.rejects(done, failsWith(InstallFailure.Network), location);
      assert.equal(away.asked.length, 1, `${location}: not followed`);
      assert.equal(await saved(partial), 0);
    }
    const loop = fakeFetch(() => redirect(build().url));
    await assert.rejects((await run(loop.fetchImpl)).done, failsWith(InstallFailure.Network));
    assert.ok(loop.asked.length <= 6, "a redirect loop is given up");
  });

  it("never saves past the stated size, whatever the host says", async () => {
    const longer = Buffer.concat([ARCHIVE, Buffer.from("and more bytes than the catalog stated")]);
    const lying = fakeFetch((_, signal) => new Response(body([longer], signal), { status: 200 }));
    const first = await run(lying.fetchImpl);
    await assert.rejects(first.done, failsWith(InstallFailure.TooLarge));
    assert.ok((await saved(first.partial)) <= ARCHIVE.length);
    const declared = fakeFetch(
      (_, signal) =>
        new Response(body([ARCHIVE], signal), { status: 200, headers: { "content-length": String(longer.length) } }),
    );
    await assert.rejects((await run(declared.fetchImpl)).done, failsWith(InstallFailure.TooLarge));
  });

  it("resumes from the bytes saved when the host answers the range, and starts over when it does not", async () => {
    const half = ARCHIVE.length >> 1;
    const ranged = fakeFetch((call, signal) => {
      const rest = ARCHIVE.subarray(half);
      const range = `bytes ${half}-${ARCHIVE.length - 1}/${ARCHIVE.length}`;
      return call.range === `bytes=${half}-`
        ? new Response(body([rest], signal), { status: 206, headers: { "content-range": range } })
        : whole(signal);
    });
    const resumed = await run(ranged.fetchImpl, { partial: ARCHIVE.subarray(0, half) });
    await resumed.done;
    assert.equal(ranged.asked[0]?.range, `bytes=${half}-`);
    assert.deepEqual(await readFile(resumed.partial), ARCHIVE);
    const ignoring = fakeFetch((_, signal) => whole(signal));
    const restarted = await run(ignoring.fetchImpl, { partial: Buffer.from("stale bytes") });
    await restarted.done;
    assert.deepEqual(await readFile(restarted.partial), ARCHIVE, "a whole answer replaces the saved bytes");
    const wrongRange = fakeFetch(
      (_, signal) =>
        new Response(body([ARCHIVE.subarray(3)], signal), {
          status: 206,
          headers: { "content-range": `bytes 3-${ARCHIVE.length - 1}/${ARCHIVE.length}` },
        }),
    );
    const wrong = await run(wrongRange.fetchImpl, { partial: ARCHIVE.subarray(0, half) });
    await assert.rejects(wrong.done, failsWith(InstallFailure.Network));
    assert.equal(await saved(wrong.partial), half, "the saved bytes are kept for the next try");
    const longer = await run(fakeFetch((_, signal) => whole(signal)).fetchImpl, {
      partial: Buffer.concat([ARCHIVE, ARCHIVE]),
    });
    await longer.done;
    assert.deepEqual(await readFile(longer.partial), ARCHIVE, "saved bytes longer than the archive are dropped");
  });

  it("keeps the bytes saved when the network drops, for the next try", async () => {
    const dropping = fakeFetch(() => {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls === 1) controller.enqueue(ARCHIVE.subarray(0, 10));
          else controller.error(new TypeError("terminated"));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const dropped = await run(dropping.fetchImpl);
    await assert.rejects(dropped.done, failsWith(InstallFailure.Network));
    assert.equal(await saved(dropped.partial), 10);
    const offline = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects((await run(offline.fetchImpl)).done, failsWith(InstallFailure.Network));
  });

  it("gives a download up once it stops moving", async () => {
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
    const silent = fakeFetch(
      (_, signal) => new Response(body([ARCHIVE.subarray(0, 5)], signal, false), { status: 200 }),
    );
    const stalled = await run(silent.fetchImpl, { stallClock: clock });
    await stalled.reported;
    timers.at(-1)?.();
    await assert.rejects(stalled.done, failsWith(InstallFailure.Stalled));
  });

  it("stops when asked, keeping what it saved", async () => {
    const stop = new AbortController();
    const slow = fakeFetch((_, signal) => new Response(body([ARCHIVE.subarray(0, 7)], signal, false), { status: 200 }));
    const stopped = await run(slow.fetchImpl, { signal: stop.signal });
    await stopped.reported;
    stop.abort();
    await assert.rejects(stopped.done, failsWith(InstallFailure.Failed));
    assert.equal(await saved(stopped.partial), 7);
  });

  it("checks addresses as the catalog would: https on a build host only", () => {
    assert.equal(checkedBuildUrl(`https://${HOST}/x.zip`, HOSTS).hostname, HOST);
    assert.throws(() => checkedBuildUrl(`https://${HOST}/x.zip`, new Set()), failsWith(InstallFailure.Network));
    assert.equal(checkedBuildUrl("/y.zip", HOSTS, `https://${HOST}/x.zip`).href, `https://${HOST}/y.zip`);
  });
});

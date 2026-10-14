/**
 * The crates.io network boundary of a crate request (M3.15): the sparse index and the archive
 * download, read over the host's network only on the person's approval. Each hostile answer an
 * injected fetcher gives (a stall, an oversize body, a wrong status, a redirect, an index that is
 * not UTF-8) is refused typed (`CrateFetchError.code`) and leaves nothing written where the
 * download would have put its file.
 */
import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CrateFetchError, CrateFetchRefusal, cratesIoDownload, cratesIoIndex } from "../../src/main/crate-requests.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A body of `bytes` sent in `chunk`-sized pieces, or one that never ends (`stall`). */
function body(bytes: Uint8Array, { stall = false, chunk = 64 * 1024 } = {}): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        if (!stall) controller.close();
        return new Promise(() => {});
      }
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
      return undefined;
    },
  });
}

/** A fetcher that answers every URL with `make()`, recording what it was asked with. */
function fetcher(make: () => Response) {
  const asked: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init });
    return make();
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const LIMITS = { timeoutMs: 50, indexMaxBytes: 1024, archiveMaxBytes: 4096 };
const INDEX_LINE = `${JSON.stringify({ name: "tidy", vers: "1.0.0", deps: [], cksum: "a".repeat(64), features: {}, yanked: false })}\n`;

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "answered",
    (error: unknown) => (error instanceof CrateFetchError ? error.code : `untyped: ${String(error)}`),
  );
}

describe("the crates.io index", () => {
  it("reads a good index and asks with no redirect and a deadline", async () => {
    const { fetch, asked } = fetcher(() => new Response(INDEX_LINE));
    const versions = await cratesIoIndex(fetch, LIMITS).versions("tidy");
    assert.equal(versions?.[0]?.vers, "1.0.0");
    assert.equal(asked[0]?.init?.redirect, "error");
    assert.ok(asked[0]?.init?.signal, "a deadline");
  });

  it("answers null for a crate the index does not have", async () => {
    const { fetch } = fetcher(() => new Response("", { status: 404 }));
    assert.equal(await cratesIoIndex(fetch, LIMITS).versions("tidy"), null);
  });

  it("refuses every hostile answer typed", async () => {
    const rows: Array<[string, () => Response, string]> = [
      [
        "a stalled body",
        () => new Response(body(new TextEncoder().encode(INDEX_LINE), { stall: true })),
        CrateFetchRefusal.Timeout,
      ],
      [
        "an oversize body",
        () => new Response(body(new Uint8Array(LIMITS.indexMaxBytes * 3).fill(0x61))),
        CrateFetchRefusal.TooLarge,
      ],
      [
        "an oversize declared length",
        () => new Response("x", { headers: { "content-length": String(10 * 1024 * 1024) } }),
        CrateFetchRefusal.TooLarge,
      ],
      ["a server error", () => new Response("", { status: 500 }), CrateFetchRefusal.Status],
      [
        "a redirect",
        () => new Response("", { status: 302, headers: { location: "https://evil.example/" } }),
        CrateFetchRefusal.Status,
      ],
      ["an index that is not UTF-8", () => new Response(new Uint8Array([0xff, 0xfe, 0x00])), CrateFetchRefusal.NotUtf8],
    ];
    for (const [why, make, code] of rows) {
      const { fetch } = fetcher(make);
      assert.equal(await refusalOf(cratesIoIndex(fetch, LIMITS).versions("tidy")), code, why);
    }
  });

  it("refuses a fetch that never answers at its deadline", async () => {
    const never = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof globalThis.fetch;
    assert.equal(await refusalOf(cratesIoIndex(never, LIMITS).versions("tidy")), CrateFetchRefusal.Timeout);
  });
});

describe("the crates.io archive download", () => {
  it("writes a good archive", async () => {
    const dir = await tmpDir("crate-fetch-");
    const file = path.join(dir, "tidy-1.0.0.crate");
    const { fetch, asked } = fetcher(() => new Response(new Uint8Array([1, 2, 3])));
    await cratesIoDownload(fetch, LIMITS)({ name: "tidy", version: "1.0.0" }, file);
    assert.equal((await lstat(file)).size, 3);
    assert.equal(asked[0]?.init?.redirect, "error");
  });

  it("refuses every hostile answer typed and writes nothing", async () => {
    const rows: Array<[string, () => Response, string]> = [
      ["a stalled body", () => new Response(body(new Uint8Array(10), { stall: true })), CrateFetchRefusal.Timeout],
      [
        "an oversize body",
        () => new Response(body(new Uint8Array(LIMITS.archiveMaxBytes * 2))),
        CrateFetchRefusal.TooLarge,
      ],
      ["a not-found", () => new Response("", { status: 404 }), CrateFetchRefusal.Status],
      [
        "a redirect",
        () => new Response("", { status: 301, headers: { location: "http://x/" } }),
        CrateFetchRefusal.Status,
      ],
    ];
    for (const [why, make, code] of rows) {
      const dir = await tmpDir("crate-fetch-");
      const file = path.join(dir, "tidy-1.0.0.crate");
      const { fetch } = fetcher(make);
      assert.equal(
        await refusalOf(cratesIoDownload(fetch, LIMITS)({ name: "tidy", version: "1.0.0" }, file)),
        code,
        why,
      );
      assert.equal(
        await lstat(file).then(
          () => true,
          () => false,
        ),
        false,
        `${why}: nothing written`,
      );
    }
  });
});

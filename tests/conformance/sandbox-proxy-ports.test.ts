/**
 * The Windows sandbox's network proxies bind inside srt-win's loopback range (60080-60089 unless
 * the install said otherwise): its egress filter lets the sandbox user reach only those ports.
 * Windows refuses a port there with EACCES, not EADDRINUSE, when Hyper-V, WSL, Docker or an
 * administrator reserved it (`netsh int ipv4 show excludedportrange protocol=tcp`), and SRT gave up
 * on the first such port, so the agents never started. These drive SRT's own `listenInRange`, as
 * Genex's patch leaves it, over a server whose refusals the test decides.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "dist");
const { listenInRange } = await import(pathToFileURL(path.join(dist, "sandbox/listen-in-range.js")).href);

const RANGE: [number, number] = [60080, 60089];

/** A server whose `listen` fails with the code `refusals` gives a port, and binds any other. */
function fakeServer(refusals: ReadonlyMap<number, string>) {
  const server = new EventEmitter();
  const tried: number[] = [];
  let bound: number | undefined;
  const listen = (port: number) => {
    tried.push(port);
    const code = refusals.get(port);
    queueMicrotask(() => {
      if (!code) {
        bound = port;
        server.emit("listening");
        return;
      }
      const error: NodeJS.ErrnoException = new Error(`listen ${code}: 127.0.0.1:${port}`);
      error.code = code;
      server.emit("error", error);
    });
  };
  return { server, listen, tried, bound: () => bound };
}

/** Every port from `from` to `to`, refused with `code`. */
function refuse(from: number, to: number, code: string): Map<number, string> {
  const ports = new Map<number, string>();
  for (let port = from; port <= to; port++) ports.set(port, code);
  return ports;
}

describe("Windows sandbox proxy ports", () => {
  const cases = [
    { name: "a reserved first port (EACCES)", refusals: refuse(60080, 60080, "EACCES"), bound: 60081 },
    { name: "a port another program holds (EADDRINUSE)", refusals: refuse(60080, 60080, "EADDRINUSE"), bound: 60081 },
    {
      name: "reserved and held ports mixed",
      refusals: new Map([...refuse(60080, 60083, "EACCES"), [60084, "EADDRINUSE"]]),
      bound: 60085,
    },
    { name: "every port but the last reserved", refusals: refuse(60080, 60088, "EACCES"), bound: 60089 },
  ];
  for (const { name, refusals, bound } of cases) {
    it(`binds the next port in the range past ${name}`, async () => {
      const fake = fakeServer(refusals);
      await listenInRange(fake.server, fake.listen, RANGE, new Set());
      assert.equal(fake.bound(), bound);
    });
  }

  it("fails with the refusal's code when Windows reserved the whole range", async () => {
    const fake = fakeServer(refuse(60080, 60089, "EACCES"));
    await assert.rejects(listenInRange(fake.server, fake.listen, RANGE, new Set()), { code: "EACCES" });
    assert.equal(fake.tried.length, 10, "each port of the range is tried once");
  });

  it("stops at once on an error that is not a refused port", async () => {
    const fake = fakeServer(refuse(60080, 60080, "EINVAL"));
    await assert.rejects(listenInRange(fake.server, fake.listen, RANGE, new Set()), { code: "EINVAL" });
    assert.deepEqual(fake.tried, [60080]);
  });
});

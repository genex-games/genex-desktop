/**
 * The address a person types for their own model server: read into the base URL the engine
 * calls, and accepted only when every address it names is on this computer or the local network.
 * A refused address is never asked anything: the lookup below is the only way out, and the
 * hostile table asserts what it was asked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AddressProblem,
  isLocalIp,
  localServerAddress,
  readServerAddress,
} from "../../src/substrate/local-server/address.ts";

/** A resolver that answers from a table and records every name it was asked. */
function resolver(table: Record<string, string[]>) {
  const asked: string[] = [];
  const lookup = async (host: string) => {
    asked.push(host);
    const found = table[host];
    if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { asked, lookup };
}

describe("reading a typed server address", () => {
  const cases: Array<[string, string]> = [
    ["http://127.0.0.1:5000/v1", "http://127.0.0.1:5000/v1"],
    ["127.0.0.1:5000", "http://127.0.0.1:5000/v1"],
    ["localhost:1234", "http://localhost:1234/v1"],
    ["  http://localhost:8080/  ", "http://localhost:8080/v1"],
    ["http://127.0.0.1:5000/v1/", "http://127.0.0.1:5000/v1"],
    ["http://127.0.0.1:5000/v1/chat/completions", "http://127.0.0.1:5000/v1"],
    ["http://127.0.0.1:5000/v1/models", "http://127.0.0.1:5000/v1"],
    ["http://192.168.1.20:5001/api/v1", "http://192.168.1.20:5001/api/v1"],
    ["https://gpu-box.local:8443/v1", "https://gpu-box.local:8443/v1"],
    ["HTTP://LOCALHOST:5000/V1", "http://localhost:5000/V1"],
    ["http://[::1]:8000", "http://[::1]:8000/v1"],
  ];
  for (const [typed, base] of cases)
    it(`reads ${JSON.stringify(typed)} as ${base}`, () => {
      const read = readServerAddress(typed);
      assert.equal(read.ok, true, JSON.stringify(read));
      if (read.ok) assert.equal(read.baseUrl, base);
    });

  it("reads the listen-on-everything address a server prints as this computer", () => {
    const read = readServerAddress("http://0.0.0.0:5000");
    assert.ok(read.ok);
    assert.equal(read.baseUrl, "http://127.0.0.1:5000/v1");
    const six = readServerAddress("http://[::]:5000/v1");
    assert.ok(six.ok);
    assert.equal(six.baseUrl, "http://[::1]:5000/v1");
  });
});

describe("hostile and malformed addresses (nothing is looked up, nothing is reached)", () => {
  const refused: Array<[unknown, AddressProblem]> = [
    ["", AddressProblem.Empty],
    ["   ", AddressProblem.Empty],
    [undefined, AddressProblem.Empty],
    [42, AddressProblem.Empty],
    ["file:///etc/passwd", AddressProblem.Scheme],
    ["javascript:alert(1)", AddressProblem.Scheme],
    ["ftp://127.0.0.1:21", AddressProblem.Scheme],
    ["ws://127.0.0.1:5000", AddressProblem.Scheme],
    ["http://user:secret@127.0.0.1:5000", AddressProblem.Credentials],
    ["http://:secret@127.0.0.1:5000", AddressProblem.Credentials],
    ["http://127.0.0.1:5000/v1?key=abc", AddressProblem.Malformed],
    ["http://127.0.0.1:5000/v1#models", AddressProblem.Malformed],
    ["http://127.0.0.1:99999", AddressProblem.Malformed],
    ["http://127.0.0.1:5000/v1\nHost: evil", AddressProblem.Malformed],
    ["http://127.0.0.1:5000/v 1", AddressProblem.Malformed],
    ["http://", AddressProblem.Malformed],
    [`http://127.0.0.1:5000/${"a".repeat(3000)}`, AddressProblem.Malformed],
  ];
  for (const [typed, problem] of refused)
    it(`refuses ${JSON.stringify(typed)?.slice(0, 60)} as ${problem}`, async () => {
      const read = readServerAddress(typed);
      assert.deepEqual(read, { ok: false, problem });
      const { asked, lookup } = resolver({});
      assert.deepEqual(await localServerAddress(typed, lookup), { ok: false, problem });
      assert.deepEqual(asked, [], "a refused address is never looked up");
    });

  const remote: Array<[string, Record<string, string[]>]> = [
    ["http://8.8.8.8:5000", {}],
    ["https://api.openai.com/v1", { "api.openai.com": ["104.18.33.45"] }],
    ["http://[2606:4700::1111]:80", {}],
    // A name that resolves to the network and to this computer at once is not local.
    ["http://split.example:5000", { "split.example": ["127.0.0.1", "93.184.215.14"] }],
    ["http://172.32.0.1:5000", {}],
    ["http://100.128.0.1:5000", {}],
    ["http://[::ffff:8.8.8.8]:5000", {}],
  ];
  for (const [typed, table] of remote)
    it(`refuses ${typed}: not on this computer or the local network`, async () => {
      const { lookup } = resolver(table);
      assert.deepEqual(await localServerAddress(typed, lookup), { ok: false, problem: AddressProblem.NotLocal });
    });

  it("says a name it cannot find is not found, rather than not local", async () => {
    const { asked, lookup } = resolver({});
    assert.deepEqual(await localServerAddress("http://gpu-box:5000", lookup), {
      ok: false,
      problem: AddressProblem.NotFound,
    });
    assert.deepEqual(asked, ["gpu-box"]);
  });
});

describe("local addresses", () => {
  it("accepts this computer, the private ranges, link-local and a tailnet", async () => {
    const { asked, lookup } = resolver({
      "gpu-box.local": ["192.168.1.20", "fe80::1"],
      "gpu.tail.ts.net": ["100.101.1.2"],
    });
    for (const typed of [
      "http://127.0.0.1:5000",
      "http://10.0.0.5:5000",
      "http://172.16.4.2:1234",
      "http://172.31.255.255:1234",
      "http://192.168.0.10:8080",
      "http://169.254.10.1:5000",
      "http://[fd12:3456::1]:5000",
      "http://[::ffff:192.168.1.2]:5000",
      "http://gpu-box.local:5000",
      "http://gpu.tail.ts.net:5000",
    ]) {
      const found = await localServerAddress(typed, lookup);
      assert.equal(found.ok, true, `${typed}: ${JSON.stringify(found)}`);
    }
    assert.deepEqual(asked, ["gpu-box.local", "gpu.tail.ts.net"], "only names are looked up; numbers are read");
  });

  it("knows the local ranges by number", () => {
    for (const ip of [
      "127.0.0.1",
      "127.9.9.9",
      "10.255.0.1",
      "172.20.0.1",
      "192.168.255.1",
      "169.254.0.1",
      "100.64.0.1",
    ])
      assert.equal(isLocalIp(ip), true, ip);
    for (const ip of ["::1", "fc00::1", "fdff::1", "fe80::abcd", "::ffff:10.0.0.1"])
      assert.equal(isLocalIp(ip), true, ip);
    for (const ip of [
      "8.8.8.8",
      "172.15.0.1",
      "192.169.0.1",
      "100.63.255.255",
      "1.1.1.1",
      "2001:db8::1",
      "::ffff:1.1.1.1",
    ])
      assert.equal(isLocalIp(ip), false, ip);
    assert.equal(isLocalIp("not an address"), false);
  });
});

/**
 * Publish's warning for a game that calls an AI vendor directly (D5): the host's export answer names
 * the vendor hosts its files reach, and Publish shows one line naming them and pointing at genex-ai.
 * The answer crosses the plugin boundary, so anything that is not a host list reads as no warning.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aiDirectWarning, MESSAGE } from "../../src/plugins/genex/publish.ts";

const host = (name: string) => ({ file: "src/main.js", host: name, vendor: "openai" });

describe("aiDirectWarning", () => {
  it("names the hosts a build reaches and points at genex-ai", () => {
    const line = aiDirectWarning({ aiDirect: { hosts: [host("api.openai.com")], hint: "use genex-ai" } });
    assert.equal(line, MESSAGE.AiDirect(["api.openai.com"], 0));
    assert.match(line ?? "", /api\.openai\.com/);
    assert.match(line ?? "", /genex-ai/);
  });

  it("names at most three hosts and counts the rest", () => {
    const hosts = ["a.openai.com", "b.openai.com", "c.openai.com", "d.openai.com", "e.openai.com"].map(host);
    assert.equal(
      aiDirectWarning({ aiDirect: { hosts, hint: "" } }),
      MESSAGE.AiDirect(["a.openai.com", "b.openai.com", "c.openai.com"], 2),
    );
  });

  const none: Array<[string, unknown]> = [
    ["no export answer", null],
    ["an answer without the field", { files: 2 }],
    ["an empty host list", { aiDirect: { hosts: [], hint: "" } }],
    ["hosts that are not a list", { aiDirect: { hosts: "api.openai.com" } }],
    ["a host that is not a hostname", { aiDirect: { hosts: [host("api.openai.com/<script>")] } }],
    ["a host that is not text", { aiDirect: { hosts: [{ host: 7 }] } }],
    ["an overlong host", { aiDirect: { hosts: [host(`${"a".repeat(300)}.openai.com`)] } }],
  ];
  for (const [name, exported] of none)
    it(`reads ${name} as no warning`, () => {
      assert.equal(aiDirectWarning(exported), null);
    });
});

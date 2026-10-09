/**
 * Settings → Model Providers: a long Older models list (OpenRouter's hundreds) can be searched by
 * the words of a model's name or id, in any order and any case.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchingModels, offersSearch } from "../../src/renderer/panels/picker-search.ts";

const rows = [
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
  { id: "google/gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "qwen/qwen3-coder", name: "Qwen3 Coder" },
];
const ids = (query: string) => matchingModels(rows, query).map((row) => row.id);

describe("searching a provider's older models", () => {
  it("matches every word of the query against the name or the id, in any case or order", () => {
    assert.deepEqual(ids("sonnet 4"), ["anthropic/claude-sonnet-4.5"]);
    assert.deepEqual(ids("CLAUDE"), ["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-5.5"]);
    assert.deepEqual(ids("google"), ["google/gemini-3.1-pro"], "the vendor is in the id, not the name");
    assert.deepEqual(ids("coder qwen"), ["qwen/qwen3-coder"]);
    assert.deepEqual(ids("gpt"), []);
  });

  it("keeps the whole list for an empty or blank query", () => {
    assert.equal(ids("").length, rows.length);
    assert.equal(ids("   ").length, rows.length);
  });

  it("offers a search only when the list is too long to scan", () => {
    assert.equal(offersSearch(8), false);
    assert.equal(offersSearch(32), true);
    assert.equal(offersSearch(390), true);
  });
});

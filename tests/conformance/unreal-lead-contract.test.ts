/**
 * The Unreal lead's run tools as its engine is offered them: one spec per `LeadTool`, with the flat
 * string arguments both bridges carry.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LeadTool } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { LEAD_TOOLS } from "../../src/harness-seed/loop/unreal/lead-tools.ts";

describe("the Unreal lead's run tools", () => {
  it("offers the session exactly its run tools, each once", () => {
    assert.deepEqual(LEAD_TOOLS.map((tool) => tool.name).sort(), Object.values(LeadTool).sort());
  });

  it("takes every argument as a flat string, and requires only arguments it describes", () => {
    for (const tool of LEAD_TOOLS) {
      const properties = tool.parameters.properties ?? {};
      for (const [name, property] of Object.entries(properties))
        assert.equal(property.type, "string", `${tool.name}.${name} is a string`);
      for (const name of tool.parameters.required ?? []) assert.ok(name in properties, `${tool.name} requires ${name}`);
    }
  });
});

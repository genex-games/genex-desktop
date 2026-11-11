import { piContext } from "../../src/substrate/engines/pi-completions.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  describeWithSchema,
  exposedToolName,
  flatParameters,
  zodShapeFromJsonSchema,
} from "../../src/substrate/engines/tool-schema.ts";

const nested = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "string" }, description: "labels" },
    count: { type: "integer" },
    mode: { type: "string", enum: ["a", "b"] },
  },
  required: ["items"],
  additionalProperties: false,
};

test("a real MCP schema becomes a zod shape that accepts nested arguments and refuses wrong ones", () => {
  const shape = zodShapeFromJsonSchema(nested, z);
  assert.deepEqual(Object.keys(shape).sort(), ["count", "items", "mode"]);
  const object = z.object(shape);
  assert.equal(object.safeParse({ items: ["x"], count: 2, mode: "a" }).success, true);
  assert.equal(object.safeParse({ items: ["x"], count: "2" }).success, false);
  assert.equal(object.safeParse({ items: ["x"], mode: "z" }).success, false);
  assert.equal(object.safeParse({ count: 2 }).success, false, "a required property stays required");
});

test("local $defs and $ref resolve; an empty schema is an empty shape", () => {
  const shape = zodShapeFromJsonSchema(
    {
      type: "object",
      $defs: { Point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
      properties: { point: { $ref: "#/$defs/Point" } },
      required: ["point"],
    },
    z,
  );
  const object = z.object(shape);
  assert.equal(object.safeParse({ point: { x: 1 } }).success, true);
  assert.equal(object.safeParse({ point: {} }).success, false);
  assert.deepEqual(zodShapeFromJsonSchema({ type: "object" }, z), {});
  assert.deepEqual(zodShapeFromJsonSchema(undefined, z), {});
});

test("a schema zod cannot build stays callable: unknown per declared property, schema in the description", () => {
  const remote = {
    type: "object",
    properties: { a: { $ref: "https://example.com/a.json", description: "somewhere else" }, b: { type: "string" } },
    required: ["a"],
  };
  const shape = zodShapeFromJsonSchema(remote, z);
  assert.deepEqual(Object.keys(shape).sort(), ["a", "b"]);
  const object = z.object(shape);
  assert.equal(object.safeParse({ a: { deeply: { nested: true } } }).success, true, "the tool is still callable");
  assert.equal(object.safeParse({ b: "only" }).success, false, "required stays required in the fallback");
  const described = describeWithSchema("Do a thing", remote);
  assert.match(described, /^Do a thing/);
  assert.match(described, /Arguments: JSON matching/);
  assert.match(described, /example\.com/);
  assert.equal(describeWithSchema("Do a thing", undefined), "Do a thing");
});

test("the flat projection keeps types, descriptions and required for consumers that read nothing else", () => {
  assert.deepEqual(flatParameters(nested), {
    type: "object",
    properties: {
      items: { type: "array", description: "labels" },
      count: { type: "integer" },
      mode: { type: "string", description: "One of: a, b." },
    },
    required: ["items"],
  });
  assert.deepEqual(flatParameters({ type: "object", properties: { odd: { type: "null" } }, required: ["missing"] }), {
    type: "object",
    properties: { odd: { type: "string" } },
  });
  assert.deepEqual(flatParameters("not a schema"), { type: "object", properties: {} });
});

test("a tool name an engine would refuse is sanitised, and never becomes empty", () => {
  assert.equal(exposedToolName("weird.name/x"), "weird_name_x");
  assert.equal(exposedToolName("plain_tool-1"), "plain_tool-1");
  assert.equal(exposedToolName("..."), "tool");
  assert.equal(exposedToolName("x".repeat(80)).length, 48);
});

test("piContext drops acceptJsonString from tool parameter schemas", () => {
  const context = piContext({
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        parameters: {
          type: "object",
          acceptJsonString: true,
          properties: {
            code: { type: "string", acceptJsonString: false },
          },
        },
      },
    ],
  });
  const tool = (context.tools as Array<{ name: string; parameters: Record<string, unknown> }>)?.[0];
  assert.equal(tool?.name, "test_tool");
  assert.equal("acceptJsonString" in (tool?.parameters ?? {}), false);
  const props = tool?.parameters?.properties as Record<string, unknown>;
  assert.equal("acceptJsonString" in ((props?.code as Record<string, unknown>) ?? {}), false);
  assert.equal((props?.code as Record<string, unknown>)?.type, "string");
});

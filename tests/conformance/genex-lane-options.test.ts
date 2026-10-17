/**
 * Each Genex lane takes its own options. The asset tool's description tells the agent which ones
 * each operation takes, the host accepts exactly those, and a refusal names the ones the lane does
 * take, before any job folder or CLI call exists.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { GenexTools, validateGenexRequest } from "../../src/plugins/genex/adapter.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const manifest: PluginManifest = validateManifest(
  JSON.parse(await readFile(path.resolve("src/plugins/genex/plugin.json"), "utf8")),
);
const assetTool = manifest.tools.find((tool) => tool.name === "asset");
/** Where the options description starts listing operations. */
const BY_OPERATION = "By operation: ";
/** The operations the host answers itself, which take no CLI options. */
const HOST_OPERATIONS = ["status", "inspect_use", "verify_use"];

/** The options description's `operation: key (note), key; …` list, as operation → keys. */
function documentedOptions(): Map<string, string[]> {
  const text = String(assetTool?.parameters.properties.options?.description ?? "");
  const start = text.indexOf(BY_OPERATION);
  assert.ok(start >= 0, "the options description lists options by operation");
  const lanes = new Map<string, string[]>();
  for (const entry of text
    .slice(start + BY_OPERATION.length)
    .replace(/\.$/, "")
    .split("; ")) {
    const [operation = "", keys = ""] = entry.split(": ");
    const names = keys
      .replace(/\([^)]*\)/g, "")
      .split(",")
      .map((key) => key.trim());
    lanes.set(
      operation,
      names.filter((key) => key && key !== "none"),
    );
  }
  return lanes;
}

/** The refusal's list of what the lane takes, as keys. */
function namedInRefusal(error: unknown, operation: string): string[] {
  const message = (error as Error).message;
  const takes = new RegExp(`${operation.replace(".", "\\.")} takes: ([^.]+)\\.`).exec(message);
  return (takes?.[1] ?? "")
    .split(", ")
    .map((key) => key.trim())
    .filter(Boolean);
}

/** The refusal `validateGenexRequest` throws for this request. */
function refusal(request: Parameters<typeof validateGenexRequest>[0]): Error {
  try {
    validateGenexRequest(request);
  } catch (error) {
    return error as Error;
  }
  assert.fail(`${JSON.stringify(request)} was accepted`);
}

describe("Genex options by lane", () => {
  it("documents an option list for every CLI operation the tool names", () => {
    const named = /Operations: (.+)$/.exec(assetTool?.description ?? "")?.[1]?.split(", ") ?? [];
    assert.ok(named.length > 20, "the description names its operations");
    const documented = documentedOptions();
    for (const operation of named.filter((op) => !HOST_OPERATIONS.includes(op)))
      assert.ok(documented.has(operation), `${operation} has a documented option list`);
  });

  it("accepts every option the description lists for a lane, and refuses another by naming exactly those", () => {
    for (const [operation, keys] of documentedOptions()) {
      for (const key of keys) validateGenexRequest({ operation, prompt: "fixture", options: { [key]: true } });
      const refused = refusal({ operation, prompt: "fixture", options: { provider: "meshy" } });
      assert.match(
        refused.message,
        new RegExp(`^Unsupported Genex option for ${operation.replace(".", "\\.")}: provider`),
      );
      assert.deepEqual(namedInRefusal(refused, operation).sort(), [...keys].sort(), operation);
      if (!keys.length) assert.match(refused.message, /takes no options/, operation);
    }
  });

  it("refuses options that belong to another lane, or that Studio runs for the agent", () => {
    const rows: Array<[string, Record<string, unknown>, RegExp]> = [
      ["model", { provider: "meshy" }, /no provider option.*model lane is Tripo.*Meshy/s],
      ["texture", { noWait: true }, /without waiting.*operation wait/s],
      ["texture", { wait: false }, /without waiting.*operation wait/s],
      ["model", { terrain: true }, /model takes: .*auto-size/],
      ["music", { loop: true }, /music takes: duration\./],
      ["image", { glass: true }, /image takes: /],
      ["creature", { "direct-text": true }, /creature takes: /],
      ["creature.animate", { action: "Left Slash" }, /creature\.animate takes: .*locomotion/],
      ["wait", { timeout: 30 }, /wait takes no options/],
      ["sfx", { animation: ["walk"] }, /sfx takes: duration, loop\./],
      [
        "texture",
        { constructor: true },
        /^Unsupported Genex option for texture: constructor\. texture takes: terrain\.$/,
      ],
    ];
    for (const [operation, options, expected] of rows)
      assert.match(refusal({ operation, prompt: "fixture", options: options as never }).message, expected, operation);
  });

  it("takes the options that size a model, shape a sound and cast a creature", () => {
    validateGenexRequest({ operation: "model", prompt: "x", options: { "auto-size": true, "face-limit": 20000 } });
    validateGenexRequest({ operation: "model", prompt: "x", options: { "low-poly": true, texture: "standard" } });
    validateGenexRequest({ operation: "sfx", prompt: "x", options: { duration: 12, loop: true } });
    validateGenexRequest({
      operation: "creature",
      prompt: "x",
      options: { polycount: 20000, height: 2.4, pose: "t-pose", animation: ["Left Slash", 466] },
    });
    validateGenexRequest({ operation: "character", prompt: "x", options: { "direct-text": true } });
    validateGenexRequest({ operation: "creature.animate", id: "existing", options: { locomotion: true, lean: true } });
  });

  it("refuses an option value that is not a scalar, naming the option", () => {
    assert.match(refusal({ operation: "model", options: { "face-limit": { n: 1 } as never } }).message, /face-limit/);
  });

  it("an unsupported option leaves no job and makes no call to Genex", async () => {
    const root = await tmpDir("studio-genex-lanes-");
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      let token: string | null = "fixture-token";
      const credentials = {
        get: async () => token,
        set: async (next: string) => {
          token = next;
        },
        clear: async () => {
          token = null;
        },
      };
      const tools = new GenexTools(path.join(root, "host"), api, { credentials });
      await tools.init();
      const game = path.join(root, "game");
      await assert.rejects(
        tools.execute("game", game, { operation: "model", prompt: "x", options: { provider: "meshy" } }),
        /Unsupported Genex option for model: provider/,
      );
      const jobs = await readdir(path.join(tools.root, "projects", "game", "jobs")).catch(() => []);
      assert.deepEqual(jobs, [], "no job folder");
      assert.deepEqual(calls, [], "no request reached Genex");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

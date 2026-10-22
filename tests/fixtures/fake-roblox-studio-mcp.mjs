#!/usr/bin/env node
/**
 * A stand-in for Roblox Studio's `StudioMCP`: newline-delimited JSON-RPC over stdio, answering as
 * server "RobloxStudio" with the tools of `roblox-studio/tools.json` (names, arguments and required
 * arguments only). Like the real one it checks what Genex must send: a listed `studio_id` on every
 * call but `list_roblox_studios`, a `datamodel_type` from the tool's enum, and a `capture_id` on
 * `screen_capture`, which answers a small JPEG.
 *
 * Flags: `--log <file>` appends one JSON line at start (`{start: {home, pid}}`, the HOME it was
 * started with) and one per tool call (`{tool, args}`); `--no-studio` never lists a Studio;
 * `--late-studio <ms>` lists none until that long after start; `--crash-after <n>` exits on the
 * n-th tool call without answering it; `--big-shot` answers `screen_capture` with a 1.2 MB JPEG;
 * `--studios <json>` lists those Studios (default one, `studio-1` named Place1); `--lose-after <n>`
 * lists them for its first n lists only, as a StudioMCP that reached Studio through another one
 * loses it when that one ends; `--extra-tool
 * <name>` (repeatable) lists one more tool, unknown to Genex, that answers like any other;
 * `--no-init` never answers `initialize`.
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const logFile = flag("--log");
const startedAt = Date.now();
const lateMs = Number(flag("--late-studio") ?? 0);
const crashAfter = Number(flag("--crash-after") ?? 0);
const extraTools = argv.flatMap((arg, index) => (arg === "--extra-tool" ? [argv[index + 1]] : []));
const loseAfter = Number(flag("--lose-after") ?? 0);
let lists = 0;
const studios = argv.includes("--no-studio")
  ? []
  : JSON.parse(flag("--studios") ?? JSON.stringify([{ id: "studio-1", name: "Place1" }]));

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(path.join(here, "roblox-studio", "tools.json"), "utf8"));
const tools = contract.tools.map((tool) => ({ ...tool, description: `Stand-in for ${tool.name}.` }));
for (const extraTool of extraTools)
  tools.push({
    name: extraTool,
    description: "A tool Genex has no class for.",
    inputSchema: { type: "object", properties: { studio_id: { type: "string" } }, required: ["studio_id"] },
  });

const log = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
log({ start: { home: process.env.HOME ?? null, pid: process.pid } });

/** A JPEG of `size` bytes: start and end markers around filler. */
function jpeg(size) {
  const bytes = Buffer.alloc(size, 0x20);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes.toString("base64");
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const failed = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
const listed = () => (Date.now() - startedAt >= lateMs && !(loseAfter && lists > loseAfter) ? studios : []);

/** What the real server refuses, as a failed call; undefined when the call is well formed. */
function refusal(tool, args) {
  for (const name of tool.inputSchema.required ?? [])
    if (args[name] === undefined) return `Missing required argument: ${name}`;
  if (args.studio_id !== undefined && !listed().some((studio) => studio.id === args.studio_id))
    return `No Studio with id ${args.studio_id}`;
  const allowed = tool.inputSchema.properties?.datamodel_type?.enum;
  if (allowed && args.datamodel_type !== undefined && !allowed.includes(args.datamodel_type))
    return `datamodel_type must be one of ${allowed.join(", ")}`;
  return undefined;
}

let calls = 0;
function answer(name, args) {
  if (name === "list_roblox_studios") {
    lists++;
    return text({ studios: listed() });
  }
  const tool = tools.find((each) => each.name === name);
  if (!tool) return failed(`Unknown tool ${name}`);
  const refused = refusal(tool, args);
  if (refused) return failed(refused);
  if (name === "screen_capture") {
    const data = jpeg(argv.includes("--big-shot") ? 1_200_000 : 2_000);
    return { content: [{ type: "image", data, mimeType: "image/jpeg" }] };
  }
  if (name === "execute_luau") return text("4");
  return text({ tool: name, ok: true });
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize" && argv.includes("--no-init")) return;
  if (message.method === "initialize")
    return send({
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "RobloxStudio", version: "0.743" },
      },
    });
  if (message.method === "tools/list") return send({ id: message.id, result: { tools } });
  if (message.method !== "tools/call")
    return send({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
  const { name, arguments: args = {} } = message.params ?? {};
  calls++;
  log({ tool: name, args });
  if (crashAfter && calls >= crashAfter) process.exit(3);
  send({ id: message.id, result: answer(name, args) });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  handle(JSON.parse(line));
});
process.stdin.on("end", () => process.exit(0));

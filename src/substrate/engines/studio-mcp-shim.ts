/**
 * The studio's tools as a stdio MCP server, for a contractor that takes MCP servers in its own
 * config but cannot be handed the studio's in-process one (OpenCode). The contractor starts
 * `node .studio/bridge/mcp.mjs` itself, as a child inside its own sandbox; the shim speaks MCP on
 * stdio and relays every call over the file bridge the studio already answers (`studio-bridge.ts`)
 * — no port, no network, no new way in. What comes back is MCP content: the answer's text, and
 * the pictures the studio saved into `res/` as image content, so the model sees them inline.
 *
 * Deliberately dependency-free: it runs under whatever `node` the contractor's sandbox has.
 */

/** The shim's file name in the bridge folder. */
export const MCP_SHIM_FILE = "mcp.mjs";

/** The MCP server name the contractor knows the studio's tools under (`studio_<tool>` in OpenCode). */
export const MCP_SERVER_NAME = "studio";

/**
 * The shim. Reads newline-delimited JSON-RPC on stdin, answers on stdout. A call is a request file
 * written into `req/` exactly as `tool.mjs` writes one, then the answer read from `res/`; a picture
 * is read only when the answer names a plain file in `res/` with an image type, and only up to a cap.
 */
export const MCP_SHIM_SOURCE = `#!/usr/bin/env node
/* Studio MCP shim — written by the studio for one session, deleted when the session ends. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "tools.json"), "utf8"));
const known = new Map(manifest.map((t) => [t.name, t]));
const resDir = path.join(here, "res");
const reqDir = path.join(here, "req");
const POLL_MS = 100;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PLAIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const timeoutMs = Number(process.env.STUDIO_TOOL_TIMEOUT_MS || 600000);

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function textResult(text, isError) {
  return { content: [{ type: "text", text }], isError };
}

/* A picture the answer names, read only from res/ itself: a plain name, an image type, under the cap. */
function picture(item) {
  if (!item || typeof item !== "object") return null;
  const { file, mimeType } = item;
  if (typeof file !== "string" || !PLAIN_FILE.test(file) || !IMAGE_TYPES.has(mimeType)) return null;
  const full = path.join(resDir, file);
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    return { type: "image", data: fs.readFileSync(full).toString("base64"), mimeType };
  } catch {
    return null;
  }
}

async function call(name, args) {
  if (!known.has(name)) {
    return textResult("no studio tool called '" + name + "'. Available: " + [...known.keys()].join(", "), true);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return textResult("'" + name + "' takes its arguments as one JSON object", true);
  }
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  fs.mkdirSync(reqDir, { recursive: true });
  const tmp = path.join(reqDir, id + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify({ id, name, args }));
  fs.renameSync(tmp, path.join(reqDir, id + ".json"));
  const answer = path.join(resDir, id + ".json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(answer)) {
      const body = JSON.parse(fs.readFileSync(answer, "utf8"));
      const pictures = Array.isArray(body.images) ? body.images.map(picture).filter(Boolean) : [];
      return { content: [{ type: "text", text: String(body.text ?? "") }, ...pictures], isError: body.ok === false };
    }
    await sleep(POLL_MS);
  }
  return textResult("the studio did not answer '" + name + "' in time — carry on without it", true);
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return; /* a notification: nothing to answer */
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "studio", version: "1" },
      },
    });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") {
    const tools = manifest.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? t.parameters }));
    return send({ id, result: { tools } });
  }
  if (method === "tools/call") {
    const result = await call(params?.name, params?.arguments ?? {}).catch((err) =>
      textResult("'" + params?.name + "' failed: " + (err?.message ?? err), true),
    );
    return send({ id, result });
  }
  send({ id, error: { code: -32601, message: "method not found: " + method } });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim() || line.length > MAX_LINE) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  void handle(message);
});
lines.on("close", () => process.exit(0));
`;

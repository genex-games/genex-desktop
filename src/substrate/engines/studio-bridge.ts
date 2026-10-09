/**
 * Studio tools for a contractor that has no in-process MCP — the Codex path.
 *
 * Claude Code gets the studio's tools as an SDK MCP server the studio hosts inside its own
 * process. Codex cannot be given that: `codex exec` auto-denies every MCP tool call, because a
 * non-interactive session has nobody to show the approval prompt to, and the only documented
 * way round it is `--dangerously-bypass-approvals-and-sandbox` — trading the contractor's OS
 * sandbox for a checkpoint button, which is not a trade worth making.
 *
 * So the tools arrive the way everything else in a build arrives: as a command the contractor
 * runs. `.studio/bridge/tool.mjs` writes one request file inside the workspace (which the
 * sandbox lets it write) and blocks until the studio — a different process, outside the sandbox
 * — drops the answer beside it. From the model's side it reads exactly like a tool call:
 *
 *     node .studio/bridge/tool.mjs capture --cameras=hero
 *     → saved 2 frames: run/.../hero.png, run/.../wide.png
 *
 * The whole directory is created for one delegation and deleted after it, so a workspace never
 * carries the bridge into a snapshot.
 */
import { constants } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DelegateRequest, LiveToolResult } from "./types.ts";
import { DelegateEventType } from "./types.ts";
import { CHECKPOINT_NOTE_CHARS } from "./common.ts";
import { CHECKPOINT_TOOL, CODEX_CAPTURE_TOOL, intakeToolReply, StudioTool } from "./studio-tool-prompts.ts";
import { captureArgs } from "./capture-args.ts";
import { openNoFollow, readRegularFile } from "../fsx.ts";
import { schemaType } from "./tool-schema.ts";
import { MCP_SHIM_FILE, MCP_SHIM_SOURCE } from "./studio-mcp-shim.ts";
import { errorMessage } from "../../shared/errors.ts";

/** A request bigger than this is refused unread: arguments, not payloads, travel through req/. */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** How often the studio looks for new requests, unless the caller says otherwise. */
const DEFAULT_POLL_MS = 150;
/** An enum's type word lists at most this many of its choices. */
const ENUM_CHOICES_SHOWN = 8;
/** How deep an example argument nests before its arrays and objects are left empty. */
const EXAMPLE_DEPTH = 2;
/** What a tool's attached pictures are called when the tool gave them no label. */
const DEFAULT_IMAGE_LABEL = "Tool observation";
/** What the contractor is told to do with a tool's pictures. */
const IMAGE_GUIDANCE = "Open these exact image files before judging this tool observation.";

/** Why the bridge refuses to open. */
const MESSAGE = {
  NotPlainFolder: (dir: string) => `the studio bridge will not open: ${dir} is not a plain folder`,
} as const;

/** The file extension a tool's picture is saved with. */
function imageExtension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

export interface BridgeTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  /**
   * The tool's real JSON Schema when the flat `parameters` cannot express it (a connector's
   * arrays, enums and nested objects). Written into `tools.json` so the contractor can read the
   * whole shape, and pointed at from the instructions — a nested argument goes through `--json`,
   * because `--key=value` flags only ever produce strings.
   */
  inputSchema?: Record<string, unknown>;
}

export interface BridgeOptions {
  /**
   * Where the bridge directory goes, and the folder the contractor is started in — so
   * `node .studio/tool.mjs` resolves for it. Usually the workspace it builds in; for a session
   * that may not write to the build (the playtester) it is a scratch folder of its own, which is
   * then the only place its sandbox lets it write at all.
   */
  cwd: string;
  tools: BridgeTool[];
  /**
   * Runs in the studio's own process. A throw is reported to the contractor as text.
   *
   * The arguments are whatever arrived: strings from `--key=value` flags, or any JSON value the
   * contractor sent through `--json`. They are passed on untouched — the studio does not guess a
   * type the caller did not send, and a connector's own server is the thing that validates.
   */
  onCall: (name: string, args: Record<string, unknown>) => Promise<LiveToolResult>;
  /** Test seam: how often the studio looks for a new request. */
  pollMs?: number;
  /**
   * Also write the MCP shim (`studio-mcp-shim.ts`): a contractor that takes MCP servers in its own
   * config starts it and reaches the same tools, pictures inline, over this same bridge.
   */
  mcp?: boolean;
}

/** A picture an answer names for the MCP shim: a plain file in `res/`, and its type. */
interface AnswerImage {
  file: string;
  mimeType: string;
}

/** What an answer carries: the text the shim prints, and the pictures saved beside it. */
interface Answer {
  text: string;
  images: AnswerImage[];
}

/**
 * Where the bridge lives, relative to the folder the contractor runs in. Under `.studio/`,
 * which the workspace scaffolder already gitignores and file-ownership already permits — but in
 * a room of its own: `.studio/BRIEF.md` is the harness's per-iteration contract and the first
 * thing a builder is told to read, so clearing the bridge must never take the brief with it.
 */
export const BRIDGE_DIR = ".studio/bridge";

/**
 * The shim the contractor runs. Deliberately dependency-free and synchronous: it is spawned
 * inside someone else's sandbox, where the only thing we can count on is `node` and the
 * workspace being writable.
 */
export const SHIM_SOURCE = `#!/usr/bin/env node
/* Studio tool bridge — written by the studio for one build, deleted when the build ends. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* fileURLToPath, not URL.pathname: a workspace under "Application Support" has spaces, and the
   pathname keeps them percent-encoded — tools.json was never found from there. */
const here = path.dirname(fileURLToPath(import.meta.url));
const [, , name, ...rest] = process.argv;
const manifest = JSON.parse(fs.readFileSync(path.join(here, "tools.json"), "utf8"));
const known = manifest.map((t) => t.name);

if (!name || name === "--help" || name === "-h") {
  console.log("Studio tools:\\n" + manifest.map((t) => "  " + t.name + " — " + t.description).join("\\n"));
  process.exit(name ? 0 : 1);
}
if (!known.includes(name)) {
  console.error("no studio tool called '" + name + "'. Available: " + known.join(", "));
  process.exit(2);
}

/* --key=value, --key value, one --json '{"key":"value"}' object, or --json @args.json to read
   that object from a file — which is how a big or deeply nested payload avoids the shell. */
const args = {};
for (let i = 0; i < rest.length; i++) {
  const token = rest[i];
  if (!token.startsWith("--")) continue;
  const eq = token.indexOf("=");
  if (token === "--json" || (eq > 0 && token.slice(2, eq) === "json")) {
    const value = token === "--json" ? rest[++i] ?? "{}" : token.slice(eq + 1);
    const body = value.startsWith("@") ? fs.readFileSync(path.resolve(value.slice(1)), "utf8") : value;
    Object.assign(args, JSON.parse(body));
    continue;
  }
  if (eq > 0) args[token.slice(2, eq)] = token.slice(eq + 1);
  else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) args[token.slice(2)] = rest[++i];
  else args[token.slice(2)] = "true";
}

const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
fs.mkdirSync(path.join(here, "req"), { recursive: true });
fs.mkdirSync(path.join(here, "res"), { recursive: true });
/* Written beside the target and renamed, so the studio never reads a half-written request. */
const tmp = path.join(here, "req", id + ".tmp");
fs.writeFileSync(tmp, JSON.stringify({ id, name, args }));
fs.renameSync(tmp, path.join(here, "req", id + ".json"));

const answer = path.join(here, "res", id + ".json");
const deadline = Date.now() + Number(process.env.STUDIO_TOOL_TIMEOUT_MS || 600000);
const idle = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < deadline) {
  if (fs.existsSync(answer)) {
    const body = JSON.parse(fs.readFileSync(answer, "utf8"));
    console.log(body.text);
    process.exit(body.ok === false ? 1 : 0);
  }
  Atomics.wait(idle, 0, 0, 150);
}
console.error("the studio did not answer '" + name + "' in time — carry on without it");
process.exit(3);
`;

type JsonNode = Record<string, unknown>;

/** What the shim writes into `req/`. */
interface BridgeRequest {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

/**
 * A tool's text with its saved pictures named: merged into a JSON object answer, or appended
 * below any other text.
 */
function withImageFiles(text: string, imageFiles: Array<{ path: string; label: string }>): string {
  try {
    const body = JSON.parse(text);
    const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
    if (!isObject) throw new Error("not an object");
    return JSON.stringify({ ...body, imageFiles, imageGuidance: IMAGE_GUIDANCE });
  } catch {
    return `${text}\n${IMAGE_GUIDANCE}\n${JSON.stringify(imageFiles)}`;
  }
}

const node = (value: unknown): JsonNode =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonNode) : {};

/** The type word a contractor reads, taken from the schema rather than the flat projection. */
function typeName(schema: JsonNode): string {
  const choices = Array.isArray(schema.enum)
    ? schema.enum.filter((v) => typeof v === "string" || typeof v === "number")
    : [];
  if (choices.length) return `one of ${choices.slice(0, ENUM_CHOICES_SHOWN).join("|")}`;
  const raw = schemaType(schema);
  if (raw === "array") return `array of ${typeName(node(schema.items))}`;
  return raw ?? "any";
}

/**
 * One plausible value for a property, small enough to sit on a command line. The point is not a
 * complete example — it is showing the model that this tool is called with a JSON object.
 */
function exampleValue(schema: unknown, depth = 0): unknown {
  const shape = node(schema);
  const choices = Array.isArray(shape.enum) ? shape.enum : [];
  if (choices.length) return choices[0];
  const raw = schemaType(shape);
  if (raw === "integer" || raw === "number") return 1;
  if (raw === "boolean") return true;
  if (raw === "array") return depth >= EXAMPLE_DEPTH ? [] : [exampleValue(shape.items, depth + 1)];
  if (raw === "object") return exampleObject(shape, depth);
  return "text";
}

/** An example object: its required keys (or its first two), nested no deeper than the example allows. */
function exampleObject(shape: JsonNode, depth: number): JsonNode {
  if (depth >= EXAMPLE_DEPTH) return {};
  const properties = node(shape.properties);
  const required = Array.isArray(shape.required)
    ? shape.required.filter((k): k is string => typeof k === "string")
    : Object.keys(properties).slice(0, 2);
  const out: JsonNode = {};
  for (const key of required) if (key in properties) out[key] = exampleValue(properties[key], depth + 1);
  return out;
}

/** The classic line: a tool whose arguments are flat strings is called with flat flags. */
function flagLines(tool: BridgeTool): string {
  const flags = Object.entries(tool.parameters?.properties ?? {})
    .map(([key, prop]) => {
      const optional = !tool.parameters?.required?.includes(key);
      const slot = `--${key}=<${prop.description ? key : (prop.type ?? "text")}>`;
      return optional ? `[${slot}]` : slot;
    })
    .join(" ");
  const params = Object.entries(tool.parameters?.properties ?? {})
    .filter(([, prop]) => prop.description)
    .map(([key, prop]) => `      ${key}: ${prop.description}`)
    .join("\n");
  return `  node ${BRIDGE_DIR}/tool.mjs ${tool.name}${flags ? ` ${flags}` : ""}\n      ${tool.description}${params ? `\n${params}` : ""}`;
}

/** A tool with a real schema is shown as one `--json` call, because that is the only way it works. */
function schemaLines(tool: BridgeTool): string {
  const schema = node(tool.inputSchema);
  const properties = node(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  const example: JsonNode = {};
  for (const key of required) if (key in properties) example[key] = exampleValue(properties[key]);
  if (!Object.keys(example).length) {
    for (const [key, prop] of Object.entries(properties).slice(0, 1)) example[key] = exampleValue(prop);
  }
  const params = Object.entries(properties)
    .map(([key, prop]) => {
      const shape = node(prop);
      const description = typeof shape.description === "string" ? shape.description : "";
      return `      ${key}: ${typeName(shape)}${required.includes(key) ? " (required)" : ""}${description ? ` — ${description}` : ""}`;
    })
    .join("\n");
  return `  node ${BRIDGE_DIR}/tool.mjs ${tool.name} --json '${JSON.stringify(example)}'   [JSON]\n      ${tool.description}${params ? `\n${params}` : ""}`;
}

export class StudioBridge {
  readonly dir: string;
  readonly #mcp: boolean;
  readonly #cwd: string;
  readonly #tools: BridgeTool[];
  readonly #onCall: BridgeOptions["onCall"];
  readonly #pollMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #seen = new Set<string>();
  #inFlight = new Set<string>();
  #closed = false;
  /** The `res/` folder this bridge made, by identity: a folder swapped in later is not it. */
  #res: { dev: number; ino: number } | null = null;
  /** The `req/` folder this bridge made, by identity: requests are read only from it (TQ-4). */
  #req: { dev: number; ino: number } | null = null;
  /** Every call the contractor made, in order — the record the harness executes against. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  private constructor(options: BridgeOptions) {
    this.#cwd = path.resolve(options.cwd);
    this.dir = path.join(this.#cwd, BRIDGE_DIR);
    this.#tools = options.tools.map((tool) =>
      tool.inputSchema || !Object.values(tool.parameters.properties).some((property) => property.type !== "string")
        ? tool
        : { ...tool, inputSchema: tool.parameters },
    );
    this.#onCall = options.onCall;
    this.#mcp = options.mcp === true;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  static async open(options: BridgeOptions): Promise<StudioBridge> {
    const bridge = new StudioBridge(options);
    // The workspace is the contractor's to write, so `.studio` may be a link it planted. Every
    // path below would resolve through it, outside the workspace, so the bridge does not open.
    const studio = path.dirname(bridge.dir);
    const existing = await lstat(studio).catch(() => null);
    if (existing && !existing.isDirectory()) throw new Error(MESSAGE.NotPlainFolder(studio));
    // A bridge left behind by a crashed build is scaffolding, not state: start clean. `rm` removes
    // a planted link itself, never what it points at.
    await rm(bridge.dir, { recursive: true, force: true }).catch(() => {});
    await mkdir(path.join(bridge.dir, "req"), { recursive: true });
    await mkdir(path.join(bridge.dir, "res"), { recursive: true });
    const res = await lstat(path.join(bridge.dir, "res"));
    bridge.#res = { dev: res.dev, ino: res.ino };
    const req = await lstat(path.join(bridge.dir, "req"));
    bridge.#req = { dev: req.dev, ino: req.ino };
    if (!(await bridge.#intact())) throw new Error(MESSAGE.NotPlainFolder(bridge.dir));
    await writeFile(path.join(bridge.dir, "tool.mjs"), SHIM_SOURCE, "utf8");
    if (options.mcp) await writeFile(path.join(bridge.dir, MCP_SHIM_FILE), MCP_SHIM_SOURCE, "utf8");
    await writeFile(
      path.join(bridge.dir, "tools.json"),
      JSON.stringify(
        // The whole declaration, not just its name: the shim reads the names, and the contractor
        // reads the schema when a tool's arguments are more than a flat string.
        bridge.#tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        })),
        null,
        2,
      ),
      "utf8",
    );
    bridge.#timer = setInterval(() => void bridge.#drain(), bridge.#pollMs);
    bridge.#timer.unref?.();
    return bridge;
  }

  /**
   * What the contractor is told about its tools, appended to the brief. Written as commands
   * because that is what they are — a model that has been handed a shell needs no new grammar.
   */
  /** How a contractor starts the MCP shim: `node` and its path; null when this bridge wrote none. */
  mcpCommand(): string[] | null {
    return this.#mcp ? ["node", path.join(this.dir, MCP_SHIM_FILE)] : null;
  }

  instructions(): string {
    if (!this.#tools.length) return "";
    const lines = this.#tools.map((tool) => (tool.inputSchema ? schemaLines(tool) : flagLines(tool)));
    const schemaTools = this.#tools.filter((tool) => tool.inputSchema);
    return [
      "STUDIO TOOLS — run these as ordinary shell commands from the workspace root.",
      "They block until the studio answers and print the answer on stdout; treat that output",
      "as the tool's result. A value with spaces goes in quotes, or pass one JSON object:",
      `  node ${BRIDGE_DIR}/tool.mjs <tool> --json '{"key":"value"}'`,
      ...(schemaTools.length
        ? [
            // A --key=value flag can only ever produce a string. The tools below take lists,
            // numbers and nested objects, so they are called with one JSON object or not at all.
            `Tools marked JSON (${schemaTools.map((tool) => tool.name).join(", ")}) take arrays, numbers`,
            "or nested objects: send --json, never --key=value. For a large payload, write the object",
            "to a file first and pass the path:",
            `  node ${BRIDGE_DIR}/tool.mjs <tool> --json @args.json`,
            `Every tool's full JSON Schema is in ${BRIDGE_DIR}/tools.json.`,
          ]
        : []),
      "",
      ...lines,
      "",
      `Never edit, commit or delete anything under ${BRIDGE_DIR}/ — it is the studio's, not the game's.`,
    ].join("\n");
  }

  /** Answer every request that has appeared since the last look. */
  async #drain(): Promise<void> {
    if (this.#closed) return;
    let entries: string[];
    try {
      entries = await readdir(path.join(this.dir, "req"));
    } catch {
      return;
    }
    for (const entry of entries) {
      const newRequest = entry.endsWith(".json") && !this.#seen.has(entry) && !this.#inFlight.has(entry);
      if (!newRequest) continue;
      this.#inFlight.add(entry);
      void this.#answer(entry).finally(() => {
        this.#inFlight.delete(entry);
        this.#seen.add(entry);
      });
    }
  }

  /**
   * Is the bridge still the folders this studio made? The contractor can write the workspace, so
   * it can swap `.studio`, the bridge, `req/` or `res/` for a link to anywhere, and this process
   * runs outside every sandbox. Checked before a request is read, before a tool runs and around
   * every write (PH-1, TQ-4).
   */
  async #intact(): Promise<boolean> {
    const plain = async (dir: string) => (await lstat(dir).catch(() => null))?.isDirectory() === true;
    if (!(await plain(path.dirname(this.dir))) || !(await plain(this.dir))) return false;
    const same = async (name: string, made: { dev: number; ino: number } | null) => {
      const info = await lstat(path.join(this.dir, name)).catch(() => null);
      return !!info && info.isDirectory() && info.dev === made?.dev && info.ino === made?.ino;
    };
    return (await same("req", this.#req)) && (await same("res", this.#res));
  }

  /** Create a new file and write it, never following or reusing anything already at `file`. */
  async #create(file: string, data: string | Buffer): Promise<{ dev: number; ino: number }> {
    const handle = await openNoFollow(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
      await handle.writeFile(data);
      const info = await handle.stat();
      return { dev: info.dev, ino: info.ino };
    } finally {
      await handle.close();
    }
  }

  async #answer(entry: string): Promise<void> {
    // A bridge the contractor has rerouted runs no tool: its answer could only land outside.
    if (!(await this.#intact())) return;
    let request: BridgeRequest;
    try {
      request = await this.#readRequest(entry);
    } catch (err) {
      await this.#write(entry, false, `the studio could not read that request: ${errorMessage(err)}`);
      return;
    }
    // `req/` swapped while the file was opened: what was read came from somewhere else.
    if (!(await this.#intact())) return;
    const name = String(request.name ?? "");
    const args = (request.args ?? {}) as Record<string, unknown>;
    if (!this.#tools.some((tool) => tool.name === name)) {
      await this.#write(entry, false, `no studio tool called '${name}'`);
      return;
    }
    this.calls.push({ name, args });
    try {
      const answer = await this.#answerOf(await this.#onCall(name, args));
      // The bridge was rerouted while its pictures were being saved: there is nowhere to answer.
      if (answer === null) return;
      await this.#write(entry, true, answer.text, answer.images);
    } catch (err) {
      // A broken tool reports as text. It must never end a build that is otherwise going well.
      await this.#write(entry, false, `${name} failed: ${errorMessage(err)}`);
    }
  }

  /** One request file, read never through a link, never blocking on a FIFO, never unbounded (M4). */
  async #readRequest(entry: string): Promise<BridgeRequest> {
    const raw = await readRegularFile(path.join(this.dir, "req", entry), MAX_REQUEST_BYTES);
    return JSON.parse(raw.toString("utf8")) as BridgeRequest;
  }

  /**
   * A tool's result as the text the shim prints. Its pictures are saved into `res/` and named in
   * the answer, so the contractor can open them; null when the bridge stopped being intact.
   */
  async #answerOf(result: LiveToolResult): Promise<Answer | null> {
    if (typeof result === "string") return { text: result, images: [] };
    if (!result.images?.length) return { text: result.text, images: [] };
    const imageFiles = [];
    const images: AnswerImage[] = [];
    for (const image of result.images) {
      const name = `${randomUUID()}.${imageExtension(image.mimeType)}`;
      const file = path.join(this.dir, "res", name);
      if (!(await this.#intact())) return null;
      await this.#create(file, Buffer.from(image.data, "base64"));
      imageFiles.push({ path: file, label: image.label ?? DEFAULT_IMAGE_LABEL });
      images.push({ file: name, mimeType: image.mimeType });
    }
    return { text: withImageFiles(result.text, imageFiles), images };
  }

  async #write(entry: string, ok: boolean, text: string, images: AnswerImage[] = []): Promise<void> {
    if (this.#closed || !(await this.#intact())) return;
    const target = path.join(this.dir, "res", entry);
    // Same write-then-rename dance as the shim, from the other side of the conversation. The
    // temp name is one the contractor cannot guess and plant a link at, it is created exclusively
    // without following links, and the file renamed into place must be the one just written,
    // still inside this bridge's own `res/`. A lost race leaves at most an orphan temp file.
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      const written = await this.#create(tmp, JSON.stringify({ ok, text, ...(images.length ? { images } : {}) }));
      const now = await lstat(tmp);
      const sameFile = now.dev === written.dev && now.ino === written.ino;
      if (!sameFile || !(await this.#intact())) return;
      await rename(tmp, target);
    } catch {
      /* the contractor rerouted or removed the bridge: there is nowhere safe to answer */
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    // Only through a `.studio` that is still a plain folder: `rm` removes a planted bridge link
    // itself, but a planted `.studio` link would aim it at a folder outside the workspace.
    if ((await lstat(path.dirname(this.dir)).catch(() => null))?.isDirectory()) {
      await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** The studio tools a delegation grants a bridge engine (Codex, OpenCode) — the bridge declares exactly these. */
export function bridgeTools(request: DelegateRequest): BridgeTool[] {
  const tools: BridgeTool[] = [];
  if (!request.readOnly) {
    tools.push({
      name: StudioTool.Checkpoint,
      description: CHECKPOINT_TOOL.description,
      parameters: {
        type: "object",
        properties: { note: { type: "string", description: CHECKPOINT_TOOL.note } },
        required: ["note"],
      },
    });
  }
  if (request.onCapture) {
    tools.push({
      name: StudioTool.Capture,
      description: CODEX_CAPTURE_TOOL.description,
      parameters: {
        type: "object",
        properties: {
          cameras: { type: "string", description: CODEX_CAPTURE_TOOL.cameras },
          page: { type: "string", description: CODEX_CAPTURE_TOOL.page },
        },
      },
    });
  }
  if (request.onLiveTool) tools.push(...(request.liveTools ?? []));
  tools.push(...(request.interviewTools ?? []));
  return tools;
}

/** One bridge call, routed to whichever studio handler this delegation was given. */
export async function answerBridgeCall(
  name: string,
  args: Record<string, unknown>,
  request: DelegateRequest,
): Promise<LiveToolResult> {
  if (name === StudioTool.Checkpoint) {
    const note = String(args.note ?? "").slice(0, CHECKPOINT_NOTE_CHARS);
    request.onEvent?.({ type: DelegateEventType.Checkpoint, payload: { note } });
    return CHECKPOINT_TOOL.reply;
  }
  if (name === StudioTool.Capture && request.onCapture) {
    return request.onCapture(captureArgs(args));
  }
  if (request.onLiveTool && (request.liveTools ?? []).some((tool) => tool.name === name)) {
    // The file bridge materializes attached images beside its response for the session to view.
    return request.onLiveTool(name, args);
  }
  // Intake tools only record: the harness executes the real thing once the reply ends.
  if ((request.interviewTools ?? []).some((tool) => tool.name === name)) return intakeToolReply(name);
  return `the studio has no tool called '${name}' in this session`;
}

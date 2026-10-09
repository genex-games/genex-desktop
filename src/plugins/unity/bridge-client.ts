import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

/** Wire limits shared with the Editor package; a screenshot must fit the response limit. */
const LIMIT = { Request: 1024 * 1024, Response: 4 * 1024 * 1024, Endpoint: 16 * 1024, TimeoutMs: 20_000 };
const MESSAGE = {
  NotProject: "Choose a Unity 6 project containing Assets, Packages and ProjectSettings.",
  EndpointMissing: "Open this project in Unity with the Genex Editor bridge installed, then reconnect.",
  EndpointInvalid: "Unity bridge discovery is invalid or belongs to another project. Reconnect from Unity.",
  PathOutside: "Unity bridge files must remain inside the selected project.",
  ReplyInvalid: "Unity returned an invalid or mismatched bridge response.",
  RequestLarge: "Unity request exceeds 1 MiB. Split the operation into smaller batches.",
  ResponseLarge: "Unity response exceeds 4 MiB. Use pagination or a smaller screenshot.",
  Uncertain:
    "Unity connection ended after the request was sent; its result is unknown. The operation may have completed. Inspect the project before retrying.",
  TimedOut: "Unity did not answer within the call budget. Inspect Editor status and accepted jobs before retrying.",
  Stopped: "Stopped waiting for Unity. An accepted Editor operation may still continue; inspect it before retrying.",
} as const;

/** A bridge failure has a stable code; neither its message nor JSON serialization contains the token. */
export class UnityBridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UnityBridgeError";
    this.code = code;
  }
}

export interface UnityProject {
  root: string;
  version: string;
}
export interface UnityBridgeEndpoint {
  protocol: 1;
  host: "127.0.0.1";
  port: number;
  projectRoot: string;
  projectId: string;
  pid: number;
  unityVersion: string;
  /** Non-enumerable; used only by the authenticated transport. Never return this field to an agent. */
  token: string;
}
interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Compare canonical filesystem paths, including Windows' case-insensitive spelling. */
const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, child: string): boolean => {
  const relative = path.relative(root, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

/** Read a bounded plain file after resolving it inside the selected project. */
async function projectFile(root: string, relative: string, maximum: number): Promise<string> {
  const file = path.join(root, relative);
  let parent = path.dirname(file);
  while (!samePath(parent, root)) {
    const directory = await lstat(parent);
    if (directory.isSymbolicLink() || !directory.isDirectory())
      throw new UnityBridgeError("invalid_path", MESSAGE.PathOutside);
    parent = path.dirname(parent);
  }
  const info = await lstat(file);
  const canonical = await realpath(file);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || !inside(root, canonical))
    throw new UnityBridgeError("invalid_path", MESSAGE.PathOutside);
  if (info.size > maximum) throw new UnityBridgeError("invalid_file", MESSAGE.EndpointInvalid);
  return readFile(canonical, "utf8");
}

/** Validate a Unity project without opening it or changing its files. */
export async function inspectUnityProject(requestedRoot: string): Promise<UnityProject> {
  if (!requestedRoot || !path.isAbsolute(requestedRoot)) throw new UnityBridgeError("not_project", MESSAGE.NotProject);
  const root = await realpath(requestedRoot).catch(() => "");
  if (!root) throw new UnityBridgeError("not_project", MESSAGE.NotProject);
  const assets = await lstat(path.join(root, "Assets")).catch(() => null);
  if (!assets?.isDirectory() || assets.isSymbolicLink()) throw new UnityBridgeError("not_project", MESSAGE.NotProject);
  const versionFile = await projectFile(root, "ProjectSettings/ProjectVersion.txt", LIMIT.Endpoint);
  const version = /^m_EditorVersion:\s*(\S+)/m.exec(versionFile)?.[1];
  if (!version || !/^6000\.\d+\.\d+[abfp]\d+$/.test(version))
    throw new UnityBridgeError("not_project", MESSAGE.NotProject);
  const manifest = JSON.parse(await projectFile(root, "Packages/manifest.json", LIMIT.Request));
  if (!manifest?.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies))
    throw new UnityBridgeError("not_project", MESSAGE.NotProject);
  return { root, version };
}

/** Read fresh per-project discovery; domain reloads may move its port. No connection is attempted here. */
export async function readBridgeEndpoint(requestedRoot: string): Promise<UnityBridgeEndpoint> {
  const project = await inspectUnityProject(requestedRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(await projectFile(project.root, "Library/Genex/bridge.json", LIMIT.Endpoint));
  } catch (error) {
    if (error instanceof UnityBridgeError) throw error;
    throw new UnityBridgeError("not_connected", MESSAGE.EndpointMissing);
  }
  const value = raw as Partial<UnityBridgeEndpoint> | null;
  const valid =
    value &&
    value.protocol === 1 &&
    value.host === "127.0.0.1" &&
    Number.isInteger(value.port) &&
    Number(value.port) > 0 &&
    Number(value.port) <= 65535 &&
    typeof value.token === "string" &&
    /^[a-f0-9]{64}$/.test(value.token) &&
    typeof value.projectId === "string" &&
    value.projectId.length > 0 &&
    value.projectId.length <= 128 &&
    Number.isInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.unityVersion === "string" &&
    typeof value.projectRoot === "string";
  if (!valid || !value) throw new UnityBridgeError("invalid_endpoint", MESSAGE.EndpointInvalid);
  const endpointRoot = await realpath(String(value.projectRoot)).catch(() => "");
  if (!samePath(project.root, endpointRoot)) throw new UnityBridgeError("invalid_endpoint", MESSAGE.EndpointInvalid);
  const endpoint = { ...value, projectRoot: project.root } as UnityBridgeEndpoint;
  Object.defineProperty(endpoint, "token", { value: value.token, enumerable: false });
  return Object.freeze(endpoint);
}

/** Validate one reply before exposing its result, and redact even an untrusted server's error. */
function responseResult(line: Buffer, id: string, endpoint: UnityBridgeEndpoint): unknown {
  let reply: {
    id?: string;
    projectId?: string;
    ok?: boolean;
    result?: unknown;
    error?: { code?: string; message?: string };
  };
  try {
    const redact = (text: string) => text.replaceAll(endpoint.token, "[redacted]");
    reply = JSON.parse(line.toString("utf8"), (_key, value: unknown) => {
      if (typeof value === "string") return redact(value);
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), item]));
      return value;
    });
  } catch {
    throw new UnityBridgeError("invalid_response", MESSAGE.ReplyInvalid);
  }
  if (!reply || reply.id !== id || reply.projectId !== endpoint.projectId || typeof reply.ok !== "boolean")
    throw new UnityBridgeError("invalid_response", MESSAGE.ReplyInvalid);
  if (reply.ok) return reply.result;
  const code = typeof reply.error?.code === "string" ? reply.error.code.slice(0, 80) : "editor_error";
  const message = String(reply.error?.message || MESSAGE.ReplyInvalid)
    .replaceAll(endpoint.token, "[redacted]")
    .slice(0, 2000);
  throw new UnityBridgeError(code, message);
}

/** One authenticated request, with bounded buffers and no automatic replay of accepted work. */
export async function bridgeRequest(
  root: string,
  method: string,
  params: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<unknown> {
  options.signal?.throwIfAborted();
  const endpoint = await readBridgeEndpoint(root);
  options.signal?.throwIfAborted();
  const id = randomUUID();
  const payload = Buffer.from(`${JSON.stringify({ id, token: endpoint.token, method, params })}\n`);
  if (payload.length > LIMIT.Request) throw new UnityBridgeError("request_too_large", MESSAGE.RequestLarge);
  return exchange(endpoint, id, payload, options);
}

function exchange(endpoint: UnityBridgeEndpoint, id: string, payload: Buffer, options: CallOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    let done = false,
      sent = false,
      bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stopped);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const stopped = () => finish(new UnityBridgeError("stopped", MESSAGE.Stopped));
    const timer = setTimeout(
      () => finish(new UnityBridgeError("timeout", MESSAGE.TimedOut)),
      options.timeoutMs ?? LIMIT.TimeoutMs,
    );
    options.signal?.addEventListener("abort", stopped, { once: true });
    socket.once("connect", () => {
      sent = true;
      socket.write(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > LIMIT.Response) {
        finish(new UnityBridgeError("response_too_large", MESSAGE.ResponseLarge));
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      const data = Buffer.concat(chunks);
      try {
        finish(undefined, responseResult(data.subarray(0, data.indexOf(10)), id, endpoint));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(MESSAGE.ReplyInvalid));
      }
    });
    socket.once("error", () =>
      finish(
        new UnityBridgeError(sent ? "uncertain" : "not_connected", sent ? MESSAGE.Uncertain : MESSAGE.EndpointMissing),
      ),
    );
    socket.once("close", () =>
      finish(
        new UnityBridgeError(sent ? "uncertain" : "not_connected", sent ? MESSAGE.Uncertain : MESSAGE.EndpointMissing),
      ),
    );
    if (options.signal?.aborted) stopped();
  });
}

/** Offline AppContainer CLI execution with HTTP confined to the pinned API by the trusted host. */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { NativeProcessRequest, NativeProcessResult } from "../../substrate/plugins/native-process-contract.ts";
import { NativeEndReason } from "../../substrate/plugins/native-process-contract.ts";
import type { RunRequest, RunResult } from "../../substrate/spawn.ts";

const PREFIX = "\u001eGENEX_HTTP:";
const MAX_FRAME_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MESSAGE = {
  InvalidFrame: "Invalid Genex host transport frame",
  RefusedOrigin: "Genex host transport refuses a different API origin",
  ApiFailed: "Genex API request failed",
  LargeResponse: "Genex API response exceeds the host transport limit",
};

interface FetchFrame {
  id: number;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body?: string;
  redirect: RequestRedirect;
}

async function responseBytes(response: Response): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error(MESSAGE.LargeResponse);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function apiUrl(raw: string, origin: string): URL {
  const url = new URL(raw);
  if (url.origin !== origin || url.username || url.password) throw new Error(MESSAGE.RefusedOrigin);
  return url;
}

async function apiRequest(frame: FetchFrame, origin: string, signal: AbortSignal) {
  let url = apiUrl(frame.url, origin);
  let method = frame.method;
  let body: Uint8Array<ArrayBuffer> | undefined = frame.body
    ? new Uint8Array(Buffer.from(frame.body, "base64"))
    : undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, { method, body, headers: frame.headers, redirect: "manual", signal });
    const location = response.headers.get("location");
    const redirects = location && [301, 302, 303, 307, 308].includes(response.status);
    if (!redirects || frame.redirect === "manual") {
      return {
        id: frame.id,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        url: url.href,
        body: (await responseBytes(response)).toString("base64"),
      };
    }
    await response.body?.cancel();
    if (frame.redirect === "error" || hop === MAX_REDIRECTS) throw new Error(MESSAGE.ApiFailed);
    url = apiUrl(new URL(location, url).href, origin);
    const becomesGet = response.status === 303 || (method === "POST" && [301, 302].includes(response.status));
    if (becomesGet) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error(MESSAGE.ApiFailed);
}

function isFetchFrame(value: unknown): value is FetchFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<FetchFrame>;
  const scalarFields =
    Number.isSafeInteger(frame.id) &&
    Number(frame.id) > 0 &&
    typeof frame.url === "string" &&
    typeof frame.method === "string";
  const bodyValid = frame.body === undefined || typeof frame.body === "string";
  const headersValid =
    Array.isArray(frame.headers) &&
    frame.headers.every(
      (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === "string"),
    );
  return scalarFields && bodyValid && headersValid && ["follow", "manual", "error"].includes(frame.redirect ?? "");
}

function hostChannel(credential: string, origin: string, controller: AbortController, signal: AbortSignal) {
  const decoder = new StringDecoder("utf8");
  const pending = new Set<Promise<void>>();
  const requests = new Map<number, AbortController>();
  let tail = "";
  let initialized = false;
  let outputBytes = 0;
  let failure: Error | undefined;
  let send: (payload: string) => void = () => {};
  const reply = (value: unknown) => send(`${JSON.stringify(value)}\n`);
  const accept = (line: string) => {
    const start = line.indexOf(PREFIX);
    if (start < 0) return line;
    try {
      const frame: unknown = JSON.parse(line.slice(start + PREFIX.length));
      if (!initialized && (frame as { ready?: boolean } | null)?.ready === true) {
        initialized = true;
        reply({ credential });
      } else {
        const cancel = (frame as { cancel?: number } | null)?.cancel;
        if (Number.isSafeInteger(cancel)) {
          requests.get(Number(cancel))?.abort();
          return line.slice(0, start);
        }
        if (!initialized || !isFetchFrame(frame)) throw new Error(MESSAGE.InvalidFrame);
        const request = new AbortController();
        requests.set(frame.id, request);
        const task = apiRequest(frame, origin, AbortSignal.any([signal, request.signal])).then(reply, () =>
          reply({ id: frame.id, error: MESSAGE.ApiFailed }),
        );
        pending.add(task);
        void task.finally(() => {
          pending.delete(task);
          requests.delete(frame.id);
        });
      }
    } catch {
      failure = new Error(MESSAGE.InvalidFrame);
      controller.abort();
    }
    return line.slice(0, start);
  };
  const channel: NonNullable<NativeProcessRequest["channel"]> = {
    connect(write) {
      send = write;
    },
    stdout(chunk) {
      tail += decoder.write(chunk);
      if (tail.length > MAX_FRAME_CHARS) {
        failure = new Error(MESSAGE.InvalidFrame);
        controller.abort();
        tail = "";
      }
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      const output = Buffer.from(lines.map((line) => accept(`${line}\n`)).join(""));
      outputBytes += output.length;
      return output;
    },
  };
  return {
    channel,
    outputBytes: () => outputBytes,
    async finish() {
      const output = accept(tail + decoder.end());
      outputBytes += Buffer.byteLength(output);
      controller.abort();
      await Promise.allSettled(pending);
      if (failure) throw failure;
      return output;
    },
  };
}

/** Keep the CLI's private writable folder inaccessible to the long-lived shared-account harness. */
export async function runWindowsCli(
  request: RunRequest,
  argv: string[],
  resources: string,
  run: (request: NativeProcessRequest) => Promise<NativeProcessResult>,
): Promise<RunResult> {
  const started = Date.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal ?? new AbortController().signal, controller.signal]);
  const origin = new URL(request.env?.GENEX_API_URL ?? "").origin;
  const bridge = hostChannel(request.stdin ?? "", origin, controller, signal);
  const root = path.dirname(request.cwd);
  const scratch = path.join(root, "tmp");
  const maxOutputBytes = request.maxOutputBytes ?? MAX_RESPONSE_BYTES;
  await mkdir(scratch, { recursive: true });
  let result: NativeProcessResult;
  let tail = "";
  try {
    result = await run({
      binary: argv[0] ?? "",
      // Real files are already pinned by the native launcher. Node's default realpath walk
      // would demand root-directory attributes beyond this job's declared file grants.
      args: ["--preserve-symlinks", "--preserve-symlinks-main", ...argv.slice(1)],
      cwd: request.cwd,
      scratch,
      reads: [resources],
      writes: [root],
      denyRead: request.policy?.denyRead ?? [],
      signal,
      timeoutMs: request.timeoutMs ?? 0,
      maxOutputBytes,
      environment: { ...request.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", STUDIO_GENEX_HOST_IO: "stdio" },
      channel: bridge.channel,
    });
  } finally {
    tail = await bridge.finish();
  }
  return {
    code: result.code,
    signal: result.signal,
    stdout: Buffer.from(result.stdout + tail)
      .subarray(-maxOutputBytes)
      .toString("utf8"),
    stderr: result.stderr,
    durationMs: Date.now() - started,
    timedOut: result.reason === NativeEndReason.Timeout,
    truncated: result.truncated === true || bridge.outputBytes() > maxOutputBytes,
    sandboxed: true,
    command: request.command,
    cwd: request.cwd,
  };
}

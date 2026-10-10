import net from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DevErrorCode,
  operationSchema,
  type Operation,
  type DevResponse,
  MAX_REQUEST_BYTES,
} from "../../src/main/dev/protocol.ts";

/** How long the controller may take to answer one request. */
const CONTROLLER_TIMEOUT_MS = 35_000;
/** The largest response the client reads before giving up on it. */
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
/** How long an input waits for its target to take pointer input. */
const REACHABLE_TIMEOUT_MS = 15_000;
/** How soon an input whose target is not reachable yet is tried again. */
const REACHABLE_RETRY_MS = 150;

type Descriptor = { instanceId: string; socket: string; capability: string };

/** The response line's value, when it answers this request; its error when the controller refused. */
function responseValue(line: string, requestId: string): unknown {
  const r = JSON.parse(line) as DevResponse;
  if (r.version !== 1 || r.requestId !== requestId) throw new Error("wrong response identity");
  if (!r.ok) throw Object.assign(new Error(`${r.error.code}: ${r.error.message}`), { code: r.error.code });
  return r.value;
}

/** Sends one line to the controller's socket and settles with the value of the line it answers. */
function exchange(socket: string, payload: string, requestId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let buffer = "";
    let done = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true;
      client.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    client.setTimeout(CONTROLLER_TIMEOUT_MS, () => finish(new Error("controller timeout")));
    client.on("error", (e) => finish(e));
    client.on("connect", () => client.write(payload));
    client.on("close", () => {
      if (!done) finish(new Error("controller closed before response"));
    });
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_RESPONSE_CHARS) {
        finish(new Error("response exceeds 4 MiB"));
        return;
      }
      if (!buffer.includes("\n")) return;
      try {
        finish(undefined, responseValue(buffer.split("\n")[0] ?? "", requestId));
      } catch (e) {
        finish(e as Error);
      }
    });
  });
}

/** One validated operation to the running app's dev controller, answered by its value. */
export async function request(descriptor: Descriptor, operation: Operation): Promise<any> {
  const op = operationSchema.parse(operation);
  const requestId = randomUUID();
  const payload = `${JSON.stringify({
    version: 1,
    requestId,
    instanceId: descriptor.instanceId,
    capability: descriptor.capability,
    ...op,
  })}\n`;
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw new Error("request exceeds 64 KiB");
  return exchange(descriptor.socket, payload, requestId);
}

/**
 * One input operation, sent again while the control cannot reach its target yet: refused as
 * target-not-visible, nothing was dispatched. A modal dialog or menu, for one, turns pointer events
 * off outside itself as it opens and turns its own on one render later. Any other refusal, and
 * that one past `timeoutMs`, is final.
 */
export async function requestWhenReachable(
  descriptor: Descriptor,
  operation: Operation,
  timeoutMs = REACHABLE_TIMEOUT_MS,
): ReturnType<typeof request> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await request(descriptor, operation);
    } catch (e) {
      const covered = (e as { code?: string }).code === DevErrorCode.TargetNotVisible;
      if (!covered || Date.now() >= deadline) throw e;
    }
    await sleep(REACHABLE_RETRY_MS);
  }
}

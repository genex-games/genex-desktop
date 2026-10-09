/** The offline CLI's credential and pinned HTTP transport, over inherited anonymous pipes only. */
import { createInterface } from "node:readline";

const PREFIX = "\u001eGENEX_HTTP:";
const MAX_BODY_BYTES = 1024 * 1024;
const MESSAGE = { closed: "Genex host transport closed", large: "Genex request exceeds the host transport limit" };
const replies = new Map();
let nextId = 0;
let receiveCredential;
let rejectCredential;
const initial = new Promise((resolve, reject) => {
  receiveCredential = resolve;
  rejectCredential = reject;
});
const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
let initialized = false;

lines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (!initialized) {
    initialized = true;
    receiveCredential(typeof frame.credential === "string" ? frame.credential : "");
    process.stdin.unref?.();
    return;
  }
  const reply = replies.get(frame.id);
  if (!reply) return;
  replies.delete(frame.id);
  reply.cleanup();
  if (!replies.size) process.stdin.unref?.();
  if (frame.error) {
    reply.reject(new Error(frame.error));
    return;
  }
  try {
    const response = new Response([204, 205, 304].includes(frame.status) ? null : Buffer.from(frame.body, "base64"), {
      status: frame.status,
      statusText: frame.statusText,
      headers: frame.headers,
    });
    Object.defineProperty(response, "url", { value: frame.url });
    reply.resolve(response);
  } catch (error) {
    reply.reject(error);
  }
});
lines.on("close", () => {
  rejectCredential(new Error(MESSAGE.closed));
  for (const reply of replies.values()) {
    reply.cleanup();
    reply.reject(new Error(MESSAGE.closed));
  }
  replies.clear();
});

process.stdout.write(`${PREFIX}${JSON.stringify({ ready: true })}\n`);
export const credential = await initial;

globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  request.signal.throwIfAborted();
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  if (body && body.length > MAX_BODY_BYTES) throw new Error(MESSAGE.large);
  const id = ++nextId;
  request.signal.throwIfAborted();
  const abort = () => {
    const reply = replies.get(id);
    if (!reply) return;
    replies.delete(id);
    reply.cleanup();
    reply.reject(request.signal.reason);
    if (!replies.size) process.stdin.unref?.();
    process.stdout.write(`${PREFIX}${JSON.stringify({ cancel: id })}\n`);
  };
  const promise = new Promise((resolve, reject) =>
    replies.set(id, {
      resolve,
      reject,
      cleanup: () => request.signal.removeEventListener("abort", abort),
    }),
  );
  request.signal.addEventListener("abort", abort, { once: true });
  process.stdin.ref?.();
  process.stdout.write(
    `${PREFIX}${JSON.stringify({
      id,
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: body?.toString("base64"),
      redirect: request.redirect,
    })}\n`,
  );
  return promise;
};

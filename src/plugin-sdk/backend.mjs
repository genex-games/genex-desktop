/** SDK process bootstrap. Plugins export activate(host); no Electron objects cross this wire. */
import { pathToFileURL } from "node:url";

/** How long aborted calls get to wind down after a stop before the process exits. */
const STOP_GRACE_MS = 1500;

const pending = new Map(),
  running = new Map();
let sequence = 0,
  activation;
const host = {
  call(method, args = {}, callId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      process.send({ kind: "host", id, method, args, callId });
    });
  },
};
/** One call's answer: a readiness ping, an empty review the plugin does not implement, or its own handler. */
async function answer(instance, message, context) {
  if (message.method === "ping") return { ready: true };
  if (message.method === "review" && !instance.review) return {};
  return instance[message.method](message.name, message.args, context);
}
/**
 * The app's language, as the host sends it before a call: the backend's own copy of the app's
 * words (`shared/i18n.ts`, bundled into it) reads it from this process-wide slot.
 */
const LANGUAGE_SLOT = Symbol.for("genex.language");
process.on("message", async (message) => {
  if (message.kind === "language") {
    globalThis[LANGUAGE_SLOT] = { locale: message.locale, catalog: message.catalog ?? {} };
    return;
  }
  if (message.kind === "host-result") {
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
    return;
  }
  if (message.kind === "cancel") {
    running.get(message.id)?.abort();
    return;
  }
  if (message.kind !== "call") return;
  const controller = new AbortController();
  running.set(message.id, controller);
  try {
    activation ??= import(pathToFileURL(process.argv[2]).href).then((module) => module.activate(host));
    const instance = await activation;
    const context = {
      ...message.context,
      signal: controller.signal,
      callId: message.id,
      host: (method, args) => host.call(method, args, message.id),
    };
    const result = await answer(instance, message, context);
    process.send({ kind: "result", id: message.id, result });
  } catch (error) {
    process.send({ kind: "result", id: message.id, error: error?.message ?? String(error) });
  } finally {
    running.delete(message.id);
  }
});
const stop = () => {
  for (const controller of running.values()) controller.abort();
  setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
};
process.on("SIGTERM", stop);
process.on("disconnect", stop);
process.send({ kind: "ready" });

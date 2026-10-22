/**
 * Harness bootstrap — PLAN.md §5.2. Shipped inside the app, **not** agent-editable.
 *
 * This is the fixed point the whole self-modification story rests on: it is small, it does not
 * change, and all it does is (1) speak the substrate protocol and (2) dynamically import the
 * agent's own code from the harness workspace. Everything above it — the loop, the tools, the
 * skills, the prompts — is the agent's to rewrite.
 *
 * If the imported harness throws on load, this process exits non-zero and the host's watchdog
 * rewinds the workspace to the newest healthy snapshot. That is the safety net that lets the
 * agent edit itself without a human standing by.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The kinds of message on the wire, both ways (the app's copy of the shapes is `HarnessToHost` and
 * `HostToHarness` in `shared/protocol.ts`): never rename a value.
 */
const MessageKind = {
  Rpc: "rpc",
  RpcResult: "rpc-result",
  Notify: "notify",
  Heartbeat: "heartbeat",
  Ready: "ready",
  Dispatch: "dispatch",
  DispatchResult: "dispatch-result",
  Shutdown: "shutdown",
};

/** How this process ends when it cannot go on; the host's watchdog reads any non-zero code as a failed self. */
const ExitCode = {
  NoWorkspace: 2,
  Uncaught: 3,
  UnhandledRejection: 4,
  LoadFailed: 5,
  InboxFailed: 6,
};

/** The dispatched action that asks the loaded self to prove it runs. */
const HEALTHCHECK = "healthcheck";
/** How often the heartbeat tells the host this process is alive. */
const HEARTBEAT_MS = 5_000;
/** How deep the fingerprint walks into the harness tree. */
const MAX_FINGERPRINT_DEPTH = 4;

/** Windows: the loopback port and first-line token of the host's channel, when stdin is not it. */
const INBOX_PORT = Number(process.env.HARNESS_INBOX_PORT) || 0;
const INBOX_TOKEN = process.env.HARNESS_INBOX_TOKEN ?? "";

const WS = process.env.HARNESS_WS;
if (!WS) {
  process.stderr.write("[bootstrap] HARNESS_WS is not set\n");
  process.exit(ExitCode.NoWorkspace);
}

// ── wire ────────────────────────────────────────────────────────────────────────────────────
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let nextRpcId = 1;
const pendingRpc = new Map();

/** The substrate API, as seen by the agent's code. The only way out of this process. */
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pendingRpc.set(id, { resolve, reject });
    out({ kind: MessageKind.Rpc, id, method, params });
  });
}

const host = {
  call,
  notify: (type, payload) => out({ kind: MessageKind.Notify, type, payload }),
  heartbeat: (status) => out({ kind: MessageKind.Heartbeat, ts: Date.now(), status }),
  workspace: WS,
};

// ── loading the (editable) self ─────────────────────────────────────────────────────────────
/** mtime fingerprint of the harness tree — proves which version of itself is running. */
function fingerprint(dir, depth = 0) {
  if (depth > MAX_FINGERPRINT_DEPTH) return "";
  let acc = "";
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) acc += fingerprint(full, depth + 1);
    else acc += `${entry.name}:${statSync(full).mtimeMs};`;
  }
  return acc;
}

/** FNV-1a of `text`, as eight hex digits: the short name of a fingerprint. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Cache-busted import so a single edited file can be picked up without a full restart. */
async function load(relative) {
  const file = path.join(WS, relative);
  const version = statSync(file).mtimeMs;
  return import(`${pathToFileURL(file).href}?v=${version}`);
}

let studio = null;

/**
 * The entry module: `loop/main.ts`, which Node runs by stripping its types. A workspace from before
 * the harness was TypeScript has only `loop/main.mjs`, and still boots from it.
 */
function entry() {
  return existsSync(path.join(WS, "loop", "main.ts")) ? "loop/main.ts" : "loop/main.mjs";
}

async function boot() {
  const module = await load(entry());
  studio = await module.createStudio(host);
  // The bootstrap ships in the app and always tracks it; the harness is editable and may not.
  // So a harness that declares nothing reports [] — the host reads that as "this self predates
  // capability-gated features", never as "this self can do everything the app can".
  const capabilities = Array.isArray(studio?.capabilities)
    ? studio.capabilities.filter((c) => typeof c === "string")
    : [];
  // With NODE_COMPILE_CACHE set, write what this boot compiled now: a harness that is killed
  // rather than exiting never reaches Node's write at exit, and the next boot would compile again.
  nodeModule.flushCompileCache?.();
  out({ kind: MessageKind.Ready, pid: process.pid, harnessVersion: hash(fingerprint(WS)), capabilities });
}

// ── inbound ─────────────────────────────────────────────────────────────────────────────────
let buffer = "";

/**
 * Windows: srt-win does not pass stdin through, so the host connects to a loopback port instead
 * (`substrate/harness-inbox.ts`). The first line must be the one-time token; any other client is
 * dropped, and the port closes once the host is in.
 */
function listenInbox() {
  if (!INBOX_TOKEN) {
    process.stderr.write("[bootstrap] HARNESS_INBOX_TOKEN is not set\n");
    process.exit(ExitCode.InboxFailed);
  }
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let greeting = "";
    let greeted = false;
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (greeted) return inbound(chunk);
      greeting += chunk;
      const end = greeting.indexOf("\n");
      if (end < 0) return;
      if (greeting.slice(0, end) !== INBOX_TOKEN) return socket.destroy();
      greeted = true;
      server.close();
      inbound(greeting.slice(end + 1));
    });
  });
  server.on("error", (err) => {
    process.stderr.write(`[bootstrap] inbox failed: ${err?.message ?? err}\n`);
    process.exit(ExitCode.InboxFailed);
  });
  server.listen(INBOX_PORT, "127.0.0.1");
}

if (INBOX_PORT) listenInbox();
else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", inbound);
}

function inbound(chunk) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      process.stderr.write(`[bootstrap] bad line: ${err.message}\n`);
      continue;
    }
    handle(message);
  }
}

async function handle(message) {
  if (message.kind === MessageKind.RpcResult) settleRpc(message);
  else if (message.kind === MessageKind.Shutdown) await shutdown();
  else if (message.kind === MessageKind.Dispatch) await answerDispatch(message);
}

/** Settle the harness's pending substrate call with the host's answer. */
function settleRpc(message) {
  const pending = pendingRpc.get(message.id);
  if (!pending) return;
  pendingRpc.delete(message.id);
  if (message.ok) {
    pending.resolve(message.value);
    return;
  }
  const error = new Error(message.error?.message ?? "substrate call failed");
  error.name = message.error?.name ?? "SubstrateError";
  // Rehydrate structured detail (e.g. an engine failure's `kind` and `fallbacks`) so the
  // agent's own code can act on it rather than string-matching a message.
  Object.assign(error, message.error?.data ?? {});
  pending.reject(error);
}

/** Let the loaded harness shut down, then exit whatever it did. */
async function shutdown() {
  try {
    await studio?.shutdown?.();
  } finally {
    process.exit(0);
  }
}

/** Run one dispatched action through the loaded harness and answer the host with the result. */
async function answerDispatch(message) {
  try {
    let value = null;
    if (message.action.type === HEALTHCHECK) {
      // Prove the loaded self can actually run, not merely that the process is alive.
      await studio.healthcheck();
    } else {
      // A dispatch may answer (the director's tools do); anything else stays an ack.
      value = await studio.dispatch(message.action);
    }
    out({
      kind: MessageKind.DispatchResult,
      id: message.id,
      ok: true,
      ...(value !== undefined && value !== null ? { value } : {}),
    });
  } catch (err) {
    out({ kind: MessageKind.DispatchResult, id: message.id, ok: false, error: err?.message ?? String(err) });
  }
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`[bootstrap] uncaught: ${err?.stack ?? err}\n`);
  process.exit(ExitCode.Uncaught);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[bootstrap] unhandled rejection: ${err?.stack ?? err}\n`);
  process.exit(ExitCode.UnhandledRejection);
});

// A slow drumbeat so the host can tell "wedged" from "thinking".
const beat = setInterval(() => host.heartbeat(studio?.status?.() ?? "idle"), HEARTBEAT_MS);
beat.unref?.();

boot().catch((err) => {
  process.stderr.write(`[bootstrap] failed to load harness: ${err?.stack ?? err}\n`);
  process.exit(ExitCode.LoadFailed);
});

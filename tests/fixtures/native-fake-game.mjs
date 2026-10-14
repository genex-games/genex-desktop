// A scripted native game for the port's fuzz rows: a Node process that speaks the native
// protocol on fd 3 (NDJSON both ways) the way a C++ · raylib game does, and misbehaves on cue.
// `node native-fake-game.mjs <mode>`, with GENEX_STUDIO_NONCE and GENEX_STATE_DIR set:
//
//   good          ready, then answers state, capture (a 2×2 BGRA file) and quit (exit 0)
//   partial       the same, every line sent a few bytes at a time
//   crlf          the same, every line ended with CRLF
//   flood         ready, then a 2 MiB line in place of the first answer
//   endless       ready, then bytes with no newline at all, until killed
//   depth         ready, then a state answer nested 100,000 levels deep
//   stderr-flood  ready, then 5,000 stderr lines, the first one 10,000 characters long
//   ignore-quit   ready; answers quit but never exits, and ignores SIGTERM
import { writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const mode = process.argv[2] ?? "good";
const nonce = process.env.GENEX_STUDIO_NONCE ?? "";
const stateDir = process.env.GENEX_STATE_DIR ?? process.cwd();
const pipe = new net.Socket({ fd: 3, readable: true, writable: true });

/** FNV-1a 64 of `bytes`, 16 lowercase hex: what the template's capture declares. */
function fnv(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function writeLine(value) {
  const text = `${JSON.stringify(value)}${mode === "crlf" ? "\r\n" : "\n"}`;
  if (mode !== "partial") return void pipe.write(text);
  for (let at = 0; at < text.length; at += 3) pipe.write(text.slice(at, at + 3));
}

let seq = 0;
function capture() {
  const bgra = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]);
  const dir = path.join(stateDir, "captures");
  mkdirSync(dir, { recursive: true });
  seq += 1;
  writeFileSync(path.join(dir, `${seq}.bgra`), bgra);
  return { seq, width: 2, height: 2, format: "bgra8", digest: fnv(bgra) };
}

function answer(request) {
  const { id, op } = request;
  if (mode === "flood") return void pipe.write(`${"x".repeat(2 * 1024 * 1024)}\n`);
  if (mode === "endless") {
    const chunk = "y".repeat(64 * 1024);
    // More of the same line whenever the pipe takes it: it never ends.
    const more = () => {
      if (pipe.write(chunk)) setImmediate(more);
      else pipe.once("drain", more);
    };
    return void more();
  }
  if (mode === "depth" && op === "state") {
    const deep = `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`;
    return void pipe.write(`{"id":${id},"ok":true,"op":"state","result":${deep}}\n`);
  }
  if (op === "state") return writeLine({ id, ok: true, op, result: { tick: 1, mode } });
  if (op === "capture") return writeLine({ id, ok: true, op, result: capture() });
  if (op === "quit") {
    writeLine({ id, ok: true, op, result: { quitting: true } });
    if (mode !== "ignore-quit") setTimeout(() => process.exit(0), 10);
    return;
  }
  writeLine({ id, ok: false, op, error: "unknown op" });
}

if (mode === "ignore-quit") process.on("SIGTERM", () => {});
let buffered = "";
pipe.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    answer(JSON.parse(line));
  }
});
pipe.on("end", () => mode !== "ignore-quit" && process.exit(0));
pipe.on("error", () => {});

writeLine({
  event: "ready",
  nonce,
  protocol: 1,
  contractVersion: 1,
  build: "fake",
  backend: { api: "unknown", device: null },
  size: { width: 2, height: 2 },
  seed: 0,
});
if (mode === "stderr-flood") {
  process.stderr.write(`${"z".repeat(10_000)}\n`);
  for (let line = 1; line < 5000; line++) process.stderr.write(`WARNING: line ${line}\n`);
}
// Keep running until told otherwise.
setInterval(() => {}, 60_000);

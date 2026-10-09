/** Host-only credential transport for the unmodified pinned Genex CLI.
 * Credentials arrive through an anonymous pipe, never argv, environment or a plaintext file: fd 3,
 * or the descriptor `STUDIO_GENEX_CREDENTIAL_FD` names. The pipe carries a `GENEX_TOKEN=` line.
 *
 * The CLI (1.35+) reads its sign-in from a per-origin record beside its env file,
 * `<env>.origins/<sha256(origin)>.json` holding `{ apiUrl, token }` — the file `genex auth` itself
 * writes. This serves exactly one such record, for the origin Studio pinned for the run
 * (`GENEX_API_URL`). Every other read, including another origin's record and the legacy env file,
 * goes to the real filesystem, where nothing exists, so the CLI's own origin binding refuses it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const VIRTUAL_ENV_FILE = "/__studio_genex_credentials__";
const DEFAULT_CREDENTIAL_FD = "3";
const MAX_CREDENTIAL_BYTES = 65536;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const MESSAGE = {
  Oversized: "Oversized Genex credential transport",
  BadDescriptor: "STUDIO_GENEX_CREDENTIAL_FD must name stdin (0) or a descriptor from 3 up",
};

/** The credential descriptor: stdin or an extra pipe, never stdout or stderr. */
function credentialFd() {
  const raw = process.env.STUDIO_GENEX_CREDENTIAL_FD ?? DEFAULT_CREDENTIAL_FD;
  if (!/^(0|[3-9]|[1-9][0-9])$/.test(raw)) throw new Error(MESSAGE.BadDescriptor);
  return Number(raw);
}

async function readCredential(fd) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of fs.createReadStream(null, { fd, autoClose: true })) {
    bytes += chunk.length;
    if (bytes > MAX_CREDENTIAL_BYTES) throw new Error(MESSAGE.Oversized);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The `GENEX_TOKEN=` value, or null when the pipe carried none (a locked account sends nothing). */
function tokenFrom(payload) {
  const value = payload.match(/^GENEX_TOKEN=(.*)$/m)?.[1]?.trim();
  return value || null;
}

/** The pinned API as the CLI normalizes it, or null when it is missing or not a bare origin. */
function pinnedOrigin(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
  const bare = !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/+$/, "") === "";
  return secure && bare ? url.origin : null;
}

const transport = process.env.STUDIO_GENEX_HOST_IO === "stdio" ? await import("./stdio-fetch.mjs") : null;
const token = tokenFrom(transport ? transport.credential : await readCredential(credentialFd()));
const origin = pinnedOrigin(process.env.GENEX_API_URL);
if (token && origin) {
  const key = createHash("sha256").update(origin).digest("hex");
  const record = path.join(`${VIRTUAL_ENV_FILE}.origins`, `${key}.json`);
  // The CLI resolves the env file's path: on Windows that puts the drive of its folder in front.
  const recordNames = new Set([record, path.resolve(record)]);
  const content = Buffer.from(`${JSON.stringify({ apiUrl: origin, token })}\n`);
  const original = fsp.readFile.bind(fsp);
  fsp.readFile = async (file, options) => {
    if (!recordNames.has(file)) return original(file, options);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? content.toString(encoding) : Buffer.from(content);
  };
  syncBuiltinESMExports();
}

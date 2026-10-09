/**
 * Maintainer step for a community submission: fetch the artifact the contributor attached to their
 * release, check it against the record in this catalog, and place it where the upload expects it.
 * Never executes package code and never uploads anything. Dependency-free, like check-catalog.mjs.
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { checkArtifact } from "./check-catalog.mjs";

/** The largest artifact the catalog accepts, as check-catalog.mjs enforces. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
/** Release downloads redirect once or twice (GitHub → its asset host); more is a loop. */
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const RECORD_PATH = /^records\/[a-z][a-z0-9-]{0,47}\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.json$/;

const fail = (message) => {
  throw new Error(message);
};

/** A credential-free HTTPS URL, or a refusal naming what was wrong. */
function httpsUrl(value, what) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    fail(`${what} must be a credential-free HTTPS URL: ${url.origin}`);
  return url;
}

/** The release record at `record` inside `root`: a regular file, no links on the way. */
async function readRecord(root, record) {
  if (typeof record !== "string" || !RECORD_PATH.test(record))
    fail(`Record path must be records/<id>/<version>.json: ${record}`);
  let current = path.resolve(root);
  for (const part of record.split("/")) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail(`Links are not allowed: ${record}`);
  }
  const entry = JSON.parse(await readFile(current, "utf8"));
  const [, id, name] = record.split("/");
  if (entry.id !== id || `${entry.version}.json` !== name) fail(`Record identity mismatch: ${record}`);
  if (!entry.artifact || !/^[a-f0-9]{64}$/.test(entry.artifact.sha256))
    fail(`Record has no artifact digest: ${record}`);
  return entry;
}

/** Follow HTTPS redirects by hand, so a hop to plain HTTP or an endless chain is refused. */
async function download(from, fetch, maxBytes) {
  let url = httpsUrl(from, "Artifact source");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = httpsUrl(new URL(location, url).href, "Redirect target");
      continue;
    }
    if (!res.ok) fail(`Artifact source answered HTTP ${res.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) fail("Artifact too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return fail("Too many redirects");
}

/**
 * Stage the contributor's artifact for upload. Writes `<out>/<id>/<version>/<sha256>.json` only when
 * the bytes match the record's digest and its envelope passes the catalog's own artifact check.
 * @param {{root:string, record:string, from:string, out:string, fetch?:typeof globalThis.fetch, maxBytes?:number}} options
 */
export async function stageArtifact({
  root,
  record,
  from,
  out,
  fetch = globalThis.fetch,
  maxBytes = MAX_ARTIFACT_BYTES,
}) {
  const entry = await readRecord(root, record);
  const key = httpsUrl(entry.artifact.url, "Record artifact URL").pathname.replace(/^\//, "");
  const bytes = await download(from, fetch, maxBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.artifact.sha256) fail(`Artifact digest mismatch: got ${sha256}`);
  await checkArtifact(entry, bytes);
  const file = path.join(path.resolve(out), entry.id, entry.version, `${sha256}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
  return { id: entry.id, version: entry.version, file, key, sha256, bytes: bytes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const value = (key) => {
      const i = args.indexOf(key);
      return i < 0 ? undefined : args[i + 1];
    };
    const [root, record, from, out] = ["--root", "--record", "--from", "--out"].map(value);
    if (!root || !record || !from || !out)
      fail(
        "Usage: node scripts/stage-artifact.mjs --root . --record records/<id>/<version>.json --from <https URL> --out <uploads-dir>",
      );
    const staged = await stageArtifact({ root, record, from, out });
    console.log(JSON.stringify(staged, null, 2));
    console.error(`Upload ${staged.file} as object ${staged.key} (RELEASING.md); never replace a different payload.`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

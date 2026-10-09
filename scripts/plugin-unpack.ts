/**
 * Unpack a plugin artifact envelope into a new folder, for review: diff it against the source
 * commit, run `plugin:doctor` on it, or load it in Studio. Writes files only; runs nothing.
 *
 *     npm run plugin:unpack -- <artifact.json> <new-directory>
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { MAX_ARTIFACT_BYTES, unpackEnvelope } from "../src/substrate/plugins/pack.ts";
import { inspectPackage } from "../src/substrate/plugins/manifest.ts";
import { errorMessage } from "../src/shared/errors.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [artifact, output] = process.argv.slice(2);
if (!artifact || !output) fail("Usage: npm run plugin:unpack -- <artifact.json> <new-directory>");
const bytes = await readFile(path.resolve(artifact));
if (bytes.length > MAX_ARTIFACT_BYTES) fail("Artifact exceeds 256 MiB");
const destination = path.resolve(output);
// A new folder only: unpacking into an existing one could mix a reviewed package with other files.
await mkdir(path.dirname(destination), { recursive: true });
await mkdir(destination).catch(() => fail(`${destination} already exists; choose a new directory`));
try {
  const files = await unpackEnvelope(bytes, destination);
  const manifest = await inspectPackage(destination);
  console.log(JSON.stringify({ id: manifest.id, version: manifest.version, directory: destination, files }, null, 2));
} catch (e) {
  await rm(destination, { recursive: true, force: true });
  fail(errorMessage(e));
}

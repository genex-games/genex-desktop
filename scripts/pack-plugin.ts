/** Prebuilt packages only: no dependency installation, build hooks or network access. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { packEnvelope } from "../src/substrate/plugins/pack.ts";
import { isInside } from "../src/substrate/paths.ts";
import { errorMessage } from "../src/shared/errors.ts";

const USAGE = "Usage: npm run plugin:pack -- <prebuilt-directory> <artifact.json>";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [directory, output] = process.argv.slice(2);
if (!directory || !output) fail(USAGE);
const root = path.resolve(directory),
  destination = path.resolve(output);
if (isInside(root, destination)) fail("Artifact output must be outside the plugin package");
const { manifest, bytes, sha256 } = await packEnvelope(root).catch((e: unknown) => fail(errorMessage(e)));
await writeFile(destination, bytes);
console.log(JSON.stringify({ manifest, sha256, artifact: destination }, null, 2));

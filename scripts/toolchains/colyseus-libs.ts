/**
 * Lays out one downloaded Colyseus native-sdk prebuilt (`COLYSEUS_ASSETS`) as the per-triple
 * library folders the vendored relay client links (MP-1a), with the store's own checks
 * (`toolchain-store/colyseus.ts`): the pinned size and sha256, no link or oversized entry, every
 * library an `ar` archive. `setup-toolchain.sh` runs it for its `colyseus` group, filling the dev
 * toolchain's `tools/colyseus/<triple>`, the folder `rust-env.ts` names in `GENEX_COLYSEUS_LIB_DIR`.
 *
 *   node scripts/toolchains/colyseus-libs.ts <downloaded asset> <tools/colyseus>
 *
 * The asset is named by its file name. A refusal is one line on stderr and exit 78; the
 * destination is left as it was.
 */
import path from "node:path";
import { ColyseusAsset } from "../../src/shared/toolchain.ts";
import { installColyseusAsset } from "../../src/substrate/toolchain-store/colyseus.ts";

/** The exit code of a refusal (EX_CONFIG), as the other toolchain helpers use. */
const REFUSED_EXIT = 78;
const USAGE = "usage: node scripts/toolchains/colyseus-libs.ts <downloaded asset> <tools/colyseus>";

const ASSETS: ReadonlySet<string> = new Set<string>(Object.values(ColyseusAsset));
const isAsset = (name: string): name is ColyseusAsset => ASSETS.has(name);

async function main(argv: readonly string[]): Promise<void> {
  const [file, dest] = argv;
  if (file === undefined || dest === undefined || argv.length !== 2) throw new Error(USAGE);
  const name = path.basename(file);
  if (!isAsset(name)) throw new Error(`${name} is not a pinned Colyseus asset`);
  const triples = await installColyseusAsset(path.resolve(file), name, path.resolve(dest));
  for (const triple of triples) process.stdout.write(`${path.join(path.resolve(dest), triple)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`colyseus-libs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(REFUSED_EXIT);
  });
}

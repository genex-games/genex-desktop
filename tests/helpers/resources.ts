import { buildPlugins } from "../../scripts/build-plugins.mjs";
/**
 * The read-only resources folder a {@link StudioCore} expects, assembled without a build. Kept apart
 * from studio-rig.ts so tests that only need resources (core-lite, seed upgrades, dev policy) stay
 * out of the serial rig group.
 */
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vendorTsc } from "../../scripts/vendor-tsc.ts";
import { tmpDir } from "./tmp.ts";

const src = fileURLToPath(new URL("../../src", import.meta.url));

let resources: Promise<string> | undefined;

/** One read-only assembly per test file; every core still gets its own writable profile. */
export function sharedResources(): Promise<string> {
  resources ??= makeResources();
  return resources;
}

/**
 * Assemble a fresh resources folder, for fixtures that change what the app ships. The type gate's
 * compiler is linked from node_modules, not copied; `tsc: false` leaves it out, as a build that
 * lost it would. Readers that do not change resources use `sharedResources` instead.
 */
export async function makeResources({ tsc = true }: { tsc?: boolean } = {}): Promise<string> {
  const dir = path.join(await tmpDir("studio-res-"), "resources");
  await mkdir(dir, { recursive: true });
  await cp(path.join(src, "harness-seed"), path.join(dir, "harness-seed"), { recursive: true });
  await cp(path.join(src, "harness-boot"), path.join(dir, "harness-boot"), { recursive: true });
  await cp(path.join(src, "game-template"), path.join(dir, "game-template"), { recursive: true });
  await buildPlugins(path.dirname(src), dir, { dependencies: false });
  // Headless rigs must never contact the real account service after a fixture unlock.
  // genex-creator-mcp.test.ts exercises the actual packaged bridge separately.
  await cp(path.join(src, "../tests/fixtures/mcp/genex-creator.mjs"), path.join(dir, "plugins/genex/creator-mcp.mjs"));
  await mkdir(path.join(dir, "vendor"), { recursive: true });
  // A stand-in for three.js: the fake preview never executes it.
  await writeFile(path.join(dir, "vendor", "three.module.js"), "export const REVISION = 'test';\n");
  if (tsc) await vendorTsc(path.dirname(src), dir, { link: true });
  return dir;
}

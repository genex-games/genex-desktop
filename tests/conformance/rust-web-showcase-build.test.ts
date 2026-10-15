/**
 * The web showcase build (`scripts/spike/rust-wgpu/web-showcase.sh`) measures what a web export
 * ships (renderer pass 2, A.12): its release build compiles with the lane's export size profile
 * (`RUST_WEB_EXPORT_PROFILE_SETTINGS`), so the gzip size it reports is the size the lane's export
 * would have. Before A.12 it built with cargo's release defaults and reported 4,559,208 B gzip for
 * Lakeside where the export profile gives 3,589,203 B.
 *
 * No cargo runs here: `--print-cargo` prints the cargo arguments one per line and exits.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RUST_WEB_EXPORT_PROFILE_SETTINGS } from "../../src/main/rust-build-web.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const WEB_SHOWCASE = path.join(REPO, "scripts", "spike", "rust-wgpu", "web-showcase.sh");

/** The cargo arguments the script would build with. */
async function cargoArgs(...flags: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("bash", [WEB_SHOWCASE, "--print-cargo", ...flags]);
  return stdout.split("\n").filter((line) => line.length > 0);
}

/** Each `--config <setting>` pair in `args`. */
function configSettings(args: readonly string[]): string[] {
  return args.flatMap((arg, i) => (arg === "--config" && i + 1 < args.length ? [args[i + 1] ?? ""] : []));
}

describe("the web showcase build", { skip: process.platform === "win32" ? "POSIX-only script" : false }, () => {
  it("builds a release with the lane's export size profile, as a web export does", async () => {
    const args = await cargoArgs();
    assert.ok(args.includes("--release"), args.join(" "));
    assert.deepEqual(configSettings(args), [...RUST_WEB_EXPORT_PROFILE_SETTINGS]);
  });

  it("keeps cargo's dev profile for --debug (a Live-like build is never measured)", async () => {
    const args = await cargoArgs("--debug");
    assert.equal(args.includes("--release"), false);
    assert.deepEqual(configSettings(args), []);
  });
});

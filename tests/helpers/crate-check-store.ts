/**
 * The crate checker's real store components for the real rows: cargo-deny, cargo-vet and the
 * pinned RustSec snapshot, installed into a test's own store through the store's installer
 * (`installComponents`, probes under the real `ProcessSandbox`) from the pinned archives already
 * downloaded into `$GENEX_RUST_TOOLCHAIN_DIR/downloads/` (default `.studio-dev/spike-toolchain`,
 * named as its `receipt.tsv` says, else as the URL; `scripts/toolchains/crate-policy.ts refresh`
 * puts the snapshot there). Nothing is fetched.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ToolchainInstallPhase, toolchainHostOf } from "../../src/shared/toolchain.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { crateCheckEntries } from "../../src/substrate/toolchain-store/crate-check-store.ts";
import { installComponents } from "../../src/substrate/toolchain-store/install.ts";
import { prewarmSandboxOptions } from "../../src/substrate/toolchain-store/prewarm.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const DOWNLOADS = path.join(TOOLCHAIN_DIR, "downloads");

/** The spike's download receipt (`receipt.tsv`: component, file, sha256, URL): each URL's local file name. */
function receiptNames(): Map<string, string> {
  const names = new Map<string, string>();
  const text = existsSync(path.join(TOOLCHAIN_DIR, "receipt.tsv"))
    ? readFileSync(path.join(TOOLCHAIN_DIR, "receipt.tsv"), "utf8")
    : "";
  for (const line of text.split("\n")) {
    const [, file, , url] = line.split("\t");
    if (file && url) names.set(url, file);
  }
  return names;
}

/** This host's checker entries and each archive's local file, or why they are not here. */
function served() {
  const host = toolchainHostOf(process.platform, process.arch);
  const entries = host ? crateCheckEntries(host) : [];
  if (entries.length === 0) return { absent: "a host the crate checker pins" } as const;
  const files = new Map<string, string>();
  const names = receiptNames();
  for (const archive of entries.flatMap((entry) => entry.archives)) {
    const file = path.join(DOWNLOADS, names.get(archive.url) ?? path.basename(new URL(archive.url).pathname));
    if (!existsSync(file)) return { absent: file } as const;
    files.set(archive.url, file);
  }
  return { entries, files } as const;
}

/** Why the real checker rows cannot run here, or null. */
export function realCrateCheckAbsent(): string | null {
  if (process.platform === "win32") return "a POSIX host";
  const found = served();
  return "absent" in found ? `the crate checker's downloads (${found.absent})` : null;
}

/** The skip a real row takes, or none; `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure. */
export function needsCrateCheck(): { skip?: string } {
  const missing = realCrateCheckAbsent();
  if (!missing) return {};
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/** Installs the checker into `store` from the local downloads, as the app installs it on the first approval. */
export async function installRealCrateCheck(store: string, scratch: string): Promise<void> {
  const found = served();
  if ("absent" in found) throw new Error(`no crate checker downloads: ${found.absent}`);
  const sandbox = await ProcessSandbox.create(prewarmSandboxOptions(scratch, []));
  try {
    const job = await installComponents(store, found.entries, {
      fetch: async (url) => {
        const file = found.files.get(url);
        if (!file) return new Response(null, { status: 404 });
        return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>);
      },
      run: (request) => sandbox.run(request),
      freeBytes: async (dir) => {
        const disk = await statfs(dir);
        return disk.bavail * disk.bsize;
      },
      onJob: () => {},
    });
    if (job.phase !== ToolchainInstallPhase.Installed) throw new Error(`crate checker install: ${JSON.stringify(job)}`);
  } finally {
    await sandbox.dispose();
  }
}

/**
 * The Rust · wgpu payload every Genex package carries in `dist/resources/`: the game template a
 * Rust game is scaffolded from (`game-template-rust`, a development build's creation only while the
 * stack is gated), the lock line its vendored crate set is cut from (`native/genex-rust/Cargo.lock`,
 * byte for byte: `rust-manifest.ts` derives each game's lock from it), the lane's determinism
 * gate beside it (`native/genex-rust/clippy.toml`, `src/main/core/rust-lane.ts`) and the crate
 * policy crate requests are vetted against (`native/genex-rust/crate-policy.json`, only the bytes
 * `CRATE_POLICY_SHA256` pins, `crate-policy.ts`). Never a compiler: the
 * toolchain store installs cargo and rustc on the user's computer from pinned release downloads,
 * so the package carries no Rust program and no build output.
 *
 * `scripts/build.mjs` ships it ({@link shipRustPayload}); `tests/e2e/run-packaged-smoke.mjs` holds
 * a package to it ({@link rustPayloadChecks}).
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CRATE_POLICY_SHA256 } from "../src/substrate/toolchain-store/crate-policy.ts";

/** Where the payload comes from in the repository and lands under `dist/resources/`. */
export const RUST_PAYLOAD = {
  /** The template folder: `src/<template>` in the repository, `<resources>/<template>` in a package. */
  template: "game-template-rust",
  /** Files a template must hold to scaffold a game: its manifest, its entry points and its agent guide. */
  templateFiles: ["genex.toml", "src/main.rs", "src/game.rs", "CLAUDE.md"],
  /** The lock line, from the repository root to the resources folder. */
  lock: { source: "native/genex-rust/Cargo.lock", resource: "native/genex-rust/Cargo.lock" },
  /** The lane's determinism gate (`CLIPPY_CONF_DIR`, `src/main/core/rust-lane.ts`), beside the lock line. */
  clippy: { source: "native/genex-rust/clippy.toml", resource: "native/genex-rust/clippy.toml" },
  /** The crate policy (`CRATE_POLICY_FILE`), beside the lock line, at its pinned bytes. */
  policy: { source: "native/genex-rust/crate-policy.json", resource: "native/genex-rust/crate-policy.json" },
} as const;

/** Folders a template copy never ships: cargo's build output, if anyone built the template in place. */
const BUILD_OUTPUT_FOLDERS: ReadonlySet<string> = new Set(["target"]);

/** The lock format the lane reads (cargo 1.99 writes version 4). */
const LOCK_VERSION_LINE = /^version = 4$/m;

/**
 * A Rust toolchain's programs, by file name: the toolchain store installs them on the user's
 * computer, so a package never carries one (on any platform, with or without `.exe`).
 */
const RUST_PROGRAM =
  /^(?:cargo|rustc|rustdoc|rustup|rustfmt|rust-analyzer|rust-lld|rust-gdb|rust-lldb|cargo-(?:clippy|fmt|miri)|clippy-driver|wasm-bindgen(?:-test-runner)?|wasm2es6js)(?:\.exe)?$/i;

const MESSAGE = {
  TemplateFile: (rel: string) => `The Rust template has no ${rel} to ship (src/${RUST_PAYLOAD.template}/${rel}).`,
  Lock: (rel: string) => `${rel} is not a version 4 cargo lock: the Rust lock line cannot ship.`,
  Clippy: (rel: string) => `${rel} is missing or empty: the Rust lane's determinism gate cannot ship.`,
  Policy: (rel: string) => `${rel} is not the pinned crate policy (CRATE_POLICY_SHA256): it cannot ship.`,
} as const;

/** Whether `bytes` are the crate policy `CRATE_POLICY_SHA256` pins. */
const isPinnedPolicy = (bytes: Buffer | null): boolean =>
  bytes !== null && createHash("sha256").update(bytes).digest("hex") === CRATE_POLICY_SHA256;

/** One packaged-smoke check: its name, whether it held, and what failed. */
export interface PayloadCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The bytes of `file`, or null when it cannot be read. */
async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/**
 * Copies the Rust template (without build output), the lock line and the lane's `clippy.toml` from
 * the repository at `root` into `resources`. Refuses before copying when a template file is missing
 * or empty, the lock line is not a version 4 cargo lock or the `clippy.toml` is missing or empty,
 * so a build never ships a payload that cannot scaffold or build a game.
 */
export async function shipRustPayload({ root, resources }: { root: string; resources: string }): Promise<void> {
  const template = path.join(root, "src", RUST_PAYLOAD.template);
  for (const rel of RUST_PAYLOAD.templateFiles) {
    const bytes = await readOrNull(path.join(template, rel));
    if (!bytes?.length) throw new Error(MESSAGE.TemplateFile(rel));
  }
  const lock = await readOrNull(path.join(root, RUST_PAYLOAD.lock.source));
  if (!lock || !LOCK_VERSION_LINE.test(lock.toString("utf8"))) throw new Error(MESSAGE.Lock(RUST_PAYLOAD.lock.source));
  const clippy = await readOrNull(path.join(root, RUST_PAYLOAD.clippy.source));
  if (!clippy?.length) throw new Error(MESSAGE.Clippy(RUST_PAYLOAD.clippy.source));
  const policy = await readOrNull(path.join(root, RUST_PAYLOAD.policy.source));
  if (!isPinnedPolicy(policy)) throw new Error(MESSAGE.Policy(RUST_PAYLOAD.policy.source));
  await cp(template, path.join(resources, RUST_PAYLOAD.template), {
    recursive: true,
    filter: (source) =>
      !path
        .relative(template, source)
        .split(path.sep)
        .some((part) => BUILD_OUTPUT_FOLDERS.has(part)),
  });
  const shipped = path.join(resources, RUST_PAYLOAD.lock.resource);
  await mkdir(path.dirname(shipped), { recursive: true });
  await cp(path.join(root, RUST_PAYLOAD.lock.source), shipped);
  await cp(path.join(root, RUST_PAYLOAD.clippy.source), path.join(resources, RUST_PAYLOAD.clippy.resource));
  await cp(path.join(root, RUST_PAYLOAD.policy.source), path.join(resources, RUST_PAYLOAD.policy.resource));
}

/** What the packaged smoke reads from a package for the Rust checks. */
export interface RustPayloadInput {
  /** Every path the package holds, asar and unpacked, `/`-rooted with `/` separators (folders too). */
  entries: readonly string[];
  /** The packaged lock line's bytes, or null when the package has none. */
  shippedLock: Buffer | null;
  /** The repository's lock line. */
  sourceLock: Buffer;
  /** The packaged crate policy's bytes, or null when the package has none. */
  shippedPolicy: Buffer | null;
  /** The main bundle's text: the Rust recipe is inlined into it (`manifest.ts` imports it). */
  mainBundle: string;
  /** The Rust recipe the package was built from (`rust-recipe.json`). */
  recipe: { entries: ReadonlyArray<{ archives: ReadonlyArray<{ sha256: string | null }> }> };
}

/** The packaged smoke's Rust checks: the template, the lock line byte for byte, the crate policy, no Rust program, the pins. */
export function rustPayloadChecks({
  entries,
  shippedLock,
  sourceLock,
  shippedPolicy,
  mainBundle,
  recipe,
}: RustPayloadInput): PayloadCheck[] {
  const home = `/dist/resources/${RUST_PAYLOAD.template}/`;
  const missing = RUST_PAYLOAD.templateFiles.filter((rel) => !entries.includes(`${home}${rel}`));
  // Listings name folders too: only a leaf, a file, can be a program.
  const folders = new Set(entries.map((entry) => path.posix.dirname(entry)));
  const programs = entries.filter((entry) => RUST_PROGRAM.test(path.posix.basename(entry)) && !folders.has(entry));
  const pins = recipe.entries.flatMap((entry) => entry.archives.map((archive) => archive.sha256));
  const unshipped = pins.filter((sha256) => sha256 === null || !mainBundle.includes(sha256));
  return [
    {
      name: "package carries the Rust · wgpu game template",
      ok: missing.length === 0,
      ...(missing.length ? { detail: `missing ${missing.join(", ")}` } : {}),
    },
    {
      name: "package carries the Rust lock line byte for byte",
      ok: shippedLock?.equals(sourceLock) === true,
      ...(shippedLock ? {} : { detail: `no ${RUST_PAYLOAD.lock.resource}` }),
    },
    {
      name: "package carries the pinned crate policy",
      ok: isPinnedPolicy(shippedPolicy),
      ...(shippedPolicy ? {} : { detail: `no ${RUST_PAYLOAD.policy.resource}` }),
    },
    {
      name: "package carries no Rust compiler, cargo or Rust tool program",
      ok: programs.length === 0,
      ...(programs.length ? { detail: programs.slice(0, 5).join(", ") } : {}),
    },
    {
      name: "main bundle carries the Rust toolchain pins",
      ok: unshipped.length === 0,
      ...(unshipped.length ? { detail: `${unshipped.length} of ${pins.length} pins absent` } : {}),
    },
  ];
}

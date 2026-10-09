/** Build the pinned SRT broker with the parent-only ACL fix; keep the SDK's existing protocol and paths. */
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = path.join(ROOT, "native/srt-win");
const TARGET = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
const RUST_FLAGS = ["-C", "target-feature=+crt-static"].join("\x1f");

async function sourceDigest(dir, hash = createHash("sha256")) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "target" || entry.name === ".git") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceDigest(file, hash);
    else hash.update(path.relative(SOURCE, file)).update(await readFile(file));
  }
  return hash;
}

async function cargo(args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn("cargo", args, { cwd: ROOT, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Pinned Windows sandbox build failed (${code}); Rust and MSVC build tools are required.`));
    });
  });
}

async function licenseFiles(packages, destination) {
  await mkdir(destination, { recursive: true });
  const rows = [];
  for (const pkg of packages) {
    if (!pkg.source) continue;
    const dir = path.dirname(pkg.manifest_path);
    const files = (await readdir(dir)).filter((name) => /^(license|copying|unlicense|copyright)([._-]|$)/i.test(name));
    if (!files.length) throw new Error(`Missing native dependency license: ${pkg.name}@${pkg.version}`);
    const target = path.join(destination, `${pkg.name}-${pkg.version}`);
    await mkdir(target, { recursive: true });
    for (const file of files) await cp(path.join(dir, file), path.join(target, file));
    rows.push(`${pkg.name}@${pkg.version}: ${pkg.license ?? "see license files"}`);
  }
  await cp(path.join(SOURCE, "LICENSE"), path.join(destination, "LICENSE-srt-win"));
  await writeFile(path.join(destination, "NOTICE.txt"), `${rows.sort().join("\n")}\n`);
}

/** Replace only this architecture's vendored broker, built from checked-in, attributed sources. */
export async function buildWindowsSandboxHelper(packageDir, arch = process.arch) {
  if (process.platform !== "win32") return;
  const target = TARGET[arch];
  if (!target) throw new Error(`Windows sandbox architecture unsupported: ${arch}`);
  const { stdout: rust } = await run("rustc", ["--version"], { windowsHide: true });
  const digest = (await sourceDigest(SOURCE)).update(target).update(RUST_FLAGS).update(rust).digest("hex");
  const cache = path.join(ROOT, ".studio-dev/native/srt-win", arch);
  const executable = path.join(cache, target, "release/srt-win.exe");
  const stamp = path.join(cache, "source.json");
  const previous = await readFile(stamp, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: RUST_FLAGS, CARGO_TARGET_DIR: cache };
  const manifest = path.join(SOURCE, "Cargo.toml");
  if (previous?.digest !== digest) {
    await cargo(["build", "--release", "--locked", "--target", target, "--manifest-path", manifest], env);
    await writeFile(stamp, JSON.stringify({ digest, rust: rust.trim(), target }));
  }
  const destination = path.join(packageDir, "vendor/srt-win", arch);
  const metadata = await run(
    "cargo",
    [
      "metadata",
      "--locked",
      "--offline",
      "--format-version",
      "1",
      "--filter-platform",
      target,
      "--manifest-path",
      manifest,
    ],
    { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  await licenseFiles(JSON.parse(metadata.stdout).packages, path.join(destination, "licenses"));
  const broker = path.join(destination, "srt-win.exe");
  const built = await readFile(executable);
  const installed = await readFile(broker).catch(() => null);
  // Windows locks a running executable: a cached build must not replace identical bytes.
  if (!installed?.equals(built)) await cp(executable, broker);
  await cp(path.join(SOURCE, "PROVENANCE.md"), path.join(destination, "PROVENANCE.md"));
  await cp(stamp, path.join(destination, "genex-build.json"));
}

/** First-run private Git install: verified bytes, atomic publication, no global setup or accounts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  activateWindowsGit,
  ensureWindowsGit,
  windowsGit,
  type WindowsGitSetup,
} from "../../src/substrate/windows-git.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function fixture() {
  const data = await tmpDir("genex-git-setup-");
  const bytes = Buffer.from("synthetic verified portable Git");
  const counts = { downloads: 0, extractions: 0 };
  const setup: WindowsGitSetup = {
    discover: async () => null,
    source: {
      name: "git.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: "https://example.invalid/git",
    },
    fetch: async (source, directory) => {
      counts.downloads++;
      const archive = path.join(directory, source.name);
      await writeFile(archive, bytes);
      return archive;
    },
    extract: async (_archive, stage) => {
      counts.extractions++;
      await mkdir(path.join(stage, "bin"), { recursive: true });
      await mkdir(path.join(stage, "cmd"), { recursive: true });
      await writeFile(path.join(stage, "bin", "bash.exe"), "fake bash");
      await writeFile(path.join(stage, "cmd", "git.exe"), "fake git");
    },
    arch: "x64",
  };
  return { data, setup, counts };
}

test("an existing Git is reused without downloads or machine PATH changes", async () => {
  const f = await fixture();
  f.setup.discover = async () => "C:\\Git\\bin\\bash.exe";
  assert.equal(await ensureWindowsGit(f.data, f.setup), "C:\\Git");
  assert.deepEqual(f.counts, { downloads: 0, extractions: 0 });
  const original = path.join(f.data, "existing");
  const env = { PATH: original };
  activateWindowsGit(f.data, env);
  activateWindowsGit(f.data, env);
  assert.deepEqual(env.PATH.split(path.delimiter), [path.join(f.data, "cmd"), original]);
});

test("concurrent first launches share one verified install; subsequent launches reuse the cache", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([ensureWindowsGit(f.data, f.setup), ensureWindowsGit(f.data, f.setup)]);
  assert.equal(first, second);
  assert.equal(await windowsGit(f.data, f.setup), first);
  assert.equal(await ensureWindowsGit(f.data, f.setup), first);
  assert.deepEqual(f.counts, { downloads: 1, extractions: 1 });
  assert.deepEqual(await readdir(path.dirname(first)), [path.basename(first)]);
});

test("a tampered download is never executed or published", async () => {
  const f = await fixture();
  assert.ok(f.setup.source);
  f.setup.source = { ...f.setup.source, sha256: "0".repeat(64) };
  await assert.rejects(ensureWindowsGit(f.data, f.setup), /integrity check/);
  assert.equal(f.counts.extractions, 0);
  assert.equal(await windowsGit(f.data, f.setup), null);
  assert.deepEqual(await readdir(path.join(f.data, "runtime", "git")), []);
});

test("a failed extraction removes only its stage and stays retryable", async () => {
  const f = await fixture();
  const extract = f.setup.extract;
  f.setup.extract = async () => {
    throw new Error("synthetic extraction failure");
  };
  await assert.rejects(ensureWindowsGit(f.data, f.setup), /synthetic extraction failure/);
  assert.equal(await windowsGit(f.data, f.setup), null);
  assert.deepEqual(await readdir(path.join(f.data, "runtime", "git")), []);
  f.setup.extract = extract;
  assert.ok(await ensureWindowsGit(f.data, f.setup));
});

test("an interrupted download stays undiscoverable and leaves no executable", async () => {
  const f = await fixture();
  f.setup.fetch = async (_spec, directory) => {
    await writeFile(path.join(directory, "partial.exe"), "incomplete");
    throw new Error("synthetic connection lost");
  };
  await assert.rejects(ensureWindowsGit(f.data, f.setup), /synthetic connection lost/);
  assert.equal(f.counts.extractions, 0);
  assert.deepEqual(await readdir(path.join(f.data, "runtime", "git")), []);
});

test("an unsupported architecture never downloads an x64 executable", async () => {
  const f = await fixture();
  await assert.rejects(ensureWindowsGit(f.data, { ...f.setup, arch: "arm64" }), /Windows x64/);
  assert.equal(f.counts.downloads, 0);
});

test("a junction to a foreign runtime root is rejected before download or mutation", async () => {
  const f = await fixture();
  const foreign = await tmpDir("foreign-git-setup-");
  await symlink(foreign, path.join(f.data, "runtime"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(ensureWindowsGit(f.data, f.setup), /crosses a link/);
  assert.deepEqual(await readdir(foreign), []);
  assert.equal(f.counts.downloads, 0);
});

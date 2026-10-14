/**
 * The crate checker in a profile's toolchain store (`crate-check-store.ts`,
 * `ToolchainService.crateCheckTools`): cargo-deny, cargo-vet and the RustSec snapshot at the
 * recipe's pins, installed on the person's first approval, in no build lock, and kept by a prune.
 * A tool or snapshot that is not where and what the store installs (a link, a moved folder, a
 * receipt for another pin, a snapshot the policy does not pin) is not located, and locating
 * writes nothing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ToolchainService, type ToolchainStoreOps } from "../../src/main/core/toolchains.ts";
import {
  CRATE_CHECK_COMPONENTS,
  type ToolchainEntry,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
} from "../../src/shared/toolchain.ts";
import { crateCheckEntries, locateCrateCheckTools } from "../../src/substrate/toolchain-store/crate-check-store.ts";
import { type CratePolicy, readCratePolicy } from "../../src/substrate/toolchain-store/crate-policy.ts";
import { componentFolder } from "../../src/substrate/toolchain-store/locate.ts";
import { CURRENT_LOCK_FILE, lockOf, writeCurrentLock } from "../../src/substrate/toolchain-store/lock.ts";
import { entrySha12 } from "../../src/substrate/toolchain-store/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const HOST = ToolchainHost.MacArm64;
const POSIX_ONLY = process.platform === "win32" ? { skip: "link rows need POSIX links" } : {};

async function shippedPolicy(): Promise<CratePolicy> {
  const read = await readCratePolicy(path.join(REPO, "native", "genex-rust"));
  assert.ok(read.ok);
  return read.policy;
}

/** Lays one component out as an install leaves it: its files and a receipt naming its pin. */
async function lay(store: string, entry: ToolchainEntry, sha12 = entrySha12(entry)): Promise<string> {
  const folder = componentFolder(store, entry.id, { version: entry.version, sha12 });
  await mkdir(folder, { recursive: true });
  if (entry.id === ToolchainId.RustsecAdvisoryDb) {
    await mkdir(path.join(folder, "crates", "tidy"), { recursive: true });
    await writeFile(path.join(folder, "support.toml"), "");
  } else await writeFile(path.join(folder, entry.id), "#!/bin/sh\n", { mode: 0o755 });
  const receipt = {
    id: entry.id,
    version: entry.version,
    sha256: entry.archives[0]?.sha256,
    sha12,
    bytes: 1,
    host: entry.host,
    target: null,
    source: "archive",
    installedAt: "2026-10-08T00:00:00.000Z",
  };
  await writeFile(path.join(folder, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return folder;
}

/** A store with the checker laid out at the recipe's pins; answers each component's folder. */
async function laidStore(): Promise<{ store: string; folders: Map<ToolchainId, string> }> {
  const store = path.join(await realpath(await tmpDir("crate-check-store-")), "toolchains");
  const folders = new Map<ToolchainId, string>();
  for (const entry of crateCheckEntries(HOST)) folders.set(entry.id, await lay(store, entry));
  return { store, folders };
}

/** Every path under `root` with its kind and bytes: what a locate must leave as it was. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    const full = path.join(root, name);
    const info = await lstat(full);
    if (info.isDirectory()) out.push(`${name}/`, ...(await tree(full)).map((child) => `${name}/${child}`));
    else if (info.isSymbolicLink()) out.push(`${name}@`);
    else
      out.push(
        `${name}:${createHash("sha256")
          .update(await readFile(full))
          .digest("hex")}`,
      );
  }
  return out;
}

function service(store: string, ops: Partial<ToolchainStoreOps> = {}, host: ToolchainHost | null = HOST) {
  return new ToolchainService({
    store,
    host,
    emit: () => {},
    run: async () => {
      throw new Error("no command runs in these rows");
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    probeClt: async () => ({ present: true, version: "16.0" }),
    ops,
  });
}

describe("the crate checker's pins", () => {
  it("are one entry per component for each host the Rust store serves, the snapshot shared", () => {
    for (const host of [ToolchainHost.MacArm64, ToolchainHost.LinuxX64]) {
      const entries = crateCheckEntries(host);
      assert.deepEqual(
        entries.map((entry) => entry.id),
        [...CRATE_CHECK_COMPONENTS],
      );
      const tools = entries.filter((entry) => entry.id !== ToolchainId.RustsecAdvisoryDb);
      assert.ok(tools.every((entry) => entry.host === host));
      assert.equal(entries.find((entry) => entry.id === ToolchainId.RustsecAdvisoryDb)?.host, null);
    }
  });
});

describe("locating the checker", () => {
  it("finds the tools and the snapshot the store installed, at the policy's commit", async () => {
    const { store, folders } = await laidStore();
    const tools = await locateCrateCheckTools(store, HOST, await shippedPolicy());
    assert.ok(tools);
    assert.equal(path.basename(tools.cargoDeny.bin), "cargo-deny");
    assert.equal(tools.cargoDeny.version, "0.20.2");
    assert.equal(tools.cargoVet?.version, "0.10.0");
    assert.equal(tools.advisoryDb.dir, folders.get(ToolchainId.RustsecAdvisoryDb));
    assert.equal(tools.advisoryDb.commit, (await shippedPolicy()).advisories.commit);
  });

  it("finds cargo-deny and the snapshot without cargo-vet: the audits are then not asked", async () => {
    const { store, folders } = await laidStore();
    await rm(folders.get(ToolchainId.CargoVet) ?? "", { recursive: true });
    const tools = await locateCrateCheckTools(store, HOST, await shippedPolicy());
    assert.ok(tools);
    assert.equal(tools.cargoVet, null);
  });

  const hostile: ReadonlyArray<{
    label: string;
    lay: (store: string, folders: Map<ToolchainId, string>, outside: string) => Promise<void>;
    policy?: (policy: CratePolicy) => CratePolicy;
  }> = [
    {
      label: "nothing installed",
      lay: async (store) => {
        await rm(store, { recursive: true });
        await mkdir(store);
      },
    },
    {
      label: "cargo-deny is a link to a program elsewhere",
      lay: async (_store, folders, outside) => {
        const bin = path.join(folders.get(ToolchainId.CargoDeny) ?? "", "cargo-deny");
        await rm(bin);
        await writeFile(path.join(outside, "cargo-deny"), "#!/bin/sh\n", { mode: 0o755 });
        await symlink(path.join(outside, "cargo-deny"), bin);
      },
    },
    {
      label: "cargo-deny's install folder is a link to a folder elsewhere",
      lay: async (_store, folders, outside) => {
        const folder = folders.get(ToolchainId.CargoDeny) ?? "";
        const moved = path.join(outside, "moved-cargo-deny");
        await mkdir(moved);
        for (const name of await readdir(folder))
          await writeFile(path.join(moved, name), await readFile(path.join(folder, name)));
        await rm(folder, { recursive: true });
        await symlink(moved, folder);
      },
    },
    {
      label: "cargo-deny is a folder, not a program",
      lay: async (_store, folders) => {
        const bin = path.join(folders.get(ToolchainId.CargoDeny) ?? "", "cargo-deny");
        await rm(bin);
        await mkdir(bin);
      },
    },
    {
      label: "the snapshot's receipt names another pin",
      lay: async (store) => {
        const entry = crateCheckEntries(HOST).find((found) => found.id === ToolchainId.RustsecAdvisoryDb);
        assert.ok(entry);
        await rm(componentFolder(store, entry.id, { version: entry.version, sha12: entrySha12(entry) }), {
          recursive: true,
        });
        await lay(store, entry, "0".repeat(12));
      },
    },
    {
      label: "the snapshot's advisories are a link to a folder elsewhere",
      lay: async (_store, folders, outside) => {
        const crates = path.join(folders.get(ToolchainId.RustsecAdvisoryDb) ?? "", "crates");
        await rm(crates, { recursive: true });
        await mkdir(path.join(outside, "crates"));
        await symlink(path.join(outside, "crates"), crates);
      },
    },
    {
      label: "the snapshot has no advisories at all",
      lay: async (_store, folders) => {
        await rm(path.join(folders.get(ToolchainId.RustsecAdvisoryDb) ?? "", "crates"), { recursive: true });
      },
    },
    {
      label: "the policy pins another snapshot than the recipe",
      lay: async () => {},
      policy: (policy) => ({ ...policy, advisories: { ...policy.advisories, sha256: "f".repeat(64) } }),
    },
  ];
  for (const row of hostile) {
    it(`does not locate it when ${row.label}, and changes nothing`, POSIX_ONLY, async () => {
      const { store, folders } = await laidStore();
      const outside = await tmpDir("crate-check-outside-");
      await row.lay(store, folders, outside);
      const before = [await tree(store), await tree(outside)];
      const policy = await shippedPolicy();
      const found = await locateCrateCheckTools(store, HOST, row.policy ? row.policy(policy) : policy);
      assert.equal(found, null);
      assert.deepEqual([await tree(store), await tree(outside)], before);
    });
  }
});

describe("the toolchain service's checker", () => {
  it("installs the missing components on the first approval, quietly and outside every lock", async () => {
    const store = path.join(await tmpDir("crate-check-install-"), "toolchains");
    await mkdir(store, { recursive: true });
    const jobs: unknown[] = [];
    const installs: ToolchainId[][] = [];
    const tools = new ToolchainService({
      store,
      host: HOST,
      emit: (job) => jobs.push(job),
      run: async () => {
        throw new Error("the fake install runs no probe");
      },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      probeClt: async () => ({ present: true, version: "16.0" }),
      ops: {
        installComponents: async (into, entries) => {
          installs.push(entries.map((entry) => entry.id));
          for (const entry of entries) await lay(into, entry);
          return { phase: ToolchainInstallPhase.Installed, entry: null, completed: 0, total: 0, startedAt: "" };
        },
      },
    });
    const found = await tools.crateCheckTools(await shippedPolicy());
    assert.ok(found, "installed, then located");
    assert.deepEqual(installs, [[...CRATE_CHECK_COMPONENTS]]);
    assert.deepEqual(jobs, [], "the Toolchain sheet's job is not this one's");
    assert.equal(existsSync(path.join(store, CURRENT_LOCK_FILE)), false, "no lock was written");
    assert.ok(await tools.crateCheckTools(await shippedPolicy()));
    assert.equal(installs.length, 1, "a located checker is not installed again");
  });

  it("answers null when the install fails or the host has no pins, and never throws", async () => {
    const store = path.join(await tmpDir("crate-check-install-failed-"), "toolchains");
    await mkdir(store, { recursive: true });
    const failing = service(store, {
      installComponents: async () => ({
        phase: ToolchainInstallPhase.Failed,
        entry: ToolchainId.CargoDeny,
        completed: 0,
        total: 0,
        startedAt: "",
      }),
    });
    assert.equal(await failing.crateCheckTools(await shippedPolicy()), null);
    assert.equal(await service(store, {}, null).crateCheckTools(await shippedPolicy()), null);
  });

  it("keeps the checker's current pins through a prune and removes an older snapshot", async () => {
    const { store, folders } = await laidStore();
    const entry = crateCheckEntries(HOST).find((found) => found.id === ToolchainId.RustsecAdvisoryDb);
    assert.ok(entry);
    const older = await lay(store, { ...entry, version: "000000000000" }, "111111111111");
    // A current lock to prune against: a lock names none of the checker's components.
    const cmake = path.join(store, ToolchainId.Cmake, "4.4.3-222222222222");
    await mkdir(cmake, { recursive: true });
    await writeCurrentLock(store, lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: "222222222222" } }));
    const pruned = await service(store).prune([]);
    assert.ok(!("refusal" in pruned) || pruned.refusal === undefined, JSON.stringify(pruned));
    assert.ok(existsSync(cmake));
    for (const folder of folders.values()) assert.ok(existsSync(folder), folder);
    assert.equal(existsSync(older), false, "a snapshot the recipe no longer pins goes");
  });
});

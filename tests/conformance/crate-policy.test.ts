/**
 * The shipped crate policy (`native/genex-rust/crate-policy.json`, owner decision 2026-10-08,
 * option C): mode `person-decides`, the pinned RustSec snapshot the store recipe installs, the
 * vendored-set policy's licences and bans, the five trusted audit sources, and the rule that lets
 * withdrawn and unmaintained advisories through. The host reads it only as the pinned bytes:
 * a missing, changed, linked or misshapen policy is refused `crate-policy-tampered` and nothing is
 * written anywhere.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CrateAuditSource, CrateRefusal } from "../../src/shared/crate-requests.ts";
import { ToolchainHost, ToolchainId } from "../../src/shared/toolchain.ts";
import { parseTomlDocument } from "../../src/substrate/genex-toml.ts";
import {
  AdvisoryKind,
  advisoryBlocks,
  CRATE_POLICY_FILE,
  CratePolicyMode,
  readCratePolicy,
} from "../../src/substrate/toolchain-store/crate-policy.ts";
import { CRATE_BANS, CRATE_LICENCE_ALLOW } from "../../src/substrate/toolchain-store/crate-check.ts";
import { manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PAYLOAD = path.join(REPO, "native", "genex-rust");

/** deny.toml's `[licenses] allow` array, read as TOML data (the section's float key aside). */
async function denyTomlAllow(): Promise<unknown> {
  const text = await readFile(path.join(PAYLOAD, "deny.toml"), "utf8");
  const section = text.slice(text.indexOf("\n[licenses]"));
  const start = section.indexOf("\nallow = [");
  const end = section.indexOf("]", start);
  return parseTomlDocument(`[licenses]${section.slice(start, end + 1)}\n`).licenses;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

describe("the shipped crate policy", () => {
  it("is the pinned file, in person-decides mode, with deny.toml's licences and bans", async () => {
    const read = await readCratePolicy(PAYLOAD);
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.policy.mode, CratePolicyMode.PersonDecides);
    const licenses = await denyTomlAllow();
    assert.ok(typeof licenses === "object" && licenses !== null && "allow" in licenses);
    assert.deepEqual(read.policy.licences, licenses.allow);
    assert.deepEqual(read.policy.licences, [...CRATE_LICENCE_ALLOW]);
    assert.deepEqual(read.policy.bans, [...CRATE_BANS]);
  });

  it("pins the same RustSec snapshot the store recipe installs, at one commit", async () => {
    const read = await readCratePolicy(PAYLOAD);
    assert.ok(read.ok);
    const { advisories } = read.policy;
    assert.match(advisories.commit, /^[0-9a-f]{40}$/);
    for (const host of [ToolchainHost.MacArm64, ToolchainHost.LinuxX64]) {
      const entry = manifestEntry(ToolchainId.RustsecAdvisoryDb, host);
      assert.ok(entry, host);
      assert.equal(entry.version, advisories.commit.slice(0, 12));
      assert.deepEqual(
        entry.archives.map(({ url, sha256, bytes }) => ({ url, sha256, bytes })),
        [{ url: advisories.archive, sha256: advisories.sha256, bytes: advisories.bytes }],
      );
      assert.ok(advisories.archive.includes(advisories.commit));
    }
  });

  it("asks the five trusted sources, each at a commit-pinned URL, and never lets an audit refuse", async () => {
    const read = await readCratePolicy(PAYLOAD);
    assert.ok(read.ok);
    const { audits } = read.policy;
    assert.equal(audits.blocks, false);
    assert.equal(audits.criteria, "safe-to-deploy");
    assert.deepEqual(audits.imports.map((found) => found.source).sort(), Object.values(CrateAuditSource).sort());
    for (const found of audits.imports) {
      assert.match(found.url, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//, found.url);
      assert.ok(found.sha256 === null || /^[0-9a-f]{64}$/.test(found.sha256), found.source);
    }
  });

  it("writes down the advisory rule the checks apply: withdrawn and unmaintained pass, the rest blocks", async () => {
    const read = await readCratePolicy(PAYLOAD);
    assert.ok(read.ok);
    assert.equal(read.policy.advisories.pinnedAt, "2026-10-08", "the day the person is told the advisories are as of");
    assert.deepEqual(read.policy.advisories.passes, [AdvisoryKind.Unmaintained, AdvisoryKind.Withdrawn]);
    assert.deepEqual(read.policy.advisories.blocks, [
      AdvisoryKind.Vulnerability,
      AdvisoryKind.Unsound,
      AdvisoryKind.Notice,
    ]);
    const rows: ReadonlyArray<readonly [string, { informational?: string | null; withdrawn?: boolean }, boolean]> = [
      ["a vulnerability", {}, true],
      ["an unsound advisory", { informational: "unsound" }, true],
      ["a notice", { informational: "notice" }, true],
      ["an unmaintained crate", { informational: "unmaintained" }, false],
      ["a withdrawn vulnerability", { withdrawn: true }, false],
      ["a withdrawn unsound advisory", { informational: "unsound", withdrawn: true }, false],
      ["an informational kind the rule does not name", { informational: "something-new" }, true],
    ];
    for (const [label, advisory, blocks] of rows) assert.equal(advisoryBlocks(advisory), blocks, label);
  });
});

describe("a tampered or missing policy fails closed, with no side effect", () => {
  /** A payload folder holding a copy of the shipped policy; answers the folder and its bytes. */
  async function payloadCopy() {
    const dir = path.join(await tmpDir("crate-policy-"), "genex-rust");
    await mkdir(dir, { recursive: true });
    const bytes = await readFile(path.join(PAYLOAD, CRATE_POLICY_FILE));
    return { dir, bytes, file: path.join(dir, CRATE_POLICY_FILE) };
  }

  /** Every entry under `dir` with its kind and bytes: what a read must leave as it was. */
  async function tree(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const kind = info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file";
      out.push(`${name}:${kind}:${info.isFile() ? sha256(await readFile(full)) : ""}`);
      if (kind === "dir") out.push(...(await tree(full)).map((child) => `${name}/${child}`));
    }
    return out;
  }

  const edit = (bytes: Buffer, change: (policy: Record<string, unknown>) => void): Buffer => {
    const policy = JSON.parse(bytes.toString("utf8"));
    change(policy);
    return Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
  };

  const rows: ReadonlyArray<{
    label: string;
    /** Lays the hostile file out; answers the pin to read against (default: the shipped pin). */
    lay: (copy: Awaited<ReturnType<typeof payloadCopy>>) => Promise<string | undefined>;
  }> = [
    { label: "no policy at all", lay: async () => undefined },
    {
      label: "one byte changed",
      lay: async ({ file, bytes }) => {
        const changed = Buffer.from(bytes);
        changed[changed.length - 2] = 0x20;
        await writeFile(file, changed);
        return undefined;
      },
    },
    {
      label: "a link to the shipped policy",
      lay: async ({ file }) => {
        await symlink(path.join(PAYLOAD, CRATE_POLICY_FILE), file);
        return undefined;
      },
    },
    {
      label: "a folder in its place",
      lay: async ({ file }) => {
        await mkdir(file);
        return undefined;
      },
    },
    {
      label: "a file far over the cap",
      lay: async ({ file }) => {
        await writeFile(file, Buffer.alloc(4 * 1024 * 1024, 0x20));
        return undefined;
      },
    },
    {
      label: "the pin matches but the mode lets an agent decide",
      lay: async ({ file, bytes }) => {
        const changed = edit(bytes, (policy) => {
          policy.mode = "agent-decides";
        });
        await writeFile(file, changed);
        return sha256(changed);
      },
    },
    {
      label: "the pin matches but an audit may refuse",
      lay: async ({ file, bytes }) => {
        const changed = edit(bytes, (policy) => {
          const audits = policy.audits as Record<string, unknown>;
          audits.blocks = true;
        });
        await writeFile(file, changed);
        return sha256(changed);
      },
    },
    {
      label: "the pin matches but unmaintained advisories are said to block",
      lay: async ({ file, bytes }) => {
        const changed = edit(bytes, (policy) => {
          const advisories = policy.advisories as Record<string, unknown>;
          advisories.passes = ["withdrawn"];
        });
        await writeFile(file, changed);
        return sha256(changed);
      },
    },
    {
      label: "the pin matches but the snapshot digest is not one",
      lay: async ({ file, bytes }) => {
        const changed = edit(bytes, (policy) => {
          const advisories = policy.advisories as Record<string, unknown>;
          advisories.sha256 = "../../etc/passwd";
        });
        await writeFile(file, changed);
        return sha256(changed);
      },
    },
    {
      label: "the pin matches but the snapshot's day is not a date",
      lay: async ({ file, bytes }) => {
        const changed = edit(bytes, (policy) => {
          const advisories = policy.advisories as Record<string, unknown>;
          advisories.pinnedAt = "<img src=x>";
        });
        await writeFile(file, changed);
        return sha256(changed);
      },
    },
    {
      label: "the pin matches but an audit source is not a trusted one",
      lay: async ({ file, bytes }) => {
        const changed = edit(bytes, (policy) => {
          const audits = policy.audits as { imports: Array<Record<string, unknown>> };
          const first = audits.imports[0];
          if (first) first.source = "someone-else";
        });
        await writeFile(file, changed);
        return sha256(changed);
      },
    },
    {
      label: "the pin matches but it is not JSON",
      lay: async ({ file }) => {
        const changed = Buffer.from("{ not json");
        await writeFile(file, changed);
        return sha256(changed);
      },
    },
  ];
  for (const row of rows) {
    it(`refuses ${row.label}: crate-policy-tampered`, async () => {
      const copy = await payloadCopy();
      const pin = await row.lay(copy);
      const before = await tree(copy.dir);
      const read = pin === undefined ? await readCratePolicy(copy.dir) : await readCratePolicy(copy.dir, pin);
      assert.equal(read.ok, false);
      assert.equal(!read.ok && read.refusal, CrateRefusal.PolicyTampered);
      assert.deepEqual(await tree(copy.dir), before, "the read wrote, moved or removed nothing");
    });
  }

  it("reads an unchanged copy of the shipped policy", async () => {
    const copy = await payloadCopy();
    await writeFile(copy.file, copy.bytes);
    const read = await readCratePolicy(copy.dir);
    assert.equal(read.ok, true);
  });
});

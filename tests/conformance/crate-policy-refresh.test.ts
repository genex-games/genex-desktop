/**
 * `scripts/toolchains/crate-policy.ts`: moving the RustSec snapshot rewrites the shipped policy,
 * the store recipe's entry, the spike's pin row and `CRATE_POLICY_SHA256` together, and `check`
 * reports any of them drifting from the others. No row downloads anything: the rewrites are pure
 * and `check` reads a copy of the repository's four files.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PIN_FILES,
  pinDrift,
  rewriteModulePin,
  rewritePins,
  rewritePolicy,
  rewriteRecipe,
  type Snapshot,
} from "../../scripts/toolchains/crate-policy.ts";
import { ToolchainId } from "../../src/shared/toolchain.ts";
import { CRATE_POLICY_SHA256, readCratePolicy } from "../../src/substrate/toolchain-store/crate-policy.ts";
import { rustManifestOf } from "../../src/substrate/toolchain-store/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const NEXT: Snapshot = {
  commit: "a".repeat(40),
  sha256: "b".repeat(64),
  bytes: 512_000,
  pinnedAt: "2026-11-01",
};

/** A copy of the repository's four pin files under a fresh root. */
async function repoCopy(): Promise<string> {
  const root = await tmpDir("crate-policy-refresh-");
  for (const rel of Object.values(PIN_FILES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), await readFile(path.join(REPO, rel)));
  }
  return root;
}

const read = (root: string, rel: string) => readFile(path.join(root, rel), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("refreshing the crate policy's snapshot", () => {
  it("agrees with itself as shipped", async () => {
    assert.deepEqual(await pinDrift(REPO), []);
  });

  it("moves the policy, the recipe entry, the pin row and the policy's own pin together", async () => {
    const root = await repoCopy();
    const policy = rewritePolicy(await read(root, PIN_FILES.policy), NEXT);
    await writeFile(path.join(root, PIN_FILES.policy), policy);
    const recipe = rewriteRecipe(await read(root, PIN_FILES.recipe), NEXT);
    await writeFile(path.join(root, PIN_FILES.recipe), recipe);
    const pins = rewritePins(await read(root, PIN_FILES.pins), NEXT);
    await writeFile(path.join(root, PIN_FILES.pins), pins);
    const module = rewriteModulePin(await read(root, PIN_FILES.module), sha256(policy));
    assert.ok(module.includes(`export const CRATE_POLICY_SHA256 = "${sha256(policy)}";`));

    const reread = await readCratePolicy(path.join(root, "native", "genex-rust"), sha256(policy));
    assert.ok(reread.ok, JSON.stringify(reread));
    assert.equal(reread.policy.advisories.commit, NEXT.commit);
    assert.equal(reread.policy.advisories.sha256, NEXT.sha256);
    const entry = rustManifestOf(JSON.parse(recipe)).find((found) => found.id === ToolchainId.RustsecAdvisoryDb);
    assert.equal(entry?.version, NEXT.commit.slice(0, 12));
    assert.deepEqual(
      entry?.archives.map(({ url, sha256: digest, bytes }) => ({ url, digest, bytes })),
      [{ url: reread.policy.advisories.archive, digest: NEXT.sha256, bytes: NEXT.bytes }],
    );
    const rows = pins.split("\n").filter((line) => line.includes("rustsec/advisory-db/archive/"));
    assert.equal(rows.length, 1, "one snapshot row, the old one replaced");
    assert.ok(rows[0]?.includes(NEXT.sha256));
    assert.deepEqual(await pinDrift(root, sha256(policy)), []);
  });

  it("reports each pin that drifts from the shipped policy", async () => {
    const recipeDrift = await repoCopy();
    await writeFile(
      path.join(recipeDrift, PIN_FILES.recipe),
      rewriteRecipe(await read(recipeDrift, PIN_FILES.recipe), NEXT),
    );
    assert.match((await pinDrift(recipeDrift)).join("\n"), /recipe/);

    const rowDrift = await repoCopy();
    await writeFile(path.join(rowDrift, PIN_FILES.pins), rewritePins(await read(rowDrift, PIN_FILES.pins), NEXT));
    assert.match((await pinDrift(rowDrift)).join("\n"), /pins\.md/);

    const policyDrift = await repoCopy();
    await writeFile(
      path.join(policyDrift, PIN_FILES.policy),
      rewritePolicy(await read(policyDrift, PIN_FILES.policy), NEXT),
    );
    assert.match((await pinDrift(policyDrift, CRATE_POLICY_SHA256)).join("\n"), /CRATE_POLICY_SHA256/);
  });
});

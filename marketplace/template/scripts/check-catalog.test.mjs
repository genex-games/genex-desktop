/**
 * Identity and history rules of check-catalog.mjs, over throwaway catalogs. Dependency-free:
 * `node --test scripts/`. Artifacts are not checked here (no --artifacts / --remote).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCatalog } from "./check-catalog.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CURRENT = "genex-games/genex-desktop";
const LEGACY = "Rabneba/ai-game-studio";
const POLICY = {
  artifactOrigins: ["https://plugins.genex.games"],
  official: {
    genex: { publisher: "Genex", repos: [CURRENT, LEGACY] },
    blender: { publisher: "Studio", repos: [CURRENT, LEGACY] },
  },
};

/** A well-formed release record; `digest` keeps artifact addresses distinct per release. */
function release(id, version, fields = {}) {
  const official = POLICY.official[id];
  const sha256 = (fields.digest ?? `${id}${version}`).replace(/[^a-f0-9]/g, "a").padEnd(64, "0").slice(0, 64);
  const entry = {
    id,
    name: `Plugin ${id}`,
    publisher: official?.publisher ?? "Someone",
    description: "Test plugin.",
    category: "tools",
    tier: official ? "official" : "community",
    repo: official ? CURRENT : `someone/${id}`,
    sha: "a".repeat(40),
    version,
    capabilities: ["observe"],
    artifact: { url: `https://plugins.genex.games/releases/${id}/${version}/${sha256}.json`, sha256 },
    subdir: `src/plugins/${id}`,
    ...fields,
  };
  delete entry.digest;
  return entry;
}

/** Write a catalog whose index lists the highest version of each id. */
async function catalog(records, policy = POLICY) {
  const root = await mkdtemp(path.join(tmpdir(), "catalog-test-"));
  await writeFile(path.join(root, "policy.json"), JSON.stringify(policy));
  const latest = new Map();
  for (const r of records) {
    await mkdir(path.join(root, "records", r.id), { recursive: true });
    await writeFile(path.join(root, "records", r.id, `${r.version}.json`), JSON.stringify(r));
    latest.set(r.id, r);
  }
  const index = { version: 1, updatedAt: "2026-10-05T00:00:00.000Z", plugins: [...latest.values()] };
  await writeFile(path.join(root, "index.json"), JSON.stringify(index));
  return root;
}

const roots = [];
async function check(records, { previous, policy } = {}) {
  const root = await catalog(records, policy);
  roots.push(root);
  let before;
  if (previous) {
    before = await catalog(previous, policy);
    roots.push(before);
  }
  return checkCatalog({ root, previous: before });
}
test.after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

test("this repository's catalog passes under its policy", async () => {
  const report = await checkCatalog({ root: REPO_ROOT, previous: REPO_ROOT });
  assert.equal(report.ok, true);
});

test("the published records of an official id may name its legacy repository", async () => {
  const old = [release("genex", "1.4.0", { repo: LEGACY }), release("blender", "1.1.0", { repo: LEGACY })];
  assert.equal((await check(old)).ok, true);
  assert.equal((await check(old, { previous: old })).ok, true);
});

test("a new official release on the current repository continues the legacy history", async () => {
  const old = [release("genex", "1.3.2", { repo: LEGACY }), release("genex", "1.4.0", { repo: LEGACY })];
  const next = [...old, release("genex", "1.5.0", { repo: CURRENT })];
  assert.equal((await check(next, { previous: old })).ok, true);
});

test("a new official release must name the current repository, not the legacy one", async () => {
  const old = [release("genex", "1.4.0", { repo: LEGACY })];
  const next = [...old, release("genex", "1.5.0", { repo: LEGACY })];
  await assert.rejects(check(next, { previous: old }), /Official release must name genex-games\/genex-desktop: genex/);
});

const impostors = [
  ["an unlisted repository", { repo: "evil/genex" }],
  ["another publisher", { publisher: "Evil" }],
  ["the community tier", { tier: "community" }],
];
for (const [what, fields] of impostors)
  test(`an official id from ${what} is refused`, async () => {
    await assert.rejects(check([release("genex", "1.0.0", fields)]), /Reserved official identity: genex/);
  });

test("a non-official id cannot claim an official repository", async () => {
  for (const repo of [CURRENT, LEGACY, CURRENT.toUpperCase()])
    await assert.rejects(
      check([release("genex-tools", "1.0.0", { repo, publisher: "Genex" })]),
      /Official source reserved: genex-tools/,
    );
});

test("a community id cannot move to an official repository across releases", async () => {
  const old = [release("helper", "1.0.0")];
  const next = [...old, release("helper", "1.1.0", { repo: CURRENT })];
  await assert.rejects(check(next, { previous: old }), /Official source reserved: helper/);
});

test("a community id keeps a single repository", async () => {
  const old = [release("helper", "1.0.0")];
  const moved = [...old, release("helper", "1.1.0", { repo: "someone-else/helper" })];
  await assert.rejects(check(moved), /Publisher\/source ownership changed: helper/);
  await assert.rejects(check(moved, { previous: old }), /Publisher\/source ownership changed: helper/);
});

test("an official id still cannot change its subdirectory", async () => {
  const old = [release("genex", "1.4.0", { repo: LEGACY })];
  const next = [...old, release("genex", "1.5.0", { subdir: "plugins/genex" })];
  await assert.rejects(check(next, { previous: old }), /Publisher\/source ownership changed: genex/);
});

test("only the repos policy shape is accepted", async () => {
  const single = {
    artifactOrigins: POLICY.artifactOrigins,
    official: { genex: { publisher: "Genex", repo: LEGACY } },
  };
  await assert.rejects(check([release("genex", "1.4.0", { repo: LEGACY })], { policy: single }), /Invalid maintainer policy/);
  const empty = { ...POLICY, official: { genex: { publisher: "Genex", repos: [] } } };
  await assert.rejects(check([], { policy: empty }), /Invalid maintainer policy/);
});

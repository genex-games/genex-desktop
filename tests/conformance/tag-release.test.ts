/**
 * Merging a version bump into main tags it `v<version>` and starts its release (tag-release.yml).
 * A tag is created once and never moved: a published release's tag is what installed copies
 * update from.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tagRelease } from "../../scripts/tag-release.mjs";

const REPO = "fixture/repo";
const SOURCE = "0123456789abcdef0123456789abcdef01234567";

/** A gh runner that answers the tag lookup with `refs` and records every call. */
function fakeGh(refs: string[]) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1]?.includes("/git/matching-refs/")) return JSON.stringify(refs.map((ref) => ({ ref })));
    if (args[1]?.endsWith("/git/tags")) return JSON.stringify({ sha: "tag-object" });
    return "{}";
  };
  return { calls, run };
}

/** A call's `-f key=value` fields. */
const fields = (args: string[] | undefined) =>
  Object.fromEntries(
    (args ?? []).flatMap((arg, i) => (args?.[i - 1] === "-f" ? [arg.split(/=(.*)/s).slice(0, 2)] : [])),
  );

test("a new version merged into main is tagged at that commit, then its release starts on the tag", async () => {
  for (const version of ["0.1.2", "0.2.0-rc.1"]) {
    const gh = fakeGh([`refs/tags/v${version}0`, `refs/tags/v${version}-rc.9`]);
    const result = await tagRelease({ version, repo: REPO, source: SOURCE, run: gh.run });
    assert.deepEqual(result, { tag: `v${version}`, created: true });
    assert.equal(gh.calls.length, 4, JSON.stringify(gh.calls));
    assert.deepEqual(gh.calls[0], ["api", `repos/${REPO}/git/matching-refs/tags/v${version}`]);
    assert.deepEqual(fields(gh.calls[1]), {
      tag: `v${version}`,
      message: `Genex ${version}`,
      object: SOURCE,
      type: "commit",
    });
    assert.deepEqual(fields(gh.calls[2]), { ref: `refs/tags/v${version}`, sha: "tag-object" });
    assert.deepEqual(gh.calls[3], ["workflow", "run", "release.yml", "--repo", REPO, "--ref", `v${version}`]);
  }
});

test("a version that already has its tag is never tagged again or released again", async () => {
  const gh = fakeGh(["refs/tags/v0.1.1"]);
  assert.deepEqual(await tagRelease({ version: "0.1.1", repo: REPO, source: SOURCE, run: gh.run }), {
    tag: "v0.1.1",
    created: false,
  });
  assert.equal(gh.calls.length, 1, "only the lookup");
});

test("a malformed version, repository or source refuses before any remote call", async () => {
  const hostile = [
    { version: "latest" },
    { version: "0.1" },
    { version: "v0.1.2" },
    { version: "0.1.2 " },
    { version: "0.1.2/../../heads/main" },
    { version: "0.1.2", repo: "" },
    { version: "0.1.2", repo: "fixture/repo/../other" },
    { version: "0.1.2", source: "" },
    { version: "0.1.2", source: "main" },
  ];
  for (const candidate of hostile) {
    const gh = fakeGh([]);
    await assert.rejects(
      tagRelease({ repo: REPO, source: SOURCE, ...candidate, run: gh.run }),
      JSON.stringify(candidate),
    );
    assert.equal(gh.calls.length, 0, JSON.stringify(candidate));
  }
});

test("a failed lookup is not evidence the tag is absent: nothing is written", async () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    throw new Error("HTTP 502");
  };
  await assert.rejects(tagRelease({ version: "0.1.2", repo: REPO, source: SOURCE, run }), /502/);
  assert.equal(calls.length, 1);
});

/**
 * The release balances its rig shards by the times the newest earlier release left; a missing,
 * expired or unreadable record is a plan by source bytes, and a hostile one is refused.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DURATIONS_ARTIFACT, latestDurations, mergeDurations } from "../../scripts/release-durations.mjs";

const REPO = "fixture/repo";
const A = "tests/conformance/a.test.ts";
const B = "tests/conformance/b.test.ts";

test("each rig shard's times merge into one table, and a hostile table is refused", () => {
  assert.deepEqual(mergeDurations([{ [A]: 10 }, { [B]: 20 }, { [A]: 5 }]), { [A]: 10, [B]: 20 });
  assert.throws(() => mergeDurations([{ [A]: 10 }, { "../etc/passwd.test.ts": 1 }]), /Invalid test duration/);
});

/** A fake `gh`: release runs newest first, each run's artifacts, and what a download writes. */
function gh(
  runs: number[],
  artifacts: Record<number, Array<{ name: string; expired: boolean }>>,
  files: Record<number, string>,
) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "run") {
      const id = Number(args[2]);
      const dir = args[args.indexOf("--dir") + 1];
      fs.writeFileSync(path.join(dir, "durations.json"), files[id]);
      return "";
    }
    const url = args[1];
    if (url.includes("/workflows/release.yml/runs"))
      return JSON.stringify({ workflow_runs: runs.map((id) => ({ id })) });
    const id = Number(/runs\/(\d+)\/artifacts/.exec(url)?.[1]);
    return JSON.stringify({ artifacts: artifacts[id] ?? [] });
  };
  return { run, calls };
}

test("the newest earlier run with an unexpired record is read, skipping this run and expired ones", () => {
  const record = (expired = false) => [{ name: DURATIONS_ARTIFACT, expired }];
  const { run, calls } = gh(
    [9, 8, 7, 6],
    { 9: record(), 8: record(true), 7: [], 6: record() },
    { 6: JSON.stringify({ [A]: 42 }) },
  );
  assert.deepEqual(latestDurations({ repo: REPO, currentRun: "9", run }), { [A]: 42 });
  const downloads = calls.filter((args) => args[0] === "run");
  assert.deepEqual(
    downloads.map((args) => args.slice(0, 5)),
    [["run", "download", "6", "--name", DURATIONS_ARTIFACT]],
  );
  assert.ok(downloads[0].includes("--repo") && downloads[0].includes(REPO));
});

test("no earlier record plans by bytes; a hostile record or repository is refused", () => {
  assert.equal(latestDurations({ repo: REPO, run: gh([5, 4], {}, {}).run }), undefined);
  const hostile = gh(
    [5],
    { 5: [{ name: DURATIONS_ARTIFACT, expired: false }] },
    { 5: JSON.stringify({ "/abs.test.ts": 1 }) },
  );
  assert.throws(() => latestDurations({ repo: REPO, run: hostile.run }), /Invalid test duration/);
  for (const repo of [undefined, "../repo", "a/b/c", "a b/c"])
    assert.throws(() => latestDurations({ repo, run: gh([], {}, {}).run }), /Invalid repository/);
});

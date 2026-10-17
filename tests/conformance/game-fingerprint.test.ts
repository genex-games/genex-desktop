/**
 * The game folder's fingerprint while a worker writes in place (`loop/workers/game-change.ts`): a
 * tree id written through a throwaway index in the game's git folder. A fingerprint cut off by its
 * time limit can leave its index behind; the next one clears what an earlier one left, never an
 * index another fingerprint may still be writing. Real git in a temporary game.
 */
import assert from "node:assert/strict";
import { lutimes, mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GIT_TIMEOUT_MS } from "../../src/harness-seed/loop/config.ts";
import { gameFingerprint, LEFTOVER_MINUTES } from "../../src/harness-seed/loop/workers/game-change.ts";
import { gameRepo, PROJECT, poolHost } from "../helpers/worker-pool-host.ts";

/** How old a leftover index is here: well past any fingerprint's time limit. */
const LEFT_LONG_AGO_S = 10 * 60;
/** A minute ago: young enough that a fingerprint may still be writing it. */
const A_MINUTE_AGO_S = 60;

describe("the game folder's fingerprint", () => {
  it("clears a throwaway index an earlier fingerprint left, and keeps one that may still be in use", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const gitDir = path.join(repo, ".git");
    const old = path.join(gitDir, "genex-fingerprint-1-1.index");
    const oldLock = `${old}.lock`;
    const fresh = path.join(gitDir, "genex-fingerprint-2-1.index");
    for (const file of [old, oldLock, fresh]) await writeFile(file, "left\n");
    const longAgo = Date.now() / 1000 - LEFT_LONG_AGO_S;
    for (const file of [old, oldLock]) await utimes(file, longAgo, longAgo);
    const tree = await gameFingerprint(host.recorder.ctx as never, PROJECT);
    assert.match(String(tree), /^[0-9a-f]{40,64}$/, "the fingerprint is a tree id");
    const left = (await readdir(gitDir)).filter((name) => name.startsWith("genex-fingerprint-"));
    assert.deepEqual(left, ["genex-fingerprint-2-1.index"], "only the index that may be in use stays");
  });

  it("counts an index as left over only once it is older than the longest fingerprint's time limit", () => {
    assert.ok(LEFTOVER_MINUTES * 60_000 > GIT_TIMEOUT_MS.slow, "never an index a fingerprint may still be writing");
  });

  it("removes nothing but old files of its own name: a link's target, a folder and a young index stay", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const gitDir = path.join(repo, ".git");
    const outside = path.join(path.dirname(repo), "keep-me.txt");
    await writeFile(outside, "the person's file\n");
    const link = path.join(gitDir, "genex-fingerprint-link.index");
    await symlink(outside, link);
    const folder = path.join(gitDir, "genex-fingerprint-dir");
    await mkdir(folder);
    await writeFile(path.join(folder, "inside.txt"), "inside\n");
    const young = path.join(gitDir, "genex-fingerprint-3-1.index");
    await writeFile(young, "in use\n");
    const longAgo = Date.now() / 1000 - LEFT_LONG_AGO_S;
    const aMinuteAgo = Date.now() / 1000 - A_MINUTE_AGO_S;
    await lutimes(link, longAgo, longAgo);
    await utimes(folder, longAgo, longAgo);
    await utimes(young, aMinuteAgo, aMinuteAgo);
    assert.match(String(await gameFingerprint(host.recorder.ctx as never, PROJECT)), /^[0-9a-f]{40,64}$/);
    assert.equal(await readFile(outside, "utf8"), "the person's file\n", "the link's target is untouched");
    const left = (await readdir(gitDir)).filter((name) => name.startsWith("genex-fingerprint-")).sort();
    assert.ok(left.includes("genex-fingerprint-dir"), "a folder of that name stays");
    assert.equal(await readFile(path.join(folder, "inside.txt"), "utf8"), "inside\n", "and what it holds");
    assert.ok(left.includes("genex-fingerprint-3-1.index"), "a young index stays");
  });
});

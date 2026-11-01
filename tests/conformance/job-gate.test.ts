/**
 * A job's gate and box, by the chat's mode: Bypass runs it in a wider box writing the home folder, Auto
 * in the box of its write roots, Accept edits and Manual ask the person first, Plan holds it. Every box
 * denies the never-touch list for reads and writes, Claude Code's own folder in each write root for
 * writes, and the network. Pure.
 */
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JobGate, jobGate, jobPolicy } from "../../src/main/core/job-gate.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { neverTouchFence } from "../../src/substrate/engines/claude-permissions.ts";
import { NeverTouchKind, type NeverTouchList } from "../../src/substrate/engines/never-touch.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

/** Genex's data holding a worker's copy and a Claude home's snapshots, a granted folder, another game. */
async function fixture() {
  const root = await realpath(await tmpDir("job-gate-"));
  const userData = path.join(root, "userData");
  const copy = path.join(userData, "scratch", "workers", "copy-1");
  const snapshots = path.join(userData, "engine-homes", "claude", "shell-snapshots");
  const granted = path.join(root, "refs");
  const otherGame = path.join(root, "games", "other");
  for (const dir of [copy, snapshots, granted, otherGame, path.join(userData, "runs")])
    await mkdir(dir, { recursive: true });
  const list: NeverTouchList = {
    roots: [
      { path: path.join(os.homedir(), ".codex", "auth.json"), kind: NeverTouchKind.Login },
      { path: userData, kind: NeverTouchKind.GenexData },
      { path: otherGame, kind: NeverTouchKind.OtherGame },
    ],
    open: [copy],
    readOpen: [snapshots],
  };
  return { root, userData, copy, snapshots, granted, otherGame, list };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const reachOf = (f: Fixture) => ({ writeRoots: [f.copy, f.granted], neverTouch: f.list, home: os.homedir() });

/** Whether a deny list holds `target`: a folder it is in, or a glob that matches it. */
const denies = (list: readonly string[], target: string) =>
  list.some((entry) => isInside(entry, target) || path.matchesGlob(target, entry));

describe("a job's gate and box", () => {
  it("each chat mode runs, boxes, asks or holds a job", () => {
    const table = [
      [PermissionMode.Bypass, JobGate.Wide],
      [PermissionMode.Auto, JobGate.Boxed],
      [PermissionMode.AcceptEdits, JobGate.Ask],
      [PermissionMode.Manual, JobGate.Ask],
      [PermissionMode.Plan, JobGate.Plan],
    ] as const;
    for (const [mode, gate] of table) assert.equal(jobGate(mode), gate, mode);
  });

  it("a job's box writes only its roots, Bypass adds the home folder, and neither reaches the never-touch list or the network", async () => {
    const f = await fixture();
    const fence = await neverTouchFence(f.list);
    // Off a Mac the box denies only a Claude Code folder that exists, so each root holds one.
    for (const root of [f.copy, f.granted]) await mkdir(path.join(root, ".claude"), { recursive: true });
    for (const gate of [JobGate.Wide, JobGate.Boxed, JobGate.Ask]) {
      const policy = jobPolicy(gate, reachOf(f), fence);
      const roots = [f.copy, f.granted];
      const writes = gate === JobGate.Wide ? [os.homedir(), ...roots] : roots;
      assert.deepEqual(policy.allowWrite, writes, `${gate}: its write roots`);
      assert.deepEqual(policy.allowedDomains, [], `${gate}: no outbound network`);
      assert.equal(policy.allowLocalBinding, true, `${gate}: a server on localhost`);
      const denyRead = policy.denyRead ?? [];
      const denyWrite = policy.denyWrite ?? [];
      for (const denied of [denyRead, denyWrite]) {
        assert.ok(denied.includes(f.otherGame), `${gate}: another game`);
        assert.ok(denied.includes(path.join(f.userData, "runs")), `${gate}: Genex's data beside the copy`);
        assert.ok(!denied.includes(f.copy), `${gate}: its own copy stays open`);
        assert.ok(!denied.includes(f.userData), `${gate}: the folder holding its copy is fenced around it`);
      }
      assert.ok(!denyRead.includes(f.snapshots), `${gate}: a folder open for reading is read`);
      assert.ok(denies(denyWrite, f.snapshots), `${gate}: and never written`);
      for (const root of roots)
        assert.ok(denies(denyWrite, path.join(root, ".claude")), `${gate}: Claude Code's folder in ${root}`);
    }
  });

  it("a box whose roots do not hold the game's own folder never writes it; one working in the game does", async () => {
    const f = await fixture();
    const fence = await neverTouchFence(f.list);
    const game = path.join(f.root, "games", "mine");
    for (const gate of [JobGate.Boxed, JobGate.Ask]) {
      const copy = jobPolicy(gate, { ...reachOf(f), gameFolder: game }, fence);
      assert.ok(copy.denyWrite?.includes(game), `${gate}: a copy's job never writes the game`);
      const inGame = jobPolicy(gate, { ...reachOf(f), writeRoots: [game], gameFolder: game }, fence);
      assert.equal(inGame.denyWrite?.includes(game), false, `${gate}: a job in the game writes it`);
    }
    const wide = jobPolicy(JobGate.Wide, { ...reachOf(f), gameFolder: game }, fence);
    assert.equal(wide.denyWrite?.includes(game), false, "Bypass's box writes the home folder, as the Bypass worker's");
  });

  it("a Bypass job's box writes the home folder and its roots and denies the never-touch list", async () => {
    // A Bypass worker itself has no box (it runs as the person); its jobs still start in this one.
    const f = await fixture();
    const fence = await neverTouchFence(f.list);
    const reach = reachOf(f);
    const policy = jobPolicy(JobGate.Wide, reach, fence);
    assert.deepEqual(policy.allowWrite, [reach.home, ...reach.writeRoots], "the home folder and its roots");
    for (const denied of fence.writes) assert.ok(policy.denyWrite?.includes(denied), `never writes ${denied}`);
    for (const denied of fence.reads) assert.ok(policy.denyRead?.includes(denied), `never reads ${denied}`);
  });
});

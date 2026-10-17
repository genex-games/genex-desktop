/**
 * A job's gate and box, by the chat's mode: Bypass runs it in the Bypass worker's wider box, Auto in
 * the box of its write roots, Accept edits and Manual ask the person first, Plan holds it. Every box
 * denies the never-touch list for reads and writes, Claude Code's own folder in each write root for
 * writes, and the network. Pure: the box is compared with the one Claude Code's engine builds for a
 * Bypass worker of the same seat, through the engine's own interface (an injected `query()`).
 */
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JobGate, jobGate, jobPolicy } from "../../src/main/core/job-gate.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { neverTouchFence } from "../../src/substrate/engines/claude-permissions.ts";
import { NeverTouchKind, type NeverTouchList } from "../../src/substrate/engines/never-touch.ts";
import type { WorkerSeat } from "../../src/substrate/engines/types.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { baseDenyRead } from "../../src/substrate/spawn.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
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

/** The box Claude Code's engine builds for a Bypass worker of the same seat. */
async function bypassWorkerBox(f: Fixture) {
  const seen: Array<Record<string, unknown>> = [];
  const queryFn = ((params: { options?: Record<string, unknown> }) => {
    seen.push(params.options ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, usage: {} };
      },
    };
  }) as never;
  const engine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: path.join(f.root, "engine-home"),
    systemHome: path.join(f.root, "no-system-login"),
    queryFn,
    protectedPaths: [],
  });
  const seat: WorkerSeat = {
    id: "w1",
    title: "Scene builder",
    mode: PermissionMode.Bypass,
    writeRoots: [f.copy, f.granted],
    neverTouch: f.list,
    research: false,
    asks: {
      mode: PermissionMode.Bypass,
      allow: [],
      directories: [],
      protectWrites: [],
      ask: async () => ({ decision: "allow" }),
      screen: async () => null,
      worker: { id: "w1", title: "Scene builder" },
    },
  };
  await engine.delegate({ prompt: "build", cwd: f.copy, worker: seat } as never);
  const sandbox = seen[0]?.sandbox as { filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] } };
  assert.ok(sandbox, "the worker ran in a box");
  return sandbox.filesystem;
}

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

  it("a Bypass job's box is the Bypass worker's box, less what every sandboxed process is denied already", async () => {
    const f = await fixture();
    const policy = jobPolicy(JobGate.Wide, reachOf(f), await neverTouchFence(f.list));
    const worker = await bypassWorkerBox(f);
    // The engine's own protected list (the sign-in stores and its login homes) is the base sandbox's
    // for every job; the never-touch list the host builds names the sign-in stores as well.
    const engineOwn = new Set([...baseDenyRead(), path.join(f.root, "no-system-login")]);
    const own = (list: string[]) => list.filter((dir) => !engineOwn.has(dir));
    assert.deepEqual(policy.allowWrite, worker.allowWrite, "the same writable folders");
    assert.deepEqual(policy.denyWrite, own(worker.denyWrite), "the same write denies");
    assert.deepEqual(policy.denyRead, own(worker.denyRead), "the same read denies");
  });
});

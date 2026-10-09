/**
 * `preview.computer`: the computer tool for an engine whose tool loop is the harness's own. It runs
 * only on a window the harness leased, only on this game's folder or a build of this run (checked by
 * real path), keeps one session per window until it is released, and answers the schema on describe.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { computerRpc, type ComputerRpcHost } from "../../src/main/core/computer-rpc.ts";
import type { ComputerGrant, ComputerTools } from "../../src/main/core/computer-tools.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A host over real folders, whose computers record each call and count how often one was built. */
async function hostWith() {
  const base = await tmpDir("computer-rpc-");
  const games = path.join(base, "games");
  const scratch = path.join(base, "scratch");
  const outside = path.join(base, "outside");
  for (const dir of [
    path.join(games, "kart"),
    path.join(games, "other"),
    path.join(scratch, "autopilot", "run_1", "wt"),
    outside,
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(outside, "x"), "");
  const built: Array<{ grant: ComputerGrant; root: string }> = [];
  const host: ComputerRpcHost = {
    gameDir: (project) => path.join(games, project),
    scratch: () => scratch,
    runs: () => path.join(base, "runs"),
    port: () => ({}) as never,
    computerTools: async (grant, root): Promise<ComputerTools> => {
      built.push({ grant, root });
      return {
        liveTools: [{ name: "computer", description: "hands", parameters: { type: "object", properties: {} } }],
        onLiveTool: async (_name, args) => `did ${String(args.action)}`,
        ensureLoaded: async () => ({ port: {} as never, problem: null, note: null }),
        screen: () => ({}) as never,
        root: () => root,
        retarget: () => {},
        trace: () => ({ path: null, steps: built.length, deterministic: false, reachedAt: null }),
        runtime: "browser",
        release: async () => {},
      };
    },
  };
  return { host, built, games, scratch, outside, base };
}

describe("preview.computer", () => {
  it("runs on a leased window, keeps one session per window, and answers the schema on describe", async () => {
    const { host, built, games } = await hostWith();
    const rpc = computerRpc(host);
    const grant = { project: "kart", root: path.join(games, "kart"), handle: "pool-1", role: "judge" as const };
    const schema = await rpc.call({ ...grant, describe: true });
    assert.equal("tool" in schema && schema.tool.name, "computer");
    const answer = await rpc.call({ ...grant, args: { action: "key", text: "w" } });
    assert.equal("answer" in answer && answer.answer, "did key");
    assert.equal(built.length, 1, "one session for the window");
    assert.equal(built[0]!.grant.role, "judge");
    rpc.forget("pool-1");
    await rpc.call({ ...grant, args: { action: "key" } });
    assert.equal(built.length, 2, "a released window starts a new session");
    await rpc.call({ ...grant, role: "playtester", args: { action: "key" } });
    assert.equal(built.length, 3, "another role is another session");
  });

  it("refuses the person's own window, and any build that is not this game's or this run's", async () => {
    const { host, built, games, scratch, outside, base } = await hostWith();
    await symlink(outside, path.join(games, "kart", "escape"));
    const rpc = computerRpc(host);
    const ok = { project: "kart", handle: "pool-1" };
    await rpc.call({ ...ok, root: path.join(scratch, "autopilot", "run_1", "wt"), runId: "run_1", args: {} });
    const hostile: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...ok, handle: "live", root: path.join(games, "kart") }, /never the person's own/],
      [{ ...ok, handle: "stand-in", root: path.join(games, "kart") }, /never the person's own/],
      [{ ...ok, handle: "", root: path.join(games, "kart") }, /leased/],
      [{ ...ok, root: path.join(games, "kart", "..", "other") }, /not this game's folder/],
      [{ ...ok, root: outside }, /not this game's folder/],
      [{ ...ok, root: path.join(games, "kart", "escape") }, /not this game's folder/],
      [{ ...ok, root: path.join(base, "missing") }, /not this game's folder/],
      [{ ...ok, root: path.join(scratch, "autopilot", "run_1", "wt") }, /not this game's folder/],
      [{ ...ok, root: path.join(scratch, "autopilot", "run_1", "wt"), runId: "run_2" }, /not this game's folder/],
    ];
    for (const [params, why] of hostile) await assert.rejects(rpc.call(params as never), why, JSON.stringify(params));
    assert.equal(built.length, 1, "nothing hostile built a session");
  });
});

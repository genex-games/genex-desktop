/**
 * Substrate additions for Autopilot: preview pool, worktree RPC,
 * per-directory delegation lock, budget ledger, and the judge/ freeze. All behavior-preserving
 * for existing callers — these tests assert the new seams and the old defaults side by side.
 */
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { BudgetLedger, usageTokens, workClassOf } from "../../src/substrate/budget.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { PreviewPool } from "../../src/substrate/preview-pool.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import type { DelegateResult } from "../../src/substrate/engines/types.ts";
import { tools as selfTools } from "../../src/harness-seed/tools/self-tools.ts";
import { makeFakePreview, startRig, type Rig } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

type Api = Record<string, (params: unknown) => Promise<unknown>>;
const apiOf = (rig: Rig): Api => rig.core.api() as unknown as Api;

describe("preview pool", () => {
  it("routes no handle and 'live' to the visible view; leases are separate ports", async () => {
    const live = makeFakePreview();
    const headless: ReturnType<typeof makeFakePreview>[] = [];
    const pool = new PreviewPool({
      live,
      createHeadless: async () => {
        const port = makeFakePreview();
        headless.push(port);
        return port;
      },
      max: 2,
    });

    assert.equal(pool.port(), live);
    assert.equal(pool.port("live"), live);

    const a = await pool.acquire({ label: "terrain" });
    const b = await pool.acquire({ label: "lighting" });
    assert.notEqual(a.handle, b.handle);
    assert.equal(pool.port(a.handle), headless[0]);
    assert.equal(pool.port(b.handle), headless[1]);
    assert.equal(pool.leaseCount, 2);

    await assert.rejects(pool.acquire({ label: "third" }), /exhausted/);
    await pool.release(a.handle);
    assert.equal(pool.leaseCount, 1);
    assert.throws(() => pool.port(a.handle), /unknown preview handle/);
    // Releasing twice, or releasing "live", is a no-op — never an error mid-teardown.
    await pool.release(a.handle);
    await pool.release("live");
    assert.equal(pool.port(), live);
  });

  it("disposes headless ports on release and refuses to acquire without a factory", async () => {
    let disposed = 0;
    const port = { ...makeFakePreview(), dispose: () => void disposed++ } as PreviewPort;
    const pool = new PreviewPool({ live: makeFakePreview(), createHeadless: async () => port, max: 1 });
    const lease = await pool.acquire({ label: "x" });
    await pool.release(lease.handle);
    assert.equal(disposed, 1);

    const liveOnly = new PreviewPool({ live: makeFakePreview() });
    await assert.rejects(liveOnly.acquire({ label: "x" }), /no headless preview capability/);
  });
});

describe("budget ledger", () => {
  it("never blocks user work, blocks improvement work while user work is in flight", async () => {
    const ledger = new BudgetLedger({ file: path.join(await tmpDir("budget-"), "ledger.json") });
    assert.deepEqual(ledger.gate({ class: "user" }), { ok: true });
    assert.deepEqual(ledger.gate({ class: "improvement" }), { ok: true });

    ledger.beginWork("user");
    const gated = ledger.gate({ class: "improvement" });
    assert.equal(gated.ok, false);
    assert.match((gated as { reason: string }).reason, /user work is running/);
    // Improvement in flight never blocks anything.
    ledger.endWork("user");
    ledger.beginWork("improvement");
    assert.deepEqual(ledger.gate({ class: "user" }), { ok: true });
    assert.deepEqual(ledger.gate({ class: "improvement" }), { ok: true });
  });

  it("caps the improvement share of the day but always allows the floor", async () => {
    const file = path.join(await tmpDir("budget-"), "ledger.json");
    const ledger = new BudgetLedger({ file, improvementShare: 0.15, improvementFloorTokens: 1_000 });
    // Under the floor: allowed even though the share of a quiet day would be ~0.
    ledger.record({ tokens: 500, class: "improvement" });
    assert.equal(ledger.gate({ class: "improvement" }).ok, true);
    // Past the floor with no user work to earn a share against: refused.
    ledger.record({ tokens: 600, class: "improvement" });
    assert.equal(ledger.gate({ class: "improvement" }).ok, false);
    // A day of heavy user work raises the allowance again.
    ledger.record({ tokens: 100_000, class: "user" });
    assert.equal(ledger.gate({ class: "improvement" }).ok, true);

    // Day totals persist and survive a reload.
    await ledger.flush();
    const reloaded = new BudgetLedger({ file });
    await reloaded.load();
    assert.deepEqual(reloaded.today(), { user: 100_000, improvement: 1_100 });
  });

  it("run gates, counts the call in flight and records its usage, even when it fails", async () => {
    const ledger = new BudgetLedger({
      file: path.join(await tmpDir("budget-"), "ledger.json"),
      improvementFloorTokens: 1_000,
    });
    let inFlight = -1;
    const answer = await ledger.run(workClassOf("user"), async () => {
      inFlight = ledger.userInFlight;
      return { usage: { input_tokens: 40, output_tokens: 2 } };
    });
    assert.deepEqual(answer, { usage: { input_tokens: 40, output_tokens: 2 } });
    assert.equal(inFlight, 1);
    assert.equal(ledger.userInFlight, 0);
    assert.deepEqual(ledger.today(), { user: 42, improvement: 0 });

    await assert.rejects(
      ledger.run("user", async () => {
        throw new Error("engine down");
      }),
      /engine down/,
    );
    assert.equal(ledger.userInFlight, 0);

    ledger.record({ tokens: 1_000, class: "improvement" });
    let ran = false;
    await assert.rejects(
      ledger.run(workClassOf("improvement"), async () => {
        ran = true;
        return {};
      }),
      /^Error: budget: improvement work has spent its daily share/,
    );
    assert.equal(ran, false);
    // Anything but an explicit "improvement" is user work.
    assert.equal(workClassOf(undefined), "user");
    assert.equal(workClassOf("anything"), "user");
  });

  it("usageTokens tolerates partial usage records", () => {
    assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5 }), 15);
    assert.equal(usageTokens({ input_tokens: 10, cache_read_tokens: 3 }), 13);
    assert.equal(usageTokens(undefined), 0);
    assert.equal(usageTokens({ input_tokens: Number.NaN }), 0);
  });

  it("counts a Codex cache read once: its input_tokens already holds it", async () => {
    const codex = { input_tokens: 100, cache_read_tokens: 80, output_tokens: 5 };
    assert.equal(usageTokens(codex, EngineId.Codex), 105);
    assert.equal(usageTokens(codex, EngineId.ClaudeCode), 185, "Claude's input_tokens leaves cache reads out");
    const ledger = new BudgetLedger({ file: path.join(await tmpDir("budget-"), "ledger.json") });
    ledger.recordUsage(workClassOf("user"), codex, EngineId.Codex);
    await ledger.run(workClassOf("user"), async () => ({ usage: codex }), EngineId.Codex);
    assert.deepEqual(ledger.today(), { user: 210, improvement: 0 });
  });
});

describe("judge freeze (seed guard)", () => {
  it("write_own_file refuses judge/ before touching anything", async () => {
    const write = selfTools.find((tool: { name: string }) => tool.name === "write_own_file") as {
      execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
    };
    const ctx = {
      workspace: "/nowhere",
      call: async () => {
        throw new Error("must refuse before any substrate call");
      },
      notify: () => {},
    };
    await assert.rejects(
      write.execute({ file: "judge/blind-compare.md", contents: "x", reason: "test" }, ctx),
      /judge\/ is frozen/,
    );
    await assert.rejects(write.execute({ file: "judge", contents: "x", reason: "test" }, ctx), /frozen/);
  });
});

describe("autopilot substrate over the real rig", () => {
  it("worktree RPC, per-cwd delegation lock, cwd jail, and the sandboxed judge/ denial", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const api = apiOf(rig);

    const project = ((await api["game.scaffold"]!({ name: "wtgame", kind: "web" })) as { name: string }).name;

    // — worktree RPC: two detached, playable forks of the same game —
    const wt1 = (await api["snapshot.worktree"]!({ project, name: "facet-a", runId: "run1" })) as {
      path: string;
      commit: string;
    };
    const wt2 = (await api["snapshot.worktree"]!({ project, name: "facet-b", runId: "run1" })) as {
      path: string;
      commit: string;
    };
    assert.notEqual(wt1.path, wt2.path);
    assert.equal(wt1.commit, wt2.commit);
    assert.ok((await stat(path.join(wt1.path, "index.html"))).isFile(), "a worktree is a playable copy");
    assert.ok(wt1.path.startsWith(path.resolve(rig.core.layout.scratch) + path.sep), "worktrees live under scratch");
    await assert.rejects(api["snapshot.worktree"]!({ project, name: "../escape", runId: "run1" }), /slug/);

    // Worktrees are writable to sandboxed agent processes (a facet contractor edits here).
    const exec = (await api["run.exec"]!({
      command: "echo facet-work > facet-note.txt",
      cwd: wt1.path,
    })) as { code: number | null };
    assert.equal(exec.code, 0);
    assert.equal((await readFile(path.join(wt1.path, "facet-note.txt"), "utf8")).trim(), "facet-work");

    // — the sandbox denies writes into judge/ even via raw shell —
    const judgeFiles = await api["run.exec"]!({ command: "ls judge" }).then((r) => (r as { stdout: string }).stdout);
    assert.ok(judgeFiles.trim().length > 0, "the seed ships judge rubrics");
    const denied = (await api["run.exec"]!({
      command: "echo bent-yardstick >> judge/$(ls judge | head -1)",
    })) as { code: number | null };
    assert.notEqual(denied.code, 0, "a judge/ write must be denied by the sandbox");
    const readsFine = (await api["run.exec"]!({
      command: "cat judge/$(ls judge | head -1) > /dev/null && echo ok",
    })) as { code: number | null; stdout: string };
    assert.equal(readsFine.stdout.trim(), "ok", "judge/ stays readable — frozen, not hidden");

    // — nor into the harness's own code, from its folder or any other: that goes through the
    //   self-edit gate (write_own_file), never around it —
    const harnessWs = rig.core.layout.harnessWs;
    for (const [command, cwd] of [
      ["echo 'export const x = 1;' > tools/x.ts", undefined],
      ["echo '// bent' >> loop/main.ts", undefined],
      ["echo '{}' > tsconfig.json", undefined],
      // B7: prompts and skills change only through guardian.write_self, like the judge never does.
      ["echo note > skills/.probe", undefined],
      ["echo note > prompts/.probe", undefined],
      [`echo 'export const y = 1;' > ${JSON.stringify(path.join(harnessWs, "memory", "y.ts"))}`, wt1.path],
    ] as const) {
      const result = (await api["run.exec"]!({ command, ...(cwd ? { cwd } : {}) })) as { code: number | null };
      assert.notEqual(result.code, 0, `${command} must be denied`);
    }
    await assert.rejects(stat(path.join(harnessWs, "tools", "x.ts")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(harnessWs, "memory", "y.ts")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(harnessWs, "skills", ".probe")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(harnessWs, "prompts", ".probe")), { code: "ENOENT" });
    assert.doesNotMatch(await readFile(path.join(harnessWs, "loop", "main.ts"), "utf8"), /\/\/ bent/);
    const notes = (await api["run.exec"]!({
      command: "echo note > library/.probe && cat library/.probe && rm library/.probe",
    })) as { code: number | null };
    assert.equal(notes.code, 0, "the rest of the harness folder stays writable");

    // — delegation lock is per-directory: two worktrees of one game build in parallel —
    const settled: Array<() => void> = [];
    const result: DelegateResult = { ok: true, summary: "done", usage: {}, turns: 1, engine: "fake-delegate" };
    rig.core.engines.register({
      id: "fake-delegate",
      label: "Fake delegate",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: () => new Promise((resolve) => settled.push(() => resolve(result))),
    });
    const first = api["engine.delegate"]!({ engine: "fake-delegate", prompt: "a", project, cwd: wt1.path });
    const second = api["engine.delegate"]!({ engine: "fake-delegate", prompt: "b", project, cwd: wt2.path });
    // Observe readiness rather than assuming asynchronous tool discovery finishes in 50 ms.
    const waitDelegates = async (count: number) => {
      const until = Date.now() + 5000;
      while (settled.length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled.length, count, "delegates reached the fixture engine");
    };
    await waitDelegates(2);
    const listed = (await api["engine.delegations"]!({})) as Array<{ project: string; cwd: string }>;
    assert.equal(listed.length, 2, "two facet worktrees of one project delegate concurrently");
    assert.ok(listed.every((d) => d.project === project));
    await assert.rejects(
      api["engine.delegate"]!({ engine: "fake-delegate", prompt: "c", project, cwd: wt1.path }),
      /already building/,
    );
    // Same live folder twice still collides (the original invariant, now keyed by cwd).
    const live = api["engine.delegate"]!({ engine: "fake-delegate", prompt: "d", project });
    await waitDelegates(3);
    await assert.rejects(
      api["engine.delegate"]!({ engine: "fake-delegate", prompt: "e", project }),
      /already building/,
    );
    for (const release of settled) release();
    await Promise.all([first, second, live]);
    assert.equal(((await api["engine.delegations"]!({})) as unknown[]).length, 0);

    // — the cwd jail: a delegation may only build in the project folder or a scratch worktree —
    await assert.rejects(
      api["engine.delegate"]!({ engine: "fake-delegate", prompt: "x", project, cwd: "/etc" }),
      /must be the project folder or a scratch worktree/,
    );

    // — removeWorktree cleans up, and its rm is jailed to scratch —
    await api["snapshot.removeWorktree"]!({ project, path: wt1.path });
    await assert.rejects(stat(wt1.path), /ENOENT/);
    await assert.rejects(
      api["snapshot.removeWorktree"]!({ project, path: rig.core.games.dirFor(project) }),
      /outside scratch/,
    );
  });
});

describe("v2 contract upgrade", () => {
  it("replaces a pre-v2 studio.js with the template's and keeps the old copy", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const api = rig.core.api() as Record<string, (p: never) => Promise<unknown>>;
    await api["game.scaffold"]!({ name: "oldgame", title: "Old", kind: "web" } as never);
    const dir = path.join(rig.core.layout.gamesRoot, "oldgame");
    // A fresh scaffold already carries v2: nothing to do.
    // A fresh scaffold already carries v2 and the material library: nothing to do.
    assert.deepEqual(await api["game.upgradeContract"]!({ project: "oldgame" } as never), {
      upgraded: false,
      materialsAdded: false,
    });
    // A v1 contract (no inspect()) the studio shipped is upgraded, the old file kept beside it.
    await writeFile(
      path.join(dir, "src", "studio.js"),
      await readFile(path.join(import.meta.dirname, "..", "fixtures", "shipped", "studio-generation-1.js.txt"), "utf8"),
    );
    const before = (await api["game.validate"]!({ project: "oldgame" } as never)) as { warnings: string[] };
    assert.ok(
      before.warnings.some((w) => /predates the v2 contract/.test(w)),
      "validate names the old contract",
    );
    const result = (await api["game.upgradeContract"]!({ project: "oldgame" } as never)) as {
      upgraded: boolean;
      backup: string;
    };
    assert.equal(result.upgraded, true);
    assert.equal(result.backup, "src/studio.v1.js");
    assert.match(await readFile(path.join(dir, "src", "studio.js"), "utf8"), /inspect/);
    assert.match(await readFile(path.join(dir, "src", "studio.v1.js"), "utf8"), /version: 1/);
    // A v1 main.js on the v2 studio.js: the contract exists, the game does not feed it yet.
    await writeFile(
      path.join(dir, "src", "main.js"),
      'import { installStudio } from "./studio.js";\ninstallStudio({ update() {}, render() {} });\n',
    );
    const validation = (await api["game.validate"]!({ project: "oldgame" } as never)) as { warnings: string[] };
    assert.ok(
      validation.warnings.some((w) => /without scene\/camera\/player/.test(w)),
      "validate now asks main.js to pass the v2 config",
    );
  });
});

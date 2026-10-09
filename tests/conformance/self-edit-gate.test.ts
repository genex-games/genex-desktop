/**
 * The self-edit gate: a change to the harness's own code is tried in a validation fork — type-
 * checked by the vendored TypeScript 7 compiler, then booted — before the harness writes it
 * (`guardian.validate_edit`, main/core/self-edit-gate.ts). Driven through the seed's own
 * write_own_file and install_tool against a real core, so what is asserted is what the agent sees
 * and what lands on disk.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { tools as selfTools } from "../../src/harness-seed/tools/self-tools.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { makeResources } from "../helpers/resources.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";

type Outcome = string | { ok?: boolean; content?: string };
type Tool = { name: string; execute(args: Record<string, unknown>, ctx: unknown): Promise<Outcome> };

/** Run one of the seed's self tools the way the harness does, its host calls going to the core. */
async function run(
  lite: CoreLite,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const tool = (selfTools as unknown as Tool[]).find((entry) => entry.name === name)!;
  const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  const ctx = {
    workspace: lite.core.layout.harnessWs,
    threadId: lite.core.mainThread,
    cancelled: false,
    call: (method: string, params: unknown) => api[method]!(params),
    notify: () => {},
    setStatus: () => {},
  };
  const outcome = await tool.execute(args, ctx);
  return typeof outcome === "string"
    ? { ok: true, content: outcome }
    : { ok: outcome.ok !== false, content: outcome.content ?? "" };
}

async function harnessEvents(lite: CoreLite): Promise<string[]> {
  return (await lite.core.listAllEvents()).map((event) =>
    event.data.type === "custom" ? event.data.event_type : event.data.type,
  );
}

const HELPER = "loop/helper.ts";
const VALID = "export const helper = (n: number): number => n + 1;\n";
const BROKEN = "export const helper = (n: number): number => `${n}`;\n";

describe("the self-edit gate", () => {
  it("a validation fork cannot write a live game or abort live provider work", async () => {
    const lite = await coreLite();
    await lite.core.games.scaffold("pong");
    const api = lite.core.api.bind(lite.core);
    let aborts = 0;
    lite.core.api = () => ({
      ...api(),
      [HostMethod.EngineAbort]: async () => {
        aborts += 1;
        return { aborted: 0 };
      },
    });
    const contents = [
      'import type { Host } from "../types/harness.d.ts";',
      'import { HostMethod } from "./host-methods.ts";',
      'export { judgeableFirst } from "./chat-dispatch.ts";',
      'export { loopRunRefusal } from "./run-dispatch.ts";',
      "export async function createStudio(host: Host) {",
      "  await host.call(HostMethod.EngineAbort, {}).catch(() => {});",
      '  await host.call(HostMethod.GameWrite, {project:"pong", file:"intrusion.txt", contents:"forged"}).catch(() => {});',
      '  return {status:()=>"idle", dispatch:async()=>{}, shutdown:async()=>{},',
      "    healthcheck:async()=>({ok:true, head:await host.call(HostMethod.EventsHead,{})})};",
      "}",
    ].join("\n");
    const outcome = await run(lite, "write_own_file", {
      file: "loop/main.ts",
      contents,
      reason: "probe fork authority",
    });
    assert.equal(outcome.ok, true, outcome.content);
    assert.equal(aborts, 0, "fork RPC never reaches the live abort handler");
    await assert.rejects(readFile(path.join(lite.core.games.dirFor("pong"), "intrusion.txt")), { code: "ENOENT" });
  });
  it("refuses a type-broken code edit with the compiler's diagnostics and leaves the workspace as it was", async () => {
    const lite = await coreLite();
    const before = await harnessEvents(lite);
    const result = await run(lite, "write_own_file", { file: HELPER, contents: BROKEN, reason: "a helper" });

    assert.equal(result.ok, false);
    assert.match(result.content, /^Not applied: loop\/helper\.ts is unchanged/);
    assert.match(
      result.content,
      /loop\/helper\.ts\(1,\d+\): error TS2322: Type 'string' is not assignable to type 'number'/,
      "the agent reads the compiler's own line",
    );
    await assert.rejects(
      readFile(path.join(lite.core.layout.harnessWs, HELPER), "utf8"),
      { code: "ENOENT" },
      "nothing was written",
    );
    assert.deepEqual(await harnessEvents(lite), before, "no snapshot and no self_edit: nothing happened");
    assert.deepEqual(await lite.core.snapshots.uncommittedPaths("harness"), [], "no stray fork files in the workspace");
  });

  it("accepts a code edit that type-checks and boots, and snapshots it healthy at once", async () => {
    const lite = await coreLite();
    const result = await run(lite, "write_own_file", { file: HELPER, contents: VALID, reason: "a helper" });

    assert.equal(result.ok, true, result.content);
    assert.equal(await readFile(path.join(lite.core.layout.harnessWs, HELPER), "utf8"), VALID);
    const edit = (await lite.core.listAllEvents()).find(
      (event) => event.data.type === "custom" && event.data.event_type === "self_edit",
    );
    const payload = (edit?.data as { payload?: { snapshot_id?: string; post_snapshot_id?: string } } | undefined)
      ?.payload;
    assert.ok(payload?.snapshot_id && payload.post_snapshot_id, "before and after snapshots, as ever");
    assert.equal(
      lite.core.snapshotIndex.get(payload.post_snapshot_id)?.healthy,
      true,
      "code a fork booted is a rewind target",
    );
    assert.equal(lite.core.snapshotIndex.newestHealthy("harness")?.snapshot_id, payload.post_snapshot_id);
  });

  it("does not hold an edit to errors the self already had elsewhere, only to the ones it adds", async () => {
    const lite = await coreLite();
    const ws = lite.core.layout.harnessWs;
    // A migrated file of the agent's that never type-checked: it must not freeze every later edit.
    await writeFile(path.join(ws, "loop", "old-mine.ts"), "export const old: number = 'still a string';\n");
    const clean = await run(lite, "write_own_file", { file: HELPER, contents: VALID, reason: "a helper" });
    assert.equal(clean.ok, true, clean.content);

    // An edit that breaks a caller elsewhere is refused, with only the error it adds.
    await writeFile(
      path.join(ws, "loop", "uses-helper.ts"),
      'import { helper } from "./helper.ts";\nexport const two: number = helper(1);\n',
    );
    const breaking = await run(lite, "write_own_file", {
      file: HELPER,
      contents: "export const helper = (n: number): string => `${n}`;\n",
      reason: "strings now",
    });
    assert.equal(breaking.ok, false);
    assert.match(breaking.content, /1 new type error\.\nloop\/uses-helper\.ts\(2,\d+\): error TS2322/);
    assert.doesNotMatch(breaking.content, /old-mine/, "the error the self already had is not the edit's");
    assert.equal(await readFile(path.join(ws, HELPER), "utf8"), VALID);
  });

  it("checks against the app's own tsconfig, so loosening the workspace's does not turn the check off", async () => {
    const lite = await coreLite();
    const config = path.join(lite.core.layout.harnessWs, "tsconfig.json");
    const shipped = JSON.parse(await readFile(config, "utf8")) as { compilerOptions: Record<string, unknown> };
    // The config is not code: nothing gates an edit to it, by accident or on purpose.
    for (const loosened of [
      { ...shipped, compilerOptions: { ...shipped.compilerOptions, noCheck: true } },
      { files: [], references: [] },
      { ...shipped, include: ["memory"] },
    ]) {
      await writeFile(config, JSON.stringify(loosened));
      const result = await run(lite, "write_own_file", { file: HELPER, contents: BROKEN, reason: "a helper" });
      assert.equal(result.ok, false, JSON.stringify(loosened));
      assert.match(result.content, /loop\/helper\.ts\(1,\d+\): error TS2322/);
      await assert.rejects(readFile(path.join(lite.core.layout.harnessWs, HELPER), "utf8"), { code: "ENOENT" });
    }
  });

  it("refuses a code edit whose copy does not start, even when it adds no type error", async () => {
    const lite = await coreLite();
    // An error the self already had: the check compares with the self before the change, and the
    // copy that boots must still be the one with the change in it.
    await writeFile(
      path.join(lite.core.layout.harnessWs, "loop", "old-mine.ts"),
      "export const old: number = 'still a string';\n",
    );
    const main = path.join(lite.core.layout.harnessWs, "loop", "main.ts");
    const shipped = await readFile(main, "utf8");
    const result = await run(lite, "write_own_file", {
      file: "loop/main.ts",
      contents: `${shipped}\nthrow new Error("broken at load");\n`,
      reason: "oops",
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /did not start/);
    assert.equal(await readFile(main, "utf8"), shipped);
  });

  it("gates install_tool the same way", async () => {
    const lite = await coreLite();
    const result = await run(lite, "install_tool", {
      filename: "count-tools.ts",
      reason: "count",
      contents: "export const tools: string = 7;\n",
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /tools\/count-tools\.ts\(1,\d+\): error TS2322/);
    await assert.rejects(readFile(path.join(lite.core.layout.harnessWs, "tools", "count-tools.ts")), {
      code: "ENOENT",
    });
  });

  it("a type check that runs out of time refuses the edit rather than passing it", async () => {
    const lite = await coreLite({ typeGate: { timeoutMs: 1 } });
    const result = await run(lite, "write_own_file", { file: HELPER, contents: VALID, reason: "a helper" });
    assert.equal(result.ok, false);
    assert.match(result.content, /did not finish within/);
    await assert.rejects(readFile(path.join(lite.core.layout.harnessWs, HELPER)), { code: "ENOENT" });
  });

  it("fails closed when the build has no compiler, and still lets non-code edits through", async () => {
    const lite = await coreLite({ resources: await makeResources({ tsc: false }) });
    const code = await run(lite, "write_own_file", { file: HELPER, contents: VALID, reason: "a helper" });
    assert.equal(code.ok, false, "no silent accept");
    assert.match(code.content, /type checker is missing from this build/);
    await assert.rejects(readFile(path.join(lite.core.layout.harnessWs, HELPER)), { code: "ENOENT" });

    const skill = await run(lite, "write_own_file", {
      file: "skills/a-lesson.md",
      contents: "- Keep ownership explicit.\n",
      reason: "learned",
    });
    assert.equal(skill.ok, true, "a skill never runs and is not type-checked");
  });

  it("refuses paths that are not the harness's own before making any copy", async () => {
    const lite = await coreLite();
    const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<{ ok: boolean; stage?: string }>>;
    for (const file of [
      "../escape.ts",
      "/abs.ts",
      "judge/rubric.ts",
      "loop/../../x.ts",
      ".git/hooks/post-commit.js",
      "loop\\x.ts",
      "",
    ]) {
      const verdict = await api["guardian.validate_edit"]!({ files: [{ file, contents: VALID }] });
      assert.deepEqual([verdict.ok, verdict.stage], [false, "refused"], file);
    }
  });
});

const SKILL = "---\nname: camera-rules\ndescription: Where the camera goes\n---\n- Frame the player.\n";

/** The self-change records in the log, oldest first, as their payloads. */
async function selfChanges(lite: CoreLite, type: string): Promise<Array<Record<string, unknown>>> {
  return (await lite.core.listAllEvents()).flatMap((event) =>
    event.data.type === "custom" && event.data.event_type === type
      ? [(event.data.payload ?? {}) as Record<string, unknown>]
      : [],
  );
}

describe("the agent changes its own files only through the host (B7)", () => {
  it("prompts and skills are write-denied to every agent process, like the judge", async () => {
    const lite = await coreLite();
    const ws = lite.core.layout.harnessWs;
    for (const dir of ["judge", "prompts", "skills"]) {
      assert.ok(lite.core.sandbox.policy.denyWrite.includes(path.join(ws, dir)), `denyWrite holds ${dir}/`);
    }
  });

  it("write_skill lands through the host: tried first, recorded by the host, and undone from Review", async () => {
    const lite = await coreLite();
    const file = path.join(lite.core.layout.harnessWs, "skills", "camera-rules.md");
    const result = await run(lite, "write_skill", { slug: "camera-rules", contents: SKILL, reason: "learned" });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /tried in a copy of you first/);
    assert.equal(await readFile(file, "utf8"), SKILL);
    const [record, ...more] = await selfChanges(lite, "skill_edited");
    assert.equal(more.length, 0, "one record per change");
    assert.equal(record!.slug, "camera-rules");
    for (const key of ["snapshot_id", "post_snapshot_id"]) {
      assert.ok(lite.core.snapshotIndex.get(String(record![key])), `${key} is a snapshot the host took`);
    }
    await lite.core.undoSelfChange(String(record!.snapshot_id));
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" }, "undoing a new skill removes it");
  });

  it("a self-change keeps the plain title and summary the agent wrote for the person, bounded", async () => {
    const lite = await coreLite();
    const result = await run(lite, "write_skill", {
      slug: "camera-rules",
      contents: SKILL,
      reason: "facets collided on the HUD three times",
      title: "Give the scoreboard   one owner",
      summary: ["One part now owns the scoreboard.", "", 42, "x".repeat(600)],
    });
    assert.equal(result.ok, true, result.content);
    const [record] = await selfChanges(lite, "skill_edited");
    assert.equal(record!.title, "Give the scoreboard one owner");
    assert.deepEqual(
      (record!.summary as string[]).map((line) => line.length),
      [33, 200],
      "blank and non-text lines are dropped; a line is clipped",
    );
  });

  it("write_own_file on a prompt is recorded by the host with the file it wrote", async () => {
    const lite = await coreLite();
    const result = await run(lite, "write_own_file", {
      file: "prompts/operating-rules.md",
      contents: "Follow the brief.\n",
      reason: "the README said to",
    });
    assert.equal(result.ok, true, result.content);
    const [record] = await selfChanges(lite, "self_edit");
    assert.deepEqual([record!.file, record!.reason], ["prompts/operating-rules.md", "the README said to"]);
  });

  it("the harness cannot write the record of a self-change itself", async () => {
    const lite = await coreLite();
    const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    for (const event_type of ["self_edit", "skill_edited", "tool_installed"]) {
      const batch = [{ type: "custom", event_type, payload: { file: "prompts/x.md", snapshot_id: "forged" } }];
      await assert.rejects(api["events.append"]!({ batch }), /studio only/, event_type);
    }
  });

  it("guardian.write_self refuses a path that is not the harness's own and changes nothing", async () => {
    const lite = await coreLite();
    const ws = lite.core.layout.harnessWs;
    const outside = await mkdtemp(path.join(os.tmpdir(), "self-write-outside-"));
    const target = path.join(outside, "target.md");
    await writeFile(target, "untouched\n");
    await symlink(target, path.join(ws, "prompts", "planted.md"));
    await symlink(outside, path.join(ws, "skills", "planted-dir"));
    const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<{ ok: boolean }>>;
    const before = (await lite.core.listAllEvents()).length;
    const snapshots = lite.core.snapshotIndex.all().length;
    for (const file of [
      "../escape.md",
      "/abs.md",
      "judge/rubric.md",
      "prompts/../../escape.md",
      ".git/config",
      "prompts\\x.md",
      "",
      "prompts/planted.md",
      "skills/planted-dir/x.md",
    ]) {
      const result = await api["guardian.write_self"]!({ file, contents: "hostile\n", reason: "test" });
      assert.equal(result.ok, false, file);
    }
    assert.equal(await readFile(target, "utf8"), "untouched\n", "a planted link carries no write out");
    await assert.rejects(readFile(path.join(outside, "x.md"), "utf8"), { code: "ENOENT" });
    assert.equal((await lite.core.listAllEvents()).length, before, "no record");
    assert.equal(lite.core.snapshotIndex.all().length, snapshots, "no snapshot");
  });
});

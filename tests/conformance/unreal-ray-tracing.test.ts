/**
 * Hardware ray tracing in an Unreal project's own config (`plugins/unreal/ray-tracing.ts`): whether
 * Unreal would start the project with it (the last `r.RayTracing` in the renderer settings), and
 * turning it off, which changes only those lines. A config that is a link, a folder or too large is
 * never written.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRayTracing, turnOffRayTracing } from "../../src/plugins/unreal/ray-tracing.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RENDERER = "[/Script/Engine.RendererSettings]";

/** A project folder whose Config/DefaultEngine.ini holds `ini` (none when undefined); answers its .uproject. */
async function project(ini: string | undefined): Promise<{ file: string; config: string }> {
  const directory = path.join(await tmpDir("studio-unreal-rt-"), "Drift");
  await mkdir(path.join(directory, "Config"), { recursive: true });
  const file = path.join(directory, "Drift.uproject");
  await writeFile(file, '{"FileVersion":3}\n');
  const config = path.join(directory, "Config", "DefaultEngine.ini");
  if (ini !== undefined) await writeFile(config, ini);
  return { file, config };
}

describe("hardware ray tracing in a project's config", () => {
  const table: Array<[string, string | undefined, boolean]> = [
    ["Epic's Maximum preset", `${RENDERER}\nr.ReflectionMethod=1\nr.RayTracing=True\n`, true],
    ["written as 1", `${RENDERER}\nr.RayTracing=1\n`, true],
    ["any case", `${RENDERER}\nR.RAYTRACING=true\n`, true],
    ["off", `${RENDERER}\nr.RayTracing=False\n`, false],
    ["on, then off: the last line is what Unreal reads", `${RENDERER}\nr.RayTracing=True\nr.RayTracing=False\n`, false],
    ["in another section only", "[/Script/Engine.Engine]\nr.RayTracing=True\n", false],
    ["a related setting only", `${RENDERER}\nr.RayTracing.RayTracingProxies.ProjectEnabled=True\n`, false],
    ["commented out", `${RENDERER}\n;r.RayTracing=True\n`, false],
    ["no config at all", undefined, false],
  ];
  for (const [name, ini, on] of table)
    it(`is ${on ? "on" : "off"}: ${name}`, async () => {
      assert.equal(await projectRayTracing((await project(ini)).file), on);
    });

  it("turns every r.RayTracing line off and leaves every other line as it was", async () => {
    const ini = [
      "[/Script/Engine.Engine]",
      "r.RayTracing=True",
      "",
      RENDERER,
      "r.ReflectionMethod=1",
      "r.RayTracing=True",
      "r.RayTracing.RayTracingProxies.ProjectEnabled=True",
      "  r.RayTracing = 1",
      "",
    ].join("\r\n");
    const { file, config } = await project(ini);
    await turnOffRayTracing(file);
    const written = await readFile(config, "utf8");
    assert.equal(
      written,
      [
        "[/Script/Engine.Engine]",
        "r.RayTracing=True",
        "",
        RENDERER,
        "r.ReflectionMethod=1",
        "r.RayTracing=False",
        "r.RayTracing.RayTracingProxies.ProjectEnabled=True",
        "r.RayTracing=False",
        "",
      ].join("\r\n"),
    );
    assert.equal(await projectRayTracing(file), false);
  });

  it("adds the setting where the config has none, in its renderer section or a new one", async () => {
    const withSection = await project(`${RENDERER}\nr.ReflectionMethod=1\n\n[URL]\nGameName=Drift\n`);
    await turnOffRayTracing(withSection.file);
    assert.equal(
      await readFile(withSection.config, "utf8"),
      `${RENDERER}\nr.ReflectionMethod=1\nr.RayTracing=False\n\n[URL]\nGameName=Drift\n`,
    );
    const without = await project("[URL]\nGameName=Drift\n");
    await turnOffRayTracing(without.file);
    assert.equal(await readFile(without.config, "utf8"), `[URL]\nGameName=Drift\n\n${RENDERER}\nr.RayTracing=False\n`);
    assert.equal(await projectRayTracing(without.file), false);
  });

  it("refuses a config it can't safely rewrite, and changes nothing", async () => {
    const outside = path.join(await tmpDir("studio-unreal-rt-outside-"), "Elsewhere.ini");
    const original = `${RENDERER}\nr.RayTracing=True\n`;
    await writeFile(outside, original);
    const linked = await project(undefined);
    await symlink(outside, linked.config);
    await assert.rejects(turnOffRayTracing(linked.file));
    assert.equal(await readFile(outside, "utf8"), original, "a linked config's target is never written");

    const folder = await project(undefined);
    await mkdir(folder.config);
    await assert.rejects(turnOffRayTracing(folder.file));

    const huge = await project(`${RENDERER}\nr.RayTracing=True\n${"; padding\n".repeat(400_000)}`);
    const before = await readFile(huge.config, "utf8");
    await assert.rejects(turnOffRayTracing(huge.file));
    assert.equal(await readFile(huge.config, "utf8"), before);
  });
});

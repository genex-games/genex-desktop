// Runs Genex's own Roblox asset gate (checkModel, the check import-model runs first) over each
// downloaded Poly Haven glTF, as the in-app agent's import would. Usage:
//   node .realism-test/gate_check.mts <repo> <work>/assets/models
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, modelsDir] = process.argv.slice(2);
const gate = await import(pathToFileURL(path.join(repo, "src/plugins/roblox/asset-gate.ts")).href);

const rows = [];
for (const name of (await readdir(modelsDir)).sort()) {
  const folder = path.join(modelsDir, name);
  const answer = await gate.checkModel(folder, `${name}.gltf`);
  if (!answer.ok) {
    rows.push({ name, passed: false, refused: answer.refusal, why: answer.message });
    continue;
  }
  const { check } = answer;
  rows.push({
    name,
    passed: check.passed,
    triangles: check.triangles,
    materials: check.materials,
    textures: check.textures.length,
    problems: check.problems.map((p: { problem: string }) => p.problem),
  });
}
console.log(JSON.stringify(rows, null, 1));
const passed = rows.filter((r) => r.passed).length;
console.log(`passed ${passed} of ${rows.length}`);

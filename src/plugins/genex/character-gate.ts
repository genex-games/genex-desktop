/**
 * The character gate (Track A): a body a character or creature generation downloaded is read by
 * the importer's own rules (`shared/character-contract.ts`) before it is delivered into the game.
 * One that is not a playable humanoid is rejected as a typed failure that says what is wrong and
 * the next call that fixes it, so a broken body never reaches the game. Regenerating spends
 * credits, so the gate only says how; the agent asks for it through the usual quote.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  CharacterFailure,
  CharacterRole,
  characterVerdict,
  type CharacterProblem,
  clipRole,
} from "../../shared/character-contract.ts";
import { GenexFailureCode, type GenexJob, type GenexJobFailure, GenexOperation } from "../../shared/genex.ts";
import { characterFacts, restPoseOf } from "../../substrate/asset-import/character-facts.ts";
import { readGlb } from "../../substrate/asset-import/glb.ts";

/** The operations whose result is a body the game animates. */
const BODY_OPERATIONS: ReadonlySet<string> = new Set([
  GenexOperation.Character,
  GenexOperation.Creature,
  GenexOperation.CharacterFinalize,
  GenexOperation.CharacterImport,
]);
/** A body file larger than this is not read (a character GLB is 30 MB at most). */
const BODY_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** What to do next, by what the body failed. */
const NEXT: Readonly<Record<CharacterFailure, string>> = {
  [CharacterFailure.NotRigged]:
    "The file has no skinned skeleton. Rig the body with operation character.import (Uthana) on a humanoid model, or generate it again with character or creature.",
  [CharacterFailure.NotHumanoid]:
    "The rig lacks the core humanoid bones. Generate a biped humanoid again (character or creature), or take the body through character.import to get a Uthana humanoid rig.",
  [CharacterFailure.RestPose]:
    "Generate the body again in a rig-friendly rest pose: operation character with options pose a-pose (t-pose also works). Arms hanging at the sides or raised overhead cannot be retargeted.",
  [CharacterFailure.Scale]:
    "Generate the body again with options height set (0.5-3 m, a person is 1.7): its skeleton is not a person's size off the ground.",
};

/** Every GLB under `dir`, by path. */
async function glbsUnder(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  return names.filter((name) => name.toLowerCase().endsWith(".glb")).map((name) => path.join(dir, name));
}

/** Whether a GLB's document has a node that draws a mesh: an animation-only file has none. */
function drawsMesh(bytes: Uint8Array): boolean {
  try {
    const nodes = readGlb(bytes).json.nodes;
    return Array.isArray(nodes) && nodes.some((node) => typeof node === "object" && node !== null && "mesh" in node);
  } catch {
    return false;
  }
}

/** The problems of the body at `file`, or none for a file that is no body (animation-only, unreadable, too large). */
async function problemsOf(file: string): Promise<CharacterProblem[]> {
  if ((await stat(file)).size > BODY_FILE_MAX_BYTES) return [];
  const bytes = new Uint8Array(await readFile(file));
  if (!drawsMesh(bytes)) return [];
  return characterVerdict(characterFacts(bytes), restPoseOf(bytes)).failures;
}

/**
 * Judge the bodies a body-making job downloaded into `output`. Null when every one passes (or the
 * job makes no body, or nothing was downloaded); else the failure to record on the job.
 */
export async function gateCharacter(job: GenexJob, output: string): Promise<GenexJobFailure | null> {
  if (!BODY_OPERATIONS.has(job.operation)) return null;
  const rejected: string[] = [];
  const codes = new Set<CharacterFailure>();
  for (const file of await glbsUnder(output)) {
    const problems = await problemsOf(file);
    if (!problems.length) continue;
    for (const problem of problems) codes.add(problem.code);
    const reasons = problems.map((problem) => `${problem.code} (${problem.detail})`).join(", ");
    rejected.push(`${path.relative(output, file)}: ${reasons}`);
  }
  if (!rejected.length) return null;
  return {
    code: GenexFailureCode.CharacterRejected,
    kind: job.operation,
    providerError: `Not delivered, the body is not playable: ${rejected.join("; ")}`,
    next: [...codes].map((code) => NEXT[code]).join(" "),
  };
}

/** The names of the clips a GLB's document holds. */
function clipNames(bytes: Uint8Array): string[] {
  try {
    const animations = readGlb(bytes).json.animations;
    if (!Array.isArray(animations)) return [];
    return animations.map((each) =>
      each && typeof each === "object" && typeof each.name === "string" ? each.name : "",
    );
  } catch {
    return [];
  }
}

/**
 * The move roles no clip in `output` covers, counting the body's own clips and those of the
 * animation-only GLBs beside it: what the agent still fills with `character.animate` or
 * `animations.search`. Null when the job makes no body.
 */
export async function missingRolesOf(job: GenexJob, output: string): Promise<CharacterRole[] | null> {
  if (!BODY_OPERATIONS.has(job.operation)) return null;
  const covered = new Set<CharacterRole>();
  for (const file of await glbsUnder(output)) {
    if ((await stat(file)).size > BODY_FILE_MAX_BYTES) continue;
    for (const name of clipNames(new Uint8Array(await readFile(file)))) {
      const role = clipRole(name);
      if (role) covered.add(role);
    }
  }
  return Object.values(CharacterRole).filter((role) => !covered.has(role));
}

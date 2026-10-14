/**
 * Project policy on this computer: where a development launch may keep its games (only below the
 * profile's own games root), and which stack a new game starts on here.
 */
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { parseStackDefaultSwitch } from "../shared/game-project.ts";
import { defaultStackFor, type StackDefault } from "../shared/toolchain.ts";
import { isBelow } from "../substrate/paths.ts";

/** Why a development project is refused. */
const MESSAGE = {
  outsideRoot: (project: string) => `Project is outside the owned development games root: ${project}`,
  alias: (project: string) => `Project alias is not allowed: ${project}`,
} as const;

/** Development-only containment. Check before adopting/indexing/granting project writes. */
export async function assertOwnedProject(root: string | undefined, project: string): Promise<void> {
  if (!root) return;
  const canonicalRoot = await realpath(root);
  const requested = path.resolve(project);
  const actual = await realpath(project);
  if (requested !== actual || !isBelow(canonicalRoot, actual)) throw new Error(MESSAGE.outsideRoot(project));
  let current = canonicalRoot;
  for (const part of path.relative(canonicalRoot, requested).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(MESSAGE.alias(project));
  }
}

/** What {@link stackDefaultHere} reads besides this computer's platform and architecture. */
export interface StackDefaultInput {
  /** The stored `stackDefault` setting, unparsed: absent or unknown is the shipped switch. */
  setting: unknown;
  /** Whether the toolchain's downloads can be reached now. */
  online: boolean;
  /** Whether the Rust toolchain is already installed in this profile's store. */
  rustToolchainReady: boolean;
}

/** A new game's default stack on this computer (`defaultStackFor` over `process.platform` and `process.arch`). */
export function stackDefaultHere(input: StackDefaultInput): StackDefault {
  return defaultStackFor(parseStackDefaultSwitch(input.setting), {
    platform: process.platform,
    arch: process.arch,
    online: input.online,
    rustToolchainReady: input.rustToolchainReady,
  });
}

/**
 * The harness seed's person-side controls: re-taking the seed copy of a module the agent kept from
 * before Rust games (`studio:seed.retake`, fixture-safe: it rewrites one module of the profile's own
 * harness workspace). The shipped copy is laid down by `retakeSeedModule`, which refuses a hostile
 * path typed and with nothing written; the agent's edit is kept as a patch (and its whole copy) in a
 * fresh `seed-retake-*` folder under the updates folder, which the agent cannot write. Each answer
 * is recorded as a `seed_retake` event, and a re-take leaves the agent a memory note naming its patch.
 */
import path from "node:path";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import type { SeedRetakeAnswer, SeedRetakePayload } from "../../shared/seed-retake.ts";
import { SnapshotScope } from "../../shared/event-log.ts";
import { retakeSeedModule } from "../../substrate/seed-upgrade.ts";
import { SEED_MANIFEST_FILE } from "../core/recovery.ts";
import { seedRetakeNote } from "../seed-upgrade-notice.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** The longest module path a re-take accepts. */
const MAX_MODULE_CHARS = 1024;

/** Why a re-take request is refused before anything is read. */
const MESSAGE = {
  badModule: "Re-take refused: name one harness module by its workspace-relative path.",
  snapshot: "seed re-take",
} as const;

/** The memory key of the note a re-take leaves the agent: one per module. */
export const SEED_RETAKE_MEMORY_PREFIX = "seed copy re-taken for Rust games: ";

/** Where a re-take reads and writes, and what it tells. */
export interface SeedRetakeDeps {
  dirs: { seedDir: string; workspaceDir: string; manifestFile: string; updatesDir: string };
  /** Appends the `seed_retake` record. */
  record: (payload: SeedRetakePayload) => Promise<void>;
  /** Leaves the agent a memory note under `key`. */
  note: (key: string, text: string) => Promise<void>;
  /** A harness snapshot before the workspace changes. */
  snapshot?: () => Promise<unknown>;
  now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The module a request names; throws on anything but one non-empty string within the limit. */
function moduleOf(payload: unknown): string {
  const module = isRecord(payload) ? payload.module : undefined;
  const named = typeof module === "string" && module.length > 0 && module.length <= MAX_MODULE_CHARS;
  if (!named) throw new Error(MESSAGE.badModule);
  return module;
}

/**
 * Re-takes the seed copy of the module `payload` names: snapshot, re-take, record, and on success
 * the agent's note. A malformed payload throws before any of them.
 */
export async function retakeSeed(deps: SeedRetakeDeps, payload: unknown): Promise<SeedRetakeAnswer> {
  const module = moduleOf(payload);
  await deps.snapshot?.();
  const stamp = (deps.now ?? Date.now)().toString(36);
  const result = await retakeSeedModule({
    ...deps.dirs,
    rel: module,
    patchDir: path.join(deps.dirs.updatesDir, `seed-retake-${stamp}`),
  });
  const answer: SeedRetakeAnswer = result.ok
    ? { ok: true, module, patchFile: result.patchFile, keptFile: result.keptFile }
    : { ok: false, module, code: result.code };
  await deps.record({ ...answer });
  if (result.ok) await deps.note(`${SEED_RETAKE_MEMORY_PREFIX}${module}`, seedRetakeNote(result));
  return answer;
}

/** The core's real re-take: its seed, harness workspace, manifest and updates folder, log, memory and snapshots. */
export function seedRetakeDepsOf(core: StudioCore): SeedRetakeDeps {
  return {
    dirs: {
      seedDir: path.join(core.options.paths.resources, "harness-seed"),
      workspaceDir: core.layout.harnessWs,
      manifestFile: path.join(core.options.paths.userData, SEED_MANIFEST_FILE),
      updatesDir: core.layout.updates,
    },
    record: async (payload) => {
      await core.append([customEventData(CustomEvent.SeedRetake, payload)]);
    },
    note: async (key, text) => {
      const memory = (await core.store.readArtifact<Record<string, unknown>>(core.mainThread, "memory")) ?? {};
      await core.store.writeArtifact(core.mainThread, "memory", { ...memory, [key]: text });
    },
    snapshot: () => core.snapshot(SnapshotScope.Harness, MESSAGE.snapshot),
  };
}

/** Registers `studio:seed.retake`. */
export function registerSeedIpc(handle: IpcHandle, deps: SeedRetakeDeps): void {
  handle("studio:seed.retake", (payload) => retakeSeed(deps, payload));
}

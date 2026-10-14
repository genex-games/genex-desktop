/**
 * Re-taking the seed copy of one harness module the in-app agent kept from before Rust games
 * (`studio:seed.retake`): the shipped copy is laid down again and the agent's edit is kept as a
 * patch beside it (substrate/seed-upgrade.ts `retakeSeedModule`). The person starts it from the
 * notice of a Rust night refused over kept modules; each re-take is a persisted `seed_retake` event.
 */
import { CustomEvent, type CustomEventData, customPayload } from "./custom-events.ts";

/**
 * Why a re-take was refused, with no side effect. The values are substrate/seed-upgrade.ts
 * `RetakeRefusalCode`'s, which the main handler answers with. Wire values: never rename one.
 */
export const SeedRetakeRefusal = {
  /** Not a plain `/`-separated relative path. */
  InvalidPath: "invalid-path",
  /** The seed ships no file there. */
  NotSeedFile: "not-seed-file",
  /** A link, or something other than a file, on the way to the workspace copy. */
  NotPlainFile: "not-plain-file",
  /** The workspace copy is the seed's already: no edit to keep. */
  NotKept: "not-kept",
  /** An earlier re-take's patch is where this one would go. */
  PatchExists: "patch-exists",
} as const;
export type SeedRetakeRefusal = (typeof SeedRetakeRefusal)[keyof typeof SeedRetakeRefusal];

/** What a re-take answers: where the agent's edit was kept, or why nothing was done. */
export type SeedRetakeAnswer =
  | {
      ok: true;
      /** The workspace-relative module, as the refusal named it. */
      module: string;
      /** The agent's diff, to carry over what it still needs. */
      patchFile: string;
      /** The agent's whole copy; null when its edit was deleting the module. */
      keptFile: string | null;
    }
  | { ok: false; module: string; code: SeedRetakeRefusal };

/** The persisted `seed_retake` payload: the answer as written. Every field optional, as old logs keep old shapes. */
export type SeedRetakePayload = Partial<{
  ok: boolean;
  module: string;
  patchFile: string;
  keptFile: string | null;
  code: SeedRetakeRefusal;
}>;

/** The `seed_retake` record's payload, or null for any other event. */
export function seedRetakeOf(data: CustomEventData): SeedRetakePayload | null {
  return customPayload(data, CustomEvent.SeedRetake);
}

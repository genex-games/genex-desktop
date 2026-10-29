/**
 * What a Rust build's import step left out, said on the game's console (B8). A refused file leaves
 * the stage (`rust-assets.ts`), so the game reads it only as `missing: … was not fetched`; these
 * lines name the file, the refusal code, the validator's codes when there are any, and what the
 * agent can do about it. Agent-facing console lines, never shown as UI copy.
 */
import { AssetImportRefusal } from "../shared/game-assets.ts";
import { type StagedImportReport, StagePlacementRefusal } from "./rust-assets.ts";

/** The most refused files one build names; the rest are counted in one more line. */
const NOTED_FILES_MAX = 12;

/** What to do about each refusal, by its code. */
export const IMPORT_REFUSAL_REMEDY = {
  [AssetImportRefusal.UnsupportedByRaylib]: "convert it to a format the game's stack loads (docs/api/assets.md).",
  [AssetImportRefusal.UnsupportedByRust]: "convert it to a format the Rust stack loads (docs/api/assets.md).",
  [AssetImportRefusal.UnsafePath]: "rename it to a plain relative path under assets/.",
  [AssetImportRefusal.EscapesGame]: "replace the link with the file itself, inside the game folder.",
  [AssetImportRefusal.Missing]: "put the file back, or stop referring to it.",
  [AssetImportRefusal.NotRegularFile]: "replace it with a regular file.",
  [AssetImportRefusal.TooLarge]: "make it smaller than 256 MiB (fewer triangles, smaller textures).",
  [AssetImportRefusal.Malformed]: "the bytes are damaged or not the format the name says: export or download it again.",
  [AssetImportRefusal.UnsupportedExtension]: "export it again without the glTF extension the detail names.",
  [AssetImportRefusal.ConverterMissing]: "deliver the sound as OGG, WAV or MP3.",
  [AssetImportRefusal.ImporterFailed]: "build again; if it fails again, export the file again.",
  [AssetImportRefusal.ValidationFailed]:
    "fix what the Khronos glTF validator names (the codes above), or export the file again through Local Blender. Stale accessor bounds are fixed for you; these are not.",
  [StagePlacementRefusal.NameTaken]: "rename one of the two files: their outputs share a name.",
} as const satisfies Record<AssetImportRefusal | StagePlacementRefusal, string>;

const MESSAGE = {
  leftOut: (file: string, code: string, detail: string | undefined, remedy: string) =>
    `Studio left ${file} out of this build (${code}${detail ? `: ${detail}` : ""}), so the game reads it as missing. To fix: ${remedy}`,
  more: (count: number) => `Studio left ${count} more files out of this build; the build receipt's assets list them.`,
} as const;

/** One console line per file `report` refused, at most {@link NOTED_FILES_MAX} and a count of the rest. */
export function importRefusalNotes(report: StagedImportReport | null | undefined): string[] {
  const refused = (report?.files ?? []).filter((row) => row.refusal !== undefined);
  const notes = refused.slice(0, NOTED_FILES_MAX).map((row) => {
    const code = row.refusal ?? AssetImportRefusal.ImporterFailed;
    return MESSAGE.leftOut(row.file, code, row.detail, IMPORT_REFUSAL_REMEDY[code]);
  });
  if (refused.length > NOTED_FILES_MAX) notes.push(MESSAGE.more(refused.length - NOTED_FILES_MAX));
  return notes;
}

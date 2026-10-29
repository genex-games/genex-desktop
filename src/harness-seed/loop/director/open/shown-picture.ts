/**
 * The picture a save point names as showing its change (`save_point {shows}`), read as a finish
 * proof file is (`../../finish-proof.ts`): inside the project's folder by its real path, by handle,
 * never through a link or from a FIFO, at most `PROOF_FILE_MAX_BYTES`, and only a PNG or a JPEG. A
 * module of its own, so the shipped tools need no new name from a module an agent may have kept.
 */
import type { HookImage } from "../../../types/host-api.d.ts";
import { pictureType, readProofFile } from "../../finish-proof.ts";
import { SHOWS_WORDS } from "./evidence-prompts.ts";

/** The picture `shows` names in the project's folder, read; or why it is none. */
export async function shownPicture(
  projectDir: string,
  rel: string,
): Promise<{ image: HookImage } | { problem: string }> {
  const read = await readProofFile(projectDir, rel);
  if ("problem" in read) return read;
  if (!pictureType(read.bytes)) return { problem: SHOWS_WORDS.notPicture };
  return { image: { name: rel, data: read.bytes.toString("base64") } };
}

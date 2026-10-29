/**
 * Magic-byte sniffing for a clip's container. A clip's declared type is never trusted: the bytes
 * decide whether a recording is the WebM or the MP4 it says it is, when the recorder hands it
 * over and when the renderer reads a kept one back.
 */
import { PluginClipMimeType } from "../shared/plugins.ts";

/** An EBML header: every Matroska and WebM file starts with these four bytes. */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;
/** The DocType a WebM header names, `webm`, somewhere in its first bytes. */
const WEBM_DOCTYPE = Buffer.from("webm", "ascii");
/** How far into the file the EBML header's DocType is looked for. */
const EBML_HEADER_BYTES = 64;
/** An ISO base media file's first box is `ftyp`, its type at bytes 4 to 8. */
const FTYP = Buffer.from("ftyp", "ascii");
const FTYP_OFFSET = 4;

/** Whether `data` starts with `bytes`. */
const startsWith = (data: Uint8Array, bytes: readonly number[]) => bytes.every((byte, i) => data[i] === byte);

/** The clip container `data` holds, by its bytes: WebM, MP4, or null for anything else. */
export function sniffClipContainer(data: Uint8Array): PluginClipMimeType | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (startsWith(bytes, EBML_MAGIC) && bytes.subarray(0, EBML_HEADER_BYTES).includes(WEBM_DOCTYPE))
    return PluginClipMimeType.Webm;
  if (bytes.length >= FTYP_OFFSET + FTYP.length && bytes.subarray(FTYP_OFFSET, FTYP_OFFSET + FTYP.length).equals(FTYP))
    return PluginClipMimeType.Mp4;
  return null;
}

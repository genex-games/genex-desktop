/**
 * A glTF with external resources packed into one self-contained GLB (glTF 2.0 section 4.4): its
 * buffers joined into the binary chunk, and each image moved into a buffer view of its own. Poly
 * Haven ships models as `.gltf` + `.bin` + textures; a Rust game loads a model from one file's bytes.
 */
import { Cc0Error, Cc0Refusal } from "../../substrate/cc0-fetch.ts";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const ALIGN = 4;
const SPACE = 0x20;

/** The image types a packed GLB may embed, by the resource's extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

interface GltfBuffer {
  uri?: string;
  byteLength?: number;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
}
interface GltfImage {
  uri?: string;
  bufferView?: number;
  mimeType?: string;
}
interface Gltf {
  asset?: { version?: string };
  buffers?: GltfBuffer[];
  bufferViews?: GltfBufferView[];
  images?: GltfImage[];
  [key: string]: unknown;
}

const padded = (length: number) => Math.ceil(length / ALIGN) * ALIGN;

function malformed(detail: string): Cc0Error {
  return new Cc0Error(Cc0Refusal.ManifestInvalid, `gltf: ${detail}`);
}

/** The resource a URI names, or a refusal: never a data URI, never one the glTF's include list lacks. */
function resource(resources: ReadonlyMap<string, Uint8Array>, uri: string | undefined): Uint8Array {
  if (uri === undefined || uri.startsWith("data:")) throw malformed(`an embedded or missing uri`);
  const bytes = resources.get(uri) ?? resources.get(decodeURI(uri));
  if (!bytes) throw new Cc0Error(Cc0Refusal.ZipMemberMissing, `gltf: ${uri} was not fetched`);
  return bytes;
}

function imageType(uri: string): string {
  const type = IMAGE_TYPES[uri.slice(uri.lastIndexOf(".") + 1).toLowerCase()];
  if (!type) throw malformed(`${uri} is not a JPEG or PNG`);
  return type;
}

function parsed(gltf: Uint8Array): Gltf {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(gltf));
  } catch {
    throw malformed("not JSON");
  }
  const document = json as Gltf;
  const usable = typeof json === "object" && json !== null && document.asset?.version === "2.0";
  if (!usable || !Array.isArray(document.buffers) || document.buffers.length === 0)
    throw malformed("not glTF 2.0 with buffers");
  return document;
}

/** Bytes appended to the binary chunk, each at a 4-byte boundary. */
class Body {
  parts: Uint8Array[] = [];
  length = 0;
  add(bytes: Uint8Array): number {
    const at = this.length;
    this.parts.push(bytes);
    this.length = padded(at + bytes.byteLength);
    return at;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at = padded(at + part.byteLength);
    }
    return out;
  }
}

/** The GLB `gltf` and its `resources` (by the URI the glTF names them) make; deterministic. */
export function packGlb(gltf: Uint8Array, resources: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const document = parsed(gltf);
  const body = new Body();
  const offsets = (document.buffers ?? []).map((buffer) => body.add(resource(resources, buffer.uri)));
  const views = (document.bufferViews ?? []).map((view) => {
    const offset = offsets[view.buffer];
    if (offset === undefined) throw malformed(`a buffer view names buffer ${view.buffer}`);
    return { ...view, buffer: 0, byteOffset: (view.byteOffset ?? 0) + offset };
  });
  const images = (document.images ?? []).map((image) => {
    if (image.uri === undefined) throw malformed("an image in a buffer view of an external glTF");
    const bytes = resource(resources, image.uri);
    const { uri: _external, ...rest } = image;
    views.push({ buffer: 0, byteOffset: body.add(bytes), byteLength: bytes.byteLength });
    return { ...rest, bufferView: views.length - 1, mimeType: imageType(image.uri) };
  });
  const packed: Gltf = { ...document, buffers: [{ byteLength: body.length }], bufferViews: views };
  if (document.images) packed.images = images;
  return glbBytes(new TextEncoder().encode(JSON.stringify(packed)), body.bytes());
}

function glbBytes(json: Uint8Array, bin: Uint8Array): Uint8Array {
  const jsonLength = padded(json.byteLength);
  const total = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonLength + CHUNK_HEADER_BYTES + bin.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.fill(SPACE, 20, 20 + jsonLength);
  out.set(json, 20);
  const binAt = 20 + jsonLength;
  view.setUint32(binAt, bin.byteLength, true);
  view.setUint32(binAt + 4, CHUNK_BIN, true);
  out.set(bin, binAt + CHUNK_HEADER_BYTES);
  return out;
}

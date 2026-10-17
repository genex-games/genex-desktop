/**
 * The per-destination texture table: which GPU texture family a KTX2 (Basis Universal) texture
 * is transcoded to on each destination, in order of preference, keyed to the WebGPU
 * texture-compression features (plan "Game services"): BC on desktop and desktop browsers, ASTC
 * on iOS, Android and mobile browsers, ETC2 where ASTC is absent, uncompressed RGBA8 last. The
 * import step transcodes every family a game's destinations may pick, so a texture that cannot
 * reach one is refused at import, not on the device. `genex-assets` keeps the same table
 * (`tests/fixtures/asset-import/texture-table.json` holds both to it).
 */
import { BuildTarget } from "../../shared/game-project.ts";

/** A GPU texture family. Wire values in the import receipt and the runtime's table: never rename one. */
export const TextureCompression = {
  Bc: "bc",
  Astc: "astc",
  Etc2: "etc2",
  /** Uncompressed RGBA, 8 bits a channel: every device takes it. */
  Rgba8: "rgba8",
} as const;
export type TextureCompression = (typeof TextureCompression)[keyof typeof TextureCompression];

const { Bc, Astc, Etc2, Rgba8 } = TextureCompression;

/** The WebGPU feature a family needs; uncompressed needs none. */
export const TEXTURE_COMPRESSION_FEATURE = {
  [Bc]: "texture-compression-bc",
  [Astc]: "texture-compression-astc",
  [Etc2]: "texture-compression-etc2",
  [Rgba8]: null,
} as const satisfies Record<TextureCompression, string | null>;

/** Each destination's families, best first; the last is always uncompressed. */
export const DESTINATION_TEXTURES = Object.freeze({
  [BuildTarget.Mac]: [Bc, Rgba8],
  [BuildTarget.Windows]: [Bc, Rgba8],
  [BuildTarget.Linux]: [Bc, Rgba8],
  [BuildTarget.Ios]: [Astc, Etc2, Rgba8],
  [BuildTarget.Android]: [Astc, Etc2, Rgba8],
  // A browser is a desktop or a phone: BC first, then the mobile families.
  [BuildTarget.Web]: [Bc, Astc, Etc2, Rgba8],
} as const satisfies Record<BuildTarget, readonly TextureCompression[]>);

/**
 * Basis Universal's `transcoder_texture_format` for each family (`basisu_transcoder.h`): BC7,
 * ASTC 4×4, ETC2 with EAC alpha, RGBA32. Pinned with the transcoder.
 */
export const BASIS_TRANSCODE_FORMAT = {
  [Bc]: 6,
  [Astc]: 10,
  [Etc2]: 1,
  [Rgba8]: 13,
} as const satisfies Record<TextureCompression, number>;

/**
 * The Vulkan format of each family's KTX2 files the import step writes (A6.5), sRGB for colour
 * and linear for data: BC7, ASTC 4x4, ETC2 RGBA8 with EAC alpha, RGBA8 (`VkFormat` values; the
 * runtime's `read_ktx2` reads exactly these).
 */
export const KTX2_VK_FORMAT = {
  [Bc]: { srgb: 146, linear: 145 },
  [Astc]: { srgb: 158, linear: 157 },
  [Etc2]: { srgb: 152, linear: 151 },
  [Rgba8]: { srgb: 43, linear: 37 },
} as const satisfies Record<TextureCompression, { srgb: number; linear: number }>;

/** The file a family's KTX2 takes beside its source: `assets/rock.ktx2` → `assets/rock.bc.ktx2`. */
export function familyFileName(file: string, compression: TextureCompression): string {
  const dot = file.lastIndexOf(".");
  const stem = dot > file.lastIndexOf("/") ? file.slice(0, dot) : file;
  return `${stem}.${compression}.ktx2`;
}

/** A KTX2 texture's first level transcoded to one family, as the import receipt records it. */
export interface TranscodedTexture {
  compression: TextureCompression;
  /** Basis Universal's `transcoder_texture_format`. */
  format: number;
  bytes: number;
  sha256: string;
}

/** The family a device of `target` with `features` (WebGPU feature names) loads a texture as. */
export function textureCompressionFor(target: BuildTarget, features: ReadonlySet<string>): TextureCompression {
  const usable = (family: TextureCompression) => {
    const feature = TEXTURE_COMPRESSION_FEATURE[family];
    return feature === null || features.has(feature);
  };
  return DESTINATION_TEXTURES[target].find(usable) ?? Rgba8;
}

/** Every family any of `targets` may pick, in table order: what the import step transcodes. */
export function texturesForTargets(targets: readonly BuildTarget[]): TextureCompression[] {
  const wanted = new Set<TextureCompression>(targets.flatMap((target) => DESTINATION_TEXTURES[target]));
  return Object.values(TextureCompression).filter((family) => wanted.has(family));
}

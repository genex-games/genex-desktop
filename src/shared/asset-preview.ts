import { ASSET_FORMATS, assetExtension, assetFormat, type AssetPreviewMode } from "./game-assets.ts";
import { isGenexRef } from "./genex-ref.ts";

export { assetExtension };

/** Local preview formats, from the one format table. Unknown files remain inspectable metadata, never executable content. */
export const ASSET_PREVIEW_MIME: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, string>,
    Object.fromEntries(Object.entries(ASSET_FORMATS).map(([ext, format]) => [ext, format.mime])),
  ),
);
export function assetPreviewMode(file: string): AssetPreviewMode {
  return assetFormat(file)?.preview ?? "unsupported";
}
/**
 * The folder a model's resources must stay inside: its Genex ref, `public/assets`, or the top
 * folder the model is in (`assets`, Unity's `Assets`, a plugin's folder), or the game's root for a
 * model there. The main side holds every read to the game's asset folders besides.
 */
function companionRoot(base: string): string[] {
  if (isGenexRef(base)) return base.split("/").slice(0, 2);
  if (base.startsWith("public/assets/")) return ["public", "assets"];
  const parts = base.split("/");
  return parts.length > 1 ? parts.slice(0, 1) : [];
}

function decodedResource(uri: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error("Invalid model resource path.");
  }
  if (!decoded || /[\\\x00-\x1f?#]/.test(decoded) || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded))
    throw new Error("Models may only load local asset resources.");
  return decoded;
}

/** Resolve a model's companion resource without admitting network/absolute/protected paths. */
export function assetCompanion(base: string, uri: string): string {
  const decoded = decodedResource(uri);
  const root = companionRoot(base);
  const result = base.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (result.length <= root.length) throw new Error("Model resource leaves its asset folder.");
      result.pop();
      continue;
    }
    if (part.startsWith(".")) throw new Error("Hidden model resources are not allowed.");
    result.push(part);
  }
  if (!root.every((part, i) => result[i] === part)) throw new Error("Model resource leaves its asset folder.");
  return result.join("/");
}

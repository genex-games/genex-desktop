import { ASSET_FOLDERS, ASSET_FORMATS, assetExtension, assetFormat, type AssetPreviewMode } from "./game-assets.ts";
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
/** A model's resources stay inside its Genex ref or the same host-owned asset tree. */
function companionRoot(base: string): string[] {
  if (isGenexRef(base)) return base.split("/").slice(0, 2);
  if (base.startsWith(`${ASSET_FOLDERS.UnityGenerated}/`)) return ASSET_FOLDERS.UnityGenerated.split("/");
  return base.startsWith(`${ASSET_FOLDERS.BrowserBuild}/`)
    ? ASSET_FOLDERS.BrowserBuild.split("/")
    : [ASSET_FOLDERS.Browser];
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

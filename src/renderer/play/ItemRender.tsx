/**
 * An item's 3D render (marketplace P6–P8): its picture, a render on a transparent background, on a
 * soft gradient of the item's own hue (a card, the sheet), or bare (the profile shelf). On the
 * purchase sheet an item with a model loads it lazily into the app's model viewer, and the picture
 * gives way to it once it draws, with "Drag to turn"; a model that cannot be read leaves the
 * picture. A picture that fails to load, or none, draws a plain box.
 */
import type { CSSProperties, JSX } from "react";
import { useEffect, useState } from "react";
import type { PlayerItem } from "../../shared/store-items.ts";
import { Icon } from "../ui/icons.tsx";
import { PLAY_STORE_WORDS } from "../words.ts";
import { itemHue } from "./store-model.ts";

const WORDS = PLAY_STORE_WORDS;
/** The largest model the sheet reads: genex.games' own cap on an item's GLB (plan 6.3). */
const ITEM_MODEL_MAX_BYTES = 20 * 1024 * 1024;
/** What the viewer is told it reads: a binary glTF. */
const MODEL_FILE = "item.glb";
const MODEL_TYPE = "model/gltf-binary";

type RenderedItem = Pick<PlayerItem, "id" | "iconUrl" | "modelUrl">;

/** The item's model, read from genex.games' host whole and no larger than the cap. */
async function readModel(
  url: string,
  signal: AbortSignal,
): Promise<{ data: Uint8Array<ArrayBuffer>; mimeType: string }> {
  const response = await fetch(url, { signal, credentials: "omit" });
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || declared > ITEM_MODEL_MAX_BYTES) throw new Error(`Item model unavailable (${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > ITEM_MODEL_MAX_BYTES) throw new Error("Item model too large");
  return { data, mimeType: MODEL_TYPE };
}

/** The model drawn in `host` once it is read; true once it shows. Nothing is read without a url. */
function useItemModel(url: string | null): { host: (node: HTMLDivElement | null) => void; ready: boolean } {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!url || !node) return undefined;
    let cancelled = false;
    let viewer: { dispose(): void } | null = null;
    const abort = new AbortController();
    void import("../asset-model-viewer.js")
      .then(({ createAssetViewer }) => {
        if (cancelled) return;
        viewer = createAssetViewer(node, {
          file: MODEL_FILE,
          read: () => readModel(url, abort.signal),
          companions: [],
          onReady: () => {
            if (!cancelled) setReady(true);
          },
          // A model that cannot be read leaves the picture: the sheet says nothing about it.
          onError: () => {
            if (!cancelled) setReady(false);
          },
          onTime: () => {},
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      abort.abort();
      viewer?.dispose();
    };
  }, [url, node]);
  return { host: setNode, ready };
}

/** The picture, or a plain box while there is none or it fails to load. */
function ItemPicture({ src, hidden }: { src: string | null; hidden?: boolean }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <span className="item-render-box" aria-hidden="true">
        <Icon name="box" size={28} strokeWidth={1.5} />
      </span>
    );
  return (
    <img
      className="item-render-picture"
      src={src}
      alt=""
      draggable={false}
      decoding="async"
      data-hidden={hidden || undefined}
      onError={() => setFailed(true)}
    />
  );
}

/** The model over the picture, with "Drag to turn" once it draws. */
function TurnableModel({ item }: { item: RenderedItem }): JSX.Element {
  const { host, ready } = useItemModel(item.modelUrl);
  return (
    <>
      <ItemPicture src={item.iconUrl} hidden={ready} />
      <div ref={host} className="item-render-model" data-ready={ready || undefined} />
      {ready && (
        <span className="item-render-hint" data-item-turn>
          <Icon name="reload" size={13} />
          {WORDS.dragToTurn}
        </span>
      )}
    </>
  );
}

/**
 * The item's render. `backdrop` draws it on its gradient; `turnable` lets a model replace the
 * picture; `badge` sits in its corner (the check once it is the player's).
 */
export function ItemRender({
  item,
  backdrop = true,
  turnable = false,
  dimmed = false,
  badge,
  className,
}: {
  item: RenderedItem;
  backdrop?: boolean;
  turnable?: boolean;
  dimmed?: boolean;
  badge?: JSX.Element | null;
  className?: string;
}): JSX.Element {
  const style = { "--item-hue": itemHue(item.id) } as CSSProperties;
  const classes = ["item-render", className].filter(Boolean).join(" ");
  return (
    <span className={classes} style={style} data-backdrop={backdrop || undefined} data-dimmed={dimmed || undefined}>
      {turnable && item.modelUrl ? <TurnableModel item={item} /> : <ItemPicture src={item.iconUrl} />}
      {badge}
    </span>
  );
}

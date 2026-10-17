import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { openBeside } from "../open-beside.ts";

/** Sent pictures do not change; a transcript that remounts rows asks main once per message. */
const MESSAGE_IMAGE_CACHE_MAX = 64;
const loaded = new Map<string, Promise<ReferenceFrame[]>>();
/** The same, once known: a row shows them in its first paint. */
const known = new Map<string, ReferenceFrame[]>();

const imagesKey = (threadId: string, messageId: string): string => `${threadId}:${messageId}`;

function trimImages(): void {
  while (loaded.size > MESSAGE_IMAGE_CACHE_MAX) {
    const oldest = loaded.keys().next().value;
    if (oldest !== undefined) {
      loaded.delete(oldest);
      known.delete(oldest);
    }
  }
}

function imagesOf(threadId: string, messageId: string): Promise<ReferenceFrame[]> {
  const key = imagesKey(threadId, messageId);
  let images = loaded.get(key);
  if (!images) {
    images = window.studio
      .messageImages(threadId, messageId)
      .then((list) => {
        if (loaded.get(key) === images) known.set(key, list);
        return list;
      })
      .catch(() => {
        loaded.delete(key);
        return [];
      });
    loaded.set(key, images);
    trimImages();
  } else {
    loaded.delete(key);
    loaded.set(key, images);
  }
  return images;
}

/** A sent message's pictures as the composer had them, so its saved row does not blink to placeholders. */
export function rememberMessageImages(threadId: string, messageId: string, frames: ReferenceFrame[]): void {
  const key = imagesKey(threadId, messageId);
  if (known.has(key)) return;
  known.set(key, frames);
  loaded.set(key, Promise.resolve(frames));
  trimImages();
}

/** The pictures already known for a message, or null until they load. */
function knownImages(threadId: string | undefined, messageId: string | undefined): ReferenceFrame[] | null {
  if (!threadId || !messageId) return null;
  return known.get(imagesKey(threadId, messageId)) ?? null;
}

/** The pictures sent with a chat message, once loaded (null until then): the chat's and the Builds graph's. */
export function useMessageImages(threadId: string | undefined, messageId: string | undefined): ReferenceFrame[] | null {
  const [images, setImages] = useState<ReferenceFrame[] | null>(() => knownImages(threadId, messageId));
  useEffect(() => {
    if (!threadId || !messageId) return;
    let current = true;
    void imagesOf(threadId, messageId).then((list) => {
      if (current) setImages(list);
    });
    return () => {
      current = false;
    };
  }, [threadId, messageId]);
  return images;
}

/** A sent picture as an image source. */
export const imageSrc = (image: ReferenceFrame): string => `data:${image.mimeType};base64,${image.data}`;

/**
 * The pictures someone sent with a message, above its words: proof they went with it. A message
 * still on its way shows the pictures the composer had (`frames`) in the same tiles.
 */
export function MessageImages({
  threadId,
  messageId,
  count = 0,
  frames,
}: {
  threadId?: string;
  messageId?: string;
  count?: number;
  frames?: ReferenceFrame[];
}): JSX.Element | null {
  const images = useMessageImages(threadId, messageId);
  const shown = frames ?? images ?? Array.from({ length: Math.min(count, 12) }, () => null);
  if (!shown.length) return null;
  return (
    <div data-message-images className="ms-auto flex max-w-[88%] flex-wrap justify-end gap-1.5">
      {shown.map((image, index) =>
        image ? (
          <button
            key={index}
            type="button"
            aria-label={`Open ${image.label || "image"}`}
            title={image.label}
            onClick={() =>
              openBeside({
                kind: "image",
                name: image.label || `Image ${index + 1}`,
                src: imageSrc(image),
              })
            }
            className="h-[84px] w-[120px] cursor-pointer overflow-hidden rounded-[12px] bg-inset shadow-[inset_0_0_0_1px_var(--line)]"
          >
            <img src={imageSrc(image)} alt="" decoding="async" draggable={false} className="size-full object-cover" />
          </button>
        ) : (
          <span key={index} aria-hidden className="h-[84px] w-[120px] rounded-[12px] bg-inset" />
        ),
      )}
    </div>
  );
}

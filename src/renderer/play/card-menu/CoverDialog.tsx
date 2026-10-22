/**
 * Change cover, for a game's owner or an admin: pick a picture (or drop one on the frame), see it
 * cropped to 16:9 exactly as genex.games will store it, and send it. The picture is cropped here,
 * as the website crops one, so any format this Mac decodes works; genex.games may still keep the
 * old cover (too dark, flat, or outranked), and the dialog then says why.
 */
import type { DragEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { PLAY_COVER_MAX_BYTES, PLAY_COVER_SIZE, PlayCoverType } from "../../../shared/play-manage.ts";
import { studio } from "../../state/studio.ts";
import { ToastTone } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { Icon } from "../../ui/icons.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";
import { actionLabel, type CardDialogProps, DialogFoot } from "./DialogFoot.tsx";

const WORDS = PLAY_CARD_MENU_WORDS.cover;
/** The largest file read at all; the crop is always far smaller. */
const PICTURE_MAX_BYTES = 40 * 1024 * 1024;
/** WebP quality of the cropped cover, as the website encodes one. */
const WEBP_QUALITY = 0.85;
const JPEG_QUALITY = 0.9;

/** A picture bigger than the app reads at all. */
class PictureTooLarge extends Error {}

/** A cropped cover: its bytes, their type, and a local address to preview them. */
interface Cropped {
  bytes: Uint8Array;
  type: PlayCoverType;
  preview: string;
}

/** The canvas encoded as `type`, or null when it could not be. */
const encoded = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** Centre-crop any picture this Mac decodes to the cover size: WebP, else JPEG. */
async function crop(file: File): Promise<Cropped> {
  if (file.size > PICTURE_MAX_BYTES) throw new PictureTooLarge();
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PLAY_COVER_SIZE.width;
    canvas.height = PLAY_COVER_SIZE.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(WORDS.unreadable);
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    // An encoder the canvas lacks hands back a PNG without failing, so the blob's own type is read.
    const webp = await encoded(canvas, PlayCoverType.Webp, WEBP_QUALITY);
    const blob = webp?.type === PlayCoverType.Webp ? webp : await encoded(canvas, PlayCoverType.Jpeg, JPEG_QUALITY);
    if (!blob || blob.size > PLAY_COVER_MAX_BYTES) throw new Error(WORDS.unreadable);
    const type = blob.type === PlayCoverType.Webp ? PlayCoverType.Webp : PlayCoverType.Jpeg;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type, preview: URL.createObjectURL(blob) };
  } finally {
    bitmap.close();
  }
}

/** Pick, preview and send a new cover. */
export function CoverDialog({ game, onClose, returnFocus }: CardDialogProps): JSX.Element {
  const [picked, setPicked] = useState<Cropped | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => () => (picked ? URL.revokeObjectURL(picked.preview) : undefined), [picked]);

  const pick = async (chosen: File | undefined) => {
    if (!chosen || busy) return;
    setProblem(null);
    setFailed(false);
    try {
      setPicked(await crop(chosen));
    } catch (error) {
      setProblem(error instanceof PictureTooLarge ? WORDS.tooLarge : WORDS.unreadable);
    }
  };
  const send = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await studio().api.playCover(game.id, picked.bytes, picked.type);
      if (result.applied && result.coverUrl) studio().play.coverChanged(game, result.coverUrl);
      if (!result.applied) {
        setProblem(result.refusal ? WORDS.refusal[result.refusal] : WORDS.failed);
        return;
      }
      studio().notify(WORDS.done, ToastTone.Ok);
      onClose();
    } catch {
      setProblem(WORDS.failed);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    void pick(event.dataTransfer.files[0]);
  };
  const shown = picked?.preview ?? game.coverUrl;
  return (
    <DialogSurface
      title={WORDS.title(game.title)}
      description={WORDS.sub}
      onDismiss={onClose}
      returnFocus={returnFocus}
      dismissible={!busy}
    >
      <div
        className="play-cover-frame"
        data-play-cover-frame
        role="img"
        aria-label={picked ? WORDS.picked : WORDS.current}
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
      >
        {shown && <img src={shown} alt="" draggable={false} />}
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={WORDS.choose}
        onChange={(event) => {
          void pick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <DialogFoot
        problem={problem}
        busy={busy}
        onCancel={onClose}
        aside={
          <Button variant="secondary" disabled={busy} onClick={() => file.current?.click()} data-play-cover-choose>
            <Icon name="image" />
            {picked ? WORDS.another : WORDS.choose}
          </Button>
        }
      >
        {picked && (
          <Button variant="play-fill" disabled={busy} onClick={() => void send()} data-play-dialog-save>
            {actionLabel(WORDS.save, busy, failed)}
          </Button>
        )}
      </DialogFoot>
    </DialogSurface>
  );
}

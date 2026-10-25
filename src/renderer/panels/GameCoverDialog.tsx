/** Adapted from Genex CoverDialog: center-crop, preview, explicit save. Everything stays local. */
import { useEffect, useRef, useState } from "react";
import type { GameProject } from "../types.ts";
import type { GameCover, GameUpdate } from "../../shared/game-library.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { problemWords } from "../words.ts";
import { t } from "../../shared/i18n.ts";

/** The largest image a cover is read from (20 MB). */
const COVER_MAX_BYTES = 20 * 1024 * 1024;
/** A saved cover's side, in pixels: the image is centre-cropped to this square. */
const COVER_PX = 256;

/** What a cover that cannot be read tells the person. */
const MESSAGE = {
  tooLarge: t("Choose an image smaller than 20 MB."),
  noPreview: t("Image preview is unavailable."),
};

async function normalizeCover(file: File): Promise<string> {
  if (file.size > COVER_MAX_BYTES) throw new Error(MESSAGE.tooLarge);
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = COVER_PX;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(MESSAGE.noPreview);
    const scale = Math.max(COVER_PX / image.width, COVER_PX / image.height);
    context.drawImage(
      image,
      (COVER_PX - image.width * scale) / 2,
      (COVER_PX - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
    // Electron nativeImage decodes PNG/JPEG; normalize WebP uploads before crossing IPC.
    return canvas.toDataURL("image/png");
  } finally {
    image.close();
  }
}
export function GameCoverDialog({
  game,
  onSave,
  onDismiss,
}: {
  game: GameProject;
  onSave: (patch: GameUpdate) => Promise<void>;
  onDismiss: () => void;
}) {
  const [pending, setPending] = useState<GameCover | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function pick(file?: File) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const dataUrl = await normalizeCover(file);
      if (mounted.current) setPending({ kind: "image", dataUrl });
    } catch {
      if (mounted.current) setError(t("Could not read that image. Try a PNG, JPEG or WebP file."));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <DialogSurface
      dismissible={!busy}
      title={t("Change image")}
      size="md"
      onDismiss={() => {
        if (!busy) onDismiss();
      }}
    >
      <div className="game-cover-preview" role="img" aria-label={t("{game} cover preview", { game: game.title })}>
        <GameAvatar cover={pending ?? game.cover} gameKey={game.name} />
      </div>
      <input
        type="file"
        ref={fileRef}
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label={t("Choose game image")}
        onChange={(event) => {
          void pick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-red">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button disabled={busy} onClick={() => fileRef.current?.click()}>
          <Icon name="image" />
          {t("Choose image…")}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={onDismiss}>
            {t("Cancel")}
          </Button>
          <Button
            variant="default"
            disabled={busy || !pending}
            onClick={() => {
              if (!pending) return;
              setBusy(true);
              void onSave({ cover: pending })
                .then(onDismiss)
                .catch((error) => setError(problemWords(error)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? t("Saving…") : t("Save image")}
          </Button>
        </div>
      </div>
    </DialogSurface>
  );
}

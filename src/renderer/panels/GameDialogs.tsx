import { useRef, useState } from "react";
import type { GameProject } from "../types.ts";
import type { GameUpdate } from "../../shared/game-library.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { Button } from "../ui/Button.tsx";
import { problemWords } from "../words.ts";
import { t } from "../../shared/i18n.ts";

export function RenameGameDialog({
  game,
  onSave,
  onDismiss,
}: {
  game: GameProject;
  onSave: (patch: GameUpdate) => Promise<void>;
  onDismiss: () => void;
}) {
  const [name, setName] = useState(game.title);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <DialogSurface
      dismissible={!busy}
      title={t("Rename game")}
      onDismiss={() => {
        if (!busy) onDismiss();
      }}
      initialFocus={input}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !name.trim()) return;
          setBusy(true);
          void onSave({ title: name.trim() })
            .then(onDismiss)
            .catch((error) => setError(problemWords(error)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="flex flex-col gap-2 text-xs text-ink-2">
          {t("Game name")}
          <input
            className="game-text-input"
            ref={input}
            autoFocus
            value={name}
            maxLength={80}
            disabled={busy}
            onFocus={(event) => event.target.select()}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-red">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onDismiss}>
            {t("Cancel")}
          </Button>
          <Button type="submit" variant="default" disabled={busy || !name.trim()}>
            {busy ? t("Saving…") : t("Save")}
          </Button>
        </div>
      </form>
    </DialogSurface>
  );
}
export function DeleteGameDialog({
  game,
  onDelete,
  onDismiss,
}: {
  game: GameProject;
  onDelete: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <DialogSurface
      dismissible={!busy}
      title={t("Delete “{game}”?", { game: game.title })}
      description={t(
        "Removes it from the sidebar. Your files and conversation history stay on this computer. Open the folder again to restore it.",
      )}
      onDismiss={() => {
        if (!busy) onDismiss();
      }}
    >
      {error && (
        <p role="alert" className="text-xs text-red">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onDismiss}>
          {t("Cancel")}
        </Button>
        <Button
          data-delete-game
          variant="destructive"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDelete()
              .then(onDismiss)
              .catch((error) => setError(problemWords(error)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t("Removing…") : t("Delete game")}
        </Button>
      </div>
    </DialogSurface>
  );
}

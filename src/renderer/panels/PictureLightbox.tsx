/**
 * A picture the chat shows, opened over the whole window the way an asset is: an image someone
 * sent, a cover shot, a screenshot or an image of the game the chat names. A game file is read
 * inside the game (its folder, or the build a run made); Show in Finder reaches one in the folder.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { GameFile } from "../../shared/game-file.ts";
import { t } from "../../shared/i18n.ts";
import { type BesideTarget, besideName } from "../open-beside.ts";
import { hostPlatform } from "../platform.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { Lightbox } from "../ui/Lightbox.tsx";
import { Pending } from "../ui/Pending.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { fileManagerWords, problemWords } from "../words.ts";

/** Where reading the picture stands. */
const ReadState = {
  Reading: "reading",
  Ready: "ready",
  Failed: "failed",
} as const;
/** Still reading, its source (and its file, for one of the game), or why it cannot show. */
type Read =
  | { state: typeof ReadState.Reading }
  | { state: typeof ReadState.Ready; src: string; file: GameFile | null }
  | { state: typeof ReadState.Failed; problem: string };

const READING: Read = { state: ReadState.Reading };
const failed = (problem: string): Read => ({ state: ReadState.Failed, problem });

/** The picture's source: at hand for a sent image, read from the game for a file. */
function usePicture(threadId: string | null, target: BesideTarget): Read {
  const [read, setRead] = useState<Read>(READING);
  useEffect(() => {
    if (target.kind === "image") {
      setRead({ state: ReadState.Ready, src: target.src, file: null });
      return;
    }
    if (!threadId) {
      setRead(failed(t("This chat has no game folder yet.")));
      return;
    }
    let current = true;
    setRead(READING);
    window.studio.readGameFile(threadId, target.path).then(
      (file) => {
        if (!current) return;
        setRead(
          file.kind === "image" && file.src
            ? { state: ReadState.Ready, src: file.src, file }
            : failed(t("This file can’t be shown here.")),
        );
      },
      (error: unknown) => {
        if (current) setRead(failed(problemWords(error)));
      },
    );
    return () => {
      current = false;
    };
  }, [threadId, target]);
  return read;
}

/** The chat's picture over the window, with Close, and Show in Finder for one in the game folder. */
export function PictureLightbox({
  threadId,
  target,
  onClose,
  onNotice,
}: {
  threadId: string | null;
  target: BesideTarget;
  onClose: () => void;
  onNotice: Notify;
}): JSX.Element {
  const read = usePicture(threadId, target);
  const name = besideName(target);
  const inFolder = read.state === ReadState.Ready && read.file?.where === "game" ? read.file : null;
  return (
    <Lightbox
      title={name}
      testId="chat-picture"
      onDismiss={onClose}
      actions={
        inFolder && threadId ? (
          <button
            type="button"
            className="lightbox-button"
            onClick={() => void window.studio.revealGameFile(threadId, inFolder.path).catch(notifyProblem(onNotice))}
          >
            {fileManagerWords(hostPlatform()).reveal}
          </button>
        ) : null
      }
    >
      <PictureBody read={read} name={name} />
    </Lightbox>
  );
}

function PictureBody({ read, name }: { read: Read; name: string }): JSX.Element {
  if (read.state === ReadState.Ready)
    return (
      <img
        src={read.src}
        alt={name}
        draggable={false}
        data-chat-picture-image
        className="lightbox-media block max-h-[calc(100vh-160px)] max-w-[calc(100vw-160px)] object-contain"
      />
    );
  if (read.state === ReadState.Failed)
    return (
      <div role="alert" className="max-w-md text-center text-body-sm text-ink-2">
        {read.problem}
      </div>
    );
  return (
    <Pending label={t("Opening {name}", { name })} className="pointer-events-none grid place-items-center">
      <Skeleton width={220} height={220} radius={20} />
    </Pending>
  );
}

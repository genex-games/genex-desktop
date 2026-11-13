/**
 * A file the chat named, read beside the conversation; a picture opens over the window instead
 * (PictureLightbox.tsx). The game view gives this rectangle back the way Builds and Assets do.
 * Files the viewer cannot draw say so; Show in Finder reaches everything in the game folder.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { GameFile } from "../../shared/game-file.ts";
import { Icon } from "../ui/icons.tsx";
import { ChatFilesScope } from "../chat-files.ts";
import { Markdown } from "../ui/Markdown.tsx";
import { codeLanguage, highlightCode } from "../ui/syntax-highlight.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { fileManagerWords, problemWords } from "../words.ts";
import { type BesideFile, besideName } from "../open-beside.ts";
import { hostPlatform } from "../platform.ts";
import { Pending } from "../ui/Pending.tsx";
import { t } from "../../shared/i18n.ts";
import { SkeletonLines } from "../ui/Skeleton.tsx";

/** Where reading the file stands. */
const LoadState = {
  Loading: "loading",
  Ready: "ready",
  Failed: "failed",
} as const;
type Loaded =
  | { state: typeof LoadState.Loading }
  | { state: typeof LoadState.Ready; file: GameFile }
  | { state: typeof LoadState.Failed; problem: string };

export function FileViewer({
  threadId,
  target,
  onClose,
  onNotice,
}: {
  threadId: string | null;
  target: BesideFile;
  onClose: () => void;
  onNotice: Notify;
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ state: LoadState.Loading });
  useEffect(() => {
    if (!threadId) {
      setLoaded({ state: LoadState.Failed, problem: t("This chat has no game folder yet.") });
      return;
    }
    let current = true;
    setLoaded({ state: LoadState.Loading });
    window.studio.readGameFile(threadId, target.path).then(
      (file) => {
        if (current) setLoaded({ state: LoadState.Ready, file });
      },
      (error: unknown) => {
        if (current) setLoaded({ state: LoadState.Failed, problem: problemWords(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [threadId, target]);
  const file = loaded.state === LoadState.Ready ? loaded.file : null;
  const code = useMemo(
    () => (file?.kind === "text" && file.text !== undefined ? highlightCode(file.text, codeLanguage(file.path)) : ""),
    [file],
  );
  const inFolder = file?.where === "game";
  const folderFile = inFolder ? file : null;
  return (
    <section data-file-viewer aria-label={besideName(target)} className="absolute inset-0 flex flex-col bg-page">
      <div className="flex min-h-15 shrink-0 items-center gap-3 border-b border-line ps-5 pe-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span title={file?.path ?? target.path} className="truncate text-[15px] leading-5 font-medium text-ink">
            {besideName(target)}
          </span>
          {file?.where === "build" && (
            <span className="truncate text-[13px] leading-[18px] text-ink-3">
              {t("In the build · not in your game folder yet")}
            </span>
          )}
        </div>
        {folderFile && threadId && (
          <ViewerAction
            label={fileManagerWords(hostPlatform()).show}
            onClick={() => void window.studio.revealGameFile(threadId, folderFile.path).catch(notifyProblem(onNotice))}
          >
            <Icon name="folder" size={16} />
          </ViewerAction>
        )}
        <ViewerAction label={t("Close file")} onClick={onClose}>
          <Icon name="close" size={15} />
        </ViewerAction>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* A document's own links are the chat's files: they open as the chat's would. */}
        <ChatFilesScope.Provider value={threadId}>
          <FileBody loaded={loaded} name={besideName(target)} code={code} />
        </ChatFilesScope.Provider>
        {file?.truncated && (
          <p className="m-0 px-11 pb-7 text-chat-sub text-ink-3">
            {t("The rest of this file is too long to show here.")}
          </p>
        )}
      </div>
    </section>
  );
}

/** The file as the viewer shows it: opening, its problem, a document, highlighted code, or a refusal. */
function FileBody({ loaded, name, code }: { loaded: Loaded; name: string; code: string }): JSX.Element {
  if (loaded.state === LoadState.Loading)
    return (
      <Pending label={t("Opening {name}", { name })} className="flex flex-col gap-7 px-11 py-7">
        <SkeletonLines widths={["100%", "96%", "62%"]} />
        <SkeletonLines widths={["100%", "88%", "92%", "40%"]} />
      </Pending>
    );
  if (loaded.state === LoadState.Failed)
    return (
      <p role="alert" className="m-0 px-11 py-7 text-chat text-ink-2">
        {loaded.problem}
      </p>
    );
  const { file } = loaded;
  if (file.kind === "markdown")
    return (
      <article className="max-w-[700px] px-11 py-7">
        <Markdown text={file.text ?? ""} fileBase={file.path} className="file-doc" />
      </article>
    );
  if (file.kind === "text")
    return (
      <pre className="file-code m-0 px-5 py-4">
        <code dangerouslySetInnerHTML={{ __html: code }} />
      </pre>
    );
  return <p className="m-0 px-11 py-7 text-chat text-ink-2">{t("This file can’t be shown here.")}</p>;
}

function ViewerAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-control text-ink-3 transition-colors duration-(--duration-quick) hover:bg-control-hover hover:text-control-text-hover"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

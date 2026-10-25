/**
 * Plain chat text — a person's message, a worker's note, a reason — with the names in it that
 * are files as links (file-links.ts does the same for rendered HTML). Outside a chat's
 * `ChatFilesScope` it is only the text.
 */
import { type JSX, memo, type ReactNode, useMemo } from "react";
import { type ChatFileLink, type ChatFileRef, fileMentions } from "../../shared/chat-files.ts";
import { clickFileLink, useChatFileNames, useChatFiles } from "../chat-files.ts";
import { fileLinkTitle, fileNameOfPath } from "./file-links.ts";
import { Icon } from "./icons.tsx";

/**
 * The text with its file names as links. With `chips`, a path written out in full shows as a chip
 * with the file's own name (the path on hover), as a person's message shows the files it carries.
 */
export const FileText = memo(function FileText({
  text,
  chips = false,
}: {
  text: string;
  chips?: boolean;
}): JSX.Element {
  const { threadId, lookup } = useChatFiles();
  const mentions = useMemo(() => (threadId ? fileMentions(text) : []), [threadId, text]);
  useChatFileNames(
    threadId,
    useMemo(() => mentions.map((mention) => ({ name: mention.name })), [mentions]),
  );
  const parts: ReactNode[] = [];
  let at = 0;
  for (const mention of mentions) {
    const link = lookup(mention.name);
    if (!link) continue;
    const short = chips ? fileNameOfPath(mention.name) : null;
    parts.push(text.slice(at, mention.start));
    at = mention.end;
    parts.push(
      short ? (
        <FileLink
          key={mention.start}
          threadId={threadId}
          fileRef={{ name: mention.name }}
          link={link}
          label={short}
          className="file-chip"
        >
          <Icon name="file" size={13} />
          <span className="truncate">{short}</span>
        </FileLink>
      ) : (
        <FileLink key={mention.start} threadId={threadId} fileRef={{ name: mention.name }} link={link}>
          {text.slice(mention.start, mention.end)}
        </FileLink>
      ),
    );
  }
  if (!at) return <>{text}</>;
  parts.push(text.slice(at));
  return <>{parts}</>;
});

/** One file link as underlined text. `children` is what it says; long paths may pass pieces. */
export function FileLink({
  threadId,
  fileRef,
  link,
  children,
  label,
  className = "",
}: {
  threadId: string | null;
  fileRef: ChatFileRef;
  link: ChatFileLink;
  children: ReactNode;
  /** The words it shows, when `children` is not plain text. */
  label?: string;
  className?: string;
}): JSX.Element {
  const words = label ?? (typeof children === "string" ? children : fileRef.name);
  return (
    <button
      type="button"
      className={`file-link ${className}`}
      data-file-path={fileRef.name}
      data-file-base={fileRef.base}
      data-file-open={link.open}
      data-file-target={link.path}
      title={fileLinkTitle(link, words)}
      onClick={(event) => clickFileLink(event, threadId)}
    >
      {children}
    </button>
  );
}

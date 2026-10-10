import type { JSX } from "react";
import { ChatHeader } from "../panels/ChatHeader.tsx";
import type { ChatExport } from "./use-chat-export.ts";
import type { ChatParts } from "./use-chat-panel.ts";

/**
 * The chat's header, keyed by thread: its title (a game chat renames its game), export, reveal
 * and compaction.
 */
export function ChatPanelHeader({
  props,
  chat,
  composer,
  chatExport,
}: ChatParts & { chatExport: ChatExport }): JSX.Element {
  const { project, threadId } = chat;
  const nativeUnity = chat.folder?.shape.kind === "unity";
  let onExport: (() => void) | undefined;
  if (project) onExport = nativeUnity ? props.onShowLive : chatExport.exportGame(project);
  return (
    <ChatHeader
      key={threadId}
      sidebarHidden={props.sidebarHidden}
      onToggleSidebar={props.onToggleSidebar}
      exporting={nativeUnity ? false : chatExport.exporting}
      exportLabel={nativeUnity ? "Build Unity player…" : undefined}
      onExport={onExport}
      chatTitle={chat.chatTitle}
      isStudio={chat.isStudioThread}
      isDraft={chat.isDraft}
      project={project}
      pathLabel={chat.folder?.pathLabel}
      contextUsage={null}
      compacting={composer.compact.compacting}
      onCompact={composer.compact.compactNow}
      onRename={(title) => {
        if (project && props.onRenameGame) props.onRenameGame(project, title);
        else if (threadId) props.onRename(threadId, title);
      }}
      onReveal={project ? () => void window.studio.revealProject(project) : undefined}
    />
  );
}

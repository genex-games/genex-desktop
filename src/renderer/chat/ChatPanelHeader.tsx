import { type JSX, lazy, Suspense } from "react";
import { ChatHeader } from "../panels/ChatHeader.tsx";
import type { ChatExport } from "./use-chat-export.ts";
import { useGameStorage } from "./use-game-storage.ts";
import type { ChatParts } from "./use-chat-panel.ts";

// The export sheet loads when an export opens it, outside the studio's first chunk.
const ExportSheet = lazy(() => import("../panels/ExportSheet.tsx").then((m) => ({ default: m.ExportSheet })));

/**
 * The chat's header, keyed by thread: its title (a game chat renames its game), export (a phone
 * opens the export sheet), reveal, freeing its game's space and compaction.
 */
export function ChatPanelHeader({
  props,
  chat,
  composer,
  chatExport,
}: ChatParts & { chatExport: ChatExport }): JSX.Element {
  const { sheet } = chatExport;
  return (
    <>
      <ChatHeaderBar props={props} chat={chat} composer={composer} chatExport={chatExport} />
      {sheet && (
        <Suspense fallback={null}>
          <ExportSheet
            project={sheet.project}
            destination={sheet.destination}
            onClose={chatExport.closeSheet}
            onExported={chatExport.sheetExported}
          />
        </Suspense>
      )}
    </>
  );
}

/** The header itself: title, export menu, reveal, history space and compaction. */
function ChatHeaderBar({
  props,
  chat,
  composer,
  chatExport,
}: Pick<ChatParts, "props" | "chat" | "composer"> & { chatExport: ChatExport }): JSX.Element {
  const { project, threadId } = chat;
  const storage = useGameStorage(project, chat.working, props.onNotice);
  return (
    <ChatHeader
      key={threadId}
      sidebarHidden={props.sidebarHidden}
      onToggleSidebar={props.onToggleSidebar}
      exporting={chatExport.exporting}
      onExport={project ? chatExport.exportGame(project) : undefined}
      storage={project ? storage : undefined}
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

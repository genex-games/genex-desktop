import type { RefObject } from "react";
import type { ComposerSendOptions } from "../../shared/composer.ts";
import type { Notify } from "../state/toasts.ts";
import type { ConversationRecord, EngineDescriptor, EventEnvelope, GameProject } from "../types.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";

/** The open chat's paging: whether earlier messages exist, and loading them. */
export type ChatHistory = { hasMore: boolean; paging: boolean; pageError?: string; loadEarlier: () => Promise<void> };

/** What the shell hands the chat panel: the open thread, its slice of the log, and the shell's actions. */
export interface ChatPanelProps {
  events: EventEnvelope[];
  stateEvents: EventEnvelope[];
  history: ChatHistory;
  engines: EngineDescriptor[];
  games: GameProject[];
  activeThread: ConversationRecord | null;
  status: string;
  busySince: number | null;
  /** What the open chat's work waits for the person to finish in (a lock's label), when it does. */
  personFirst?: string | null;
  firstAsk?: string | null;
  loading: boolean;
  loadError?: string;
  onRetryLoad: () => void;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  onEnginesRefresh: () => void;
  onRename: (threadId: string, title: string) => void;
  onRenameGame?: (project: string, title: string) => void;
  onNewGame?: () => void;
  /** Put the stage on Live — the morning card's own answer to "let me see it". */
  onShowLive?: () => void;
  onShowAssets?: () => void;
  /** Put the stage on Builds — the running build's row in the chat opens it. */
  onShowBuilds?: () => void;
  onOpenStudio?: () => void;
  /**
   * App's toast channel. The morning card's own buttons refuse for ordinary reasons — an edit of
   * the user's own in the game folder, a builder still working there — and without this they
   * refuse in silence.
   */
  onNotice: Notify;
  onSend: (text: string, options: ComposerSendOptions) => Promise<void>;
  /** The composer, for App's shortcuts (⌘I) and for putting the cursor in a new game's chat. */
  composer?: RefObject<PromptBarHandle | null>;
}

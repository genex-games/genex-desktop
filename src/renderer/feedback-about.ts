/** Where Send feedback was opened: the screen, and the chat whose logs it can attach. */
import { FeedbackScreen } from "../shared/feedback.ts";
import { isGameThread, threadMeta } from "./state/threads.ts";
import type { ConversationRecord, GameProject } from "./types.ts";
import { NOTICE_WORDS } from "./words.ts";

export interface FeedbackAbout {
  screen: FeedbackScreen;
  /** The open chat, or null on Home and Plugins. */
  chat: { id: string; title: string } | null;
}

/** The screen behind the sidebar, and its chat named as the person knows it: the game, or Harness. */
export function feedbackAbout({
  activeThread,
  pluginsOpen,
  games,
}: {
  activeThread: ConversationRecord | null;
  pluginsOpen: boolean;
  games: readonly GameProject[];
}): FeedbackAbout {
  if (pluginsOpen) return { screen: FeedbackScreen.Plugins, chat: null };
  if (!activeThread) return { screen: FeedbackScreen.Home, chat: null };
  if (!isGameThread(activeThread)) {
    return { screen: FeedbackScreen.Harness, chat: { id: activeThread.id, title: NOTICE_WORDS.harness } };
  }
  const project = threadMeta(activeThread).project;
  const game = games.find((entry) => entry.name === project);
  const title = game?.title ?? activeThread.title ?? NOTICE_WORDS.newGame;
  return { screen: FeedbackScreen.Chat, chat: { id: activeThread.id, title } };
}

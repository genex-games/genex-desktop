/**
 * The lines the agent reads about a message's @ tags, after the person's words. Each tag says what
 * it is and where it is, and the closing rule asks the agent to use every one or say why not.
 */
import {
  MENTION_CONTEXT_HEADING,
  MentionKind,
  MentionMiss,
  type MentionOutcome,
  MentionResult,
} from "../../shared/prompt-mention.ts";

/** Why a tag attached nothing, in words the agent can pass on. */
const MISS_WORDS: Record<MentionMiss, string> = {
  [MentionMiss.Gone]: "it is no longer there",
  [MentionMiss.NotTakeable]: "its author no longer lets anyone take it",
  [MentionMiss.NotDownloaded]: "it could not be downloaded",
  [MentionMiss.NotWebGame]: "assets are three.js code and this game is not a web game",
};

const KIND_WORDS: Record<MentionKind, string> = {
  [MentionKind.Game]: "game",
  [MentionKind.Tool]: "tool",
  [MentionKind.Asset]: "asset",
  [MentionKind.Plugin]: "plugin",
};

/** One tag's line; `folder` is a local game's folder, `usage` an asset's own usage notes. */
export function mentionLine(tag: MentionOutcome, extra: { folder?: string; usage?: string } = {}): string {
  const name = `@${tag.handle} (${KIND_WORDS[tag.kind]} "${tag.title}")`;
  if (tag.kind === MentionKind.Plugin && tag.result === MentionResult.Read)
    return `- ${name}: a plugin that is on in this chat. Use its tools for this where they help.`;
  if (tag.result === MentionResult.Read)
    return `- ${name}: the person's own game, read-only at ${extra.folder ?? "its folder"}. Read what helps; never edit it.`;
  if (tag.result === MentionResult.Copied)
    return `- ${name} from genex.games: a read-only copy at ${tag.path}/. Read it and adapt what helps into this game's own code; never import from it, edit it or ship it.`;
  if (tag.result === MentionResult.Added) {
    const usage = extra.usage ? ` ${extra.usage}` : "";
    return `- ${name}: its module is now this game's file ${tag.path}, free to use and edit (MIT).${usage}`;
  }
  return `- ${name}: could not be attached, because ${MISS_WORDS[tag.miss ?? MentionMiss.Gone]}. Tell the person.`;
}

/** The block after the person's words: the heading, a line per tag and the rule. */
export function mentionContext(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `${MENTION_CONTEXT_HEADING}${lines.join("\n")}\nUse each tagged thing in this turn's work, or say in your reply why not.`;
}

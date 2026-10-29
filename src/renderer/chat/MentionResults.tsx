/**
 * The card under a message with @ tags: each tag's cover, what the agent got, and a green ✓ for
 * those that arrived. A tag that didn't is yellow and says what to do: Try again when fetching it
 * again can help, else Remove tag. A removed tag leaves the card.
 */
import { type JSX, useState } from "react";
import type { GameCover } from "../../shared/game-library.ts";
import {
  MentionKind,
  type MentionOutcome,
  MentionMiss,
  MentionResult,
  MentionRetry,
  refOf,
  retriable,
} from "../../shared/prompt-mention.ts";
import { useLibrary, usePlugins } from "../state/hooks.ts";
import { PluginIcon } from "../ui/PluginIcon.tsx";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { Icon } from "../ui/icons.tsx";
import { MENTION_WORDS } from "../words.ts";

/** What a tag's row says under its title. */
function rowWords(tag: MentionOutcome): string {
  if (tag.kind === MentionKind.Plugin) return MENTION_WORDS.pluginRead;
  if (tag.result === MentionResult.Read) return MENTION_WORDS.read;
  if (tag.result === MentionResult.Copied) return MENTION_WORDS.copied;
  if (tag.result === MentionResult.Added) return tag.path ? MENTION_WORDS.addedTo(tag.path) : MENTION_WORDS.added;
  return MENTION_WORDS.missed[tag.miss ?? MentionMiss.Gone];
}

/** A tag's small cover: a plugin's own logo, its genex.games picture, a local game's sphere, or a plain tile. */
function TagCover({ tag, cover }: { tag: MentionOutcome; cover: GameCover | undefined }): JSX.Element {
  const plugin = usePlugins((s) => (tag.plugin ? s.list.find((entry) => entry.manifest.id === tag.plugin) : undefined));
  if (tag.kind === MentionKind.Plugin)
    return (
      <span className="mention-result-cover mention-result-logo" aria-hidden>
        <PluginIcon name={tag.title} src={plugin?.iconUrl} size="menu" />
      </span>
    );
  if (tag.coverUrl) return <img src={tag.coverUrl} alt="" className="mention-result-cover" draggable={false} />;
  return (
    <span className="mention-result-cover" aria-hidden>
      {tag.game ? <GameAvatar cover={cover} gameKey={tag.game} className="mention-result-avatar" /> : null}
    </span>
  );
}

/** The button on a tag that attached nothing: Try again when fetching it again can help, else Remove tag. */
function TagAction({ tag, act }: { tag: MentionOutcome; act: (action: MentionRetry) => Promise<void> }): JSX.Element {
  const [pending, setPending] = useState(false);
  const action = retriable(tag) ? MentionRetry.Again : MentionRetry.Remove;
  const label = action === MentionRetry.Again ? MENTION_WORDS.tryAgain : MENTION_WORDS.removeTag;
  return (
    <button
      type="button"
      className="mention-result-action"
      data-mention-retry={action}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void act(action).finally(() => setPending(false));
      }}
    >
      {pending ? MENTION_WORDS.trying : label}
    </button>
  );
}

/** A tag that arrived: a green ✓ alone; its words name it for a screen reader. */
function TagOk({ tag }: { tag: MentionOutcome }): JSX.Element {
  const words = tag.result === MentionResult.Added ? MENTION_WORDS.added : MENTION_WORDS.ready;
  return (
    <span className="mention-result-ok" role="img" aria-label={words} title={words}>
      <Icon name="check" size={15} />
    </span>
  );
}

/** One tag's row, with its action while it attached nothing. */
function TagRow({
  tag,
  cover,
  act,
}: {
  tag: MentionOutcome;
  cover: GameCover | undefined;
  act: ((action: MentionRetry) => Promise<void>) | null;
}): JSX.Element {
  const failed = tag.result === MentionResult.Unavailable;
  return (
    <div className="mention-result" role="listitem" data-mention-result={tag.handle} data-failed={failed || undefined}>
      <TagCover tag={tag} cover={cover} />
      <span className="mention-result-text">
        <b>{tag.title}</b>
        <span>{rowWords(tag)}</span>
      </span>
      {failed && act ? <TagAction tag={tag} act={act} /> : null}
      {failed ? null : <TagOk tag={tag} />}
    </div>
  );
}

/** The card; its actions need the chat and the message's queue id, else it only shows results. */
export function MentionResults({
  tags,
  threadId,
  messageId,
  onProblem,
}: {
  tags: readonly MentionOutcome[];
  threadId: string | null;
  messageId: string | undefined;
  onProblem: (error: unknown) => void;
}): JSX.Element | null {
  const games = useLibrary((s) => s.games);
  const shown = tags.filter((tag) => tag.result !== MentionResult.Removed);
  if (!shown.length) return null;
  const act =
    threadId && messageId
      ? (tag: MentionOutcome) => (action: MentionRetry) =>
          window.studio.mentionRetry(threadId, messageId, refOf(tag), action).catch(onProblem)
      : null;
  return (
    <div className="mention-results" role="list" aria-label={MENTION_WORDS.resultsLabel}>
      {shown.map((tag) => (
        <TagRow
          key={tag.handle}
          tag={tag}
          cover={tag.game ? games.find((game) => game.name === tag.game)?.cover : undefined}
          act={act ? act(tag) : null}
        />
      ))}
    </div>
  );
}

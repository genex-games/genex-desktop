/**
 * The Publish dialog's platforms (canvas board "Publish"): the web, Mac and Windows rows read from
 * the game folder, each with what its build runs on, when it was built and its size. An app not made
 * yet offers "Make with agent", which sends the ask through the game's chat at once and keeps the
 * dialog open, the row then saying it was asked. A ready app goes with Publish once its web build is
 * public: the line under the rows says so, and its row then says it is being sent, is on Genex, or
 * was not sent (with why, under the rows). While Studio's Genex CLI cannot send apps, a built one
 * says "Coming soon" and its players get the web version. A web game with no app shows none of this.
 */
import type { JSX } from "react";
import { useState } from "react";
import type { GenexNativeRecord } from "../../../../shared/genex.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { useLibrary } from "../../../state/hooks.ts";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { PUBLISH_PLATFORM_WORDS } from "../../../words.ts";
import {
  failureLines,
  listingLine,
  listsPlatforms,
  makeAppAsk,
  makesApps,
  PlatformEnd,
  type PlatformRow,
  platformRows,
  reachLine,
} from "./publish-platforms-view.ts";

const WORDS = PUBLISH_PLATFORM_WORDS;

/** Each platform's mark. */
const MARK: Readonly<Record<PublishTarget, IconName>> = {
  [PublishTarget.Web]: "globe",
  [PublishTarget.Mac]: "apple",
  [PublishTarget.Windows]: "windows",
};

/** The game folder's platforms, read once as the dialog opens; null until read or when unreadable. */
export function usePublishPlatforms(project: string): PublishPlatform[] | null {
  const [platforms, setPlatforms] = useState<PublishPlatform[] | null>(null);
  useAsyncEffect(
    (alive) => {
      void window.studio
        .genexPublishPlatforms(project)
        .then((read) => {
          if (alive()) setPlatforms(read);
        })
        .catch(() => {});
      return undefined;
    },
    [project],
  );
  return platforms;
}

/** The quiet words a row ends with, by what it says: each with its words for a screen reader. */
const NOTE: Partial<Record<PlatformEnd, { text: string; label: (name: string) => string }>> = {
  [PlatformEnd.Soon]: { text: WORDS.soon, label: WORDS.soonLabel },
  [PlatformEnd.Sending]: { text: WORDS.sending, label: (name) => `${name}: ${WORDS.sending}` },
  [PlatformEnd.Sent]: { text: WORDS.sent, label: WORDS.sentLabel },
  [PlatformEnd.Failed]: { text: WORDS.failed, label: (name) => `${name}: ${WORDS.failed}` },
};

/** What a row ends with: a note ("Coming soon", "On Genex"…), Make with agent, or that the agent was asked. */
function End({
  row,
  asked,
  onMake,
}: {
  row: PlatformRow;
  asked: boolean;
  onMake: (target: PublishTarget) => void;
}): JSX.Element | null {
  const note = NOTE[row.end];
  if (note)
    return (
      <span className="genex-publish-platform-note" data-end={row.end} role="note" aria-label={note.label(row.name)}>
        {note.text}
      </span>
    );
  if (row.end !== PlatformEnd.Make) return null;
  if (asked)
    return (
      <span className="genex-publish-platform-note" role="status" data-publish-platform-asked={row.target}>
        {WORDS.asked}
      </span>
    );
  return (
    <button
      type="button"
      className="genex-publish-platform-make"
      aria-label={WORDS.makeLabel(row.name)}
      data-publish-platform-make={row.target}
      onClick={() => onMake(row.target)}
    >
      {WORDS.make}
      <Icon name="chevron-right" size={12} />
    </button>
  );
}

/** One platform: its mark, name and detail, then its size or what it offers. */
function Row({
  row,
  asked,
  onMake,
}: {
  row: PlatformRow;
  asked: boolean;
  onMake: (target: PublishTarget) => void;
}): JSX.Element {
  return (
    <li className="genex-publish-platform" data-publish-platform={row.target} data-state={row.state}>
      <Icon name={MARK[row.target]} size={18} />
      <span className="genex-publish-platform-text">
        <span>{row.name}</span>
        <span className="genex-publish-platform-detail">{row.detail}</span>
      </span>
      {row.size && <span className="genex-publish-platform-size">{row.size}</span>}
      <End row={row} asked={asked} onMake={onMake} />
    </li>
  );
}

/**
 * The platform rows and who plays what, or nothing for a web game with no app. Read once while the
 * dialog is open: hidden while it celebrates, they are not read again after.
 */
export function PublishPlatforms({
  project,
  platforms,
  shown,
  native,
}: {
  project: string;
  /** The game folder's platforms (`usePublishPlatforms`), null until read. */
  platforms: PublishPlatform[] | null;
  shown: boolean;
  /** How the last Publish's apps went, from the publish record. */
  native?: GenexNativeRecord | undefined;
}): JSX.Element | null {
  const engineGame = useLibrary((s) => {
    const game = s.games.find((g) => g.name === project);
    return Boolean(game?.engine) || makesApps(game?.facts ?? []);
  });
  const title = useLibrary((s) => s.games.find((g) => g.name === project)?.title) || project;
  const [asked, setAsked] = useState<ReadonlySet<PublishTarget>>(() => new Set());
  if (!shown || !platforms || !listsPlatforms(platforms, engineGame)) return null;
  const reach = reachLine(platforms);
  const listing = listingLine(platforms, native);
  const make = (target: PublishTarget): void => {
    composeInChat({ project, text: makeAppAsk(target, title), send: true });
    setAsked((before) => new Set(before).add(target));
  };
  return (
    <div className="genex-publish-platforms" data-genex-publish-platforms>
      <ul aria-label={WORDS.label}>
        {platformRows(platforms, Date.now(), native).map((row) => (
          <Row key={row.target} row={row} asked={asked.has(row.target)} onMake={make} />
        ))}
      </ul>
      {failureLines(platforms, native).map((line) => (
        <p key={line} className="genex-publish-platform-failure">
          {line}
        </p>
      ))}
      {listing && <p className="genex-publish-platform-failure">{listing}</p>}
      {reach && <p className="genex-publish-reach">{reach}</p>}
    </div>
  );
}

/**
 * The Publish dialog's platforms (canvas board "Publish"): the web, Mac, Windows and Linux rows read from
 * the game folder, each with what its build runs on, when it was built and its size. An app not made
 * yet, and a Unity or Godot game's web version, offers "Make with agent", which sends the ask through
 * the game's chat at once and keeps the dialog open, the row then saying it was asked; an Unreal
 * game's web row says it has none, and its rows for other systems say where they are packaged. A ready app goes with Publish once its web build is
 * public: the line under the rows says so, and its row then says it is being sent, is on Genex, or
 * was not sent (with why, under the rows). While Studio's Genex CLI cannot send apps, a built one
 * says "Coming soon" and its players get the web version. A web game with no app shows none of this.
 */
import type { JSX } from "react";
import { useState } from "react";
import type { GenexNativeRecord } from "../../../../shared/genex.ts";
import { t } from "../../../../shared/i18n.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { hostPlatform } from "../../../platform.ts";
import { useLibrary } from "../../../state/hooks.ts";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { PUBLISH_PLATFORM_WORDS } from "../../../words.ts";
import {
  appsMadeOnly,
  failureLines,
  listingLine,
  listsPlatforms,
  makeAppAsk,
  makesApps,
  makeWebAsk,
  rebuildAsk,
  PlatformEnd,
  type PlatformRow,
  platformRows,
  reachLine,
  webOfferFor,
} from "./publish-platforms-view.ts";

const WORDS = PUBLISH_PLATFORM_WORDS;

/** Each platform's mark. */
const MARK: Readonly<Record<PublishTarget, IconName>> = {
  [PublishTarget.Web]: "globe",
  [PublishTarget.Mac]: "apple",
  [PublishTarget.Windows]: "windows",
  [PublishTarget.Linux]: "linux",
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
  [PlatformEnd.Sending]: { text: WORDS.sending, label: (name) => t("{name}: {state}", { name, state: WORDS.sending }) },
  [PlatformEnd.Sent]: { text: WORDS.sent, label: WORDS.sentLabel },
  [PlatformEnd.Review]: { text: WORDS.review, label: WORDS.reviewLabel },
  [PlatformEnd.Rejected]: {
    text: WORDS.notApproved,
    label: (name) => t("{name}: {state}", { name, state: WORDS.notApproved }),
  },
  [PlatformEnd.Failed]: { text: WORDS.failed, label: (name) => t("{name}: {state}", { name, state: WORDS.failed }) },
};

/** The agent's presses a row may end with: making an app, or building one again. */
const ASK: Partial<Record<PlatformEnd, { text: string; label: (name: string) => string }>> = {
  [PlatformEnd.Make]: { text: WORDS.make, label: WORDS.makeLabel },
  [PlatformEnd.Rebuild]: { text: WORDS.rebuild, label: WORDS.rebuildLabel },
};

/** What a row's press says to a screen reader: the web row's names the web version. */
const askLabel = (row: PlatformRow, label: (name: string) => string): string =>
  row.target === PublishTarget.Web ? WORDS.makeWebLabel : label(row.name);

/** What a row ends with: a note ("Coming soon", "On Genex"…), an ask for the agent, or that the agent was asked. */
function End({
  row,
  asked,
  onMake,
}: {
  row: PlatformRow;
  asked: boolean;
  onMake: (target: PublishTarget, end: PlatformEnd) => void;
}): JSX.Element | null {
  const note = NOTE[row.end];
  if (note)
    return (
      <span className="genex-publish-platform-note" data-end={row.end} role="note" aria-label={note.label(row.name)}>
        {note.text}
      </span>
    );
  const ask = ASK[row.end];
  if (!ask) return null;
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
      aria-label={askLabel(row, ask.label)}
      data-publish-platform-make={row.target}
      data-end={row.end}
      onClick={() => onMake(row.target, row.end)}
    >
      {ask.text}
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
  onMake: (target: PublishTarget, end: PlatformEnd) => void;
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

/** What a row's press sends through the game's chat: a web version, an app, or an app built again. */
function askText(target: PublishTarget, end: PlatformEnd, title: string): string {
  if (target === PublishTarget.Web) return makeWebAsk(title);
  return end === PlatformEnd.Rebuild ? rebuildAsk(target, title) : makeAppAsk(target, title);
}

/**
 * The platform rows and who plays what, or nothing for a web game with no app. Read once while the
 * dialog is open: hidden while it celebrates, they are not read again after.
 */
export function PublishPlatforms({
  project,
  platforms,
  behind = false,
  shown,
  native,
}: {
  project: string;
  /** The game folder's platforms as the Genex plugin can send them (`gateByPlugin`), null until read. */
  platforms: PublishPlatform[] | null;
  /** The installed Genex plugin is from before apps: the line says to update it. */
  behind?: boolean;
  shown: boolean;
  /** How the last Publish's apps went, from the publish record. */
  native?: GenexNativeRecord | undefined;
}): JSX.Element | null {
  const facts = useLibrary((s) => s.games.find((g) => g.name === project)?.facts);
  const engineGame =
    useLibrary((s) => Boolean(s.games.find((g) => g.name === project)?.engine)) || makesApps(facts ?? []);
  const title = useLibrary((s) => s.games.find((g) => g.name === project)?.title) || project;
  const [asked, setAsked] = useState<ReadonlySet<PublishTarget>>(() => new Set());
  if (!shown || !platforms || !listsPlatforms(platforms, engineGame)) return null;
  const webOffer = webOfferFor(facts ?? []);
  const reach = reachLine(platforms, behind, webOffer);
  const listing = listingLine(platforms, native);
  const make = (target: PublishTarget, end: PlatformEnd): void => {
    const text = askText(target, end, title);
    composeInChat({ project, text, send: true });
    setAsked((before) => new Set(before).add(target));
  };
  return (
    <div className="genex-publish-platforms" data-genex-publish-platforms>
      <ul aria-label={WORDS.label}>
        {platformRows(platforms, Date.now(), native, webOffer, appsMadeOnly(facts ?? [], hostPlatform())).map((row) => (
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

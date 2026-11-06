/**
 * The Publish dialog's platforms (canvas board "Publish"): the web, Mac, Windows and Linux rows read from
 * the game folder, each with what its build runs on, when it was built and its size. An app not made
 * yet, and a Unity or Godot game's web version, offers "Make with agent", which sends the ask through
 * the game's chat at once and keeps the dialog open, the row then saying it was asked; an Unreal
 * game's web row says it has none, and its rows for other systems say where they are packaged. A ready app goes with Publish once its web build is
 * public: the line under the rows says so, and its row then says it is being sent, is on Genex, or
 * was not sent (with why, under the rows). While Studio's Genex CLI cannot send apps, a built one
 * says "Coming soon" and its players get the web version. A game with no web build that Genex still
 * plays one of (a page of mockups once sent as an Unreal game's) says so on its web row, with Remove,
 * which takes it off Genex so the page shows the apps. A web game with no app shows none of this.
 * An Unreal game's Windows app on a Mac, which Unreal can't package here, offers "Build on Genex" once
 * the game has a page on Genex: Genex builds it on its own computers, and the row says how that goes.
 */
import type { JSX } from "react";
import { useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { errorMessage } from "../../../../shared/errors.ts";
import type { GenexNativeRecord } from "../../../../shared/genex.ts";
import { t } from "../../../../shared/i18n.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { hostPlatform } from "../../../platform.ts";
import { useLibrary } from "../../../state/hooks.ts";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { Elapsed } from "../../../ui/LoadingState.tsx";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import { PUBLISH_PLATFORM_WORDS } from "../../../words.ts";
import {
  appsMadeHere,
  failureLines,
  listingLine,
  listsPlatforms,
  makeAppAsk,
  makesApps,
  makeWebAsk,
  rebuildAsk,
  replacesAppsPage,
  PlatformEnd,
  type PlatformRow,
  cloudErrors,
  cloudFixAsk,
  platformRows,
  shownRows,
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
  [PlatformEnd.Building]: {
    text: WORDS.building,
    label: (name) => t("{name}: {state}", { name, state: WORDS.building }),
  },
};

/** The presses a row may end with: the agent making an app or building one again, or Genex building one. */
const ASK: Partial<Record<PlatformEnd, { text: string; label: (name: string) => string }>> = {
  [PlatformEnd.Make]: { text: WORDS.make, label: WORDS.makeLabel },
  [PlatformEnd.Rebuild]: { text: WORDS.rebuild, label: WORDS.rebuildLabel },
  [PlatformEnd.CloudBuild]: { text: WORDS.cloudBuild, label: WORDS.cloudBuildLabel },
  [PlatformEnd.CloudRebuild]: { text: WORDS.rebuild, label: WORDS.cloudRetryLabel },
  [PlatformEnd.CloudRetry]: { text: WORDS.cloudRetry, label: WORDS.cloudRetryLabel },
};

/** How long a press of Build on Genex says it asked: past the publish record's slowest read. */
const CLOUD_ASK_HOLD_MS = 12 * SECOND_MS;

/** The notes of work going on now, which shimmer as the chat's current work does. */
const WORKING_ENDS: ReadonlySet<PlatformEnd> = new Set([PlatformEnd.Sending, PlatformEnd.Building]);

/** The presses Genex answers on its own computers, rather than the agent in the game's chat. */
const CLOUD_ENDS: ReadonlySet<PlatformEnd> = new Set([
  PlatformEnd.CloudBuild,
  PlatformEnd.CloudRebuild,
  PlatformEnd.CloudRetry,
]);

/** What a row's press says to a screen reader: the web row's names the web version. */
const askLabel = (row: PlatformRow, label: (name: string) => string): string =>
  row.target === PublishTarget.Web ? WORDS.makeWebLabel : label(row.name);

/** The web row's Remove: takes the web version Genex still plays off it, once the native dialog confirms. */
function RemoveWeb({ onRemove }: { onRemove: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="genex-publish-platform-make"
      aria-label={WORDS.removeWebLabel}
      data-publish-platform-remove-web
      onClick={onRemove}
    >
      {WORDS.removeWeb}
    </button>
  );
}

/** What a row ends with: a note ("Coming soon", "On Genex"…), an ask for the agent, that the agent was asked, or Remove. */
function End({
  row,
  asked,
  onMake,
  onRemoveWeb,
}: {
  row: PlatformRow;
  asked: boolean;
  onMake: (target: PublishTarget, end: PlatformEnd) => void;
  onRemoveWeb: () => void;
}): JSX.Element | null {
  if (row.end === PlatformEnd.RemoveWeb) return <RemoveWeb onRemove={onRemoveWeb} />;
  const note = NOTE[row.end];
  if (note)
    return (
      <span className="genex-publish-platform-note" data-end={row.end} role="note" aria-label={note.label(row.name)}>
        {WORKING_ENDS.has(row.end) ? (
          <span data-shimmer className="chat-status-shimmer">
            {note.text}
          </span>
        ) : (
          note.text
        )}
        {row.since && (
          <span className="genex-publish-platform-clock" data-publish-platform-clock={row.target}>
            <Elapsed since={Date.parse(row.since)} />
          </span>
        )}
      </span>
    );
  const ask = ASK[row.end];
  if (!ask) return null;
  if (asked)
    return (
      <span className="genex-publish-platform-note" role="status" data-publish-platform-asked={row.target}>
        {CLOUD_ENDS.has(row.end) ? WORDS.cloudAsked : WORDS.asked}
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
  onRemoveWeb,
}: {
  row: PlatformRow;
  asked: boolean;
  onMake: (target: PublishTarget, end: PlatformEnd) => void;
  onRemoveWeb: () => void;
}): JSX.Element {
  return (
    <li className="genex-publish-platform" data-publish-platform={row.target} data-state={row.state}>
      <Icon name={MARK[row.target]} size={18} />
      <span className="genex-publish-platform-text">
        <span>{row.name}</span>
        <span className="genex-publish-platform-detail">{row.detail}</span>
      </span>
      {row.size && <span className="genex-publish-platform-size">{row.size}</span>}
      <End row={row} asked={asked} onMake={onMake} onRemoveWeb={onRemoveWeb} />
    </li>
  );
}

/** Whether Genex's answer to a row's press has come: the row says it is sending or building, not what it offered. */
const isAnswered = (row: PlatformRow): boolean => row.end === PlatformEnd.Building || row.end === PlatformEnd.Sending;

/** What a row's press sends through the game's chat: a web version, an app, or an app built again. */
function askText(target: PublishTarget, end: PlatformEnd, title: string): string {
  if (target === PublishTarget.Web) return makeWebAsk(title);
  return end === PlatformEnd.Rebuild ? rebuildAsk(target, title) : makeAppAsk(target, title);
}

/** What went wrong in a build on Genex: the first error, how many more, and the agent to fix them all. */
function CloudErrors({
  project,
  title,
  platforms,
  native,
}: {
  project: string;
  title: string;
  platforms: readonly PublishPlatform[];
  native: GenexNativeRecord | undefined;
}): JSX.Element | null {
  /** The errors last handed to the agent: new ones offer it again. */
  const [askedFix, setAskedFix] = useState<string | null>(null);
  const fix = cloudErrors(platforms, native);
  if (!fix) return null;
  const key = fix.errors.join("\n");
  const askFix = (): void => {
    composeInChat({ project, text: cloudFixAsk(fix, title), send: true });
    setAskedFix(key);
  };
  return (
    <div className="genex-publish-cloud-errors" data-publish-cloud-errors>
      <div className="genex-publish-cloud-words">
        <p className="genex-publish-platform-failure">
          {fix.errors[0]}
          {fix.errors.length > 1 && ` ${WORDS.cloudMoreErrors(fix.errors.length - 1)}`}
        </p>
        <p className="genex-publish-reach">{WORDS.cloudChangeFirst}</p>
      </div>
      {askedFix === key ? (
        <span className="genex-publish-platform-note" role="status">
          {WORDS.asked}
        </span>
      ) : (
        <button
          type="button"
          className="genex-publish-platform-make"
          aria-label={WORDS.cloudFixLabel}
          data-publish-cloud-fix
          onClick={askFix}
        >
          {WORDS.cloudFix}
          <Icon name="chevron-right" size={12} />
        </button>
      )}
    </div>
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
  onGenex = false,
  hostedWeb,
  onRemoveWeb,
  reviewed = false,
}: {
  project: string;
  /** The game folder's platforms as the Genex plugin can send them (`gateByPlugin`), null until read. */
  platforms: PublishPlatform[] | null;
  shown: boolean;
  /** How the last Publish's apps went, from the publish record. */
  native?: GenexNativeRecord | undefined;
  /** The game has a page on Genex, which an app Genex builds goes on. */
  onGenex?: boolean;
  /** Whether Genex's page for the game plays a web version, from the publish record (`hostedWeb`); absent while unknown. */
  hostedWeb?: boolean | undefined;
  /** The web row's Remove: the Genex plugin's `publish-remove-web`. */
  onRemoveWeb: () => void;
  /** Genex's review card or check says how the apps stand: no line under the rows says it again. */
  reviewed?: boolean;
}): JSX.Element | null {
  const facts = useLibrary((s) => s.games.find((g) => g.name === project)?.facts);
  const engineGame =
    useLibrary((s) => Boolean(s.games.find((g) => g.name === project)?.engine)) || makesApps(facts ?? []);
  const title = useLibrary((s) => s.games.find((g) => g.name === project)?.title) || project;
  const [asked, setAsked] = useState<ReadonlySet<PublishTarget>>(() => new Set());
  /** The rows whose app was asked of Genex, by how many builds of it Genex had then: a new one answers. */
  const [cloudAsked, setCloudAsked] = useState<ReadonlyMap<PublishTarget, number>>(() => new Map());
  const [refused, setRefused] = useState<string | null>(null);
  if (!shown || !platforms || !listsPlatforms(platforms, engineGame)) return null;
  const webOffer = webOfferFor(facts ?? []);
  const reach = reachLine(platforms, webOffer, hostedWeb === true);
  const replaces = replacesAppsPage(platforms, native, hostedWeb);
  const listing = reviewed ? null : listingLine(platforms, native);
  const rows = platformRows(
    platforms,
    Date.now(),
    native,
    webOffer,
    appsMadeHere(facts ?? [], hostPlatform()),
    onGenex,
    hostedWeb === true,
  );
  const builds = (target: PublishTarget): number =>
    native?.cloud?.builds.filter((build) => build.platform === target).length ?? 0;
  const askedOf = (target: PublishTarget): boolean => asked.has(target) || cloudAsked.get(target) === builds(target);
  const make = (target: PublishTarget, end: PlatformEnd): void => {
    if (!CLOUD_ENDS.has(end)) {
      composeInChat({ project, text: askText(target, end, title), send: true });
      setAsked((before) => new Set(before).add(target));
      return;
    }
    setRefused(null);
    setCloudAsked((before) => new Map(before).set(target, builds(target)));
    const name = rows.find((row) => row.target === target)?.name ?? "";
    const forget = (): void => setCloudAsked((before) => new Map([...before].filter(([one]) => one !== target)));
    // The row reads Genex's answer from the publish record as it comes; a refusal is said under the rows.
    // The press lets go once the record has had time to say so: Genex may answer with the build it
    // already has, and then no new build ever ends the note.
    void window.studio
      .genexCloudBuild(project, target)
      .then(() => window.setTimeout(forget, CLOUD_ASK_HOLD_MS))
      .catch((error: unknown) => {
        setRefused(WORDS.cloudRefused(name, errorMessage(error)));
        forget();
      });
  };
  return (
    <div className="genex-publish-platforms" data-genex-publish-platforms>
      <ul aria-label={WORDS.label}>
        {shownRows(rows).map((row) => (
          <Row
            key={row.target}
            row={row}
            asked={askedOf(row.target) && !isAnswered(row)}
            onMake={make}
            onRemoveWeb={onRemoveWeb}
          />
        ))}
      </ul>
      <CloudErrors project={project} title={title} platforms={platforms} native={native} />
      {failureLines(platforms, native, reviewed).map((line) => (
        <p key={line} className="genex-publish-platform-failure">
          {line}
        </p>
      ))}
      {listing && <p className="genex-publish-platform-failure">{listing}</p>}
      {refused && <p className="genex-publish-platform-failure">{refused}</p>}
      {reach && <p className="genex-publish-reach">{reach}</p>}
      {replaces && (
        <p className="genex-publish-reach" data-publish-replaces-apps>
          {WORDS.replacesApps}
        </p>
      )}
    </div>
  );
}

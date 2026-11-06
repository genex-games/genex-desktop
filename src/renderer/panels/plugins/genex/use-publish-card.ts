/**
 * The Publish card's state and its one press, for a game made in an engine. The rows wait for both
 * the game folder and Genex's record; the switches are the person's until the press; a press does
 * what its plan says: the agent builds apps (and nothing else), or the card sends what is ready,
 * has Genex Cloud build, and takes switched-off platforms down. Genex Cloud needs the game's page on
 * Genex: a first publish asks for its builds once the page is there.
 */
import { useEffect, useState } from "react";
import { GenexAction, type GenexNativeRecord } from "../../../../shared/genex.ts";
import type { FactRef } from "../../../../shared/project-facts.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { hostPlatform } from "../../../platform.ts";
import { useLibrary } from "../../../state/hooks.ts";
import { type CardRow, CardWork, cardRows, type PressPlan, busyPress, pressPlan } from "./publish-card-view.ts";
import {
  appsMadeHere,
  type CloudBuildErrors,
  cloudErrors,
  cloudFixAsk,
  makeAppAsk,
  makeWebAsk,
  rebuildAsk,
  webOfferFor,
} from "./publish-platforms-view.ts";
import type { usePublishRecord } from "./use-publish-record.ts";

type PublishRecord = ReturnType<typeof usePublishRecord>;

/**
 * The apps the agent was asked to build from a game's card, by when, for this run of the app: the
 * card says so again when it opens while the agent still builds.
 */
const ASKED = new Map<string, ReadonlyMap<PublishTarget, string>>();

const NO_FACTS: readonly FactRef[] = [];

/** What a Build step sends the agent: make the app (or the web version), or build it again. */
function buildAsk(row: CardRow | undefined, target: PublishTarget, title: string): string {
  if (target === PublishTarget.Web) return makeWebAsk(title);
  return row?.live ? rebuildAsk(target, title) : makeAppAsk(target, title);
}

/** The targets of a plan's steps of one kind. */
const targetsOf = (plan: PressPlan, work: CardWork): PublishTarget[] =>
  plan.steps.filter((step) => step.work === work).map((step) => step.target);

/** A failed Genex Cloud build's errors, and Fix with agent, which hands them over once: new errors offer it again. */
function useCloudFix(
  project: string,
  title: string,
  platforms: PublishPlatform[] | null,
  native: GenexNativeRecord | undefined,
): { fix: CloudBuildErrors | null; onFix: (() => void) | undefined } {
  const [asked, setAsked] = useState<string | null>(null);
  const fix = platforms ? cloudErrors(platforms, native) : null;
  const key = fix?.errors.join("\n") ?? null;
  if (!fix || key === asked) return { fix, onFix: undefined };
  return {
    fix,
    onFix: () => {
      composeInChat({ project, text: cloudFixAsk(fix, title), send: true });
      setAsked(key);
    },
  };
}

/** What the card shows and does for `project`, from its record and the folder's platforms (null until read). */
export function usePublishCard({
  project,
  record,
  platforms,
  name,
  remix,
  replacesApps,
}: {
  project: string;
  record: PublishRecord;
  platforms: PublishPlatform[] | null;
  /** The game's name as the banner has it: what the publish lists it under. */
  name: string;
  /** Allow remixing: whether the publish sends the game's project. */
  remix: boolean;
  /** The card said this web build takes the place of a page that shows only the game's apps. */
  replacesApps: boolean;
}) {
  const facts = useLibrary((s) => s.games.find((g) => g.name === project)?.facts) ?? NO_FACTS;
  const title = useLibrary((s) => s.games.find((g) => g.name === project)?.title) || project;
  const [switches, setSwitches] = useState<ReadonlyMap<PublishTarget, boolean>>(() => new Map());
  const [asked, setAsked] = useState<ReadonlyMap<PublishTarget, string>>(() => ASKED.get(project) ?? new Map());
  const [waitingCloud, setWaitingCloud] = useState<readonly PublishTarget[]>([]);
  const [acting, setActing] = useState(false);
  const state = record.state;
  const onGenex = Boolean(state?.slug);
  const rows =
    platforms && state
      ? cardRows({
          platforms,
          native: state.native,
          now: Date.now(),
          webOffer: webOfferFor(facts),
          madeHere: appsMadeHere(facts, hostPlatform()),
          hostedWeb: state.hostedWeb,
          webPublishedAt: state.lastPublishAt,
          asked,
          mac: hostPlatform() === "darwin",
        })
      : null;
  // A first publish made the game's page: the Genex Cloud builds its press chose start now.
  useEffect(() => {
    if (!onGenex || waitingCloud.length === 0) return;
    setWaitingCloud([]);
    for (const target of waitingCloud) void window.studio.genexCloudBuild(project, target).catch(() => {});
  }, [onGenex, waitingCloud, project]);
  const remember = (targets: readonly PublishTarget[]): void => {
    const at = new Date().toISOString();
    const next = new Map(asked);
    for (const target of targets) next.set(target, at);
    ASKED.set(project, next);
    setAsked(next);
  };
  const ask = (targets: readonly PublishTarget[]): void => {
    if (targets.length === 0) return;
    const text = targets.map((target) =>
      buildAsk(
        rows?.find((row) => row.target === target),
        target,
        title,
      ),
    );
    composeInChat({ project, text: text.join("\n\n"), send: true });
    remember(targets);
  };
  const takeDown = async (targets: readonly PublishTarget[]): Promise<void> => {
    for (const target of targets)
      await (target === PublishTarget.Web
        ? record.act(GenexAction.PublishRemoveWeb)
        : record.act(GenexAction.PublishRemoveApp, { platform: target }));
  };
  const send = async (plan: PressPlan): Promise<void> => {
    const published = targetsOf(plan, CardWork.Publish);
    const apps = published.filter((target) => target !== PublishTarget.Web);
    if (published.includes(PublishTarget.Web)) await record.publish(name, remix, replacesApps, apps);
    else if (apps.length > 0) await record.publishApps(name, remix, apps);
    const cloud = targetsOf(plan, CardWork.Cloud);
    if (onGenex) for (const target of cloud) await window.studio.genexCloudBuild(project, target).catch(() => {});
    else setWaitingCloud(cloud);
  };
  const press = async (plan: PressPlan): Promise<void> => {
    setActing(true);
    try {
      ask(targetsOf(plan, CardWork.Build));
      await takeDown(targetsOf(plan, CardWork.TakeDown));
      await send(plan);
      setSwitches(new Map());
    } finally {
      setActing(false);
      await record.refresh();
    }
  };
  const { fix, onFix } = useCloudFix(project, title, platforms, state?.native);
  return {
    /** A failed Genex Cloud build's errors, and the press that hands them to the agent until it was handed them. */
    fix,
    onFix,
    rows,
    switches,
    onSwitch: (target: PublishTarget, on: boolean) => setSwitches((before) => new Map(before).set(target, on)),
    plan: rows ? pressPlan(rows, switches, onGenex) : null,
    busy: rows ? busyPress(rows) : null,
    /** The agent is building an app here: the folder is read again until it lands. */
    building: rows?.some((row) => row.here) ?? false,
    press,
    acting,
  };
}

/**
 * The Publish card's state and its presses, for a game made in an engine. The rows wait for both the
 * game folder and Genex's record. A row's own button does one thing: Build asks the agent for the app
 * here, or Genex Cloud for the one this computer can't make, and gives players nothing (Genex Cloud
 * keeps what it builds); Publish and Update send what is ready; the menu of a platform players have
 * takes it down. The big button does all of it: it builds what isn't built, sends what is ready, and
 * hands the rest to the follow (`publish-follow.ts`), which gives players each platform as soon as it
 * is ready, whether this dialog stays open or not.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { GenexAction, type GenexNativeRecord } from "../../../../shared/genex.ts";
import type { FactRef } from "../../../../shared/project-facts.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { hostPlatform } from "../../../platform.ts";
import { useLibrary } from "../../../state/hooks.ts";
import {
  type CardError,
  CardErrorKind,
  type CardRow,
  CardWork,
  cardErrors,
  followBar,
  type PlanStep,
  type PressPlan,
  pressPlan,
  recordRows,
  sendCalls,
} from "./publish-card-view.ts";
import { publishFollow } from "./publish-follow.ts";
import {
  appsMadeHere,
  cloudFixAsk,
  makeAppAsk,
  makeWebAsk,
  rebuildAsk,
  webOfferFor,
} from "./publish-platforms-view.ts";
import type { usePublishRecord } from "./use-publish-record.ts";

type PublishRecord = ReturnType<typeof usePublishRecord>;

/** The press being carried out now: a row's own (its platform), or the big button's. */
export const ALL_PLATFORMS = "all";
export type CardPress = PublishTarget | typeof ALL_PLATFORMS;

const NO_FACTS: readonly FactRef[] = [];

/** What a Build step sends the agent: make the app (or the web version), or build it again. */
function buildAsk(row: CardRow | undefined, target: PublishTarget, title: string): string {
  if (target === PublishTarget.Web) return makeWebAsk(title);
  return row?.live ? rebuildAsk(target, title) : makeAppAsk(target, title);
}

/** The targets of the steps of one kind. */
const targetsOf = (steps: readonly PlanStep[], work: CardWork): PublishTarget[] =>
  steps.filter((step) => step.work === work).map((step) => step.target);

/** The steps that give players something. */
const sendsOf = (steps: readonly PlanStep[]): PlanStep[] =>
  steps.filter((step) => step.work === CardWork.Publish || step.work === CardWork.Release);

/** One error block as the card draws it: what failed, when the agent was handed it, and its press. */
export interface ErrorBlock extends CardError {
  /** When the agent was handed this error from the card; null before. */
  sentAt: string | null;
  /** A failed build: hand its log to the agent. */
  onSend?: () => void;
}

/**
 * The card's error blocks: Send to agent for a failed Genex Cloud build (the block then says the agent
 * is fixing it, until the error changes). A build that didn't start and an app that didn't reach Genex
 * are tried again from their row.
 */
function useErrorBlocks(
  project: string,
  title: string,
  platforms: PublishPlatform[] | null,
  native: GenexNativeRecord | undefined,
): ErrorBlock[] {
  const [sent, setSent] = useState<ReadonlyMap<string, string>>(() => new Map());
  const errors = platforms ? cardErrors(platforms, native) : [];
  return errors.map((error) => {
    const key = `${error.target}\n${error.kind}\n${error.text}`;
    const block: ErrorBlock = { ...error, sentAt: sent.get(key) ?? null };
    if (error.kind !== CardErrorKind.Build) return block;
    const onSend = (): void => {
      composeInChat({
        project,
        text: cloudFixAsk({ target: error.target, errors: error.text.split("\n") }, title),
        send: true,
      });
      setSent((before) => new Map(before).set(key, new Date().toISOString()));
    };
    return { ...block, onSend };
  });
}

/**
 * What the app keeps for `project` outside this dialog: the builds the card asked the agent for, the
 * big button's press under way, and why its last send was refused.
 */
function useFollowed(project: string) {
  const asked = useSyncExternalStore(publishFollow.subscribe, () => publishFollow.asked(project));
  const following = useSyncExternalStore(publishFollow.subscribe, () => publishFollow.following(project));
  const error = useSyncExternalStore(publishFollow.subscribe, () => publishFollow.error(project));
  return { asked, following, error };
}

/**
 * Keep the dialog and the follow in step: the record is read again each time the follow gives players
 * something, and the follow looks again when the rows change, so a build that lands while the dialog
 * is open goes at once.
 */
function useFollowInStep(project: string, record: PublishRecord, rows: readonly CardRow[] | null, sends: number) {
  const { refresh } = record;
  useEffect(() => {
    if (sends > 0) void refresh();
  }, [refresh, sends]);
  const seen = rows?.map((row) => `${row.target}:${row.tone}:${row.work}`).join() ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows that changed are the reason to look again.
  useEffect(() => {
    void publishFollow.tick(project);
  }, [project, seen]);
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
  const [acting, setActing] = useState<CardPress | null>(null);
  const state = record.state;
  const here = {
    webOffer: webOfferFor(facts),
    madeHere: appsMadeHere(facts, hostPlatform()),
    mac: hostPlatform() === "darwin",
  };
  const follow = useFollowed(project);
  const rows =
    platforms && state ? recordRows(platforms, state, { ...here, now: Date.now(), asked: follow.asked }) : null;
  useFollowInStep(project, record, rows, follow.following?.sends ?? 0);
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
    publishFollow.remember(project, targets);
  };
  /**
   * Genex Cloud builds each app and keeps it. A build Genex refuses before anything goes is the record's
   * error line; one whose project didn't arrive is the record's too, shown in its block.
   */
  const buildOnCloud = async (targets: readonly PublishTarget[]): Promise<void> => {
    for (const target of targets) await record.buildOnCloud(target);
  };
  /** Give players what `steps` name: the web publish with the apps behind it, then what goes on its own. */
  const send = async (steps: readonly PlanStep[]): Promise<void> => {
    const calls = sendCalls(steps);
    if (calls.web) await record.publish(name, remix, replacesApps, calls.web);
    if (calls.apps) await record.publishApps(name, remix, calls.apps.platforms, calls.apps.release);
  };
  /** Do `steps` now: the builds first (they only start), then the sends. */
  const run = async (by: CardPress, steps: readonly PlanStep[], after?: () => void): Promise<void> => {
    setActing(by);
    try {
      ask(targetsOf(steps, CardWork.Build));
      await buildOnCloud(targetsOf(steps, CardWork.Cloud));
      await send(sendsOf(steps));
      after?.();
    } finally {
      setActing(null);
      await record.refresh();
    }
  };
  const press = (plan: PressPlan): Promise<void> =>
    run(ALL_PLATFORMS, plan.steps, () =>
      publishFollow.start({
        project,
        targets: plan.follow,
        sent: sendsOf(plan.steps).map((step) => step.target),
        update: plan.update,
        name,
        remix,
        replacesApps,
        card: here,
      }),
    );
  const takeDown = (target: PublishTarget): Promise<void> =>
    target === PublishTarget.Web
      ? record.act(GenexAction.PublishRemoveWeb)
      : record.act(GenexAction.PublishRemoveApp, { platform: target });
  return {
    /** The error blocks under the rows: a failed build's goes to the agent. */
    errors: useErrorBlocks(project, title, platforms, state?.native),
    rows,
    /** The big button: what it does and says; null while its press is followed, and when nothing needs doing. */
    plan: rows && !follow.following ? pressPlan(rows) : null,
    /** The status in the big button's place while its press is followed. */
    bar: rows && follow.following ? followBar(rows, follow.following.update) : null,
    /** Why the follow's last send was refused; empty when none was. */
    followError: follow.error,
    /** The agent is building an app here: the folder is read again until it lands. */
    building: rows?.some((row) => row.here) ?? false,
    press,
    /** A row's own button: its one step. */
    act: (row: CardRow): Promise<void> =>
      row.act ? run(row.target, [{ target: row.target, work: row.act.work }]) : Promise.resolve(),
    takeDown,
    /** The press being carried out now, or null: no other is taken meanwhile. */
    acting,
  };
}

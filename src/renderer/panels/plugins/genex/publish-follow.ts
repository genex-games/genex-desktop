/**
 * What the Publish card keeps for this run of the app, outside its dialog: the apps it asked the
 * agent to build, by when (a row says so again when the dialog opens while the agent still builds),
 * and the big button's presses that are still under way. Such a press is followed here: the game's
 * folder and its record are read again every few seconds, and each platform the press named goes to
 * players as soon as it is ready (`followStep`), whether the dialog is open or not. A platform is
 * sent once; when nothing more comes by itself the follow ends.
 */
import { HOUR_MS, SECOND_MS } from "../../../../shared/duration.ts";
import { GENEX_PLUGIN_ID, type GenexPublishState } from "../../../../shared/genex.ts";
import type { ExportReview } from "../../../../shared/plugins.ts";
import type { PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import {
  type CardContext,
  type CardRow,
  followStep,
  type PlanStep,
  recordRows,
  sendCalls,
} from "./publish-card-view.ts";
import { gateByPlugin } from "./publish-platforms-view.ts";
import { readPublishState } from "./use-publish-record.ts";

/** How often a followed press reads the game's folder and record again. */
const FOLLOW_EVERY_MS = 4 * SECOND_MS;
/** How long after a send its row may still say "ready": the record takes a moment to say it is on its way. */
const SEND_SETTLES_MS = 20 * SECOND_MS;
/** A follow older than this ends: no build takes this long, so nothing more is coming. */
const FOLLOW_MAX_MS = 6 * HOUR_MS;

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A big-button press to follow: the platforms it named, and what its publishes are made with. */
export interface FollowRequest {
  project: string;
  targets: readonly PublishTarget[];
  /** The platforms the press sent itself: each goes once, so the follow never sends them again. */
  sent: readonly PublishTarget[];
  /** Players had every platform it named: the status says "Updating". */
  update: boolean;
  /** The name the publishes list the game under, Allow remixing, and the web build taking the apps' page, as pressed. */
  name: string;
  remix: boolean;
  replacesApps: boolean;
  /** What the rows are read with (`CardContext`), as the card had it. */
  card: Pick<CardContext, "webOffer" | "madeHere" | "mac">;
}

/** A followed press as the card shows it. */
export interface Following {
  /** The platforms still on their way. */
  targets: readonly PublishTarget[];
  update: boolean;
  /** How many times the follow gave players something: the dialog reads its record again when it changes. */
  sends: number;
}

/** What a follow reads and does: Studio's calls, and the clock. */
export interface FollowHost {
  platforms(project: string): Promise<PublishPlatform[]>;
  state(project: string): Promise<GenexPublishState>;
  files(project: string): Promise<ExportReview>;
  publish(project: string, files: ExportReview, request: FollowRequest, apps: PublishTarget[]): Promise<void>;
  publishApps(
    project: string,
    request: FollowRequest,
    platforms: PublishTarget[],
    release: PublishTarget[],
  ): Promise<void>;
  now(): number;
  /** Call `tick` every `ms` until the returned function is called. */
  every(ms: number, tick: () => void): () => void;
}

interface Follow {
  request: FollowRequest;
  startedAt: number;
  targets: readonly PublishTarget[];
  /** When each platform was sent, by the press or the follow. */
  sentAt: Map<PublishTarget, number>;
  sends: number;
  /** A read or a send is under way: the next tick waits for it. */
  reading: boolean;
  view: Following;
}

const NOT_ASKED: ReadonlyMap<PublishTarget, string> = new Map();

/** The Publish card's follow-through over `host`: the app has one (`publishFollow`), a test its own. */
export function createPublishFollow(host: FollowHost) {
  const follows = new Map<string, Follow>();
  const asked = new Map<string, ReadonlyMap<PublishTarget, string>>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const rowsOf = async (follow: Follow): Promise<CardRow[]> => {
    const { project, card } = follow.request;
    const [platforms, state] = await Promise.all([host.platforms(project), host.state(project)]);
    const context = { ...card, now: host.now(), asked: asked.get(project) ?? NOT_ASKED };
    return recordRows(gateByPlugin(platforms, state.native), state, context);
  };

  /** Give players what `steps` name; a refusal is kept for the card and the platforms leave the follow. */
  const send = async (follow: Follow, steps: readonly PlanStep[]): Promise<void> => {
    const { request } = follow;
    for (const step of steps) follow.sentAt.set(step.target, host.now());
    follow.sends += 1;
    try {
      const calls = sendCalls(steps);
      if (calls.web) await host.publish(request.project, await host.files(request.project), request, calls.web);
      if (calls.apps) await host.publishApps(request.project, request, calls.apps.platforms, calls.apps.release);
    } catch (e) {
      errors.set(request.project, words(e));
      const refused = new Set(steps.map((step) => step.target));
      follow.targets = follow.targets.filter((target) => !refused.has(target));
    }
  };

  const end = (project: string): void => {
    follows.delete(project);
    if (follows.size === 0 && stop) {
      stop();
      stop = null;
    }
  };

  /** One look at a followed game: send what is ready, keep what is still coming, end when nothing is. */
  const look = async (follow: Follow): Promise<void> => {
    const now = host.now();
    const rows = await rowsOf(follow);
    const settling = new Set(
      [...follow.sentAt].filter(([, at]) => now - at < SEND_SETTLES_MS).map(([target]) => target),
    );
    const step = followStep(rows, follow.targets, settling);
    // A platform goes once: one that is ready again after it was sent didn't take, and is left to its row.
    const again = new Set(step.send.filter((one) => follow.sentAt.has(one.target)).map((one) => one.target));
    follow.targets = step.left.filter((target) => !again.has(target));
    const fresh = step.send.filter((one) => !again.has(one.target));
    if (fresh.length > 0) await send(follow, fresh);
  };

  /** Look at `project`'s followed press now; nothing when it has none, or a look is under way. */
  const tick = async (project: string): Promise<void> => {
    const follow = follows.get(project);
    if (!follow || follow.reading) return;
    follow.reading = true;
    try {
      await look(follow);
    } catch {
      // The folder or the record couldn't be read: the next tick reads them again.
    } finally {
      follow.reading = false;
    }
    const over = follow.targets.length === 0 || host.now() - follow.startedAt > FOLLOW_MAX_MS;
    const same = follow.view.sends === follow.sends && follow.view.targets.join() === follow.targets.join();
    if (!over && same) return;
    if (over) end(project);
    else follow.view = { targets: follow.targets, update: follow.request.update, sends: follow.sends };
    changed();
  };

  return {
    /** Follow a press until each platform it named is live or nothing more comes; it takes the place of an older one. */
    start(request: FollowRequest): void {
      const now = host.now();
      errors.delete(request.project);
      follows.set(request.project, {
        request,
        startedAt: now,
        targets: request.targets,
        sentAt: new Map(request.sent.map((target) => [target, now])),
        sends: 0,
        reading: false,
        view: { targets: request.targets, update: request.update, sends: 0 },
      });
      stop ??= host.every(FOLLOW_EVERY_MS, () => {
        for (const project of follows.keys()) void tick(project);
      });
      changed();
    },
    tick,
    /** The press under way for `project`, or null; the same object until it changes. */
    following: (project: string): Following | null => follows.get(project)?.view ?? null,
    /** Why the follow's last send for `project` was refused; empty when none was. */
    error: (project: string): string => errors.get(project) ?? "",
    /** The apps the agent was asked to build for `project` from its card, by when. */
    asked: (project: string): ReadonlyMap<PublishTarget, string> => asked.get(project) ?? NOT_ASKED,
    /** The card asked the agent for `targets` now. */
    remember(project: string, targets: readonly PublishTarget[]): void {
      const at = new Date(host.now()).toISOString();
      const next = new Map(asked.get(project) ?? NOT_ASKED);
      for (const target of targets) next.set(target, at);
      asked.set(project, next);
      changed();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Studio's own calls, for the app's follow. */
const STUDIO_HOST: FollowHost = {
  platforms: (project) => window.studio.genexPublishPlatforms(project),
  state: (project) => readPublishState(GENEX_PLUGIN_ID, project),
  files: (project) => window.studio.genexPublishReview(project),
  publish: (project, files, request, apps) =>
    window.studio.genexPublish(project, files, request.name, request.remix, request.replacesApps, apps),
  publishApps: (project, request, platforms, release) =>
    window.studio.genexPublishApps(project, request.name, request.remix, platforms, release),
  now: () => Date.now(),
  every: (ms, tick) => {
    const timer = window.setInterval(tick, ms);
    return () => window.clearInterval(timer);
  },
};

/** The app's follow-through of the Publish card: it lives as long as the app runs. */
export const publishFollow = createPublishFollow(STUDIO_HOST);

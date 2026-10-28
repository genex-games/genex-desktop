/**
 * Every product event the app sends, by wire name, and what each one carries. Each part of the app
 * keeps its own in `events/<area>.ts`; a name is written as `AnalyticsEvent.MessageSent`, never as
 * a string, and `track` takes only the properties declared for it.
 */
import { BuildsEvent, type BuildsEventProperties } from "./events/builds.ts";
import { ChatEvent, type ChatEventProperties } from "./events/chat.ts";
import { CoreEvent, type CoreEventProperties } from "./events/core.ts";
import { LaunchEvent, type LaunchEventProperties } from "./events/launch.ts";
import { PluginsEvent, type PluginsEventProperties } from "./events/plugins.ts";
import { WelcomeEvent, type WelcomeEventProperties } from "./events/welcome.ts";
import { WorkspaceEvent, type WorkspaceEventProperties } from "./events/workspace.ts";

export const AnalyticsEvent = {
  ...CoreEvent,
  ...LaunchEvent,
  ...WelcomeEvent,
  ...WorkspaceEvent,
  ...ChatEvent,
  ...BuildsEvent,
  ...PluginsEvent,
} as const;
export type AnalyticsEvent = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/** What each event carries. An event missing here fails `track`'s type. */
export type AnalyticsEventProperties = CoreEventProperties &
  LaunchEventProperties &
  WelcomeEventProperties &
  WorkspaceEventProperties &
  ChatEventProperties &
  BuildsEventProperties &
  PluginsEventProperties;

/** Sent with every event: what the app is and where it stands, never who uses it. */
export type SuperProperties = {
  app_version: string;
  os: string;
  arch: string;
  /** The app's resolved language. */
  locale: string;
  /** A random id for this launch, in memory only: events of one launch group together. */
  launch_id: string;
  /** The welcome was up when this launch started. */
  first_launch: boolean;
  /** The engines ready to answer, sorted EngineId values. */
  engines_ready: readonly string[];
  engines_ready_count: number;
  any_model_ready: boolean;
  /** A Genex account is signed in (never which). */
  genex_signed_in: boolean;
  /** This install is recording a replay of its first week. */
  replay: boolean;
};

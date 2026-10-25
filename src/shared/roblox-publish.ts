/**
 * Publishing a Roblox game from Studio's Publish button: the Roblox plugin's actions the publishing
 * card sends, and what its `publish-status` answers. The press hands the publish to the game's chat,
 * whose agent clicks File › Publish to Roblox in Roblox Studio; the card follows the attempt until
 * the agent says it is published or stopped, or Genex sees the place on Roblox.
 */

/** The Roblox plugin's actions the publishing card sends. Wire values: never rename one. */
export const RobloxPublishAction = {
  /** A place never on Roblox, published as a new game under `name`. */
  FirstPublish: "first-publish",
  /** A published place, updated. */
  PublishUpdate: "publish-update",
  /** Where the game's place and its latest publish stand: {@link RobloxPublishState}. */
  PublishStatus: "publish-status",
} as const;
export type RobloxPublishAction = (typeof RobloxPublishAction)[keyof typeof RobloxPublishAction];

/** Where a publish stands. Wire values: never rename one. */
export const RobloxPublishPhase = {
  /** Handed to the game's chat; its agent is clicking it in Studio. */
  Publishing: "publishing",
  Published: "published",
  /** The agent stopped (Roblox asked the person something) or never said. */
  Stopped: "stopped",
} as const;
export type RobloxPublishPhase = (typeof RobloxPublishPhase)[keyof typeof RobloxPublishPhase];

/** Which publish an attempt is. Wire values: never rename one. */
export const RobloxPublishKind = {
  First: "first",
  Update: "update",
} as const;
export type RobloxPublishKind = (typeof RobloxPublishKind)[keyof typeof RobloxPublishKind];

/** The game's latest publish: when it was handed over, which one, and how it ended. */
export interface RobloxPublishAttempt {
  phase: RobloxPublishPhase;
  kind: RobloxPublishKind;
  /** When it was handed to the chat, in ms since the epoch. */
  at: number;
  /** A first publish's name on Roblox. */
  name?: string;
  /** The agent's words when it stopped, or published with something to add. */
  detail?: string;
}

/** What `publish-status` answers for the game a call is bound to. */
export interface RobloxPublishState {
  /** The game builds in a Roblox place. */
  linked: boolean;
  /** Roblox has the place: a publish updates it. */
  published: boolean;
  /** Genex can click in Studio here; elsewhere the person publishes in Studio themselves. */
  canClick: boolean;
  /** The name a first publish uses unless the person types another. */
  name?: string;
  /** The published place's id, for its page on Roblox. */
  placeId?: string;
  attempt?: RobloxPublishAttempt;
}

/** What a publish press answers: handed to the chat, or why not. */
export interface RobloxPublishAnswer {
  started: boolean;
  message: string;
  /** Studio's own clicks, where Genex can't click them. */
  clickPath?: string;
}

const PLACE_ID = /^\d{1,20}$/;

/** A published place's page on Roblox; undefined for anything but a place id. */
export function robloxGameUrl(placeId: string | undefined): string | undefined {
  return placeId && PLACE_ID.test(placeId) ? `https://www.roblox.com/games/${placeId}` : undefined;
}

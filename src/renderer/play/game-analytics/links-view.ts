/**
 * What the Campaign links tab shows, decided without React: the tags a draft of the form makes and
 * the link they give, whether it can be saved, the sources already used, the rows of the saved
 * links' table and the rules a visit is credited by. Days are UTC days, as genex.games counts them.
 */
import {
  CAMPAIGN_LINKS_MAX,
  CAMPAIGN_TAG_MAX,
  CampaignField,
  type CampaignLink,
  type CampaignTags,
  campaignTag,
  campaignUrl,
  INSTALL_CREDIT_DAYS,
} from "../../../shared/game-analytics.ts";
import { withoutBidiControls } from "../../../shared/play-purchase.ts";
import { formatDay, share } from "./kit/index.ts";
import { LINKS_WORDS } from "./links-words.ts";
import { savedPastLimit } from "./report-props.ts";

/** The tags the form asks for, in its order. A term is left to links tagged elsewhere. */
export const LINK_FIELDS = [
  CampaignField.Source,
  CampaignField.Medium,
  CampaignField.Campaign,
  CampaignField.Content,
] as const;
export type LinkField = (typeof LINK_FIELDS)[number];

/** What is typed in the form, as it was typed. */
export type LinkDraft = Record<LinkField, string>;

/** The form before anything is typed. */
export const EMPTY_DRAFT: LinkDraft = {
  [CampaignField.Source]: "",
  [CampaignField.Medium]: "",
  [CampaignField.Campaign]: "",
  [CampaignField.Content]: "",
};

/** Where the form stands: what it offers in place of, or as, Save. */
export const SaveStep = {
  /** A tag a link needs is missing, or one is too long. */
  Incomplete: "incomplete",
  Ready: "ready",
  /** A saved link already has exactly these tags. */
  Saved: "saved",
  /** The game keeps no more links. */
  Full: "full",
} as const;
export type SaveStep = (typeof SaveStep)[keyof typeof SaveStep];

/** What a press on Save is doing. */
export const SavePhase = {
  Idle: "idle",
  Saving: "saving",
  /** genex.games refused the save; the form stands as it was typed. */
  Refused: "refused",
  /** genex.games refused the save because the game keeps no more links: trying again cannot work. */
  Full: "full",
} as const;
export type SavePhase = (typeof SavePhase)[keyof typeof SavePhase];

/** Where a saved link's removal stands: asked about, or being carried out. */
export const RemovalStep = { Asking: "asking", Removing: "removing" } as const;
export type RemovalStep = (typeof RemovalStep)[keyof typeof RemovalStep];

/** The one saved link being removed: which, how far, and whether the last try was refused. */
export interface Removal {
  id: string;
  step: RemovalStep;
  failed: boolean;
}

/** The save phase once the person types again: a refusal was about words they have just changed. */
export const phaseAfterTyping = (phase: SavePhase): SavePhase =>
  phase === SavePhase.Refused || phase === SavePhase.Full ? SavePhase.Idle : phase;

/** The save phase genex.games' refusal leaves: a full list says so, anything else may work if tried again. */
export const phaseAfterRefusal = (error: unknown): SavePhase =>
  savedPastLimit(error) ? SavePhase.Full : SavePhase.Refused;

/** The save phase once a saved link was removed: a full list has room again. */
export const phaseAfterRemoval = (phase: SavePhase): SavePhase => (phase === SavePhase.Full ? SavePhase.Idle : phase);

/** What a press on Remove starts: the question, asked about that link. */
export const removalAsked = (id: string): Removal => ({ id, step: RemovalStep.Asking, failed: false });

/** What a press on the question's Remove starts: the removal of that link. */
export const removalStarted = (id: string): Removal => ({ id, step: RemovalStep.Removing, failed: false });

/**
 * Where the removal stands once the call that removed `id` ended. Only that link's removal ends
 * with it: a question about another link asked meanwhile stays. A refused call asks again, with
 * the refusal said.
 */
export function removalEnded(current: Removal | null, id: string, failed: boolean): Removal | null {
  if (current?.id !== id) return current;
  return failed ? { id, step: RemovalStep.Asking, failed } : null;
}

/** The form's draft, worked out. */
export interface LinkFormView {
  step: SaveStep;
  /** The link as it will be: the game's address with the tags typed so far. */
  url: string;
  /** The tags a save sends; null while the draft cannot be saved. */
  tags: CampaignTags | null;
  /** The saved link that has the draft's tags. */
  saved: CampaignLink | null;
  /** The fields whose words run past `CAMPAIGN_TAG_MAX`: main refuses them, it does not cut them. */
  tooLong: LinkField[];
}

/** The most used sources the form offers as chips. */
const SOURCE_CHIPS_MAX = 8;
/** Characters nobody sees and main refuses in typed words: controls and the two line separators. */
const CONTROLS = /[\p{Cc}\u2028\u2029]/gu;

/** What was typed as the person sees it: without invisible characters, trimmed. */
export const typedTag = (value: string): string => withoutBidiControls(value).replace(CONTROLS, "").trim();

/** Whether what was typed is short enough to be a tag: main refuses a longer one, it does not cut it. */
const fits = (value: string): boolean => typedTag(value).length <= CAMPAIGN_TAG_MAX;

/** The tags the draft makes, as they are saved (lower case, spaces as underscores), whether or not they can be. */
function tagsOf(draft: LinkDraft): CampaignTags {
  const tag = (field: LinkField): string => campaignTag(typedTag(draft[field]));
  return {
    source: tag(CampaignField.Source),
    medium: tag(CampaignField.Medium),
    campaign: tag(CampaignField.Campaign),
    content: tag(CampaignField.Content) || null,
    term: null,
  };
}

/** The tags to save: null while Source, Medium or Campaign is empty or any tag is too long. */
export function draftTags(draft: LinkDraft): CampaignTags | null {
  const tags = tagsOf(draft);
  const named = tags.source !== "" && tags.medium !== "" && tags.campaign !== "";
  return named && LINK_FIELDS.every((field) => fits(draft[field])) ? tags : null;
}

/** A link's tags as they are compared: saved the same way, a tag left out the same as an empty one. */
const tagKey = (tags: CampaignTags): string =>
  JSON.stringify([tags.source, tags.medium, tags.campaign, tags.content ?? "", tags.term ?? ""].map(campaignTag));

/** The form's draft against the game's address and its saved links. */
export function formView(draft: LinkDraft, links: readonly CampaignLink[], gameUrl: string): LinkFormView {
  const tags = draftTags(draft);
  const url = URL.canParse(gameUrl) ? campaignUrl(gameUrl, tagsOf(draft)) : gameUrl;
  const saved = tags ? (links.find((link) => tagKey(link) === tagKey(tags)) ?? null) : null;
  const tooLong = LINK_FIELDS.filter((field) => !fits(draft[field]));
  return { step: stepOf(tags, saved, links.length), url, tags, saved, tooLong };
}

/** Where the form stands: a link that is already saved comes before a full list, a full list before Save. */
function stepOf(tags: CampaignTags | null, saved: CampaignLink | null, links: number): SaveStep {
  if (saved) return SaveStep.Saved;
  if (links >= CAMPAIGN_LINKS_MAX) return SaveStep.Full;
  return tags ? SaveStep.Ready : SaveStep.Incomplete;
}

/** The sources the saved links use, each once, in the links' order: what the form offers to fill Source with. */
export function usedSources(links: readonly CampaignLink[]): string[] {
  const sources = new Set(links.map((link) => campaignTag(link.source)).filter((source) => source !== ""));
  return [...sources].slice(0, SOURCE_CHIPS_MAX);
}

/** A saved link as its row shows it. */
export interface LinkRow {
  id: string;
  campaign: string;
  content: string | null;
  /** Its source and medium on one line. */
  via: string;
  /** What its buttons call it. */
  name: string;
  newVisitors: number;
  newPlayers: number;
  /** New players for each new visitor; null when it has brought no visitor, or more players than visitors. */
  visitToPlay: number | null;
  day7: number | null;
  /** The day it was saved, as written. */
  created: string;
  url: string;
}

/** The saved links' rows, in the order genex.games listed them. */
export function linkRows(links: readonly CampaignLink[]): LinkRow[] {
  return links.map((link) => ({
    id: link.id,
    campaign: link.campaign,
    content: link.content,
    via: LINKS_WORDS.via(link.source, link.medium),
    name: link.content ? LINKS_WORDS.linkName(link.campaign, link.content) : link.campaign,
    newVisitors: link.newVisitors,
    newPlayers: link.newPlayers,
    visitToPlay: share(link.newPlayers, link.newVisitors),
    day7: link.day7,
    created: formatDay(link.createdOn),
    url: link.url,
  }));
}

/** One rule of how a visit is credited: what it says first, then what it means. */
export interface CreditRule {
  id: string;
  lead: string;
  detail: string;
}

/** The rules a visit is credited by, in the order genex.games applies them. */
export function creditRules(): CreditRule[] {
  const { tags, site, genex, first, latest } = LINKS_WORDS.rules;
  return [
    { id: "tags", ...tags },
    { id: "site", ...site },
    { id: "genex", ...genex },
    { id: "first", lead: first.lead, detail: first.detail(INSTALL_CREDIT_DAYS) },
    { id: "latest", ...latest },
  ];
}

/**
 * What `first-publish` and `publish-update` tell the agent that called them: that the publish is
 * handed to the game's chat, or why not and what to do instead.
 */
import { agentTool, RobloxTool } from "./tools.ts";
import { PUBLISH_CLICK_PATH } from "./words.ts";

const FIRST_PUBLISH = agentTool(RobloxTool.FirstPublish);
const PUBLISH_UPDATE = agentTool(RobloxTool.PublishUpdate);

/** What the person can do in Studio themselves where Genex can't click, as the agent passes it on. */
const YOURSELF = `Tell the person they can publish it themselves in Studio: ${PUBLISH_CLICK_PATH}; Genex links this game to the published place by itself afterwards.`;

/**
 * The end of a started publish's answer: the turn that answers the chat's message clicks, which is
 * this one only when the message joined it.
 */
const END_TURN = `this chat's message "Roblox Studio asks: Publish …" hands ${PUBLISH_CLICK_PATH} to the turn that answers it, with computer control. If that message is already in front of you in this turn, you are that turn: click it now with the desktop tool, as the publish skill says. Otherwise end this turn now and don't click anything yourself.`;

export const PUBLISH_PROMPTS = {
  Started: `The person's OK is recorded: ${END_TURN}`,
  FirstStarted: (name: string) =>
    `The person's OK is recorded for a new game named "${name}": ${END_TURN} Genex links this game to the published place by itself once Studio has it.`,
  Unavailable: `Genex can't click in Roblox Studio on this computer (no computer control here), so nothing was published. ${YOURSELF}`,
  Declined: `The person said no to computer control, so nothing was published. ${YOURSELF}`,
  NoChat: `There's no chat to publish from, so nothing was published. ${YOURSELF}`,
  NotStarted: `Nothing was published. ${YOURSELF}`,
  FirstPublish: (name: string) =>
    `This place has never been published, so there is nothing to update. When the person asks to publish, call ${FIRST_PUBLISH} with name "${name}" (the game's title) unless they gave another; the person approves it on a card, and Roblox asks nothing else unless it needs their age, ID, a two-step code, terms or a payment. Nothing was clicked.`,
  NameUnfit: (fits: string) =>
    `Nothing was clicked: Roblox wouldn't take that name as the card showed it (it needs one plain line of at most 50 characters, no double quotes). Call ${FIRST_PUBLISH} again with a name that fits, such as "${fits}"; the person approves it on a new card.`,
  AlreadyPublished: `This place is already on Roblox, so it has no first publish: call ${PUBLISH_UPDATE} to publish an update. Nothing was clicked.`,
  NoPlace: "This game doesn't build in a Roblox place yet, so there's nothing to publish.",
  ResultNoted: "Noted: the person's publishing card shows it. Say the same to them in one line.",
  NoAttempt:
    "No publish is under way for this game, so nothing was noted. Call this only in the turn that publishes, once Studio has published or you stopped for the person.",
} as const;

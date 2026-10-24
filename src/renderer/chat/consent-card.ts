/**
 * A consent card's words: its title and its choices. A plugin's card asks its own question with
 * Allow once (Always allow on a connector's) and Don't allow; the studio's card that turns computer
 * control on asks in its own words, Turn on or Not now.
 */
import { StudioConsentSource } from "../../shared/plugins.ts";
import { COMPUTER_SETTING_CARD_WORDS, CONSENT_CHOICE_WORDS, consentNeededWords } from "../words.ts";
import type { ChatChoice } from "./ChatQuestion.tsx";

/** The consent card's answers, as `ChatQuestion` choice ids. */
export const ConsentChoice = { Once: "once", Always: "always", Decline: "decline" } as const;
export type ConsentChoice = (typeof ConsentChoice)[keyof typeof ConsentChoice];

/** What a card's words are read from: whose card it is, its name, its question and whether Always allow is offered. */
export interface ConsentCardFields {
  consentSourceId?: string;
  consentSource?: string;
  consentPrompt?: string;
  consentAlwaysOffered?: boolean;
}

/** Whether this is the studio's card that turns computer control on for every chat. */
const turnsComputerControlOn = (entry: ConsentCardFields): boolean =>
  entry.consentSourceId === StudioConsentSource.ComputerSetting;

/** The card's title: the studio's own words for its setting card, else the question asked. */
export function consentTitle(entry: ConsentCardFields): string {
  if (turnsComputerControlOn(entry)) return COMPUTER_SETTING_CARD_WORDS.title;
  return entry.consentPrompt || consentNeededWords(entry.consentSource);
}

/** The choices a consent card offers: Always allow only on a connector's, for that exact tool. */
export function consentChoices(entry: ConsentCardFields): ChatChoice[] {
  if (turnsComputerControlOn(entry))
    return [
      { id: ConsentChoice.Once, ...COMPUTER_SETTING_CARD_WORDS.turnOn },
      { id: ConsentChoice.Decline, ...COMPUTER_SETTING_CARD_WORDS.notNow },
    ];
  const always = entry.consentAlwaysOffered
    ? [{ id: ConsentChoice.Always, ...CONSENT_CHOICE_WORDS.always(entry.consentSource ?? "") }]
    : [];
  return [
    { id: ConsentChoice.Once, ...CONSENT_CHOICE_WORDS.once },
    ...always,
    { id: ConsentChoice.Decline, ...CONSENT_CHOICE_WORDS.decline },
  ];
}

/**
 * The language the agents write to the person in: the one the person writes in, and, for Genex's own
 * messages (a resume, a continue, a system note) or when the person's language is unclear, the one
 * Genex is set to, so those turns never pull the chat back to English. Code and the agents' own
 * files stay English.
 */
import type { AppLanguage } from "./app-language.ts";

/** Where Genex's own messages are answered, when the host named its language. */
function fallback(app: AppLanguage | null | undefined): string {
  return app
    ? ` When a message is Genex's own rather than the user's (a resume, a continue, a system note), or the user's language is unclear, write in ${app.name} (${app.tag}), the language the user set Genex to.`
    : "";
}

/** The builder's rule: every word the person reads in the person's language. */
export function languageRule(app: AppLanguage | null | undefined): string {
  return `Write everything the user reads (your replies, questions, plans and progress notes) in the language the user writes to you in.${fallback(app)} Code, file names, commit messages and NOTES.md stay in English.`;
}

/** The Loop chat coordinator's rule, the same in its own voice. */
export function coordinatorLanguageRule(app: AppLanguage | null | undefined): string {
  return `Reply in the language the user writes to you in.${fallback(app)}`;
}

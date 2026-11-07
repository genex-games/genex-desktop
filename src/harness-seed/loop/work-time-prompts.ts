/**
 * The words of a Loop's time (work-time.ts): what the chat's session is told to name when it starts or
 * resumes a Loop, and Genex's lines to the Loop's lead about the time the person asked for (facts, and
 * what the time means for its finish). Model-facing: the session and the lead read them as written.
 * Spans come in already written as a person reads them ("2 h 20 min").
 */

/** What a launch's or a resume's `hours` and `minutes` are: only what the person named. */
export const WORK_TIME_PARAM_WORDS = {
  hours:
    'Only when the person named how long to work ("work 3h", "for an hour"): the hours they said. Genex keeps the build going until that much work is done and refuses an earlier finish. Leave it out when they named no time.',
  minutes:
    'Only when the person named how long to work: the minutes they said ("30 minutes"), or the minutes past the hours they said.',
} as const;

/** Genex's lines to the lead about the person's time. */
export const WORK_WORDS = {
  /** Beside the Loop's first line: the time the person asked for, and how much of it is left. */
  asked: (asked: string, left: string) =>
    `The person asked for ${asked} of work: ${left} of it is left. Genex keeps the Loop going until then and refuses a finish before it; only the person can end it sooner. Spend the time on the goal, and tell the person how long it really worked.`,
  /** A finish before the person's time is worked. */
  tooSoon: (asked: string, worked: string, left: string) =>
    `Not finished: the person asked for ${asked} of work, and the Loop has worked ${worked}, so ${left} is left. Keep working on the goal until then: test, fix and polish what it asks, and add nothing it doesn't. Genex tells you when the time is up; only the person can end the Loop sooner.`,
  /** A turn that ended with nothing at work while the person's time has some left: it wakes the lead. */
  keepWorking: (asked: string, worked: string, left: string) =>
    `Your turn ended with nothing at work, but the person asked for ${asked} of work: the Loop has worked ${worked}, and ${left} is left. Keep working on the goal: test, fix and polish what it asks, and add nothing it doesn't.`,
  /** The person's time is up, told to a lead mid-turn. */
  timeUp: (asked: string, worked: string) =>
    `The ${asked} the person asked for are up (the Loop worked ${worked}). Wrap up now: let what is at work finish or stop it, keep a save point, then call finish.`,
  /** The wrap-up turn the person's time starts. */
  wrapUp: (asked: string, worked: string) =>
    `The ${asked} the person asked for are up (the Loop worked ${worked}): this is your last turn, and the Loop closes when it ends. Keep a save point, then call finish.`,
  /** Beside every close of a timed Loop: the time it worked, for its summary. */
  worked: (asked: string, worked: string) =>
    `The Loop worked ${worked} of the ${asked} the person asked for: say how long it worked in your summary.`,
} as const;

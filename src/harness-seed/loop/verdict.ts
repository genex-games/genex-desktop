/**
 * The verdict record — one per judged build, whoever judged it.
 *
 * Five passes look at a build over a run and, until this module, each wrote its answer in its
 * own shape and its own words: the worker loop kept `verdictSource` + a scoreboard on
 * `facet_iteration`; the lead's judge, fork gate, health pass and close wrote `verdict.json`
 * files and in-memory notes nothing on screen could read. So the app's own build-health box was
 * boilerplate ("Inspect the final result and recorded checks"), a round card counted the checks
 * the judge had *grown* as wins, and the morning could not say, in one sentence, why anything
 * was kept.
 *
 * `verdictRecord()` is the one shape all five produce:
 *
 *   { pass, at, build, against, observed, measured, seen, decision, because }
 *
 * `decision` is a token pair (`kept` and the `rule` that decided it) and `because` is the
 * sentence a non-technical owner reads. The sentence is composed here, from the record's own
 * facts, and never carries a check id, a commit, a branch or a harness word — the screen may
 * show it as it stands. Nothing in this file talks to the studio: it takes plain values and
 * returns a plain object, so every path can be tested without a run.
 */

/** What a record keeps of each list: problems and console lines, cameras and demos, board entries. */
const MAX_PROBLEMS = 5;
const MAX_CAMERAS = 12;
const MAX_CHECK_LINES = 60;
const CHECK_REASON_CHARS = 200;

/**
 * The five passes that judge a build. `round` is a worker's own loop; the rest are the lead's.
 * Verdict records keep the pass and the screen reads it: never rename a value.
 */
export const VerdictPass = {
  Round: "round",
  Gate: "gate",
  Judge: "judge",
  Health: "health",
  Close: "close",
} as const;
export type VerdictPass = (typeof VerdictPass)[keyof typeof VerdictPass];

/** The five passes, in order, for code that checks one at run time. */
export const VERDICT_PASSES: string[] = Object.values(VerdictPass);

/**
 * What a build was judged against, besides another worker's build: the run's start, the live
 * folder, nothing, or the round before. Verdict records keep it: never rename a value.
 */
export const Against = {
  Start: "start",
  Live: "live",
  None: "none",
  Round: "round",
} as const;
export type Against = (typeof Against)[keyof typeof Against];

/** What a build was judged against, named the way the owner would name it. */
const AGAINST: Record<string, string | null> = {
  [Against.Start]: "the game you had",
  [Against.Live]: "the game you had",
  [Against.None]: null,
  [Against.Round]: "the round before",
};

/**
 * The rule that decided a verdict (`decision.rule`). Verdict records keep it and the screen reads
 * it: never rename a value.
 */
export const VerdictRule = {
  ChecksFlipped: "checks-flipped",
  JudgePreferred: "judge-preferred",
  Satisfied: "satisfied",
  ChecksRegressed: "checks-regressed",
  Vetoed: "vetoed",
  NoChange: "no-change",
  NoMove: "no-move",
  Unfixed: "unfixed",
  Broken: "broken",
  Unreachable: "unreachable",
  Stopped: "stopped",
  FirstBuild: "first-build",
  NoStart: "no-start",
  Starts: "starts",
  DoesNotStart: "does-not-start",
  Preferred: "preferred",
  NotPreferred: "not-preferred",
  Unseen: "unseen",
  Landed: "landed",
  NotLanded: "not-landed",
} as const;
export type VerdictRule = (typeof VerdictRule)[keyof typeof VerdictRule];

/** Why a close landed nothing (`verdictRecord({ notLanded })`); each has its sentence in `NOT_LANDED`. */
export const NotLandedReason = {
  NotAsked: "not-asked",
  NothingNew: "nothing-new",
  DoesNotRun: "does-not-run",
  CouldNotLand: "could-not-land",
  NestedNotVersioned: "nested-not-versioned",
  FinalCommitFailed: "final-commit-failed",
  /** The game folder had uncommitted changes the landing would not merge over or into. */
  UncommittedChanges: "uncommitted-changes",
  Stopped: "stopped",
  Crashed: "crashed",
  /** A lost provider paused the run (a sign-in gone, a limit, an outage): Resume lands it once it can be checked. */
  Paused: "paused",
} as const;
export type NotLandedReason = (typeof NotLandedReason)[keyof typeof NotLandedReason];

/**
 * How a worker's round was decided (`verdictSource` on `facet_iteration`, the loop's own word).
 * Old events, the report and the run's memory all read it, and the facet loop decides it
 * (`facet/rules.ts`): never rename a value.
 */
export const VerdictSource = {
  /** The scoreboard decided: a strong flip, or a regression. */
  Checks: "checks",
  /** No check moved; the blind side-by-side pick decided. */
  Taste: "taste",
  /** The taste judge vetoed with a named regression. */
  TasteVeto: "taste-veto",
  /** A prose-only plan: the v1 blind A/B rule. */
  Legacy: "legacy",
  /** Every camera reads identical to the accepted build: no judge call spent. */
  Invisible: "invisible",
  /** The move somebody asked for was not delivered, and nothing flipped. */
  NoMove: "no-move",
  /** THE FIX was mandatory and the build leaves it. */
  Unfixed: "unfixed",
  /** The challenger did not produce a judgeable build. */
  Broken: "broken",
  /** The judge could not be reached: an auto-tie. */
  Outage: "outage",
  /** The run stopped the round before anybody judged it. */
  Stopped: "stopped",
} as const;
export type VerdictSource = (typeof VerdictSource)[keyof typeof VerdictSource];

/**
 * What `verdictSource` (the worker loop's own word for how a round was decided) means as a rule
 * when the round was NOT kept — a win is read off the source directly, below. The loop keeps its
 * field (old events, the report and the run's memory all read it); this is the single place it
 * becomes something the record and the screen can share.
 */
const LOST_BY_SOURCE: Record<string, string> = {
  [VerdictSource.Checks]: VerdictRule.ChecksRegressed,
  [VerdictSource.Taste]: VerdictRule.Vetoed,
  [VerdictSource.Legacy]: VerdictRule.Vetoed,
  [VerdictSource.TasteVeto]: VerdictRule.Vetoed,
  [VerdictSource.Invisible]: VerdictRule.NoChange,
  [VerdictSource.NoMove]: VerdictRule.NoMove,
  [VerdictSource.Unfixed]: VerdictRule.Unfixed,
  [VerdictSource.Broken]: VerdictRule.Broken,
  [VerdictSource.Outage]: VerdictRule.Unreachable,
  [VerdictSource.Stopped]: VerdictRule.Stopped,
} satisfies Record<VerdictSource, VerdictRule>;

/** Sentences that need no fact but the rule. Counts are added by `because()` where they help. */
const BECAUSE: Record<string, string> = {
  "checks-flipped": "Kept: what it was asked to make work now works, and the judge did not object.",
  "judge-preferred": "Kept: no check moved, but the judge preferred it to the round before.",
  satisfied: "Kept: everything this part was asked for now passes.",
  "checks-regressed": "Undone: something that used to work stopped working.",
  vetoed: "Undone: the judge preferred the round before.",
  "no-change": "Undone: every camera showed exactly what the round before showed.",
  "no-move": "Undone: the step it was asked for did not arrive.",
  unfixed: "Undone: the problem it was told to fix is still there.",
  broken: "Undone: the game did not start after this build.",
  unreachable: "Undone: the judge could not be reached, so nothing was changed.",
  stopped: "Not judged: the lead stopped this round, and the work it had done is kept.",
  "first-build": "Nothing to compare it with: the build started from an empty game, so it is judged on its own.",
  "no-start": "Nothing to compare it with: the game as it stood could not be photographed.",
  starts: "It starts and draws its first frame.",
  "does-not-start": "It did not start when it was looked at.",
  preferred: "The judge preferred it.",
  "not-preferred": "The judge preferred the other build.",
  unseen: "Nobody could look at it.",
  landed: "Made live.",
  "not-landed": "Nothing was made live.",
} satisfies Record<VerdictRule, string>;

/** Why a close landed nothing, in the owner's words rather than the branch's. */
const NOT_LANDED: Record<string, string> = {
  "not-asked": "Nothing was made live: the lead kept this build aside.",
  "nothing-new": "Nothing was made live: the build added nothing to the game you already had.",
  "does-not-run": "Nothing was made live: this build did not start when it was checked at the end.",
  "could-not-land": "Nothing was made live: your game folder had changes of its own, so this build was left beside it.",
  "nested-not-versioned":
    "Nothing was made live: part of this game keeps its own version history, and only you can add this build's work to it — the build is waiting for you.",
  "final-commit-failed":
    "Nothing was made live: the lead's last edits could not be saved, so this build was left beside your game.",
  "uncommitted-changes":
    "Nothing was made live: files in your game folder had changes not yet in its history, so this build was left beside it, waiting for Make it live.",
  stopped: "Nothing was made live: the build was stopped before it finished.",
  crashed: "Nothing was made live: the build hit a problem and stopped early.",
  paused:
    "Nothing was made live: the model provider stopped answering, so the build paused before anything could check it — Resume picks it up.",
} satisfies Record<NotLandedReason, string>;

/** A commit, a branch, a ref, a run id, an absolute path — nothing a player has a use for. */
const IDS = [
  /\b(?:refs\/|attempt\/)[\w./-]+/g,
  /\/(?:Users|private|var|tmp)\/\S+/g,
  /\brun_[a-z0-9]{6,}\b/gi,
  /\b[0-9a-f]{7,40}\b/g,
];
/** A check id: `state.contact.speedKept`, `motion-blur-at-speed`, `[state.post.bloom]`. */
const CHECK_IDS = [
  /\[[^\]\n]{0,80}\]/g,
  /`[^`\n]{0,80}`/g,
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g,
  /\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/g,
];
/** The harness's own vocabulary. Left in a sentence it would read as somebody else's log. */
const HARNESS_WORDS =
  /\b(?:challengers?|incumbents?|facets?|worktrees?|scoreboards?|gauntlets?|iterations?|verdicts?|autopilot|integration|integrated|director|commits?|shas?|land=\w*|HEAD)\b/gi;

/**
 * A clause a judge or a builder wrote, made safe to show. Everything only a developer could act
 * on comes out; what is left is trimmed to one clause. Returns "" when too little survives to
 * be worth a sentence — a half-scrubbed fragment reads worse than no clause at all.
 */
export function plainClause(text: unknown, limit = 120): string {
  let out = String(text ?? "");
  for (const pattern of [...IDS, ...CHECK_IDS]) out = out.replace(pattern, " ");
  out = out
    .replace(HARNESS_WORDS, " ")
    .replace(/\(\s*[),;:—–-]*\s*\)/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/[«»"']/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[\s—–:,;.(-]+/, "")
    .replace(/[\s—–:,;.(-]+$/, "");
  // What a removed id leaves behind: "…reaches the tyres on at", "…renders black at". Repeated,
  // because a scrubbed clause often ends in two of them. A leading one goes the same way, but
  // only when it is now pointing at a verb — "the mud never reaches…" is the clause itself,
  // "the did not produce…" is what a removed word left standing.
  let trimmed: string;
  do {
    trimmed = out;
    out = out
      .replace(/\s+(?:on|at|in|to|from|as|of|for|with|by|the|a|an)$/i, "")
      .replace(/[\s—–:,;.(-]+$/, "")
      .replace(/^(?:on|at|in|to|from|as|of|for|with|by)\s+/i, "")
      .replace(
        /^(?:the|a|an)\s+(?=(?:did|does|do|is|was|were|are|has|have|had|could|would|will|can|never|no|not)\b)/i,
        "",
      );
  } while (out !== trimmed);
  if (out.length > limit) out = `${out.slice(0, limit).replace(/[\s,;:-]+\S*$/, "")}…`;
  // Three words is the floor: below it the clause is rubble, not a reason.
  return out.split(/\s+/).filter(Boolean).length >= 3 ? out : "";
}

const list = (value: unknown): any[] =>
  Array.isArray(value) ? value.filter((entry) => entry !== null && entry !== undefined) : [];
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One board entry as a record keeps it: which check, of what kind, and how it read. */
export interface CheckLine {
  id: string;
  kind: string;
  pass: boolean | null;
  reason: string;
}

/** A check as a caller hands it to a record: any of its fields may be missing. */
export interface CheckInput {
  id?: string;
  kind?: string;
  weight?: string;
  pass?: boolean | null;
  reason?: string;
}

/** Everything a pass may know about a build; every field is optional and normalised. */
export interface VerdictFields {
  pass?: string;
  at?: string | null;
  head?: string | null;
  worker?: string | null;
  round?: number | null;
  against?: string | null;
  againstHead?: string | null;
  ok?: boolean | null;
  problems?: readonly unknown[];
  cameras?: readonly unknown[];
  demos?: readonly unknown[];
  consoleFresh?: readonly unknown[];
  consoleInherited?: readonly unknown[];
  readyAfterMs?: number | null;
  planned?: readonly CheckInput[];
  grown?: readonly CheckInput[];
  flips?: readonly unknown[];
  regressions?: readonly unknown[];
  unmeasured?: readonly unknown[];
  pick?: string | null;
  veto?: boolean | null;
  satisfied?: boolean | null;
  question?: string | null;
  answer?: boolean | null;
  alive?: number | null;
  aliveMax?: number | null;
  judgeCalls?: number;
  kept?: boolean | null;
  rule?: string;
  gap?: string | null;
  landingLine?: string | null;
  notLanded?: string | null;
}

/** One judgement of one build, in the shape every pass writes. */
export interface VerdictRecord {
  pass: string;
  at: string;
  build: { head: string | null; worker: string | null; round: number | null };
  against: { head: string | null; what: string | null };
  observed: {
    ok: boolean | null;
    problems: string[];
    cameras: string[];
    demos: string[];
    consoleFresh: string[];
    consoleInherited: string[];
    readyAfterMs?: number;
  };
  measured: { planned: CheckLine[]; grown: CheckLine[]; flips: string[]; regressions: string[]; unmeasured: string[] };
  seen: {
    pick: string | null;
    veto: boolean | null;
    satisfied: boolean | null;
    question: string | null;
    answer: boolean | null;
    alive: number | null;
    aliveMax: number | null;
    judgeCalls: number;
  };
  decision: { kept: boolean | null; rule: string };
  because: string;
}

/** What the sentence may say beyond the record's own facts. */
interface BecauseFacts {
  landingLine?: string | null;
  notLanded?: string | null;
  gap?: string | null;
}

/** Rules whose sentence carries the judge's own words about what is still wrong. */
const CLAUSED_RULES = new Set<string>([VerdictRule.Vetoed, VerdictRule.Unfixed, VerdictRule.Broken]);

/**
 * The rules whose sentence depends on more than the rule: a count, the landing, the pass, what
 * the build was put beside. Null hands the rule back to its plain sentence.
 */
const RULE_SENTENCE: Partial<Record<VerdictRule, (record: VerdictRecord, facts: BecauseFacts) => string | null>> = {
  [VerdictRule.ChecksFlipped]: (record) => {
    const flips = record.measured.flips.length;
    if (!flips) return null;
    return `Kept: ${count(flips, "check")} that ${flips === 1 ? "was" : "were"} failing now ${flips === 1 ? "passes" : "pass"}, and the judge did not object.`;
  },
  [VerdictRule.ChecksRegressed]: (record) => {
    const regressions = record.measured.regressions.length;
    return regressions ? `Undone: ${count(regressions, "check")} that used to pass stopped passing.` : null;
  },
  [VerdictRule.Landed]: (_record, { landingLine }) =>
    landingLine ? `Made live — ${landingLine.replace(/^made live[,—-]?\s*/i, "")}.` : BECAUSE.landed,
  [VerdictRule.NotLanded]: (_record, { notLanded }) => NOT_LANDED[notLanded as string] ?? BECAUSE["not-landed"],
  // The fork gate's refusal is the one a user feels: no builder starts at all.
  [VerdictRule.Starts]: (record) =>
    record.pass === VerdictPass.Gate
      ? "The build this builder starts from runs, so it begins from something that works."
      : BECAUSE.starts,
  [VerdictRule.DoesNotStart]: (record) => {
    const opening =
      record.pass === VerdictPass.Gate
        ? "No builder could start: the build they would work from did not run"
        : "It did not start when it was looked at";
    const problem = plainClause(record.observed.problems[0] ?? "");
    return problem ? `${opening}: ${problem}.` : `${opening}.`;
  },
  [VerdictRule.Preferred]: (record) =>
    record.against.what ? `The judge preferred it to ${record.against.what}.` : BECAUSE.preferred,
  [VerdictRule.NotPreferred]: (record) =>
    record.against.what ? `The judge preferred ${record.against.what} to it.` : BECAUSE["not-preferred"],
};

/**
 * The sentence. It is built from the record's own counts, never from free text alone, so it says
 * something even when every judge was silent; a scrubbed clause is appended only when the judge
 * named a problem in words a player could act on.
 */
function because(record: VerdictRecord, facts: BecauseFacts = {}): string {
  const { rule } = record.decision;
  const special = Object.hasOwn(RULE_SENTENCE, rule) ? RULE_SENTENCE[rule as VerdictRule]?.(record, facts) : null;
  if (special) return special;
  const sentence = BECAUSE[rule] ?? BECAUSE.unseen;
  // The judge's own words about what is still wrong, when they survive scrubbing: a reason like
  // "the mud never reaches the tyres" is worth more than any count.
  const clause = CLAUSED_RULES.has(rule) ? plainClause(facts.gap ?? "") : "";
  return clause ? `${sentence.replace(/\.$/, "")} — ${clause}.` : sentence;
}

/** A value that is a boolean, or null. */
const booleanOrNull = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
/** A value that is a number, or null. */
const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);
/** A list of anything, as its first `max` entries in words. */
const words = (value: unknown, max?: number): string[] => list(value).map(String).slice(0, max);

/** What an evidence pass saw, as the record keeps it. */
function observedOf(fields: VerdictFields): VerdictRecord["observed"] {
  const { ok, problems, cameras, demos, consoleFresh, consoleInherited, readyAfterMs } = fields;
  return {
    ok: booleanOrNull(ok),
    problems: words(problems, MAX_PROBLEMS),
    cameras: words(cameras, MAX_CAMERAS),
    demos: words(demos, MAX_CAMERAS),
    consoleFresh: words(consoleFresh, MAX_PROBLEMS),
    consoleInherited: words(consoleInherited, MAX_PROBLEMS),
    // How long the page took to be ready, when the page said so. A build judged black is a
    // different fact from a build photographed before it had drawn anything, and the record
    // is where that difference has to survive the run. Absent when nobody could measure it.
    ...(Number.isFinite(readyAfterMs) ? { readyAfterMs: Math.round(Number(readyAfterMs)) } : {}),
  };
}

/** What a judge or a player said, as the record keeps it. */
function seenOf(fields: VerdictFields): VerdictRecord["seen"] {
  const { pick, veto, satisfied, question, answer, alive, aliveMax, judgeCalls } = fields;
  return {
    pick: pick ?? null,
    veto: booleanOrNull(veto),
    satisfied: booleanOrNull(satisfied),
    question: question ?? null,
    answer: booleanOrNull(answer),
    alive: numberOrNull(alive),
    aliveMax: numberOrNull(aliveMax),
    judgeCalls: Number.isFinite(judgeCalls) ? (judgeCalls as number) : 0,
  };
}

/**
 * One record. Every field is normalised here, so a caller may pass whatever its pass happens to
 * have: absent lists become empty ones, absent facts become null, and the sentence is composed
 * last, from what survived.
 */
export function verdictRecord(fields: VerdictFields = {}): VerdictRecord {
  const { pass, at, head, worker, round, against, againstHead, kept, rule } = fields;
  const record: VerdictRecord = {
    pass: VERDICT_PASSES.includes(pass as string) ? (pass as string) : VerdictPass.Judge,
    at: at ?? new Date().toISOString(),
    build: { head: head ?? null, worker: worker ?? null, round: numberOrNull(round) },
    against: { head: againstHead ?? null, what: against ?? null },
    observed: observedOf(fields),
    measured: {
      planned: checkLines(fields.planned ?? []),
      grown: checkLines(fields.grown ?? []),
      flips: words(fields.flips ?? []),
      regressions: words(fields.regressions ?? []),
      unmeasured: words(fields.unmeasured ?? []),
    },
    seen: seenOf({ judgeCalls: 0, ...fields }),
    decision: { kept: booleanOrNull(kept), rule: String(rule ?? VerdictRule.Unseen) },
    because: "",
  };
  record.because = because(record, fields);
  return record;
}

/** One board entry, kept to what a card can use: which check, of what kind, and how it read. */
function checkLines(entries: unknown): CheckLine[] {
  return list(entries)
    .map((entry) => ({
      id: String(entry?.id ?? ""),
      kind: String(entry?.kind ?? ""),
      pass: booleanOrNull(entry?.pass),
      reason: String(entry?.reason ?? "").slice(0, CHECK_REASON_CHARS),
    }))
    .filter((entry) => entry.id)
    .slice(0, MAX_CHECK_LINES);
}

/**
 * The rule a worker's round was decided by. The loop already knows *how* it decided
 * (`verdictSource`); this turns that into the token every pass shares, and catches the two cases
 * the source alone cannot tell apart — a regression (which the loop also calls "checks") and a
 * part that finished everything it was asked for.
 */
export function roundRule({
  source,
  won = false,
  satisfied = false,
}: {
  source?: string | null;
  won?: boolean;
  satisfied?: boolean;
} = {}): string {
  if (source === VerdictSource.Stopped) return VerdictRule.Stopped;
  if (won && satisfied) return VerdictRule.Satisfied;
  if (won) return source === VerdictSource.Checks ? VerdictRule.ChecksFlipped : VerdictRule.JudgePreferred;
  return LOST_BY_SOURCE[source as string] ?? VerdictRule.Vetoed;
}

/**
 * The phrase for `against`: a known key becomes the owner's words, a worker id its own name.
 */
export function againstWords(
  key: string | null | undefined,
  { workerTitle = null }: { workerTitle?: string | null } = {},
): string | null {
  if (key === null || key === undefined) return null;
  const name = String(key);
  if (name in AGAINST) return AGAINST[name]!;
  return workerTitle ? `what ${workerTitle} built` : "another build";
}

/**
 * What an evidence pass saw, in the record's words. `evidence` is a gatherEvidence result.
 */
export function observedFrom(
  evidence:
    | {
        ok?: boolean;
        readyAfterMs?: number | null;
        problems?: readonly string[];
        shots?: ReadonlyArray<{ camera?: string } | string>;
        registeredDemos?: readonly string[] | null;
        consoleErrors?: readonly string[];
      }
    | null
    | undefined,
): {
  ok: boolean;
  readyAfterMs: number | null;
  problems: string[];
  cameras: string[];
  demos: string[];
  consoleFresh: string[];
} {
  return {
    ok: evidence?.ok === true,
    readyAfterMs:
      typeof evidence?.readyAfterMs === "number" && Number.isFinite(evidence.readyAfterMs)
        ? evidence.readyAfterMs
        : null,
    problems: list(evidence?.problems),
    cameras: list(evidence?.shots)
      .map((shot) => (typeof shot === "string" ? shot : shot?.camera))
      .filter(Boolean),
    demos: list(evidence?.registeredDemos),
    consoleFresh: list(evidence?.consoleErrors),
  };
}

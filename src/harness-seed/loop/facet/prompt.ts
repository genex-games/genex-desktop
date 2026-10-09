/** What the facet loop says to its builder: the prompt, the steer, the wind-down ask, the images and the brief's moved sections. */
import { CheckKind, CheckWeight, HARNESS_CHECKS, renderChecks } from "../spec.ts";
import { GAME_KINDS, describePlayScript, playScriptFor } from "../kinds.ts";
import { roleEngine, RoleKey, toolCall } from "../model-roles.ts";
import { facetNotes } from "../repo.ts";
import { CLIP_QUOTE } from "../text.ts";
import { DEFAULT_CAMERA } from "../cameras.ts";
import { FacetStage, moveEscalated, stageOf } from "./stage.ts";
import { FINISH_FIX_ASK, FINISH_PROMPT_LINE, finishLossEscalate } from "./stage-prompts.ts";
import { scopeLines } from "../scope-prompts.ts";
import { visionBriefLines } from "../vision-prompts.ts";
import { heldHudPromptDraws } from "../held-hud-prompts.ts";
import { appliesToBuild } from "../applies-to-build.ts";
import { screenOwnerLine } from "../screen-owner-prompts.ts";
import { blockPromptLine } from "./build-block-prompts.ts";
import { reapplyWords } from "./carried-fixes-prompts.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** Reference stills into the first brief, and pair images later, at most. */
const MAX_PROMPT_IMAGES = 12;

/**
 * The caps on the lists a build prompt carries (M4.8b). A board of forty checks, a steering
 * thread the user typed for the whole run and a stack trace from a bundler are each unbounded, so the
 * prompt's size was an accident of the run rather than a number anybody chose. Each list is
 * cut with a tail that says how many went, because a silent truncation reads as a shorter board.
 */
export const MAX_PROMPT_LIST = 8;

/** The most of one steering instruction, and of the whole thread, a prompt repeats. */
export const MAX_PROMPT_STEERING = 4;

/** How much of one steering message a prompt quotes. */
const MAX_STEERING_CHARS = 400;

/** The most of a failure report a prompt carries; the whole of it is in the worker's own log. */
export const MAX_PROMPT_FAILURE = 2_000;
/** Reference-and-build pairs one prompt shows. */
const MAX_REFERENCE_PAIRS = 4;
/** How much of a failing check's reason the board line quotes. */
const FAILING_REASON_CHARS = 160;
/** Ledger defects a resumed prompt names, and an opening one. */
const RESUMED_LEDGER_DEFECTS = 10;
const OPENING_LEDGER_DEFECTS = 12;
/** How much of the brief a direct engine's prompt carries inline. */
const MAX_INLINE_BRIEF = 12_000;

/**
 * The four sections a delegated worker's prompt stops rendering (M4.8b) and `.studio/BRIEF.md`
 * carries instead. A cut instruction is a lost instruction: the ownership rule in particular is
 * the only prose that tells a non-owner to keep out of the entry module, so it is MOVED, never
 * deleted, and the file the worker reads is the one place it now lives.
 *
 * It is spliced into the rendered brief rather than written inside `renderBrief` because
 * `library.ts` belongs to another lane; the guard makes it a no-op the day that function
 * renders these itself, so the two can never both speak.
 */
export function briefWithMovedSections(
  text: unknown,
  {
    spec,
    ownsMain = true,
    ownShape = false,
    entryMain = "src/main.js",
    build = null,
  }: {
    spec?: AnyRecord | null;
    ownsMain?: boolean;
    ownShape?: boolean;
    entryMain?: string;
    build?: string | null;
  } = {},
): string {
  const body = rulesBeforeHistory(withDoneSection(String(text ?? ""), spec));
  if (body.includes("- YOUR SEAM:") || body.includes("- YOUR FILES:")) return body;
  const rules = [
    seamRule(spec, ownShape),
    entryRule(entryMain, ownsMain, ownShape),
    ...(ownShape && build
      ? [
          `- Run \`${build}\` before you finish: the studio runs the same build before every preview, and a build that fails is a black screen for every critic.`,
        ]
      : []),
    `- If this facet is behavioural (an interaction, a move, a beat), expose a deterministic demo of it via the studio contract (config.demos in installStudio) — demo checks run it and photograph its end frame.`,
  ];
  const header = "## Rules that do not change";
  return body.includes(header)
    ? body.replace(header, [header, ...rules].join("\n"))
    : [body, ``, header, ...rules].join("\n");
}

/** The brief's rules block, and the sections of history and recipes it must come before. */
const RULES_HEADER = "## Rules that do not change";
const HISTORY_HEADERS = ["## Earlier rounds", "## Recipes that apply"];

/**
 * The brief with its rules block ahead of the earlier rounds and the recipes. Those two are the
 * longest and least binding sections, and a direct engine's inline brief is cut from the end:
 * behind them the seam and the entry rule were what the cut took. Moved whole, up to the next
 * heading, so the lessons after it stay where they were; a brief already in that order is
 * returned unchanged.
 */
function rulesBeforeHistory(body: string): string {
  const rulesAt = body.indexOf(`\n${RULES_HEADER}`);
  const historyAt = Math.min(...HISTORY_HEADERS.map((header) => body.indexOf(`\n${header}`)).filter((at) => at !== -1));
  if (rulesAt === -1 || !Number.isFinite(historyAt) || rulesAt < historyAt) return body;
  const next = body.indexOf("\n## ", rulesAt + 1);
  const end = next === -1 ? body.length : next;
  const block = body.slice(rulesAt, end).replace(/\n+$/, "");
  const rest = `${body.slice(0, rulesAt)}${body.slice(end)}`;
  return `${rest.slice(0, historyAt)}${block}\n${rest.slice(historyAt)}`;
}

/** The brief with its "Done means" section, placed before the scoreboard when it has one. */
function withDoneSection(body: string, spec: AnyRecord | null | undefined): string {
  if (!spec?.done?.length || body.includes("## Done means")) return body;
  const block = [
    `## Done means (this facet ends when these pass and the taste judge agrees)`,
    ...spec.done.map((d: AnyRecord) => `- ${d.what} — measured by check ${d.id}`),
    ``,
  ].join("\n");
  const at = body.indexOf("## Scoreboard");
  return at === -1 ? `${body}\n\n${block}` : `${body.slice(0, at)}${block}\n${body.slice(at)}`;
}

/** Where the worker's own work goes: its seam in the user's code, or its own module in the template. */
function seamRule(spec: AnyRecord | null | undefined, ownShape: boolean): string {
  const owned = spec?.owns?.length ? spec.owns.join(", ") : null;
  if (ownShape)
    return `- YOUR SEAM: ${owned ?? "every file of this game except its entry module, the studio contract and index.html"}. It is the user's own code — read what is around your seam before you change anything, follow the conventions the game already has, and do not rename, restyle or reformat a file you did not have to change.`;
  return `- YOUR FILES: put this facet's work in its own module — ${owned ?? `src/${String(spec?.id ?? "facet").replace(/[^a-z0-9-]/g, "")}.js`} (split further under src/ if it grows).`;
}

/** Who may touch the entry module and the studio contract. */
function entryRule(entryMain: string, ownsMain: boolean, ownShape: boolean): string {
  if (ownsMain)
    return `- This worker OWNS ${entryMain} and src/studio.js — you may restructure them, and you wire in other workers' modules when they appear.`;
  if (ownShape)
    return `- This worker does NOT own ${entryMain}, src/studio.js or index.html. If your work needs a change in one of them, say so in your summary and leave it: the director makes that edit, or gives it to whoever owns the entry.`;
  return `- This facet does NOT own ${entryMain} or src/studio.js. Touch ${entryMain} ONLY to add your single import + init line inside the "FACET WIRING" marker block (add the marker block if it is missing); never reformat or reorganise anything else in either file.`;
}

/** `n` entries and a tail saying how many were left out, or the whole list when it fits. */
function cappedList(entries: readonly unknown[], max = MAX_PROMPT_LIST): unknown[] {
  const all = entries.filter(Boolean);
  if (all.length <= max) return all;
  return [...all.slice(0, max), `(+${all.length - max} more — the whole board is in the brief)`];
}

/** The last `max` characters of a failure report: the cause is at the bottom of a stack. */
function cappedFailure(text: unknown, max = MAX_PROMPT_FAILURE): string {
  const body = String(text ?? "");
  if (body.length <= max) return body;
  return `(+${body.length - max} earlier characters, clipped)\n${body.slice(-max)}`;
}

/** The steering the prompt repeats: the newest instructions, each one clipped. */
function cappedSteering(steering: readonly unknown[] | null | undefined, max = MAX_PROMPT_STEERING): string[] {
  const all = (steering ?? []).filter(Boolean).map((s) => String(s));
  const kept = all.slice(-max).map((s) => (s.length > MAX_STEERING_CHARS ? `${s.slice(0, MAX_STEERING_CHARS)}…` : s));
  return all.length > max
    ? [`(+${all.length - max} earlier instruction${all.length - max === 1 ? "" : "s"}, in the brief)`, ...kept]
    : kept;
}

/**
 * The instruction that arrives mid-build. The turn it interrupted is resumed in the same
 * session — everything the builder had read and written is still there — so it says what
 * changed and asks for the work to go on, never for a fresh start.
 */
export function steerPrompt(texts: readonly unknown[]): string {
  return [
    `A STEER ARRIVED WHILE YOU WERE WORKING — your turn was interrupted to hand it to you:`,
    ...texts.map((t) => `- ${String(t).trim()}`),
    ``,
    `Continue where you were, with this in front of everything else. Do not start over, and undo nothing you have already written unless this asks you to.`,
  ].join("\n");
}

/**
 * The end of a build turn the clock was about to cut. Sent in the same session, so the builder
 * ends the edit it is inside instead of leaving a half-written file for the judge to photograph.
 */
export const WIND_DOWN_ASK = [
  `TIME: your build turn is at its limit — the studio looks at what you have in a few minutes.`,
  `Start nothing new. Finish the edit you are inside so the game still runs, reload it and read the console, write what you did and what is left in your notes, then stop.`,
].join("\n");

/**
 * Which stills go into the builder's prompt as images (WP3d). Iteration 1: every reference
 * still and the base build's frames for the facet's cameras. Later: one reference|build pair
 * per facet camera, only when a style/vision check is failing or the last build lost.
 */
export function promptImagesFor({
  run,
  spec,
  iteration,
  board = {},
  loseStreak = 0,
  baseShots = [],
  incumbentEvidence = null,
  pairs = [],
}: {
  run: AnyRecord | null | undefined;
  spec?: { cameras?: string[] } | null;
  iteration: number;
  board?: AnyRecord | null;
  loseStreak?: number;
  baseShots?: AnyRecord[] | null;
  incumbentEvidence?: AnyRecord | null;
  pairs?: AnyRecord[] | null;
}): Array<{ label: string; mimeType: string; data: string }> {
  const frames = (run?.reference?.frames ?? []).filter((f: AnyRecord | null) => f?.data);
  if (iteration === 1 || !incumbentEvidence) {
    const refs = frames.slice(0, MAX_PROMPT_IMAGES).map((f: AnyRecord, i: number) => ({
      label: `REFERENCE STILL "${f.label || i + 1}"`,
      mimeType: f.mimeType || "image/jpeg",
      data: f.data,
    }));
    const wanted = new Set(spec?.cameras ?? []);
    const base = (baseShots ?? [])
      .filter((s) => s?.base64 && (wanted.has(s.camera) || s.camera === DEFAULT_CAMERA))
      .slice(0, Math.max(0, MAX_PROMPT_IMAGES - refs.length))
      .map((s) => ({
        label: `BASE BUILD / ${s.camera} (what you start from)`,
        mimeType: "image/jpeg",
        data: s.base64,
      }));
    return [...refs, ...base];
  }
  const failingStyle = Object.values(board ?? {}).some(
    (e: AnyRecord) => (e.kind === CheckKind.Vision || e.kind === CheckKind.Metric) && e.pass === false,
  );
  if (!failingStyle && loseStreak < 1) return [];
  return (pairs ?? [])
    .filter((p) => p?.data)
    .slice(0, MAX_REFERENCE_PAIRS)
    .map((p) => ({
      label: `PAIR reference "${p.reference}" (LEFT) | your accepted build ${p.camera} (RIGHT)`,
      mimeType: "image/jpeg",
      data: p.data,
    }));
}

/**
 * The prompt that opens (or continues) the builder's session. The full contract lives in
 * `.studio/BRIEF.md`; the prompt points there and carries only what changed. Direct engines
 * (no file-reading habit) get the brief inline.
 */
export function facetPrompt(args: AnyRecord): string {
  const p = promptInput(args);
  return p.resumed ? resumedPrompt(p) : openingPrompt(p);
}

/** Everything `facetPrompt` is handed, with its defaults, and what every section derives from it. */
type PromptInput = AnyRecord & {
  entryMain: string;
  pointsAtBrief: boolean;
  steering: string[];
  failureText: string | null;
  moveLine: string;
  briefPointer: string;
  /** A finishing worker (facet/stage.ts): no move, polish is the work. */
  finishing: boolean;
};

function promptInput({
  briefText = null,
  board = {},
  lastAttempt = null,
  lastFailure = null,
  loseStreak = 0,
  gapHistory = [],
  defectList = [],
  userSteering = [],
  acceptedShots = [],
  ownsMain = true,
  spike = null,
  integrationNote = null,
  legacy = false,
  imagesAttached = 0,
  move = null,
  fix = null,
  shape = null,
  ownShape = false,
  game = null,
  stage = null,
  buildBlock = null,
  ...rest
}: AnyRecord): PromptInput {
  const { briefFile } = rest;
  const finishing = stageOf({ stage }) === FacetStage.Finish;
  // A worker's first, long round (facet/build-block.ts) says so before its move.
  const blockLine = buildBlock ? blockPromptLine(buildBlock.bench ?? null) : "";
  return {
    ...rest,
    briefText,
    board,
    lastAttempt,
    lastFailure,
    loseStreak,
    gapHistory,
    defectList,
    userSteering,
    acceptedShots,
    ownsMain,
    spike,
    integrationNote,
    legacy,
    imagesAttached,
    move,
    fix,
    shape,
    ownShape,
    game,
    entryMain: shape?.main ?? "src/main.js",
    // Every section below that .studio/BRIEF.md already carries is rendered ONCE (M4.8b). A
    // delegated engine reads the file — the loop wrote it into the worktree and the prompt's
    // first line points at it — so repeating the contract, the ownership rules, the ledger and
    // the reference bullets in the prompt bought nothing and cost the window. A direct engine
    // has no file to read (`briefText` rides in the prompt instead), and keeps everything.
    pointsAtBrief: Boolean(briefFile) && briefText === null,
    steering: cappedSteering(userSteering),
    failureText: lastFailure ? cappedFailure(lastFailure) : null,
    finishing,
    moveLine: (finishing ? [FINISH_PROMPT_LINE, fixAsk(fix, true)] : [blockLine, moveAsk(move), fixAsk(fix)])
      .filter(Boolean)
      .join("\n"),
    briefPointer: briefFile
      ? `READ ${briefFile} FIRST — it is this iteration's brief: the checks (your contract), the scoreboard, the attempts that lost, and the recipes that apply.`
      : "",
  };
}

/** THE MOVE this iteration asks for, and whether a build that skips it loses. */
function moveAsk(move: AnyRecord | null): string {
  if (!move?.what) return "";
  const measured = move.check
    ? ` — measured by check ${move.check.id}`
    : " — the taste judge answers whether it is visible";
  const lead = move.mandatory ? "A build that only tunes what already exists LOSES; make" : "Make";
  const escalate = moveEscalated(move)
    ? ` ESCALATE: your last ${move.polishStreak} accepted builds were polish only.`
    : "";
  return `THE MOVE THIS ITERATION (${move.mandatory ? "mandatory" : "asked for"}): ${move.what}${measured}. ${lead} the move first — the whole step, boldly, so a player notices it in the first minute — then fix up to three ledger items.${escalate}`;
}

/** THE FIX this iteration names, and how many more namings make it mandatory; a finisher may tune it closed. */
function fixAsk(fix: AnyRecord | null, finishing = false): string {
  if (!fix?.what) return "";
  const weight = fix.mandatory
    ? "mandatory — a build that leaves it LOSES"
    : "the judge has named it " + fix.streak + " times; next time it is mandatory";
  const how = finishing
    ? FINISH_FIX_ASK
    : "Replace the mechanism, do not tune it: if it is a shape, rebuild the shape; if it is a material, change the material kind (foliage.js for anything leafy).";
  return `THE FIX THIS ITERATION (${weight}): ${fix.what}${fix.checkId ? ` — measured by check ${fix.checkId}` : ""}. ${how}`;
}

/** A losing streak's ESCALATE: the build stage's own words, or a finisher's "change the approach". */
function lossEscalate(p: PromptInput, buildWords: string): string {
  return p.finishing ? finishLossEscalate(p.loseStreak) : buildWords;
}

/**
 * The board's failing entries and the ones nobody could measure, of this build's questions only: a
 * harness check the build cannot answer (loop/applies-to-build.ts) is not named to its builder.
 */
function boardState(
  board: AnyRecord,
  spec: AnyRecord | null | undefined,
): { failing: AnyRecord[]; unmeasuredNow: AnyRecord[] } {
  const entries = (Object.values(board) as AnyRecord[]).filter((e) => appliesToBuild(e, spec));
  return {
    failing: entries.filter((e) => e.pass === false),
    unmeasuredNow: entries.filter((e) => e.pass !== true && e.pass !== false),
  };
}

/** The user's steering, obeyed over everything else. */
function steeringLines(steering: string[]): string[] {
  if (!steering.length) return [];
  return ["", "USER STEERING (obey this over everything below):", ...steering.map((s) => `- ${s}`)];
}

/** The unmeasured entries, said as what they are: not failures. */
function unmeasuredLine(unmeasuredNow: AnyRecord[]): string {
  if (!unmeasuredNow.length) return "";
  return `UNMEASURED (not failures — the harness could not look): ${cappedList(unmeasuredNow.map((e) => `${e.id} — ${String(e.reason).slice(0, CLIP_QUOTE)}`)).join("; ")}`;
}

// ── the resumed session ───────────────────────────────────────────────────────────────────

/** The prompt that continues the builder's own session: what happened, and what is still open. */
function resumedPrompt(p: PromptInput): string {
  const { run, spec: facet, iteration, pointsAtBrief, integrationNote, spike, failureText } = p;
  const { unmeasuredNow } = boardState(p.board, p.spec);
  return [
    `Iteration ${iteration} of your facet "${facet.title}" (run ${run.runId}). You are resuming your own session — you remember what you tried.`,
    p.briefPointer,
    // A direct engine has no brief to point at, and the screen's owner can change between rounds.
    ...(pointsAtBrief ? [] : screenOwnerLines(p)),
    ...steeringLines(p.steering),
    // Three sections the brief carries in full: repeated here only when there is no brief.
    ...(!pointsAtBrief && integrationNote ? ["", integrationNote] : []),
    ...(!pointsAtBrief && spike ? ["", spike] : []),
    "",
    lastAttemptLine(p.lastAttempt),
    p.moveLine,
    resumedBoardLine(p),
    unmeasuredLine(unmeasuredNow),
    failureText
      ? `YOUR LAST BUILD COULD NOT BE JUDGED. The actual errors:\n${failureText}\nFix the cause first — the same cause twice ends this facet.`
      : "",
    p.imagesAttached
      ? `LOOK AT THE ${p.imagesAttached} IMAGES ATTACHED TO THIS MESSAGE: reference (LEFT) next to your build (RIGHT). Close the gap you can SEE.`
      : "",
    resumedLedger(p),
    p.loseStreak >= 2
      ? lossEscalate(
          p,
          `ESCALATE: ${p.loseStreak} losses in a row on the same checks — change the mechanism, do not re-tune numbers.`,
        )
      : "",
    "",
    "Flip failing checks, identity first; do not break passing ones. Capture and LOOK before you finish. Update " +
      `${facetNotes(facet.id)}.`,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

/** How the last build went: accepted, lost (and where its code is kept), or nothing yet. */
function lastAttemptLine(lastAttempt: AnyRecord | null): string {
  if (!lastAttempt) return "";
  const unseen = unseenDemosLine(lastAttempt.skippedDemos);
  if (lastAttempt.won)
    return `Your last build was ACCEPTED${lastAttempt.flips.length ? ` (flipped: ${lastAttempt.flips.join(", ")})` : ""}.${unseen}`;
  // The worktree went back to the accepted build: what the lost build fixed is re-applied, not "kept".
  const kept = lastAttempt.flips.length ? reapplyWords(lastAttempt.flips) : "";
  const retained = lastAttempt.branch ? `. Its code is retained on ${lastAttempt.branch}` : "";
  return `Your last build LOST: ${lastAttempt.why || "no check flipped"}${kept}${retained}. The worktree is back on the accepted build.${unseen}`;
}

/**
 * The demos the last round's look registered but did not photograph (the look's cap): a builder
 * whose new demo is never seen spends rounds on a move no judge can look at.
 */
function unseenDemosLine(skipped: unknown): string {
  const names = Array.isArray(skipped) ? skipped.map(String).filter(Boolean) : [];
  if (!names.length) return "";
  return ` Its look did not photograph the demos ${names.join(", ")} (a look runs every demo a check names, and only so many more) — name one in a check (a demo check, or a vision check on demo:<name>) to have it photographed every round.`;
}

/** Identity checks first. */
const byIdentityFirst = (a: AnyRecord, b: AnyRecord): number =>
  (a.weight === CheckWeight.Identity ? -1 : 1) - (b.weight === CheckWeight.Identity ? -1 : 1);

/** What is still failing, or — when nothing is — what this iteration works on instead. */
function resumedBoardLine(p: PromptInput): string {
  const { failing } = boardState(p.board, p.spec);
  if (failing.length)
    return `STILL FAILING (identity first): ${cappedList(failing.sort(byIdentityFirst).map((e) => `${e.id} — ${String(e.reason).slice(0, FAILING_REASON_CHARS)}`)).join("; ")}`;
  if (p.legacy) return `THE BIGGEST REMAINING GAP: ${p.defectList[0] ?? ""}`;
  if (p.move?.what) return "Every check passes — make THE MOVE above, then work the judge's defect list in the brief.";
  return "Every check passes — this iteration is taste: work the judge's defect list in the brief.";
}

/** The ledger is not the prompt's to carry: a legacy loop, a brief that points at it, or an empty one. */
function ledgerElsewhere(p: PromptInput): boolean {
  return Boolean(p.legacy || p.pointsAtBrief || !p.defectList.length);
}

/** The judge's defect ledger, when the prompt carries it itself. */
function resumedLedger(p: PromptInput): string {
  if (ledgerElsewhere(p)) return "";
  return `THE JUDGE'S DEFECT LEDGER on the accepted build (worst first; the worst are also vision checks on your board):\n${p.defectList
    .slice(0, RESUMED_LEDGER_DEFECTS)
    .map((d: unknown, i: number) => `${i + 1}. ${d}`)
    .join("\n")}`;
}

// ── the opening prompt ────────────────────────────────────────────────────────────────────

/** The prompt that opens a builder's session: who it is, the goal, the contract and this iteration's news. */
function openingPrompt(p: PromptInput): string {
  const lines = [...openingHead(p), ...ownershipLines(p), ...conventionLines(p), ...screenOwnerLines(p)];
  lines.push(...steeringLines(p.steering));
  if (p.moveLine) lines.push("", p.moveLine);
  if (!p.pointsAtBrief && p.integrationNote) lines.push("", p.integrationNote);
  if (!p.pointsAtBrief && p.spike) lines.push("", p.spike);
  lines.push(...progressLines(p), ...openingLedger(p), ...imageLines(p), ...closingLines(p));
  if (p.briefText)
    lines.push("", "─".repeat(40), "THE BRIEF (also in .studio/BRIEF.md):", p.briefText.slice(0, MAX_INLINE_BRIEF));
  // A dropped section leaves its blank lines behind; the brief has collapsed them since it was
  // written, and a prompt with four blank lines in a row reads as a prompt with a hole in it.
  return lines
    .filter((line) => line !== undefined && line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** What kind of game this is, and the controls the harness drives before every judgement (M4.4). */
function kindLine(game: AnyRecord | null): string {
  if (!game?.kind || !GAME_KINDS[game.kind]) return "";
  return `GAME KIND: ${GAME_KINDS[game.kind].says}. Before every judgement the harness drives ${describePlayScript(playScriptFor(game))}, then photographs what that left.`;
}

/** The opening's head: who the builder is, the goal, the facet, and the contract when there is no brief. */
function openingHead(p: PromptInput): string[] {
  const { run, spec: facet, pointsAtBrief } = p;
  const scope = scopeLines(run);
  const vision = visionBriefLines(run);
  return [
    `You are building ONE FACET of a game inside Autopilot run ${run.runId}, iteration ${p.iteration}.`,
    ``,
    `GAME GOAL: ${run.goal}`,
    // What the user asked for, in their words, and what is cut (loop/scope.ts); nothing for a run without it.
    ...(scope ? [scope] : []),
    // Where the whole world is going (loop/vision.ts): the direction to grow toward; nothing without one.
    ...(vision ? [vision] : []),
    `PROJECT: ${run.project}`,
    // A game that declares no kind says nothing here.
    kindLine(p.game),
    // Eleven sections live in .studio/BRIEF.md and are rendered there only (M4.8b). What stays
    // in the prompt is what the brief cannot carry: who you are, the goal, the pointer at the
    // file, the user's own words, this iteration's move and fix, and the last build's news.
    !pointsAtBrief && run.reference?.name
      ? `REFERENCE / DIRECTION: ${run.reference.name}${run.reference?.notes ? ` — ${run.reference.notes}` : ""}`
      : "",
    ``,
    `YOUR FACET: ${facet.title}`,
    `INTENT: ${facet.intent ?? facet.brief}`,
    !pointsAtBrief && facet.identity?.length
      ? `IDENTITY FEATURES (ranked — a lower one is never polished while a higher one fails): ${facet.identity.join(" > ")}`
      : "",
    // What the loop will actually stop on, in the words the director wrote it in.
    !pointsAtBrief && facet.done?.length
      ? `DONE MEANS (this facet ends when these pass and the taste judge agrees):\n${facet.done.map((d: AnyRecord) => `- ${d.what} — measured by check ${d.id}`).join("\n")}`
      : "",
    ``,
    p.briefPointer,
    p.legacy || pointsAtBrief
      ? ``
      : `THE CONTRACT — these checks are verified mechanically after every build; a build is accepted only when it flips at least one to pass and regresses none:\n${renderChecks(p.spec.checks)}`,
    ``,
    p.worktree
      ? `You are working in an isolated copy of the game. Touch only what this facet needs — other facets are being built in parallel and their accepted work is merged into your copy between iterations.`
      : `Work only on this facet. Other facets get their own turns — do not start unrelated work.`,
    ``,
  ];
}

/**
 * Two paragraphs, because a worker builds in one of two worlds (M4.6). In the studio's
 * template a facet is a module under src/ and the entry carries a wiring block everyone adds
 * one line to. In a game the user brought there is no such block: the worker is given a seam —
 * a path, a folder or a glob — and everything else is somebody's existing code. Both, and the
 * four bullets under them, are in the brief when there is one.
 */
function ownershipLines(p: PromptInput): string[] {
  if (p.pointsAtBrief) return [];
  return p.ownShape ? seamOwnership(p) : templateOwnership(p);
}

function seamOwnership({ spec: facet, entryMain, ownsMain }: PromptInput): string[] {
  return [
    `YOUR SEAM IN THIS GAME (it is the user's own code — everything outside your seam already works):`,
    `- Your seam is ${facet.owns?.length ? facet.owns.join(", ") : "every file of this game except its entry module, the studio contract and index.html"}. Read what is around it before you change anything; follow the conventions the game already has rather than the ones you would have chosen.`,
    ownsMain
      ? `- This worker OWNS ${entryMain} and src/studio.js — you may restructure them, and you wire in other workers' modules when they appear.`
      : `- This worker does NOT own ${entryMain}, src/studio.js or index.html. If your work needs a change in one of them, say so in your summary and leave it: the director makes that edit, or gives it to whoever owns the entry.`,
    `- Do not rename, restyle, reformat or "clean up" files you did not have to change. A diff that touches ten files to change one is a diff nobody can land.`,
  ];
}

function templateOwnership({ spec: facet, entryMain, ownsMain }: PromptInput): string[] {
  return [
    `FILE OWNERSHIP (merge conflicts are the run's most expensive failure):`,
    `- Put this facet's work in its own module: ${facet.owns?.length ? facet.owns.join(", ") : `src/${facet.id.replace(/[^a-z0-9-]/g, "")}.js`} (split further under src/ if it grows).`,
    ownsMain
      ? `- This facet OWNS ${entryMain} and src/studio.js — you may restructure them, and you wire in other facets' modules when their import lines appear.`
      : `- This facet does NOT own ${entryMain} or src/studio.js. Touch ${entryMain} ONLY to add your single import + init line inside the "FACET WIRING" marker block (add the marker block if it is missing); never reformat or reorganise anything else in either file.`,
  ];
}

/** Notes, tags and the one-screen rule: the conventions the brief carries when there is one. */
function conventionLines(p: PromptInput): string[] {
  if (p.pointsAtBrief) return [];
  return [
    `- Keep your working notes in ${facetNotes(p.spec.id)} — do not edit the shared NOTES.md.`,
    `- Tag every object you create (obj.userData.tag = "<tag>") with the tag names the checks use. Untagged objects do not exist to the checks.`,
    p.ownShape ? ownShapeLine(p) : oneScreenLine(p),
  ];
}

/**
 * Who owns the screen (loop/screen-owner.ts), said in the prompt even when the brief carries the
 * rest: the owner draws the HUD, the menus and the layout, every other part publishes its values.
 * Nothing in a game of its own shape, where the rule is inert, or when no part owns the screen.
 */
function screenOwnerLines({ ownShape, spec }: PromptInput): string[] {
  const line = ownShape ? null : screenOwnerLine(spec);
  return line ? [line] : [];
}

function ownShapeLine({ entryMain, shape }: PromptInput): string {
  const built = shape?.build ? `, it is built with \`${shape.build}\`` : "";
  const runBuild = shape?.build
    ? ` Run \`${shape.build}\` before you finish: the studio runs the same build before every preview, and a build that fails is a black screen for every critic.`
    : "";
  return `- THIS GAME HAS ITS OWN SHAPE: its entry is ${entryMain}${built} and the studio serves ${shape?.entry ?? "index.html"}. Keep its UI and input handling as they are — no __studio.hud overlays, no second input path. Keep window.__studio working (installStudio in ${entryMain}).${runBuild}`;
}

function oneScreenLine({ spec: facet, run }: PromptInput): string {
  // Only the harness-owned checks this facet actually carries — under the declared-only rule a
  // board may carry none of them, and naming a check nobody scores teaches the wrong lesson.
  const harnessOnBoard = (facet.checks ?? [])
    .filter((c: AnyRecord) => HARNESS_CHECKS[c.id])
    .map((c: AnyRecord) => c.id);
  const one = harnessOnBoard.length === 1;
  const enforced = harnessOnBoard.length
    ? ` The harness-owned check${one ? "" : "s"} ${harnessOnBoard.join(", ")} enforce${one ? "s" : ""} this.`
    : "";
  // A game keeping an edited older HUD (held-hud.ts) is told only what that HUD draws.
  const draws =
    heldHudPromptDraws(run) ??
    "drawn into the canvas: text, bars, arcs and gauges, paths, images, panels and fonts, anchored in frame fractions; keep the middle of the view for the game — the harness measures the HUD's coverage and overlap";
  return `- ONE SCREEN, ONE INPUT PATH: all UI through __studio.hud (${draws}; no DOM, no second HUD); all input from ctx.keys / ctx.look / ctx.wheel (studio.js owns pointer lock and the mouse).${enforced} A label that belongs to something in the world — a player's name, a marker over a target — is a sprite or mesh in the scene, attached to that object and tagged with it (never hud), so it moves and hides with it; __studio.hud holds only what stays on the screen.`;
}

/** The last build's news: its failure, the legacy gap, or the board. */
function progressLines(p: PromptInput): string[] {
  if (p.failureText)
    return [
      "",
      `The previous attempt never reached verification — it failed before quality was in question. The actual errors, verbatim:`,
      p.failureText,
      `That is a failure report, not a design verdict. Fix that cause first — the same cause twice ends this facet. Deliver a build that loads and keeps window.__studio working.`,
    ];
  if (p.iteration > 1 && p.legacy) return legacyProgress(p);
  if (p.iteration > 1) return boardProgress(p);
  return [];
}

/** A prose-only facet's news: the defects from the last blind comparison. */
function legacyProgress({ defectList, loseStreak, gapHistory }: PromptInput): string[] {
  const lines: string[] =
    defectList.length > 1
      ? [
          "",
          `REMAINING DEFECTS IN THIS FACET (from the last blind comparison, worst first):`,
          ...defectList.map((defect: unknown, index: number) => `${index + 1}. ${defect}`),
        ]
      : [
          "",
          `THE SINGLE BIGGEST REMAINING GAP IN THIS FACET (from the last blind comparison):`,
          defectList[0] ?? "",
          "",
          `Close that one gap. Prefer a change the default camera can see.`,
        ];
  if (loseStreak >= 2)
    lines.push(
      "",
      `ESCALATE: your last ${loseStreak} challengers ALL LOST. Replace the mechanism behind the gap, and make the change unmistakable from the primary camera.`,
    );
  if (gapHistory.length > 1)
    lines.push(
      "",
      `EARLIER GAPS (newest first):`,
      ...gapHistory.slice(1).map((entry: AnyRecord) => `- iteration ${entry.iteration}: ${entry.gap}`),
    );
  return lines;
}

/** A checked facet's news: what still fails, what nobody could measure, and a losing streak. */
function boardProgress(p: PromptInput): string[] {
  const { board, loseStreak } = p;
  const { failing, unmeasuredNow } = boardState(board, p.spec);
  const lines: string[] = [];
  if (failing.length)
    lines.push(
      "",
      `STILL FAILING (identity first): ${cappedList(failing.map((e) => `${e.id} — ${String(e.reason).slice(0, FAILING_REASON_CHARS)}`)).join("; ")}`,
    );
  if (unmeasuredNow.length) lines.push("", unmeasuredLine(unmeasuredNow));
  if (loseStreak >= 2)
    lines.push(
      "",
      lossEscalate(
        p,
        `ESCALATE: ${loseStreak} losses in a row — parameter tweaks on the current approach have failed. Replace the mechanism.`,
      ),
    );
  return lines;
}

/** The judge's defect ledger on the current build, when the prompt carries it itself. */
function openingLedger(p: PromptInput): string[] {
  if (ledgerElsewhere(p)) return [];
  const { defectList } = p;
  return [
    "",
    `THE JUDGE'S DEFECT LEDGER on the current build (worst first; the worst are also vision checks on your board — fix as many as you can):`,
    ...defectList.slice(0, OPENING_LEDGER_DEFECTS).map((d: unknown, i: number) => `${i + 1}. ${d}`),
  ];
}

/** What to look at before coding: the attached images, the accepted build's shots, the reference stills. */
function imageLines({ acceptedShots, iteration, imagesAttached, pointsAtBrief }: PromptInput): string[] {
  const nothingToLookAt = !acceptedShots.length && iteration !== 1 && !imagesAttached;
  if (nothingToLookAt) return [];
  const attached =
    iteration === 1 ? " and the base build you start from" : " paired with your build (reference LEFT, yours RIGHT)";
  return [
    "",
    `LOOK AT IMAGES BEFORE YOU CODE:`,
    ...(imagesAttached
      ? [
          `- ${imagesAttached} images are ATTACHED to this message: the reference stills${attached}. They are the visual bar — materials, light, silhouette, palette.`,
        ]
      : []),
    ...(acceptedShots.length
      ? [`- screenshots of the current accepted build (Read these files): ${acceptedShots.join(", ")}`]
      : []),
    ...(pointsAtBrief
      ? []
      : [
          `- reference stills in references/ in your workspace — they are the visual bar. Compare them with the current build and close the gap you can SEE, not the one you imagine.`,
          `- the brief's "Distance to the references" section names the number per camera; an accepted build must not move it up.`,
        ]),
  ];
}

/** The requested state's setup, as the builder is told it. */
function setupLine(setup: AnyRecord): string {
  const how = setup.note ?? (setup.demo ? `demo "${setup.demo}"` : `${(setup.actions ?? []).length} input action(s)`);
  const equals = setup.verify && "equals" in setup.verify ? ` == ${JSON.stringify(setup.verify.equals)}` : "";
  const verified = setup.verify ? `, verified by ${setup.verify.path}${equals}` : "";
  return `THE REQUESTED STATE: the window opens on the state this run is about — the studio replays a setup script after every load (${how})${verified}. Every judge, every capture and the check "requested-state" look there, not at the boot screen. If a capture or screenshot says the state was not reached, that is the first thing to fix — the way a player reaches it, not by changing what the game boots into.`;
}

/** The demo ask, the builder's hands and eyes, and what to check before finishing. */
function closingLines({ run, worktree, pointsAtBrief }: PromptInput): string[] {
  return [
    ...(pointsAtBrief
      ? []
      : [
          "",
          `If this facet is behavioural (an interaction, a move, a beat), expose a deterministic demo of it via the studio contract (config.demos in installStudio) — demo checks run it and photograph its end frame.`,
        ]),
    ...(worktree
      ? [
          "",
          `YOU HAVE HANDS AND EYES — USE THEM: ${toolCall(roleEngine(run, RoleKey.Builder), "computer")} runs YOUR build (this worktree, uncommitted edits included) live in its own window and its own description lists every action it takes, down to the reload that picks up your edits; ${toolCall(roleEngine(run, RoleKey.Builder), "capture")} takes every registered camera in one go. Look after every meaningful change and fix what you SEE before finishing; do not finish without at least one frame that shows your change working from the primary camera.`,
          ...(run.setup ? [setupLine(run.setup)] : []),
        ]
      : []),
    "",
    `Before you finish:`,
    `- Re-read the checks and verify each one you can see in your frames. A check ignored every iteration becomes the run's final gap.`,
    `- Compare your captured frames against the accepted build's shots: if you cannot see your change, neither can the verifier — an invisible diff is rejected without a judge.`,
    ...(pointsAtBrief
      ? []
      : [
          `- Make sure the game still loads and window.__studio still works (installStudio with scene/renderer/camera/player) — a build that cannot be verified counts as a loss.`,
        ]),
  ];
}

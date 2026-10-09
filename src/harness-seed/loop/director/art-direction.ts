/**
 * The art director's part of a run: one absolute look at the whole integrated game
 * (loop/ship-review.ts), the defects it names routed to the parts that own them, and the finish
 * mark that makes the look happen without the lead asking.
 *
 * Every judge of a run compared — a round against the one before, integration against the
 * start — and a run could win thirty rounds that way while nobody asked whether the game was
 * good. At the finish mark (a timed build's last 30% of working time, `finishMarkMs`; a goal build
 * once, when its lead idles or finishes with no review on its head) the studio asks: would you
 * ship this as the user's demo today? The lead is woken with the answer and the defects by part,
 * and from there the owners finish their parts (`stage=finish`). Each defect is a question on its
 * owner's board in the director's name, so its fix keeps the round (a strong flip). The verdict
 * is reported, never a landing veto, and it turns a goal build's finish back at most once.
 *
 * Nor does the look wait for the mark: busy workers can keep a lead from ever idling, and nobody
 * would look at the whole game for hours. So the studio also looks on its own while
 * loop workers build (`shipLookAt`): once the first wave is in (every running loop worker has
 * kept work merged, or after `SHIP_LOOK_EVERY_MS` of working time), then every `SHIP_LOOK_EVERY_MS`
 * on a head it has not reviewed — never within `SHIP_LOOK_GAP_MS` before a timed build's mark,
 * whose own look takes its place. That regular look only routes defects: owners keep building,
 * and the finish stage still begins at the mark. Each review also names what already works and
 * must stay (`doNotRegress`): the latest list rides in every loop worker's spec, so its brief and
 * its taste judge hold the build to it.
 *
 * A new module, bound onto the run (director.ts `LOOP_RUN_MODULES`): callers in older modules reach
 * it through the run and check that it is there. It reads budgets.ts and rules.ts by namespace,
 * so a kept older copy of either never stops it linking.
 */
import { shortSha } from "../git.ts";
import { isRunning, WorkerMode } from "../outcomes.ts";
import { DEFAULT_CAMERA } from "../cameras.ts";
import { uniqueCheckId } from "../facet/defects.ts";
import { DefectSeverity } from "../ship-review.ts";
import { CheckKind, CheckOrigin, CheckWeight, type Check } from "../spec.ts";
import { clip, CLIP_QUOTE, CLIP_REASON } from "../text.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import { Against } from "../verdict.ts";
import * as budgetParts from "./budgets.ts";
import { goalCommission } from "./commission.ts";
import * as contractParts from "./module-contract.ts";
import * as ruleParts from "./rules.ts";
import { list, slug } from "./args.ts";
import { contractAloneOnStart } from "./contract-gate.ts";
import { isFinishing } from "../facet/stage.ts";
import { ART_SKIPPED, shipFinishRefusal, shipGateSkipped, shipSteer } from "./art-direction-prompts.ts";
import { BuildTarget } from "./loop-run.ts";
import { NoteKind } from "./wake-schedule.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { ShipDefect, ShipPart, ShipReview } from "../ship-review.ts";
import type { LoopRun, Worker } from "./loop-run.ts";
import type { ShelvedDefect } from "./rules.ts";

/**
 * This part serves a lead that is its chat's own session (one session): it builds in the integration
 * worktree by its full path and keeps no memory file. A run seats one only when every part it
 * depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/**
 * How soon after it starts the studio's own ship review must be done asking: it borrows the
 * studio's window as the close does, and a goal build's runs inside the lead's `finish` call,
 * which the engine gives up on after ten minutes.
 */
export const ART_DIRECTION_JUDGE_MS = 4 * MINUTE_MS;
/** The engine gives up on one tool call after this: a goal build's finish gate and its close share one `finish` call. */
const FINISH_CALL_MS = 10 * MINUTE_MS;
/** One look at a build, as a finish call budgets it (a big game's patient look). */
const LOOK_MS = 2 * MINUTE_MS;
/** What a finish call keeps beyond the gate and the close's own look and settle, for the answer and a slow host. */
const FINISH_MARGIN_MS = MINUTE_MS;
/** How long a close waits for stopped workers when a kept older budgets.ts does not say (budgets.ts `CLOSE_SETTLE_MS`). */
const CLOSE_SETTLE_FALLBACK_MS = 90 * SECOND_MS;
/** How many replacements deep a part's running owner is looked for (`replaces`), so a cycle never loops. */
const MAX_REPLACEMENTS = 8;
/** Who names a ship defect on a board and on the ledger: never a worker id. */
const ART_DIRECTOR = "art-director";
/** The ledger's owner of a defect no part owns: the lead's integration. */
const LEAD_OWNS = BuildTarget.Integration;
/** How much working time passes between the studio's regular looks at the whole game while workers build. */
export const SHIP_LOOK_EVERY_MS = 90 * MINUTE_MS;
/**
 * No regular look comes this soon before a timed build's finish mark (the mark looks itself), and
 * one the art director could not give is tried again after this much working time.
 */
const SHIP_LOOK_GAP_MS = 30 * MINUTE_MS;

/**
 * The art director's last word on the integration branch: the head it looked at, ship or not, its
 * defects, and what already works and must stay (absent from a journal written before the list).
 */
export interface LastShip {
  head: string | null;
  ship: boolean | null;
  defects: ShipDefect[];
  doNotRegress?: string[];
  at: number;
}

/** When the next regular look is due, as the wake loop keeps it, and the clocks it is read against. */
export interface ShipCadence {
  /** The working time the next look is due at; null until the first look of the run. */
  nextAtWorkedMs: number | null;
  now: number;
  /** When the finish mark comes, while it is unsaid (wake.ts `finishMarkView`), or null. */
  finishMarkAt: number | null;
}

/** One ship defect as a question on its owner's board: the part it is for (null: nobody's), and the check. */
export interface ShipRoute {
  part: string | null;
  defect: ShipDefect;
  check: Check;
}

/** What the studio's look at the finish mark found: the review, or why there was none. */
export interface ArtDirection {
  head: string | null;
  review: LastShip | null;
  skipped: string | null;
}

/** How the studio's own look is asked: what else the one look answers, as whose judge, and by when. */
export interface ArtDirectionAsk {
  /** More of the judge's arguments for the same look (the close's own question, at the finish gate). */
  ask?: AnyRecord;
  /** The look is the close's own judge of the head it makes live (`LastJudge.final`). */
  final?: boolean;
  /** How long its judge calls may take from the start of the pass. */
  judgeMs?: number;
  /**
   * The look is the finish look (the mark's, a goal build's finish gate): from it on, every owner
   * of a defect is told as a finisher. False for the regular look, after which owners keep building.
   */
  finishLook?: boolean;
}

/** The plan's parts as the art director is told them: the only ids a defect may name. */
export function shipParts(plan: AnyRecord | null | undefined): ShipPart[] {
  const workers: AnyRecord[] = Array.isArray(plan?.workers) ? plan.workers : [];
  return workers
    .filter((w) => typeof w?.id === "string" && w.id)
    .map((w) => ({ id: w.id, title: String(w.title ?? w.id), seam: String(w.seam ?? ""), owns: list(w.owns) }));
}

/** Can this worker take a question on its board now: a loop still running, with a spec. */
const takesShipDefects = (worker: Worker | undefined): worker is Worker & { spec: AnyRecord } =>
  Boolean(worker && isRunning(worker) && worker.mode === WorkerMode.Loop && worker.spec);

/**
 * The plan part a worker builds, as the contract gate reads it (module-contract.ts
 * `partOfWorker`): its own id, else the worker it restarts, else the goal it advances — whichever
 * is a part of the plan. A kept older module-contract.ts without it reads the goal alone.
 */
function planPartOf(plan: AnyRecord | null | undefined, worker: Worker): string | null {
  const partOf = (contractParts as { partOfWorker?: typeof contractParts.partOfWorker }).partOfWorker;
  if (typeof partOf === "function") return partOf(plan, [worker.id, worker.replaces, worker.goal]);
  return worker.goal ?? null;
}

/**
 * The worker that owns `part` now: the running loop worker of that id, or the running one that
 * replaced it (`worker_start replaces=`, followed through each replacement by its typed field) or
 * was started for it under another id (`goal=`, the plan part the contract gate gives it); else
 * the part's own worker, finished or not, or none.
 */
function ownerOf(
  workers: ReadonlyMap<string, Worker>,
  part: string | null,
  plan?: AnyRecord | null,
): Worker | undefined {
  if (!part) return undefined;
  const own = workers.get(part);
  if (takesShipDefects(own)) return own;
  const replacesPart = (worker: Worker): boolean => {
    let replaced = worker.replaces;
    for (let depth = 0; replaced && depth < MAX_REPLACEMENTS; depth++) {
      if (replaced === part) return true;
      replaced = workers.get(replaced)?.replaces ?? null;
    }
    return false;
  };
  const buildsPart = (worker: Worker): boolean => replacesPart(worker) || planPartOf(plan, worker) === part;
  return [...workers.values()].find((worker) => takesShipDefects(worker) && buildsPart(worker)) ?? own;
}

/**
 * The frame a ship defect's question is asked on: the camera it named (ship-review.ts keeps only
 * one the review was shown, `shownCameras`), else the default.
 */
const checkCamera = (camera: string | null): string => camera ?? DEFAULT_CAMERA;

/** A blocker or a visible defect decides whether the part is done; a nit counts and decides nothing. */
const weightOf = (defect: ShipDefect): string =>
  defect.severity === DefectSeverity.Nit ? CheckWeight.Normal : CheckWeight.Identity;

/** One ship defect as the director's own vision question: yes once the frame no longer shows it. */
function shipCheck(board: { checks: AnyRecord[] }, defect: ShipDefect): Check {
  const text = clip(defect.what, CLIP_REASON);
  return {
    id: uniqueCheckId(board, `ship-${text}`),
    kind: CheckKind.Vision,
    weight: weightOf(defect),
    hard: false,
    camera: checkCamera(defect.camera),
    ask: `Is this gone? "${clip(text, CLIP_QUOTE)}" — answer yes only if the frame no longer shows it.`,
    expect: "yes",
    origin: CheckOrigin.Director,
    defect: text,
    note: `the art director's ship review (${defect.severity})`,
    askedBy: ART_DIRECTOR,
  };
}

/** Is this question on a board the art director's own (`shipCheck`), by its typed field alone? */
const isShipCheck = (check: AnyRecord): boolean => check?.askedBy === ART_DIRECTOR;

/**
 * Runs whose finish look has begun: the finish mark's own pass, or a goal build's finish gate
 * (`artDirectionPass`). Its defects reach owners the lead has not flipped to `stage=finish` yet.
 */
const finishLooked = new WeakSet<LoopRun>();

/**
 * Is the run past its finish mark: its finish look has begun, or a wake said the mark (the
 * journal keeps that across a Resume, wake.ts `journalWake`)? From there every owner of a ship
 * defect is told as a finisher, so no steer puts a move ahead of finishing what exists.
 */
function pastFinishMark(loopRun: LoopRun): boolean {
  return finishLooked.has(loopRun) || loopRun.journal?.director?.wake?.finishMarkSaid === true;
}

/**
 * Take the art director's earlier questions off every running board the newest review does not
 * ask again, so a re-review swaps its set instead of adding to it: a re-review rewords the same
 * defect, and each reworded copy was one more identity question to answer before the part is done
 * and one more vision call a round. A question the newest review repeats word for word stays, with
 * its id. Answers the ids it took off, by worker.
 */
function retireShipChecks(loopRun: LoopRun, routes: readonly ShipRoute[]): Map<string, string[]> {
  const { state } = loopRun;
  const retired = new Map<string, string[]>();
  for (const worker of state.workers.values()) {
    if (!takesShipDefects(worker) || !Array.isArray(worker.spec.checks)) continue;
    const askedAgain = new Set(
      routes.filter((route) => ownerOf(state.workers, route.part) === worker).map((route) => route.check.defect),
    );
    const stale = (check: AnyRecord): boolean => isShipCheck(check) && !askedAgain.has(check.defect);
    const gone = worker.spec.checks.filter(stale).map((check: AnyRecord) => String(check.id));
    if (gone.length === 0) continue;
    worker.spec.checks = worker.spec.checks.filter((check: AnyRecord) => !stale(check));
    retired.set(worker.id, gone);
  }
  return retired;
}

/**
 * Every ship defect as a question for the part that owns it, by the part's id alone — never by
 * reading the defect's words. A running loop worker's ids are unique on its own board; a part with
 * no board (finished, a single session, never started) or no part at all gets a board of its own.
 */
export function shipDefectsToChecks(
  review: Pick<ShipReview, "defects">,
  workers: ReadonlyMap<string, Worker>,
  plan?: AnyRecord | null,
): ShipRoute[] {
  const boards = new Map<string, { checks: AnyRecord[] }>();
  const boardOf = (part: string | null): { checks: AnyRecord[] } => {
    const key = part ?? "";
    const known = boards.get(key);
    if (known) return known;
    const worker = ownerOf(workers, part, plan);
    const board = { checks: [...(takesShipDefects(worker) ? (worker.spec.checks ?? []) : [])] };
    boards.set(key, board);
    return board;
  };
  return review.defects.map((defect) => {
    const board = boardOf(defect.part);
    const check = shipCheck(board, defect);
    board.checks.push(check);
    return { part: defect.part, defect, check };
  });
}

/** A defect on the run's ledger, under the part (or the lead) it is for: the rules.ts shelf when it has one. */
function shelve(ledger: ShelvedDefect[], defect: { text: string; owner: string }): void {
  const fn = (ruleParts as { shelveDefect?: typeof ruleParts.shelveDefect }).shelveDefect;
  if (typeof fn === "function") {
    fn(ledger, { ...defect, from: ART_DIRECTOR });
    return;
  }
  if (!ledger.some((d) => d.text === defect.text)) ledger.push({ ...defect, from: ART_DIRECTOR, at: Date.now() });
}

/**
 * Put a ship question on a running worker's board and tell it — in words that follow the review's
 * verdict (`ship`), the defect's severity and the worker's stage (a finisher's, or anyone's past the
 * finish mark) — rules.ts's board when it has one, its router otherwise.
 */
function onBoard(
  loopRun: LoopRun,
  worker: Worker & { spec: AnyRecord },
  route: ShipRoute,
  ship: boolean | null = null,
): void {
  const { note, state } = loopRun;
  const put = (ruleParts as { putOnBoard?: typeof ruleParts.putOnBoard }).putOnBoard;
  if (typeof put !== "function") {
    ruleParts.makeRouteDefect({ workers: state.workers, from: ART_DIRECTOR, ledger: state.ledger, note })(
      worker.id,
      route.check,
    );
    return;
  }
  if (!put(worker.spec, route.check)) return;
  worker.steering.push(
    shipSteer({
      defect: String(route.check.defect),
      checkId: route.check.id,
      severity: route.defect.severity,
      ship,
      finishing: isFinishing(worker.spec) || pastFinishMark(loopRun),
    }),
  );
  note(
    `worker ${worker.id}: the art director's defect is on its board — "${clip(route.check.defect, CLIP_QUOTE)}"`,
    NoteKind.DefectRouted,
  );
}

/** Tell each worker which of the art director's earlier questions left its board. */
function tellRetired(loopRun: LoopRun, retired: ReadonlyMap<string, string[]>): void {
  for (const [id, gone] of retired) {
    loopRun.state.workers
      .get(id)
      ?.steering.push(
        `The art director looked at the whole game again: its earlier questions ${gone.join(", ")} are off your board — its newest review replaces them.`,
      );
  }
}

/**
 * The art director's do-not-regress list on a loop worker's spec, where its brief (library.ts
 * `renderBrief`) and its round's taste judge (judge.ts `tasteVeto`) read it. An empty list says nothing.
 */
function giveDoNotRegress(worker: Worker & { spec: AnyRecord }, doNotRegress: readonly string[]): void {
  worker.spec.doNotRegress = [...doNotRegress];
}

/**
 * Hand each ship defect to its owner: the running loop worker whose part it names gets it on its
 * board as the director's own question (its fix is a strong flip, so the round is kept); a part
 * that is finished, a single session or not started has it on the ledger under its id; a defect
 * no part owns is the lead's, on the ledger under the integration. A review with a verdict first
 * takes the earlier reviews' questions it does not ask again off the running boards, and gives every
 * running loop worker its do-not-regress list in place of the last one. Answers what went where.
 */
export function routeShipDefects(
  loopRun: LoopRun,
  review: Pick<ShipReview, "defects"> & Partial<Pick<ShipReview, "ship" | "doNotRegress">>,
): ShipRoute[] {
  const { note, state } = loopRun;
  const routes = shipDefectsToChecks(review, state.workers, state.plan);
  // Only a review with a verdict replaces the last one's questions and list: one nobody could read leaves them.
  if (typeof review.ship === "boolean") {
    tellRetired(loopRun, retireShipChecks(loopRun, routes));
    for (const worker of [...state.workers.values()].filter(takesShipDefects))
      giveDoNotRegress(worker, review.doNotRegress ?? []);
  }
  for (const route of routes) {
    const worker = ownerOf(state.workers, route.part, state.plan);
    if (takesShipDefects(worker)) {
      onBoard(loopRun, worker, route, review.ship ?? null);
      continue;
    }
    const owner = route.part ?? LEAD_OWNS;
    shelve(state.ledger, { text: String(route.check.defect), owner });
    note(
      `the art director's defect for ${owner} is on the run's ledger — "${clip(route.check.defect, CLIP_QUOTE)}"`,
      NoteKind.DefectShelved,
    );
  }
  return routes;
}

/**
 * The plan part a worker starting now builds: its own id, a worker it replaces (followed through
 * each replacement by its typed field), else its goal — whichever the plan names first.
 */
function partStartedOn(loopRun: LoopRun, worker: Worker): string | null {
  const { plan, workers } = loopRun.state;
  const parts = new Set(shipParts(plan).map((part) => part.id));
  const replaced: string[] = [];
  let next = worker.replaces;
  for (let depth = 0; next && depth < MAX_REPLACEMENTS; depth++) {
    replaced.push(next);
    next = workers.get(next)?.replaces ?? null;
  }
  return [worker.id, ...replaced, slug(worker.goal)].find((id) => parts.has(id)) ?? null;
}

/**
 * A shelved defect as the art director named it: its last look's defect with the same words for
 * that part (severity and camera kept), else a visible one on the default camera — a defect the
 * art director named and nobody fixed is one a player notices until a look says it is gone.
 */
function shelvedShipDefect(loopRun: LoopRun, part: string, text: string): ShipDefect {
  const named = (loopRun.state.lastShip?.defects ?? []).find(
    (defect) => defect.part === part && clip(defect.what, CLIP_REASON) === text,
  );
  return named ?? { what: text, camera: null, part, severity: DefectSeverity.Visible };
}

/** Is a ship question with these words on the worker's board now? */
const onItsBoard = (worker: Worker & { spec: AnyRecord }, check: Check): boolean =>
  (worker.spec.checks ?? []).some((c: AnyRecord) => c.defect === check.defect);

/**
 * A loop worker starting on a part (`worker_start`, its id, `replaces` or goal naming the plan
 * part) takes the art director's defects shelved under that part while nobody ran it: each goes on
 * its board as the director's own question, as a running owner's would (so a finish worker's
 * round ends only once a blocker or visible defect is gone), and leaves the ledger. Any loop worker
 * starting takes the art director's latest do-not-regress list too. Answers the routes it took.
 */
export function takeShelvedShipDefects(loopRun: LoopRun, worker: Worker): ShipRoute[] {
  const { ledger } = loopRun.state;
  if (!takesShipDefects(worker)) return [];
  const doNotRegress = loopRun.state.lastShip?.doNotRegress ?? [];
  if (doNotRegress.length) giveDoNotRegress(worker, doNotRegress);
  const part = partStartedOn(loopRun, worker);
  if (!part) return [];
  const shelved = ledger.filter((entry) => entry.from === ART_DIRECTOR && entry.owner === part);
  const taken: ShipRoute[] = [];
  for (const entry of shelved) {
    const defect = shelvedShipDefect(loopRun, part, entry.text);
    const route = { part, defect, check: shipCheck({ checks: worker.spec.checks ?? [] }, defect) };
    onBoard(loopRun, worker, route, loopRun.state.lastShip?.ship ?? null);
    if (!onItsBoard(worker, route.check)) continue;
    ledger.splice(ledger.indexOf(entry), 1);
    taken.push(route);
  }
  return taken;
}

/** Has the integration branch anything beyond the run's starting point at `head`? */
function movedBeyondStart(loopRun: LoopRun, head: string | null): head is string {
  const { baseCommit, state } = loopRun;
  if (!head || head === baseCommit || state.baseHeads.has(head)) return false;
  // The module contract written on the start alone is a document, not a build (contract-gate.ts).
  return !contractAloneOnStart(loopRun, head);
}

/** The art director's word on `head`, when its last look was at that head. */
export function shipReviewOn(loopRun: LoopRun, head: string | null): LastShip | null {
  const last = loopRun.state.lastShip ?? null;
  if (!last || !head) return null;
  return last.head === head ? last : null;
}

/**
 * Is a goal build owed the art director's look: its integration has moved, nothing says it does
 * not load, and no review stands on its head. A timed build has its finish mark instead.
 */
export function shipOwed(loopRun: LoopRun): boolean {
  const { run, state } = loopRun;
  const head = state.integrationHead;
  if (!goalCommission(run) || !movedBeyondStart(loopRun, head)) return false;
  return state.healthByHead.get(head) !== false && !shipReviewOn(loopRun, head);
}

/**
 * When a timed build reaches its finish mark (budgets.ts `finishMarkMs`, from the run's own
 * clock so a Resume keeps it), or null — a goal build, a short one, or a kept budgets.ts without it.
 */
export function finishMarkAt(loopRun: LoopRun): number | null {
  const markMs = (budgetParts as { finishMarkMs?: typeof budgetParts.finishMarkMs }).finishMarkMs;
  if (typeof markMs !== "function") return null;
  const clock = loopRun.clock ?? { started: loopRun.started, softDeadline: loopRun.softDeadline };
  const ms = markMs(loopRun.run, clock.softDeadline - clock.started);
  return ms === null ? null : clock.softDeadline - ms;
}

/** When the run's working time began on its own clock: a Resume's goes on from the time already worked. */
const workStarted = (loopRun: LoopRun): number => loopRun.clock?.started ?? loopRun.started;

/** The loop workers building now: those that take the art director's defects on their boards. */
const buildingWorkers = (loopRun: LoopRun): Worker[] => [...loopRun.state.workers.values()].filter(takesShipDefects);

/**
 * Is the run's first integration wave in: loop workers are building, and every one of them has
 * had kept work merged into the integration branch (integrate.ts marks it `integrated`).
 */
export function firstWaveIn(loopRun: LoopRun): boolean {
  const building = buildingWorkers(loopRun);
  return building.length > 0 && building.every((worker) => worker.integrated === true);
}

/**
 * Is there a whole game for the regular look to see: loop workers building, an integration beyond
 * the start that nothing says does not load, and no review standing on its head.
 */
function lookable(loopRun: LoopRun): boolean {
  const { state } = loopRun;
  const head = state.integrationHead;
  if (!buildingWorkers(loopRun).length || !movedBeyondStart(loopRun, head)) return false;
  return state.healthByHead.get(head) !== false && !shipReviewOn(loopRun, head);
}

/**
 * When the studio's regular look at the whole game is due, on the loop's clock, or null. The first
 * comes once the first wave is in, or after `SHIP_LOOK_EVERY_MS` of working time (one worker that
 * never keeps a round does not hold it back); each later one at the working time the cadence names.
 * None within `SHIP_LOOK_GAP_MS` before an unsaid finish mark — the mark looks itself — and none
 * once the working time is over.
 */
export function shipLookAt(loopRun: LoopRun, { nextAtWorkedMs, now, finishMarkAt }: ShipCadence): number | null {
  if (now >= loopRun.softDeadline || !lookable(loopRun)) return null;
  const started = workStarted(loopRun);
  const firstAt = firstWaveIn(loopRun) ? now : started + SHIP_LOOK_EVERY_MS;
  // A look already overdue happens now: it is now that must keep clear of the mark.
  const due = Math.max(now, nextAtWorkedMs === null ? firstAt : started + nextAtWorkedMs);
  const markLooks = finishMarkAt !== null && due >= finishMarkAt - SHIP_LOOK_GAP_MS;
  return markLooks ? null : due;
}

/**
 * The working time the next regular look is due at after a look that ended `now`: a whole
 * `SHIP_LOOK_EVERY_MS` after one the art director gave (the lead's own `judge ship=yes` and the
 * mark's count), `SHIP_LOOK_GAP_MS` after one it could not give.
 */
export function shipLookAfter(loopRun: LoopRun, { now, looked }: { now: number; looked: boolean }): number {
  return now - workStarted(loopRun) + (looked ? SHIP_LOOK_EVERY_MS : SHIP_LOOK_GAP_MS);
}

/**
 * The studio's regular look at the whole game (`shipLookAt`): the art director's pass, whose
 * defects go to their owners while they keep building — no finish mark, and no finish stage.
 */
export function shipLookPass(loopRun: LoopRun): Promise<ArtDirection> {
  return artDirectionPass(loopRun, { finishLook: false });
}

/**
 * The studio's own look at the finish mark: when the integration branch has moved beyond the start
 * and nothing says it does not load, the art director judges it (`judge ship=yes`, through the
 * studio's window when every other is taken, done by `ART_DIRECTION_JUDGE_MS`) and its defects go
 * to their owners. `how` lets the same look answer the close's own question (the finish gate).
 * From this look on the run is past its finish mark (`pastFinishMark`) — unless it is the
 * regular look (`finishLook: false`, `shipLookPass`). Answers the review, or why there was none.
 */
export async function artDirectionPass(loopRun: LoopRun, how: ArtDirectionAsk = {}): Promise<ArtDirection> {
  const { ctx, note, state } = loopRun;
  const { ask = {}, final = false, judgeMs = ART_DIRECTION_JUDGE_MS, finishLook = true } = how;
  if (finishLook) finishLooked.add(loopRun);
  const head = (await loopRun.syncHead().catch(() => null)) ?? state.integrationHead;
  if (ctx.cancelled) return { head, review: null, skipped: ART_SKIPPED.stopped };
  if (!movedBeyondStart(loopRun, head)) return { head, review: null, skipped: ART_SKIPPED.nothingNew };
  if (state.healthByHead.get(head) === false) return { head, review: null, skipped: ART_SKIPPED.doesNotLoad };
  const judged = { ...ask, target: BuildTarget.Integration, against: Against.None, ship: "yes" };
  // `until` is read by the judge (tools.ts), which holds its calls to the wall clock: the same clock here.
  await loopRun
    .judge(judged, { borrow: true, final, until: Date.now() + judgeMs })
    .catch((err: unknown) =>
      note(`the art director could not judge ${shortSha(head)}: ${clip((err as Error)?.message ?? err, CLIP_REASON)}`),
    );
  const review = shipReviewOn(loopRun, head);
  return { head, review, skipped: review ? null : ART_SKIPPED.notJudged };
}

/**
 * How long the finish gate's judge may take from its start: one `finish` call holds the gate's
 * look and judge, then the close's settle and its own look, inside the engine's ten minutes.
 */
function finishGateJudgeMs(): number {
  const settle = (budgetParts as { CLOSE_SETTLE_MS?: number }).CLOSE_SETTLE_MS ?? CLOSE_SETTLE_FALLBACK_MS;
  return Math.min(ART_DIRECTION_JUDGE_MS, FINISH_CALL_MS - settle - LOOK_MS - FINISH_MARGIN_MS);
}

/**
 * The judge the close still owes the head (tools.ts `closeJudgeAsk`): null when a judge on that
 * head already holds its word, undefined under a kept older tools.ts that cannot say.
 */
function closeJudgeOwed(loopRun: LoopRun): AnyRecord | null | undefined {
  if (typeof loopRun.closeJudgeAsk !== "function") return undefined;
  return loopRun.closeJudgeAsk(loopRun.state.integrationHead);
}

/**
 * A goal build's finish with no review on its head: the art director looks once, and a "no" turns
 * the finish back once, with the defects — never twice, never for the user's own finish, never in
 * the wrap-up (no time to act on it). The look runs inside the lead's `finish` call, so it is
 * bounded by `finishGateJudgeMs` and answers the close's own question too, so the close does not
 * judge the head again; when the close still owes a blind judge against the start, there is no
 * time for both, and the finish closes without it. `now` is the clock the working deadline is
 * read on (a test's, or the wall clock). Answers the refusal, or null to close.
 */
export async function shipFinishGate(
  loopRun: LoopRun,
  userEnds: boolean,
  now: () => number = Date.now,
): Promise<string | null> {
  const { ctx, note, state } = loopRun;
  const notOurs = userEnds || ctx.cancelled || state.shipFinishRefused === true;
  const noTimeToAct = now() >= loopRun.softDeadline;
  if (notOurs || noTimeToAct) return null;
  if (!shipOwed(loopRun)) return null;
  const owed = closeJudgeOwed(loopRun);
  if (owed === undefined) return null;
  if (owed && owed.against !== Against.None) {
    note(shipGateSkipped(state.integrationHead));
    return null;
  }
  const how = owed ? { ask: { question: owed.question }, final: true } : {};
  const { review } = await artDirectionPass(loopRun, { ...how, judgeMs: finishGateJudgeMs() });
  if (review?.ship !== false) return null;
  state.shipFinishRefused = true;
  await loopRun.saveJournal();
  return shipFinishRefusal(review);
}

/** What the report says of the art director's look at the head it closed on, or null when it looked at another. */
export function shipReport(loopRun: LoopRun): AnyRecord | null {
  const review = shipReviewOn(loopRun, loopRun.state.integrationHead);
  if (!review) return null;
  return {
    head: review.head,
    ship: review.ship,
    defectsLeft: review.defects.length,
    blockers: review.defects.filter((d) => d.severity === DefectSeverity.Blocker).length,
    doNotRegress: review.doNotRegress ?? [],
    at: new Date(review.at).toISOString(),
  };
}

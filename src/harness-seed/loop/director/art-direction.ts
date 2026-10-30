/**
 * The art director's part of a run: one absolute look at the whole integrated game
 * (loop/ship-review.ts) when the lead asks for it (`judge ship=yes`), the defects it names routed to
 * the parts that own them, and the finish mark, a timed build's last 30% of working time
 * (`finishMarkMs`), when the lead is told to finish what exists.
 *
 * The look is a second opinion (Loop phase 4): the studio never runs it on its own — not at the
 * finish mark, not on a cadence while workers build, not at a goal build's finish — and its verdict
 * turns nothing back. Each blocker it names is a question on its owner's board in the director's
 * name (normal weight: it never holds a part's own contract), and each review names what already
 * works and must stay (`doNotRegress`), which rides in every loop worker's brief.
 *
 * A new module, bound onto the run (director.ts `LOOP_RUN_MODULES`): callers in older modules reach
 * it through the run and check that it is there. It reads budgets.ts and rules.ts by namespace,
 * so a kept older copy of either never stops it linking.
 */
import { isRunning, WorkerMode } from "../outcomes.ts";
import { DEFAULT_CAMERA } from "../cameras.ts";
import { uniqueCheckId } from "../facet/defects.ts";
import { DefectSeverity } from "../ship-review.ts";
import { blockersOf } from "../ship-blockers.ts";
import { CheckKind, CheckOrigin, CheckWeight, type Check } from "../spec.ts";
import { clip, CLIP_QUOTE, CLIP_REASON } from "../text.ts";
import * as budgetParts from "./budgets.ts";
import * as contractParts from "./module-contract.ts";
import * as ruleParts from "./rules.ts";
import { list, slug } from "./args.ts";
import { isFinishing } from "../facet/stage.ts";
import { shipSteer } from "./art-direction-prompts.ts";
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

/** How many replacements deep a part's running owner is looked for (`replaces`), so a cycle never loops. */
const MAX_REPLACEMENTS = 8;
/** Who names a ship defect on a board and on the ledger: never a worker id. */
const ART_DIRECTOR = "art-director";
/** The ledger's owner of a defect no part owns: the lead's integration. */
const LEAD_OWNS = BuildTarget.Integration;
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

/** One ship defect as a question on its owner's board: the part it is for (null: nobody's), and the check. */
export interface ShipRoute {
  part: string | null;
  defect: ShipDefect;
  check: Check;
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
const weightOf = (_defect: ShipDefect): string => CheckWeight.Normal;

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
 * Is the run past its finish mark: a wake said the mark (the journal keeps that across a Resume,
 * wake.ts `journalWake`)? From there every owner of a ship defect is told as a finisher, so no steer
 * puts a move ahead of finishing what exists.
 */
function pastFinishMark(loopRun: LoopRun): boolean {
  return loopRun.journal?.director?.wake?.finishMarkSaid === true;
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
 * Hand each blocker to its owner: the running loop worker whose part it names gets it on its board
 * as the director's own question (its fix is a strong flip, so the round is kept); a part that is
 * finished, a single session or not started has it on the ledger under its id; a blocker no part
 * owns is the lead's, on the ledger under the integration. A visible flaw or a nit starts and steers
 * no round: it stays on the review, for the user's report. A review with a verdict first takes the
 * earlier reviews' questions it does not ask again off the running boards, and gives every running
 * loop worker its do-not-regress list in place of the last one. Answers what went where.
 */
export function routeShipDefects(
  loopRun: LoopRun,
  review: Pick<ShipReview, "defects"> & Partial<Pick<ShipReview, "ship" | "doNotRegress">>,
): ShipRoute[] {
  const { note, state } = loopRun;
  const routes = shipDefectsToChecks({ defects: blockersOf(review.defects) }, state.workers, state.plan);
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
 * that part (severity and camera kept), else a blocker on the default camera — only a blocker is
 * shelved, and one nobody fixed blocks until a look says it is gone.
 */
function shelvedShipDefect(loopRun: LoopRun, part: string, text: string): ShipDefect {
  const named = (loopRun.state.lastShip?.defects ?? []).find(
    (defect) => defect.part === part && clip(defect.what, CLIP_REASON) === text,
  );
  return named ?? { what: text, camera: null, part, severity: DefectSeverity.Blocker };
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
    // Shelved before only blockers were work: the report has it, and no round takes it.
    if (defect.severity !== DefectSeverity.Blocker) {
      ledger.splice(ledger.indexOf(entry), 1);
      continue;
    }
    const route = { part, defect, check: shipCheck({ checks: worker.spec.checks ?? [] }, defect) };
    onBoard(loopRun, worker, route, loopRun.state.lastShip?.ship ?? null);
    if (!onItsBoard(worker, route.check)) continue;
    ledger.splice(ledger.indexOf(entry), 1);
    taken.push(route);
  }
  return taken;
}

/** The art director's word on `head`, when its last look was at that head. */
export function shipReviewOn(loopRun: LoopRun, head: string | null): LastShip | null {
  const last = loopRun.state.lastShip ?? null;
  if (!last || !head) return null;
  return last.head === head ? last : null;
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

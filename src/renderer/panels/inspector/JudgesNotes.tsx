/**
 * The judges' full notes on one try, read in place in its step's card: the verdict, the checks,
 * what they named, the liveness critic, and what comes next.
 */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import {
  checkWords,
  type FacetNode,
  GraphNodeKind,
  type IterationNode,
  IterationStatus,
  type Liveness,
  plainDefect,
  plannedFlips,
  type RunGraph as RunGraphModel,
  roundStep,
  type Scoreboard,
} from "../../run-graph.ts";
import { checkCounts, sideBySideWords, stoppedWords, undoneBecause, verdictSentence } from "../../words.ts";
import { capitalise } from "./format.ts";

/** The most failing checks and named defects the sheet lists. */
const FAILING_SHOWN = 10;
const DEFECTS_SHOWN = 12;
/** A liveness principle is scored out of this. */
const PRINCIPLE_MAX = 3;

const ALIVE_WORDS: Record<string, string> = {
  light: t("light"),
  extent: t("how far the world goes"),
  scales: t("things at every size"),
  purpose: t("every object has a reason to be there"),
  life: t("movement and inhabitants"),
  wear: t("age and weather on things"),
};

const aliveWord = (key: string): string => ALIVE_WORDS[key] ?? key;

/** The principle the critic scored lowest, first of equals. */
function weakestPrinciple(alive: Liveness | null): { key: string; score: number } | null {
  let worst: { key: string; score: number } | null = null;
  for (const principle of alive?.principles ?? []) {
    if (principle.score === null) continue;
    if (!worst || principle.score < worst.score) worst = { key: principle.key, score: principle.score };
  }
  return worst;
}

/** The verdict in words: the judges' own sentence, else why it was undone or kept. */
function verdictWords(node: IterationNode, problem: string, flips: string[]): string {
  const written = verdictSentence(node.verdict);
  if (written) return written;
  if (node.status === IterationStatus.Rolled) {
    const reason = undoneBecause(node.verdictSource);
    if (!problem) return t("Undone — {reason}.", { reason });
    return t("Undone — {reason}. The reviewers' biggest objection: {objection}.", {
      reason,
      objection: problem.replace(/\.$/, ""),
    });
  }
  if (node.satisfied)
    return t(
      "Kept, and the reviewers are satisfied with this part: every identity check passes and the side-by-side reviewer has nothing left to ask.",
    );
  if (!flips.length)
    return t(
      "Kept. No check changed, but the step landed and the side-by-side reviewer preferred the new build to the one before.",
    );
  return t(
    "Kept. {count, plural, one {# check that failed before now passes} other {# checks that failed before now pass}}, nothing that passed before broke, and the side-by-side reviewer did not object.",
    { count: flips.length },
  );
}

/** What the builder is asked next: the next try's step, or why there is none. */
function nextWords(next: IterationNode | null, facet: FacetNode | null): string {
  if (next) return roundStep(next);
  if (facet?.stoppedBecause)
    return t("Nothing — this part has stopped ({reason}).", { reason: stoppedWords(facet.stoppedBecause) });
  if (facet?.satisfied) return t("Nothing — this part is done.");
  return t("Not decided yet.");
}

function CheckIds({ title, ids }: { title: string; ids: string[] }): JSX.Element | null {
  if (!ids.length) return null;
  return (
    <>
      <p>
        <strong>{title}</strong>
      </p>
      <ul>
        {ids.map((id) => (
          <li key={id}>{capitalise(checkWords(id))}</li>
        ))}
      </ul>
    </>
  );
}

function StillFailing({ board, problem }: { board: Scoreboard; problem: string }): JSX.Element {
  const failing = board.results.filter((row) => row.pass === false);
  if (!failing.length) return <p>{t("Nothing is failing.")}</p>;
  return (
    <>
      <p>
        <strong>{t("Still failing")}</strong>
        {problem ? <> {t("— the biggest of them: {problem}", { problem })}</> : null}
      </p>
      <ul>
        {failing.slice(0, FAILING_SHOWN).map((row) => (
          <li key={row.id}>
            {capitalise(checkWords(row.id))}
            {row.reason ? <span className="text-ink-3"> — {row.reason}</span> : null}
          </li>
        ))}
        {failing.length > FAILING_SHOWN ? (
          <li className="text-ink-3">{t("and {count} more", { count: failing.length - FAILING_SHOWN })}</li>
        ) : null}
      </ul>
    </>
  );
}

function Checks({ node, problem }: { node: IterationNode; problem: string }): JSX.Element | null {
  const board = node.scoreboard;
  if (!board) return null;
  return (
    <>
      <h3>{t("Checks — {counts}", { counts: checkCounts(board) })}</h3>
      <CheckIds title={t("Newly passing")} ids={plannedFlips(node)} />
      <CheckIds title={t("Broke again")} ids={board.regressions} />
      <StillFailing board={board} problem={problem} />
    </>
  );
}

function Named({ defects }: { defects: string[] }): JSX.Element | null {
  if (!defects.length) return null;
  return (
    <>
      <h3>{t("What the reviewers named")}</h3>
      <ul>
        {defects.slice(0, DEFECTS_SHOWN).map((defect, index) => (
          <li key={index}>{plainDefect(defect)}</li>
        ))}
      </ul>
    </>
  );
}

function Weakest({ alive }: { alive: Liveness }): JSX.Element | null {
  const weakest = weakestPrinciple(alive);
  if (weakest)
    return (
      <p>{t("Six things the critic looks for; the weakest here is {thing}.", { thing: aliveWord(weakest.key) })}</p>
    );
  if (alive.biggest) return <p>{t("The weakest thing: {thing}.", { thing: aliveWord(alive.biggest) })}</p>;
  return null;
}

function Alive({ alive }: { alive: Liveness | null }): JSX.Element | null {
  if (!alive || alive.total === null) return null;
  const explained = alive.principles.some((principle) => principle.reason || principle.fix);
  return (
    <>
      <h3>{t("Does it feel alive? {score} of {max}", { score: alive.total, max: alive.max ?? "?" })}</h3>
      {alive.summary ? <p>{alive.summary}</p> : null}
      <Weakest alive={alive} />
      {explained ? (
        <ul>
          {alive.principles.map((principle) => (
            <li key={principle.key}>
              <strong>{capitalise(ALIVE_WORDS[principle.key] ?? principle.title ?? principle.key)}</strong>
              {principle.score !== null
                ? ` · ${t("{score} of {max}", { score: principle.score, max: PRINCIPLE_MAX })}`
                : ""}
              {principle.reason ? ` — ${principle.reason}` : ""}
              {principle.fix ? <span className="text-ink-3"> {t("Fix: {fix}", { fix: principle.fix })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The try after this one in the same part, when there is one. */
const nextTry = (graph: RunGraphModel, node: IterationNode): IterationNode | null =>
  graph.nodes
    .filter((item): item is IterationNode => item.kind === GraphNodeKind.Iteration)
    .find((item) => item.facetId === node.facetId && item.iteration === node.iteration + 1) ?? null;

/** The verdict, unless the card above the notes already quotes the same sentence. */
function Verdict({ node, problem, quoted }: { node: IterationNode; problem: string; quoted: string }): JSX.Element {
  const words = verdictWords(node, problem, plannedFlips(node));
  return (
    <>
      {words === quoted ? null : (
        <>
          <h3>{t("Verdict")}</h3>
          <p>{words}</p>
        </>
      )}
      {node.reason ? (
        <p className="text-ink-3">{t("In the reviewers' words: {words}", { words: plainDefect(node.reason) })}</p>
      ) : null}
    </>
  );
}

/** The judges' notes on one try, inside its card; long notes scroll in place. */
export function JudgesNotes({
  node,
  graph,
  quoted,
}: {
  node: IterationNode;
  graph: RunGraphModel;
  /** what the card already quotes the judges saying about this try */
  quoted: string;
}): JSX.Element {
  const facet = graph.facets.find((item) => item.facetId === node.facetId) ?? null;
  const problem = plainDefect(node.biggestGap);
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region takes focus so the keyboard can scroll it
      tabIndex={0}
      aria-label={t("Reviewers' notes")}
      className="graph-sheet max-h-[360px] overflow-y-auto rounded-[10px] bg-inset px-3.5 py-3 select-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Verdict node={node} problem={problem} quoted={quoted} />
      <Checks node={node} problem={problem} />
      <Named defects={node.defects} />
      <h3>{t("Side by side with the build before")}</h3>
      <p>{sideBySideWords({ status: node.status, satisfied: node.satisfied, source: node.verdictSource })}</p>
      <Alive alive={node.liveness} />
      <h3>{t("What the worker is asked next")}</h3>
      <p>{nextWords(nextTry(graph, node), facet)}</p>
    </section>
  );
}

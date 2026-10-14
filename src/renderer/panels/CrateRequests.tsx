/**
 * The person's card for crates Rust games asked for (extension ladder level 4): each request with
 * its crate, game, reason and what Genex read of its closure (licence, size, build scripts, proc
 * macros), and, while it waits, Approve and Decline with separate switches for build scripts and
 * proc macros (`studio:crates.decide`). The closure is read and checked only after the approval
 * (crates.io is reached on the person's approval alone), so a waiting request says so. A decided
 * request says where it ended, naming the crate a check stopped (the requested one or one it
 * brings in), and, once its closure was checked, what the checks found: the advisories as of the
 * snapshot's day, the licence, any banned crate, each trusted source's audit, the notice, and
 * behind "How it was checked" the engines and the snapshot. Agents only ask; only this card decides.
 */
import { Fragment, type JSX, useCallback, useEffect, useState } from "react";
import {
  type CrateCheckReport,
  type CrateRequestView,
  CrateDecision,
  CrateRequestState,
} from "../../shared/crate-requests.ts";
import { Button } from "../ui/Button.tsx";
import { Toggle } from "../ui/Toggle.tsx";
import { CRATE_REQUEST_WORDS, problemWords } from "../words.ts";

/** One waiting request's switches and whether its decision is on its way. */
interface Choice {
  buildScripts: boolean;
  procMacros: boolean;
  deciding: boolean;
}

const NO_CHOICE: Choice = { buildScripts: false, procMacros: false, deciding: false };

type CheckRow = readonly [key: string, label: string, value: string];

/** Labelled rows of what a check found, each value carrying its `data-crate-check-row` key. */
function RowList({ rows, ...rest }: { rows: readonly CheckRow[]; "data-crate-check"?: string }): JSX.Element {
  return (
    <dl {...rest} className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs leading-snug">
      {rows.map(([key, label, value]) => (
        <Fragment key={key}>
          <dt className="text-ink-3">{label}</dt>
          <dd data-crate-check-row={key} className="m-0 text-pretty text-ink-2">
            {value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** What the checks found in a decided request's closure: one labelled row each, its notice, then how it was checked. */
function CheckRows({ report }: { report: CrateCheckReport }): JSX.Element {
  const words = CRATE_REQUEST_WORDS;
  const banned = words.banned(report);
  const rows: readonly CheckRow[] = [
    ["advisories", words.check.advisories, words.advisories(report)],
    ["licence", words.check.licence, words.licence(report)],
    ...(banned ? [["banned", words.check.banned, banned] as const] : []),
    ...(report.audits.length > 0 ? [["audits", words.check.audits, words.audits(report)] as const] : []),
  ];
  const how: readonly CheckRow[] = [
    ["engine", words.check.engine, words.engine(report)],
    ["snapshot", words.check.snapshot, words.snapshot(report)],
  ];
  return (
    <>
      <RowList data-crate-check={report.engine} rows={rows} />
      {report.notice && (
        <span data-crate-notice={report.notice} className="text-xs leading-snug text-pretty text-ink">
          {words.notice[report.notice]}
        </span>
      )}
      <details data-crate-check-details className="text-xs leading-snug">
        <summary className="w-fit cursor-pointer text-ink-3 hover:text-ink-2">{words.check.details}</summary>
        <div className="pt-1">
          <RowList rows={how} />
        </div>
      </details>
    </>
  );
}

/** One request: what it is, what was read of it, and its decision controls or outcome. */
function RequestRow({
  view,
  choice,
  onChoice,
  onDecide,
}: {
  view: CrateRequestView;
  choice: Choice;
  onChoice: (choice: Choice) => void;
  onDecide: (decision: CrateDecision) => void;
}): JSX.Element {
  const words = CRATE_REQUEST_WORDS;
  const waiting = view.state === CrateRequestState.Pending;
  return (
    <li data-crate-request={view.requestId} className="flex flex-col gap-1.5 py-2">
      <span className="flex min-w-0 items-baseline justify-between gap-4">
        <span className="min-w-0 truncate font-mono text-xs text-ink" title={`${view.name} ${view.version}`}>
          {view.name} {view.version}
        </span>
        <span className="shrink-0 text-xs text-ink-3">{words.forGame(view.project)}</span>
      </span>
      {view.reason && <span className="text-xs leading-snug text-pretty text-ink-2">{view.reason}</span>}
      <span data-crate-facts className="text-xs leading-snug text-pretty text-ink-3">
        {words.facts(view)}
      </span>
      {waiting && view.refusal && (
        <span role="status" data-crate-retry={view.refusal} className="text-xs leading-snug text-pretty text-ink-2">
          {words.refusal[view.refusal]}
        </span>
      )}
      {waiting ? (
        <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Toggle
            size="sm"
            on={choice.buildScripts}
            label={words.allowBuildScripts}
            disabled={choice.deciding}
            onChange={(buildScripts) => onChoice({ ...choice, buildScripts })}
          />
          <Toggle
            size="sm"
            on={choice.procMacros}
            label={words.allowProcMacros}
            disabled={choice.deciding}
            onChange={(procMacros) => onChoice({ ...choice, procMacros })}
          />
          <span className="ml-auto flex gap-2">
            <Button
              data-crate-decline={view.requestId}
              variant="secondary"
              disabled={choice.deciding}
              onClick={() => onDecide(CrateDecision.Decline)}
            >
              {words.decline}
            </Button>
            <Button
              data-crate-approve={view.requestId}
              variant="accent-outline"
              disabled={choice.deciding}
              onClick={() => onDecide(CrateDecision.Approve)}
            >
              {choice.deciding ? words.approving : words.approve}
            </Button>
          </span>
        </span>
      ) : (
        <>
          <span
            role="status"
            data-crate-outcome={view.refusal ?? view.state}
            className="text-xs leading-snug text-pretty text-ink-3"
          >
            {words.outcome(view)}
          </span>
          {view.check && <CheckRows report={view.check} />}
        </>
      )}
    </li>
  );
}

/** Every crate request, newest first, with the person's decision on each waiting one. Nothing when there are none. */
export function CrateRequests({ project }: { project?: string }): JSX.Element | null {
  const [views, setViews] = useState<readonly CrateRequestView[]>([]);
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setViews(await window.studio.cratesList(project));
    } catch (cause) {
      setError(problemWords(cause));
    }
  }, [project]);
  useEffect(() => {
    void load();
  }, [load]);
  if (views.length === 0 && error === null) return null;
  const choiceOf = (requestId: string) => choices[requestId] ?? NO_CHOICE;
  const setChoice = (requestId: string, choice: Choice) =>
    setChoices((current) => ({ ...current, [requestId]: choice }));
  const decide = async (view: CrateRequestView, decision: CrateDecision) => {
    const choice = choiceOf(view.requestId);
    setChoice(view.requestId, { ...choice, deciding: true });
    setError(null);
    try {
      const { buildScripts, procMacros } = choice;
      await window.studio.cratesDecide({ requestId: view.requestId, decision, buildScripts, procMacros });
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setChoice(view.requestId, { ...choice, deciding: false });
      await load();
    }
  };
  return (
    <section data-crate-requests className="flex flex-col gap-1">
      <span className="text-body-sm font-medium text-ink">{CRATE_REQUEST_WORDS.title}</span>
      <span className="text-xs leading-snug text-pretty text-ink-3">{CRATE_REQUEST_WORDS.intro}</span>
      <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
        {views.map((view) => (
          <RequestRow
            key={view.requestId}
            view={view}
            choice={choiceOf(view.requestId)}
            onChoice={(choice) => setChoice(view.requestId, choice)}
            onDecide={(decision) => void decide(view, decision)}
          />
        ))}
      </ul>
      {error && (
        <span role="alert" className="text-xs leading-snug text-red">
          {error}
        </span>
      )}
    </section>
  );
}

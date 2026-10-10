/**
 * The Genex plugin's page, below its title: the account card, the tools it routes, the skills it
 * gives agents and what it is. The page is app-wide: one balance covers every game,
 * a game's own spend is in its usage panel, and Publish lives on the game's stage.
 */
import type { JSX } from "react";
import { GenexAction } from "../../../../shared/genex.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { Button } from "../../../ui/Button.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { GENEX_WORDS } from "../../../words.ts";
import { PluginApproval } from "../../PluginApproval.tsx";
import { Information, PluginNotes, PluginSkills, UpdateButton } from "../detail-parts.tsx";
import { isActive } from "../labels.ts";
import type { PluginsPage } from "../page.ts";
import { Section } from "../rows.tsx";
import type { ShownSkill } from "../skills-sections.ts";
import { GenexAccount } from "./GenexAccount.tsx";
import { type GenexJobRow, genexJobRows, JobState } from "./genex-view.ts";
import { ROUTED_TOOLS, toolCopy } from "./routed-tools.ts";
import { type GenexLive, useGenexStatus } from "./use-genex-status.ts";

/** The tools Genex routes, each with its mark and what it does. */
function RoutedTools(): JSX.Element {
  const words = GENEX_WORDS.router;
  return (
    <Section title={words.toolsTitle} count={ROUTED_TOOLS.length} hooks={{ "data-genex-tools": "" }}>
      <p className="genex-section-intro">{words.toolsIntro}</p>
      <ul className="genex-tools">
        {ROUTED_TOOLS.map(({ id, mark }) => {
          const tool = toolCopy(id);
          return (
            <li key={id} className="genex-tool" data-genex-tool={id}>
              <span className="genex-tool-mark" aria-hidden="true">
                <img src={mark} alt="" draggable={false} />
              </span>
              <span className="genex-tool-copy">
                <span className="genex-tool-name">{tool.name}</span>
                <span className="genex-tool-line">{tool.line}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** One Review button: a candidate's number, or the remesh. */
function ReviewButton({ id, candidate, live }: { id: string; candidate: number | null; live: GenexLive }): JSX.Element {
  return (
    <Button
      disabled={live.running !== null}
      onClick={() => void live.act(GenexAction.Approve, { id, ...(candidate ? { candidate } : {}) })}
    >
      {GENEX_WORDS.review.button(candidate)}
    </Button>
  );
}

/** A preview candidate: its picture above its Review button, so the person chooses by looking. */
function CandidateReview({
  row,
  candidate,
  live,
}: {
  row: GenexJobRow;
  candidate: number;
  live: GenexLive;
}): JSX.Element {
  const picture = row.pictures[candidate];
  return (
    <div className="genex-candidate" data-genex-candidate={candidate}>
      {picture && (
        <img
          className="genex-candidate-picture"
          src={picture}
          alt={GENEX_WORDS.review.picture(candidate)}
          draggable={false}
        />
      )}
      <ReviewButton id={row.id} candidate={candidate} live={live} />
    </div>
  );
}

/** One generation that waits for the person: what it is, and a Review button per candidate. */
function ReviewRow({ row, live }: { row: GenexJobRow; live: GenexLive }): JSX.Element {
  return (
    <li className="genex-job" data-genex-job={row.state}>
      <span className="genex-job-icon" aria-hidden="true">
        <Icon name={row.icon} size={16} />
      </span>
      <span className="genex-job-copy">
        <span className="genex-job-title">{row.label}</span>
      </span>
      <span className="genex-job-state" data-state={row.state}>
        {GENEX_WORDS.state[row.state]}
      </span>
      <div className="genex-job-actions">
        {row.candidates.map((candidate) =>
          candidate === null ? (
            <ReviewButton key="remesh" id={row.id} candidate={null} live={live} />
          ) : (
            <CandidateReview key={candidate} row={row} candidate={candidate} live={live} />
          ),
        )}
      </div>
    </li>
  );
}

/**
 * The open game's generations that wait for the person (a character's candidates, a remesh):
 * the page is app-wide, but a decision only the person can make is shown where they look for Genex.
 */
function WaitingForReview({ live }: { live: GenexLive }): JSX.Element | null {
  const rows = genexJobRows(live.status?.jobs ?? []).filter((row) => row.state === JobState.Review);
  if (!rows.length) return null;
  return (
    <Section title={GENEX_WORDS.review.title} count={rows.length} hooks={{ "data-genex-review": "" }}>
      <ul className="genex-jobs">
        {rows.map((row) => (
          <ReviewRow key={row.id} row={row} live={live} />
        ))}
      </ul>
    </Section>
  );
}

/** The account card (the shared balance, never a game's spend) and what waits for review in the open game. */
function LiveAccount({ detail, page }: { detail: PluginInfo; page: PluginsPage }): JSX.Element {
  const live = useGenexStatus(detail, page.project);
  return (
    <>
      <GenexAccount live={live} problem={page.error} />
      <WaitingForReview live={live} />
      {live.review && <PluginApproval review={live.review} onClose={live.closeReview} />}
    </>
  );
}

/** The Genex page below its title. */
export function GenexDetail({
  detail,
  page,
  onSkill,
}: {
  detail: PluginInfo;
  page: PluginsPage;
  onSkill: (skill: ShownSkill) => void;
}): JSX.Element {
  const active = isActive(detail);
  return (
    <div className="genex-page">
      <PluginNotes detail={detail} />
      <div className="extensions-detail-actions">
        <UpdateButton detail={detail} page={page} />
      </div>
      {active ? (
        <LiveAccount detail={detail} page={page} />
      ) : (
        <>
          <p className="genex-off">{GENEX_WORDS.account.off}</p>
          {page.error && (
            <p role="alert" className="extensions-error">
              {page.error}
            </p>
          )}
        </>
      )}
      <RoutedTools />
      <PluginSkills detail={detail} onSkill={onSkill} />
      <Information detail={detail} />
    </div>
  );
}

/**
 * Live's frame profile strip for a Rust game (game-systems PROF-7), above the stage like the
 * device row: closed by default, and only while the person has it open does it poll the game's
 * summary (`studio:native.profile`). Open, it shows the frame-time sparkline with hitch marks and
 * the 60 fps line, the slowest scopes (the game's own marked), memory against its budgets, and,
 * when the person times GPU passes, each pass's time.
 */
import { type JSX, useEffect, useState } from "react";
import { type GameProject, GameStack, stackOf } from "../../../shared/game-project.ts";
import { type GpuNodeRow, memoryRows, type ScopeRow, sparklineOf, topScopeRows } from "../../live-profile.ts";
import { useLiveProfile } from "../../state/hooks.ts";
import { type LiveProfileGame, liveProfileOf, liveProfileStoreFor } from "../../state/live-profile.ts";
import { studio } from "../../state/studio.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { PROFILE_WORDS } from "../../words.ts";

/** The sparkline's drawing box (scaled to the strip's width). */
const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 40;

/** What the open strip's body shows: a profile, why there is none, or that it is reading. */
function bodyState(profile: LiveProfileGame): string {
  if (profile.failed) return "failed";
  if (profile.unavailable) return profile.unavailable;
  return profile.summary ? "summary" : "reading";
}

function Sparkline({ profile }: { profile: LiveProfileGame }): JSX.Element {
  const line = sparklineOf(profile.history, SPARK_WIDTH, SPARK_HEIGHT);
  return (
    <svg
      role="img"
      aria-label={PROFILE_WORDS.sparkline}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      className="h-10 w-full overflow-visible"
    >
      <line
        x1={0}
        x2={SPARK_WIDTH}
        y1={line.budgetY}
        y2={line.budgetY}
        stroke="var(--color-line-strong)"
        strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
      />
      {line.hitches.map((x) => (
        <line
          key={x}
          data-stage-profile-hitch=""
          x1={x}
          x2={x}
          y1={0}
          y2={SPARK_HEIGHT}
          stroke="var(--color-orange)"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polyline
        points={line.gpu}
        fill="none"
        stroke="var(--color-green)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={line.cpu}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ScopeRows({ rows }: { rows: ScopeRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-xs font-medium text-ink-2">{PROFILE_WORDS.scopes}</h3>
      <ul className="grid gap-0.5">
        {rows.map((row) => (
          <li
            key={row.scope}
            data-stage-profile-scope={row.game ? "game" : "engine"}
            className="flex items-baseline gap-2 text-xs"
          >
            <span className="min-w-0 truncate font-mono text-ink">{row.scope}</span>
            {row.game ? <span className="text-accent-ink">{PROFILE_WORDS.gameScope}</span> : null}
            <span className="ms-auto shrink-0 font-mono text-ink-3 tabular-nums">{PROFILE_WORDS.ms(row.ms)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemoryRows({ profile }: { profile: LiveProfileGame }): JSX.Element | null {
  const rows = profile.summary ? memoryRows(profile.summary) : [];
  if (rows.length === 0) return null;
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-xs font-medium text-ink-2">{PROFILE_WORDS.memory}</h3>
      <ul className="grid gap-1">
        {rows.map((row) => (
          <li key={row.name} data-stage-profile-memory={row.over ? "over" : "within"} className="grid gap-0.5 text-xs">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 truncate font-mono text-ink">{row.name}</span>
              <span className={`ms-auto shrink-0 tabular-nums ${row.over ? "text-red" : "text-ink-3"}`}>
                {PROFILE_WORDS.mib(row.mib, row.budgetMib)}
                {row.over ? ` · ${PROFILE_WORDS.overBudget}` : ""}
              </span>
            </span>
            {row.fraction === null ? null : (
              <span className="h-1 overflow-hidden rounded-full bg-inset">
                <span
                  className={`block h-full rounded-full ${row.over ? "bg-red" : "bg-ink-3"}`}
                  style={{ width: `${Math.round(row.fraction * 100)}%` }}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PassRows({ nodes }: { nodes: readonly GpuNodeRow[] }): JSX.Element {
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-xs font-medium text-ink-2">{PROFILE_WORDS.passes}</h3>
      {nodes.length === 0 ? (
        <p className="text-xs text-ink-3">{PROFILE_WORDS.passesWaiting}</p>
      ) : (
        <ul className="grid gap-0.5">
          {nodes.map((row) => (
            <li key={row.node} data-stage-profile-node={row.node} className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 truncate font-mono text-ink">{row.node}</span>
              <span className="ms-auto shrink-0 font-mono text-ink-3 tabular-nums">{PROFILE_WORDS.ms(row.ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The open strip's profile: the sparkline and its line, then scopes, memory and the armed passes. */
function ProfileBody({ project, profile, onNotice }: { project: string; profile: LiveProfileGame; onNotice: Notify }) {
  const [arming, setArming] = useState(false);
  const summary = profile.summary;
  if (!summary) return null;
  const arm = (): void => {
    setArming(true);
    liveProfileStoreFor(studio().api)
      .arm(project, !profile.armed)
      .catch(notifyProblem(onNotice))
      .finally(() => setArming(false));
  };
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Sparkline profile={profile} />
        <p className="flex flex-wrap gap-x-3 text-xs text-ink-3 tabular-nums">
          <span>{PROFILE_WORDS.times(summary.cpu.p95, summary.gpu?.p95 ?? null)}</span>
          <span>{PROFILE_WORDS.hitches(summary.hitches.count)}</span>
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ScopeRows rows={topScopeRows(summary)} />
        <MemoryRows profile={profile} />
      </div>
      {profile.armed ? <PassRows nodes={profile.nodes} /> : null}
      <span>
        <Button data-stage-profile-arm={profile.armed ? "on" : "off"} busy={arming} onClick={arm}>
          {profile.armed ? PROFILE_WORDS.disarm : PROFILE_WORDS.arm}
        </Button>
      </span>
    </div>
  );
}

/** The line the open strip says when it has no profile to show. */
function bodyLine(profile: LiveProfileGame): string | null {
  if (profile.failed) return PROFILE_WORDS.failed;
  if (profile.unavailable) return PROFILE_WORDS.unavailable[profile.unavailable];
  return profile.summary ? null : PROFILE_WORDS.reading;
}

/** The strip for `game`, or nothing for a game that is not a Rust game. */
export function ProfileStrip({ game, onNotice }: { game: GameProject; onNotice: Notify }): JSX.Element | null {
  const project = game.name;
  const rust = stackOf(game.shape) === GameStack.RustWgpu;
  const profile = useLiveProfile((state) => liveProfileOf(state, project));
  // Leaving the game (or the stage) closes its strip, so nothing polls a game nobody looks at.
  useEffect(() => () => liveProfileStoreFor(studio().api).close(project), [project]);
  if (!rust) return null;
  const store = liveProfileStoreFor(studio().api);
  const toggle = (): void => (profile.open ? store.close(project) : store.open(project));
  const line = profile.open ? bodyLine(profile) : null;
  return (
    <div
      data-stage-profile={profile.open ? "open" : "closed"}
      data-stage-profile-state={profile.open ? bodyState(profile) : ""}
      className="grid shrink-0 gap-2 border-b border-line bg-surface px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="text-body-sm font-medium text-ink">{PROFILE_WORDS.heading}</span>
        {line ? (
          <span role="status" className="min-w-0 flex-1 truncate text-xs text-ink-3">
            {line}
          </span>
        ) : null}
        <Button className="ms-auto" data-stage-profile-toggle="" aria-expanded={profile.open} onClick={toggle}>
          {profile.open ? PROFILE_WORDS.hide : PROFILE_WORDS.show}
        </Button>
      </div>
      {profile.open ? <ProfileBody project={project} profile={profile} onNotice={onNotice} /> : null}
    </div>
  );
}

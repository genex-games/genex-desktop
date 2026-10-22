/**
 * Harness Activity: what needs a decision, what each run delivered and what Harness has learned.
 * Every row expands in place. The header holds the one switch for self-improvement.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import type { EventEnvelope, GameProject, SelfChange, StagedProposal } from "../types.ts";
import type { RunOutcomeKind, StudioActivityItem } from "../../shared/studio-activity.ts";
import { useRunSummary } from "../use-run-summary.ts";
import { Button } from "../ui/Button.tsx";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { Icon } from "../ui/icons.tsx";
import { Switch } from "../ui/switch.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { DisclosureBody, ExactEdit, SuggestionReview, TurningChevron } from "../ui/ProposalsTable.tsx";
import { patchDiff } from "../edit-diff.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { intlLocale, t } from "../../shared/i18n.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { ACTIVITY_WORDS, problemWords } from "../words.ts";
import { Pending } from "../ui/Pending.tsx";

/** How many runs the list shows at first, and how many more each "Show earlier runs" adds. */
const RUNS_PAGE = 20;
/** A burst of new events reloads the feed once, this long after the last of them. */
const RELOAD_AFTER_EVENT_MS = 300;
/** How long the Look button shows what it found before offering the check again. */
const CHECK_RESULT_MS = 4 * SECOND_MS;
/** The most lines of a learned change's diff the exact-edit view shows. */
const DIFF_LINES_SHOWN = 300;
/** Every event of the improvement search starts with this. */
const SKILLOPT_EVENTS = "skillopt.";

interface Props {
  events: EventEnvelope[];
  games: GameProject[];
  onStagedCount: (count: number) => void;
  onPlayCommit: (project: string, commit: string) => void;
  onOpenGame: (project: string) => void;
  onNewGame: () => void;
  /** Back to the game chat the person was last in, ready to type. */
  onStartBuilding: () => void;
}

const OUTCOME: Record<RunOutcomeKind, { label: string; tone: string; sentence: string }> = {
  running: {
    label: t("Running"),
    tone: "bg-accent-tint text-accent-ink",
    sentence: t("Harness is still building. The game chat shows its progress."),
  },
  delivered: { label: t("New build"), tone: "bg-green-tint text-green", sentence: t("A new build is ready to play.") },
  none: {
    label: t("No build"),
    tone: "bg-orange-tint text-orange",
    sentence: t("No new build was delivered. Your game is as you left it."),
  },
  failed: {
    label: t("Failed"),
    tone: "bg-red-tint text-red",
    sentence: t("The run stopped because of an error. Your game is as you left it."),
  },
  stopped: {
    label: t("Stopped"),
    tone: "bg-orange-tint text-orange",
    sentence: t("The run was stopped before it finished."),
  },
  unknown: {
    label: t("Unknown"),
    tone: "bg-inset text-ink-3",
    sentence: t("Harness could not read how this run ended."),
  },
};
const when = (at: string) =>
  new Date(at).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One row of a list card: the whole header is the toggle, and the body opens beneath it. */
function ExpandRow({
  label,
  header,
  trailing,
  children,
  ...props
}: { label?: string; header: ReactNode; trailing?: ReactNode; children: ReactNode } & Record<
  `data-${string}`,
  string | undefined
>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div {...props} className="border-b border-line last:border-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-(--duration-quick) aria-[expanded=false]:hover:bg-ink/[0.03]"
      >
        {header}
        {trailing}
        <TurningChevron open={open} />
      </button>
      <DisclosureBody id={id} open={open}>
        {children}
      </DisclosureBody>
    </div>
  );
}

function RowText({ title, meta, muted = false }: { title: string; meta: string; muted?: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span title={title} className={`truncate ${muted ? "text-ink-3" : "text-ink"}`}>
        {title}
      </span>
      <span className="truncate text-chat-sub text-ink-3">{meta}</span>
    </span>
  );
}

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-chat-sub font-medium ${tone}`}
    >
      {children}
    </span>
  );
}

function ListCard({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-card bg-surface shadow-card">{children}</div>;
}

/** Where the Look for improvements button stands; the value is its `data-look-state`. */
const LookState = {
  Idle: "idle",
  Looking: "looking",
  Found: "found",
  Added: "added",
  None: "none",
} as const;
type LookState = (typeof LookState)[keyof typeof LookState];
const LOOK: Array<{ state: LookState; label: string; icon?: "spinner" | "check" }> = [
  { state: LookState.Idle, label: t("Look for improvements") },
  { state: LookState.Looking, label: t("Looking…"), icon: "spinner" },
  { state: LookState.Found, label: t("Found"), icon: "check" },
  { state: LookState.Added, label: t("Added"), icon: "check" },
  { state: LookState.None, label: t("Nothing new") },
];

/** One button that shows its own progress and result. Labels cross-fade in one cell while the
 * button's width follows the visible label, so it always hugs its text. */
function LookButton({ state, onClick }: { state: LookState; onClick: () => void }) {
  const labels = useRef<Partial<Record<LookState, HTMLSpanElement | null>>>({});
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const measure = () => {
      const next = labels.current[state]?.offsetWidth;
      if (next) setWidth(next);
    };
    measure();
    // Fonts and zoom change the text's width after the first measurement.
    const observer = new ResizeObserver(measure);
    for (const label of Object.values(labels.current)) if (label) observer.observe(label);
    return () => observer.disconnect();
  }, [state]);
  return (
    <Button
      variant="secondary"
      data-look-state={state}
      disabled={state === LookState.Looking}
      aria-label={t("Look for improvements in recent builds")}
      onClick={onClick}
      className="shrink-0"
    >
      {/* Every label is centred on the same point; the box clips to the visible one as it resizes. */}
      <span
        className="relative block h-5 overflow-hidden transition-[width] duration-(--duration-fast) ease-(--ease-smooth-out) motion-reduce:transition-none"
        style={{ width }}
      >
        {LOOK.map((item) => (
          <span
            key={item.state}
            data-look-label={item.state}
            ref={(element) => {
              labels.current[item.state] = element;
            }}
            aria-hidden
            className={`absolute top-0 left-1/2 flex h-5 -translate-x-1/2 items-center gap-2 whitespace-nowrap transition-opacity duration-(--duration-fast) ease-(--ease-smooth-out) motion-reduce:transition-none ${item.state === state ? "opacity-100" : "pointer-events-none opacity-0"}`}
          >
            {item.icon === "spinner" && (
              <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" />
            )}
            {item.icon === "check" && <Icon name="check" size={14} />}
            {item.label}
          </span>
        ))}
      </span>
    </Button>
  );
}

/** Self-improvement, shared with Settings through the host's settings.changed event. */
function useLearningSwitch(setError: (error: string | null) => void) {
  const [learning, setLearning] = useState<boolean | null>(null);
  useEffect(() => {
    void window.studio
      .settings()
      .then((settings) => setLearning(settings.learning))
      .catch(() => {});
  }, []);
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        if (event.type === UiEvent.SettingsChanged) setLearning(event.payload.learning !== false);
      }),
    [],
  );
  const switchLearning = (next: boolean) => {
    setLearning(next);
    setError(null);
    void window.studio
      .setSettings({ learning: next })
      .then((settings) => setLearning(settings.learning))
      .catch((cause) => {
        setLearning(!next);
        setError(problemWords(cause));
      });
  };
  return { learning, switchLearning };
}

/** What a load counted: the suggestions waiting and the improvements applied. */
type Tally = { staged: number; learned: number };

const countLearned = (items: StudioActivityItem[]): number =>
  items.filter((item) => item.kind === "improvement").length;

/** The activity feed and Harness's own changes: loaded now, again shortly after each new event; the latest load wins. */
function useActivity(onStagedCount: (count: number) => void, latestEvent: string | undefined) {
  const [items, setItems] = useState<StudioActivityItem[]>([]);
  const [changes, setChanges] = useState<SelfChange[]>([]);
  const [staged, setStaged] = useState<StagedProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async (): Promise<Tally | null> => {
    const current = ++generation.current;
    try {
      const [activity, self] = await Promise.all([window.studio.studioActivity(), window.studio.selfChanges()]);
      if (current !== generation.current) return null;
      setItems(activity);
      setChanges(self.changes);
      setStaged(self.staged);
      onStagedCount(self.staged.length);
      setError(null);
      return { staged: self.staged.length, learned: countLearned(activity) };
    } catch (cause) {
      if (current === generation.current) setError(problemWords(cause));
      return null;
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [onStagedCount]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every new event is a reason to reload
  useEffect(() => {
    const timer = setTimeout(() => void load(), RELOAD_AFTER_EVENT_MS);
    return () => clearTimeout(timer);
  }, [latestEvent, load]);
  return { items, changes, staged, loading, error, setError, load };
}

/** What a finished check found, by comparing the counts before and after it. */
function checkResult(before: Tally, after: Tally): { state: LookState; note: string } {
  const found = after.staged - before.staged;
  const applied = after.learned - before.learned;
  if (found > 0)
    return {
      state: LookState.Found,
      note: t("Found {count, plural, one {# new suggestion} other {# new suggestions}} at the top of Activity.", {
        count: found,
      }),
    };
  if (applied > 0)
    return {
      state: LookState.Added,
      note: t("Applied {count, plural, one {# improvement} other {# improvements}}.", { count: applied }),
    };
  return { state: LookState.None, note: t("Nothing new to suggest.") };
}

/** Looking for improvements on demand: the button's state, and what it found once the look finishes. */
function useImprovementCheck(activity: ReturnType<typeof useActivity>) {
  const { load, setError } = activity;
  const [check, setCheck] = useState<LookState>(LookState.Idle);
  const [checkNote, setCheckNote] = useState("");
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beforeCheck = useRef<Tally | null>(null);
  const report = useCallback((before: Tally | null, after: Tally | null): void => {
    if (!before || !after) {
      setCheck(LookState.Idle);
      return;
    }
    // The button itself reports the result for a moment, then offers the check again.
    const result = checkResult(before, after);
    setCheck(result.state);
    setCheckNote(result.note);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      setCheck(LookState.Idle);
      setCheckNote("");
    }, CHECK_RESULT_MS);
  }, []);
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        if (!event.type.startsWith(SKILLOPT_EVENTS)) return;
        if (event.type === UiEvent.SkilloptFailed) {
          setCheck(LookState.Idle);
          beforeCheck.current = null;
          setError(problemWords(event.payload?.error ?? t("Could not look for improvements. Try again.")));
          return;
        }
        const done = event.type === UiEvent.SkilloptFinished;
        void load().then((after) => {
          if (!done) return;
          const before = beforeCheck.current;
          beforeCheck.current = null;
          report(before, after);
        });
      }),
    [load, report, setError],
  );
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );
  const findImprovements = () => {
    if (settle.current) clearTimeout(settle.current);
    setCheck(LookState.Looking);
    setError(null);
    setCheckNote("");
    beforeCheck.current = { staged: activity.staged.length, learned: countLearned(activity.items) };
    void window.studio.startSkillOpt().catch((cause) => {
      setCheck(LookState.Idle);
      beforeCheck.current = null;
      setError(problemWords(cause));
    });
  };
  return { check, checkNote, findImprovements };
}

/** A self-update that failed and was not followed by a restore: the one recovery the user must act on. */
function unrecoveredFailure(items: StudioActivityItem[]): StudioActivityItem | null {
  const recoveries = items.filter((item) => item.kind === "recovery");
  const failed = recoveries.find((item) => item.restartFailed);
  if (!failed) return null;
  const restored = recoveries.some((item) => Boolean(item.snapshotId) && item.at >= failed.at);
  return restored ? null : failed;
}

function ActivityHeader({
  learning,
  onLearning,
}: {
  learning: boolean | null;
  onLearning: (next: boolean) => void;
}): JSX.Element {
  return (
    <header className="titlebar-drag window-controls-end sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-canvas px-4">
      <h1 className="text-title font-medium">{ACTIVITY_WORDS.title}</h1>
      {learning !== null && (
        <label
          data-learning-switch
          title={ACTIVITY_WORDS.learningHint}
          className="no-drag flex cursor-pointer items-center gap-2 text-chat-sub text-ink-2"
        >
          {ACTIVITY_WORDS.learning}
          <Switch checked={learning} onCheckedChange={onLearning} aria-label={ACTIVITY_WORDS.learning} />
        </label>
      )}
    </header>
  );
}

function RunRow({
  item,
  games,
  onPlayCommit,
  onOpenGame,
}: {
  item: StudioActivityItem;
  games: GameProject[];
  onPlayCommit: Props["onPlayCommit"];
  onOpenGame: Props["onOpenGame"];
}): JSX.Element {
  const game = games.find((candidate) => candidate.name === item.project);
  const outcome = OUTCOME[item.outcome ?? "unknown"];
  const running = item.outcome === "running";
  const where = game?.title ?? item.project ?? "";
  const at = when(item.at);
  const meta = running ? t("{game} · started {time}", { game: where, time: at }) : `${where} · ${at}`;
  return (
    <ExpandRow
      data-activity-kind="run"
      label={`${item.title}, ${outcome.label}`}
      header={
        <>
          <GameAvatar cover={game?.cover} />
          <RowText title={item.title} meta={meta} />
        </>
      }
      trailing={
        <Pill tone={outcome.tone}>
          {running && (
            <span
              aria-hidden
              className="size-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
            />
          )}
          {outcome.label}
        </Pill>
      }
    >
      <RunDetails item={item} game={game} onPlayCommit={onPlayCommit} onOpenGame={onOpenGame} />
    </ExpandRow>
  );
}

function RecentRuns({
  runs,
  games,
  limit,
  onMore,
  onPlayCommit,
  onOpenGame,
}: {
  runs: StudioActivityItem[];
  games: GameProject[];
  limit: number;
  onMore: () => void;
  onPlayCommit: Props["onPlayCommit"];
  onOpenGame: Props["onOpenGame"];
}): JSX.Element | null {
  if (!runs.length) return null;
  return (
    <section aria-labelledby="activity-runs" data-studio-feed className="flex flex-col gap-3">
      <h2 id="activity-runs" className="font-medium text-ink">
        {t("Recent runs")}
      </h2>
      <ListCard>
        {runs.slice(0, limit).map((item) => (
          <RunRow key={item.id} item={item} games={games} onPlayCommit={onPlayCommit} onOpenGame={onOpenGame} />
        ))}
      </ListCard>
      {runs.length > limit && (
        <button type="button" className="chat-disclosure cursor-pointer" onClick={onMore}>
          {t("Show earlier runs")}
        </button>
      )}
    </section>
  );
}

/** Who let a learned change land. */
const APPROVED_BY: Record<NonNullable<StudioActivityItem["approvedBy"]>, string> = {
  auto: t("Applied automatically"),
  human: t("You approved"),
};

/** What a learned change says about itself: its summary lines, or why it is undone. */
function LearnedStory({ item }: { item: StudioActivityItem }): JSX.Element | null {
  if (item.summary?.length)
    return (
      <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
        {item.summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  if (!item.undone) return null;
  return (
    <p className="text-ink-2">
      {item.undoneByUser
        ? t("You undid this change. Harness works the way it did before.")
        : t("A later restore took this change back. Harness works the way it did before.")}
    </p>
  );
}

function LearnedRow({
  item,
  change,
  busy,
  onUndo,
}: {
  item: StudioActivityItem;
  change: SelfChange | undefined;
  busy: boolean;
  onUndo: (from: string) => void;
}): JSX.Element {
  const how = item.approvedBy ? APPROVED_BY[item.approvedBy] : t("Applied");
  const plain = !item.summary?.length && !item.undone;
  const plainDetail = !change && plain ? item.detail : undefined;
  return (
    <ExpandRow
      data-activity-kind="improvement"
      label={item.title}
      header={
        <RowText
          title={item.title}
          muted={item.undone}
          meta={`${item.undone ? t("Undone") : how} · ${when(item.at)}`}
        />
      }
      trailing={item.undone ? <Pill tone="bg-orange-tint text-orange">{t("Undone")}</Pill> : undefined}
    >
      <div className="flex flex-col items-start gap-3 px-3.5 pt-0.5 pb-4">
        <LearnedStory item={item} />
        {change && (
          <ExactEdit
            inline={plain}
            file={change.file}
            notes={item.detail !== change.reason ? item.detail : undefined}
            lines={patchDiff(change.diff, DIFF_LINES_SHOWN)}
          />
        )}
        {plainDetail && <p className="text-ink-2 [overflow-wrap:anywhere]">{plainDetail}</p>}
        {change && !item.undone && (
          <Button variant="secondary" disabled={busy} onClick={() => onUndo(change.from)}>
            {t("Undo this change")}
          </Button>
        )}
      </div>
    </ExpandRow>
  );
}

function LearnedSection({
  learned,
  changes,
  learning,
  hasRuns,
  improvement,
  busy,
  onUndo,
}: {
  learned: StudioActivityItem[];
  changes: SelfChange[];
  learning: boolean | null;
  hasRuns: boolean;
  improvement: ReturnType<typeof useImprovementCheck>;
  busy: boolean;
  onUndo: (from: string) => void;
}): JSX.Element {
  const { check, checkNote, findImprovements } = improvement;
  return (
    <section aria-labelledby="activity-learned" data-studio-learned className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 max-w-[480px] flex-col gap-0.5">
          <h2 id="activity-learned" className="font-medium text-ink">
            {t("What Harness has learned")}
          </h2>
          <p className="text-chat-sub text-ink-3">
            {learning === false
              ? t("Self-improvement is off. Harness isn’t learning from new builds.")
              : t("Harness looks at your finished builds for better ways to build.")}
          </p>
          <span role="status" className="sr-only">
            {check === LookState.Looking ? t("Looking for improvements") : checkNote}
          </span>
        </div>
        {/* Improvements are mined from runs, so there is nothing to look at before one. */}
        {learning !== false && hasRuns && <LookButton state={check} onClick={findImprovements} />}
      </div>
      {learned.length > 0 && (
        <ListCard>
          {learned.map((item) => (
            <LearnedRow
              key={item.id}
              item={item}
              change={changes.find((candidate) => candidate.from === item.snapshotId)}
              busy={busy}
              onUndo={onUndo}
            />
          ))}
        </ListCard>
      )}
    </section>
  );
}

/** One review action at a time, reloading the feed after it and keeping its error for the page. */
function useReviewAction(activity: ReturnType<typeof useActivity>) {
  const [busy, setBusy] = useState(false);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    activity.setError(null);
    try {
      await action();
      await activity.load();
    } catch (cause) {
      activity.setError(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  // Descending, so earlier indices stay valid while the staged list shrinks.
  const each = (indices: number[], act: (index: number) => Promise<unknown>) =>
    perform(async () => {
      for (const index of [...indices].sort((a, b) => b - a)) await act(index);
    });
  return { busy, perform, each };
}

function ActivityNotices({
  activity,
  problem,
}: {
  activity: ReturnType<typeof useActivity>;
  problem: StudioActivityItem | null;
}): JSX.Element {
  return (
    <>
      {activity.error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-red">
          {activity.error}
          <Button variant="ghost" onClick={() => void activity.load()}>
            {t("Retry")}
          </Button>
        </div>
      )}
      {activity.loading && <Pending label={t("Loading activity…")} />}
      {problem && (
        <div role="alert" data-studio-problem className="flex flex-col gap-1 rounded-card bg-red-tint px-4 py-3">
          <p className="font-medium text-ink">{t("Harness couldn’t restore itself after a failed update")}</p>
          <p className="text-chat-sub text-ink-2">
            {problem.detail
              ? t("Quit and reopen the app so it can repair itself. {detail}", { detail: problem.detail })
              : t("Quit and reopen the app so it can repair itself.")}
          </p>
        </div>
      )}
    </>
  );
}

/** The first look at Harness says what it is; the way on is the game, not another game. */
function ActivityEmpty({
  hasGames,
  onNewGame,
  onStartBuilding,
}: {
  hasGames: boolean;
  onNewGame: () => void;
  onStartBuilding: () => void;
}): JSX.Element {
  const action = hasGames ? (
    <Button variant="default" onClick={onStartBuilding}>
      {t("Start building")}
    </Button>
  ) : (
    <Button variant="default" onClick={onNewGame}>
      {t("New game")}
    </Button>
  );
  return (
    <div className="grid flex-1 place-items-center p-8">
      <EmptyState
        data-activity-empty=""
        art="harness"
        title={t("A self-improving harness")}
        subtitle={t("Runs and improvements will show up here.")}
        action={action}
      />
    </div>
  );
}

export function ReviewPanel({
  events,
  games,
  onStagedCount,
  onPlayCommit,
  onOpenGame,
  onNewGame,
  onStartBuilding,
}: Props): JSX.Element {
  const activity = useActivity(onStagedCount, events.at(-1)?.id);
  const { items, staged } = activity;
  const { learning, switchLearning } = useLearningSwitch(activity.setError);
  const improvement = useImprovementCheck(activity);
  const { busy, perform, each } = useReviewAction(activity);
  const [limit, setLimit] = useState(RUNS_PAGE);
  const runs = useMemo(() => items.filter((item) => item.kind === "run"), [items]);
  const learned = useMemo(() => items.filter((item) => item.kind === "improvement"), [items]);
  // Restores, restarts and app updates are Harness looking after itself. A failed self-update is
  // normally followed by an automatic restore; only one that was not needs the user.
  const problem = useMemo(() => unrecoveredFailure(items), [items]);
  const nothingYet = !runs.length && !learned.length && !staged.length;
  const empty = !activity.loading && !activity.error && !problem && nothingYet;
  const target = (index: number) => ({ at: staged[index]?.at, skill: staged[index]?.skill });

  return (
    <div
      data-testid="review-panel"
      className="studio-view @container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-canvas"
    >
      <ActivityHeader learning={learning} onLearning={switchLearning} />
      {empty ? (
        <ActivityEmpty hasGames={games.length > 0} onNewGame={onNewGame} onStartBuilding={onStartBuilding} />
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-5 py-6 @min-[700px]:px-8">
          <ActivityNotices activity={activity} problem={problem} />
          {staged.length > 0 && (
            <SuggestionReview
              key={staged.map((p) => p.at).join()}
              proposals={staged}
              busy={busy}
              onApply={(indices) => void each(indices, (index) => window.studio.acceptProposal(index, target(index)))}
              onDiscard={(indices) =>
                void each(indices, (index) => window.studio.discardProposal(index, undefined, target(index)))
              }
            />
          )}
          <RecentRuns
            runs={runs}
            games={games}
            limit={limit}
            onMore={() => setLimit((value) => value + RUNS_PAGE)}
            onPlayCommit={onPlayCommit}
            onOpenGame={onOpenGame}
          />
          <LearnedSection
            learned={learned}
            changes={activity.changes}
            learning={learning}
            hasRuns={runs.length > 0}
            improvement={improvement}
            busy={busy}
            onUndo={(from) => void perform(() => window.studio.undoChange(from))}
          />
        </div>
      )}
    </div>
  );
}

function RunDetails({
  item,
  game,
  onPlayCommit,
  onOpenGame,
}: {
  item: StudioActivityItem;
  game?: GameProject;
  onPlayCommit: Props["onPlayCommit"];
  onOpenGame: Props["onOpenGame"];
}) {
  const project = item.project ?? null;
  const summary = useRunSummary(project, item.runId ?? null);
  const before = summary?.captures?.base;
  const after = summary?.captures?.current;
  const newHead = summary?.head && summary.head !== summary.base ? summary.head : null;
  const head = item.outcome === "delivered" ? newHead : null;
  const captured = Boolean(before || after);
  return (
    <div className="flex flex-col gap-3.5 pt-0.5 pr-5 pb-4 pl-[54px]">
      <p className="text-ink-2">{item.report || OUTCOME[item.outcome ?? "unknown"].sentence}</p>
      {captured && (
        <div className="grid grid-cols-2 gap-3">
          {before && (
            <figure className="flex flex-col gap-1.5">
              <RunStill path={before} />
              <figcaption className="text-chat-sub text-ink-3">{t("Before")}</figcaption>
            </figure>
          )}
          {after && (
            <figure className="flex flex-col gap-1.5">
              <RunStill path={after} accent />
              <figcaption className="text-chat-sub text-ink-3">{t("After")}</figcaption>
            </figure>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {head && project && (
          <Button variant="secondary" onClick={() => onPlayCommit(project, head)}>
            <Icon name="play" size={13} />
            {t("Play build")}
          </Button>
        )}
        {game && project && (
          <Button
            variant="ghost"
            aria-label={t("Open game chat for {game}", { game: game.title })}
            onClick={() => onOpenGame(project)}
          >
            {t("Open game chat")}
          </Button>
        )}
      </div>
    </div>
  );
}

function RunStill({
  path,
  caption,
  accent = false,
}: {
  path: string;
  caption?: string;
  accent?: boolean;
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  // The tile stays plain while its read runs; the stripes say there is no still, so only after.
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setMissing(false);
    window.studio.readRunStill(path).then(
      (still) => {
        if (cancelled) return;
        if (still) setSrc(`data:${still.mimeType};base64,${still.data}`);
        else setMissing(true);
      },
      () => {
        if (!cancelled) setMissing(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <div
      className="relative overflow-hidden rounded-[8px] bg-inset shadow-btn"
      style={{
        aspectRatio: "16 / 10",
        ...(accent ? { boxShadow: "0 0 0 2px var(--accent), 0 0 0 5px var(--accent-tint)" } : {}),
      }}
    >
      {src && <img src={src} alt={caption ?? ""} className="h-full w-full object-cover" />}
      {missing && (
        <div
          className="h-full w-full"
          style={{
            background:
              "repeating-linear-gradient(-45deg, var(--hatch-stripe, var(--stripe)) 0, var(--hatch-stripe, var(--stripe)) 1px, transparent 1px, transparent 8px), var(--hatch-ground, var(--stripe-bg))",
          }}
        />
      )}
      {caption ? <span className="absolute top-1.5 left-1.5 text-chat-sub text-ink-3">{caption}</span> : null}
    </div>
  );
}

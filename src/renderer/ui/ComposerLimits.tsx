import { type JSX, useEffect, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { ComposerTip } from "./PickerPanel.tsx";
import { Icon } from "./icons.tsx";
import { contextLabel, type ModelChoice, type RoleKey } from "./ModelMenu.tsx";
import {
  contextReading,
  limitLevel,
  pendingPlans,
  PLAN_PROVIDERS,
  planWords,
  resetWords,
  shownLimits,
} from "./usage-words.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { usePolling } from "../use-polling.ts";
import { GenexCredits } from "../panels/plugins/genex/GenexCredits.tsx";
import { type ProviderUsage, type ProviderUsageReport, UsageState } from "../../shared/provider-usage.ts";
import type { ContextUsage } from "../../shared/context.ts";
import { selectedCompact } from "../chat/compact-control.ts";
import { COMPACT_WORDS, PROVIDER_ACCOUNT_WORDS } from "../words.ts";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import type { SubscriptionAccountView } from "../../shared/subscription-accounts.ts";
import { accountLabel, activeAccount, switchAccount, useSubscriptionAccounts } from "../subscription-accounts.ts";
import { useEngines, useProviderUsage } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
export type { ContextUsage };
/** The ring's circumference: a circle of radius 6. */
const RING = 2 * Math.PI * 6;
const ROLE_WORDS: Record<RoleKey, string> = { planner: t("Main agent"), builder: t("Workers"), judge: t("Reviewers") };
/** While the panel is open, usage is read again this often. */
const USAGE_POLL_MS = MINUTE_MS;
/** From this full (percent), the context ring and meter show as full. */
const CONTEXT_FULL = 85;

/** Which roles a plan serves: all of them, some by name, or none. */
function rolesWords(roles: RoleKey[], allRoles: number): string {
  if (!roles.length) return t("Not in use");
  return roles.length === allRoles ? t("In use") : roles.map((role) => ROLE_WORDS[role]).join(" · ");
}

/** Where a plan sorts: the orchestrator's first, then others in use, then the rest. */
function planRank(roles: RoleKey[] | undefined): number {
  if (roles?.includes("planner")) return 0;
  return roles?.length ? 1 : 2;
}

/** One limit window of a plan: its name, its reset, and how much of it is used. */
function LimitWindow({ window }: { window: ProviderUsage["windows"][number] }) {
  const percent = window.percent === null ? null : Math.round(window.percent);
  const resets = resetWords(window.resetsAt);
  const usedWords = percent === null ? t("Not reported") : t("{percent}% used", { percent });
  return (
    <div className="usage-limit">
      <div className="usage-limit-head">
        <span className="min-w-0 truncate">{window.label}</span>
        <span className="usage-limit-value">
          {resets && <span className="truncate">{resets}</span>}
          <span>{percent === null ? "—" : `${percent}%`}</span>
        </span>
      </div>
      <div
        className="picker-meter"
        role="progressbar"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={[usedWords, resets].filter(Boolean).join(", ")}
      >
        <i style={{ width: `${percent ?? 0}%` }} data-level={limitLevel(percent)} />
      </div>
    </div>
  );
}

/**
 * The account a plan's limits belong to, and the others to switch to: the one in use names the
 * plan's line, clicking it lists the rest. A switch to an account that is not signed in starts its
 * web sign-in and opens Model Providers, where that sign-in shows.
 */
function PlanAccounts({
  engine,
  accounts,
  onSwitched,
}: {
  engine: string;
  accounts: readonly SubscriptionAccountView[];
  onSwitched: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const inUse = activeAccount(accounts);
  const others = accounts.filter((account) => !account.active);
  const pick = (account: string): void => {
    setOpen(false);
    void switchAccount(engine, account, (opts) => signInAgain(engine, opts.account))
      .catch(() => {})
      .finally(onSwitched);
  };
  return (
    <div className="usage-plan-accounts">
      <button type="button" className="usage-plan-account" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <span className="truncate">{inUse ? accountLabel(inUse) : PROVIDER_ACCOUNT_WORDS.terminal}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open &&
        others.map((account) => (
          <button
            type="button"
            key={account.id}
            className="usage-plan-account picker-expand"
            data-switch-account={account.id}
            onClick={() => pick(account.id)}
          >
            <span className="truncate">{PROVIDER_ACCOUNT_WORDS.switchTo(accountLabel(account))}</span>
          </button>
        ))}
    </div>
  );
}

/** Start an account's web sign-in and open Model Providers, where that sign-in shows. */
async function signInAgain(engine: string, account: string | null): Promise<void> {
  await window.studio.subscriptionSignIn({ engine, ...(account ? { account } : {}) });
  openSettings(SettingsSection.Providers);
}

/** A plan's one problem line and its one action: Try again, or Sign in again (the accent's). */
function PlanProblem({
  words,
  action,
  primary = false,
  onAction,
}: {
  words: string;
  action: string;
  primary?: boolean;
  onAction: () => void;
}) {
  return (
    <div className="usage-problem" data-usage-problem>
      <span className="min-w-0 flex-1 truncate">{words}</span>
      <button type="button" className="usage-problem-action" data-primary={primary || undefined} onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

/** What a plan shows under its name, by where its limits stand. */
function PlanBody({ report, onRetry }: { report: ProviderUsageReport; onRetry: () => void }): JSX.Element {
  const limits = shownLimits(report.usage?.windows ?? []);
  const brand = PLAN_PROVIDERS[report.engine]?.brand ?? report.engine;
  if (report.state === UsageState.SignedOut)
    return (
      <PlanProblem
        words={t("This account is signed out")}
        action={t("Sign in again")}
        primary
        onAction={() => void signInAgain(report.engine, report.account).catch(() => {})}
      />
    );
  if (report.state === UsageState.NotShared)
    return <p className="usage-note">{t("{brand} doesn’t share limits for this plan", { brand })}</p>;
  if (!limits.length && report.state === UsageState.Checking)
    return (
      <div role="status" aria-busy="true" aria-label={t("Checking plan usage…")}>
        <SkeletonLimit name={92} />
        <SkeletonLimit name={130} />
      </div>
    );
  return (
    <>
      {limits.map((window) => (
        <LimitWindow key={window.id} window={window} />
      ))}
      {report.state === UsageState.Failed && (
        <PlanProblem words={t("Couldn’t check your limits")} action={t("Try again")} onAction={onRetry} />
      )}
    </>
  );
}

function PlanLimits({
  report,
  roles,
  showRoles,
  allRoles,
  onSwitched,
  onRetry,
}: {
  report: ProviderUsageReport;
  roles: RoleKey[];
  showRoles: boolean;
  allRoles: number;
  /** Another account runs now: read the accounts again (main pushes the new limits itself). */
  onSwitched: (reloadAccounts: () => void) => void;
  onRetry: () => void;
}) {
  const usage: ProviderUsage | null = report.usage;
  const page = PLAN_PROVIDERS[report.engine]?.usagePage;
  const title = planWords(report.engine, usage?.plan);
  // The accounts are read again when the account in use or the engine's sign-in changes.
  const status = useEngines((s) => s.list.find((engine) => engine.id === report.engine)?.status.code);
  const { accounts, reload } = useSubscriptionAccounts(report.engine, `${report.account}:${status}`);
  return (
    <section className="usage-plan" data-usage-engine={report.engine} data-usage-state={report.state}>
      <div className="usage-plan-head">
        {page ? (
          <button
            type="button"
            className="usage-plan-link"
            onClick={() => void window.studio.openUrl(page)}
            aria-label={t("{plan}: open usage details", { plan: title })}
          >
            <span className="truncate">{title}</span>
            <Icon name="chevron-right" size={12} />
          </button>
        ) : (
          <span className="truncate">{title}</span>
        )}
        {showRoles && (
          <span className="usage-plan-roles" data-in-use={roles.length > 0 || undefined}>
            {rolesWords(roles, allRoles)}
          </span>
        )}
      </div>
      {accounts.length > 1 && (
        <PlanAccounts engine={report.engine} accounts={accounts} onSwitched={() => onSwitched(reload)} />
      )}
      <PlanBody report={report} onRetry={onRetry} />
    </section>
  );
}

/**
 * The subscriptions' plan usage, as main keeps it: asked for on hover or focus (unless asked just
 * now) and every minute while the panel is open; each answer arrives as main pushes it.
 */
function usePlanUsage(open: boolean) {
  const reports = useProviderUsage((s) => s.reports);
  const failed = useProviderUsage((s) => s.failed);
  const refresh = (force = false): void => studio().providerUsage.refresh(force);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a read when the panel opens, not per render
  useEffect(() => {
    if (open) refresh();
  }, [open]);
  usePolling(() => refresh(true), USAGE_POLL_MS, open);
  return { reports, failed, refresh };
}

/** A bar the size of the text it stands in for, shimmering softly while that text is read. */
function SkeletonBar({ width, className = "" }: { width?: number; className?: string }): JSX.Element {
  return <span aria-hidden className={`usage-skeleton ${className}`} style={width ? { width } : undefined} />;
}

/** A limit row while its numbers are read: its name, its reset and percent, and its meter. */
function SkeletonLimit({ name }: { name: number }): JSX.Element {
  return (
    <div className="usage-limit">
      <div className="usage-limit-head">
        <SkeletonBar width={name} />
        <SkeletonBar width={118} className="usage-skeleton-sub" />
      </div>
      <SkeletonBar className="usage-skeleton-meter" />
    </div>
  );
}

/**
 * The plans while their usage is read, drawn at their real size: each plan this setup uses by its
 * name and roles, its limits as soft shimmering bars; one unnamed plan when none is known.
 */
function PendingPlans({ usedBy }: { usedBy: Record<string, RoleKey[]> }): JSX.Element {
  const allRoles = Object.values(usedBy).flat().length;
  const plans = pendingPlans(usedBy);
  return (
    <div role="status" aria-busy="true" aria-label={t("Checking plan usage…")} data-usage-pending>
      {plans.map((engine) => (
        <section key={engine ?? "plan"} className="usage-plan">
          <div className="usage-plan-head">
            {engine ? <span className="truncate">{planWords(engine)}</span> : <SkeletonBar width={112} />}
            {engine && plans.length > 1 && (
              <span className="usage-plan-roles" data-in-use>
                {rolesWords(usedBy[engine] ?? [], allRoles)}
              </span>
            )}
          </div>
          <SkeletonLimit name={92} />
          <SkeletonLimit name={130} />
        </section>
      ))}
    </div>
  );
}

/** Each subscription's plan limits, once read; until then their skeletons, or that they cannot be read. */
function PlanUsage({
  reports,
  failed,
  usedBy,
  onSwitched,
  onRetry,
}: {
  reports: ProviderUsageReport[] | null;
  failed: boolean;
  usedBy: Record<string, RoleKey[]>;
  onSwitched: (reloadAccounts: () => void) => void;
  onRetry: () => void;
}): JSX.Element {
  if (reports === null && failed)
    return <p className="usage-note usage-divider">{t("Plan usage isn’t available right now.")}</p>;
  if (reports === null) return <PendingPlans usedBy={usedBy} />;
  // The orchestrator's plan first, then the others this setup draws on, then any left to switch to.
  const rank = (engineId: string) => planRank(usedBy[engineId]);
  const plans = [...reports].sort((a, b) => rank(a.engine) - rank(b.engine));
  return (
    <>
      {plans.map((report) => (
        <PlanLimits
          key={report.engine}
          report={report}
          roles={usedBy[report.engine] ?? []}
          showRoles={plans.length > 1}
          allRoles={Object.values(usedBy).flat().length}
          onSwitched={onSwitched}
          onRetry={onRetry}
        />
      ))}
    </>
  );
}

/** The orchestrator's context and each signed-in subscription's plan limits. The ring is the
 * context summary; the panel adds the numbers, Compact now and the plans' remaining room. */
export function ComposerLimits({
  models,
  modelKey,
  usage,
  onCompact,
  compacting,
  compactBusy,
  contexts = [],
  usedBy = {},
  project,
}: {
  models: ModelChoice[];
  modelKey: string | null;
  usage?: ContextUsage | null;
  contexts?: ContextUsage[];
  onCompact?: () => void;
  compacting?: boolean;
  /** A turn or a build is under way: Compact now waits for it. */
  compactBusy?: boolean;
  /** Which roles each subscription serves in the current setup, keyed by engine id. */
  usedBy?: Record<string, RoleKey[]>;
  /** The open game: Genex's block reads this game's spend. */
  project?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { reports, failed, refresh } = usePlanUsage(open);
  const selected = models.find((m) => m.key === modelKey);
  const { used, capacity, percent, summary } = contextReading({
    modelKey,
    usage,
    contexts,
    modelWindow: selected?.contextWindow,
  });
  // The line names how full the context is only once it was measured; the meter's text says when not.
  const reading = percent == null ? COMPACT_WORDS.automatic : `${summary} · ${COMPACT_WORDS.automatic}`;
  const compact = selectedCompact(models, modelKey, { compacting: Boolean(compacting), busy: Boolean(compactBusy) });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ComposerTip
        hidden={open}
        content={percent == null ? t("Context and usage") : t("Context · {percent}% used", { percent })}
      >
        <PopoverTrigger
          render={<button type="button" />}
          aria-label={t("Context and usage")}
          className="composer-icon composer-ring"
          onPointerEnter={() => refresh()}
          onFocus={() => refresh()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
            <circle cx="8" cy="8" r="6" className="composer-ring-track" />
            {percent != null && percent > 0 && (
              <circle
                cx="8"
                cy="8"
                r="6"
                className="composer-ring-value"
                data-full={percent >= CONTEXT_FULL || undefined}
                strokeDasharray={`${(percent / 100) * RING} ${RING}`}
              />
            )}
          </svg>
        </PopoverTrigger>
      </ComposerTip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="picker-panel w-[360px] max-w-(--available-width) max-h-(--available-height) overflow-y-auto p-1.5"
        aria-label={t("Context and usage")}
      >
        <section className="px-2.5 pt-1.5 pb-2">
          <div className="usage-limit-head text-chat">
            <span>{t("Context window")}</span>
            <span className="usage-limit-value tabular-nums">
              {[used, capacity]
                .filter((n): n is number => n != null && n > 0)
                .map(contextLabel)
                .join(" / ")}
            </span>
          </div>
          <div
            className="picker-meter"
            role="progressbar"
            aria-label={t("Context used")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={summary}
          >
            <i style={{ width: `${percent ?? 0}%` }} data-full={(percent ?? 0) >= CONTEXT_FULL || undefined} />
          </div>
          <div className="mt-2 flex min-h-6 items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-3" title={reading}>
              {reading}
            </p>
            {compact.shown && onCompact && (
              <button
                type="button"
                className="picker-action usage-compact"
                title={COMPACT_WORDS.caption}
                disabled={compact.disabled}
                onClick={onCompact}
              >
                <Icon name="compact" size={14} />
                {compacting ? COMPACT_WORDS.running : COMPACT_WORDS.action}
              </button>
            )}
          </div>
        </section>
        <PlanUsage
          reports={reports}
          failed={failed}
          usedBy={usedBy}
          onSwitched={(reloadAccounts) => reloadAccounts()}
          onRetry={() => refresh(true)}
        />
        <GenexCredits project={project} open={open} />
        <button
          type="button"
          className="usage-footer"
          data-usage-providers
          onClick={() => {
            setOpen(false);
            openSettings(SettingsSection.Providers);
          }}
        >
          {PROVIDER_ACCOUNT_WORDS.modelProviders}
          <Icon name="chevron-right" size={14} className="ml-auto" />
        </button>
      </PopoverContent>
    </Popover>
  );
}

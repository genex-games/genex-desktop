/**
 * Settings → Model Providers, Genex's row (owner, 2026-10-28): building on the person's Genex
 * credits, shown only where genex.games offers it. It keeps a provider row's shape: one status
 * plate, the chat notice's line for what is still missing (`genex-build.ts`) with its one step, and,
 * once Genex is ready, an Account menu (Check connection, Get credits) and the picker's Genex models.
 */
import type { JSX } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { t } from "../../shared/i18n.ts";
import { EngineId } from "../../shared/providers.ts";
import { useRowViewed } from "../analytics/welcome-report.ts";
import { ProviderSurface, SubscriptionRowFace } from "../analytics/welcome-vocabulary.ts";
import { type GenexBuild, GenexNeed, genexNoticeWords, offersGenex, useGenexBuild } from "../genex-build.ts";
import { useGetCredits } from "../play/use-get-credits.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { DropdownMenuItem } from "../ui/dropdown-menu.tsx";
import { METERED_PROVIDER_WORDS } from "../words.ts";
import { AccountMenu, ItemWords, ProviderCard, useRecheck, useRun } from "./MeteredProviders.tsx";
import { type ProviderWords, RowTone, type RowView } from "./provider-row.tsx";

const WORDS = METERED_PROVIDER_WORDS;
const GENEX: ProviderWords = { name: "Genex", plans: "", guide: "" };

const MESSAGE = {
  ready: () => t("Builds with your Genex credits."),
  noCredits: () => t("No credits yet"),
  verifyEmail: () => t("Verify email"),
  outOfCredits: () => t("Out of credits"),
  paused: () => t("Paused"),
  needsSetup: () => t("Needs setup"),
  settingUp: () => t("Setting up…"),
  getCredits: () => t("Get credits"),
  getCreditsLine: () => t("Pro or a credit pack on genex.games"),
} as const;

/** The plate a need shows: its tone, its word, and the face usage analytics names. */
interface NeedPlate {
  tone: RowTone;
  status: string;
  face: SubscriptionRowFace;
}

const NEED_PLATE: Record<GenexNeed, (installing: boolean) => NeedPlate> = {
  [GenexNeed.SignIn]: () => ({ tone: RowTone.Off, status: WORDS.notConnected, face: SubscriptionRowFace.NotConnected }),
  [GenexNeed.Plan]: () => ({ tone: RowTone.Off, status: MESSAGE.noCredits(), face: SubscriptionRowFace.NotConnected }),
  [GenexNeed.VerifyEmail]: () => ({
    tone: RowTone.Warning,
    status: MESSAGE.verifyEmail(),
    face: SubscriptionRowFace.NotConnected,
  }),
  [GenexNeed.OutOfCredits]: () => ({
    tone: RowTone.Warning,
    status: MESSAGE.outOfCredits(),
    face: SubscriptionRowFace.NotConnected,
  }),
  [GenexNeed.Paused]: () => ({
    tone: RowTone.Warning,
    status: MESSAGE.paused(),
    face: SubscriptionRowFace.NotConnected,
  }),
  [GenexNeed.Setup]: (installing) =>
    installing
      ? { tone: RowTone.Busy, status: MESSAGE.settingUp(), face: SubscriptionRowFace.Installing }
      : { tone: RowTone.Off, status: MESSAGE.needsSetup(), face: SubscriptionRowFace.NotInstalled },
  [GenexNeed.Unreachable]: () => ({
    tone: RowTone.Danger,
    status: WORDS.couldNotCheck,
    face: SubscriptionRowFace.CouldntCheck,
  }),
};

/** What the row does: check Genex again, and open genex.games for credits. */
export interface GenexRowActions {
  onCheck(): void;
  onGetCredits(): void;
}

/** The row by where Genex stands: ready to build, or what is missing and its one step. */
export function genexRowView(
  build: Pick<GenexBuild, "need" | "waiting" | "installing" | "primary">,
  act: GenexRowActions,
): RowView {
  if (build.need === null)
    return {
      tone: RowTone.Connected,
      status: WORDS.connected,
      line: MESSAGE.ready(),
      actions: (
        <AccountMenu name={GENEX.name} onCheck={act.onCheck}>
          <DropdownMenuItem onSelect={act.onGetCredits}>
            <ItemWords title={MESSAGE.getCredits()} line={MESSAGE.getCreditsLine()} />
          </DropdownMenuItem>
        </AccountMenu>
      ),
      face: SubscriptionRowFace.Connected,
    };
  const words = genexNoticeWords(build.need, { held: false, waiting: build.waiting, installing: build.installing });
  return {
    ...NEED_PLATE[build.need](build.installing),
    line: words.line,
    actions: words.primary ? (
      <Button variant="default" data-genex-action="primary" onClick={() => void build.primary()}>
        {words.primary}
      </Button>
    ) : null,
  };
}

/** Genex's card: the row's view, its models once ready, and its trouble. */
export function GenexCard({
  engine,
  view,
  checking,
  problem,
}: {
  engine: EngineDescriptor;
  view: RowView;
  checking: boolean;
  problem: string | null;
}): JSX.Element {
  const ready = engine.status.code === EngineStatusCode.Ready;
  return (
    <ProviderCard words={GENEX} engine={engine} view={view} checking={checking} connected={ready} problem={problem} />
  );
}

/** The row with its steps, for a Genex engine genex.games offers. */
function GenexRow({
  engine,
  onEnginesRefresh,
}: {
  engine: EngineDescriptor;
  onEnginesRefresh: () => Promise<void> | void;
}): JSX.Element {
  const build = useGenexBuild(engine, onEnginesRefresh);
  const { run, error } = useRun();
  const { checking, recheck } = useRecheck(EngineId.Genex, onEnginesRefresh);
  const getCredits = useGetCredits();
  const view = genexRowView(build, { onCheck: () => void run(recheck), onGetCredits: getCredits });
  useRowViewed(EngineId.Genex, view.face, ProviderSurface.Settings, null);
  return <GenexCard engine={engine} view={view} checking={checking} problem={error ?? build.problem} />;
}

/** Genex's row, where genex.games offers building with credits; nothing elsewhere. */
export function GenexBuildRow({
  engines,
  onEnginesRefresh,
}: {
  engines: EngineDescriptor[];
  onEnginesRefresh: () => Promise<void> | void;
}): JSX.Element | null {
  const engine = engines.find((candidate) => candidate.id === EngineId.Genex);
  if (!engine || !offersGenex(engine)) return null;
  return <GenexRow engine={engine} onEnginesRefresh={onEnginesRefresh} />;
}

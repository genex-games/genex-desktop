/**
 * Publish for a Roblox game, drawn by Studio over the game's stage: one card with one main button.
 * The press hands the publish to the game's agent (the Roblox plugin's `first-publish` or
 * `publish-update`, which asks nothing more: the press is the person's go-ahead), and the agent
 * clicks File › Publish to Roblox in Roblox Studio with computer control. The card follows it
 * through `publish-status` until Roblox has it, or says why it stopped; closing the card never
 * stops it. Where Genex can't click, the card gives Studio's own clicks instead.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ROBLOX_PLUGIN_ID } from "../../../../shared/observers.ts";
import {
  type RobloxPublishAnswer,
  RobloxPublishAction,
  type RobloxPublishState,
} from "../../../../shared/roblox-publish.ts";
import { openPluginSetup } from "../../../plugin-setup.ts";
import { Button } from "../../../ui/Button.tsx";
import { DialogSurface } from "../../../ui/dialog.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { Pending } from "../../../ui/Pending.tsx";
import { StepBar } from "../../../ui/StepBar.tsx";
import { GENEX_WORDS, ROBLOX_PUBLISH_WORDS as WORDS } from "../../../words.ts";
import { pollAfterMs, RobloxCardStage, type RobloxCardView, robloxCardView } from "./roblox-publish-view.ts";

/** Studio's own menu path for publishing, in Studio's own (English) words. */
const STUDIO_CLICKS = ["File", "Publish to Roblox"];
/** A cancelled press is the person's choice, not an error to show. */
const CANCELLED = /Cancelled/;
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The strip's Publish for a Roblox game, dressed as Genex's: Play's blue tint. */
export function RobloxPublishButton({ onPress }: { onPress: () => void }): JSX.Element {
  return (
    <Button variant="play-tint" data-roblox-publish aria-label={WORDS.title} onClick={onPress}>
      <Icon name="globe" />
      <span>{GENEX_WORDS.publish.button}</span>
    </Button>
  );
}

/** The game's publish status, read now and again on the card's cadence; null until the first answer. */
function usePublishStatus(project: string) {
  const [state, setState] = useState<RobloxPublishState | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const read = useCallback(async () => {
    const mine = ++request.current;
    const answer = await window.studio
      .pluginAction(ROBLOX_PLUGIN_ID, RobloxPublishAction.PublishStatus, {}, project)
      .catch(() => null);
    if (mine !== request.current) return;
    if (answer && typeof answer === "object") {
      setState(answer as RobloxPublishState);
      setFailed(false);
    } else setFailed(true);
  }, [project]);
  const view = robloxCardView(state, Date.now());
  const wait = pollAfterMs(view);
  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), wait);
    return () => {
      clearInterval(timer);
      request.current++;
    };
  }, [read, wait]);
  return { view, failed, read };
}

/** Studio's own clicks, as its menu names them. */
function StudioClicks(): JSX.Element {
  return (
    <p className="genex-publish-hint" data-studio-clicks>
      <strong className="font-medium text-ink">{STUDIO_CLICKS.join(" › ")}</strong>
    </p>
  );
}

/** The main press: hand the publish to the agent, its words while it is handed over or runs. */
function MainPress({
  view,
  pressing,
  onPress,
}: {
  view: RobloxCardView;
  pressing: boolean;
  onPress: () => void;
}): JSX.Element {
  const publishing = view.stage === RobloxCardStage.Publishing;
  let label: string = view.first ? WORDS.publishFirst : WORDS.publishUpdate;
  if (view.stage === RobloxCardStage.Stopped) label = WORDS.tryAgain;
  if (pressing) label = WORDS.handing;
  if (publishing) label = WORDS.publishing;
  return (
    <Button
      variant={publishing || pressing ? "secondary" : "default"}
      size="default"
      className="genex-publish-primary"
      aria-busy={publishing || pressing || undefined}
      disabled={publishing || pressing}
      onClick={onPress}
    >
      {label}
    </Button>
  );
}

/** The game's page on Roblox, with Open. */
function RobloxLink({ url }: { url: string }): JSX.Element {
  return (
    <div className="genex-publish-link-field" data-public>
      <Icon name="globe" size={15} />
      <span title={url}>{url.replace(/^https?:\/\//, "")}</span>
      <Button onClick={() => void window.studio.openUrl(url)}>
        {WORDS.open}
        <Icon name="arrow-up-right" size={14} />
      </Button>
    </div>
  );
}

/** The publish's steps as one bar, while it runs and once it ended. */
function Progress({ view }: { view: RobloxCardView }): JSX.Element | null {
  if (view.steps.length === 0) return null;
  return (
    <div className="genex-publish-progress">
      <StepBar steps={view.steps} label={WORDS.progress} valueText={view.stage} />
    </div>
  );
}

/** A first publish's name: the game's title until the person types another. */
function NameField({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
  return (
    <label className="grid gap-1.5 text-chat-sub text-ink-2">
      {WORDS.name}
      <input
        data-roblox-publish-name
        value={value}
        maxLength={50}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-control border border-input bg-field px-3 text-chat text-foreground outline-none placeholder:text-muted-foreground focus:border-accent-ink"
      />
    </label>
  );
}

/** What the card says over its press, for each stage that has a press. */
function Body({
  view,
  name,
  onName,
}: {
  view: RobloxCardView;
  name: string;
  onName: (value: string) => void;
}): JSX.Element | null {
  if (view.stage === RobloxCardStage.Publishing) return <Progress view={view} />;
  if (view.stage === RobloxCardStage.Stopped)
    return (
      <>
        <Progress view={view} />
        <p role="alert" className="genex-publish-problem">
          {view.detail ?? WORDS.stoppedLine}
        </p>
      </>
    );
  if (view.first) return <NameField value={name} onChange={onName} />;
  return <p className="genex-publish-hint">{WORDS.updateLine}</p>;
}

/** The card for a game whose press can run: Ready, Publishing or Stopped. */
function PressCard({ project, view, read }: { project: string; view: RobloxCardView; read: () => Promise<void> }) {
  const [typed, setTyped] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const [refused, setRefused] = useState<RobloxPublishAnswer | null>(null);
  const name = typed ?? view.name;
  const press = async () => {
    setPressing(true);
    setRefused(null);
    const action = view.first ? RobloxPublishAction.FirstPublish : RobloxPublishAction.PublishUpdate;
    try {
      const answer = (await window.studio.pluginAction(
        ROBLOX_PLUGIN_ID,
        action,
        view.first ? { name: name.trim() } : {},
        project,
      )) as RobloxPublishAnswer | null;
      if (!answer?.started) setRefused(answer ?? { started: false, message: WORDS.stoppedLine });
    } catch (e) {
      if (!CANCELLED.test(words(e))) setRefused({ started: false, message: words(e) });
    } finally {
      setPressing(false);
      await read();
    }
  };
  let hint: string | null = null;
  if (pressing) hint = WORDS.chatAsks;
  else if (view.stage === RobloxCardStage.Publishing) hint = WORDS.publishingLine;
  return (
    <>
      <Body view={view} name={name} onName={setTyped} />
      {refused && (
        <div>
          <p role="alert" className="genex-publish-problem">
            {refused.message}
          </p>
          {refused.clickPath && <StudioClicks />}
        </div>
      )}
      <MainPress view={view} pressing={pressing} onPress={() => void press()} />
      {hint && <p className="genex-publish-hint">{hint}</p>}
    </>
  );
}

/** The card's content for the stage it is at. */
function CardContent({
  project,
  view,
  failed,
  read,
  onClose,
}: {
  project: string;
  view: RobloxCardView;
  failed: boolean;
  read: () => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  if (view.stage === RobloxCardStage.Loading)
    return failed ? (
      <p role="alert" className="genex-publish-problem">
        {WORDS.readFailed}
      </p>
    ) : (
      <Pending label={WORDS.title} />
    );
  if (view.stage === RobloxCardStage.NoPlace)
    return (
      <>
        <p className="genex-publish-hint">{WORDS.noPlace}</p>
        <Button
          variant="default"
          size="default"
          className="genex-publish-primary"
          onClick={() => {
            onClose();
            openPluginSetup(ROBLOX_PLUGIN_ID);
          }}
        >
          {WORDS.setUp}
        </Button>
      </>
    );
  if (view.stage === RobloxCardStage.ByHand)
    return (
      <>
        <p className="genex-publish-hint">{WORDS.byHand}</p>
        <StudioClicks />
      </>
    );
  if (view.stage === RobloxCardStage.Published)
    return (
      <>
        <Progress view={view} />
        <p className="flex items-center justify-center gap-2 text-chat text-ink" data-roblox-published>
          <Icon name="check" size={16} className="text-green" />
          {view.first ? WORDS.publishedFirst : WORDS.publishedUpdate}
        </p>
        {view.url && <RobloxLink url={view.url} />}
        <Button variant="default" size="default" className="genex-publish-primary" onClick={onClose}>
          {WORDS.done}
        </Button>
      </>
    );
  return <PressCard project={project} view={view} read={read} />;
}

/** The card over the stage: where the game's publish stands, and the one press that hands it to the agent. */
export function RobloxPublishDialog({ project, onClose }: { project: string; onClose: () => void }): JSX.Element {
  const { view, failed, read } = usePublishStatus(project);
  return (
    <DialogSurface
      title={WORDS.title}
      titleIcon={<Icon name="globe" size={20} className="text-ink-3" />}
      description={WORDS.intro}
      onDismiss={onClose}
      size="lg"
      testId="roblox-publish"
    >
      <div className="genex-publish-body" data-roblox-publish-stage={view.stage}>
        <CardContent project={project} view={view} failed={failed} read={read} onClose={onClose} />
      </div>
    </DialogSurface>
  );
}

/** The strip's Publish for a Roblox game and, while it is open for `card`, its card. */
export function RobloxPublish({
  shown,
  card,
  open,
  close,
}: {
  shown: boolean;
  card: string | null;
  open: () => void;
  close: () => void;
}): JSX.Element | null {
  if (!shown) return null;
  return (
    <>
      <RobloxPublishButton onPress={open} />
      {card && <RobloxPublishDialog project={card} onClose={close} />}
    </>
  );
}

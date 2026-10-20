/**
 * Publish's play-time AI block (`V3-Publish`, `V3-Publish-States`): Needs AI or Works without AI,
 * with nothing chosen for the creator; Best with, the model the listing names; AI cost for players
 * once a check measured it; a leaderboard switch and the creator's share for a game that needs AI.
 * Publish never waits for the model check: without one the block names the playtest's model and
 * offers Check models. It shows only for a game that played with AI.
 */
import { type JSX, useCallback, useEffect, useState } from "react";
import { AiAudience, type AiModelRef, AiRequirement, createGameKey } from "../../../shared/game-ai.ts";
import type { AiPublishChoice, AiPublishFacts } from "../../../shared/game-ai-check.ts";
import type { AiModelMenu } from "../../../shared/game-ai-views.ts";
import { Button } from "../../ui/Button.tsx";
import { PickerSegmented } from "../../ui/PickerPanel.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { PUBLISH_AI_WORDS } from "../../words.ts";
import { ModelCheckDialog } from "./ModelCheckDialog.tsx";
import {
  audienceNote,
  BestWithAction,
  modelLabel,
  publishAiView,
  publishChoice,
  publishShowsAi,
} from "./play-ai-view.ts";

const WORDS = PUBLISH_AI_WORDS;

/** What Publish keeps of the block: main's facts, the creator's choice, and whether a press found it unmade. */
export interface PublishAi {
  facts: AiPublishFacts | null;
  menu: AiModelMenu | null;
  shown: boolean;
  requires: AiRequirement | null;
  leaderboard: boolean;
  /** Who sees what the game's AI writes: declared on genex.games at Publish (D6). */
  audience: AiAudience;
  setAudience: (audience: AiAudience) => void;
  /** A Publish press found the requirement unchosen: the block says so. */
  attempted: boolean;
  setRequires: (requires: AiRequirement) => void;
  setLeaderboard: (on: boolean) => void;
  /** What Publish sends, or null while the block is shown and nothing is chosen (Publish then waits). */
  choice: AiPublishChoice | null;
  /** Whether Publish may go ahead now; a press that may not marks the block. */
  ready: () => boolean;
  refresh: () => Promise<void>;
}

/** The block's state for one game, read when Publish opens. A game whose facts can't be read publishes as before. */
export function usePublishAi(project: string): PublishAi {
  const [facts, setFacts] = useState<AiPublishFacts | null>(null);
  const [menu, setMenu] = useState<AiModelMenu | null>(null);
  const [requires, setRequires] = useState<AiRequirement | null>(null);
  const [leaderboard, setLeaderboard] = useState(false);
  const [audience, setAudience] = useState<AiAudience>(AiAudience.Player);
  const [attempted, setAttempted] = useState(false);
  const refresh = useCallback(async () => {
    if (!project) return;
    const [read, models] = await Promise.allSettled([
      window.studio.gameAiPublishFacts(project),
      window.studio.gameAiMenu(createGameKey(project)),
    ]);
    if (read.status === "fulfilled" && read.value) {
      setFacts(read.value);
      // A game published before keeps the audience its creator declared.
      if (read.value.audience) setAudience(read.value.audience.audience);
    }
    if (models.status === "fulfilled" && models.value) setMenu(models.value);
  }, [project]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const shown = publishShowsAi(facts);
  const choice = publishChoice(requires, leaderboard, audience);
  return {
    facts,
    menu,
    shown,
    requires,
    leaderboard,
    attempted,
    audience,
    setAudience,
    setRequires: (next) => {
      setRequires(next);
      setAttempted(false);
    },
    setLeaderboard,
    choice: shown ? choice : null,
    ready: () => {
      if (!shown || choice) return true;
      setAttempted(true);
      return false;
    },
    refresh,
  };
}

/** The block itself, above Publish's presses. */
export function PublishAiBlock({
  ai,
  project,
  title,
  quiet,
}: {
  ai: PublishAi;
  project: string;
  title: string;
  /** While it publishes, and once it just went live, the dialog shows only its progress and link. */
  quiet: { publishing: boolean; celebrate: boolean };
}): JSX.Element | null {
  const [checking, setChecking] = useState(false);
  if (!ai.shown || !ai.facts || quiet.publishing || quiet.celebrate) return null;
  const labelOf = (model: AiModelRef) => modelLabel(ai.menu, model);
  const view = publishAiView(ai.facts, ai.requires, labelOf);
  return (
    <section className="play-ai-publish" aria-label={WORDS.label} data-publish-ai={ai.requires ?? "unchosen"}>
      <span className="play-ai-publish-label">{WORDS.label}</span>
      <PickerSegmented<AiRequirement>
        label={WORDS.needsLabel}
        value={ai.requires}
        onChange={ai.setRequires}
        options={[
          { value: AiRequirement.Ai, label: WORDS.needs },
          { value: AiRequirement.Optional, label: WORDS.without },
        ]}
      />
      {ai.attempted && (
        <p role="alert" className="text-orange" data-publish-ai-gate>
          {WORDS.choose(title)}
        </p>
      )}
      {view.bestWith && (
        <div className="play-ai-publish-row" data-publish-ai-best>
          <span className="text-ink-3">{WORDS.bestWith}</span>
          <span className="min-w-0 flex-1 truncate text-ink">{view.bestWith}</span>
          <Button onClick={() => setChecking(true)} data-publish-ai-check={view.action}>
            {view.action === BestWithAction.Change ? WORDS.change : WORDS.checkModels}
          </Button>
        </div>
      )}
      {view.noCheck && <p className="text-ink-3">{WORDS.noCheck}</p>}
      {view.cost && (
        <div className="play-ai-publish-row" data-publish-ai-cost>
          <span className="text-ink-3">{WORDS.cost}</span>
          {"free" in view.cost ? (
            <span className="text-ink">{view.cost.free}</span>
          ) : (
            <span className="text-ink">
              <span className="font-mono">{view.cost.marks}</span> {view.cost.name}
            </span>
          )}
        </div>
      )}
      {view.leaderboard && (
        <div className="play-ai-publish-row" data-publish-ai-leaderboard={ai.leaderboard ? "on" : "off"}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-ink">{WORDS.leaderboard}</span>
            <span className="text-ink-3">{WORDS.leaderboardWhat}</span>
          </span>
          <Toggle on={ai.leaderboard} onChange={ai.setLeaderboard} ariaLabel={WORDS.leaderboard} />
        </div>
      )}
      <PickerSegmented<AiAudience>
        label={WORDS.audienceLabel}
        value={ai.audience}
        onChange={ai.setAudience}
        options={[
          { value: AiAudience.Player, label: WORDS.audiencePlayer },
          { value: AiAudience.Shared, label: WORDS.audienceShared },
          { value: AiAudience.OpenChat, label: WORDS.audienceOpenChat },
        ]}
      />
      {ai.audience !== AiAudience.Player && (
        <p className="text-ink-3" data-publish-ai-audience={ai.audience}>
          {audienceNote(ai.facts, ai.audience) ?? WORDS.audienceWhat}
        </p>
      )}
      {view.share && (
        <p className="text-ink-3" data-publish-ai-share>
          {view.share}
        </p>
      )}
      {checking && (
        <ModelCheckDialog
          project={project}
          title={title}
          onPlayNow={() => setChecking(false)}
          onClose={() => {
            setChecking(false);
            void ai.refresh();
          }}
        />
      )}
    </section>
  );
}

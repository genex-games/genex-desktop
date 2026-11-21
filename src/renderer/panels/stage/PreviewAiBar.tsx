/**
 * Live's AI bar, above the game (the native view paints over anything inside the stage): for a
 * game whose code calls Genex's models, practice answers by default and the person's own way to real
 * ones, approved once for a cap; and the game's microphone ask. Every button is the person's click
 * in the app, never an agent's call.
 */
import { type JSX, type ReactNode, useEffect, useState } from "react";
import {
  PREVIEW_AI_CAPS,
  PREVIEW_AI_DEFAULT_CAP,
  PreviewAiMode,
  type PreviewAiState,
} from "../../../shared/preview-ai.ts";
import { studio } from "../../state/studio.ts";
import { usePreviewAi } from "../../state/hooks.ts";
import { Button } from "../../ui/Button.tsx";
import { cn } from "../../ui/cn.ts";
import {
  offersRetry,
  PREVIEW_AI_WORDS as WORDS,
  PreviewAiBarKind,
  previewAiBarKind,
  unavailableWords,
} from "./preview-ai-bar.ts";

/** The bar's row: one line of words and its buttons, the stage's banner surface. */
function Row({ kind, children }: { kind: PreviewAiBarKind; children: ReactNode }): JSX.Element {
  return (
    <div
      data-preview-ai={kind}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
    >
      {children}
    </div>
  );
}

/** The bar's words: the row's one line of text. */
function Words({ text, quiet = false }: { text: string; quiet?: boolean }): JSX.Element {
  return (
    <span role="status" className={cn("min-w-32 flex-1 text-xs leading-relaxed", quiet ? "text-ink-3" : "text-ink-2")}>
      {text}
    </span>
  );
}

/** The caps to choose between, as one radio group of small buttons. */
function CapChoice({ cap, onCap }: { cap: number; onCap: (cap: number) => void }): JSX.Element {
  return (
    <div role="radiogroup" aria-label={WORDS.capChoice()} className="flex items-center gap-1">
      {PREVIEW_AI_CAPS.map((option) => (
        <Button
          key={option}
          role="radio"
          aria-checked={option === cap}
          data-preview-ai-cap={option}
          variant={option === cap ? "accent-outline" : "ghost"}
          onClick={() => onCap(option)}
        >
          {WORDS.capOption(option)}
        </Button>
      ))}
    </div>
  );
}

/** The confirmation of a cap: the person's Start is the only way real models start. */
function Confirm({ project, onDone }: { project: string; onDone: () => void }): JSX.Element {
  const [cap, setCap] = useState<number>(PREVIEW_AI_DEFAULT_CAP);
  return (
    <Row kind={PreviewAiBarKind.Confirm}>
      <Words text={WORDS.confirm(cap)} />
      <CapChoice cap={cap} onCap={setCap} />
      <Button variant="ghost" data-preview-ai-cancel onClick={onDone}>
        {WORDS.cancel()}
      </Button>
      <Button
        variant="default"
        data-preview-ai-start
        onClick={() => {
          onDone();
          void studio().previewAi.startReal(project, cap);
        }}
      >
        {WORDS.start()}
      </Button>
    </Row>
  );
}

/** The game's microphone ask. */
function MicAsk({ project }: { project: string }): JSX.Element {
  const answer = (allow: boolean) => void studio().previewAi.answerMic(project, allow);
  return (
    <Row kind={PreviewAiBarKind.Mic}>
      <Words text={WORDS.micAsk()} />
      <Button variant="ghost" data-preview-mic-not-now onClick={() => answer(false)}>
        {WORDS.micNotNow()}
      </Button>
      <Button variant="default" data-preview-mic-allow onClick={() => answer(true)}>
        {WORDS.micAllow()}
      </Button>
    </Row>
  );
}

/** The bar for a state that is not the confirmation or the microphone. */
function StateRow({
  state,
  kind,
  onConfirm,
}: {
  state: PreviewAiState;
  kind: PreviewAiBarKind;
  onConfirm: () => void;
}): JSX.Element | null {
  const stop = () => void studio().previewAi.backToPractice(state.project);
  const cap = state.capCredits ?? PREVIEW_AI_DEFAULT_CAP;
  if (kind === PreviewAiBarKind.Live || kind === PreviewAiBarKind.Starting)
    return (
      <Row kind={kind}>
        <Words text={kind === PreviewAiBarKind.Live ? WORDS.live(state.chargedCredits, cap) : WORDS.starting()} />
        <Button variant="ghost" data-preview-ai-stop onClick={stop}>
          {WORDS.stop()}
        </Button>
      </Row>
    );
  if (kind === PreviewAiBarKind.CapReached)
    return (
      <Row kind={kind}>
        <Words text={WORDS.capReached()} />
        <Button variant="ghost" data-preview-ai-stop onClick={stop}>
          {WORDS.stop()}
        </Button>
        <Button variant="accent-outline" data-preview-ai-more onClick={onConfirm}>
          {WORDS.addMore(cap)}
        </Button>
      </Row>
    );
  if (kind === PreviewAiBarKind.Unavailable)
    return (
      <Row kind={kind}>
        <Words text={unavailableWords(state.reason, state.error)} />
        {offersRetry(state.reason) ? (
          <Button variant="ghost" data-preview-ai-retry onClick={onConfirm}>
            {WORDS.tryAgain()}
          </Button>
        ) : null}
      </Row>
    );
  const failed = state.mode === PreviewAiMode.Practice && state.error !== null;
  return (
    <Row kind={PreviewAiBarKind.Practice}>
      <Words text={failed ? WORDS.practiceFailed(state.error ?? "") : WORDS.practice()} quiet />
      <Button variant="accent-outline" data-preview-ai-real onClick={onConfirm}>
        {WORDS.realAi()}
      </Button>
    </Row>
  );
}

/** Live's AI bar for the game on the stage; nothing for a game that calls no model and asks nothing. */
export function PreviewAiBar({ project }: { project: string | null }): JSX.Element | null {
  const state = usePreviewAi((s) => (project ? s.games[project] : undefined));
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setConfirming(false);
    if (project) void studio().previewAi.read(project);
  }, [project]);
  const kind = previewAiBarKind(state, confirming);
  if (!project || !state || kind === PreviewAiBarKind.Hidden) return null;
  if (kind === PreviewAiBarKind.Mic) return <MicAsk project={project} />;
  if (kind === PreviewAiBarKind.Confirm) return <Confirm project={project} onDone={() => setConfirming(false)} />;
  return <StateRow state={state} kind={kind} onConfirm={() => setConfirming(true)} />;
}

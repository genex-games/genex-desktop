/**
 * The optional model check (`V3-Create-Check`, `V3-Create-States`; owner decisions D10 and D12):
 * Genex replays the saved AI moments of the creator's playtests on the models they have — their
 * plans, their OpenRouter key and this Mac, never Genex credits — and shows how each fits, what it
 * costs players and how fast it replies. The creator picks the model players on credits get.
 * Nothing waits for it: Publish goes ahead without a check.
 */
import { type JSX, useCallback, useEffect, useState } from "react";
import type { AiModelRef } from "../../../shared/game-ai.ts";
import { AiCheckFit, type AiCheckResult, AiCheckState, sameModel } from "../../../shared/game-ai-check.ts";
import { GameAiNoticeKind, type GameAiNotice } from "../../../shared/game-ai-views.ts";
import { hostPlatform } from "../../platform.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { MODEL_CHECK_WORDS, problemWords } from "../../words.ts";
import { type CheckRowView, checkIntro, checkRows, strugglesLine } from "./play-ai-view.ts";
import { useGameAiNotices } from "./use-game-ai.ts";

const WORDS = MODEL_CHECK_WORDS;
/** The menu value for no recommendation. */
const NO_PICK = "none";

/** A game's check, read on open and again as main reports progress. */
function useCheck(project: string) {
  const [result, setResult] = useState<AiCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useCallback(async () => {
    try {
      setResult(await window.studio.gameAiCheckState(project));
    } catch (cause) {
      setError(problemWords(cause));
    }
  }, [project]);
  useEffect(() => {
    void read();
  }, [read]);
  useGameAiNotices(
    useCallback(
      (notice: GameAiNotice) => {
        if (notice.kind === GameAiNoticeKind.Check && notice.project === project) void read();
      },
      [project, read],
    ),
  );
  const act = async (step: () => Promise<AiCheckResult>) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await step());
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  return { result, error, busy, act };
}

/** The table: each model, where it runs, how it fits, its cost here and its reply time. */
function CheckTable({ rows }: { rows: readonly CheckRowView[] }): JSX.Element {
  return (
    <table className="play-ai-check-table" data-model-check-table>
      <thead>
        <tr>
          <th scope="col">{WORDS.columns.model}</th>
          <th scope="col">{WORDS.columns.fit}</th>
          <th scope="col">{WORDS.columns.cost}</th>
          <th scope="col">{WORDS.columns.reply}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} data-model-check-row={row.key} data-fit={row.fit}>
            <th scope="row">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-ink">{row.label}</span>
                {row.best && (
                  <span className="model-free-tag" data-model-check-best>
                    {WORDS.best}
                  </span>
                )}
              </span>
              <span className="block truncate text-ink-3">{row.source}</span>
            </th>
            <td data-tone={row.fit === AiCheckFit.Struggles ? "orange" : undefined}>{row.fitText}</td>
            <td className="font-mono">{row.cost}</td>
            <td className="font-mono">{row.reply}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Recommend: the model players on credits get, from the models that fit; or none. */
function RecommendMenu({
  result,
  disabled,
  onRecommend,
}: {
  result: AiCheckResult;
  disabled: boolean;
  onRecommend: (model: AiModelRef | null) => void;
}): JSX.Element {
  const fits = result.rows.filter((row) => row.fit === AiCheckFit.Fits);
  const { recommended } = result;
  const current = recommended ? result.rows.find((row) => sameModel(row.model, recommended)) : null;
  const keyOf = (model: AiModelRef) => `${model.door}/${model.engine}/${model.model}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="secondary" data-model-check-recommend>
          {current ? WORDS.recommend(current.label) : WORDS.recommendNone}
          <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="appearance-menu">
        <DropdownMenuRadioGroup
          value={recommended ? keyOf(recommended) : NO_PICK}
          onValueChange={(value) => onRecommend(fits.find((row) => keyOf(row.model) === value)?.model ?? null)}
        >
          {fits.map((row) => (
            <DropdownMenuRadioItem key={keyOf(row.model)} value={keyOf(row.model)} className="py-2">
              {row.label}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value={NO_PICK} className="py-2">
            {WORDS.noPick}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The presses at the foot, by where the check stands. */
function Presses({
  result,
  busy,
  project,
  act,
  onPlayNow,
  onClose,
}: {
  result: AiCheckResult;
  busy: boolean;
  project: string;
  act: (step: () => Promise<AiCheckResult>) => Promise<void>;
  onPlayNow: () => void;
  onClose: () => void;
}): JSX.Element {
  const start = () => void act(() => window.studio.gameAiCheck(project));
  switch (result.state) {
    case AiCheckState.Empty:
      return (
        <Button variant="default" onClick={onPlayNow} data-model-check-play>
          {WORDS.playNow}
        </Button>
      );
    case AiCheckState.Checking:
      return (
        <Button
          busy={busy}
          onClick={() => void act(() => window.studio.gameAiCheckStop(project))}
          data-model-check-stop
        >
          {WORDS.stop}
        </Button>
      );
    case AiCheckState.Done:
      return (
        <>
          <Button onClick={start} disabled={busy} data-model-check-again>
            {WORDS.again}
          </Button>
          <RecommendMenu
            result={result}
            disabled={busy}
            onRecommend={(model) => void act(() => window.studio.gameAiRecommend(project, model))}
          />
          <Button variant="default" onClick={onClose} data-model-check-done>
            {WORDS.close}
          </Button>
        </>
      );
    default:
      return (
        <Button variant="default" busy={busy} onClick={start} data-model-check-start>
          {result.state === AiCheckState.Failed ? WORDS.again : WORDS.start}
        </Button>
      );
  }
}

/** Models for a game: the check, over Create. */
export function ModelCheckDialog({
  project,
  title,
  onPlayNow,
  onClose,
}: {
  project: string;
  title: string;
  onPlayNow: () => void;
  onClose: () => void;
}): JSX.Element {
  const { result, error, busy, act } = useCheck(project);
  const platform = hostPlatform();
  const struggles = result ? strugglesLine(result) : null;
  return (
    <DialogSurface title={WORDS.title(title)} onDismiss={onClose} size="xl" testId="model-check">
      <div className="play-ai-check" data-model-check={result?.state ?? "loading"}>
        {result && <p className="text-ink-2">{checkIntro(result, title, platform)}</p>}
        {result?.state === AiCheckState.Checking && <p className="text-ink-3">{WORDS.checkingNote}</p>}
        {result && result.rows.length > 0 && result.state !== AiCheckState.Checking && (
          <CheckTable rows={checkRows(result, platform)} />
        )}
        {struggles && result?.state === AiCheckState.Done && <p className="text-ink-3">{struggles}</p>}
        {error && (
          <p role="alert" className="text-red">
            {error}
          </p>
        )}
        {result && (
          <div className="play-ai-dialog-presses">
            {result.state === AiCheckState.Done && <span className="mr-auto text-ink-3">{WORDS.pickNote}</span>}
            <Presses result={result} busy={busy} project={project} act={act} onPlayNow={onPlayNow} onClose={onClose} />
          </div>
        )}
      </div>
    </DialogSurface>
  );
}

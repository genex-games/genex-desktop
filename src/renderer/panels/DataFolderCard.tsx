/**
 * Settings → Storage's data folder (Windows): the folder Genex keeps its files in, with Change…
 * to pick another one. Main checks the folder; a good one asks before Genex restarts to move its
 * files there, and a refused one says why. A move that did not happen is said until the next one.
 */
import { type JSX, useState } from "react";
import { pathParts } from "../../shared/path-label.ts";
import type { DataFolderChoice, DataFolderState } from "../../shared/data-folder.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmSheet } from "../ui/Confirm.tsx";
import { Icon } from "../ui/icons.tsx";
import { DATA_FOLDER_PROBLEM_WORDS, DATA_FOLDER_WORDS as WORDS, problemWords } from "../words.ts";

/** A folder main checked and found good: where the files would go and how much moves. */
type Accepted = Extract<DataFolderChoice, { ok: true }>;

export function DataFolderCard({ state }: { state: DataFolderState }): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [moving, setMoving] = useState(false);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answered = (choice: DataFolderChoice | null): void => {
    if (!choice) return;
    if (choice.ok) setAccepted(choice);
    else setError(DATA_FOLDER_PROBLEM_WORDS[choice.problem]);
  };
  const choose = async (): Promise<void> => {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      answered(await window.studio.chooseDataFolder());
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setChecking(false);
    }
  };
  const move = async (): Promise<void> => {
    setAccepted(null);
    setMoving(true);
    try {
      const choice = await window.studio.moveDataFolder();
      // A good answer restarts Genex; only a refusal comes back to say why.
      if (!choice.ok) setError(DATA_FOLDER_PROBLEM_WORDS[choice.problem]);
    } catch (cause) {
      setError(problemWords(cause));
    }
    setMoving(false);
  };
  const { parent, leaf } = pathParts(state.dir);
  return (
    <section aria-label={WORDS.title} data-data-folder className="settings-card">
      {accepted && (
        <ConfirmSheet
          title={WORDS.moveTitle(accepted.bytes, accepted.to)}
          body={WORDS.moveBody}
          testId="data-folder-move"
          onDismiss={() => setAccepted(null)}
          choices={[
            { label: WORDS.keep, onChoose: () => setAccepted(null) },
            { label: WORDS.move, onChoose: () => void move() },
          ]}
        />
      )}
      <h3 className="settings-card-title">{WORDS.title}</h3>
      <div className="mt-2.5 flex min-w-0 items-center gap-2">
        <div data-data-folder-path title={state.dir} className="settings-path">
          <Icon name="folder" size={14} className="shrink-0 text-ink-3" />
          {/* One run of text: the parent's separator sits right against the folder's name. */}
          <span className="flex min-w-0">
            <span className="min-w-0 truncate text-ink-3">{parent}</span>
            <span className="shrink-0 whitespace-nowrap text-ink">{leaf}</span>
          </span>
        </div>
        <Button data-data-folder-change disabled={checking || moving} onClick={() => void choose()} className="h-9">
          {checking ? WORDS.checking : WORDS.change}
        </Button>
      </div>
      <p className="mt-2.5 text-ink-3">{WORDS.hint}</p>
      {state.failed && !error && (
        <p data-data-folder-failed className="mt-2 text-orange">
          {WORDS.failed(state.failed.to, state.failed.problem)}
        </p>
      )}
      {state.kept.map((dir) => (
        <p key={dir} data-data-folder-kept className="mt-2 text-ink-3">
          {WORDS.kept(dir)}
        </p>
      ))}
      {error && (
        <p role="alert" className="mt-2 text-orange">
          {error}
        </p>
      )}
    </section>
  );
}

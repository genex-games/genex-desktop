/**
 * The "re-take the seed copy" remedy for harness parts Harness changed before Rust games: a Rust
 * night refuses them by name, and each row lays the shipped copy down again on the person's press
 * (`studio:seed.retake`), keeping Harness's change as a patch beside it. Each row then says where
 * the patch went, or why nothing was changed. The person starts it; an agent never does.
 */
import { type JSX, useState } from "react";
import type { SeedRetakeAnswer } from "../../shared/seed-retake.ts";
import { Button } from "../ui/Button.tsx";
import { problemWords, SEED_RETAKE_WORDS } from "../words.ts";

/** One part's state: untouched, asked, answered, or failed before an answer. */
type RowState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answered"; answer: SeedRetakeAnswer }
  | {
      kind: "failed";
      error: string;
    };

/** One kept part: its path, its button until it is re-taken, and how the re-take went. */
function RetakeRow({
  module,
  state,
  onRetake,
}: {
  module: string;
  state: RowState;
  onRetake: () => void;
}): JSX.Element {
  const retaken = state.kind === "answered" && state.answer.ok;
  return (
    <li data-seed-retake={module} className="flex flex-col gap-1 py-1.5">
      <span className="flex min-w-0 items-center justify-between gap-4">
        <span className="min-w-0 truncate font-mono text-xs text-ink" title={module}>
          {module}
        </span>
        {!retaken && (
          <Button
            data-seed-retake-button={module}
            variant="secondary"
            disabled={state.kind === "asking"}
            onClick={onRetake}
          >
            {state.kind === "asking" ? SEED_RETAKE_WORDS.retaking : SEED_RETAKE_WORDS.retake}
          </Button>
        )}
      </span>
      {state.kind === "answered" && (
        <span
          role="status"
          data-seed-retake-answer={state.answer.ok ? "retaken" : state.answer.code}
          className="text-xs leading-snug text-pretty text-ink-3"
        >
          {SEED_RETAKE_WORDS.answer(state.answer)}
        </span>
      )}
      {state.kind === "failed" && (
        <span role="alert" className="text-xs leading-snug text-red">
          {state.error}
        </span>
      )}
    </li>
  );
}

/**
 * The kept parts, each with its re-take button, and the parts re-taken here with how it went.
 * `onRetaken` runs after a part is re-taken, so the opener can read the status again.
 */
export function SeedRetake({
  title,
  intro,
  modules,
  onRetaken,
}: {
  title: string;
  intro: string;
  modules: readonly string[];
  onRetaken?: () => void;
}): JSX.Element | null {
  const [states, setStates] = useState<Readonly<Record<string, RowState>>>({});
  // A part re-taken here stays listed with its answer after the status no longer names it.
  const answered = Object.keys(states).filter((module) => !modules.includes(module));
  const shown = [...modules, ...answered];
  if (shown.length === 0) return null;
  const set = (module: string, state: RowState) => setStates((current) => ({ ...current, [module]: state }));
  const retake = async (module: string) => {
    set(module, { kind: "asking" });
    try {
      const answer = await window.studio.retakeSeedModule(module);
      set(module, { kind: "answered", answer });
      if (answer.ok) onRetaken?.();
    } catch (cause) {
      set(module, { kind: "failed", error: problemWords(cause) });
    }
  };
  return (
    <section data-seed-retakes className="flex flex-col gap-1">
      <span className="text-body-sm font-medium text-ink">{title}</span>
      <span className="text-xs leading-snug text-pretty text-ink-3">{intro}</span>
      <ul className="m-0 flex list-none flex-col p-0">
        {shown.map((module) => (
          <RetakeRow
            key={module}
            module={module}
            state={states[module] ?? { kind: "idle" }}
            onRetake={() => void retake(module)}
          />
        ))}
      </ul>
    </section>
  );
}

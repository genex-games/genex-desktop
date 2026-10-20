/** Settings → Games: the folder new games are created in. */
import { useState, type JSX } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { problemWords } from "../words.ts";
import { pathParts } from "../../shared/path-label.ts";

/** The section's own words. */
const WORDS = {
  title: "Default game folder",
  hint: "New games are created here. Games you already have stay where they are.",
  change: "Change…",
  choosing: "Choosing…",
} as const;

export function GamesSection({
  rootLabel,
  onRoot,
}: {
  rootLabel: string;
  onRoot: (label: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const label = await window.studio.chooseGamesRoot();
      if (label) onRoot(label);
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  const { parent, leaf } = pathParts(rootLabel);
  return (
    <div data-games-settings className="appearance-section">
      <section aria-label={WORDS.title} className="settings-card">
        <h3 className="settings-card-title">{WORDS.title}</h3>
        <div className="mt-2.5 flex min-w-0 items-center gap-2">
          <div data-games-root title={rootLabel} className="settings-path">
            <Icon name="folder" size={14} className="shrink-0 text-ink-3" />
            {/* One run of text: the parent's separator sits right against the folder's name. */}
            <span className="flex min-w-0">
              <span className="min-w-0 truncate text-ink-3">{parent}</span>
              <span className="shrink-0 whitespace-nowrap text-ink">{leaf}</span>
            </span>
          </div>
          <Button disabled={busy} onClick={() => void choose()} className="h-9">
            {busy ? WORDS.choosing : WORDS.change}
          </Button>
        </div>
        <p className="mt-2.5 text-ink-3">{WORDS.hint}</p>
      </section>
      {error && (
        <p role="alert" className="mt-2 text-red">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Settings → Privacy: Share build metrics (off by default), See what would be sent, Delete what I
 * shared, and Genex's privacy policy and terms at the bottom of the tab.
 */
import { type JSX, useEffect, useState } from "react";
import type { FieldRow, RunSharingStatus } from "../../shared/run-sharing.ts";
import { Button } from "../ui/Button.tsx";
import { Switch } from "../ui/switch.tsx";
import { PRIVACY_WORDS, privacyDeleteWords, problemWords } from "../words.ts";

/** Where Privacy's links go, in the order the line shows them. */
const POLICY_LINKS = [
  { id: "policy", url: "https://genex.games/privacy", label: PRIVACY_WORDS.links.policy },
  { id: "terms", url: "https://genex.games/terms", label: PRIVACY_WORDS.links.terms },
] as const;

/** The links at the bottom of the tab, quiet and underlined as links read; each opens in the browser. */
function PolicyLinks(): JSX.Element {
  return (
    <p
      data-privacy-links
      className="mt-auto flex flex-wrap gap-x-4 gap-y-1 px-4 pt-6 text-body-sm text-muted-foreground"
    >
      {POLICY_LINKS.map((link) => (
        <button
          key={link.id}
          type="button"
          data-privacy-link={link.id}
          onClick={() => void window.studio.openUrl(link.url)}
          className="cursor-pointer underline decoration-current/35 decoration-[0.5px] underline-offset-[5px] hover:text-ink-2 hover:decoration-current/70 focus-visible:text-ink-2 focus-visible:outline-none"
        >
          {link.label}
        </button>
      ))}
    </p>
  );
}

/** The line under the switch: paused, a launch that never sends, rows waiting, or nothing. */
function statusLine(status: RunSharingStatus): string | null {
  if (status.paused) return PRIVACY_WORDS.paused;
  if (!status.sends) return PRIVACY_WORDS.notSent;
  return status.queued > 0 ? PRIVACY_WORDS.queued(status.queued) : null;
}

/** The switch, with what it sends and never sends. */
function ShareRow({
  status,
  busy,
  onChange,
}: {
  status: RunSharingStatus;
  busy: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  const line = statusLine(status);
  return (
    <div className="appearance-row">
      <label htmlFor="privacy-share-builds" className="flex min-w-0 flex-col">
        <span className="text-ink">{PRIVACY_WORDS.share}</span>
        <span className="text-ink-3">{PRIVACY_WORDS.shareWhat}</span>
        {line && (
          <span data-run-sharing-state role="status" className="text-ink-2">
            {line}
          </span>
        )}
      </label>
      <Switch id="privacy-share-builds" checked={status.on} disabled={busy} onCheckedChange={onChange} />
    </div>
  );
}

/** See what would be sent: the real next row, disclosed on request. */
function PreviewRow(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [row, setRow] = useState<FieldRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const show = async () => {
    setOpen(true);
    setError(null);
    try {
      setRow(await window.studio.runSharingPreview());
    } catch (cause) {
      setError(problemWords(cause));
    }
  };
  return (
    <div className="appearance-row flex-wrap">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-ink">{PRIVACY_WORDS.preview}</span>
        <span className="text-ink-3">{PRIVACY_WORDS.previewWhat}</span>
      </span>
      <Button
        aria-expanded={open}
        aria-controls="privacy-preview"
        onClick={() => (open ? setOpen(false) : void show())}
      >
        {open ? PRIVACY_WORDS.hidePreview : PRIVACY_WORDS.preview}
      </Button>
      {open && (
        <div id="privacy-preview" data-run-sharing-preview className="basis-full">
          {error && (
            <p role="alert" className="text-red">
              {error}
            </p>
          )}
          {row === null && <p className="text-ink-3">{PRIVACY_WORDS.previewEmpty}</p>}
          {row && (
            <pre className="max-h-72 overflow-auto rounded-control bg-field p-3 font-mono text-micro text-ink-2 [overflow-wrap:anywhere] whitespace-pre-wrap">
              {JSON.stringify(row, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Delete what I shared, with an inline second step: the deletion cannot be undone. */
function DeleteRow(): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    try {
      setAnswer(privacyDeleteWords(await window.studio.deleteSharedRuns()));
    } catch (cause) {
      setAnswer(problemWords(cause));
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  return (
    <div className="appearance-row">
      <span className="flex min-w-0 flex-col">
        <span className="text-ink">{asking ? PRIVACY_WORDS.deleteAsk : PRIVACY_WORDS.delete}</span>
        <span className="text-ink-3">{PRIVACY_WORDS.deleteWhat}</span>
        {answer && (
          <span data-run-sharing-deleted role="status" className="text-ink-2">
            {answer}
          </span>
        )}
      </span>
      {asking ? (
        <span className="flex shrink-0 gap-2">
          <Button data-run-sharing-delete="cancel" disabled={busy} onClick={() => setAsking(false)}>
            {PRIVACY_WORDS.deleteCancel}
          </Button>
          <Button data-run-sharing-delete="confirm" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? PRIVACY_WORDS.deleting : PRIVACY_WORDS.deleteConfirm}
          </Button>
        </span>
      ) : (
        <Button data-run-sharing-delete="ask" onClick={() => setAsking(true)}>
          {PRIVACY_WORDS.delete}
        </Button>
      )}
    </div>
  );
}

/** Settings → Privacy. */
export function PrivacySection(): JSX.Element {
  const [status, setStatus] = useState<RunSharingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.studio
      .runSharingStatus()
      .then(setStatus)
      .catch((cause) => setError(problemWords(cause)));
  }, []);
  const change = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.studio.setRunSharing(on));
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  const alert = error && (
    <p role="alert" className="mt-2 text-red">
      {error}
    </p>
  );
  if (!status)
    return (
      <div data-privacy-settings className="appearance-section flex min-h-full flex-col">
        {alert || (
          <p role="status" className="text-ink-3">
            {PRIVACY_WORDS.loading}
          </p>
        )}
        <PolicyLinks />
      </div>
    );
  if (!status.available)
    return (
      <div data-privacy-settings className="appearance-section flex min-h-full flex-col">
        <p className="mb-4 text-ink-3">{PRIVACY_WORDS.removed}</p>
        <PolicyLinks />
      </div>
    );
  return (
    <div data-privacy-settings className="appearance-section flex min-h-full flex-col">
      <section className="appearance-theme settings-rows">
        <ShareRow status={status} busy={busy} onChange={(on) => void change(on)} />
        <PreviewRow />
        <DeleteRow />
      </section>
      {alert}
      <PolicyLinks />
    </div>
  );
}

/**
 * Settings → About: what Genex is and which version runs, Check for Updates with what it found and
 * the one next step, the website, the source and the licenses, and the version info to copy.
 */
import { type JSX, useEffect, useState } from "react";
import { type AppAbout, UpdateAction, type UpdateCheckResult, UpdateCheckStatus } from "../../shared/app-update.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { ABOUT_WORDS, LICENSE_WORDS, problemWords } from "../words.ts";
import { LicensesDialog } from "./LicensesDialog.tsx";

/** Where About's links go. */
const LINKS = {
  website: "https://genex.games",
  source: "https://github.com/genex-games/genex-desktop",
} as const;
/** How long "Copied" stands in for Copy version info. */
const COPIED_MS = 1_500;

/** The line a check's answer reads as. */
function resultLine(result: UpdateCheckResult): string {
  const version = result.update?.version ?? null;
  if (result.status === UpdateCheckStatus.Current) return ABOUT_WORDS.current;
  if (result.status === UpdateCheckStatus.Downloading) return ABOUT_WORDS.downloading;
  if (result.status === UpdateCheckStatus.Off) return ABOUT_WORDS.off;
  if (result.status === UpdateCheckStatus.System) return ABOUT_WORDS.system;
  if (result.status === UpdateCheckStatus.Failed) return ABOUT_WORDS.failed;
  return result.update?.action === UpdateAction.Download ? ABOUT_WORDS.available(version) : ABOUT_WORDS.ready(version);
}

/** The step a waiting update offers: relaunch into it, or open its download page. */
function NextStep({ result }: { result: UpdateCheckResult }): JSX.Element | null {
  if (result.status !== UpdateCheckStatus.Waiting || !result.update) return null;
  if (result.update.action === UpdateAction.Download)
    return (
      <Button data-about-download onClick={() => void window.studio.openUpdateDownload()}>
        {ABOUT_WORDS.download}
      </Button>
    );
  return (
    <Button data-about-restart onClick={() => void window.studio.restartToUpdate()}>
      {ABOUT_WORDS.restart}
    </Button>
  );
}

/** The Genex mark beside the name. */
function GenexMark(): JSX.Element {
  return (
    <svg width="48" height="38" viewBox="0 0 683 533" aria-hidden="true" className="shrink-0 fill-ink">
      <path d="M526.479 314.98H239.981V266.964H683V397.295C683 397.295 648.57 532.96 347.968 532.96C347.968 532.96 0 542.868 0 252.483C0 -16.5617 376.426 0.205967 376.426 0.205967C666.184 0.205967 683 141.207 683 141.207L607.973 153.401C607.973 153.401 584.689 45.1737 371.252 45.1737C371.252 45.1737 85.375 34.5034 85.375 257.818C85.375 257.818 78.9072 480.37 351.849 486.467C566.58 493.327 597.625 379.002 600.212 359.186C607.973 334.034 574.341 314.98 526.479 314.98Z" />
    </svg>
  );
}

/** Check for Updates, in its own card. */
function Updates(): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setResult(await window.studio.checkForUpdates());
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section aria-label={ABOUT_WORDS.updates} data-row className="settings-card">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm text-ink">{ABOUT_WORDS.updates}</span>
        {result && (
          <span data-about-update-state role="status" className="text-ink-3">
            {resultLine(result)}
          </span>
        )}
        {error && (
          <span role="alert" className="text-red">
            {error}
          </span>
        )}
      </span>
      {result && <NextStep result={result} />}
      <Button data-about-check aria-busy={checking} disabled={checking} onClick={() => void check()}>
        {checking ? ABOUT_WORDS.checking : ABOUT_WORDS.check}
      </Button>
    </section>
  );
}

/** One row of the links card: what it is, and where it goes. */
function LinkRow({
  label,
  value,
  external,
  onOpen,
  ...data
}: {
  label: string;
  value: string;
  external: boolean;
  onOpen: () => void;
} & Record<`data-${string}`, string | boolean>): JSX.Element {
  return (
    <li className="settings-list-group">
      <button
        type="button"
        {...data}
        onClick={onOpen}
        className="settings-list-row flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 px-3 text-left hover:bg-foreground/5"
      >
        <span className="text-sm text-ink">{label}</span>
        <span className="flex items-center gap-1.5 font-mono text-xs text-ink-3">
          {value}
          <Icon name={external ? "arrow-up-right" : "chevron-right"} size={12} />
        </span>
      </button>
    </li>
  );
}

/** "Genex 0.4.2 · macOS · arm64", and Copy version info beside it. */
function VersionInfo({ about }: { about: AppAbout }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const info = ABOUT_WORDS.info(about.version, about.platform, about.arch);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => void navigator.clipboard.writeText(info).then(() => setCopied(true));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4">
      <span data-about-info className="font-mono text-micro text-ink-3">
        {info}
      </span>
      <Button data-about-copy variant="ghost" className="h-7 gap-1.5 px-2.5 text-xs text-ink-3" onClick={copy}>
        <Icon name="copy" size={12} />
        {copied ? ABOUT_WORDS.copied : ABOUT_WORDS.copy}
      </Button>
    </div>
  );
}

export function AboutSection(): JSX.Element {
  const [about, setAbout] = useState<AppAbout | null>(null);
  const [licenses, setLicenses] = useState(false);
  useEffect(() => {
    let current = true;
    void window.studio
      .appAbout()
      .then((answer) => {
        if (current) setAbout(answer);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  const open = (url: string) => () => void window.studio.openUrl(url);
  return (
    <div data-about-settings className="appearance-section flex flex-col gap-4">
      <section className="flex items-center gap-4 px-4 pt-5">
        <GenexMark />
        <span className="flex flex-col gap-0.5">
          <span className="text-xl font-medium text-ink">{ABOUT_WORDS.product}</span>
          <span data-about-version className="font-mono text-xs text-ink-3">
            {ABOUT_WORDS.versionLine(about?.version ?? null)}
          </span>
        </span>
      </section>
      <p className="-mt-2 max-w-[520px] px-4 text-sm text-ink-2">{ABOUT_WORDS.tagline}</p>
      <Updates />
      <ul data-list className="settings-card">
        <LinkRow label={ABOUT_WORDS.website} value="genex.games" external onOpen={open(LINKS.website)} />
        <LinkRow label={ABOUT_WORDS.source} value="GitHub" external onOpen={open(LINKS.source)} />
        <LinkRow
          data-settings-licenses
          label={ABOUT_WORDS.licenses}
          value={LICENSE_WORDS.link}
          external={false}
          onOpen={() => setLicenses(true)}
        />
      </ul>
      {about && <VersionInfo about={about} />}
      {licenses && <LicensesDialog onDismiss={() => setLicenses(false)} />}
    </div>
  );
}

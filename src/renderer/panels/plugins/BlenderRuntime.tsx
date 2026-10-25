/**
 * Local Blender's page parts, drawn by Studio in the app's own type and buttons: the setup card
 * (ready, not installed, downloading) that replaces the plugin's sandboxed frame, and what it does.
 */
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { InstallPhase } from "../../../shared/model-install.ts";
import {
  isLocalBlenderStatus,
  LOCAL_BLENDER_PLUGIN_ID,
  LocalBlenderAction,
  type LocalBlenderStatus,
} from "../../../shared/local-blender.ts";
import { isUserCancelled } from "../../../shared/errors.ts";
import { NativeRuntimeState, type PluginInfo } from "../../../shared/plugins.ts";
import { StudioPlatform } from "../../../shared/boot.ts";
import { runPluginAction } from "../../plugin-actions.ts";
import { hostPlatform } from "../../platform.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon, type IconName } from "../../ui/icons.tsx";
import { Pending } from "../../ui/Pending.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import { Section } from "./rows.tsx";

const WORDS = PLUGINS_WORDS.blender;
/** How often the card re-reads Blender while a download runs. */
const DOWNLOAD_POLL_MS = 2 * SECOND_MS;
const MEGABYTE = 1024 * 1024;

/** Where Blender is, as a person knows it: the app, not the binary inside it. */
const appBundle = (binary: string): string => binary.replace(/(\.app)\/.*$/, "$1");

/** The plugin setting that names the person's own Blender program (`setting:program` in its manifest). */
const PROGRAM_SETTING = "program";
/** What Choose Blender asks the file picker for: Blender's program on Windows. */
const PROGRAM_REQUEST = { title: WORDS.chooseTitle, extensions: ["exe"] };

/** Bytes as the card says them: "346 MB". */
const megabytes = (bytes: number): string => `${Math.round(bytes / MEGABYTE)} MB`;

/** Blender's status, re-read on open, on focus, and every two seconds while a download runs. */
function useBlenderStatus(plugin: PluginInfo) {
  const [status, setStatus] = useState<LocalBlenderStatus | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.studio.pluginAction(LOCAL_BLENDER_PLUGIN_ID, LocalBlenderAction.Status, {});
      if (isLocalBlenderStatus(next)) setStatus(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const downloading = Boolean(status?.installation?.active);
  useEffect(() => {
    void refresh();
    const again = (): void => void refresh();
    window.addEventListener("focus", again);
    const timer = downloading ? window.setInterval(again, DOWNLOAD_POLL_MS) : undefined;
    return () => {
      window.removeEventListener("focus", again);
      if (timer) window.clearInterval(timer);
    };
  }, [downloading, refresh]);
  const act = async (name: string): Promise<void> => {
    setError("");
    // A download runs for minutes; the card follows it by status soon after it starts, not by waiting on it.
    const soon = window.setTimeout(() => void refresh(), DOWNLOAD_POLL_MS / 4);
    try {
      // Download is a confirmed action: it goes through the review, its ticket and the native approval.
      await runPluginAction({ plugin, name, args: {}, project: null, review: (request) => request.resolve(false) });
    } catch (e) {
      if (!isUserCancelled(e)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      window.clearTimeout(soon);
      void refresh();
    }
  };
  /** Choose file, then use the chosen program as Blender: a cancelled picker changes nothing. */
  const choose = async (): Promise<void> => {
    setError("");
    try {
      const program = await window.studio.pluginChooseFile(LOCAL_BLENDER_PLUGIN_ID, PROGRAM_REQUEST);
      if (!program) return;
      await window.studio.pluginSetSetting(LOCAL_BLENDER_PLUGIN_ID, PROGRAM_SETTING, program);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };
  return { status, error, refresh, act, choose };
}

function Prompt({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="genex-account-row">
      <div className="genex-account-copy">
        <h2>{title}</h2>
        {children}
      </div>
      {actions && <div className="genex-account-actions">{actions}</div>}
    </div>
  );
}

/** What the card says when Blender can't be used yet: too old, failing to start, or not installed. */
function notReadyWords(runtime: LocalBlenderStatus["runtime"], pinned: string, size: string) {
  if (runtime.state === NativeRuntimeState.Incompatible)
    return { title: WORDS.oldTitle(runtime.version ?? ""), text: WORDS.oldText(pinned, size) };
  if (runtime.state === NativeRuntimeState.Failed) return { title: WORDS.failedTitle, text: runtime.detail };
  if (!pinned) return { title: WORDS.missingTitle, text: WORDS.missingOwnText };
  return { title: WORDS.missingTitle, text: WORDS.missingText(pinned, size) };
}

/** The card's body for where Blender stands: ready, downloading, or missing (or too old) with Download. */
function RuntimeBody({ blender }: { blender: ReturnType<typeof useBlenderStatus> }) {
  const { status } = blender;
  if (!status) return <Pending label={WORDS.checking} working />;
  // The download Genex pins for this computer, as the host found it; none where it pins none.
  const install = status.runtime.download;
  const pinned = /(\d+\.\d+\.\d+)/.exec(install?.url ?? "")?.[1] ?? "";
  const size = install ? megabytes(install.bytes) : "";
  const job = status.installation;
  if (job?.active)
    return (
      <>
        <Prompt
          title={job.phase === InstallPhase.Downloading ? WORDS.downloading(pinned) : WORDS.installing(pinned)}
          actions={<Button onClick={() => void blender.act(LocalBlenderAction.CancelInstall)}>{WORDS.cancel}</Button>}
        >
          <p>{WORDS.progress(megabytes(job.completed), megabytes(job.total))}</p>
        </Prompt>
        <progress
          className="blender-progress"
          max={job.total}
          value={job.completed}
          aria-label={WORDS.downloading(pinned)}
        />
      </>
    );
  const { runtime } = status;
  if (runtime.state === NativeRuntimeState.Ready)
    return (
      <Prompt
        title={
          <>
            <span className="genex-dot" aria-hidden="true" />
            {WORDS.ready(runtime.version ?? "")}
          </>
        }
        actions={<Button onClick={() => void blender.refresh()}>{WORDS.checkAgain}</Button>}
      >
        {runtime.path && <p className="blender-path">{appBundle(runtime.path)}</p>}
      </Prompt>
    );
  const { title, text } = notReadyWords(runtime, pinned, size);
  // On Windows Blender is a program anywhere on disk, so the person can point at their own.
  const canChoose = hostPlatform() === StudioPlatform.Windows;
  return (
    <Prompt
      title={title}
      actions={
        <>
          {install && (
            <Button variant="default" size="default" onClick={() => void blender.act(install.action)}>
              {WORDS.download}
            </Button>
          )}
          {canChoose && <Button onClick={() => void blender.choose()}>{WORDS.choose}</Button>}
        </>
      }
    >
      <p>{text}</p>
    </Prompt>
  );
}

/** Local Blender's setup card, first on its page. */
export function BlenderRuntimeCard({ plugin }: { plugin: PluginInfo }): JSX.Element {
  const blender = useBlenderStatus(plugin);
  const state = blender.status?.installation?.active ? "downloading" : blender.status?.runtime.state;
  return (
    <section
      className="genex-account"
      data-blender-runtime={state ?? "checking"}
      aria-live="polite"
      aria-label={WORDS.card}
    >
      <RuntimeBody blender={blender} />
      {blender.error && (
        <p role="alert" className="genex-error">
          {blender.error}
        </p>
      )}
    </section>
  );
}

const DOES: ReadonlyArray<[IconName, { title: string; text: string }]> = [
  ["box", WORDS.model],
  ["undo", WORDS.change],
];

/** What Local Blender does, and when agents reach for it. */
export function BlenderDoes(): JSX.Element {
  return (
    <Section title={WORDS.doesTitle}>
      <p className="genex-section-intro">{WORDS.doesIntro}</p>
      <ul className="genex-makes">
        {DOES.map(([icon, words]) => (
          <li key={words.title}>
            <span className="genex-make-icon" aria-hidden="true">
              <Icon name={icon} size={20} />
            </span>
            <span className="genex-make-copy">
              <span className="genex-make-title">{words.title}</span>
              <span className="genex-make-text">{words.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

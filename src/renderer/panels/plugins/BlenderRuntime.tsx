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
import { NativeRuntimeState, type PluginInfo } from "../../../shared/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon, type IconName } from "../../ui/icons.tsx";
import { Pending } from "../../ui/Pending.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import { Section } from "./rows.tsx";
import { hostPlatform } from "../../platform.ts";
import { StudioPlatform } from "../../../shared/boot.ts";

const WORDS = PLUGINS_WORDS.blender;
/** How often the card re-reads Blender while a download runs. */
const DOWNLOAD_POLL_MS = 2 * SECOND_MS;
const MEGABYTE = 1024 * 1024;

/** Where Blender is, as a person knows it: the app, not the binary inside it. */
const appBundle = (binary: string): string => binary.replace(/(\.app)\/.*$/, "$1");

/** Bytes as the card says them: "346 MB". */
const megabytes = (bytes: number): string => `${Math.round(bytes / MEGABYTE)} MB`;

/** Blender's status, re-read on open, on focus, and every two seconds while a download runs. */
function useBlenderStatus() {
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
      await window.studio.pluginAction(LOCAL_BLENDER_PLUGIN_ID, name, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      window.clearTimeout(soon);
      void refresh();
    }
  };
  return { status, error, refresh, act };
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
  return { title: WORDS.missingTitle, text: WORDS.missingText(pinned, size) };
}

/** The card's body for where Blender stands: ready, downloading, or missing (or too old) with Download. */
function RuntimeBody({ plugin, blender }: { plugin: PluginInfo; blender: ReturnType<typeof useBlenderStatus> }) {
  const { status } = blender;
  const declared = plugin.manifest.nativeRuntimes?.[0];
  const install = status?.runtime.install ?? (!declared?.platforms ? declared?.install : undefined);
  const pinned = /(\d+\.\d+\.\d+)/.exec(install?.url ?? "")?.[1] ?? "";
  const size = install ? megabytes(install.bytes) : "";
  if (!status) return <Pending label={WORDS.checking} className="genex-checking" />;
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
    return <ReadyRuntime runtime={runtime} install={install} blender={blender} />;
  if (!install)
    return (
      <Prompt title={WORDS.missingTitle}>
        <p>{runtime.detail}</p>
      </Prompt>
    );
  const { title, text } = notReadyWords(runtime, pinned, size);
  return (
    <Prompt
      title={title}
      actions={
        install && (
          <Button variant="default" size="default" onClick={() => void blender.act(install.action)}>
            {WORDS.download}
          </Button>
        )
      }
    >
      <p>{text}</p>
    </Prompt>
  );
}

function ReadyRuntime({
  runtime,
  install,
  blender,
}: {
  runtime: LocalBlenderStatus["runtime"];
  install: LocalBlenderStatus["runtime"]["install"];
  blender: ReturnType<typeof useBlenderStatus>;
}) {
  const privateCopy = hostPlatform() === StudioPlatform.Windows && runtime.managed === false && install;
  return (
    <Prompt
      title={
        <>
          <span className="genex-dot" aria-hidden="true" />
          {WORDS.ready(runtime.version ?? "")}
        </>
      }
      actions={
        <>
          <Button onClick={() => void blender.refresh()}>{WORDS.checkAgain}</Button>
          {privateCopy ? (
            <Button onClick={() => void blender.act(privateCopy.action)}>{WORDS.privateCopy}</Button>
          ) : null}
        </>
      }
    >
      {runtime.path && <p className="blender-path">{appBundle(runtime.path)}</p>}
    </Prompt>
  );
}

/** Local Blender's setup card, first on its page. */
export function BlenderRuntimeCard({ plugin }: { plugin: PluginInfo }): JSX.Element {
  const blender = useBlenderStatus();
  const state = blender.status?.installation?.active ? "downloading" : blender.status?.runtime.state;
  return (
    <section
      className="genex-account"
      data-blender-runtime={state ?? "checking"}
      aria-live="polite"
      aria-label={WORDS.card}
    >
      <RuntimeBody plugin={plugin} blender={blender} />
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

/** Settings → Local Models: hardware-aware downloads and their durable installation status. */
import type { FormEvent, JSX } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { errorMessage } from "../../shared/errors.ts";
import { EngineId } from "../../shared/providers.ts";
import type { LocalModelChoice } from "../../shared/studio-api.ts";
import { UiEvent, type UiEventMap } from "../../shared/ui-events.ts";
import type { EngineDescriptor } from "../types.ts";
import { needsOllama, ollamaDownloadPage, stoppedDownload, type StoppedDownload } from "../model-download.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import type { ModelSettingsProps } from "./ModelsSection.tsx";
import { Pending } from "../ui/Pending.tsx";

/** Where the Add from Ollama hint sends the user to find a model's name. */
const OLLAMA_LIBRARY_URL = "https://ollama.com/search";

/** What deleting an installed model says. */
const WORDS = {
  delete: "Delete",
  deleteModel: (title: string) => `Delete ${title}`,
  deleteAsk: "Delete it from this Mac? You can download it again.",
  deleteCancel: "Cancel",
  deleting: "Deleting…",
} as const;

type Hardware = Awaited<ReturnType<typeof window.studio.hardware>>;
type Lookup = Awaited<ReturnType<typeof window.studio.lookupModel>>;

/** Ollama names an untagged pull `:latest`; compare installed models the same way. */
const canonical = (id: string): string => (id.includes(":") ? id : `${id}:latest`);

/** Opens Ollama's download page for the platform main runs on; the person installs it there. */
const openOllamaDownload = (): void =>
  void window.studio.bootState().then(({ platform }) => window.studio.openUrl(ollamaDownloadPage(platform)));

/** "uses ~22 of 23 GB" with a small meter, or the Mac it needs. */
function Fit({
  fits,
  needGb,
  needsRamGb,
  usable,
}: {
  fits: boolean;
  needGb: number;
  needsRamGb: number | null;
  usable: number;
}): JSX.Element {
  if (!fits) {
    return (
      <span className="text-orange">{needsRamGb ? `Needs a ${needsRamGb} GB Mac` : "Too large to run locally"}</span>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="inline-flex h-1 w-14 overflow-hidden rounded-full bg-hover">
        <span
          className="h-full bg-accent-primary"
          style={{ width: `${Math.min(100, Math.round((needGb / usable) * 100))}%` }}
        />
      </span>
      <span>
        uses ~{Math.round(needGb)} of {Math.round(usable)} GB
      </span>
    </>
  );
}

/** A download's progress as a thin bar. */
function ProgressBar({ label, percent, animated }: { label: string; percent: number; animated: boolean }): JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover"
    >
      <div
        className={
          animated
            ? "h-full bg-accent-primary transition-[width] duration-300 motion-reduce:transition-none"
            : "h-full bg-accent-primary"
        }
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** The quiet, disabled button a model already on this Mac wears. */
function InstalledBadge(): JSX.Element {
  return (
    <Button disabled className="bg-transparent text-muted-foreground">
      <Icon name="check" size={14} />
      Installed
    </Button>
  );
}

/** One installed row's Delete: whether it asks or deletes now, and its steps. */
interface RowDeletion {
  asking: boolean;
  removing: boolean;
  /** Another download or deletion is running. */
  disabled: boolean;
  ask: () => void;
  keep: () => void;
  confirm: () => void;
}

/**
 * Installed, with Delete behind a second step. Asking moves focus to Cancel, the safe choice;
 * Cancel, or a refusal, hands it back to the trash button.
 */
function InstalledAction({ title, deletion }: { title: string; deletion: RowDeletion }): JSX.Element {
  const trash = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const asked = useRef(deletion.asking);
  useEffect(() => {
    if (deletion.asking) cancel.current?.focus();
    else if (asked.current) trash.current?.focus();
    asked.current = deletion.asking;
  }, [deletion.asking]);
  if (deletion.asking)
    return (
      <div className="flex shrink-0 gap-2">
        <Button ref={cancel} data-model-delete="cancel" disabled={deletion.removing} onClick={deletion.keep}>
          {WORDS.deleteCancel}
        </Button>
        <Button
          data-model-delete="confirm"
          variant="destructive"
          disabled={deletion.removing}
          onClick={deletion.confirm}
        >
          {deletion.removing ? WORDS.deleting : WORDS.delete}
        </Button>
      </div>
    );
  return (
    <div className="flex shrink-0 items-center gap-1">
      <InstalledBadge />
      <Button
        ref={trash}
        data-model-delete="ask"
        variant="ghost"
        size="icon-sm"
        aria-label={WORDS.deleteModel(title)}
        title={WORDS.delete}
        disabled={deletion.disabled}
        onClick={deletion.ask}
      >
        <Icon name="trash" />
      </Button>
    </div>
  );
}

/** The question an installed row asks before Delete. */
function DeleteQuestion(): JSX.Element {
  return <p className="text-body-sm text-ink">{WORDS.deleteAsk}</p>;
}

/** A stopped download's saved share beside Resume, which continues from the saved bytes. */
function ResumeAction({
  title,
  percent,
  best,
  busy,
  onResume,
}: {
  title: string;
  percent: number;
  best: boolean;
  busy: boolean;
  onResume: () => void;
}): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 font-mono text-sm text-muted-foreground tabular-nums">
      <span>{percent}%</span>
      <Button
        variant={best ? "default" : "secondary"}
        disabled={busy}
        onClick={onResume}
        aria-label={`Resume downloading ${title}`}
      >
        Resume
      </Button>
    </div>
  );
}

/** Download, with Install Ollama before it when the last try found no Ollama running. */
function DownloadAction({
  title,
  best,
  busy,
  onDownload,
  onInstallOllama,
}: {
  title: string;
  best: boolean;
  busy: boolean;
  onDownload: () => void;
  onInstallOllama: (() => void) | null;
}): JSX.Element {
  const download = (
    <Button
      variant={best ? "default" : "secondary"}
      disabled={busy}
      onClick={onDownload}
      aria-label={`Download ${title}`}
    >
      Download
    </Button>
  );
  if (!onInstallOllama) return download;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button onClick={onInstallOllama}>Install Ollama</Button>
      {download}
    </div>
  );
}

/** A model row's action: its download's progress (and Cancel), Installed with Delete, Resume, or Download when it fits. */
function ModelAction({
  pick,
  title,
  best,
  installed,
  pulling,
  percent,
  stopped,
  cancellable,
  busy,
  deletion,
  onDownload,
  onInstallOllama,
  onCancel,
}: {
  pick: LocalModelChoice;
  title: string;
  best: boolean;
  installed: boolean;
  pulling: boolean;
  percent: number;
  stopped: StoppedDownload | null;
  cancellable: boolean;
  busy: boolean;
  deletion: RowDeletion;
  onDownload: () => void;
  onInstallOllama: (() => void) | null;
  onCancel: () => void;
}): JSX.Element | null {
  if (pulling)
    return (
      <div
        role="status"
        className="flex shrink-0 items-center gap-2 font-mono text-sm text-muted-foreground tabular-nums"
      >
        <span>{percent}%</span>
        {cancellable && (
          <Button onClick={onCancel} aria-label={`Cancel downloading ${title}`}>
            Cancel
          </Button>
        )}
      </div>
    );
  if (installed) return <InstalledAction title={title} deletion={deletion} />;
  if (stopped?.resumable)
    return <ResumeAction title={title} percent={stopped.percent} best={best} busy={busy} onResume={onDownload} />;
  if (!pick.fits) return null;
  return (
    <DownloadAction title={title} best={best} busy={busy} onDownload={onDownload} onInstallOllama={onInstallOllama} />
  );
}

/** Why a row's download stopped: quiet when the person cancelled it, an error otherwise. */
function StopReason({ reason, cancelled }: { reason: string; cancelled: boolean }): JSX.Element {
  if (cancelled) return <p className="text-body-sm text-muted-foreground">{reason}</p>;
  return (
    <p role="alert" className="text-body-sm text-red">
      {reason}
    </p>
  );
}

function ModelRow(props: {
  pick: LocalModelChoice;
  best: boolean;
  installed: boolean;
  pulling: boolean;
  progress: number;
  /** This model's last download, when it stopped short. */
  stopped: StoppedDownload | null;
  /** This model's last download, lookup or delete failure in this session. */
  failure: string | null;
  cancellable: boolean;
  busy: boolean;
  deletion: RowDeletion;
  usable: number;
  onDownload: () => void;
  /** Opens Ollama's download page; offered when this model's download found no Ollama running. */
  onInstallOllama: (() => void) | null;
  onCancel: () => void;
}): JSX.Element {
  const { pick, best, pulling, stopped, usable } = props;
  const percent = Math.round(props.progress * 100);
  const title = pick.variant ? `${pick.name} ${pick.variant}` : pick.name;
  const reason = pulling ? null : (stopped?.reason ?? props.failure);
  // A model already on this Mac shows no share saved by an earlier stopped download.
  const saved = pulling || props.installed ? null : stopped;
  return (
    <div className="flex items-center gap-4 border-b border-border py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[15px] leading-[22px] font-medium text-ink">{pick.name}</span>
          <span className="break-all font-mono text-xs text-muted-foreground">{pick.variant ?? pick.model}</span>
          {best && (
            <span className="inline-flex h-5 items-center self-center rounded-[6px] bg-accent-tint px-1.5 font-mono text-micro text-accent-ink">
              Best fit
            </span>
          )}
        </div>
        <p className="text-body-sm text-muted-foreground">{pick.about}</p>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>{pick.vision ? "Vision" : "Text only"}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{pick.sizeGb} GB</span>
          <span aria-hidden="true">·</span>
          <Fit fits={pick.fits} needGb={pick.needGb} needsRamGb={pick.needsRamGb} usable={usable} />
        </div>
        {pulling && <ProgressBar label={`Downloading ${title}`} percent={percent} animated />}
        {saved?.resumable && (
          <ProgressBar label={`Downloaded part of ${title}`} percent={saved.percent} animated={false} />
        )}
        {props.installed && props.deletion.asking && <DeleteQuestion />}
        {reason && <StopReason reason={reason} cancelled={Boolean(stopped?.cancelled)} />}
      </div>
      <ModelAction {...props} title={title} percent={percent} />
    </div>
  );
}

type InstallJob = Awaited<ReturnType<typeof window.studio.modelInstallStatus>>;
type PullEvent = UiEventMap[typeof UiEvent.ModelPull];
/** What last went wrong, and the model it went wrong for (none when the status itself is unreadable). */
interface DownloadFailure {
  model: string | null;
  message: string;
}

/** This Mac's hardware and the model download in progress: read once, then followed by the host's events. */
function useModelInstalls(onEnginesRefresh: () => void) {
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [job, setJob] = useState<InstallJob>(null);
  const [failure, setFailure] = useState<DownloadFailure | null>(null);
  useEffect(() => {
    onEnginesRefresh();
    let alive = true;
    let revision = 0;
    void window.studio
      .hardware()
      .then((value) => {
        if (alive) setHardware(value);
      })
      .catch((error) => {
        if (alive) setHardwareError(String(error));
      });
    const apply = (next: InstallJob) => {
      if (!next) return;
      setJob(next);
      setPulling(next.active ? next.model : null);
      setFailure(next.error ? { model: next.model, message: next.error } : null);
      if (next.total) setProgress(next.completed / next.total);
    };
    const applyPull = ({ model, progress }: PullEvent): void => {
      if (progress.status === "error") {
        setPulling(null);
        setFailure({ model, message: progress.error ?? "Download failed" });
        return;
      }
      if (progress.status === "success") {
        setPulling(null);
        onEnginesRefresh();
      } else {
        setPulling(model);
      }
      if (progress.total) setProgress((progress.completed ?? 0) / progress.total);
    };
    void window.studio
      .modelInstallStatus()
      .then((job) => {
        if (alive && revision === 0) apply(job);
      })
      .catch((e) => {
        if (alive) setFailure({ model: null, message: String(e) });
      });
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type === UiEvent.ModelInstall) {
        revision++;
        apply(event.payload);
        return;
      }
      if (event.type !== UiEvent.ModelPull) return;
      revision++;
      applyPull(event.payload);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [onEnginesRefresh]);

  const pull = async (model: string): Promise<void> => {
    setPulling(model);
    setProgress(0);
    setFailure(null);
    // This model's new job replaces the stopped one; until it reports, an early refusal shows instead.
    setJob((current) => (current?.model === model ? null : current));
    try {
      await window.studio.pullModel(model);
      onEnginesRefresh();
    } catch (err) {
      setFailure({ model, message: errorMessage(err) });
      // Whether Ollama runs decides what the row offers next.
      onEnginesRefresh();
    } finally {
      setPulling(null);
    }
  };
  /** A deleted model's last download, finished or stopped, no longer describes its row. */
  const forget = (model: string): void => {
    setJob((current) => (current?.model === model ? null : current));
    setFailure((current) => (current?.model === model ? null : current));
  };
  return { hardware, hardwareError, pulling, progress, job, failure, pull, forget };
}

/** Deleting installed models: the row asking to confirm, the one being deleted, and what went wrong. */
function useModelRemoval(onRemoved: (model: string) => Promise<void> | void) {
  const [asking, setAsking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<DownloadFailure | null>(null);
  const remove = async (model: string): Promise<void> => {
    setRemoving(model);
    setFailure(null);
    try {
      await window.studio.removeModel(model);
      // The row keeps saying Deleting… until the refreshed list no longer has the model.
      await onRemoved(model);
    } catch (err) {
      setFailure({ model, message: errorMessage(err) });
    } finally {
      setRemoving(null);
      setAsking(null);
    }
  };
  /** `model`'s row; `busy` while a download runs. */
  const forRow = (model: string, busy: boolean): RowDeletion => ({
    asking: asking === model,
    removing: removing === model,
    disabled: busy || removing !== null,
    ask: () => {
      setAsking(model);
      setFailure(null);
    },
    keep: () => setAsking(null),
    confirm: () => void remove(model),
  });
  return { failure, forRow };
}

/** What checking a tag found wrong: the lookup's own error, a missing or malformed tag, or an unreachable library. */
function lookupWords(lookup: Lookup | null, lookupError: string | null): string | null {
  if (lookupError) return lookupError;
  if (!lookup || lookup.ok) return null;
  if (lookup.reason === "not_found")
    return `Couldn't find ${lookup.id} in the Ollama library. Check the name and the tag after the colon.`;
  if (lookup.reason === "invalid") return "Enter a model name like qwen3.5:9b.";
  return lookup.error ?? "Could not reach the Ollama library.";
}

function HardwareLine({
  hardware,
  hardwareError,
  usable,
}: {
  hardware: Hardware | null;
  hardwareError: string | null;
  usable: number;
}): JSX.Element {
  if (hardwareError)
    return (
      <p role="alert" className="py-3 text-body-sm text-red">
        Could not load local models. Reopen Settings to try again. {hardwareError}
      </p>
    );
  if (!hardware) return <Pending label="Detecting this Mac…" className="py-3 text-body-sm" />;
  return (
    <p className="text-body-sm text-muted-foreground">
      {hardware.hardware.cpu} · {Math.round(hardware.hardware.ramGb)} GB memory · about {Math.round(usable)} GB
      available for models
    </p>
  );
}

/** A model found by its tag: its size and fit, and Installed, its download's progress, or Download. */
function FoundModel({
  found,
  installs,
  installed,
  usable,
  onInstallOllama,
}: {
  found: Extract<Lookup, { ok: true }>;
  installs: ReturnType<typeof useModelInstalls>;
  installed: boolean;
  usable: number;
  onInstallOllama: (() => void) | null;
}): JSX.Element {
  const { pulling, pull } = installs;
  const percent = Math.round(installs.progress * 100);
  const downloading = pulling === found.id;
  const action = (): JSX.Element | null => {
    if (installed) return <InstalledBadge />;
    if (downloading)
      return (
        <span role="status" className="font-mono text-sm text-muted-foreground tabular-nums">
          {percent}%
        </span>
      );
    if (!found.fits) return null;
    return (
      <DownloadAction
        title={found.id}
        best={false}
        busy={pulling !== null}
        onDownload={() => void pull(found.id)}
        onInstallOllama={onInstallOllama}
      />
    );
  };
  return (
    <div className="mt-1 flex items-center gap-4 rounded-card bg-surface px-3.5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-all font-mono text-sm text-ink">{found.id}</span>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="tabular-nums">{found.sizeGb} GB</span>
          <span aria-hidden="true">·</span>
          <Fit fits={found.fits} needGb={found.needGb} needsRamGb={found.needsRamGb} usable={usable} />
        </div>
        {downloading && <ProgressBar label={`Downloading ${found.id}`} percent={percent} animated={false} />}
      </div>
      {action()}
    </div>
  );
}

/** Add any model from the Ollama library by its tag: check its size first, then download it. */
function AddFromOllama({
  ollama,
  installs,
  installed,
  usable,
  installOllamaFor,
}: {
  ollama: EngineDescriptor | undefined;
  installs: ReturnType<typeof useModelInstalls>;
  installed: Set<string>;
  usable: number;
  installOllamaFor: (model: string) => (() => void) | null;
}): JSX.Element {
  const [tag, setTag] = useState("");
  const [checking, setChecking] = useState(false);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const tagId = useId();
  const check = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!tag.trim() || checking) return;
    setChecking(true);
    setLookup(null);
    setLookupError(null);
    try {
      setLookup(await window.studio.lookupModel(tag.trim()));
    } catch (err) {
      setLookupError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };
  const found = lookup?.ok ? lookup : null;
  const lookupMessage = lookupWords(lookup, lookupError);
  return (
    <form onSubmit={(event) => void check(event)} className="flex flex-col gap-2 pt-6">
      <label htmlFor={tagId} className="text-sm font-medium text-ink">
        Add from Ollama
      </label>
      <div className="flex gap-2">
        <input
          id={tagId}
          value={tag}
          onChange={(event) => {
            setTag(event.target.value);
            setLookup(null);
            setLookupError(null);
          }}
          placeholder="qwen3.5:9b"
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-control border border-input bg-field px-2.5 font-mono text-sm text-ink outline-none placeholder:text-muted-foreground focus:border-accent-primary"
        />
        <Button type="submit" disabled={!tag.trim() || checking}>
          {checking ? "Checking…" : "Check"}
        </Button>
      </div>
      <p className="text-body-sm text-muted-foreground">
        Enter any model name from the{" "}
        <button
          type="button"
          onClick={() => void window.studio.openUrl(OLLAMA_LIBRARY_URL)}
          className="cursor-pointer text-accent-ink underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
        >
          Ollama library ↗
        </button>
        . Studio checks its size before downloading.
      </p>
      {ollama && ollama.status.code !== EngineStatusCode.Ready && (
        <p className="text-body-sm text-muted-foreground">
          {ollama.status.detail}
          {ollama.status.remedy ? ` — ${ollama.status.remedy}` : ""}
        </p>
      )}
      {lookupMessage && (
        <p role="alert" className="text-body-sm text-red">
          {lookupMessage}
        </p>
      )}
      {found && (
        <FoundModel
          found={found}
          installs={installs}
          installed={installed.has(canonical(found.id))}
          usable={usable}
          onInstallOllama={installOllamaFor(found.id)}
        />
      )}
    </form>
  );
}

/** Models Ollama has that the catalog does not list: already installed, added by hand. */
function ExtraModels({
  models,
  deletion,
  failure,
}: {
  models: EngineDescriptor["models"];
  deletion: (model: string) => RowDeletion;
  failure: (model: string) => string | null;
}): JSX.Element {
  return (
    <>
      {models.map((model) => {
        const rowDeletion = deletion(model.id);
        const reason = failure(model.id);
        return (
          <div key={model.id} className="flex items-center gap-4 border-b border-border py-3.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="break-all font-mono text-sm text-ink">{model.id}</span>
              <span className="text-body-sm text-muted-foreground">Added from Ollama</span>
              {rowDeletion.asking && <DeleteQuestion />}
              {reason && <StopReason reason={reason} cancelled={false} />}
            </div>
            <InstalledAction title={model.id} deletion={rowDeletion} />
          </div>
        );
      })}
    </>
  );
}

/** The More models disclosure: the catalog beyond this Mac's picks. */
function MoreModels({
  more,
  open,
  onToggle,
  row,
}: {
  more: LocalModelChoice[];
  open: boolean;
  onToggle: () => void;
  row: (pick: LocalModelChoice, best: boolean) => JSX.Element;
}): JSX.Element | null {
  if (!more.length) return null;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="-ms-2 mt-3 flex w-fit cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm font-medium text-ink transition-colors duration-(--duration-quick) hover:bg-control-hover focus-visible:bg-control-hover focus-visible:outline-none motion-reduce:transition-none"
      >
        <Icon
          name="chevron-right"
          size={14}
          className={`transition-transform duration-(--duration-quick) motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        More models
        <span className="font-mono text-xs font-normal text-muted-foreground">{more.length}</span>
      </button>
      {open && more.map((pick) => row(pick, false))}
    </>
  );
}

export function LocalModelsSection({ engines, onEnginesRefresh }: ModelSettingsProps): JSX.Element {
  const installs = useModelInstalls(onEnginesRefresh);
  const { hardware, pulling, progress, failure } = installs;
  const removal = useModelRemoval((model) => {
    installs.forget(model);
    return onEnginesRefresh();
  });
  const deletion = (model: string): RowDeletion => removal.forRow(model, pulling !== null);
  /** What last went wrong on `model`'s row: its download, or its deletion. */
  const failureFor = (model: string): string | null => {
    if (failure?.model === model) return failure.message;
    return removal.failure?.model === model ? removal.failure.message : null;
  };
  const [moreOpen, setMoreOpen] = useState(false);
  const ollama = engines.find((engine) => engine.id === EngineId.Ollama);
  /** Install Ollama beside an Ollama model's Download, once its download found no Ollama running. */
  const installOllamaFor = (model: string): (() => void) | null =>
    failure?.model === model && needsOllama(ollama) ? openOllamaDownload : null;
  const installed = new Set(engines.flatMap((engine) => engine.models.map((model) => canonical(model.id))));
  const recommendation = hardware?.recommendation;
  const catalogIds = new Set(
    [...(recommendation?.picks ?? []), ...(recommendation?.more ?? [])].map((pick) => canonical(pick.model)),
  );
  const extra = (ollama?.models ?? []).filter((model) => !catalogIds.has(canonical(model.id)));
  const usable = hardware?.hardware.usableModelGb ?? 0;
  // A download running under the collapsed list keeps its progress in view.
  const showMore = moreOpen || Boolean(recommendation?.more.some((pick) => pick.model === pulling));
  const shownRows = [...(recommendation?.picks ?? []), ...(showMore ? (recommendation?.more ?? []) : [])];
  // A row says why its own download stopped; the line below the picks keeps the rest.
  const failureOnRow = shownRows.some((pick) => pick.model === failure?.model);

  const row = (pick: LocalModelChoice, best: boolean): JSX.Element => (
    <ModelRow
      key={pick.model}
      pick={pick}
      best={best}
      usable={usable}
      installed={installed.has(canonical(pick.model))}
      pulling={pulling === pick.model}
      progress={progress}
      stopped={stoppedDownload(installs.job, pick.model)}
      failure={failureFor(pick.model)}
      cancellable={pick.engine === EngineId.Bonsai}
      busy={pulling !== null}
      deletion={deletion(pick.model)}
      onDownload={() => void installs.pull(pick.model)}
      onInstallOllama={pick.engine === EngineId.Bonsai ? null : installOllamaFor(pick.model)}
      onCancel={() => void window.studio.cancelModelDownload()}
    />
  );

  return (
    <div className="flex w-full flex-col">
      <HardwareLine hardware={hardware} hardwareError={installs.hardwareError} usable={usable} />

      {recommendation && recommendation.picks.length === 0 && (
        <p className="py-3 text-body-sm text-muted-foreground">
          No recommended model fits this Mac. More models lists what bigger Macs can run.
        </p>
      )}
      {recommendation?.picks.map((pick) => row(pick, pick.model === recommendation.defaultModel))}

      {extra.length > 0 && <ExtraModels models={extra} deletion={deletion} failure={failureFor} />}

      {failure && !failureOnRow && (
        <p role="alert" className="py-2 text-body-sm text-red">
          {failure.message}
        </p>
      )}

      {recommendation && (
        <MoreModels more={recommendation.more} open={showMore} onToggle={() => setMoreOpen(!showMore)} row={row} />
      )}

      {hardware && (
        <AddFromOllama
          ollama={ollama}
          installs={installs}
          installed={installed}
          usable={usable}
          installOllamaFor={installOllamaFor}
        />
      )}
    </div>
  );
}

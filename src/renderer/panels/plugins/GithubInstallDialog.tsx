/**
 * Install from GitHub: paste a link, see which plugin it leads to and at which version, then hand
 * that exact commit to the one native trust dialog. Studio settles the commit; nobody types it.
 */
import type { FormEvent, JSX } from "react";
import { useState } from "react";
import {
  GithubLookupKind,
  GithubLookupProblem,
  type GithubLookup,
  type GithubPluginFound,
  type GithubVersion,
  GithubVersionKind,
} from "../../../shared/plugins.ts";
import { parseGithubLink } from "../../../shared/github-link.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import {
  canLookUp,
  type GithubAnswer,
  keptChoice,
  ownerOf,
  shortDate,
  shownPlugin,
  takesNewestCode,
  versionWords,
} from "./github-install.ts";
import { PLUGIN_GUIDE_URL } from "./labels.ts";
import { PluginIcon } from "../../ui/PluginIcon.tsx";
import { SkeletonLines } from "../../ui/Skeleton.tsx";

const WORDS = PLUGINS_WORDS.github;

/** What the window is doing: looking a link up or handing a plugin to the trust dialog. */
const Busy = { Looking: "looking", Installing: "installing" } as const;
type Busy = (typeof Busy)[keyof typeof Busy];

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The window's state and the two things it does: look a link (or another version) up, and install. */
function useGithubInstall(onInstalled: (id: string) => void) {
  const [link, setLink] = useState("");
  const [answer, setAnswer] = useState<GithubAnswer | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState("");
  const current = answer && answer.link === link.trim() ? answer : null;
  const plugin = shownPlugin(current, chosen);

  const lookUp = async (version?: GithubVersion): Promise<void> => {
    const text = link.trim();
    setError("");
    // A link that is not GitHub's is answered here, before anything is asked of GitHub.
    if (!parseGithubLink(text)) {
      setAnswer({ lookup: { kind: GithubLookupKind.Problem, problem: GithubLookupProblem.NotALink }, link: text });
      return;
    }
    setBusy(Busy.Looking);
    try {
      const lookup = await window.studio.pluginLookupGithub(text, version);
      setAnswer({ lookup, link: text, ...(version ? { picked: version } : {}) });
      setChosen(keptChoice(lookup, plugin?.subdir));
    } catch (e) {
      setError(words(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async (found: GithubPluginFound): Promise<void> => {
    setBusy(Busy.Installing);
    setError("");
    try {
      await window.studio.pluginInstallGithub(found.spec);
      // Declining the trust dialog installs nothing and keeps this window open.
      const installed = (await window.studio.pluginsList()).some(
        (p) => p.manifest.id === found.plugin.id && !p.removed && p.origin?.sha === found.sha,
      );
      if (installed) onInstalled(found.plugin.id);
    } catch (e) {
      setError(words(e));
    } finally {
      setBusy(null);
    }
  };

  return { link, setLink, current, plugin, chosen, setChosen, busy, error, lookUp, install };
}

/** The version line, with Change to pick another release or the default branch's newest code. */
function VersionRow({
  found,
  picked,
  disabled,
  onPick,
}: {
  found: GithubPluginFound;
  picked: boolean;
  disabled: boolean;
  onPick: (version: GithubVersion) => void;
}): JSX.Element {
  const [versions, setVersions] = useState<GithubVersion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { name, detail } = versionWords(found, picked);
  const load = (open: boolean): void => {
    if (!open || versions) return;
    setFailed(false);
    window.studio.pluginGithubVersions(found.repo).then(setVersions, () => setFailed(true));
  };
  return (
    <div className="github-install-version">
      <span className="github-install-version-label">{WORDS.version}</span>
      <span className="github-install-version-name">
        {name}
        {detail && <span className="text-ink-3"> · {detail}</span>}
      </span>
      <DropdownMenu onOpenChange={load}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={WORDS.changeLabel}>
            {WORDS.change}
            <Icon name="chevron-down" size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {!versions && !failed && (
            <DropdownMenuItem disabled aria-label={WORDS.versionsLoading} className="block py-2.5">
              <SkeletonLines widths={["70%", "55%", "62%"]} />
            </DropdownMenuItem>
          )}
          {failed && <DropdownMenuItem disabled>{WORDS.versionsFailed}</DropdownMenuItem>}
          {versions?.map((version) => (
            <DropdownMenuItem key={`${version.kind}:${version.label}`} onSelect={() => onPick(version)}>
              <span className="min-w-0 flex-1 truncate">
                {version.kind === GithubVersionKind.Branch ? WORDS.newestOn(version.label) : version.label}
              </span>
              <span className="text-ink-3">{shortDate(version.date)}</span>
              {version.label === found.version.label && <Icon name="check" size={14} />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** One plugin as the link found it: its picture, name, owner and description. */
function PluginSummary({ found }: { found: GithubPluginFound }): JSX.Element {
  const { plugin } = found;
  return (
    <div className="github-install-plugin">
      <PluginIcon name={plugin.name} />
      <span className="extension-copy">
        <span className="extension-name">
          {plugin.name}
          <span className="github-install-owner">{WORDS.by(ownerOf(found.repo))}</span>
        </span>
        <span className="extension-description">{plugin.description}</span>
      </span>
    </div>
  );
}

/** Why the link found no plugin, what to try, and the guide when the repository has no plugin at all. */
function Problem({
  lookup,
}: {
  lookup: Extract<GithubLookup, { kind: typeof GithubLookupKind.Problem }>;
}): JSX.Element {
  const [what, next] = WORDS.problem[lookup.problem];
  const hint = lookup.problem === GithubLookupProblem.InvalidPlugin ? (lookup.detail ?? "") : next;
  return (
    <div role="alert" className="github-install-problem">
      <p className="text-red">{what}</p>
      {hint && <p>{hint}</p>}
      {lookup.problem === GithubLookupProblem.NoPlugin && (
        <button
          type="button"
          className="github-install-guide"
          onClick={() => void window.studio.openUrl(PLUGIN_GUIDE_URL)}
        >
          {WORDS.guide}
          <Icon name="arrow-up-right" size={12} />
        </button>
      )}
    </div>
  );
}

/** Several plugins in one repository, to choose one from. */
function Choices({
  lookup,
  chosen,
  onChoose,
}: {
  lookup: Extract<GithubLookup, { kind: typeof GithubLookupKind.Choose }>;
  chosen: string | null;
  onChoose: (spec: string) => void;
}): JSX.Element {
  return (
    <div className="github-install-choices">
      <p className="text-ink-3">{WORDS.choose(lookup.plugins.length)}</p>
      <div role="radiogroup" aria-label={WORDS.choose(lookup.plugins.length)}>
        {lookup.plugins.map((found) => (
          <button
            key={found.spec}
            type="button"
            role="radio"
            aria-checked={found.spec === chosen}
            className="github-install-choice"
            onClick={() => onChoose(found.spec)}
          >
            <PluginIcon name={found.plugin.name} />
            <span className="extension-copy">
              <span className="extension-name">{found.plugin.name}</span>
              <span className="github-install-folder">{found.subdir}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Install from GitHub, as a window over the Plugins page. */
export function GithubInstallDialog({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: (id: string) => void;
}): JSX.Element {
  const state = useGithubInstall(onInstalled);
  const { current, plugin, busy } = state;
  const lookup = current?.lookup;
  const picked = Boolean(current?.picked);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    if (plugin) void state.install(plugin);
    else if (canLookUp(state.link, current)) void state.lookUp();
  };
  const primary = plugin ? WORDS.install : WORDS.continue;
  const primaryBusy = busy === Busy.Installing ? WORDS.installing : WORDS.looking;
  return (
    <DialogSurface
      title={WORDS.title}
      description={lookup ? undefined : WORDS.intro}
      onDismiss={onClose}
      size="lg"
      testId="github-install"
    >
      <form className="github-install" onSubmit={submit}>
        <label className="github-install-field">
          {WORDS.field}
          <input
            aria-label={WORDS.field}
            aria-invalid={lookup?.kind === GithubLookupKind.Problem || undefined}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={WORDS.placeholder}
            value={state.link}
            onChange={(event) => state.setLink(event.target.value)}
          />
        </label>
        {lookup?.kind === GithubLookupKind.Problem && <Problem lookup={lookup} />}
        {lookup?.kind === GithubLookupKind.Choose && (
          <Choices lookup={lookup} chosen={state.chosen} onChoose={state.setChosen} />
        )}
        {plugin && (
          <div className="github-install-card">
            {lookup?.kind === GithubLookupKind.Plugin && <PluginSummary found={plugin} />}
            <VersionRow found={plugin} picked={picked} disabled={busy !== null} onPick={(v) => void state.lookUp(v)} />
          </div>
        )}
        {plugin && takesNewestCode(plugin, picked) && <p className="github-install-note">{WORDS.noRelease}</p>}
        {plugin && <p className="github-install-note">{WORDS.next}</p>}
        {state.error && (
          <p role="alert" className="extensions-error">
            {state.error}
          </p>
        )}
        <div className="github-install-actions">
          <Button onClick={onClose}>{WORDS.cancel}</Button>
          <Button
            type="submit"
            variant="default"
            disabled={busy !== null || (!plugin && !canLookUp(state.link, current))}
          >
            {busy ? primaryBusy : primary}
          </Button>
        </div>
      </form>
    </DialogSurface>
  );
}

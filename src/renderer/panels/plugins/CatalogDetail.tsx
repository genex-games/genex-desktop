/**
 * A catalog plugin's page before it is installed: who made it, how to start (Genex's install step,
 * its author's plain steps, when it is ready), what it can do and where its code comes from. Every
 * word an author wrote is drawn as text; links open in the browser.
 */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import type { PluginIndexEntry, PluginIndexView, PluginManifest } from "../../../shared/plugins.ts";
import { GithubMark } from "../../ui/brand.tsx";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import {
  capabilityLine,
  installedSteps,
  listingSteps,
  meetsMinimumVersion,
  publisherProfile,
  type SetupStep,
} from "./labels.ts";
import type { PluginsPage } from "./page.ts";
import { Section } from "./rows.tsx";

const WORDS = PLUGINS_WORDS.listing;
/** How much of a source commit the page shows. */
const SHORT_SHA = 7;

/** "by" and the publisher's GitHub name with GitHub's mark, opening their profile. */
export function PublisherLink({ repo, className = "" }: { repo: string; className?: string }): JSX.Element {
  const { login, url } = publisherProfile(repo);
  return (
    <span className={`community-by ${className}`}>
      {PLUGINS_WORDS.community.by}{" "}
      <button
        type="button"
        className="community-profile"
        aria-label={PLUGINS_WORDS.community.profile(login)}
        onClick={() => void window.studio.openUrl(url)}
      >
        <GithubMark />
        {login}
      </button>
    </span>
  );
}

/** The page's Install button, or the Studio version it needs. */
export function CatalogInstall({
  entry,
  index,
  page,
}: {
  entry: PluginIndexEntry;
  index: PluginIndexView;
  page: PluginsPage;
}): JSX.Element {
  const minimum = entry.minStudioVersion;
  const blocked = minimum !== undefined && !meetsMinimumVersion(index.studioVersion, minimum);
  if (blocked) return <span className="text-xs text-ink-3">{t("Needs Studio ≥ {version}", { version: minimum })}</span>;
  return (
    <Button
      variant="default"
      disabled={page.busy}
      aria-label={WORDS.installLabel(entry.name)}
      onClick={() => void page.act(() => window.studio.pluginInstall(entry.id))}
    >
      {WORDS.install}
    </Button>
  );
}

/** A link on the page: its text, opening the address in the browser. */
function OutLink({ href, children }: { href: string; children: string }): JSX.Element {
  return (
    <button type="button" className="community-profile" onClick={() => void window.studio.openUrl(href)}>
      {children}
      <Icon name="arrow-up-right" size={12} />
    </button>
  );
}

/** The commit the catalog pins, as `owner/repo @ abc1234`, opening that tree on GitHub. */
function sourceLink(entry: PluginIndexEntry): { label: string; url: string } {
  const folder = entry.subdir ? `/${entry.subdir}` : "";
  return {
    label: `${entry.repo}${folder} @ ${entry.sha.slice(0, SHORT_SHA)}`,
    url: `https://github.com/${entry.repo}/tree/${entry.sha}${folder}`,
  };
}

/** "How to start" as a numbered list; a step already done is ticked and quieter. */
function StepList({ steps }: { steps: SetupStep[] }): JSX.Element {
  return (
    <Section title={WORDS.steps}>
      <ol className="community-steps">
        {steps.map((step, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a page's steps are fixed and may repeat a line
          <li key={i} data-step-done={step.done ? "" : undefined}>
            {step.done && <Icon name="check" size={14} className="community-step-check" />}
            {step.text}
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** An installed plugin's "How to start", with Install ticked off; nothing when it has nothing to set up. */
export function InstalledSteps({ manifest }: { manifest: PluginManifest }): JSX.Element | null {
  const steps = installedSteps(manifest);
  return steps.length ? <StepList steps={steps} /> : null;
}

/** The mark beside a plugin's switch while it waits on its person. */
export function NeedsSetup(): JSX.Element {
  return <span className="community-needs-setup">{WORDS.needsSetup}</span>;
}

/** The page below a catalog plugin's title: its publisher, how to start, and what it is. */
export function CatalogDetail({ entry }: { entry: PluginIndexEntry }): JSX.Element {
  const source = sourceLink(entry);
  return (
    <div data-catalog-page={entry.id}>
      <PublisherLink repo={entry.repo} className="community-by-page" />
      <StepList steps={listingSteps(entry).map((text) => ({ text, done: false }))} />
      <Section title={PLUGINS_WORDS.page.information}>
        <dl className="extension-information">
          <dt>{WORDS.developer}</dt>
          <dd>{entry.publisher}</dd>
          <dt>{PLUGINS_WORDS.page.version}</dt>
          <dd>{entry.version}</dd>
          <dt>{PLUGINS_WORDS.page.can}</dt>
          {/* The account it uses is the service it is named for, not its publisher's. */}
          <dd>{capabilityLine({ capabilities: entry.capabilities, publisher: entry.name })}</dd>
          <dt>{WORDS.source}</dt>
          <dd>
            <OutLink href={source.url}>{source.label}</OutLink>
          </dd>
          {entry.docsUrl && (
            <>
              <dt>{WORDS.guide}</dt>
              <dd>
                <OutLink href={entry.docsUrl}>{new URL(entry.docsUrl).host}</OutLink>
              </dd>
            </>
          )}
        </dl>
        <p className="mt-6 text-xs text-ink-3">{PLUGINS_WORDS.page.trusted}</p>
      </Section>
    </div>
  );
}

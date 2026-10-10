/** The plugins page's building blocks: its sections and pictures, a plugin's row, its on/off toggle and its account step. */
import type { JSX, ReactNode } from "react";
import { GENEX_PLUGIN_ID } from "../../../shared/genex.ts";
import type { PluginInfo } from "../../../shared/plugins.ts";
import { installPluginUpdate } from "../../state/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon, type IconName } from "../../ui/icons.tsx";
import { PluginIcon, type PluginIconSize } from "../../ui/PluginIcon.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import { CreditsKind, type CreditsView } from "./genex/genex-view.ts";
import { RouterIcon } from "./genex/RouterIcon.tsx";
import {
  accountPanel,
  isOffList,
  pluginAccount,
  pluginIconUrl,
  RowAccountStep,
  rowAccountStep,
  shownDescription,
  shownName,
} from "./labels.ts";
import type { PluginsPage } from "./page.ts";

const ACCOUNT_WORDS = PLUGINS_WORDS.account;
/** Credits read with the reader's own digit grouping. */
const NUMBER = new Intl.NumberFormat();

/** A skill's square glyph, in the interface's icon colour. */
export function Mark({ kind = "plugins", large = false }: { kind?: IconName; large?: boolean }): JSX.Element {
  return (
    <span className={`extension-mark ${large ? "extension-mark-large" : ""}`}>
      <Icon name={kind} size={large ? 30 : 22} />
    </span>
  );
}

/** A plugin's picture: Genex's routed tools on their moving board, any other plugin's own picture. */
export function PluginPicture({ plugin, size }: { plugin: PluginInfo; size?: PluginIconSize }): JSX.Element {
  if (plugin.manifest.id === GENEX_PLUGIN_ID) return <RouterIcon size={size} />;
  return <PluginIcon name={plugin.manifest.name} src={pluginIconUrl(plugin)} size={size} />;
}

/** A titled section of the page, with an optional count and action. */
export function Section({
  title,
  count,
  children,
  action,
  hooks,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  action?: ReactNode;
  /** `data-*` selectors that name the section for smoke checks. */
  hooks?: { [key: `data-${string}`]: string };
}): JSX.Element {
  return (
    <section className="extensions-section" {...hooks}>
      <div className="extensions-section-heading">
        <h2>
          {title}
          {count !== undefined && <span className="ml-2 text-ink-3">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A plugin's on/off switch; turning it off closes its open panel. */
export function PluginToggle({ plugin, page }: { plugin: PluginInfo; page: PluginsPage }): JSX.Element {
  return (
    <Toggle
      on={plugin.enabled}
      disabled={page.busy}
      ariaLabel={`Use ${shownName(plugin)}`}
      onChange={(on) =>
        void page.act(async () => {
          page.setSelected(null);
          await window.studio.pluginEnable(plugin.manifest.id, on);
        })
      }
    />
  );
}

/** Run one of a plugin's account actions (connect, cancel) through the shared review, then re-read the account. */
async function runAccountAction(plugin: PluginInfo, page: PluginsPage, name: string): Promise<void> {
  const { manifest } = plugin;
  const { project } = page;
  const action = manifest.actions.find((a) => a.name === name);
  const review = action?.confirmation
    ? await window.studio.pluginReview(manifest.id, name, {}, project ?? undefined)
    : undefined;
  await window.studio.pluginAction(manifest.id, name, {}, project ?? undefined, review?.ticket);
  page.setConnections(await window.studio.connections(undefined, project));
}

/**
 * Connect (or reconnect) a plugin's account. A plugin that sets its account up in its own panel
 * opens its page with that panel; the connect action reuses a saved sign-in or starts one in the
 * browser, so the row itself moves on to "Finish in your browser" or the balance.
 */
function connectAccount(plugin: PluginInfo, page: PluginsPage): Promise<void> {
  const { manifest } = plugin;
  return page.act(async () => {
    const panel = accountPanel(manifest, page.project);
    if (panel) {
      page.openPlugin(manifest.id);
      page.setSelected({ id: manifest.id, document: await window.studio.pluginPanel(manifest.id, panel.id) });
    }
    if (manifest.account) await runAccountAction(plugin, page, manifest.account.connect);
  });
}

/** A balance as the row says it: "1,240 credits", "Unlimited credits", or nothing while unknown. */
function creditsWords(credits: CreditsView | null | undefined): string | null {
  if (credits?.kind === CreditsKind.Unlimited) return ACCOUNT_WORDS.unlimited;
  return credits?.kind === CreditsKind.Count ? ACCOUNT_WORDS.credits(NUMBER.format(credits.count)) : null;
}

/**
 * A plugin's account where its row (or page) needs it: one Connect button, the browser step with
 * Cancel, Reconnect after a failure, or, once connected, the balance and no button at all.
 */
export function AccountStep({
  plugin,
  page,
  credits,
}: {
  plugin: PluginInfo;
  page: PluginsPage;
  credits?: CreditsView | null;
}): JSX.Element | null {
  const { manifest } = plugin;
  const account = manifest.account;
  if (!account || !plugin.enabled || isOffList(plugin)) return null;
  const name = shownName(plugin);
  const step = rowAccountStep(pluginAccount(page.connections, manifest.id));
  const connect = () => void connectAccount(plugin, page);
  switch (step) {
    case RowAccountStep.Connect:
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={manifest.id === GENEX_PLUGIN_ID ? "default" : "secondary"}
              disabled={page.busy}
              aria-label={`Connect ${name}`}
              onClick={connect}
            >
              {ACCOUNT_WORDS.connect}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{ACCOUNT_WORDS.connectHint}</TooltipContent>
        </Tooltip>
      );
    case RowAccountStep.Reconnect:
      return (
        <Button disabled={page.busy} aria-label={`Reconnect ${name}`} onClick={connect}>
          {ACCOUNT_WORDS.reconnect}
        </Button>
      );
    case RowAccountStep.Finishing:
      return (
        <>
          <span className="extension-account-note">{ACCOUNT_WORDS.finishing}</span>
          {account.cancel && (
            <Button
              variant="ghost"
              disabled={page.busy}
              onClick={() => void page.act(() => runAccountAction(plugin, page, account.cancel ?? ""))}
            >
              {ACCOUNT_WORDS.cancel}
            </Button>
          )}
        </>
      );
    default: {
      const balance = step === RowAccountStep.Connected ? creditsWords(credits) : null;
      return balance ? <span className="extension-credits">{balance}</span> : null;
    }
  }
}

/** Install a removed plugin again, or allow one found on disk. */
export function ReinstallButton({ plugin, page }: { plugin: PluginInfo; page: PluginsPage }): JSX.Element {
  return (
    <Button disabled={page.busy} onClick={() => void page.act(() => window.studio.pluginInstall(plugin.manifest.id))}>
      {plugin.removed ? "Reinstall" : "Allow…"}
    </Button>
  );
}

/** A plugin's row: open it, see its account and errors, and switch it on or off (or bring it back). */
function PluginRow({
  plugin,
  page,
  credits,
}: {
  plugin: PluginInfo;
  page: PluginsPage;
  credits?: CreditsView | null;
}): JSX.Element {
  const { manifest } = plugin;
  const name = shownName(plugin);
  const description = shownDescription(plugin);
  const update = page.updates.get(manifest.id);
  return (
    <article className="extension-row" data-plugin-row={manifest.id}>
      <button
        type="button"
        className="extension-open"
        aria-label={`View ${name}`}
        onClick={() => page.openPlugin(manifest.id)}
      >
        <PluginPicture plugin={plugin} />
        <span className="extension-copy">
          <span className="extension-name">{name}</span>
          <span className="extension-description" title={description}>
            {description}
          </span>
          {plugin.error && <span className="text-xs text-red">{plugin.error}</span>}
          {plugin.pendingVersion && (
            <span className="text-xs text-orange">Update {plugin.pendingVersion} waits for active sessions.</span>
          )}
        </span>
      </button>
      <AccountStep plugin={plugin} page={page} credits={credits} />
      {update && (
        <Button
          disabled={page.busy}
          aria-label={`Update ${name}`}
          onClick={() => void page.act(() => installPluginUpdate(window.studio, update))}
        >
          Update to {update.version}
        </Button>
      )}
      {isOffList(plugin) ? (
        <ReinstallButton plugin={plugin} page={page} />
      ) : (
        <PluginToggle plugin={plugin} page={page} />
      )}
    </article>
  );
}

/** Whether a plugin matches the page's search. */
export const pluginMatches = (page: PluginsPage, p: PluginInfo): boolean =>
  page.matches(shownName(p), shownDescription(p), p.manifest.name, p.manifest.description, p.manifest.publisher);

/** The rows of the plugins that match the search; `credits` is Genex's balance. */
export function PluginRows({
  list,
  page,
  credits,
}: {
  list: PluginInfo[];
  page: PluginsPage;
  credits?: CreditsView | null;
}): JSX.Element {
  return (
    <>
      {list
        .filter((p) => pluginMatches(page, p))
        .map((p) => (
          <PluginRow
            key={p.manifest.id}
            plugin={p}
            page={page}
            credits={p.manifest.id === GENEX_PLUGIN_ID ? credits : undefined}
          />
        ))}
    </>
  );
}

/**
 * What every provider row in Settings → Model Providers shares: its status plate (a dot and a word
 * on a soft plate of the tone's color), and its heading — name, version, status, one line of
 * context and at most one visible action.
 */
import type { JSX } from "react";

/** The words a provider row speaks in: its name, the plans it uses, and its install guide. */
export type ProviderWords = { name: string; plans: string; guide: string };

/** A provider row's status: its dot and the ink of its word. */
export const RowTone = {
  Connected: "connected",
  Off: "off",
  Busy: "busy",
  Warning: "warning",
  Danger: "danger",
} as const;
export type RowTone = (typeof RowTone)[keyof typeof RowTone];

const DOT: Record<RowTone, string> = {
  [RowTone.Connected]: "bg-green",
  [RowTone.Off]: "border-[1.5px] border-muted-foreground",
  [RowTone.Busy]: "bg-accent-ink",
  [RowTone.Warning]: "bg-orange",
  [RowTone.Danger]: "bg-red",
};

/** The row's status: its dot and word on a soft plate of the tone's color (`.status-plate`). */
export function Status({ tone, children }: { tone: RowTone; children: string }): JSX.Element {
  return (
    <span className="status-plate" data-tone={tone}>
      <span aria-hidden className={`size-[6px] shrink-0 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

/** What a provider row shows: a status dot and word, one line of context, and its actions. */
export interface RowView {
  tone: RowTone;
  status: string;
  line: string | null;
  actions: JSX.Element | null;
}

/** The row's heading: the provider's name and version, its status, its line and its actions. */
export function RowHeading({
  words,
  version,
  tone,
  status,
  view,
}: {
  words: ProviderWords;
  version: string | undefined;
  tone: RowTone;
  status: string;
  view: RowView;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h3 className="text-base font-medium text-foreground">{words.name}</h3>
          {version && <span className="font-mono text-micro text-muted-foreground">{version}</span>}
          <Status tone={tone}>{status}</Status>
        </div>
        {view.line && <p className="text-body-sm text-muted-foreground">{view.line}</p>}
      </div>
      {view.actions && <div className="flex flex-wrap items-center gap-2">{view.actions}</div>}
    </div>
  );
}

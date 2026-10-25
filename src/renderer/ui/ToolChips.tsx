/** Genex web trace geometry; completed activity stays static and details mount on demand. */
import { memo, useState, type JSX } from "react";
import { type ChatFileLink, wholeFileName } from "../../shared/chat-files.ts";
import type { GenexBlocked } from "../../shared/genex.ts";
import { t } from "../../shared/i18n.ts";
import { useChatFileNames, useChatFiles } from "../chat-files.ts";
import { RowShots } from "../chat/ConnectorShots.tsx";
import { TOOL_ACTIVITY_WORDS, type ToolIcon } from "../words.ts";
import { FileLink } from "./FileText.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { SyntaxCode } from "./SyntaxCode.tsx";
import { codeLanguage } from "./syntax-highlight.ts";
import { OutputTone, toolFailed, ToolState } from "./tool-state.ts";

export interface ToolChipRow {
  key: string;
  icon: ToolIcon;
  label: string;
  activeLabel?: string;
  chip?: string;
  chipMono?: boolean;
  /** Recorded input, formatted only when the tool is expanded. */
  input?: unknown;
  add?: number;
  del?: number;
  failed?: boolean;
  state?: ToolState;
  detail?: Array<{ text: string; tone?: OutputTone }>;
  detailMono?: boolean;
  /** The plugin or connector the step ran in, as a work heading names it ("Worked in Unreal"). */
  source?: { id: string; name: string };
  /** The pictures the step answered with (game-relative paths); `play` ones go up to the work's strip. */
  shots?: Array<{ path: string; play: boolean }>;
  /**
   * A step that makes an asset (its record says what, `CallMaking`): the ids its job may go by in
   * the game's inventory, the call's own first, then the job and generation it answered with.
   */
  making?: { ids: string[] };
  /** The call went no further than asking the person for something first (Genex's terms). */
  blocked?: GenexBlocked;
}
const icons: Record<ToolIcon, IconName> = {
  think: "harness",
  write: "new-game",
  run: "play",
  read: "plan",
  see: "image",
  game: "box",
};
const labels: Record<ToolState, string> = {
  [ToolState.Running]: t("Running"),
  [ToolState.Succeeded]: t("Completed"),
  [ToolState.Failed]: t("Failed"),
  [ToolState.Stopped]: t("Stopped"),
  [ToolState.Unknown]: t("Outcome not recorded"),
};

export const ToolChips = memo(function ToolChips({
  header,
  rows,
}: {
  header: string;
  rows: ToolChipRow[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(30);
  const failures = rows.filter(toolFailed).length;
  const running = rows.findLast((row) => row.state === ToolState.Running);
  return (
    <div data-tool-group className="w-full min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="chat-disclosure">
        <span className="min-w-0 truncate tabular-nums">
          {running ? (running.activeLabel ?? TOOL_ACTIVITY_WORDS.run) : header}
        </span>
        {failures > 0 && (
          <span className="shrink-0 text-orange">{t("{count, plural, other {# failed}}", { count: failures })}</span>
        )}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      </button>
      {open && (
        <div className="chat-tool-frame" data-tool-rows>
          {rows.slice(-limit).map((row) => (
            <ToolRow key={row.key} row={row} />
          ))}
          {rows.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((value) => value + 30)}
              className="w-fit rounded-control px-1.5 py-1 text-chat-sub text-ink-3 hover:bg-control-hover"
            >
              {t("Show {count, plural, other {# earlier tools}}", { count: Math.min(30, rows.length - limit) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
function inputText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.cmd === "string") return record.cmd;
  }
  return JSON.stringify(value, null, 2);
}

/** How a line of a tool's output reads: removed lines and errors red, added lines green. */
const OUTPUT_TONE: Record<OutputTone, string> = {
  [OutputTone.Del]: "text-red",
  [OutputTone.Err]: "text-red",
  [OutputTone.Add]: "text-green",
};

/** The language a tool's input is shown in: a command reads as shell, other arguments as JSON. */
function inputLanguage(row: ToolChipRow): string | undefined {
  const args = row.input && typeof row.input === "object" ? (row.input as Record<string, unknown>) : undefined;
  if (args) return typeof args.command === "string" || typeof args.cmd === "string" ? "bash" : "json";
  return row.input && row.icon === "run" ? "bash" : undefined;
}

/** An opened tool: what it was given, then what it answered (toned lines, or highlighted code). */
function ToolDetail({ row, input }: { row: ToolChipRow; input: string | undefined }): JSX.Element {
  const output = row.detail?.filter((line) => line.text.trim() !== input?.trim());
  const outputLanguage = row.icon === "read" || row.icon === "write" ? codeLanguage(row.chip) : undefined;
  return (
    <div className="chat-tool-detail text-ink-2" data-tool-detail>
      {input && (
        <pre className="chat-tool-code" data-tool-input>
          <SyntaxCode text={input} language={inputLanguage(row)} />
        </pre>
      )}
      {!!output?.length && (
        <pre className={`chat-tool-code ${input ? "chat-tool-output" : ""}`} data-tool-output>
          {output.some((line) => line.tone) ? (
            <code>
              {output.map((line, index) => (
                <span key={index} className={line.tone ? OUTPUT_TONE[line.tone] : undefined}>
                  {line.text}
                  {index < output.length - 1 ? "\n" : ""}
                </span>
              ))}
            </code>
          ) : (
            <SyntaxCode text={output.map((line) => line.text).join("\n")} language={outputLanguage} />
          )}
        </pre>
      )}
    </div>
  );
}

/** What a row that neither succeeded nor runs says after its title. */
function settledLabel(state: ToolState): string {
  return state === ToolState.Unknown ? t("Unknown") : labels[state];
}

/** A path gives up its folders first: the file's own name stays readable. */
function ToolFileLink({
  row,
  threadId,
  name,
  link,
  ink,
}: {
  row: ToolChipRow;
  threadId: string | null;
  name: string;
  link: ChatFileLink;
  ink: string;
}): JSX.Element {
  const chip = row.chip?.trim() ?? "";
  const folder = chip.slice(0, chip.lastIndexOf("/") + 1);
  return (
    <FileLink threadId={threadId} fileRef={{ name }} link={link} label={chip} className={`chat-tool-file ${ink}`}>
      {folder && <span className="min-w-0 truncate">{folder}</span>}
      <span className="shrink-0">{chip.slice(folder.length)}</span>
    </FileLink>
  );
}

/** The file a tool row names, once main has said it is one; the row asks about it while shown. */
function useToolFile(row: ToolChipRow) {
  const { threadId, lookup } = useChatFiles();
  const name = threadId && row.chip ? wholeFileName(row.chip) : null;
  useChatFileNames(threadId, name ? [{ name }] : []);
  const link = name ? lookup(name) : null;
  return { threadId, name, link };
}

/** A step's pictures that stay in its row: all but those its work group shows under its heading. */
function rowShots(row: ToolChipRow, inStrip: readonly string[] | undefined): string[] {
  return (row.shots ?? []).flatMap((shot) => (inStrip?.includes(shot.path) ? [] : [shot.path]));
}

export const ToolRow = memo(function ToolRow({
  row,
  inStrip,
}: {
  row: ToolChipRow;
  /** The pictures its work group shows under its heading, which the row leaves out. */
  inStrip?: readonly string[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const state = row.failed ? ToolState.Failed : (row.state ?? ToolState.Unknown);
  const failed = state === ToolState.Failed;
  const details = Boolean(row.detail?.length || row.chip || row.input != null);
  const label = state === ToolState.Running ? (row.activeLabel ?? row.label) : row.label;
  const verb = label.charAt(0).toUpperCase() + label.slice(1);
  const title = [verb, row.chip].filter(Boolean).join(" · ");
  const settledOther = state !== ToolState.Succeeded && state !== ToolState.Running;
  const ink = failed ? "text-red" : "text-ink-3";
  // A file the row names is a link beside the toggle, never inside it: the toggle stretches over
  // the row (`chat-tool-toggle`), the link sits above it.
  const file = useToolFile(row);
  const shots = rowShots(row, inStrip);
  return (
    <div data-tool-state={state}>
      <div data-tool-head className="chat-tool-head text-step">
        <button
          type="button"
          data-tool-toggle
          title={title}
          aria-label={t("{tool}: {state}", { tool: label, state: labels[state] })}
          disabled={!details}
          aria-expanded={details ? open : undefined}
          onClick={() => setOpen((value) => !value)}
          className="chat-tool-toggle"
        >
          <span aria-hidden className={`flex size-3 shrink-0 items-center ${ink}`}>
            <Icon name={icons[row.icon]} size={12} />
          </span>
          <span data-tool-label className={`min-w-0 truncate ${ink}`}>
            {file.link ? `${verb} ·` : title}
          </span>
        </button>
        {file.link && file.name && (
          <ToolFileLink row={row} threadId={file.threadId} name={file.name} link={file.link} ink={ink} />
        )}
        <RowShots paths={shots} />
        {settledOther && <span className={`shrink-0 text-chat-sub ${ink}`}>{settledLabel(state)}</span>}
        {details && <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="shrink-0 text-icon" />}
      </div>
      {open && <ToolDetail row={row} input={inputText(row.input) ?? row.chip} />}
    </div>
  );
});

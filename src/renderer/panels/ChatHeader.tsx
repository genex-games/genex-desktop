/**
 * The chat column's identity row — which game, how full the context is, and its file actions.
 * Rename lives here (click the title, or ⋯). One game has one chat, so there is no chat switcher.
 * Every gap between the controls drags the window.
 */
import type { JSX, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { Shortcut } from "../ui/Shortcut.tsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip.tsx";
import { formatTokens } from "../chat-labels.ts";
import { TOGGLE_TERMINAL_EVENT } from "./terminal-events.ts";
import type { ContextUsage } from "../../shared/context.ts";
import { hostPlatform } from "../platform.ts";
import { fileManagerWords } from "../words.ts";
import { HarnessGuideButton } from "../chat/HarnessGuide.tsx";

interface Props {
  chatTitle: string;
  isStudio: boolean;
  isDraft: boolean;
  project: string | null;
  pathLabel?: string;
  contextUsage: ContextUsage | null;
  compacting: boolean;
  onCompact: () => void;
  onRename: (title: string) => void;
  onReveal?: () => void;
  onExport?: () => void;
  exportLabel?: string;
  exporting?: boolean;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}

/** A 32px icon-only header control with its tooltip. */
function HeaderButton({
  icon,
  label,
  tip,
  onClick,
  ...rest
}: { icon: IconName; label: string; tip: ReactNode; onClick?: () => void } & Record<
  `data-${string}` | `aria-${string}`,
  string | boolean | undefined
>): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="no-drag header-control" aria-label={label} onClick={onClick} {...rest}>
          <Icon name={icon} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Show sidebar, at the start of a header while the sidebar is hidden. */
export function ShowSidebarButton({ onToggle }: { onToggle: () => void }): JSX.Element {
  return (
    <HeaderButton
      icon="sidebar"
      label="Show sidebar"
      tip={
        <span className="flex items-center gap-2">
          Show sidebar <Shortcut>⌘B</Shortcut>
        </span>
      }
      aria-controls="studio-sidebar"
      aria-expanded={false}
      onClick={onToggle}
    />
  );
}

/** The context meter turns orange, then red, as the chat fills the model's window (percent). */
const CONTEXT_WARN = 60;
const CONTEXT_FULL = 85;
/** From this full, the meter offers to compact the chat. */
const CONTEXT_COMPACT = 40;

const meterColor = (percent: number): string => {
  if (percent >= CONTEXT_FULL) return "var(--red)";
  return percent >= CONTEXT_WARN ? "var(--orange)" : "var(--green)";
};

/** How full the chat's context is, and, once it is filling, the offer to compact it. */
function ContextMeter({
  usage,
  compacting,
  onCompact,
}: {
  usage: ContextUsage & { contextWindow: number };
  compacting: boolean;
  onCompact: () => void;
}): JSX.Element {
  const percent = usage.percent ?? 0;
  const used = `${formatTokens(usage.promptTokens ?? 0)}/${formatTokens(usage.contextWindow)}`;
  return (
    <div
      className="no-drag me-1 flex shrink-0 items-center gap-1.5"
      data-context-meter
      title={`Context: ${used} tokens`}
    >
      <span className="relative h-[3px] w-6 overflow-hidden rounded-full bg-inset shadow-hairline">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${Math.min(100, percent)}%`, background: meterColor(percent) }}
        />
      </span>
      <span className="sr-only">{used}</span>
      {percent >= CONTEXT_COMPACT && (
        <button
          type="button"
          onClick={onCompact}
          disabled={compacting}
          title="Summarise the older part of this chat into the log so it fits the model"
          className="h-5 rounded-chip bg-inset px-1.5 font-mono text-micro text-ink-2 shadow-hairline hover:text-control-text-hover disabled:opacity-50"
        >
          {compacting ? "…" : "compact"}
        </button>
      )}
    </div>
  );
}

/** The chat's title: its rename field while editing, Studio's fixed name, or the rename button. */
function ChatTitle({
  editing,
  draft,
  input,
  chatTitle,
  isStudio,
  isDraft,
  project,
  onDraft,
  onCommit,
  onCancel,
  onEdit,
}: {
  editing: boolean;
  draft: string;
  input: RefObject<HTMLInputElement | null>;
  chatTitle: string;
  isStudio: boolean;
  isDraft: boolean;
  project: string | null;
  onDraft: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onEdit: () => void;
}): JSX.Element {
  if (editing)
    return (
      <input
        ref={input}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
          if (event.key === "Escape") onCancel();
        }}
        className="no-drag h-[30px] w-80 min-w-0 shrink rounded-control bg-field px-2 text-sm font-medium text-ink outline-none"
        aria-label={project ? "Game name" : "Chat name"}
      />
    );
  if (isStudio) return <span className="chat-header-title">Harness</span>;
  return (
    <button
      type="button"
      title={`Rename ${chatTitle}`}
      aria-label={`Rename ${project ? "game" : "chat"}: ${chatTitle}`}
      onClick={onEdit}
      className="no-drag chat-header-title"
    >
      {isDraft ? "New chat" : chatTitle}
    </button>
  );
}

/** The ⋯ menu: the game's build/export action and chat rename. Closing returns focus to the rename field. */
function ChatActions({
  input,
  exporting,
  onExport,
  exportLabel = "Export game…",
  onRename,
}: {
  input: RefObject<HTMLInputElement | null>;
  exporting?: boolean;
  onExport?: () => void;
  exportLabel?: string;
  onRename: () => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-expanded={menuOpen} aria-label="Chat actions" className="no-drag header-control">
              <Icon name="more" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onCloseAutoFocus={(event) => {
          if (input.current) {
            event.preventDefault();
            input.current.focus();
          }
        }}
      >
        <DropdownMenuItem data-chat-action="export" disabled={!onExport || exporting} onSelect={() => onExport?.()}>
          <Icon name="export" />
          {exporting ? "Exporting…" : exportLabel}
        </DropdownMenuItem>
        <DropdownMenuItem data-chat-action="rename" onSelect={onRename}>
          <Icon name="rename" />
          Rename
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatHeader({
  chatTitle,
  isStudio,
  isDraft,
  project,
  pathLabel,
  contextUsage,
  compacting,
  onCompact,
  onRename,
  onReveal,
  onExport,
  exportLabel,
  exporting,
  sidebarHidden,
  onToggleSidebar,
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chatTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(chatTitle);
  }, [chatTitle, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== chatTitle) onRename(next);
    else setDraft(chatTitle);
  };
  const contextWindow = contextUsage?.contextWindow;

  return (
    <div
      data-chat-header
      className={`titlebar-drag flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-page ps-2.5 pe-2 ${sidebarHidden ? "chat-header-sidebar-hidden" : ""}`}
    >
      {sidebarHidden && <ShowSidebarButton onToggle={onToggleSidebar} />}
      <ChatTitle
        editing={editing}
        draft={draft}
        input={inputRef}
        chatTitle={chatTitle}
        isStudio={isStudio}
        isDraft={isDraft}
        project={project}
        onDraft={setDraft}
        onCommit={commit}
        onCancel={() => {
          setDraft(chatTitle);
          setEditing(false);
        }}
        onEdit={() => setEditing(true)}
      />
      {isStudio && <HarnessGuideButton />}
      <span className="min-w-2 flex-1 self-stretch" />

      {contextUsage && contextWindow ? (
        <ContextMeter usage={{ ...contextUsage, contextWindow }} compacting={compacting} onCompact={onCompact} />
      ) : null}

      {project && onReveal && (
        <HeaderButton
          icon="folder"
          label={fileManagerWords(hostPlatform()).show}
          data-reveal-folder=""
          tip={
            <span className="flex flex-col">
              <span>{fileManagerWords(hostPlatform()).show}</span>
              {pathLabel && <span className="font-mono text-[10px] leading-4 opacity-70">{pathLabel}</span>}
            </span>
          }
          onClick={onReveal}
        />
      )}
      <HeaderButton
        icon="terminal"
        label="Toggle terminal"
        data-terminal-toggle=""
        tip={
          <span className="flex items-center gap-2">
            Terminal <Shortcut>⌘`</Shortcut>
          </span>
        }
        onClick={() => window.dispatchEvent(new Event(TOGGLE_TERMINAL_EVENT))}
      />
      {!isStudio && (
        <ChatActions
          input={inputRef}
          exporting={exporting}
          onExport={onExport}
          exportLabel={exportLabel}
          onRename={() => setEditing(true)}
        />
      )}
    </div>
  );
}

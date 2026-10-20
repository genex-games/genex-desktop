/**
 * Where home's next game is saved: a quiet chip under the composer naming the folder, and its
 * menu — the games folder, another folder the user picks, or a folder with a game they already
 * have (which the Open Game sheet takes over).
 */
import type { JSX } from "react";
import { useState } from "react";
import type { FolderInspection, GameLocation } from "../../shared/game-project.ts";
import { pathLeaf } from "../../shared/path-label.ts";
import { inspectPickedFolder } from "../open-folder.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { problemWords } from "../words.ts";

/** The chip's words. */
const MESSAGE = {
  where: "Where this game is saved",
  saveIn: "Save the new game in",
  another: "Another folder…",
  open: "Open a folder…",
  openHint: "Keep working on a game you already have",
} as const;

/** The menu's two places: the games folder, or the folder the user chose. */
const Place = { Games: "games", Chosen: "chosen" } as const;

/** One row's two lines: what it is, and a path (mono) or a few words saying more. */
function FolderLines({ title, path, hint }: { title: string; path?: string; hint?: string }): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-chat text-ink">{title}</span>
      {path ? <span className="truncate font-mono text-xs text-ink-3">{path}</span> : null}
      {hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </span>
  );
}

export function HomeFolderChip({
  rootLabel,
  location,
  disabled = false,
  onLocation,
  onInspect,
  onProblem,
}: {
  /** The games folder, as the UI shows it (`~/AI Games`). */
  rootLabel: string;
  /** The folder chosen for the next game, or null for the games folder. */
  location: GameLocation | null;
  disabled?: boolean;
  onLocation: (location: GameLocation | null) => void;
  /** A folder with a game in it was picked and looked at: the Open Game sheet takes over. */
  onInspect: (inspection: FolderInspection) => void;
  onProblem: (words: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const label = pathLeaf(location?.pathLabel ?? rootLabel);
  const ask = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      onProblem(problemWords(error));
    } finally {
      setBusy(false);
    }
  };
  const chooseAnother = () =>
    ask(async () => {
      const chosen = await window.studio.pickGameLocation();
      if (chosen) onLocation(chosen);
    });
  const openFolder = () =>
    ask(async () => {
      const inspected = await inspectPickedFolder(window.studio);
      if (inspected) onInspect(inspected);
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-home-folder
          className="home-folder-chip"
          title={MESSAGE.where}
          aria-label={`${MESSAGE.where}: ${label}`}
          disabled={disabled || busy}
        >
          <Icon name="folder" size={15} />
          <span className="truncate">{label}</span>
          <Icon name="chevron-down" size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="w-80">
        <DropdownMenuLabel>{MESSAGE.saveIn}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={location ? Place.Chosen : Place.Games}>
          <DropdownMenuRadioItem value={Place.Games} onSelect={() => onLocation(null)}>
            <span className="flex min-w-0 items-center gap-2.5">
              <Icon name="folder" size={16} />
              <FolderLines title={pathLeaf(rootLabel)} path={rootLabel} />
            </span>
          </DropdownMenuRadioItem>
          {/* Picking this row asks for a folder every time, even when one is chosen already. */}
          <DropdownMenuRadioItem value={Place.Chosen} onSelect={() => void chooseAnother()}>
            <span className="flex min-w-0 items-center gap-2.5">
              <Icon name="folder-plus" size={16} />
              <FolderLines
                title={location ? pathLeaf(location.pathLabel) : MESSAGE.another}
                path={location?.pathLabel}
              />
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5" onSelect={() => void openFolder()}>
          <Icon name="folder-open" size={16} />
          <FolderLines title={MESSAGE.open} hint={MESSAGE.openHint} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where home's next game is saved: a quiet chip under the composer naming the folder, and its
 * menu — the games folder, another folder the user picks, or a folder with a game they already
 * have (which the Open Game sheet takes over).
 */
import type { JSX } from "react";
import { useState } from "react";
import { t } from "../../shared/i18n.ts";
import type { FolderInspection, GameLocation } from "../../shared/game-project.ts";
import { pathLeaf } from "../../shared/path-label.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { elapsedMs } from "../analytics/properties.ts";
import { workspaceCode } from "../analytics/workspace-properties.ts";
import { LocationOutcome } from "../analytics/workspace-vocabulary.ts";
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
  where: t("Where this game is saved"),
  whereFolder: (folder: string) => t("Where this game is saved: {folder}", { folder }),
  saveIn: t("Save the new game in"),
  another: t("Another folder…"),
  open: t("Open a folder…"),
  openHint: t("Keep working on a game you already have"),
} as const;

/** The menu's two places: the games folder, or the folder the user chose. */
const Place = { Games: "games", Chosen: "chosen" } as const;

/** One row's two lines: what it is, and a path (mono) or a few words saying more. A row with a path names the person's folder. */
function FolderLines({ title, path, hint }: { title: string; path?: string; hint?: string }): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col" {...(path ? { "data-analytics-mask": "" } : {})}>
      <span className="truncate text-chat text-ink">{title}</span>
      {path ? <span className="truncate font-mono text-xs text-ink-3">{path}</span> : null}
      {hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </span>
  );
}

interface ChipProps {
  /** The games folder, as the UI shows it (`~/AI Games`). */
  rootLabel: string;
  /** The folder chosen for the next game, or null for the games folder. */
  location: GameLocation | null;
  disabled?: boolean;
  onLocation: (location: GameLocation | null) => void;
  /** A folder with a game in it was picked and looked at: the Open Game sheet takes over. */
  onInspect: (inspection: FolderInspection) => void;
  onProblem: (words: string) => void;
}

/** The menu's three asks, one at a time, each counted as it ends; a refusal is said in the person's words. */
function useChipAsks({ location, onLocation, onInspect, onProblem }: ChipProps) {
  const [busy, setBusy] = useState(false);
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
      const started = Date.now();
      const picked = (outcome: LocationOutcome, failure?: unknown): void => {
        const code = outcome === LocationOutcome.Refused ? { code: workspaceCode(failure) } : {};
        track(AnalyticsEvent.GameLocationPicked, { outcome, pick_ms: elapsedMs(started, Date.now()), ...code });
      };
      const chosen = await window.studio.pickGameLocation().catch((error: unknown) => {
        picked(LocationOutcome.Refused, error);
        throw error;
      });
      picked(chosen ? LocationOutcome.Chosen : LocationOutcome.Cancelled);
      if (chosen) onLocation(chosen);
    });
  const openFolder = () =>
    ask(async () => {
      const inspected = await inspectPickedFolder(window.studio, (picked) =>
        track(AnalyticsEvent.OpenFolderPicked, picked),
      );
      if (inspected) onInspect(inspected);
    });
  const backToGames = (): void => {
    if (location) track(AnalyticsEvent.GameLocationPicked, { outcome: LocationOutcome.Reset });
    onLocation(null);
  };
  return { busy, chooseAnother, openFolder, backToGames };
}

export function HomeFolderChip(props: ChipProps): JSX.Element {
  const { rootLabel, location, disabled = false } = props;
  const { busy, chooseAnother, openFolder, backToGames } = useChipAsks(props);
  const label = pathLeaf(location?.pathLabel ?? rootLabel);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Its words and its label name the person's folder. */}
        <button
          type="button"
          data-home-folder
          data-analytics-mask
          className="home-folder-chip"
          title={MESSAGE.where}
          aria-label={MESSAGE.whereFolder(label)}
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
          <DropdownMenuRadioItem value={Place.Games} onSelect={backToGames}>
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

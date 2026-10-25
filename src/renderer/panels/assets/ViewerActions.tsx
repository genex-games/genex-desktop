/**
 * Save and Share in the opened asset, left of Reveal: Save marks it in the person's library (the
 * bookmark fills once saved), Share opens the share window for a file Genex made, and an asset on
 * Play reads Shared, with its page on Play and Stop sharing behind it.
 */
import type { JSX } from "react";
import type { AssetLibraryState } from "../../../shared/asset-library.ts";
import { canSave, canShare, type ShareProgress, sharedAssetUrl, shareUnderway } from "../../asset-library-view.ts";
import { usePlayWeb } from "../../state/hooks.ts";
import { studio } from "../../state/studio.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx";
import { ASSET_LIBRARY_WORDS as WORDS } from "../../words.ts";

/** The bookmark: Save, or Remove from Saved once saved. */
function SaveButton({
  project,
  state,
  onNotice,
}: {
  project: string;
  state: AssetLibraryState;
  onNotice: Notify;
}): JSX.Element {
  const tip = state.saved ? WORDS.unsaveTip : WORDS.saveTip;
  const toggle = (): void => {
    void studio().sharing.save(project, [state.file], !state.saved).catch(notifyProblem(onNotice));
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-viewer-save={state.saved ? "saved" : "save"}
          aria-label={tip}
          aria-pressed={state.saved}
          data-icon-only
          className="lightbox-button"
          onClick={toggle}
        >
          <Icon name="bookmark" size={16} className={state.saved ? "gi-filled" : ""} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/** Shared: the asset's page on Play, and Stop sharing. */
function SharedMenu({
  project,
  state,
  slug,
  onNotice,
}: {
  project: string;
  state: AssetLibraryState;
  slug: string;
  onNotice: Notify;
}): JSX.Element {
  const web = usePlayWeb();
  const open = (): void => {
    void studio().api.openUrl(sharedAssetUrl(web, slug)).catch(notifyProblem(onNotice));
  };
  const stop = (): void => {
    void studio().sharing.unshare(project, state.file).catch(notifyProblem(onNotice));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-viewer-shared aria-label={WORDS.sharedMenu} className="lightbox-button gap-1.5">
          <Icon name="check" size={14} strokeWidth={2} />
          {WORDS.shared}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[230] min-w-[11rem]">
        <DropdownMenuItem data-shared-open onSelect={open}>
          <Icon name="arrow-up-right" size={14} />
          {WORDS.openOnPlay}
        </DropdownMenuItem>
        <DropdownMenuItem data-shared-stop onSelect={stop}>
          <Icon name="close" size={14} />
          {WORDS.stopSharing}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Share in Play's tint, beside Reveal in its own type, with what it does on hover; Sharing… while it goes. */
function ShareButton({ busy, onShare }: { busy: boolean; onShare: () => void }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-viewer-share
          aria-label={WORDS.shareTip}
          aria-busy={busy || undefined}
          disabled={busy}
          className="lightbox-button play-tint gap-1.5"
          onClick={onShare}
        >
          {!busy && <Icon name="globe" size={14} />}
          {busy ? WORDS.sharing : WORDS.share}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {WORDS.shareTip}
      </TooltipContent>
    </Tooltip>
  );
}

/** Save and Share for the opened file, each where it can act; nothing while the library is unread. */
export function ViewerActions({
  project,
  state,
  progress,
  onShare,
  onNotice,
}: {
  project: string;
  state: AssetLibraryState | null;
  progress: ShareProgress | undefined;
  onShare: () => void;
  onNotice: Notify;
}): JSX.Element | null {
  if (!state) return null;
  const slug = state.shared?.live ? state.shared.slug : null;
  const underway = shareUnderway(progress);
  return (
    <>
      {canSave(state) && <SaveButton project={project} state={state} onNotice={onNotice} />}
      {slug && !underway && <SharedMenu project={project} state={state} slug={slug} onNotice={onNotice} />}
      {(canShare(state) || underway) && <ShareButton busy={underway} onShare={onShare} />}
    </>
  );
}

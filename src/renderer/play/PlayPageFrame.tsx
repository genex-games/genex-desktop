/**
 * The frame of Play's people pages (Friends, a profile): the dashboard's page and scroller, its
 * bar holding the sidebar's toggle while the sidebar is hidden and, on a profile, Back.
 */
import type { JSX, ReactNode } from "react";
import { SIDEBAR_TOGGLE, SidebarToggle } from "../shell/use-shell-chrome.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";

/** A people page: its bar, then what scrolls. */
export function PlayPageFrame({
  label,
  sidebarHidden,
  onToggleSidebar,
  onBack,
  backLabel = PLAY_WORDS.people.back,
  children,
}: {
  label: string;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  /** Back to the page before; none on a page the sidebar opens. */
  onBack?: () => void;
  /** What Back says: the page it returns to, when that is clearer than "Back". */
  backLabel?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section data-play-page aria-label={label} className="play-page">
      <div className="play-scroll">
        <header
          className={`play-toolbar people-toolbar titlebar-drag window-controls-end ${sidebarHidden ? "play-toolbar-inset" : ""}`}
        >
          {sidebarHidden && (
            <button
              type="button"
              className="no-drag sidebar-toggle"
              data-sidebar-toggle={SidebarToggle.Show}
              aria-label={SIDEBAR_TOGGLE.Show}
              aria-controls="studio-sidebar"
              aria-expanded="false"
              onClick={onToggleSidebar}
            >
              <Icon name="sidebar" />
            </button>
          )}
          {onBack && (
            <Button variant="ghost" className="no-drag text-ink-3" data-play-back onClick={onBack}>
              <Icon name="chevron-left" />
              {backLabel}
            </Button>
          )}
        </header>
        <div className="people-content">{children}</div>
      </div>
    </section>
  );
}

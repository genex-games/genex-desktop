/**
 * A link Play hands out and the ways to pass it on: a box showing it without its scheme, with Copy;
 * under it Post on X (X's post page in the browser, the text and the link filled in) and, on a Mac,
 * Share… (its share menu, by the button: Messages, Mail, AirDrop). The invite card on Friends and
 * Share on the account's own profile both use them.
 */
import type { JSX, MouseEvent, Ref } from "react";
import { StudioPlatform } from "../../shared/boot.ts";
import { linkWithoutScheme, xPostUrl } from "../../shared/play-share.ts";
import { hostPlatform } from "../platform.ts";
import { studio } from "../state/studio.ts";
import { XMark } from "../ui/brand.tsx";
import { Icon } from "../ui/icons.tsx";
import { useCopy } from "../use-copy.ts";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.people;
/** How far under the button the share menu opens. */
const MENU_GAP = 4;

/** The link in a box, read-only and selected whole on focus, and Copy, which copies all of it. */
export function LinkCopy({
  link,
  label,
  copyHook,
  copyRef,
}: {
  link: string;
  label: string;
  /** The Copy button's `data-*` hook. */
  copyHook: Record<`data-${string}`, string>;
  /** The Copy button, for a popover to put its first focus on. */
  copyRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <div className="people-invite-link">
      <input
        readOnly
        value={linkWithoutScheme(link)}
        aria-label={label}
        data-share-link
        onFocus={(event) => event.target.select()}
      />
      <button
        ref={copyRef}
        type="button"
        className="people-button"
        data-tone="tint"
        {...copyHook}
        onClick={() => copy(link)}
      >
        <Icon name={copied ? "check" : "copy"} size={15} />
        {copied ? WORDS.copied : WORDS.copy}
      </button>
    </div>
  );
}

/** Open the Mac's share menu for `link` under the button that was pressed. */
function shareFrom(event: MouseEvent<HTMLButtonElement>, link: string): void {
  const rect = event.currentTarget.getBoundingClientRect();
  // A menu that cannot open (a fixture launch) leaves nothing to say: the link is still in the box.
  studio()
    .api.playShare(link, { x: rect.left, y: rect.bottom + MENU_GAP })
    .catch(() => undefined);
}

/** Post on X with `xText` and the link, and Share… on a Mac, side by side. */
export function ShareRow({ link, xText }: { link: string; xText: string }): JSX.Element {
  const mac = hostPlatform() === StudioPlatform.Mac;
  return (
    <div className="share-row" data-share-row>
      <button
        type="button"
        className="people-button share-row-button"
        data-tone="quiet"
        data-share-x
        onClick={() =>
          void studio()
            .api.openUrl(xPostUrl(xText, link))
            .catch(() => undefined)
        }
      >
        <XMark size={13} />
        {WORDS.postOnX}
      </button>
      {mac && (
        <button
          type="button"
          className="people-button share-row-button"
          data-tone="quiet"
          aria-label={WORDS.shareMenuLabel}
          data-share-menu
          onClick={(event) => shareFrom(event, link)}
        >
          <Icon name="export" size={14} />
          {WORDS.shareMenu}
        </button>
      )}
    </div>
  );
}

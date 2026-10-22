/**
 * Publish's one row that shares the game's assets on Play when it goes live: the first few assets'
 * pictures overlapping, "Share its N assets on Play" and a switch, off by default. Once the game is
 * live the row gives way to one line of how the shares went: a bare ✓ with how many are on Play, or
 * in orange how many couldn't be shared, with Try again.
 */
import type { JSX } from "react";
import { LibraryKind } from "../../../../shared/asset-library.ts";
import { KIND_GLYPH } from "../../../asset-library-view.ts";
import { Button } from "../../../ui/Button.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { Toggle } from "../../../ui/Toggle.tsx";
import { PUBLISH_SHARE_WORDS } from "../../../words.ts";
import { ShareLine, shareLine } from "./publish-share.ts";
import { type PublishShare, ShareRun, type ShareThumbView } from "./use-publish-share.ts";

const WORDS = PUBLISH_SHARE_WORDS;

/** One small square picture, overlapping the one before it. */
function Thumb({ thumb }: { thumb: ShareThumbView }): JSX.Element {
  return (
    <span className="publish-share-thumb">
      {thumb.url ? (
        <img src={thumb.url} alt="" draggable={false} />
      ) : (
        <Icon name={KIND_GLYPH[thumb.kind ?? LibraryKind.Model]} size={13} />
      )}
    </span>
  );
}

/** The row above the presses: pictures, one line, and the switch. */
function ShareRow({ share }: { share: PublishShare }): JSX.Element {
  const text = WORDS.offer(share.count);
  return (
    <div className="publish-share" data-publish-share={share.on ? "on" : "off"}>
      <span className="publish-share-thumbs" aria-hidden="true">
        {share.thumbs.map((thumb) => (
          <Thumb key={thumb.file} thumb={thumb} />
        ))}
      </span>
      <span className="publish-share-text" title={text}>
        {text}
      </span>
      <Toggle on={share.on} onChange={share.setOn} ariaLabel={WORDS.switchLabel(share.count)} />
    </div>
  );
}

/** Publish closed before an asked-for share ran: one line and Share now, never a silent drop. */
function NotSharedRow({ share }: { share: PublishShare }): JSX.Element {
  return (
    <p className="publish-share-line" role="status" data-publish-share-outcome="not-shared">
      {WORDS.notShared(share.count)}
      <Button
        variant="play-tint"
        className="publish-share-now"
        aria-label={WORDS.shareNowLabel(share.count)}
        onClick={share.shareNow}
      >
        {WORDS.shareNow}
      </Button>
    </p>
  );
}

/** The success screen's one line: sharing, done with a bare ✓, or what missed with Try again. */
function ShareOutcomeLine({ share }: { share: PublishShare }): JSX.Element | null {
  if (share.run === ShareRun.Sharing)
    return (
      <p className="publish-share-line" role="status" data-publish-share-outcome="sharing">
        {WORDS.sharing(share.count)}
      </p>
    );
  const { line, count } = shareLine(share.tally);
  if (line === ShareLine.None) return null;
  if (line === ShareLine.Missed)
    return (
      <p className="publish-share-line" role="alert" data-publish-share-outcome={line}>
        {WORDS.missed(count)}
        <Button className="publish-share-retry" aria-label={WORDS.tryAgainLabel} onClick={share.retry}>
          {WORDS.tryAgain}
        </Button>
      </p>
    );
  return (
    <p className="publish-share-line" role="status" data-publish-share-outcome={line}>
      <Icon name="check" size={14} />
      {line === ShareLine.Checking ? WORDS.checking(count) : WORDS.shared(count)}
    </p>
  );
}

/** Before the game goes live, the row (when there is something to share); after, how the shares went. */
export function PublishShareLine({
  share,
  celebrate,
}: {
  share: PublishShare;
  celebrate: boolean;
}): JSX.Element | null {
  if (share.run !== ShareRun.Idle) return <ShareOutcomeLine share={share} />;
  if (celebrate) return null;
  if (share.missedBefore) return <NotSharedRow share={share} />;
  return share.shown ? <ShareRow share={share} /> : null;
}

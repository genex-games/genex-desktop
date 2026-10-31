/**
 * What Create › Items shows in place of a list it could not show: a read under way, a failure with
 * Try again, the Genex account signed out (with Sign in), or genex.games' store off.
 */
import type { JSX } from "react";
import { SignInNote } from "../../play/SignInNote.tsx";
import { ItemsRead } from "../../state/items.ts";
import { Button } from "../../ui/Button.tsx";
import { Pending } from "../../ui/Pending.tsx";
import { SkeletonLines } from "../../ui/Skeleton.tsx";
import { ITEMS_WORDS } from "../../words.ts";

/** The note for `read`, or null once there is something to show. */
export function ReadNote({ read, onRetry }: { read: ItemsRead; onRetry: () => void }): JSX.Element | null {
  switch (read) {
    case ItemsRead.Idle:
    case ItemsRead.Loading:
      return (
        <Pending label={ITEMS_WORDS.title}>
          <SkeletonLines widths={["60%", "40%", "52%"]} />
        </Pending>
      );
    case ItemsRead.Failed:
      return (
        <div role="alert" className="items-note">
          {ITEMS_WORDS.failed}
          <Button variant="secondary" onClick={onRetry}>
            {ITEMS_WORDS.tryAgain}
          </Button>
        </div>
      );
    case ItemsRead.SignedOut:
      return <SignInNote text={ITEMS_WORDS.signedOut} />;
    case ItemsRead.Off:
      return <p className="items-note">{ITEMS_WORDS.storeOff}</p>;
    default:
      return null;
  }
}

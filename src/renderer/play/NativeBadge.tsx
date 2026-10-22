/**
 * A native game's marks: the Apple, Windows and Linux marks of the systems it was built for, and the
 * badge on its card's cover (canvas board "Main"): the systems' marks on one small glass plate in
 * the cover's top corner while it is not installed (Rab, 2026-10-22), how far its download has come with a
 * line along the cover's foot, On this Mac (or computer) once installed, or an update waiting with
 * its size. A game with a web build shows nothing new until it is installed here.
 */
import type { JSX } from "react";
import { sizeWords } from "../../shared/byte-size.ts";
import { NativePlatform } from "../../shared/play-native.ts";
import { Icon } from "../ui/icons.tsx";
import { NATIVE_WORDS, nativeHereWords } from "../words.ts";
import { CardBadge, type CardBadgeState } from "./native-model.ts";

const WORDS = NATIVE_WORDS;

/** The marks each system is drawn with. */
const MARK: Record<NativePlatform, "apple" | "windows" | "linux"> = {
  [NativePlatform.Mac]: "apple",
  [NativePlatform.Windows]: "windows",
  [NativePlatform.Linux]: "linux",
};

/** The systems' names as one phrase: "Mac and Windows". */
export const platformNames = (platforms: readonly NativePlatform[]): string =>
  WORDS.platforms(platforms.map((platform) => WORDS.platform[platform]));

/** The marks of `platforms`, side by side; the phrase is the caller's to say. */
export function PlatformMarks({ platforms, size = 15 }: { platforms: readonly NativePlatform[]; size?: number }) {
  return (
    <span className="native-marks" aria-hidden="true">
      {platforms.map((platform) => (
        <Icon key={platform} name={MARK[platform]} size={size} />
      ))}
    </span>
  );
}

/** The badge over a card's cover, and the download's line along its foot. */
export function CardNativeBadge({ badge }: { badge: CardBadgeState }): JSX.Element {
  switch (badge.kind) {
    case CardBadge.Platforms:
      return (
        <span
          className="native-keys"
          role="img"
          aria-label={platformNames(badge.platforms)}
          title={platformNames(badge.platforms)}
          data-native-badge="platforms"
        >
          {badge.platforms.map((platform) => (
            <Icon key={platform} name={MARK[platform]} size={14} />
          ))}
        </span>
      );
    case CardBadge.Downloading:
      return (
        <>
          <span className="native-badge" data-native-badge="downloading">
            {WORDS.downloading(badge.percent, WORDS.left(badge.etaMs))}
          </span>
          <span className="native-progress" aria-hidden="true" style={{ width: `${badge.percent}%` }} />
        </>
      );
    case CardBadge.Update:
      return (
        <span className="native-badge" data-native-badge="update">
          <Icon name="update" size={13} />
          {WORDS.update(sizeWords(badge.bytes))}
        </span>
      );
    default:
      return (
        <span className="native-badge" data-native-badge="installed">
          <Icon name="check" size={13} />
          {nativeHereWords(badge.platform).installedHere}
        </span>
      );
  }
}

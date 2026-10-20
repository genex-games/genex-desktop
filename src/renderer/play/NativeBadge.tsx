/**
 * A native game's marks: the Apple and Windows marks of the systems it was built for, and the badge
 * on its card's cover (canvas board "Main"): the marks alone while it is not installed, how far its
 * download has come with a line along the cover's foot, On this Mac once installed, or an update
 * waiting with its size. A game with a web build shows nothing new until it is installed here.
 */
import type { JSX } from "react";
import { sizeWords } from "../../shared/byte-size.ts";
import { NativePlatform } from "../../shared/play-native.ts";
import { Icon } from "../ui/icons.tsx";
import { NATIVE_WORDS } from "../words.ts";
import { CardBadge, type CardBadgeState } from "./native-model.ts";

const WORDS = NATIVE_WORDS;

/** The marks each system is drawn with; Linux has none of its own yet. */
const MARK: Partial<Record<NativePlatform, "apple" | "windows">> = {
  [NativePlatform.Mac]: "apple",
  [NativePlatform.Windows]: "windows",
};

/** The systems' names as one phrase: "Mac and Windows". */
export const platformNames = (platforms: readonly NativePlatform[]): string =>
  WORDS.platforms(platforms.map((platform) => WORDS.platform[platform]));

/** The marks of `platforms`, side by side; the phrase is the caller's to say. */
export function PlatformMarks({ platforms, size = 15 }: { platforms: readonly NativePlatform[]; size?: number }) {
  return (
    <span className="native-marks" aria-hidden="true">
      {platforms.map((platform) => {
        const mark = MARK[platform];
        return mark ? <Icon key={platform} name={mark} size={size} /> : null;
      })}
    </span>
  );
}

/** The badge over a card's cover, and the download's line along its foot. */
export function CardNativeBadge({ badge }: { badge: CardBadgeState }): JSX.Element {
  switch (badge.kind) {
    case CardBadge.Platforms:
      return (
        <span
          className="native-badge"
          role="img"
          aria-label={platformNames(badge.platforms)}
          data-native-badge="platforms"
        >
          <PlatformMarks platforms={badge.platforms} />
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
          {WORDS.installedHere}
        </span>
      );
  }
}

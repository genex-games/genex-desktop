/**
 * A sound's face on an asset tile: a drawn waveform (the same for the same sound) whose bars fill as
 * it plays, and a round play button when the tile knows the sound's file. One sound plays at a time,
 * as in the chat; the file streams from genex.games' asset hosts.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { audioPlayer, type OpenedAudio } from "../chat/audio-player.ts";
import { Icon } from "../ui/icons.tsx";
import { PLAY_ASSET_WORDS } from "../words.ts";
import { waveDrawing } from "./asset-tiles.ts";

const WORDS = PLAY_ASSET_WORDS;

/** A sound on the network as an element that plays it; nothing to free afterwards. */
function openRemote(url: string): Promise<OpenedAudio> {
  const element = new Audio(url);
  element.preload = "auto";
  return Promise.resolve({ element, close: () => {} });
}

/** The tile's player: made on the first press, released with the tile. */
function useRemoteSound(url: string | null) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const player = useMemo(
    () =>
      url
        ? audioPlayer(() => openRemote(url), {
            time: setTime,
            duration: setDuration,
            playing: setPlaying,
            failed: () => {
              setFailed(true);
              setPlaying(false);
            },
          })
        : null,
    [url],
  );
  useEffect(() => () => player?.release(), [player]);
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  return { player, playing, failed, progress };
}

/** The sound's drawing and, when its file is known, the round button that plays it on the tile. */
export function SoundFace({
  title,
  seed,
  fileUrl,
}: {
  title: string;
  /** What keeps the drawing the same for the same sound. */
  seed: string;
  fileUrl: string | null;
}): JSX.Element {
  const bars = useMemo(() => waveDrawing(seed), [seed]);
  const { player, playing, failed, progress } = useRemoteSound(fileUrl);
  return (
    <>
      <span className="play-asset-wave" aria-hidden="true">
        {bars.map((height, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a drawing, only ever in this order
            key={index}
            className="audio-bar"
            data-played={(playing || progress > 0) && index / bars.length < progress ? true : undefined}
            style={{ height: `${height * 100}%` }}
          />
        ))}
      </span>
      {player && (
        <button
          type="button"
          className="play-asset-sound audio-play"
          aria-label={playing ? WORDS.pause(title) : WORDS.play(title)}
          title={failed ? WORDS.playFailed : undefined}
          disabled={failed}
          data-play-asset-sound={playing ? "playing" : "paused"}
          onClick={() => void player.toggle()}
        >
          <Icon name={playing ? "pause" : "play"} size={12} className="play-asset-sound-glyph" />
        </button>
      )}
    </>
  );
}

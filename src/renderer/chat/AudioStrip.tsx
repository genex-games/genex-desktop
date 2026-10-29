/**
 * A delivered sound, played where it is: one quiet row in the chat (`AudioStrip`) and a tile on the
 * Assets canvas (`AudioTile`), each with its waveform drawn in the theme's ink.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import type { ProjectAsset } from "../../shared/game-assets.ts";
import { t } from "../../shared/i18n.ts";
import { previewBytes } from "../asset-bytes.ts";
import { assetTitle } from "../asset-names.ts";
import { Icon } from "../ui/icons.tsx";
import { ASSET_WORDS } from "../words.ts";
import { audioPlayer, type OpenedAudio } from "./audio-player.ts";
import { useAsyncEffect } from "../use-async-effect.ts";

/** A waveform's bars. */
const BARS = 40;
/** A bar's shortest height, as a share of the waveform's. */
const MIN_BAR_PCT = 12;
/** How many sounds' waveforms stay in memory before the oldest is forgotten. */
const WAVE_CACHE_CAP = 96;
/** A file larger than this plays without a waveform: decoding it would cost more than it shows. */
const MAX_WAVEFORM_BYTES = 20 * 1024 * 1024;
/** How many samples each bar looks at, at most, to find its peak. */
const SAMPLES_PER_BAR = 256;
/** A minute, in the seconds the player's clock counts. */
const SECONDS_PER_MINUTE = MINUTE_MS / SECOND_MS;

/** What the strip says in place of a waveform it would not draw. */
const MESSAGE = {
  tooLarge: t("Large audio plays without a waveform"),
} as const;

type Wave = { peaks: number[]; duration: number };
const waves = new Map<string, Wave | null>();
let queue: Promise<unknown> = Promise.resolve();

const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / SECONDS_PER_MINUTE)}:${String(whole % SECONDS_PER_MINUTE).padStart(2, "0")}`;
};

async function decode(project: string, file: string): Promise<{ peaks: number[]; duration: number }> {
  const result = await window.studio.previewProjectAsset({ project, file });
  const bytes = previewBytes(result.data);
  if (bytes.length > MAX_WAVEFORM_BYTES) throw new Error(MESSAGE.tooLarge);
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(bytes.buffer);
    const data = audio.getChannelData(0),
      peaks: number[] = [];
    for (let i = 0; i < BARS; i++) {
      const start = Math.floor((i * data.length) / BARS),
        end = Math.floor(((i + 1) * data.length) / BARS);
      let peak = 0;
      for (let j = start; j < end; j += Math.max(1, Math.floor((end - start) / SAMPLES_PER_BAR)))
        peak = Math.max(peak, Math.abs(data[j] ?? 0));
      peaks.push(peak);
    }
    const loudest = Math.max(...peaks, 0.001);
    return { peaks: peaks.map((peak) => peak / loudest), duration: audio.duration };
  } finally {
    await context.close();
  }
}

/** Remember a waveform (or that there is none), forgetting the oldest past the cap. */
function rememberWave(key: string, wave: Wave | null): void {
  waves.set(key, wave);
  if (waves.size <= WAVE_CACHE_CAP) return;
  const oldest = waves.keys().next().value;
  if (oldest !== undefined) waves.delete(oldest);
}

/**
 * The sound's waveform, decoded once the row nears the screen, one decode at a time across the
 * chat. `onDuration` learns the length the decode found.
 */
function useWaveform(
  key: string,
  source: { project: string; file: string },
  host: RefObject<HTMLDivElement | null>,
  onDuration: (seconds: number) => void,
): Wave | null | undefined {
  const [wave, setWave] = useState(() => waves.get(key));
  useAsyncEffect(
    (alive) => {
      if (waves.has(key)) return;
      let started = false;
      const observer = new IntersectionObserver(
        (entries) => {
          if (started || !entries.some((entry) => entry.isIntersecting)) return;
          started = true;
          observer.disconnect();
          const task = queue.catch(() => {}).then(() => (alive() ? decode(source.project, source.file) : null));
          queue = task;
          void task
            .then((value) => {
              if (!value) return;
              rememberWave(key, value);
              if (!alive()) return;
              setWave(value);
              onDuration(value.duration);
            })
            .catch(() => {
              waves.set(key, null);
              if (alive()) setWave(null);
            });
        },
        { rootMargin: "150px" },
      );
      if (host.current) observer.observe(host.current);
      return () => observer.disconnect();
    },
    [key],
  );
  return wave;
}

/** Read a sound's file into an element that plays it from memory. */
async function openAudio(source: { project: string; file: string }): Promise<OpenedAudio> {
  const result = await window.studio.previewProjectAsset(source);
  const url = URL.createObjectURL(new Blob([previewBytes(result.data)], { type: result.mimeType }));
  const element = new Audio(url);
  element.preload = "auto";
  return { element, close: () => URL.revokeObjectURL(url) };
}

/** The strip's player: made on the first play or seek, one playing at a time, released on unmount. */
function useAudioPlayer(source: { project: string; file: string }, knownDuration: number) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(knownDuration);
  const [isPlaying, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [player] = useState(() =>
    audioPlayer(() => openAudio(source), {
      time: setTime,
      duration: setDuration,
      playing: setPlaying,
      failed: () => {
        setFailed(true);
        setPlaying(false);
      },
    }),
  );
  useEffect(() => () => player.release(), [player]);

  const seek = (seconds: number) => {
    setTime(seconds);
    return player.seek(seconds);
  };
  /** A length learned elsewhere (the waveform's decode) fills in only a length not yet known. */
  const learnDuration = (seconds: number) => setDuration((current) => current || seconds);
  return { time, duration, isPlaying, failed, toggle: player.toggle, seek, learnDuration };
}

/** The sound's player and waveform, as a strip and a tile both use them. */
function useSound(project: string, asset: ProjectAsset, host: RefObject<HTMLDivElement | null>) {
  const file = asset.assetRef ?? asset.file;
  const key = JSON.stringify([project, file, asset.mtime, asset.bytes]);
  const source = { project, file };
  const player = useAudioPlayer(source, waves.get(key)?.duration ?? 0);
  const wave = useWaveform(key, source, host, player.learnDuration);
  const { time, duration, isPlaying } = player;
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  const shownTime = isPlaying || time > 0 ? time : duration;
  return { ...player, wave, progress, clockText: duration > 0 ? clock(shownTime) : "", live: isPlaying || time > 0 };
}

type Sound = ReturnType<typeof useSound>;

/** Where a waveform stands, as its `data-thumbnail-state` says it. */
function waveState(wave: Wave | null | undefined): string {
  if (wave) return "ready";
  return wave === null ? "unavailable" : "loading";
}

/** The round play button, filled in the theme's ink. */
function PlayButton({ sound, name, className }: { sound: Sound; name: string; className: string }) {
  const { isPlaying, failed, toggle } = sound;
  return (
    <button
      type="button"
      aria-label={isPlaying ? t("Pause {name}", { name }) : t("Play {name}", { name })}
      title={failed ? ASSET_WORDS.playFailed : undefined}
      disabled={failed}
      onClick={() => void toggle()}
      className={`audio-play grid shrink-0 cursor-pointer place-items-center rounded-full disabled:cursor-default disabled:opacity-50 ${className}`}
    >
      {isPlaying ? (
        <Pause aria-hidden size={12} fill="currentColor" strokeWidth={0} />
      ) : (
        <Play aria-hidden size={12} fill="currentColor" strokeWidth={0} className="translate-x-px" />
      )}
    </button>
  );
}

/** The sound's shape: bars in ink up to where it has played, and a seek control over them. */
function Waveform({ sound, name, className }: { sound: Sound; name: string; className: string }) {
  const { wave, progress, duration, time, failed, seek } = sound;
  const peaks = wave?.peaks ?? Array.from({ length: BARS }, () => 0.12);
  return (
    <div
      data-thumbnail-state={waveState(wave)}
      className={`relative flex shrink-0 items-center gap-0.5 rounded-sm has-[input:focus-visible]:bg-control-hover ${className}`}
      aria-hidden={!duration}
    >
      {peaks.map((peak, i) => (
        <span
          key={i}
          data-played={i / BARS < progress || undefined}
          className="audio-bar flex-1 rounded-full"
          style={{ height: `${Math.max(MIN_BAR_PCT, peak * 100)}%` }}
        />
      ))}
      {duration > 0 && !failed && (
        <input
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(time, duration)}
          aria-label={t("Seek {name}", { name })}
          aria-valuetext={t("{time} of {duration}", { time: clock(time), duration: clock(duration) })}
          onChange={(event) => void seek(Number(event.target.value))}
          className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0"
        />
      )}
    </div>
  );
}

/**
 * A delivered sound in the chat as one row: play in place, its shape, its length. With
 * `onOpenAssets`, hovering the row swaps the length for Open in Assets.
 */
export function AudioStrip({
  project,
  asset,
  onOpenAssets,
}: {
  project: string;
  asset: ProjectAsset;
  onOpenAssets?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const sound = useSound(project, asset, host);
  const name = assetTitle(asset.file);
  return (
    <div
      ref={host}
      data-audio-strip={asset.file}
      className="asset-row flex h-11 min-w-0 items-center gap-2.5 rounded-xl pr-2 pl-1.5"
    >
      <PlayButton sound={sound} name={name} className="size-8" />
      <span title={asset.file} className="min-w-0 flex-1 truncate text-chat-sub text-ink">
        {name}
      </span>
      <Waveform sound={sound} name={name} className="h-[22px] w-[168px]" />
      <span className="relative h-7 w-9 shrink-0">
        <span
          data-live={sound.live || undefined}
          className={`audio-time absolute inset-0 flex items-center justify-end font-mono text-xs tabular-nums ${onOpenAssets ? "asset-row-rest" : ""}`}
        >
          {sound.clockText}
        </span>
        {onOpenAssets && (
          <button
            type="button"
            data-open-assets
            aria-label={ASSET_WORDS.openInAssets}
            title={ASSET_WORDS.openInAssets}
            onClick={onOpenAssets}
            className="asset-row-action absolute top-0 -right-0.5 grid size-7 cursor-pointer place-items-center rounded-lg text-ink-2 hover:bg-control-hover hover:text-control-text-hover"
          >
            <Icon name="assets" size={16} />
          </button>
        )}
      </span>
    </div>
  );
}

/** A sound on the Assets canvas: its waveform, play in place, its name and length; the tile opens the viewer. */
export function AudioTile({ project, asset, onOpen }: { project: string; asset: ProjectAsset; onOpen: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const sound = useSound(project, asset, host);
  const name = assetTitle(asset.file);
  const fileName = asset.file.split("/").at(-1) ?? asset.file;
  return (
    <div
      ref={host}
      data-tile-kind="audio"
      className="asset-tile relative h-full min-h-0 overflow-hidden rounded-card bg-inset"
    >
      <button
        type="button"
        aria-label={t("Preview {file}", { file: fileName })}
        title={fileName}
        onClick={onOpen}
        className="absolute inset-0 cursor-pointer rounded-card"
      />
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        <Waveform sound={sound} name={name} className="pointer-events-auto mt-[18%] h-[28%] w-full" />
        <div className="flex min-w-0 items-center gap-2">
          <PlayButton sound={sound} name={name} className="pointer-events-auto size-7" />
          <span className="min-w-0 flex-1 truncate text-micro text-ink">{name}</span>
          <span data-live={sound.live || undefined} className="audio-time font-mono text-micro tabular-nums">
            {sound.clockText}
          </span>
        </div>
      </div>
    </div>
  );
}

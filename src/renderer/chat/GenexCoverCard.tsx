/**
 * The Genex cover a builder kept, as a result in the chat: the shot itself at 16:9, captioned
 * "Genex cover", with Publish beside it, which opens Studio's own Publish dialog for this game
 * (that dialog's press is the consent; a live game is offered Publish update there). Publish is
 * hidden while a publish of the game runs, while Genex puts no Publish on the strip, and once
 * Genex has answered for the kept frame (`coverCardPublish`).
 *
 * The picture is the game's kept shot, read from Genex's storage by the game's name
 * (`readProjectAsset`'s `genex-cover` scope), never a picture a tool result carried: a shot that
 * can no longer be read leaves no card. Genex-only on purpose, until plugin pictures have a
 * general home in the chat; then only Publish stays here.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import type { GenexCoverEntry } from "../chat-entries.ts";
import { openBeside } from "../open-beside.ts";
import { readGenexShot } from "../panels/plugins/genex/genex-cover-shot.ts";
import { coverCardPublish } from "../panels/plugins/genex/genex-publish-view.ts";
import { type GenexPublishReading, useGenexPublishState } from "../panels/plugins/genex/use-genex-publishing.ts";
import { composeInChat } from "../compose-in-chat.ts";
import { openPluginSetup } from "../plugin-setup.ts";
import { usePlugins } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useAsyncEffect } from "../use-async-effect.ts";
import { GENEX_WORDS } from "../words.ts";

const WORDS = GENEX_WORDS.publish;
/** The longest edge the card's picture is read at: twice the card's widest picture, for sharp pixels. */
const CARD_PICTURE_PX = 960;
/** How many games' shots stay in memory, so a card the transcript remounts shows its picture at once. */
const SHOT_CACHE_MAX = 16;

/** Each game's kept shot as last read: its picture, or null when it could not be read. */
const shots = new Map<string, string | null>();

function rememberShot(project: string, src: string | null): void {
  shots.delete(project);
  shots.set(project, src);
  while (shots.size > SHOT_CACHE_MAX) {
    const oldest = shots.keys().next().value;
    if (oldest === undefined) break;
    shots.delete(oldest);
  }
}

const readShot = readGenexShot;

/**
 * The game's kept shot: undefined while it is first read, null when it cannot be. A card shows the
 * picture last read for its game at once, and reads it again whenever it mounts or a newer shoot
 * takes the card: a later shot (a publish shoots again) replaces the kept one.
 */
function useKeptShot(project: string | null, callId: string): string | null | undefined {
  const [read, setRead] = useState<{ project: string; src: string | null } | null>(null);
  useAsyncEffect(
    (alive) => {
      if (!project) return;
      void readShot(project, CARD_PICTURE_PX).then((src) => {
        rememberShot(project, src);
        if (alive()) setRead({ project, src });
      });
      return undefined;
    },
    [project, callId],
  );
  if (!project) return null;
  if (read?.project === project) return read.src;
  return shots.has(project) ? (shots.get(project) ?? null) : undefined;
}

/** Open the shot beside the chat at its full size, or as the card shows it when that cannot be read. */
async function openShot(project: string, shown: string): Promise<void> {
  openBeside({ kind: "image", name: WORDS.coverCard, src: (await readShot(project)) ?? shown });
}

/**
 * Publish beside the cover: opens Studio's Publish dialog, unless Genex is off, already
 * publishing or done with this frame. It waits for the game's first publish record, so it never
 * shows and then goes.
 */
function CoverPublish({ project, reading }: { project: string; reading: GenexPublishReading }): JSX.Element | null {
  const plugins = usePlugins((s) => s.list);
  const { read, state } = reading;
  if (!read || !coverCardPublish(plugins, project, state)) return null;
  return (
    // The chat's result button (Play on a build card) in size and type; the accent fill marks it due.
    <Button
      variant="default"
      className="result-button"
      data-genex-cover-publish
      aria-label={WORDS.coverCardPublishLabel}
      onClick={() => openPluginSetup(GENEX_PLUGIN_ID)}
    >
      <Icon name="globe" size={12} />
      <span>{WORDS.publish}</span>
    </Button>
  );
}

/** Another beside Publish: asks this chat for a different cover, as the Publish banner's Another cover does. */
function CoverAnother({ project }: { project: string }): JSX.Element {
  return (
    <Button
      variant="ghost"
      className="result-button"
      data-genex-cover-another
      aria-label={WORDS.anotherCoverLabel}
      onClick={() => composeInChat({ project, text: WORDS.coverAnotherPrompt(""), send: true })}
    >
      <Icon name="reload" size={12} />
      <span>{WORDS.coverCardAnother}</span>
    </Button>
  );
}

/** The card: the kept shot (its place held while it is read), the caption, Another and Publish. */
export function GenexCoverCard({ entry, project }: { entry: GenexCoverEntry; project: string | null }) {
  const game = entry.project ?? project;
  const src = useKeptShot(game, entry.callId);
  const plugins = usePlugins((s) => s.list);
  const reading = useGenexPublishState(game, Boolean(game) && coverCardPublish(plugins, game ?? "", null));
  const clip = reading.state?.cover?.clip ?? null;
  // A cover is the Genex plugin's to make: with it off, nobody in the chat can.
  const genexOn = plugins.some((p) => p.manifest.id === GENEX_PLUGIN_ID && p.enabled);
  // A shot that is gone (another game's chat, a cleared plugin) leaves no card: a caption says nothing.
  if (!game || src === null) return null;
  return (
    <section
      data-genex-cover={entry.callId}
      aria-label={WORDS.coverCard}
      className="build-card flex w-full max-w-[26rem] min-w-0 flex-col gap-2 rounded-card bg-composer p-2"
    >
      {src ? (
        <button
          type="button"
          title={WORDS.coverCardAlt}
          onClick={() => void openShot(game, src)}
          className="asset-tile relative block h-52 w-full min-w-0 cursor-pointer overflow-hidden rounded-[10px] bg-inset"
        >
          <img
            src={src}
            alt={WORDS.coverCardAlt}
            decoding="async"
            draggable={false}
            className="size-full object-cover"
          />
          {clip && (
            <span className="genex-cover-card-clip" data-genex-cover-clip>
              <Icon name="play" size={8} />
              {WORDS.coverCardClip(clip.durationMs)}
            </span>
          )}
        </button>
      ) : (
        <span aria-hidden className="block h-52 w-full rounded-[10px] bg-inset" />
      )}
      <div className="flex min-h-8 min-w-0 items-center gap-3 ps-2">
        <p className="m-0 min-w-0 flex-1 truncate text-chat text-ink">{WORDS.coverCard}</p>
        {genexOn && <CoverAnother project={game} />}
        <CoverPublish project={game} reading={reading} />
      </div>
    </section>
  );
}

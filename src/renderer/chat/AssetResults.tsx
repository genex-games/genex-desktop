import { withoutGenexSources } from "../../shared/genex.ts";
import type { JSX } from "react";
import { memo, useMemo, useState } from "react";
import type { AssetDeliveredPayload, ProjectAsset } from "../../shared/game-assets.ts";
import { assetPreviewMode } from "../../shared/asset-preview.ts";
import { t } from "../../shared/i18n.ts";
import type { ModelRig } from "../../shared/model-rig.ts";
import { assetTitle, clipTitles } from "../asset-names.ts";
import { foldAssets, ownerInGame, useModelRigs } from "../model-rigs.ts";
import { AssetTile } from "../panels/AssetTile.tsx";
import { AssetPreview } from "../panels/AssetPreview.tsx";
import { Icon } from "../ui/icons.tsx";
import { ResultButton } from "../ui/ResultButton.tsx";
import { useAsyncEffect } from "../use-async-effect.ts";
import { AudioStrip } from "./AudioStrip.tsx";
import { hostPlatform } from "../platform.ts";
import { ASSET_WORDS, animationCountWords, fileManagerWords, modelAnimationsWords } from "../words.ts";

/** What the game folder was last seen holding, so a remounted row keeps its height. */
const presence = new Map<string, boolean>();
/** The model each animation file that came alone moves, once looked up in the game, by game and file. */
const clipOwners = new Map<string, ProjectAsset | null>();
/** How many files `presence` remembers before it forgets the oldest. */
const PRESENCE_CAP = 2000;
/** Results shown at first, and added by each "Show more assets". */
const PAGE_SIZE = 6;
const presenceKey = (project: string, file: string) => `${project}\n${file}`;
const VISUAL = new Set(["image", "model", "texture", "video"]);
const isVisual = (asset: ProjectAsset): boolean => VISUAL.has(assetPreviewMode(asset.file));
const isAudio = (asset: ProjectAsset): boolean => assetPreviewMode(asset.file) === "audio";

/** Remember what the folder holds, forgetting the oldest entry past the cap. */
function rememberPresence(project: string, asked: readonly string[], here: ReadonlySet<string>): void {
  for (const file of asked) presence.set(presenceKey(project, file), here.has(file));
  while (presence.size > PRESENCE_CAP) {
    const oldest = presence.keys().next().value;
    if (oldest !== undefined) presence.delete(oldest);
  }
}

/** Each delivered file once, with the delivery it came in. */
function deliveredAssets(deliveries: AssetDeliveredPayload[]): ProjectAsset[] {
  const seen = new Set<string>();
  return deliveries
    .flatMap((delivery) =>
      delivery.files.map((file) => ({
        ...file,
        source: delivery.source,
        mtime: delivery.at,
        jobId: delivery.jobId,
        render: file.kind === "model" ? delivery.render : null,
      })),
    )
    .filter((asset) => !seen.has(asset.file) && Boolean(seen.add(asset.file)));
}

/**
 * The files the game folder holds now, or null until the first answer (unless every file was
 * seen before). Entries are rebuilt as the log grows; the question only changes when the files do.
 */
function usePresentFiles(project: string, files: readonly string[], revision: number): Set<string> | null {
  const filesKey = files.join("\n");
  const known = (): Set<string> | null =>
    files.every((file) => presence.has(presenceKey(project, file)))
      ? new Set(files.filter((file) => presence.get(presenceKey(project, file))))
      : null;
  const [present, setPresent] = useState<Set<string> | null>(known);
  useAsyncEffect(
    (alive) => {
      const asked = filesKey ? filesKey.split("\n") : [];
      if (!project || asked.length === 0) {
        setPresent(new Set());
        return;
      }
      void Promise.resolve()
        .then(() => window.studio.presentProjectAssets({ project, files: asked }))
        .then((found) => {
          const here = new Set(found);
          rememberPresence(project, asked, here);
          if (alive()) setPresent(here);
        })
        .catch(() => {
          if (alive()) setPresent((current) => current ?? new Set());
        });
      return undefined;
    },
    [project, filesKey, revision],
  );
  return present;
}

/** A file opened in the viewer, with the animation files that play on it. */
interface Opened {
  asset: ProjectAsset;
  clips: ProjectAsset[];
}

/**
 * The model an animation file that came without one moves, looked up among everything the game
 * holds: undefined while looking, null when no model fits.
 */
function useClipOwner(project: string, clip: ModelRig | null): ProjectAsset | null | undefined {
  const key = clip ? presenceKey(project, clip.file) : "";
  const [found, setFound] = useState<{ key: string; owner: ProjectAsset | null } | null>(null);
  useAsyncEffect(
    (alive) => {
      if (!clip || clipOwners.has(key)) return;
      void ownerInGame(project, clip).then((owner) => {
        clipOwners.set(key, owner);
        if (alive()) setFound({ key, owner });
      });
      return undefined;
    },
    [project, key],
  );
  if (!clip) return null;
  if (clipOwners.has(key)) return clipOwners.get(key) ?? null;
  return found?.key === key ? found.owner : undefined;
}

/** The trailing action of a row: Open in Assets, shown on hover or focus. */
function OpenInAssets({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-open-assets
      aria-label={ASSET_WORDS.openInAssets}
      title={ASSET_WORDS.openInAssets}
      onClick={onClick}
      className="asset-row-action grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-ink-2 hover:bg-control-hover hover:text-control-text-hover"
    >
      <Icon name="assets" size={16} />
    </button>
  );
}

/** A file with no picture of its own: its name opens the preview; Open in Assets waits at the row's end. */
function AssetRow({
  asset,
  onSelect,
  onOpenAssets,
}: {
  asset: ProjectAsset;
  onSelect: () => void;
  onOpenAssets?: () => void;
}): JSX.Element {
  return (
    <div data-asset-file={asset.file} className="asset-row flex h-11 min-w-0 items-center gap-2 rounded-xl pr-2 pl-3">
      <button
        type="button"
        title={asset.file}
        onClick={onSelect}
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-chat-sub text-ink-2 hover:text-control-text-hover"
      >
        {asset.file.split("/").at(-1)}
      </button>
      {onOpenAssets && <OpenInAssets onClick={onOpenAssets} />}
    </div>
  );
}

/**
 * Animation files that came without their model, as one row: the model's name, the clips' names,
 * and a click that opens the model playing them. With no model in the game, the row only names them.
 */
function AnimationRow({
  clips,
  owner,
  onOpen,
}: {
  clips: ProjectAsset[];
  owner: ProjectAsset | null;
  onOpen: (owner: ProjectAsset) => void;
}): JSX.Element {
  const body = (
    <>
      <span className="asset-row-icon grid size-8 shrink-0 place-items-center rounded-[10px]">
        <Icon name="character" size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-chat-sub text-ink">
          {owner ? modelAnimationsWords(assetTitle(owner.file)) : animationCountWords(clips.length)}
        </span>
        <span className="asset-row-sub truncate text-micro">
          {clipTitles(clips.map((clip) => clip.file)).join(" · ")}
        </span>
      </span>
    </>
  );
  const className = "asset-row flex h-[52px] w-full min-w-0 items-center gap-2.5 rounded-xl pr-2.5 pl-2.5";
  if (!owner)
    return (
      <div data-asset-animations={clips.length} className={className}>
        {body}
      </div>
    );
  return (
    <button
      type="button"
      data-asset-animations={clips.length}
      onClick={() => onOpen(owner)}
      className={`${className} cursor-pointer`}
    >
      {body}
      <Icon name="chevron-right" size={16} className="asset-row-chevron" />
    </button>
  );
}

/**
 * One tile alone keeps a modest width; several share a two-column grid. Tiles keep a fixed height
 * (the picture crops to fit) so narrowing the chat does not change how tall they stand.
 */
function TileGroup({ tiles, render }: { tiles: ProjectAsset[]; render: (asset: ProjectAsset) => JSX.Element }) {
  const [only] = tiles;
  if (tiles.length === 1 && only) return <div className="h-50 max-w-80">{render(only)}</div>;
  if (tiles.length > 1) return <div className="grid auto-rows-[8rem] grid-cols-2 gap-2">{tiles.map(render)}</div>;
  return null;
}

/** What the game folder holds of the delivered files, read once: present files, their rigs, and a lone clip's model. */
function useDelivered(project: string, assets: ProjectAsset[], revision: number) {
  const files = useMemo(() => assets.map((asset) => asset.file), [assets]);
  const present = usePresentFiles(project, files, revision);
  const available = useMemo(
    () => (present ? assets.filter((asset) => present.has(asset.file)) : []),
    [assets, present],
  );
  const rigs = useModelRigs(
    project,
    available.map((asset) => asset.file),
  );
  const folded = useMemo(() => (rigs ? foldAssets(available, rigs) : null), [available, rigs]);
  const looseRig = rigs?.find((rig) => rig.file === folded?.loose[0]) ?? null;
  const owner = useClipOwner(project, looseRig);
  const known = present !== null && folded !== null && owner !== undefined;
  return known ? { available, folded, owner } : null;
}

/**
 * Generated files as results: only what the game folder holds now. A build's files arrive with
 * its result once it lands; a file that is not in the game is never shown as a broken preview.
 * Animation files never get a card of their own: they ride on their model's card, or, when their
 * model came earlier, share one row that opens it.
 */
export const AssetResults = memo(function AssetResults({
  deliveries,
  revision = 0,
  onOpenAssets,
}: {
  deliveries: AssetDeliveredPayload[];
  revision?: number;
  onOpenAssets?: () => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const project = deliveries[0]?.project ?? "";
  const assets = useMemo(() => deliveredAssets(deliveries), [deliveries]);
  const delivered = useDelivered(project, assets, revision);
  if (!delivered) return null;
  const { available, folded, owner } = delivered;
  const shown = withoutGenexSources(available.filter((asset) => !folded.motions.has(asset.file)));
  const loose = available.filter((asset) => folded.loose.includes(asset.file));
  const clipsOf = (asset: ProjectAsset) =>
    available.filter((clip) => folded.clipsOf.get(asset.file)?.includes(clip.file));
  const visual = shown.filter(isVisual);
  const audio = shown.filter(isAudio);
  // Buffers, material and atlas files belong to the media beside them; alone they still get a row.
  const ordered = visual.length || audio.length || loose.length ? [...visual, ...audio] : shown;
  if (ordered.length === 0 && loose.length === 0) return null;
  const page = ordered.slice(0, limit);
  const rows = page.filter((asset) => !isVisual(asset));
  const tile = (asset: ProjectAsset) => (
    <div key={asset.file} className="h-full min-w-0">
      <AssetTile
        project={project}
        asset={asset}
        companions={available.map((item) => item.file)}
        clips={clipsOf(asset).length}
        onOpen={() => setSelected({ asset, clips: clipsOf(asset) })}
        onOpenAssets={onOpenAssets}
      />
    </div>
  );
  return (
    <section data-chat-assets className="w-full max-w-[26rem] min-w-0 space-y-2" aria-label={t("Generated assets")}>
      <TileGroup tiles={page.filter(isVisual)} render={tile} />
      {(loose.length > 0 || rows.length > 0) && (
        <div className="flex flex-col gap-1.5">
          {loose.length > 0 && (
            <AnimationRow clips={loose} owner={owner} onOpen={(model) => setSelected({ asset: model, clips: loose })} />
          )}
          {rows.map((asset) =>
            isAudio(asset) ? (
              <AudioStrip key={asset.file} project={project} asset={asset} onOpenAssets={onOpenAssets} />
            ) : (
              <AssetRow
                key={asset.file}
                asset={asset}
                onSelect={() => setSelected({ asset, clips: [] })}
                onOpenAssets={onOpenAssets}
              />
            ),
          )}
        </div>
      )}
      {ordered.length > limit && (
        <ResultButton onClick={() => setLimit((n) => n + PAGE_SIZE)}>{t("Show more assets")}</ResultButton>
      )}
      {error && (
        <p role="alert" className="text-chat-sub text-ink-3">
          {error}
        </p>
      )}
      {selected && (
        <AssetPreview
          key={selected.asset.file}
          project={project}
          asset={selected.asset}
          assets={assets}
          clips={selected.clips}
          onClose={() => setSelected(null)}
          onReveal={() =>
            void window.studio
              .revealProject(project, selected.asset.file)
              .catch(() => setError(fileManagerWords(hostPlatform()).revealFailed))
          }
        />
      )}
    </section>
  );
});

/** The panel of the run's assets: every job a plugin was asked for, grouped by where it got to, and the modeller's work. */
import type { JSX } from "react";
import type { AssetInfo, BlenderNode, RunGraph as RunGraphModel } from "../../run-graph.ts";
import { runIdOf, truncate } from "../../run-graph.ts";
import { AssetCardState } from "../../run-graph-assets.ts";
import { useStill } from "../../stills.ts";
import { BlenderLogo } from "../../ui/brand.tsx";
import { Icon } from "../../ui/icons.tsx";
import { kilobyteWords } from "../../words.ts";
import { AssetThumbnail } from "../AssetThumbnail.tsx";
import { ASSET_THUMB_PX, blenderRender, firstImage, isMaking, kindWord, trianglesWords } from "./asset-jobs.ts";
import { Details, Panel, Row, Rows, Section } from "./chrome.tsx";
import { joinDots } from "./format.ts";
import { IMAGE_OUTLINE } from "./pictures.tsx";
import { GraphSelection } from "./selection.ts";
import type { InspectorProps } from "./types.ts";

/** A job's thumbnail frame, in pixels. */
const PICTURE_FRAME = { width: 92, height: 58, boxShadow: IMAGE_OUTLINE };
/** How much of a modeller's error the panel prints. */
const BLENDER_ERROR_CHARS = 140;

/** A job's picture once delivered: its Assets-stage thumbnail, a still of it, or its kind in words. */
function DeliveredPicture({ job, project }: { job: AssetInfo; project: string | null }): JSX.Element {
  const picture = !job.preview ? firstImage(job) : null;
  const still = useStill(project && picture ? { project, asset: picture, maxPx: ASSET_THUMB_PX } : null);
  const render = useStill(blenderRender(job));
  const src = render ?? still;
  if (project && job.preview)
    return <AssetThumbnail project={project} asset={job.preview} companions={[]} fallback={null} quiet />;
  if (src) return <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />;
  return <span className="absolute inset-0 grid place-items-center text-micro">{kindWord(job) ?? "File"}</span>;
}

function AssetPicture({
  job,
  project,
  onOpen,
}: {
  job: AssetInfo;
  project: string | null;
  onOpen: (job: AssetInfo) => void;
}): JSX.Element {
  if (job.state === AssetCardState.Failed)
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[6px]"
        style={{ ...PICTURE_FRAME, background: "var(--red-tint)", color: "var(--red)" }}
      >
        <Icon name="info" size={14} />
      </span>
    );
  if (job.state !== AssetCardState.Delivered)
    return <span className="graph-shimmer block shrink-0 rounded-[6px]" style={PICTURE_FRAME} />;
  return (
    <button
      type="button"
      className="relative shrink-0 cursor-pointer overflow-hidden rounded-[6px] bg-inset text-ink-3"
      style={PICTURE_FRAME}
      title={job.name}
      onClick={() => onOpen(job)}
    >
      <DeliveredPicture job={job} project={project} />
    </button>
  );
}

/** Why a job is not in hand: its own failure, or an in-game check that failed to start. */
function JobProblem({ job }: { job: AssetInfo }): JSX.Element | null {
  if (job.state === AssetCardState.Failed && job.error)
    return <span className="line-clamp-3 text-xs text-red">{job.error}</span>;
  if (!job.check || job.check.ok) return null;
  return (
    <span className="line-clamp-3 text-xs text-ink-3">
      Last check couldn’t run: {job.check.error ?? "no reason given"}
    </span>
  );
}

type DerivedStep = NonNullable<AssetInfo["derived"]>[number];

/** A plugin's work on an asset in one line: measured or processed, its size and its triangles. */
function derivedLine(step: DerivedStep): string {
  const plugin = step.pluginName ?? "a plugin";
  const measured = step.size || step.triangles !== null;
  return joinDots([
    measured ? `Measured in ${plugin}` : `Processed in ${plugin}`,
    step.size ? step.size.map((n) => Number(n.toFixed(2))).join(" × ") : null,
    step.triangles !== null ? trianglesWords(step.triangles) : null,
  ]);
}

function JobRow({
  job,
  project,
  partNumber,
  onOpen,
}: {
  job: AssetInfo;
  project: string | null;
  partNumber: (facetId: string | null) => string;
  onOpen: (job: AssetInfo) => void;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <AssetPicture job={job} project={project} onOpen={onOpen} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-body-sm text-ink" title={job.prompt ?? job.name}>
          {job.name}
        </span>
        <span className="truncate text-xs text-ink-3">
          {joinDots([kindWord(job), job.pluginName ?? job.source, partNumber(job.facetId)])}
        </span>
        <JobProblem job={job} />
        {job.derived?.map((step) => (
          <span key={step.at + step.name} className="line-clamp-2 text-xs text-ink-3" title={step.files.join("\n")}>
            {derivedLine(step)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A modelled asset's size and triangles, after its part. */
const modelledLine = (asset: AssetInfo): string => {
  if (!asset.ok) return "";
  const triangles = asset.triangles !== null ? ` · ${trianglesWords(asset.triangles)}` : "";
  return ` · ${kilobyteWords(asset.bytes)}${triangles}`;
};

function BlenderSection({
  blender,
  project,
  partNumber,
  onOpen,
}: {
  blender: BlenderNode | null;
  project: string | null;
  partNumber: (facetId: string | null) => string;
  onOpen: (asset: AssetInfo) => void;
}): JSX.Element | null {
  if (!blender) return null;
  const modelled = blender.assets;
  return (
    <Section
      label={`Modelled in Blender${blender.version ? ` ${blender.version}` : ""} · ${modelled.length}`}
      gap="gap-2"
    >
      <span className="flex items-center gap-2 text-body-sm text-ink-3">
        <BlenderLogo height={12} />
        Every part can reach for it when a shape needs real modelling.
      </span>
      {modelled.map((asset) => (
        <div key={asset.name + asset.at} className="flex items-start gap-3">
          <AssetPicture job={asset} project={project} onOpen={onOpen} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-mono text-xs text-ink">{asset.name}</span>
            <span className="text-xs text-ink-3">
              {partNumber(asset.facetId)}
              {modelledLine(asset)}
            </span>
            {asset.error ? (
              <span className="text-xs text-orange">{truncate(asset.error, BLENDER_ERROR_CHARS)}</span>
            ) : null}
          </div>
        </div>
      ))}
    </Section>
  );
}

/** The jobs grouped by where they got to, in the order the panel lists them. */
function jobGroups(jobs: AssetInfo[]): Array<[string, AssetInfo[]]> {
  const made = jobs.filter((job) => job.state === AssetCardState.Delivered);
  return [
    ["Failed", jobs.filter((job) => job.state === AssetCardState.Failed)],
    ["Making", jobs.filter(isMaking)],
    ["Not in your game yet", made.filter((job) => job.inGame === false)],
    ["In your game", made.filter((job) => job.inGame)],
    ["Delivered", made.filter((job) => job.inGame === undefined)],
  ];
}

/** The panel's subtitle: how much was made, and which plugins made it. */
function assetsSub(jobs: AssetInfo[], modelled: AssetInfo[]): string {
  const made =
    jobs.filter((job) => job.state === AssetCardState.Delivered).length + modelled.filter((item) => item.ok).length;
  const plugins = [...new Set(jobs.map((job) => job.pluginName ?? job.source))];
  return [made ? `${made} made for this build` : "Nothing made yet", ...plugins].join(" · ");
}

function AssetDetails({
  graph,
  jobs,
  modelled,
}: {
  graph: RunGraphModel;
  jobs: AssetInfo[];
  modelled: AssetInfo[];
}): JSX.Element {
  const files = [
    ...jobs.flatMap((job) => [...job.files, ...(job.derived ?? []).flatMap((step) => step.files)]),
    ...modelled.map((asset) => asset.file ?? ""),
  ];
  return (
    <Row label="Technical details">
      <Details
        rows={[
          ["run", runIdOf(graph)],
          ["files", joinDots(files) || null],
          ["jobs", joinDots(jobs.map((job) => job.jobId)) || null],
        ]}
      />
    </Row>
  );
}

/** The lightbox of the modeller's renders: both views of every asset it made. */
function blenderViews(modelled: AssetInfo[]): Array<{ item: AssetInfo; path: string }> {
  return modelled.flatMap((item) => {
    if (!item.ok || !item.render) return [];
    return [{ item, path: item.render }, ...(item.renderFront ? [{ item, path: item.renderFront }] : [])];
  });
}

/** The panel of what the run made. */
export function AssetsPanel(props: InspectorProps): JSX.Element {
  const { graph, blender, assets, project } = props;
  const partNumber = (facetId: string | null): string =>
    facetId ? `Part ${graph.facets.findIndex((facet) => facet.facetId === facetId) + 1}` : "Chat";
  const jobs = assets?.jobs ?? [];
  const modelled = blender?.assets ?? [];
  const openBlender = (asset: AssetInfo): void => {
    const views = blenderViews(modelled);
    if (!views.length) return;
    const items = views.map(({ item, path }) => ({
      path,
      src: null,
      title: `Modelled in Blender: ${item.name}`,
      caption: `${partNumber(item.facetId)}${item.triangles !== null ? ` · ${trianglesWords(item.triangles)}` : ""}`,
    }));
    props.onLight(
      items,
      Math.max(
        0,
        views.findIndex((view) => view.item === asset),
      ),
    );
  };
  return (
    <Panel
      id={GraphSelection.Assets}
      label="Assets"
      title="Assets"
      sub={assetsSub(jobs, modelled)}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
    >
      {jobGroups(jobs)
        .filter(([, list]) => list.length)
        .map(([label, list]) => (
          <Section key={label} label={`${label} · ${list.length}`} gap="gap-2">
            {list.map((job) => (
              <JobRow
                key={job.callId ?? job.jobId ?? job.at}
                job={job}
                project={project}
                partNumber={partNumber}
                onOpen={props.onOpenJob}
              />
            ))}
          </Section>
        ))}
      <BlenderSection blender={blender} project={project} partNumber={partNumber} onOpen={openBlender} />
      <Rows>
        <AssetDetails graph={graph} jobs={jobs} modelled={modelled} />
      </Rows>
    </Panel>
  );
}

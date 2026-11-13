/**
 * The card of one build whose check did not pass: what its health check found, the screenshot it
 * kept, and what made the build (a worker's merge, or the main agent's own changes).
 */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { type BuildCard, BuildOutcome } from "../../run-graph-builds.ts";
import { Tone } from "../../run-steps.ts";
import { useStill } from "../../stills.ts";
import { BUILD_LINE_WORDS } from "../../words.ts";
import { Details, Panel, PanelRow, Para, Row, Rows, Section } from "./chrome.tsx";
import { Single } from "./pictures.tsx";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** The largest side, in pixels, the card's screenshot is read at. */
const CARD_PICTURE_PX = 640;

/** Each check outcome's ink: green for a pass, orange for a blank screen, red for errors or a failure. */
const OUTCOME_TONE: Record<BuildOutcome, Tone> = {
  [BuildOutcome.Passed]: Tone.Green,
  [BuildOutcome.Blank]: Tone.Orange,
  [BuildOutcome.Errors]: Tone.Red,
  [BuildOutcome.Failed]: Tone.Red,
};

/** What made the build: the merged worker by its title, or the main agent's own changes. */
function madeBy(props: InspectorProps, build: BuildCard): string {
  const worker = build.worker ? props.graph.facets.find((facet) => facet.facetId === build.worker) : undefined;
  return worker ? BUILD_LINE_WORDS.merged(worker.title) : BUILD_LINE_WORDS.leadsOwn;
}

/** The card of one build of the line. */
export function BuildPanel(props: InspectorProps & { build: BuildCard }): JSX.Element {
  const { build } = props;
  const src = useStill(build.picture ? { run: build.picture, maxPx: CARD_PICTURE_PX } : null);
  const name = BUILD_LINE_WORDS.name(build.n);
  const open = (): void => {
    if (build.picture)
      props.onLight([{ path: build.picture, src: null, title: name, caption: madeBy(props, build) }], 0);
  };
  return (
    <Panel
      id={build.id}
      label={t("Build")}
      title={name}
      sub={madeBy(props, build)}
      status={<Status tone={OUTCOME_TONE[build.outcome]}>{BUILD_LINE_WORDS.outcome[build.outcome]}</Status>}
      onClose={props.onClose}
      reply={{ label: name, placeholder: t("Ask for a change to this build") }}
      onReply={props.onReply}
      media={<Single src={src} label={name} onOpen={open} />}
    >
      {build.findings.length ? (
        <Section label={BUILD_LINE_WORDS.problems}>
          {[...new Set(build.findings)].map((finding) => (
            <Para key={finding}>{BUILD_LINE_WORDS.finding[finding]}</Para>
          ))}
        </Section>
      ) : null}
      <Rows>
        <Row row={PanelRow.TechnicalDetails} label={t("Technical details")}>
          <Details
            rows={[
              [t("commit"), build.head],
              [BUILD_LINE_WORDS.found, build.problems.join(" | ") || null],
            ]}
          />
        </Row>
      </Rows>
    </Panel>
  );
}

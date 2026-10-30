/**
 * The card of one build on a Loop's line: what its health check found, the screenshot it kept, and
 * what made the build (a worker's merge, or the main agent's own changes). Its picture is compared
 * with the build's before it only when both are health-check screenshots and their pixels visibly
 * differ; otherwise the card shows it alone and says so.
 */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { type BuildCard, buildBefore } from "../../run-graph-builds.ts";
import { BUILD_LINE_WORDS } from "../../words.ts";
import { OUTCOME_LOOK } from "../run-graph/nodes.tsx";
import { Details, Panel, PanelRow, Para, Row, Rows, Section } from "./chrome.tsx";
import { PictureChange } from "./pictures.tsx";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** What made the build: the merged worker by its title, or the main agent's own changes. */
function madeBy(props: InspectorProps, build: BuildCard): string {
  const worker = build.worker ? props.graph.facets.find((facet) => facet.facetId === build.worker) : undefined;
  return worker ? BUILD_LINE_WORDS.merged(worker.title) : BUILD_LINE_WORDS.leadsOwn;
}

/** The card of one build of the line. */
export function BuildPanel(props: InspectorProps & { build: BuildCard }): JSX.Element {
  const { build } = props;
  const builds = props.timeline?.builds ?? [];
  const before = buildBefore(builds, build);
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
      status={<Status tone={OUTCOME_LOOK[build.outcome].tone}>{BUILD_LINE_WORDS.outcome[build.outcome]}</Status>}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={{ label: name, placeholder: t("Ask for a change to this build") }}
      onReply={props.onReply}
      media={
        <PictureChange
          before={before?.picture ?? null}
          now={build.picture}
          beforeLabel={before ? BUILD_LINE_WORDS.before(before.n) : ""}
          nowLabel={name}
          unchanged={before ? BUILD_LINE_WORDS.unchanged(before.n) : ""}
          onOpen={open}
        />
      }
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

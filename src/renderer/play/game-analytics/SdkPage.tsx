/**
 * SDK: what Genex counts in every game with no code, how the game sends its own events, the names
 * that fill in reports, the events arriving now, the ones genex.games dropped and the rules events
 * are held to. The shell mounts it only with a status to draw (`report-props.ts` says what it is
 * given); `sdk-view.ts` works out what each block says and `sdk-live.tsx` draws the two that follow
 * the game as it runs.
 */
import type { JSX } from "react";
import type { AnalyticsGame, EventLimits } from "../../../shared/game-analytics.ts";
import { ReportColumns, ReportSection, TermList } from "./kit/index.ts";
import { CopyButton } from "./links-copy.tsx";
import type { SdkPageProps } from "./report-props.ts";
import { DroppedEvents, LiveEvents } from "./sdk-live.tsx";
import { autoRows, knownGroups, ruleLines, sdkSample } from "./sdk-view.ts";
import { SDK_WORDS as WORDS } from "./sdk-words.ts";

/** The events Genex counts in every game, each with what it counts. */
function CountedForYou(): JSX.Element {
  return (
    <ReportSection id="counted" title={WORDS.counted.title} hint={WORDS.counted.hint}>
      <TermList mono items={autoRows().map((row) => ({ id: row.id, term: row.id, detail: row.detail }))} />
    </ReportSection>
  );
}

/** How a game sends its own events: why, whether this game's build can yet, and the code to copy. */
function SendYourOwn({ game }: { game: AnalyticsGame }): JSX.Element {
  const sample = sdkSample();
  return (
    <ReportSection id="own" title={WORDS.own.title} hint={WORDS.own.hint}>
      {!game.eventsReady && (
        <p className="game-analytics-sdk-notice" data-game-analytics-sdk-not-ready>
          {WORDS.own.notReady}
        </p>
      )}
      <div className="game-analytics-sdk-sample">
        <div className="game-analytics-sdk-sample-bar">
          <span className="game-analytics-sdk-sample-label">{WORDS.own.sampleLabel}</span>
          <CopyButton id="sample" text={sample} label={WORDS.own.copy} />
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the sample scrolls sideways, and a keyboard has to reach it */}
        <section className="game-analytics-sdk-code" tabIndex={0} aria-label={WORDS.own.sampleLabel}>
          <pre>
            <code>{sample}</code>
          </pre>
        </section>
      </div>
    </ReportSection>
  );
}

/** The names that also draw a report, grouped as they work together, each over the report it fills. */
function KnownNames(): JSX.Element {
  return (
    <ReportSection id="known" title={WORDS.known.title} hint={WORDS.known.hint}>
      <dl className="game-analytics-sdk-known">
        {knownGroups().map((group) => (
          <div key={group.id} className="game-analytics-sdk-known-group" data-game-analytics-known={group.id}>
            <dt>
              {group.names.map((name) => (
                <span key={name} className="game-analytics-sdk-name">
                  {name}
                </span>
              ))}
              {group.withProperty && <span className="game-analytics-sdk-with">{group.withProperty}</span>}
            </dt>
            <dd>{group.detail}</dd>
          </div>
        ))}
      </dl>
    </ReportSection>
  );
}

/** What an event is held to, from the limits genex.games sent. */
function Rules({ limits, used }: { limits: EventLimits; used: number }): JSX.Element {
  const items = ruleLines(limits, used).map((rule) => ({
    id: rule.id,
    term: rule.term,
    detail: rule.details.join(" "),
  }));
  return (
    <ReportSection id="rules" title={WORDS.rules.title}>
      <TermList items={items} />
    </ReportSection>
  );
}

/** The SDK tab's body: two columns, what to send on the left and what arrives on the right. */
export function SdkPage({ game, status, origin, now, onOrigin }: SdkPageProps): JSX.Element {
  return (
    <div className="game-analytics-report" data-game-analytics-sdk>
      <ReportColumns>
        <div className="game-analytics-sdk-column">
          <CountedForYou />
          <SendYourOwn game={game} />
          <KnownNames />
        </div>
        <div className="game-analytics-sdk-column">
          <LiveEvents status={status} origin={origin} now={now} onOrigin={onOrigin} />
          <DroppedEvents status={status} now={now} />
          <Rules limits={status.limits} used={status.names} />
        </div>
      </ReportColumns>
    </div>
  );
}

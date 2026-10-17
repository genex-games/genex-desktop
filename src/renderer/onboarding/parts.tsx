/**
 * The pieces every first-launch screen after the welcome shares: the Back/Skip bar, the heading
 * that takes focus, a button box that hugs its words, the check of a connected status, a metered
 * provider's mark, and Start building at the foot.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { ArtCanvas, type Draw } from "./ArtCanvas.tsx";
import { drawMeteredMark, MARKS, MarkState, type MeteredMark } from "./art.ts";

/**
 * The welcome's buttons that move it on, as `data-onboarding-action` names them: the stable hooks
 * an operator presses through dev control (words and classes may change; these do not).
 */
export const OnboardingAction = {
  Next: "next",
  Start: "start",
  Skip: "skip",
  /** Leave the welcome for Settings to connect a model server the person already runs. */
  Server: "server",
} as const;

/** A width that follows its content, so a button's box glides to hug each new label. */
export function Hug({ swap, children }: { swap: string; children: ReactNode }): JSX.Element {
  const inner = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new label re-keys the inner box, so the observer must follow it
  useLayoutEffect(() => {
    const element = inner.current;
    if (!element) return;
    const measure = () => setWidth(element.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [swap]);
  return (
    <div className="onboarding-hug" style={width === null ? undefined : { width }}>
      <div ref={inner} key={swap} className="onboarding-hug-inner">
        {children}
      </div>
    </div>
  );
}

/** The green check of a connected status; it draws itself once. */
export function Check(): JSX.Element {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="onboarding-check">
      <circle cx="8" cy="8" r="8" />
      <path pathLength={1} d="M4.6 8.2l2.3 2.2 4.5-4.6" />
    </svg>
  );
}

/** Back, and Skip for now until something is connected. */
export function TopBar({ onBack, onSkip }: { onBack: () => void; onSkip?: () => void }): JSX.Element {
  return (
    <div className="onboarding-bar">
      <Button variant="ghost" onClick={onBack}>
        <Icon name="chevron-left" />
        Back
      </Button>
      {onSkip && (
        <Button
          variant="ghost"
          className="onboarding-swap"
          data-onboarding-action={OnboardingAction.Skip}
          onClick={onSkip}
        >
          Skip for now
        </Button>
      )}
    </div>
  );
}

/** The screen's heading, focused as the screen opens so a screen reader starts there. */
export function useHeadingFocus(): RefObject<HTMLHeadingElement | null> {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return heading;
}

/** The foot of a screen: Start building, once anything is connected. */
export function StartBuilding({ anyOn, onStart }: { anyOn: boolean; onStart: () => void }): JSX.Element {
  return (
    <div className="onboarding-foot">
      {anyOn && (
        <Button
          variant="default"
          size="lg"
          className="onboarding-cta onboarding-rise"
          data-onboarding-action={OnboardingAction.Start}
          onClick={onStart}
        >
          Start building
        </Button>
      )}
    </div>
  );
}

/** A metered provider's mark alone over its screen's actions; it pops when it connects during this visit. */
export function MeteredMarkArt({ id, state }: { id: MeteredMark; state: MarkState }): JSX.Element {
  const now = useRef(state);
  now.current = state;
  const born = useRef(performance.now());
  const litAt = useRef(-1);
  const seen = useRef<MarkState | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = state;
    // Only a mark seen unlit on this screen pops as it lights; one lit on arrival stays still.
    const wasUnlit = before !== null && before !== MarkState.On;
    if (wasUnlit && state === MarkState.On) litAt.current = performance.now();
  }, [state]);
  const draw = useCallback<Draw>(
    (ctx, palette, time) => {
      const age = time === null || litAt.current < 0 ? -1 : (time - litAt.current) / SECOND_MS;
      drawMeteredMark(ctx, id, now.current, time === null ? 0 : (time - born.current) / SECOND_MS, age, palette);
    },
    [id],
  );
  return <ArtCanvas width={MARKS.width} height={MARKS.height} draw={draw} still={state} className="onboarding-mark" />;
}

/**
 * Builders for AA+ release-gate tests: a small prompt and an evidence bundle that passes every
 * floor, so a test changes one fact and watches one check move.
 */
import {
  AAA_EVIDENCE_SCHEMA,
  type AaaCapture,
  type AaaEvidence,
  FactSource,
  type PoseTick,
  PropOrigin,
} from "../../scripts/evals/aaa/evidence.ts";
import { type AaaPrompt, parseAaaSuite } from "../../scripts/evals/aaa/suite.ts";

/** Raw suite prompt JSON with two views, one motion and one doorway demo. */
export function rawPrompt(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    label: `Prompt ${id}`,
    origin: "test",
    brief: `A test brief for ${id}, written the way a person would type it.`,
    look: "bright",
    views: [
      { role: "interior-hero", setting: "interior", describe: "A room at eye height" },
      { role: "exterior-hero", setting: "exterior", describe: "A yard at eye height" },
    ],
    motion: [{ demo: "sprint", describe: "A sprint" }],
    transitions: [{ demo: "doorway", describe: "Through a door" }],
    references: [{ source: "polyhaven", asset: "snowy_park_01", matches: "exterior-hero", yawDeg: [0] }],
    ...overrides,
  };
}

/** A parsed suite of three test prompts. */
export function testSuite(...prompts: Record<string, unknown>[]): AaaPrompt[] {
  const list = prompts.length ? prompts : [rawPrompt("alpha"), rawPrompt("beta"), rawPrompt("gamma")];
  return parseAaaSuite({ schema: "genex-aaa-suite/1", prompts: list });
}

/** A sine track: camera height bob and roll at the given amplitudes and frequencies, 60 ticks a second. */
export function sineTrack(options: {
  bobP2pM: number;
  bobHz: number;
  rollAmpDeg: number;
  rollHz: number;
  seconds?: number;
  tickHz?: number;
}): PoseTick[] {
  const ticks: PoseTick[] = [];
  const tickHz = options.tickHz ?? 60;
  const count = Math.round((options.seconds ?? 3) * tickHz);
  for (let i = 0; i < count; i++) {
    const t = i / tickHz;
    ticks.push({
      tMs: t * 1000,
      y: 1.7 + (options.bobP2pM / 2) * Math.sin(2 * Math.PI * options.bobHz * t),
      rollDeg: options.rollAmpDeg * Math.sin(2 * Math.PI * options.rollHz * t),
      pitchDeg: 0,
    });
  }
  return ticks;
}

/** An exposure ramp from `from` to `to` EV over `rampMs`, sampled every 50 ms for 3 s. */
export function evRamp(from: number, to: number, rampMs: number): Array<{ tMs: number; ev: number }> {
  const out: Array<{ tMs: number; ev: number }> = [];
  for (let tMs = 0; tMs <= 3000; tMs += 50) {
    const k = Math.min(1, Math.max(0, (tMs - 500) / rampMs));
    out.push({ tMs, ev: from + (to - from) * k });
  }
  return out;
}

function capture(role: string, camera: string, meanLuma: number): AaaCapture {
  return {
    role,
    camera,
    image: null,
    width: 3840,
    height: 2160,
    clean: true,
    native: true,
    meanLuma,
    darkFraction: 0.05,
    source: FactSource.Probe,
  };
}

/** Evidence for a two-view prompt that passes every floor up to AAA-ish, taste aside. */
export function passingEvidence(prompt: AaaPrompt): AaaEvidence {
  return {
    schema: AAA_EVIDENCE_SCHEMA,
    promptId: prompt.id,
    promptVersion: prompt.version,
    subject: { game: "test-game", head: "abc", runId: "run_test", preset: "desktop-ultra", destination: "native" },
    captures: [capture("interior-hero", "classroom", 110), capture("exterior-hero", "yard", 120)],
    surfaces: [
      { tag: "wall", nearestM: 2, texelDensityPxPerM: 1200, hasNormal: true, hasOrm: true, source: FactSource.Engine },
      { tag: "floor", nearestM: 1, texelDensityPxPerM: 1100, hasNormal: true, hasOrm: true, source: FactSource.Engine },
    ],
    props: [
      { tag: "bench", nearestM: 2, origin: PropOrigin.Cc0, organic: false, hasCards: null, source: FactSource.Engine },
      {
        tag: "birch",
        nearestM: 4,
        origin: PropOrigin.Generator,
        organic: true,
        hasCards: true,
        source: FactSource.Engine,
      },
    ],
    flatCoverage: { value: 0.005, source: FactSource.Engine },
    motion: [
      {
        demo: "sprint",
        reducedMotion: false,
        source: FactSource.Engine,
        ticks: sineTrack({ bobP2pM: 0.02, bobHz: 2, rollAmpDeg: 0.8, rollHz: 1 }),
      },
      {
        demo: "sprint",
        reducedMotion: true,
        source: FactSource.Engine,
        ticks: sineTrack({ bobP2pM: 0.001, bobHz: 2, rollAmpDeg: 0.04, rollHz: 1 }),
      },
    ],
    exposure: [{ demo: "doorway", source: FactSource.Engine, ticks: evRamp(12, 8, 2000) }],
  };
}

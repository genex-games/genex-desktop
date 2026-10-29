/**
 * The time-domain measurements behind the comfort and doorway floors: pure functions over a demo's
 * per-tick track. Spectra use a direct Fourier sum at each tick's own time, so slightly uneven tick
 * spacing needs no resampling. A track too short or too coarse to measure a quantity answers null
 * for it, never zero.
 */
import type { ExposureTrack, PoseTick } from "./evidence.ts";

/** The lowest frequency a spectrum looks at: slower drift is a walk's path, not bob. */
export const SPECTRUM_MIN_HZ = 0.5;
/** The spectrum's step. */
export const SPECTRUM_STEP_HZ = 0.25;
/** Above this, camera motion is shake rather than gait (WP-3). */
export const HIGH_FREQUENCY_HZ = 6;
/** The window the doorway floor measures exposure change over. */
export const EV_WINDOW_MS = 500;
/** The leading share of a transition track taken as its starting exposure. */
const EV_START_SHARE = 0.1;
/** The trailing share of a transition track taken as its settled exposure. */
const EV_SETTLED_SHARE = 0.2;

/** What a motion track measures. */
export interface ComfortMetrics {
  /** Peak-to-peak camera height after removing the path's slope, in metres. */
  bobPeakToPeakM: number;
  /** The strongest bob frequency, or null when the track cannot resolve one. */
  dominantBobHz: number | null;
  /** Half the peak-to-peak roll about its mean, in degrees. */
  rollAmplitudeDeg: number;
  /** The largest absolute roll, lean included. */
  maxAbsRollDeg: number;
  /** Share of roll and pitch power above `HIGH_FREQUENCY_HZ`, or null when ticks are too coarse. */
  highFrequencyShare: number | null;
  /** RMS angular velocity of roll and pitch, in degrees per second. */
  angularVelocityRmsDegS: number;
}

/** What a transition track measures. */
export interface ExposureMetrics {
  /** The largest metered EV change inside any `EV_WINDOW_MS` window. */
  maxEvStepPerWindow: number;
  /** How far the exposure went past where it settled, in EV. */
  overshootEv: number;
}

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const span = (values: readonly number[]) => Math.max(...values) - Math.min(...values);

/** The values with their least-squares line over time removed. */
export function detrend(times: readonly number[], values: readonly number[]): number[] {
  const tMean = mean(times);
  const vMean = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < times.length; i++) {
    const dt = (times[i] ?? 0) - tMean;
    num += dt * ((values[i] ?? 0) - vMean);
    den += dt * dt;
  }
  const slope = den > 0 ? num / den : 0;
  return values.map((v, i) => v - vMean - slope * ((times[i] ?? 0) - tMean));
}

/** The power of a zero-mean signal at each frequency, by a direct Fourier sum at the sample times. */
export function powerSpectrum(timesS: readonly number[], values: readonly number[], frequencies: readonly number[]) {
  return frequencies.map((hz) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < timesS.length; i++) {
      const phase = 2 * Math.PI * hz * (timesS[i] ?? 0);
      re += (values[i] ?? 0) * Math.cos(phase);
      im -= (values[i] ?? 0) * Math.sin(phase);
    }
    return (re * re + im * im) / timesS.length;
  });
}

/** Frequencies from `SPECTRUM_MIN_HZ` to the track's Nyquist limit, or none when it is too short. */
function spectrumFrequencies(timesS: readonly number[]): number[] {
  const steps = timesS.slice(1).map((t, i) => t - (timesS[i] ?? 0));
  const sorted = [...steps].sort((a, b) => a - b);
  const medianStep = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const duration = (timesS.at(-1) ?? 0) - (timesS[0] ?? 0);
  if (medianStep <= 0 || duration * SPECTRUM_MIN_HZ < 1) return [];
  const nyquist = 0.5 / medianStep;
  const out: number[] = [];
  for (let hz = SPECTRUM_MIN_HZ; hz <= nyquist + 1e-9; hz += SPECTRUM_STEP_HZ) out.push(hz);
  return out;
}

function dominantFrequency(frequencies: readonly number[], power: readonly number[]): number | null {
  if (!frequencies.length) return null;
  let best = 0;
  for (let i = 1; i < power.length; i++) if ((power[i] ?? 0) > (power[best] ?? 0)) best = i;
  return (power[best] ?? 0) > 0 ? (frequencies[best] ?? null) : null;
}

function highShare(frequencies: readonly number[], spectra: ReadonlyArray<readonly number[]>): number | null {
  if (!frequencies.some((hz) => hz > HIGH_FREQUENCY_HZ)) return null;
  let high = 0;
  let total = 0;
  for (const power of spectra)
    for (let i = 0; i < frequencies.length; i++) {
      total += power[i] ?? 0;
      if ((frequencies[i] ?? 0) > HIGH_FREQUENCY_HZ) high += power[i] ?? 0;
    }
  return total > 0 ? high / total : 0;
}

function angularVelocityRms(ticks: readonly PoseTick[]): number {
  let sum = 0;
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1] as PoseTick;
    const b = ticks[i] as PoseTick;
    const dt = (b.tMs - a.tMs) / 1000;
    sum += ((b.rollDeg - a.rollDeg) / dt) ** 2 + ((b.pitchDeg - a.pitchDeg) / dt) ** 2;
  }
  return Math.sqrt(sum / (ticks.length - 1));
}

/** Measure one motion track. */
export function comfortMetrics(ticks: readonly PoseTick[]): ComfortMetrics {
  const timesS = ticks.map((tick) => tick.tMs / 1000);
  const bob = detrend(
    timesS,
    ticks.map((tick) => tick.y),
  );
  const rolls = ticks.map((tick) => tick.rollDeg);
  const rollMean = mean(rolls);
  const roll = rolls.map((r) => r - rollMean);
  const pitch = detrend(
    timesS,
    ticks.map((tick) => tick.pitchDeg),
  );
  const frequencies = spectrumFrequencies(timesS);
  return {
    bobPeakToPeakM: span(bob),
    dominantBobHz: dominantFrequency(frequencies, powerSpectrum(timesS, bob, frequencies)),
    rollAmplitudeDeg: span(roll) / 2,
    maxAbsRollDeg: Math.max(...rolls.map(Math.abs)),
    highFrequencyShare: highShare(frequencies, [
      powerSpectrum(timesS, roll, frequencies),
      powerSpectrum(timesS, pitch, frequencies),
    ]),
    angularVelocityRmsDegS: angularVelocityRms(ticks),
  };
}

/** Measure one doorway transition: the steepest change in any window, and the overshoot past settling. */
export function exposureMetrics(track: Pick<ExposureTrack, "ticks">): ExposureMetrics {
  const { ticks } = track;
  let maxStep = 0;
  for (let i = 0; i < ticks.length; i++)
    for (let j = i + 1; j < ticks.length && (ticks[j]?.tMs ?? 0) - (ticks[i]?.tMs ?? 0) <= EV_WINDOW_MS; j++)
      maxStep = Math.max(maxStep, Math.abs((ticks[j]?.ev ?? 0) - (ticks[i]?.ev ?? 0)));
  const evs = ticks.map((tick) => tick.ev);
  const head = evs.slice(0, Math.max(1, Math.round(evs.length * EV_START_SHARE)));
  const tail = evs.slice(-Math.max(1, Math.round(evs.length * EV_SETTLED_SHARE)));
  const start = mean(head);
  const settled = mean(tail);
  const rising = settled >= start;
  const overshoot = rising ? Math.max(...evs) - settled : settled - Math.min(...evs);
  return { maxEvStepPerWindow: maxStep, overshootEv: Math.max(0, overshoot) };
}

/**
 * The AA+ evidence bundle (`genex-aaa-evidence/1`): everything the rubric grades one prompt's run on,
 * in one `evidence.json` beside its capture images. Every fact carries its source. A fact from a
 * probe or the engine can pass or fail a floor; a `reconstructed` fact (read from code or a review
 * by hand) can only fail one, so a bundle assembled by hand never certifies a grade. A section that
 * was not measured is null or empty, never zero.
 */
import fs from "node:fs";
import path from "node:path";

/** The schema tag an evidence bundle carries. */
export const AAA_EVIDENCE_SCHEMA = "genex-aaa-evidence/1";
/** The bundle's file name inside its folder. */
export const EVIDENCE_FILE = "evidence.json";

/** Where a fact came from. */
export const FactSource = {
  /** Measured from a capture or a probe of the running build. */
  Probe: "probe",
  /** Reported by the engine (`state().__render.look`, a demo's per-tick log). */
  Engine: "engine",
  /** Read from code, assets or a review by a person or agent; can fail a floor, never pass one. */
  Reconstructed: "reconstructed",
} as const;
export type FactSource = (typeof FactSource)[keyof typeof FactSource];

/** Where a prop's mesh came from (the provenance audit's vocabulary). */
export const PropOrigin = {
  /** Built from primitive boxes, cones or cylinders in code or a bpy script. */
  Primitive: "primitive",
  /** A bevelled modular kit piece textured with scans. */
  Kit: "kit",
  Cc0: "cc0",
  /** A text- or image-to-3D model (Tripo, Meshy, Genex). */
  Generated: "generated",
  /** A procedural generator with real detail (vegetation, rocks). */
  Generator: "generator",
  Unknown: "unknown",
} as const;
export type PropOrigin = (typeof PropOrigin)[keyof typeof PropOrigin];

/** One still of one view. */
export interface AaaCapture {
  /** The suite view role this camera stands for, or null when no role was mapped. */
  role: string | null;
  camera: string;
  /** The image, relative to the bundle folder; null when only its statistics were kept. */
  image: string | null;
  width: number;
  height: number;
  /** Taken with stylised post (lens, grain, overlays) off. Null when unknown. */
  clean: boolean | null;
  /** Rendered at the capture's size with no upscale. Null when unknown. */
  native: boolean | null;
  /** Share of the frame height the subject fills; a close-up needs one. Null when unknown. */
  subjectFraction: number | null;
  meanLuma: number;
  /** Fraction of pixels in the darkest of 32 luma bins (luma below 8). */
  darkFraction: number;
  source: FactSource;
  /** Where a reconstructed or copied fact was read from. */
  cite?: string;
}

/** One surface the player sees within 10 m, as the look facts report it. */
export interface AaaSurface {
  tag: string;
  nearestM: number;
  texelDensityPxPerM: number | null;
  hasNormal: boolean | null;
  hasOrm: boolean | null;
  source: FactSource;
  cite?: string;
}

/** One prop, as the provenance audit reports it. */
export interface AaaProp {
  tag: string;
  nearestM: number;
  origin: PropOrigin;
  organic: boolean;
  /** For organic props: alpha cards or twig instances present. Null when unknown. */
  hasCards: boolean | null;
  source: FactSource;
  cite?: string;
}

/** A screen-wide measurement with its source. */
export interface AaaMeasure {
  value: number;
  source: FactSource;
  cite?: string;
}

/** One camera pose per tick, from a motion demo. */
export interface PoseTick {
  tMs: number;
  /** Camera height in metres. */
  y: number;
  rollDeg: number;
  pitchDeg: number;
}

/** A motion demo's per-tick camera track. */
export interface MotionTrack {
  demo: string;
  reducedMotion: boolean;
  source: FactSource;
  ticks: PoseTick[];
  cite?: string;
}

/** A transition demo's per-tick metered exposure. */
export interface ExposureTrack {
  demo: string;
  source: FactSource;
  ticks: Array<{ tMs: number; ev: number }>;
  cite?: string;
}

/** One animation clip of one character, as a close-up capture and a pose validation name it. */
export interface AaaClipRef {
  character: string;
  clip: string;
}

/** Every animated character clip the game plays; an empty list means the game has none. */
export interface AaaCharacters {
  clips: AaaClipRef[];
  source: FactSource;
  cite?: string;
}

/** The pose validation of one clip (Track A's per-clip check), measured against the rest pose. */
export interface AaaClipPose extends AaaClipRef {
  /** Worst bone-length change over the clip, as a fraction of the rest length. */
  limbLengthDrift: number | null;
  /** Shortest torso length over the clip, as a fraction of the rest length. */
  torsoLengthRatio: number | null;
  /** Worst share of the body's volume inside itself over the clip. */
  selfIntersection: number | null;
  feetGrounded: boolean | null;
  source: FactSource;
  cite?: string;
}

/** The level plan against the built level (the reachability check's numbers). */
export interface AaaPlace {
  zones: number;
  /** Zones the level plan named; null when the run made no plan. */
  plannedZones: number | null;
  reachableZones: number;
  exits: number;
  plannedExits: number | null;
  unplannedDeadEnds: number;
  source: FactSource;
  cite?: string;
}

/** The quality preset's look features against the ones the engine reports on. */
export interface AaaLookFeatures {
  preset: string;
  /** Features the preset owns. */
  expected: string[];
  /** Features the engine reports on in the graded build. */
  active: string[];
  source: FactSource;
  cite?: string;
}

/** The dev store the graded run used. */
export interface AaaStore {
  /** The integration head the store was built from. */
  head: string;
  source: FactSource;
  cite?: string;
}

/** What was graded: the game, its head, the preset and where it ran. */
export interface AaaSubject {
  game: string;
  head: string | null;
  runId: string | null;
  preset: string | null;
  destination: string | null;
}

/** One prompt run's evidence. */
export interface AaaEvidence {
  schema: typeof AAA_EVIDENCE_SCHEMA;
  promptId: string;
  /** The suite version of the prompt the run was given; null when the run predates the suite. */
  promptVersion: string | null;
  subject: AaaSubject;
  captures: AaaCapture[];
  surfaces: AaaSurface[] | null;
  props: AaaProp[] | null;
  /** Share of the screen drawn with flat (untextured) materials, over the views. */
  flatCoverage: AaaMeasure | null;
  motion: MotionTrack[];
  exposure: ExposureTrack[];
  characters: AaaCharacters | null;
  poses: AaaClipPose[] | null;
  place: AaaPlace | null;
  lookFeatures: AaaLookFeatures | null;
  store: AaaStore | null;
}

/** An evidence bundle that does not validate, naming the field. */
export class AaaEvidenceError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`aaa evidence (${field}): ${detail}`);
    this.name = "AaaEvidenceError";
    this.field = field;
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSource = (value: unknown): value is FactSource => Object.values(FactSource).includes(value as FactSource);
const isNullableBool = (value: unknown) => value === null || typeof value === "boolean";
const isNullableNumber = (value: unknown) => value === null || isFiniteNumber(value);

function need(ok: boolean, field: string, detail: string): void {
  if (!ok) throw new AaaEvidenceError(field, detail);
}

/** A relative path that stays inside the bundle folder. */
function isInsidePath(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  if (path.isAbsolute(value) || value.includes("\\")) return false;
  return !path.posix.normalize(value).split("/").includes("..");
}

function checkCapture(raw: unknown, index: number): void {
  const field = `captures[${index}]`;
  need(isObject(raw), field, "an object");
  const capture = raw as Json;
  need(capture.role === null || typeof capture.role === "string", `${field}.role`, "a role or null");
  need(typeof capture.camera === "string" && capture.camera.length > 0, `${field}.camera`, "a camera name");
  need(capture.image === null || isInsidePath(capture.image), `${field}.image`, "a path inside the bundle");
  const sizeOk = [capture.width, capture.height].every((side) => Number.isInteger(side) && (side as number) > 0);
  need(sizeOk, `${field}.size`, "positive integer width and height");
  need(isNullableBool(capture.clean) && isNullableBool(capture.native), `${field}.flags`, "booleans or null");
  need(isNullableNumber(capture.subjectFraction), `${field}.subjectFraction`, "a fraction or null");
  need(isFiniteNumber(capture.meanLuma), `${field}.meanLuma`, "a number");
  const dark = capture.darkFraction;
  need(isFiniteNumber(dark) && dark >= 0 && dark <= 1, `${field}.darkFraction`, "a fraction");
  need(isSource(capture.source), `${field}.source`, "a fact source");
}

function checkSurface(raw: unknown, index: number): void {
  const field = `surfaces[${index}]`;
  const surface = isObject(raw) ? raw : {};
  need(typeof surface.tag === "string" && isFiniteNumber(surface.nearestM), field, "a tag and a distance");
  need(isNullableNumber(surface.texelDensityPxPerM), `${field}.texelDensityPxPerM`, "a number or null");
  need(isNullableBool(surface.hasNormal) && isNullableBool(surface.hasOrm), `${field}.maps`, "booleans or null");
  need(isSource(surface.source), `${field}.source`, "a fact source");
}

function checkProp(raw: unknown, index: number): void {
  const field = `props[${index}]`;
  const prop = isObject(raw) ? raw : {};
  need(typeof prop.tag === "string" && isFiniteNumber(prop.nearestM), field, "a tag and a distance");
  need(Object.values(PropOrigin).includes(prop.origin as PropOrigin), `${field}.origin`, "a prop origin");
  need(typeof prop.organic === "boolean" && isNullableBool(prop.hasCards), `${field}.organic`, "booleans");
  need(isSource(prop.source), `${field}.source`, "a fact source");
}

function checkTrack(raw: unknown, field: string, tickOk: (tick: Json) => boolean): void {
  const track = isObject(raw) ? raw : {};
  need(typeof track.demo === "string" && isSource(track.source), field, "a demo and a fact source");
  const ticks: unknown[] = Array.isArray(track.ticks) ? track.ticks : [];
  need(ticks.length >= 2, `${field}.ticks`, "at least two ticks");
  const timeOf = (tick: unknown) => (isObject(tick) && isFiniteNumber(tick.tMs) ? tick.tMs : Number.NaN);
  const ordered = ticks.every(
    (tick, i) => isObject(tick) && tickOk(tick) && (i === 0 || timeOf(tick) > timeOf(ticks[i - 1])),
  );
  need(ordered, `${field}.ticks`, "well-formed ticks in time order");
}

const poseTickOk = (tick: Json) => ["tMs", "y", "rollDeg", "pitchDeg"].every((key) => isFiniteNumber(tick[key]));
const evTickOk = (tick: Json) => isFiniteNumber(tick.tMs) && isFiniteNumber(tick.ev);

const isNames = (value: unknown) => Array.isArray(value) && value.every((name) => typeof name === "string");
const isClipRef = (value: Json) => typeof value.character === "string" && typeof value.clip === "string";

function checkHonest(bundle: Json): void {
  const characters = bundle.characters;
  need(
    characters === null ||
      (isObject(characters) &&
        isSource(characters.source) &&
        Array.isArray(characters.clips) &&
        characters.clips.every((clip) => isObject(clip) && isClipRef(clip))),
    "characters",
    "clips with a fact source, or null",
  );
  const poses = bundle.poses;
  const poseOk = (pose: unknown) =>
    isObject(pose) &&
    isClipRef(pose) &&
    isSource(pose.source) &&
    [pose.limbLengthDrift, pose.torsoLengthRatio, pose.selfIntersection].every(isNullableNumber) &&
    isNullableBool(pose.feetGrounded);
  need(poses === null || (Array.isArray(poses) && poses.every(poseOk)), "poses", "clip poses or null");
  const place = bundle.place;
  const countsOk = (p: Json) =>
    ["zones", "reachableZones", "exits", "unplannedDeadEnds"].every((key) => isFiniteNumber(p[key])) &&
    isNullableNumber(p.plannedZones) &&
    isNullableNumber(p.plannedExits);
  need(place === null || (isObject(place) && isSource(place.source) && countsOk(place)), "place", "counts or null");
  const look = bundle.lookFeatures;
  const lookOk = (l: Json) =>
    typeof l.preset === "string" && isNames(l.expected) && isNames(l.active) && isSource(l.source);
  need(look === null || (isObject(look) && lookOk(look)), "lookFeatures", "a preset and feature lists, or null");
  const store = bundle.store;
  need(
    store === null || (isObject(store) && typeof store.head === "string" && isSource(store.source)),
    "store",
    "a head and a fact source, or null",
  );
}

/** Fill the fields older bundles lack with null, so they read as unmeasured. */
function withDefaults(raw: Json): Json {
  const captures = Array.isArray(raw.captures)
    ? raw.captures.map((c) => (isObject(c) ? { subjectFraction: null, ...c } : c))
    : raw.captures;
  const missing = { characters: null, poses: null, place: null, lookFeatures: null, store: null };
  return { ...missing, ...raw, captures };
}

/** Validate an evidence bundle's JSON. Throws `AaaEvidenceError` naming the field. */
export function parseEvidence(raw: unknown): AaaEvidence {
  need(isObject(raw) && raw.schema === AAA_EVIDENCE_SCHEMA, "schema", AAA_EVIDENCE_SCHEMA);
  const bundle = withDefaults(raw as Json);
  need(typeof bundle.promptId === "string", "promptId", "a prompt id");
  need(bundle.promptVersion === null || typeof bundle.promptVersion === "string", "promptVersion", "text or null");
  need(isObject(bundle.subject) && typeof bundle.subject.game === "string", "subject", "a subject with a game");
  need(Array.isArray(bundle.captures), "captures", "a list");
  for (const [i, capture] of (bundle.captures as unknown[]).entries()) checkCapture(capture, i);
  need(bundle.surfaces === null || Array.isArray(bundle.surfaces), "surfaces", "a list or null");
  for (const [i, surface] of ((bundle.surfaces as unknown[] | null) ?? []).entries()) checkSurface(surface, i);
  need(bundle.props === null || Array.isArray(bundle.props), "props", "a list or null");
  for (const [i, prop] of ((bundle.props as unknown[] | null) ?? []).entries()) checkProp(prop, i);
  const flat = bundle.flatCoverage;
  need(
    flat === null || (isObject(flat) && isFiniteNumber(flat.value) && isSource(flat.source)),
    "flatCoverage",
    "a measure or null",
  );
  need(Array.isArray(bundle.motion) && Array.isArray(bundle.exposure), "tracks", "motion and exposure lists");
  for (const [i, track] of (bundle.motion as unknown[]).entries()) checkTrack(track, `motion[${i}]`, poseTickOk);
  for (const [i, track] of (bundle.exposure as unknown[]).entries()) checkTrack(track, `exposure[${i}]`, evTickOk);
  checkHonest(bundle);
  return bundle as unknown as AaaEvidence;
}

/** Read and validate `<dir>/evidence.json`. */
export function readEvidence(dir: string): AaaEvidence {
  return parseEvidence(JSON.parse(fs.readFileSync(path.join(dir, EVIDENCE_FILE), "utf8")));
}

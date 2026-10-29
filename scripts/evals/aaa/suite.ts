/**
 * The AA+ release-gate suite (`evals/aaa/suite.json`, docs/evals.md#the-aa-release-gate): held-out
 * Rust-stack briefs in a user's words, each with the views a judge must see, the motion and doorway
 * demos the comfort and exposure floors read, and the CC0 references the taste judge compares
 * against. This module validates the file and versions each prompt by the sha256 of its own
 * canonical JSON, so editing one prompt never moves another. It holds no brief text.
 */
import fs from "node:fs";
import path from "node:path";
import { sha256Text } from "../ledger/hash.ts";
import { SLUG_PATTERN } from "../ledger/types.ts";

/** The suite file, relative to the repository root. */
export const AAA_SUITE_FILE = "evals/aaa/suite.json";
/** The schema tag the suite file carries. */
export const AAA_SUITE_SCHEMA = "genex-aaa-suite/1";
/** Hex characters kept of a prompt's sha256. */
export const PROMPT_DIGEST_CHARS = 12;
/** The fewest prompts a suite may hold: the release gate needs three different ones to pass. */
export const MIN_SUITE_PROMPTS = 3;

/** How bright a prompt's world is meant to read: it picks the luma band its views are held to. */
export const AaaLook = {
  Bright: "bright",
  /** A night, horror or other low-key look the brief asks for. */
  Dark: "dark",
} as const;
export type AaaLook = (typeof AaaLook)[keyof typeof AaaLook];

/** Whether a view is inside or outside; the luma band differs. */
export const ViewSetting = {
  Interior: "interior",
  Exterior: "exterior",
} as const;
export type ViewSetting = (typeof ViewSetting)[keyof typeof ViewSetting];

/** Where a reference still comes from. Poly Haven assets are CC0. */
export const ReferenceSource = {
  PolyHaven: "polyhaven",
} as const;
export type ReferenceSource = (typeof ReferenceSource)[keyof typeof ReferenceSource];

/** A view the judge must see: a role the operator maps a game camera to. */
export interface AaaView {
  role: string;
  setting: ViewSetting;
  describe: string;
}

/** A demo a floor reads a per-tick track from. */
export interface AaaDemo {
  demo: string;
  describe: string;
}

/** A licence-safe reference: a CC0 panorama, cut into 1600×900 stills at each yaw. */
export interface AaaReference {
  source: ReferenceSource;
  asset: string;
  /** The view role this reference is the target for. */
  matches: string;
  yawDeg: number[];
}

/** One release-gate prompt. */
export interface AaaPrompt {
  id: string;
  label: string;
  origin: string;
  brief: string;
  look: AaaLook;
  views: AaaView[];
  motion: AaaDemo[];
  transitions: AaaDemo[];
  references: AaaReference[];
  /** sha256[:12] of the prompt's canonical JSON. */
  version: string;
}

/** A suite file that does not validate, naming the prompt (when known) and the field. */
export class AaaSuiteError extends Error {
  readonly promptId: string | null;
  readonly field: string;
  constructor(promptId: string | null, field: string, detail: string) {
    super(`aaa suite (${promptId ?? "file"}, ${field}): ${detail}`);
    this.name = "AaaSuiteError";
    this.promptId = promptId;
    this.field = field;
  }
}

const ASSET_ID = /^[a-z0-9_]+$/;
const ROLE = /^[a-z]+(?:-[a-z]+)*$/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isOneOf = <T extends string>(values: Record<string, T>, value: unknown): value is T =>
  Object.values(values).includes(value as T);

/** A validator scoped to one prompt, so every refusal names it. */
function checker(promptId: string | null) {
  return (ok: boolean, field: string, detail: string) => {
    if (!ok) throw new AaaSuiteError(promptId, field, detail);
  };
}

function parseView(raw: unknown, check: ReturnType<typeof checker>): AaaView {
  check(isObject(raw), "views", "a view is an object");
  const view = raw as Json;
  check(isText(view.role) && ROLE.test(view.role), "views.role", "a kebab-case role");
  check(isOneOf(ViewSetting, view.setting), "views.setting", "interior or exterior");
  check(isText(view.describe), "views.describe", "what the camera shows");
  return { role: view.role as string, setting: view.setting as ViewSetting, describe: view.describe as string };
}

function parseDemo(raw: unknown, field: string, check: ReturnType<typeof checker>): AaaDemo {
  const demo = isObject(raw) ? raw : {};
  check(isText(demo.demo) && ROLE.test(demo.demo), `${field}.demo`, "a kebab-case demo name");
  check(isText(demo.describe), `${field}.describe`, "what the demo does");
  return { demo: demo.demo as string, describe: demo.describe as string };
}

function parseReference(raw: unknown, roles: ReadonlySet<string>, check: ReturnType<typeof checker>): AaaReference {
  const ref = isObject(raw) ? raw : {};
  check(isOneOf(ReferenceSource, ref.source), "references.source", "a known licence-safe source");
  check(isText(ref.asset) && ASSET_ID.test(ref.asset), "references.asset", "an asset id");
  check(isText(ref.matches) && roles.has(ref.matches), "references.matches", "one of the prompt's view roles");
  const yaws = Array.isArray(ref.yawDeg) ? ref.yawDeg : [];
  const validYaw = (yaw: unknown) => typeof yaw === "number" && yaw >= 0 && yaw < 360;
  check(yaws.length > 0 && yaws.every(validYaw), "references.yawDeg", "yaws in [0, 360)");
  return {
    source: ref.source as ReferenceSource,
    asset: ref.asset as string,
    matches: ref.matches as string,
    yawDeg: yaws as number[],
  };
}

/** Validate one prompt and stamp its version. */
function parsePrompt(raw: unknown): AaaPrompt {
  const prompt = isObject(raw) ? raw : {};
  const id = isText(prompt.id) ? prompt.id : null;
  const check = checker(id);
  check(id !== null && SLUG_PATTERN.test(id), "id", "a slug");
  for (const field of ["label", "origin", "brief"]) check(isText(prompt[field]), field, "non-empty text");
  check(isOneOf(AaaLook, prompt.look), "look", "bright or dark");
  const lists = ["views", "motion", "transitions", "references"];
  for (const field of lists) check(Array.isArray(prompt[field]), field, "a list");
  const views = (prompt.views as unknown[]).map((view) => parseView(view, check));
  const roles = new Set(views.map((view) => view.role));
  check(views.length > 0 && roles.size === views.length, "views", "at least one view, roles unique");
  const motion = (prompt.motion as unknown[]).map((demo) => parseDemo(demo, "motion", check));
  check(motion.length > 0, "motion", "at least one motion demo");
  const transitions = (prompt.transitions as unknown[]).map((demo) => parseDemo(demo, "transitions", check));
  const references = (prompt.references as unknown[]).map((ref) => parseReference(ref, roles, check));
  check(references.length > 0, "references", "at least one reference");
  const body = {
    id: id as string,
    label: prompt.label as string,
    origin: prompt.origin as string,
    brief: prompt.brief as string,
    look: prompt.look as AaaLook,
    views,
    motion,
    transitions,
    references,
  };
  return { ...body, version: sha256Text(JSON.stringify(body)).slice(0, PROMPT_DIGEST_CHARS) };
}

/** Validate a suite file's JSON. Throws `AaaSuiteError` naming the prompt and field. */
export function parseAaaSuite(raw: unknown): AaaPrompt[] {
  const check = checker(null);
  check(isObject(raw) && raw.schema === AAA_SUITE_SCHEMA, "schema", AAA_SUITE_SCHEMA);
  const list = (raw as Json).prompts;
  check(Array.isArray(list), "prompts", "a list");
  const prompts = (list as unknown[]).map(parsePrompt);
  check(prompts.length >= MIN_SUITE_PROMPTS, "prompts", `at least ${MIN_SUITE_PROMPTS} prompts`);
  const ids = new Set(prompts.map((prompt) => prompt.id));
  check(ids.size === prompts.length, "id", "ids are unique");
  return prompts;
}

/** Read and validate the committed suite. */
export function readAaaSuite(root: string): AaaPrompt[] {
  return parseAaaSuite(JSON.parse(fs.readFileSync(path.join(root, AAA_SUITE_FILE), "utf8")));
}
